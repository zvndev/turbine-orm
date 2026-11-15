import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { emittedClosure, facadeFiles, profileManifest } from './profiles/contract.mjs';
import { assertBetterSqlite3HelperImport, betterSqlite3HelperEdges, betterSqlite3Pins } from './profiles/contract.mjs';

const original = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const root = { '.': { import: { types: './dist/main.d.ts', default: './dist/main.js' }, require: { types: './dist/main.d.ts', default: './dist/main.js' } } };
const available = code => ({ 'dist/main.js': Buffer.from(code), 'dist/main.d.ts': Buffer.from('export {};') });
const manifest = { name: 'turbine-orm-better-sqlite3-runtime-stage', exports: root };

test('better-sqlite3 has the exact private dependency and public surface', () => {
  const profile = profileManifest(original, 'better-sqlite3');
  assert.equal(profile.name, manifest.name);
  assert.equal(profile.private, true);
  assert.deepEqual(profile.dependencies, { 'better-sqlite3': '12.11.1' });
  assert.deepEqual(Object.keys(profile.exports), ['.', './better-sqlite3', './sql']);
  assert.deepEqual(profile.peerDependencies, { pg: original.dependencies.pg });
  assert.deepEqual(profile.peerDependenciesMeta, { pg: { optional: true } });
  for (const key of ['bin', 'scripts', 'devDependencies']) assert.equal(profile[key], undefined);
  const facade = facadeFiles('better-sqlite3');
  assert.equal(facade['dist/profile.js'].toString(), "export * from './better-sqlite3.js';\nexport * from './errors.js';\nexport { defineSchema } from './schema-builder.js';\nexport { schemaDefToMetadata } from './schema-metadata.js';\n");
  assert.equal(facade['dist/profile.d.ts'].toString(), facade['dist/profile.js'] + "export type * from './index.js';\n");
});

test('native externals are finite and confined to their profile', () => {
  for (const peer of ['better-sqlite3', 'better-sqlite3/package.json']) {
    assert.ok(emittedClosure(available(`import '${peer}';`), manifest, ts).external.includes(peer));
    for (const profile of ['d1', 'sqlite', 'mysql']) assert.throws(() => emittedClosure(available(`import '${peer}';`), { ...manifest, name: `turbine-orm-${profile}-runtime-stage` }, ts), /Unreviewed external/);
  }
  for (const peer of ['better-sqlite3/lib/database', 'mysql2', 'miniflare', 'typescript', 'unknown'])
    assert.throws(() => emittedClosure(available(`import '${peer}';`), manifest, ts), /Unreviewed external/);
});

test('opaque imports and every previously rejected loader alias still refuse', () => {
  for (const code of [
    'import(opaque)', 'require(opaque)', "const load=require; load('better-sqlite3');",
    "import {createRequire as renamed} from 'node:module'; const load=renamed(import.meta.url); load('better-sqlite3');",
    "import {createRequire} from 'node:module'; const local=createRequire(import.meta.url); const load=local; load('better-sqlite3');",
    "import {createRequire} from 'node:module'; const local=createRequire(import.meta.url); local(opaque);",
  ]) assert.throws(() => emittedClosure(available(code), manifest, ts), /Opaque|Unsupported .*loader/);
});

test('literal lazy runtime and declaration-only edges are required', () => {
  const graph = { ...available("export const load=()=>import('./lazy.js');"), 'dist/lazy.js': Buffer.from('export {};') };
  graph['dist/main.d.ts'] = Buffer.from("export type * from './types.js';");
  graph['dist/types.d.ts'] = Buffer.from('export type Value=string;');
  assert.deepEqual(emittedClosure(graph, manifest, ts).inventory, ['dist/lazy.js', 'dist/main.d.ts', 'dist/main.js', 'dist/types.d.ts']);
  for (const name of ['dist/lazy.js', 'dist/types.d.ts']) {
    const broken = { ...graph }; delete broken[name];
    assert.throws(() => emittedClosure(broken, manifest, ts), /Missing emitted target/);
  }
});

test('finite helper admission requires both exact callers and both sibling semantics', () => {
  const graph = Object.fromEntries([...Object.keys(betterSqlite3Pins.helpers), ...Object.keys(betterSqlite3Pins.callers)].map(name => [name, readFileSync(new URL(`../../${name}`, import.meta.url))]));
  for (const name of Object.keys(betterSqlite3Pins.helpers)) {
    const targets = [], edges = [];
    assert.equal(betterSqlite3HelperEdges(name, graph, (from, specifier) => targets.push({ from, specifier }), edges), true);
    assert.deepEqual(targets.map(row => row.specifier), ['better-sqlite3', 'better-sqlite3/package.json', 'node:fs', ...(name.startsWith('dist/cjs/') ? ['../optional-peer-import.cjs'] : [])]);
    assert.equal(edges.length, name.startsWith('dist/cjs/') ? 0 : 1);
    assert.throws(() => betterSqlite3HelperEdges(name, { ...graph, [name]: Buffer.from('import(opaque)') }, () => {}, []), /internal peer helper changed/);
    for (const caller of Object.keys(betterSqlite3Pins.callers)) {
      const broken = { ...graph }; delete broken[caller];
      assert.throws(() => betterSqlite3HelperEdges(name, broken, () => {}, []), /Missing .*literal helper caller/);
      assert.throws(() => betterSqlite3HelperEdges(name, { ...graph, [caller]: Buffer.from("importOptionalPeer(dynamic)") }, () => {}, []), /literal helper caller changed/);
    }
  }
  assert.throws(() => betterSqlite3HelperEdges('dist/optional-peer-import.cjs', { ...graph, 'optional-peer-import.cjs': Buffer.from('') }, () => {}, []), /formerly absent/);
  assert.throws(() => assertBetterSqlite3HelperImport('dist/unknown.js', 'dist/optional-peer-import.cjs', graph), /Unreviewed .*helper caller/);
  for (const name of Object.keys(betterSqlite3Pins.callers)) assertBetterSqlite3HelperImport(name, name.replace('better-sqlite3.js', 'optional-peer-import.cjs'), graph);
  const unknown = { ...graph, ...available("import load from './optional-peer-import.cjs'; load(dynamic);") };
  assert.throws(() => emittedClosure(unknown, manifest, ts), /Unreviewed .*helper caller/);
});
