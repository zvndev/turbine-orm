/**
 * PowDB answers with Postgres semantics, or refuses.
 *
 * Every test here runs the REAL in-process `@zvndev/powdb-embedded` engine on a
 * schema and seed built through Turbine's own code-first path (`defineSchema`,
 * `powqlSchemaDDL`), and asserts the rows Postgres returns for the same data
 * and the same arguments. The final suite runs the same matrix against a live
 * Postgres (gated on DATABASE_URL) and diffs the two engines directly, so the
 * expected values written below are checked against the oracle, not against
 * PowDB's own earlier output.
 *
 * Areas: global filters on every relation path; `is` / `isNot` / bare to-one
 * relation filters; `none` / `every` with NULL keys and NULL child columns; the
 * relation-filter key cap; literal `contains` / `startsWith` / `endsWith`;
 * `numeric` columns; column defaults; `_min` / `_max` decoding; and plain
 * statements issued while a transaction is open.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { applyPowdbLinks, powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { MAX_RELATION_FILTER_KEYS } from '../powql.js';
import { UNSAFE } from '../query/index.js';
import { jsonValue } from '../query/json-value.js';
import type { SchemaMetadata } from '../schema.js';
import { defineSchema, type SchemaDef } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { skipGate } from './helpers.js';

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

// biome-ignore lint/suspicious/noExplicitAny: the matrix drives many arg shapes through untyped table accessors
type Db = any;

// ---------------------------------------------------------------------------
// Fixture: one schema, one seed, for both engines
// ---------------------------------------------------------------------------

const def: SchemaDef = defineSchema({
  orgs: { id: { type: 'serial', primaryKey: true }, name: { type: 'text', notNull: true } },
  users: {
    id: { type: 'serial', primaryKey: true },
    orgId: { type: 'integer', notNull: true, references: 'orgs.id' },
    managerId: { type: 'integer', references: 'users.id' },
    tenantId: { type: 'integer', notNull: true, default: '1' },
    email: { type: 'text', notNull: true },
    score: { type: 'integer' },
    balance: { type: 'numeric' },
    big: { type: 'bigint' },
    joinedAt: { type: 'timestamptz' },
    role: { type: 'text', default: "'member'" },
    active: { type: 'boolean', default: 'true' },
  },
  posts: {
    id: { type: 'serial', primaryKey: true },
    userId: { type: 'integer', references: 'users.id' },
    title: { type: 'text', notNull: true },
    rating: { type: 'double' },
    meta: { type: 'json' },
    tenantId: { type: 'integer', notNull: true, default: '1' },
    createdAt: { type: 'timestamptz', notNull: true, default: 'now()' },
  },
  tags: {
    id: { type: 'serial', primaryKey: true },
    label: { type: 'text', notNull: true },
    tenantId: { type: 'integer', notNull: true, default: '1' },
  },
  postTags: {
    postId: { type: 'integer', notNull: true, references: 'posts.id' },
    tagId: { type: 'integer', notNull: true, references: 'tags.id' },
    primaryKey: ['postId', 'tagId'],
  },
} as never);

/**
 * The metadata with each column's default expression attached, the input the
 * PowDB engine needs to apply a default it has no DDL for.
 */
function withDefaultExpressions(meta: SchemaMetadata): SchemaMetadata {
  for (const table of Object.values(def.tables)) {
    const tm = meta.tables[table.name]!;
    for (const [field, config] of Object.entries(table.columns)) {
      if (config.defaultValue == null) continue;
      const col = tm.columns.find((c) => c.field === field)!;
      (col as { defaultValue?: string }).defaultValue = config.defaultValue;
    }
  }
  return meta;
}

const SCHEMA = withDefaultExpressions(schemaDefToMetadata(def));

const USERS = [
  { orgId: 1, managerId: null, tenantId: 1, email: 'alice@x', score: 10, balance: '12.34', big: 9007199254740993n },
  { orgId: 1, managerId: 1, tenantId: 1, email: 'bob@x', score: 2, balance: '7.5', big: -5n },
  { orgId: 1, managerId: 1, tenantId: 1, email: 'carol@x', score: null, balance: '7.50', big: null },
  { orgId: 2, managerId: null, tenantId: 2, email: 'judy@x', score: 8, balance: '100', big: 7n },
  { orgId: 2, managerId: 4, tenantId: 2, email: 'mallory@x', score: 1, balance: null, big: 1n },
];
const POSTS = [
  { userId: 1, title: '50% off_now', rating: 4, meta: { t: '50% off_now' }, tenantId: 1 },
  { userId: 1, title: '50X off-now', rating: null, meta: { t: '50X off-now' }, tenantId: 1 },
  { userId: 2, title: 'a\\b', rating: 2, meta: { t: 'a\\b' }, tenantId: 1 },
  { userId: 4, title: 'tenant two', rating: 5, meta: null, tenantId: 2 },
  { userId: null, title: 'orphan', rating: 1, meta: null, tenantId: 1 },
];
const TAGS: [string, number][] = [
  ['ts', 1],
  ['pg', 1],
  ['secret', 2],
];
const POST_TAGS = [
  [1, 1],
  [1, 3],
  [2, 2],
  [4, 3],
];
const JOINED = new Date('2026-03-08T06:59:59.999Z');

