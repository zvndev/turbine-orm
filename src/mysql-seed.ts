/** Explicit, DML-only MySQL seed callbacks. MySQL DDL implicitly commits. */
import type { TransactionClient } from './client.js';
import { ValidationError } from './errors.js';
import { MysqlPool, turbineMysql } from './mysql.js';
import type { TableClient } from './query/table-client.js';
import type { SchemaMetadata } from './schema.js';

// Closed deliberately: newly added accessor methods need a safety decision.
const METHODS = [
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
] as const satisfies readonly (keyof TableClient<object>)[];

/** Ordinary typed reads and DML; no SQL, deferred statements or driver internals. */
export type MysqlSeedTable<T extends object> = Pick<TableClient<T>, (typeof METHODS)[number]>;

/** A restricted transaction handle, also used by every nested savepoint callback. */
export interface MysqlSeedClient {
  table<T extends object = Record<string, unknown>>(name: string): MysqlSeedTable<T>;
  $transaction<R>(fn: (tx: MysqlSeedClient) => Promise<R>): Promise<R>;
}

export type MysqlSeedFunction = (tx: MysqlSeedClient) => Promise<void> | void;

/** Declare trusted code without executing it at module import time. */
export function defineMysqlSeed(fn: MysqlSeedFunction): MysqlSeedFunction {
  if (typeof fn !== 'function') throw new ValidationError('A MySQL seed must be a callable callback.');
  return fn;
}

