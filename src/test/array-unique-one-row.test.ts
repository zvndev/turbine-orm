/**
 * A whole-array equality on a unique ARRAY column identifies one row.
 *
 * Array columns are admitted unique-key types (the generated `WhereUnique`
 * accepts them, `findMany` compiles `col = $1` for a bare array), but the
 * one-row rule only counted scalar equalities, so every operation with a
 * one-row contract (`findUnique`, `update`, `delete`, `upsert`, nested-write
 * `connect`) refused a table whose only reachable key is `text[]` / `int[]`.
 *
 * The discriminating shapes: a bare array and `{ equals: [...] }` on an array
 * column pin the column (an empty array is a value and pins too), while the
 * array OPERATORS (`has`, `hasEvery`, `hasSome`, `isEmpty`) only narrow, and a
 * bare array on a SCALAR unique column is a set, never an identity.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { upsertWhereMatchesCreate, whereIdentifiesOneRow } from '../query/compound-unique.js';
import * as whereMod from '../query/where.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';
import { compileWhere, ctxOf } from './where-core-fixture.js';

/** node:sqlite is a builtin only on Node >= 22.5; probe without a static import. */
const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

/**
 * Mark the `_`-typed columns as arrays, the way introspection (`data_type =
 * 'ARRAY'`) and `defineSchema` (`.array()`) record them. The one-row rule reads
 * that catalog flag as well as the type token, because a scalar type may be
 * named like an array type.
 */
function withArrayFlags(meta: TableMetadata): TableMetadata {
  for (const col of meta.columns) col.isArray = col.pgType.startsWith('_');
  return meta;
}

function arrayKeySchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      docs: withArrayFlags(
        mockTable('docs', [
          { name: 'id', field: 'id' },
          { name: 'email', field: 'email', pgType: 'text', unique: true },
          { name: 'tags', field: 'tags', pgType: '_text', unique: true },
          { name: 'nums', field: 'nums', pgType: '_int4', unique: true },
          { name: 'name', field: 'name', pgType: 'text' },
        ]),
      ),
      pairs: withArrayFlags(
        mockTable(
          'pairs',
          [
            { name: 'tenant_id', field: 'tenantId' },
            { name: 'codes', field: 'codes', pgType: '_int4' },
            { name: 'label', field: 'label', pgType: 'text' },
          ],
          {},
          ['tenant_id', 'codes'],
        ),
      ),
    },
  };
}

const schema = arrayKeySchema();
const docsMeta = schema.tables.docs!;
const pairsMeta = schema.tables.pairs!;

describe('whole-array equality identifies one row', () => {
  const accepted: [string, Record<string, unknown>][] = [
    ['a bare text array', { tags: ['a', 'b'] }],
    ['equals with a text array', { tags: { equals: ['a', 'b'] } }],
    ['equals with mode default', { tags: { equals: ['a'], mode: 'default' } }],
    ['an empty array', { tags: [] }],
    ['equals with an empty array', { tags: { equals: [] } }],
    ['a bare int array', { nums: [1, 2] }],
    // PostgreSQL array equality, and its unique index, treat NULL elements as
    // equal, so one stored array can hold this value.
    ['an array with a null element', { tags: ['a', null] }],
    ['the array key beside a narrowing predicate', { tags: ['a'], name: { contains: 'x' } }],
  ];
  for (const [label, where] of accepted) {
    it(`accepts ${label}`, () => assert.equal(whereIdentifiesOneRow(docsMeta, where), true));
  }

  const refused: [string, Record<string, unknown>][] = [
    ['has', { tags: { has: 'a' } }],
    ['hasEvery', { tags: { hasEvery: ['a', 'b'] } }],
    ['hasSome', { tags: { hasSome: ['a', 'b'] } }],
    ['isEmpty true', { tags: { isEmpty: true } }],
    ['isEmpty false', { tags: { isEmpty: false } }],
    ['an empty hasEvery', { tags: { hasEvery: [] } }],
    ['null', { tags: null }],
    ['equals null', { tags: { equals: null } }],
    ['equals with mode insensitive', { tags: { equals: ['a'], mode: 'insensitive' } }],
    ['in holding one array', { tags: { in: [['a']] } }],
    ['a NaN element', { nums: [Number.NaN] }],
    ['an object element', { tags: [{ a: 1 }] }],
    ['a bare array on a scalar unique column', { email: ['a@b.c'] }],
    ['equals array on a scalar unique column', { email: { equals: ['a@b.c'] } }],
    ['a bare array on the scalar primary key', { id: [1] }],
  ];
  for (const [label, where] of refused) {
    it(`refuses ${label}`, () => assert.equal(whereIdentifiesOneRow(docsMeta, where), false));
  }

  it('a compound key with an array member needs every column', () => {
    assert.equal(whereIdentifiesOneRow(pairsMeta, { codes: [1] }), false);
    assert.equal(whereIdentifiesOneRow(pairsMeta, { tenantId: 1 }), false);
    assert.equal(whereIdentifiesOneRow(pairsMeta, { tenantId: 1, codes: { has: 1 } }), false);
    assert.equal(whereIdentifiesOneRow(pairsMeta, { tenantId: 1, codes: [1, 2] }), true);
    assert.equal(whereIdentifiesOneRow(pairsMeta, { tenantId: 1, codes: { equals: [] } }), true);
  });
});

