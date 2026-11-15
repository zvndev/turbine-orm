/** Run only from a fresh physical alias installation. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const manifest = JSON.parse(readFileSync('node_modules/turbine-orm/package.json'));
const expected = JSON.parse(readFileSync('expected-namespaces.json'));
const excluded = JSON.parse(readFileSync('excluded-exports.json'));
const result = {};
for (const format of ['esm', 'cjs']) {
  const load = name => format === 'esm' ? import(name) : require(name);
  result[format] = {};
  for (const [entry, keys] of Object.entries(expected)) {
    const name = entry === '.' ? 'turbine-orm' : `turbine-orm/${entry.slice(2)}`;
    const path = resolve('node_modules/turbine-orm', manifest.exports[entry][format === 'esm' ? 'import' : 'require'].default);
    assert.equal(format === 'esm' ? import.meta.resolve(name) : require.resolve(name), format === 'esm' ? pathToFileURL(path).href : path);
    result[format][entry] = Object.keys(await load(name)).sort();
    assert.deepEqual(result[format][entry], keys, `${format} namespace ${entry}`);
  }
  const root = await load('turbine-orm');
  for (const name of ['TurbineClient', 'TransactionClient', 'generate', 'introspect', 'schemaPush', 'schemaDiff', 'executePipeline', 'turbineHttp', 'turbineMysql', 'turbineSqlite', 'SqlitePool', 'seedSqlite']) assert.equal(Object.hasOwn(root, name), false, name);
  for (const entry of excluded) {
    const name = `turbine-orm/${entry.slice(2)}`;
    if (format === 'esm') await assert.rejects(() => load(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    else assert.throws(() => load(name), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  }
  const path = resolve(`node_modules/turbine-orm/dist/optional-pg.${format === 'esm' ? 'js' : 'cjs'}`);
  const pg = format === 'esm' ? (await import(pathToFileURL(path))).default : require(path);
  for (const call of [() => new pg.Pool(), () => pg.types.getTypeParser(20)]) assert.throws(call, /optional pg peer/);
}
for (const peer of ['pg', 'pg-pool', 'pg-types', 'mysql2', 'mssql', '@libsql/client', 'miniflare', 'workerd', 'typescript']) assert.throws(() => require.resolve(peer), { code: 'MODULE_NOT_FOUND' });
assert.deepEqual(manifest.dependencies, { 'better-sqlite3': '12.11.1' });
assert.equal(manifest.private, true);
assert.equal(manifest.bin, undefined);
assert.equal(manifest.imports['#pg'].workerd, './dist/unavailable-pg.js');
console.log(JSON.stringify({ ok: true, node: process.version, namespaces: result, excluded, noPgCapability: true }));
