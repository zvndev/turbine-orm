/**
 * The cross-engine battery's scenario list. One entry per question; every
 * engine answers every entry, and Postgres's answer is the expected one.
 *
 * A read scenario runs against the shared seeded state. A write scenario runs
 * against a fresh seed and is compared on both its return value and the final
 * contents of the tables it names in `state`, read back through an UNFILTERED
 * client (so a write that escaped a global filter is visible).
 *
 * Ids are stable: the allowlist keys on them. Keep them `area/what`.
 */

import { UNSAFE } from '../../../query/index.js';
import type { ClientConfig, Db } from './harness.js';

export type TableName = 'oe_orgs' | 'oe_users' | 'oe_profiles' | 'oe_posts' | 'oe_comments';

export interface Scenario {
  id: string;
  kind: 'read' | 'write';
  /** A dedicated client built with this config (global filters, strategies). */
  config?: ClientConfig;
  run(db: Db): Promise<unknown>;
  /** Write scenarios: tables whose final rows are compared too. */
  state?: readonly TableName[];
}

const U = 'oe_users';
const P = 'oe_posts';
const C = 'oe_comments';
const O = 'oe_orgs';
const PR = 'oe_profiles';

const byId = { orderBy: { id: 'asc' } } as const;
const users = (db: Db, args: Record<string, unknown> = {}) => db.table(U).findMany({ ...byId, ...args });
const posts = (db: Db, args: Record<string, unknown> = {}) => db.table(P).findMany({ ...byId, ...args });
const ids = async (rows: Promise<{ id: unknown }[]>) => (await rows).map((r) => r.id);

/** A read that returns the matching user ids, in id order. */
const userWhere = (id: string, where: Record<string, unknown>): Scenario => ({
  id,
  kind: 'read',
  run: (db) => ids(users(db, { where })),
});
const postWhere = (id: string, where: Record<string, unknown>): Scenario => ({
  id,
  kind: 'read',
  run: (db) => ids(posts(db, { where })),
});

const TENANT: ClientConfig = {
  globalFilters: { oe_users: { orgId: 1 }, oe_posts: { orgId: 1 }, oe_comments: { orgId: 1 } },
};

const SEED_READS: Scenario[] = (['oe_orgs', 'oe_users', 'oe_profiles', 'oe_posts', 'oe_comments'] as const).map(
  (table) => ({ id: `seed/${table}`, kind: 'read', run: (db: Db) => db.table(table).findMany(byId) }),
);

const WHERE_READS: Scenario[] = [
  userWhere('where/equals-text', { name: 'Alice' }),
  userWhere('where/equals-other-case', { name: 'BOB' }),
  userWhere('where/equals-unaccented', { name: 'emile' }),
  userWhere('where/not-text-nullable', { nickname: { not: 'ally' } }),
  userWhere('where/int-range', { age: { gt: 20, lte: 40 } }),
  userWhere('where/double-gte', { score: { gte: 7.25 } }),
  userWhere('where/numeric-gt', { balance: { gt: '10' } }),
  userWhere('where/numeric-equals-scale', { balance: '7.5' }),
  userWhere('where/bigint-equals-past-2^53', { big: 9007199254740993n }),
  userWhere('where/bigint-lt', { big: { lt: 2n } }),
  userWhere('where/timestamp-range', {
    createdAt: { gte: new Date('2026-01-01T00:00:00.000Z'), lt: new Date('2026-03-08T06:59:59.999Z') },
  }),
  userWhere('where/timestamp-equals-ms', { createdAt: new Date('2025-12-31T23:59:59.999Z') }),
  userWhere('where/date-equals', { birthday: new Date('2000-02-29T00:00:00.000Z') }),
  userWhere('where/date-equals-iso-string', { birthday: '2000-02-29' }),
  userWhere('where/date-lt', { birthday: { lt: new Date('1986-01-01T00:00:00.000Z') } }),
  userWhere('where/boolean', { active: false }),
  userWhere('where/uuid-equals', { token: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }),
  userWhere('where/in', { age: { in: [34, 19] } }),
  userWhere('where/not-in-nullable', { age: { notIn: [34, 19] } }),
  userWhere('where/is-null', { nickname: null }),
  userWhere('where/not-null', { nickname: { not: null } }),
  userWhere('where/contains-percent', { name: { contains: '50%' } }),
  userWhere('where/contains-underscore', { name: { contains: 'off_' } }),
  userWhere('where/contains-backslash', { name: { contains: 'k\\s' } }),
  postWhere('where/starts-with-percent', { title: { startsWith: '100%' } }),
  postWhere('where/ends-with', { title: { endsWith: '_thing' } }),
  postWhere('where/contains-case-sensitive', { title: { contains: 'hello' } }),
  userWhere('where/contains-insensitive', { name: { contains: 'ALI', mode: 'insensitive' } }),
  userWhere('where/equals-insensitive', { email: { equals: 'ALICE@EXAMPLE.COM', mode: 'insensitive' } }),
  userWhere('where/or', { OR: [{ age: { lt: 20 } }, { nickname: null }] }),
  userWhere('where/not-block', { NOT: { active: true } }),
  userWhere('where/and-nested-or', { AND: [{ orgId: 1 }, { OR: [{ score: { gt: 9 } }, { age: null }] }] }),
  userWhere('where/json-path-string', { prefs: { path: ['theme'], equals: 'dark' } }),
  postWhere('where/json-path-number', { meta: { path: ['n'], equals: 3 } }),
];

