/**
 * turbine-orm: empty-`data` writes, and bulk insert into ARRAY columns.
 *
 * Two independent defects reported from a production Prisma-to-turbine
 * migration, both with the same signature: a shape the single-row path handles
 * correctly falls over on a neighbouring path.
 *
 *  - `update({ data: {} })` rendered `UPDATE t SET WHERE …` and failed with a
 *    raw PostgreSQL 42601. Any handler building its payload from optional
 *    request fields produces `{}` on a legitimate request, and Prisma treats
 *    that as a no-op returning the row, so a ported handler inherited a 500
 *    where the original returned 200.
 *  - `createMany` with a `text[]` column failed 42804. The PostgreSQL bulk form
 *    is a column-major `UNNEST` transpose, and `unnest` FLATTENS, so N rows of
 *    `text[]` arrive as one flat `text[]`. Single-row `create` binds each value
 *    directly and was always fine, which is why it went unnoticed.
 *
 * Run: npx tsx --test src/test/write-empty-and-arrays.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockColumn, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const items = mockTable('items', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'version', field: 'version', pgType: 'int4' },
  ]);
  // An array-typed column: pgType `_text` is how PostgreSQL names `text[]`.
  const tagged = mockTable('tagged', [
    { name: 'id', field: 'id' },
    { name: 'tags', field: 'tags', pgType: '_text' },
    { name: 'label', field: 'label', pgType: 'text' },
  ]);
  return { enums: {}, tables: { items, tagged } };
}

// biome-ignore lint/suspicious/noExplicitAny: build-only args in a SQL-shape test
const q = (table = 'items') => makeQuery(table, schema()) as any;

describe('update with no fields to set is a no-op that returns the row', () => {
  it('emits a SELECT rather than invalid `UPDATE … SET  WHERE`', () => {
    const { sql, params } = q().buildUpdate({ where: { id: 1 }, data: {} });
    assert.doesNotMatch(sql, /UPDATE/);
    assert.match(sql, /^SELECT .* FROM "items" WHERE "id" = \$1$/);
    assert.deepEqual(params, [1]);
  });

  it('treats an all-undefined data object the same way', () => {
    const { sql } = q().buildUpdate({ where: { id: 1 }, data: { name: undefined } });
    assert.doesNotMatch(sql, /UPDATE/);
  });

  it('still raises NotFoundError when the predicate matches nothing', () => {
    const { transform } = q().buildUpdate({ where: { id: 1 }, data: {} });
    assert.throws(() => transform({ rows: [], rowCount: 0 }), /found no record/);
  });

  it('still enforces the empty-where guard: a no-op update is not a free pass', () => {
    assert.throws(() => q().buildUpdate({ where: {}, data: {} }), /`where` clause is empty/);
  });

  it('updateMany with nothing to set reports 0 rows changed and issues no UPDATE', () => {
    const { sql, transform } = q().buildUpdateMany({ where: { id: 1 }, data: {} });
    assert.doesNotMatch(sql, /UPDATE/);
    assert.deepEqual(transform({ rows: [], rowCount: 0 }), { count: 0 });
  });

  it('a real update is untouched', () => {
    const { sql, params } = q().buildUpdate({ where: { id: 1 }, data: { name: 'x' } });
    assert.match(sql, /UPDATE "items" SET "name" = \$1 WHERE "id" = \$2 RETURNING \*/);
    assert.deepEqual(params, ['x', 1]);
  });

  it('optimisticLock still emits a real UPDATE: it always has a version to bump', () => {
    const { sql } = q().buildUpdate({
      where: { id: 1 },
      data: {},
      optimisticLock: { field: 'version', expected: 3 },
    });
    assert.match(sql, /UPDATE "items" SET "version" = "version" \+ 1/);
  });
});

describe('createMany into a table with an array column', () => {
  it('uses the row-major VALUES form so arrays are not flattened', () => {
    const { sql, params } = q('tagged').buildCreateMany({
      data: [
        { tags: ['a', 'b'], label: 'x' },
        { tags: ['c'], label: 'y' },
      ],
    });
    assert.match(sql, /INSERT INTO "tagged" \("tags", "label"\) VALUES \(\$1, \$2\), \(\$3, \$4\) RETURNING \*/);
    // Row-major: the arrays stay whole, one param per cell.
    assert.deepEqual(params, [['a', 'b'], 'x', ['c'], 'y']);
  });

  it('keeps the column-major UNNEST form when no column is array-typed', () => {
    const { sql, params } = q().buildCreateMany({ data: [{ name: 'a' }, { name: 'b' }] });
    assert.match(sql, /SELECT \* FROM UNNEST\(\$1::text\[\]\)/);
    assert.deepEqual(params, [['a', 'b']]);
  });

  it('detects the array column from its declared type, not from the first row value', () => {
    // Every row's array cell is null here; the form must still be VALUES,
    // because row 2 of some other call could carry a real array.
    const { sql } = q('tagged').buildCreateMany({ data: [{ tags: null }, { tags: null }] });
    assert.match(sql, /VALUES \(\$1\), \(\$2\)/);
  });

  it('still honors skipDuplicates', () => {
    const { sql } = q('tagged').buildCreateMany({ data: [{ tags: ['a'] }], skipDuplicates: true });
    assert.match(sql, /ON CONFLICT DO NOTHING/);
  });

  it('single-row create is unchanged', () => {
    const { sql, params } = q('tagged').buildCreate({ data: { tags: ['a'] } });
    assert.match(sql, /INSERT INTO "tagged" \("tags"\) VALUES \(\$1\) RETURNING \*/);
    assert.deepEqual(params, [['a']]);
  });
});

// Keep the import of mockColumn meaningful for future column-shape additions.
void mockColumn;
