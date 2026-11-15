import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startNative } from './neon-ws-lifecycle-native.ts';

const format = process.argv[2] || 'esm';
const require = createRequire(import.meta.url);
const api =
  format === 'cjs'
    ? require('turbine-orm/neon-ws')
    : format === 'source'
      ? await import('../../neon-ws.ts')
      : await import('turbine-orm/neon-ws');
const neon = format === 'cjs' ? require('@neondatabase/serverless') : await import('@neondatabase/serverless');
const { turbineNeonWs, withNeonWs } = api;
// Standalone generated-style metadata: installed cases load no source implementation.
const columns = [
  {
    name: 'id',
    field: 'id',
    pgType: 'int4',
    tsType: 'number',
    nullable: false,
    hasDefault: true,
    isArray: false,
    pgArrayType: 'int4[]',
  },
  {
    name: 'label',
    field: 'label',
    pgType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
  },
];
const schema = {
  tables: {
    ws_review: {
      name: 'ws_review',
      columns,
      columnMap: { id: 'id', label: 'label' },
      reverseColumnMap: { id: 'id', label: 'label' },
      dateColumns: new Set(),
      dialectTypes: { id: 'int4', label: 'text' },
      pgTypes: { id: 'int4', label: 'text' },
      allColumns: ['id', 'label'],
      primaryKey: ['id'],
      uniqueColumns: [['id']],
      relations: {},
      indexes: [],
    },
  },
  enums: {},
};
assert.equal(
  JSON.parse(readFileSync(join(dirname(require.resolve('@neondatabase/serverless')), 'package.json'), 'utf8')).version,
  '1.2.0',
  'native regressions require actual Neon1.2.0',
);
const empty = { tables: {}, enums: {} };
const options = { sessionMode: 'persistent', lifetime: 'persistent', warnOnUnlimited: false };
const fields = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ')[1].split(' ');
const report = {
  runtime: process.version,
  format,
  process: {
    pid: process.pid,
    parent: process.ppid,
    group: Number(fields[2]),
    execPath: process.execPath,
    argv: process.argv,
  },
  checks: [],
  findings: [],
};
const out = process.env.TURBINE_WS_LIFECYCLE_REPORT;
if (!out) throw new Error('TURBINE_WS_LIFECYCLE_REPORT is required');
assert.ok(process.env.TURBINE_NEON_WS_PG_ROOT, 'TURBINE_NEON_WS_PG_ROOT must name the local PostgreSQL installation.');
const native = await startNative(process.env.TURBINE_NEON_WS_PG_ROOT);
report.serviceRoot = native.root;
const cleanup = [];
const own = async (extra = {}, src = { connection: native.connection, driver: native.driver }) => {
  const db = await turbineNeonWs(src, schema, { ...options, ...extra });
  cleanup.push(() => db.disconnect());
  return db;
};
function gate() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function waitFor(run, label) {
  for (let i = 0; i < 200; i++) {
    if (await run()) return;
    await delay(10);
  }
  throw new Error(label);
}
async function deadline(p, label, ms = 4000) {
  let timer;
  try {
    return await Promise.race([p, new Promise((_, rej) => (timer = setTimeout(() => rej(new Error(label)), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}
async function check(name, run) {
  await run();
  await native.captureOwnership();
  report.checks.push(name);
  console.log('PASS', name);
}
function suppliedPool(max = 2, extra = {}) {
  const pool = new neon.Pool({ ...native.connection, max, ...extra });
  const Base = neon.Client;
  pool.Client = class extends Base {
    constructor(c) {
      super(c);
      Object.assign(this.neonConfig, native.driver);
    }
  };
  cleanup.push(() => pool.end());
  return pool;
}
try {
  await native.admin.query('CREATE TABLE ws_review(id integer PRIMARY KEY,label text NOT NULL)');
  await check('pre-await snapshot of admission, source selection, nested connection and driver config', async () => {
    await assert.rejects(
      turbineNeonWs({ connection: native.connection }, empty, {
        ...options,
        sessionMode: 'transaction',
        preparedStatements: true,
      }),
      /Named statements/,
    );
    const opts = { ...options, preparedStatements: true };
    const connection = { ...native.connection };
    const driver = { ...native.driver };
    const src = { connection, driver };
    const pending = turbineNeonWs(src, empty, opts);
    opts.sessionMode = 'transaction';
    opts.lifetime = 'invocation';
    opts.preparedStatements = false;
    connection.connectionString = 'postgresql://bad@127.0.0.1:1/absent';
    driver.wsProxy = () => '127.0.0.1:1/v1';
    delete src.connection;
    src.client = {};
    const db = await pending;
    cleanup.push(() => db.disconnect());
    assert.equal(db.wsOptions.sessionMode, 'persistent');
    assert.equal(db.wsOptions.lifetime, 'persistent');
    assert.equal(db.queryOptions.preparedStatements, true);
    assert.deepEqual((await db.rawQuery('SELECT 102 AS n')).rows, [{ n: 102 }]);
    const sub = await db.$listen('ws_snapshot_before_await', () => {});
    await sub.unsubscribe();
    class MutableOptions {
      constructor() {
        Object.assign(this, options, { preparedStatements: true });
      }
    }
    class MutableConnection {
      constructor() {
        Object.assign(this, native.connection);
      }
    }
    class MutableDriver {
      constructor() {
        Object.assign(this, native.driver);
      }
    }
    const classOptions = new MutableOptions();
    const sink = {
      entries: [],
      error(_message, entry) {
        this.entries.push(entry.code);
      },
    };
    classOptions.logger = sink;
    const classConnection = new MutableConnection();
    const classDriver = new MutableDriver();
    const classPending = turbineNeonWs({ connection: classConnection, driver: classDriver }, empty, classOptions);
    classOptions.sessionMode = 'transaction';
    classConnection.connectionString = 'postgresql://bad@127.0.0.1:1/absent';
    classDriver.wsProxy = () => '127.0.0.1:1/v1';
    const classDb = await classPending;
    cleanup.push(() => classDb.disconnect());
    assert.equal(classDb.logger, sink);
    assert.equal(classDb.wsOptions.sessionMode, 'persistent');
    assert.equal(classDb.queryOptions.preparedStatements, true);
    assert.deepEqual((await classDb.rawQuery('SELECT 108 AS n')).rows, [{ n: 108 }]);
    const raw = new neon.Client(native.connection);
    Object.assign(raw.neonConfig, native.driver);
    await raw.connect();
    try {
      const controller = new AbortController();
      await assert.rejects(
        turbineNeonWs({ client: raw }, empty, { ...options, signal: controller.signal }),
        /caller connection/,
      );
      const suppliedOptions = { ...options };
      const attach = turbineNeonWs({ client: raw }, empty, suppliedOptions);
      suppliedOptions.signal = controller.signal;
      const caller = await attach;
      try {
        controller.abort(new Error('POST_CALL_SIGNAL_IGNORED'));
        await caller.$transaction(async (tx) => {
          await tx.raw`INSERT INTO ws_review VALUES(101,'caller snapshot commits')`;
        });
        const pid = (await raw.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        assert.equal(
          (await native.admin.query('SELECT xact_start IS NOT NULL AS open FROM pg_stat_activity WHERE pid=$1', [pid]))
            .rows[0].open,
          false,
        );
        assert.deepEqual((await native.admin.query('SELECT id FROM ws_review WHERE id=101')).rows, [{ id: 101 }]);
        await native.admin.query('DELETE FROM ws_review WHERE id=101');
      } finally {
        await caller.disconnect();
      }
      assert.deepEqual((await raw.query('SELECT 103 AS n')).rows, [{ n: 103 }]);
    } finally {
      await raw.end();
    }
  });
  await check('owned invocation abort destroys a held startup with connect timeout zero', async () => {
    const sent = gate();
    const released = false;
    let escaped;
    class HeldWebSocket extends WebSocket {
      send() {
        sent.resolve();
      }
    }
    const controller = new AbortController();
    const reason = new Error('HELD_STARTUP_ABORT');
    const invoke = withNeonWs(
      {
        connection: { ...native.connection, connectionTimeoutMillis: 0 },
        driver: { ...native.driver, webSocketConstructor: HeldWebSocket },
      },
      empty,
      { sessionMode: 'persistent', signal: controller.signal },
      async (db) => {
        escaped = db;
        return db.rawQuery('SELECT 1');
      },
    );
    const rejected = assert.rejects(invoke, (e) => e === reason);
    void rejected.catch(() => {});
    await deadline(sent.promise, 'invocation never started');
    controller.abort(reason);
    await deadline(rejected, 'invocation cleanup waited on held startup');
    assert.equal(escaped.pool._clients.length, 0);
    assert.equal(released, false);
  });
  await check('caller-owned Client refuses deadlines before BEGIN and confirms rollback before reuse', async () => {
    const raw = new neon.Client(native.connection);
    Object.assign(raw.neonConfig, native.driver);
    await raw.connect();
    try {
      const db = await turbineNeonWs({ client: raw }, empty, options);
      const statements = [];
      const query = raw.query.bind(raw);
      raw.query = (q, ...args) => {
        statements.push(typeof q === 'string' ? q : q.text);
        return query(q, ...args);
      };
      try {
        await assert.rejects(
          db.$transaction(async () => {}, { timeout: 20 }),
          /Cannot cancel or destroy/,
        );
        assert.deepEqual(statements, []);
        let escaped;
        await assert.rejects(
          db.$transaction(async (tx) => {
            escaped = tx;
            await tx.raw`INSERT INTO ws_review VALUES(104,'caller rollback')`;
            throw new Error('CALLER_FAIL');
          }),
          /CALLER_FAIL/,
        );
        await assert.rejects(escaped.raw`SELECT 1`, /was rolled back/);
        assert.deepEqual((await native.admin.query('SELECT id FROM ws_review WHERE id=104')).rows, []);
        // Leave real work in flight. The adapter must await its queued rollback,
        // rather than returning this surviving Client in an open transaction.
        const locker = await native.admin.connect();
        await locker.query('SELECT pg_advisory_lock(77163)');
        let pendingStatement;
        let bodyReturned = false;
        let ended = false;
        try {
          const attempt = db
            .$transaction(async (tx) => {
              await tx.raw`INSERT INTO ws_review VALUES(105,'unawaited rollback')`;
              pendingStatement = tx.raw`SELECT pg_advisory_xact_lock(77163)`.catch(() => {});
              await waitFor(
                async () =>
                  (
                    await native.admin.query(
                      "SELECT 1 FROM pg_stat_activity WHERE query='SELECT pg_advisory_xact_lock(77163)' AND wait_event_type='Lock'",
                    )
                  ).rows.length > 0,
                'caller query did not block',
              );
              bodyReturned = true;
            })
            .finally(() => {
              ended = true;
            });
          const rejected = assert.rejects(attempt, /still running/);
          await waitFor(() => bodyReturned, 'caller body did not return');
          // A direct queue observer establishes ROLLBACK is already queued.
          await waitFor(
            () => statements.some((s) => s === 'ROLLBACK') && raw.queryQueue.length > 0,
            'rollback was not queued',
          );
          assert.equal(ended, false);
          await locker.query('SELECT pg_advisory_unlock(77163)');
          await deadline(rejected, 'caller transaction failed to finish rollback');
          await pendingStatement;
        } finally {
          await locker.query('SELECT pg_advisory_unlock(77163)');
          locker.release();
        }
        assert.deepEqual((await native.admin.query('SELECT id FROM ws_review WHERE id IN (104,105)')).rows, []);
        assert.deepEqual((await raw.query('SELECT 106 AS n')).rows, [{ n: 106 }]);
        const pid = (await raw.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        assert.equal(
          (await native.admin.query('SELECT xact_start IS NOT NULL AS open FROM pg_stat_activity WHERE pid=$1', [pid]))
            .rows[0].open,
          false,
        );
      } finally {
        await db.disconnect();
      }
    } finally {
      await raw.end();
    }
  });
  await check(
    'owned checked-out failures forward once; idle failures use inherited default error logging',
    async () => {
      const db = await own();
      const lost = [];
      db.$on('connectionLost', (e) => lost.push(e));
      let pid;
      const pending = db.$transaction(async (tx) => {
        pid = (await tx.raw`SELECT pg_backend_pid() AS pid`)[0].pid;
        await tx.raw`SELECT pg_sleep(30)`;
      });
      const rejected = assert.rejects(pending);
      await waitFor(
        async () =>
          pid &&
          (await native.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid])).rows
            .length > 0,
        'checkout did not start query',
      );
      await native.admin.query('SELECT pg_terminate_backend($1)', [pid]);
      await rejected;
      assert.equal(lost.length, 1);
      assert.equal(lost[0].pool, 'primary');
      assert.deepEqual((await db.rawQuery('SELECT 107 AS n')).rows, [{ n: 107 }]);
      await db.disconnect();
      assert.equal(db.pool.observers.size, 0);
      const logs = [];
      const logging = await own({ logger: { error: (message, entry) => logs.push({ message, ...entry }) } });
      const idle = (await logging.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await native.admin.query('SELECT pg_terminate_backend($1)', [idle]);
      await waitFor(() => logs.some((e) => e.code === 'pool-error'), 'idle failure did not reach default log path');
      assert.equal(logs.filter((e) => e.code === 'pool-error').length, 1);
      await logging.disconnect();
      assert.equal(logging.pool.pool.listenerCount('error'), 0);
    },
  );
  await check('native typed rows, exact bigint/date/arrays, pinned backend, SQL-error rollback', async () => {
    const db = await own();
    await db.table('ws_review').create({ data: { id: 1, label: "O'Brien" } });
    assert.deepEqual(await db.table('ws_review').findMany({ orderBy: { id: 'asc' } }), [{ id: 1, label: "O'Brien" }]);
    const row = (
      await db.rawQuery(
        "SELECT 12::bigint AS small,9007199254740993::bigint AS big,TIMESTAMP '2026-02-03 04:05:06' AS stamp,ARRAY[DATE '2026-02-03',NULL] AS dates,12.34::numeric AS decimal",
      )
    ).rows[0];
    assert.equal(row.small, 12);
    assert.equal(row.big, '9007199254740993');
    assert.equal(row.stamp.toISOString(), '2026-02-03T04:05:06.000Z');
    assert.equal(row.dates[0].toISOString(), '2026-02-03T00:00:00.000Z');
    assert.equal(row.dates[1], null);
    assert.equal(row.decimal, '12.34');
    await db.$transaction(async (tx) => {
      const before = await tx.raw`SELECT pg_backend_pid() AS pid`;
      await tx.raw`INSERT INTO ws_review VALUES(2,'commit')`;
      assert.deepEqual(await tx.raw`SELECT pg_backend_pid() AS pid`, before);
    });
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.raw`INSERT INTO ws_review VALUES(3,'rollback')`;
        await tx.raw`INSERT INTO ws_review VALUES(1,'duplicate')`;
      }),
    );
    let escaped;
    await assert.rejects(
      db.$transaction(async (tx) => {
        escaped = tx;
        await tx.raw`INSERT INTO ws_review VALUES(95,'caught SQL error')`;
        try {
          await tx.raw`INSERT INTO ws_review VALUES(1,'duplicate caught')`;
        } catch {}
      }),
      /rolled back/,
    );
    await assert.rejects(escaped.raw`SELECT 1`, /was rolled back/);
    assert.deepEqual((await db.rawQuery('SELECT id FROM ws_review ORDER BY id')).rows, [{ id: 1 }, { id: 2 }]);
    assert.deepEqual((await db.rawQuery('SELECT 4 AS recovered')).rows, [{ recovered: 4 }]);
    report.parsers = {
      small: row.small,
      big: row.big,
      stamp: row.stamp.toISOString(),
      date: row.dates[0].toISOString(),
      decimal: row.decimal,
    };
  });
  await check('snapshot options/driver settings; actual fetch omission control; globals restored', async () => {
    const old = { poolQueryViaFetch: neon.neonConfig.poolQueryViaFetch, fetchFunction: neon.neonConfig.fetchFunction };
    const before = { ...neon.neonConfig.opts };
    let fetchAttempts = 0;
    neon.neonConfig.poolQueryViaFetch = true;
    neon.neonConfig.fetchFunction = async () => {
      fetchAttempts++;
      throw new Error('FETCH_FORBIDDEN_REVIEW');
    };
    const productionBefore = { ...neon.neonConfig.opts };
    try {
      const mutableOptions = { ...options };
      const mutableDriver = { ...native.driver };
      const db = await turbineNeonWs({ connection: native.connection, driver: mutableDriver }, schema, mutableOptions);
      cleanup.push(() => db.disconnect());
      mutableOptions.sessionMode = 'transaction';
      mutableOptions.lifetime = 'invocation';
      mutableDriver.wsProxy = () => '127.0.0.1:1/v1';
      assert.deepEqual(await db.raw`SELECT 11 AS n`, [{ n: 11 }]);
      const sub = await db.$listen('ws_review_snapshot', () => {});
      await sub.unsubscribe();
      assert.equal(fetchAttempts, 0);
      assert.deepEqual({ ...neon.neonConfig.opts }, productionBefore);
      const direct = new neon.Pool(native.connection);
      try {
        await assert.rejects(direct.query('SELECT 12'), /FETCH_FORBIDDEN_REVIEW/);
        assert.equal(fetchAttempts, 1);
      } finally {
        await direct.end();
      }
      report.fetchControl = { adapterFetchCalls: 0, directPoolFetchCalls: fetchAttempts };
    } finally {
      neon.neonConfig.poolQueryViaFetch = old.poolQueryViaFetch;
      neon.neonConfig.fetchFunction = old.fetchFunction;
      for (const key of Object.keys(neon.neonConfig.opts))
        if (!Object.hasOwn(before, key)) delete neon.neonConfig.opts[key];
      assert.deepEqual({ ...neon.neonConfig.opts }, before);
    }
  });
  await check('supplied Client overlap/busy disconnect/signal/LISTEN refusals and caller lifetime', async () => {
    const raw = new neon.Client(native.connection);
    Object.assign(raw.neonConfig, native.driver);
    await raw.connect();
    try {
      await assert.rejects(
        turbineNeonWs({ client: raw }, empty, { ...options, signal: new AbortController().signal }),
        /caller connection/,
      );
      const db = await turbineNeonWs({ client: raw }, schema, options);
      await assert.rejects(
        db.$listen('ws_review_client', () => {}),
        /dedicated listener/,
      );
      await db.$transaction(async (tx) => {
        await assert.rejects(db.rawQuery('SELECT 1'), /already leased/);
        await assert.rejects(db.disconnect(), /busy caller-owned/);
        assert.deepEqual(await tx.raw`SELECT 21 AS n`, [{ n: 21 }]);
      });
      await db.disconnect();
      assert.deepEqual((await raw.query('SELECT 22 AS n')).rows, [{ n: 22 }]);
    } finally {
      await raw.end();
    }
  });
  await check('supplied Pool late acquisition is destroyed without SQL, external checkout survives', async () => {
    const pool = suppliedPool(1);
    let sent = 0;
    const Base = pool.Client;
    pool.Client = class extends Base {
      query(q, ...args) {
        if ((typeof q === 'string' ? q : q.text).includes('LATE_CHECKOUT_REVIEW')) sent++;
        return super.query(q, ...args);
      }
    };
    const held = await pool.connect();
    const originalPid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const db = await own({}, { pool });
    const pending = db.rawQuery("SELECT 'LATE_CHECKOUT_REVIEW'");
    const rejected = assert.rejects(pending, /disconnected/);
    await waitFor(() => pool.waitingCount === 1, 'no queued checkout');
    assert.equal((await db.disconnect({ timeoutMs: 0 })).forcedConnections, 0);
    await rejected;
    assert.equal((await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, originalPid);
    held.release();
    await waitFor(() => pool.totalCount === 0, 'late client not destroyed');
    assert.equal(sent, 0);
    const next = await pool.connect();
    try {
      assert.notEqual((await next.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, originalPid);
    } finally {
      next.release();
    }
  });
  await check('transaction/session refusals and invocation cleanup on throw', async () => {
    await assert.rejects(
      turbineNeonWs({ connection: native.connection }, schema, {
        ...options,
        sessionMode: 'transaction',
        preparedStatements: true,
      }),
      /Named statements/,
    );
    const transactionDb = await own({ sessionMode: 'transaction' });
    await assert.rejects(
      transactionDb.$listen('ws_review_bad', () => {}),
      /persistent backend/,
    );
    let escaped;
    await assert.rejects(
      withNeonWs(
        { connection: native.connection, driver: native.driver },
        schema,
        { sessionMode: 'persistent' },
        async (db) => {
          escaped = db;
          await assert.rejects(
            db.$listen('ws_review_invocation', () => {}),
            /persistent lifetime/,
          );
          await db.rawQuery('SELECT 1');
          throw new Error('INVOCATION_REVIEW');
        },
      ),
      /INVOCATION_REVIEW/,
    );
    await assert.rejects(escaped.rawQuery('SELECT 1'), /disconnected/);
  });
  await check('held-out owned shutdown during an uncompleted actual Neon handshake', async () => {
    const sent = gate();
    const paused = true;
    const buffered = [];
    class HeldWebSocket extends WebSocket {
      send(...args) {
        if (paused) {
          buffered.push([this, args]);
          sent.resolve();
          return;
        }
        return super.send(...args);
      }
    }
    const db = await own(
      {},
      {
        connection: { ...native.connection, connectionTimeoutMillis: 0 },
        driver: { ...native.driver, webSocketConstructor: HeldWebSocket },
      },
    );
    const pending = db.rawQuery('SELECT 71 AS stalled');
    const rejected = assert.rejects(pending, /disconnected/);
    await deadline(sent.promise, 'startup frame never sent');
    const raw = db.pool._clients[0];
    assert.equal(raw._connecting, true);
    const result = await deadline(db.disconnect({ timeoutMs: 0 }), 'disconnect waited for held startup');
    await rejected;
    assert.equal(db.pool._clients.length, 0);
    assert.equal(raw.connection.stream.destroyed, true);
    assert.equal(result.forcedConnections, 1);
    assert.ok(paused);
    assert.ok(buffered.length > 0);
    report.stalledHandshake = { disconnectSettledBeforeHandshakeReleased: true, rawClientCount: 0, timeoutMs: 0 };
    // Never release the bytes: doing so would conceal a shutdown regression.
  });
  await check('held-out owned Pool error events and query recovery', async () => {
    const db = await own();
    const events = [];
    db.$on('poolError', (e) => events.push(e));
    db.$on('connectionLost', (e) => events.push(e));
    const pid = (await db.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const actualPool = db.pool.pool;
    let rawErrors = 0;
    actualPool.on('error', () => rawErrors++);
    await native.admin.query('SELECT pg_terminate_backend($1)', [pid]);
    await waitFor(() => rawErrors > 0, 'native idle failure not observed');
    assert.deepEqual((await db.rawQuery('SELECT 81 AS recovered')).rows, [{ recovered: 81 }]);
    report.events = { nativeOwnedPoolErrors: rawErrors, turbinePoolEvents: events.length };
    assert.equal(events.length, 1);
    assert.equal(events[0].pool, 'primary');
    assert.equal(events[0].error.code, '57P01');
    await db.disconnect();
    assert.equal(db.pool.observers.size, 0);
    assert.equal(db.pool.onFailure, undefined);
  });
  await check('held-out transaction timeout: observe actual backend lock after the error', async () => {
    const locker = await native.admin.connect();
    await locker.query('SELECT pg_advisory_lock(77162)');
    const logs = [];
    const db = await own({ logging: true, logger: { debug: (message, entry) => logs.push({ message, ...entry }) } });
    let pid;
    let error;
    let escaped;
    try {
      try {
        await db.$transaction(
          async (tx) => {
            escaped = tx;
            pid = (await tx.raw`SELECT pg_backend_pid() AS pid`)[0].pid;
            await tx.raw`INSERT INTO ws_review VALUES(91,'timeout')`;
            await tx.raw`SELECT pg_advisory_xact_lock(77162)`;
          },
          { timeout: 150 },
        );
      } catch (e) {
        error = e;
      }
      assert.ok(error);
      assert.equal(error.code, 'TURBINE_E002');
      const backend = (
        await native.admin.query('SELECT state,wait_event_type,wait_event,query FROM pg_stat_activity WHERE pid=$1', [
          pid,
        ])
      ).rows;
      report.timeout = { message: error.message, outcome: error.outcome, backendAfterError: backend };
      assert.ok(backend.some((r) => r.state === 'active' && r.wait_event_type === 'Lock'));
      assert.equal(error.outcome, 'unknown');
      assert.match(error.message, /not confirmed.*unknown/);
      assert.doesNotMatch(error.message, /was rolled back|none.*saved|was cancelled/);
      await assert.rejects(escaped.raw`SELECT 1`, /unknown outcome/);
      assert.ok(logs.some((e) => e.code === 'transaction-outcome-unknown'));
      assert.ok(!logs.some((e) => e.code === 'transaction-rolled-back'));
    } finally {
      await locker.query('SELECT pg_advisory_unlock(77162)');
      locker.release();
    }
    await waitFor(
      async () => !(await native.admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [pid])).rows.length,
      'timed-out backend remains after lock released',
    );
    assert.deepEqual((await native.admin.query('SELECT id FROM ws_review WHERE id=91')).rows, []);
  });
  await check('held-out COMMIT response loss preserves unknown write outcome', async () => {
    const controller = new AbortController();
    const logs = [];
    const db = await own({
      signal: controller.signal,
      logging: true,
      logger: { debug: (message, entry) => logs.push({ message, ...entry }) },
    });
    await db.rawQuery('SELECT 1');
    const raw = db.pool._clients[0];
    const query = raw.query.bind(raw);
    const commitSent = gate();
    raw.query = (q, ...args) => {
      if (/^COMMIT/.test(typeof q === 'string' ? q : q.text)) {
        native.controls.holdServer = true;
        commitSent.resolve();
      }
      return query(q, ...args);
    };
    let error;
    let escaped;
    const tx = db
      .$transaction(async (tx) => {
        escaped = tx;
        await tx.raw`INSERT INTO ws_review VALUES(92,'commit acknowledgement held')`;
      })
      .catch((e) => {
        error = e;
      });
    await deadline(commitSent.promise, 'COMMIT was not sent');
    await waitFor(
      async () => (await native.admin.query('SELECT id FROM ws_review WHERE id=92')).rows.length === 1,
      'real COMMIT did not persist',
    );
    assert.ok(native.controls.held.length > 0);
    controller.abort(new Error('COMMIT_ACK_REVIEW'));
    await deadline(tx, 'aborted COMMIT did not reject');
    await db.disconnect();
    native.controls.release();
    assert.ok(error);
    assert.equal(error, controller.signal.reason);
    assert.doesNotMatch(error.message, /none.*saved|rolled back|cancelled on the server/i);
    let escapedError;
    try {
      await escaped.raw`SELECT 1`;
    } catch (e) {
      escapedError = e.message;
    }
    assert.match(escapedError, /unknown outcome/);
    assert.ok(logs.some((e) => e.code === 'transaction-outcome-unknown'));
    assert.ok(!logs.some((e) => e.code === 'transaction-rolled-back'));
    report.commitAckLoss = {
      serverCommitted: true,
      error: error.message,
      outcome: error.outcome ?? null,
      escapedHandleError: escapedError,
      scope: 'real COMMIT; held native server-to-WS acknowledgement in isolated relay',
    };
  });
  await check('idle callback timeout confirms rollback without claiming cancellation', async () => {
    const logs = [];
    const db = await own({ logging: true, logger: { debug: (message, entry) => logs.push({ message, ...entry }) } });
    const body = gate();
    let escaped;
    try {
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            escaped = tx;
            await tx.raw`INSERT INTO ws_review VALUES(94,'idle timeout')`;
            await body.promise;
          },
          { timeout: 100 },
        ),
        (error) => {
          assert.equal(error.outcome, 'not-executed');
          assert.match(error.message, /rollback was confirmed/);
          assert.doesNotMatch(error.message, /cancelled/);
          return true;
        },
      );
      await assert.rejects(escaped.raw`SELECT 1`, /was rolled back/);
      assert.deepEqual((await native.admin.query('SELECT id FROM ws_review WHERE id=94')).rows, []);
      assert.ok(logs.some((e) => e.code === 'transaction-rolled-back'));
      assert.ok(!logs.some((e) => e.code === 'transaction-outcome-unknown'));
    } finally {
      body.resolve();
    }
  });
  await check('legacy raw transaction preserves unknown COMMIT and escaped-handle state', async () => {
    const controller = new AbortController();
    const db = await own({ signal: controller.signal });
    await db.rawQuery('SELECT 1');
    const raw = db.pool._clients[0];
    const query = raw.query.bind(raw);
    const sent = gate();
    let escaped;
    raw.query = (q, ...args) => {
      if (/^COMMIT/.test(typeof q === 'string' ? q : q.text)) {
        native.controls.holdServer = true;
        sent.resolve();
      }
      return query(q, ...args);
    };
    const reason = new Error('RAW_COMMIT_ACK_HELD');
    const pending = db.transaction(async (client) => {
      escaped = client;
      await client.query("INSERT INTO ws_review VALUES(93,'raw committed')");
    });
    const rejected = assert.rejects(pending, (e) => e === reason);
    void rejected.catch(() => {});
    try {
      await deadline(sent.promise, 'raw COMMIT not sent');
      await waitFor(
        async () => (await native.admin.query('SELECT id FROM ws_review WHERE id=93')).rows.length === 1,
        'raw COMMIT did not persist',
      );
      controller.abort(reason);
      await deadline(rejected, 'raw COMMIT did not reject');
      await db.disconnect();
      await assert.rejects(escaped.query('SELECT 1'), /unknown outcome/);
    } finally {
      native.controls.release();
    }
  });
  await check('native listener reconnect and disconnect during queued listener acquisition', async () => {
    const db = await own();
    const reconnected = gate();
    const messages = [];
    const arrival = gate();
    const sub = await db.$listen(
      'ws_review_reconnect',
      (p) => {
        messages.push(p);
        arrival.resolve();
      },
      {
        reconnect: { initialDelayMs: 10, maxDelayMs: 20 },
        onError: () => {},
        onReconnect: () => reconnected.resolve(),
      },
    );
    const listenerPid = (
      await native.admin.query(
        "SELECT pid FROM pg_stat_activity WHERE application_name='neon_ws_native' AND query='LISTEN \"ws_review_reconnect\"'",
      )
    ).rows[0].pid;
    await native.admin.query('SELECT pg_terminate_backend($1)', [listenerPid]);
    await deadline(reconnected.promise, 'listener failed to reconnect');
    await db.$notify('ws_review_reconnect', 'after reconnect');
    await deadline(arrival.promise, 'missing reconnected notification');
    assert.deepEqual(messages, ['after reconnect']);
    await db.disconnect();
    await sub.unsubscribe();
    const pool = suppliedPool(1);
    const held = await pool.connect();
    const blocked = await own({}, { pool });
    const pending = blocked.$listen('ws_review_pending_listen', () => {});
    const rejected = assert.rejects(pending, /disconnected/);
    await waitFor(() => pool.waitingCount === 1, 'LISTEN did not wait for pool');
    await blocked.disconnect();
    await rejected;
    held.release();
    await waitFor(() => pool.totalCount === 0, 'late listener acquisition leaked');
  });
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const close of cleanup.reverse()) await close();
  await native.close();
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(JSON.stringify(report, null, 2));
