/**
 * PowDB answers like Postgres, or refuses like Postgres, on six shapes:
 *
 *   - the batched relation loader when the parent `select` / `omit` leaves out
 *     the key it correlates on;
 *   - nested `set` (the nested-write engine's internal `updateMany`);
 *   - a global filter that holds a relation filter, at every entry point;
 *   - an `OR` with a branch that has no condition (constant TRUE), its `NOT`,
 *     and the mass-mutation guard;
 *   - Date, JSON-document, cursor, upsert and int8 operands.
 *
 * Every test runs the real in-process `@zvndev/powdb-embedded` engine on a
 * schema built through `defineSchema` / `powqlSchemaDDL`. The oracle suite at
 * the end runs the same cases on Postgres (gated on DATABASE_URL) and diffs the
 * two engines, so the expected values are Postgres's, not PowDB's own.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { NotFoundError, UniqueConstraintError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { UNSAFE } from '../query/index.js';
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

// biome-ignore lint/suspicious/noExplicitAny: the cases drive many arg shapes through untyped table accessors
type Db = any;

const def: SchemaDef = defineSchema({
  orgs: { id: { type: 'integer', primaryKey: true }, name: { type: 'text', notNull: true } },
  users: {
    id: { type: 'integer', primaryKey: true },
    orgId: { type: 'integer', notNull: true, references: 'orgs.id' },
    name: { type: 'text', notNull: true },
    age: { type: 'integer' },
    deletedAt: { type: 'timestamptz' },
  },
  posts: {
    id: { type: 'integer', primaryKey: true },
    userId: { type: 'integer', references: 'users.id' },
    orgId: { type: 'integer', notNull: true, references: 'orgs.id' },
    title: { type: 'text', notNull: true },
    meta: { type: 'jsonb' },
    score: { type: 'integer' },
  },
  tags: {
    id: { type: 'integer', primaryKey: true },
    orgId: { type: 'integer', notNull: true },
    name: { type: 'text', notNull: true },
  },
  postTags: {
    postId: { type: 'integer', notNull: true, references: 'posts.id' },
    tagId: { type: 'integer', notNull: true, references: 'tags.id' },
    primaryKey: ['postId', 'tagId'],
  },
  items: {
    id: { type: 'integer', primaryKey: true },
    n: { type: 'integer', notNull: true, default: '0' },
    big: { type: 'bigint', default: '9007199254740993' },
  },
} as never);
const SCHEMA: SchemaMetadata = schemaDefToMetadata(def);

async function seed(db: Db): Promise<void> {
  await db.table('orgs').createMany({
    data: [
      { id: 1, name: 'o1' },
      { id: 2, name: 'o2' },
    ],
  });
  await db.table('users').createMany({
    data: [
      { id: 1, orgId: 1, name: 'a1', age: 30, deletedAt: null },
      { id: 2, orgId: 1, name: 'a2', age: null, deletedAt: null },
      { id: 3, orgId: 2, name: 'b1', age: 40, deletedAt: null },
      { id: 4, orgId: 2, name: 'b2', age: 50, deletedAt: null },
      { id: 5, orgId: 1, name: 'a3', age: 20, deletedAt: new Date('2026-01-01T00:00:00Z') },
    ],
  });
  await db.table('posts').createMany({
    data: [
      { id: 1, userId: 1, orgId: 1, title: 'p1', meta: { a: 1 }, score: 1 },
      { id: 2, userId: 1, orgId: 1, title: 'p2', meta: { a: 2 }, score: 2 },
      { id: 3, userId: 3, orgId: 2, title: 'p3', meta: { a: 1 }, score: 3 },
      { id: 4, userId: 1, orgId: 2, title: 'p4', meta: null, score: 4 },
      { id: 5, userId: 3, orgId: 1, title: 'p5', meta: { b: 1 }, score: null },
      { id: 6, userId: null, orgId: 1, title: 'p6', meta: null, score: 6 },
    ],
  });
  await db.table('tags').createMany({
    data: [
      { id: 1, orgId: 1, name: 't1' },
      { id: 2, orgId: 2, name: 't2' },
    ],
  });
  await db.table('post_tags').createMany({
    data: [
      { postId: 1, tagId: 1 },
      { postId: 1, tagId: 2 },
      { postId: 3, tagId: 2 },
    ],
  });
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function openPow(opts: Record<string, unknown> = {}): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-fx-powdb-'));
  dirs.push(dir);
  const boot = await turbinePowDB({ embedded: dir }, SCHEMA, { warnOnUnlimited: false });
  for (const stmt of powqlSchemaDDL(SCHEMA)) await boot.rawUnsafe(stmt);
  await seed(boot);
  await boot.disconnect();
  return turbinePowDB({ embedded: dir }, SCHEMA, { warnOnUnlimited: false, ...opts });
}

async function withDb<R>(opts: Record<string, unknown>, fn: (db: Db) => Promise<R>): Promise<R> {
  const db = await openPow(opts);
  try {
    return await fn(db);
  } finally {
    await db.disconnect();
  }
}

/** Run `fn` in a transaction that always rolls back, returning what it produced. */
const SENTINEL = new Error('roll back');
function rolledBack(fn: (tx: Db) => Promise<unknown>): (db: Db) => Promise<unknown> {
  return async (db) => {
    let out: unknown;
    try {
      await db.$transaction(async (tx: Db) => {
        out = await fn(tx);
        throw SENTINEL;
      });
    } catch (err) {
      const e = err as { message?: string; cause?: { message?: string } };
      if (err !== SENTINEL && e.message !== SENTINEL.message && e.cause?.message !== SENTINEL.message) throw err;
    }
    return out;
  };
}

