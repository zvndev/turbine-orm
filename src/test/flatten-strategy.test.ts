/**
 * turbine-orm, `relationLoadStrategy: 'flatten'` (build-only, no DB)
 *
 * `'flatten'` compiles an eligible TO-ONE relation to a `LEFT JOIN` with a
 * prefixed scalar projection instead of a correlated `json_build_object`
 * subquery, then assembles the object client-side. These tests pin:
 *
 *   - the emitted SQL shape (join, prefixed aliases, predicate discriminator),
 *   - the eligibility rules, and that EVERY ineligible shape falls back to
 *     byte-identical default-strategy SQL rather than emitting a join,
 *   - that the SQL-template cache can never serve a join-planned statement to a
 *     flatten-planned call (or vice versa),
 *   - the row assembler (null vs all-NULL relation, nesting, key order).
 *
 * Run: npx tsx --test src/test/flatten-strategy.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CircularRelationError, RelationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function rel(def: RelationDef): RelationDef {
  return def;
}

function buildSchema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'org_id', field: 'orgId' },
      { name: 'manager_id', field: 'managerId' },
      { name: 'city_code', field: 'cityCode', pgType: 'text' },
      { name: 'account_email', field: 'accountEmail', pgType: 'text' },
    ],
    {
      org: rel({ type: 'belongsTo', name: 'org', from: 'users', to: 'orgs', foreignKey: 'org_id', referenceKey: 'id' }),
      manager: rel({
        type: 'belongsTo',
        name: 'manager',
        from: 'users',
        to: 'users',
        foreignKey: 'manager_id',
        referenceKey: 'id',
      }),
      // Target-side key is a plain column: NOT provably unique → must fall back.
      city: rel({
        type: 'belongsTo',
        name: 'city',
        from: 'users',
        to: 'cities',
        foreignKey: 'city_code',
        referenceKey: 'code',
      }),
      account: rel({
        type: 'belongsTo',
        name: 'account',
        from: 'users',
        to: 'accounts',
        foreignKey: 'account_email',
        referenceKey: 'email',
      }),
      profile: rel({
        type: 'hasOne',
        name: 'profile',
        from: 'users',
        to: 'profiles',
        foreignKey: 'user_id',
        referenceKey: 'id',
      }),
      // hasOne over a NON-unique child FK: the join would fan out → fall back.
      draft: rel({
        type: 'hasOne',
        name: 'draft',
        from: 'users',
        to: 'posts',
        foreignKey: 'user_id',
        referenceKey: 'id',
      }),
      posts: rel({
        type: 'hasMany',
        name: 'posts',
        from: 'users',
        to: 'posts',
        foreignKey: 'user_id',
        referenceKey: 'id',
      }),
    },
  );

  const orgs = mockTable(
    'orgs',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'region_id', field: 'regionId' },
      { name: 'deleted', field: 'deleted', pgType: 'bool' },
    ],
    {
      region: rel({
        type: 'belongsTo',
        name: 'region',
        from: 'orgs',
        to: 'regions',
        foreignKey: 'region_id',
        referenceKey: 'id',
      }),
      members: rel({
        type: 'hasMany',
        name: 'members',
        from: 'orgs',
        to: 'users',
        foreignKey: 'org_id',
        referenceKey: 'id',
      }),
    },
  );

  const regions = mockTable(
    'regions',
    [
      { name: 'id', field: 'id' },
      { name: 'code', field: 'code', pgType: 'text' },
      { name: 'parent_id', field: 'parentId' },
    ],
    {
      parent: rel({
        type: 'belongsTo',
        name: 'parent',
        from: 'regions',
        to: 'regions',
        foreignKey: 'parent_id',
        referenceKey: 'id',
      }),
    },
  );

  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'title', field: 'title', pgType: 'text' },
    ],
    {
      author: rel({
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      }),
    },
  );

  // Unique FK on the child side → hasOne is flattenable.
  const profiles = mockTable('profiles', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'bio', field: 'bio', pgType: 'text' },
  ]);
  profiles.uniqueColumns = [['id'], ['user_id']];

  // `code` carries only a NON-unique index → not a uniqueness proof.
  const cities = mockTable('cities', [
    { name: 'id', field: 'id' },
    { name: 'code', field: 'code', pgType: 'text' },
    { name: 'label', field: 'label', pgType: 'text' },
  ]);
  cities.indexes = [{ name: 'idx_cities_code', columns: ['code'], unique: false, definition: '' }];

  // `email` is a PII-tagged UNIQUE column, and the relation's correlation key.
  const accounts = mockTable('accounts', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'plan', field: 'plan', pgType: 'text' },
  ]);
  accounts.uniqueColumns = [['id'], ['email']];
  accounts.columns[1]!.pii = true;

  return {
    tables: { users, orgs, regions, posts, profiles, cities, accounts },
    enums: {},
  } as unknown as SchemaMetadata;
}

const FLATTEN = { relationLoadStrategy: 'flatten' } as const;

/** Build a findMany under an explicit strategy and return its SQL. */
// biome-ignore lint/suspicious/noExplicitAny: build-only helper over the generic arg surface
function sqlFor(args: any, table = 'users', schema: SchemaMetadata = buildSchema(), options?: any): string {
  return makeQuery(table, schema, options).buildFindMany(args).sql;
}

