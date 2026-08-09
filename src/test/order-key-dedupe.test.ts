/**
 * turbine-orm: a redundant sort/grouping term is dropped, not refused
 *
 * `ORDER BY id ASC, id ASC` sorts identically to `ORDER BY id ASC`, and so does
 * `ORDER BY id ASC, id DESC`: the first term already totally orders the rows it
 * covers, so no later term on the same expression can move anything, whichever
 * way it points. The same is true of `DISTINCT ON (a, a)`.
 *
 * That matters for two reasons at once.
 *
 * SECURITY: repetition is the only way to push one of these lists past the
 * table's column count, so before this it was an unbounded source of distinct
 * SQL texts, each one a permanent server-side prepared statement. Removing the
 * repeat bounds the length by the table's width, which is what leaves the
 * length cap (MAX_NAMED_ORDER_KEYS) a meaningful backstop rather than the only
 * one.
 *
 * CORRECTNESS OF THE REMEDY: dropping rather than refusing, because the shape
 * is produced by correct code. The idiomatic stable-pagination sort is
 * `[{ [sortField]: dir }, { id: 'asc' }]`, appending a primary-key tiebreak
 * unconditionally, and it collides exactly when the caller sorts BY the primary
 * key. Refusing would turn a working table into a 500 on one column header and
 * no others. This repo's own differential fuzz generator writes that pattern
 * ("a random key first, the PK as final tiebreaker") over a field pool that
 * contains `id`, so a refusal would also have failed the fuzz suite on 10-35%
 * of generated cases depending on table width.
 *
 * These tests pin: the term is gone from the SQL, the query still runs, the
 * comparison is on the RESOLVED column rather than the spelling, terms that are
 * genuinely different are untouched, and the caller hears about it once.
 *
 * AND that a dropped term is still VALIDATED. The direction guard lives on the
 * compile path (`buildOrderBy`), which a dropped term never reaches, so the
 * drop silently swallowed it: `[{id:'asc'},{id:'sideways'}]` was accepted while
 * `[{id:'sideways'}]` alone raised E003, and `groupBy` (which validates BEFORE
 * its own dedupe) still refused the identical input, so findMany and groupBy
 * disagreed about whether a query was valid. Whether a bad direction is
 * reported must not depend on whether an earlier term happened to name the same
 * column. See `assertDroppedDirection` in query/filters.ts.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'age', field: 'age', pgType: 'int4' },
          { name: 'tenant_id', field: 'tenantId' },
          { name: 'meta', field: 'meta', pgType: 'jsonb' },
        ],
        {
          posts: {
            name: 'posts',
            type: 'hasMany',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
      ]),
    },
  };
}

/** Everything after ORDER BY, or '' when the statement has none. */
function orderClause(sql: string): string {
  const at = sql.indexOf(' ORDER BY ');
  return at === -1 ? '' : sql.slice(at + ' ORDER BY '.length);
}

/** Swallow the dev advisory so the suite's output stays readable. */
function quiet<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

afterEach(() => {
  resetWarnOnce();
});

