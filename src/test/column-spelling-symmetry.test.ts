/**
 * A column has TWO legal spellings on every caller-facing argument, and which
 * argument the name appears in must not change the answer.
 *
 * `resolveColumnName` (query/utils.ts) is the one key→column rule: the field
 * map first, else `camelToSnake(key)` accepted only when that names a real
 * column. Because `camelToSnake` is idempotent on an already-snake string, the
 * raw DDL column name resolves too, which is the spelling anyone reads off a
 * migration and the spelling a model writes back after reading the schema.
 *
 * Sites that tested `key in meta.columnMap` instead saw only the FIELD
 * spelling, so on one table, in one query language, `where` / `select` /
 * `distinct` accepted `created_at` while `orderBy` / `groupBy.by` / `_min`
 * rejected it with E003. Two audits missed it because every test asked one
 * surface the question it was known to answer, and `_count: { id: true }` is
 * spelled identically in both conventions, so the common case never exposed it.
 *
 * THE SHAPE OF THIS SUITE IS THE POINT. One list of surfaces, three questions
 * asked of every one of them by construction:
 *
 *   1. the camelCase FIELD spelling is accepted;
 *   2. the snake_case COLUMN spelling is accepted;
 *   3. a name that is neither is refused with E003.
 *
 * Plus a fourth that (1) and (2) alone cannot state: the two spellings compile
 * to BYTE-IDENTICAL SQL and params. "Accepted" is not the property, "means the
 * same query" is; a surface could resolve one spelling to a different column,
 * or emit a differently-shaped statement, and still pass (1) and (2).
 *
 * Adding a surface here is one array entry. Leaving one out is the failure this
 * file exists to prevent, so prefer a slightly awkward entry to an omission.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineError } from '../errors.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { includeKeysForBatching } from '../query/batched-loader.js';
import { expandCompoundUniqueWhere } from '../query/compound-unique.js';
import type { DeferredQuery } from '../query/deferred.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture. Every column's two spellings DIFFER (a name like `id` or `title` is
// spelled identically in both conventions and can prove nothing here), and the
// set covers each typed surface: temporal, numeric, JSON, vector, lock.
// ---------------------------------------------------------------------------

const users = mockTable(
  'users',
  [
    { name: 'id', field: 'id' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    { name: 'view_count', field: 'viewCount', pgType: 'int4' },
    { name: 'meta_data', field: 'metaData', pgType: 'jsonb' },
    { name: 'embed_vec', field: 'embedVec', pgType: 'vector' },
    { name: 'row_version', field: 'rowVersion', pgType: 'int4' },
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
  },
);

const posts = mockTable(
  'posts',
  [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
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
);

const schema = { tables: { users, posts }, enums: {} } as unknown as SchemaMetadata;
const q = () => makeQuery('users', schema);
const pq = () => makeQuery('posts', schema);

/** The three spellings each surface is asked about. */
const CAMEL = 'createdAt';
const SNAKE = 'created_at';
const BOGUS = 'creatd_at';

/**
 * A surface places a caller-supplied column name into ONE argument and returns
 * the compiled statement. `build` receives the name to place; everything else
 * about the query is held constant, so a difference between two runs can only
 * come from the spelling.
 *
 * `numeric` / `json` / `vector` / `lock` surfaces need a differently-typed
 * column, so they carry their own trio.
 */
interface Surface {
  name: string;
  camel?: string;
  snake?: string;
  bogus?: string;
  build: (name: string) => DeferredQuery<unknown>;
}

const NUMERIC = { camel: 'viewCount', snake: 'view_count', bogus: 'veiw_count' };
const JSONCOL = { camel: 'metaData', snake: 'meta_data', bogus: 'meta_dta' };
const VECTOR = { camel: 'embedVec', snake: 'embed_vec', bogus: 'embed_vekt' };
const LOCK = { camel: 'rowVersion', snake: 'row_version', bogus: 'row_vrsion' };