const RELATION_READS: Scenario[] = [
  userWhere('relation/some', { oePosts: { some: { published: false } } }),
  userWhere('relation/every', { oePosts: { every: { published: true } } }),
  userWhere('relation/none', { oePosts: { none: { views: { gt: 50 } } } }),
  userWhere('relation/every-nullable-child-column', { oeComments: { every: { likes: { gt: 0 } } } }),
  userWhere('relation/none-nullable-child-column', { oeComments: { none: { likes: null } } }),
  postWhere('relation/is', { oeUser: { is: { name: 'Alice' } } }),
  postWhere('relation/is-not', { oeUser: { isNot: { name: 'Alice' } } }),
  postWhere('relation/is-null', { oeUser: { is: null } }),
  postWhere('relation/bare-to-one', { oeUser: { active: false } }),
  {
    id: 'relation/is-on-nullable-fk',
    kind: 'read',
    run: (db) => ids(db.table(C).findMany({ ...byId, where: { oeUser: { is: { orgId: 1 } } } })),
  },
  {
    id: 'relation/nested-some',
    kind: 'read',
    run: (db) =>
      ids(
        db.table(O).findMany({ ...byId, where: { oeUsers: { some: { oePosts: { some: { views: { gt: 70 } } } } } } }),
      ),
  },
];

const ORDER_READS: Scenario[] = [
  {
    id: 'order/nullable-asc',
    kind: 'read',
    run: (db) => ids(users(db, { orderBy: [{ nickname: 'asc' }, { id: 'asc' }] })),
  },
  {
    id: 'order/nullable-desc',
    kind: 'read',
    run: (db) => ids(users(db, { orderBy: [{ nickname: 'desc' }, { id: 'asc' }] })),
  },
  {
    id: 'order/nulls-first',
    kind: 'read',
    run: (db) => ids(users(db, { orderBy: [{ nickname: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }] })),
  },
  {
    id: 'order/nulls-last-desc',
    kind: 'read',
    run: (db) => ids(users(db, { orderBy: [{ age: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }] })),
  },
  {
    id: 'order/double-desc-nullable',
    kind: 'read',
    run: (db) => ids(posts(db, { orderBy: [{ rating: 'desc' }, { id: 'asc' }] })),
  },
  { id: 'order/text-ascii', kind: 'read', run: (db) => ids(users(db, { orderBy: { email: 'desc' } })) },
  {
    id: 'order/timestamp-ties',
    kind: 'read',
    run: (db) => ids(users(db, { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })),
  },
  {
    id: 'order/numeric',
    kind: 'read',
    run: (db) => ids(users(db, { where: { balance: { not: null } }, orderBy: [{ balance: 'asc' }, { id: 'asc' }] })),
  },
  {
    id: 'order/relation-count',
    kind: 'read',
    run: (db) => ids(users(db, { orderBy: [{ oePosts: { _count: 'desc' } }, { id: 'asc' }] })),
  },
];