async function seed(db: Db): Promise<void> {
  await db.table('orgs').create({ data: { name: 'Acme' } });
  await db.table('orgs').create({ data: { name: 'Globex' } });
  for (const [i, u] of USERS.entries()) {
    await db.table('users').create({ data: { ...u, joinedAt: i === 0 ? JOINED : null, role: 'member' } });
  }
  for (const p of POSTS) await db.table('posts').create({ data: p });
  for (const [label, tenantId] of TAGS) await db.table('tags').create({ data: { label, tenantId } });
  for (const [postId, tagId] of POST_TAGS) await db.table('post_tags').create({ data: { postId, tagId } });
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A seeded embedded database, reopened with `opts`. */
/** One literal statement as the tagged-template argument `raw` takes. */
const tsa = (sql: string): TemplateStringsArray =>
  Object.assign([sql], { raw: [sql] }) as unknown as TemplateStringsArray;

async function openPow(opts: Record<string, unknown> = {}, schema: SchemaMetadata = SCHEMA): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-v090-'));
  dirs.push(dir);
  const boot = await turbinePowDB({ embedded: dir }, SCHEMA, { warnOnUnlimited: false });
  for (const stmt of powqlSchemaDDL(SCHEMA)) await boot.raw(tsa(stmt));
  await seed(boot);
  await boot.disconnect();
  return turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false, ...opts });
}

const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id);
const TENANT_USERS = { globalFilters: { users: () => ({ tenantId: 1 }) } };
const TENANT_ALL = { globalFilters: { users: () => ({ tenantId: 1 }), tags: { tenantId: 1 } } };

async function withDb<R>(opts: Record<string, unknown>, fn: (db: Db) => Promise<R>): Promise<R> {
  const db = await openPow(opts);
  try {
    return await fn(db);
  } finally {
    await db.disconnect();
  }
}

// ---------------------------------------------------------------------------
// The shared read matrix (asserted on PowDB here, diffed against Postgres below)
// ---------------------------------------------------------------------------

type Case = { name: string; opts: Record<string, unknown>; run: (db: Db) => Promise<unknown>; expected: unknown };

const orgUsers = (rows: { id: number; users: { id: number }[] }[]) => rows.map((o) => [o.id, ids(o.users)]);
const postUser = (rows: { id: number; user: { id: number } | null }[]) => rows.map((p) => [p.id, p.user?.id ?? null]);
const postTags = (rows: { id: number; tags: { id: number }[] }[]) => rows.map((p) => [p.id, ids(p.tags)]);
const ORDER = { orderBy: { id: 'asc' } };

