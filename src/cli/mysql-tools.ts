/** Owned native MySQL connections for the read-only CLI/MCP handlers. */
import { ConnectionError, ValidationError } from '../errors.js';
import { introspectMysqlWith, MysqlPool, mysqlDialect } from '../mysql.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from '../pg-types.js';
import type { IndexMetadata, SchemaMetadata } from '../schema.js';
import { mysqlDatabaseFromUrl } from './config.js';
import { assertMysqlCatalogVisibility } from './mysql-schema-snapshot.js';

interface NativeConnection {
  query(sql: string, values?: unknown): Promise<[unknown, unknown]>;
  execute(sql: string, values?: unknown): Promise<[unknown, unknown]>;
  destroy(): void;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

type Filters = { include?: string[]; exclude?: string[]; legacyToManyUniques?: boolean };
interface ToolConnection {
  schema: string;
  query: PgCompatPoolClient['query'];
  metadata?: SchemaMetadata;
}
const connections = new WeakMap<PgCompatPoolClient, ToolConnection>();
const summaries = new WeakMap<IndexMetadata, Record<string, unknown>>();

/** Structural native index facts; expression text is never read from the catalog. */
export function mysqlToolIndexSummary(index: IndexMetadata): Record<string, unknown> | undefined {
  return summaries.get(index);
}

/** Peer resolution only; never connects or infers a server version. */
export function mysqlToolRuntime() {
  const available = importOptionalPeer.peerPackageVersion('mysql2') !== null;
  return {
    available,
    minimumNode: null,
    reason: available ? null : 'MySQL tools require the optional peer mysql2. Install it with npm i mysql2.',
  };
}

/** Only operations implemented by the shared handlers with this native adapter. */
export const MYSQL_TOOLS: readonly string[] = [
  'doctor_report',
  'schema_overview',
  'table_detail',
  'compile_query',
  'sample_rows',
  'relation_graph',
  'find_join_path',
  'explain_error',
  'engine_capabilities',
];

/** Facts about this adapter, independent of an application's ORM pool. */
export const mysqlToolTransport = {
  kind: 'mysql2',
  sessions: true,
  transactions: true,
  cursors: false,
  pipeline: false,
  readOnlyEnforcement: 'transaction-read-only-consistent-snapshot',
  statementTimeout: false,
  ownership: 'one-owned-connection-per-call',
  note: 'Read-only repeatable-read snapshots for transactional tables. No cursor, pipeline or query deadline is exposed. Concurrent DDL and nontransactional tables are not snapshot-isolated.',
} as const;

/** Validate filters before opening the native connection. */
export function validateMysqlToolOptions(options: Filters): void {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new ValidationError('MySQL tool filters must be an object.');
  }
  for (const key of ['include', 'exclude'] as const) {
    const values = options[key];
    if (
      values !== undefined &&
      (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value || value.includes('\0')))
    ) {
      throw new ValidationError(`MySQL tool ${key} must be an array of nonempty table names.`);
    }
  }
}

// Native errors can contain bound values or stored expression literals. Never
// send their text, SQL, bindings or causes through the tool error channel.
function nativeFailure(error: unknown): ConnectionError {
  const code = (error as { code?: unknown } | null)?.code;
  const label = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? ` (${code})` : '';
  return new ConnectionError(`MySQL read-only tool connection or query failed${label}.`);
}

