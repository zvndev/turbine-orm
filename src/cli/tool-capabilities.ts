/** Effective facts for the read-only CLI/MCP surface, independent of ORM transports. */
import { postgresDialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { sqliteDialect } from '../sqlite.js';
import { mssqlToolRuntime, mssqlToolSupported, mssqlToolTransport } from './mssql-tools.js';
import { MYSQL_TOOLS, mysqlToolRuntime, mysqlToolTransport } from './mysql-tools.js';
import { sqliteToolRuntime } from './sqlite-tools.js';

export type ToolEngine = 'postgresql' | 'sqlite' | 'mysql' | 'mssql';

/** The implemented tool names; used by both discovery and dispatch. */
export const READ_ONLY_TOOLS = [
  'schema_overview',
  'table_detail',
  'migrate_status',
  'doctor_report',
  'explain_query',
  'compile_query',
  'sample_rows',
  'relation_graph',
  'find_join_path',
  'table_stats',
  'explain_error',
  'engine_capabilities',
] as const;

const SQLITE_TOOLS: readonly string[] = READ_ONLY_TOOLS.filter(
  (name) => !['migrate_status', 'explain_query', 'table_stats'].includes(name),
);

/** Refuse unknown engines instead of silently compiling PostgreSQL SQL. */
export function toolEngine(value: unknown): ToolEngine {
  if (value === undefined || value === 'postgresql') return 'postgresql';
  if (value === 'sqlite') return 'sqlite';
  if (value === 'mysql') return 'mysql';
  if (value === 'mssql') return 'mssql';
  throw new ValidationError('Read-only tools support engines "postgresql", "sqlite", "mysql" and "mssql" only.');
}

/** Whether a tool is implemented for this engine, regardless of database connectivity. */
export function toolSupported(engine: ToolEngine, name: string): boolean {
  engine = toolEngine(engine);
  if (engine === 'mssql') return mssqlToolSupported(name);
  return (engine === 'mysql' ? MYSQL_TOOLS : engine === 'sqlite' ? SQLITE_TOOLS : READ_ONLY_TOOLS).includes(
    name as (typeof READ_ONLY_TOOLS)[number],
  );
}

/**
 * Version 1 describes this tooling transport, never an arbitrary application's pool.
 * No connection or SQL probe is made. Server versions/connectivity remain unknown.
 * @example discoverToolCapabilities('sqlite')
 */
export function discoverToolCapabilities(engine: ToolEngine, injectedPool = false) {
  engine = toolEngine(engine);
  const sqlite = engine === 'sqlite';
  const mysql = engine === 'mysql';
  const runtime =
    engine === 'mssql'
      ? mssqlToolRuntime()
      : mysql
        ? mysqlToolRuntime()
        : sqlite
          ? sqliteToolRuntime()
          : { available: true, minimumNode: null, reason: null };
  const dialect = engine === 'mssql' ? mssqlDialect : mysql ? mysqlDialect : sqlite ? sqliteDialect : postgresDialect;
  return {
    schemaVersion: 1 as const,
    scope: 'read-only-tools' as const,
    engine,
    runtime: { node: process.versions.node, ...runtime },
    databaseVersion: sqlite && runtime.available ? (process.versions.sqlite ?? null) : null,
    databaseVersionSource: sqlite && runtime.available ? 'node-runtime' : 'unknown',
    connectivity: 'not-probed',
    // Copy the compiler's actual facts. JSON must distinguish infinity from unknown/null.
    sql: Object.fromEntries(
      Object.entries(dialect.capabilities).map(([key, value]) => [
        key,
        typeof value === 'number' && !Number.isFinite(value) ? 'unbounded' : value,
      ]),
    ),
    transport:
      engine === 'mssql'
        ? mssqlToolTransport
        : mysql
          ? mysqlToolTransport
          : {
              kind: sqlite ? 'node:sqlite' : injectedPool ? 'injected-pool' : 'pg-pool',
              sessions: injectedPool ? null : true,
              transactions: injectedPool ? null : true,
              cursors: false,
              pipeline: false,
              readOnlyEnforcement: sqlite
                ? 'database-open-read-only'
                : injectedPool
                  ? 'requested-transaction-read-only-unverified'
                  : 'transaction-read-only',
              statementTimeout: sqlite ? false : 'transaction-local-30s',
              ownership: sqlite
                ? 'one-owned-handle-per-call'
                : injectedPool
                  ? 'server-closes-injected-pool'
                  : 'server-owned-pool',
              note: 'These facts describe the tool adapter. Cursors, pipeline and write transactions are not exposed by tools.',
            },
    tools: READ_ONLY_TOOLS.map((name) => {
      const implemented = toolSupported(engine, name);
      const needsDatabase = name !== 'engine_capabilities' && name !== 'explain_error';
      return {
        name,
        implemented,
        available: implemented && (!needsDatabase || runtime.available),
        needsDatabase,
        reason: !implemented
          ? 'Not implemented for this engine.'
          : needsDatabase && !runtime.available
            ? runtime.reason
            : null,
      };
    }),
  };
}