/** Build the SAME args under 'join' and 'flatten' on ONE interface (shared cache). */
// biome-ignore lint/suspicious/noExplicitAny: build-only helper over the generic arg surface
function bothStrategies(args: any, table = 'users', schema: SchemaMetadata = buildSchema()) {
  const q = makeQuery(table, schema);
  const join = q.buildFindMany({ ...args, relationLoadStrategy: 'join' });
  const flatten = q.buildFindMany({ ...args, relationLoadStrategy: 'flatten' });
  // Rebuild both to force a cache HIT (which also runs the dev cross-check that
  // compares the collected params against a fresh build).
  const joinAgain = q.buildFindMany({ ...args, relationLoadStrategy: 'join' });
  const flattenAgain = q.buildFindMany({ ...args, relationLoadStrategy: 'flatten' });
  return { join, flatten, joinAgain, flattenAgain };
}

// ---------------------------------------------------------------------------
// SQL shape
// ---------------------------------------------------------------------------

describe("relationLoadStrategy: 'flatten', SQL shape", () => {
  it('compiles a belongsTo to a LEFT JOIN with a prefixed projection', () => {
    const sql = sqlFor({ with: { org: true }, ...FLATTEN });
    assert.match(sql, /FROM "orgs" f0s\) f0 ON f0\."f0__\$c0" = "users"\."org_id"/);
    assert.match(sql, /f0s\."name" AS "f0__name"/);
    // ...and NOT as a correlated json subquery.
    assert.doesNotMatch(sql, /json_build_object\('id', f0/);
    assert.doesNotMatch(sql, /AS "org"/);
  });

  it('projects the match discriminator as a predicate, never as the key value', () => {
    // Top-level node: a constant, nulled by the outer LEFT JOIN on a miss.
    assert.match(sqlFor({ with: { org: true }, ...FLATTEN }), /SELECT 1 AS "f0__\$k"/);
    // Nested node: a predicate on the key column, never the key VALUE.
    assert.match(
      sqlFor({ with: { org: { with: { region: true } } }, ...FLATTEN }),
      /\(f1s\."id" IS NOT NULL\) AS "f1__\$k"/,
    );
  });

  it('compiles a hasOne over a UNIQUE child FK to a LEFT JOIN', () => {
    const sql = sqlFor({ with: { profile: true }, ...FLATTEN });
    assert.match(sql, /FROM "profiles" f0s\) f0 ON f0\."f0__\$c0" = "users"\."id"/);
    assert.match(sql, /f0s\."user_id" AS "f0__\$c0"/);
  });

  it('chains to-one relations as successive joins on the previous alias', () => {
    const sql = sqlFor({ with: { org: { with: { region: { with: { parent: true } } } } }, ...FLATTEN });
    assert.match(sql, /\) f0 ON f0\."f0__\$c0" = "users"\."org_id"/);
    assert.match(sql, /LEFT JOIN "regions" f1s ON f1s\."id" = f0s\."region_id"/);
    assert.match(sql, /LEFT JOIN "regions" f2s ON f2s\."id" = f1s\."parent_id"/);
  });

  it('flattens a self-relation without alias collisions', () => {
    const sql = sqlFor({ with: { manager: { with: { manager: true } } }, ...FLATTEN });
    assert.match(
      sql,
      /FROM "users" f0s LEFT JOIN "users" f1s ON f1s\."id" = f0s\."manager_id"\) f0 ON f0\."f0__\$c0" = "users"\."manager_id"/,
    );
  });

  it('keeps a to-many nested under a flattened to-one as a correlated subquery on the join alias', () => {
    const sql = sqlFor({ with: { org: { with: { members: true } } }, ...FLATTEN });
    assert.match(sql, /FROM "users" t0 WHERE t0\."org_id" = "f0s"\."id"/);
    assert.match(sql, /AS "f0__members"/);
  });

  it('narrows the projection with a relation `select`', () => {
    const sql = sqlFor({ with: { org: { select: { name: true } } }, ...FLATTEN });
    assert.match(sql, /f0s\."name" AS "f0__name"/);
    assert.doesNotMatch(sql, /f0s\."region_id" AS "f0__region_id"/);
    // The discriminator survives the narrowing (it is not one of the columns).
    assert.match(sql, /SELECT 1 AS "f0__\$k"/);
  });

  it('puts a relation `where` in the ON clause, not the WHERE clause', () => {
    const d = makeQuery('users', buildSchema()).buildFindMany({
      where: { name: 'kirby' },
      with: { org: { where: { name: 'acme' } } },
      ...FLATTEN,
      // biome-ignore lint/suspicious/noExplicitAny: build-only args
    } as any);
    // The relation predicate filters INSIDE the derived table, which for a LEFT
    // JOIN is equivalent to an ON condition: the parent row survives, the
    // relation assembles as null.
    assert.match(d.sql, /FROM "orgs" f0s WHERE f0s\."name" = \$2\) f0 ON /);
    assert.match(d.sql, /\) f0 ON f0\."f0__\$c0" = "users"\."org_id" WHERE "name" = \$1/);
    // Parent where binds first, then the relation's ON predicate.
    assert.deepEqual(d.params, ['kirby', 'acme']);
  });

  it('AND-merges a target global filter into the ON clause', () => {
    const q = makeQuery('users', buildSchema(), { globalFilters: { orgs: { deleted: false } } });
    // biome-ignore lint/suspicious/noExplicitAny: build-only args
    const d = q.buildFindMany({ with: { org: true }, ...FLATTEN } as any);
    assert.match(d.sql, /FROM "orgs" f0s WHERE f0s\."deleted" = \$1\) f0 ON /);
    assert.deepEqual(d.params, [false]);
  });

  it('leaves top-level `_count` on its correlated COUNT(*) subquery', () => {
    const sql = sqlFor({ with: { org: true, _count: { posts: true } }, ...FLATTEN });
    assert.match(sql, /\) f0 ON /);
    assert.match(sql, /AS "_count__posts"/);
  });

  it('pages over the parent set: LIMIT/OFFSET stay on the joined statement', () => {
    // Safe precisely BECAUSE the join key is provably unique: at most one target
    // row per parent, so the join never changes the parent row count.
    const sql = sqlFor({ with: { org: true }, limit: 10, offset: 5, ...FLATTEN });
    assert.match(sql, /\) f0 ON /);
    assert.match(sql, /LIMIT \$1 OFFSET \$2/);
    assert.doesNotMatch(sql, /SELECT \* FROM \(/);
  });
});

