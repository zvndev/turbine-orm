/**
 * turbine-orm — Relation `limit` parameter alignment
 *
 * Regression test for the bug where a `with` clause on a to-one relation
 * (belongsTo / hasOne) that carried a `limit` pushed a parameter into the
 * params array but rendered a literal `LIMIT 1`, never referencing the
 * placeholder. The orphaned, untyped `$N` made Postgres reject the whole
 * query with "could not determine data type of parameter $N".
 *
 * To-one relations always return a single row, so `limit` is meaningless and
 * must be ignored entirely — no param, no placeholder.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Every $N referenced in the SQL must have a corresponding params entry, and
 *  there must be no params entry that the SQL never references. */
function assertParamsAligned(sql: string, params: unknown[]): void {
  const referenced = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) {
    referenced.add(Number(m[1]));
  }
  const max = referenced.size ? Math.max(...referenced) : 0;
  // No gaps: every index 1..max appears (an orphaned $1 with the outer LIMIT at
  // $2 would leave a gap if $1 were missing — but the real bug is the reverse:
  // params has an entry whose placeholder is absent). Assert both directions.
  assert.equal(max, params.length, `SQL references up to $${max} but got ${params.length} params: ${sql}`);
  for (let i = 1; i <= params.length; i++) {
    assert.ok(referenced.has(i), `param $${i} is never referenced in SQL — orphaned param: ${sql}`);
  }
}

function selfRelSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      authors: mockTable(
        'authors',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'mentor_id', field: 'mentorId' },
        ],
        {
          // belongsTo self-relation (the exact shape that triggered the bug)
          mentor: {
            type: 'belongsTo',
            name: 'mentor',
            from: 'authors',
            to: 'authors',
            foreignKey: 'mentor_id',
            referenceKey: 'id',
          },
          // hasMany self-relation
          mentees: {
            type: 'hasMany',
            name: 'mentees',
            from: 'authors',
            to: 'authors',
            foreignKey: 'mentor_id',
            referenceKey: 'id',
          },
          // hasMany to another table
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'authors',
            to: 'posts',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'author_id', field: 'authorId' },
          { name: 'title', field: 'title', pgType: 'text' },
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'posts',
            to: 'authors',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };
}

describe('relation limit parameter alignment', () => {
  it('ignores limit on a belongsTo relation (no orphaned $N)', () => {
    const q = makeQuery('authors', selfRelSchema());
    const { sql, params } = q.buildFindMany({ with: { mentor: { limit: 10 } }, limit: 10 } as never);
    assertParamsAligned(sql, params);
    // to-one renders literal LIMIT 1; the spec.limit must not have produced a param
    assert.match(sql, /LIMIT 1\)/);
    assert.deepEqual(params, [10], 'only the outer LIMIT should be parameterized');
  });

  it('ignores limit on a hasOne relation', () => {
    const schema = selfRelSchema();
    const authorRel = schema.tables.posts?.relations.author;
    assert.ok(authorRel);
    authorRel.type = 'hasOne';
    const q = makeQuery('posts', schema);
    const { sql, params } = q.buildFindMany({ with: { author: { limit: 5 } }, limit: 10 } as never);
    assertParamsAligned(sql, params);
  });

  it('still honors limit on a hasMany relation (param referenced)', () => {
    const q = makeQuery('authors', selfRelSchema());
    const { sql, params } = q.buildFindMany({ with: { posts: { limit: 3 } }, limit: 10 } as never);
    assertParamsAligned(sql, params);
    // hasMany wraps in an inner subquery with a real LIMIT $N
    assert.match(sql, /LIMIT \$\d+\) t\di/);
    assert.ok(params.includes(3), 'the relation limit should be a parameter');
  });

  it('handles a belongsTo + hasMany mix without orphaning params', () => {
    const q = makeQuery('authors', selfRelSchema());
    const { sql, params } = q.buildFindMany({
      with: { mentor: { limit: 10 }, posts: { limit: 5 } },
      limit: 10,
    } as never);
    assertParamsAligned(sql, params);
  });

  it('belongsTo without a limit is unaffected', () => {
    const q = makeQuery('authors', selfRelSchema());
    const { sql, params } = q.buildFindMany({ with: { mentor: true }, limit: 10 } as never);
    assertParamsAligned(sql, params);
  });
});
