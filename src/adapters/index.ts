/**
 * turbine-orm — Database adapter interface
 *
 * Adapters allow Turbine to work with PostgreSQL-compatible databases that
 * have subtle differences (e.g. CockroachDB, YugabyteDB). The default
 * behavior remains standard PostgreSQL — adapters only override specific
 * operations where compatibility gaps exist.
 *
 * @example
 * ```ts
 * import { cockroachdb } from 'turbine-orm/adapters';
 *
 * // Pass to TurbineCliConfig or migration functions
 * const config = { url: process.env.DATABASE_URL, adapter: cockroachdb };
 * ```
 */

import type { PgCompatPoolClient } from '../client.js';

// ---------------------------------------------------------------------------
// Introspection overrides
// ---------------------------------------------------------------------------

/**
 * Override individual introspection SQL queries for databases where
 * pg_catalog or information_schema behaves differently.
 */
export interface IntrospectionOverrides {
  /** Override the pg_indexes query (CockroachDB uses crdb_internal or show indexes) */
  indexes: string;
  /** Override the pg_enum query */
  enums: string;
  /** Override the row count estimation query (pg_class reltuples) */
  rowEstimates: string;
}

// ---------------------------------------------------------------------------
// Database adapter interface
// ---------------------------------------------------------------------------

/**
 * A DatabaseAdapter encapsulates dialect-specific behavior for databases
 * that speak the PostgreSQL wire protocol but differ in implementation.
 *
 * All methods are optional except `name`. Turbine falls through to standard
 * PostgreSQL behavior for any method not provided by the adapter.
 */
export interface DatabaseAdapter {
  /** Identifier for the adapter (e.g. 'postgresql', 'cockroachdb') */
  readonly name: string;

  /**
   * Acquire a concurrency lock for migrations.
   * PostgreSQL uses `pg_try_advisory_lock`. CockroachDB uses a lock table.
   *
   * @returns `true` if the lock was successfully acquired.
   */
  acquireLock(client: PgCompatPoolClient, lockId: number): Promise<boolean>;

  /**
   * Release the concurrency lock acquired by `acquireLock`.
   */
  releaseLock(client: PgCompatPoolClient, lockId: number): Promise<void>;

  /**
   * Optional overrides for introspection queries where the default
   * information_schema/pg_catalog queries don't work.
   */
  introspectionOverrides?: Partial<IntrospectionOverrides>;

  /**
   * Generate the SQL to set a statement timeout within a transaction.
   * PostgreSQL uses `SET LOCAL statement_timeout = $1`.
   * CockroachDB uses `SET transaction_timeout = $1` (v23.1+).
   *
   * @param seconds — timeout in seconds
   * @returns an object with the parameterized SQL and its bound values
   */
  statementTimeout?(seconds: number): { sql: string; params: unknown[] };

  /**
   * SQL to create the lock table used by table-based locking adapters.
   * Called during `ensureTrackingTable` when the adapter uses table locks.
   */
  createLockTableSQL?(): string;
}

// ---------------------------------------------------------------------------
// Default PostgreSQL adapter (no-op — standard behavior)
// ---------------------------------------------------------------------------

/**
 * The default PostgreSQL adapter. Uses pg_try_advisory_lock, standard
 * pg_catalog queries, and SET LOCAL statement_timeout.
 */
export const postgresql: DatabaseAdapter = {
  name: 'postgresql',

  async acquireLock(client, lockId) {
    const result = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [lockId]);
    return result.rows[0]?.locked ?? false;
  },

  async releaseLock(client, lockId) {
    await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
  },

  statementTimeout(seconds) {
    // `SET LOCAL ... = $1` is a Postgres syntax error — SET does not accept
    // bind parameters. `set_config(name, value, is_local=true)` is the
    // parameterizable, transaction-local equivalent.
    return { sql: `SELECT set_config('statement_timeout', $1, true)`, params: [`${seconds}s`] };
  },
};

// ---------------------------------------------------------------------------
// AlloyDB — fully PostgreSQL-compatible, no adapter logic needed
// ---------------------------------------------------------------------------

/**
 * Google AlloyDB adapter. AlloyDB is PostgreSQL with Google's columnar storage
 * engine. It is wire-protocol and catalog-compatible — no adapter overrides
 * are needed. All Turbine features (json_agg, advisory locks, introspection,
 * migrations) work identically to standard PostgreSQL.
 *
 * This export exists for documentation and explicit configuration:
 *
 * ```ts
 * import { alloydb } from 'turbine-orm/adapters';
 * const config = { url: process.env.DATABASE_URL, adapter: alloydb };
 * ```
 */
export const alloydb: DatabaseAdapter = {
  ...postgresql,
  name: 'alloydb',
};

// ---------------------------------------------------------------------------
// TimescaleDB — PostgreSQL extension, fully compatible
// ---------------------------------------------------------------------------

/**
 * TimescaleDB adapter. Timescale is a PostgreSQL extension that adds
 * hypertables, continuous aggregates, and time-series optimizations.
 * Standard tables and hypertables both introspect via information_schema
 * identically. Advisory locks, json_agg, and all other Turbine features
 * work without modification.
 *
 * This export exists for documentation and explicit configuration:
 *
 * ```ts
 * import { timescale } from 'turbine-orm/adapters';
 * const config = { url: process.env.DATABASE_URL, adapter: timescale };
 * ```
 */
export const timescale: DatabaseAdapter = {
  ...postgresql,
  name: 'timescale',
};

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { cockroachdb } from './cockroachdb.js';
export { yugabytedb } from './yugabytedb.js';