/** Reuse native introspection on the SAME owned read-only snapshot. */
export async function introspectMysqlToolClient(client: PgCompatPoolClient, options: Filters = {}) {
  validateMysqlToolOptions(options);
  const state = connections.get(client);
  if (!state) throw new ValidationError('MySQL tool metadata requires an active MySQL tool connection.');
  const metadata = await introspectMysqlWith(
    async (sql, params) => (await state.query(sql, params)).rows,
    state.schema,
    {
      ...options,
      logger: { info() {}, warn() {} },
    },
  );
  const result = await state.query<{
    TABLE_NAME: string;
    INDEX_NAME: string;
    NON_UNIQUE: number;
    COLUMN_NAME: string | null;
    SUB_PART: number | null;
    COLLATION: string | null;
    INDEX_TYPE: string;
    IS_VISIBLE: string;
  }>(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SUB_PART, COLLATION, INDEX_TYPE, IS_VISIBLE
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [state.schema],
  );
  for (const table of Object.values(metadata.tables)) {
    table.uniqueColumns = table.uniqueColumns.filter(
      (columns) =>
        columns.length > 0 &&
        columns.every((column) => typeof column === 'string' && table.allColumns.includes(column)),
    );
    for (const index of table.indexes) {
      const keys = result.rows.filter((row) => row.TABLE_NAME === table.name && row.INDEX_NAME === index.name);
      const withheld = keys.length === 0 || keys.some((key) => key.COLUMN_NAME === null);
      const columns = keys.flatMap((key) => (key.COLUMN_NAME === null ? [] : [key.COLUMN_NAME]));
      // A mixed expression key must not become a false plain-column unique key.
      index.columns = withheld || keys.some((key) => key.SUB_PART != null) ? [] : columns;
      // No presentation DDL is trusted or reparsed as PostgreSQL syntax.
      index.definition = '(definition withheld: native index SQL may contain literal values)';
      summaries.set(index, {
        name: index.name,
        columns,
        columnsWithheld: withheld,
        unique: index.unique,
        partial: false,
        definitionWithheld: true,
        definition: index.definition,
        keys: keys.map((key) => ({
          column: key.COLUMN_NAME,
          expressionWithheld: key.COLUMN_NAME === null,
          prefixLength: key.SUB_PART,
          direction: key.COLLATION === 'A' ? 'asc' : key.COLLATION === 'D' ? 'desc' : null,
        })),
        type: keys[0]?.INDEX_TYPE ?? null,
        visible: keys.length ? keys[0]!.IS_VISIBLE === 'YES' : null,
      });
    }
  }
  // Enum labels are schema literals, not required for structural tooling.
  metadata.enums = {};
  state.metadata = metadata;
  return metadata;
}

