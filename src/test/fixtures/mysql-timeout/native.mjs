import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const consumer = process.env.CONSUMER,
  require = createRequire(`${consumer}/package.json`),
  format = process.env.FORMAT;
const manifest = JSON.parse(readFileSync(`${consumer}/node_modules/turbine-orm/package.json`));
const target = manifest.exports['./mysql'][format === 'cjs' ? 'require' : 'import'].default;
const resolved = `${consumer}/node_modules/turbine-orm/${target.slice(2)}`;
const api = format === 'cjs' ? require(resolved) : await import(pathToFileURL(resolved));
const mysql = require('mysql2/promise'),
  events = [],
  result = {
    success: false,
    format,
    runtime: process.version,
    execPath: process.execPath,
    resolved,
    driver: JSON.parse(readFileSync(`${consumer}/node_modules/mysql2/package.json`)).version,
    cases: [],
    events,
  };
assert.equal(result.driver, '3.24.6');
assert(['v22.16.0', 'v24.10.0'].includes(process.version));
const u = new URL(process.env.MYSQL_URL),
  config = {
    host: u.hostname,
    port: Number(u.port),
    user: 'root',
    database: u.pathname.slice(1),
    namedPlaceholders: true,
    connectionLimit: 1,
    connectTimeout: 1000,
  };
const pool = mysql.createPool(config),
  observer = await mysql.createConnection({ ...config }),
  blocker = await mysql.createConnection({ ...config });
const showError = (e) =>
  e === undefined
    ? { kind: 'undefined' }
    : e === null
      ? { kind: 'null' }
      : typeof e !== 'object'
        ? { kind: typeof e, value: e }
        : {
            kind: 'object',
            constructor: e.constructor?.name,
            name: e.name,
            code: e.code,
            outcome: e.outcome,
            message: e.message,
            cause:
              e.cause === undefined ? null : { name: e.cause?.name, code: e.cause?.code, message: e.cause?.message },
          };
const now = () => Number(process.hrtime.bigint() / 1000000n);
const record = (kind, data = {}) => events.push({ kind, ...data, at: now() });
const originalGet = pool.getConnection.bind(pool);
const connections = new Map();
let fault;
pool.getConnection = async (...args) => {
  const conn = await originalGet(...args),
    raw = conn.connection,
    id = raw.threadId;
  if (!connections.has(id)) {
    connections.set(id, raw);
    for (const name of ['destroy', 'release']) {
      const f = raw[name].bind(raw);
      raw[name] = (...a) => {
        record(`native-${name}`, { id });
        return f(...a);
      };
    }
  }
  for (const name of ['query', 'execute']) {
    const f = conn[name].bind(conn);
    conn[name] = (...args) => {
      const sql = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
      record('dispatch', { id, name, sql });
      const selected = fault?.sql === sql ? fault : undefined;
      const rawPromise = selected?.before ? Promise.reject(selected.reason) : f(...args);
      const p =
        selected && !selected.before
          ? rawPromise.then(async (value) => {
              record('hidden-native-ack', { id, sql, value });
              if (selected.hold) await selected.hold.promise;
              if (selected.after) throw selected.reason;
              return value;
            })
          : rawPromise;
      p.then(
        (value) => record('settled', { id, name, sql, value }),
        (error) => record('rejected', { id, name, sql, error: showError(error) }),
      );
      return p;
    };
  }
  record('acquire', { id });
  return conn;
};
const flags = () =>
  JSON.stringify(Object.fromEntries(Object.entries(pool.pool.config.connectionConfig).filter(([k]) => k !== 'pool')));
