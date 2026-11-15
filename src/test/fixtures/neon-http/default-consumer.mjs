// Compatibility of the actual root archive, kept separate from the HTTP bridge scope.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.NEON_HTTP_CONSUMER_ROOT;
const require = createRequire(join(root, 'package.json'));
const manifest = JSON.parse(readFileSync(join(root, 'node_modules/turbine-orm/package.json')));
assert.equal(manifest.dependencies.pg, '^8.15.0');
assert.equal(JSON.parse(readFileSync(join(root, 'node_modules/pg/package.json'))).version, '8.15.0');
const { load: esm } = await import(pathToFileURL(join(root, 'entry.mjs')).href);
const entries = Object.keys(manifest.exports).filter((entry) => entry !== './cli' && entry !== './package.json');
for (const entry of entries) {
  const specifier = entry === '.' ? 'turbine-orm' : `turbine-orm/${entry.slice(2)}`;
  require(specifier);
  await esm(specifier);
}
const pg = require('pg');
const admin = new pg.Client({ connectionString: process.env.NEON_HTTP_NATIVE_URL });
await admin.connect();
const schema = { tables: {}, enums: {} };
for (const format of ['esm', 'cjs']) {
  const { TurbineClient } = format === 'esm' ? await esm('turbine-orm') : require('turbine-orm');
  const channel = `http_default_${format}_${process.pid}`;
  const db = new TurbineClient({ connectionString: process.env.NEON_HTTP_NATIVE_URL }, schema);
  let sub;
  try {
    assert.deepEqual(await db.rawUnsafe('SELECT $1::int AS one, $2::int8 AS big', 1, '9007199254740993'), [
      { one: 1, big: '9007199254740993' },
    ]);
    await db.transaction(async (client) => {
      assert.equal(
        (await client.query("SELECT current_setting('transaction_isolation') AS level")).rows[0].level,
        'read committed',
      );
    });
    let received;
    const value = new Promise((resolve) => {
      received = resolve;
    });
    sub = await db.$listen(channel, received);
    await admin.query('SELECT pg_notify($1,$2)', [channel, 'actual-default-listen']);
    assert.equal(
      await Promise.race([
        value,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error('Native LISTEN delivery missing')), 5000);
          timer.unref();
        }),
      ]),
      'actual-default-listen',
    );
  } finally {
    await sub?.unsubscribe();
    await db.disconnect();
  }
}
await admin.end();
console.log(
  JSON.stringify({
    entries: entries.length,
    formats: ['import', 'require'],
    pg: '8.15.0',
    nativeRootReadTransactionListen: true,
    packageManifest: readFileSync(join(root, 'node_modules/turbine-orm/package.json'), 'utf8').length,
  }),
);
