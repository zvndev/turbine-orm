import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const format = process.argv[2];
assert.ok(format === 'esm' || format === 'cjs');
const { createNotificationHub } =
  format === 'esm'
    ? await import('turbine-orm/notification-hub')
    : createRequire(import.meta.url)('turbine-orm/notification-hub');
const { default: pg } = await import('pg');
assert.ok(process.env.DATABASE_URL, 'Actual native PostgreSQL required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
const sender = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
const errors = [],
  seen = [],
  lifecycle = [];
const records = [];
let ends = 0;
const transport = {
  async connect() {
    const client = await pool.connect();
    const sql = [],
      releases = [];
    const record = { client, pid: client.processID, sql, releases };
    records.push(record);
    return {
      query: (text) => {
        sql.push(text);
        return client.query(text);
      },
      on: client.on.bind(client),
      removeListener: client.removeListener.bind(client),
      release: (error) => {
        releases.push(error);
        client.release(error);
      },
    };
  },
  async end() {
    ends++;
    await pool.end();
  },
};
const hub = createNotificationHub(transport, {
  endpoint: 'direct',
  ownership: 'owned',
  reconnect: { initialDelayMs: 100, maxDelayMs: 100 },
  onError: (e) => {
    errors.push(e);
  },
});
async function until(predicate) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await delay(5);
  }
  assert.ok(predicate(), 'packed native condition not met');
}
try {
  await sender.connect();
  const a = `packed_A_${process.pid}`,
    b = `packed_b_${process.pid}`;
  const abort = new AbortController();
  await Promise.all([
    hub.subscribe(
      a,
      (p) => {
        seen.push(`a:${p}`);
      },
      {
        onReconnect: () => {
          assert.deepEqual(records[1].sql, [`LISTEN "${a}"`, `LISTEN "${b}"`]);
          lifecycle.push('reconnect');
        },
        onResync: (reason) => {
          lifecycle.push(reason);
        },
      },
    ),
    hub.subscribe(
      a,
      (p) => {
        seen.push(`peer:${p}`);
      },
      { signal: abort.signal },
    ),
    hub.subscribe(b, (p) => {
      seen.push(`b:${p}`);
    }),
  ]);
  assert.equal(records.length, 1);
  await sender.query('BEGIN');
  await sender.query('SELECT pg_notify($1,$2)', [a, 'one']);
  await sender.query('SELECT pg_notify($1,$2)', [b, 'two']);
  assert.deepEqual(seen, []);
  await sender.query('COMMIT');
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ['a:one', 'peer:one', 'b:two']);
  await sender.query('SELECT pg_terminate_backend($1)', [records[0].pid]);
  await until(() => !hub.stats.connected);
  abort.abort();
  await sender.query('SELECT pg_notify($1,$2)', [a, 'gap']);
  await until(() => lifecycle.length === 2);
  assert.deepEqual(lifecycle, ['reconnect', 'reconnect']);
  assert.equal(records[0].releases.length, 1);
  assert.ok(records[0].releases[0] instanceof Error);
  assert.notEqual(records[0].pid, records[1].pid);
  assert.equal(errors.length, 3);
  await sender.query('SELECT pg_notify($1,$2)', [a, 'three']);
  await sender.query('SELECT pg_notify($1,$2)', [b, 'four']);
  await until(() => seen.length === 5);
  assert.deepEqual(seen.slice(3), ['a:three', 'b:four']);
  await Promise.all([hub.close(), hub.close()]);
  assert.equal(ends, 1);
  assert.equal(pool.totalCount, 0);
  assert.deepEqual(records[1].releases, [undefined]);
  assert.deepEqual(hub.stats, { channels: 0, subscriptions: 0, connected: false, reconnecting: false, closed: true });
  // Exercise handler rejection in a driver fixture separately from the native evidence above.
  const client = new EventEmitter();
  client.query = async () => ({});
  client.release = () => {};
  const fixtureErrors = [];
  const fixtureHub = createNotificationHub(
    { connect: async () => client, end: async () => {} },
    {
      endpoint: 'direct',
      onError: (error) => {
        fixtureErrors.push(error.message);
      },
    },
  );
  await fixtureHub.subscribe('fixture', async () => {
    throw new Error('observed');
  });
  client.emit('notification', { channel: 'fixture', payload: '' });
  await until(() => fixtureErrors.length === 1);
  assert.deepEqual(fixtureErrors, ['observed']);
  await fixtureHub.close();
  process.stdout.write(
    `${JSON.stringify({
      format,
      native: true,
      checks: [
        'exact fanout/order',
        'transaction commit',
        'physical disconnect',
        'restore/resync',
        'gap loss',
        'consumer cancellation',
        'owned cleanup',
      ],
      fixture: 'async callback rejection',
    })}\n`,
  );
} finally {
  await hub.close();
  await sender.end();
}