const MATRIX: Case[] = [
  // Global filters on every relation path.
  ...(['default', 'batched', 'join'] as const).flatMap((strategy): Case[] => {
    const s = strategy === 'default' ? {} : { relationLoadStrategy: strategy };
    return [
      {
        name: `global filter, hasMany with (${strategy})`,
        opts: TENANT_USERS,
        run: async (db) => orgUsers(await db.table('orgs').findMany({ with: { users: true }, ...ORDER, ...s })),
        expected: [
          [1, [1, 2, 3]],
          [2, []],
        ],
      },
      {
        // A projection without the bigint column keeps the relation eligible
        // for a nested projection block; the full row is not (see the path test).
        name: `global filter, hasMany with a projection (${strategy})`,
        opts: TENANT_USERS,
        run: async (db) =>
          orgUsers(await db.table('orgs').findMany({ with: { users: { select: { id: true } } }, ...ORDER, ...s })),
        expected: [
          [1, [1, 2, 3]],
          [2, []],
        ],
      },
      {
        name: `global filter, belongsTo with a projection (${strategy})`,
        opts: TENANT_USERS,
        run: async (db) =>
          postUser(await db.table('posts').findMany({ with: { user: { select: { id: true } } }, ...ORDER, ...s })),
        expected: [
          [1, 1],
          [2, 1],
          [3, 2],
          [4, null],
          [5, null],
        ],
      },
      {
        name: `global filter, belongsTo with (${strategy})`,
        opts: TENANT_USERS,
        run: async (db) => postUser(await db.table('posts').findMany({ with: { user: true }, ...ORDER, ...s })),
        expected: [
          [1, 1],
          [2, 1],
          [3, 2],
          [4, null],
          [5, null],
        ],
      },
      {
        name: `global filter, manyToMany with (${strategy})`,
        opts: TENANT_ALL,
        run: async (db) => postTags(await db.table('posts').findMany({ with: { tags: true }, ...ORDER, ...s })),
        expected: [
          [1, [1]],
          [2, [2]],
          [3, []],
          [4, []],
          [5, []],
        ],
      },
      {
        name: `skipGlobalFilters reaches a manyToMany relation (${strategy})`,
        opts: TENANT_ALL,
        run: async (db) =>
          postTags(
            await db.table('posts').findMany({ with: { tags: true }, skipGlobalFilters: UNSAFE, ...ORDER, ...s }),
          ),
        expected: [
          [1, [1, 3]],
          [2, [2]],
          [3, []],
          [4, [3]],
          [5, []],
        ],
      },
      {
        name: `skipGlobalFilters reaches the relation (${strategy})`,
        opts: TENANT_USERS,
        run: async (db) =>
          orgUsers(
            await db.table('orgs').findMany({ with: { users: true }, skipGlobalFilters: UNSAFE, ...ORDER, ...s }),
          ),
        expected: [
          [1, [1, 2, 3]],
          [2, [4, 5]],
        ],
      },
    ];
  }),
  {
    name: 'global filter, two-level with',
    opts: TENANT_USERS,
    run: async (db) =>
      (await db.table('orgs').findMany({ with: { users: { with: { posts: true } } }, ...ORDER })).map(
        (o: { id: number; users: { id: number; posts: { id: number }[] }[] }) => [
          o.id,
          o.users.map((u) => [u.id, ids(u.posts)]),
        ],
      ),
    expected: [
      [
        1,
        [
          [1, [1, 2]],
          [2, [3]],
          [3, []],
        ],
      ],
      [2, []],
    ],
  },
  {
    name: 'global filter bounds a relation filter',
    opts: TENANT_USERS,
    run: async (db) => ids(await db.table('orgs').findMany({ where: { users: { some: {} } }, ...ORDER })),
    expected: [1],
  },
  {
    name: 'per-table skipGlobalFilters reaches a relation filter',
    opts: TENANT_USERS,
    run: async (db) =>
      ids(
        await db
          .table('orgs')
          .findMany({ where: { users: { some: {} } }, skipGlobalFilters: [UNSAFE, 'users'], ...ORDER }),
      ),
    expected: [1, 2],
  },
  // To-one relation filters.
  {
    name: 'is',
    opts: {},
    run: async (db) => ids(await db.table('posts').findMany({ where: { user: { is: { email: 'bob@x' } } }, ...ORDER })),
    expected: [3],
  },
  {
    name: 'isNot (keeps the NULL foreign key)',
    opts: {},
    run: async (db) =>
      ids(await db.table('posts').findMany({ where: { user: { isNot: { email: 'bob@x' } } }, ...ORDER })),
    expected: [1, 2, 4, 5],
  },
  {
    name: 'bare to-one object is an implicit is',
    opts: {},
    run: async (db) => ids(await db.table('posts').findMany({ where: { user: { email: 'bob@x' } }, ...ORDER })),
    expected: [3],
  },
  {
    name: 'is: null',
    opts: {},
    run: async (db) => ids(await db.table('posts').findMany({ where: { user: { is: null } }, ...ORDER })),
    expected: [5],
  },
  {
    name: 'isNot: null',
    opts: {},
    run: async (db) => ids(await db.table('posts').findMany({ where: { user: { isNot: null } }, ...ORDER })),
    expected: [1, 2, 3, 4],
  },
  {
    name: 'count with is',
    opts: {},
    run: (db) => db.table('posts').count({ where: { user: { is: { orgId: 2 } } } }),
    expected: 1,
  },
  {
    name: 'is and isNot together',
    opts: {},
    run: async (db) =>
      ids(
        await db
          .table('posts')
          .findMany({ where: { user: { is: { orgId: 1 }, isNot: { email: 'alice@x' } } }, ...ORDER }),
      ),
    expected: [3],
  },
  // `not` over an operator object holds where the inner condition is FALSE, so a NULL column is excluded.
  {
    name: 'not over an operator object',
    opts: {},
    run: async (db) => [
      ids(await db.table('users').findMany({ where: { score: { not: { gt: 5 } } }, ...ORDER })),
      ids(await db.table('posts').findMany({ where: { rating: { not: { in: [4, 5] } } }, ...ORDER })),
    ],
    expected: [
      [2, 5],
      [3, 5],
    ],
  },
  // An integral number against a float column, inside every predicate shape.
  {
    name: 'integral numbers against a float column',
    opts: {},
    run: async (db) => {
      const P = db.table('posts');
      return [
        ids(await P.findMany({ where: { rating: { in: [4, 5] } }, ...ORDER })),
        ids(await P.findMany({ where: { rating: { notIn: [4, 5] } }, ...ORDER })),
        ids(await P.findMany({ where: { OR: [{ rating: 4 }, { id: 5 }] }, ...ORDER })),
        ids(await P.findMany({ where: { OR: [{ rating: { equals: 2 } }, { id: 5 }] }, ...ORDER })),
        ids(await P.findMany({ where: { user: { none: { posts: { some: { rating: 4 } } } } }, ...ORDER })),
      ];
    },
    expected: [
      [1, 4],
      [3, 5],
      [1, 5],
      [3, 5],
      [3, 4, 5],
    ],
  },
  // none / every with NULLs.
  {
    name: 'none over a nullable foreign key',
    opts: {},
    run: async (db) =>
      ids(await db.table('users').findMany({ where: { user: { none: { score: { gt: 5 } } } }, ...ORDER })),
    expected: [1, 4],
  },
  {
    name: 'every over a nullable foreign key',
    opts: {},
    run: async (db) =>
      ids(await db.table('users').findMany({ where: { user: { every: { score: { lt: 9 } } } }, ...ORDER })),
    expected: [1, 4, 5],
  },
  {
    name: 'every with a NULL child column',
    opts: {},
    run: async (db) =>
      ids(await db.table('users').findMany({ where: { posts: { every: { rating: { gt: 1 } } } }, ...ORDER })),
    expected: [1, 2, 3, 4, 5],
  },
  {
    name: 'every with a NOT inside the predicate',
    opts: {},
    run: async (db) =>
      ids(await db.table('users').findMany({ where: { posts: { every: { NOT: { rating: { lt: 3 } } } } }, ...ORDER })),
    expected: [1, 3, 4, 5],
  },
  {
    name: 'none with a NULL child column',
    opts: {},
    run: async (db) =>
      ids(await db.table('users').findMany({ where: { posts: { none: { rating: { gt: 3 } } } }, ...ORDER })),
    expected: [2, 3, 5],
  },
  {
    name: 'manyToMany none and every',
    opts: {},
    run: async (db) => [
      ids(await db.table('posts').findMany({ where: { tags: { none: { label: 'secret' } } }, ...ORDER })),
      ids(await db.table('posts').findMany({ where: { tags: { every: { label: { not: 'secret' } } } }, ...ORDER })),
    ],
    expected: [
      [2, 3, 5],
      [2, 3, 5],
    ],
  },
  {
    name: 'NOT over a relation filter',
    opts: {},
    run: async (db) =>
      ids(await db.table('users').findMany({ where: { NOT: { posts: { some: { rating: { gte: 4 } } } } }, ...ORDER })),
    expected: [2, 3, 5],
  },
  // Literal string matching.
  {
    name: 'startsWith / endsWith / contains match metacharacters literally',
    opts: {},
    run: async (db) => {
      const t = (where: object) =>
        db
          .table('posts')
          .findMany({ where: { title: where }, ...ORDER })
          .then(ids);
      return [
        await t({ startsWith: '50%' }),
        await t({ endsWith: '_now' }),
        await t({ contains: '\\' }),
        await t({ startsWith: 'a\\' }),
        await t({ endsWith: 'longer than every title in the table' }),
        await t({ contains: 'off' }),
        await t({ startsWith: '50x', mode: 'insensitive' }),
      ];
    },
    expected: [[1], [1], [3], [3], [], [1, 2], [2]],
  },
  {
    name: 'JSON path startsWith / endsWith match metacharacters literally',
    opts: {},
    run: async (db) => [
      ids(await db.table('posts').findMany({ where: { meta: { path: ['t'], stringStartsWith: '50%' } }, ...ORDER })),
      ids(await db.table('posts').findMany({ where: { meta: { path: ['t'], stringEndsWith: '_now' } }, ...ORDER })),
    ],
    expected: [[1], [1]],
  },
  // _min / _max decoded through the column.
  {
    name: '_min / _max decode to the column type',
    opts: {},
    run: (db) =>
      db.table('users').aggregate({
        _min: { email: true, joinedAt: true, big: true, score: true },
        _max: { email: true, big: true },
      }),
    expected: {
      // int8 policy, as on a row read: a safe integer is a number, a larger one keeps its digits as a string.
      _min: { email: 'alice@x', joinedAt: JOINED, big: -5, score: 1 },
      _max: { email: 'mallory@x', big: '9007199254740993' },
    },
  },
  // An `undefined` filter value means "no filter on that key", as on the SQL engines.
  {
    name: 'undefined filter values are absent',
    opts: {},
    run: async (db) => {
      const U = db.table('users');
      const P = db.table('posts');
      return [
        ids(await U.findMany({ where: { email: undefined }, ...ORDER })),
        ids(await U.findMany({ where: { OR: [{ email: undefined }, { id: 2 }] }, ...ORDER })),
        ids(await U.findMany({ where: { email: { contains: undefined, mode: 'insensitive' } }, ...ORDER })),
        ids(await U.findMany({ orderBy: [{ score: undefined }, { id: 'desc' }] })),
        await P.count({ where: { user: { is: { email: undefined } } } }),
        await P.count({ where: { user: { is: { email: undefined, id: 1 } } } }),
      ];
    },
    expected: [[1, 2, 3, 4, 5], [2], [1, 2, 3, 4, 5], [5, 4, 3, 2, 1], 5, 2],
  },
  // Prisma's take / skip inside `with`.
  {
    name: 'take and skip inside with',
    opts: {},
    run: async (db) =>
      orgUsers(
        await db.table('orgs').findMany({ with: { users: { take: 2, skip: 1, orderBy: { id: 'asc' } } }, ...ORDER }),
      ),
    expected: [
      [1, [2, 3]],
      [2, [5]],
    ],
  },
  // Last, because it writes (and then removes) rows in the shared oracle schema.
  {
    name: 'jsonValue writes the serialized value',
    opts: {},
    run: async (db) => {
      const P = db.table('posts');
      for (const [title, meta] of [
        ['j1', jsonValue('hello')],
        ['j2', jsonValue([1, 2])],
        ['j3', jsonValue(null)],
        ['j4', jsonValue(0)],
      ] as const) {
        await P.create({ data: { title, meta, tenantId: 1 } });
      }
      await P.update({ where: { title: 'j4' }, data: { meta: jsonValue('x') }, allowFullTableScan: UNSAFE } as never);
      const rows = await P.findMany({ where: { title: { startsWith: 'j' } }, orderBy: { title: 'asc' } });
      await P.deleteMany({ where: { title: { startsWith: 'j' } } });
      return rows.map((r: { title: string; meta: unknown }) => [r.title, r.meta]);
    },
    expected: [
      ['j1', 'hello'],
      ['j2', [1, 2]],
      ['j3', null],
      ['j4', 'x'],
    ],
  },
];