// ---------------------------------------------------------------------------
// Eligibility / fallback
// ---------------------------------------------------------------------------

describe("relationLoadStrategy: 'flatten', fallback rules", () => {
  /** Assert the shape compiles to EXACTLY the default-strategy statement. */
  // biome-ignore lint/suspicious/noExplicitAny: build-only helper
  function assertFallsBack(args: any, schema: SchemaMetadata = buildSchema(), options?: any) {
    const flat = sqlFor({ ...args, relationLoadStrategy: 'flatten' }, 'users', schema, options);
    const join = sqlFor({ ...args, relationLoadStrategy: 'join' }, 'users', schema, options);
    assert.equal(flat, join);
    assert.doesNotMatch(flat, /\) f\d ON /);
  }

  it('FAN-OUT GUARD: a belongsTo whose target key is not provably unique falls back', () => {
    // `cities.code` has only a non-unique index, joining on it would multiply
    // parent rows. Must stay a correlated subquery.
    assertFallsBack({ with: { city: true } });
  });

  it('FAN-OUT GUARD: a hasOne over a non-unique child FK falls back', () => {
    // `posts.user_id` is not unique: the "hasOne" is a lie the schema cannot back.
    assertFallsBack({ with: { draft: true } });
  });

  it('a unique index on (a, b) does not make (a) unique', () => {
    const schema = buildSchema();
    (schema.tables.cities as TableMetadata).indexes = [
      { name: 'u', columns: ['code', 'label'], unique: true, definition: '' },
    ];
    assertFallsBack({ with: { city: true } }, schema);
  });

  it('a PARTIAL unique index is not a uniqueness proof', () => {
    const schema = buildSchema();
    (schema.tables.cities as TableMetadata).indexes = [
      { name: 'u', columns: ['code'], unique: true, partial: true, definition: '' },
    ];
    assertFallsBack({ with: { city: true } }, schema);
  });

  it('a FULL unique index IS a uniqueness proof', () => {
    const schema = buildSchema();
    (schema.tables.cities as TableMetadata).indexes = [{ name: 'u', columns: ['code'], unique: true, definition: '' }];
    const sql = sqlFor({ with: { city: true }, ...FLATTEN }, 'users', schema);
    assert.match(sql, /FROM "cities" f0s\) f0 ON f0\."f0__\$c0" = "users"\."city_code"/);
  });

  it('to-many relations are never flattened', () => {
    assertFallsBack({ with: { posts: true } });
  });

  it('a relation `orderBy` or `limit` falls back', () => {
    assertFallsBack({ with: { org: { orderBy: { name: 'asc' } } } });
    assertFallsBack({ with: { org: { limit: 1 } } });
  });

  it('`distinct` disables the whole plan', () => {
    assertFallsBack({ with: { org: true }, distinct: ['orgId'] });
  });

  it('SQL Server is ineligible: its FOR JSON PATH override owns relation SQL', () => {
    // mssqlDialect defines `buildRelationSubquery`, so it compiles the whole
    // relation itself; flatten has no branch for that shape and must not try.
    assertFallsBack({ with: { org: true } }, buildSchema(), { dialect: mssqlDialect });
  });

  it("`jsonEncoding: 'positional'` disables the whole plan", () => {
    assertFallsBack({ with: { org: true } }, buildSchema(), { jsonEncoding: 'positional' });
  });

  it('a nested `_count` falls back and still raises the join path error', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: build-only args
      () => q.buildFindMany({ with: { org: { with: { _count: true } } }, ...FLATTEN } as any),
      RelationError,
    );
  });

  it('an unknown nested relation falls back and still raises E005', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: build-only args
      () => q.buildFindMany({ with: { org: { with: { nope: true } } }, ...FLATTEN } as any),
      RelationError,
    );
  });

  it('the depth cap still fires on a too-deep to-one chain', () => {
    // 11 nested `parent` levels: the 11th is refused by the planner, falls to
    // the subquery path, and raises the same CircularRelationError as 'join'.
    let spec: unknown = true;
    for (let i = 0; i < 12; i++) spec = { with: { parent: spec } };
    const q = makeQuery('regions', buildSchema());
    // biome-ignore lint/suspicious/noExplicitAny: build-only args
    assert.throws(() => q.buildFindMany({ with: { parent: spec }, ...FLATTEN } as any), CircularRelationError);
  });

  it('an alias that would collide with a root column disables the plan', () => {
    const schema = buildSchema();
    const users = schema.tables.users as TableMetadata;
    users.columns.push({
      name: 'f0__id',
      field: 'f0Id',
      pgType: 'text',
      tsType: 'string',
      nullable: true,
      hasDefault: false,
      isArray: false,
      pgArrayType: 'text[]',
    });
    users.allColumns.push('f0__id');
    users.columnMap.f0Id = 'f0__id';
    users.reverseColumnMap.f0__id = 'f0Id';
    assertFallsBack({ with: { org: true } }, schema);
  });

  it('a mixed clause flattens only the eligible relations', () => {
    const sql = sqlFor({ with: { org: true, posts: true, city: true }, ...FLATTEN });
    assert.match(sql, /FROM "orgs" f0s\) f0 ON /);
    assert.match(sql, /AS "posts"/); // to-many stays a subquery
    assert.match(sql, /AS "city"/); // unprovable uniqueness stays a subquery
  });

  it('the default strategy is untouched: no arg emits exactly the join statement', () => {
    const schema = buildSchema();
    const bare = sqlFor({ with: { org: true, posts: true } }, 'users', schema);
    const join = sqlFor({ with: { org: true, posts: true }, relationLoadStrategy: 'join' }, 'users', schema);
    assert.equal(bare, join);
    assert.doesNotMatch(bare, /\) f0 ON /);
  });
});

