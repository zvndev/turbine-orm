import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url),
  pg = require('pg'),
  { createPool } = require('mysql2/promise');
const [format, output] = process.argv.slice(2);
const { openOrderRelay } = await import(`./${format}/examples/postgres-mysql-relay/application.js`);
const { TurbineClient } = format === 'esm' ? await import('turbine-orm') : require('turbine-orm');
const originalDisconnect = TurbineClient.prototype.disconnect;
const source = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 600,
  query_timeout: 3000,
  statement_timeout: 2500,
});
source.on('error', () => {});
const target = createPool({
  host: '127.0.0.1',
  port: Number(process.env.MYSQL_PORT),
  user: 'root',
  database: process.env.MYSQL_DATABASE,
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
  waitForConnections: false,
  connectionLimit: 4,
  connectTimeout: 600,
});
const report = { format, node: process.version, passed: [], raw: [], closeObservations: [] },
  relays = [],
  failedClosures = new Set();
let hook = async () => {},
  failClose = false,
  closeReason;
TurbineClient.prototype.disconnect = async function (...args) {
  const result = await originalDisconnect.apply(this, args);
  if (this.dialect.name === 'mysql' && failClose) {
    failedClosures.add(this);
    report.closeObservations.push({ nativeCleanupCompletedFirst: true, reason: String(closeReason) });
    throw closeReason;
  }
  return result;
};
const get = target.getConnection.bind(target);
target.getConnection = async () => {
  const c = await get(),
    originals = {};
  for (const method of ['query', 'execute']) {
    originals[method] = c[method];
    c[method] = async (s, ...v) => {
      const sql = String(s.sql ?? s);
      await hook('before', sql);
      const result = await originals[method].call(c, s, ...v);
      await hook('after', sql, result);
      return result;
    };
  }
  const release = c.release;
  c.release = () => {
    Object.assign(c, originals);
    c.release = release;
    return release.call(c);
  };
  return c;
};
const options = {
  sourcePool: source,
  targetPool: target,
  schema: process.env.PG_SCHEMA,
  sourceHistoryId: process.env.SOURCE_HISTORY_ID,
  consumer: 'mail',
  endpoint: 'direct',
  onDiagnostic() {},
};
async function open() {
  const relay = await openOrderRelay(options);
  relays.push(relay);
  return relay;
}
const input = (n) => ({
  eventId: `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  orderId: `10000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  title: 'é雪💧',
  quantity: '9007199254740993',
  amount: '1.000',
  occurredAt: '2026-11-07T12:34:56.123456Z',
  body: Buffer.from([0, 255, 128]),
});
async function outcome(action) {
  try {
    return { resolved: true, value: await action() };
  } catch (reason) {
    return { resolved: false, reason };
  }
}
async function state(tenant, relay) {
  const checkpoint =
    (
      await source.query(
        `SELECT last_position::text AS p FROM "${process.env.PG_SCHEMA}".checkpoints WHERE tenant=$1 AND consumer=$2`,
        [tenant, relay.binding],
      )
    ).rows[0]?.p ?? '0';
  const [inbox] = await target.query('SELECT event_id,payload FROM inbox WHERE tenant=? AND consumer=?', [
    tenant,
    relay.binding,
  ]);
  const [[projection]] = await target.query('SELECT delivered FROM mail_projection WHERE tenant=? AND consumer=?', [
    tenant,
    relay.binding,
  ]);
  const raw = { tenant, checkpoint, inbox, delivered: projection?.delivered ?? 0 };
  report.raw.push(raw);
  return raw;
}
const noAck = async (tenant, relay) => {
  const raw = await state(tenant, relay);
  assert.equal(raw.checkpoint, '0');
  assert.equal(raw.delivered, 0);
  assert.deepEqual(raw.inbox, []);
};
try {
  const relay = await open();
  await relay.initialize();
  await relay.append('late_open', input(1));
  let armed = true,
    opened = false;
  hook = async (phase, sql) => {
    if (armed && phase === 'after' && /^COMMIT/i.test(sql)) {
      armed = false;
      await new Promise((r) => setTimeout(r, 2250));
      opened = true;
    }
  };
  assert.equal((await outcome(() => relay.relayBatch('late_open'))).resolved, false);
  assert.equal(opened, true, 'late startup promise must settle before return');
  assert.equal(relay.outstandingTargets, 0);
  hook = async () => {};
  await noAck('late_open', relay);
  assert.equal(await relay.relayBatch('late_open'), 1);
  report.passed.push(
    'late page-wrapper startup crosses source callback deadline and is drained/closed without delivery before retry',
  );

  for (const [i, reason] of [undefined, null, false, 0, ''].entries()) {
    const tenant = `failed_open_${i}`;
    await relay.append(tenant, input(10 + i));
    armed = true;
    hook = async (phase, sql) => {
      if (armed && phase === 'after' && /^COMMIT/i.test(sql)) {
        armed = false;
        throw reason;
      }
    };
    const result = await outcome(() => relay.relayBatch(tenant));
    assert.equal(result.resolved, false);
    assert.equal(result.reason, reason);
    assert.equal(relay.outstandingTargets, 0);
    hook = async () => {};
    await noAck(tenant, relay);
    assert.equal(await relay.relayBatch(tenant), 1);
  }
  report.passed.push(
    'failed page-wrapper startup preserves all five original falsy rejections and releases its admission slot',
  );

  await relay.append('identity', input(20));
  armed = true;
  hook = async (phase, sql, result) => {
    if (armed && phase === 'after' && sql.startsWith('SELECT @@server_uuid')) {
      armed = false;
      result[0][0].uuid = 'different-server-identity';
    }
  };
  const identity = await outcome(() => relay.relayBatch('identity'));
  assert.equal(identity.resolved, false);
  assert.match(String(identity.reason), /Target database identity changed/);
  hook = async () => {};
  await noAck('identity', relay);
  assert.equal(await relay.relayBatch('identity'), 1);
  report.passed.push(
    'page-wrapper server/database identity mismatch refuses before target effects or source acknowledgement',
  );

  const capped = await open();
  const closeFailure = new Error('injected close failure after real native cleanup');
  closeReason = closeFailure;
  failClose = true;
  for (let i = 0; i < 8; i++) {
    const tenant = `retained_${i}`,
      stop = new AbortController();
    await capped.append(tenant, input(30 + i));
    armed = true;
    hook = async (phase, sql) => {
      if (armed && phase === 'before' && /^INSERT INTO inbox/i.test(sql)) {
        armed = false;
        setTimeout(() => stop.abort(false), 20);
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    const result = await outcome(() => capped.relayBatch(tenant, stop.signal));
    assert.equal(result.resolved, false);
    assert.equal(result.reason, false, 'primary falsy cancellation must survive target close failure');
    assert.equal(capped.outstandingTargets, 0);
    assert.equal(failedClosures.size, i + 1);
    hook = async () => {};
    await noAck(tenant, capped);
  }
  failClose = false;
  await capped.append('cap_ninth', input(40));
  const ninth = await outcome(() => capped.relayBatch('cap_ninth'));
  assert.equal(ninth.resolved, false);
  assert.match(String(ninth.reason), /target wrapper cap \(8\)/);
  assert.equal(failedClosures.size, 8);
  await noAck('cap_ninth', capped);
  const closed = await outcome(() => capped.close());
  assert.equal(closed.resolved, false);
  assert.ok(closed.reason instanceof AggregateError);
  assert.equal(closed.reason.errors.length, 8);
  assert.ok(closed.reason.errors.every((e) => e === closeFailure));
  report.passed.push(
    'primary false plus failed wrapper close retains eight counted wrappers; ninth refuses and final close reports all eight',
  );

  const closeOnly = await open();
  await closeOnly.append('close_only', input(41));
  failClose = true;
  closeReason = 0;
  const result = await outcome(() => closeOnly.relayBatch('close_only'));
  assert.equal(result.resolved, false);
  assert.equal(result.reason, 0);
  failClose = false;
  const committed = await state('close_only', closeOnly);
  assert.equal(committed.checkpoint, '1');
  assert.equal(committed.delivered, 1);
  assert.equal(await closeOnly.relayBatch('close_only'), 0);
  const final = await outcome(() => closeOnly.close());
  assert.equal(final.resolved, false);
  assert.deepEqual(final.reason.errors, [0]);
  report.passed.push(
    'falsy close-only failure follows real source/target commits and retries the current checkpoint without duplicating effects',
  );
} finally {
  hook = async () => {};
  failClose = false;
  report.finalClose = (await Promise.all(relays.map((r) => outcome(() => r.close())))).map((r) => ({
    resolved: r.resolved,
    errorCount: r.reason?.errors?.length ?? 0,
  }));
  TurbineClient.prototype.disconnect = originalDisconnect;
  await source.query('SELECT 1');
  await target.query('SELECT 1');
  await source.end();
  await target.end();
  report.callersSurvived = true;
  report.success = report.passed.length === 5;
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ success: report.success, passed: report.passed.length, format, node: process.version }));
}