/** Sample only validated columns from metadata read on this owned connection. */
export async function sampleMysqlToolRows(
  client: PgCompatPoolClient,
  tableName: string,
  columns: string[],
  limit: number,
): Promise<PgCompatQueryResult> {
  const state = connections.get(client);
  const table = state?.metadata?.tables[tableName];
  if (!state || !table || !Object.hasOwn(state.metadata!.tables, tableName)) {
    throw new ValidationError('MySQL sampling requires table metadata from the active tool connection.');
  }
  if (
    !Array.isArray(columns) ||
    columns.some((column) => !table.allColumns.includes(column)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    throw new ValidationError('MySQL sampling requires catalog columns and a limit from 1 to 100.');
  }
  const q = mysqlDialect.quoteIdentifier;
  const select = columns.length ? columns.map(q).join(', ') : '1 AS `_`';
  return state.query(`SELECT ${select} FROM ${q(state.schema)}.${q(table.name)} LIMIT :p1`, [limit]);
}

/**
 * Lazy optional peer, one dedicated connection per checkout. The snapshot is
 * established before connect resolves; neither a caller pool nor raw SQL is a
 * tool input. Destroying the connection rolls back unfinished work on release.
 */
export function createMysqlToolPool(url: string, schema: string, options: Filters = {}): PgCompatPool {
  let database: string;
  try {
    database = mysqlDatabaseFromUrl(url);
  } catch {
    throw new ValidationError(
      'MySQL tools require a valid mysql://host/database URL without query parameters or fragments.',
    );
  }
  if (schema !== database) throw new ValidationError('MySQL tool schema must match the database in its URL.');
  const parsed = new URL(url);
  if (parsed.port === '0') throw new ValidationError('MySQL tools require a nonzero TCP port.');
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (
    [database, user, password, parsed.hostname].some((value) =>
      Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127),
    )
  ) {
    throw new ValidationError('MySQL tool connection fields cannot contain control characters.');
  }
  validateMysqlToolOptions(options);
  let closed = false;
  const active = new Set<PgCompatPoolClient>();
  const pending = new Set<Promise<PgCompatPoolClient>>();

  const checkout = async (): Promise<PgCompatPoolClient> => {
    if (closed) throw new ValidationError('MySQL tool transport is closed.');
    let native: NativeConnection | undefined;
    let cleanup: (() => void) | undefined;
    try {
      const mod = (await importOptionalPeer('mysql2/promise')) as {
        createConnection?: (config: Record<string, unknown>) => Promise<NativeConnection>;
        default?: { createConnection?: (config: Record<string, unknown>) => Promise<NativeConnection> };
      };
      const createConnection = mod.default?.createConnection ?? mod.createConnection;
      if (!createConnection)
        throw new ConnectionError(mysqlToolRuntime().reason ?? 'mysql2 createConnection is unavailable.');
      if (closed) throw new ValidationError('MySQL tool transport is closed.');
      native = await createConnection({
        host: parsed.hostname.replace(/^\[|\]$/g, ''),
        port: parsed.port ? Number(parsed.port) : 3306,
        user,
        password,
        database,
        namedPlaceholders: true,
        supportBigNumbers: true,
        bigNumberStrings: false,
        dateStrings: false,
        timezone: 'Z',
        multipleStatements: false,
        connectTimeout: 10_000,
      });
      const connection = native;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        connections.delete(client);
        active.delete(client);
        connection.destroy();
      };
      cleanup = release;
      const inner = new MysqlPool({
        query: connection.query.bind(connection),
        execute: connection.execute.bind(connection),
        async getConnection(): Promise<never> {
          throw new ValidationError('MySQL tools do not expose nested checkouts.');
        },
        async end() {
          release();
        },
      });
      const query: PgCompatPoolClient['query'] = async (text, values) => {
        if (released || closed) throw new ValidationError('MySQL tool connection is closed.');
        try {
          return await inner.query(text, values);
        } catch (error) {
          release();
          throw nativeFailure(error);
        }
      };
      const client: PgCompatPoolClient = {
        async query(): Promise<never> {
          throw new ValidationError('MySQL tools do not accept arbitrary SQL or transaction commands.');
        },
        release,
      };
      // Errors outside a query must close this owned socket too.
      connection.on('error', release);
      active.add(client);
      if (closed) {
        release();
        throw new ValidationError('MySQL tool transport is closed.');
      }
      const version = (await query<{ version: string }>('SELECT VERSION() AS version')).rows[0]?.version;
      if (typeof version !== 'string' || !/^8\./.test(version) || /mariadb/i.test(version)) {
        release();
        throw new ValidationError('MySQL tools require native MySQL 8.x.');
      }
      await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
      if (closed || released) {
        release();
        throw new ValidationError('MySQL tool transport is closed.');
      }
      connections.set(client, { schema, query });
      return client;
    } catch (error) {
      if (cleanup) cleanup();
      else native?.destroy();
      if (error instanceof ValidationError || error instanceof ConnectionError) throw error;
      throw nativeFailure(error);
    }
  };
  return {
    async query(): Promise<never> {
      throw new ValidationError('MySQL tools require a scoped read-only connection.');
    },
    connect() {
      const promise = checkout();
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    },
    async end() {
      closed = true;
      for (const client of active) client.release();
      await Promise.allSettled(pending);
    },
  };
}

/** Doctor alone receives the internal snapshot executor; raw SQL stays sealed to tool callers. */
export async function mysqlToolDoctorReport(client: PgCompatPoolClient, options: Filters = {}) {
  const state = connections.get(client);
  if (!state) throw new ValidationError('MySQL doctor requires an active MySQL tool snapshot.');
  const { collectMysqlDoctor } = await import('./mysql-doctor.js');
  return collectMysqlDoctor(
    {
      client,
      schema: state.schema,
      query: state.query,
      async assertVisibility() {
        const grants = (await state.query('SHOW GRANTS')).rows.flatMap((row) => Object.values(row).map(String));
        const active = (await state.query<{ active_roles: string }>('SELECT CURRENT_ROLE() AS active_roles')).rows[0]
          ?.active_roles;
        if (active !== 'NONE' || grants.some((grant) => /^GRANT /i.test(grant) && !/^GRANT [A-Z_, ]+ ON /i.test(grant)))
          throw new ValidationError('MySQL doctor cannot prove visibility with role grants.');
        assertMysqlCatalogVisibility(grants, state.schema);
      },
    },
    options,
  );
}
