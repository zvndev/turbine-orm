/**
 * Transaction outcomes beyond a plain `$transaction` callback, checked against
 * what a live PostgreSQL actually holds: a nested block whose rollback is not
 * confirmed, and the transactions Turbine opens on its own (a nested write, a
 * lookup-first upsert, a `createMany` split across statements, the sequential
 * pipeline).
 *
 * Each case reads the truth through a separate pg client (whether the row is
 * there) and through the pool (whether the connection was released clean or
 * discarded, and whether the next checkout lands on the same backend). The
 * unanswered-COMMIT cases need no fault injection: node-postgres's
 * `query_timeout` rejects a COMMIT that a deferred constraint trigger makes
 * slow, and the server commits anyway.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/transaction-outcome-paths.integration.test.ts
 */

import assert from 'node:assert/strict';
import net from 'node:net';
import { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { TurbineClient, type TurbineConfig } from '../client.js';
import { postgresDialect } from '../dialect.js';
import {
  TimeoutError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  UniqueConstraintError,
} from '../errors.js';
import { introspect } from '../introspect.js';
import type { PgCompatPool } from '../pg-types.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

interface Rig {
  db: TurbineClient;
  pool: pg.Pool;
  /** Statements as the driver saw them. */
  wire: string[];
  /** One entry per release: true when the connection was discarded. */
  discarded: boolean[];
  logs: string[];
  /** The backend the next checkout gets, without disturbing `discarded`. */
  nextBackend(): Promise<number>;
  /** The backend this rig's one connection runs on. */
  backend(): Promise<number>;
  close(): Promise<void>;
}

/**
 * A one-connection pg.Pool handed to Turbine as a supplied pool, its checkouts'
 * `query` wrapped to record statements and to refuse the ones `refuse` names
 * before they are sent.
 */
function rig(
  fx: TxFixture,
  poolConfig: pg.PoolConfig = {},
  refuse?: (sql: string) => boolean,
  clientConfig: Partial<TurbineConfig> = {},
): Rig {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, ...poolConfig });
  const wire: string[] = [];
  const discarded: boolean[] = [];
  const logs: string[] = [];
  let probing = false;
  pool.on('release', (err: Error | undefined) => {
    if (!probing) discarded.push(err !== undefined);
  });
  pool.on('connect', (client) => {
    const original = client.query.bind(client) as (...args: unknown[]) => Promise<pg.QueryResult>;
    (client as unknown as { query: unknown }).query = (config: unknown, values?: unknown, callback?: unknown) => {
      if (typeof values === 'function' || typeof callback === 'function') return original(config, values, callback);
      const sql = typeof config === 'string' ? config : (config as { text: string }).text;
      if (!probing && refuse?.(sql)) {
        wire.push(`${sql} refused before dispatch`);
        return Promise.reject(new Error(`injected: ${sql} refused before dispatch`));
      }
      if (!probing) wire.push(sql);
      return original(config, values);
    };
  });
  const db = new TurbineClient(
    {
      pool: pool as unknown as PgCompatPool,
      logging: true,
      warnOnUnlimited: false,
      logger: { debug: (_message, entry) => logs.push(entry.code), warn: () => {} },
      ...clientConfig,
    },
    fx.schema,
  );
  const probe = async (): Promise<number> => {
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
  };
  return { db, pool, wire, discarded, logs, nextBackend: probe, backend: probe, close: () => pool.end() };
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

/**
 * The same one-connection pool, seen through only `query` / `connect` /
 * `release`, so `pipeline()` cannot find node-postgres's wire internals and
 * takes its sequential fallback while the real server runs every statement.
 */
function withoutWireInternals(pool: pg.Pool): PgCompatPool {
  return {
    query: (text: string, values?: unknown[]) => pool.query(text, values),
    connect: async () => {
      const client = await pool.connect();
      return {
        query: (text: string, values?: unknown[]) => client.query(text, values),
        release: (err?: Error | boolean) => client.release(err),
      };
    },
    end: () => pool.end(),
  } as unknown as PgCompatPool;
}

