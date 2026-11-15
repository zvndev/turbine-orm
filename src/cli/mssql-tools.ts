/** SQL Server catalog-only tools. Native handles never escape this module. */

import { ConnectionError, ValidationError } from '../errors.js';
import { introspectMssqlWith } from '../mssql.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import type { IndexMetadata, SchemaMetadata } from '../schema.js';
import type { MssqlDoctorCatalog } from './mssql-doctor.js';

interface NativeRequest {
  input(name: string, value: unknown): NativeRequest;
  query(sql: string): Promise<{ recordset?: Record<string, unknown>[] }>;
}
interface NativePool {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  request(): NativeRequest;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}
interface Driver {
  ConnectionPool: new (config: Record<string, unknown>) => NativePool;
}
interface Session {
  schema: string;
  active: boolean;
  busy: boolean;
  work?: Promise<SchemaMetadata>;
  exec(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  release(): Promise<void>;
}

const sessions = new WeakMap<PgCompatPoolClient, Session>();
const doctorCatalogs = new WeakMap<SchemaMetadata, MssqlDoctorCatalog>();

/** Provenance retained from existing fixed catalog reads, not a visibility guarantee. */
export function mssqlToolDoctorCatalog(metadata: SchemaMetadata): MssqlDoctorCatalog | undefined {
  return doctorCatalogs.get(metadata);
}

const summaries = new WeakMap<IndexMetadata, Record<string, unknown>>();

export const MSSQL_CATALOG_TOOLS: readonly string[] = Object.freeze([
  'doctor_report',
  'schema_overview',
  'table_detail',
  'relation_graph',
  'find_join_path',
  'compile_query',
  'explain_error',
  'engine_capabilities',
]);

export function mssqlToolSupported(name: string): boolean {
  return MSSQL_CATALOG_TOOLS.includes(name);
}

/** Resolution only: discovery does not evaluate the driver or open a connection. */
export function mssqlToolRuntime() {
  const available = importOptionalPeer.peerPackageVersion('mssql') !== null;
  return {
    available,
    minimumNode: null,
    reason: available ? null : "SQL Server catalog tools require the optional peer 'mssql'. Install it: npm i mssql.",
  };
}

export const mssqlToolTransport = Object.freeze({
  kind: 'mssql-catalog-only',
  sessions: true,
  transactions: false,
  cursors: false,
  pipeline: false,
  readOnlyEnforcement: 'fixed-catalog-queries-only',
  statementTimeout: 'native-request-30s',
  ownership: 'one-owned-pool-per-call',
  note: 'No native read-only transaction or database permission enforcement is asserted. Data and explain execution are refused; catalog reads are not a consistent snapshot.',
});

/** Native flags only; expressions, definitions and filter literals are withheld. */
export function mssqlToolIndexSummary(index: IndexMetadata): Record<string, unknown> | undefined {
  return summaries.get(index);
}

function configFor(url: string, schema: string): Record<string, unknown> {
  if (
    typeof schema !== 'string' ||
    !schema ||
    schema.length > 128 ||
    [...schema].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)
  ) {
    throw new ValidationError('SQL Server tools require a schema identifier of 1–128 characters without controls.');
  }
  try {
    if (typeof url !== 'string') throw new Error('invalid URL');
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    if (
      parsed.protocol !== 'mssql:' ||
      !parsed.hostname ||
      !database ||
      database.includes('/') ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error('invalid URL');
    }
    return {
      server: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 1433,
      database,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      pool: { min: 0, max: 1 },
      connectionTimeout: 15_000,
      requestTimeout: 30_000,
      options: { encrypt: false, trustServerCertificate: true, useUTC: true },
    };
  } catch {
    // Driver/URL diagnostics may contain credentials. Never echo them.
    throw new ValidationError('SQL Server tools require mssql://host/database without query parameters or fragment.');
  }
}

async function loadDriver(): Promise<Driver> {
  let module: unknown;
  try {
    module = await importOptionalPeer('mssql');
  } catch {
    throw new ConnectionError("SQL Server catalog tools require the optional peer 'mssql'. Install it: npm i mssql.");
  }
  const driver = ((module as { default?: unknown } | null)?.default ?? module) as Driver | null;
  if (typeof driver?.ConnectionPool !== 'function') {
    throw new ConnectionError('SQL Server catalog driver is missing ConnectionPool.');
  }
  return driver;
}

function refuseQuery(): never {
  throw new ValidationError(
    'SQL Server tools accept fixed catalog reads only; arbitrary SQL and data execution are refused.',
  );
}

/** Await native cleanup in the dispatcher; PgCompat release() itself returns void. */
export async function releaseMssqlToolClient(client: PgCompatPoolClient): Promise<void> {
  const session = sessions.get(client);
  if (!session) throw new ValidationError('SQL Server tools require an owned catalog connection.');
  await session.release();
}

