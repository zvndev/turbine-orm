/**
 * turbine-orm, build-level parity between the two accepted spellings of a key
 *
 * `toColumn` accepts a key spelled as the camelCase FIELD or as the snake_case
 * COLUMN, so both compile to the same SQL. Every value-side pass has to resolve
 * a key the SAME way or the two silently disagree: the write coercion used to
 * read `columnMap` alone (field spelling only), so a column-spelled key emitted
 * a byte-identical statement with an unprocessed `Date` bound to it, and the
 * `updatedAt` injector matched the field spelling only, so a column-spelled key
 * assigned the same column twice.
 *
 * The assertion shape is deliberate and is what keeps this class dead: run each
 * surface twice, once per spelling, and require identical SQL AND identical
 * params. The first block additionally PINS the field-spelled output, so the
 * spelling that always worked is proven byte-for-byte unchanged rather than
 * merely equal to its own new sibling.
 *
 * Live stored-value proof: column-key-write-parity.integration.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { injectForeignKey } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Schema: every field name differs from its column name where it can.
// ---------------------------------------------------------------------------

const scheduleTable = mockTable('report_schedule', [
  { name: 'id', field: 'id', pgType: 'int4' },
  { name: 'last_run', field: 'lastRun', pgType: 'timestamp' },
  { name: 'day', field: 'day', pgType: 'date' },
  { name: 'tz', field: 'tz', pgType: 'timestamptz' },
  { name: 'ran_stamps', field: 'ranStamps', pgType: '_timestamp' },
  { name: 'counter', field: 'counter', pgType: 'int4' },
]);

const docTable = mockTable('doc', [
  { name: 'id', field: 'id', pgType: 'int4' },
  { name: 'body', field: 'body', pgType: 'text' },
  { name: 'updated_at', field: 'updatedAt', pgType: 'timestamp' },
]);
docTable.columns.find((c) => c.name === 'updated_at')!.updatedAt = true;

const schema = {
  tables: { report_schedule: scheduleTable, doc: docTable },
  enums: {},
} as unknown as SchemaMetadata;

const V = new Date('2026-03-15T00:30:00Z');
const V2 = new Date('2026-03-16T00:30:00Z');
/** What the temporal rewrite must produce, whatever the process zone. */
const TS = '2026-03-15 00:30:00';
const TS2 = '2026-03-16 00:30:00';
const DAY = '2026-03-15';
/** `timestamptz` stores a real instant, so its bind is the Date, untouched. */
const TZ = V;

const q = (table = 'report_schedule') => makeQuery<Record<string, unknown>>(table, schema);

/** The same payload under the FIELD spelling and under the COLUMN spelling. */
const BY_FIELD = { lastRun: V, day: V, tz: V, ranStamps: [V, V2] };
const BY_COLUMN = { last_run: V, day: V, tz: V, ran_stamps: [V, V2] };

type Built = { sql: string; params: unknown[] };

/** Every write surface, built from one `data`-shaped payload. */
const SURFACES: { name: string; build: (data: Record<string, unknown>) => Built }[] = [
  { name: 'create', build: (data) => q().buildCreate({ data }) },
  { name: 'createMany', build: (data) => q().buildCreateMany({ data: [data, data] }) },
  { name: 'update', build: (data) => q().buildUpdate({ where: { id: 1 }, data }) },
  { name: 'updateMany', build: (data) => q().buildUpdateMany({ where: { id: 1 }, data }) },
  { name: 'upsert', build: (data) => q().buildUpsert({ where: { id: 1 }, create: data, update: data }) },
  {
    name: 'update { set }',
    build: (data) =>
      q().buildUpdate({
        where: { id: 1 },
        data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { set: v }])),
      }),
  },
];

describe('column-key parity: write surfaces bind the same params under either spelling', () => {
  for (const surface of SURFACES) {
    it(`${surface.name} is identical field-spelled and column-spelled`, () => {
      const byField = surface.build({ ...BY_FIELD });
      const byColumn = surface.build({ ...BY_COLUMN });
      assert.equal(byColumn.sql, byField.sql, `${surface.name}: SQL differs`);
      assert.deepStrictEqual(byColumn.params, byField.params, `${surface.name}: bound params differ`);
    });
  }

  it('the coerced values are the UTC literals, not the driver serialization', () => {
    // The parity assertions above would also pass if BOTH spellings skipped the
    // rewrite, so pin the values themselves once.
    const { params } = q().buildCreate({ data: { ...BY_COLUMN } });
    assert.deepStrictEqual(params, [TS, DAY, TZ, [TS, TS2]]);
  });
});