describe('transaction outcomes on nested blocks and implicit transactions, live', () => {
  let fx: TxFixture;

  before(async () => {
    fx = await openFixture('txp');
    // A COMMIT that takes 450 ms for any user whose email starts with `slow`,
    // longer than the 180 ms query_timeout the unanswered-COMMIT cases use.
    await fx.raw.query(`
      CREATE OR REPLACE FUNCTION txp_slow_commit_fn() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.email LIKE 'slow%' THEN PERFORM pg_sleep(0.45); END IF; RETURN NULL; END $$;
      CREATE CONSTRAINT TRIGGER txp_slow_commit_trg AFTER INSERT ON ${fx.t.users}
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION txp_slow_commit_fn();
    `);
  });

  after(async () => {
    await fx?.raw.query('DROP FUNCTION IF EXISTS txp_slow_commit_fn() CASCADE');
    await fx?.close();
  });

  const userSaved = (email: string) => async () => (await fx.count(fx.t.users, 'email = $1', [email])) === 1;

  /**
   * Run `call` on a fresh one-connection rig whose COMMIT is cut off by
   * `query_timeout`, then check what the caller got, the connection and the
   * truth. The implicit transactions log nothing, and never a rollback.
   */
  async function unansweredCommit(call: (r: Rig) => Promise<unknown>, email: string): Promise<void> {
    await fx.reset();
    const r = rig(fx, { query_timeout: 180 });
    try {
      const pid = await r.backend();
      const outcome = await call(r).catch((err: unknown) => err);
      // What the caller was told.
      assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
      assert.equal((outcome.cause as Error).message, 'Query read timeout');
      assert.ok(!('isRetryable' in outcome));
      // What was sent and logged, and the connection.
      assert.ok(r.wire.includes('COMMIT'), r.wire.join(' | '));
      assert.ok(!r.wire.includes('ROLLBACK'), r.wire.join(' | '));
      assert.deepEqual(r.discarded, [true]);
      assert.ok(!r.logs.includes('transaction-rolled-back'), r.logs.join(', '));
      assert.notEqual(await r.nextBackend(), pid);
      // The truth: the server committed after the driver gave up waiting.
      assert.ok(await eventually(userSaved(email)), 'the slow COMMIT did not commit');
    } finally {
      await r.close();
    }
  }

  describe('a COMMIT whose answer never arrives, no fault injected', () => {
    it('a nested write (create with a nested author create): E021, no ROLLBACK, discarded, row committed', async () => {
      await unansweredCommit(
        (r) =>
          r.db
            .table(fx.t.posts)
            .create({ data: { title: 'slow post', author: { create: { email: 'slow-nested@x' } } } }),
        'slow-nested@x',
      );
    });

    it('a lookup-first upsert: E021, no ROLLBACK, discarded, row committed', async () => {
      await unansweredCommit(
        (r) =>
          r.db.table(fx.t.users).upsert({
            where: { id: 999 },
            create: { email: 'slow-upsert@x' },
            update: { tenant: 'never' },
          }),
        'slow-upsert@x',
      );
    });

    it('the sequential pipeline fallback: E021, no ROLLBACK, discarded, row committed', async () => {
      await fx.reset();
      const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, query_timeout: 180 });
      const released: boolean[] = [];
      pool.on('release', (err: Error | undefined) => released.push(err !== undefined));
      try {
        const db = new TurbineClient({ pool: withoutWireInternals(pool), warnOnUnlimited: false }, fx.schema);
        const outcome = await db
          .pipeline([db.table(fx.t.users).buildCreate({ data: { email: 'slow-pipeline@x' } })])
          .catch((err: unknown) => err);
        assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
        assert.equal((outcome.cause as Error).message, 'Query read timeout');
        assert.deepEqual(released, [true]);
        assert.ok(await eventually(userSaved('slow-pipeline@x')), 'the slow COMMIT did not commit');
      } finally {
        await pool.end();
      }
    });

    it('a supplied pool whose release throws: E021 and its cause survive, the outcome is logged', async () => {
      await fx.reset();
      const real = new pg.Pool({ connectionString: DATABASE_URL, max: 1, query_timeout: 180 });
      const released: boolean[] = [];
      const logs: string[] = [];
      const pool = {
        query: (text: string, values?: unknown[]) => real.query(text, values),
        connect: async () => {
          const client = await real.connect();
          return {
            query: (text: string, values?: unknown[]) => client.query(text, values),
            release: (err?: Error | boolean) => {
              released.push(Boolean(err));
              client.release(err);
              throw new Error('supplied pool release threw after handing the connection back');
            },
          };
        },
        end: () => real.end(),
      } as unknown as PgCompatPool;
      try {
        const db = new TurbineClient(
          { pool, logging: true, logger: { debug: (_m, entry) => logs.push(entry.code), warn: () => {} } },
          fx.schema,
        );
        const outcome = await db
          .$transaction((tx) => tx.table(fx.t.users).create({ data: { email: 'slow-release@x' } }))
          .catch((err: unknown) => err);
        assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
        assert.equal((outcome.cause as Error).message, 'Query read timeout');
        assert.deepEqual(released, [true]);
        assert.deepEqual(logs.slice(-1), ['transaction-outcome-unknown']);
        assert.ok(await eventually(userSaved('slow-release@x')), 'the slow COMMIT did not commit');
      } finally {
        await real.end();
      }
    });

    it('control: the same nested write with a prompt COMMIT commits and reuses the connection', async () => {
      await fx.reset();
      const r = rig(fx, { query_timeout: 2000 });
      try {
        const pid = await r.backend();
        await r.db
          .table(fx.t.posts)
          .create({ data: { title: 'quick post', author: { create: { email: 'quick@x' } } } });
        assert.deepEqual(r.discarded, [false]);
        assert.equal(await r.nextBackend(), pid);
        assert.ok(await userSaved('quick@x')());
      } finally {
        await r.close();
      }
    });
  });

  describe('a server ERROR at COMMIT, in whatever language the server reports it', () => {
    it('a deferred unique violation is the server answer: UniqueConstraintError, nothing saved, reused', async () => {
      // node-postgres exposes only the severity word in the server's
      // lc_messages language (FEHLER, ERREUR, ...). The SQLSTATE decides when
      // the word is not English, so this holds on a server in any language.
      await fx.reset();
      await fx.raw.query('DROP TABLE IF EXISTS txp_deferred_unique');
      await fx.raw.query(
        'CREATE TABLE txp_deferred_unique (k INTEGER, CONSTRAINT txp_k UNIQUE (k) DEFERRABLE INITIALLY DEFERRED)',
      );
      const r = rig(fx);
      try {
        const pid = await r.backend();
        const outcome = await r.db
          .$transaction(async (tx) => {
            await tx.rawUnsafe('INSERT INTO txp_deferred_unique (k) VALUES (1), (1)');
          })
          .catch((err: unknown) => err);
        assert.ok(outcome instanceof UniqueConstraintError, `got ${String(outcome)}`);
        assert.equal(typeof (outcome.cause as { severity?: unknown }).severity, 'string');
        assert.deepEqual(r.discarded, [false]);
        assert.equal(await r.nextBackend(), pid);
        assert.deepEqual(r.logs.slice(-1), ['transaction-rolled-back']);
        assert.equal((await fx.raw.query('SELECT count(*)::int AS n FROM txp_deferred_unique')).rows[0].n, 0);
      } finally {
        await r.close();
        await fx.raw.query('DROP TABLE IF EXISTS txp_deferred_unique');
      }
    });
  });

  describe('a transaction deadline whose cancel request lands after the statement finished', () => {
    it('the rollback is claimed (acknowledged), the cancellation of the statement is not', async () => {
      // Only the cancel request goes through this proxy, 150 ms late; the
      // statement's own connection talks to the server directly.
      const target = new URL(DATABASE_URL!);
      const sockets = new Set<net.Socket>();
      let cancelRequests = 0;
      const proxy = net.createServer((socket) => {
        sockets.add(socket);
        socket.once('data', (packet) => {
          cancelRequests++;
          setTimeout(() => {
            const upstream = net.connect({ host: target.hostname, port: Number(target.port || 5432) }, () =>
              upstream.write(packet),
            );
            sockets.add(upstream);
            upstream.on('data', (chunk) => socket.write(chunk));
            upstream.on('end', () => socket.end());
            upstream.on('error', () => socket.destroy());
            socket.on('error', () => upstream.destroy());
          }, 150);
        });
      });
      await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
      const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
      pool.on('connect', (client) => {
        (client as unknown as { host: string; port: number }).host = '127.0.0.1';
        (client as unknown as { port: number }).port = (proxy.address() as net.AddressInfo).port;
      });
      try {
        const db = new TurbineClient({ pool: pool as unknown as PgCompatPool }, fx.schema);
        let finished = false;
        const outcome = await db
          .$transaction(
            async (tx) => {
              await tx.rawUnsafe('SELECT pg_sleep(0.08)');
              finished = true;
            },
            { timeout: 20 },
          )
          .catch((err: unknown) => err);
        assert.ok(outcome instanceof TimeoutError, `got ${String(outcome)}`);
        assert.equal(finished, true, 'the statement was expected to finish before the cancel landed');
        assert.equal(cancelRequests, 1);
        assert.equal(outcome.outcome, 'not-executed');
        assert.match(outcome.message, /was rolled back, so none of its writes were saved/);
        assert.doesNotMatch(outcome.message, /cancel/);
      } finally {
        await pool.end();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      }
    });
  });

  describe("a nested write's `timeout` bounds the whole call", () => {
    // A post titled `slow-stmt...` takes 600 ms to insert: the nested write's
    // second statement, after the author's INSERT.
    before(async () => {
      await fx.raw.query(`
        CREATE OR REPLACE FUNCTION txp_slow_stmt_fn() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.title LIKE 'slow-stmt%' THEN PERFORM pg_sleep(0.6); END IF; RETURN NEW; END $$;
        CREATE TRIGGER txp_slow_stmt_trg BEFORE INSERT ON ${fx.t.posts}
          FOR EACH ROW EXECUTE FUNCTION txp_slow_stmt_fn();
      `);
    });
    after(async () => {
      await fx?.raw.query('DROP FUNCTION IF EXISTS txp_slow_stmt_fn() CASCADE');
    });

    const slowNested = (db: { table(name: string): { create(args: unknown): Promise<unknown> } }, email: string) =>
      db.table(fx.t.posts).create({ data: { title: 'slow-stmt', author: { create: { email } } }, timeout: 150 });

    it('its own transaction: a timeout well before the slow statement ends, rolled back, nothing saved', async () => {
      await fx.reset();
      const r = rig(fx);
      try {
        const pid = await r.backend();
        const start = performance.now();
        const outcome = await slowNested(r.db, 'nested-timeout@x').catch((err: unknown) => err);
        const elapsed = performance.now() - start;
        assert.ok(outcome instanceof TimeoutError, `got ${String(outcome)}`);
        assert.ok(elapsed < 550, `the call ran ${Math.round(elapsed)} ms past a 150 ms timeout`);
        // The statement was cancelled and the ROLLBACK acknowledged: confirmed, and the connection reused.
        assert.equal(outcome.outcome, 'not-executed');
        assert.match(outcome.message, /the transaction it ran in was rolled back/);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        assert.deepEqual(r.discarded, [false]);
        assert.equal(await r.nextBackend(), pid);
        await delay(700);
        assert.equal(await fx.count(fx.t.users, 'email = $1', ['nested-timeout@x']), 0);
      } finally {
        await r.close();
      }
    });

    it("in the caller's transaction: the same bound, and nothing saved", async () => {
      await fx.reset();
      const r = rig(fx);
      try {
        const start = performance.now();
        const outcome = await r.db
          .$transaction((tx) => slowNested(tx, 'nested-timeout-tx@x'))
          .catch((err: unknown) => err);
        const elapsed = performance.now() - start;
        assert.ok(outcome instanceof TimeoutError, `got ${String(outcome)}`);
        assert.ok(elapsed < 550, `the call ran ${Math.round(elapsed)} ms past a 150 ms timeout`);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        await delay(700);
        assert.equal(await fx.count(fx.t.users, 'email = $1', ['nested-timeout-tx@x']), 0);
      } finally {
        await r.close();
      }
    });

    it('control: without a timeout the same nested write waits for the slow statement and commits', async () => {
      await fx.reset();
      const r = rig(fx);
      try {
        await r.db
          .table(fx.t.posts)
          .create({ data: { title: 'slow-stmt', author: { create: { email: 'nested-slow@x' } } } });
        assert.equal(await fx.count(fx.t.users, 'email = $1', ['nested-slow@x']), 1);
      } finally {
        await r.close();
      }
    });
  });

  describe("a write's statement still running at its deadline, in the caller's transaction", () => {
    // In the caller's transaction a multi-statement write runs in its own
    // savepoint. Its timeout may say the write made no change only once the
    // rollback to that savepoint is acknowledged.
    //
    // A post titled `lag-long...` takes 2.5 s to insert, longer than the 2 s a
    // timed-out statement is given to answer its cancel; `lag-short...` takes
    // 0.6 s, and so does a user whose email starts with `lag-row`.
    before(async () => {
      await fx.raw.query(`
        CREATE OR REPLACE FUNCTION txp_lag_post_fn() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.title LIKE 'lag-long%' THEN PERFORM pg_sleep(2.5);
            ELSIF NEW.title LIKE 'lag-short%' THEN PERFORM pg_sleep(0.6); END IF;
            RETURN NEW;
          END $$;
        CREATE TRIGGER txp_lag_post_trg BEFORE INSERT ON ${fx.t.posts}
          FOR EACH ROW EXECUTE FUNCTION txp_lag_post_fn();
        CREATE OR REPLACE FUNCTION txp_lag_user_fn() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.email LIKE 'lag-row%' THEN PERFORM pg_sleep(0.6); END IF; RETURN NEW; END $$;
        CREATE TRIGGER txp_lag_user_trg BEFORE INSERT ON ${fx.t.users}
          FOR EACH ROW EXECUTE FUNCTION txp_lag_user_fn();
      `);
    });
    after(async () => {
      await fx?.raw.query('DROP FUNCTION IF EXISTS txp_lag_post_fn() CASCADE');
      await fx?.raw.query('DROP FUNCTION IF EXISTS txp_lag_user_fn() CASCADE');
    });

    /**
     * A rig whose `ROLLBACK TO` is refused when `refuseRollbackTo` (every one, or
     * those the predicate names), and whose
     * cancel requests go to a socket that drops them when `loseCancel`. Also
     * hands out the one connection, for reads that bypass Turbine.
     */
    async function runningRig(
      refuseRollbackTo: boolean | ((sql: string) => boolean),
      loseCancel: boolean,
      clientConfig?: Partial<TurbineConfig>,
    ) {
      const refuse =
        typeof refuseRollbackTo === 'function'
          ? refuseRollbackTo
          : (sql: string) => refuseRollbackTo && sql.startsWith('ROLLBACK TO');
      const r = rig(fx, {}, refuse, clientConfig);
      const sockets = new Set<net.Socket>();
      let cancelRequests = 0;
      const sink = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('error', () => {});
        socket.once('data', () => {
          cancelRequests++;
          socket.end();
        });
      });
      await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
      let connection: pg.PoolClient | undefined;
      r.pool.on('connect', (client) => {
        connection = client;
        if (!loseCancel) return;
        (client as unknown as { host: string }).host = '127.0.0.1';
        (client as unknown as { port: number }).port = (sink.address() as net.AddressInfo).port;
      });
      return {
        ...r,
        cancelRequests: () => cancelRequests,
        /** Rows matching `where` in each table, read on the transaction's own connection. */
        async inside(): Promise<{ users: number; posts: number }> {
          const read = pg.Client.prototype.query as (this: unknown, sql: string) => Promise<pg.QueryResult>;
          const { rows } = await read.call(
            connection,
            `SELECT (SELECT count(*) FROM ${fx.t.users} WHERE email LIKE 'lag%')::int AS users,
                    (SELECT count(*) FROM ${fx.t.posts} WHERE title LIKE 'lag%')::int AS posts`,
          );
          return rows[0] as { users: number; posts: number };
        },
        async close() {
          await r.close();
          for (const socket of sockets) socket.destroy();
          await new Promise<void>((resolve) => sink.close(() => resolve()));
        },
      };
    }

    /** The caller's transaction goes on: nothing may say it is over. */
    const assertAcknowledgedText = (err: TimeoutError) => {
      assert.match(err.message, /A savepoint rollback undid the write; the transaction can continue\./);
      assert.doesNotMatch(err.message, /is over|rolls back instead of committing|may still complete/);
    };
    /** Nothing has undone the write, and the caller's transaction cannot commit. */
    const assertRefusedText = (err: TimeoutError) => {
      assert.match(err.message, /A savepoint rollback was not acknowledged; the transaction cannot commit\./);
      assert.doesNotMatch(err.message, /made no change|can continue/);
    };

    const nestedCreate = (tx: { table(name: string): { create(args: unknown): Promise<unknown> } }, title: string) =>
      tx
        .table(fx.t.posts)
        .create({ data: { title, author: { create: { email: `lag-author-${title}` } } }, timeout: 80 });

    it('cancelled, but the rollback to its savepoint is refused: unknown, and the transaction does not commit', async () => {
      await fx.reset();
      const r = await runningRig(true, false);
      try {
        let caught: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            caught = await nestedCreate(tx, 'lag-short').catch((err: unknown) => err);
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        assert.equal(r.cancelRequests(), 0);
        // The author's INSERT ran before the cancelled one, and its rollback was never acknowledged.
        assert.equal(caught.outcome, 'unknown');
        assertRefusedText(caught);
        assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
        assert.equal(outcome.cause, caught);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        assert.equal(await fx.count(fx.t.users, "email LIKE 'lag%'"), 0);
      } finally {
        await r.close();
      }
    });

    it('its cancel lost and the rollback to its savepoint refused: unknown while the write is still in the transaction', async () => {
      await fx.reset();
      const r = await runningRig(true, true);
      try {
        let caught: unknown;
        let elapsed = 0;
        let inside: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            const start = performance.now();
            caught = await nestedCreate(tx, 'lag-long').catch((err: unknown) => err);
            elapsed = performance.now() - start;
            // Read once the statement has ended (the driver queues the read behind it).
            inside = await r.inside();
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        assert.equal(r.cancelRequests(), 1);
        assert.ok(elapsed < 2400, `delivered after ${Math.round(elapsed)} ms, once the statement had ended`);
        assert.equal(caught.outcome, 'unknown');
        assertRefusedText(caught);
        assert.deepEqual(inside, { users: 1, posts: 1 });
        assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
        assert.equal(outcome.cause, caught);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        assert.equal(await fx.count(fx.t.users, "email LIKE 'lag%'"), 0);
      } finally {
        await r.close();
      }
    });

    it('a createMany split across statements, cancelled, its savepoint rollback refused: unknown', async () => {
      // Two rows per statement, so the third row is a second INSERT, and the slow one.
      const dialect = {
        ...postgresDialect,
        capabilities: { ...postgresDialect.capabilities, chunkBindParameters: 2, maxInsertRows: 2 },
      };
      await fx.reset();
      const r = await runningRig(true, false, { dialect });
      try {
        let caught: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            caught = await tx
              .table(fx.t.users)
              .createMany({ data: [{ email: 'lag-a@x' }, { email: 'lag-b@x' }, { email: 'lag-row@x' }], timeout: 150 })
              .catch((err: unknown) => err);
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        assert.equal(caught.outcome, 'unknown');
        assertRefusedText(caught);
        assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
        assert.equal(outcome.cause, caught);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        assert.equal(await fx.count(fx.t.users, "email LIKE 'lag%'"), 0);
      } finally {
        await r.close();
      }
    });

    it('its cancel lost, the rollback to its savepoint acknowledged late: not-executed once it answers, and the transaction commits', async () => {
      await fx.reset();
      const r = await runningRig(false, true);
      try {
        let caught: unknown;
        let elapsed = 0;
        let inside: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            const start = performance.now();
            caught = await nestedCreate(tx, 'lag-long').catch((err: unknown) => err);
            elapsed = performance.now() - start;
            inside = await r.inside();
            await tx.table(fx.t.users).create({ data: { email: 'after@x' } });
            return 'committed';
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        assert.equal(r.cancelRequests(), 1);
        // The ROLLBACK TO queued behind the statement, so it answered once the statement ended.
        assert.ok(elapsed > 2400, `delivered after ${Math.round(elapsed)} ms, before the rollback could answer`);
        assert.equal(caught.outcome, 'not-executed');
        assertAcknowledgedText(caught);
        assert.deepEqual(inside, { users: 0, posts: 0 });
        assert.equal(outcome, 'committed');
        assert.equal(await fx.count(fx.t.users, "email LIKE 'lag%'"), 0);
        assert.equal(await fx.count(fx.t.users, "email = 'after@x'"), 1);
      } finally {
        await r.close();
      }
    });

    it('a nested update, cancelled after its UPDATE ran, the rollback acknowledged: the UPDATE is undone, and the transaction commits', async () => {
      await fx.reset();
      const r = await runningRig(false, false);
      try {
        let caught: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            caught = await tx
              .table(fx.t.users)
              .update({
                where: { id: 1 },
                data: { tenant: 'changed', posts: { create: { title: 'lag-short' } } },
                timeout: 80,
              })
              .catch((err: unknown) => err);
            await tx.table(fx.t.users).create({ data: { email: 'after@x' } });
            return 'committed';
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        assert.ok(
          r.wire.some((sql) => sql.startsWith('UPDATE')),
          r.wire.join(' | '),
        );
        assert.equal(caught.outcome, 'not-executed');
        assertAcknowledgedText(caught);
        assert.equal(outcome, 'committed');
        assert.equal(await fx.count(fx.t.users, "id = 1 AND tenant = 't1'"), 1);
        assert.equal(await fx.count(fx.t.posts, "title LIKE 'lag%'"), 0);
        assert.equal(await fx.count(fx.t.users, "email = 'after@x'"), 1);
      } finally {
        await r.close();
      }
    });

    it('a write inside a write: the inner savepoint rolled back, the outer refused: unknown, and the parent row is still there', async () => {
      // The nested create's `posts` array is one createMany, split in two statements
      // (two rows each), so it runs in a savepoint of its own inside the nested write's.
      const dialect = {
        ...postgresDialect,
        capabilities: { ...postgresDialect.capabilities, chunkBindParameters: 2, maxInsertRows: 2 },
      };
      await fx.reset();
      const r = await runningRig((sql) => sql === 'ROLLBACK TO SAVEPOINT sp_1', false, { dialect });
      try {
        let caught: unknown;
        let inside: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            caught = await tx
              .table(fx.t.users)
              .create({
                data: {
                  email: 'lag-parent@x',
                  posts: { create: [{ title: 'lag-a' }, { title: 'lag-b' }, { title: 'lag-short' }] },
                },
                timeout: 150,
              })
              .catch((err: unknown) => err);
            inside = await r.inside();
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        assert.ok(r.wire.includes('ROLLBACK TO SAVEPOINT sp_2'), r.wire.join(' | '));
        assert.ok(r.wire.includes('ROLLBACK TO SAVEPOINT sp_1 refused before dispatch'), r.wire.join(' | '));
        // The inner rollback undid the posts; the parent's INSERT is still in the transaction.
        assert.deepEqual(inside, { users: 1, posts: 0 });
        assert.equal(caught.outcome, 'unknown');
        assertRefusedText(caught);
        assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
        assert.equal(outcome.cause, caught);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        assert.equal(await fx.count(fx.t.users, "email LIKE 'lag%'"), 0);
      } finally {
        await r.close();
      }
    });

    it('control: cancelled and the rollback to its savepoint acknowledged: not-executed, and the transaction commits', async () => {
      await fx.reset();
      const r = await runningRig(false, false);
      try {
        let caught: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            caught = await nestedCreate(tx, 'lag-short').catch((err: unknown) => err);
            await tx.table(fx.t.users).create({ data: { email: 'after@x' } });
            return 'committed';
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        assert.equal(caught.outcome, 'not-executed');
        assertAcknowledgedText(caught);
        assert.equal(outcome, 'committed');
        assert.equal(await fx.count(fx.t.users, "email LIKE 'lag%'"), 0);
        assert.equal(await fx.count(fx.t.users, "email = 'after@x'"), 1);
      } finally {
        await r.close();
      }
    });
  });

  describe('a nested block whose ROLLBACK TO is not confirmed', () => {
    it('the outer callback catches the block error and returns: no COMMIT, the block row is not saved', async () => {
      await fx.reset();
      const r = rig(fx, {}, (sql) => sql.startsWith('ROLLBACK TO'));
      try {
        const pid = await r.backend();
        const inner = new Error('inner failed');
        let caught: unknown;
        const outcome = await r.db
          .$transaction(async (tx) => {
            await tx.table(fx.t.users).create({ data: { email: 'outer@x' } });
            await tx
              .$transaction(async (block) => {
                await block.table(fx.t.users).create({ data: { email: 'block@x' } });
                throw inner;
              })
              .catch((err: unknown) => {
                caught = err;
              });
          })
          .catch((err: unknown) => err);
        assert.equal(caught, inner);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        // The outer ROLLBACK was acknowledged, so a rollback is claimed and the connection is reused.
        assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
        assert.equal(outcome.cause, inner);
        assert.deepEqual(r.discarded, [false]);
        assert.equal(await r.nextBackend(), pid);
        assert.deepEqual(r.logs.slice(-1), ['transaction-rolled-back']);
        // The truth: neither the block's row nor the outer one was saved.
        assert.equal(await fx.count(fx.t.users, "email IN ('outer@x', 'block@x')"), 0);
      } finally {
        await r.close();
      }
    });

    it("a createMany whose deadline passes between its statements: unknown until the savepoint's rollback is confirmed", async () => {
      // Two rows per statement, so three rows are two INSERTs in the write's savepoint.
      const dialect = {
        ...postgresDialect,
        capabilities: { ...postgresDialect.capabilities, chunkBindParameters: 2, maxInsertRows: 2 },
      };
      for (const refuseRollbackTo of [true, false]) {
        await fx.reset();
        const r = rig(fx, {}, (sql) => refuseRollbackTo && sql.startsWith('ROLLBACK TO'), { dialect });
        try {
          // The first INSERT runs; its query event then holds the thread past the
          // write's 200 ms deadline, so the second one is never sent.
          let held = false;
          r.db.$on('query', (e) => {
            if (held || !e.sql.startsWith('INSERT')) return;
            held = true;
            const start = performance.now();
            while (performance.now() - start < 350) {}
          });
          let blockError: unknown;
          let inside = -1;
          const outcome = await r.db
            .$transaction(async (tx) => {
              blockError = await tx
                .table(fx.t.users)
                .createMany({ data: [{ email: 'c1@x' }, { email: 'c2@x' }, { email: 'c3@x' }], timeout: 200 })
                .catch((err: unknown) => err);
              const [row] = await tx.rawUnsafe<{ n: number }>(
                `SELECT count(*)::int AS n FROM ${fx.t.users} WHERE email LIKE 'c_@x'`,
              );
              inside = row!.n;
              return 'returned';
            })
            .catch((err: unknown) => err);
          assert.ok(blockError instanceof TimeoutError, `got ${String(blockError)}`);
          if (refuseRollbackTo) {
            // The first chunk is still in the transaction: nothing may say the write made no change.
            assert.equal(inside, 2);
            assert.equal(blockError.outcome, 'unknown');
            assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
            assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
          } else {
            assert.equal(inside, 0);
            assert.equal(blockError.outcome, 'not-executed');
            assert.equal(outcome, 'returned');
          }
          assert.equal(await fx.count(fx.t.users, "email LIKE 'c_@x'"), 0);
        } finally {
          await r.close();
        }
      }
    });

    it('a block that rejects with undefined, then an outer write: no COMMIT, neither row saved', async () => {
      await fx.reset();
      const r = rig(fx, {}, (sql) => sql.startsWith('ROLLBACK TO'));
      try {
        let caught: unknown = 'not caught';
        const outcome = await r.db
          .$transaction(async (tx) => {
            try {
              await tx.$transaction(async (block) => {
                await block.table(fx.t.users).create({ data: { email: 'block@x' } });
                throw undefined;
              });
            } catch (err) {
              caught = err;
            }
            await tx.table(fx.t.users).create({ data: { email: 'outer@x' } });
          })
          .then(
            () => 'committed',
            (err: unknown) => err,
          );
        assert.equal(caught, undefined);
        assert.ok(!r.wire.includes('COMMIT'), r.wire.join(' | '));
        assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
        assert.deepEqual(r.logs.slice(-1), ['transaction-rolled-back']);
        assert.equal(await fx.count(fx.t.users, "email IN ('outer@x', 'block@x')"), 0);
      } finally {
        await r.close();
      }
    });
  });

  describe('the documented replay recipe, run against a COMMIT whose answer is lost', () => {
    // payments(idempotency_key UNIQUE, amount UNIQUE). A key starting with `key`
    // makes COMMIT take 300 ms, longer than the 180 ms query_timeout; `key-abort`
    // then fails its deferred check, so that first attempt rolls back.
    before(async () => {
      await fx.raw.query(`
        DROP TABLE IF EXISTS txp_payments;
        CREATE TABLE txp_payments (idempotency_key TEXT NOT NULL UNIQUE, amount INTEGER NOT NULL UNIQUE);
        CREATE OR REPLACE FUNCTION txp_pay_slow_fn() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.idempotency_key LIKE 'key%' THEN PERFORM pg_sleep(0.3); END IF;
            IF NEW.idempotency_key = 'key-abort' THEN RAISE EXCEPTION 'first attempt aborts' USING ERRCODE = '23514'; END IF;
            RETURN NULL;
          END $$;
        CREATE CONSTRAINT TRIGGER txp_pay_slow_trg AFTER INSERT ON txp_payments
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION txp_pay_slow_fn();
      `);
    });
    after(async () => {
      await fx?.raw.query('DROP TABLE IF EXISTS txp_payments; DROP FUNCTION IF EXISTS txp_pay_slow_fn() CASCADE');
    });

    /** The recipe on the transactions page, with this table's names. */
    async function replay(
      db: TurbineClient,
      idempotencyKey: string,
      amount: number,
      beforeReplay?: () => Promise<void>,
    ) {
      const payments = () => db.table<{ idempotencyKey: string; amount: number }>('txp_payments');
      const pay = () =>
        db.$transaction(async (tx) => tx.table('txp_payments').create({ data: { idempotencyKey, amount } }));
      try {
        await pay();
        return 'saved';
      } catch (err) {
        if (!(err instanceof TransactionOutcomeUnknownError)) throw err;
        await beforeReplay?.();
        try {
          await pay();
          return 'saved on replay';
        } catch (replayError) {
          if (
            !(replayError instanceof UniqueConstraintError) ||
            replayError.constraint !== 'txp_payments_idempotency_key_key'
          ) {
            throw replayError;
          }
          const stored = await payments().findUniqueOrThrow({ where: { idempotencyKey } });
          if (stored.amount !== amount) throw new Error(`idempotency key ${idempotencyKey} holds a different payment`);
          return 'first attempt committed';
        }
      }
    }

    it('the first attempt committed: the replay fails on the key, and the read-back confirms it', async () => {
      const schema = await introspect({ connectionString: DATABASE_URL!, include: ['txp_payments'] });
      const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, query_timeout: 180 });
      try {
        const db = new TurbineClient({ pool: pool as unknown as PgCompatPool, warnOnUnlimited: false }, schema);
        assert.equal(await replay(db, 'key-success', 1), 'first attempt committed');
        assert.equal(await fx.count('txp_payments', 'idempotency_key = $1', ['key-success']), 1);
      } finally {
        await pool.end();
      }
    });

    it('the first attempt rolled back and another write took a different unique value: the error propagates', async () => {
      const schema = await introspect({ connectionString: DATABASE_URL!, include: ['txp_payments'] });
      const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1, query_timeout: 180 });
      try {
        const db = new TurbineClient({ pool: pool as unknown as PgCompatPool, warnOnUnlimited: false }, schema);
        const outcome = await replay(db, 'key-abort', 2, async () => {
          await delay(500);
          await fx.raw.query("INSERT INTO txp_payments VALUES ('competitor', 2)");
        }).catch((err: unknown) => err);
        // Not "the first attempt committed": the conflict is on amount, not on the key.
        assert.ok(outcome instanceof UniqueConstraintError, `got ${String(outcome)}`);
        assert.equal(outcome.constraint, 'txp_payments_amount_key');
        assert.equal(await fx.count('txp_payments', 'idempotency_key = $1', ['key-abort']), 0);
      } finally {
        await pool.end();
      }
    });
  });
});