describe('powdb v0.90: each relation path applies the global filter', () => {
  /** Run `fn` and return the PowQL statements it sent. */
  async function statements(db: Db, fn: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const listener = (e: { sql: string }) => seen.push(e.sql);
    db.$on('query', listener);
    try {
      await fn();
    } finally {
      db.$off('query', listener);
    }
    return seen;
  }

  it('nested projection, native join, loader and link path each filter the target', async () => {
    await withDb(TENANT_USERS, async (db) => {
      const O = db.table('orgs');
      let rowsAfterLink: unknown;
      const nested = await statements(db, () => O.findMany({ with: { users: { select: { id: true } } } }));
      assert.equal(nested.length, 1, 'one statement: the nested projection');
      assert.match(nested[0]!, /users: users as t1 filter t1\.org_id = t0\.id and \(t1\.tenant_id = \$\d+\)/);

      // Below engine 0.18 there are no nested projections, so an explicit
      // 'join' compiles to a native join for both directions of a relation.
      const pre018 = await openPow({ ...TENANT_USERS, assumeEngineVersion: '0.17.0' });
      try {
        const joinArgs = { relationLoadStrategy: 'join', ...ORDER };
        let rows: unknown;
        const hasMany = await statements(pre018, async () => {
          rows = await pre018.table('orgs').findMany({ with: { users: true }, ...joinArgs });
        });
        const hasManyJoin = hasMany.find((q) => / join /.test(q));
        assert.ok(hasManyJoin, `a native join ran: ${hasMany.join(' | ')}`);
        assert.match(hasManyJoin, /c\.tenant_id = \$\d+/);
        assert.deepEqual(orgUsers(rows as never), [
          [1, [1, 2, 3]],
          [2, []],
        ]);
        const belongsTo = await statements(pre018, async () => {
          rows = await pre018.table('posts').findMany({ with: { user: true }, ...joinArgs });
        });
        assert.ok(
          belongsTo.some((q) => / join .*c\.tenant_id = \$\d+/.test(q)),
          belongsTo.join(' | '),
        );
        assert.deepEqual(postUser(rows as never), [
          [1, 1],
          [2, 1],
          [3, 2],
          [4, null],
          [5, null],
        ]);
        // The join re-emits the parent's where on `p`, filter included.
        const parent = await statements(pre018, () =>
          pre018.table('users').findMany({ with: { posts: true }, ...joinArgs }),
        );
        assert.ok(
          parent.some((q) => / join .*p\.tenant_id = \$\d+/.test(q)),
          parent.join(' | '),
        );
      } finally {
        await pre018.disconnect();
      }

      const loader = await statements(db, () => O.findMany({ with: { users: true }, relationLoadStrategy: 'batched' }));
      assert.ok(
        loader.some((q) => /^users filter .*\.tenant_id = \$\d+/.test(q)),
        `the loader query carries the filter: ${loader.join(' | ')}`,
      );

      // A to-one whose target carries a JS-bigint column cannot ride a JSON
      // block, so with declared entity links it becomes a scalar link hop,
      // which has no filter of its own: under a global filter the relation
      // must go to the loader instead.
      const bigintSchema = structuredClone(SCHEMA);
      bigintSchema.tables.users!.columns.find((c) => c.name === 'big')!.tsType = 'bigint | null';
      const linked = async (opts: Record<string, unknown>): Promise<Db> => {
        const linkDb = await openPow(opts, bigintSchema);
        await applyPowdbLinks(async (q: string) => ({ rows: await linkDb.raw(tsa(q)) }), bigintSchema);
        return linkDb;
      };
      const unfiltered = await linked({});
      try {
        const hop = await statements(unfiltered, () => unfiltered.table('posts').findMany({ with: { user: true } }));
        assert.ok(
          hop.some((q) => /t0\.user\./.test(q)),
          `without a filter the link path is taken: ${hop.join(' | ')}`,
        );
      } finally {
        await unfiltered.disconnect();
      }
      const filteredDb = await linked(TENANT_USERS);
      try {
        const LP = filteredDb.table('posts');
        const filtered = await statements(filteredDb, () => LP.findMany({ with: { user: true } }));
        assert.ok(!filtered.some((q) => /t0\.user\./.test(q)), `no link hop under a filter: ${filtered.join(' | ')}`);
        rowsAfterLink = postUser(await LP.findMany({ with: { user: true }, ...ORDER }));
      } finally {
        await filteredDb.disconnect();
      }
      assert.deepEqual(rowsAfterLink, [
        [1, 1],
        [2, 1],
        [3, 2],
        [4, null],
        [5, null],
      ]);
    });
  });
});