const docs = () => makeQuery('docs', arrayKeySchema());

describe('the guard at each operation', () => {
  it('buildFindUnique emits whole-array equality with the array as one param', () => {
    const { sql, params } = docs().buildFindUnique({ where: { tags: ['a', 'b'] } } as never);
    assert.match(sql, /"tags" = \$1/);
    assert.deepEqual(params, [['a', 'b']]);
  });

  it('build, cache-hit param collect and fingerprint agree on an array equality', () => {
    const q = docs();
    const first = compileWhere({ tags: ['a', 'b'] }, q);
    assert.match(first.sql ?? '', /"tags" = \$1/);
    assert.deepEqual(first.buildParams, [['a', 'b']]);
    assert.deepEqual(first.collectParams, first.buildParams);
    // A different value (even a different length) is the same SQL shape, so it
    // shares the template and only the collected params move.
    const second = compileWhere({ tags: ['x'] }, q);
    assert.equal(second.fingerprint, first.fingerprint);
    assert.deepEqual(second.collectParams, [['x']]);
    // An array OPERATOR is a different shape and never shares the entry.
    const operator = compileWhere({ tags: { has: 'a' } }, q);
    assert.notEqual(operator.fingerprint, first.fingerprint);
  });

  it('update and delete accept an array key and refuse an array operator', () => {
    assert.match(docs().buildUpdate({ where: { tags: ['a'] }, data: { name: 'n' } } as never).sql, /"tags" = \$\d+/);
    assert.match(docs().buildDelete({ where: { nums: [1] } } as never).sql, /"nums" = \$\d+/);
    assert.throws(
      () => docs().buildDelete({ where: { tags: { has: 'a' } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /delete on "docs" refused/);
        return true;
      },
    );
  });

  it('upsert names the array column as its conflict target', () => {
    const { sql } = docs().buildUpsert({
      where: { tags: ['a', 'b'] },
      create: { tags: ['a', 'b'], name: 'n' },
      update: { name: 'm' },
    } as never);
    assert.match(sql, /ON CONFLICT \("tags"\)/);
  });

  it('a compound selector carrying an array member resolves', () => {
    const q = makeQuery('pairs', arrayKeySchema());
    const { sql, params } = q.buildFindUnique({ where: { tenantId_codes: { tenantId: 1, codes: [7] } } } as never);
    assert.match(sql, /"codes" = \$1 AND "tenant_id" = \$2/);
    assert.deepEqual(params, [[7], 1]);
  });
});

describe('upsert: does one conflict statement mean what the call says', () => {
  it('two distinct arrays with equal elements match', () => {
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: ['a', 'b'] }, { tags: ['a', 'b'] }), true);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: { equals: ['a'] } }, { tags: ['a'] }), true);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { nums: [1, null] }, { nums: [1, null] }), true);
  });

  it('element order and length are part of the value', () => {
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: ['a', 'b'] }, { tags: ['b', 'a'] }), false);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: ['a'] }, { tags: ['a', 'b'] }), false);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: ['a'] }, { name: 'n' }), false);
  });

  it('an array key beside columns that are not one unique key keeps the lookup path', () => {
    // The statement's conflict target is `where`'s columns, and `ON CONFLICT
    // ("id", "tags")` names no unique index (42P10). The lookup path answers
    // it, as it did before arrays compared by value.
    assert.equal(upsertWhereMatchesCreate(docsMeta, { id: 1, tags: ['a'] }, { id: 1, tags: ['a'] }), false);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: ['a'], name: 'n' }, { tags: ['a'], name: 'n' }), false);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: ['a'] }, { id: 1, tags: ['a'] }), true);
    assert.equal(upsertWhereMatchesCreate(pairsMeta, { tenantId: 1, codes: [1] }, { tenantId: 1, codes: [1] }), true);
  });

  it('nested arrays and Date elements compare by value', () => {
    assert.equal(upsertWhereMatchesCreate(docsMeta, { nums: [[1], [2]] }, { nums: [[1], [2]] }), true);
    const at = new Date('2026-01-01T00:00:00Z');
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: [at] }, { tags: [new Date(at.getTime())] }), true);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: [at] }, { tags: [new Date(at.getTime() + 1)] }), false);
  });
});

