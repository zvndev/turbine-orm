import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url),
  pg = require('pg'),
  { createPool } = require('mysql2/promise');
const [format, output] = process.argv.slice(2);
const { openOrderRelay } = await import(`./${format}/examples/postgres-mysql-relay/application.js`);
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
const report = { format, node: process.version, passed: [], raw: [] },
  relays = [];
let hook = async () => {};
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
      await hook('after', sql);
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
  batchSize: 2,
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
  amount: '1.000000',
  occurredAt: '2026-11-07T12:34:56.123456Z',
  body: Buffer.from([0, 255, 128, 39, 92]),
});
async function state(tenant, relay) {
  const checkpoint =
    (
      await source.query(
        `SELECT last_position::text AS p FROM "${process.env.PG_SCHEMA}".checkpoints WHERE tenant=$1 AND consumer=$2`,
        [tenant, relay.binding],
      )
    ).rows[0]?.p ?? '0';
  const [inbox] = await target.query(
    'SELECT event_id,payload FROM inbox WHERE tenant=? AND consumer=? ORDER BY event_id',
    [tenant, relay.binding],
  );
  const [[projection]] = await target.query('SELECT delivered FROM mail_projection WHERE tenant=? AND consumer=?', [
    tenant,
    relay.binding,
  ]);
  const r = { tenant, checkpoint, inbox, delivered: projection?.delivered ?? 0 };
  report.raw.push(r);
  return r;
}
async function rejects(action) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true);
}
try {
  const relay = await open();
  await relay.initialize();
  await relay.append('callback_timeout', input(1));
  let armed = true,
    settlementReached = false,
    effectStarted = false;
  hook = async (phase, sql) => {
    if (phase === 'before' && /^INSERT INTO mail_projection/i.test(sql)) effectStarted = true;
    if (armed && effectStarted && phase === 'after' && /^COMMIT/i.test(sql)) {
      armed = false;
      await new Promise((r) => setTimeout(r, 2250));
      settlementReached = true;
    }
  };
  await rejects(() => relay.relayBatch('callback_timeout'));
  assert.equal(settlementReached, true, 'relay returned while the concrete target native promise remained owned');
  assert.equal(relay.outstandingTargets, 0);
  const before = await state('callback_timeout', relay);
  assert.equal(before.checkpoint, '0');
  assert.equal(before.delivered, 1);
  hook = async () => {};
  await relay.close();
  const reopened = await open();
  assert.equal(await reopened.relayBatch('callback_timeout'), 1);
  const after = await state('callback_timeout', reopened);
  assert.equal(after.checkpoint, '1');
  assert.equal(after.delivered, 1);
  assert.deepEqual(after.inbox, before.inbox);
  report.passed.push(
    'source whole-page callback timeout drains target settlement after committed response is delayed; reopen deduplicates',
  );

  await reopened.append('prefix', input(2));
  await reopened.append('prefix', input(3));
  let insert = 0;
  hook = async (phase, sql) => {
    if (phase === 'after' && /^INSERT INTO inbox/i.test(sql) && ++insert === 2)
      throw new Error('second target transaction rolls back');
  };
  await rejects(() => reopened.relayBatch('prefix'));
  const prefix = await state('prefix', reopened);
  assert.equal(prefix.checkpoint, '0');
  assert.equal(prefix.delivered, 1);
  assert.equal(prefix.inbox.length, 1);
  hook = async () => {};
  assert.equal(await reopened.relayBatch('prefix'), 2);
  const complete = await state('prefix', reopened);
  assert.equal(complete.checkpoint, '2');
  assert.equal(complete.delivered, 2);
  assert.equal(complete.inbox.length, 2);
  assert.deepEqual(complete.inbox[0], prefix.inbox[0]);
  report.passed.push(
    'successful target prefix repeats after source page rollback without repeating the projection effect',
  );

  for (const reason of [undefined, null, false, 0, '']) {
    const stop = new AbortController();
    // AbortController supplies its own DOMException for undefined by specification.
    const pending = reopened.reconcile('poll_abort', { maxBatches: 2, intervalMs: 200 }, stop.signal).then(
      () => ({ resolved: true }),
      (error) => ({ resolved: false, error }),
    );
    const timer = setTimeout(() => stop.abort(reason), 70);
    const result = await pending;
    clearTimeout(timer);
    assert.equal(result.resolved, false);
    assert.equal(result.error, stop.signal.reason);
  }
  report.passed.push(
    'in-flight reconciliation timer cancellation preserves the original abort reason including falsy values',
  );

  await reopened.append('close_active', input(4));
  let entered;
  const reached = new Promise((r) => {
    entered = r;
  });
  let delayed = false;
  hook = async (phase, sql) => {
    if (!delayed && phase === 'before' && /^INSERT INTO mail_projection/i.test(sql)) {
      delayed = true;
      entered();
      await new Promise((r) => setTimeout(r, 150));
    }
  };
  const pending = reopened.relayBatch('close_active').then(
    () => ({ acknowledged: true }),
    (error) => ({ acknowledged: false, error: String(error) }),
  );
  const guard = setTimeout(() => entered(), 4000);
  await reached;
  clearTimeout(guard);
  assert.equal(delayed, true);
  await reopened.close();
  assert.equal((await pending).acknowledged, false);
  assert.equal(reopened.outstandingTargets, 0);
  const final = await state('close_active', reopened);
  assert.equal(final.checkpoint, '0');
  assert.equal(final.delivered, 0);
  report.passed.push(
    'close during native target work seals admission, aborts and drains without ending either caller pool',
  );
} finally {
  await Promise.all(relays.map((r) => r.close()));
  await source.query('SELECT 1');
  await target.query('SELECT 1');
  await source.end();
  await target.end();
  report.success = report.passed.length === 4;
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ success: report.success, passed: report.passed.length, node: process.version, format }));
}
