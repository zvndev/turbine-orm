/**
 * What a native pg transaction tells its caller, checked against what the
 * database actually holds.
 *
 * Each case reads the truth independently, through a separate pg client:
 * whether the row is there, what `pg_stat_activity` shows for the
 * transaction's backend, and whether the next checkout lands on the same
 * backend (the connection was reused) or a new one (it was discarded). It then
 * asserts what Turbine reported: the error, its `outcome`, the log codes, and
 * a leaked handle's refusal.
 *
 * The first case needs no fault injection: node-postgres's `query_timeout`
 * rejects a COMMIT that a deferred constraint trigger makes slow, the server
 * commits anyway, and Turbine used to answer that with a ROLLBACK the server
 * acknowledged (there was no transaction left) and report a rollback. The
 * others wrap the real driver's acknowledgements on a live connection: a
 * COMMIT answer hidden after the server committed, a ROLLBACK refused before
 * it is sent, a ROLLBACK answered after the grace period, and a deadline
 * reached while a statement waits on a lock and no cancel can be sent.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/transaction-outcome.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { type TransactionClient, TurbineClient } from '../client.js';
import {
  SerializationFailureError,
  TimeoutError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  ValidationError,
} from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const ROWS = 'txo_rows';
const SLOW = 'txo_slow_commit';
const SSI = 'txo_ssi';

type Fault = 'hide-commit' | 'refuse-rollback' | 'delay-rollback' | 'no-cancel';

interface Rig {
  db: TurbineClient;
  pool: pg.Pool;
  /** Statements as the driver saw them, plus what a fault did to them. */
  wire: string[];
  /** Log codes, in order. */
  logs: string[];
  /** One entry per release: true when the connection was discarded. */
  discarded: boolean[];
  /** The backend the next checkout gets, without disturbing `discarded`. */
  nextBackend(): Promise<number>;
  close(): Promise<void>;
}

/**
 * A one-connection pg.Pool handed to Turbine as a supplied pool, its
 * checkouts' `query` wrapped to record and, for `fault`, interfere with the
 * real driver's acknowledgements.
 */
function rig(fault?: Fault, poolConfig: pg.PoolConfig = {}): Rig {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, ...poolConfig });
  const wire: string[] = [];
  const logs: string[] = [];
  const discarded: boolean[] = [];
  let probing = false;
  pool.on('release', (err: Error | undefined) => {
    if (!probing) discarded.push(err !== undefined);
  });
  pool.on('connect', (client) => {
    // No backend key: nothing can cancel this connection's statement.
    if (fault === 'no-cancel') (client as unknown as { processID?: number }).processID = undefined;
    const original = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
    (client as unknown as { query: unknown }).query = (config: unknown, values?: unknown, callback?: unknown) => {
      if (typeof values === 'function' || typeof callback === 'function') return original(config, values, callback);
      const sql = typeof config === 'string' ? config : (config as { text: string }).text;
      if (sql === 'ROLLBACK' && fault === 'refuse-rollback') {
        wire.push('ROLLBACK refused before dispatch');
        return Promise.reject(new Error('injected: ROLLBACK refused before dispatch'));
      }
      wire.push(sql);
      const sent = original(config, values);
      if (sql === 'COMMIT' && fault === 'hide-commit') {
        return sent.then((answer) => {
          wire.push(`COMMIT answered ${answer.command}, answer hidden`);
          throw new Error('injected: COMMIT acknowledgement lost');
        });
      }
      if (sql === 'ROLLBACK' && fault === 'delay-rollback') {
        return sent.then(async (answer) => {
          await delay(2500);
          return answer;
        });
      }
      return sent;
    };
  });
  const db = new TurbineClient(
    {
      pool: pool as unknown as PgCompatPool,
      logging: true,
      logger: { debug: (_message, entry) => logs.push(entry.code), warn: () => {} },
    },
    { tables: {}, enums: {} },
  );
  return {
    db,
    pool,
    wire,
    logs,
    discarded,
    async nextBackend() {
      probing = true;
      try {
        const client = await pool.connect();
        try {
          return (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        } finally {
          client.release();
        }
      } finally {
        probing = false;
      }
    },
    close: () => pool.end(),
  };
}

type Api = 'transaction' | '$transaction';
type Handle = PgCompatPoolClient & TransactionClient;

/** Run `sql` (no params) through either API's handle and return its rows. */
async function send(api: Api, handle: Handle, sql: string): Promise<Array<Record<string, unknown>>> {
  return api === 'transaction'
    ? ((await handle.query(sql)).rows as Array<Record<string, unknown>>)
    : handle.rawUnsafe<Record<string, unknown>>(sql);
}

