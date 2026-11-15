/**
 * turbine-orm, a unique array column identifies one row (live Postgres)
 *
 * `findUnique({ where: { tags: ['a', 'b'] } })` on a `text[] UNIQUE` column
 * refused with E003 ("does not identify a single row") even though the same
 * predicate in `findMany` compiles to whole-array equality and PostgreSQL's
 * unique index admits exactly one row per array value (NULL elements compare
 * equal). Every consumer of the one-row rule is exercised against the real
 * server: the findUnique family, update, delete, upsert (single-statement
 * `ON CONFLICT` on the array column) and nested-write connect /
 * connectOrCreate. Array operators must keep refusing.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/array-unique.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping array-unique integration tests: DATABASE_URL not set');
}

const DDL = `
DROP TABLE IF EXISTS egau_holder CASCADE;
DROP TABLE IF EXISTS egau_comp CASCADE;
DROP TABLE IF EXISTS egau_doc CASCADE;
DROP TABLE IF EXISTS egau_sparse CASCADE;
DROP TABLE IF EXISTS egau_json CASCADE;
DROP TABLE IF EXISTS egau_named_kid, egau_named CASCADE;
DROP TABLE IF EXISTS egau_ggrand, egau_gkid, egau_gparent CASCADE;
DROP TYPE IF EXISTS _egau_scalar;
CREATE TABLE egau_doc (
  id    SERIAL PRIMARY KEY,
  tags  TEXT[] UNIQUE,
  nums  INTEGER[] UNIQUE,
  label TEXT
);
CREATE TABLE egau_comp (
  id     SERIAL PRIMARY KEY,
  tenant TEXT,
  codes  INTEGER[],
  label  TEXT,
  UNIQUE (tenant, codes)
);
CREATE TABLE egau_holder (
  id     SERIAL PRIMARY KEY,
  doc_id INTEGER REFERENCES egau_doc(id),
  name   TEXT
);
CREATE TABLE egau_sparse (
  id   SERIAL PRIMARY KEY,
  t    TEXT[] UNIQUE,
  note TEXT
);
INSERT INTO egau_sparse (t, note) VALUES (ARRAY[NULL]::text[], 'null-row'), (ARRAY['other'], 'other-row');
CREATE TABLE egau_json (
  id   INTEGER PRIMARY KEY,
  j    JSONB,
  note TEXT
);
INSERT INTO egau_json VALUES (1, '[1]', 'before');
-- A SCALAR type whose name starts with an underscore, holding a label that
-- reads like an array literal.
CREATE TYPE _egau_scalar AS ENUM ('x', '{"x"}');
CREATE TABLE egau_named (
  id   SERIAL PRIMARY KEY,
  s    _egau_scalar UNIQUE,
  note TEXT
);
INSERT INTO egau_named (s, note) VALUES ('{"x"}', 'scalar-label');
CREATE TABLE egau_named_kid (
  id       SERIAL PRIMARY KEY,
  named_id INTEGER REFERENCES egau_named(id),
  s        _egau_scalar
);
-- Children whose JSON columns are named like nested-write operations.
CREATE TABLE egau_gparent (id INTEGER PRIMARY KEY, note TEXT);
CREATE TABLE egau_gkid (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES egau_gparent(id),
  tags      TEXT[],
  data      JSONB,
  "create"  JSONB
);
CREATE TABLE egau_ggrand (
  id       INTEGER PRIMARY KEY,
  kid_id   INTEGER REFERENCES egau_gkid(id),
  tags     TEXT[],
  data     JSONB,
  "update" JSONB
);
INSERT INTO egau_gparent VALUES (1, 'before');
INSERT INTO egau_gkid VALUES (1, 1, ARRAY['a'], '[]', '[]');
INSERT INTO egau_ggrand VALUES (1, 1, ARRAY['a'], '[]', '[]');
`;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

let raw: pg.Client;
let db: TurbineClient;
let schema: SchemaMetadata;

const doc = () => db.table<Record<string, unknown>>('egau_doc');
const comp = () => db.table<Record<string, unknown>>('egau_comp');
const holder = () => db.table<Record<string, unknown>>('egau_holder');

/** The introspected belongsTo relation name from the holder to the doc. */
function docRelation(): string {
  const rels = schema.tables.egau_holder!.relations;
  const name = Object.keys(rels).find((k) => rels[k]!.to === 'egau_doc');
  assert.ok(name, 'introspection found no holder -> doc relation');
  return name;
}