describe('orderBy: a redundant term is dropped', () => {
  it('a key repeated with the same direction emits one term', () => {
    const q = makeQuery('users', schema());
    const once = q.buildFindMany({ orderBy: [{ id: 'asc' }] } as never);
    const twice = quiet(() => q.buildFindMany({ orderBy: [{ id: 'asc' }, { id: 'asc' }] } as never));
    assert.equal(orderClause(twice.sql), '"id" ASC');
    assert.equal(twice.sql, once.sql, 'the duplicate must compile to the same statement, not a second one');
  });

  it('a key repeated with the OPPOSITE direction is still redundant', () => {
    // The case a direction-aware comparison would have missed, and the one the
    // stable-pagination pattern actually produces: sort by id descending, then
    // append the unconditional `{ id: 'asc' }` tiebreak.
    const q = makeQuery('users', schema());
    const built = quiet(() => q.buildFindMany({ orderBy: [{ id: 'desc' }, { id: 'asc' }] } as never));
    assert.equal(orderClause(built.sql), '"id" DESC');
  });

  it('the stable-pagination pattern does not throw on the primary key', () => {
    // The whole reason this drops instead of refusing. `[{ [sortField]: dir },
    // { id: 'asc' }]` is correct defensive code; it must not fail when the user
    // clicks the ID column header.
    const q = makeQuery('users', schema());
    for (const sortField of ['age', 'tenantId', 'id']) {
      assert.doesNotThrow(() =>
        quiet(() => q.buildFindMany({ orderBy: [{ [sortField]: 'desc' }, { id: 'asc' }] } as never)),
      );
    }
  });

  it('two spellings of one column are recognised as the duplicate they are', () => {
    // Resolved through the same `resolveColumnName` every SQL builder uses, so
    // the field spelling and the snake_case column spelling (both legal on an
    // introspected schema) collapse.
    const q = makeQuery('users', schema());
    const built = quiet(() => q.buildFindMany({ orderBy: [{ tenantId: 'asc' }, { tenant_id: 'desc' }] } as never));
    assert.equal(orderClause(built.sql), '"tenant_id" ASC');
  });

  it('the object form is deduped too', () => {
    // An object cannot repeat a key, but it can carry two spellings of one.
    const q = makeQuery('users', schema());
    const built = quiet(() => q.buildFindMany({ orderBy: { tenantId: 'asc', tenant_id: 'desc' } } as never));
    assert.equal(orderClause(built.sql), '"tenant_id" ASC');
  });

  it('the earliest occurrence wins, and the surviving order is unchanged', () => {
    const q = makeQuery('users', schema());
    const built = quiet(() => q.buildFindMany({ orderBy: [{ age: 'desc' }, { id: 'asc' }, { age: 'asc' }] } as never));
    assert.equal(orderClause(built.sql), '"age" DESC, "id" ASC');
  });

  it('a caller who wrote no duplicate is untouched, down to the SQL cache', () => {
    const q = makeQuery('users', schema());
    const a = q.buildFindMany({ orderBy: [{ age: 'desc' }, { id: 'asc' }] } as never);
    const b = q.buildFindMany({ orderBy: [{ age: 'desc' }, { id: 'asc' }] } as never);
    assert.equal(orderClause(a.sql), '"age" DESC, "id" ASC');
    assert.equal(a.sql, b.sql);
    assert.ok((a.preparedName ?? '').length > 0);
  });
});

describe('orderBy: terms that only look alike are left alone', () => {
  it('different columns are not merged', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ orderBy: [{ age: 'asc' }, { tenantId: 'asc' }, { id: 'asc' }] } as never);
    assert.equal(orderClause(built.sql), '"age" ASC, "tenant_id" ASC, "id" ASC');
  });

  it('two JSON paths on ONE column are two different expressions', () => {
    // Same column, different extraction: the second term genuinely breaks ties
    // the first leaves, so merging it would change the result.
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({
      orderBy: [{ meta: { path: ['a'], direction: 'asc' } }, { meta: { path: ['b'], direction: 'desc' } }],
    } as never);
    const clause = orderClause(built.sql);
    assert.ok(clause.includes(','), `expected two ORDER BY terms, got: ${clause}`);
  });

  it('the SAME JSON path twice IS redundant', () => {
    const q = makeQuery('users', schema());
    const built = quiet(() =>
      q.buildFindMany({
        orderBy: [{ meta: { path: ['a'], direction: 'asc' } }, { meta: { path: ['a'], direction: 'desc' } }],
      } as never),
    );
    assert.equal(orderClause(built.sql).includes(','), false, 'one path, one term');
  });

  it('the same JSON path under a different cast is not redundant', () => {
    // `type: 'numeric'` sorts 2 before 10 and `text` sorts 10 before 2, so
    // these are different orderings of the same values.
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({
      orderBy: [
        { meta: { path: ['a'], direction: 'asc', type: 'numeric' } },
        { meta: { path: ['a'], direction: 'asc', type: 'text' } },
      ],
    } as never);
    assert.ok(orderClause(built.sql).includes(','), 'a numeric and a text ordering are two terms');
  });

  it('a relation ordering is never merged with a column of the same name', () => {
    // Relation-shaped values are deliberately not compared (their identity is a
    // whole correlated subquery), so nothing here can be dropped wrongly.
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ orderBy: [{ posts: { _count: 'desc' } }, { id: 'asc' }] } as never);
    assert.ok(orderClause(built.sql).includes(','));
  });
});