const SURFACES: Surface[] = [
  // -- reads: predicates -----------------------------------------------------
  { name: 'where (equality)', build: (n) => q().buildFindMany({ where: { [n]: null } } as never) },
  {
    name: 'where (operator)',
    ...NUMERIC,
    build: (n) => q().buildFindMany({ where: { [n]: { gt: 1 } } } as never),
  },
  {
    name: 'where { col } reference',
    ...NUMERIC,
    build: (n) => q().buildFindMany({ where: { viewCount: { gt: { col: n } } } } as never),
  },
  {
    name: 'where (JSON path filter)',
    ...JSONCOL,
    build: (n) => q().buildFindMany({ where: { [n]: { path: ['a'], equals: 1 } } } as never),
  },
  {
    name: 'where (relation sub-filter)',
    build: (n) => q().buildFindMany({ where: { posts: { some: { [n]: null } } } } as never),
  },
  { name: 'count where', build: (n) => q().buildCount({ where: { [n]: null } } as never) },

  // -- reads: projection -----------------------------------------------------
  { name: 'select', build: (n) => q().buildFindMany({ select: { [n]: true } } as never) },
  { name: 'omit', build: (n) => q().buildFindMany({ omit: { [n]: true } } as never) },
  {
    name: 'with select (relation target)',
    build: (n) => q().buildFindMany({ with: { posts: { select: { [n]: true } } } } as never),
  },
  {
    name: 'with omit (relation target)',
    build: (n) => q().buildFindMany({ with: { posts: { omit: { [n]: true } } } } as never),
  },

  // -- reads: ordering, paging, de-duplication -------------------------------
  { name: 'orderBy (plain direction)', build: (n) => q().buildFindMany({ orderBy: { [n]: 'asc' } } as never) },
  {
    name: 'orderBy (OrderBySpec nulls)',
    build: (n) => q().buildFindMany({ orderBy: { [n]: { sort: 'asc', nulls: 'last' } } } as never),
  },
  {
    name: 'orderBy (array form)',
    build: (n) => q().buildFindMany({ orderBy: [{ [n]: 'asc' }, { id: 'asc' }] } as never),
  },
  {
    name: 'orderBy (JSON path)',
    ...JSONCOL,
    build: (n) => q().buildFindMany({ orderBy: { [n]: { path: ['a'], direction: 'asc' } } } as never),
  },
  {
    name: 'orderBy (vector KNN)',
    ...VECTOR,
    build: (n) => q().buildFindMany({ orderBy: { [n]: { distance: { to: [1, 2], metric: 'l2' } } } } as never),
  },
  {
    name: 'orderBy (to-one relation target column)',
    build: (n) => pq().buildFindMany({ orderBy: { author: { [n]: 'asc' } } } as never),
  },
  {
    name: 'orderBy (pick-row: pick.orderBy AND by)',
    build: (n) => q().buildFindMany({ orderBy: { posts: { pick: { orderBy: { [n]: 'desc' } }, by: n } } } as never),
  },
  {
    name: 'with orderBy (relation target)',
    build: (n) => q().buildFindMany({ with: { posts: { orderBy: { [n]: 'asc' } } } } as never),
  },
  {
    name: 'with where (relation target)',
    build: (n) => q().buildFindMany({ with: { posts: { where: { [n]: null } } } } as never),
  },
  { name: 'distinct', build: (n) => q().buildFindMany({ distinct: [n] } as never) },
  {
    name: 'cursor',
    build: (n) => q().buildFindMany({ cursor: { [n]: 1 }, orderBy: { [n]: 'asc' } } as never),
  },

  // -- reads: aggregation ----------------------------------------------------
  { name: 'groupBy by', build: (n) => q().buildGroupBy({ by: [n] } as never) },
  {
    name: 'groupBy by (JSON group key)',
    ...JSONCOL,
    build: (n) => q().buildGroupBy({ by: [{ field: n, path: ['a'] }] } as never),
  },
  { name: 'groupBy orderBy', build: (n) => q().buildGroupBy({ by: [n], orderBy: { [n]: 'asc' } } as never) },
  {
    name: 'groupBy having (scalar on a group key)',
    build: (n) => q().buildGroupBy({ by: [n], having: { [n]: { not: null } } } as never),
  },
  {
    name: 'groupBy having (aggregate filter)',
    ...NUMERIC,
    build: (n) => q().buildGroupBy({ by: ['id'], having: { [n]: { _sum: { gt: 1 } } } } as never),
  },
  { name: 'groupBy _min', build: (n) => q().buildGroupBy({ by: ['id'], _min: { [n]: true } } as never) },
  { name: 'groupBy _max', build: (n) => q().buildGroupBy({ by: ['id'], _max: { [n]: true } } as never) },
  {
    name: 'groupBy _sum',
    ...NUMERIC,
    build: (n) => q().buildGroupBy({ by: ['id'], _sum: { [n]: true } } as never),
  },
  {
    name: 'groupBy _avg',
    ...NUMERIC,
    build: (n) => q().buildGroupBy({ by: ['id'], _avg: { [n]: true } } as never),
  },
  {
    name: 'groupBy _count (record form)',
    build: (n) => q().buildGroupBy({ by: ['id'], _count: { [n]: true } } as never),
  },
  {
    name: 'groupBy distinctOn (columns AND orderBy)',
    build: (n) => q().buildGroupBy({ by: ['id'], distinctOn: { columns: [n], orderBy: { [n]: 'desc' } } } as never),
  },
  { name: 'aggregate _min', build: (n) => q().buildAggregate({ _min: { [n]: true } } as never) },
  { name: 'aggregate _max', build: (n) => q().buildAggregate({ _max: { [n]: true } } as never) },
  { name: 'aggregate _sum', ...NUMERIC, build: (n) => q().buildAggregate({ _sum: { [n]: true } } as never) },
  { name: 'aggregate _avg', ...NUMERIC, build: (n) => q().buildAggregate({ _avg: { [n]: true } } as never) },
  { name: 'aggregate _count (record form)', build: (n) => q().buildAggregate({ _count: { [n]: true } } as never) },

  // -- writes ----------------------------------------------------------------
  { name: 'create data', build: (n) => q().buildCreate({ data: { id: 1, [n]: new Date(0) } } as never) },
  {
    name: 'createMany data',
    build: (n) => q().buildCreateMany({ data: [{ id: 1, [n]: new Date(0) }] } as never),
  },
  {
    name: 'update data',
    build: (n) => q().buildUpdate({ where: { id: 1 }, data: { [n]: new Date(0) } } as never),
  },
  {
    name: 'update data (atomic operator)',
    ...NUMERIC,
    build: (n) => q().buildUpdate({ where: { id: 1 }, data: { [n]: { increment: 1 } } } as never),
  },
  {
    name: 'update optimisticLock.field',
    ...LOCK,
    build: (n) =>
      q().buildUpdate({
        where: { id: 1 },
        data: { viewCount: 1 },
        optimisticLock: { field: n, value: 1 },
      } as never),
  },
  {
    name: 'update where',
    // `update` returns one row, so its where must carry an identifying key
    // (query/compound-unique.ts); the probed column rides beside it.
    build: (n) => q().buildUpdate({ where: { id: 'x', [n]: null }, data: { viewCount: 1 } } as never),
  },
  {
    name: 'updateMany data',
    build: (n) => q().buildUpdateMany({ where: { id: 1 }, data: { [n]: new Date(0) } } as never),
  },
  {
    name: 'delete where',
    build: (n) => q().buildDelete({ where: { id: 1, [n]: null } } as never),
  },
  {
    name: 'deleteMany where',
    build: (n) => q().buildDeleteMany({ where: { [n]: null } } as never),
  },
  {
    name: 'upsert create + update data',
    build: (n) =>
      q().buildUpsert({
        where: { id: 1 },
        create: { id: 1, [n]: new Date(0) },
        update: { [n]: new Date(0) },
      } as never),
  },
];