/** `length` holes, without a sparse array literal. */
function holes(length: number): unknown[] {
  return new Array(length);
}

/** `values` with index `at` turned into a hole. */
function holeAt(values: unknown[], at: number): unknown[] {
  const out = [...values];
  delete out[at];
  return out;
}

const isSparseRefusal = (err: unknown): boolean => {
  assert.ok(err instanceof ValidationError);
  assert.match(err.message, /"tags"/);
  assert.match(err.message, /sparse array/);
  return true;
};

describe('a sparse array is refused, never skipped or read as NULL', () => {
  // `Array.prototype.every` skips a hole while node-postgres binds it as NULL,
  // so `new Array(1)` passed the one-row check, the upsert comparison called it
  // equal to `['other']`, and the server compared `{NULL}`: the upsert updated
  // the `['other']` row. A hole is refused like the `undefined` it reads as,
  // in all three places, at any depth.
  const sparse: [string, unknown[], unknown[]][] = [
    ['new Array(1)', holes(1), [null]],
    ['a hole between elements', holeAt(['a', 'x', 'b'], 1), ['a', null, 'b']],
    ['a hole in a nested array', [['a'], holes(1)], [['a'], [null]]],
  ];
  for (const [label, value, asBound] of sparse) {
    it(`the one-row rule refuses ${label} with E003 naming the column`, () => {
      assert.throws(() => whereIdentifiesOneRow(docsMeta, { tags: value }), isSparseRefusal);
      assert.throws(() => whereIdentifiesOneRow(docsMeta, { tags: { equals: value } }), isSparseRefusal);
      assert.throws(() => docs().buildFindUnique({ where: { tags: value } } as never), isSparseRefusal);
    });

    it(`the upsert comparison never calls ${label} equal`, () => {
      // Neither to what the driver would bind for it, nor to the value the
      // skipping comparison used to accept, nor to itself.
      for (const other of [asBound, ['other'], value]) {
        assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: value }, { tags: other }), false);
        assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: other }, { tags: value }), false);
      }
      assert.equal(docs().upsertNeedsLookup({ where: { tags: value }, create: { tags: ['other'] } } as never), true);
    });

    it(`the where compiler refuses ${label}, cold and on a warm template`, () => {
      assert.throws(() => docs().buildFindMany({ where: { tags: value } } as never), isSparseRefusal);
      assert.throws(() => docs().buildFindMany({ where: { tags: { equals: value } } } as never), isSparseRefusal);
      // A dense array of the same length has the same fingerprint, so a warm
      // template would serve the sparse one: the cache-hit param collect must
      // refuse it too.
      const q = docs();
      const dense = compileWhere({ tags: asBound }, q);
      assert.equal(whereMod.fingerprintWhere(ctxOf(q), { tags: value }), dense.fingerprint);
      assert.throws(() => whereMod.collectWhereParams(ctxOf(q), { tags: value }, []), isSparseRefusal);
    });
  }

  it('an explicit null element is a value, not a hole', () => {
    assert.equal(whereIdentifiesOneRow(docsMeta, { tags: [null] }), true);
    assert.equal(upsertWhereMatchesCreate(docsMeta, { tags: [null] }, { tags: [null] }), true);
  });
});