describe('column-key parity: the field-spelled output is unchanged, byte for byte', () => {
  const cases: { name: string; built: Built; sql: string; params: unknown[] }[] = [
    {
      name: 'create',
      built: q().buildCreate({ data: { ...BY_FIELD } }),
      sql: 'INSERT INTO "report_schedule" ("last_run", "day", "tz", "ran_stamps") VALUES ($1, $2, $3, $4) RETURNING *',
      params: [TS, DAY, TZ, [TS, TS2]],
    },
    {
      // An array-typed column forces the row-major VALUES form (UNNEST would
      // flatten it), so both createMany shapes are pinned.
      name: 'createMany (array column)',
      built: q().buildCreateMany({ data: [{ ...BY_FIELD }] }),
      sql: 'INSERT INTO "report_schedule" ("last_run", "day", "tz", "ran_stamps") VALUES ($1, $2, $3, $4) RETURNING *',
      params: [TS, DAY, TZ, [TS, TS2]],
    },
    {
      name: 'createMany (column-major UNNEST)',
      built: q().buildCreateMany({
        data: [
          { lastRun: V, day: V },
          { lastRun: V2, day: V2 },
        ],
      }),
      sql:
        'INSERT INTO "report_schedule" ("last_run", "day") ' +
        'SELECT * FROM UNNEST($1::timestamp[], $2::date[]) RETURNING *',
      params: [
        [TS, TS2],
        [DAY, '2026-03-16'],
      ],
    },
    {
      name: 'update',
      built: q().buildUpdate({ where: { id: 1 }, data: { ...BY_FIELD } }),
      sql: 'UPDATE "report_schedule" SET "last_run" = $1, "day" = $2, "tz" = $3, "ran_stamps" = $4 WHERE "id" = $5 RETURNING *',
      params: [TS, DAY, TZ, [TS, TS2], 1],
    },
    {
      name: 'updateMany',
      built: q().buildUpdateMany({ where: { id: 1 }, data: { ...BY_FIELD } }),
      sql: 'UPDATE "report_schedule" SET "last_run" = $1, "day" = $2, "tz" = $3, "ran_stamps" = $4 WHERE "id" = $5',
      params: [TS, DAY, TZ, [TS, TS2], 1],
    },
    {
      name: 'upsert',
      built: q().buildUpsert({ where: { id: 1 }, create: { ...BY_FIELD }, update: { ...BY_FIELD } }),
      sql:
        'INSERT INTO "report_schedule" ("last_run", "day", "tz", "ran_stamps") VALUES ($1, $2, $3, $4) ' +
        'ON CONFLICT ("id") DO UPDATE SET "last_run" = $5, "day" = $6, "tz" = $7, "ran_stamps" = $8 RETURNING *',
      params: [TS, DAY, TZ, [TS, TS2], TS, DAY, TZ, [TS, TS2]],
    },
  ];

  for (const c of cases) {
    it(`${c.name} emits the pinned SQL and params`, () => {
      assert.equal(c.built.sql, c.sql);
      assert.deepStrictEqual(c.built.params, c.params);
    });
  }
});

describe('column-key parity: the cache-hit param collector agrees with the build', () => {
  it('a second update with the same shape binds the same params', () => {
    // The first call fills the SQL template cache; the second takes the
    // collect-only path, which resolves keys through the same resolver.
    const qi = makeQuery<Record<string, unknown>>('report_schedule', schema);
    const first = qi.buildUpdate({ where: { id: 1 }, data: { ...BY_COLUMN } });
    const second = qi.buildUpdate({ where: { id: 2 }, data: { ...BY_COLUMN } });
    assert.equal(second.sql, first.sql);
    assert.deepStrictEqual(second.params, [TS, DAY, TZ, [TS, TS2], 2]);
  });

  it('a second `set`-operator update binds the same params', () => {
    const qi = makeQuery<Record<string, unknown>>('report_schedule', schema);
    qi.buildUpdate({ where: { id: 1 }, data: { last_run: { set: V } } });
    const second = qi.buildUpdate({ where: { id: 2 }, data: { last_run: { set: V } } });
    assert.deepStrictEqual(second.params, [TS, 2]);
  });
});

describe('column-key parity: unknown and prototype keys still fail the same way', () => {
  it('an unresolvable data key raises E003', () => {
    assert.throws(() => q().buildCreate({ data: { lasttRun: V } }), /Unknown field "lasttRun"/);
  });

  it('a key inherited from Object.prototype raises E003 rather than resolving', () => {
    assert.throws(() => q().buildCreate({ data: { constructor: V } }), /Unknown field "constructor"/);
    assert.throws(() => q().buildCreate({ data: { toString: V } }), /Unknown field "toString"/);
  });
});