function sealed<T extends object>(members: T): T {
  return new Proxy(Object.freeze(members), {
    get(target, key, receiver) {
      if (Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      // Promise assimilation and inspection must not turn this into a thenable.
      if (key === 'then' || typeof key === 'symbol') return undefined;
      throw new ValidationError(
        `MySQL seed handles do not support "${String(key)}". Use table() reads/DML or callback $transaction; raw SQL, DDL and connection access are unavailable.`,
      );
    },
  });
}

async function withSeedClient<R>(tx: TransactionClient, fn: (client: MysqlSeedClient) => R | Promise<R>): Promise<R> {
  let open = true;
  const assertOpen = () => {
    if (!open) throw new ValidationError('This MySQL seed callback has settled; its transaction handle is closed.');
  };
  const client = sealed(
    Object.assign(Object.create(null), {
      table(name: string) {
        assertOpen();
        const qi = tx.table(name);
        const methods = Object.create(null) as Record<string, unknown>;
        for (const method of METHODS) {
          // Only the bound function escapes, never the QueryInterface or its pool.
          methods[method] = async (...args: unknown[]) => {
            assertOpen();
            return Reflect.apply(qi[method], qi, args);
          };
        }
        return sealed(methods);
      },
      async $transaction<R>(fn: (inner: MysqlSeedClient) => Promise<R>): Promise<R> {
        assertOpen();
        if (typeof fn !== 'function') throw new ValidationError('MySQL seed $transaction requires a callback.');
        return tx.$transaction((inner) => withSeedClient(inner, fn));
      },
    }),
  ) as MysqlSeedClient;
  try {
    return await fn(client);
  } finally {
    open = false;
  }
}

type SeedTarget = Exclude<Parameters<typeof turbineMysql>[0], MysqlPool>;

/** Refuse borrowing a connection with an existing transaction before START can commit it. */
function checkedTarget(target: SeedTarget): SeedTarget {
  if (target instanceof MysqlPool) {
    throw new ValidationError('MySQL seeds accept a mysql2 promise pool, not a MysqlPool wrapper.');
  }
  if (typeof target !== 'object' || !target || !('getConnection' in target)) return target;
  const pool = target as Extract<SeedTarget, { getConnection: unknown }>;
  return {
    query: pool.query.bind(pool),
    execute: pool.execute.bind(pool),
    end: pool.end.bind(pool),
    async getConnection() {
      const connection = await pool.getConnection();
      try {
        // A DO result carries mysql2's actual protocol server-status bits.
        // Bit 1 = IN_TRANS, bit 2 = AUTOCOMMIT. No session SET or rollback.
        const [header] = await connection.query('DO 0');
        const status = (header as { serverStatus?: unknown })?.serverStatus;
        if (typeof status !== 'number' || (status & 1) !== 0 || (status & 2) === 0) {
          throw new ValidationError(
            'MySQL seed requires an idle autocommit connection; a caller-owned transaction is never committed or rolled back.',
          );
        }
        return connection;
      } catch (error) {
        connection.release();
        throw error;
      }
    },
  };
}

async function checkCatalog(tx: TransactionClient, schema: SchemaMetadata): Promise<void> {
  const databases = await tx.raw<{
    name: string;
    account: string;
  }>`SELECT DATABASE() AS name, CURRENT_USER() AS account`;
  if (!databases[0]?.name) throw new ValidationError('MySQL seeds require a current database.');
  // A global TRIGGER row survives a database-level partial revoke, while the
  // trigger catalog hides that database's triggers. Never trust that row alone.
  const effectiveGrants = await tx.raw`SHOW GRANTS`;
  if (effectiveGrants.some((row) => Object.values(row).some((value) => /^REVOKE\b/i.test(String(value).trim())))) {
    throw new ValidationError('MySQL seeds refuse partial revokes because trigger catalog visibility is uncertain.');
  }
  // TRIGGERS silently hides objects without TRIGGER privilege. Require a direct
  // database/global grant before trusting an empty catalog (role-only grants
  // are deliberately refused rather than guessed at).
  const account = databases[0].account;
  const at = account.lastIndexOf('@');
  const quoted = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const grantee = `${quoted(account.slice(0, at))}@${quoted(account.slice(at + 1))}`;
  const grants = await tx.raw`
    SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES
    WHERE GRANTEE = ${grantee} AND PRIVILEGE_TYPE = 'TRIGGER'
    UNION ALL
    SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES
    WHERE GRANTEE = ${grantee} AND TABLE_SCHEMA = DATABASE() AND PRIVILEGE_TYPE = 'TRIGGER'`;
  if (!grants.length)
    throw new ValidationError(
      'MySQL seeds require a direct database-wide or global TRIGGER privilege to verify the absence of triggers.',
    );
  // Check the whole database, not just the selected tables: FK cascades may
  // reach excluded tables. Refuse triggers rather than guess at their effects.
  const tables = await tx.raw<{ name: string; kind: string; engine: string | null }>`
    SELECT TABLE_NAME AS name, TABLE_TYPE AS kind, ENGINE AS engine
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()`;
  if (tables.some((table) => table.kind === 'BASE TABLE' && table.engine !== 'InnoDB')) {
    throw new ValidationError('MySQL seeds require every base table in the database to use InnoDB for DML rollback.');
  }
  const names = new Set(tables.filter((table) => table.kind === 'BASE TABLE').map((table) => table.name));
  if (Object.entries(schema.tables).some(([name, table]) => table.name !== name || !names.has(name))) {
    throw new ValidationError('MySQL seed metadata may reference only existing base tables, not views.');
  }
  const triggers = await tx.raw`SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()`;
  if (triggers.length)
    throw new ValidationError(
      'MySQL seeds refuse databases with triggers; their side effects cannot be guaranteed transactional.',
    );
}

/**
 * Run awaited typed DML in one native transaction. Callback failure rolls back
 * its DML on an InnoDB database without triggers. No arbitrary SQL is exposed.
 * The catalog must be fully visible to the connection's user and schema must
 * not change concurrently. Imports, captured connections and other external
 * effects are outside this guarantee. Trusted code, not a security sandbox.
 * A supplied mysql2 promise pool stays open; a string/config pool closes here.
 */
export async function runMysqlSeed(
  target: SeedTarget,
  schema: SchemaMetadata,
  fn: MysqlSeedFunction,
  options: Parameters<typeof turbineMysql>[2] = {},
): Promise<void> {
  defineMysqlSeed(fn);
  const db = await turbineMysql(checkedTarget(target), schema, options);
  try {
    await db.$transaction(async (tx) => {
      await checkCatalog(tx, schema);
      await withSeedClient(tx, fn);
    });
  } finally {
    await db.disconnect();
  }
}
