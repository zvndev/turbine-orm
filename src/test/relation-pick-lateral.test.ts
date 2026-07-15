/**
 * turbine-orm: opt-in LATERAL plan for pick-row relation ordering
 *
 * `orderBy: { versions: { pick, by, plan: 'lateral' } }` compiles the pick-row
 * ordering as a `LEFT JOIN LATERAL (... LIMIT 1) ON true` spliced into the FROM
 * clause, ordering by the joined value's single reserved output column:
 *
 *   SELECT "instances".* FROM "instances"
 *   LEFT JOIN LATERAL (
 *     SELECT ord0i."title" AS "__turbine_pick" FROM "versions" ord0i
 *     WHERE ord0i."instance_id" = "instances"."id"
 *     ORDER BY ord0i."created_at" DESC LIMIT 1
 *   ) ord0 ON true
 *   ORDER BY ord0."__turbine_pick" ASC NULLS LAST
 *
 * Default is `plan: 'subquery'` (byte-for-byte the pre-lateral SQL). The lateral
 * form is PostgreSQL-only (E017 elsewhere), refuses distinct / nested / a parent
 * column literally named `__turbine_pick` (all E003), and produces IDENTICAL
 * results to the subquery plan. Param push order is identical between the two
 * plans, so the cache-hit collect mirror is plan-agnostic.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { PowqlInterface } from '../powql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      instances: mockTable(
        'instances',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          versions: {
            type: 'hasMany',
            name: 'versions',
            from: 'instances',
            to: 'versions',
            foreignKey: 'instance_id',
            referenceKey: 'id',
          },
          logs: {
            type: 'hasMany',
            name: 'logs',
            from: 'instances',
            to: 'logs',
            foreignKey: 'instance_id',
            referenceKey: 'id',
          },
          tags: {
            type: 'manyToMany',
            name: 'tags',
            from: 'instances',
            to: 'tags',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'instance_tags', sourceKey: 'instance_id', targetKey: 'tag_id' },
          },
          owner: {
            type: 'belongsTo',
            name: 'owner',
            from: 'instances',
            to: 'owners',
            foreignKey: 'owner_id',
            referenceKey: 'id',
          },
        },
      ),
      versions: mockTable('versions', [
        { name: 'id', field: 'id' },
        { name: 'instance_id', field: 'instanceId' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'data', field: 'data', pgType: 'jsonb' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
        { name: 'is_current', field: 'isCurrent', pgType: 'bool' },
      ]),
      logs: mockTable('logs', [
        { name: 'id', field: 'id' },
        { name: 'instance_id', field: 'instanceId' },
        { name: 'message', field: 'message', pgType: 'text' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
      ]),
      tags: mockTable('tags', [
        { name: 'id', field: 'id' },
        { name: 'label', field: 'label', pgType: 'text' },
      ]),
      instance_tags: mockTable('instance_tags', [
        { name: 'instance_id', field: 'instanceId' },
        { name: 'tag_id', field: 'tagId' },
      ]),
      owners: mockTable('owners', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

// ---------------------------------------------------------------------------
// SQL generation (build-only, no DB)
// ---------------------------------------------------------------------------

describe('pick-row lateral plan: SQL generation', () => {
  it('plain-column by → LEFT JOIN LATERAL in FROM, ORDER BY the reserved output column', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
    } as never);
    assert.equal(
      sql,
      'SELECT "instances".* FROM "instances" LEFT JOIN LATERAL (SELECT ord0i."title" AS "__turbine_pick" ' +
        'FROM "versions" ord0i WHERE ord0i."instance_id" = "instances"."id" ORDER BY ord0i."created_at" DESC ' +
        'LIMIT 1) ord0 ON true ORDER BY ord0."__turbine_pick" ASC NULLS LAST',
    );
    assert.deepEqual(params, []);
  });

  it('JSON-path by with type: numeric → cast extraction in the lateral SELECT, path bound as one text[]', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      orderBy: {
        versions: {
          pick: { orderBy: { createdAt: 'desc' } },
          by: { field: 'data', path: ['price'], type: 'numeric' },
          plan: 'lateral',
        },
      },
    } as never);
    assert.match(
      sql,
      /LEFT JOIN LATERAL \(SELECT \(ord0i\."data" #>> \$1::text\[\]\)::numeric AS "__turbine_pick" FROM "versions" ord0i/,
    );
    assert.match(sql, /ORDER BY ord0\."__turbine_pick" ASC NULLS LAST$/);
    assert.deepEqual(params, [['price']]);
  });

  it('param sequence is IDENTICAL to the subquery plan for the same args (collect mirror is plan-agnostic)', () => {
    const q = makeQuery('instances', schema());
    const args = (plan?: 'lateral') =>
      ({
        where: { name: 'n' },
        orderBy: {
          versions: {
            pick: {
              orderBy: { data: { path: ['rev'], type: 'numeric', direction: 'desc' } },
              where: { isCurrent: true },
            },
            by: { field: 'data', path: ['title'] },
            direction: 'desc',
            ...(plan ? { plan } : {}),
          },
        },
        limit: 3,
      }) as never;
    const sub = q.buildFindMany(args());
    const lat = q.buildFindMany(args('lateral'));
    // Push order: where → by-path → target-global-filter(none) → pick.where →
    // pick.orderBy path → limit. Same for both plans.
    assert.deepEqual(sub.params, ['n', ['title'], true, ['rev'], 3]);
    assert.deepEqual(lat.params, sub.params);
    // The SQL text differs (subquery vs lateral) but the params do not.
    assert.notEqual(sub.sql, lat.sql);
  });

  it('direction desc defaults to NULLS LAST; explicit nulls: first overrides', () => {
    const q = makeQuery('instances', schema());
    const desc = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', direction: 'desc', plan: 'lateral' },
      },
    } as never);
    assert.match(desc.sql, /ORDER BY ord0\."__turbine_pick" DESC NULLS LAST$/);
    const first = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', nulls: 'first', plan: 'lateral' },
      },
    } as never);
    assert.match(first.sql, /ORDER BY ord0\."__turbine_pick" ASC NULLS FIRST$/);
  });

  it('two lateral pick entries → two joins (ord0, ord1) in entry order, two qualified order terms', () => {
    const q = makeQuery('instances', schema());
    const { sql } = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' },
        logs: { pick: { orderBy: { createdAt: 'asc' } }, by: 'message', plan: 'lateral' },
      },
    } as never);
    // Two lateral joins, ord0 before ord1, correlated to the child tables.
    assert.match(
      sql,
      /FROM "instances" LEFT JOIN LATERAL \(SELECT ord0i\."title"[^)]*FROM "versions" ord0i[^)]*\) ord0 ON true/,
    );
    assert.match(sql, /LEFT JOIN LATERAL \(SELECT ord1i\."message"[^)]*FROM "logs" ord1i[^)]*\) ord1 ON true/);
    // The first lateral join text precedes the second.
    assert.ok(sql.indexOf('ord0 ON true') < sql.indexOf('ord1 ON true'));
    // Two qualified order terms in entry order.
    assert.match(sql, /ORDER BY ord0\."__turbine_pick" ASC NULLS LAST, ord1\."__turbine_pick" ASC NULLS LAST$/);
  });

  it('one lateral pick, one SUBQUERY pick in the same orderBy: only the lateral entry adds a join', () => {
    const q = makeQuery('instances', schema());
    const { sql } = q.buildFindMany({
      orderBy: {
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' },
        logs: { pick: { orderBy: { createdAt: 'asc' } }, by: 'message' },
      },
    } as never);
    // Exactly one LEFT JOIN LATERAL (the versions entry).
    assert.equal(sql.match(/LEFT JOIN LATERAL/g)?.length, 1);
    // The logs entry stays a correlated scalar subquery in ORDER BY.
    assert.match(
      sql,
      /ORDER BY ord0\."__turbine_pick" ASC NULLS LAST, \(SELECT ord1\."message" FROM "logs" ord1 WHERE ord1\."instance_id" = "instances"\."id" ORDER BY ord1\."created_at" ASC LIMIT 1\) ASC NULLS LAST$/,
    );
  });

  it('lateral pick alongside a plain column and a _count entry', () => {
    const q = makeQuery('instances', schema());
    const { sql } = q.buildFindMany({
      orderBy: {
        name: 'asc',
        versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral', direction: 'desc' },
        logs: { _count: 'desc' },
      },
    } as never);
    assert.match(sql, /FROM "instances" LEFT JOIN LATERAL \([^)]*FROM "versions" ord0i[^)]*\) ord0 ON true ORDER BY /);
    // Plain column term unqualified, lateral term qualified, _count subquery.
    assert.match(sql, /ORDER BY "name" ASC, ord0\."__turbine_pick" DESC NULLS LAST, \(SELECT COUNT\(\*\)/);
  });

  it('lateral pick + `with` clause: the `t0` relation subquery and the `ord0` join coexist, both correlate to the unaliased parent', () => {
    const q = makeQuery('instances', schema());
    const { sql } = q.buildFindMany({
      with: { owner: true },
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
    } as never);
    // The `with` subquery uses the t-namespace alias.
    assert.match(
      sql,
      /\(SELECT json_build_object\('id', t0\."id"[^)]*\) FROM "owners" t0 WHERE t0\."id" = "instances"\."owner_id" LIMIT 1\) AS "owner"/,
    );
    // The lateral uses the ord-namespace alias; disjoint from t0.
    assert.match(
      sql,
      /LEFT JOIN LATERAL \(SELECT ord0i\."title"[^)]*WHERE ord0i\."instance_id" = "instances"\."id"[^)]*\) ord0 ON true/,
    );
    // Both subqueries correlate to the unaliased parent table by name.
    assert.match(sql, /ord0i\."instance_id" = "instances"\."id"/); // lateral correlation
    assert.match(sql, /t0\."id" = "instances"\."owner_id"/); // with subquery correlation
  });

  it('lateral pick + cursor + limit + offset: qualified cursor condition, pagination params last', () => {
    const q = makeQuery('instances', schema());
    const { sql, params } = q.buildFindMany({
      cursor: { id: 50 },
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
      limit: 5,
      offset: 2,
    } as never);
    // Cursor condition is qualified and sits after the join, before ORDER BY.
    assert.match(
      sql,
      /ord0 ON true WHERE "instances"\."id" > \$1 ORDER BY ord0\."__turbine_pick" ASC NULLS LAST LIMIT \$2 OFFSET \$3$/,
    );
    assert.deepEqual(params, [50, 5, 2]);
  });

  it('findFirst with a lateral pick appends LIMIT 1', () => {
    const q = makeQuery('instances', schema());
    // biome-ignore lint/suspicious/noExplicitAny: buildFindFirst is a public build method
    const { sql, params } = (q as any).buildFindFirst({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
    });
    assert.match(
      sql,
      /LEFT JOIN LATERAL \([^)]*\) ord0 ON true ORDER BY ord0\."__turbine_pick" ASC NULLS LAST LIMIT \$1$/,
    );
    assert.deepEqual(params, [1]);
  });

  it("plan: 'subquery' explicitly is byte-identical to omitting plan", () => {
    const q = makeQuery('instances', schema());
    const omitted = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never);
    const explicit = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'subquery' } },
    } as never);
    assert.equal(explicit.sql, omitted.sql);
    assert.deepEqual(explicit.params, omitted.params);
  });
});

// ---------------------------------------------------------------------------
// Byte-equality regression: the buildSql restructure must not change any
// existing (default-plan) SQL shape. These literals are the pre-lateral output.
// ---------------------------------------------------------------------------

describe('pick-row lateral plan: byte-identical default-plan SQL (buildSql restructure regression)', () => {
  const cases: { name: string; args: unknown; sql: string; params: unknown[] }[] = [
    { name: 'plain', args: {}, sql: 'SELECT "instances".* FROM "instances"', params: [] },
    {
      name: 'where',
      args: { where: { name: 'x' } },
      sql: 'SELECT "instances".* FROM "instances" WHERE "name" = $1',
      params: ['x'],
    },
    {
      name: 'with-relations',
      args: { with: { versions: true } },
      sql:
        'SELECT "instances"."id", "instances"."name", (SELECT COALESCE(json_agg(json_build_object(\'id\', ' +
        't0."id", \'instanceId\', t0."instance_id", \'title\', t0."title", \'data\', t0."data", \'createdAt\', ' +
        't0."created_at", \'isCurrent\', t0."is_current")), \'[]\'::json) FROM "versions" t0 WHERE t0."instance_id" ' +
        '= "instances"."id") AS "versions" FROM "instances"',
      params: [],
    },
    {
      name: 'orderBy',
      args: { orderBy: { name: 'asc' } },
      sql: 'SELECT "instances".* FROM "instances" ORDER BY "name" ASC',
      params: [],
    },
    {
      name: 'pagination',
      args: { limit: 10, offset: 5, orderBy: { name: 'asc' } },
      sql: 'SELECT "instances".* FROM "instances" ORDER BY "name" ASC LIMIT $1 OFFSET $2',
      params: [10, 5],
    },
    {
      name: 'distinct',
      args: { distinct: ['name'], orderBy: { name: 'asc' } },
      sql:
        'SELECT * FROM (SELECT DISTINCT ON ("name") "instances".* FROM "instances" ORDER BY "name" ASC, "name" ASC) ' +
        'AS "instances_distinct" ORDER BY "name" ASC',
      params: [],
    },
    {
      name: 'cursor',
      args: { cursor: { id: 100 }, orderBy: { id: 'asc' }, limit: 5 },
      sql: 'SELECT "instances".* FROM "instances" WHERE "instances"."id" > $1 ORDER BY "id" ASC LIMIT $2',
      params: [100, 5],
    },
    {
      name: 'subquery-pick',
      args: { orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } } },
      sql:
        'SELECT "instances".* FROM "instances" ORDER BY (SELECT ord0."title" FROM "versions" ord0 WHERE ' +
        'ord0."instance_id" = "instances"."id" ORDER BY ord0."created_at" DESC LIMIT 1) ASC NULLS LAST',
      params: [],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: unchanged SQL + params`, () => {
      const q = makeQuery('instances', schema());
      const built = q.buildFindMany(c.args as never);
      assert.equal(built.sql, c.sql);
      assert.deepEqual(built.params, c.params);
    });
  }
});

// ---------------------------------------------------------------------------
// Dialect gating and error cases
// ---------------------------------------------------------------------------

describe('pick-row lateral plan: dialect gating (E017)', () => {
  const nonPg: [string, Dialect][] = [
    ['sqlite', sqliteDialect],
    ['mysql', mysqlDialect],
    ['mssql', mssqlDialect],
  ];
  for (const [name, dialect] of nonPg) {
    it(`plan: 'lateral' throws E017 on ${name} (naming the feature)`, () => {
      const q = makeQuery('instances', schema(), { dialect, sqlCache: false });
      assert.throws(
        () =>
          q.buildFindMany({
            orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
          } as never),
        (err: unknown) =>
          err instanceof UnsupportedFeatureError && err.code === 'TURBINE_E017' && /lateral/i.test(err.message),
      );
    });

    it(`plan: 'lateral' on ${name} throws on a WARMED cache too (validation shared with collect)`, () => {
      const q = makeQuery('instances', schema(), { dialect });
      const args = {
        orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
      } as never;
      assert.throws(() => q.buildFindMany(args), UnsupportedFeatureError);
      // Second call would hit the cache if the first had cached; the shared
      // validatePickOrderBy throws before any cache lookup either way.
      assert.throws(() => q.buildFindMany(args), UnsupportedFeatureError);
    });
  }

  it('the default plan (subquery) still compiles on non-Postgres engines', () => {
    const q = makeQuery('instances', schema(), { dialect: sqliteDialect, sqlCache: false });
    assert.doesNotThrow(() =>
      q.buildFindMany({
        orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
      } as never),
    );
  });
});

describe('pick-row lateral plan: hard-error contexts (never a silent fallback)', () => {
  it('an invalid plan value throws E003 (a typo must never silently run the subquery plan)', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'latreal' } },
        } as never),
      (err: unknown) =>
        err instanceof ValidationError && err.code === 'TURBINE_E003' && /invalid `plan`/.test(err.message),
    );
  });

  it('distinct + lateral pick throws the existing distinct E003 (message unchanged)', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          distinct: ['name'],
          orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
        } as never),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === 'TURBINE_E003' &&
        /`distinct` cannot be combined with relation orderBy/.test(err.message),
    );
  });

  it('nested `with` orderBy pick with plan: the existing top-level-only E003', () => {
    const s = schema();
    // versions self-relation so the nested `with` has a hasMany to pick on.
    s.tables.versions!.relations = {
      revisions: {
        type: 'hasMany',
        name: 'revisions',
        from: 'versions',
        to: 'versions',
        foreignKey: 'instance_id',
        referenceKey: 'id',
      },
    };
    const q = makeQuery('instances', s);
    assert.throws(
      () =>
        q.buildFindMany({
          with: {
            versions: {
              orderBy: { revisions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
            },
          },
        } as never),
      (err: unknown) =>
        err instanceof ValidationError &&
        err.code === 'TURBINE_E003' &&
        /only supported in a top-level/.test(err.message),
    );
  });

  it('manyToMany + lateral pick throws the existing hasMany-only E003', () => {
    const q = makeQuery('instances', schema());
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: { tags: { pick: { orderBy: { label: 'asc' } }, by: 'label', plan: 'lateral' } },
        } as never),
      (err: unknown) => err instanceof ValidationError && /manyToMany/.test(err.message),
    );
  });

  it('a parent column literally named "__turbine_pick" throws E003 (reserved-name guard)', () => {
    const s = schema();
    s.tables.instances = mockTable(
      'instances',
      [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: '__turbine_pick', field: 'turbinePick', pgType: 'text' },
      ],
      s.tables.instances!.relations,
    );
    const q = makeQuery('instances', s);
    assert.throws(
      () =>
        q.buildFindMany({
          orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
        } as never),
      (err: unknown) =>
        err instanceof ValidationError && err.code === 'TURBINE_E003' && /__turbine_pick/.test(err.message),
    );
    // The default subquery plan is unaffected by that column's existence.
    assert.doesNotThrow(() =>
      q.buildFindMany({
        orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
      } as never),
    );
  });

  it('PowDB still refuses pick ordering with plan, naming "relation pick-row ordering" (E017)', async () => {
    const pool = { query: () => Promise.resolve({ rows: [], rowCount: 0 }) } as never;
    const q = new PowqlInterface(pool, 'instances', schema());
    await assert.rejects(
      () =>
        q.findMany({
          orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
        } as never),
      (err: unknown) =>
        err instanceof UnsupportedFeatureError &&
        err.code === 'TURBINE_E017' &&
        /relation pick-row ordering/.test(err.message),
    );
  });
});

// ---------------------------------------------------------------------------
// Cache safety: the plan discriminator keeps the two plans on distinct entries
// ---------------------------------------------------------------------------

describe('pick-row lateral plan: cache safety', () => {
  it('double-run identity: a lateral pick rebuilds byte-identical SQL + params', () => {
    const q = makeQuery('instances', schema());
    const args = {
      where: { name: 'n' },
      orderBy: {
        versions: {
          pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: true } },
          by: { field: 'data', path: ['title'] },
          plan: 'lateral',
        },
      },
      limit: 3,
    } as never;
    const first = q.buildFindMany(args);
    const second = q.buildFindMany(args);
    assert.equal(second.sql, first.sql);
    assert.deepEqual(second.params, first.params);
    assert.deepEqual(first.params, ['n', ['title'], true, 3]);
  });

  it('subquery and lateral plans for otherwise-identical args never share a cache entry', () => {
    const q = makeQuery('instances', schema());
    const sub = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } },
    } as never);
    const lat = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
    } as never);
    assert.notEqual(sub.sql, lat.sql);
    assert.ok(!sub.sql.includes('LEFT JOIN LATERAL'));
    assert.ok(lat.sql.includes('LEFT JOIN LATERAL'));
    // Warming subquery first must NOT let a later lateral call be served the
    // subquery SQL (distinct fingerprints).
    const q2 = makeQuery('instances', schema());
    q2.buildFindMany({ orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title' } } } as never);
    const latAfterSub = q2.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
    } as never);
    assert.ok(latAfterSub.sql.includes('LEFT JOIN LATERAL'));
  });
});

// ---------------------------------------------------------------------------
// Batched relation-load strategy: the lateral survives in the batched base
// ---------------------------------------------------------------------------

describe('pick-row lateral plan: batched base query', () => {
  it('the lateral join text is byte-identical in the batched base and the join-strategy query', () => {
    const q = makeQuery('instances', schema());
    // Standalone (join-strategy) lateral pick, no `with`.
    const standalone = q.buildFindMany({
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
    } as never);
    const fragment = standalone.sql.match(/ LEFT JOIN LATERAL \(.*?\) ord0 ON true/)?.[0];
    assert.ok(fragment, 'expected a lateral join fragment in the standalone query');

    // What runFindManyBatched feeds buildFindMany: the same args with `with`
    // dropped (prepareBatchedBase). The lateral pick orderBy flows through
    // verbatim, so the base query carries the SAME lateral join text.
    const withArgs = {
      with: { owner: true },
      orderBy: { versions: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', plan: 'lateral' } },
    };
    // biome-ignore lint/suspicious/noExplicitAny: reach the private batched-base helper
    const { baseArgs } = (q as any).prepareBatchedBase(withArgs, withArgs.with);
    const base = q.buildFindMany(baseArgs);
    assert.ok(base.sql.includes(fragment!), `batched base is missing the lateral join:\n${base.sql}`);
    // The `with` subquery is dropped from the base (loaded separately).
    assert.ok(!base.sql.includes('AS "owner"'), 'batched base must not carry the `with` subquery');
  });
});

// ---------------------------------------------------------------------------
// Integration (requires DATABASE_URL): result-set equality between plans
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping pick-row lateral integration tests: DATABASE_URL not set');
}

describe('pick-row lateral plan: integration (result-set equality vs subquery plan)', () => {
  const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');
  let db: TurbineClient;
  let schemaMeta: SchemaMetadata;
  const PARENTS = '_latpick_instances';
  const CHILDREN = '_latpick_versions';

  before(async () => {
    const setup = new pg.Client({ connectionString: DATABASE_URL! });
    await setup.connect();
    try {
      await setup.query(`DROP TABLE IF EXISTS ${CHILDREN}`);
      await setup.query(`DROP TABLE IF EXISTS ${PARENTS}`);
      await setup.query(`CREATE TABLE ${PARENTS} (id serial PRIMARY KEY, name text NOT NULL)`);
      await setup.query(
        `CREATE TABLE ${CHILDREN} (
           id serial PRIMARY KEY,
           instance_id int NOT NULL REFERENCES ${PARENTS}(id),
           title text,
           data jsonb NOT NULL DEFAULT '{}',
           is_current boolean NOT NULL DEFAULT false,
           created_at timestamptz NOT NULL
         )`,
      );
      await setup.query(`INSERT INTO ${PARENTS} (name) VALUES ('p1'), ('p2'), ('p3'), ('p4'), ('p5')`);
      await setup.query(
        `INSERT INTO ${CHILDREN} (instance_id, title, data, is_current, created_at) VALUES
           (1, 'zebra',    '{"rank": 9}', false, '2024-01-01'),
           (1, 'banana',   '{"rank": 2}', true,  '2024-03-01'),
           (2, 'apple',    '{"rank": 3}', true,  '2024-02-01'),
           (2, 'aardvark', '{"rank": 1}', false, '2024-01-15'),
           (3, NULL,       '{"rank": 1}', true,  '2024-04-01'),
           (5, 'cherry',   '{"rank": 4}', false, '2024-05-01')`,
      );
      // p4 has no versions at all; p5 has one non-current version.
    } finally {
      await setup.end();
    }
    schemaMeta = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3 }, schemaMeta);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    const teardown = new pg.Client({ connectionString: DATABASE_URL! });
    await teardown.connect();
    try {
      await teardown.query(`DROP TABLE IF EXISTS ${CHILDREN}`);
      await teardown.query(`DROP TABLE IF EXISTS ${PARENTS}`);
    } finally {
      await teardown.end();
    }
  });

  function versionsRelation(): string {
    const rels = schemaMeta.tables[PARENTS]?.relations ?? {};
    const name = Object.keys(rels).find((r) => rels[r]?.to === CHILDREN && rels[r]?.type === 'hasMany');
    assert.ok(name, `expected a hasMany relation to ${CHILDREN}, got: ${Object.keys(rels).join(', ')}`);
    return name!;
  }

  for (const direction of ['asc', 'desc'] as const) {
    it(`subquery and lateral plans return identical rows (by newest title, ${direction}, NULLS LAST)`, async () => {
      const rel = versionsRelation();
      const build = (plan?: 'lateral') =>
        ({
          orderBy: { [rel]: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', direction, plan } },
        }) as never;
      const sub = (await db.table(PARENTS).findMany(build())) as { id: number; name: string }[];
      const lat = (await db.table(PARENTS).findMany(build('lateral'))) as { id: number; name: string }[];
      assert.deepEqual(
        lat.map((r) => r.name),
        sub.map((r) => r.name),
      );
      // Childless (p4) and NULL-title (p3) parents land last in both directions
      // (NULLS LAST). p1/p2/p5 have real titles and precede them.
      assert.deepEqual(new Set(sub.map((r) => r.name).slice(-2)), new Set(['p3', 'p4']));
    });
  }

  it('a pick.where that zeroes some parents’ candidate rows sorts them last in both plans', async () => {
    const rel = versionsRelation();
    const build = (plan?: 'lateral') =>
      ({
        orderBy: {
          [rel]: {
            pick: { orderBy: { createdAt: 'desc' }, where: { isCurrent: true } },
            by: { field: 'data', path: ['rank'], type: 'numeric' },
            direction: 'desc',
            plan,
          },
        },
      }) as never;
    const sub = (await db.table(PARENTS).findMany(build())) as { name: string }[];
    const lat = (await db.table(PARENTS).findMany(build('lateral'))) as { name: string }[];
    assert.deepEqual(
      lat.map((r) => r.name),
      sub.map((r) => r.name),
    );
    // Only p1(rank2), p2(rank3), p3(rank1) have a current row → desc p2,p1,p3.
    assert.deepEqual(sub.map((r) => r.name).slice(0, 3), ['p2', 'p1', 'p3']);
  });

  it('pagination slices are equal across plans (limit 3 offset 1)', async () => {
    const rel = versionsRelation();
    const build = (plan?: 'lateral') =>
      ({
        orderBy: { [rel]: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', direction: 'asc', plan } },
        limit: 3,
        offset: 1,
      }) as never;
    const sub = (await db.table(PARENTS).findMany(build())) as { name: string }[];
    const lat = (await db.table(PARENTS).findMany(build('lateral'))) as { name: string }[];
    assert.deepEqual(
      lat.map((r) => r.name),
      sub.map((r) => r.name),
    );
    assert.equal(lat.length, 3);
  });

  it('join vs batched strategy return identical rows for a lateral pick + `with`', async () => {
    const rel = versionsRelation();
    const args = () =>
      ({
        with: { [rel]: true },
        orderBy: {
          [rel]: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', direction: 'asc', plan: 'lateral' },
        },
      }) as never;
    const join = (await db
      .table(PARENTS)
      .findMany({ ...(args() as object), relationLoadStrategy: 'join' } as never)) as {
      name: string;
    }[];
    const batched = (await db
      .table(PARENTS)
      .findMany({ ...(args() as object), relationLoadStrategy: 'batched' } as never)) as { name: string }[];
    assert.deepEqual(
      batched.map((r) => r.name),
      join.map((r) => r.name),
    );
  });

  it('findManyStream (batchSize 2, cursor path) yields the same ordered sequence as findMany for a lateral pick', async () => {
    const rel = versionsRelation();
    const orderBy = {
      [rel]: { pick: { orderBy: { createdAt: 'desc' } }, by: 'title', direction: 'asc', plan: 'lateral' },
    };
    const flat = (await db.table(PARENTS).findMany({ orderBy } as never)) as { name: string }[];
    const streamed: string[] = [];
    for await (const row of db.table(PARENTS).findManyStream({ orderBy, batchSize: 2 } as never)) {
      streamed.push((row as { name: string }).name);
    }
    assert.deepEqual(
      streamed,
      flat.map((r) => r.name),
    );
  });
});