describe('distinct: a repeated column is dropped', () => {
  it('DISTINCT ON names each column once', () => {
    const q = makeQuery('users', schema());
    const built = quiet(() => q.buildFindMany({ distinct: ['tenantId', 'tenantId'] } as never));
    assert.match(built.sql, /^SELECT DISTINCT ON \("tenant_id"\) /);
  });

  it('two spellings of one column collapse', () => {
    const q = makeQuery('users', schema());
    const built = quiet(() => q.buildFindMany({ distinct: ['tenantId', 'tenant_id'] } as never));
    assert.match(built.sql, /^SELECT DISTINCT ON \("tenant_id"\) /);
  });

  it('genuinely distinct columns are untouched', () => {
    const q = makeQuery('users', schema());
    const built = q.buildFindMany({ distinct: ['tenantId', 'age'] } as never);
    assert.match(built.sql, /^SELECT DISTINCT ON \("tenant_id", "age"\) /);
  });

  it("groupBy's distinctOn.columns follows the same rule", () => {
    const q = makeQuery('users', schema());
    const built = quiet(() =>
      q.buildGroupBy({
        by: ['tenantId'],
        distinctOn: { columns: ['tenantId', 'tenant_id'], orderBy: { id: 'desc' } },
      } as never),
    );
    assert.match(built.sql, /SELECT DISTINCT ON \("tenant_id"\) \*/);
  });
});

describe('groupBy: a redundant orderBy term is dropped', () => {
  it('one output key ordered twice emits one term', () => {
    const q = makeQuery('users', schema());
    const built = quiet(() =>
      q.buildGroupBy({ by: ['tenantId'], orderBy: [{ tenantId: 'asc' }, { tenantId: 'desc' }] } as never),
    );
    assert.equal(orderClause(built.sql), '"tenant_id" ASC');
  });

  it('a by-key and an aggregate are two different terms', () => {
    const q = makeQuery('users', schema());
    const built = q.buildGroupBy({
      by: ['tenantId'],
      _count: true,
      orderBy: [{ _count: 'desc' }, { tenantId: 'asc' }],
    } as never);
    assert.ok(orderClause(built.sql).includes(','));
  });
});

describe('the dropped term is reported once', () => {
  it('warns on the first occurrence and stays quiet after', () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      seen.push(String(msg));
    };
    try {
      const q = makeQuery('users', schema());
      q.buildFindMany({ orderBy: [{ id: 'desc' }, { id: 'asc' }] } as never);
      q.buildFindMany({ orderBy: [{ id: 'desc' }, { id: 'asc' }] } as never);
      // A different accessor on the same table must not re-say it either: the
      // registry is process-wide, so a per-request client cannot spam.
      makeQuery('users', schema()).buildFindMany({ orderBy: [{ id: 'desc' }, { id: 'asc' }] } as never);
    } finally {
      console.warn = original;
    }
    assert.equal(seen.length, 1, `expected exactly one advisory, got ${seen.length}`);
    assert.match(seen[0] ?? '', /orderBy on table "users"/);
    assert.match(seen[0] ?? '', /"id" is named twice/);
    assert.match(seen[0] ?? '', /dropped/);
  });

  it('names both spellings when they differ', () => {
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      seen.push(String(msg));
    };
    try {
      makeQuery('users', schema()).buildFindMany({ orderBy: [{ tenantId: 'asc' }, { tenant_id: 'desc' }] } as never);
    } finally {
      console.warn = original;
    }
    assert.equal(seen.length, 1);
    assert.match(seen[0] ?? '', /"tenant_id" and the earlier "tenantId" both target tenant_id/);
  });

  it('says nothing under NODE_ENV=production', () => {
    // It describes the QUERY the application sends, which does not vary with
    // the environment, so a production process learns nothing from repeating
    // it. The DROP itself still happens.
    const seen: string[] = [];
    const original = console.warn;
    const env = process.env.NODE_ENV;
    console.warn = (msg: unknown) => {
      seen.push(String(msg));
    };
    process.env.NODE_ENV = 'production';
    try {
      const built = makeQuery('users', schema()).buildFindMany({ orderBy: [{ id: 'desc' }, { id: 'asc' }] } as never);
      assert.equal(orderClause(built.sql), '"id" DESC');
    } finally {
      console.warn = original;
      if (env === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = env;
    }
    assert.equal(seen.length, 0);
  });
});

