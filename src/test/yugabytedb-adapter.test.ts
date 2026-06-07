/**
 * Unit tests for the YugabyteDB adapter.
 *
 * Validates that the adapter correctly implements the DatabaseAdapter interface
 * and generates the expected SQL for table-based locking.
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { DatabaseAdapter } from '../adapters/index.js';
import { yugabytedb } from '../adapters/yugabytedb.js';

// ---------------------------------------------------------------------------
// Mock client for capturing SQL queries
// ---------------------------------------------------------------------------

interface QueryCall {
  text: string;
  values?: unknown[];
}

function createMockClient() {
  const calls: QueryCall[] = [];
  let shouldFailOnForUpdate = false;

  const client = {
    calls,
    setShouldFailOnForUpdate(v: boolean) {
      shouldFailOnForUpdate = v;
    },
    query: mock.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });

      // Simulate lock_not_available error on FOR UPDATE NOWAIT
      if (shouldFailOnForUpdate && text.includes('FOR UPDATE NOWAIT')) {
        const err = new Error('could not obtain lock on row') as Error & { code: string };
        err.code = '55P03';
        throw err;
      }

      // Default: return rows with locked = true
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: true }] };
      }
      return { rows: [] };
    }),
  };

  return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('yugabytedb adapter', () => {
  it('has the correct name', () => {
    assert.equal(yugabytedb.name, 'yugabytedb');
  });

  it('implements DatabaseAdapter interface', () => {
    // Verify all required and optional methods exist
    const adapter: DatabaseAdapter = yugabytedb;
    assert.equal(typeof adapter.name, 'string');
    assert.equal(typeof adapter.acquireLock, 'function');
    assert.equal(typeof adapter.releaseLock, 'function');
    assert.equal(typeof adapter.createLockTableSQL, 'function');
    assert.equal(typeof adapter.statementTimeout, 'function');
    assert.ok(adapter.introspectionOverrides !== undefined);
  });

  describe('acquireLock', () => {
    it('creates lock table, inserts row, and acquires FOR UPDATE lock', async () => {
      const client = createMockClient();
      // biome-ignore lint/suspicious/noExplicitAny: mock client
      const result = await yugabytedb.acquireLock(client as any, 42);

      assert.equal(result, true);

      // Should have issued these queries in order:
      // 1. CREATE TABLE IF NOT EXISTS (lock table)
      // 2. INSERT ... ON CONFLICT DO NOTHING (ensure row)
      // 3. BEGIN
      // 4. SELECT ... FOR UPDATE NOWAIT (acquire lock)
      // 5. UPDATE ... SET acquired_at (metadata)
      assert.ok(client.calls.length >= 5);

      const createTable = client.calls[0]!;
      assert.ok(createTable.text.includes('CREATE TABLE IF NOT EXISTS'));
      assert.ok(createTable.text.includes('_turbine_lock'));

      const insertRow = client.calls[1]!;
      assert.ok(insertRow.text.includes('INSERT INTO'));
      assert.ok(insertRow.text.includes('ON CONFLICT'));
      assert.deepEqual(insertRow.values, [42]);

      const begin = client.calls[2]!;
      assert.equal(begin.text, 'BEGIN');

      const selectForUpdate = client.calls[3]!;
      assert.ok(selectForUpdate.text.includes('FOR UPDATE NOWAIT'));
      assert.deepEqual(selectForUpdate.values, [42]);

      const updateMeta = client.calls[4]!;
      assert.ok(updateMeta.text.includes('UPDATE'));
      assert.ok(updateMeta.text.includes('acquired_at'));
      assert.deepEqual(updateMeta.values, [42]);
    });

    it('returns false when lock is already held (55P03)', async () => {
      const client = createMockClient();
      client.setShouldFailOnForUpdate(true);

      // biome-ignore lint/suspicious/noExplicitAny: mock client
      const result = await yugabytedb.acquireLock(client as any, 99);

      assert.equal(result, false);

      // Should have rolled back after the 55P03 error
      const rollbackCall = client.calls.find((c) => c.text === 'ROLLBACK');
      assert.ok(rollbackCall !== undefined, 'Should issue ROLLBACK on lock failure');
    });

    it('re-throws non-lock errors', async () => {
      const client = createMockClient();
      // Override to throw a different error
      client.query = mock.fn(async (text: string, _values?: unknown[]) => {
        if (text.includes('FOR UPDATE NOWAIT')) {
          const err = new Error('connection lost') as Error & { code: string };
          err.code = '08006';
          throw err;
        }
        return { rows: [] };
      });

      await assert.rejects(
        // biome-ignore lint/suspicious/noExplicitAny: mock client
        () => yugabytedb.acquireLock(client as any, 1),
        (err: Error) => {
          assert.ok(err.message.includes('connection lost'));
          return true;
        },
      );
    });
  });

  describe('releaseLock', () => {
    it('commits the transaction to release the row lock', async () => {
      const client = createMockClient();
      // biome-ignore lint/suspicious/noExplicitAny: mock client
      await yugabytedb.releaseLock(client as any, 42);

      assert.ok(client.calls.some((c) => c.text === 'COMMIT'));
    });

    it('falls back to ROLLBACK if COMMIT fails', async () => {
      const calls: string[] = [];
      const client = {
        query: mock.fn(async (text: string) => {
          calls.push(text);
          if (text === 'COMMIT') {
            throw new Error('commit failed');
          }
          return { rows: [] };
        }),
      };

      // Should not throw
      // biome-ignore lint/suspicious/noExplicitAny: mock client
      await yugabytedb.releaseLock(client as any, 42);

      assert.ok(calls.includes('COMMIT'));
      assert.ok(calls.includes('ROLLBACK'));
    });
  });

  describe('createLockTableSQL', () => {
    it('returns valid DDL for the lock table', () => {
      const sql = yugabytedb.createLockTableSQL!();
      assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS'));
      assert.ok(sql.includes('_turbine_lock'));
      assert.ok(sql.includes('lock_id'));
      assert.ok(sql.includes('INT PRIMARY KEY'));
      assert.ok(sql.includes('acquired_at'));
      assert.ok(sql.includes('acquired_by'));
    });
  });

  describe('statementTimeout', () => {
    it('uses set_config(statement_timeout, …, is_local) — SET LOCAL cannot take a bind param', () => {
      const result = yugabytedb.statementTimeout!(30);
      assert.equal(result.sql, "SELECT set_config('statement_timeout', $1, true)");
      assert.deepEqual(result.params, ['30s']);
    });

    it('handles different timeout values', () => {
      assert.deepEqual(yugabytedb.statementTimeout!(5), {
        sql: "SELECT set_config('statement_timeout', $1, true)",
        params: ['5s'],
      });
      assert.deepEqual(yugabytedb.statementTimeout!(120), {
        sql: "SELECT set_config('statement_timeout', $1, true)",
        params: ['120s'],
      });
    });
  });

  describe('introspectionOverrides', () => {
    it('provides rowEstimates override', () => {
      assert.ok(yugabytedb.introspectionOverrides !== undefined);
      assert.ok(yugabytedb.introspectionOverrides!.rowEstimates !== undefined);
      assert.ok(yugabytedb.introspectionOverrides!.rowEstimates!.includes('pg_class'));
      assert.ok(yugabytedb.introspectionOverrides!.rowEstimates!.includes('reltuples'));
    });

    it('does not override indexes or enums (they work with standard pg_catalog)', () => {
      assert.equal(yugabytedb.introspectionOverrides!.indexes, undefined);
      assert.equal(yugabytedb.introspectionOverrides!.enums, undefined);
    });
  });
});