function begin<T>(db: TurbineClient, api: Api, body: (handle: Handle) => Promise<T>): Promise<T> {
  return api === 'transaction'
    ? db.transaction((client) => body(client as Handle))
    : db.$transaction((tx) => body(tx as Handle));
}

/** The refusal a handle used after its transaction settled gets. */
async function refusalOf(api: Api, handle: Handle): Promise<string> {
  try {
    await send(api, handle, 'SELECT 1');
  } catch (err) {
    assert.ok(err instanceof ValidationError, String(err));
    return err.message;
  }
  throw new Error('the late query was not refused');
}

describe('transaction outcomes against a live PostgreSQL', () => {
  let admin: pg.Client;

  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`
      DROP TABLE IF EXISTS ${ROWS}, ${SLOW}, ${SSI};
      CREATE TABLE ${ROWS} (id INTEGER PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE ${SLOW} (id INTEGER PRIMARY KEY);
      CREATE TABLE ${SSI} (grp INTEGER NOT NULL, v INTEGER NOT NULL);
      CREATE OR REPLACE FUNCTION txo_slow_commit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_sleep(0.45); RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER txo_slow_commit_trg AFTER INSERT ON ${SLOW}
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION txo_slow_commit_fn();
    `);
  });

  after(async () => {
    await admin.query(`DROP TABLE IF EXISTS ${ROWS}, ${SLOW}, ${SSI}; DROP FUNCTION IF EXISTS txo_slow_commit_fn()`);
    await admin.end();
  });

  async function reset(): Promise<void> {
    await admin.query(`TRUNCATE ${ROWS}, ${SLOW}, ${SSI}; INSERT INTO ${ROWS} (id, n) VALUES (1, 0)`);
  }

  async function rowExists(table: string, id: number): Promise<boolean> {
    return (await admin.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;
  }

  async function backendAlive(pid: number): Promise<boolean> {
    return (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid = $1', [pid])).rowCount === 1;
  }

  /** Wait (at most `ms`) for `check` to hold. */
  async function eventually(check: () => Promise<boolean>, ms = 5000): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return true;
      await delay(25);
    }
    return check();
  }

  describe('a COMMIT whose answer never arrives', () => {
    for (const api of ['transaction', '$transaction'] as const) {
      it(`${api}: query_timeout shorter than the COMMIT, no fault injected: E021, no ROLLBACK, discarded, row committed`, async () => {
        await reset();
        const r = rig(undefined, { query_timeout: 300 });
        try {
          let pid = 0;
          let handle!: Handle;
          let thrown: unknown;
          await begin(r.db, api, async (h) => {
            handle = h;
            pid = (await send(api, h, 'SELECT pg_backend_pid() AS pid'))[0]!.pid as number;
            await send(api, h, `INSERT INTO ${SLOW} (id) VALUES (7)`);
          }).catch((err: unknown) => {
            thrown = err;
          });
          // What the caller was told.
          assert.ok(thrown instanceof TransactionOutcomeUnknownError, `got ${String(thrown)}`);
          assert.equal((thrown.cause as Error).message, 'Query read timeout');
          assert.doesNotMatch(thrown.message, /rolled back/);
          assert.match(await refusalOf(api, handle), /ended with an unknown outcome/);
          // What was sent and logged, and the connection.
          assert.ok(!r.wire.includes('ROLLBACK'), r.wire.join(' | '));
          assert.deepEqual(r.discarded, [true]);
          if (api === '$transaction') assert.deepEqual(r.logs.slice(-1), ['transaction-outcome-unknown']);
          assert.ok(!r.logs.includes('transaction-rolled-back'));
          assert.notEqual(await r.nextBackend(), pid);
          // The truth: the server committed after the driver gave up waiting.
          assert.ok(await eventually(() => rowExists(SLOW, 7)), 'the slow COMMIT did not commit');
        } finally {
          await r.close();
        }
      });
    }

    for (const api of ['transaction', '$transaction'] as const) {
      it(`${api}: a COMMIT answer hidden after the server committed is E021, and the row is there`, async () => {
        await reset();
        const r = rig('hide-commit');
        try {
          let pid = 0;
          await assert.rejects(
            begin(r.db, api, async (h) => {
              pid = (await send(api, h, 'SELECT pg_backend_pid() AS pid'))[0]!.pid as number;
              await send(api, h, `UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);
            }),
            (err) =>
              err instanceof TransactionOutcomeUnknownError &&
              (err.cause as Error).message === 'injected: COMMIT acknowledgement lost',
          );
          assert.ok(r.wire.includes('COMMIT answered COMMIT, answer hidden'), r.wire.join(' | '));
          assert.ok(!r.wire.includes('ROLLBACK'));
          assert.deepEqual(r.discarded, [true]);
          assert.ok(!r.logs.includes('transaction-rolled-back'));
          if (api === '$transaction') assert.ok(r.logs.includes('transaction-outcome-unknown'));
          assert.notEqual(await r.nextBackend(), pid);
          assert.equal((await admin.query(`SELECT n FROM ${ROWS} WHERE id = 1`)).rows[0].n, 1);
        } finally {
          await r.close();
        }
      });
    }
  });

  describe('a cleanup ROLLBACK the server did not acknowledge, before any COMMIT', () => {
    for (const [fault, label] of [
      ['refuse-rollback', 'refused before it is sent'],
      ['delay-rollback', 'answered after the grace period'],
    ] as const) {
      for (const api of ['transaction', '$transaction'] as const) {
        it(`${api}: a ROLLBACK ${label}: the callback's error, no rollback claimed, discarded, nothing saved`, async () => {
          await reset();
          const r = rig(fault);
          try {
            let pid = 0;
            let handle!: Handle;
            const reason = new Error('callback failed');
            await assert.rejects(
              begin(r.db, api, async (h) => {
                handle = h;
                pid = (await send(api, h, 'SELECT pg_backend_pid() AS pid'))[0]!.pid as number;
                await send(api, h, `INSERT INTO ${ROWS} (id) VALUES (2)`);
                throw reason;
              }),
              (err) => err === reason,
            );
            assert.match(await refusalOf(api, handle), /ended with an unknown outcome/);
            assert.deepEqual(r.discarded, [true]);
            assert.ok(!r.logs.includes('transaction-rolled-back'), r.logs.join(','));
            if (api === '$transaction') assert.ok(r.logs.includes('transaction-outcome-unknown'));
            assert.notEqual(await r.nextBackend(), pid);
            // COMMIT was never sent: once the server sees the connection gone,
            // the transaction is aborted and its row was never there.
            assert.ok(await eventually(async () => !(await backendAlive(pid))), 'the discarded backend lingers');
            assert.equal(await rowExists(ROWS, 2), false);
          } finally {
            await r.close();
          }
        });
      }
    }
  });

  describe('a transaction deadline', () => {
    it('reached while a statement waits on a lock and no cancel can be sent: outcome unknown, no rollback or cancel claimed', async () => {
      await reset();
      const r = rig('no-cancel');
      const blocker = new pg.Client({ connectionString: DATABASE_URL });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT * FROM ${ROWS} WHERE id = 1 FOR UPDATE`);
        let pid = 0;
        let escaped!: TransactionClient;
        await assert.rejects(
          r.db.$transaction(
            async (tx) => {
              escaped = tx;
              pid = (await tx.rawUnsafe<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
              await tx.rawUnsafe(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);
            },
            { timeout: 300 },
          ),
          (err) => {
            assert.ok(err instanceof TimeoutError, String(err));
            assert.equal(err.outcome, 'unknown');
            assert.match(err.message, /COMMIT was never sent/);
            assert.doesNotMatch(err.message, /was rolled back|cancelled/);
            return true;
          },
        );
        // The truth at the moment of the rejection: the statement is still
        // waiting on the server.
        const activity = await admin.query('SELECT state, wait_event_type FROM pg_stat_activity WHERE pid = $1', [pid]);
        assert.deepEqual(activity.rows, [{ state: 'active', wait_event_type: 'Lock' }]);
        assert.ok(!r.wire.includes('ROLLBACK'), r.wire.join(' | '));
        assert.deepEqual(r.discarded, [true]);
        assert.ok(r.logs.includes('transaction-outcome-unknown') && !r.logs.includes('transaction-rolled-back'));
        await assert.rejects(escaped.rawUnsafe('SELECT 1'), /timed out/);
        await blocker.query('ROLLBACK');
        assert.ok(await eventually(async () => !(await backendAlive(pid))), 'the abandoned backend lingers');
        assert.equal((await admin.query(`SELECT n FROM ${ROWS} WHERE id = 1`)).rows[0].n, 0);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        await blocker.end();
        await r.close();
      }
    });

    it('control: the statement is cancelled and the rollback acknowledged: not-executed, and the connection is reused', async () => {
      await reset();
      const r = rig();
      const blocker = new pg.Client({ connectionString: DATABASE_URL });
      await blocker.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(`SELECT * FROM ${ROWS} WHERE id = 1 FOR UPDATE`);
        let pid = 0;
        await assert.rejects(
          r.db.$transaction(
            async (tx) => {
              pid = (await tx.rawUnsafe<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
              await tx.rawUnsafe(`UPDATE ${ROWS} SET n = n + 1 WHERE id = 1`);
            },
            { timeout: 300 },
          ),
          (err) =>
            err instanceof TimeoutError &&
            err.outcome === 'not-executed' &&
            // Rolled back (acknowledged), but no claim about the statement:
            // a cancel landing after it finished would have been ignored.
            /was rolled back, so none of its writes were saved\. \(/.test(err.message),
        );
        assert.deepEqual(r.discarded, [false]);
        assert.ok(r.logs.includes('transaction-rolled-back') && !r.logs.includes('transaction-outcome-unknown'));
        assert.equal(await r.nextBackend(), pid);
      } finally {
        await blocker.query('ROLLBACK').catch(() => {});
        await blocker.end();
        await r.close();
      }
    });
  });

  describe('controls: outcomes the server confirmed keep their behaviour', () => {
    for (const api of ['transaction', '$transaction'] as const) {
      it(`${api}: an ordinary commit`, async () => {
        await reset();
        const r = rig();
        try {
          let pid = 0;
          const value = await begin(r.db, api, async (h) => {
            pid = (await send(api, h, 'SELECT pg_backend_pid() AS pid'))[0]!.pid as number;
            await send(api, h, `INSERT INTO ${ROWS} (id) VALUES (3)`);
            return 17;
          });
          assert.equal(value, 17);
          assert.equal(await rowExists(ROWS, 3), true);
          assert.deepEqual(r.discarded, [false]);
          if (api === '$transaction') assert.deepEqual(r.logs, ['external-pool', 'transaction-committed']);
          assert.equal(await r.nextBackend(), pid);
        } finally {
          await r.close();
        }
      });

      it(`${api}: an acknowledged rollback of a failed callback`, async () => {
        await reset();
        const r = rig();
        try {
          let pid = 0;
          let handle!: Handle;
          const reason = new Error('callback failed');
          await assert.rejects(
            begin(r.db, api, async (h) => {
              handle = h;
              pid = (await send(api, h, 'SELECT pg_backend_pid() AS pid'))[0]!.pid as number;
              await send(api, h, `INSERT INTO ${ROWS} (id) VALUES (4)`);
              throw reason;
            }),
            (err) => err === reason,
          );
          assert.equal(await rowExists(ROWS, 4), false);
          assert.match(await refusalOf(api, handle), /was rolled back/);
          assert.deepEqual(r.discarded, [false]);
          if (api === '$transaction') assert.deepEqual(r.logs.slice(-1), ['transaction-rolled-back']);
          assert.equal(await r.nextBackend(), pid);
        } finally {
          await r.close();
        }
      });

      it(`${api}: a COMMIT answered with ROLLBACK after a caught failure is E019`, async () => {
        await reset();
        const r = rig();
        try {
          let pid = 0;
          await assert.rejects(
            begin(r.db, api, async (h) => {
              pid = (await send(api, h, 'SELECT pg_backend_pid() AS pid'))[0]!.pid as number;
              await send(api, h, `INSERT INTO ${ROWS} (id) VALUES (5)`);
              await send(api, h, `INSERT INTO ${ROWS} (id) VALUES (1)`).catch(() => {});
            }),
            TransactionRolledBackError,
          );
          assert.equal(await rowExists(ROWS, 5), false);
          assert.deepEqual(r.discarded, [false]);
          if (api === '$transaction') assert.deepEqual(r.logs.slice(-1), ['transaction-rolled-back']);
          assert.equal(await r.nextBackend(), pid);
        } finally {
          await r.close();
        }
      });
    }

    it('$transaction: a serialization failure answered at COMMIT keeps its retryable class', async () => {
      await reset();
      const r = rig();
      const other = new pg.Client({ connectionString: DATABASE_URL });
      await other.connect();
      try {
        await other.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await other.query(`SELECT sum(v) FROM ${SSI} WHERE grp = 1`);
        let pid = 0;
        await assert.rejects(
          r.db.$transaction(
            async (tx) => {
              pid = (await tx.rawUnsafe<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
              await tx.rawUnsafe(`SELECT sum(v) FROM ${SSI} WHERE grp = 2`);
              await other.query(`INSERT INTO ${SSI} VALUES (2, 1)`);
              await tx.rawUnsafe(`INSERT INTO ${SSI} VALUES (1, 1)`);
              await other.query('COMMIT');
            },
            { isolationLevel: 'Serializable' },
          ),
          (err) => err instanceof SerializationFailureError && err.isRetryable,
        );
        assert.ok(r.wire.includes('COMMIT'));
        assert.equal((await admin.query(`SELECT count(*)::int AS n FROM ${SSI} WHERE grp = 1`)).rows[0].n, 0);
        assert.deepEqual(r.discarded, [false]);
        assert.deepEqual(r.logs.slice(-1), ['transaction-rolled-back']);
        assert.equal(await r.nextBackend(), pid);
      } finally {
        await other.query('ROLLBACK').catch(() => {});
        await other.end();
        await r.close();
      }
    });
  });
});
