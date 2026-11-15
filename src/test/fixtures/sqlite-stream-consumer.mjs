// Run from an installed package consumer: node sqlite-stream-consumer.mjs esm|cjs.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const mode = process.argv[2];
assert.ok(['esm', 'cjs'].includes(mode));
const load = (name) => (mode === 'cjs' ? createRequire(import.meta.url)(name) : import(name));
const { defineSchema, schemaDefToMetadata } = await load('turbine-orm');
const { turbineSqlite } = await load('turbine-orm/sqlite');
const schema = schemaDefToMetadata(
  defineSchema({
    items: {
      id: { type: 'integer', primaryKey: true },
      enabled: { type: 'boolean' },
      prefs: { type: 'json' },
      createdAt: { type: 'timestamp' },
      wide: { type: 'bigint' },
    },
  }),
);
const raw = new DatabaseSync(':memory:');
raw.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, enabled INTEGER, prefs TEXT, created_at TIMESTAMP, wide INTEGER);
  WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<1205)
  INSERT INTO items SELECT id,id%2,json_object('id',id),'2024-02-03 04:05:06',9007199254740993 FROM n;`);
const prepare = raw.prepare.bind(raw);
let steps = 0,
  arrays = 0,
  returns = 0,
  allCalls = 0,
  failAt = 0;
raw.function('observe', (id) => {
  if (Number(id) === failAt) throw new Error('packed native step failure');
  return id;
});
raw.prepare = (sql) => {
  const stmt = prepare(sql);
  if (/\bFROM\s+"?items"?\b/i.test(sql)) {
    stmt.all = () => {
      allCalls++;
      throw new Error('packed stream must not materialize');
    };
    const iterate = stmt.iterate.bind(stmt);
    stmt.iterate = (...args) => {
      const iterator = iterate(...args);
      const next = iterator.next.bind(iterator),
        close = iterator.return.bind(iterator);
      iterator.next = () => {
        const step = next();
        if (!step.done) {
          steps++;
          if (Array.isArray(step.value)) arrays++;
        }
        return step;
      };
      iterator.return = () => {
        returns++;
        return close();
      };
      return iterator;
    };
  }
  return stmt;
};
const app = turbineSqlite(raw, schema, { logger: {}, warnOnUnlimited: false });
const expected = (id) => ({
  id,
  enabled: id % 2 === 1,
  prefs: { id },
  createdAt: new Date('2024-02-03T04:05:06Z'),
  wide: '9007199254740993',
});
let checkedRows = 0;
try {
  let id = 0;
  const lengths = [];
  for await (const batch of app.table('items').findManyStreamBatches({ batchSize: 1001, orderBy: { id: 'asc' } })) {
    lengths.push(batch.length);
    for (const row of batch) {
      assert.deepEqual(row, expected(++id));
      checkedRows++;
    }
  }
  assert.equal(id, 1205);
  assert.deepEqual(lengths, [1001, 204]);
  assert.equal(steps, 1205);
  assert.equal(arrays, 1204);
  assert.equal(returns, 1);
  const before = steps;
  const rowStream = app.table('items').findManyStream({ batchSize: 1001, orderBy: { id: 'asc' } });
  assert.deepEqual((await rowStream.next()).value, expected(1));
  assert.equal(steps - before, 1001);
  let completed = false;
  const waiting = app.rawUnsafe('SELECT 7 AS ok').then((rows) => {
    completed = true;
    return rows;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  await rowStream.return();
  assert.deepEqual(await waiting, [{ ok: 7 }]);
  assert.equal(steps - before, 1001, 'return must not drain');
  const controller = new AbortController(),
    reason = new Error('packed abort');
  const aborted = app
    .table('items')
    .findManyStreamBatches({ batchSize: 3, orderBy: { id: 'asc' }, signal: controller.signal });
  assert.equal((await aborted.next()).value.length, 3);
  const beforeAbort = steps;
  controller.abort(reason);
  await assert.rejects(aborted.next(), (error) => error === reason);
  assert.equal(steps, beforeAbort);
  await app.$transaction(async (tx) => {
    const stream = tx.table('items').findManyStreamBatches({ batchSize: 1001, orderBy: { id: 'asc' } });
    assert.deepEqual((await stream.next()).value[0], expected(1));
    await stream.return();
    assert.equal(raw.isTransaction, true, 'stream must not finish its caller transaction');
    await tx.rawUnsafe("INSERT INTO items VALUES(1206,0,'null',NULL,NULL)");
  });
  assert.equal(raw.isTransaction, false);
  failAt = 1003;
  const client = await app.pool.connect();
  try {
    const failed = client.streamBatches('SELECT observe(id), * FROM items ORDER BY id', [], 1001);
    assert.equal((await failed.next()).value.length, 1001);
    await assert.rejects(failed.next(), /packed native step failure/);
    assert.deepEqual((await client.query('SELECT 9 AS ok')).rows, [{ ok: 9 }]);
  } finally {
    client.release();
  }
  assert.equal(allCalls, 0);
  await app.disconnect();
  assert.equal(raw.isOpen, true, 'factory must not close a borrowed native handle');
  assert.equal(prepare('SELECT count(*) AS n FROM items').get().n, 1206);
} finally {
  await app.disconnect();
  raw.close();
}
console.log(
  JSON.stringify({
    mode,
    node: process.version,
    checkedRows,
    steps,
    arrays,
    returns,
    allCalls,
    cleanup: { borrowedSurvivedDisconnect: true, handlesClosed: !raw.isOpen, transactionOpen: false },
  }),
);