const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id);
const ORDER = { orderBy: { id: 'asc' } };
const allPosts = (db: Db) =>
  db.table('posts').findMany({ ...ORDER, select: { id: true, userId: true, title: true }, skipGlobalFilters: UNSAFE });

// ---------------------------------------------------------------------------
// The shared matrix: asserted on PowDB here, diffed against Postgres below
// ---------------------------------------------------------------------------

type Case = { name: string; opts: Record<string, unknown>; run: (db: Db) => Promise<unknown>; expected: unknown };

const USER_OF_POST = [
  { id: 1, user: { id: 1, name: 'a1' } },
  { id: 2, user: { id: 1, name: 'a1' } },
  { id: 3, user: { id: 3, name: 'b1' } },
  { id: 4, user: { id: 1, name: 'a1' } },
  { id: 5, user: { id: 3, name: 'b1' } },
  { id: 6, user: null },
];

const REL_GF = { globalFilters: { users: { posts: { some: { orgId: 1 } } } } };
const PARENT_GF = { globalFilters: { posts: { user: { is: { orgId: 1 } } } } };
const PARENT_FN_GF = { globalFilters: { posts: () => ({ user: { isNot: { orgId: 2 } } }) } };
const M2M_GF = { globalFilters: { posts: { tags: { some: { orgId: 1 } } } } };