/** Lazy optional transport. An application-owned native pool is never accepted. */
export function createMssqlToolPool(url: string, schema: string): PgCompatPool {
  const config = configFor(url, schema);
  let closed = false;
  const active = new Set<Session>();
  const pending = new Set<Promise<PgCompatPoolClient>>();
  const cleanup = new Set<Promise<void>>();
  let cleanupFailure: unknown;
  async function connect(): Promise<PgCompatPoolClient> {
    if (closed) throw new ValidationError('SQL Server tool transport is closed.');
    const driver = await loadDriver();
    if (closed) throw new ValidationError('SQL Server tool transport is closed.');
    let native: NativePool;
    try {
      native = new driver.ConnectionPool(config);
    } catch {
      throw new ConnectionError('SQL Server catalog connection construction failed.');
    }
    let poolError: unknown;
    native.on('error', (error) => {
      poolError = error;
    });
    let ready: Promise<unknown>;
    let closing: Promise<void> | undefined;
    const session: Session = {
      schema,
      active: true,
      busy: false,
      async exec(sql, params) {
        if (!session.active || closed) throw new ValidationError('SQL Server tool connection was released.');
        if (poolError !== undefined) throw new ConnectionError('SQL Server catalog connection failed.');
        try {
          const request = native.request();
          for (let i = 0; i < params.length; i++) request.input(`p${i + 1}`, params[i]);
          const response = await request.query(sql);
          if (!session.active || closed || poolError !== undefined) throw new Error('inactive catalog connection');
          return response.recordset ?? [];
        } catch {
          throw new ConnectionError(
            'SQL Server catalog read failed. Check connection and catalog visibility permissions.',
          );
        }
      },
      release() {
        session.active = false;
        if (!closing) {
          closing = (async () => {
            try {
              await ready.catch(() => undefined);
              await session.work?.catch(() => undefined);
              await native.close();
            } catch {
              throw new ConnectionError('SQL Server catalog connection cleanup failed.');
            } finally {
              active.delete(session);
            }
          })();
          cleanup.add(closing);
          // release() is also callable through the synchronous PgCompat interface.
          void closing
            .catch((error) => {
              cleanupFailure ??= error;
            })
            .finally(() => cleanup.delete(closing!));
        }
        return closing;
      },
    };
    active.add(session);
    ready = Promise.resolve().then(() => native.connect());
    try {
      await ready;
      if (closed) throw new ValidationError('SQL Server tool transport is closed.');
      if (poolError !== undefined) throw new ConnectionError('SQL Server catalog connection failed.');
      const client: PgCompatPoolClient = {
        query: refuseQuery,
        release() {
          void session.release();
        },
      };
      sessions.set(client, session);
      return client;
    } catch (error) {
      await session.release();
      if (error instanceof ValidationError || error instanceof ConnectionError) throw error;
      throw new ConnectionError('SQL Server catalog connection failed.');
    }
  }
  return {
    query: refuseQuery,
    connect() {
      const opening = connect();
      pending.add(opening);
      void opening.finally(() => pending.delete(opening)).catch(() => undefined);
      return opening;
    },
    async end() {
      closed = true;
      await Promise.allSettled([...pending]);
      for (const session of active) void session.release();
      await Promise.allSettled(cleanup);
      if (cleanupFailure !== undefined) throw cleanupFailure;
    },
  };
}

// These reads fetch flags and identifiers, never computed/default/filter SQL text.
const COLUMN_FLAGS = `SELECT s.name AS TABLE_SCHEMA, t.name AS TABLE_NAME, c.name AS COLUMN_NAME,
  c.is_computed AS IS_COMPUTED, c.is_identity AS IS_IDENTITY
  FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  WHERE s.name = @p1 ORDER BY t.name, c.column_id`;
const INDEX_FLAGS = `SELECT t.name AS TABLE_NAME, i.name AS INDEX_NAME,
  i.is_primary_key AS IS_PRIMARY_KEY, i.is_unique AS IS_UNIQUE,
  i.has_filter AS HAS_FILTER, i.is_disabled AS IS_DISABLED,
  i.is_hypothetical AS IS_HYPOTHETICAL, i.type_desc AS INDEX_TYPE,
  c.name AS COLUMN_NAME, c.is_computed AS IS_COMPUTED,
  ic.is_included_column AS IS_INCLUDED, ic.key_ordinal AS KEY_ORDINAL
  FROM sys.indexes i JOIN sys.tables t ON t.object_id = i.object_id
  JOIN sys.schemas s ON s.schema_id = t.schema_id
  JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
  JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
  WHERE s.name = @p1 AND i.name IS NOT NULL
  ORDER BY t.name, i.name, ic.key_ordinal, ic.index_column_id`;

const bit = (value: unknown): boolean => value === true || value === 1 || value === '1';