const PAGE_READS: Scenario[] = [
  { id: 'page/limit-offset', kind: 'read', run: (db) => ids(users(db, { limit: 2, offset: 2 })) },
  { id: 'page/take-skip', kind: 'read', run: (db) => ids(users(db, { take: 3, skip: 1 })) },
  { id: 'page/cursor', kind: 'read', run: (db) => ids(users(db, { cursor: { id: 3 }, limit: 2 })) },
  {
    id: 'page/ties-limit',
    kind: 'read',
    run: (db) => ids(posts(db, { orderBy: [{ views: 'desc' }, { id: 'asc' }], limit: 3, offset: 1 })),
  },
  { id: 'page/limit-zero', kind: 'read', run: (db) => ids(users(db, { limit: 0 })) },
];

const WITH_READS: Scenario[] = [
  {
    id: 'with/depth-2-full-rows',
    kind: 'read',
    run: (db) =>
      db.table(O).findMany({
        ...byId,
        with: { oeUsers: { orderBy: { id: 'asc' }, with: { oePosts: { orderBy: { id: 'asc' } } } } },
      }),
  },
  ...(['join', 'batched'] as const).map(
    (strategy): Scenario => ({
      id: `with/depth-2-options-${strategy}`,
      kind: 'read',
      run: (db) =>
        users(db, {
          relationLoadStrategy: strategy,
          select: { id: true, name: true },
          with: {
            oePosts: {
              where: { published: true },
              orderBy: [{ views: 'desc' }, { id: 'asc' }],
              limit: 1,
              with: { oeComments: { orderBy: { id: 'asc' }, select: { id: true, body: true, likes: true } } },
            },
            oeProfiles: { select: { bio: true } },
          },
        }),
    }),
  ),
  {
    id: 'with/belongs-to-nullable',
    kind: 'read',
    run: (db) =>
      posts(db, {
        select: { id: true },
        with: { oeUser: { select: { id: true, name: true }, with: { oeOrg: true } } },
      }),
  },
  {
    id: 'with/relation-count',
    kind: 'read',
    run: (db) => users(db, { select: { id: true }, with: { _count: { oePosts: true, oeComments: true } } }),
  },
  {
    id: 'with/to-many-full-row-types',
    kind: 'read',
    run: (db) => db.table(O).findMany({ ...byId, where: { id: 1 }, with: { oeUsers: { orderBy: { id: 'asc' } } } }),
  },
];

const AGGREGATE_READS: Scenario[] = [
  { id: 'agg/count', kind: 'read', run: (db) => db.table(U).count() },
  { id: 'agg/count-where', kind: 'read', run: (db) => db.table(U).count({ where: { active: true } }) },
  {
    id: 'agg/sum-avg-int-double',
    kind: 'read',
    run: (db) =>
      db.table(U).aggregate({ _count: true, _sum: { age: true, score: true }, _avg: { age: true, score: true } }),
  },
  { id: 'agg/sum-numeric', kind: 'read', run: (db) => db.table(U).aggregate({ _sum: { balance: true } }) },
  { id: 'agg/sum-bigint', kind: 'read', run: (db) => db.table(U).aggregate({ _sum: { big: true } }) },
  {
    id: 'agg/min-max-mixed',
    kind: 'read',
    run: (db) =>
      db.table(U).aggregate({
        _min: { age: true, createdAt: true, email: true, birthday: true },
        _max: { age: true, createdAt: true, email: true, big: true },
      }),
  },
  {
    id: 'agg/min-max-numeric',
    kind: 'read',
    run: (db) => db.table(U).aggregate({ _min: { balance: true }, _max: { balance: true } }),
  },
  {
    id: 'agg/group-by',
    kind: 'read',
    run: (db) =>
      db.table(P).groupBy({
        by: ['orgId'],
        _count: true,
        _sum: { views: true },
        _max: { rating: true },
        orderBy: { orgId: 'asc' },
      }),
  },
  {
    id: 'agg/group-by-having',
    kind: 'read',
    run: (db) =>
      db
        .table(P)
        .groupBy({ by: ['userId'], _count: true, having: { views: { _sum: { gt: 60 } } }, orderBy: { userId: 'asc' } }),
  },
  {
    id: 'agg/group-by-boolean',
    kind: 'read',
    run: (db) =>
      db.table(P).groupBy({ by: ['published'], _count: true, _avg: { views: true }, orderBy: { published: 'asc' } }),
  },
];

