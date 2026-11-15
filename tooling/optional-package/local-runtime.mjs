import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const here = dirname(fileURLToPath(import.meta.url));
const [consumer, destination] = process.argv.slice(2);
assert.ok(consumer && destination, 'Usage: node local-runtime.mjs INSTALLED_CONSUMER NEW_OUTPUT');
mkdirSync(destination);
const results = [];
const require = createRequire(join(consumer, 'package.json'));
const api = require('turbine-orm');
const schema = api.schemaDefToMetadata(api.defineSchema({ items: { id: { type: 'integer', primaryKey: true }, label: { type: 'text', notNull: true } } }));
for (const format of ['esm']) {
  const entry = join(consumer, 'node_modules/turbine-orm/dist', format === 'esm' ? 'd1.js' : 'cjs/d1.js');
  const bundle = await build({
    entryPoints: [resolve(here, '../../src/test/fixtures/d1/worker.ts')],
    bundle: true, write: false, format: 'esm', platform: 'neutral', conditions: ['workerd'],
    external: ['node:async_hooks'], metafile: true,
    plugins: [{ name: 'installed-d1', setup(builder) {
      builder.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/d1\.js$/ }, () => ({ path: entry }));
    } }],
  });
  const inputs = Object.keys(bundle.metafile.inputs);
  assert.ok(inputs.some((path) => resolve(path) === entry), 'Installed D1 entry required');
  assert.ok(!inputs.some((path) => /node_modules\/(?:pg(?:-[^/]+)?|pgpass)\//.test(path)), 'No pg in worker graph');
  const script = bundle.outputFiles[0].text;
  writeFileSync(join(destination, `worker-${format}.js`), script);
  writeFileSync(join(destination, `metafile-${format}.json`), JSON.stringify(bundle.metafile, null, 2));
  const mf = new Miniflare({ modules: true, script, compatibilityDate: '2026-01-01', compatibilityFlags: ['nodejs_compat'], d1Databases: { DB: 'local-optional' }, d1Persist: false, host: '127.0.0.1', port: 57176 });
  try {
    const response = await mf.dispatchFetch('http://localhost/');
    const body = await response.text();
    assert.equal(response.status, 200, body);
    const output = JSON.parse(body);
    assert.equal(output.ok, true);
    assert.equal(output.groups, 24);
    assert.ok(output.prepares > 10 && output.batches >= 3);
    results.push({ format, node: process.version, ...output });
    // CommonJS consumers use the real D1 binding through Miniflare's Node API.
    // Workers themselves resolve the ESM export, as the preceding bundle does.
    const binding = await mf.getD1Database('DB');
    await binding.prepare('CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL UNIQUE)').run();
    const cjs = require('turbine-orm/d1').turbineD1(binding, schema);
    try {
      assert.deepEqual(await cjs.table('items').create({ data: { id: 1, label: 'one' } }), { id: 1, label: 'one' });
      await assert.rejects(() => cjs.$batch([
        cjs.table('items').buildCreate({ data: { id: 2, label: 'two' } }),
        cjs.table('items').buildCreate({ data: { id: 3, label: 'one' } }),
      ]), /TURBINE_E008/);
      assert.deepEqual(await cjs.table('items').findMany(), [{ id: 1, label: 'one' }]);
      results.push({ format: 'cjs', node: process.version, d1NativeBinding: true, atomicRollback: true });
    } finally { await cjs.disconnect(); }
    assert.equal((await binding.prepare('SELECT 1 AS alive').first()).alive, 1);
  } finally { await mf.dispose(); }
}
// The peer is installed in this consumer only; the staged package still has no pg.
const libsql = require('turbine-orm/libsql');
for (const format of ['esm', 'cjs']) {
  const mod = format === 'cjs' ? libsql : await import(require.resolve('turbine-orm/libsql').replace('/dist/cjs/', '/dist/'));
  const db = await mod.turbineLibsql(':memory:', schema);
  try {
    await db.rawUnsafe('CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL)');
    assert.deepEqual(await db.table('items').create({ data: { id: 1, label: 'one' } }), { id: 1, label: 'one' });
    await assert.rejects(() => db.$transaction(async (tx) => { await tx.table('items').update({ where: { id: 1 }, data: { label: 'no' } }); throw Error('rollback'); }), /rollback/);
    assert.deepEqual(await db.table('items').findMany(), [{ id: 1, label: 'one' }]);
    results.push({ format, node: process.version, libsql: true, rollback: true });
  } finally { await db.disconnect(); }
}
writeFileSync(join(destination, 'report.json'), JSON.stringify({ success: true, results }, null, 2));
console.log(JSON.stringify({ success: true, results }));