async function readMetadata(
  session: Session,
  options: { include?: string[]; exclude?: string[]; legacyToManyUniques?: boolean },
) {
  const columns = await session.exec(COLUMN_FLAGS, [session.schema]);
  const indexes = await session.exec(INDEX_FLAGS, [session.schema]);
  const metadata = await introspectMssqlWith(session.exec, session.schema, options);
  const tri = (rows: Record<string, unknown>[], key: string): boolean | null => {
    if (!rows.length || rows.some((row) => ![true, false, 0, 1, '0', '1'].includes(row[key] as never))) return null;
    return rows.some((row) => bit(row[key]));
  };
  const namespaces = new Set(columns.map((row) => row.TABLE_SCHEMA));
  const namespace =
    namespaces.size === 1 && typeof columns[0]?.TABLE_SCHEMA === 'string' ? columns[0].TABLE_SCHEMA : null;
  const primaryKeys: MssqlDoctorCatalog['primaryKeys'] = Object.create(null);
  for (const table of Object.values(metadata.tables)) {
    const rows = indexes.filter((row) => row.TABLE_NAME === table.name && bit(row.IS_PRIMARY_KEY));
    const keys = rows
      .filter((row) => !bit(row.IS_INCLUDED) && Number(row.KEY_ORDINAL) > 0)
      .sort((a, b) => Number(a.KEY_ORDINAL) - Number(b.KEY_ORDINAL));
    const orderedKeysKnown =
      tri(rows, 'IS_INCLUDED') !== null &&
      tri(rows, 'HAS_FILTER') === false &&
      tri(keys, 'IS_COMPUTED') === false &&
      new Set(rows.map((row) => row.INDEX_NAME)).size === 1 &&
      keys.length > 0 &&
      keys.length === table.primaryKey.length &&
      keys.every((row, i) => Number(row.KEY_ORDINAL) === i + 1 && row.COLUMN_NAME === table.primaryKey[i]);
    primaryKeys[table.name] = {
      disabled: tri(rows, 'IS_DISABLED'),
      hypothetical: tri(rows, 'IS_HYPOTHETICAL'),
      orderedKeysKnown,
      method: rows[0]?.INDEX_TYPE === 'CLUSTERED' || rows[0]?.INDEX_TYPE === 'NONCLUSTERED' ? rows[0].INDEX_TYPE : null,
    };
  }
  doctorCatalogs.set(metadata, { namespace, primaryKeys });
  for (const table of Object.values(metadata.tables)) {
    delete table.checks;
    for (const column of table.columns) {
      delete column.defaultValue;
      delete column.generationExpression;
      const flags = columns.find((row) => row.TABLE_NAME === table.name && row.COLUMN_NAME === column.name);
      if (flags) {
        column.isGenerated = bit(flags.IS_IDENTITY);
        column.isGeneratedStored ||= bit(flags.IS_COMPUTED);
      }
      column.hasDefault ||= column.isGenerated === true || column.isGeneratedStored === true;
    }
    for (const index of table.indexes) {
      const flags = indexes.filter((row) => row.TABLE_NAME === table.name && row.INDEX_NAME === index.name);
      const partial = tri(flags, 'HAS_FILTER');
      const keys = flags
        .filter((row) => !bit(row.IS_INCLUDED) && Number(row.KEY_ORDINAL) > 0)
        .sort((a, b) => Number(a.KEY_ORDINAL) - Number(b.KEY_ORDINAL));
      const computed = tri(keys, 'IS_COMPUTED');
      const orderedKeysKnown =
        tri(flags, 'IS_INCLUDED') !== null &&
        keys.length === index.columns.length &&
        keys.length > 0 &&
        keys.every((row, i) => Number(row.KEY_ORDINAL) === i + 1 && row.COLUMN_NAME === index.columns[i]);
      // All index definitions are withheld, including expression-like column names.
      index.definition = '(definition withheld)';
      summaries.set(index, {
        name: index.name,
        columns: [...index.columns],
        unique: index.unique,
        nativeUnique: tri(flags, 'IS_UNIQUE'),
        partial,
        disabled: tri(flags, 'IS_DISABLED'),
        hypothetical: tri(flags, 'IS_HYPOTHETICAL'),
        computed,
        orderedKeysKnown,
        method:
          flags.length > 0 && flags.every((row) => row.INDEX_TYPE === flags[0]!.INDEX_TYPE)
            ? flags[0]!.INDEX_TYPE
            : null,
        includedColumns: flags.filter((row) => bit(row.IS_INCLUDED)).map((row) => String(row.COLUMN_NAME)),
        definitionWithheld: true,
        definition: index.definition,
      });
    }
  }
  return metadata;
}

/** Only an active owned token can reach the fixed native introspector. */
export async function introspectMssqlToolClient(
  client: PgCompatPoolClient,
  options: { include?: string[]; exclude?: string[]; legacyToManyUniques?: boolean },
): Promise<SchemaMetadata> {
  const session = sessions.get(client);
  if (!session?.active) throw new ValidationError('SQL Server tools require an active owned catalog connection.');
  if (session.busy) throw new ValidationError('SQL Server catalog introspection is already active on this connection.');
  session.busy = true;
  session.work = readMetadata(session, options);
  try {
    return await session.work;
  } finally {
    session.busy = false;
  }
}
