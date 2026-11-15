/**
 * One answer to "is this an array column", read by every consumer.
 *
 * `columnOperandKind` (query/filters.ts) decides it from the column's type
 * token, resolved column entry first and then the table's `dialectTypes` /
 * `pgTypes` maps, and from the catalog's array flag. The where compiler (SQL
 * build, cache-hit param collection, the `OR: []` key the fingerprint reads),
 * the unique-key rule and the write path all ask it. These cases are the
 * shapes on which the consumers used to disagree:
 *
 * - the type only in a table map: the compiler bound the whole array while
 *   the unique-key rule refused it as a key;
 * - a scalar type NAMED like an array type (`_mood`, `isArray: false`): the
 *   compiler bound an array operand, so a read matched, and a bulk update
 *   changed, a row whose scalar label is the text `{"x"}`;
 * - an array type spelled with a suffix (`text[]`, `STRING[]`): refused
 *   everywhere although the catalog flag says array.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import type { PgCompatPool } from '../pg-types.js';
import { whereIdentifiesOneRow } from '../query/compound-unique.js';
import { columnOperandKind } from '../query/filters.js';
import * as whereMod from '../query/where.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';
import { compileWhere, ctxOf } from './where-core-fixture.js';

function table(pgType: string, change?: (meta: TableMetadata) => void): SchemaMetadata {
  const docs = mockTable('docs', [
    { name: 'id', field: 'id' },
    { name: 'tags', field: 'tags', pgType, unique: true },
    { name: 'note', field: 'note', pgType: 'text' },
  ]);
  change?.(docs);
  const holders = mockTable(
    'holders',
    [
      { name: 'id', field: 'id' },
      { name: 'doc_id', field: 'docId' },
    ],
    { doc: { type: 'belongsTo', name: 'doc', from: 'holders', to: 'docs', foreignKey: 'doc_id', referenceKey: 'id' } },
  );
  return { enums: { _mood: ['x', '{"x"}'] }, tables: { docs, holders } };
}

const tagsColumn = (meta: TableMetadata) => meta.columns.find((c) => c.name === 'tags')!;

/** {@link table} with the catalog array flag of `tags` set to `isArray`. */
const flagged = (pgType: string, isArray: boolean): SchemaMetadata =>
  table(pgType, (m) => {
    tagsColumn(m).isArray = isArray;
  });

/** Every consumer's answer for `tags` under `schema`. */
function answers(schema: SchemaMetadata) {
  const meta = schema.tables.docs!;
  const q = makeQuery('docs', schema);
  const compiles = (() => {
    try {
      const { sql, params } = q.buildFindMany({ where: { tags: ['a'] } } as never);
      return /"tags" = \$1/.test(sql) && Array.isArray(params[0]);
    } catch (err) {
      assert.ok(err instanceof ValidationError, String(err));
      return false;
    }
  })();
  // NULL fits every column, so the statement form is the only thing compared.
  const createMany = q.buildCreateMany({ data: [{ id: 1, tags: null }] } as never).sql;
  return {
    kind: columnOperandKind(meta, 'tags'),
    identity: whereIdentifiesOneRow(meta, { tags: ['a'] }),
    compiles,
    // An array column takes the row-major VALUES form (UNNEST would flatten it).
    rowMajorWrite: !/UNNEST/.test(createMany),
  };
}

const ARRAY = { kind: 'array', identity: true, compiles: true, rowMajorWrite: true };
const SCALAR = { kind: 'scalar', identity: false, compiles: false, rowMajorWrite: false };

