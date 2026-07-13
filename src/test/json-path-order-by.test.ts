/**
 * turbine-orm: JSON-path orderBy on same-table jsonb columns (Capa item 4a)
 *
 * `orderBy: { data: { path: ['weight'], direction: 'asc', type: 'numeric' } }`
 * compiles to `("data" #>> $n::text[])::numeric ASC`: the path bound as ONE
 * text[] param, numeric cast only with `type: 'numeric'` (default is text
 * comparison), extraction routed through the dialect JSON hook exactly like
 * the JSON where-filters. Works top-level AND in nested `with` orderBy (the
 * unified relation orderBy path). Cross-relation lateral ordering is out of
 * scope by design.
 *
 * Cache safety: direction / cast kind / nulls change the SQL text and are
 * fingerprinted; the path values are params and are mirrored by the collect
 * paths.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      entries: mockTable(
        'entries',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'data', field: 'data', pgType: 'jsonb' },
          { name: 'meta', field: 'meta', pgType: 'json' },
        ],
        {
          items: {
            type: 'hasMany',
            name: 'items',
            from: 'entries',
            to: 'items',
            foreignKey: 'entry_id',
            referenceKey: 'id',
          },
        },
      ),
      items: mockTable('items', [
        { name: 'id', field: 'id' },
        { name: 'entry_id', field: 'entryId' },
        { name: 'attrs', field: 'attrs', pgType: 'jsonb' },
        { name: 'label', field: 'label', pgType: 'text' },
      ]),
    },
  };
}

describe('JSON-path orderBy: top-level', () => {
  it('defaults to text comparison, ASC: path bound as one text[] param', () => {
    const q = makeQuery('entries', schema());
    const { sql, params } = q.buildFindMany({ orderBy: { data: { path: ['weight'] } } } as never);
    assert.ok(sql.includes('ORDER BY "data" #>> $1::text[] ASC'), sql);
    assert.deepEqual(params, [['weight']]);
  });

  it("type: 'numeric' adds the ::numeric cast; desc respected", () => {
    const q = makeQuery('entries', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: { data: { path: ['weight'], direction: 'desc', type: 'numeric' } },
    } as never);
    assert.ok(sql.includes('ORDER BY ("data" #>> $1::text[])::numeric DESC'), sql);
    assert.deepEqual(params, [['weight']]);
  });

  it('deep paths bind every element as text (array indexes stringified)', () => {
    const q = makeQuery('entries', schema());
    const { params } = q.buildFindMany({
      orderBy: { data: { path: ['settings', 0, 'weight'], type: 'numeric' } },
    } as never);
    assert.deepEqual(params, [['settings', '0', 'weight']]);
  });

  it('nulls placement is emitted', () => {
    const q = makeQuery('entries', schema());
    const { sql } = q.buildFindMany({ orderBy: { data: { path: ['weight'], nulls: 'last' } } } as never);
    assert.ok(sql.includes('ORDER BY "data" #>> $1::text[] ASC NULLS LAST'), sql);
  });

  it('json (not just jsonb) columns are accepted', () => {
    const q = makeQuery('entries', schema());
    const { sql } = q.buildFindMany({ orderBy: { meta: { path: ['rank'] } } } as never);
    assert.ok(sql.includes('"meta" #>> $1::text[] ASC'), sql);
  });

  it('param order interleaves correctly with where and limit params', () => {
    const q = makeQuery('entries', schema());
    const { sql, params } = q.buildFindMany({
      where: { name: { contains: 'x' } },
      orderBy: { data: { path: ['weight'], type: 'numeric' } },
      limit: 5,
    } as never);
    assert.deepEqual(params, ['%x%', ['weight'], 5]);
    assert.ok(sql.includes('"name" LIKE $1'), sql);
    assert.ok(sql.includes('#>> $2::text[]'), sql);
    assert.ok(sql.includes('LIMIT $3'), sql);
  });
});

describe('JSON-path orderBy: validation', () => {
  it('non-JSON column throws E003', () => {
    const q = makeQuery('entries', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { name: { path: ['x'] } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /JSON-path orderBy on "name": column "name" on table "entries" is not a JSON column/);
        return true;
      },
    );
  });

  it('unknown field throws the standard unknown-field E003', () => {
    const q = makeQuery('entries', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { bogus: { path: ['x'] } } } as never),
      /Unknown field "bogus" in orderBy on table "entries"/,
    );
  });

  it('empty path throws E003', () => {
    const q = makeQuery('entries', schema());
    assert.throws(
      () => q.buildFindMany({ orderBy: { data: { path: [] } } } as never),
      /requires a non-empty `path` array/,
    );
  });
});

describe('JSON-path orderBy: nested with orderBy (unified item-2 path)', () => {
  it('compiles inside a hasMany with orderBy (inner-subquery wrap), alias-qualified', () => {
    const q = makeQuery('entries', schema());
    const { sql, params } = q.buildFindMany({
      with: { items: { orderBy: { attrs: { path: ['weight'], type: 'numeric' } } } },
    } as never);
    assert.ok(sql.includes('ORDER BY (t0."attrs" #>> $1::text[])::numeric ASC'), sql);
    assert.deepEqual(params, [['weight']]);
  });

  it('orderBy params precede the relation where params (build/collect lockstep)', () => {
    const q = makeQuery('entries', schema());
    const args = {
      with: {
        items: {
          orderBy: { attrs: { path: ['weight'] } },
          where: { label: 'a' },
          limit: 2,
        },
      },
    } as never;
    const first = q.buildFindMany(args);
    assert.deepEqual(first.params, [['weight'], 'a', 2]);
    const second = q.buildFindMany(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
  });

  it('non-JSON nested column still throws E003', () => {
    const q = makeQuery('entries', schema());
    assert.throws(
      () => q.buildFindMany({ with: { items: { orderBy: { label: { path: ['x'] } } } } } as never),
      /not a JSON column/,
    );
  });
});

describe('JSON-path orderBy: cache safety', () => {
  it('double-run identity: cache hit collects the same SQL and params', () => {
    const q = makeQuery('entries', schema());
    const args = {
      where: { name: 'n' },
      orderBy: { data: { path: ['a', 'b'], direction: 'desc', type: 'numeric', nulls: 'first' } },
    } as never;
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(first.params, ['n', ['a', 'b']]);
  });

  it('same shape with different path values shares SQL text but binds its own path', () => {
    const q = makeQuery('entries', schema());
    const a = q.buildFindMany({ orderBy: { data: { path: ['weight'] } } } as never);
    const b = q.buildFindMany({ orderBy: { data: { path: ['priority'] } } } as never);
    assert.equal(a.sql, b.sql);
    assert.deepEqual(a.params, [['weight']]);
    assert.deepEqual(b.params, [['priority']]);
  });

  it('direction, cast kind, and nulls each change the SQL text (fingerprinted)', () => {
    const q = makeQuery('entries', schema());
    const base = q.buildFindMany({ orderBy: { data: { path: ['w'] } } } as never);
    const desc = q.buildFindMany({ orderBy: { data: { path: ['w'], direction: 'desc' } } } as never);
    const numeric = q.buildFindMany({ orderBy: { data: { path: ['w'], type: 'numeric' } } } as never);
    const nulls = q.buildFindMany({ orderBy: { data: { path: ['w'], nulls: 'last' } } } as never);
    assert.notEqual(base.sql, desc.sql);
    assert.notEqual(base.sql, numeric.sql);
    assert.notEqual(base.sql, nulls.sql);
    assert.notEqual(desc.sql, numeric.sql);
  });

  it('a JSON-path orderBy never collides with a plain direction on the same column', () => {
    const q = makeQuery('entries', schema());
    const plain = q.buildFindMany({ orderBy: { data: 'asc' } } as never);
    const jsonPath = q.buildFindMany({ orderBy: { data: { path: ['w'] } } } as never);
    assert.notEqual(plain.sql, jsonPath.sql);
    assert.deepEqual(plain.params, []);
    assert.deepEqual(jsonPath.params, [['w']]);
  });
});
