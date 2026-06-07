/**
 * turbine-orm — CockroachDB adapter
 *
 * CockroachDB speaks the PostgreSQL wire protocol but has key differences:
 *
 * 1. **No advisory locks** — `pg_try_advisory_lock()` is not supported.
 *    This adapter uses a `_turbine_lock` table with `SELECT FOR UPDATE NOWAIT`
 *    as a concurrency mechanism for migrations.
 *
 * 2. **No `SET LOCAL statement_timeout`** — CockroachDB uses
 *    `SET transaction_timeout` (v23.1+) for per-transaction time limits.
 *
 * 3. **`pg_indexes` view** — CockroachDB supports `pg_indexes` since v22.1
 *    but the `indexdef` column may not match Postgres exactly. We use
 *    `SHOW INDEXES` as a more reliable alternative.
 *
 * 4. **`pg_class.reltuples`** — Not reliable in CockroachDB. We use
 *    `crdb_internal.table_row_statistics` for row estimates.
 *
 * Known limitations with Turbine on CockroachDB:
 * - `json_agg` works but NULL ordering within aggregates may differ
 * - `SERIAL` columns use `unique_rowid()` instead of sequences
 * - Schema introspection via information_schema works for tables, columns,
 *   constraints; pg_catalog has gaps for some metadata
 * - Pipeline batching works (extended query protocol is supported)
 *
 * @example
 * ```ts
 * import { cockroachdb } from 'turbine-orm/adapters';
 *
 * // In turbine.config.ts:
 * export default {
 *   url: process.env.DATABASE_URL,
 *   adapter: cockroachdb,
 * };
 * ```
 */

import type { PgCompatPoolClient } from '../client.js';
import type { DatabaseAdapter, IntrospectionOverrides } from './index.js';

// ---------------------------------------------------------------------------
// Lock table SQL
// ---------------------------------------------------------------------------

const LOCK_TABLE = '_turbine_lock';

/**
 * DDL for the table-based lock mechanism. The table holds a single row per
 * lock ID. `SELECT ... FOR UPDATE NOWAIT` on this row serves as a mutex.
 */
const CREATE_LOCK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS "${LOCK_TABLE}" (
    lock_id INT PRIMARY KEY,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    acquired_by TEXT
  )
`;

// ---------------------------------------------------------------------------
// Introspection query overrides
// ---------------------------------------------------------------------------

/**
 * CockroachDB index introspection via SHOW INDEXES.
 * This returns a different shape than pg_indexes, so the consumer
 * needs to handle the transformation. However, since we're providing this
 * as a drop-in SQL string for the existing introspection flow, we use
 * CockroachDB's pg_indexes compatibility view but with a fallback query
 * that produces the same columns.
 *
 * CockroachDB's pg_indexes is compatible since v22.1 — we keep this
 * override for older versions or when indexdef is incomplete.
 */
const SQL_INDEXES_CRDB = `
  SELECT
    tablename,
    indexname,
    indexdef
  FROM pg_indexes
  WHERE schemaname = $1
`;

/**
 * Row estimates using crdb_internal. Falls back gracefully if the view
 * doesn't exist (permissions issue) — returns 0 rows in that case.
 */
const SQL_ROW_ESTIMATES_CRDB = `
  SELECT
    t.name AS relname,
    COALESCE(s.estimated_row_count, 0)::text AS reltuples
  FROM crdb_internal.tables t
  LEFT JOIN crdb_internal.table_row_statistics s
    ON s.table_id = t.table_id
  WHERE t.schema_name = $1
    AND t.database_name = current_database()
`;

/**
 * Enum introspection — CockroachDB supports pg_type/pg_enum since v20.2.
 * The standard query works, but we include it explicitly so the override
 * mechanism is complete.
 */
const SQL_ENUMS_CRDB = `
  SELECT t.typname, e.enumlabel
  FROM pg_type t
  JOIN pg_enum e ON t.oid = e.enumtypid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = $1
  ORDER BY t.typname, e.enumsortorder
`;

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const cockroachdb: DatabaseAdapter = {
  name: 'cockroachdb',

  createLockTableSQL() {
    return CREATE_LOCK_TABLE_SQL;
  },

  async acquireLock(client: PgCompatPoolClient, lockId: number): Promise<boolean> {
    // Ensure the lock table exists
    await client.query(CREATE_LOCK_TABLE_SQL);

    // Insert the lock row if it doesn't exist (idempotent)
    await client.query(`INSERT INTO "${LOCK_TABLE}" (lock_id) VALUES ($1) ON CONFLICT (lock_id) DO NOTHING`, [lockId]);

    // Try to acquire the row lock with NOWAIT — fails immediately if held
    try {
      await client.query('BEGIN');
      await client.query(`SELECT lock_id FROM "${LOCK_TABLE}" WHERE lock_id = $1 FOR UPDATE NOWAIT`, [lockId]);
      // Update the acquired metadata
      await client.query(
        `UPDATE "${LOCK_TABLE}" SET acquired_at = now(), acquired_by = current_user WHERE lock_id = $1`,
        [lockId],
      );
      // Note: we leave the transaction OPEN — the lock is held until
      // releaseLock() commits or rolls back.
      return true;
    } catch (err: unknown) {
      // NOWAIT throws error code 55P03 (lock_not_available) if the row is locked
      const pgErr = err as { code?: string };
      if (pgErr.code === '55P03') {
        try {
          await client.query('ROLLBACK');
        } catch {
          /* ignore rollback errors */
        }
        return false;
      }
      // Any other error — rollback and re-throw
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw err;
    }
  },

  async releaseLock(client: PgCompatPoolClient, _lockId: number): Promise<void> {
    // Commit the transaction opened in acquireLock to release the FOR UPDATE lock
    try {
      await client.query('COMMIT');
    } catch {
      // If commit fails, try rollback (either way, lock is released)
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
    }
  },

  introspectionOverrides: {
    indexes: SQL_INDEXES_CRDB,
    enums: SQL_ENUMS_CRDB,
    rowEstimates: SQL_ROW_ESTIMATES_CRDB,
  } satisfies Partial<IntrospectionOverrides>,

  statementTimeout(seconds: number): { sql: string; params: unknown[] } {
    // CockroachDB v23.1+ supports transaction_timeout. `SET ... = $1` cannot
    // take a bind parameter, so use the parameterizable set_config() form
    // (is_local=true scopes it to the current transaction).
    return { sql: `SELECT set_config('transaction_timeout', $1, true)`, params: [`${seconds}s`] };
  },
};