describe('powdb v0.90: rows match Postgres semantics', () => {
  for (const c of MATRIX) {
    it(c.name, async () => {
      assert.deepEqual(await withDb(c.opts, c.run), c.expected);
    });
  }
});

// ---------------------------------------------------------------------------
// Writes and refusals
// ---------------------------------------------------------------------------

describe('powdb v0.90: relation filters on writes and malformed shapes', () => {
  it('deleteMany with is deletes exactly the related rows', async () => {
    await withDb({}, async (db) => {
      await db.table('post_tags').deleteMany({ where: { postId: { gt: 0 } } });
      const res = await db
        .table('posts')
        .deleteMany({ where: { rating: { gte: 0 }, user: { is: { email: 'bob@x' } } } });
      assert.deepEqual(res, { count: 1 });
      assert.deepEqual(ids(await db.table('posts').findMany(ORDER)), [1, 2, 4, 5]);
    });
  });

  it('updateMany with is under a global filter writes only the related rows', async () => {
    await withDb(TENANT_USERS, async (db) => {
      const res = await db.table('users').updateMany({ where: { org: { is: { name: 'Acme' } } }, data: { score: 0 } });
      assert.deepEqual(res, { count: 3 });
      const zero = await db.table('users').findMany({ where: { score: 0 }, skipGlobalFilters: UNSAFE, ...ORDER });
      assert.deepEqual(ids(zero), [1, 2, 3]);
    });
  });

  it('refuses a relation filter shape it cannot honour, instead of matching every row', async () => {
    await withDb({}, async (db) => {
      const shapes: [object, RegExp][] = [
        [{ posts: { title: 'x' } }, /takes `\{ some/],
        [{ posts: {} }, /filter object is empty/],
        [{ user: { is: { email: 'bob@x' }, nope: 1 } }, /unrecognized key "nope"/],
        [{ user: 'bob@x' }, /expected an object, got string/],
        [{ user: { is: 5 } }, /`is` takes a where object/],
      ];
      for (const [where, message] of shapes) {
        const table = 'posts' in where ? 'users' : 'posts';
        await assert.rejects(
          () => db.table(table).deleteMany({ where }),
          (err: unknown) => err instanceof ValidationError && message.test(err.message),
          JSON.stringify(where),
        );
      }
      assert.equal(await db.table('posts').count(), 5, 'nothing was deleted');
    });
  });

  it(`refuses a relation filter matching more than ${MAX_RELATION_FILTER_KEYS} keys`, async () => {
    await withDb({}, async (db) => {
      const rows = Array.from({ length: MAX_RELATION_FILTER_KEYS + 1 }, (_, i) => ({ name: `org-${i}` }));
      for (let i = 0; i < rows.length; i += 1000) await db.table('orgs').createMany({ data: rows.slice(i, i + 1000) });
      // Exactly at the cap is served.
      const atCap = await db
        .table('users')
        .count({ where: { org: { is: { id: { lte: MAX_RELATION_FILTER_KEYS } } } } });
      assert.equal(atCap, 5);
      await assert.rejects(
        () => db.table('users').deleteMany({ where: { org: { is: { name: { not: 'x' } } } } }),
        (err: unknown) =>
          err instanceof UnsupportedFeatureError &&
          err.message.includes(`${MAX_RELATION_FILTER_KEYS + 3} distinct keys`) &&
          err.message.includes(`refuses lists over ${MAX_RELATION_FILTER_KEYS}`),
      );
      assert.equal(await db.table('users').count(), 5, 'nothing was deleted');
    });
  });
});

describe('powdb v0.90: a where whose every value is undefined', () => {
  it('findFirst and findFirstOrThrow refuse it instead of returning an arbitrary row', async () => {
    await withDb({}, async (db) => {
      for (const op of ['findFirst', 'findFirstOrThrow'] as const) {
        await assert.rejects(
          () => db.table('users')[op]({ where: { email: undefined } }),
          (err: unknown) =>
            err instanceof ValidationError &&
            err.message.includes(`${op} on "users" refused: every key in \`where\` was undefined`),
          op,
        );
      }
      // Written as empty, it still asks for any row.
      assert.ok(await db.table('users').findFirst({ where: {} }));
    });
  });

  it('a write refuses it as a full-table write', async () => {
    await withDb({}, async (db) => {
      await assert.rejects(
        () => db.table('posts').deleteMany({ where: { user: { is: { email: undefined } } } }),
        (err: unknown) => err instanceof ValidationError && /allowFullTableScan/.test(err.message),
      );
      await assert.rejects(
        () => db.table('users').updateMany({ where: { email: undefined }, data: { score: 0 } }),
        (err: unknown) => err instanceof ValidationError && /allowFullTableScan/.test(err.message),
      );
      assert.equal(await db.table('posts').count(), 5);
      assert.equal(await db.table('users').count({ where: { score: 0 } }), 0);
    });
  });
});

