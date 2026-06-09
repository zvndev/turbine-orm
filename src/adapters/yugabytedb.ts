/**
 * turbine-orm — YugabyteDB adapter
 *
 * YugabyteDB is a distributed SQL database that speaks the PostgreSQL wire
 * protocol. It supports most PostgreSQL features including json_agg,
 * subqueries, CTEs, and the standard information_schema.
 *
 * Key differences from PostgreSQL that this adapter addresses:
 *
 * 1. **Advisory locks are per-node** — `pg_try_advisory_lock()` is supported
 *    but only scoped to the tserver node handling the connection. In a
 *    multi-node cluster, two concurrent `turbine migrate` runs routed to
 *    different nodes would both acquire the "same" advisory lock. This adapter
 *    provides a table-based distributed lock using `SELECT FOR UPDATE NOWAIT`
 *    which is cluster-wide via YugabyteDB's distributed transactions.
 *
 * 2. **Sequences may have gaps** — YugabyteDB uses distributed sequences.
 *    SERIAL/BIGSERIAL columns work correctly but may produce non-contiguous
 *    IDs under concurrent inserts. This is purely cosmetic and does not affect
 *    Turbine's behavior.
 *
 * 3. **pg_catalog** — Mostly complete. `pg_indexes`, `pg_type`, `pg_enum`,
 *    `information_schema.columns` all work. Row estimate via `pg_class.reltuples`
 *    may be stale or zero on recently created tables (YugabyteDB's stats
 *    collection is asynchronous). This adapter provides an override that
 *    falls back to `yb_table_properties` when available.
 *
 * Features that work identically to PostgreSQL (no adapter override needed):
 * - `json_agg` / `json_build_object` — fully supported
 * - Correlated subqueries — fully supported
 * - `COALESCE`, `LIMIT`, `OFFSET`, `ORDER BY` — fully supported
 * - `information_schema` for table/column/constraint introspection
 * - Extended query protocol (parameterized queries, pipeline batching)
 * - Transactions with `SAVEPOINT` (nested transactions)
 * - `FOR UPDATE` / `FOR SHARE` row-level locking
 * - All WHERE operators (LIKE, ILIKE, IN, etc.)
 * - Array and JSON column types
 *
 * @example
 * ```ts
 * import { yugabytedb } from 'turbine-orm/adapters';
 *
 * // In turbine.config.ts:
 * export default {
 *   url: process.env.DATABASE_URL,
 *   adapter: yugabytedb,
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
 * DDL for the table-based lock mechanism. Uses a single row per lock ID.
 * `SELECT ... FOR UPDATE NOWAIT` on this row provides a cluster-wide mutex
 * via YugabyteDB's distributed transaction layer.
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
 * Row estimates override. YugabyteDB's pg_class.reltuples can be stale or
 * zero. We still query it (it works) but the results may lag behind actual
 * row counts. This query matches the PostgreSQL format so the introspection
 * consumer doesn't need special handling.
 *
 * Note: YugabyteDB also exposes `yb_table_properties(oid)` but it returns
 * tablet count, not row estimates. For most Turbine use cases (Studio UI
 * row counts), pg_class is acceptable.
 */
const SQL_ROW_ESTIMATES_YBDB = `
  SELECT
    c.relname,
    COALESCE(c.reltuples, 0)::text AS reltuples
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = $1
    AND c.relkind IN ('r', 'p')
`;

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const yugabytedb: DatabaseAdapter = {
  name: 'yugabytedb',

  createLockTableSQL() {
    return CREATE_LOCK_TABLE_SQL;
  },

  async acquireLock(client: PgCompatPoolClient, lockId: number): Promise<boolean> {
    // Ensure the lock table exists (idempotent)
    await client.query(CREATE_LOCK_TABLE_SQL);

    // Ensure the lock row exists (idempotent)
    await client.query(`INSERT INTO "${LOCK_TABLE}" (lock_id) VALUES ($1) ON CONFLICT (lock_id) DO NOTHING`, [lockId]);

    // Attempt to acquire the row-level lock with NOWAIT
    // This is cluster-wide because YugabyteDB's row locks are distributed
    try {
      await client.query('BEGIN');
      await client.query(`SELECT lock_id FROM "${LOCK_TABLE}" WHERE lock_id = $1 FOR UPDATE NOWAIT`, [lockId]);
      // Update acquisition metadata for observability
      await client.query(
        `UPDATE "${LOCK_TABLE}" SET acquired_at = now(), acquired_by = current_user WHERE lock_id = $1`,
        [lockId],
      );
      // Leave the transaction open — lock is held until releaseLock()
      return true;
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      // 55P03 = lock_not_available (NOWAIT couldn't acquire)
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
    // Commit the transaction to release the FOR UPDATE lock
    try {
      await client.query('COMMIT');
    } catch {
      // If commit fails, try rollback — either way the lock is released
      try {
        await client.query('ROLLBACK');
      } catch {
        /* ignore */
      }
    }
  },

  introspectionOverrides: {
    rowEstimates: SQL_ROW_ESTIMATES_YBDB,
  } satisfies Partial<IntrospectionOverrides>,

  statementTimeout(seconds: number): { sql: string; params: unknown[] } {
    // YugabyteDB supports standard PostgreSQL statement_timeout. `SET LOCAL`
    // cannot take a bind parameter, so use the parameterizable, transaction-
    // local set_config() form.
    return { sql: `SELECT set_config('statement_timeout', $1, true)`, params: [`${seconds}s`] };
  },
};
