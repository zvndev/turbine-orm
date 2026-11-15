/** Explicit, transaction-scoped SQL Server seed callbacks. */
import type { TransactionClient } from './client.js';
import { ValidationError } from './errors.js';
import { turbineMssql } from './mssql.js';
import type { QueryInterface } from './query/index.js';
import type { SchemaMetadata } from './schema.js';

const methods = [
  'findMany',
  'findUnique',
  'findFirst',
  'findUniqueOrThrow',
  'findFirstOrThrow',
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
] as const;

/** Eager typed reads and DML only; no builder, stream, raw or connection access. */
export type MssqlSeedTable<T extends object = Record<string, unknown>> = Pick<
  QueryInterface<T>,
  (typeof methods)[number]
>;

export interface MssqlSeedClient {
  table<T extends object = Record<string, unknown>>(name: string): MssqlSeedTable<T>;
  /** A nested savepoint, with another closed callback handle. Await its work. */
  $transaction(fn: MssqlSeedFunction): Promise<void>;
}

export type MssqlSeedFunction = (tx: MssqlSeedClient) => Promise<void> | void;

/** Declaration only: importing a module never invokes this callback. */
export function defineMssqlSeed(fn: MssqlSeedFunction): MssqlSeedFunction {
  if (typeof fn !== 'function') throw new ValidationError('A SQL Server seed must be a callable callback.');
  return fn;
}

async function invoke(tx: TransactionClient, fn: MssqlSeedFunction): Promise<void> {
  let active = true;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  const assertActive = () => {
    if (!active) throw new ValidationError('This SQL Server seed callback handle has ended.');
  };
  const client: MssqlSeedClient = Object.freeze({
    table<T extends object = Record<string, unknown>>(name: string): MssqlSeedTable<T> {
      assertActive();
      const table = tx.table<T>(name);
      // Each closure returns only the eager method's result. Binding or picking
      // the original object would expose its pool, prototype and query builders.
      return Object.freeze(
        Object.fromEntries(
          methods.map((method) => [
            method,
            async (...args: unknown[]) => {
              assertActive();
              return track(Reflect.apply(table[method], table, args));
            },
          ]),
        ),
      ) as MssqlSeedTable<T>;
    },
    async $transaction(fn: MssqlSeedFunction): Promise<void> {
      assertActive();
      defineMssqlSeed(fn);
      await track(
        tx.$transaction(async (nested) => {
          await invoke(nested, fn);
        }),
      );
    },
  });
  let unfinished = false;
  try {
    await fn(client);
    unfinished = pending.size > 0;
  } finally {
    active = false;
    // mssql refuses rollback while a Request owns the Transaction pin. Drain
    // eager work (including nested callbacks) before the enclosing rollback.
    await Promise.allSettled(pending);
  }
  if (unfinished) throw new ValidationError('Await every SQL Server seed operation; unfinished work was rolled back.');
}

/**
 * Run trusted DML in the existing native Transaction lifecycle. Owned pools
 * close on either outcome; supplied pools remain owned by the caller. Metadata,
 * middleware and server triggers must be trusted. Imports, external effects and
 * captured connections are outside this transaction.
 *
 * The SQL Server compiler uses unqualified table identifiers. Verify their
 * native resolution on the pinned transaction before handing out a callback.
 * options.schema defaults to dbo; it validates resolution, it does not SET a
 * session default or rewrite metadata. Views and synonyms are refused.
 */
export async function runMssqlSeed(
  target: Parameters<typeof turbineMssql>[0],
  schema: SchemaMetadata,
  fn: MssqlSeedFunction,
  options: Parameters<typeof turbineMssql>[2] = {},
): Promise<void> {
  defineMssqlSeed(fn);
  const namespace = options.schema ?? 'dbo';
  if (
    typeof namespace !== 'string' ||
    !namespace ||
    namespace.length > 128 ||
    [...namespace].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    throw new ValidationError('SQL Server seed schema must be an identifier of 1–128 characters without controls.');
  }
  for (const [name, table] of Object.entries(schema.tables)) {
    if (name !== table.name || !name || name.length > 128) {
      throw new ValidationError('SQL Server seed metadata must use matching table names of 1–128 characters.');
    }
  }
  const db = await turbineMssql(target, schema, options);
  try {
    await db.$transaction(async (tx) => {
      for (const name of Object.keys(schema.tables)) {
        const rows = await tx.rawUnsafe<{ seed_schema: string | null }>(
          "SELECT OBJECT_SCHEMA_NAME(OBJECT_ID(QUOTENAME(@p1), N'U')) AS seed_schema",
          name,
        );
        if (rows.length !== 1 || rows[0]?.seed_schema !== namespace) {
          throw new ValidationError(
            'SQL Server seed table resolution must match options.schema (default dbo). Check the login default schema and base-table metadata.',
          );
        }
      }
      await invoke(tx, fn);
    });
  } finally {
    await db.disconnect();
  }
}