describe('powdb v0.90: shared option refusals', () => {
  it('optimisticLock on upsert and updateMany is refused, as on the SQL engines', async () => {
    await withDb({}, async (db) => {
      const lock = { field: 'score', expected: 1 };
      await assert.rejects(
        () => db.table('users').updateMany({ where: { id: 1 }, data: { email: 'z@x' }, optimisticLock: lock } as never),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.includes('`optimisticLock` is an `update` option and updateMany on "users" does not apply it'),
      );
      await assert.rejects(
        () =>
          db.table('users').upsert({
            where: { id: 1 },
            create: { orgId: 1, email: 'z@x' },
            update: { email: 'z@x' },
            optimisticLock: lock,
          } as never),
        (err: unknown) =>
          err instanceof ValidationError &&
          err.message.includes('`optimisticLock` is an `update` option and upsert on "users" does not apply it'),
      );
      assert.equal(await db.table('users').count({ where: { email: 'z@x' } }), 0);
    });
  });

  it('skip on a to-one relation inside with is refused', async () => {
    await withDb({}, async (db) => {
      await assert.rejects(
        () => db.table('posts').findMany({ with: { user: { skip: 1 } } } as never),
        (err: unknown) =>
          err instanceof ValidationError && /to-one relation "user" of "posts" has nothing to skip/.test(err.message),
      );
    });
  });
});

