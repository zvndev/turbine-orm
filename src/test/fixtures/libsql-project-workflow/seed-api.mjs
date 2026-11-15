/** Copied into the actual installed consumer; native ESM/CJS with no TS loader. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const format = process.argv[2];
assert.ok(['esm', 'cjs'].includes(format));
const load = (name) => (format === 'esm' ? import(name) : Promise.resolve(require(name)));
const { createClient } = await load('@libsql/client/node');
const { defineLibsqlSeed, runLibsqlSeed } = await load('turbine-orm/libsql/seed');
const { introspectLibsql } = await load('turbine-orm/libsql/introspect');
const url = pathToFileURL(join(process.cwd(), `api-${format}.sqlite`)).href;
let client = createClient({ url, intMode: 'bigint' });
try {
  await client.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
} finally {
  client.close();
}
const schema = await introspectLibsql(url);
await runLibsqlSeed(
  url,
  schema,
  defineLibsqlSeed(async (tx) => {
    await tx.raw`INSERT INTO items VALUES(1,'committed')`;
  }),
);
for (const reason of [undefined, null, false, 0]) {
  let caught = false;
  try {
    await runLibsqlSeed(url, schema, async (tx) => {
      await tx.raw`INSERT INTO items VALUES(2,'rollback')`;
      throw reason;
    });
  } catch (error) {
    caught = true;
    assert.equal(error, reason);
  }
  assert.equal(caught, true, 'Falsy callback reasons must remain rejections');
}
client = createClient({ url, intMode: 'bigint' });
try {
  assert.equal((await client.execute('SELECT COUNT(*) FROM items')).rows[0][0], 1n);
  const transaction = client.transaction.bind(client);
  client.transaction = async (...args) => {
    const tx = await transaction(...args),
      close = tx.close.bind(tx);
    tx.close = () => {
      close();
      throw undefined;
    };
    return tx;
  };
  const reason = { callback: 'preserve exact identity' };
  let caught = false;
  try {
    await runLibsqlSeed({ url, client }, schema, async (tx) => {
      await tx.raw`INSERT INTO items VALUES(3,'rollback')`;
      throw reason;
    });
  } catch (error) {
    caught = true;
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.equal(error.errors[0], reason);
    assert.equal(error.errors[1], undefined);
  }
  assert.equal(caught, true, 'Native undefined cleanup must be aggregated after callback failure');
  assert.equal(client.closed, false, 'Supplied native clients remain caller-owned');
  assert.equal((await client.execute('SELECT COUNT(*) FROM items')).rows[0][0], 1n);
} finally {
  client.close();
  assert.equal(client.closed, true);
}
console.log(
  JSON.stringify({
    format,
    native: true,
    falsyReasons: 4,
    aggregateUndefinedCleanup: true,
    reopened: true,
    rollback: true,
  }),
);
