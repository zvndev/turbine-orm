// Executed from the installed consumer, in each module format. No service proof.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const [format, phase] = process.argv.slice(2);
assert.ok(['esm', 'cjs'].includes(format));
const load = async (name) => format === 'esm' ? import(name) : Promise.resolve(require(name));
const { liveQuery } = await load('turbine-orm/live-query');
const { createNotificationHub } = await load('turbine-orm/notification-hub');
let invalidate, callbacks, unsubscribed = 0, count = 1;
const live = liveQuery({ query: () => ({ count }), subscribe(handler, observers) {
  invalidate = handler; callbacks = observers;
  return { unsubscribe() { unsubscribed++; } };
} });
try {
  assert.deepEqual(await live.next(), { done: false, value: { count: 1 } });
  count = 2; invalidate();
  assert.deepEqual(await live.next(), { done: false, value: { count: 2 } });
  count = 3; callbacks.onReconnect();
  assert.deepEqual(await live.next(), { done: false, value: { count: 3 } });
} finally { await live.dispose(); }
await live.dispose();
assert.equal(unsubscribed, 1);
assert.equal((await live.next()).done, true);
for (const ownership of ['external', 'owned']) {
  const client = new EventEmitter();
  const queries = []; let releases = 0, ends = 0, connects = 0;
  client.query = async (sql) => { queries.push(sql); return { rows: [] }; };
  client.release = () => { releases++; };
  const pool = { connect: async () => { connects++; return client; }, end: async () => { ends++; } };
  assert.throws(() => createNotificationHub(pool, { endpoint: 'transaction-pool' }), /NOTIFY but not LISTEN/);
  const hub = createNotificationHub(pool, { endpoint: 'direct', ownership });
  try {
    const seen = [];
    const a = await hub.subscribe('optional_gate', (payload) => { seen.push(payload); });
    const b = await hub.subscribe('optional_gate', (payload) => { seen.push(`peer:${payload}`); });
    assert.equal(connects, 1);
    client.emit('notification', { channel: 'optional_gate', payload: 'one' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(seen, ['one', 'peer:one']);
    await a.unsubscribe(); await a.unsubscribe(); await b.unsubscribe();
    assert.deepEqual(queries, ['LISTEN "optional_gate"', 'UNLISTEN *']);
  } finally { await hub.close(); }
  await hub.close();
  assert.equal(releases, 1); assert.equal(ends, ownership === 'owned' ? 1 : 0);
  assert.equal(client.listenerCount('notification'), 0);
  assert.equal(client.listenerCount('end'), 0);
}
if (phase !== 'pg-free') {
  const { TurbineClient } = await load('turbine-orm');
  assert.equal(typeof TurbineClient, 'function');
  const { turbineNeonWs } = await load('turbine-orm/neon-ws');
  const { turbineNeonHttp } = await load('turbine-orm/neon-http');
  assert.equal(typeof turbineNeonHttp, 'function');
  if (phase === 'missing-peer') {
    // A missing peer is a typed ConnectionError naming the package, and its cause is the real resolution failure.
    await assert.rejects(turbineNeonWs({ connection: { connectionString: 'postgresql://127.0.0.1:1/unused' } }, { tables: {}, enums: {} }, { sessionMode: 'persistent', lifetime: 'persistent' }), (error) => {
      assert.equal(error.code, 'TURBINE_E004');
      assert.match(error.message, /requires the optional @neondatabase\/serverless package/);
      assert.match(String(error.cause?.message), /Cannot find package|Cannot find module/);
      return true;
    });
  } else {
    const driver = await load('@neondatabase/serverless');
    assert.equal(typeof driver.Pool, 'function');
    // Factory validation must fail before opening any connection.
    await assert.rejects(turbineNeonWs({ pool: {} }, { tables: {}, enums: {} }, { sessionMode: 'persistent', lifetime: 'persistent' }), /actual @neondatabase/);
  }
} else {
  // HTTP now uses the supplied-transport core; WS retains its pg session graph.
  assert.equal(typeof (await load('turbine-orm/neon-http')).turbineNeonHttp, 'function');
  await assert.rejects(load('turbine-orm/neon-ws'), /Cannot find package 'pg'|Cannot find module 'pg'/);
  await assert.rejects(load('turbine-orm'), /Cannot find package 'pg'|Cannot find module 'pg'/);
}
console.log(JSON.stringify({ format, phase, callbackSnapshots: 3, disposed: true, hubOwnership: ['external', 'owned'], native: false }));
