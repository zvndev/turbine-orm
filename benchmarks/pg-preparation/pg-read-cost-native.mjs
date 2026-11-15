/** Installed ESM/CJS native count controls. Service ownership belongs to the caller. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [consumer, format, output] = process.argv.slice(2);
assert.ok(consumer && output && ['esm', 'cjs'].includes(format));
assert.ok(process.env.DATABASE_URL, 'Owned native service required; no skip path');
const require = createRequire(join(consumer, 'package.json'));
const installed = join(consumer, 'node_modules/turbine-orm');
const manifest = JSON.parse(readFileSync(join(installed, 'package.json')));
const api = format === 'esm'
  ? await import(pathToFileURL(join(installed, manifest.exports['.'].import.default)))
  : require('turbine-orm');
const pg = require('pg');
const report = { format, runtime: process.version, pg: JSON.parse(readFileSync(join(consumer, 'node_modules/pg/package.json'))).version, checks: [], snapshots: [], success: false };
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const drop = 'DROP TABLE IF EXISTS pg_cost_links,pg_cost_tags,pg_cost_posts,pg_cost_users CASCADE';
let db;
try {
  await pool.query(drop);
  await pool.query(`
    CREATE TABLE pg_cost_users(id bigint PRIMARY KEY, tenant_id int NOT NULL, label text NOT NULL,
      ref text, _count jsonb, _count__stored text, prototype_column text, at timestamptz, score float8);
    CREATE TABLE pg_cost_posts(id int PRIMARY KEY, user_id bigint REFERENCES pg_cost_users(id),
      tenant_id int NOT NULL, visible boolean NOT NULL, ref text);
    CREATE INDEX ON pg_cost_posts(user_id);
    CREATE TABLE pg_cost_tags(id int PRIMARY KEY, tenant_id int NOT NULL, visible boolean NOT NULL);
    CREATE TABLE pg_cost_links(user_id bigint, tag_id int);
    INSERT INTO pg_cost_users VALUES
      (1,1,'one','a','{"stored":1}','stored','safe','2025-01-02T03:04:05Z','-Infinity'),
      (2,1,'zero',NULL,NULL,'other','data',NULL,'NaN'), (3,2,'other','b',NULL,NULL,NULL,NULL,0);
    INSERT INTO pg_cost_posts VALUES (1,1,1,true,'a'),(2,1,1,true,'a'),(3,1,1,false,'a'),
      (4,1,2,true,'a'),(5,3,2,true,'b'),(6,NULL,1,true,NULL);
    INSERT INTO pg_cost_tags VALUES (1,1,true),(2,1,false),(3,2,true);
    INSERT INTO pg_cost_links VALUES (1,1),(1,1),(1,2),(1,3),(1,999);`);
  const schema = await api.introspect({ connectionString: process.env.DATABASE_URL });
  const users = schema.tables.pg_cost_users;
  assert.ok(users?.allColumns.length === 9);
  // Include safe own prototype-key materialization without relying on a name converter.
  users.reverseColumnMap.prototype_column = '__proto__';
  Object.defineProperty(users.columnMap, '__proto__', { value: 'prototype_column', enumerable: true });
  users.columns.find((c) => c.name === 'prototype_column').field = '__proto__';
  users.reverseColumnMap._count = '_count';
  users.columnMap._count = '_count';
  users.columns.find((c) => c.name === '_count').field = '_count';
  users.relations = {
    posts: { type: 'hasMany', name: 'posts', from: 'pg_cost_users', to: 'pg_cost_posts', foreignKey: 'user_id', referenceKey: 'id' },
    byRef: { type: 'hasMany', name: 'byRef', from: 'pg_cost_users', to: 'pg_cost_posts', foreignKey: 'ref', referenceKey: 'ref' },
    tags: { type: 'manyToMany', name: 'tags', from: 'pg_cost_users', to: 'pg_cost_tags', foreignKey: 'id', referenceKey: 'id', through: { table: 'pg_cost_links', sourceKey: 'user_id', targetKey: 'tag_id' } },
  };
  let tenant = 1;
  const globalFilters = {
    pg_cost_users: () => ({ tenantId: tenant }),
    pg_cost_posts: () => ({ tenantId: tenant, visible: true }),
    pg_cost_tags: () => ({ tenantId: tenant, visible: true }),
  };
  db = new api.TurbineClient({ pool, globalFilters, preparedStatements: true, logger: {}, warnOnUnlimited: false }, schema);
  await db.connect();
  const table = db.table('pg_cost_users');
  const calls = [];
  const send = pool.query;
  pool.query = function (query, ...args) { calls.push(typeof query === 'string' ? { text: query } : { text: query.text, name: query.name }); return send.call(this, query, ...args); };
  const base = { orderBy: { id: 'asc' }, limit: 100 };
  for (const jsonEncoding of ['object', 'positional']) for (const relationLoadStrategy of ['join', 'batched', 'auto']) {
    const args = { ...base, jsonEncoding, relationLoadStrategy, select: { id: true, label: true }, with: { _count: { posts: true } } };
    const value = await table.findMany(args);
    assert.deepEqual(value, [{ id: 1, label: 'one', _count: { posts: 2 } }, { id: 2, label: 'zero', _count: { posts: 0 } }]);
    assert.deepEqual(value.map(Object.keys), [['id', 'label', '_count'], ['id', 'label', '_count']]);
    const complete = await table.findMany({ ...base, jsonEncoding, relationLoadStrategy, with: { _count: { posts: true } } });
    assert.equal(complete.length, 2);
    assert.equal(Object.getPrototypeOf(complete[0]), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(complete[0], '__proto__').value, 'safe');
    assert.equal(complete[0].at.toISOString(), '2025-01-02T03:04:05.000Z');
    assert.equal(complete[0].score, -Infinity);
    assert.ok(Number.isNaN(complete[1].score));
    assert.equal(Object.keys(complete[0]).length, 9, 'every original column plus replacing _count');
    const multiple = await table.findMany({ ...args, with: { _count: { posts: true, byRef: true, tags: true } } });
    assert.deepEqual(multiple, [
      { id: 1, label: 'one', _count: { posts: 2, byRef: 2, tags: 2 } },
      { id: 2, label: 'zero', _count: { posts: 0, byRef: 0, tags: 0 } },
    ], 'count duplicate junction rows, exclude filtered/dangling targets, do not match NULL correlation keys');
    report.snapshots.push({ jsonEncoding, relationLoadStrategy, keys: complete.map(Object.keys), projected: value, multiple });
    report.checks.push(`${jsonEncoding}/${relationLoadStrategy}/full-projection-counts-order-types-tenant-null-cardinality`);
  }
  tenant = 2;
  assert.deepEqual(await table.findMany({ ...base, select: { id: true }, with: { _count: { posts: true } } }), [{ id: 3, _count: { posts: 1 } }], 'mutable tenant filter cannot reuse another tenant binding');
  tenant = 1;
  const distinct = await table.findMany({ ...base, distinct: ['id'], select: { id: true }, with: { _count: { posts: true } } });
  assert.deepEqual(distinct, [{ id: 1, _count: { posts: 2 } }, { id: 2, _count: { posts: 0 } }]);
  const descriptor = table.buildFindMany({ ...base, with: { _count: { posts: true } } });
  assert.ok(descriptor.preparedName);
  calls.length = 0;
  await table.findMany({ ...base, with: { _count: { posts: true } } });
  assert.equal(calls.at(-1).name, descriptor.preparedName, 'native named policy unchanged');
  await table.findMany({ ...base, with: { _count: { posts: true } }, forceCustomPlan: true });
  assert.ok(!calls.at(-1).name, 'explicit forceCustomPlan remains unnamed');
  const rollback = new Error('rollback sentinel');
  await assert.rejects(db.$transaction(async (tx) => {
    await tx.raw`INSERT INTO pg_cost_posts VALUES (99,1,1,true,'a')`;
    const rows = await tx.table('pg_cost_users').findMany({ ...base, select: { id: true }, with: { _count: { posts: true } } });
    assert.equal(rows[0]._count.posts, 3);
    throw rollback;
  }), (error) => error === rollback);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM pg_cost_posts WHERE id=99')).rows[0].n, 0);
  // These independent expected-value guards must reject actual omissions/filter loss.
  assert.throws(() => assert.deepEqual(distinct.map((row) => ({ id: row.id })), distinct));
  assert.throws(() => assert.deepEqual([{ id: 1, _count: { posts: 4 } }, distinct[1]], distinct));
  report.checks.push('mutable-filter-distinct-named-unnamed-rollback-negative-controls');
  await db.disconnect(); db = undefined;
  assert.equal((await pool.query('SELECT 1 AS alive')).rows[0].alive, 1, 'caller pool survives disconnect');
  report.checks.push('borrowed-pool-survives');
  report.success = true;
} finally {
  await db?.disconnect();
  await pool.query(drop);
  await pool.end();
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}
