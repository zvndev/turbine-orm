/**
 * turbine-orm/mssql: relation `offset` in the FOR JSON PATH override.
 *
 * SQL Server builds nested relations with its own `FOR JSON PATH` subquery
 * (`mssqlDialect.buildRelationSubquery`), whose paging clause carried only a
 * limit. These are build-only tests (no SQL Server instance): they pin the
 * emitted paging clause and the parameter order, which must be limit, then
 * offset, then nested relations, the order the builder's cache-hit
 * param-collect pass pushes them.
 *
 * Run: npx tsx --test src/test/sql-engines-mssql.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RelationSubqueryContext } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import type { WithOptions } from '../query/index.js';
import { QueryInterface } from '../query/index.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const users = mockTable(
  'users',
  [
    { name: 'id', field: 'id', pgType: 'bigint' },
    { name: 'name', field: 'name', pgType: 'nvarchar' },
  ],
  {
    posts: { name: 'posts', type: 'hasMany', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    tags: {
      name: 'tags',
      type: 'manyToMany',
      from: 'users',
      to: 'tags',
      foreignKey: 'id',
      referenceKey: 'id',
      through: { table: 'user_tags', sourceKey: 'user_id', targetKey: 'tag_id' },
    } as RelationDef,
  } as Record<string, RelationDef>,
);
const posts = mockTable(
  'posts',
  [
    { name: 'id', field: 'id', pgType: 'bigint' },
    { name: 'user_id', field: 'userId', pgType: 'bigint' },
    { name: 'title', field: 'title', pgType: 'nvarchar' },
  ],
  {
    comments: {
      name: 'comments',
      type: 'hasMany',
      from: 'posts',
      to: 'comments',
      foreignKey: 'post_id',
      referenceKey: 'id',
    },
  } as Record<string, RelationDef>,
);
const comments = mockTable('comments', [
  { name: 'id', field: 'id', pgType: 'bigint' },
  { name: 'post_id', field: 'postId', pgType: 'bigint' },
]);
const tags = mockTable('tags', [
  { name: 'id', field: 'id', pgType: 'bigint' },
  { name: 'label', field: 'label', pgType: 'nvarchar' },
]);
const schema: SchemaMetadata = { tables: { users, posts, comments, tags }, enums: {} };

/** Call the override directly, the way the relation builder does, with a where that binds one param. */
function build(relName: 'posts' | 'tags', spec: true | WithOptions, params: unknown[] = []) {
  const relDef = users.relations[relName]!;
  const targetMeta = schema.tables[relDef.to]!;
  let aliasN = 1;
  const ctx: RelationSubqueryContext = {
    relDef,
    spec,
    params,
    parentRef: 'users',
    alias: 't0',
    targetTable: relDef.to,
    targetMeta,
    targetColumns: targetMeta.allColumns,
    depth: 0,
    path: ['users'],
    quote: (n) => mssqlDialect.quoteIdentifier(n),
    buildWhere: () => {
      params.push('where-value');
      return `t0.[id] > ${mssqlDialect.paramPlaceholder(params.length)}`;
    },
    recurse: (nested, nestedSpec, parentRef, depth, path) =>
      mssqlDialect.buildRelationSubquery!({
        ...ctx,
        relDef: nested,
        spec: nestedSpec,
        parentRef,
        alias: `t${aliasN++}`,
        targetTable: nested.to,
        targetMeta: schema.tables[nested.to]!,
        targetColumns: schema.tables[nested.to]!.allColumns,
        depth,
        path,
        buildWhere: () => '',
      }),
  };
  const sql = mssqlDialect.buildRelationSubquery!(ctx);
  return { sql, params };
}

describe('SQL Server relation offset (FOR JSON PATH override)', () => {
  it('limit + offset page with OFFSET n ROWS FETCH NEXT m ROWS ONLY, params limit then offset', () => {
    const { sql, params } = build('posts', { limit: 2, offset: 3, orderBy: { id: 'asc' } });
    assert.match(sql, /ORDER BY t0\.\[id\] ASC OFFSET @p3 ROWS FETCH NEXT @p2 ROWS ONLY FOR JSON PATH/);
    assert.deepEqual(params, ['where-value', 2, 3]);
  });

  it('offset alone pages without FETCH and supplies the ORDER BY OFFSET requires', () => {
    const { sql, params } = build('posts', { offset: 4 });
    assert.match(sql, /ORDER BY \(SELECT NULL\) OFFSET @p2 ROWS FOR JSON PATH/);
    assert.doesNotMatch(sql, /FETCH NEXT/);
    assert.deepEqual(params, ['where-value', 4]);
  });

  it('nested relations bind after the offset (the wrap order)', () => {
    const { params } = build('posts', { offset: 1, with: { comments: { limit: 5 } } });
    assert.deepEqual(params, ['where-value', 1, 5]);
  });

  it('a many-to-many relation pages the same way', () => {
    const { sql, params } = build('tags', { limit: 10, offset: 20 });
    assert.match(sql, /OFFSET @p3 ROWS FETCH NEXT @p2 ROWS ONLY/);
    assert.deepEqual(params, ['where-value', 10, 20]);
  });

  it('without an offset the SQL and params are unchanged', () => {
    const { sql, params } = build('posts', { limit: 2, orderBy: { id: 'desc' } });
    assert.match(sql, /ORDER BY t0\.\[id\] DESC OFFSET 0 ROWS FETCH NEXT @p2 ROWS ONLY/);
    assert.deepEqual(params, ['where-value', 2]);
    const plain = build('posts', true);
    assert.doesNotMatch(plain.sql, /OFFSET/);
  });

  it('a negative or fractional offset is refused', () => {
    for (const offset of [-1, 1.5, Number.NaN]) {
      assert.throws(() => build('posts', { offset } as WithOptions), ValidationError);
    }
  });

  // Through the full builder, once the relation builder stops refusing an
  // offset for dialects that own their relation subquery (see the report:
  // `src/query/relations.ts`, the `relation offset` E017 in buildRelationSubquery).
  // The cold build and the warm cache-hit collect must bind the same params.
  const q = new QueryInterface<Record<string, unknown>>(null as never, 'users', schema, [], {
    dialect: mssqlDialect,
    sqlCache: true,
  } as never);
  let builderRefuses = false;
  try {
    q.buildFindMany({ with: { posts: { offset: 1 } } } as never);
  } catch (err) {
    builderRefuses = err instanceof UnsupportedFeatureError;
  }
  it('end to end through buildFindMany: cold and warm params agree', {
    todo: builderRefuses ? 'the relation builder still refuses relation offset on SQL Server' : undefined,
  }, () => {
    const a = q.buildFindMany({ with: { posts: { limit: 2, offset: 3, orderBy: { id: 'asc' } } } } as never);
    const b = q.buildFindMany({ with: { posts: { limit: 5, offset: 7, orderBy: { id: 'asc' } } } } as never);
    assert.equal(a.sql, b.sql);
    assert.match(a.sql, /OFFSET @p\d+ ROWS FETCH NEXT @p\d+ ROWS ONLY/);
    assert.deepEqual(a.params, [2, 3]);
    assert.deepEqual(b.params, [5, 7]);
  });
});