const MATRIX: Case[] = [
  // P0-5: the parent's correlation key is fetched for the loader and stripped after.
  ...(['batched', 'join'] as const).flatMap((strategy): Case[] => [
    {
      name: `belongsTo with a select that leaves out the foreign key (${strategy})`,
      opts: {},
      run: (db) =>
        db.table('posts').findMany({
          relationLoadStrategy: strategy,
          ...ORDER,
          select: { id: true },
          with: { user: { select: { id: true, name: true } } },
        }),
      expected: USER_OF_POST,
    },
    {
      name: `belongsTo with an omit of the foreign key (${strategy})`,
      opts: {},
      run: async (db) =>
        (
          await db.table('posts').findMany({
            relationLoadStrategy: strategy,
            ...ORDER,
            omit: { userId: true, meta: true, title: true, score: true, orgId: true },
            with: { user: { select: { id: true, name: true } } },
          })
        ).map((p: { id: number; user: unknown }) => ({ ...p })),
      expected: USER_OF_POST,
    },
  ]),
  {
    name: 'belongsTo with a select that leaves out the foreign key (client-level batched)',
    opts: { relationLoadStrategy: 'batched' },
    run: (db) =>
      db
        .table('posts')
        .findMany({ ...ORDER, select: { id: true }, with: { user: { select: { id: true, name: true } } } }),
    expected: USER_OF_POST,
  },
  {
    name: 'belongsTo two levels deep, each level leaving out its key (batched)',
    opts: {},
    run: (db) =>
      db.table('posts').findMany({
        relationLoadStrategy: 'batched',
        where: { id: { in: [1, 3, 6] } },
        ...ORDER,
        select: { title: true },
        with: { user: { select: { name: true }, with: { org: { select: { name: true } } } } },
      }),
    expected: [
      { title: 'p1', user: { name: 'a1', org: { name: 'o1' } } },
      { title: 'p3', user: { name: 'b1', org: { name: 'o2' } } },
      { title: 'p6', user: null },
    ],
  },
  {
    name: 'findUnique and findFirst with a select that leaves out the foreign key (batched)',
    opts: {},
    run: async (db) => [
      await db
        .table('posts')
        .findUnique({ relationLoadStrategy: 'batched', where: { id: 3 }, select: { id: true }, with: { user: true } }),
      await db.table('posts').findFirst({
        relationLoadStrategy: 'batched',
        where: { id: 2 },
        select: { title: true },
        with: { user: { select: { id: true } } },
      }),
    ],
    expected: [
      { id: 3, user: { id: 3, orgId: 2, name: 'b1', age: 40, deletedAt: null } },
      { title: 'p2', user: { id: 1 } },
    ],
  },
  {
    name: 'a hasMany, a manyToMany and a _count with a select that leaves out the parent key (batched)',
    opts: {},
    run: (db) =>
      db.table('posts').findMany({
        relationLoadStrategy: 'batched',
        where: { id: { in: [1, 3] } },
        ...ORDER,
        select: { title: true },
        with: { tags: { select: { name: true }, ...ORDER }, _count: { tags: true } },
      }),
    expected: [
      { title: 'p1', tags: [{ name: 't1' }, { name: 't2' }], _count: { tags: 2 } },
      { title: 'p3', tags: [{ name: 't2' }], _count: { tags: 1 } },
    ],
  },

  // P1-11: nested `set` on every relation shape the engine supports.
  {
    name: 'nested set replaces the children',
    opts: {},
    run: async (db) => {
      await db.table('users').update({ where: { id: 2 }, data: { posts: { set: [{ id: 2 }] } } });
      return allPosts(db);
    },
    expected: [
      { id: 1, userId: 1, title: 'p1' },
      { id: 2, userId: 2, title: 'p2' },
      { id: 3, userId: 3, title: 'p3' },
      { id: 4, userId: 1, title: 'p4' },
      { id: 5, userId: 3, title: 'p5' },
      { id: 6, userId: null, title: 'p6' },
    ],
  },
  {
    name: 'nested set [] clears the children, inside $transaction',
    opts: {},
    run: async (db) => {
      await db.$transaction(async (tx: Db) => {
        await tx.table('users').update({ where: { id: 1 }, data: { posts: { set: [] } } });
      });
      return allPosts(db);
    },
    expected: [
      { id: 1, userId: null, title: 'p1' },
      { id: 2, userId: null, title: 'p2' },
      { id: 3, userId: 3, title: 'p3' },
      { id: 4, userId: null, title: 'p4' },
      { id: 5, userId: 3, title: 'p5' },
      { id: 6, userId: null, title: 'p6' },
    ],
  },

  // P1-12: a global filter holding a relation filter, at every entry point.
  ...(
    [
      ['some', REL_GF],
      ['is', PARENT_GF],
      ['isNot, function form', PARENT_FN_GF],
      ['manyToMany some', M2M_GF],
    ] as const
  ).flatMap(([label, opts]): Case[] => [
    {
      name: `global relation filter (${label}): reads`,
      opts,
      run: async (db) => ({
        users: ids(await db.table('users').findMany({ ...ORDER, select: { id: true } })),
        posts: ids(await db.table('posts').findMany({ ...ORDER, select: { id: true } })),
        userCount: await db.table('users').count(),
        postCount: await db.table('posts').count({ where: { score: { gt: 0 } } }),
        first: (await db.table('posts').findFirst({ ...ORDER, select: { id: true } }))?.id ?? null,
      }),
      expected: {
        some: { users: [1, 3], posts: [1, 2, 3, 4, 5, 6], userCount: 2, postCount: 5, first: 1 },
        is: { users: [1, 2, 3, 4, 5], posts: [1, 2, 4], userCount: 5, postCount: 3, first: 1 },
        'isNot, function form': { users: [1, 2, 3, 4, 5], posts: [1, 2, 4, 6], userCount: 5, postCount: 4, first: 1 },
        'manyToMany some': { users: [1, 2, 3, 4, 5], posts: [1], userCount: 5, postCount: 1, first: 1 },
      }[label],
    },
    {
      name: `global relation filter (${label}): aggregate and groupBy`,
      opts,
      run: async (db) => ({
        agg: await db.table('posts').aggregate({ _count: true, _sum: { score: true } }),
        groups: await db.table('posts').groupBy({ by: ['orgId'], _count: true, orderBy: { orgId: 'asc' } }),
      }),
      expected: {
        some: {
          agg: { _count: 6, _sum: { score: 16 } },
          groups: [
            { orgId: 1, _count: 4 },
            { orgId: 2, _count: 2 },
          ],
        },
        is: {
          agg: { _count: 3, _sum: { score: 7 } },
          groups: [
            { orgId: 1, _count: 2 },
            { orgId: 2, _count: 1 },
          ],
        },
        'isNot, function form': {
          agg: { _count: 4, _sum: { score: 13 } },
          groups: [
            { orgId: 1, _count: 3 },
            { orgId: 2, _count: 1 },
          ],
        },
        'manyToMany some': { agg: { _count: 1, _sum: { score: 1 } }, groups: [{ orgId: 1, _count: 1 }] },
      }[label],
    },
    ...(['default', 'batched', 'join'] as const).map(
      (strategy): Case => ({
        name: `global relation filter (${label}): relation loads (${strategy})`,
        opts,
        run: async (db) =>
          (
            await db.table('users').findMany({
              ...(strategy === 'default' ? {} : { relationLoadStrategy: strategy }),
              ...ORDER,
              where: { id: { in: [1, 3] } },
              select: { id: true },
              with: { posts: { select: { id: true }, ...ORDER } },
            })
          ).map((u: { id: number; posts: { id: number }[] }) => [u.id, ids(u.posts)]),
        expected: {
          some: [
            [1, [1, 2, 4]],
            [3, [3, 5]],
          ],
          is: [
            [1, [1, 2, 4]],
            [3, []],
          ],
          'isNot, function form': [
            [1, [1, 2, 4]],
            [3, []],
          ],
          'manyToMany some': [
            [1, [1]],
            [3, []],
          ],
        }[label],
      }),
    ),
    {
      name: `global relation filter (${label}): updateMany and deleteMany`,
      opts,
      run: async (db) => ({
        updated: await rolledBack((tx) =>
          tx.table('posts').updateMany({ where: { score: { gt: 0 } }, data: { title: 'X' } }),
        )(db),
        deleted: await rolledBack((tx) =>
          tx.table('posts').deleteMany({ where: { title: { startsWith: 'p' }, tags: { none: {} } } }),
        )(db),
      }),
      expected: {
        some: { updated: { count: 5 }, deleted: { count: 4 } },
        is: { updated: { count: 3 }, deleted: { count: 2 } },
        'isNot, function form': { updated: { count: 4 }, deleted: { count: 3 } },
        'manyToMany some': { updated: { count: 1 }, deleted: { count: 0 } },
      }[label],
    },
  ]),

  {
    // Function filters are read per query: each table's filter applies once per chain.
    name: 'global relation filters that reach each other (function form) apply once per chain',
    opts: {
      globalFilters: {
        users: () => ({ posts: { some: { orgId: 1 } } }),
        posts: () => ({ user: { is: { orgId: 1 } } }),
      },
    },
    run: async (db) => ({
      users: ids(await db.table('users').findMany({ ...ORDER, select: { id: true } })),
      posts: ids(await db.table('posts').findMany({ ...ORDER, select: { id: true } })),
      counts: [await db.table('users').count(), await db.table('posts').count()],
    }),
    expected: { users: [1], posts: [1, 2, 4], counts: [1, 3] },
  },

  // P0-3: an `OR` with a branch that has no condition is constant TRUE.
  ...(
    [
      ['OR: [{}, { id: 1 }]', { OR: [{}, { id: 1 }] }, [1, 2, 3, 4, 5]],
      ['OR: [{}]', { OR: [{}] }, [1, 2, 3, 4, 5]],
      ['OR: [{ NOT: {} }, { id: 1 }]', { OR: [{ NOT: {} }, { id: 1 }] }, [1, 2, 3, 4, 5]],
      ['OR: [{ AND: [] }, { id: 1 }]', { OR: [{ AND: [] }, { id: 1 }] }, [1, 2, 3, 4, 5]],
      ['NOT: { OR: [{}, { id: 1 }] }', { NOT: { OR: [{}, { id: 1 }] } }, []],
      ['NOT: { OR: [{}] }', { NOT: { OR: [{}] } }, []],
      ['AND: [{ OR: [{}, { id: 1 }] }, { id: 2 }]', { AND: [{ OR: [{}, { id: 1 }] }, { id: 2 }] }, [2]],
      ['posts every OR [{}, x]', { posts: { every: { OR: [{}, { id: 1 }] } } }, [1, 2, 3, 4, 5]],
      ['posts none OR [{}, x]', { posts: { none: { OR: [{}, { id: 1 }] } } }, [2, 4, 5]],
      ['posts some NOT OR [{}, x]', { posts: { some: { NOT: { OR: [{}, { id: 1 }] } } } }, []],
    ] as const
  ).map(
    ([label, where, expected]): Case => ({
      name: `constant TRUE OR: findMany ${label}`,
      opts: {},
      run: async (db) => ids(await db.table('users').findMany({ where, ...ORDER, select: { id: true } })),
      expected,
    }),
  ),
  {
    name: 'constant TRUE OR: NOT of it deletes nothing',
    opts: {},
    run: rolledBack(async (tx) => tx.table('posts').deleteMany({ where: { NOT: { OR: [{ id: -1 }, {}] } } })),
    expected: { count: 0 },
  },
  {
    name: 'constant TRUE OR inside a relation where',
    opts: {},
    run: async (db) =>
      (
        await db.table('users').findMany({
          where: { id: 1 },
          select: { id: true },
          with: { posts: { where: { NOT: { OR: [{}, { id: 1 }] } }, select: { id: true } } },
        })
      ).map((u: { id: number; posts: { id: number }[] }) => [u.id, ids(u.posts)]),
    expected: [[1, []]],
  },

  // P2: an upsert onto a key the global filter hides writes nothing (E001).
  {
    name: 'upsert onto a key the global filter hides',
    opts: { globalFilters: { users: { orgId: 1 } } },
    run: async (db) => {
      const err = await db
        .table('users')
        .upsert({ where: { id: 3 }, create: { id: 3, orgId: 1, name: 'new' }, update: { name: 'HACK' } })
        .then(
          () => null,
          (e: Error) => e,
        );
      return { error: err?.constructor.name, message: err?.message, hidden: (await allUsers(db))[2] };
    },
    expected: {
      error: 'NotFoundError',
      message:
        '[TURBINE_E001] upsert on "users" wrote nothing: the row that conflicts on the given key is excluded by the ' +
        'configured global filter for "users", so it was neither updated (the filter hides it) nor inserted (the ' +
        'key is taken). Pass `skipGlobalFilters: UNSAFE` to address it anyway. (https://turbineorm.dev/errors#e001)',
      hidden: { id: 3, name: 'b1' },
    },
  },

  // P2: integer text and int8 precision.
  {
    name: 'int8 default past 2^53 and integer text on integer columns',
    opts: {},
    run: async (db) => {
      const items = db.table('items');
      const created = await items.create({ data: { id: 1 } });
      await items.create({ data: { id: 2, big: '-9007199254740995', n: '7' } });
      return {
        defaulted: created.big,
        byText: ids(await items.findMany({ where: { big: '9007199254740993' }, select: { id: true } })),
        written: await items.findUnique({ where: { id: 2 }, select: { big: true, n: true } }),
        greater: await items.count({ where: { big: { gt: '9007199254740992' } } }),
      };
    },
    expected: { defaulted: '9007199254740993', byText: [1], written: { big: '-9007199254740995', n: 7 }, greater: 1 },
  },
];