describe('every consumer gives one answer per metadata shape', () => {
  const shapes: [string, SchemaMetadata, typeof ARRAY][] = [
    ['an array type on the column entry and in the maps', table('_text'), ARRAY],
    [
      'an array type only in the dialectTypes map',
      table('_text', (m) => {
        delete (tagsColumn(m) as { pgType?: string }).pgType;
      }),
      ARRAY,
    ],
    [
      'an array type only in the legacy pgTypes map',
      table('_text', (m) => {
        delete (tagsColumn(m) as { pgType?: string }).pgType;
        delete m.dialectTypes;
      }),
      ARRAY,
    ],
    [
      'no catalog flag at all: the token decides',
      table('_text', (m) => {
        delete (tagsColumn(m) as { isArray?: boolean }).isArray;
      }),
      ARRAY,
    ],
    ['the suffix spelling text[]', flagged('text[]', true), ARRAY],
    ['the suffix spelling STRING[]', flagged('STRING[]', true), ARRAY],
    ['a scalar type named like an array type', flagged('_mood', false), SCALAR],
    ['a suffix spelling with a false flag', flagged('text[]', false), SCALAR],
    ['a true flag on a scalar token', flagged('text', true), SCALAR],
  ];
  for (const [label, schema, want] of shapes) {
    it(label, () => assert.deepEqual(answers(schema), want));
  }
});