const UNIQUE_READS: Scenario[] = [
  { id: 'unique/find-unique-id', kind: 'read', run: (db) => db.table(U).findUnique({ where: { id: 3 } }) },
  {
    id: 'unique/find-unique-email',
    kind: 'read',
    run: (db) => db.table(U).findUnique({ where: { email: 'erin@example.com' } }),
  },
  { id: 'unique/find-unique-miss', kind: 'read', run: (db) => db.table(U).findUnique({ where: { id: 999 } }) },
  {
    id: 'unique/find-first-ordered',
    kind: 'read',
    run: (db) => db.table(P).findFirst({ where: { published: true }, orderBy: [{ views: 'asc' }, { id: 'asc' }] }),
  },
];

const NEW_USER = {
  id: 100,
  orgId: 3,
  email: 'new@example.com',
  name: 'New Person',
  nickname: null,
  age: 41,
  score: 1.125,
  balance: '99999999999999999999.99',
  big: 9007199254740995n,
  active: true,
  createdAt: new Date('2026-10-25T01:30:00.007Z'),
  birthday: new Date('1999-12-31T00:00:00.000Z'),
  prefs: { nested: { list: [1, 'two', null] } },
  token: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
};

const WRITES: Scenario[] = [
  { id: 'write/create-all-types', kind: 'write', state: [U], run: (db) => db.table(U).create({ data: NEW_USER }) },
  {
    id: 'write/create-json-array',
    kind: 'write',
    state: [U],
    run: (db) => db.table(U).create({ data: { ...NEW_USER, prefs: ['x', 2, false] } }),
  },
  {
    id: 'write/create-many',
    kind: 'write',
    state: [P],
    run: (db) =>
      db
        .table(P)
        .createMany({
          data: [
            {
              id: 50,
              userId: 3,
              orgId: 1,
              title: 'a',
              views: 1,
              rating: 0.5,
              published: true,
              publishedAt: new Date('2026-05-05T05:05:05.505Z'),
              meta: { k: 1 },
            },
            {
              id: 51,
              userId: null,
              orgId: 3,
              title: 'b',
              views: 2,
              rating: null,
              published: false,
              publishedAt: null,
              meta: null,
            },
          ],
        })
        .then(() => null),
  },
  {
    id: 'write/create-many-bigint-mixed',
    kind: 'write',
    state: [U],
    run: (db) =>
      db
        .table(U)
        .createMany({
          data: [
            { ...NEW_USER, id: 60, email: 'm1@example.com', big: 9007199254740997n },
            { ...NEW_USER, id: 61, email: 'm2@example.com', big: 3n },
          ],
        })
        .then(() => null),
  },
  {
    id: 'write/update-atomic-int-double',
    kind: 'write',
    state: [U],
    run: (db) =>
      db
        .table(U)
        .update({ where: { id: 2 }, data: { age: { increment: 1 }, score: { multiply: 2 }, nickname: 'robert' } }),
  },
  {
    id: 'write/update-divide-int',
    kind: 'write',
    state: [P],
    run: (db) => db.table(P).update({ where: { id: 2 }, data: { views: { divide: 2 } } }),
  },
  {
    id: 'write/update-decrement-int',
    kind: 'write',
    state: [P],
    run: (db) => db.table(P).update({ where: { id: 1 }, data: { views: { decrement: 101 } } }),
  },
  {
    id: 'write/update-increment-numeric',
    kind: 'write',
    state: [U],
    run: (db) => db.table(U).update({ where: { id: 1 }, data: { balance: { increment: 1.5 } } }),
  },
  {
    id: 'write/update-set-null-and-json',
    kind: 'write',
    state: [U],
    run: (db) => db.table(U).update({ where: { id: 1 }, data: { nickname: null, prefs: { replaced: true } } }),
  },
  {
    id: 'write/update-many',
    kind: 'write',
    state: [P],
    run: (db) =>
      db.table(P).updateMany({ where: { published: false }, data: { published: true, views: { increment: 10 } } }),
  },
  {
    id: 'write/upsert-existing',
    kind: 'write',
    state: [U],
    run: (db) =>
      db.table(U).upsert({
        where: { email: 'bob@example.com' },
        create: { ...NEW_USER, email: 'bob@example.com' },
        update: { name: 'Bob Updated', age: { increment: 3 } },
      }),
  },
  {
    id: 'write/upsert-new',
    kind: 'write',
    state: [U],
    run: (db) => db.table(U).upsert({ where: { id: 100 }, create: NEW_USER, update: { name: 'never' } }),
  },
  { id: 'write/delete', kind: 'write', state: [C], run: (db) => db.table(C).delete({ where: { id: 2 } }) },
  {
    id: 'write/delete-many-relation-is',
    kind: 'write',
    state: [C],
    run: (db) => db.table(C).deleteMany({ where: { oeUser: { is: { name: 'bob' } } } }),
  },
  {
    id: 'write/delete-many-range',
    kind: 'write',
    state: [C],
    run: (db) => db.table(C).deleteMany({ where: { likes: { lt: 2 } } }),
  },
  {
    id: 'write/delete-many-relation-none',
    kind: 'write',
    state: [PR],
    run: (db) => db.table(PR).deleteMany({ where: { oeUser: { is: { oePosts: { none: {} } } } } }),
  },
];

