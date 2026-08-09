/**
 * turbine-orm, CockroachDB adapter unit tests
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
import { type DatabaseAdapter, postgresql, yugabytedb } from '../adapters/index.js';
import {
  acquireMigrationLock,
  type MigrationLockClient,
  releaseMigrationLock,
  runMigrationInTransaction,
} from '../cli/migrate.js';
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
// A fake server that models the ONE property this lock depends on:
// `SELECT ... FOR UPDATE NOWAIT` holds the row only while its transaction is
// open, and COMMIT/ROLLBACK on that connection ends it.
// ---------------------------------------------------------------------------

class FakeLockServer {
  /** Id of the connection currently holding the lock row, or null. */
  heldBy: string | null = null;
  /** Every statement, in order, tagged with the connection that sent it. */
  readonly log: Array<{ id: string; sql: string }> = [];
  /** Connections that have been closed via end(). */
  readonly closed: string[] = [];

  private readonly inTx = new Set<string>();

  client(id: string): PgCompatPoolClient & MigrationLockClient {
    const server = this;
    return {
      async query<R = Record<string, unknown>>(sql: string): Promise<PgCompatQueryResult<R>> {
        server.log.push({ id, sql });

        if (sql === 'BEGIN') {
          server.inTx.add(id);
        } else if (sql === 'COMMIT' || sql === 'ROLLBACK') {
          server.inTx.delete(id);
          // The row lock is transaction-scoped: ending the transaction that
          // took it releases it, whoever ended it and for whatever reason.
          if (server.heldBy === id) server.heldBy = null;
        } else if (sql.includes('FOR UPDATE NOWAIT')) {
          if (server.heldBy !== null && server.heldBy !== id) {
            throw Object.assign(new Error('could not obtain lock'), { code: '55P03' });
          }
          server.heldBy = id;
        } else if (sql.includes('pg_try_advisory_lock')) {
          // Session-scoped: no transaction involved, and this fake never
          // contends on it, so it always succeeds.
          return { rows: [{ locked: true } as unknown as R], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
      async end(): Promise<void> {
        server.closed.push(id);
        server.inTx.delete(id);
        if (server.heldBy === id) server.heldBy = null;
      },
    };
  }
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

    it('treats a serialization failure (40001) as lock-not-acquired', async () => {
      // CockroachDB is SERIALIZABLE by default, so the same contention can
      // surface as an ordering conflict instead of a refused lock. Rethrowing
      // it crashed `turbine migrate` with a raw driver error rather than the
      // clean "another migration is already running" message.
      const { client, queries } = createMockClient({ lockError: { code: '40001' } });
      assert.equal(await cockroachdb.acquireLock(client, 42), false);
      assert.ok(
        queries.find((q) => q.text === 'ROLLBACK'),
        'should rollback after a serialization failure too',
      );
    });

    it('still re-throws a genuine failure such as a missing table', async () => {
      const { client } = createMockClient({ lockError: { code: '42P01' } });
      await assert.rejects(() => cockroachdb.acquireLock(client, 42));
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

  describe('lock lifetime', () => {
    it('declares that its lock lives in an open transaction', () => {
      // This is what tells the migration runner the lock needs its OWN
      // connection. The advisory-lock adapters are session-scoped and must not
      // set it, or they would open a second connection for nothing.
      assert.equal(cockroachdb.lockHoldsOpenTransaction, true);
      assert.equal(yugabytedb.lockHoldsOpenTransaction, true);
      assert.equal(postgresql.lockHoldsOpenTransaction, undefined);
    });

    it('releases the lock when a COMMIT is issued on the SAME connection', async () => {
      // The reason a dedicated connection is mandatory, stated as a test: a row
      // lock lives and dies with its transaction, and the runner issues a
      // COMMIT per migration. Asserting this here means the runner test below
      // is not passing by accident.
      const server = new FakeLockServer();
      const shared = server.client('shared');

      assert.equal(await cockroachdb.acquireLock(shared, 42), true);
      assert.equal(server.heldBy, 'shared');

      await shared.query('COMMIT'); // what runMigrationInTransaction does
      assert.equal(server.heldBy, null, 'a COMMIT on the lock connection drops the lock');
    });
  });

  describe('statementTimeout', () => {
    it('generates CockroachDB-specific timeout syntax via set_config', () => {
      const result = cockroachdb.statementTimeout!(30);
      assert.equal(result.sql, "SELECT set_config('transaction_timeout', $1, true)");
      assert.deepEqual(result.params, ['30s']);
    });

    it('handles different timeout values', () => {
      assert.deepEqual(cockroachdb.statementTimeout!(5), {
        sql: "SELECT set_config('transaction_timeout', $1, true)",
        params: ['5s'],
      });
      assert.deepEqual(cockroachdb.statementTimeout!(60), {
        sql: "SELECT set_config('transaction_timeout', $1, true)",
        params: ['60s'],
      });
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

  it('generates standard statement_timeout via set_config', () => {
    const result = postgresql.statementTimeout!(30);
    assert.equal(result.sql, "SELECT set_config('statement_timeout', $1, true)");
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

  it('generates standard PostgreSQL statement_timeout via set_config', () => {
    const result = yugabytedb.statementTimeout!(15);
    assert.equal(result.sql, "SELECT set_config('statement_timeout', $1, true)");
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
// Migration-runner lock wiring
//
// The bug this covers: the runner took the table lock on the SAME pg.Client it
// then ran every migration on, and `runMigrationInTransaction` issues
// BEGIN ... COMMIT per file. The first migration's COMMIT ended the LOCK's
// transaction, so migrations 2..N ran unprotected and a concurrent
// `turbine migrate` could take the lock and replay them. It was silent:
// `releaseLock`'s later COMMIT is a no-op that warns rather than fails.
// ---------------------------------------------------------------------------

describe('migration lock wiring', () => {
  const TRACKING = { sql: 'INSERT INTO _turbine_migrations (name, checksum) VALUES ($1, $2)', params: ['m', 'h'] };

  /** Take the lock the way migrateUp/migrateDown do, against a fake server. */
  async function takeLock(server: FakeLockServer, adapter: DatabaseAdapter, runnerId = 'runner') {
    const runner = server.client(runnerId);
    const lockId = `${runnerId}-lock`;
    let opened = 0;
    const lock = await acquireMigrationLock(runner, 42, adapter, async () => {
      opened++;
      return server.client(lockId);
    });
    return { runner, lock, lockId, openedConnections: () => opened };
  }

  for (const adapter of [cockroachdb, yugabytedb]) {
    it(`${adapter.name}: the lock survives every migration's COMMIT`, async () => {
      const server = new FakeLockServer();
      const { runner, lock, lockId, openedConnections } = await takeLock(server, adapter);

      assert.equal(lock.acquired, true);
      assert.equal(openedConnections(), 1, 'a table-lock adapter needs its own connection');
      assert.equal(server.heldBy, lockId);

      // Three migrations, each in its own transaction, exactly as the runner
      // applies them. Without the dedicated connection the FIRST COMMIT here
      // released the lock and the remaining two ran unprotected.
      for (const body of ['CREATE TABLE a (id int)', 'CREATE TABLE b (id int)', 'CREATE TABLE c (id int)']) {
        assert.equal(await runMigrationInTransaction(runner, body, TRACKING), null);
        assert.equal(server.heldBy, lockId, `lock lost after committing: ${body}`);
      }

      // A concurrent `turbine migrate` is still refused the whole time.
      const rival = await takeLock(server, adapter, 'rival');
      assert.equal(rival.lock.acquired, false);

      await releaseMigrationLock(lock, runner);
      assert.equal(server.heldBy, null, 'release must actually free the lock');
      assert.ok(server.closed.includes(lockId), 'the dedicated connection must be closed');
      assert.ok(!server.closed.includes('runner'), 'the runner connection is closed by its own caller');
    });

    it(`${adapter.name}: a no-transaction migration does not run inside the lock transaction`, async () => {
      // Second face of the same bug: with a shared connection, a
      // `-- turbine:no-transaction` migration running FIRST executed inside the
      // still-open lock transaction, so CREATE INDEX CONCURRENTLY failed with
      // "cannot run inside a transaction block" while the identical file placed
      // second succeeded. Order-dependent, so it presented as flaky.
      const server = new FakeLockServer();
      const { runner, lock } = await takeLock(server, adapter);

      await runner.query('CREATE INDEX CONCURRENTLY idx ON t (x)');

      const runnerLog = server.log.filter((e) => e.id === 'runner');
      assert.deepEqual(
        runnerLog.map((e) => e.sql),
        ['CREATE INDEX CONCURRENTLY idx ON t (x)'],
        'the runner connection must have issued no BEGIN of its own',
      );
      await releaseMigrationLock(lock, runner);
    });

    it(`${adapter.name}: a refused lock closes the connection it opened`, async () => {
      const server = new FakeLockServer();
      const holder = await takeLock(server, adapter, 'holder');
      assert.equal(holder.lock.acquired, true);

      const loser = await takeLock(server, adapter, 'loser');
      assert.equal(loser.lock.acquired, false);
      assert.equal(loser.lock.lockClient, undefined);
      assert.ok(server.closed.includes(loser.lockId), 'a refused lock must not leak its connection');

      // Releasing a lock we never held must not unlock somebody else's.
      await releaseMigrationLock(loser.lock, loser.runner);
      assert.equal(server.heldBy, holder.lockId);
    });
  }

  it('postgresql: the advisory path opens NO second connection and is unchanged', async () => {
    const server = new FakeLockServer();
    const runner = server.client('runner');
    let opened = 0;
    const lock = await acquireMigrationLock(runner, 42, postgresql, async () => {
      opened++;
      return server.client('lock');
    });

    assert.equal(opened, 0, 'a session-scoped lock must keep using the runner connection');
    assert.equal(lock.lockClient, undefined);

    await releaseMigrationLock(lock, runner);
    assert.deepEqual(
      server.log.map((e) => `${e.id}:${e.sql.trim()}`),
      ['runner:SELECT pg_try_advisory_lock($1) AS locked', 'runner:SELECT pg_advisory_unlock($1)'],
    );
    assert.deepEqual(server.closed, [], 'the advisory path owns no connection to close');
  });

  it('defaults to the postgresql adapter when none is supplied', async () => {
    const server = new FakeLockServer();
    const runner = server.client('runner');
    const lock = await acquireMigrationLock(runner, 7, undefined, async () => server.client('lock'));
    assert.equal(lock.adapter.name, 'postgresql');
    assert.equal(lock.lockClient, undefined);
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