describe('a scalar type named like an array type takes no array operand', () => {
  const schema = flagged('_mood', false);
  const q = () => makeQuery('docs', schema);
  const refused = (err: unknown) => err instanceof ValidationError && /"tags"/.test(err.message);

  it('reads, counts and bulk writes refuse it before any statement exists', () => {
    assert.throws(() => q().buildFindMany({ where: { tags: ['x'] } } as never), refused);
    assert.throws(() => q().buildFindMany({ where: { tags: { equals: ['x'] } } } as never), refused);
    assert.throws(() => q().buildCount({ where: { tags: ['x'] } } as never), refused);
    assert.throws(() => q().buildUpdateMany({ where: { tags: ['x'] }, data: { note: 'n' } } as never), refused);
    assert.throws(() => q().buildDeleteMany({ where: { tags: ['x'] } } as never), refused);
  });

  it('the cache-hit param collect refuses it too, and a relation sub-where', () => {
    assert.throws(() => whereMod.collectWhereParams(ctxOf(q()), { tags: ['x'] }, []), refused);
    const holders = makeQuery('holders', schema);
    assert.throws(() => holders.buildFindMany({ where: { doc: { is: { tags: ['x'] } } } } as never), refused);
  });

  it('a scalar label still compares, with the enum cast a scalar enum column gets', () => {
    const where = compileWhere({ tags: '{"x"}' }, q());
    assert.equal(where.sql, '"tags" = $1');
    assert.deepEqual(where.collectParams, where.buildParams);
    assert.match(q().buildCreate({ data: { id: 1, tags: 'x' } } as never).sql, /::"_mood"/);
  });

  it('and no array write: every write path refuses it before any statement exists', async () => {
    // Bound as an array literal, `['x']` stored the label `{"x"}` through a
    // one-row write, and createMany's UNNEST flattened it to the label `x`.
    const refusedWrite = (err: unknown) => {
      assert.ok(err instanceof ValidationError, String(err));
      assert.match(err.message, /Cannot write an array to "docs\.tags" \(column type _mood\)/);
      assert.match(err.message, /a scalar type named like an array type/);
      return true;
    };
    for (const value of [['x'], [], [['x']]]) {
      assert.throws(() => q().buildCreate({ data: { id: 1, tags: value } } as never), refusedWrite);
      assert.throws(
        () =>
          q().buildCreateMany({
            data: [
              { id: 1, tags: 'x' },
              { id: 2, tags: value },
            ],
          } as never),
        refusedWrite,
      );
      assert.throws(() => q().buildUpdate({ where: { id: 1 }, data: { tags: value } } as never), refusedWrite);
      assert.throws(() => q().buildUpdate({ where: { id: 1 }, data: { tags: { set: value } } } as never), refusedWrite);
      assert.throws(() => q().buildUpdateMany({ where: { note: 'n' }, data: { tags: value } } as never), refusedWrite);
      assert.throws(
        () => q().buildUpsert({ where: { id: 1 }, create: { id: 1, tags: value }, update: { note: 'u' } } as never),
        refusedWrite,
      );
      assert.throws(
        () => q().buildUpsert({ where: { id: 1 }, create: { id: 1 }, update: { tags: value } } as never),
        refusedWrite,
      );
    }

    // A nested write, and the lookup-first upsert, refuse it before the
    // statement that would otherwise run first.
    const sent: string[] = [];
    const query = async (config: string | { text: string }) => {
      sent.push(typeof config === 'string' ? config : config.text);
      return { rows: [{ id: 1, doc_id: 1 }], rowCount: 1, fields: [] };
    };
    const pool = { query, connect: async () => ({ query, release: () => {} }), end: async () => {} };
    const db = new TurbineClient({ pool: pool as unknown as PgCompatPool }, schema);
    const writes: (() => Promise<unknown>)[] = [
      () =>
        db
          .table('holders')
          .update({ where: { id: 1 }, data: { docId: 1, doc: { update: { data: { tags: ['x'] } } } } }),
      () =>
        db.table('holders').update({
          where: { id: 1 },
          data: {
            docId: 1,
            doc: { upsert: { where: { id: 1 }, create: { id: 1, tags: ['x'] }, update: { note: 'u' } } },
          },
        }),
      () =>
        db
          .table('holders')
          .create({ data: { id: 1, doc: { connectOrCreate: { where: { id: 1 }, create: { id: 1, tags: ['x'] } } } } }),
      () =>
        db.table('docs').upsert({ where: { id: 1, note: 'n' }, create: { id: 1, note: 'n', tags: ['x'] }, update: {} }),
    ];
    for (const write of writes) {
      sent.length = 0;
      await assert.rejects(write, refusedWrite);
      assert.deepEqual(sent, []);
    }
  });

  it('the refusal is for that kind of column only: other columns keep their handling of an array', () => {
    const other = mockTable('other', [
      { name: 'id', field: 'id' },
      { name: 'n', field: 'n', pgType: 'int4' },
      { name: 't', field: 't', pgType: 'text' },
      { name: 'j', field: 'j', pgType: 'jsonb' },
      { name: 'a', field: 'a', pgType: '_text' },
    ]);
    const o = makeQuery('other', { enums: {}, tables: { other } });
    for (const [field, type] of [
      ['n', 'int4'],
      ['t', 'text'],
    ]) {
      assert.throws(
        () => o.buildCreate({ data: { id: 1, [field!]: ['x'] } } as never),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.includes(`Cannot write an array to "other.${field}" (column type ${type}). Only json/jsonb`),
      );
    }
    assert.deepEqual(o.buildCreate({ data: { id: 1, j: ['x'] } } as never).params, [1, '["x"]']);
    assert.deepEqual(o.buildCreate({ data: { id: 1, a: ['x'] } } as never).params, [1, ['x']]);
    assert.deepEqual(q().buildCreate({ data: { id: 1, tags: 'x' } } as never).params, [1, 'x']);
  });

  it('an array filter on it is refused by name, not compiled', () => {
    assert.throws(
      () => q().buildFindMany({ where: { tags: { has: 'x' } } } as never),
      (err: unknown) => err instanceof ValidationError && /not an array column/.test(err.message),
    );
  });
});

describe('a suffix array spelling compiles like the catalog spelling', () => {
  it('array filters cast to the element type, not text', () => {
    const schema = flagged('int8[]', true);
    const { sql } = makeQuery('docs', schema).buildFindMany({ where: { tags: { hasEvery: [1, 2] } } } as never);
    assert.match(sql, /"tags" @> \$1::bigint\[\]/);
    const underscore = makeQuery('docs', table('_int8')).buildFindMany({
      where: { tags: { hasEvery: [1, 2] } },
    } as never);
    assert.equal(sql, underscore.sql);
  });

  it('build, cache-hit collect and fingerprint agree', () => {
    const q = makeQuery('docs', flagged('text[]', true));
    const where = compileWhere({ tags: ['a', 'b'] }, q);
    assert.equal(where.sql, '"tags" = $1');
    assert.deepEqual(where.buildParams, [['a', 'b']]);
    assert.deepEqual(where.collectParams, where.buildParams);
    assert.equal(where.fingerprint, compileWhere({ tags: ['c'] }, q).fingerprint);
  });
});