// ---------------------------------------------------------------------------
// SQL-template cache
// ---------------------------------------------------------------------------

describe("relationLoadStrategy: 'flatten', fallback is announced, not silent", () => {
  /**
   * An explicitly requested strategy that quietly does not engage is
   * indistinguishable from one that does nothing: the query succeeds and the
   * rows are right (the strategies are value-identical), so the only symptom is
   * a plan the caller did not ask for. Each ineligible shape must name itself.
   */
  function captureWarnings(fn: () => void): string[] {
    resetWarnOnce(WARN_NS.flattenFallback);
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => {
      lines.push(String(msg));
    };
    try {
      fn();
    } finally {
      console.warn = original;
      resetWarnOnce(WARN_NS.flattenFallback);
    }
    return lines.filter((l) => l.includes("'flatten' did not engage"));
  }

  const cases: [name: string, reason: RegExp, run: () => void][] = [
    [
      'a to-many relation',
      /only a to-one relation can be flattened/,
      () => sqlFor({ ...FLATTEN, with: { posts: true } }),
    ],
    ['an unprovably-unique correlation key', /not provably unique/, () => sqlFor({ ...FLATTEN, with: { city: true } })],
    [
      'a relation orderBy',
      /declares an `orderBy`/,
      () => sqlFor({ ...FLATTEN, with: { org: { orderBy: { name: 'asc' } } } }),
    ],
    ['a relation limit', /declares a `limit`/, () => sqlFor({ ...FLATTEN, with: { org: { limit: 1 } } })],
    [
      'a nested _count',
      /nested `with` uses `_count`/,
      () => {
        try {
          sqlFor({ ...FLATTEN, with: { org: { with: { _count: { users: true } } } } });
        } catch {
          // The join path raises its own error afterwards; the warning is what
          // this case is about.
        }
      },
    ],
    ['`distinct`', /uses `distinct`/, () => sqlFor({ ...FLATTEN, with: { org: true }, distinct: ['orgId'] })],
    [
      'the positional wire encoding',
      /jsonEncoding: 'positional'/,
      () => sqlFor({ ...FLATTEN, with: { org: true } }, 'users', buildSchema(), { jsonEncoding: 'positional' }),
    ],
    [
      'a dialect that owns relation subqueries',
      /generates relation subqueries itself/,
      () => sqlFor({ ...FLATTEN, with: { org: true } }, 'users', buildSchema(), { dialect: mssqlDialect }),
    ],
    [
      'findUnique',
      /reads a single parent row/,
      () =>
        makeQuery('users', buildSchema()).buildFindUnique({
          ...FLATTEN,
          where: { id: 1 },
          with: { org: true },
        } as never),
    ],
  ];

  for (const [name, reason, run] of cases) {
    it(`names the relation and the reason: ${name}`, () => {
      const warnings = captureWarnings(run);
      assert.equal(warnings.length, 1, `expected exactly one warning, got ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, reason);
      assert.match(warnings[0]!, /on "users"/, 'the table must be named');
    });
  }

  it('names a NESTED relation by its dotted path', () => {
    // `orgs.members` is a hasMany, so it declines one level down from `org`.
    const warnings = captureWarnings(() => sqlFor({ ...FLATTEN, with: { org: { with: { members: true } } } }));
    assert.ok(
      warnings.some((w) => /"org\.members"/.test(w) && /only a to-one relation/.test(w)),
      `expected a dotted nested path, got ${JSON.stringify(warnings)}`,
    );
  });

  it('warns once per reason no matter how often the query is built', () => {
    const warnings = captureWarnings(() => {
      const q = makeQuery('users', buildSchema());
      for (let i = 0; i < 5; i++) q.buildFindMany({ ...FLATTEN, with: { posts: true } } as never);
    });
    assert.equal(warnings.length, 1, 'the shared registry must dedupe across rebuilds');
  });

  it('says nothing when the plan DOES engage', () => {
    const warnings = captureWarnings(() => sqlFor({ ...FLATTEN, with: { org: true } }));
    assert.deepEqual(warnings, []);
  });

  it('is silent in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.deepEqual(
        captureWarnings(() => sqlFor({ ...FLATTEN, with: { posts: true } })),
        [],
      );
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});

describe("relationLoadStrategy: 'flatten', SQL cache isolation", () => {
  it('join- and flatten-planned queries never share a cache entry', () => {
    const { join, flatten, joinAgain, flattenAgain } = bothStrategies({ with: { org: true } });
    assert.notEqual(join.sql, flatten.sql);
    // Warm-cache reads return each plan's OWN statement.
    assert.equal(joinAgain.sql, join.sql);
    assert.equal(flattenAgain.sql, flatten.sql);
  });

  it('warm-cache param collection mirrors the build path (dev cross-check)', () => {
    // crossCheckCache re-runs the builder on every cache HIT outside production
    // and throws on any divergence, so a passing rebuild IS the assertion.
    const args = {
      where: { name: 'kirby' },
      with: { org: { where: { name: 'acme' }, with: { members: { limit: 2 }, region: true } }, posts: { limit: 3 } },
      limit: 5,
    };
    const { flatten, flattenAgain } = bothStrategies(args);
    assert.equal(flatten.sql, flattenAgain.sql);
    assert.deepEqual(flatten.params, flattenAgain.params);
    assert.deepEqual(flatten.params, ['kirby', 'acme', 2, 3, 5]);
  });
});

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

describe("relationLoadStrategy: 'flatten', row assembly", () => {
  // biome-ignore lint/suspicious/noExplicitAny: synthetic driver result
  function run(args: any, rows: Record<string, unknown>[]): unknown[] {
    const d = makeQuery('users', buildSchema()).buildFindMany(args);
    // biome-ignore lint/suspicious/noExplicitAny: synthetic driver result
    return d.transform({ rows } as any) as unknown[];
  }

  it('a non-matching LEFT JOIN assembles as null', () => {
    const out = run({ with: { org: true }, ...FLATTEN }, [
      {
        id: 1,
        name: 'a',
        org_id: null,
        manager_id: null,
        city_code: null,
        account_email: null,
        f0__$k: false,
        f0__id: null,
        f0__name: null,
        f0__region_id: null,
        f0__deleted: null,
      },
    ]);
    assert.deepEqual(out, [
      { id: 1, name: 'a', orgId: null, managerId: null, cityCode: null, accountEmail: null, org: null },
    ]);
  });

  it('a matched row whose every projected column is NULL is an OBJECT, not null', () => {
    // The whole point of the discriminator: this row exists.
    const out = run({ with: { org: true }, ...FLATTEN }, [
      {
        id: 1,
        name: 'a',
        org_id: 7,
        manager_id: null,
        city_code: null,
        account_email: null,
        f0__$k: true,
        f0__id: null,
        f0__name: null,
        f0__region_id: null,
        f0__deleted: null,
      },
    ]);
    assert.deepEqual((out[0] as Record<string, unknown>).org, {
      id: null,
      name: null,
      regionId: null,
      deleted: null,
    });
  });

  it('assembles a three-level to-one chain', () => {
    const out = run({ with: { org: { with: { region: { with: { parent: true } } } } }, ...FLATTEN }, [
      {
        id: 1,
        name: 'a',
        org_id: 7,
        manager_id: null,
        city_code: null,
        account_email: null,
        f0__$k: true,
        f0__id: 7,
        f0__name: 'acme',
        f0__region_id: 3,
        f0__deleted: false,
        f1__$k: true,
        f1__id: 3,
        f1__code: 'eu',
        f1__parent_id: 2,
        f2__$k: true,
        f2__id: 2,
        f2__code: 'emea',
        f2__parent_id: null,
      },
    ]);
    const org = (out[0] as Record<string, unknown>).org as Record<string, unknown>;
    const region = org.region as Record<string, unknown>;
    assert.equal((region.parent as Record<string, unknown>).code, 'emea');
  });

  it('key order matches the join strategy (relation slots in sorted order)', () => {
    const out = run({ with: { org: { with: { members: true, region: true } }, posts: true }, ...FLATTEN }, [
      {
        id: 1,
        name: 'a',
        org_id: 7,
        manager_id: null,
        city_code: null,
        account_email: null,
        f0__$k: true,
        f0__id: 7,
        f0__name: 'acme',
        f0__region_id: 3,
        f0__deleted: false,
        f0__members: '[]',
        f1__$k: true,
        f1__id: 3,
        f1__code: 'eu',
        f1__parent_id: null,
        posts: '[]',
      },
    ]);
    const row = out[0] as Record<string, unknown>;
    assert.deepEqual(Object.keys(row), [
      'id',
      'name',
      'orgId',
      'managerId',
      'cityCode',
      'accountEmail',
      'org',
      'posts',
    ]);
    assert.deepEqual(Object.keys(row.org as object), ['id', 'name', 'regionId', 'deleted', 'members', 'region']);
  });

  it('parses a to-many nested under a flattened to-one', () => {
    const out = run({ with: { org: { with: { members: true } } }, ...FLATTEN }, [
      {
        id: 1,
        name: 'a',
        org_id: 7,
        manager_id: null,
        city_code: null,
        account_email: null,
        f0__$k: true,
        f0__id: 7,
        f0__name: 'acme',
        f0__region_id: null,
        f0__deleted: false,
        f0__members: '[{"id":1,"name":"a","orgId":7,"managerId":null,"cityCode":null,"accountEmail":null}]',
      },
    ]);
    const org = (out[0] as Record<string, unknown>).org as Record<string, unknown>;
    assert.deepEqual((org.members as unknown[]).length, 1);
  });
});

// ---------------------------------------------------------------------------
// PII contract
// ---------------------------------------------------------------------------

describe("relationLoadStrategy: 'flatten', PII contract", () => {
  it('a PII correlation key is used as a predicate only and never projected', () => {
    const sql = sqlFor({ with: { account: true }, ...FLATTEN });
    assert.match(sql, /FROM "accounts" f0s\) f0 ON f0\."f0__\$c0" = "users"\."account_email"/);
    assert.match(sql, /SELECT 1 AS "f0__\$k"/);
    // The correlation column is re-exposed INSIDE the derived table so the outer
    // join can reference it, but the outer SELECT never projects a `$c` column,
    // so no PII value is returned to the caller.
    assert.doesNotMatch(sql, /f0s\."email" AS "f0__email"/);
    assert.doesNotMatch(sql, /"f0"\."f0__\$c0"/);
  });

  it('`includePii` projects it, and the two share no cache entry', () => {
    const q = makeQuery('users', buildSchema());
    // biome-ignore lint/suspicious/noExplicitAny: build-only args
    const off = q.buildFindMany({ with: { account: true }, ...FLATTEN } as any);
    // biome-ignore lint/suspicious/noExplicitAny: build-only args
    const on = q.buildFindMany({ with: { account: true }, includePii: true, ...FLATTEN } as any);
    assert.doesNotMatch(off.sql, /f0s\."email" AS "f0__email"/);
    assert.match(on.sql, /f0s\."email" AS "f0__email"/);
  });

  it('the assembled object omits the PII column', () => {
    const d = makeQuery('users', buildSchema()).buildFindMany({
      with: { account: true },
      ...FLATTEN,
      // biome-ignore lint/suspicious/noExplicitAny: build-only args
    } as any);
    const out = d.transform({
      rows: [
        {
          id: 1,
          name: 'a',
          org_id: null,
          manager_id: null,
          city_code: null,
          account_email: 'x@y.z',
          f0__$k: true,
          f0__id: 5,
          f0__plan: 'pro',
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: synthetic driver result
    } as any) as Record<string, unknown>[];
    assert.deepEqual(out[0]!.account, { id: 5, plan: 'pro' });
  });
});
