/**
 * turbine-orm: JSON column writes and write-value shapes, against live engines.
 *
 * Every stored value is read back through a RAW driver query (`jsonb_typeof`,
 * `::text`, `json_type`), never through the ORM's own row parser, so a write
 * that stores the wrong JSON type cannot be hidden by a read that happens to
 * decode it back into the same JS value.
 *
 * - A JS array bound to a json/jsonb column is stored as a JSON array on every
 *   write path: create, createMany, update, updateMany, both halves of upsert
 *   (single statement and lookup-first), and nested writes.
 * - A JS string is RAW JSON TEXT (`JSON.stringify(value)` callers store the
 *   parsed value), pinned so it cannot change silently.
 * - `jsonValue(v)` stores `JSON.stringify(v)`: a JSON string, or JSON null
 *   (which is not SQL NULL).
 * - createMany never turns one JSON array cell into several rows.
 * - On a json column only `set` is an update operator.
 * - On PostgreSQL an object or array bound to a scalar column is refused.
 * - `optimisticLock` on upsert / updateMany is refused, never ignored.
 * - `updatedAt` is stamped on both upsert paths.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/writes-json-live.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { jsonValue } from '../query/json-value.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

// biome-ignore lint/suspicious/noExplicitAny: dynamic table accessors over an introspected schema
type Table = any;

const PG_DDL = `
DROP TABLE IF EXISTS wj_docs CASCADE;
DROP TABLE IF EXISTS wj_parents CASCADE;
CREATE TABLE wj_parents (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE wj_docs (
  id         SERIAL PRIMARY KEY,
  parent_id  INT REFERENCES wj_parents(id),
  slug       TEXT UNIQUE,
  title      TEXT,
  n          INT,
  data       JSONB,
  doc        JSON,
  tags       TEXT[],
  version    INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ
);
`;

describe('json writes, live postgres', () => {
  let raw: pg.Pool;
  let db: TurbineClient;
  let docs: Table;
  let parents: Table;

  /** `[jsonb_typeof(data), data::text]` for one row. */
  const stored = async (id: number, col = 'data'): Promise<[string | null, string | null]> => {
    const fn = col === 'doc' ? 'json_typeof' : 'jsonb_typeof';
    const { rows } = await raw.query(`SELECT ${fn}(${col}) AS t, ${col}::text AS v FROM wj_docs WHERE id = $1`, [id]);
    assert.equal(rows.length, 1, `row ${id} exists`);
    return [rows[0].t, rows[0].v];
  };
  const count = async () => Number((await raw.query('SELECT count(*)::int AS c FROM wj_docs')).rows[0].c);

  pgGate.before(async () => {
    raw = new pg.Pool({ connectionString: DATABASE_URL!, max: 2 });
    await raw.query(PG_DDL);
    const schema: SchemaMetadata = await introspect({
      connectionString: DATABASE_URL!,
      include: ['wj_parents', 'wj_docs'],
    });
    const touched = schema.tables.wj_docs!.columns.find((c) => c.name === 'updated_at');
    if (touched) touched.updatedAt = true;
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
    docs = db.table('wj_docs');
    parents = db.table('wj_parents');
  });

  pgGate.after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS wj_docs, wj_parents CASCADE');
    await raw?.end();
  });

  pgGate.it('create stores a JS array as a JSON array, empty and nested included', async () => {
    const empty = await docs.create({ data: { data: [] } });
    assert.deepEqual(await stored(empty.id), ['array', '[]'], '[] must not become the object {}');
    const one = await docs.create({ data: { data: ['a'] } });
    assert.deepEqual(await stored(one.id), ['array', '["a"]']);
    const mixed = await docs.create({ data: { data: [1, { x: 2 }, [3, [4]]] } });
    assert.deepEqual(await stored(mixed.id), ['array', '[1, {"x": 2}, [3, [4]]]']);
    const plainJson = await docs.create({ data: { doc: [1, 'b'] } });
    assert.deepEqual(await stored(plainJson.id, 'doc'), ['array', '[1,"b"]'], 'json (not jsonb) column too');
    assert.deepEqual(one.data, ['a'], 'the returned row carries the array');
  });

  pgGate.it('a string is raw JSON text, exactly as JSON.stringify callers rely on', async () => {
    const obj = await docs.create({ data: { data: JSON.stringify({ a: 1, b: [2] }) } });
    assert.deepEqual(await stored(obj.id), ['object', '{"a": 1, "b": [2]}']);
    const arr = await docs.create({ data: { data: JSON.stringify([1, 2]) } });
    assert.deepEqual(await stored(arr.id), ['array', '[1, 2]']);
    const str = await docs.create({ data: { data: JSON.stringify('hello') } });
    assert.deepEqual(await stored(str.id), ['string', '"hello"']);
    await docs.update({ where: { id: obj.id }, data: { data: JSON.stringify({ c: 3 }) } });
    assert.deepEqual(await stored(obj.id), ['object', '{"c": 3}']);
    const many = await docs.createMany({ data: [{ data: JSON.stringify({ m: 1 }) }, { data: JSON.stringify([9]) }] });
    assert.deepEqual(await stored(many[0].id), ['object', '{"m": 1}']);
    assert.deepEqual(await stored(many[1].id), ['array', '[9]']);
  });

  pgGate.it('jsonValue stores JSON.stringify of its value; JSON null is not SQL NULL', async () => {
    const s = await docs.create({ data: { data: jsonValue('hello') } });
    assert.deepEqual(await stored(s.id), ['string', '"hello"']);
    const jn = await docs.create({ data: { data: jsonValue(null) } });
    assert.deepEqual(await stored(jn.id), ['null', 'null'], 'jsonValue(null) is the JSON value null');
    const sqlNull = await docs.create({ data: { data: null } });
    assert.deepEqual(await stored(sqlNull.id), [null, null], 'a bare null stays SQL NULL');
    await docs.update({ where: { id: s.id }, data: { data: { set: jsonValue('x') } } });
    assert.deepEqual(await stored(s.id), ['string', '"x"']);
    const many = await docs.createMany({ data: [{ data: jsonValue('a') }, { data: jsonValue([1]) }] });
    assert.deepEqual(await stored(many[0].id), ['string', '"a"']);
    assert.deepEqual(await stored(many[1].id), ['array', '[1]']);
  });

  pgGate.it('createMany inserts exactly one row per element, whatever the JSON shape', async () => {
    const before = await count();
    const rows = await docs.createMany({
      data: [
        { title: 'a', data: [1, 2, 3] },
        { title: 'b', data: [] },
        { title: 'c', data: { k: [1, 2] } },
        { title: 'd', data: null },
        { title: 'e', data: [[1, 2], [3]] },
      ],
    });
    assert.equal(rows.length, 5);
    assert.equal((await count()) - before, 5, 'a JSON array cell must not expand into extra rows');
    assert.deepEqual(await stored(rows[0].id), ['array', '[1, 2, 3]']);
    assert.deepEqual(await stored(rows[1].id), ['array', '[]']);
    assert.deepEqual(await stored(rows[2].id), ['object', '{"k": [1, 2]}']);
    assert.deepEqual(await stored(rows[3].id), [null, null]);
    assert.deepEqual(await stored(rows[4].id), ['array', '[[1, 2], [3]]']);
  });

  pgGate.it('createMany still round-trips a native text[] column', async () => {
    const rows = await docs.createMany({
      data: [
        { title: 'x', tags: ['a', 'b'], data: [1] },
        { title: 'y', tags: [], data: { z: 1 } },
      ],
    });
    const { rows: back } = await raw.query('SELECT tags::text AS t FROM wj_docs WHERE id = ANY($1) ORDER BY id', [
      rows.map((r: { id: number }) => r.id),
    ]);
    assert.deepEqual(
      back.map((r) => r.t),
      ['{a,b}', '{}'],
    );
    assert.deepEqual(await stored(rows[0].id), ['array', '[1]']);
  });

  pgGate.it('update and updateMany store arrays; `{ set: [...] }` unwraps', async () => {
    const row = await docs.create({ data: { title: 'u' } });
    await docs.update({ where: { id: row.id }, data: { data: [1, 2] } });
    assert.deepEqual(await stored(row.id), ['array', '[1, 2]']);
    await docs.update({ where: { id: row.id }, data: { data: { set: [] } } });
    assert.deepEqual(await stored(row.id), ['array', '[]']);
    await docs.updateMany({ where: { id: row.id }, data: { data: ['m'] } });
    assert.deepEqual(await stored(row.id), ['array', '["m"]']);
    // The same statement again hits the SQL template cache; the cached
    // param-collect path must serialize identically.
    await docs.updateMany({ where: { id: row.id }, data: { data: ['n', 'o'] } });
    assert.deepEqual(await stored(row.id), ['array', '["n", "o"]']);
  });

  pgGate.it('upsert stores arrays on both halves, single-statement and lookup paths', async () => {
    // Pinned where: the single ON CONFLICT statement.
    const created = await docs.upsert({
      where: { slug: 'up1' },
      create: { slug: 'up1', data: ['c'] },
      update: { data: ['u'] },
    });
    assert.deepEqual(await stored(created.id), ['array', '["c"]']);
    await docs.upsert({ where: { slug: 'up1' }, create: { slug: 'up1', data: ['c'] }, update: { data: ['u'] } });
    assert.deepEqual(await stored(created.id), ['array', '["u"]']);
    // where not pinned to create: the lookup-first path.
    await docs.upsert({ where: { id: created.id }, create: { slug: 'up2', data: [] }, update: { data: [7] } });
    assert.deepEqual(await stored(created.id), ['array', '[7]']);
    const viaLookup = await docs.upsert({ where: { id: 999999 }, create: { slug: 'up3', data: [] }, update: {} });
    assert.deepEqual(await stored(viaLookup.id), ['array', '[]']);
  });

  pgGate.it('nested writes store arrays (nested create batch goes through createMany)', async () => {
    const before = await count();
    const parent = await parents.create({
      data: { name: 'p', wjDocs: { create: [{ data: [1, 2, 3] }, { data: [] }] } },
    });
    assert.equal((await count()) - before, 2);
    const { rows } = await raw.query(
      'SELECT jsonb_typeof(data) AS t, data::text AS v FROM wj_docs WHERE parent_id = $1 ORDER BY id',
      [parent.id],
    );
    assert.deepEqual(
      rows.map((r) => [r.t, r.v]),
      [
        ['array', '[1, 2, 3]'],
        ['array', '[]'],
      ],
    );
    const { rows: ids } = await raw.query('SELECT id FROM wj_docs WHERE parent_id = $1 ORDER BY id', [parent.id]);
    await parents.update({
      where: { id: parent.id },
      data: { wjDocs: { update: [{ where: { id: ids[0].id }, data: { data: ['nested'] } }] } },
    });
    const { rows: after } = await raw.query('SELECT data::text AS v FROM wj_docs WHERE parent_id = $1 ORDER BY id', [
      parent.id,
    ]);
    assert.deepEqual(
      after.map((r) => r.v),
      ['["nested"]', '[]'],
    );
  });

  pgGate.it('on a json column only `set` is an operator; an int column keeps its operators', async () => {
    const row = await docs.create({ data: { n: 1 } });
    await docs.update({ where: { id: row.id }, data: { data: { increment: 1 }, n: { increment: 1 } } });
    assert.deepEqual(await stored(row.id), ['object', '{"increment": 1}']);
    assert.equal((await raw.query('SELECT n FROM wj_docs WHERE id = $1', [row.id])).rows[0].n, 2);
    await docs.update({ where: { id: row.id }, data: { data: { set: { increment: 5 } } } });
    assert.deepEqual(await stored(row.id), ['object', '{"increment": 5}']);
    await docs.updateMany({ where: { id: row.id }, data: { data: { multiply: 2 } } });
    assert.deepEqual(await stored(row.id), ['object', '{"multiply": 2}']);
  });

  pgGate.it('an object or array bound to a scalar column is refused; Date, bigint and text[] are not', async () => {
    const before = await count();
    await assert.rejects(
      docs.create({ data: { title: { first: 'A', last: 'B' } } }),
      (e: unknown) => e instanceof ValidationError && /"wj_docs\.title" \(column type text\)/.test(e.message),
    );
    await assert.rejects(docs.create({ data: { title: { set: 'A' } } }), ValidationError);
    await assert.rejects(docs.create({ data: { title: ['a'] } }), /an array to "wj_docs\.title"/);
    await assert.rejects(docs.createMany({ data: [{ title: { a: 1 } }] }), ValidationError);
    await assert.rejects(
      docs.upsert({ where: { slug: 'sc' }, create: { slug: 'sc', title: { a: 1 } }, update: { title: 'x' } }),
      ValidationError,
    );
    assert.equal(await count(), before, 'nothing was written');
    const row = await docs.create({ data: { title: 't', n: 5n, updatedAt: new Date(0), tags: ['x'] } });
    await assert.rejects(
      docs.update({ where: { id: row.id }, data: { title: { first: 'A', last: 'B' } } }),
      ValidationError,
    );
    await assert.rejects(docs.update({ where: { id: row.id }, data: { n: { set: { a: 1 } } } }), ValidationError);
    const { rows } = await raw.query('SELECT title, n FROM wj_docs WHERE id = $1', [row.id]);
    assert.deepEqual(rows[0], { title: 't', n: 5 });
  });

  pgGate.it('optimisticLock on upsert and updateMany is refused, and nothing is written', async () => {
    const row = await docs.create({ data: { slug: 'ol', title: 'before', version: 3 } });
    const lock = { field: 'version', expected: 0 };
    await assert.rejects(
      docs.updateMany({ where: { id: row.id }, data: { title: 'stale' }, optimisticLock: lock }),
      (e: unknown) =>
        e instanceof ValidationError && /updateMany/.test(e.message) && /version: \{ increment: 1 \}/.test(e.message),
    );
    await assert.rejects(
      docs.upsert({
        where: { slug: 'ol' },
        create: { slug: 'ol' },
        update: { title: 'stale' },
        optimisticLock: lock,
      }),
      (e: unknown) => e instanceof ValidationError && /optimisticLock/.test(e.message),
    );
    await assert.rejects(
      docs.upsert({ where: { id: row.id }, create: { slug: 'ol2' }, update: { title: 'stale' }, optimisticLock: lock }),
      ValidationError,
    );
    const { rows } = await raw.query('SELECT title, version FROM wj_docs WHERE id = $1', [row.id]);
    assert.deepEqual(rows[0], { title: 'before', version: 3 });
  });

  pgGate.it('updatedAt is stamped on both upsert paths', async () => {
    const native = await docs.create({ data: { slug: 'ua1' } });
    const lookup = await docs.create({ data: { slug: 'ua2' } });
    await raw.query('UPDATE wj_docs SET updated_at = NULL WHERE id = ANY($1)', [[native.id, lookup.id]]);
    // Pinned where: the single ON CONFLICT statement.
    await docs.upsert({ where: { slug: 'ua1' }, create: { slug: 'ua1' }, update: { title: 'n' } });
    // where not pinned to create: lookup-first, which calls update().
    await docs.upsert({ where: { id: lookup.id }, create: { slug: 'zz' }, update: { title: 'l' } });
    const { rows } = await raw.query(
      'SELECT slug, updated_at IS NOT NULL AS stamped FROM wj_docs WHERE id = ANY($1) ORDER BY slug',
      [[native.id, lookup.id]],
    );
    assert.deepEqual(rows, [
      { slug: 'ua1', stamped: true },
      { slug: 'ua2', stamped: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// SQLite (in-process)
// ---------------------------------------------------------------------------

const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

describe('json writes, live sqlite', () => {
  sqliteGate.it('arrays, raw JSON strings and jsonValue store the same JSON as on postgres', async () => {
    const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const sqlite = new DatabaseSync(':memory:');
    sqlite.exec('CREATE TABLE wj_docs (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT UNIQUE, title TEXT, data JSON)');
    const client = turbineSqlite(sqlite, introspectSqliteDatabase(sqlite));
    const docs = client.table('wj_docs') as Table;
    const stored = (id: number): [string | null, string | null] => {
      const r = sqlite.prepare('SELECT json_type(data) AS t, data AS v FROM wj_docs WHERE id = ?').get(id) as {
        t: string | null;
        v: string | null;
      };
      return [r.t, r.v];
    };
    try {
      const a = await docs.create({ data: { data: [] } });
      assert.deepEqual(stored(a.id), ['array', '[]']);
      const b = await docs.create({ data: { data: [1, { x: 2 }] } });
      assert.deepEqual(stored(b.id), ['array', '[1,{"x":2}]']);
      const s = await docs.create({ data: { data: JSON.stringify({ a: 1 }) } });
      assert.deepEqual(stored(s.id), ['object', '{"a":1}']);
      const jv = await docs.create({ data: { data: jsonValue('hello') } });
      assert.deepEqual(stored(jv.id), ['text', '"hello"']);
      const jn = await docs.create({ data: { data: jsonValue(null) } });
      assert.deepEqual(stored(jn.id), ['null', 'null']);
      const many = await docs.createMany({ data: [{ data: [1, 2, 3] }, { data: jsonValue('m') }] });
      assert.equal(many.length, 2);
      assert.deepEqual(stored(many[0].id), ['array', '[1,2,3]']);
      assert.deepEqual(stored(many[1].id), ['text', '"m"']);
      await docs.update({ where: { id: a.id }, data: { data: { increment: 1 } } });
      assert.deepEqual(stored(a.id), ['object', '{"increment":1}']);
      await docs.upsert({ where: { slug: 'u' }, create: { slug: 'u', data: ['c'] }, update: { data: ['u'] } });
      const up = await docs.upsert({
        where: { slug: 'u' },
        create: { slug: 'u', data: ['c'] },
        update: { data: ['u'] },
      });
      assert.deepEqual(stored(up.id), ['array', '["u"]']);
    } finally {
      await client.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// MySQL (own database, created and dropped here)
// ---------------------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');
const MYSQL_DB = 'turbine_dev_writes_json';

describe('json writes, live mysql', () => {
  mysqlGate.it('arrays, raw JSON strings and jsonValue store the same JSON as on postgres', async () => {
    const { createPool } = await import('mysql2/promise');
    const { introspectMysql, turbineMysql } = await import('../mysql.js');
    const url = new URL(MYSQL_URL);
    const admin = createPool({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    });
    await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
    await admin.query(`CREATE DATABASE \`${MYSQL_DB}\``);
    await admin.query(
      `CREATE TABLE \`${MYSQL_DB}\`.wj_docs (id INT AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(32) UNIQUE, title TEXT, data JSON)`,
    );
    const dbUrl = new URL(MYSQL_URL);
    dbUrl.pathname = `/${MYSQL_DB}`;
    const client = await turbineMysql(dbUrl.toString(), await introspectMysql({ connectionString: dbUrl.toString() }));
    const docs = client.table('wj_docs') as Table;
    const stored = async (id: number): Promise<[string | null, string | null]> => {
      const [rows] = (await admin.query(
        `SELECT JSON_TYPE(data) AS t, CAST(data AS CHAR) AS v FROM \`${MYSQL_DB}\`.wj_docs WHERE id = ?`,
        [id],
      )) as unknown as [{ t: string | null; v: string | null }[]];
      return [rows[0]!.t, rows[0]!.v];
    };
    try {
      const a = await docs.create({ data: { data: [] } });
      assert.deepEqual(await stored(a.id), ['ARRAY', '[]']);
      const b = await docs.create({ data: { data: [1, { x: 2 }] } });
      assert.deepEqual(await stored(b.id), ['ARRAY', '[1, {"x": 2}]']);
      const s = await docs.create({ data: { data: JSON.stringify({ a: 1 }) } });
      assert.deepEqual(await stored(s.id), ['OBJECT', '{"a": 1}']);
      const jv = await docs.create({ data: { data: jsonValue('hello') } });
      assert.deepEqual(await stored(jv.id), ['STRING', '"hello"']);
      const jn = await docs.create({ data: { data: jsonValue(null) } });
      assert.deepEqual(await stored(jn.id), ['NULL', 'null']);
      await docs.createMany({
        data: [
          { slug: 'm1', data: [1, 2, 3] },
          { slug: 'm2', data: jsonValue('m') },
        ],
      });
      const [rows] = (await admin.query(
        `SELECT slug, CAST(data AS CHAR) AS v FROM \`${MYSQL_DB}\`.wj_docs WHERE slug IN ('m1', 'm2') ORDER BY slug`,
      )) as unknown as [{ slug: string; v: string }[]];
      assert.deepEqual(rows, [
        { slug: 'm1', v: '[1, 2, 3]' },
        { slug: 'm2', v: '"m"' },
      ]);
      await docs.update({ where: { id: a.id }, data: { data: { increment: 1 } } });
      assert.deepEqual(await stored(a.id), ['OBJECT', '{"increment": 1}']);
    } finally {
      await client.disconnect();
      await admin.query(`DROP DATABASE IF EXISTS \`${MYSQL_DB}\``);
      await admin.end();
    }
  });
});