const GLOBAL_FILTER: Scenario[] = [
  {
    id: 'gf/find-many-with',
    kind: 'read',
    config: TENANT,
    run: (db) => users(db, { select: { id: true }, with: { oePosts: { select: { id: true } } } }),
  },
  {
    id: 'gf/unfiltered-parent-with',
    kind: 'read',
    config: TENANT,
    run: (db) =>
      db.table(O).findMany({
        ...byId,
        select: { id: true },
        with: { oeUsers: { select: { id: true } }, oePosts: { select: { id: true } } },
      }),
  },
  { id: 'gf/count', kind: 'read', config: TENANT, run: (db) => db.table(P).count() },
  {
    id: 'gf/relation-filter',
    kind: 'read',
    config: TENANT,
    run: (db) => ids(users(db, { where: { oeComments: { some: {} } } })),
  },
  {
    id: 'gf/aggregate',
    kind: 'read',
    config: TENANT,
    run: (db) => db.table(P).aggregate({ _sum: { views: true }, _count: true }),
  },
  {
    id: 'gf/find-unique-other-tenant',
    kind: 'read',
    config: TENANT,
    run: (db) => db.table(U).findUnique({ where: { id: 4 } }),
  },
  {
    id: 'gf/update-many',
    kind: 'write',
    config: TENANT,
    state: [P],
    run: (db) => db.table(P).updateMany({ where: { views: { gte: 60 } }, data: { views: { increment: 1 } } }),
  },
  {
    id: 'gf/delete-many-all',
    kind: 'write',
    config: TENANT,
    state: [C],
    run: (db) => db.table(C).deleteMany({ where: {}, allowFullTableScan: UNSAFE }),
  },
  {
    id: 'gf/update-other-tenant',
    kind: 'write',
    config: TENANT,
    state: [U],
    run: (db) => db.table(U).updateMany({ where: { id: 4 }, data: { name: 'escaped' } }),
  },
];

export const SCENARIOS: readonly Scenario[] = [
  ...SEED_READS,
  ...WHERE_READS,
  ...RELATION_READS,
  ...ORDER_READS,
  ...PAGE_READS,
  ...WITH_READS,
  ...AGGREGATE_READS,
  ...UNIQUE_READS,
  ...WRITES,
  ...GLOBAL_FILTER,
];
