/**
 * turbine-orm — CockroachDB adapter unit tests
 *
 * Verifies the adapter's lock mechanism SQL, introspection overrides,
 * statement timeout generation, and lock behavior using mocked clients.
 * No actual CockroachDB connection is needed.
 *
 * Run: node --test --experimental-strip-types src/test/cockroachdb-adapter.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cockroachdb } from '../adapters/cockroachdb.js';
import { postgresql, yugabytedb } from '../adapters/index.js';
import type { PgCompatPoolClient, PgCompatQueryResult } from '../client.js';

// ---------------------------------------------------------------------------
// Mock client factory
// ---------------------------------------------------------------------------

interface MockQuery {
  text: string;
  values?: unknown[];
}

function createMockClient(options?: {
  lockError?: { code: string };
  queryResults?: Map<string, PgCompatQueryResult>;
}): { client: PgCompatPoolClient; queries: MockQuery[] } {
  const queries: MockQuery[] = [];

  const client: PgCompatPoolClient = {
    async query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>> {
      queries.push({ text, values });

      // Simulate lock contention if configured
      if (options?.lockError && text.includes('FOR UPDATE NOWAIT')) {
        throw options.lockError;
      }

      // Return custom results if configured
      if (options?.queryResults?.has(text)) {
        return options.queryResults.get(text)! as PgCompatQueryResult<R>;
      }

      // Default: return advisory lock result for postgresql adapter
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: true } as unknown as R], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  return { client, queries };
}

// ---------------------------------------------------------------------------
// CockroachDB adapter tests
// ---------------------------------------------------------------------------

describe('CockroachDB adapter', () => {
  describe('metadata', () => {
    it('has the correct name', () => {
      assert.equal(cockroachdb.name, 'cockroachdb');
    });

    it('provides createLockTableSQL', () => {
      assert.ok(cockroachdb.createLockTableSQL);
      const sql = cockroachdb.createLockTableSQL!();
      assert.ok(sql.includes('_turbine_lock'));
      assert.ok(sql.includes('lock_id'));
      assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS'));
    });
  });

  describe('acquireLock', () => {
    it('creates the lock table and row before acquiring', async () => {
      const { client, queries } = createMockClient();
      const result = await cockroachdb.acquireLock(client, 42);

      assert.equal(result, true);
      // Should have: CREATE TABLE, INSERT (lock row), BEGIN, SELECT FOR UPDATE, UPDATE
      const createTable = queries.find((q) => q.text.includes('CREATE TABLE'));
      assert.ok(createTable, 'should create the lock table');

      const insertRow = queries.find((q) => q.text.includes('INSERT INTO'));
      assert.ok(insertRow, 'should insert the lock row');
      assert.deepEqual(insertRow!.values, [42]);

      const beginQuery = queries.find((q) => q.text === 'BEGIN');
      assert.ok(beginQuery, 'should begin a transaction');

      const selectForUpdate = queries.find((q) => q.text.includes('FOR UPDATE NOWAIT'));
      assert.ok(selectForUpdate, 'should SELECT FOR UPDATE NOWAIT');
      assert.deepEqual(selectForUpdate!.values, [42]);
    });

    it('returns false when lock is held by another session (55P03)', async () => {
      const { client } = createMockClient({ lockError: { code: '55P03' } });
      const result = await cockroachdb.acquireLock(client, 42);

      assert.equal(result, false);
    });

    it('re-throws non-lock-contention errors', async () => {
      const { client } = createMockClient({ lockError: { code: '42P01' } });

      await assert.rejects(
        () => cockroachdb.acquireLock(client, 42),
        (err: unknown) => {
          return (err as { code: string }).code === '42P01';
        },
      );
    });

    it('rolls back on lock contention', async () => {
      const { client, queries } = createMockClient({ lockError: { code: '55P03' } });
      await cockroachdb.acquireLock(client, 42);

      const rollback = queries.find((q) => q.text === 'ROLLBACK');
      assert.ok(rollback, 'should rollback after contention');
    });
  });

  describe('releaseLock', () => {
    it('commits the transaction to release the lock', async () => {
      const { client, queries } = createMockClient();
      await cockroachdb.releaseLock(client, 42);

      const commit = queries.find((q) => q.text === 'COMMIT');
      assert.ok(commit, 'should COMMIT to release');
    });
  });

  describe('statementTimeout', () => {
    it('generates CockroachDB-specific timeout syntax', () => {
      const result = cockroachdb.statementTimeout!(30);
      assert.equal(result.sql, 'SET transaction_timeout = $1');
      assert.deepEqual(result.params, ['30s']);
    });

    it('handles different timeout values', () => {
      assert.deepEqual(cockroachdb.statementTimeout!(5), { sql: 'SET transaction_timeout = $1', params: ['5s'] });
      assert.deepEqual(cockroachdb.statementTimeout!(60), { sql: 'SET transaction_timeout = $1', params: ['60s'] });
    });
  });

  describe('introspectionOverrides', () => {
    it('provides index override query', () => {
      assert.ok(cockroachdb.introspectionOverrides?.indexes);
      assert.ok(cockroachdb.introspectionOverrides!.indexes.includes('pg_indexes'));
    });

    it('provides row estimate override using crdb_internal', () => {
      assert.ok(cockroachdb.introspectionOverrides?.rowEstimates);
      assert.ok(cockroachdb.introspectionOverrides!.rowEstimates.includes('crdb_internal'));
    });

    it('provides enum override query', () => {
      assert.ok(cockroachdb.introspectionOverrides?.enums);
      assert.ok(cockroachdb.introspectionOverrides!.enums.includes('pg_enum'));
    });
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL adapter tests (default)
// ---------------------------------------------------------------------------

describe('PostgreSQL adapter (default)', () => {
  it('has the correct name', () => {
    assert.equal(postgresql.name, 'postgresql');
  });

  it('uses pg_try_advisory_lock', async () => {
    const { client, queries } = createMockClient();
    const result = await postgresql.acquireLock(client, 99);

    assert.equal(result, true);
    const advisory = queries.find((q) => q.text.includes('pg_try_advisory_lock'));
    assert.ok(advisory, 'should call pg_try_advisory_lock');
    assert.deepEqual(advisory!.values, [99]);
  });

  it('uses pg_advisory_unlock for release', async () => {
    const { client, queries } = createMockClient();
    await postgresql.releaseLock(client, 99);

    const unlock = queries.find((q) => q.text.includes('pg_advisory_unlock'));
    assert.ok(unlock, 'should call pg_advisory_unlock');
    assert.deepEqual(unlock!.values, [99]);
  });

  it('generates standard statement_timeout', () => {
    const result = postgresql.statementTimeout!(30);
    assert.equal(result.sql, 'SET LOCAL statement_timeout = $1');
    assert.deepEqual(result.params, ['30s']);
  });
});

// ---------------------------------------------------------------------------
// YugabyteDB adapter tests
// ---------------------------------------------------------------------------

describe('YugabyteDB adapter', () => {
  it('has the correct name', () => {
    assert.equal(yugabytedb.name, 'yugabytedb');
  });

  it('uses table-based locking (same strategy as CockroachDB)', async () => {
    const { client, queries } = createMockClient();
    const result = await yugabytedb.acquireLock(client, 7);

    assert.equal(result, true);
    const forUpdate = queries.find((q) => q.text.includes('FOR UPDATE NOWAIT'));
    assert.ok(forUpdate, 'should use FOR UPDATE NOWAIT');
  });

  it('generates standard PostgreSQL statement_timeout', () => {
    const result = yugabytedb.statementTimeout!(15);
    assert.equal(result.sql, 'SET LOCAL statement_timeout = $1');
    assert.deepEqual(result.params, ['15s']);
  });

  it('provides row estimates override', () => {
    assert.ok(yugabytedb.introspectionOverrides?.rowEstimates);
    assert.ok(yugabytedb.introspectionOverrides!.rowEstimates.includes('pg_class'));
  });

  it('returns false when lock is contended', async () => {
    const { client } = createMockClient({ lockError: { code: '55P03' } });
    const result = await yugabytedb.acquireLock(client, 7);
    assert.equal(result, false);
  });
});

// ---------------------------------------------------------------------------
// Adapter interchangeability
// ---------------------------------------------------------------------------

describe('Adapter interface compliance', () => {
  const adapters = [postgresql, cockroachdb, yugabytedb];

  for (const adapter of adapters) {
    it(`${adapter.name} satisfies DatabaseAdapter interface`, () => {
      assert.equal(typeof adapter.name, 'string');
      assert.equal(typeof adapter.acquireLock, 'function');
      assert.equal(typeof adapter.releaseLock, 'function');
      if (adapter.statementTimeout) {
        assert.equal(typeof adapter.statementTimeout, 'function');
        const result = adapter.statementTimeout(10);
        assert.equal(typeof result.sql, 'string');
        assert.ok(result.sql.length > 0);
        assert.ok(Array.isArray(result.params));
      }
    });
  }
});
