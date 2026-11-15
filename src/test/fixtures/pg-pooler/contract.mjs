import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const emptySchema = { tables: {}, enums: {} };
const deferred = () => {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
async function until(predicate, message) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await delay(10);
  }
  assert.fail(message);
}
const pid = async (client) => (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
const channels = async (client) =>
  (await client.query('SELECT pg_listening_channels() AS channel')).rows.map((r) => r.channel).sort();
const config = (connectionString) => ({ connectionString, connectionTimeoutMillis: 3000, query_timeout: 5000 });
async function clients(url, count, run) {
  const opened = [];
  try {
    for (let i = 0; i < count; i++) {
      const client = new pg.Client(config(url));
      opened.push(client);
      await client.connect();
    }
    return await run(...opened);
  } finally {
    await Promise.all(opened.map((client) => client.end()));
  }
}
function trackedPool(url, listenGate) {
  const pool = new pg.Pool({ ...config(url), max: 1 });
  const records = [];
  let ends = 0;
  const facade = {
    async connect() {
      const client = await pool.connect();
      const record = { client, pid: await pid(client), sql: [], releases: [] };
      records.push(record);
      return {
        async query(sql) {
          record.sql.push(sql);
          const result = await client.query(sql);
          if (sql.startsWith('LISTEN ') && listenGate) {
            listenGate.ack.resolve();
            await listenGate.allow.promise;
          }
          return result;
        },
        on: client.on.bind(client),
        removeListener: client.removeListener.bind(client),
        release(error) {
          record.releases.push(error);
          client.release(error);
        },
      };
    },
    async end() {
      ends++;
      await pool.end();
    },
  };
  return {
    pool,
    facade,
    records,
    get ends() {
      return ends;
    },
  };
}

// Shared unchanged by the source and actual npm-installed ESM/CJS consumers.
export async function poolerContract(api, test, scope) {
  const names = ['DIRECT', 'SESSION', 'TRANSACTION', 'ADMIN'];
  const urls = Object.fromEntries(
    names.map((key) => {
      const value = process.env[`PG_POOLER_${key}_URL`];
      assert.ok(value, `PG_POOLER_${key}_URL required (real PgBouncer service)`);
      const parsed = new URL(value);
      assert.equal(parsed.hostname, '127.0.0.1', 'disposable loopback service only');
      return [key.toLowerCase(), value];
    }),
  );
  assert.notEqual(urls.session, urls.transaction);
  assert.ok(process.env.PG_POOLER_WS_PORT, 'actual routed WS relay is required');
  const { createNotificationHub, turbineNeonWs, withNeonWs } = api;
  await clients(urls.admin, 1, async (admin) => {
    let admitted = false;
    await test.test('real admin mode/capacity admission, not an endpoint-name heuristic', async () => {
      const version = (await admin.query('SHOW VERSION')).rows[0].version;
      assert.match(version, /^PgBouncer /);
      if (process.env.PG_POOLER_EXPECT_VERSION)
        assert.equal(version, `PgBouncer ${process.env.PG_POOLER_EXPECT_VERSION}`);
      const databases = (await admin.query('SHOW DATABASES')).rows;
      for (const [mode, size, url] of [
        ['session', 1, urls.session],
        ['transaction', 2, urls.transaction],
      ]) {
        const name = new URL(url).pathname.slice(1);
        const database = databases.find((row) => row.name === name);
        assert.ok(database, `${name} must be a configured real PgBouncer database`);
        assert.equal(database.pool_mode, mode);
        assert.equal(Number(database.pool_size), size);
        assert.equal(database.host, '127.0.0.1');
        assert.equal(Number(database.port), Number(new URL(urls.direct).port));
        assert.equal(database.database, new URL(urls.direct).pathname.slice(1));
      }
      const settings = (await admin.query('SHOW CONFIG')).rows;
      for (const [key, value] of [
        ['reserve_pool_size', '0'],
        ['max_prepared_statements', '0'],
        ['server_reset_query_always', '0'],
      ]) {
        assert.equal(settings.find((row) => row.key === key)?.value, value);
      }
      assert.equal(
        await clients(
          urls.direct,
          1,
          async (direct) => (await direct.query('SHOW server_version')).rows[0].server_version,
        ),
        '18.6',
      );
      test.diagnostic(JSON.stringify({ scope, runtime: process.version, version, databases }));
      admitted = true;
    });
    assert.ok(admitted, 'Real PgBouncer admission failed; no behavior tests may run');

    await test.test(
      'session mode retains the physical backend between transactions and queues the second client',
      async () => {
        await clients(urls.session, 2, async (a, b) => {
          const first = await pid(a);
          let completed = false;
          const queued = pid(b).then((value) => {
            completed = true;
            return value;
          });
          // Observe the pooler queue, never infer it from elapsed time.
          try {
            await until(
              async () =>
                (await admin.query('SHOW POOLS')).rows.some(
                  (r) =>
                    r.database === new URL(urls.session).pathname.slice(1) &&
                    Number(r.cl_waiting) === 1 &&
                    Number(r.sv_active) === 1,
                ),
              'second session client did not queue',
            );
            assert.equal(completed, false);
            await a.query('BEGIN');
            assert.equal(await pid(a), first);
            await a.query('COMMIT');
            assert.equal(await pid(a), first);
            await a.query('SELECT pg_advisory_lock(924052,2)');
            await a.query('BEGIN');
            await a.query('COMMIT');
            await clients(urls.direct, 1, async (observer) => {
              assert.equal(
                (await observer.query('SELECT pg_try_advisory_lock(924052,2) AS acquired')).rows[0].acquired,
                false,
              );
              assert.equal((await a.query('SELECT pg_advisory_unlock(924052,2) AS released')).rows[0].released, true);
              assert.equal(
                (await observer.query('SELECT pg_try_advisory_lock(924052,2) AS acquired')).rows[0].acquired,
                true,
              );
              await observer.query('SELECT pg_advisory_unlock(924052,2)');
            });
          } finally {
            await a.end();
            assert.equal(await queued, first, 'one physical server is reborrowed only after client disconnect');
          }
        });
      },
    );

    await test.test(
      'session hub readiness, one listener, channel UNLISTEN, final cleanup and same-backend reborrow',
      async () => {
        await clients(urls.direct, 1, async (sender) => {
          const gate = { ack: deferred(), allow: deferred() };
          const tracked = trackedPool(urls.session, gate);
          const hub = createNotificationHub(tracked.facade, { endpoint: 'session-pool', reconnect: false });
          const seen = [];
          let ready = false;
          const pending = hub
            .subscribe('PoolerCase', (p) => seen.push(`a:${p}`))
            .then((sub) => {
              ready = true;
              return sub;
            });
          try {
            await gate.ack.promise; // Actual server LISTEN has completed; hold only its return to the hub.
            assert.equal(ready, false, 'subscribe readiness must await acknowledged LISTEN');
            assert.deepEqual(await channels(tracked.records[0].client), ['PoolerCase']);
            gate.allow.resolve();
            const a = await pending;
            const b = await hub.subscribe('PoolerCase', (p) => seen.push(`b:${p}`));
            const other = await hub.subscribe('pooler_other', (p) => seen.push(`c:${p}`));
            assert.equal(tracked.records.length, 1);
            assert.deepEqual(tracked.records[0].sql, ['LISTEN "PoolerCase"', 'LISTEN "pooler_other"']);
            assert.equal(hub.stats.connected, true);
            assert.equal(tracked.pool.idleCount, 0);
            await sender.query('SELECT pg_notify($1,$2)', ['PoolerCase', 'exact']);
            await until(() => seen.length === 2, 'session hub payload missing');
            assert.deepEqual(seen, ['a:exact', 'b:exact']);
            await a.unsubscribe();
            assert.deepEqual(await channels(tracked.records[0].client), ['PoolerCase', 'pooler_other']);
            await b.unsubscribe();
            assert.ok(tracked.records[0].sql.includes('UNLISTEN "PoolerCase"'));
            assert.deepEqual(await channels(tracked.records[0].client), ['pooler_other']);
            await other.unsubscribe();
            assert.equal(tracked.records[0].sql.at(-1), 'UNLISTEN *');
            assert.deepEqual(tracked.records[0].releases, [undefined]);
            const reborrowed = await tracked.pool.connect();
            try {
              assert.equal(reborrowed, tracked.records[0].client);
              assert.equal(await pid(reborrowed), tracked.records[0].pid);
              assert.deepEqual(await channels(reborrowed), []);
              assert.equal(reborrowed.listenerCount('notification'), 0);
              assert.equal(reborrowed.listenerCount('end'), 0);
            } finally {
              reborrowed.release();
            }
            await hub.subscribe('pooler_reopened', () => {});
            assert.equal(tracked.records[1].pid, tracked.records[0].pid);
            await hub.close();
            assert.equal(tracked.ends, 0, 'external pool stays caller-owned');
            assert.deepEqual(await channels(tracked.pool), []);
            assert.equal(tracked.pool.waitingCount, 0);
            assert.equal(tracked.pool.idleCount, 1);
          } finally {
            gate.allow.resolve();
            await pending.catch(() => {});
            await hub.close();
            await tracked.pool.end();
          }
        });
      },
    );

    await test.test(
      'transaction mode pins inside BEGIN but a held logical client switches physical backend after COMMIT',
      async () => {
        await clients(urls.transaction, 3, async (a, b, c) => {
          try {
            await a.query('BEGIN');
            const first = await pid(a);
            await a.query('SELECT pg_advisory_xact_lock(924052,1)');
            await b.query('BEGIN');
            const second = await pid(b);
            assert.notEqual(first, second);
            assert.equal(
              (await b.query('SELECT pg_try_advisory_xact_lock(924052,1) AS acquired')).rows[0].acquired,
              false,
            );
            assert.equal(await pid(a), first);
            await a.query('COMMIT');
            assert.equal(
              (await b.query('SELECT pg_try_advisory_xact_lock(924052,1) AS acquired')).rows[0].acquired,
              true,
              'the other physical backend can acquire the lock after COMMIT',
            );
            await c.query('BEGIN');
            assert.equal(await pid(c), first, 'only first backend is available');
            assert.equal(
              (await c.query('SELECT pg_try_advisory_xact_lock(924052,1) AS acquired')).rows[0].acquired,
              false,
              'b owns the lock on the second physical backend',
            );
            await b.query('COMMIT');
            assert.equal(
              (await c.query('SELECT pg_try_advisory_xact_lock(924052,1) AS acquired')).rows[0].acquired,
              true,
              'the lock from the second backend also ends at COMMIT',
            );
            await a.query('BEGIN');
            assert.equal(await pid(a), second, 'same logical client, different backend while c holds first');
            assert.equal(await pid(a), second);
            test.diagnostic(JSON.stringify({ scope, first, second, logicalClientReused: true }));
          } finally {
            await Promise.all([a.query('ROLLBACK'), b.query('ROLLBACK'), c.query('ROLLBACK')]);
          }
        });
      },
    );

    await test.test(
      'transaction-mode NOTIFY commits exactly, rollback suppresses it; listener stays on a direct session',
      async () => {
        await clients(urls.direct, 2, async (listener, fence) => {
          await clients(urls.transaction, 1, async (sender) => {
            const seen = [];
            listener.on('notification', (m) => seen.push(m.payload));
            await listener.query('LISTEN pooler_notify');
            try {
              await sender.query('BEGIN');
              await sender.query("SELECT pg_notify('pooler_notify','committed')");
              await fence.query("SELECT pg_notify('pooler_notify','before-commit-fence')");
              await until(() => seen.includes('before-commit-fence'), 'precommit fence missing');
              assert.deepEqual(seen, ['before-commit-fence']);
              await sender.query('COMMIT');
              await until(() => seen.includes('committed'), 'committed NOTIFY missing');
              await sender.query('BEGIN');
              await sender.query("SELECT pg_notify('pooler_notify','rolled-back')");
              await sender.query('ROLLBACK');
              await fence.query("SELECT pg_notify('pooler_notify','after-rollback-fence')");
              await until(() => seen.includes('after-rollback-fence'), 'postrollback fence missing');
              assert.deepEqual(seen, ['before-commit-fence', 'committed', 'after-rollback-fence']);
            } finally {
              await sender.query('ROLLBACK');
              await listener.query('UNLISTEN *');
            }
          });
        });
      },
    );

    const wsSource = (mode) => ({
      connection: {
        connectionString: mode === 'session' ? urls.session : urls.transaction,
        max: 1,
        connectionTimeoutMillis: 3000,
      },
      driver: {
        webSocketConstructor: WebSocket,
        useSecureWebSocket: false,
        pipelineConnect: false,
        wsProxy: () => `127.0.0.1:${process.env.PG_POOLER_WS_PORT}/${mode}`,
      },
    });
    await test.test('declared transaction hub/WS and invocation LISTEN refusals happen before checkout', async () => {
      const tracked = trackedPool(urls.transaction);
      try {
        for (const endpoint of [undefined, 'transaction-pool', 'statement-pool']) {
          assert.throws(
            () => createNotificationHub(tracked.facade, { endpoint }),
            /explicit direct or session-pool endpoint/,
          );
        }
        assert.equal(tracked.records.length, 0);
        assert.equal(tracked.pool.totalCount, 0);
      } finally {
        await tracked.pool.end();
      }
      await assert.rejects(
        turbineNeonWs(wsSource('transaction'), emptySchema, {
          sessionMode: 'transaction',
          lifetime: 'persistent',
          preparedStatements: true,
        }),
        /Named statements/,
      );
      for (const options of [
        { sessionMode: 'transaction', lifetime: 'persistent' },
        { sessionMode: 'persistent', lifetime: 'invocation' },
      ]) {
        const db = await turbineNeonWs(wsSource('transaction'), emptySchema, options);
        try {
          await assert.rejects(
            db.$listen('pooler_refused', () => {}),
            /persistent backend session/,
          );
          assert.equal(db.pool.totalCount, 0);
        } finally {
          await db.disconnect();
        }
      }
    });

    await test.test(
      'actual WS relay through transaction PgBouncer: callback pin, commit/rollback, NOTIFY and invocation scope',
      async () => {
        // Two raw holders force each checked-out WS logical client onto the only available server.
        await clients(urls.transaction, 2, async (a, b) => {
          const db = await turbineNeonWs(wsSource('transaction'), emptySchema, {
            sessionMode: 'transaction',
            lifetime: 'persistent',
            warnOnUnlimited: false,
          });
          try {
            await a.query('BEGIN');
            const first = await pid(a);
            await b.query('BEGIN');
            const second = await pid(b);
            await a.query('COMMIT');
            await db.$transaction(async (tx) => {
              assert.deepEqual(await tx.raw`SELECT pg_backend_pid() AS pid`, [{ pid: first }]);
              await tx.raw`CREATE TEMP TABLE pooler_scope (id integer) ON COMMIT DROP`;
              await tx.raw`INSERT INTO pooler_scope VALUES (7)`;
              await tx.raw`CREATE TABLE pooler_ws_effects (id integer PRIMARY KEY)`;
              await tx.raw`INSERT INTO pooler_ws_effects VALUES (7)`;
              assert.deepEqual(await tx.raw`SELECT id FROM pooler_scope`, [{ id: 7 }]);
              assert.deepEqual(await tx.raw`SELECT pg_backend_pid() AS pid`, [{ pid: first }]);
            });
            await a.query('BEGIN');
            assert.equal(await pid(a), first);
            assert.deepEqual(
              (await a.query("SELECT to_regclass('pg_temp.pooler_scope') AS relation")).rows,
              [{ relation: null }],
              'ON COMMIT DROP is checked on the original physical backend',
            );
            await clients(urls.direct, 1, async (observer) => {
              assert.deepEqual((await observer.query('SELECT id FROM pooler_ws_effects ORDER BY id')).rows, [
                { id: 7 },
              ]);
            });
            await b.query('COMMIT');
            await assert.rejects(
              db.$transaction(async (tx) => {
                assert.deepEqual(await tx.raw`SELECT pg_backend_pid() AS pid`, [{ pid: second }]);
                await tx.raw`INSERT INTO pooler_ws_effects VALUES (8)`;
                await tx.raw`CREATE TABLE pooler_rollback (id integer)`;
                throw new Error('pooler rollback marker');
              }),
              /pooler rollback marker/,
            );
            assert.deepEqual(await db.raw`SELECT to_regclass('pooler_rollback') AS relation`, [{ relation: null }]);
            assert.deepEqual(await db.raw`SELECT id FROM pooler_ws_effects ORDER BY id`, [{ id: 7 }]);
            await clients(urls.direct, 1, async (listener) => {
              const seen = [];
              listener.on('notification', (m) => seen.push(m.payload));
              await listener.query('LISTEN pooler_ws_notify');
              await db.$notify('pooler_ws_notify', 'ws-through-pooler');
              await until(() => seen.length === 1, 'WS NOTIFY through PgBouncer missing');
              assert.deepEqual(seen, ['ws-through-pooler']);
            });
          } finally {
            await Promise.all([a.query('ROLLBACK'), b.query('ROLLBACK')]);
            await db.disconnect();
            await clients(urls.direct, 1, async (cleanup) => {
              await cleanup.query('DROP TABLE IF EXISTS pooler_ws_effects, pooler_rollback');
            });
          }
        });
        for (const fail of [false, true]) {
          let escaped;
          const run = withNeonWs(wsSource('transaction'), emptySchema, { sessionMode: 'transaction' }, async (db) => {
            escaped = db;
            assert.deepEqual(await db.raw`SELECT 52 AS value`, [{ value: 52 }]);
            await assert.rejects(
              db.$listen('pooler_invocation', () => {}),
              /persistent backend session/,
            );
            if (fail) throw new Error('invocation marker');
            return 52;
          });
          if (fail) await assert.rejects(run, /invocation marker/);
          else assert.equal(await run, 52);
          await assert.rejects(escaped.rawQuery('SELECT 1'), /disconnected/);
        }
      },
    );

    await test.test(
      'actual WS session pool: dedicated LISTEN, exact payload, explicit unsubscribe then disconnect',
      async () => {
        const db = await turbineNeonWs(wsSource('session'), emptySchema, {
          sessionMode: 'persistent',
          lifetime: 'persistent',
          warnOnUnlimited: false,
        });
        let sub;
        try {
          const seen = [];
          sub = await db.$listen('pooler_ws_session', (p) => seen.push(p), { reconnect: false });
          await clients(urls.direct, 1, async (sender) => {
            await sender.query("SELECT pg_notify('pooler_ws_session','session-ws')");
            await until(() => seen.length === 1, 'WS session LISTEN missing');
          });
          assert.deepEqual(seen, ['session-ws']);
          await sub.unsubscribe();
          const reborrowed = await db.pool.connect();
          try {
            assert.deepEqual(await channels(reborrowed), []);
          } finally {
            reborrowed.release();
          }
        } finally {
          await sub?.unsubscribe();
          await db.disconnect();
        }
      },
    );

    await test.test(
      'misdeclared hub accepts LISTEN but loses physical affinity and cannot clean the original listener',
      async () => {
        await clients(urls.transaction, 3, async (a, b, borrower) => {
          const tracked = trackedPool(urls.transaction);
          const hub = createNotificationHub(tracked.facade, { endpoint: 'session-pool', reconnect: false });
          try {
            await a.query('BEGIN');
            const original = await pid(a);
            await b.query('BEGIN');
            const alternate = await pid(b);
            await a.query('COMMIT');
            await hub.subscribe('pooler_wrong_assertion', () => {}); // Deliberately outside the supported contract.
            assert.equal(hub.stats.connected, true, 'declaration does not detect deployment mode');
            assert.equal(tracked.records[0].pid, original);
            await borrower.query('BEGIN');
            assert.equal(await pid(borrower), original);
            assert.deepEqual(
              await channels(borrower),
              ['pooler_wrong_assertion'],
              'session state leaked to another logical borrower',
            );
            await b.query('COMMIT');
            assert.equal(
              await pid(tracked.records[0].client),
              alternate,
              'hub logical checkout did not pin the backend',
            );
            assert.deepEqual(await channels(tracked.records[0].client), []);
            await hub.close(); // This UNLISTEN is on the alternate backend.
            assert.deepEqual(
              await channels(borrower),
              ['pooler_wrong_assertion'],
              'successful close cannot repair a false endpoint assertion',
            );
            await borrower.query('UNLISTEN *');
            await borrower.query('COMMIT');
            test.diagnostic(JSON.stringify({ scope, unsupportedMisdeclaration: true, original, alternate }));
          } finally {
            await Promise.all([a.query('ROLLBACK'), b.query('ROLLBACK'), borrower.query('ROLLBACK')]);
            await hub.close();
            await tracked.pool.end();
          }
        });
      },
    );

    await test.test(
      'misdeclared WS persistent session is accepted but checkout moves to a different backend',
      async () => {
        await clients(urls.transaction, 2, async (a, b) => {
          const db = await turbineNeonWs(wsSource('transaction'), emptySchema, {
            sessionMode: 'persistent',
            lifetime: 'persistent',
            warnOnUnlimited: false,
          });
          try {
            await a.query('BEGIN');
            const first = await pid(a);
            await b.query('BEGIN');
            const second = await pid(b);
            await a.query('COMMIT');
            const lease = await db.pool.connect();
            try {
              assert.equal(await pid(lease), first);
              await a.query('BEGIN');
              assert.equal(await pid(a), first);
              await b.query('COMMIT');
              assert.equal(await pid(lease), second, 'persistent declaration is not actual pooler-mode detection');
            } finally {
              lease.release();
            }
          } finally {
            await Promise.all([a.query('ROLLBACK'), b.query('ROLLBACK')]);
            await db.disconnect();
          }
        });
      },
    );
    test.diagnostic(
      `driver ${JSON.parse(readFileSync(join(dirname(require.resolve('@neondatabase/serverless')), 'package.json'), 'utf8')).version}; scope ${scope}; local routed WS only; lifecycle P1s remain blockers`,
    );
  });
}