describe('a column NAMED like an array type is not an array column', () => {
  // `CREATE TYPE _mood AS ENUM (...)` is a scalar type whose name starts with
  // an underscore; introspection records `isArray: false` for it. An array
  // value there never identifies a row (it would bind as the text `{"x"}`).
  const meta = mockTable('labels', [
    { name: 'id', field: 'id' },
    { name: 'mood', field: 'mood', pgType: '_mood', unique: true },
  ]);
  meta.columns[1]!.isArray = false;
  it('an array value never pins it', () => {
    assert.equal(whereIdentifiesOneRow(meta, { mood: ['x'] }), false);
    assert.equal(whereIdentifiesOneRow(meta, { mood: { equals: ['x'] } }), false);
    assert.equal(whereIdentifiesOneRow(meta, { mood: [] }), false);
    assert.equal(upsertWhereMatchesCreate(meta, { mood: ['x'] }, { mood: ['x'] }), false);
  });
  it('a scalar value still pins it', () => {
    assert.equal(whereIdentifiesOneRow(meta, { mood: 'x' }), true);
  });
  it('a type token that names no array type is not an array column, whatever the flag says', () => {
    const custom = withArrayFlags(
      mockTable('labels', [
        { name: 'id', field: 'id' },
        { name: 'mood', field: 'mood', pgType: 'text', unique: true },
      ]),
    );
    custom.columns[1]!.isArray = true;
    assert.equal(whereIdentifiesOneRow(custom, { mood: ['x'] }), false);
  });
});

describe('a JSON array keeps the baseline upsert decision on every engine', () => {
  // The element-by-element comparison is for array columns. A JSON column
  // compares a JSON array by identity, as before, so `where` beside a JSON
  // `equals` keeps the lookup path (and `buildUpsert` keeps refusing it)
  // instead of emitting `ON CONFLICT ("id", "j")`, which PostgreSQL rejects
  // with 42P10 because no unique index covers the JSON column.
  const jsonSchema = (): SchemaMetadata => ({
    enums: {},
    tables: {
      docs: mockTable('docs', [
        { name: 'id', field: 'id' },
        { name: 'j', field: 'j', pgType: 'jsonb' },
        { name: 'note', field: 'note', pgType: 'text' },
      ]),
    },
  });
  const args = { where: { id: 1, j: { equals: [1] } }, create: { id: 1, j: [1], note: 'n' }, update: { note: 'u' } };
  for (const dialect of [postgresDialect, mysqlDialect, sqliteDialect, mssqlDialect]) {
    it(`${dialect.name}: looks the row up, and the statement form refuses`, () => {
      const q = makeQuery('docs', jsonSchema(), { dialect });
      assert.equal(upsertWhereMatchesCreate(jsonSchema().tables.docs!, args.where, args.create), false);
      assert.equal(q.upsertNeedsLookup(args as never), true);
      assert.throws(
        () => q.buildUpsert(args as never),
        (err: unknown) => err instanceof ValidationError,
      );
    });
  }

  sqliteGate.it('sqlite, live: keeps its typed refusal of whole-document equality', async () => {
    const meta = schemaDefToMetadata(
      defineSchema({
        docs: { id: { type: 'integer', primaryKey: true }, j: { type: 'jsonb' }, note: { type: 'text' } },
      }),
    );
    const db = await turbineSqlite(':memory:', meta);
    try {
      await db.rawUnsafe('CREATE TABLE docs (id INTEGER PRIMARY KEY, j TEXT, note TEXT)');
      await db.table('docs').create({ data: { id: 1, j: [1], note: 'before' } });
      await assert.rejects(
        () => db.table('docs').upsert(args as never),
        (err: unknown) => err instanceof UnsupportedFeatureError,
      );
      assert.deepEqual(await db.rawUnsafe('SELECT note FROM docs'), [{ note: 'before' }]);
    } finally {
      await db.disconnect();
    }
  });
});

describe('PowDB refuses an array key with a typed error, never silently', () => {
  it('findUnique rejects before any query is sent', async () => {
    const calls: string[] = [];
    const pool = {
      query(text: string) {
        calls.push(text);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as PowdbPool;
    const qi = new PowqlInterface(pool, 'docs', arrayKeySchema(), [], { warnOnUnlimited: false }) as unknown as {
      findUnique(args: { where: Record<string, unknown> }): Promise<unknown>;
    };
    await assert.rejects(
      () => qi.findUnique({ where: { tags: ['a'] } }),
      (err: unknown) => err instanceof ValidationError,
    );
    await assert.rejects(
      () => qi.findUnique({ where: { tags: { equals: ['a'] } } }),
      (err: unknown) => err instanceof ValidationError,
    );
    assert.deepEqual(calls, []);
  });
});