const flagsBefore = flags();
const rows = async () => (await observer.query('SELECT id,n,label FROM lifecycle_items ORDER BY id'))[0];
async function inspect(id) {
  const [sessions] = await observer.query(
    'SELECT ID,COMMAND,STATE,INFO FROM information_schema.PROCESSLIST WHERE ID=?',
    [id],
  );
  const [transactions] = await observer.query(
    'SELECT trx_mysql_thread_id,trx_state,trx_query,trx_rows_modified,trx_rows_locked FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id=?',
    [id],
  );
  const [waits] = await observer.query(
    'SELECT t.PROCESSLIST_ID AS waiter,b.PROCESSLIST_ID AS blocker,w.REQUESTING_ENGINE_TRANSACTION_ID AS requesting,w.BLOCKING_ENGINE_TRANSACTION_ID AS blocking FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON w.REQUESTING_THREAD_ID=t.THREAD_ID JOIN performance_schema.threads b ON w.BLOCKING_THREAD_ID=b.THREAD_ID WHERE t.PROCESSLIST_ID=?',
    [id],
  );
  return { sessions, transactions, waits };
}
async function until(fn, label, ms = 2500) {
  const end = now() + ms;
  while (now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(15);
  }
  throw Error(`barrier failed: ${label}`);
}
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { resolve, promise };
};
let db;
try {
  result.facts = (
    await observer.query(
      'SELECT VERSION() AS version,@@sql_mode AS mode,@@server_uuid AS uuid,CONNECTION_ID() AS observerId,@@innodb_lock_wait_timeout AS lockWait,@@autocommit AS autocommit',
    )
  )[0];
  result.blockerId = (await blocker.query('SELECT CONNECTION_ID() AS id'))[0][0].id;
  assert.match(result.facts[0].version, /^8\.4\./);
  await observer.query(
    'CREATE TABLE lifecycle_items(id INT PRIMARY KEY,n INT NOT NULL,label VARCHAR(32) NOT NULL) ENGINE=InnoDB',
  );
  await observer.query("INSERT INTO lifecycle_items VALUES (1,0,'one'),(2,0,'two'),(3,0,'three')");
  const shim = new api.MysqlPool(pool),
    schema = await api.introspectMysqlWith(async (s, p) => (await shim.query(s, p)).rows, config.database);
  const options = { logging: true, logger: { debug: (message, entry) => record('log', { message, entry }) } };
  if (process.env.EXPECT_RECOVERY === '1') {
    const p = `${consumer}/${format}/compiled/generated/index.js`;
    const generated = format === 'cjs' ? require(p) : await import(pathToFileURL(p));
    db = await generated.turbine(shim, options);
    result.generatedFactory = p;
  } else db = await api.turbineMysql(shim, schema, options);
  // A settled statement followed by an idle callback has an observable rollback acknowledgement.
  {
    const release = gate();
    let late;
    const before = await rows();
    const start = events.length;
    const pending = db.$transaction(
      async (tx) => {
        await tx.rawUnsafe('UPDATE lifecycle_items SET n=11 WHERE id=1');
        await release.promise;
        try {
          await tx.rawUnsafe('UPDATE lifecycle_items SET n=999 WHERE id=1');
        } catch (e) {
          late = e;
        }
      },
      { timeout: 400 },
    );
    const error = await pending.then(
      () => {
        throw Error('idle timeout resolved');
      },
      (e) => e,
    );
    record('public-rejection', { case: 'idle', error: showError(error) });
    if (process.env.EXPECT_RECOVERY === '1') {
      assert.equal(error.outcome, 'not-executed');
      assert.doesNotMatch(error.message, /cancelled/);
    }
    release.resolve();
    await until(() => late, 'late idle callback refusal');
    assert.equal(late.code, 'TURBINE_E003');
    assert.deepEqual(await rows(), before);
    result.cases.push({
      name: 'idle',
      before,
      after: await rows(),
      error: showError(error),
      late: showError(late),
      events: events.slice(start),
    });
  }
  // Preserve every falsy rejection by identity, with acknowledged idle ROLLBACK.
  for (const reason of [undefined, null, false, 0, '']) {
    let observed = Symbol();
    try {
      await db.$transaction(async (tx) => {
        await tx.rawUnsafe('UPDATE lifecycle_items SET n=22 WHERE id=1');
        throw reason;
      });
    } catch (e) {
      observed = e;
    }
    assert.equal(observed, reason);
    assert.equal((await rows())[0].n, 0);
    result.cases.push({ name: 'falsy', reason: showError(reason), identity: true, after: await rows() });
  }
  for (const scenario of ['awaited', 'suppressed', 'unawaited']) {
    const before = await rows(),
      start = events.length;
    await blocker.query('START TRANSACTION');
    await blocker.query('SELECT id FROM lifecycle_items WHERE id=2 FOR UPDATE');
    let nativeWork,
      bodyDone = false,
      leaked;
    const ready = gate(),
      exit = gate();
    const pending = db.$transaction(
      async (tx) => {
        leaked = tx;
        await tx.rawUnsafe('UPDATE lifecycle_items SET n=31 WHERE id=1');
        nativeWork = tx.rawUnsafe('UPDATE lifecycle_items SET n=32 WHERE id=2');
        nativeWork.then(
          () => {
            bodyDone = true;
          },
          () => {
            bodyDone = true;
          },
        );
        ready.resolve();
        if (scenario === 'unawaited') {
          await exit.promise;
          return 'unawaited';
        }
        if (scenario === 'suppressed') {
          try {
            await nativeWork;
          } catch {}
          return 'suppressed';
        }
        await nativeWork;
        return 'awaited';
      },
      { timeout: 700 },
    );
    await ready.promise;
    const id = events.slice(start).find((e) => e.kind === 'acquire').id;
    const waiting = await until(async () => {
      const s = await inspect(id);
      return s.waits.length ? s : null;
    }, 'owned row-lock wait');
    if (scenario === 'unawaited') exit.resolve();
    const error = await pending.then(
      (v) => ({ unexpectedSuccess: v }),
      (e) => e,
    );
    record('public-rejection', { case: scenario, error: showError(error) });
    const atRejection = await inspect(id),
      settledAtRejection = bodyDone;
    assert(atRejection.waits.length > 0);
    assert.equal(settledAtRejection, false);
    if (process.env.EXPECT_RECOVERY === '1') {
      if (scenario !== 'unawaited') assert.equal(error.outcome, 'unknown');
      assert(events.slice(start).some((e) => e.kind === 'log' && e.entry.code === 'transaction-outcome-unknown'));
      assert(!events.slice(start).some((e) => e.kind === 'log' && e.entry.code === 'transaction-rolled-back'));
    }
    let late;
    try {
      await leaked.rawUnsafe('UPDATE lifecycle_items SET n=999 WHERE id=3');
    } catch (e) {
      late = e;
    }
    assert.equal(late?.code, 'TURBINE_E003');
    // Reuse the same caller pool before the original blocker is released.
    const reuse = await db.$transaction(async (tx) => {
      const [r] = await tx.rawUnsafe('SELECT CONNECTION_ID() AS id');
      await tx.rawUnsafe('UPDATE lifecycle_items SET n=n+1 WHERE id=3');
      return r.id;
    });
    const beforeRelease = await rows();
    record('blocker-normal-commit', { scenario });
    await blocker.query('COMMIT');
    let serverGone,
      observations = [];
    for (let i = 0; i < 40; i++) {
      const s = await inspect(id);
      observations.push(s);
      if (!s.transactions.length && !s.sessions.length) {
        serverGone = s;
        break;
      }
      await delay(50);
    }
    const serverAfterBound = await inspect(id);
    record('server-after-bound', { id, state: serverAfterBound });
    await delay(50);
    const after = await rows();
    assert.equal(after[0].n, 0);
    assert.equal(after[1].n, 0);
    assert.equal(after[2].n, before[2].n + 1);
    assert.notEqual(reuse, id);
    assert.equal(flags(), flagsBefore);
    result.cases.push({
      name: scenario,
      id,
      before,
      waiting,
      error: showError(error),
      atRejection,
      settledAtRejection,
      late: showError(late),
      reuseId: reuse,
      beforeRelease,
      serverGone: serverGone ?? null,
      serverAfterBound,
      observations,
      nativeSettledAfterRelease: bodyDone,
      after,
      events: events.slice(start),
    });
  }
  // Current write/reselect and pipeline outputs and sequencing.
  {
    const items = db.table('lifecycle_items'),
      start = events.length;
    const [created, updated] = await db.pipeline([
      items.buildCreate({ data: { id: 4, n: 4, label: 'four' } }),
      items.buildUpdate({ where: { id: 4 }, data: { n: 5 } }),
    ]);
    assert.deepEqual(created, { id: 4, n: 4, label: 'four' });
    assert.deepEqual(updated, { id: 4, n: 5, label: 'four' });
    const batch = await db.$transaction([items.buildUpdate({ where: { id: 4 }, data: { n: 6 } })]);
    assert.deepEqual(batch, [{ id: 4, n: 6, label: 'four' }]);
    result.cases.push({
      name: 'pipeline-reselect',
      created,
      updated,
      batch,
      after: await rows(),
      events: events.slice(start),
    });
  }
  if (process.env.EXPECT_RECOVERY === '1') {
    for (const kind of ['rollback-refusal', 'commit-response-loss', 'rollback-response-delay']) {
      const start = events.length,
        before = await rows(),
        primary = new Error('callback-primary-marker'),
        wire = new Error('driver-response-marker'),
        hold = gate();
      fault =
        kind === 'commit-response-loss'
          ? { sql: 'COMMIT', reason: wire, after: true }
          : kind === 'rollback-refusal'
            ? { sql: 'ROLLBACK', reason: wire, before: true }
            : { sql: 'ROLLBACK', hold };
      const pending = db.$transaction(
        async (tx) => {
          await tx.rawUnsafe('UPDATE lifecycle_items SET n=51 WHERE id=1');
          if (kind === 'rollback-refusal') throw primary;
          if (kind === 'rollback-response-delay') await new Promise((resolve) => setTimeout(resolve, 120));
        },
        { timeout: kind === 'rollback-response-delay' ? 40 : 0 },
      );
      const escaped = await pending.then(
        (value) => ({ unexpectedSuccess: value }),
        (error) => error,
      );
      record('fault-public-rejection', { kind, error: showError(escaped) });
      fault = undefined;
      if (kind === 'commit-response-loss') assert.equal(escaped, wire);
      else if (kind === 'rollback-refusal') assert.equal(escaped, primary);
      else {
        assert.equal(escaped.code, 'TURBINE_E002');
        assert.equal(escaped.outcome, 'unknown');
        hold.resolve();
      }
      assert(events.slice(start).some((e) => e.kind === 'log' && e.entry.code === 'transaction-outcome-unknown'));
      assert(!events.slice(start).some((e) => e.kind === 'log' && e.entry.code === 'transaction-rolled-back'));
      if (kind === 'commit-response-loss')
        assert(!events.slice(start).some((e) => e.kind === 'dispatch' && e.sql === 'ROLLBACK'));
      // Acquire the changed row independently to prove no old transaction still owns its lock.
      await until(async () => {
        try {
          await blocker.query('START TRANSACTION');
          await blocker.query('SELECT id FROM lifecycle_items WHERE id=1 FOR UPDATE NOWAIT');
          await blocker.query('ROLLBACK');
          return true;
        } catch (e) {
          await blocker.query('ROLLBACK');
          if (e.errno !== 3572) throw e;
          return false;
        }
      }, 'fault lock reclamation');
      const after = await rows();
      assert.equal(after[0].n, kind === 'commit-response-loss' ? 51 : 0);
      const alive = await db.$transaction(async (tx) => (await tx.rawUnsafe('SELECT 19 AS alive'))[0]);
      assert.deepEqual(alive, { alive: 19 });
      result.cases.push({
        name: kind,
        before,
        after,
        error: showError(escaped),
        identity:
          kind === 'rollback-refusal' ? escaped === primary : kind === 'commit-response-loss' ? escaped === wire : null,
        events: events.slice(start),
        alive,
      });
      await observer.query('UPDATE lifecycle_items SET n=0 WHERE id=1');
    }
  }
  await db.disconnect();
  assert.equal(flags(), flagsBefore);
  result.callerQuery = (await pool.query('SELECT 17 AS alive'))[0];
  assert.deepEqual(result.callerQuery, [{ alive: 17 }]);
  result.callerPoolSurvived = true;
  result.settingsUnchanged = true;
  result.success = true;
} catch (e) {
  result.failure = showError(e);
  throw e;
} finally {
  try {
    await blocker.query('ROLLBACK');
  } catch {}
  await Promise.all([pool.end(), observer.end(), blocker.end()]);
  result.connectionsClosed = true;
  writeFileSync(process.env.REPORT, `${JSON.stringify(result, null, 2)}\n`);
}
