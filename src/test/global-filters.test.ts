/**
 * turbine-orm, global filters (soft-delete / multi-tenancy), WS-G.
 *
 * Build-only SQL + param-alignment assertions via `makeQuery` (no DB), plus
 * client-level tests through recording mock pools that prove the filter reaches
 * the wire, is threaded through the batched strategy, and applies identically
 * when a read is routed to a replica.
 *
 * Invariants under test:
 *   - the filter is AND-merged into the compiled WHERE of every read/mutation
 *   - it flows into relation subqueries (join + batched), relation filters,
 *     `_count`, and relation orderBy, with $N params never misaligned
 *   - the empty-`where` guard checks the USER where, never the global filter
 *   - `skipGlobalFilters` (true / named tables) opts out
 *   - function filters are evaluated per build (per-request tenancy)
 *   - the SQL cache never serves one filter shape's SQL for another
 *   - create/createMany are never filtered
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, type PgCompatPoolClient, TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import type { QueryInterfaceOptions, WithClause } from '../query/index.js';
import { UNSAFE } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Assert every `$N` in `sql` (1..max) is backed by exactly `params.length` values. */
function assertParamsAligned(sql: string, params: unknown[]): void {
  const referenced = new Set<number>();
  for (const m of sql.matchAll(/\$(\d+)/g)) referenced.add(Number(m[1]));
  const max = referenced.size ? Math.max(...referenced) : 0;
  assert.equal(max, params.length, `SQL references up to $${max} but got ${params.length} params: ${sql}`);
  for (let i = 1; i <= params.length; i++) {
    assert.ok(referenced.has(i), `param $${i} never referenced: ${sql}`);
  }
}

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
          { name: 'deleted_at', field: 'deletedAt', pgType: 'timestamptz' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
          profile: {
            type: 'hasOne',
            name: 'profile',
            from: 'users',
            to: 'profiles',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
          orgs: {
            type: 'manyToMany',
            name: 'orgs',
            from: 'users',
            to: 'orgs',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'user_orgs', sourceKey: 'user_id', targetKey: 'org_id' },
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
          { name: 'deleted_at', field: 'deletedAt', pgType: 'timestamptz' },
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'posts',
            to: 'users',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      profiles: mockTable('profiles', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'bio', field: 'bio', pgType: 'text' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
        { name: 'deleted_at', field: 'deletedAt', pgType: 'timestamptz' },
      ]),
      orgs: mockTable('orgs', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
        { name: 'deleted_at', field: 'deletedAt', pgType: 'timestamptz' },
      ]),
    },
  };
}

/**
 * A soft-delete filter (`deletedAt: null`), the parameterless canonical case.
 *
 * It compiles to `IS NULL` and binds NOTHING, which makes it useless on its own
 * as a probe for the build/collect mirror: {@link assertParamsAligned} compares
 * 0 placeholders against 0 params and passes whatever the collect path did.
 * Every relation-target case therefore ALSO runs on {@link tenancy}; this one
 * stays so the zero-param shape keeps its own coverage.
 */
const softDelete = { deletedAt: null };

/**
 * A value-bearing tenancy filter. It binds one `$N` per table it applies to, so
 * a collect path that fails to push for it produces a placeholder no value
 * backs, and the assertion helpers can see it. This is the shape that turned
 * `with: { rel: true }` into a bind-count error on a real database.
 */
const tenancy = { tenantId: 't-42' };

/** The filter value {@link tenancy} binds. */
const TENANT = 't-42';