const allUsers = (db: Db) =>
  db.table('users').findMany({ ...ORDER, select: { id: true, name: true }, skipGlobalFilters: UNSAFE });

/** Bigints compare by digits: Postgres hands int8 values past 2^53 back as strings. */
function normalize(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

/** Aggregate keys come back in a different order per engine; compare them as sets. */
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, x]) => [k, sortKeys(x)]),
  );
}

describe('PowDB: the shared matrix', () => {
  for (const c of MATRIX) {
    it(c.name, async () => {
      const got = await withDb(c.opts, c.run);
      assert.deepEqual(sortKeys(normalize(got)), sortKeys(normalize(c.expected)));
    });
  }
});

describe('PowDB: refusals', () => {
  it('a stripped correlation key never appears in the row (key order and keys exactly as written)', async () => {
    const rows = await withDb({}, (db) =>
      db
        .table('posts')
        .findMany({ relationLoadStrategy: 'batched', ...ORDER, select: { id: true }, with: { user: true } }),
    );
    for (const row of rows as Record<string, unknown>[]) assert.deepEqual(Object.keys(row), ['id', 'user']);
  });

  it('a mutation whose where folds to TRUE through an OR branch with no condition is refused', async () => {
    await withDb({}, async (db) => {
      for (const where of [
        { OR: [{ id: 1 }, {}] },
        { OR: [{}] },
        { AND: [{ OR: [{}, { id: 1 }] }] },
        { posts: { every: { OR: [{}, { id: 1 }] } } },
      ]) {
        for (const op of ['deleteMany', 'updateMany'] as const) {
          await assert.rejects(
            () => db.table('users')[op]({ where, ...(op === 'updateMany' ? { data: { name: 'Z' } } : {}) }),
            (err: unknown) => err instanceof ValidationError && /empty or always true/.test(err.message),
            `${op} ${JSON.stringify(where)}`,
          );
        }
      }
      assert.equal(await db.table('users').count(), 5);
      // The explicit opt-in still writes every row.
      const res = await rolledBack((tx) =>
        tx.table('users').updateMany({ where: { OR: [{}] }, data: { name: 'Z' }, allowFullTableScan: UNSAFE }),
      )(db);
      assert.deepEqual(res, { count: 5 });
    });
  });

  it('static global filters that reach each other through relations are refused at construction', async () => {
    await assert.rejects(
      () =>
        openPow({ globalFilters: { users: { posts: { some: { orgId: 1 } } }, posts: { user: { is: { orgId: 1 } } } } }),
      (err: unknown) => err instanceof ValidationError && /would apply each other without end/.test(err.message),
    );
  });

  it('a number, bigint or boolean compared with or written to a Date column is E003', async () => {
    await withDb({}, async (db) => {
      const users = db.table('users');
      for (const where of [
        { deletedAt: 1767225600000 },
        { deletedAt: { not: 1767225600000 } },
        { deletedAt: { gt: 1 } },
        { deletedAt: { in: [1767225600000] } },
        { NOT: { deletedAt: 1767225600000 } },
        { deletedAt: 1767225600000000n },
        { deletedAt: true },
      ]) {
        await assert.rejects(
          () => users.findMany({ where }),
          (err: unknown) =>
            err instanceof ValidationError &&
            /Invalid value for the Date column "deleted_at" on "users": expected a Date or ISO 8601 text/.test(
              err.message,
            ),
          JSON.stringify(where, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)),
        );
      }
      await assert.rejects(
        () => users.update({ where: { id: 1 }, data: { deletedAt: 1767225600000 } }),
        (err: unknown) => err instanceof ValidationError && /Date column "deleted_at"/.test(err.message),
      );
      // A Date and ISO text still work.
      assert.deepEqual(ids(await users.findMany({ where: { deletedAt: new Date('2026-01-01T00:00:00Z') } })), [5]);
      assert.deepEqual(ids(await users.findMany({ where: { deletedAt: '2026-01-01T00:00:00Z' } })), [5]);
    });
  });

  it('a whole JSON document in a where is E017, in every spelling', async () => {
    await withDb({}, async (db) => {
      for (const where of [
        { meta: { a: 1 } },
        { meta: { equals: { a: 1 } } },
        { meta: { not: { a: 1 } } },
        { NOT: { meta: { a: 1 } } },
        { meta: [1] },
      ]) {
        await assert.rejects(
          () => db.table('posts').findMany({ where }),
          (err: unknown) => err instanceof UnsupportedFeatureError && /JSON document equality/.test(err.message),
          JSON.stringify(where),
        );
      }
    });
  });

  it('integer text that is not an integer is E003 on an integer column', async () => {
    await withDb({}, async (db) => {
      for (const big of ['1.5', 'abc', '99999999999999999999']) {
        await assert.rejects(
          () => db.table('items').create({ data: { id: 9, big } }),
          (err: unknown) =>
            err instanceof ValidationError && /for the integer column "big" on "items"/.test(err.message),
          big,
        );
      }
    });
  });

  it('an upsert onto a hidden key whose update is empty still reports the collision (E008)', async () => {
    await withDb({ globalFilters: { users: { orgId: 1 } } }, async (db) => {
      await assert.rejects(
        () => db.table('users').upsert({ where: { id: 3 }, create: { id: 3, orgId: 1, name: 'n' }, update: {} }),
        (err: unknown) => err instanceof UniqueConstraintError,
      );
      // Not the hidden-row case: a free key inserts.
      const row = await db
        .table('users')
        .upsert({ where: { id: 9 }, create: { id: 9, orgId: 1, name: 'n' }, update: { name: 'u' } });
      assert.equal(row.id, 9);
    });
  });

  it('a cursor the SQL engines refuse is the same E003; one they serve is E017', async () => {
    // The SQL engines' message, compiled without a connection.
    const pg = new TurbineClient(
      { connectionString: 'postgresql://nobody@127.0.0.1:1/none', warnOnUnlimited: false } as never,
      SCHEMA,
    );
    const sqlMessage = (args: Record<string, unknown>): string => {
      try {
        (pg as Db).table('users').buildFindMany(args);
      } catch (err) {
        return (err as Error).message;
      }
      return 'accepted';
    };
    try {
      await withDb({}, async (db) => {
        for (const args of [
          { cursor: { name: 'a1' }, limit: 2 },
          { cursor: { name: 'a1' }, orderBy: { name: 'asc' }, limit: 2 },
          { cursor: { age: 30 }, orderBy: [{ orgId: 'desc' }, { age: 'asc' }], limit: 2 },
          { cursor: { id: 1 }, orderBy: { posts: { _count: 'desc' } }, limit: 2 },
        ]) {
          const want = sqlMessage(args);
          assert.match(want, /refused/);
          await assert.rejects(
            () => db.table('users').findMany(args),
            (err: unknown) => err instanceof ValidationError && err.message === want,
            JSON.stringify(args),
          );
        }
        for (const args of [
          { cursor: { id: 1 }, limit: 2 },
          { cursor: { id: 1 }, orderBy: { name: 'asc' }, limit: 2 },
          { cursor: { name: 'a1', id: 1 }, orderBy: { name: 'asc' }, limit: 2 },
        ]) {
          assert.equal(sqlMessage(args), 'accepted');
          await assert.rejects(
            () => db.table('users').findMany(args),
            (err: unknown) => err instanceof UnsupportedFeatureError && /cursor pagination/.test(err.message),
            JSON.stringify(args),
          );
        }
      });
    } finally {
      await pg.disconnect();
    }
  });

  it('a NotFoundError from the hidden-key upsert carries the where it was given', async () => {
    await withDb({ globalFilters: { users: { orgId: 1 } } }, async (db) => {
      const err = await db
        .table('users')
        .upsert({ where: { id: 4 }, create: { id: 4, orgId: 1, name: 'x' }, update: { name: 'y' } })
        .catch((e: unknown) => e);
      assert.ok(err instanceof NotFoundError);
      assert.deepEqual(allUsersById(await allUsers(db), 4), { id: 4, name: 'b2' });
    });
  });
});