describe('powdb v0.90: literal string matching', () => {
  it('refuses contains with a wildcard character instead of matching other rows', async () => {
    await withDb({}, async (db) => {
      for (const value of ['%', '_', '50%', 'off_now']) {
        await assert.rejects(
          () => db.table('posts').findMany({ where: { title: { contains: value } } }),
          (err: unknown) => err instanceof UnsupportedFeatureError && /no escape character/.test(err.message),
          value,
        );
      }
      await assert.rejects(
        () => db.table('posts').deleteMany({ where: { meta: { path: ['t'], stringContains: '%' } } }),
        UnsupportedFeatureError,
      );
    });
  });
});

describe('powdb v0.90: numeric columns', () => {
  it('round-trips the stored text exactly', async () => {
    await withDb({}, async (db) => {
      const rows = await db.table('users').findMany({ select: { balance: true }, ...ORDER });
      assert.deepEqual(
        rows.map((r: { balance: string | null }) => r.balance),
        ['12.34', '7.5', '7.50', '100', null],
      );
      assert.deepEqual(ids(await db.table('users').findMany({ where: { balance: null }, ...ORDER })), [5]);
    });
  });

  it('refuses every comparison, ordering, aggregate and arithmetic the engine would do as text', async () => {
    await withDb({}, async (db) => {
      const U = db.table('users');
      const refusals: [string, () => Promise<unknown>][] = [
        ['gt', () => U.findMany({ where: { balance: { gt: '7.5' } } })],
        ['equality', () => U.findMany({ where: { balance: '7.5' } })],
        ['in', () => U.findMany({ where: { balance: { in: ['7.5'] } } })],
        ['orderBy', () => U.findMany({ orderBy: { balance: 'desc' } })],
        ['_max', () => U.aggregate({ _max: { balance: true } })],
        ['_sum', () => U.aggregate({ _sum: { balance: true } })],
        ['groupBy key', () => U.groupBy({ by: ['balance'] })],
        ['groupBy _avg', () => U.groupBy({ by: ['orgId'], _avg: { balance: true } })],
        ['increment', () => U.update({ where: { id: 1 }, data: { balance: { increment: 1 } } })],
      ];
      for (const [name, run] of refusals) {
        await assert.rejects(
          run,
          (err: unknown) => err instanceof UnsupportedFeatureError && /numeric column "balance"/.test(err.message),
          name,
        );
      }
      const after = await U.findUnique({ where: { id: 1 } });
      assert.equal(after.balance, '12.34', 'the refused increment wrote nothing');
    });
  });

  it('an atomic operator takes a finite number, as on the SQL engines', async () => {
    await withDb({}, async (db) => {
      await assert.rejects(
        () => db.table('users').update({ where: { id: 1 }, data: { score: { increment: '1' } } }),
        /update operator "increment" on "users.score" requires a finite number, got string/,
      );
      const row = await db.table('users').update({ where: { id: 1 }, data: { score: { increment: 1 } } });
      assert.equal(row.score, 11);
    });
  });
});