const spellings = (s: Surface) => ({
  camel: s.camel ?? CAMEL,
  snake: s.snake ?? SNAKE,
  bogus: s.bogus ?? BOGUS,
});

describe('column spelling symmetry: every surface accepts both spellings of a column', () => {
  // A guard on the fixture itself. If a "snake" spelling ever coincided with
  // its "camel" one, every assertion below would still pass while proving
  // nothing, which is exactly how this bug class survives a test suite.
  it('the fixture uses column names whose two spellings genuinely differ', () => {
    for (const trio of [{ camel: CAMEL, snake: SNAKE, bogus: BOGUS }, NUMERIC, JSONCOL, VECTOR, LOCK]) {
      assert.notEqual(trio.camel, trio.snake, `${trio.camel} must differ from its column spelling`);
      assert.equal(users.columnMap[trio.camel], trio.snake, `${trio.camel} must map to ${trio.snake}`);
      assert.ok(users.allColumns.includes(trio.snake), `${trio.snake} must be a real column`);
      assert.ok(!users.allColumns.includes(trio.bogus), `${trio.bogus} must NOT be a real column`);
      assert.ok(users.columnMap[trio.bogus] === undefined, `${trio.bogus} must NOT be a field`);
    }
  });

  it('covers every surface exactly once (no duplicate entries masking a gap)', () => {
    assert.equal(new Set(SURFACES.map((s) => s.name)).size, SURFACES.length);
  });

  for (const surface of SURFACES) {
    const { camel, snake, bogus } = spellings(surface);

    it(`${surface.name}: accepts the field spelling "${camel}"`, () => {
      assert.ok(surface.build(camel).sql.length > 0);
    });

    it(`${surface.name}: accepts the column spelling "${snake}"`, () => {
      assert.ok(surface.build(snake).sql.length > 0);
    });

    it(`${surface.name}: both spellings compile to identical SQL and params`, () => {
      const a = surface.build(camel);
      const b = surface.build(snake);
      assert.equal(b.sql, a.sql, `${surface.name}: "${snake}" compiled differently from "${camel}"`);
      assert.deepEqual(b.params, a.params);
    });

    it(`${surface.name}: refuses the unknown name "${bogus}" with E003`, () => {
      assert.throws(
        () => surface.build(bogus),
        (err: unknown) => {
          assert.ok(err instanceof TurbineError, `${surface.name}: expected a TurbineError, got ${String(err)}`);
          assert.equal(err.code, 'TURBINE_E003', `${surface.name}: ${err.message}`);
          assert.match(err.message, new RegExp(bogus), `${surface.name}: the error must name the offending key`);
          return true;
        },
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Cross-spelling: two arguments of ONE call, each free to pick its own
// spelling. This is where the registries live (a groupBy's `by` key decides
// what its `orderBy` and `having` may name), and it is a strictly stronger
// question than asking each argument in isolation.
// ---------------------------------------------------------------------------

describe('column spelling symmetry: two arguments of one call may disagree on spelling', () => {
  const both = [CAMEL, SNAKE] as const;
  const numericBoth = [NUMERIC.camel, NUMERIC.snake] as const;

  for (const by of both) {
    for (const other of both) {
      it(`groupBy by:${by} + orderBy:${other}`, () => {
        const d = q().buildGroupBy({ by: [by], orderBy: { [other]: 'asc' } } as never);
        assert.match(d.sql, /GROUP BY "created_at" ORDER BY "created_at" ASC/);
      });

      it(`groupBy by:${by} + having:${other}`, () => {
        const d = q().buildGroupBy({ by: [by], having: { [other]: { not: null } } } as never);
        assert.match(d.sql, /HAVING "created_at" IS NOT NULL/);
      });
    }
  }

  for (const agg of numericBoth) {
    for (const ord of numericBoth) {
      it(`groupBy _sum:${agg} + orderBy _sum:${ord}`, () => {
        const d = q().buildGroupBy({
          by: ['id'],
          _sum: { [agg]: true },
          orderBy: { _sum: { [ord]: 'desc' } },
        } as never);
        assert.match(d.sql, /ORDER BY SUM\("view_count"\) DESC/);
      });
    }
  }

  for (const cursor of both) {
    for (const order of both) {
      it(`cursor:${cursor} + orderBy:${order} desc seeks DESCENDING`, () => {
        // The seek direction is read off `orderBy` and applied to the `cursor`
        // field. Matching the two by RAW KEY meant a cursor and an orderBy that
        // spelled one column differently never matched: the lookup missed, the
        // seek defaulted to ascending, and the query emitted `col > $n` under
        // `ORDER BY col DESC`. No error, just the wrong page.
        const d = q().buildFindMany({ cursor: { [cursor]: 1 }, orderBy: { [order]: 'desc' }, limit: 2 } as never);
        assert.match(d.sql, /"created_at" < \$/, `cursor:${cursor} orderBy:${order} sought the wrong way`);
        assert.doesNotMatch(d.sql, /"created_at" > \$/);
      });
    }
  }

  it('a groupBy `by` key returns its value under the canonical field name whichever spelling was asked for', () => {
    // The rows a groupBy transform reads are keyed by FIELD name (`parseRow`),
    // so keying the result by the caller's spelling made `by: ['created_at']`
    // return `{ created_at: undefined }` for every group: accepted, compiled,
    // and silently empty.
    for (const spelling of both) {
      const d = q().buildGroupBy({ by: [spelling] } as never) as unknown as {
        transform: (r: { rows: Record<string, unknown>[] }) => Record<string, unknown>[];
      };
      const out = d.transform({ rows: [{ created_at: new Date(0), _count: 3 }] });
      assert.deepEqual(out, [{ createdAt: new Date(0), _count: 3 }], `by: ['${spelling}']`);
    }
  });
});

// ---------------------------------------------------------------------------
// Internal machinery that matches a caller's key against a Turbine-derived
// field name. Not a query surface, but the same question, and the failures are
// silent rather than loud.
// ---------------------------------------------------------------------------

describe('column spelling symmetry: internal key matching', () => {
  it('the batched loader recognizes an already-projected correlation key in either spelling', () => {
    // `strip` is "added only to stitch, delete before returning". A snake-spelled
    // select made the loader believe the key was missing, so it force-added AND
    // stripped it, deleting the column the caller had explicitly asked for.
    for (const spelling of ['userId', 'user_id']) {
      const proj = includeKeysForBatching(posts, { [spelling]: true, id: true }, undefined, ['userId']);
      assert.deepEqual(proj.strip, [], `select: { ${spelling}: true } must not strip a requested column`);
    }
    // And the mirror: genuinely absent means force-add plus strip.
    assert.deepEqual(includeKeysForBatching(posts, { id: true }, undefined, ['userId']).strip, ['userId']);
  });

  it('the batched loader un-omits a correlation key written in either spelling', () => {
    // Failing to un-omit leaves the stitch key absent from the child rows,
    // which trips an internal "this is a bug in turbine" assertion on a query
    // that is perfectly legal.
    for (const spelling of ['userId', 'user_id']) {
      const proj = includeKeysForBatching(posts, undefined, { [spelling]: true }, ['userId']);
      assert.deepEqual(proj.omit, {}, `omit: { ${spelling}: true } must be un-omitted`);
      assert.deepEqual(proj.strip, ['userId']);
    }
    // An omit of some OTHER column is left alone.
    assert.deepEqual(includeKeysForBatching(posts, undefined, { id: true }, ['userId']).omit, { id: true });
  });

  it('a compound-unique selector accepts either spelling for its NAME and its MEMBERS', () => {
    const members = mockTable('members', [
      { name: 'org_id', field: 'orgId' },
      { name: 'user_id', field: 'userId' },
      { name: 'role', field: 'role', pgType: 'text' },
    ]);
    members.primaryKey = ['org_id', 'user_id'];
    members.uniqueColumns = [['org_id', 'user_id']];
    const expanded = { orgId: 1, userId: 2 };
    for (const key of ['orgId_userId', 'org_id_user_id']) {
      for (const [a, b] of [
        ['orgId', 'userId'],
        ['org_id', 'user_id'],
      ]) {
        assert.deepEqual(
          expandCompoundUniqueWhere(members, { [key]: { [a as string]: 1, [b as string]: 2 } }),
          expanded,
          `selector ${key} with members ${a}/${b}`,
        );
      }
    }
  });

  it('a compound-unique selector still refuses an incomplete, unknown, or doubled member set', () => {
    const members = mockTable('members', [
      { name: 'org_id', field: 'orgId' },
      { name: 'user_id', field: 'userId' },
    ]);
    members.primaryKey = ['org_id', 'user_id'];
    members.uniqueColumns = [['org_id', 'user_id']];
    for (const selector of [
      { orgId: 1 }, // incomplete
      { orgId: 1, nope: 2 }, // unknown member
      { orgId: 1, org_id: 2 }, // two spellings of ONE column, no value for the other
    ]) {
      assert.throws(
        () => expandCompoundUniqueWhere(members, { orgId_userId: selector }),
        (err: unknown) => err instanceof TurbineError && err.code === 'TURBINE_E003',
        JSON.stringify(selector),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// PowDB / PowQL. A parallel implementation of the same public surface, so it
// owes the same property. It resolves EVERY key through one private helper
// (`PowqlInterface.column`), which is why it never grew the per-argument
// asymmetry the SQL builders did, but the registries keyed off those resolved
// columns had the same spelling-sensitivity, and fixing only the SQL side
// would have turned a shared bug into a cross-engine result-shape divergence.
// ---------------------------------------------------------------------------

const POWDB_SCHEMA = (() => {
  const t = mockTable('events', [
    { name: 'id', field: 'id' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    { name: 'view_count', field: 'viewCount', pgType: 'int4' },
  ]);
  for (const c of t.columns) {
    if (c.name === 'id') c.tsType = 'string';
    if (c.name === 'created_at') c.tsType = 'Date';
    if (c.name === 'view_count') c.tsType = 'number';
  }
  return { tables: { events: t }, enums: {} } as unknown as SchemaMetadata;
})();

function powqlMock(rows: Record<string, unknown>[] = [{ id: '1', created_at: 0, view_count: 2 }]) {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: capabilitiesFromVersion('0.18.0'),
    retryStaleReads: false,
    readonly: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      return Promise.resolve({ rows, rowCount: rows.length });
    },
  } as unknown as PowdbPool;
  return {
    calls,
    qi: () => new PowqlInterface(pool, 'events', POWDB_SCHEMA, [], { warnOnUnlimited: false }),
  };
}

interface PowqlSurface {
  name: string;
  camel?: string;
  snake?: string;
  bogus?: string;
  run: (qi: PowqlInterface, name: string) => Promise<unknown>;
}

const POWQL_NUMERIC = { camel: 'viewCount', snake: 'view_count', bogus: 'veiw_count' };

const POWQL_SURFACES: PowqlSurface[] = [
  { name: 'where', run: (qi, n) => qi.findMany({ where: { [n]: null } } as never) },
  { name: 'select', run: (qi, n) => qi.findMany({ select: { [n]: true } } as never) },
  { name: 'omit', run: (qi, n) => qi.findMany({ omit: { [n]: true } } as never) },
  { name: 'orderBy', run: (qi, n) => qi.findMany({ orderBy: { [n]: 'asc' } } as never) },
  // `distinct` is NOT a PowQL column-name surface and no longer belongs in this
  // list. It is `DISTINCT ON`, PostgreSQL-only, and PowDB now refuses it with
  // E017 the way sqlite / mysql / mssql already did, BEFORE any name is read,
  // so neither half of the pair below can hold: no statement is emitted to
  // compare, and an unknown name is E017 rather than E003. Measured on all four
  // dialects, `distinct: ['creatd_at']` -> E017 on every engine that lacks the
  // feature and E003 only on Postgres, where the feature exists; making PowDB
  // resolve the name first would have left it the one engine answering E003.
  // It stays in the SQL block above, where `q()` is a Postgres interface and
  // both properties are real. The refusal itself is covered by
  // src/test/powdb-dialect-contract.test.ts.
  { name: 'count where', run: (qi, n) => qi.count({ where: { [n]: null } } as never) },
  { name: 'groupBy by', run: (qi, n) => qi.groupBy({ by: [n] } as never) },
  { name: 'groupBy orderBy', run: (qi, n) => qi.groupBy({ by: [n], orderBy: { [n]: 'asc' } } as never) },
  {
    name: 'groupBy _min',
    run: (qi, n) => qi.groupBy({ by: ['id'], _min: { [n]: true } } as never),
  },
  {
    name: 'groupBy _sum',
    ...POWQL_NUMERIC,
    run: (qi, n) => qi.groupBy({ by: ['id'], _sum: { [n]: true } } as never),
  },
  {
    name: 'groupBy having (aggregate filter)',
    ...POWQL_NUMERIC,
    run: (qi, n) => qi.groupBy({ by: ['id'], having: { [n]: { _sum: { gt: 1 } } } } as never),
  },
  {
    name: 'aggregate _min',
    run: (qi, n) => qi.aggregate({ _min: { [n]: true } } as never),
  },
  { name: 'create data', run: (qi, n) => qi.create({ data: { id: 'x', [n]: new Date(0) } } as never) },
  {
    name: 'update data',
    run: (qi, n) => qi.update({ where: { id: 'x' }, data: { [n]: new Date(0) } } as never),
  },
  {
    name: 'delete where',
    run: (qi, n) => qi.delete({ where: { id: 'x', [n]: null } } as never),
  },
];

describe('column spelling symmetry: PowDB (PowQL) answers the same question the same way', () => {
  for (const surface of POWQL_SURFACES) {
    const camel = surface.camel ?? CAMEL;
    const snake = surface.snake ?? SNAKE;
    const bogus = surface.bogus ?? BOGUS;

    it(`${surface.name}: both spellings emit identical PowQL`, async () => {
      const a = powqlMock();
      const b = powqlMock();
      await surface.run(a.qi(), camel);
      await surface.run(b.qi(), snake);
      assert.ok(a.calls.length > 0, `${surface.name}: emitted no statement`);
      assert.equal(b.calls.length, a.calls.length);
      for (let i = 0; i < a.calls.length; i++) {
        assert.equal(b.calls[i]?.powql, a.calls[i]?.powql, `${surface.name} statement ${i}`);
        assert.deepEqual(b.calls[i]?.params, a.calls[i]?.params);
      }
    });

    it(`${surface.name}: refuses the unknown name "${bogus}" with E003`, async () => {
      await assert.rejects(
        () => surface.run(powqlMock().qi(), bogus),
        (err: unknown) => err instanceof TurbineError && err.code === 'TURBINE_E003',
        surface.name,
      );
    });
  }

  // Two arguments of ONE call, each free to pick its own spelling: the same
  // cross-argument question the SQL block asks, because PowQL keeps the same
  // kind of by-key / aggregate registries.
  for (const by of [CAMEL, SNAKE]) {
    for (const other of [CAMEL, SNAKE]) {
      it(`groupBy by:${by} + orderBy:${other}`, async () => {
        const mock = powqlMock();
        await mock.qi().groupBy({ by: [by], orderBy: { [other]: 'asc' } } as never);
        assert.match(mock.calls[0]?.powql ?? '', /order .*created_at asc/);
      });
    }
  }

  for (const agg of [POWQL_NUMERIC.camel, POWQL_NUMERIC.snake]) {
    for (const ord of [POWQL_NUMERIC.camel, POWQL_NUMERIC.snake]) {
      it(`groupBy _sum:${agg} + orderBy _sum:${ord}`, async () => {
        const mock = powqlMock();
        await mock.qi().groupBy({ by: ['id'], _sum: { [agg]: true }, orderBy: { _sum: { [ord]: 'desc' } } } as never);
        assert.match(mock.calls[0]?.powql ?? '', /order \.agg_\d+ desc/);
      });
    }
  }

  for (const by of [POWQL_NUMERIC.camel, POWQL_NUMERIC.snake]) {
    for (const having of [POWQL_NUMERIC.camel, POWQL_NUMERIC.snake]) {
      it(`groupBy by:${by} + having aggregate:${having}`, async () => {
        const mock = powqlMock();
        await mock.qi().groupBy({ by: [by], having: { [having]: { _sum: { gt: 1 } } } } as never);
        assert.match(mock.calls[0]?.powql ?? '', /having sum\(\.view_count\) > /);
      });
    }
  }

  it('groupBy returns its group key under the canonical field name, matching the SQL engines', async () => {
    for (const spelling of [CAMEL, SNAKE]) {
      const mock = powqlMock([{ created_at: 0, agg_0: 3 }]);
      const rows = await mock.qi().groupBy({ by: [spelling] } as never);
      assert.deepEqual(Object.keys(rows[0] as object).sort(), ['_count', 'createdAt'], `by: ['${spelling}']`);
    }
  });

  it('a PK supplied under the column spelling is not overwritten by a generated default', async () => {
    // `create` accepts either spelling, so testing only the camelCase field
    // made a snake-spelled PK look absent: a UUID was generated under the
    // OTHER key and the statement carried two assignments to one column.
    const t = mockTable('docs', [{ name: 'doc_id', field: 'docId', pgType: 'text' }]);
    t.primaryKey = ['doc_id'];
    t.uniqueColumns = [['doc_id']];
    for (const c of t.columns) {
      c.tsType = 'string';
      c.hasDefault = true;
    }
    const schemaWithDoc = { tables: { docs: t }, enums: {} } as unknown as SchemaMetadata;
    const calls: { powql: string; params: unknown[] }[] = [];
    const pool = {
      capabilities: capabilitiesFromVersion('0.18.0'),
      retryStaleReads: false,
      readonly: false,
      query(powql: string, params: unknown[]) {
        calls.push({ powql, params });
        return Promise.resolve({ rows: [{ doc_id: 'given' }], rowCount: 1 });
      },
    } as unknown as PowdbPool;
    for (const spelling of ['docId', 'doc_id']) {
      calls.length = 0;
      await new PowqlInterface(pool, 'docs', schemaWithDoc, [], { warnOnUnlimited: false }).create({
        data: { [spelling]: 'given' },
      } as never);
      assert.deepEqual(calls[0]?.params, ['given'], `create({ ${spelling} }) generated a default over the given value`);
      assert.equal(
        (calls[0]?.powql.match(/doc_id/g) ?? []).length,
        1,
        `create({ ${spelling} }) assigned the column twice`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// EXECUTION arm. Everything above compiles a statement and compares the text;
// this one runs both spellings against a real (in-memory sqlite) database and
// compares the ROWS, under both relation strategies.
//
// It is not redundant with the compile arm. Several sites in this bug class
// emit identical SQL and still diverge afterwards: the groupBy transform reads
// its group key off a row keyed by field name, and the batched loader decides
// which columns to force-add and then STRIP from the assembled entities. Those
// are post-SQL decisions, so only a query that actually returns rows can catch
// them, which is exactly why they survived a suite full of SQL assertions.
// ---------------------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const sqliteGate = skipGate(!DatabaseSync, 'node:sqlite unavailable (Node < 22.5)');

const EXEC_SCHEMA_SQL = `
CREATE TABLE authors (
  id         INTEGER PRIMARY KEY,
  full_name  TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE articles (
  id         INTEGER PRIMARY KEY,
  author_id  INTEGER NOT NULL REFERENCES authors(id),
  head_line  TEXT NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_articles_author_id ON articles(author_id);
`;

describe('column spelling symmetry: both spellings return the same ROWS', () => {
  let execDb: DatabaseSyncType;
  let execClient: TurbineClient;

  beforeEach(() => {
    if (!DatabaseSync) return;
    execDb = new DatabaseSync(':memory:');
    execDb.exec('PRAGMA foreign_keys = ON');
    execDb.exec(EXEC_SCHEMA_SQL);
    // Deliberately uneven: an author with no articles exercises the empty
    // relation, and repeated view_count values give groupBy real groups.
    for (let a = 1; a <= 4; a++) {
      execDb.exec(`INSERT INTO authors (id, full_name, view_count) VALUES (${a}, 'Author ${a}', ${a % 2});`);
    }
    let article = 0;
    for (let a = 1; a <= 3; a++) {
      for (let i = 0; i < a; i++) {
        article += 1;
        execDb.exec(
          `INSERT INTO articles (id, author_id, head_line, view_count) ` +
            `VALUES (${article}, ${a}, 'Article ${article}', ${article % 3});`,
        );
      }
    }
    execClient = turbineSqlite(execDb, introspectSqliteDatabase(execDb));
  });

  afterEach(async () => {
    if (!DatabaseSync) return;
    await execClient.disconnect();
  });

  /** Each shape, written twice: once in field spelling, once in column spelling. */
  const SHAPES: { name: string; table: string; camel: object; snake: object }[] = [
    {
      name: 'where + orderBy + select',
      table: 'authors',
      camel: { where: { viewCount: { gte: 0 } }, orderBy: { fullName: 'asc' }, select: { id: true, fullName: true } },
      snake: {
        where: { view_count: { gte: 0 } },
        orderBy: { full_name: 'asc' },
        select: { id: true, full_name: true },
      },
    },
    {
      name: 'omit',
      table: 'authors',
      camel: { omit: { viewCount: true }, orderBy: { id: 'asc' } },
      snake: { omit: { view_count: true }, orderBy: { id: 'asc' } },
    },
    // `distinct` is DISTINCT ON, PostgreSQL-only (E017 here), so it stays in
    // the compile arm above.
    {
      // The seek DIRECTION is read off `orderBy` and applied to the `cursor`
      // field, and matching those two by raw key meant a mixed-spelling pair
      // silently seeked the wrong way: `col > $n` under `ORDER BY col DESC`.
      // The compile arm pins the operator; this pins the rows it returns.
      name: 'cursor seek (descending)',
      table: 'articles',
      camel: { cursor: { viewCount: 2 }, orderBy: { viewCount: 'desc' }, limit: 3 },
      snake: { cursor: { view_count: 2 }, orderBy: { view_count: 'desc' }, limit: 3 },
    },
    {
      name: 'cursor seek (ascending)',
      table: 'articles',
      camel: { cursor: { viewCount: 0 }, orderBy: { viewCount: 'asc' }, limit: 3 },
      snake: { cursor: { view_count: 0 }, orderBy: { view_count: 'asc' }, limit: 3 },
    },
    {
      name: 'relation with, child orderBy + select',
      table: 'authors',
      camel: {
        orderBy: { id: 'asc' },
        with: { articles: { orderBy: { headLine: 'asc' }, select: { id: true, headLine: true } } },
      },
      snake: {
        orderBy: { id: 'asc' },
        with: { articles: { orderBy: { head_line: 'asc' }, select: { id: true, head_line: true } } },
      },
    },
    {
      name: 'relation with, child select NAMING the correlation key',
      table: 'authors',
      camel: { orderBy: { id: 'asc' }, with: { articles: { select: { id: true, authorId: true } } } },
      snake: { orderBy: { id: 'asc' }, with: { articles: { select: { id: true, author_id: true } } } },
    },
    {
      name: 'relation with, child OMITTING the correlation key',
      table: 'authors',
      camel: { orderBy: { id: 'asc' }, with: { articles: { omit: { authorId: true } } } },
      snake: { orderBy: { id: 'asc' }, with: { articles: { omit: { author_id: true } } } },
    },
    {
      name: 'relation with, per-child limit + orderBy',
      table: 'authors',
      camel: { orderBy: { id: 'asc' }, with: { articles: { orderBy: { headLine: 'asc' }, limit: 2 } } },
      snake: { orderBy: { id: 'asc' }, with: { articles: { orderBy: { head_line: 'asc' }, limit: 2 } } },
    },
    {
      name: 'relation filter (some)',
      table: 'authors',
      camel: { where: { articles: { some: { viewCount: { gte: 0 } } } }, orderBy: { id: 'asc' } },
      snake: { where: { articles: { some: { view_count: { gte: 0 } } } }, orderBy: { id: 'asc' } },
    },
    {
      name: 'nested relation with (two levels)',
      table: 'authors',
      camel: { orderBy: { id: 'asc' }, with: { articles: { with: { author: { select: { fullName: true } } } } } },
      snake: { orderBy: { id: 'asc' }, with: { articles: { with: { author: { select: { full_name: true } } } } } },
    },
  ];

  for (const shape of SHAPES) {
    for (const strategy of ['join', 'batched'] as const) {
      sqliteGate.it(`${shape.name} [${strategy}]`, async () => {
        const t = execClient.table(shape.table);
        const camel = await t.findMany({ ...shape.camel, relationLoadStrategy: strategy } as never);
        const snake = await t.findMany({ ...shape.snake, relationLoadStrategy: strategy } as never);
        assert.deepEqual(snake, camel, `${shape.name} [${strategy}] returned different rows`);
        assert.ok(Array.isArray(camel) && camel.length > 0, `${shape.name}: fixture returned no rows`);
      });
    }
  }

  sqliteGate.it('groupBy returns the same groups under both spellings', async () => {
    const t = execClient.table('articles');
    const camel = await t.groupBy({
      by: ['viewCount'],
      _count: true,
      _min: { headLine: true },
      orderBy: { viewCount: 'asc' },
    } as never);
    const snake = await t.groupBy({
      by: ['view_count'],
      _count: true,
      _min: { head_line: true },
      orderBy: { view_count: 'asc' },
    } as never);
    assert.deepEqual(snake, camel);
    // The group key must carry a real value, not `undefined`: keying the
    // result by the caller's spelling silently produced the latter.
    assert.ok((camel as Record<string, unknown>[]).every((r) => r.viewCount !== undefined));
    assert.ok((camel as Record<string, unknown>[]).length > 1);
  });

  sqliteGate.it('aggregate returns the same values under both spellings', async () => {
    const t = execClient.table('articles');
    const camel = await t.aggregate({ _count: { headLine: true }, _min: { viewCount: true } } as never);
    const snake = await t.aggregate({ _count: { head_line: true }, _min: { view_count: true } } as never);
    assert.deepEqual(snake, camel);
  });

  sqliteGate.it('writes address the same column under both spellings', async () => {
    const t = execClient.table('authors');
    const camel = await t.update({ where: { id: 1 }, data: { fullName: 'Renamed A' } } as never);
    const snake = await t.update({ where: { id: 2 }, data: { full_name: 'Renamed A' } } as never);
    assert.equal((camel as { fullName: string }).fullName, 'Renamed A');
    assert.equal((snake as { fullName: string }).fullName, 'Renamed A');
    const created = await t.create({ data: { id: 99, full_name: 'Made', view_count: 7 } } as never);
    assert.deepEqual(created, { id: 99, fullName: 'Made', viewCount: 7 });
  });
});
