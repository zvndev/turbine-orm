/**
 * An index is unique when PostgreSQL says it is, not when its definition
 * happens to contain the word.
 *
 * Introspection read uniqueness with `indexdef.includes('UNIQUE')`. The text
 * of a definition also carries the index's name, its columns, its expressions
 * and its partial predicate, so a plain index named `"IDX_UNIQUE_kind"` was
 * recorded as unique. The one-row rule trusts that flag: `findUnique`,
 * `update` and `delete` then accepted `where: { kind }`, and a `delete` meant
 * for one row removed every row with that value.
 *
 * The same rule covers the STRUCTURE of the index, read by the one reader of
 * index definitions (pg-catalog-text.ts): a quoted index name that spells
 * `USING btree (kind)` does not supply the key list, a UNIQUE index with an
 * expression key is not a unique key over its plain columns, and ordering
 * words inside a quoted column name stay part of the name.
 *
 * Run: npx tsx --test src/test/index-unique-detection.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { indexDefIsUnique, introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

describe('indexDefIsUnique reads the leading keywords of an index definition', () => {
  const unique = [
    'CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email)',
    'CREATE UNIQUE INDEX "IDX_plain" ON public.t USING btree (a, b)',
    "CREATE UNIQUE INDEX t_live ON public.t USING btree (a) WHERE (state = 'live'::text)",
    '  create unique index t_lower on public.t using btree (a)',
    'CREATE UNIQUE INDEX t_pk ON defaultdb.public.t USING btree (id ASC)',
  ];
  const plain = [
    'CREATE INDEX posts_user_id_idx ON public.posts USING btree (user_id)',
    // The word in the index name, as a quoted identifier keeps its case.
    'CREATE INDEX "IDX_UNIQUE_kind" ON public.t USING btree (kind)',
    'CREATE INDEX "UNIQUE" ON public.t USING btree (kind)',
    // In a column name, an expression and a partial predicate.
    'CREATE INDEX t_col ON public.t USING btree ("UNIQUE_code")',
    "CREATE INDEX t_expr ON public.t USING btree ((('UNIQUE'::text || kind)))",
    "CREATE INDEX t_part ON public.t USING btree (kind) WHERE (note = 'UNIQUE'::text)",
    // In the table name.
    'CREATE INDEX t_idx ON public."UNIQUE things" USING btree (kind)',
    '',
  ];
  for (const def of unique) it(`unique: ${def.trim().slice(0, 60)}`, () => assert.equal(indexDefIsUnique(def), true));
  for (const def of plain) it(`not unique: ${def.slice(0, 60)}`, () => assert.equal(indexDefIsUnique(def), false));
});

const PG_URL = process.env.DATABASE_URL;
const gate = skipGate(!PG_URL, 'DATABASE_URL not set');

describe('a plain index whose definition contains the word is not a unique key', () => {
  // A database of its own: other suites introspect the shared one in parallel.
  const DB = 'turbine_index_unique_test';
  const url = PG_URL ? PG_URL.replace(/\/[^/?]+(\?|$)/, `/${DB}$1`) : '';
  let schema: SchemaMetadata;
  let db: TurbineClient;
  let raw: pg.Client;

  async function admin(sql: string): Promise<void> {
    const client = new pg.Client({ connectionString: PG_URL });
    await client.connect();
    try {
      await client.query(sql);
    } finally {
      await client.end();
    }
  }

  gate.before(async () => {
    await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin(`CREATE DATABASE ${DB}`);
    raw = new pg.Client({ connectionString: url });
    await raw.connect();
    await raw.query('CREATE TABLE things (id int PRIMARY KEY, kind text, note text, code text, slug text)');
    await raw.query('CREATE INDEX "IDX_UNIQUE_kind" ON things (kind)');
    await raw.query(`CREATE INDEX things_note_part ON things (note) WHERE (note <> 'UNIQUE')`);
    await raw.query('CREATE INDEX "UNIQUE" ON things (code)');
    await raw.query('CREATE UNIQUE INDEX things_slug_key ON things (slug)');
    // A foreign key covered by a plain index whose name contains the word, and
    // one covered by a real unique index.
    await raw.query('CREATE TABLE owners (id int PRIMARY KEY)');
    await raw.query('CREATE TABLE pets (id int PRIMARY KEY, owner_id int NOT NULL REFERENCES owners(id))');
    await raw.query('CREATE INDEX "IDX_UNIQUE_pets_owner" ON pets (owner_id)');
    await raw.query('CREATE TABLE passports (id int PRIMARY KEY, owner_id int NOT NULL REFERENCES owners(id))');
    await raw.query('CREATE UNIQUE INDEX passports_owner_key ON passports (owner_id)');
    await raw.query(
      `INSERT INTO things VALUES (1, 'a', 'n', 'c', 's1'), (2, 'a', 'n', 'c', 's2'), (3, 'b', 'm', 'd', 's3')`,
    );
    // An index NAME that spells a key list over another column.
    await raw.query('CREATE TABLE spoof (id int PRIMARY KEY, kind text, slug text)');
    await raw.query('CREATE UNIQUE INDEX "USING btree (kind)" ON spoof (slug)');
    await raw.query(`INSERT INTO spoof VALUES (1, 'a', 's1'), (2, 'a', 's2')`);
    // A UNIQUE index whose second key is an expression.
    await raw.query('CREATE TABLE expr (id int PRIMARY KEY, kind text, slug text)');
    await raw.query('CREATE UNIQUE INDEX expr_mix ON expr (kind, lower(slug))');
    await raw.query(`INSERT INTO expr VALUES (1, 'a', 's1'), (2, 'a', 's2')`);
    // A column whose NAME ends in an ordering word, under a unique index, beside
    // the foreign key it is named after.
    await raw.query('CREATE TABLE parents (id int PRIMARY KEY)');
    await raw.query(
      'CREATE TABLE children (id int PRIMARY KEY, owner_id int REFERENCES parents(id), "owner_id DESC" int)',
    );
    await raw.query('CREATE UNIQUE INDEX suffix_key ON children ("owner_id DESC")');
    await raw.query('INSERT INTO parents VALUES (1)');
    await raw.query('INSERT INTO children VALUES (1, 1, 11), (2, 1, 12)');
    schema = await introspect({ connectionString: url });
    db = new TurbineClient({ connectionString: url, logging: false }, schema);
  });

  gate.after(async () => {
    try {
      await db?.disconnect();
      await raw?.end();
    } finally {
      await admin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    }
  });

  const rows = async () => (await raw.query('SELECT id, kind, note FROM things ORDER BY id')).rows;

  gate.it('introspection marks only the real unique indexes', () => {
    const flags = Object.fromEntries(schema.tables.things!.indexes.map((i) => [i.name, i.unique]));
    assert.deepEqual(flags, {
      IDX_UNIQUE_kind: false,
      UNIQUE: false,
      things_note_part: false,
      things_pkey: true,
      things_slug_key: true,
    });
  });

  // Relation cardinality reads the same flag: a foreign key is a to-one only
  // when a unique index covers it.
  gate.it('a foreign key under a plain index stays a to-many relation', () => {
    const relations = schema.tables.owners!.relations;
    assert.deepEqual(Object.fromEntries(Object.entries(relations).map(([name, rel]) => [name, rel.type])), {
      passport: 'hasOne',
      pets: 'hasMany',
    });
  });

  for (const column of ['kind', 'note', 'code'] as const) {
    const value = column === 'kind' ? 'a' : column === 'note' ? 'n' : 'c';
    gate.it(`findUnique, update and delete refuse where: { ${column} }, and nothing is written`, async () => {
      const before = await rows();
      const things = db.table('things');
      for (const call of [
        () => things.findUnique({ where: { [column]: value } }),
        () => things.update({ where: { [column]: value }, data: { note: 'changed' } }),
        () => things.delete({ where: { [column]: value } }),
      ]) {
        await assert.rejects(call, (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003');
      }
      assert.deepEqual(await rows(), before);
    });
  }

  gate.it('the real unique index still identifies one row', async () => {
    const things = db.table('things');
    assert.equal(((await things.findUnique({ where: { slug: 's2' } })) as { id: number }).id, 2);
    await things.update({ where: { slug: 's2' }, data: { note: 'only this one' } });
    assert.deepEqual(
      (await rows()).map((r) => r.note),
      ['n', 'only this one', 'm'],
    );
    await things.update({ where: { slug: 's2' }, data: { note: 'n' } });
  });
  const count = async (table: string, where = 'true') =>
    Number((await raw.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n);

  gate.it('a quoted index name does not supply the key list', async () => {
    const index = schema.tables.spoof!.indexes.find((i) => i.name === 'USING btree (kind)');
    assert.deepEqual([index?.columns, index?.unique, index?.partial], [['slug'], true, undefined]);
    const spoof = db.table('spoof');
    for (const call of [
      () => spoof.findUnique({ where: { kind: 'a' } }),
      () => spoof.update({ where: { kind: 'a' }, data: { slug: 'changed' } }),
      () => spoof.delete({ where: { kind: 'a' } }),
    ]) {
      await assert.rejects(call, (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003');
    }
    assert.equal(await count('spoof'), 2);
    assert.equal(await count('spoof', "slug = 'changed'"), 0);
    // The index's real column still identifies one row.
    assert.equal(((await spoof.findUnique({ where: { slug: 's2' } })) as { id: number }).id, 2);
  });

  gate.it('a UNIQUE index with an expression key is not a unique key over its columns', async () => {
    const index = schema.tables.expr!.indexes.find((i) => i.name === 'expr_mix');
    assert.deepEqual([index?.columns, index?.unique], [['kind'], false]);
    assert.match(
      index?.definition ?? '',
      /^CREATE UNIQUE INDEX expr_mix ON public\.expr USING btree \(kind, lower\(slug\)\)$/,
    );
    const expr = db.table('expr');
    for (const call of [
      () => expr.findUnique({ where: { kind: 'a' } }),
      () => expr.update({ where: { kind: 'a' }, data: { slug: 'changed' } }),
      () => expr.delete({ where: { kind: 'a' } }),
      () => expr.upsert({ where: { kind: 'a' }, create: { id: 9, kind: 'a', slug: 'x' }, update: { slug: 'changed' } }),
    ]) {
      await assert.rejects(call, (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003');
    }
    assert.equal(await count('expr'), 2);
    assert.equal(await count('expr', "slug = 'changed'"), 0);
  });

  gate.it('an ordering word inside a quoted column name stays part of the name', async () => {
    const index = schema.tables.children!.indexes.find((i) => i.name === 'suffix_key');
    assert.deepEqual([index?.columns, index?.unique], [['owner_id DESC'], true]);
    // The foreign key is owner_id, which no unique index covers: a to-many.
    const relations = schema.tables.parents!.relations;
    assert.deepEqual(Object.fromEntries(Object.entries(relations).map(([name, rel]) => [name, rel.type])), {
      children: 'hasMany',
    });
    const parents = db.table('parents');
    const parent = (await parents.findUnique({ where: { id: 1 }, with: { children: true } })) as {
      children: { id: number }[];
    };
    assert.deepEqual(parent.children.map((c) => c.id).sort(), [1, 2]);
    // `delete: true` addresses ONE related row, which a to-many does not have.
    await assert.rejects(
      () => parents.update({ where: { id: 1 }, data: { children: { delete: true } } as never }),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
    assert.equal(await count('children'), 2);
  });
});
