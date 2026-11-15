/** Complete native reads through actual installed default and supplied clients. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [consumer, format, output] = process.argv.slice(2);
assert.ok(consumer && output && process.env.DATABASE_URL && ['esm', 'cjs'].includes(format));
const require = createRequire(join(consumer, 'package.json'));
const installed = join(consumer, 'node_modules/turbine-orm');
const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
const api = format === 'esm' ? await import(pathToFileURL(join(installed, manifest.exports['.'].import.default))) : require('turbine-orm');
const pg = require('pg');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const report = { runtime: process.version, format, pg: JSON.parse(readFileSync(join(consumer, 'node_modules/pg/package.json'))).version, groups: [], success: false };
let db, supplied;
try {
  await pool.query('DROP TABLE IF EXISTS materialization_pg_children,materialization_pg_rows CASCADE');
  await pool.query(`CREATE TABLE materialization_pg_rows(id bigint PRIMARY KEY,tenant_id int,full_name text,at timestamptz,score float8,prefs jsonb,bytes bytea,prototype_column text);
    CREATE TABLE materialization_pg_children(id int PRIMARY KEY,row_id bigint REFERENCES materialization_pg_rows(id),visible boolean);
    INSERT INTO materialization_pg_rows VALUES (1,1,'one','2024-02-29T03:04:05Z','Infinity','{"n":1,"__proto__":{"safe":true}}','\\x00ff','own'),
    (2,1,'two',NULL,'NaN','null',NULL,NULL),(9007199254740993,2,'other','infinity',NULL,'[1,null]',NULL,'large');
    INSERT INTO materialization_pg_children VALUES (1,1,true),(2,1,false),(3,1,true),(4,9007199254740993,true)`);
  const schema = await api.introspect({ connectionString: process.env.DATABASE_URL });
  const meta = schema.tables.materialization_pg_rows;
  assert.equal(meta.allColumns.length, 8);
  meta.reverseColumnMap.prototype_column = '__proto__';
  Object.defineProperty(meta.columnMap, '__proto__', { enumerable: true, value: 'prototype_column' });
  meta.columns.find(column => column.name === 'prototype_column').field = '__proto__';
  meta.relations.children = { type: 'hasMany', name: 'children', from: meta.name, to: 'materialization_pg_children', foreignKey: 'row_id', referenceKey: 'id' };
  let tenant = 1;
  const options = { logger: {}, warnOnUnlimited: false, temporalInfinity: 'preserve', globalFilters: { materialization_pg_rows: () => ({ tenantId: tenant }), materialization_pg_children: { visible: true } } };
  db = new api.TurbineClient({ ...options, connectionString: process.env.DATABASE_URL, poolSize: 1 }, schema);
  supplied = new api.TurbineClient({ ...options, pool }, schema);
  for (const client of [db, supplied]) {
    const table = client.table('materialization_pg_rows');
    for (let repeat = 0; repeat < 3; repeat++) {
      const rows = await table.findMany({ orderBy: { id: 'asc' }, limit: 100 });
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map(Object.keys), [0, 1].map(() => ['id', 'tenantId', 'fullName', 'at', 'score', 'prefs', 'bytes', '__proto__']));
      assert.equal(rows[0].id, 1); assert.equal(rows[0].fullName, 'one'); assert.equal(rows[0].score, Infinity);
      assert.equal(rows[0].at.toISOString(), '2024-02-29T03:04:05.000Z');
      assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
      assert.equal(Object.getOwnPropertyDescriptor(rows[0], '__proto__').value, 'own');
      assert.deepEqual([...rows[0].bytes], [0, 255]);
      assert.equal(Object.hasOwn(rows[0].prefs, '__proto__'), true);
      assert.equal(Object.getPrototypeOf(rows[0].prefs), Object.prototype);
      assert.equal(rows[1].at, null); assert.ok(Number.isNaN(rows[1].score)); assert.equal(rows[1].prefs, null);
      const selected = await table.findMany({ select: { score: true, fullName: true }, orderBy: { id: 'desc' }, limit: 1 });
      assert.deepEqual(Object.keys(selected[0]), ['fullName', 'score']); assert.ok(Number.isNaN(selected[0].score));
      assert.equal(await table.findUnique({ where: { id: 999 } }), null);
      const filtered = await table.findMany({ where: { children: { some: { visible: true } } }, select: { id: true }, limit: 100 });
      assert.deepEqual(filtered, [{ id: 1 }]);
      const counted = await table.findMany({ with: { _count: { children: true } }, select: { id: true, fullName: true }, orderBy: { id: 'asc' }, limit: 100 });
      assert.deepEqual(counted, [{ id: 1, fullName: 'one', _count: { children: 2 } }, { id: 2, fullName: 'two', _count: { children: 0 } }]);
    }
    const events = [], sentinel = new Error('lazy native getter');
    Object.defineProperty(Object.prototype, 'fullName', { configurable: true, set(value) {
      events.push(value); Object.defineProperty(this, 'fullName', { enumerable: true, configurable: true, get() { throw sentinel; } });
    } });
    try {
      const rows = await table.findMany({ with: { _count: { children: true } }, orderBy: { id: 'asc' }, limit: 100 });
      assert.deepEqual(events, ['one', 'two']);
      assert.throws(() => rows[0].fullName, error => error === sentinel);
      assert.deepEqual(rows[0]._count, { children: 2 });
    } finally { Reflect.deleteProperty(Object.prototype, 'fullName'); }
    tenant = 2;
    const large = await table.findMany({ limit: 100 });
    assert.equal(large.length, 1); assert.equal(large[0].id, '9007199254740993'); assert.equal(large[0].at, Infinity);
    tenant = 1;
    report.groups.push({ owned: client === db, completeFlat: true, projections: true, misses: true, filteredRelations: true, counts: true, accessorIdentity: true, tenants: true, unsafeInteger: true });
  }
  await supplied.disconnect(); supplied = undefined;
  assert.equal((await pool.query('SELECT 1 AS n')).rows[0].n, 1, 'supplied client must retain caller pool');
  const rawAlias = await db.rawUnsafe('SELECT 7 AS "__proto__"');
  report.rawPrototypeAlias = Object.hasOwn(rawAlias[0], '__proto__');
  assert.equal(report.rawPrototypeAlias, report.pg !== '8.15.0', 'retain explicit floor compatibility hold');
  report.success = true;
} finally { Reflect.deleteProperty(Object.prototype, 'fullName'); await supplied?.disconnect(); await db?.disconnect(); await pool.query('DROP TABLE IF EXISTS materialization_pg_children,materialization_pg_rows CASCADE'); await pool.end(); writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); }