function qi(table: string, filters: QueryInterfaceOptions['globalFilters']) {
  return makeQuery(table, schema(), { globalFilters: filters });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe('global filters, reads', () => {
  it('findMany AND-merges the filter into WHERE (no user where)', () => {
    const { sql, params } = qi('users', { users: softDelete }).buildFindMany();
    assert.match(sql, /WHERE "deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('findMany AND-merges the filter alongside a user where', () => {
    const { sql, params } = qi('users', { users: softDelete }).buildFindMany({ where: { id: 5 } });
    assert.match(sql, /"id" = \$1/);
    assert.match(sql, /"deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
    assert.deepEqual(params, [5]);
  });

  it('no filter configured for the table → SQL is unchanged', () => {
    const withEmpty = qi('users', {}).buildFindMany({ where: { id: 1 } });
    const noConfig = makeQuery('users', schema()).buildFindMany({ where: { id: 1 } });
    assert.equal(withEmpty.sql, noConfig.sql);
    assert.doesNotMatch(withEmpty.sql, /deleted_at/);
  });

  it('a tenancy value filter binds a $N param', () => {
    const { sql, params } = qi('users', { users: { tenantId: 't-42' } }).buildFindMany();
    assert.match(sql, /"tenant_id" = \$1/);
    assert.deepEqual(params, ['t-42']);
    assertParamsAligned(sql, params);
  });

  it('function filter is evaluated per build (per-request tenancy via closure)', () => {
    let tenant = 'a';
    const q = qi('users', { users: () => ({ tenantId: tenant }) });
    const first = q.buildFindMany();
    tenant = 'b';
    const second = q.buildFindMany();
    assert.equal(first.sql, second.sql, 'same shape → same cached SQL');
    assert.deepEqual(first.params, ['a']);
    assert.deepEqual(second.params, ['b']);
  });

  it('skipGlobalFilters: UNSAFE bypasses all filters', () => {
    const { sql } = qi('users', { users: softDelete }).buildFindMany({ skipGlobalFilters: UNSAFE });
    assert.doesNotMatch(sql, /deleted_at/);
  });

  it('skipGlobalFilters: [UNSAFE, table] bypasses only the named table', () => {
    const { sql } = qi('users', { users: softDelete }).buildFindMany({ skipGlobalFilters: [UNSAFE, 'users'] });
    assert.doesNotMatch(sql, /deleted_at/);
  });

  it('findUnique applies the filter (routed off the simple-equality path)', () => {
    const { sql, params } = qi('users', { users: softDelete }).buildFindUnique({ where: { id: 7 } });
    assert.match(sql, /"id" = \$1/);
    assert.match(sql, /"deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('count applies the filter', () => {
    const { sql, params } = qi('users', { users: { tenantId: 'x' } }).buildCount({ where: { id: 1 } });
    assert.match(sql, /"id" = \$/);
    assert.match(sql, /"tenant_id" = \$/);
    assertParamsAligned(sql, params);
  });

  it('aggregate applies the filter', () => {
    const { sql, params } = qi('users', { users: softDelete }).buildAggregate({ _count: true });
    assert.match(sql, /WHERE "deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('groupBy applies the filter', () => {
    const { sql, params } = qi('users', { users: { tenantId: 't' } }).buildGroupBy({ by: ['name'], _count: true });
    assert.match(sql, /"tenant_id" = \$/);
    assertParamsAligned(sql, params);
  });
});

// ---------------------------------------------------------------------------
// Mutations + empty-where guard interplay
// ---------------------------------------------------------------------------

describe('global filters, mutations', () => {
  it('update merges the filter into WHERE and keeps params aligned', () => {
    const { sql, params } = qi('users', { users: softDelete }).buildUpdate({
      where: { id: 1 },
      data: { name: 'x' },
    });
    assert.match(sql, /"deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('the empty-where guard checks the USER where, NOT the global filter', () => {
    // Empty user where + a global filter must STILL be refused: the filter does
    // not turn an unguarded mass mutation into an allowed one.
    assert.throws(
      () => qi('users', { users: softDelete }).buildUpdate({ where: {}, data: { name: 'x' } }),
      ValidationError,
    );
    assert.throws(() => qi('users', { users: softDelete }).buildDelete({ where: {} }), ValidationError);
    assert.throws(
      () => qi('users', { users: softDelete }).buildDeleteMany({ where: { id: undefined } }),
      ValidationError,
    );
  });

  it('allowFullTableScan still applies the filter to the compiled SQL', () => {
    const { sql, params } = qi('users', { users: softDelete }).buildDeleteMany({
      where: {},
      allowFullTableScan: UNSAFE,
    });
    assert.match(sql, /"deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('updateMany / deleteMany merge the filter', () => {
    const um = qi('users', { users: softDelete }).buildUpdateMany({ where: { id: 1 }, data: { name: 'x' } });
    assert.match(um.sql, /"deleted_at" IS NULL/);
    assertParamsAligned(um.sql, um.params);
    const dm = qi('users', { users: softDelete }).buildDeleteMany({ where: { id: 1 } });
    assert.match(dm.sql, /"deleted_at" IS NULL/);
    assertParamsAligned(dm.sql, dm.params);
  });

  it('skipGlobalFilters opts a mutation out', () => {
    const { sql } = qi('users', { users: softDelete }).buildDelete({ where: { id: 1 }, skipGlobalFilters: UNSAFE });
    assert.doesNotMatch(sql, /deleted_at/);
  });

  it('create / createMany are NEVER filtered', () => {
    const c = qi('users', { users: softDelete }).buildCreate({ data: { name: 'x' } as never });
    assert.doesNotMatch(c.sql, /deleted_at/);
    const cm = qi('users', { users: softDelete }).buildCreateMany({ data: [{ name: 'x' } as never] });
    assert.doesNotMatch(cm.sql, /deleted_at/);
  });

  it('upsert restricts the conflict-UPDATE with the filter (Postgres)', () => {
    const { sql, params } = qi('users', { users: softDelete }).buildUpsert({
      where: { id: 1 },
      create: { id: 1, name: 'x' } as never,
      update: { name: 'y' } as never,
    });
    // Table-qualified: inside `ON CONFLICT ... DO UPDATE ... WHERE` both the
    // target and `excluded` are in scope, so a bare column is 42702.
    assert.match(sql, /ON CONFLICT .* DO UPDATE SET .* WHERE "users"\."deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });
});

// ---------------------------------------------------------------------------
// Relations, join strategy
// ---------------------------------------------------------------------------

/**
 * One case per relation cardinality: the table the query runs on, the `with`
 * key, and the target table the global filter is configured for.
 */
const RELATION_CASES = [
  { kind: 'hasMany', from: 'users', rel: 'posts', target: 'posts' },
  { kind: 'hasOne', from: 'users', rel: 'profile', target: 'profiles' },
  { kind: 'belongsTo', from: 'posts', rel: 'author', target: 'users' },
  { kind: 'manyToMany', from: 'users', rel: 'orgs', target: 'orgs' },
] as const;

/**
 * The `with` spec shapes a relation can be written in. `true` is not a third
 * kind of spec, it is shorthand for `{}`, and the two must compile to the same
 * statement with the same params: every walker over the `with` tree has to read
 * the shorthand the same way. When the build path expanded it and the collect
 * path early-returned on it, a value-bearing target filter emitted a `$N` that
 * no value backed.
 */
const SPEC_SHAPES: [label: string, spec: true | Record<string, unknown>][] = [
  ['true (default include)', true],
  ['{} (explicit empty options)', {}],
  ['{ where }', { where: { id: 1 } }],
  ['{ limit: 5 }', { limit: 5 }],
  ['{ orderBy }', { orderBy: { id: 'desc' } }],
  ['{ select }', { select: { id: true } }],
];

describe('global filters, relation subqueries (join)', () => {
  for (const { kind, from, rel, target } of RELATION_CASES) {
    for (const [shapeLabel, spec] of SPEC_SHAPES) {
      it(`${kind}: a VALUE target filter binds its param for \`with: { ${rel}: ${shapeLabel} }\``, () => {
        const { sql, params } = qi(from, { [target]: tenancy }).buildFindMany({
          with: { [rel]: spec } as unknown as WithClause,
        });
        // The filter must reach the correlated subquery...
        assert.match(sql, /"tenant_id" = \$\d+/);
        // ...and the collect path must have pushed the value that backs it.
        // These two assertions are the whole point: the build path was already
        // correct, the params array is what the driver binds.
        assert.ok(params.includes(TENANT), `expected the filter value in params, got ${JSON.stringify(params)}`);
        assertParamsAligned(sql, params);
      });
    }

    it(`${kind}: \`${rel}: true\` compiles identically to \`${rel}: {}\``, () => {
      const shorthand = qi(from, { [target]: tenancy }).buildFindMany({
        with: { [rel]: true } as unknown as WithClause,
      });
      const explicit = qi(from, { [target]: tenancy }).buildFindMany({
        with: { [rel]: {} } as unknown as WithClause,
      });
      assert.equal(shorthand.sql, explicit.sql);
      assert.deepEqual(shorthand.params, explicit.params);
    });

    it(`${kind}: a PARAMETERLESS target filter still applies (and binds nothing)`, () => {
      const { sql, params } = qi(from, { [target]: softDelete }).buildFindMany({
        with: { [rel]: true } as unknown as WithClause,
      });
      assert.match(sql, /"deleted_at" IS NULL/);
      assert.deepEqual(params, []);
      assertParamsAligned(sql, params);
    });
  }

  it('hasMany subquery filters the target table', () => {
    const { sql, params } = qi('users', { posts: softDelete }).buildFindMany({ with: { posts: true } });
    // The correlated posts subquery must AND the target filter.
    assert.match(sql, /FROM "posts" t0 WHERE .*"user_id" = "users"\."id".* AND t0\."deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('hasOne subquery filters the target table', () => {
    const { sql, params } = qi('users', { profiles: softDelete }).buildFindMany({ with: { profile: true } });
    assert.match(sql, /FROM "profiles" t0 WHERE .* AND t0\."deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('belongsTo subquery filters the target table', () => {
    const { sql, params } = qi('posts', { users: softDelete }).buildFindMany({ with: { author: true } });
    assert.match(sql, /FROM "users" t0 WHERE .* AND t0\."deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('manyToMany subquery filters the target table', () => {
    const { sql, params } = qi('users', { orgs: softDelete }).buildFindMany({ with: { orgs: true } });
    assert.match(sql, /"deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('nested one level deeper: `true` at depth 2 binds the nested target filter', () => {
    // users → posts → author(users). The filter is on `users`, so it applies to
    // the top-level query AND to the depth-2 subquery: two bound values, and a
    // collect path that skips the `true` leaf leaves the second unbacked.
    const { sql, params } = qi('users', { users: tenancy }).buildFindMany({
      with: { posts: { with: { author: true } } } as unknown as WithClause,
    });
    assert.equal(sql.match(/"tenant_id" = \$\d+/g)?.length, 2, `expected the filter at both levels: ${sql}`);
    assert.deepEqual(params, [TENANT, TENANT]);
    assertParamsAligned(sql, params);
  });

  it('nested one level deeper, WRAPPED parent (limit/orderBy) keeps depth-2 params aligned', () => {
    // A parent `limit` moves nested relations into the inner subquery, which is
    // a different push order on both paths.
    const { sql, params } = qi('users', { users: tenancy }).buildFindMany({
      with: { posts: { limit: 2, orderBy: { id: 'desc' }, with: { author: true } } } as unknown as WithClause,
    });
    assert.equal(sql.match(/"tenant_id" = \$\d+/g)?.length, 2, `expected the filter at both levels: ${sql}`);
    assert.ok(params.filter((v) => v === TENANT).length === 2);
    assertParamsAligned(sql, params);
  });

  it('a VALUE target filter is re-collected on a SQL cache HIT (`true` shorthand)', () => {
    // The second build takes the cached SQL and rebuilds params through the
    // collect path alone. A collect path that pushes nothing for `true` fails
    // here as a lockstep violation rather than a bind error.
    const q = qi('users', { posts: tenancy });
    const args = { with: { posts: true } } as never;
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(first.sql, second.sql);
    assert.deepEqual(first.params, second.params);
    assert.deepEqual(second.params, [TENANT]);
    assertParamsAligned(second.sql, second.params);
  });

  it('findUnique takes the same relation path (`true` shorthand)', () => {
    const { sql, params } = qi('users', { posts: tenancy }).buildFindUnique({
      where: { id: 1 },
      with: { posts: true } as unknown as WithClause,
    });
    assert.match(sql, /"tenant_id" = \$\d+/);
    assert.ok(params.includes(TENANT));
    assertParamsAligned(sql, params);
  });

  it('a filtered relation subquery with its own where keeps params aligned', () => {
    const { sql, params } = qi('users', { posts: softDelete }).buildFindMany({
      with: { posts: { where: { title: 'hi' }, limit: 5 } },
      where: { id: 3 },
    });
    assert.match(sql, /"deleted_at" IS NULL/);
    assert.deepEqual(params[0], 3); // top-level where first
    assertParamsAligned(sql, params);
  });

  it('a VALUE (parameterized) target filter keeps subquery params aligned', () => {
    // Exercises gf-param push inside a correlated subquery, interleaved with a
    // top-level where param and the relation's own where param.
    const { sql, params } = qi('users', { posts: { title: { not: 'spam' } } }).buildFindMany({
      where: { id: 3 },
      with: { posts: { where: { title: 'hi' } } },
    });
    assert.match(sql, /t0\."title" != \$/);
    assert.deepEqual(params[0], 3);
    assert.ok(params.includes('hi') && params.includes('spam'));
    assertParamsAligned(sql, params);
  });

  it('_count filters the counted target', () => {
    const { sql, params } = qi('users', { posts: softDelete }).buildFindMany({
      // Record-form _count needs a cast on untyped clients (see WS-A note in types.ts)
      with: { _count: { posts: true } } as unknown as WithClause,
    });
    assert.match(sql, /SELECT COUNT\(\*\)::int FROM "posts" .* AND .*"deleted_at" IS NULL.* AS "_count__posts"/);
    assertParamsAligned(sql, params);
  });

  it('to-many relation orderBy _count filters the counted target', () => {
    const { sql, params } = qi('users', { posts: softDelete }).buildFindMany({
      orderBy: { posts: { _count: 'desc' } },
    });
    assert.match(sql, /SELECT COUNT\(\*\)::int FROM "posts" .* AND .*"deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });
});

// ---------------------------------------------------------------------------
// SQL Server relation subqueries (FOR JSON PATH)
// ---------------------------------------------------------------------------

/**
 * SQL Server overrides `buildRelationSubquery` wholesale (`FOR JSON PATH`), so it
 * does NOT reach the shared correlated-subquery builder the block above covers.
 * That override is handed a `RelationSubqueryContext`, which carries no
 * `BuilderCtx` and therefore no `globalFilters`; the target's filter can only be
 * applied by the `buildWhere` closure the core hands it.
 *
 * Until 0.76 that closure compiled the caller's `where` alone, so a global filter
 * on a relation TARGET was dropped from every SQL Server nested read while its
 * value was still pushed by the collect path: the predicate vanished (a
 * cross-tenant read on a multi-tenant schema) and an orphan param rode along.
 * These assertions are the inverse of that measurement, one per relation shape.
 */
describe('global filters, relation subqueries (SQL Server FOR JSON PATH)', () => {
  /** `assertParamsAligned` for `@pN`, the placeholder SQL Server binds. */
  function assertMssqlParamsAligned(sql: string, params: unknown[]): void {
    const referenced = new Set<number>();
    for (const m of sql.matchAll(/@p(\d+)/g)) referenced.add(Number(m[1]));
    const max = referenced.size ? Math.max(...referenced) : 0;
    assert.equal(max, params.length, `SQL references up to @p${max} but got ${params.length} params: ${sql}`);
    for (let i = 1; i <= params.length; i++) {
      assert.ok(referenced.has(i), `param @p${i} never referenced: ${sql}`);
    }
  }

  function mssqlQi(table: string, filters: QueryInterfaceOptions['globalFilters']) {
    return makeQuery(table, schema(), { globalFilters: filters, dialect: mssqlDialect });
  }

  for (const { kind, from, rel, target } of RELATION_CASES) {
    for (const [shapeLabel, spec] of SPEC_SHAPES) {
      it(`${kind}: a VALUE target filter reaches the FOR JSON PATH subquery for \`${rel}: ${shapeLabel}\``, () => {
        const { sql, params } = mssqlQi(from, { [target]: tenancy }).buildFindMany({
          with: { [rel]: spec } as unknown as WithClause,
        });
        // The predicate itself. Its ABSENCE is the cross-tenant read, and it is
        // invisible from the params array alone, which is why both are asserted.
        assert.match(sql, /\[tenant_id\] = @p\d+/, `target filter missing from the subquery: ${sql}`);
        assert.ok(params.includes(TENANT), `expected the filter value in params, got ${JSON.stringify(params)}`);
        assertMssqlParamsAligned(sql, params);
      });
    }

    it(`${kind}: \`${rel}: true\` compiles identically to \`${rel}: {}\``, () => {
      const shorthand = mssqlQi(from, { [target]: tenancy }).buildFindMany({
        with: { [rel]: true } as unknown as WithClause,
      });
      const explicit = mssqlQi(from, { [target]: tenancy }).buildFindMany({
        with: { [rel]: {} } as unknown as WithClause,
      });
      assert.equal(shorthand.sql, explicit.sql);
      assert.deepEqual(shorthand.params, explicit.params);
    });

    it(`${kind}: a PARAMETERLESS target filter still applies (and binds nothing)`, () => {
      const { sql, params } = mssqlQi(from, { [target]: softDelete }).buildFindMany({
        with: { [rel]: true } as unknown as WithClause,
      });
      assert.match(sql, /\[deleted_at\] IS NULL/);
      assert.deepEqual(params, []);
      assertMssqlParamsAligned(sql, params);
    });

    it(`${kind}: a caller \`where\` is ANDed with the target filter, not replaced by it`, () => {
      // The closure that applies the filter is the same one that compiles the
      // caller's where. Returning either alone is a silent wrong answer.
      const { sql, params } = mssqlQi(from, { [target]: tenancy }).buildFindMany({
        with: { [rel]: { where: { id: 7 } } } as unknown as WithClause,
      });
      assert.match(sql, /\[tenant_id\] = @p\d+/, `target filter missing: ${sql}`);
      assert.match(sql, /\[id\] = @p\d+/, `caller where missing: ${sql}`);
      assert.ok(params.includes(TENANT) && params.includes(7), JSON.stringify(params));
      assertMssqlParamsAligned(sql, params);
    });
  }

  it('a per-relation limit (the wrapped shape) keeps predicate and params aligned', () => {
    const { sql, params } = mssqlQi('users', { posts: tenancy }).buildFindMany({
      with: { posts: { limit: 5 } } as unknown as WithClause,
    });
    assert.match(sql, /\[tenant_id\] = @p\d+/);
    assert.ok(params.includes(TENANT));
    assertMssqlParamsAligned(sql, params);
  });
});

// ---------------------------------------------------------------------------
// Relation filters (some / none / every)
// ---------------------------------------------------------------------------

describe('global filters, relation filters', () => {
  it('some: EXISTS domain is restricted by the target filter', () => {
    const { sql, params } = qi('users', { posts: softDelete }).buildFindMany({
      where: { posts: { some: { title: 'x' } } },
    });
    assert.match(sql, /EXISTS \(SELECT 1 FROM "posts" WHERE .*"posts"\."deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('none: NOT EXISTS domain is restricted by the target filter', () => {
    const { sql, params } = qi('users', { posts: softDelete }).buildFindMany({
      where: { posts: { none: { title: 'x' } } },
    });
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "posts" WHERE .*"posts"\."deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });

  it('every: the quantifier ranges over only surviving rows', () => {
    const { sql, params } = qi('users', { posts: softDelete }).buildFindMany({
      where: { posts: { every: { title: 'x' } } },
    });
    // gf ANDed into the domain, before NOT(filter), "every non-deleted post matches".
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "posts" WHERE .*"posts"\."deleted_at" IS NULL AND NOT \(/);
    assertParamsAligned(sql, params);
  });

  it('some with a VALUE target filter keeps EXISTS params aligned', () => {
    const { sql, params } = qi('users', { posts: { title: { not: 'spam' } } }).buildFindMany({
      where: { id: 9, posts: { some: { title: 'x' } } },
    });
    assert.match(sql, /EXISTS \(SELECT 1 FROM "posts" WHERE .*"posts"\."title" != \$/);
    assert.ok(params.includes('x') && params.includes('spam') && params.includes(9));
    assertParamsAligned(sql, params);
  });

  it('every with a VALUE target filter keeps params aligned', () => {
    const { sql, params } = qi('users', { posts: { title: { not: 'spam' } } }).buildFindMany({
      where: { posts: { every: { title: 'x' } } },
    });
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM "posts" WHERE .*"posts"\."title" != \$.* AND NOT \(/);
    assertParamsAligned(sql, params);
  });

  it('belongsTo `is` filter is restricted by the target filter', () => {
    const { sql, params } = qi('posts', { users: softDelete }).buildFindMany({
      where: { author: { is: { name: 'x' } } },
    });
    assert.match(sql, /EXISTS \(SELECT 1 FROM "users" WHERE .*"users"\."deleted_at" IS NULL/);
    assertParamsAligned(sql, params);
  });
});

// ---------------------------------------------------------------------------
// SQL cache safety
// ---------------------------------------------------------------------------

describe('global filters, SQL cache', () => {
  it('two different filter SHAPES never collide on one cache entry', () => {
    let mode: 'null' | 'value' = 'null';
    const q = qi('users', {
      users: () => (mode === 'null' ? { deletedAt: null } : { tenantId: 't' }),
    });
    const a = q.buildFindMany();
    mode = 'value';
    const b = q.buildFindMany();
    assert.notEqual(a.sql, b.sql, 'different shapes must produce different SQL');
    assert.match(a.sql, /"deleted_at" IS NULL/);
    assert.match(b.sql, /"tenant_id" = \$1/);
    assert.deepEqual(b.params, ['t']);
  });

  it('cache HIT re-collects relation-subquery + _count gf params in build order', () => {
    // Build twice on ONE QI: the second call hits the SQL cache and rebuilds
    // params via the collect path only. A value gf in the subquery + _count is
    // the desync-prone case, both builds must stay aligned and identical.
    const q = qi('users', { posts: { title: { not: 'spam' } } });
    const args = {
      where: { id: 3 },
      with: { posts: { where: { title: 'hi' } }, _count: { posts: true } } as unknown as WithClause,
    };
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(first.sql, second.sql);
    assert.deepEqual(first.params, second.params);
    assertParamsAligned(second.sql, second.params);
  });

  it('same shape, different values → same SQL text, distinct params', () => {
    let tenant = 'x';
    const q = qi('users', { users: () => ({ tenantId: tenant }) });
    const a = q.buildFindMany({ where: { id: 1 } });
    tenant = 'y';
    const b = q.buildFindMany({ where: { id: 2 } });
    assert.equal(a.sql, b.sql);
    assert.deepEqual(a.params, [1, 'x']);
    assert.deepEqual(b.params, [2, 'y']);
  });

  it("another table's relation-filter shapes are fingerprinted with THAT table's host", () => {
    // A function filter for `posts` whose shape varies inside a nested
    // RELATION filter (`author` is a relation of posts, not of users). The
    // root (users) host would classify `author` as an opaque scalar object,
    // collapsing both shapes to one cache key while the built SQL differs:
    // the classic poisoned-cache setup. The posts host must tell them apart.
    let mode: 'byName' | 'byId' = 'byName';
    const q = qi('users', {
      posts: () => (mode === 'byName' ? { author: { is: { name: 'x' } } } : { author: { is: { id: 1 } } }),
    });
    const a = q.buildFindMany({ with: { posts: true } as unknown as WithClause });
    mode = 'byId';
    const b = q.buildFindMany({ with: { posts: true } as unknown as WithClause });
    assert.notEqual(a.sql, b.sql, 'different nested relation-filter shapes must not share a cache entry');
    assert.match(a.sql, /"name" = \$\d+/);
    assert.match(b.sql, /"id" = \$\d+/);
  });
});

// ---------------------------------------------------------------------------
// Client-level: reaches the wire, threads through batched, applies on replicas
// ---------------------------------------------------------------------------

/** One statement as it reached the driver: the text AND the values bound to it. */
interface RecordedStatement {
  text: string;
  values: unknown[];
}

interface RecordingPool extends PgCompatPool {
  readonly label: string;
  readonly queries: string[];
  /**
   * Every statement with its bound values. The text alone cannot show a
   * missing param: a `$2` the collect path never filled looks identical in
   * `queries`, and only a real server rejects it. Recording the values lets a
   * no-DB test assert what Postgres would have.
   */
  readonly statements: RecordedStatement[];
}

function makeRecordingPool(label: string, rows: Record<string, unknown>[] = []): RecordingPool {
  const pool: RecordingPool = {
    label,
    queries: [],
    statements: [],
    // biome-ignore lint/suspicious/noExplicitAny: mock result shape
    query: (async (textOrConfig: any, maybeValues?: any) => {
      const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
      const values = (typeof textOrConfig === 'string' ? maybeValues : textOrConfig.values) ?? [];
      pool.queries.push(text);
      pool.statements.push({ text, values });
      return { rows, rowCount: rows.length, fields: [] };
    }) as PgCompatPool['query'],
    connect: async (): Promise<PgCompatPoolClient> => ({
      query: (async () => ({ rows: [], rowCount: 0, fields: [] })) as PgCompatPoolClient['query'],
      release: () => {},
    }),
    end: async () => {},
  };
  return pool;
}

describe('global filters, client level', () => {
  it('a configured filter reaches the wire on a plain read', async () => {
    const pool = makeRecordingPool('primary', [{ id: 1, name: 'x' }]);
    const db = new TurbineClient({ pool, globalFilters: { users: softDelete } }, schema());
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    await (db as any).users.findMany();
    assert.ok(
      pool.queries.some((q) => /deleted_at/.test(q)),
      `expected a filtered query, got: ${pool.queries.join(' | ')}`,
    );
    await db.disconnect();
  });

  it('the batched strategy applies the filter to child relation loads', async () => {
    // `user_id` is on the canned row because ONE stub answers every statement,
    // including the child posts follow-up whose rows the loader stitches by
    // that key. Without it the loader refuses the relation outright rather
    // than returning a silently empty one, which is the intended behaviour and
    // means the fixture, not the library, was the unrealistic part.
    const pool = makeRecordingPool('primary', [{ id: 1, name: 'x', user_id: 1 }]);
    const db = new TurbineClient(
      { pool, globalFilters: { posts: softDelete }, relationLoadStrategy: 'batched' },
      schema(),
    );
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    await (db as any).users.findMany({ with: { posts: true } });
    // The base users query has no filter; the child posts query must.
    const postQueries = pool.queries.filter((q) => /FROM "posts"/.test(q));
    assert.ok(postQueries.length > 0, 'expected a child posts query');
    assert.ok(
      postQueries.every((q) => /deleted_at/.test(q)),
      `child posts load must be filtered: ${postQueries.join(' | ')}`,
    );
    await db.disconnect();
  });

  it('the batched _count applies the filter (hasMany)', async () => {
    const pool = makeRecordingPool('primary', [{ id: 1, name: 'x' }]);
    const db = new TurbineClient(
      { pool, globalFilters: { posts: softDelete }, relationLoadStrategy: 'batched' },
      schema(),
    );
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    await (db as any).users.findMany({ with: { _count: { posts: true } } });
    const countQuery = pool.queries.find((q) => /COUNT\(\*\)/.test(q) && /FROM "posts"/.test(q));
    assert.ok(countQuery, `expected a grouped count query: ${pool.queries.join(' | ')}`);
    assert.match(countQuery as string, /deleted_at/);
    await db.disconnect();
  });

  /**
   * What a real server enforces at bind time, asserted locally: every `$N` the
   * statement references must be backed by a value. This is the invariant the
   * relation-target global filter broke, and it is invisible to an assertion
   * that only greps the SQL text.
   */
  function assertEveryStatementBound(pool: RecordingPool): void {
    for (const { text, values } of pool.statements) {
      const referenced = new Set<number>();
      for (const m of text.matchAll(/\$(\d+)/g)) referenced.add(Number(m[1]));
      const max = referenced.size ? Math.max(...referenced) : 0;
      assert.equal(
        max,
        values.length,
        `statement references up to $${max} but ${values.length} value(s) were bound: ${text}`,
      );
    }
  }

  // Every relation-loading strategy has to agree about a target global filter,
  // for BOTH `with` spellings. `auto` matters on its own: it picks join or
  // batched per relation, so a bug in one plan surfaces only for the schemas
  // whose indexes make `auto` choose it.
  for (const strategy of ['join', 'batched', 'auto'] as const) {
    for (const [shapeLabel, spec] of [
      ['true', true],
      ['{}', {}],
      ['{ where }', { where: { title: 'hi' } }],
    ] as [string, unknown][]) {
      it(`${strategy}: a VALUE target filter binds every placeholder for \`posts: ${shapeLabel}\``, async () => {
        // `user_id` is on the canned row so the batched loader can stitch the
        // child rows it fetches (see the note on the batched test below).
        const pool = makeRecordingPool('primary', [{ id: 1, name: 'x', user_id: 1, tenant_id: TENANT }]);
        const db = new TurbineClient(
          { pool, globalFilters: { posts: tenancy }, relationLoadStrategy: strategy },
          schema(),
        );
        // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
        await (db as any).users.findMany({ with: { posts: spec } });
        const postStatements = pool.statements.filter((q) => /"posts"/.test(q.text));
        assert.ok(postStatements.length > 0, `expected a posts statement: ${pool.queries.join(' | ')}`);
        assert.ok(
          postStatements.some((q) => q.values.includes(TENANT)),
          `the target filter value must be bound: ${JSON.stringify(postStatements)}`,
        );
        assertEveryStatementBound(pool);
        await db.disconnect();
      });
    }

    it(`${strategy}: nested one level deeper keeps every placeholder bound`, async () => {
      const pool = makeRecordingPool('primary', [{ id: 1, name: 'x', user_id: 1, tenant_id: TENANT }]);
      const db = new TurbineClient(
        { pool, globalFilters: { users: tenancy }, relationLoadStrategy: strategy },
        schema(),
      );
      // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
      await (db as any).users.findMany({ with: { posts: { with: { author: true } } } });
      assertEveryStatementBound(pool);
      await db.disconnect();
    });
  }

  it('the filter applies identically when a read is routed to a replica', async () => {
    const primary = makeRecordingPool('primary', [{ id: 1, name: 'x' }]);
    const replica = makeRecordingPool('replica', [{ id: 1, name: 'x' }]);
    const db = new TurbineClient(
      { pool: primary, replicas: [replica], globalFilters: { users: softDelete } },
      schema(),
    );
    // biome-ignore lint/suspicious/noExplicitAny: dynamic table accessor
    await (db as any).users.findMany();
    assert.equal(primary.queries.length, 0, 'read must route to the replica');
    assert.ok(replica.queries.length > 0, 'replica served the read');
    assert.ok(
      replica.queries.every((q) => /deleted_at/.test(q)),
      `replica read must be filtered: ${replica.queries.join(' | ')}`,
    );
    await db.disconnect();
  });
});
