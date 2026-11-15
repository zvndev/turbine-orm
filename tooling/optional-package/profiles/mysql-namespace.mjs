/** Run only inside a real fresh alias installation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url), expected = JSON.parse(readFileSync('expected-namespaces.json'));
const excluded = JSON.parse(readFileSync('excluded-exports.json'));
const manifest = JSON.parse(readFileSync('node_modules/turbine-orm/package.json')), results = {};
assert.deepEqual(Object.keys(manifest.exports), ['.', './mysql', './sql']);
assert.deepEqual(manifest.dependencies, { mysql2: '3.24.6' });
assert.equal(manifest.peerDependenciesMeta.pg.optional, true);
assert.equal(manifest.bin, undefined);
for (const format of ['esm', 'cjs']) {
  const load = name => format === 'esm' ? import(name) : require(name);
  results[format] = {};
  for (const [key, keys] of Object.entries(expected)) {
    const name = key === '.' ? 'turbine-orm' : `turbine-orm/${key.slice(2)}`;
    const namespace = await load(name);
    results[format][key] = Object.keys(namespace).sort();
    assert.deepEqual(results[format][key], keys);
  }
  const root = await load('turbine-orm'), engine = await load('turbine-orm/mysql');
  assert.equal(root.turbineMysql, engine.turbineMysql);
  for (const name of ['TurbineClient','TransactionClient','generate','introspect','schemaPush','schemaDiff','turbineHttp','executePipeline','turbineSqlite','turbineD1','turbineMssql','turbineLibsql']) assert.equal(Object.hasOwn(root, name), false, name);
  for (const key of excluded) {
    const name = `turbine-orm/${key.slice(2)}`;
    if (format === 'esm') await assert.rejects(() => load(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    else assert.throws(() => load(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
  const path = resolve(`node_modules/turbine-orm/dist/optional-pg.${format === 'esm' ? 'js' : 'cjs'}`);
  const pg = format === 'esm' ? (await import(pathToFileURL(path))).default : require(path);
  for (const call of [() => new pg.Pool(), () => pg.types.getTypeParser(20)]) assert.throws(call, /optional pg peer/);
}
for (const name of ['pg','pg-pool','pg-types','pgpass','better-sqlite3','mssql','@libsql/client','typescript']) assert.throws(() => require.resolve(name), { code: 'MODULE_NOT_FOUND' });
console.log(JSON.stringify({ success: true, node: process.version, results, excluded, missingPgRefused: true }));