describe('a dropped term is still validated', () => {
  // An optimization must not decide whether an input is legal. Every case here
  // pairs a BAD direction with an earlier term on the same column, which is
  // exactly the shape the dedupe removes before the compile path can look at
  // it. Verified to fail without the fix by removing the `assertDroppedDirection`
  // call from `dedupeOrderEntries`: all six then build SQL and throw nothing.

  it('an invalid direction on the DROPPED term still throws E003', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => quiet(() => q.buildFindMany({ orderBy: [{ id: 'asc' }, { id: 'sideways' }] } as never)),
      (e: Error) => /TURBINE_E003/.test(e.message) && /Invalid orderBy direction/.test(e.message),
    );
  });

  it('the OrderBySpec form of the dropped term is validated too', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () => quiet(() => q.buildFindMany({ orderBy: [{ id: 'asc' }, { id: { sort: 'sideways' } }] } as never)),
      (e: Error) => /TURBINE_E003/.test(e.message),
    );
  });

  it('findMany and groupBy now agree, which is the point', () => {
    // groupBy validates before its own dedupe and always refused this input.
    // The two surfaces disagreeing about validity is what made the swallowed
    // check a bug rather than a leniency.
    const q = makeQuery('users', schema());
    const bad = [{ tenantId: 'asc' }, { tenantId: 'sideways' }];
    assert.throws(
      () => quiet(() => q.buildFindMany({ orderBy: bad } as never)),
      (e: Error) => /TURBINE_E003/.test(e.message),
      'findMany must refuse it',
    );
    assert.throws(
      () => quiet(() => makeQuery('users', schema()).buildGroupBy({ by: ['tenantId'], orderBy: bad } as never)),
      (e: Error) => /TURBINE_E003/.test(e.message),
      'groupBy already refused it',
    );
  });

  it('the message names the table, exactly as the compile path does', () => {
    // The dropped term takes the SAME guard and the SAME context string the
    // kept term would have, so a caller cannot tell which path reported it.
    const q = makeQuery('users', schema());
    let dropped = '';
    let kept = '';
    try {
      quiet(() => q.buildFindMany({ orderBy: [{ id: 'asc' }, { id: 'sideways' }] } as never));
    } catch (e) {
      dropped = (e as Error).message;
    }
    try {
      q.buildFindMany({ orderBy: [{ id: 'sideways' }] } as never);
    } catch (e) {
      kept = (e as Error).message;
    }
    assert.match(dropped, /orderBy "id" on table "users"/);
    assert.equal(dropped, kept, 'a dropped term and a kept term must report identically');
  });

  it('a dropped JSON-path term is validated with the JSON-path guard', () => {
    const q = makeQuery('users', schema());
    assert.throws(
      () =>
        quiet(() =>
          q.buildFindMany({
            orderBy: [{ meta: { path: ['a'], direction: 'asc' } }, { meta: { path: ['a'], direction: 'sideways' } }],
          } as never),
        ),
      (e: Error) => /TURBINE_E003/.test(e.message) && /JSON-path orderBy on "meta"/.test(e.message),
    );
  });

  it('a VALID direction on a dropped term is still just dropped, not refused', () => {
    // The guard must not turn the stable-pagination pattern into a 500: that is
    // the whole reason this dedupe drops rather than refuses.
    const q = makeQuery('users', schema());
    const built = quiet(() => q.buildFindMany({ orderBy: [{ id: 'desc' }, { id: 'asc' }] } as never));
    assert.equal(orderClause(built.sql), '"id" DESC');
  });

  it('a relation-shaped term is never dropped, so its own guard still owns it', () => {
    // `orderKeyIdentity` returns null for relation shapes, so they never reach
    // the dropped-term guard; the relation compile path validates them. This
    // pins that the new check did not start refusing a shape it cannot judge.
    const q = makeQuery('users', schema());
    assert.doesNotThrow(() => q.buildFindMany({ orderBy: [{ posts: { _count: 'desc' } }, { id: 'asc' }] } as never));
  });
});