describe('a unique array column identifies one row (live Postgres)', () => {
  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL as string });
    db = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 3 }, schema);
    await db.connect();
    await doc().create({ data: { tags: ['a', 'b'], nums: [1, 2], label: 'one' } });
    await doc().create({ data: { tags: [], nums: [], label: 'empty' } });
    await doc().create({ data: { tags: ['a', null], nums: [3], label: 'null-elem' } });
    await comp().create({ data: { tenant: 'acme', codes: [7, 8], label: 'pair' } });
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query(
      'DROP TABLE IF EXISTS egau_holder CASCADE; DROP TABLE IF EXISTS egau_comp CASCADE; DROP TABLE IF EXISTS egau_doc CASCADE; ' +
        'DROP TABLE IF EXISTS egau_sparse, egau_json, egau_named_kid, egau_named, egau_ggrand, egau_gkid, egau_gparent CASCADE; ' +
        'DROP TYPE IF EXISTS _egau_scalar',
    );
    await raw?.end();
  });

  it('finds the row by a unique text[] column, bare and equals', async () => {
    const bare = await doc().findUnique({ where: { tags: ['a', 'b'] } });
    assert.equal(bare?.label, 'one');
    const equals = await doc().findUnique({ where: { tags: { equals: ['a', 'b'] } } });
    assert.equal(equals?.label, 'one');
  });

  it('finds the row by a unique int[] column', async () => {
    const row = await doc().findUnique({ where: { nums: [1, 2] } });
    assert.equal(row?.label, 'one');
    assert.deepEqual(row?.tags, ['a', 'b']);
  });

  it('an empty array is a value and identifies its row', async () => {
    assert.equal((await doc().findUnique({ where: { tags: [] } }))?.label, 'empty');
    assert.equal((await doc().findUnique({ where: { nums: [] } }))?.label, 'empty');
  });

  it('an array with a null element identifies its row', async () => {
    assert.equal((await doc().findUnique({ where: { tags: ['a', null] } }))?.label, 'null-elem');
  });

  it('a value no row holds returns null, and OrThrow throws NotFound', async () => {
    assert.equal(await doc().findUnique({ where: { tags: ['nope'] } }), null);
    assert.equal((await doc().findUniqueOrThrow({ where: { nums: [1, 2] } })).label, 'one');
    await assert.rejects(
      () => doc().findUniqueOrThrow({ where: { tags: ['nope'] } }),
      (err: unknown) => err instanceof NotFoundError,
    );
  });

  it('agrees with findFirst, across a warmed template cache', async () => {
    for (const tags of [['a', 'b'], [], ['a', null], ['nope']] as unknown[][]) {
      const viaUnique = await doc().findUnique({ where: { tags } });
      const viaFirst = await doc().findFirst({ where: { tags } });
      assert.deepEqual(viaUnique, viaFirst);
    }
    // Second pass runs on the cache-hit param collect, a separate walk.
    assert.equal((await doc().findUnique({ where: { tags: [] } }))?.label, 'empty');
    assert.equal((await doc().findUnique({ where: { tags: ['a', 'b'] } }))?.label, 'one');
  });

  it('array operators and null still refuse as non-identifying', async () => {
    for (const where of [
      { tags: { has: 'a' } },
      { tags: { hasEvery: ['a', 'b'] } },
      { tags: { hasSome: ['a'] } },
      { tags: { isEmpty: true } },
      { tags: null },
    ]) {
      await assert.rejects(
        () => doc().findUnique({ where: where as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError);
          assert.match(err.message, /does not identify a single row/);
          return true;
        },
      );
    }
  });

  it('a compound unique key with an array member, flat and by selector', async () => {
    assert.equal((await comp().findUnique({ where: { tenant: 'acme', codes: [7, 8] } }))?.label, 'pair');
    assert.equal(
      (await comp().findUnique({ where: { tenant_codes: { tenant: 'acme', codes: [7, 8] } } as never }))?.label,
      'pair',
    );
    assert.equal(await comp().findUnique({ where: { tenant: 'acme', codes: [8, 7] } }), null);
  });

  it('update and delete take the array key', async () => {
    const updated = await doc().update({ where: { nums: [3] }, data: { label: 'renamed' } });
    assert.equal(updated.label, 'renamed');
    const victim = await doc().create({ data: { tags: ['gone'], nums: [99], label: 'victim' } });
    const deleted = await doc().delete({ where: { tags: ['gone'] } });
    assert.equal(deleted.label, 'victim');
    assert.equal(await doc().findUnique({ where: { id: victim.id } }), null);
  });

  it('upsert inserts then updates on the array conflict target', async () => {
    const created = await doc().upsert({
      where: { tags: ['up'] },
      create: { tags: ['up'], nums: [5], label: 'first' },
      update: { label: 'second' },
    });
    assert.equal(created.label, 'first');
    const again = await doc().upsert({
      where: { tags: ['up'] },
      create: { tags: ['up'], nums: [5], label: 'first' },
      update: { label: 'second' },
    });
    assert.equal(again.label, 'second');
    assert.equal(again.id, created.id);
    const r = await raw.query(`SELECT count(*)::int AS n FROM egau_doc WHERE tags = '{up}'`);
    assert.equal(r.rows[0].n, 1);
  });

  it('upsert with the array key beside the primary key updates through the lookup', async () => {
    // `ON CONFLICT ("id", "tags")` names no unique index (42P10).
    const one = await doc().findUniqueOrThrow({ where: { tags: ['a', 'b'] } });
    const row = await doc().upsert({
      where: { id: one.id, tags: ['a', 'b'] },
      create: { id: one.id, tags: ['a', 'b'], label: 'create' },
      update: { label: 'beside-pk' },
    });
    assert.equal(row.id, one.id);
    assert.equal(row.label, 'beside-pk');
    await doc().update({ where: { id: one.id }, data: { label: one.label } });
  });

  it('nested connect and connectOrCreate resolve by the array key', async () => {
    const rel = docRelation();
    const connected = await holder().create({
      data: { name: 'h1', [rel]: { connect: { tags: ['a', 'b'] } } } as never,
    });
    const one = await doc().findUnique({ where: { tags: ['a', 'b'] } });
    assert.equal(connected.docId, one?.id);

    const made = await holder().create({
      data: {
        name: 'h2',
        [rel]: {
          connectOrCreate: { where: { tags: ['fresh'] }, create: { tags: ['fresh'], nums: [6], label: 'made' } },
        },
      } as never,
    });
    const fresh = await doc().findUnique({ where: { tags: ['fresh'] } });
    assert.equal(fresh?.label, 'made');
    assert.equal(made.docId, fresh?.id);
  });

  it('a sparse where is refused and no row is written', async () => {
    // node-postgres binds the hole as NULL, so this `where` means the
    // `{NULL}` row; a check that skipped the hole called it equal to
    // `create`'s `['other']` and updated the OTHER row.
    const sparse = () => db.table<Record<string, unknown>>('egau_sparse');
    await assert.rejects(
      () =>
        sparse().upsert({
          where: { t: new Array(1) },
          create: { t: ['other'], note: 'create' },
          update: { note: 'WRONG-ROW' },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /sparse array/);
        return true;
      },
    );
    await assert.rejects(
      () => sparse().findUnique({ where: { t: new Array(1) } }),
      (err: unknown) => err instanceof ValidationError,
    );
    const rows = await raw.query('SELECT t, note FROM egau_sparse ORDER BY id');
    assert.deepEqual(rows.rows, [
      { t: [null], note: 'null-row' },
      { t: ['other'], note: 'other-row' },
    ]);
  });

  it('a sparse array in write data is refused, at any depth, and nothing is written', async () => {
    const sparse = () => db.table<Record<string, unknown>>('egau_sparse');
    const refusesT = (field: string) => (err: unknown) => {
      assert.ok(err instanceof ValidationError, String(err));
      assert.ok(err.message.includes(`"${field}"`), err.message);
      assert.match(err.message, /sparse array/);
      return true;
    };
    for (const value of [new Array(1), [['a'], new Array(1)]]) {
      await assert.rejects(
        () =>
          sparse().upsert({ where: { t: ['absent'] }, create: { t: value, note: 'inserted' }, update: { note: 'u' } }),
        refusesT('t'),
      );
      await assert.rejects(() => sparse().create({ data: { t: value, note: 'created' } }), refusesT('t'));
      await assert.rejects(() => sparse().createMany({ data: [{ t: ['x'] }, { t: value }] }), refusesT('t'));
      await assert.rejects(
        () => sparse().updateMany({ where: { note: 'other-row' }, data: { t: { set: value } } }),
        refusesT('t'),
      );
      // A nested write: the parent row is never inserted either.
      await assert.rejects(
        () => holder().create({ data: { name: 'nested', [docRelation()]: { create: { tags: value, label: 'x' } } } }),
        refusesT('tags'),
      );
    }
    const rows = await raw.query('SELECT t, note FROM egau_sparse ORDER BY id');
    assert.deepEqual(rows.rows, [
      { t: [null], note: 'null-row' },
      { t: ['other'], note: 'other-row' },
    ]);
    const nested = await raw.query("SELECT count(*)::int AS n FROM egau_holder WHERE name = 'nested'");
    assert.equal(nested.rows[0].n, 0);
  });

  it('a sparse array in a nested write is refused before any statement, beside columns named data / create / update', async () => {
    // Reading `{ update: { where, data } }` as a row of a table with a `data`
    // column stopped at the wrapper, so the parent's UPDATE ran first.
    const rel = (from: string, to: string) => {
      const rels = schema.tables[from]!.relations;
      const name = Object.keys(rels).find((k) => rels[k]!.to === to);
      assert.ok(name, `introspection found no ${from} -> ${to} relation`);
      return name;
    };
    const kids = rel('egau_gparent', 'egau_gkid');
    const grands = rel('egau_gkid', 'egau_ggrand');
    const parent = () => db.table<Record<string, unknown>>('egau_gparent');
    const sent: string[] = [];
    const record = (e: { sql: string }) => sent.push(e.sql);
    db.$on('query', record);
    const refusesTags = (err: unknown) => {
      assert.ok(err instanceof ValidationError, String(err));
      assert.ok(err.message.includes('"tags"'), err.message);
      assert.match(err.message, /sparse array/);
      return true;
    };
    for (const make of [() => new Array(1), () => [['a'], new Array(1)]]) {
      const writes: (() => Promise<unknown>)[] = [
        () =>
          parent().update({
            where: { id: 1 },
            data: { note: 'effect', [kids]: { update: { where: { id: 1 }, data: { tags: make() } } } },
          }),
        () =>
          parent().update({
            where: { id: 1 },
            data: {
              note: 'effect',
              [kids]: {
                update: {
                  where: { id: 1 },
                  data: { [grands]: { update: { where: { id: 1 }, data: { tags: make(), update: [1] } } } },
                },
              },
            },
          }),
        () =>
          parent().update({
            where: { id: 1 },
            data: {
              note: 'effect',
              [kids]: { upsert: { where: { id: 2 }, create: { id: 2, tags: make() }, update: {} } },
            },
          }),
        () =>
          parent().create({ data: { id: 2, note: 'new', [kids]: { create: { id: 3, create: [1], tags: make() } } } }),
      ];
      for (const write of writes) {
        sent.length = 0;
        await assert.rejects(write, refusesTags);
        assert.deepEqual(sent, []);
      }
    }
    db.$off('query', record);
    const { rows } = await raw.query('SELECT id, note FROM egau_gparent ORDER BY id');
    assert.deepEqual(rows, [{ id: 1, note: 'before' }]);

    // A hole in a JSON column, `data` included, is still JSON null at every level.
    await parent().create({
      data: {
        id: 3,
        note: 'json',
        [kids]: { create: { id: 4, data: [['a'], new Array(1)], [grands]: { create: { id: 4, data: new Array(1) } } } },
      },
    });
    const kid = await raw.query('SELECT data FROM egau_gkid WHERE id = 4');
    assert.deepEqual(kid.rows[0].data, [['a'], [null]]);
    const grand = await raw.query('SELECT data FROM egau_ggrand WHERE id = 4');
    assert.deepEqual(grand.rows[0].data, [null]);
  });

  it('a sparse array written to a JSON column is stored as JSON does it', async () => {
    const json = () => db.table<Record<string, unknown>>('egau_json');
    await json().create({ data: { id: 2, j: Object.assign(new Array(3), { 0: 1, 2: 3 }), note: 'json' } });
    const { rows } = await raw.query('SELECT j FROM egau_json WHERE id = 2');
    assert.deepEqual(rows[0].j, [1, null, 3]);
  });

  it('a JSON array beside the key keeps the lookup path', async () => {
    // Comparing the JSON arrays element by element sent `ON CONFLICT ("id",
    // "j")`, which names no unique index: SQLSTATE 42P10.
    const row = await db.table<Record<string, unknown>>('egau_json').upsert({
      where: { id: 1, j: { equals: [1] } },
      create: { id: 1, j: [1], note: 'create' },
      update: { note: 'after' },
    });
    assert.equal(row.note, 'after');
  });

  it('an array value on a scalar type named like an array type identifies no row', async () => {
    const named = () => db.table<Record<string, unknown>>('egau_named');
    assert.equal(schema.tables.egau_named!.columns.find((c) => c.name === 's')?.isArray, false);
    await assert.rejects(
      () => named().findUnique({ where: { s: ['x'] } }),
      (err: unknown) => {
        // Refused as an operand (the compiler and the one-row rule agree it
        // is not an array column), before the one-row check is reached.
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /Invalid value on "s"/);
        return true;
      },
    );
    assert.equal((await named().findUnique({ where: { s: '{"x"}' } }))?.note, 'scalar-label');
  });

  it('nor is it an operand anywhere: reads and bulk writes refuse it, and the row is unchanged', async () => {
    const named = () => db.table<Record<string, unknown>>('egau_named');
    const refusesS = (err: unknown) => {
      assert.ok(err instanceof ValidationError, String(err));
      assert.match(err.message, /"s"/);
      return true;
    };
    // The array would bind as the text `{"x"}`, which is the scalar label
    // stored here, so a read matched it and a bulk update changed it.
    await assert.rejects(() => named().findMany({ where: { s: ['x'] } }), refusesS);
    await assert.rejects(() => named().count({ where: { s: { equals: ['x'] } } }), refusesS);
    await assert.rejects(() => named().updateMany({ where: { s: ['x'] }, data: { note: 'changed' } }), refusesS);
    await assert.rejects(() => named().deleteMany({ where: { s: ['x'] } }), refusesS);
    const { rows } = await raw.query('SELECT s::text AS s, note FROM egau_named');
    assert.deepEqual(rows, [{ s: '{"x"}', note: 'scalar-label' }]);
  });

  it('nor is it written: every write path refuses an array for it before any statement, and nothing changes', async () => {
    const named = () => db.table<Record<string, unknown>>('egau_named');
    const kids = Object.keys(schema.tables.egau_named!.relations).find(
      (k) => schema.tables.egau_named!.relations[k]!.to === 'egau_named_kid',
    );
    assert.ok(kids, 'introspection found no egau_named -> egau_named_kid relation');
    const refuses = (table: string) => (err: unknown) => {
      assert.ok(err instanceof ValidationError, String(err));
      assert.ok(err.message.includes(`Cannot write an array to "${table}.s" (column type _egau_scalar)`), err.message);
      return true;
    };
    const sent: string[] = [];
    const record = (e: { sql: string }) => sent.push(e.sql);
    db.$on('query', record);
    // A one-row write stored the label `{"x"}`; createMany's UNNEST stored `x`.
    for (const value of [['x'], ['{"x"}']]) {
      const writes: [string, () => Promise<unknown>][] = [
        ['egau_named', () => named().create({ data: { s: value, note: 'created' } })],
        ['egau_named', () => named().createMany({ data: [{ s: value, note: 'many' }] })],
        ['egau_named', () => named().update({ where: { id: 1 }, data: { s: value } })],
        ['egau_named', () => named().update({ where: { id: 1 }, data: { s: { set: value } } })],
        ['egau_named', () => named().updateMany({ where: { note: 'scalar-label' }, data: { s: value } })],
        ['egau_named', () => named().upsert({ where: { id: 1 }, create: { s: value }, update: { note: 'u' } })],
        ['egau_named', () => named().upsert({ where: { id: 1 }, create: { note: 'c' }, update: { s: value } })],
        [
          'egau_named_kid',
          () => named().update({ where: { id: 1 }, data: { note: 'effect', [kids]: { create: { s: value } } } }),
        ],
      ];
      for (const [table, write] of writes) {
        sent.length = 0;
        await assert.rejects(write, refuses(table));
        assert.deepEqual(sent, []);
      }
    }
    db.$off('query', record);
    const { rows } = await raw.query('SELECT s::text AS s, note FROM egau_named ORDER BY id');
    assert.deepEqual(rows, [{ s: '{"x"}', note: 'scalar-label' }]);
    assert.equal((await raw.query('SELECT count(*)::int AS n FROM egau_named_kid')).rows[0].n, 0);

    // A label is still written as a label, through every bulk and nested path.
    await named().createMany({ data: [{ s: 'x', note: 'label' }] });
    await named().update({ where: { id: 1 }, data: { [kids]: { create: { s: 'x' } } } });
    const labels = await raw.query(
      "SELECT (SELECT s::text FROM egau_named WHERE note = 'label') AS one, (SELECT s::text FROM egau_named_kid) AS kid",
    );
    assert.deepEqual(labels.rows, [{ one: 'x', kid: 'x' }]);
    await raw.query("DELETE FROM egau_named_kid; DELETE FROM egau_named WHERE note = 'label'");
  });

  it('metadata that carries the array type only in a table map, or as text[], keys the row too', async () => {
    const variants: [string, (s: SchemaMetadata) => void][] = [
      [
        'type only in the maps',
        (s) => {
          const col = s.tables.egau_doc!.columns.find((c) => c.name === 'tags')!;
          delete (col as { pgType?: string }).pgType;
          delete col.dialectType;
        },
      ],
      [
        'the suffix spelling text[]',
        (s) => {
          const t = s.tables.egau_doc!;
          const col = t.columns.find((c) => c.name === 'tags')!;
          col.pgType = 'text[]';
          col.dialectType = 'text[]';
          if (t.pgTypes) t.pgTypes.tags = 'text[]';
          if (t.dialectTypes) t.dialectTypes.tags = 'text[]';
        },
      ],
    ];
    for (const [label, change] of variants) {
      const variant = structuredClone(schema);
      change(variant);
      const own = new TurbineClient({ connectionString: DATABASE_URL as string, poolSize: 1 }, variant);
      try {
        const table = own.table<Record<string, unknown>>('egau_doc');
        assert.equal((await table.findUnique({ where: { tags: ['a', 'b'] } }))?.label, 'one', label);
        assert.equal((await table.findUnique({ where: { tags: { equals: [] } } }))?.label, 'empty', label);
        assert.equal((await table.findMany({ where: { tags: { has: 'b' } } })).length, 1, label);
      } finally {
        await own.disconnect();
      }
    }
  });
});
