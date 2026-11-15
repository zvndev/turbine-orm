import assert from 'node:assert/strict';
import { getEventListeners, once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { startNative } from './neon-ws-corrective-native.ts';

const format = process.argv[2] || 'source';
const require = createRequire(import.meta.url);
const api =
  format === 'source'
    ? await import('../../neon-ws.ts')
    : format === 'cjs'
      ? require('turbine-orm/neon-ws')
      : await import('turbine-orm/neon-ws');
const neon = format === 'cjs' ? require('@neondatabase/serverless') : await import('@neondatabase/serverless');
const { turbineNeonWs, withNeonWs } = api;
const empty = { tables: {}, enums: {} };
const opts = { sessionMode: 'persistent', lifetime: 'persistent', warnOnUnlimited: false };
const stat = (await readFile(`/proc/${process.pid}/stat`, 'utf8')).split(') ')[1].split(' ');
const report = {
  format,
  runtime: process.version,
  execPath: process.execPath,
  pid: process.pid,
  group: Number(stat[2]),
  checks: [],
  findings: [],
  observations: [],
};
const path = process.env.TURBINE_WS_CORRECTIVE_REPORT;
assert.ok(path);
const native = await startNative(process.env.TURBINE_NEON_WS_PG_ROOT);
report.serviceRoot = native.root;
const cleanups = [];
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
};
async function bound(p, label, ms = 6000) {
  let t;
  try {
    return await Promise.race([p, new Promise((_, r) => (t = setTimeout(() => r(new Error(label)), ms)))]);
  } finally {
    clearTimeout(t);
  }
}
async function waitFor(fn, label) {
  for (let i = 0; i < 400; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw new Error(label);
}
async function own(extra = {}, source = { connection: { ...native.connection, max: 1 }, driver: native.driver }) {
  const db = await turbineNeonWs(source, empty, { ...opts, ...extra });
  cleanups.push(() => db.disconnect());
  return db;
}
async function check(name, fn) {
  if (process.env.TURBINE_WS_CORRECTIVE_CASE && !name.includes(process.env.TURBINE_WS_CORRECTIVE_CASE)) return;
  await fn();
  report.checks.push(name);
  await native.captureOwnership();
  console.log('PASS', name);
}
const capture = async (fn) => {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
};
try {
  await native.admin.query(
    'CREATE TABLE review_rows(id int PRIMARY KEY, label text); CREATE TABLE deferred_rows(id int, UNIQUE(id) DEFERRABLE INITIALLY DEFERRED)',
  );
  await check('per-lease COMMIT state resets across success, callback failure and server ROLLBACK tag', async () => {
    const logs = [];
    const db = await own({ logging: true, logger: { debug: (message, e) => logs.push({ message, ...e }) } });
    const pid = (await db.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const raw = db.pool._clients[0];
    const query = raw.query.bind(raw);
    const tags = [];
    raw.query = async (q, ...args) => {
      const result = await query(q, ...args);
      const text = typeof q === 'string' ? q : q.text;
      if (text === 'COMMIT' || text === 'ROLLBACK') tags.push({ q: text, tag: result.command });
      return result;
    };
    await db.$transaction(async (tx) => {
      await tx.raw`INSERT INTO review_rows VALUES(1,'kept')`;
    });
    let escaped;
    const marker = new Error('SECOND_LEASE_CALLBACK');
    assert.equal(
      await capture(() =>
        db.$transaction(async (tx) => {
          escaped = tx;
          await tx.raw`INSERT INTO review_rows VALUES(2,'undo')`;
          throw marker;
        }),
      ),
      marker,
    );
    assert.match((await capture(() => escaped.raw`SELECT 1`)).message, /was rolled back/);
    let escapedTag;
    const tagError = await capture(() =>
      db.$transaction(async (tx) => {
        escapedTag = tx;
        await tx.raw`INSERT INTO review_rows VALUES(3,'undo by tag')`;
        await tx.raw`SELECT 1/0`.catch(() => {});
      }),
    );
    assert.ok(tagError);
    assert.match(tagError.message, /rolled back/);
    assert.match((await capture(() => escapedTag.raw`SELECT 1`)).message, /was rolled back/);
    assert.ok(tags.some((t) => t.q === 'COMMIT' && t.tag === 'ROLLBACK'));
    assert.equal(logs.filter((e) => e.code === 'transaction-outcome-unknown').length, 0);
    assert.equal((await db.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
    assert.deepEqual((await native.admin.query('SELECT id FROM review_rows ORDER BY id')).rows, [{ id: 1 }]);
    report.observations.push({
      case: 'per-lease',
      pid,
      tags,
      logs: logs.filter((e) => e.code.startsWith('transaction-')),
    });
  });
  await check('native COMMIT deferred-constraint error is observed separately from acknowledgement loss', async () => {
    const db = await own();
    let escaped;
    const err = await capture(() =>
      db.$transaction(async (tx) => {
        escaped = tx;
        await tx.raw`INSERT INTO deferred_rows VALUES(1),(1)`;
      }),
    );
    assert.equal(err.code, 'TURBINE_E008');
    assert.deepEqual((await native.admin.query('SELECT * FROM deferred_rows')).rows, []);
    report.observations.push({
      case: 'deferrable-commit-failure',
      error: err.message,
      code: err.code,
      escaped: (await capture(() => escaped.raw`SELECT 1`)).message,
    });
  });
  await check(
    'caller Client timeout refusal, queued rollback, primary non-Error callback and listener preservation',
    async () => {
      const raw = new neon.Client(native.connection);
      Object.assign(raw.neonConfig, native.driver);
      const callerErrors = [];
      const callerListener = (e) => callerErrors.push(e);
      raw.on('error', callerListener);
      await raw.connect();
      try {
        const db = await own({}, { client: raw });
        const commands = [];
        const query = raw.query.bind(raw);
        raw.query = (q, ...args) => {
          commands.push(q);
          return query(q, ...args);
        };
        assert.match(
          (await capture(() => db.$transaction(async () => {}, { timeout: 25 }))).message,
          /Cannot cancel or destroy/,
        );
        assert.deepEqual(commands, []);
        const thrown = { marker: 'caller callback object' };
        assert.equal(
          await capture(() =>
            db.$transaction(async (tx) => {
              await tx.raw`INSERT INTO review_rows VALUES(4,'undo caller')`;
              throw thrown;
            }),
          ),
          thrown,
        );
        assert.equal(typeof commands.at(-1) === 'string' ? commands.at(-1) : commands.at(-1).text, 'ROLLBACK');
        await db.disconnect();
        assert.ok(raw.listeners('error').includes(callerListener));
        assert.equal(raw._ending, false);
        assert.deepEqual((await raw.query('SELECT 51 AS n')).rows, [{ n: 51 }]);
        assert.deepEqual((await native.admin.query('SELECT id FROM review_rows WHERE id=4')).rows, []);
      } finally {
        await raw.end();
      }
    },
  );
  await check('caller Pool abort preserves external lease, queue ownership and caller listeners', async () => {
    const pool = new neon.Pool({ ...native.connection, max: 1 });
    const Base = neon.Client;
    pool.Client = class extends Base {
      constructor(c) {
        super(c);
        Object.assign(this.neonConfig, native.driver);
      }
    };
    const callerError = () => {};
    pool.on('error', callerError);
    const held = await pool.connect();
    const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    try {
      const ctl = new AbortController();
      const db = await own({ signal: ctl.signal }, { pool });
      const reason = new Error('CALLER_POOL_ABORT');
      const p = capture(() => db.rawQuery("SELECT 'must never execute' AS marker"));
      await waitFor(() => pool.waitingCount === 1, 'no queued checkout');
      ctl.abort(reason);
      assert.equal(await p, reason);
      await bound(db.disconnect(), 'caller pool disconnect');
      assert.equal(pool.ended, false);
      assert.ok(pool.listeners('error').includes(callerError));
      assert.deepEqual((await held.query('SELECT pg_backend_pid() AS pid')).rows, [{ pid }]);
      held.release();
      await waitFor(() => pool.totalCount === 0, 'late binding checkout not discarded');
      assert.deepEqual((await pool.query('SELECT 52 AS n')).rows, [{ n: 52 }]);
      assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
      report.observations.push({ case: 'queued-pool', pid, callerListenerRetained: true });
    } finally {
      try {
        held.release(true);
      } catch {}
      await pool.end();
    }
  });
  await check(
    'shutdown before WebSocket upgrade closes owned connecting Client without releasing handshake',
    async () => {
      const server = createServer();
      const sockets = new Set();
      const upgrade = gate();
      server.on('connection', (s) => {
        sockets.add(s);
        s.once('close', () => sockets.delete(s));
      });
      server.on('upgrade', (_req, s) => {
        s.once('end', () => s.destroy());
        s.resume();
        upgrade.resolve();
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const port = server.address().port;
      report.extraPorts = [...(report.extraPorts || []), port];
      try {
        const db = await own(
          {},
          {
            connection: { ...native.connection, connectionTimeoutMillis: 0 },
            driver: { ...native.driver, wsProxy: () => `127.0.0.1:${port}/held` },
          },
        );
        const query = capture(() => db.rawQuery('SELECT 1'));
        await bound(upgrade.promise, 'upgrade did not arrive');
        assert.equal(db.pool._clients.length, 1);
        await bound(db.disconnect({ timeoutMs: 0 }), 'shutdown hung before WS upgrade');
        assert.ok(await query);
        assert.equal(db.pool._clients.length, 0);
        await waitFor(() => sockets.size === 0, 'upgrade socket not gone');
      } finally {
        for (const s of sockets) s.destroy();
        await new Promise((r) => server.close(r));
      }
    },
  );
  await check('Error abort reason, mid-factory abort, repeated signals and observers are cleaned', async () => {
    const mid = new AbortController();
    const midReason = new Error('MID_FACTORY');
    const p = capture(() =>
      turbineNeonWs({ connection: native.connection, driver: native.driver }, empty, { ...opts, signal: mid.signal }),
    );
    mid.abort(midReason);
    assert.equal(await p, midReason);
    assert.equal(getEventListeners(mid.signal, 'abort').length, 0);
    const ctl = new AbortController();
    const baseline = getEventListeners(ctl.signal, 'abort').length;
    for (let i = 0; i < 3; i++) {
      const db = await own({ signal: ctl.signal });
      await db.rawQuery('SELECT 1');
      assert.equal(getEventListeners(ctl.signal, 'abort').length, baseline + 1);
      await db.disconnect();
      assert.equal(getEventListeners(ctl.signal, 'abort').length, baseline);
      assert.equal(db.pool.observers.size, 0);
      assert.equal(db.pool.pool.listenerCount('error'), 0);
    }
  });
  await check('real driver COMMIT read-timeout followed by queued ROLLBACK cannot imply rollback', async () => {
    const pool = new neon.Pool({ ...native.connection, max: 1, query_timeout: 250 });
    const Base = neon.Client;
    pool.Client = class extends Base {
      constructor(c) {
        super(c);
        Object.assign(this.neonConfig, native.driver);
      }
    };
    pool.on('error', () => {});
    const logs = [];
    let db;
    try {
      db = await own({ logging: true, logger: { debug: (message, e) => logs.push({ message, ...e }) } }, { pool });
      await db.rawQuery('SELECT 1');
      const raw = pool._clients[0];
      const query = raw.query.bind(raw);
      const commit = gate();
      const rollback = gate();
      const submitted = [];
      raw.query = (q, ...args) => {
        const text = typeof q === 'string' ? q : q.text;
        submitted.push({ text, kind: typeof q });
        if (text === 'COMMIT') {
          native.controls.holdServer = true;
          commit.resolve();
        }
        if (text === 'ROLLBACK') rollback.resolve();
        return query(q, ...args);
      };
      let escaped;
      const pending = capture(() =>
        db.$transaction(async (tx) => {
          escaped = tx;
          await tx.raw`INSERT INTO review_rows VALUES(6,'committed before read timeout')`;
        }),
      );
      try {
        await bound(commit.promise, 'COMMIT not submitted');
        await waitFor(
          async () => !!(await native.admin.query('SELECT id FROM review_rows WHERE id=6')).rows.length,
          'server did not commit',
        );
        const error = await bound(pending, 'COMMIT read timeout did not settle without acknowledgement');
        assert.ok(error);
        assert.equal(submitted.filter((q) => q.text === 'ROLLBACK').length, 0);
        native.controls.release();
        const escapedError = await capture(() => escaped.raw`SELECT 1`);
        const row = (await native.admin.query('SELECT id FROM review_rows WHERE id=6')).rows;
        assert.deepEqual(row, [{ id: 6 }]);
        const observation = {
          case: 'commit-read-timeout',
          serverCommitted: true,
          submitted,
          error: { message: error.message, code: error.code, outcome: error.outcome },
          escaped: escapedError.message,
          logs: logs.filter((e) => e.code.startsWith('transaction-')),
        };
        report.observations.push(observation);
        assert.match(escapedError.message, /unknown outcome/);
        assert.equal(logs.filter((e) => e.code === 'transaction-rolled-back').length, 0);
        assert.equal(logs.filter((e) => e.code === 'transaction-outcome-unknown').length, 1);
        assert.ok(submitted.some((q) => q.text === 'COMMIT' && q.kind === 'object'));
        assert.equal(error.message, 'Query read timeout');
      } finally {
        native.controls.release();
      }
    } finally {
      if (db) await db.disconnect();
      await pool.end();
    }
  });
  await check(
    'legacy string COMMIT omission control retains unknown outcome after the same real read timeout',
    async () => {
      const pool = new neon.Pool({ ...native.connection, max: 1, query_timeout: 250 });
      const Base = neon.Client;
      pool.Client = class extends Base {
        constructor(c) {
          super(c);
          Object.assign(this.neonConfig, native.driver);
        }
      };
      pool.on('error', () => {});
      let db;
      try {
        db = await own({}, { pool });
        await db.rawQuery('SELECT 1');
        const raw = pool._clients[0];
        const query = raw.query.bind(raw);
        const commit = gate();
        const submitted = [];
        raw.query = (q, ...args) => {
          const text = typeof q === 'string' ? q : q.text;
          submitted.push({ text, kind: typeof q });
          if (text === 'COMMIT') {
            native.controls.holdServer = true;
            commit.resolve();
          }
          return query(q, ...args);
        };
        let escaped;
        const pending = capture(() =>
          db.transaction(async (client) => {
            escaped = client;
            await client.query("INSERT INTO review_rows VALUES(7,'legacy committed before timeout')");
          }),
        );
        try {
          await bound(commit.promise, 'legacy COMMIT not sent');
          await waitFor(
            async () => !!(await native.admin.query('SELECT id FROM review_rows WHERE id=7')).rows.length,
            'legacy server did not commit',
          );
          assert.ok(await bound(pending, 'legacy read-timeout did not settle'));
          const err = await capture(() => escaped.query('SELECT 1'));
          assert.match(err.message, /unknown outcome/);
          assert.ok(submitted.some((s) => s.text === 'COMMIT' && s.kind === 'string'));
          assert.ok(!submitted.some((s) => s.text === 'ROLLBACK'));
          report.observations.push({ case: 'legacy-string-commit-control', submitted, escaped: err.message });
        } finally {
          native.controls.release();
        }
      } finally {
        if (db) await db.disconnect();
        await pool.end();
      }
    },
  );
  await check('class prototype getter admission is compared with valid ordinary object controls', async () => {
    const plain = await own();
    assert.deepEqual((await plain.rawQuery('SELECT 53 AS n')).rows, [{ n: 53 }]);
    class GetterOptions {
      get sessionMode() {
        return 'persistent';
      }
      get lifetime() {
        return 'persistent';
      }
      get warnOnUnlimited() {
        return false;
      }
    }
    const errors = [];
    let getterDb;
    try {
      getterDb = await turbineNeonWs(
        { connection: native.connection, driver: native.driver },
        empty,
        new GetterOptions(),
      );
      cleanups.push(() => getterDb.disconnect());
      await getterDb.rawQuery('SELECT 53 AS n');
    } catch (e) {
      errors.push({ container: 'options', code: e.code, message: e.message });
    }
    class GetterConnection {
      get connectionString() {
        return native.connection.connectionString;
      }
      get max() {
        return 1;
      }
      get connectionTimeoutMillis() {
        return 500;
      }
    }
    let connDb;
    try {
      connDb = await turbineNeonWs({ connection: new GetterConnection(), driver: native.driver }, empty, opts);
      await connDb.rawQuery('SELECT 54 AS n');
      cleanups.push(() => connDb.disconnect());
    } catch (e) {
      errors.push({ container: 'connection', code: e.code, message: e.message });
      if (connDb) {
        const cleanup = await capture(() =>
          bound(connDb.disconnect(), 'disconnect never settles after synchronous connect rejection', 500),
        );
        if (cleanup)
          report.findings.push({
            id: 'synchronous-connect-cleanup-hang',
            message: cleanup.message,
            connecting: connDb.pool.connecting.size,
            rawPoolClients: connDb.pool._clients.length,
            active: connDb.pool.active.size,
          });
      }
    }
    assert.deepEqual(errors, []);
    assert.equal(getterDb.pool.connecting.size, 0);
    assert.equal(connDb.pool.connecting.size, 0);
  });
  await check('non-Error signal reason identity is tested on an already running operation', async () => {
    const ctl = new AbortController();
    const db = await own({ signal: ctl.signal });
    const pid = (await db.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const reason = { marker: 'structured abort reason' };
    const pending = capture(() => db.rawQuery('SELECT pg_sleep(30)'));
    await waitFor(
      async () =>
        !!(await native.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid])).rows
          .length,
      'sleep not running',
    );
    ctl.abort(reason);
    const err = await pending;
    await db.disconnect();
    assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
    report.observations.push({
      case: 'non-error-signal',
      sameReason: err === reason,
      error: { code: err?.code, message: err?.message },
      reason,
    });
    assert.equal(err, reason);
    assert.equal(db.pool.pendingStops.size, 0);
    assert.equal(db.pool.observers.size, 0);
  });
  await check(
    'lost ROLLBACK acknowledgement preserves original callback failure and unknown escaped state/log',
    async () => {
      const ctl = new AbortController();
      const logs = [];
      const db = await own({
        signal: ctl.signal,
        logging: true,
        logger: { debug: (message, e) => logs.push({ message, ...e }) },
      });
      await db.rawQuery('SELECT 1');
      const raw = db.pool._clients[0];
      const query = raw.query.bind(raw);
      const sent = gate();
      raw.query = (q, ...args) => {
        if ((typeof q === 'string' ? q : q.text) === 'ROLLBACK') {
          native.controls.holdServer = true;
          sent.resolve();
        }
        return query(q, ...args);
      };
      let escaped;
      const marker = new Error('BODY_PRIMARY_WITH_LOST_ROLLBACK_ACK');
      const p = capture(() =>
        db.$transaction(async (tx) => {
          escaped = tx;
          await tx.raw`INSERT INTO review_rows VALUES(5,'undo ack held')`;
          throw marker;
        }),
      );
      try {
        await bound(sent.promise, 'ROLLBACK not sent');
        await waitFor(() => native.controls.held.length > 0, 'ROLLBACK ack not held');
        ctl.abort(new Error('SECONDARY_ABORT'));
        assert.equal(await p, marker);
        assert.match((await capture(() => escaped.raw`SELECT 1`)).message, /unknown outcome/);
        assert.equal(logs.filter((e) => e.code === 'transaction-outcome-unknown').length, 1);
        assert.equal(logs.filter((e) => e.code === 'transaction-rolled-back').length, 0);
        await db.disconnect();
      } finally {
        native.controls.release();
      }
      assert.deepEqual((await native.admin.query('SELECT id FROM review_rows WHERE id=5')).rows, []);
    },
  );

  await check(
    'later queued native ROLLBACK cannot certify a prior timed-out COMMIT for either query form',
    async () => {
      for (const [form, id] of [
        ['string', 8],
        ['config', 9],
      ]) {
        const pool = new neon.Pool({ ...native.connection, max: 1, query_timeout: 250 });
        const Base = neon.Client;
        pool.Client = class extends Base {
          constructor(c) {
            super(c);
            Object.assign(this.neonConfig, native.driver);
          }
        };
        pool.on('error', () => {});
        let db, lease;
        try {
          db = await own({}, { pool });
          lease = await db.pool.connect();
          const q = (text) => (form === 'string' ? text : { text, types: { getTypeParser: neon.types.getTypeParser } });
          await lease.query(q('BEGIN'));
          await lease.query(q(`INSERT INTO review_rows VALUES(${id},'queued rollback after commit')`));
          native.controls.holdServer = true;
          const committing = capture(() => lease.query(q('COMMIT')));
          await waitFor(
            async () => !!(await native.admin.query('SELECT id FROM review_rows WHERE id=$1', [id])).rows.length,
            'server did not commit queued control',
          );
          assert.equal((await bound(committing, 'native COMMIT did not time out')).message, 'Query read timeout');
          const rollback = lease.query(q('ROLLBACK'));
          native.controls.release();
          assert.equal((await bound(rollback, 'queued native ROLLBACK acknowledgement hung')).command, 'ROLLBACK');
          let recoverySent = false;
          assert.equal(
            await lease.transactionRecovery.rollback(
              false,
              async () => {
                recoverySent = true;
              },
              100,
            ),
            false,
          );
          assert.equal(recoverySent, false);
          assert.deepEqual((await native.admin.query('SELECT id FROM review_rows WHERE id=$1', [id])).rows, [{ id }]);
          report.observations.push({
            case: 'queued-rollback-cannot-certify-commit',
            form,
            serverCommitted: true,
            laterRollbackTag: 'ROLLBACK',
            recoveryConfirmed: false,
          });
        } finally {
          native.controls.release();
          lease?.release(true);
          if (db) await db.disconnect();
          await pool.end();
        }
      }
    },
  );
  await check('effective accessor snapshot reads once and survives mutation in factory and invocation', async () => {
    const ctl = new AbortController();
    const reads = {};
    let mode = 'persistent';
    let url = native.connection.connectionString;
    let prepared = false;
    const read = (k, v) => {
      reads[k] = (reads[k] || 0) + 1;
      return v;
    };
    const logger = { debug() {} };
    class Unrelated {
      get diagnostic() {
        throw new Error('unrelated inherited getter must not be read');
      }
    }
    class Options extends Unrelated {
      get sessionMode() {
        return read('sessionMode', mode);
      }
      get lifetime() {
        return read('lifetime', 'persistent');
      }
      get preparedStatements() {
        return read('preparedStatements', prepared);
      }
      get signal() {
        return read('signal', ctl.signal);
      }
      get logger() {
        return read('logger', logger);
      }
      get warnOnUnlimited() {
        return read('warnOnUnlimited', false);
      }
    }
    class Connection extends Unrelated {
      get connectionString() {
        return read('connectionString', url);
      }
      get max() {
        return read('max', 1);
      }
      get connectionTimeoutMillis() {
        return read('connectionTimeoutMillis', 1000);
      }
    }
    class Settings extends Unrelated {
      get webSocketConstructor() {
        return read('webSocketConstructor', native.driver.webSocketConstructor);
      }
      get wsProxy() {
        return read('wsProxy', native.driver.wsProxy);
      }
      get useSecureWebSocket() {
        return read('useSecureWebSocket', false);
      }
      get pipelineConnect() {
        return read('pipelineConnect', false);
      }
    }
    const suppliedOptions = new Options();
    suppliedOptions.futureOwnOption = 'preserved';
    Object.defineProperty(suppliedOptions, 'unusedPrivate', {
      get() {
        throw new Error('unrelated non-enumerable own getter must not be read');
      },
    });
    const promise = turbineNeonWs({ connection: new Connection(), driver: new Settings() }, empty, suppliedOptions);
    mode = 'transaction';
    url = 'postgresql:///';
    prepared = true;
    const db = await promise;
    cleanups.push(() => db.disconnect());
    assert.equal(db.wsOptions.sessionMode, 'persistent');
    assert.equal(db.wsOptions.futureOwnOption, 'preserved');
    assert.equal(db.wsOptions.preparedStatements, false);
    assert.equal(db.wsOptions.logger, logger);
    assert.equal(db.wsOptions.signal, ctl.signal);
    assert.deepEqual((await db.rawQuery('SELECT 71 AS n')).rows, [{ n: 71 }]);
    assert.ok(Object.values(reads).every((n) => n === 1));
    await db.disconnect();
    assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
    mode = 'transaction';
    prepared = true;
    const validation = await capture(() =>
      turbineNeonWs({ connection: native.connection, driver: native.driver }, empty, new Options()),
    );
    assert.equal(validation.code, 'TURBINE_E017');
    mode = 'persistent';
    prepared = false;
    url = native.connection.connectionString;
    const result = await withNeonWs(
      { connection: new Connection(), driver: new Settings() },
      empty,
      new Options(),
      async (db) => {
        assert.equal(db.wsOptions.lifetime, 'invocation');
        return (await db.rawQuery('SELECT 72 AS n')).rows;
      },
    );
    assert.deepEqual(result, [{ n: 72 }]);
    const invalid = await capture(() => turbineNeonWs({ connection: native.connection, pool: {} }, empty, opts));
    assert.match(invalid.message, /exactly one/);
    assert.match((await capture(() => turbineNeonWs({ pool: {} }, empty, opts))).message, /actual.*Pool/);
    assert.match((await capture(() => turbineNeonWs({ client: {} }, empty, opts))).message, /actual.*Client/);
    report.observations.push({
      case: 'effective-accessors',
      firstSnapshotSingleRead: true,
      reads,
      loggerIdentity: true,
      signalIdentity: true,
    });
  });
  await check(
    'synchronous actual Neon rejection settles connect promise and callback exactly once and clears tracking',
    async () => {
      assert.equal(process.env.PGHOST, undefined, 'synchronous native config control needs no PGHOST override');
      const ctl = new AbortController();
      const db = await own(
        { signal: ctl.signal },
        { connection: { connectionTimeoutMillis: 10000 }, driver: native.driver },
      );
      for (let i = 0; i < 3; i++) {
        const e = await bound(
          capture(() => db.rawQuery('SELECT 1')),
          'actual synchronous connect failure hung',
        );
        assert.match(e.message, /No database host or connection string/);
        assert.equal(db.pool.connecting.size, 0);
        assert.equal(db.pool._clients.length, 0);
        assert.equal(db.pool.pendingStops.size, 0);
      }
      const Client = db.pool.pool.Client;
      const direct = new Client({});
      let callbacks = 0;
      let error;
      await bound(
        new Promise((resolve) =>
          direct.connect((e) => {
            callbacks++;
            error = e;
            resolve();
          }),
        ),
        'synchronous connect callback hung',
      );
      assert.match(error.message, /No database host/);
      await delay(20);
      assert.equal(callbacks, 1);
      assert.equal(db.pool.connecting.size, 0);
      await direct.end();
      const promiseClient = new Client({});
      const e = await capture(() => promiseClient.connect());
      assert.match(e.message, /No database host/);
      assert.equal(db.pool.connecting.size, 0);
      await promiseClient.end();
      await bound(db.disconnect(), 'disconnect after synchronous throw hung');
      assert.equal(db.pool.closingClients.size, 0);
      assert.equal(db.pool.pool.listenerCount('error'), 0);
      assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
      const invocation = await bound(
        capture(() =>
          withNeonWs({ connection: {}, driver: native.driver }, empty, opts, (db) => db.rawQuery('SELECT 1')),
        ),
        'invocation cleanup after sync throw hung',
      );
      assert.match(invocation.message, /No database host/);
      report.observations.push({
        case: 'synchronous-native-connect',
        attempts: 3,
        callbackCount: callbacks,
        connecting: 0,
        rawPoolClients: 0,
        promiseAndInvocationSettled: true,
      });
    },
  );
  await check(
    'query configs preserve identity, per-query parsers and values through both COMMIT command tags',
    async () => {
      const db = await own();
      const lease = await db.pool.connect();
      const raw = db.pool._clients[0];
      const query = raw.query.bind(raw);
      const seen = [];
      raw.query = (q, v) => {
        seen.push({ q, v });
        return query(q, v);
      };
      const types = { getTypeParser: () => (text) => `owned:${text}` };
      const values = [91];
      const config = { text: 'SELECT $1::int4 AS n', values, types };
      assert.deepEqual((await lease.query(config)).rows, [{ n: 'owned:91' }]);
      assert.equal(seen.at(-1).q, config);
      assert.equal(seen.at(-1).q.types, types);
      assert.equal(seen.at(-1).q.values, values);
      for (const form of ['string', 'config']) {
        const q = (text) => (form === 'string' ? text : { text, types });
        await lease.query(q('BEGIN'));
        await lease.query(q('SELECT 1/0')).catch(() => {});
        const commit = q('COMMIT');
        assert.equal((await lease.query(commit)).command, 'ROLLBACK');
        assert.equal(seen.at(-1).q, commit);
        assert.equal(
          await lease.transactionRecovery.rollback(false, async () => lease.query(q('ROLLBACK')), 100),
          true,
        );
      }
      lease.release();
      await db.disconnect();
      report.observations.push({
        case: 'query-config-identity',
        sameConfig: true,
        sameParsers: true,
        sameValues: true,
        forms: ['string', 'config'],
      });
    },
  );
  await check(
    'structured and primitive abort reasons retain identity before and during work without replacing transport errors',
    async () => {
      for (const reason of [
        { nested: { marker: 'structured' } },
        new Error('ERROR_REASON'),
        'STRING_REASON',
        0,
        false,
        null,
      ]) {
        const pre = new AbortController();
        pre.abort(reason);
        assert.equal(
          await capture(() =>
            turbineNeonWs({ connection: native.connection, driver: native.driver }, empty, {
              ...opts,
              signal: pre.signal,
            }),
          ),
          reason,
        );
        const ctl = new AbortController();
        const db = await own({ signal: ctl.signal });
        const pid = (await db.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const pending = capture(() => db.rawQuery('SELECT pg_sleep(30)'));
        await waitFor(
          async () =>
            !!(await native.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid]))
              .rows.length,
          'reason query not running',
        );
        ctl.abort(reason);
        assert.equal(await pending, reason);
        assert.equal(await capture(() => db.rawQuery('SELECT 1')), reason);
        await db.disconnect();
        assert.equal(getEventListeners(ctl.signal, 'abort').length, 0);
      }
      const ctl = new AbortController();
      const db = await own({ signal: ctl.signal });
      const pid = (await db.rawQuery('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const pending = capture(() => db.rawQuery('SELECT pg_sleep(30)'));
      await waitFor(
        async () =>
          !!(await native.admin.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='PgSleep'", [pid]))
            .rows.length,
        'transport control not running',
      );
      await native.admin.query('SELECT pg_terminate_backend($1)', [pid]);
      const err = await pending;
      assert.ok(err instanceof Error);
      assert.notEqual(err, ctl.signal.reason);
      assert.equal(ctl.signal.aborted, false);
      await db.disconnect();
    },
  );
} catch (e) {
  report.error = { message: e.message, stack: e.stack };
  console.error(e);
  process.exitCode = 1;
} finally {
  native.controls.release();
  for (const fn of cleanups.reverse()) {
    try {
      await bound(fn(), 'cleanup timeout');
    } catch (e) {
      report.cleanupError = e.message;
      process.exitCode = 1;
    }
  }
  await native.close();
  report.checkCount = report.checks.length;
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}