describe('column-key parity: the updatedAt injector', () => {
  it('fills the tagged column in when the caller names neither spelling', () => {
    const built = q('doc').buildUpdate({ where: { id: 1 }, data: { body: 'x' } });
    assert.equal(built.sql, 'UPDATE "doc" SET "body" = $1, "updated_at" = $2 WHERE "id" = $3 RETURNING *');
    assert.equal(typeof built.params[1], 'string', 'the injected Date is coerced like any other bound value');
    assert.match(built.params[1] as string, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  });

  it('stands aside for an explicit value under either spelling', () => {
    const byField = q('doc').buildUpdate({ where: { id: 1 }, data: { body: 'x', updatedAt: V } });
    const byColumn = q('doc').buildUpdate({ where: { id: 1 }, data: { body: 'x', updated_at: V } });
    assert.equal(byField.sql, 'UPDATE "doc" SET "body" = $1, "updated_at" = $2 WHERE "id" = $3 RETURNING *');
    assert.equal(byColumn.sql, byField.sql, 'the column spelling assigned "updated_at" twice');
    assert.deepStrictEqual(byField.params, ['x', TS, 1]);
    assert.deepStrictEqual(byColumn.params, ['x', TS, 1]);
  });

  it('treats an explicit undefined as unnamed under either spelling', () => {
    const byField = q('doc').buildUpdate({ where: { id: 1 }, data: { body: 'x', updatedAt: undefined } });
    const byColumn = q('doc').buildUpdate({ where: { id: 1 }, data: { body: 'x', updated_at: undefined } });
    assert.equal(byColumn.sql, byField.sql);
    assert.equal(byColumn.params.length, 3, 'the tag filled the column in');
  });

  it('leaves an untagged table byte-identical', () => {
    const built = q().buildUpdate({ where: { id: 1 }, data: { counter: 1 } });
    assert.equal(built.sql, 'UPDATE "report_schedule" SET "counter" = $1 WHERE "id" = $2 RETURNING *');
  });
});

// ---------------------------------------------------------------------------
// nested-write: the engine-injected foreign key vs a caller-spelled one
// ---------------------------------------------------------------------------

const usersTable = mockTable('users', [
  { name: 'id', field: 'id' },
  { name: 'name', field: 'name', pgType: 'text' },
]);
const postsTable = mockTable('posts', [
  { name: 'id', field: 'id' },
  { name: 'title', field: 'title', pgType: 'text' },
  { name: 'user_id', field: 'userId' },
]);
const relSchema: SchemaMetadata = {
  tables: {
    users: {
      ...usersTable,
      relations: {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    },
    posts: postsTable,
  },
  enums: {},
};

describe('column-key parity: injectForeignKey', () => {
  const relation = relSchema.tables.users!.relations.posts!;

  it('overwrites a caller-supplied FK spelled as the field', () => {
    const result = injectForeignKey({ title: 'a', userId: 999 }, relation, { id: 42 }, relSchema);
    assert.deepStrictEqual(result, { title: 'a', userId: 42 });
  });

  it('replaces a caller-supplied FK spelled as the column, rather than naming it twice', () => {
    const result = injectForeignKey({ title: 'a', user_id: 999 }, relation, { id: 42 }, relSchema);
    assert.deepStrictEqual(result, { title: 'a', userId: 42 });
    assert.ok(!('user_id' in result), 'both spellings survived and the INSERT would name "user_id" twice');
  });

  it('leaves unrelated keys alone and does not mutate the input', () => {
    const childData = { title: 'a', user_id: 999 };
    injectForeignKey(childData, relation, { id: 42 }, relSchema);
    assert.deepStrictEqual(childData, { title: 'a', user_id: 999 });
  });
});

// ---------------------------------------------------------------------------
// A RELATION whose name resolves to the injected column is not a scalar alias
// ---------------------------------------------------------------------------

/**
 * Dropping the aliased scalar key is only safe while the key really is a scalar.
 * A relation NAME is resolved by the same rule (nothing stops a schema from
 * naming a relation the way its column is spelled), and a relation key carries a
 * nested write, not a value: deleting it discards the whole operation with no
 * error and no warning, which is worse than the duplicate-column error the drop
 * exists to prevent. `defineSchema` and hand-written `SchemaMetadata` can both
 * express this, so the shape has to be excluded explicitly.
 */
const aliasRelSchema: SchemaMetadata = {
  tables: {
    users: {
      ...usersTable,
      relations: {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    },
    posts: {
      ...postsTable,
      relations: {
        // Named the way the column is spelled, while the FIELD is `userId`.
        user_id: {
          type: 'belongsTo',
          name: 'user_id',
          from: 'posts',
          to: 'users',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    },
  },
  enums: {},
};

describe('injectForeignKey: a relation key is never dropped as a column alias', () => {
  const relation = aliasRelSchema.tables.users!.relations.posts!;

  it('keeps a nested relation operation whose relation name resolves to the FK column', () => {
    const op = { connect: { id: 7 } };
    const result = injectForeignKey({ title: 'a', user_id: op }, relation, { id: 42 }, aliasRelSchema);

    assert.equal(result.userId, 42, 'the injected FK still wins under the field spelling');
    assert.deepStrictEqual(result.user_id, op, 'the nested write must survive the injection');
  });

  it('still drops a SCALAR key spelled as the column, even when a relation shares the name', () => {
    const result = injectForeignKey({ title: 'a', user_id: 999 }, relation, { id: 42 }, aliasRelSchema);

    assert.deepStrictEqual(result, { title: 'a', userId: 42 });
  });
});