function allUsersById(rows: { id: number; name: string }[], id: number) {
  return rows.find((r) => r.id === id);
}

// ---------------------------------------------------------------------------
// Postgres oracle: the same matrix, diffed engine against engine
// ---------------------------------------------------------------------------

const PG_URL = process.env.DATABASE_URL;
const oracle = skipGate(!PG_URL || !embeddedAvailable, 'requires DATABASE_URL and @zvndev/powdb-embedded');
const ORACLE_SCHEMA = 'turbine_fx_powdb_oracle';

function oracleUrl(): string {
  const url = new URL(PG_URL!);
  url.searchParams.set('options', `-c search_path=${ORACLE_SCHEMA}`);
  return url.toString();
}

async function resetOracle(): Promise<void> {
  const admin = new TurbineClient({ connectionString: PG_URL!, warnOnUnlimited: false } as never, SCHEMA);
  await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${ORACLE_SCHEMA}" CASCADE`);
  await admin.rawUnsafe(`CREATE SCHEMA "${ORACLE_SCHEMA}"`);
  await admin.disconnect();
  const boot = new TurbineClient({ connectionString: oracleUrl(), warnOnUnlimited: false } as never, SCHEMA);
  for (const stmt of schemaToSQL(def)) await boot.rawUnsafe(stmt);
  await seed(boot);
  await boot.disconnect();
}

describe('PowDB against the Postgres oracle', () => {
  oracle.after(async () => {
    const admin = new TurbineClient({ connectionString: PG_URL!, warnOnUnlimited: false } as never, SCHEMA);
    await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${ORACLE_SCHEMA}" CASCADE`);
    await admin.disconnect();
  });

  for (const c of MATRIX) {
    oracle.it(c.name, async () => {
      // Several cases write, so each one gets a fresh oracle.
      await resetOracle();
      const pg = new TurbineClient(
        { connectionString: oracleUrl(), warnOnUnlimited: false, ...c.opts } as never,
        SCHEMA,
      );
      let want: unknown;
      try {
        want = await c.run(pg);
      } finally {
        await pg.disconnect();
      }
      const got = await withDb(c.opts, c.run);
      assert.deepEqual(sortKeys(normalize(got)), sortKeys(normalize(want)));
    });
  }
});