describe('powdb v0.90: column defaults', () => {
  it('applies declared defaults to omitted columns and keeps an explicit null', async () => {
    await withDb({}, async (db) => {
      const before = Date.now();
      const u = await db.table('users').create({ data: { orgId: 1, email: 'new@x' } });
      assert.equal(u.role, 'member');
      assert.equal(u.tenantId, 1);
      assert.equal(u.active, true);
      const n = await db.table('users').create({ data: { orgId: 1, email: 'null@x', role: null } });
      assert.equal(n.role, null);
      const p = await db.table('posts').create({ data: { title: 'fresh' } });
      assert.ok(p.createdAt instanceof Date && p.createdAt.getTime() >= before - 1000, 'now() is the insert time');
      const many = await db.table('tags').createMany({ data: [{ label: 'a' }, { label: 'b' }] });
      assert.deepEqual(
        many.map((t: { tenantId: number }) => t.tenantId),
        [1, 1],
      );
      const up = await db
        .table('tags')
        .upsert({ where: { id: 99 }, create: { id: 99, label: 'u' }, update: { label: 'v' } });
      assert.equal(up.tenantId, 1);
    });
  });

  it('refuses rather than writing NULL when the metadata does not carry the default', async () => {
    const bare = schemaDefToMetadata(def);
    const db = await openPow({}, bare);
    try {
      await assert.rejects(
        () => db.table('users').create({ data: { orgId: 1, email: 'x@x' } }),
        (err: unknown) => err instanceof UnsupportedFeatureError && /default of column "tenant_id"/.test(err.message),
      );
      assert.equal(await db.table('users').count({ where: { email: 'x@x' } }), 0);
      const supplied = await db.table('users').create({
        data: { orgId: 1, email: 'y@x', tenantId: 3, role: 'r', active: false },
      });
      assert.equal(supplied.tenantId, 3);
    } finally {
      await db.disconnect();
    }
  });
});

describe('powdb v0.90: statements outside an open transaction', () => {
  it('a write outside the transaction waits for it and survives its rollback', async () => {
    await withDb({}, async (db) => {
      let release!: () => void;
      const hold = new Promise<void>((r) => {
        release = r;
      });
      let entered!: () => void;
      const inside = new Promise<void>((r) => {
        entered = r;
      });
      const tx = db
        .$transaction(async (t: Db) => {
          await t.table('tags').create({ data: { label: 'in-tx' } });
          entered();
          await hold;
          throw new Error('roll back');
        })
        .catch((e: Error) => e.message);
      await inside;
      const outsideWrite = db.table('tags').create({ data: { label: 'outside' } });
      const outsideRead = db.table('tags').count({ where: { label: 'in-tx' } });
      release();
      assert.equal(await tx, 'roll back');
      await outsideWrite;
      assert.equal(await outsideRead, 0, 'no read of the uncommitted row');
      const labels = (await db.table('tags').findMany(ORDER)).map((t: { label: string }) => t.label);
      assert.deepEqual(labels, ['ts', 'pg', 'secret', 'outside']);
    });
  });

  it('a call through the client from inside its own transaction callback is refused, not absorbed', async () => {
    await withDb({}, async (db) => {
      await assert.rejects(
        () =>
          db.$transaction(async () => {
            await db.table('tags').create({ data: { label: 'wrong client' } });
          }),
        (err: unknown) => err instanceof UnsupportedFeatureError && /Use the `tx` client/.test(err.message),
      );
      assert.equal(await db.table('tags').count({ where: { label: 'wrong client' } }), 0);
    });
  });
});

// ---------------------------------------------------------------------------
// Postgres oracle: the same matrix, diffed engine against engine
// ---------------------------------------------------------------------------

const PG_URL = process.env.DATABASE_URL;
const oracle = skipGate(!PG_URL || !embeddedAvailable, 'requires DATABASE_URL and @zvndev/powdb-embedded');
const ORACLE_SCHEMA = 'turbine_powdb_v090_oracle';

function oracleUrl(): string {
  const url = new URL(PG_URL!);
  url.searchParams.set('options', `-c search_path=${ORACLE_SCHEMA}`);
  return url.toString();
}

describe('powdb v0.90: Postgres oracle', () => {
  oracle.before(async () => {
    const admin = new TurbineClient({ connectionString: PG_URL!, warnOnUnlimited: false } as never, SCHEMA);
    await admin.raw(tsa(`DROP SCHEMA IF EXISTS "${ORACLE_SCHEMA}" CASCADE`));
    await admin.raw(tsa(`CREATE SCHEMA "${ORACLE_SCHEMA}"`));
    await admin.disconnect();
    const boot = new TurbineClient({ connectionString: oracleUrl(), warnOnUnlimited: false } as never, SCHEMA);
    for (const stmt of schemaToSQL(def)) await boot.raw(tsa(stmt));
    await seed(boot);
    await boot.disconnect();
  });
  oracle.after(async () => {
    const admin = new TurbineClient({ connectionString: PG_URL!, warnOnUnlimited: false } as never, SCHEMA);
    await admin.raw(tsa(`DROP SCHEMA IF EXISTS "${ORACLE_SCHEMA}" CASCADE`));
    await admin.disconnect();
  });

  for (const c of MATRIX) {
    // Postgres has no min(boolean) and returns bigint aggregates as strings,
    // so the aggregate case is compared on the columns both engines type alike.
    oracle.it(c.name, async () => {
      const pg = new TurbineClient(
        { connectionString: oracleUrl(), warnOnUnlimited: false, ...c.opts } as never,
        SCHEMA,
      );
      try {
        const want = await c.run(pg);
        const got = await withDb(c.opts, c.run);
        assert.deepEqual(normalizeForOracle(got), normalizeForOracle(want));
      } finally {
        await pg.disconnect();
      }
    });
  }
});

/** Bigints compare by digits: Postgres hands int8 aggregates back as strings. */
function normalizeForOracle(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}
