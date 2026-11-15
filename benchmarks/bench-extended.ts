/** Original extended catalog. Exact preflight precedes all warmup and timing.
 * EXTENDED_VERIFY_ONLY=1: correctness only. EXTENDED_QUICK=1: bounded rounds,
 * with the full original fixture and operation catalog retained.
 */

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { and, asc, avg, count, desc, eq, exists, getTableColumns, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  and as rcAnd,
  asc as rcAsc,
  avg as rcAvg,
  getTableColumns as rcColumns,
  count as rcCount,
  eq as rcEq,
  exists as rcExists,
  gt as rcGt,
  sql as rcSql,
} from 'drizzle-rc';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import { makeJitRqbMapper } from 'drizzle-rc/relations';
import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import type { InterleaveOptions } from './bench-harness.js';
import { observedPgIdentity } from './pg-admission.js';
import { Bench, summarizeSamples } from './bench-harness.js';
import type { Row, SqlOracle } from './equivalence.js';
import type { ExtendedArm, ExtendedGroup, ExtendedId, ExtendedScenario } from './extended-equivalence.js';
import {
  aggregateRows,
  assertExtendedExact,
  bulkRows,
  countRows,
  EXTENDED_SEMANTICS,
  EXTENDED_BOUNDARIES,
  extendedUnsupported,
  extendedCatalog,
  extendedGroups,
  flattenTags,
  isWrite,
  nativeCounts,
  preparedPolicy,
  prepareWrite,
  readExtendedFixture,
  requiredArms,
  resultOne,
  scratchQuery,
  sortedReturning,
  verifyExtended,
  verifyWrite,
  writeTime,
} from './extended-equivalence.js';
import {
  assertSuppliedPrepared,
  coldArms,
  decodeJson,
  jsonRow,
  observeNativeQuery,
  postFields,
  tagFields,
  userFields,
} from './extended-support.js';
import * as schema from './schema.js';
import * as rcSchema from './schema-rc.js';

const require = createRequire(import.meta.url);
const poolMax = 10;
function packageVersion(name: string): string {
  let dir = dirname(require.resolve(name));
  for (;;) {
    const path = join(dir, 'package.json');
    if (existsSync(path)) {
      const info = JSON.parse(readFileSync(path, 'utf8')) as { version?: string };
      if (info.version) return info.version;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Cannot resolve installed package identity: ${name}`);
    dir = parent;
  }
}
const types = {
  getTypeParser: (oid: number, format?: 'text' | 'binary') =>
    oid === 20 ? (v: string) => v : pg.types.getTypeParser(oid, format),
};
function positive(name: string, fallback: number, zero = false): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < (zero ? 0 : 1)) throw new Error(`Invalid ${name}`);
  return value;
}
function groupsFromEnv(): ExtendedGroup[] {
  const groups =
    process.env.GROUPS === undefined ? [...extendedGroups] : process.env.GROUPS.split(',').map((g) => g.trim());
  if (
    !groups.length ||
    groups.some((g) => !extendedGroups.includes(g as ExtendedGroup)) ||
    new Set(groups).size !== groups.length
  )
    throw new Error('GROUPS must list unique known extended groups');
  return groups as ExtendedGroup[];
}

export async function createExtendedSuite(url: string, rounds: number, warmup: number, quick: boolean) {
  const pools: pg.Pool[] = [];
  const fresh = () => {
    const p = new pg.Pool({ connectionString: url, max: poolMax });
    pools.push(p);
    return p;
  };
  const turbinePool = fresh(),
    prismaPool = fresh(),
    stablePool = fresh(),
    rcPool = fresh(),
    rawPool = fresh(),
    oraclePool = fresh();
  const turbine = new TurbineClient({ pool: turbinePool, logging: false, preparedStatements: true });
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });
  const stable = drizzle(stablePool, { schema });
  const rc = drizzleRc({ client: rcPool, relations: rcSchema.relations, jit: true });
  const oracle: SqlOracle = { query: async (text, values) => oraclePool.query({ text, values, types }) };
  const close = async () => {
    const failures: unknown[] = [];
    for (const dispose of [
      () => turbine.disconnect(),
      () => prisma.$disconnect(),
      ...pools.map((p) => () => p.end()),
    ]) {
      try {
        await dispose();
      } catch (e) {
        failures.push(e);
      }
    }
    if (failures.length) throw new AggregateError(failures, 'Extended client/pool cleanup failed');
  };
  try {
    await turbine.connect();
    const preparedName = assertSuppliedPrepared(turbine, turbinePool);
    const namedProof = await observeNativeQuery(turbinePool, () => turbine.users.findUnique({ where: { id: 1 } }));
    if (namedProof.sent.length !== 1 || namedProof.sent[0]!.name !== preparedName)
      throw new Error('Turbine must send its preparedName through the supplied native pg pool');
    const unnamedProof = await observeNativeQuery(turbinePool, () =>
      turbine.users.findUnique({ where: { id: 1 }, forceCustomPlan: true }),
    );
    if (unnamedProof.sent.length !== 1 || unnamedProof.sent[0]!.name)
      throw new Error('Turbine forceCustomPlan must send an unnamed native pg query');
    const emittedSql = turbine.posts.buildFindMany({ limit: 1, with: { user: true } }).sql;
    const encoding = emittedSql.includes('json_build_array')
      ? 'positional'
      : emittedSql.includes('json_build_object')
        ? 'object'
        : 'unknown';
    if (encoding === 'unknown') throw new Error('Cannot prove emitted relation JSON encoding');
    const flattenSql = turbine.posts.buildFindMany({
      limit: 500,
      orderBy: { id: 'asc' },
      with: { user: true },
      relationLoadStrategy: 'flatten',
      jsonEncoding: 'object',
    }).sql;
    if (!/LEFT JOIN/i.test(flattenSql) || /json_build_(array|object)/i.test(flattenSql))
      throw new Error('The to-one flatten strategy must emit its native LEFT JOIN plan');
    if (
      (rc as unknown as { dialect: { mapperGenerators: { relationalRows: unknown } } }).dialect.mapperGenerators
        .relationalRows !== makeJitRqbMapper
    )
      throw new Error('Drizzle RC must use its current JIT relational mapper');
    const versions = {
      pg: packageVersion('pg'),
      drizzleStable: packageVersion('drizzle-orm'),
      drizzleRc: packageVersion('drizzle-rc'),
      prisma: packageVersion('@prisma/client'),
      prismaAdapter: packageVersion('@prisma/adapter-pg'),
      turbine: packageVersion('turbine-orm'),
    };
    if (
      versions.pg !== '8.23.1' ||
      versions.drizzleStable !== '0.45.4' ||
      versions.drizzleRc !== '1.0.0-rc.5' ||
      versions.prisma !== '7.10.1' ||
      versions.prismaAdapter !== '7.10.1'
    )
      throw new Error(`Comparison dependency profile mismatch: ${JSON.stringify(versions)}`);
    const scenarios: ExtendedScenario[] = [];
    const add = (id: ExtendedId, arms: ExtendedArm[], options?: InterleaveOptions) =>
      scenarios.push({ id, scenario: extendedCatalog.find((s) => s.id === id)!.scenario, arms, options });
    const options = (fullRounds: number, fullWarmup = warmup, note?: string): InterleaveOptions => ({
      rounds: quick ? rounds : fullRounds,
      warmup: quick ? warmup : fullWarmup,
      note,
    });
    for (const n of [5000, 50000] as const)
      add(
        n === 5000 ? 'comments-5000' : 'comments-50000',
        [
          { name: 'Turbine', fn: () => turbine.comments.findMany({ limit: n, orderBy: { id: 'asc' } }) },
          { name: 'Prisma 7', fn: () => prisma.comment.findMany({ take: n, orderBy: { id: 'asc' } }) },
          { name: 'Drizzle', fn: () => stable.query.comments.findMany({ limit: n, orderBy: asc(schema.comments.id) }) },
          { name: 'Drizzle RC', fn: () => rc.query.comments.findMany({ limit: n, orderBy: { id: 'asc' } }) },
          { name: 'Raw', fn: () => rawPool.query('SELECT * FROM comments ORDER BY id LIMIT $1', [n]) },
        ],
        options(n === 50000 ? Math.max(10, Math.floor(rounds / 10)) : rounds, 5),
      );
    add(
      'wide-1000',
      [
        { name: 'Turbine', fn: () => turbine.benchWide.findMany({ limit: 1000, orderBy: { id: 'asc' } }) },
        { name: 'Prisma 7', fn: () => prisma.benchWide.findMany({ take: 1000, orderBy: { id: 'asc' } }) },
        {
          name: 'Drizzle',
          fn: () => stable.query.benchWide.findMany({ limit: 1000, orderBy: asc(schema.benchWide.id) }),
        },
        { name: 'Drizzle RC', fn: () => rc.query.benchWide.findMany({ limit: 1000, orderBy: { id: 'asc' } }) },
        { name: 'Raw', fn: () => rawPool.query('SELECT * FROM bench_wide ORDER BY id LIMIT 1000') },
      ],
      options(Math.max(20, Math.floor(rounds / 2))),
    );
    for (const offset of [40, 9000])
      add(
        offset === 40 ? 'list-page3' : 'list-deep',
        [
          {
            name: 'Turbine',
            fn: () =>
              turbine.posts.findMany({
                where: { orgId: 1, published: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                limit: 20,
                offset,
              }),
          },
          {
            name: 'Prisma 7',
            fn: () =>
              prisma.post.findMany({
                where: { orgId: 1n, published: true },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 20,
                skip: offset,
              }),
          },
          {
            name: 'Drizzle',
            fn: () =>
              stable.query.posts.findMany({
                where: and(eq(schema.posts.orgId, 1), eq(schema.posts.published, true)),
                orderBy: [desc(schema.posts.createdAt), desc(schema.posts.id)],
                limit: 20,
                offset,
              }),
          },
          {
            name: 'Drizzle RC',
            fn: () =>
              rc.query.posts.findMany({
                where: { orgId: 1, published: true },
                orderBy: { createdAt: 'desc', id: 'desc' },
                limit: 20,
                offset,
              }),
          },
          {
            name: 'Raw',
            fn: () =>
              rawPool.query(
                'SELECT * FROM posts WHERE org_id=$1 AND published=$2 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4',
                [1, true, 20, offset],
              ),
          },
          ...(offset === 9000
            ? [
                {
                  name: 'Turbine +fCP',
                  fn: () =>
                    turbine.posts.findMany({
                      where: { orgId: 1, published: true },
                      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                      limit: 20,
                      offset,
                      forceCustomPlan: true,
                    }),
                },
              ]
            : []),
        ],
        {
          note:
            offset === 9000
              ? 'Original filtered offset 9000 is empty in this fixture (1400 qualifying posts). The row stays in the catalog; it does not prove nonempty deep-page decoding. +fCP sends the same query unnamed; default Turbine uses named statements.'
              : 'createdAt DESC, id DESC supplies the deterministic tie key.',
        },
      );
    const rawAuthor = async () =>
      (
        await rawPool.query(
          `SELECT p.*, (SELECT ${jsonRow('u', userFields, encoding)} FROM users u WHERE u.id=p.user_id) AS "user" FROM posts p ORDER BY p.id LIMIT 500`,
        )
      ).rows.map((p) => ({ ...p, user: decodeJson(p.user, userFields) }));
    const authorArms = (): ExtendedArm[] => [
      {
        name: 'Turbine',
        fn: () => turbine.posts.findMany({ limit: 500, orderBy: { id: 'asc' }, with: { user: true } }),
      },
      {
        name: 'Prisma 7',
        fn: () => prisma.post.findMany({ take: 500, orderBy: { id: 'asc' }, include: { user: true } }),
      },
      {
        name: 'Drizzle',
        fn: () => stable.query.posts.findMany({ limit: 500, orderBy: asc(schema.posts.id), with: { user: true } }),
      },
      {
        name: 'Drizzle RC',
        fn: () => rc.query.posts.findMany({ limit: 500, orderBy: { id: 'asc' }, with: { user: true } }),
      },
      { name: 'Raw', fn: rawAuthor },
    ];
    add('to-one', authorArms());
    add(
      'many-to-many',
      [
        {
          name: 'Turbine',
          fn: () =>
            turbine.posts.findMany({ limit: 200, orderBy: { id: 'asc' }, with: { tags: { orderBy: { id: 'asc' } } } }),
        },
        {
          name: 'Prisma 7',
          fn: async () =>
            flattenTags(
              await prisma.post.findMany({
                take: 200,
                orderBy: { id: 'asc' },
                include: { postTags: { orderBy: { tagId: 'asc' }, include: { tag: true } } },
              }),
            ),
        },
        {
          name: 'Drizzle',
          fn: async () =>
            flattenTags(
              await stable.query.posts.findMany({
                limit: 200,
                orderBy: asc(schema.posts.id),
                with: { postTags: { orderBy: asc(schema.postTags.tagId), with: { tag: true } } },
              }),
            ),
        },
        {
          name: 'Drizzle RC',
          fn: async () =>
            flattenTags(
              await rc.query.posts.findMany({
                limit: 200,
                orderBy: { id: 'asc' },
                with: { postTags: { orderBy: { tagId: 'asc' }, with: { tag: true } } },
              }),
            ),
        },
        {
          name: 'Raw',
          fn: async () =>
            (
              await rawPool.query(
                `SELECT p.*, COALESCE((SELECT json_agg(${jsonRow('t', tagFields, encoding)} ORDER BY t.id) FROM post_tags j JOIN tags t ON t.id=j.tag_id WHERE j.post_id=p.id), '[]'::json) AS tags FROM posts p ORDER BY p.id LIMIT 200`,
              )
            ).rows.map((p) => ({ ...p, tags: p.tags.map((t: unknown) => decodeJson(t, tagFields)) })),
        },
      ],
      {
        note: 'Full post.tags[] in tag id order. Explicit junction models in Prisma/Drizzle are validated and flattened inside the measured adapter; junction transfer remains an API cost.',
      },
    );
    add(
      'relation-count',
      [
        {
          name: 'Turbine',
          fn: async () =>
            nativeCounts(
              await turbine.users.findMany({ limit: 100, orderBy: { id: 'asc' }, with: { _count: { posts: true } } }),
            ),
        },
        {
          name: 'Prisma 7',
          fn: async () =>
            nativeCounts(
              await prisma.user.findMany({
                take: 100,
                orderBy: { id: 'asc' },
                include: { _count: { select: { posts: true } } },
              }),
            ),
        },
        {
          name: 'Drizzle',
          fn: async () =>
            countRows(
              await stable
                .select({
                  ...getTableColumns(schema.users),
                  postCount: sql`(SELECT count(*) FROM posts WHERE posts.user_id=${schema.users}.${sql.identifier('id')})`,
                })
                .from(schema.users)
                .orderBy(asc(schema.users.id))
                .limit(100),
            ),
        },
        {
          name: 'Drizzle RC',
          fn: async () =>
            countRows(
              await rc
                .select({
                  ...rcColumns(rcSchema.users),
                  postCount: rcSql`(SELECT count(*) FROM posts WHERE posts.user_id=${rcSchema.users}.${rcSql.identifier('id')})`,
                })
                .from(rcSchema.users)
                .orderBy(rcAsc(rcSchema.users.id))
                .limit(100),
            ),
        },
        {
          name: 'Raw',
          fn: async () =>
            countRows(
              await rawPool.query(
                'SELECT u.*, (SELECT count(*) FROM posts p WHERE p.user_id=u.id) AS "postCount" FROM users u ORDER BY u.id LIMIT 100',
              ),
            ),
        },
      ],
      {
        note: 'Full user projection in every arm. Both Drizzle versions use a correlated count subquery adapted to _count.posts.',
      },
    );
    add(
      'relation-filter',
      [
        {
          name: 'Turbine',
          fn: () =>
            turbine.users.findMany({
              where: { posts: { some: { published: true } } },
              orderBy: { id: 'asc' },
              limit: 100,
            }),
        },
        {
          name: 'Prisma 7',
          fn: () =>
            prisma.user.findMany({
              where: { posts: { some: { published: true } } },
              orderBy: { id: 'asc' },
              take: 100,
            }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            stable
              .select()
              .from(schema.users)
              .where(
                exists(
                  stable
                    .select({ one: sql`1` })
                    .from(schema.posts)
                    .where(and(eq(schema.posts.userId, schema.users.id), eq(schema.posts.published, true))),
                ),
              )
              .orderBy(asc(schema.users.id))
              .limit(100),
        },
        {
          name: 'Drizzle RC',
          fn: () =>
            rc
              .select()
              .from(rcSchema.users)
              .where(
                rcExists(
                  rc
                    .select({ one: rcSql`1` })
                    .from(rcSchema.posts)
                    .where(rcAnd(rcEq(rcSchema.posts.userId, rcSchema.users.id), rcEq(rcSchema.posts.published, true))),
                ),
              )
              .orderBy(rcAsc(rcSchema.users.id))
              .limit(100),
        },
        {
          name: 'Raw',
          fn: () =>
            rawPool.query(
              'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM posts p WHERE p.user_id=u.id AND p.published) ORDER BY u.id LIMIT 100',
            ),
        },
      ],
      {
        note: 'Drizzle stable/RC express EXISTS through their query builders; no native relation-filter primitive is claimed for those arms.',
      },
    );
    add(
      'group-by',
      [
        {
          name: 'Turbine',
          fn: async () =>
            aggregateRows(
              await turbine.posts.groupBy({
                by: ['orgId'],
                _count: true,
                _avg: { viewCount: true },
                having: { _count: { gt: 100 } },
                orderBy: { orgId: 'asc' },
              }),
              true,
            ),
        },
        {
          name: 'Prisma 7',
          fn: async () =>
            aggregateRows(
              await prisma.post.groupBy({
                by: ['orgId'],
                _count: true,
                _avg: { viewCount: true },
                having: { orgId: { _count: { gt: 100 } } },
                orderBy: { orgId: 'asc' },
              }),
              true,
            ),
        },
        {
          name: 'Drizzle',
          fn: async () =>
            aggregateRows(
              await stable
                .select({ orgId: schema.posts.orgId, c: count(), avgViews: avg(schema.posts.viewCount) })
                .from(schema.posts)
                .groupBy(schema.posts.orgId)
                .having(gt(count(), 100))
                .orderBy(asc(schema.posts.orgId)),
              false,
            ),
        },
        {
          name: 'Drizzle RC',
          fn: async () =>
            aggregateRows(
              await rc
                .select({ orgId: rcSchema.posts.orgId, c: rcCount(), avgViews: rcAvg(rcSchema.posts.viewCount) })
                .from(rcSchema.posts)
                .groupBy(rcSchema.posts.orgId)
                .having(rcGt(rcCount(), 100))
                .orderBy(rcAsc(rcSchema.posts.orgId)),
              false,
            ),
        },
        {
          name: 'Raw',
          fn: async () =>
            aggregateRows(
              await rawPool.query(
                'SELECT org_id AS "orgId", count(*) AS c, avg(view_count) AS "avgViews" FROM posts GROUP BY org_id HAVING count(*) > 100 ORDER BY org_id',
              ),
              false,
            ),
        },
      ],
      {
        note: 'Exact integer count and exact decimal fraction normalization. Independent sum/count oracle, no epsilon or decimal-to-number coercion.',
      },
    );
    const prepare = (id: ExtendedId) => () => prepareWrite(oracle, id);
    add(
      'create-many',
      [
        {
          name: 'Turbine',
          setup: prepare('create-many'),
          fn: async () => sortedReturning(await turbine.benchWrites.createMany({ data: bulkRows })),
        },
        {
          name: 'Prisma 7',
          setup: prepare('create-many'),
          fn: async () =>
            sortedReturning(
              await prisma.benchWrite.createManyAndReturn({
                data: bulkRows.map((r) => ({ ...r, orgId: BigInt(r.orgId) })),
              }),
            ),
        },
        {
          name: 'Drizzle',
          setup: prepare('create-many'),
          fn: async () => sortedReturning(await stable.insert(schema.benchWrites).values(bulkRows).returning()),
        },
        {
          name: 'Drizzle RC',
          setup: prepare('create-many'),
          fn: async () => sortedReturning(await rc.insert(rcSchema.benchWrites).values(bulkRows).returning()),
        },
        {
          name: 'Raw',
          setup: prepare('create-many'),
          fn: async () =>
            sortedReturning(
              await rawPool.query(
                'INSERT INTO bench_writes (org_id, slug, label, amount, active, created_at) SELECT *, true, $5::timestamptz FROM unnest($1::bigint[], $2::text[], $3::text[], $4::int[]) RETURNING *',
                [
                  bulkRows.map((r) => r.orgId),
                  bulkRows.map((r) => r.slug),
                  bulkRows.map((r) => r.label),
                  bulkRows.map((r) => r.amount),
                  writeTime,
                ],
              ),
            ),
        },
      ],
      options(
        Math.max(15, Math.floor(rounds / 5)),
        3,
        'All 1000 complete rows returned and sorted by generated id in every adapter. Prisma createManyAndReturn; raw UNNEST. Scratch setup untimed.',
      ),
    );
    add(
      'update',
      [
        {
          name: 'Turbine',
          setup: prepare('update'),
          fn: (i) => turbine.benchWrites.update({ where: { id: 1 }, data: { amount: i } }),
        },
        {
          name: 'Prisma 7',
          setup: prepare('update'),
          fn: (i) => prisma.benchWrite.update({ where: { id: 1n }, data: { amount: i } }),
        },
        {
          name: 'Drizzle',
          setup: prepare('update'),
          fn: (i) =>
            stable.update(schema.benchWrites).set({ amount: i }).where(eq(schema.benchWrites.id, 1)).returning(),
        },
        {
          name: 'Drizzle RC',
          setup: prepare('update'),
          fn: (i) =>
            rc.update(rcSchema.benchWrites).set({ amount: i }).where(rcEq(rcSchema.benchWrites.id, 1)).returning(),
        },
        {
          name: 'Raw',
          setup: prepare('update'),
          fn: (i) => rawPool.query('UPDATE bench_writes SET amount=$1 WHERE id=$2 RETURNING *', [i, 1]),
        },
      ],
      {
        note: 'Complete updated row in every arm. Untimed setup resets the same target and two unchanged sentinels; no predecessor state reused.',
      },
    );
    add(
      'upsert',
      [
        {
          name: 'Turbine',
          setup: prepare('upsert'),
          fn: (i) =>
            turbine.benchWrites.upsert({
              where: { slug: 'upsert-target' },
              create: {
                orgId: 1,
                slug: 'upsert-target',
                label: 'upsert-target',
                amount: i,
                active: true,
                createdAt: writeTime,
              },
              update: { amount: i },
            }),
        },
        {
          name: 'Prisma 7',
          setup: prepare('upsert'),
          fn: (i) =>
            prisma.benchWrite.upsert({
              where: { slug: 'upsert-target' },
              create: {
                orgId: 1n,
                slug: 'upsert-target',
                label: 'upsert-target',
                amount: i,
                active: true,
                createdAt: writeTime,
              },
              update: { amount: i },
            }),
        },
        {
          name: 'Drizzle',
          setup: prepare('upsert'),
          fn: (i) =>
            stable
              .insert(schema.benchWrites)
              .values({
                orgId: 1,
                slug: 'upsert-target',
                label: 'upsert-target',
                amount: i,
                active: true,
                createdAt: writeTime,
              })
              .onConflictDoUpdate({ target: schema.benchWrites.slug, set: { amount: i } })
              .returning(),
        },
        {
          name: 'Drizzle RC',
          setup: prepare('upsert'),
          fn: (i) =>
            rc
              .insert(rcSchema.benchWrites)
              .values({
                orgId: 1,
                slug: 'upsert-target',
                label: 'upsert-target',
                amount: i,
                active: true,
                createdAt: writeTime,
              })
              .onConflictDoUpdate({ target: rcSchema.benchWrites.slug, set: { amount: i } })
              .returning(),
        },
        {
          name: 'Raw',
          setup: prepare('upsert'),
          fn: (i) =>
            rawPool.query(
              'INSERT INTO bench_writes (org_id, slug, label, amount, active, created_at) VALUES (1, $1, $1, $2, true, $3) ON CONFLICT (slug) DO UPDATE SET amount=EXCLUDED.amount RETURNING *',
              ['upsert-target', i, writeTime],
            ),
        },
      ],
      {
        note: 'Existing target guaranteed even with WARMUP=0. Only update path timed, complete row returned. Native single-statement atomic writes, no artificial enclosing transaction.',
      },
    );
    add(
      'delete',
      [
        {
          name: 'Turbine',
          setup: prepare('delete'),
          fn: () => turbine.benchWrites.delete({ where: { slug: 'delete-target' } }),
        },
        {
          name: 'Prisma 7',
          setup: prepare('delete'),
          fn: () => prisma.benchWrite.delete({ where: { slug: 'delete-target' } }),
        },
        {
          name: 'Drizzle',
          setup: prepare('delete'),
          fn: () => stable.delete(schema.benchWrites).where(eq(schema.benchWrites.slug, 'delete-target')).returning(),
        },
        {
          name: 'Drizzle RC',
          setup: prepare('delete'),
          fn: () => rc.delete(rcSchema.benchWrites).where(rcEq(rcSchema.benchWrites.slug, 'delete-target')).returning(),
        },
        {
          name: 'Raw',
          setup: prepare('delete'),
          fn: () => rawPool.query('DELETE FROM bench_writes WHERE slug=$1 RETURNING *', ['delete-target']),
        },
      ],
      {
        note: 'Complete deleted row in every arm. Target insertion and two sentinels untimed; independent checks prove removal and untouched survivors.',
      },
    );
    add(
      'strategy-many',
      [
        ...(['join', 'batched', 'auto'] as const).map((strategy) => ({
          name: `Turbine ${strategy}`,
          fn: () =>
            turbine.users.findMany({
              limit: 200,
              orderBy: { id: 'asc' },
              with: { posts: { orderBy: { id: 'asc' } } },
              relationLoadStrategy: strategy,
            }),
        })),
        ...(['join', 'query'] as const).map((strategy) => ({
          name: `Prisma 7 ${strategy}`,
          fn: () =>
            prisma.user.findMany({
              take: 200,
              orderBy: { id: 'asc' },
              include: { posts: { orderBy: { id: 'asc' } } },
              relationLoadStrategy: strategy,
            }),
        })),
        {
          name: 'Drizzle',
          fn: () =>
            stable.query.users.findMany({
              limit: 200,
              orderBy: asc(schema.users.id),
              with: { posts: { orderBy: asc(schema.posts.id) } },
            }),
        },
        {
          name: 'Drizzle RC',
          fn: () =>
            rc.query.users.findMany({
              limit: 200,
              orderBy: { id: 'asc' },
              with: { posts: { orderBy: { id: 'asc' } } },
            }),
        },
        {
          name: 'Raw',
          fn: async () =>
            (
              await rawPool.query(
                `SELECT u.*, COALESCE((SELECT json_agg(${jsonRow('p', postFields, encoding)} ORDER BY p.id) FROM posts p WHERE p.user_id=u.id), '[]'::json) AS posts FROM users u ORDER BY u.id LIMIT 200`,
              )
            ).rows.map((u) => ({ ...u, posts: u.posts.map((p: unknown) => decodeJson(p, postFields)) })),
        },
      ],
      {
        note: 'Full ordered users and posts. Turbine join/batched/auto and Prisma join/query retain different round trips and READ COMMITTED statement snapshots. Drizzle native relational builders; raw encoding-matched JSON join. Flatten inapplicable to to-many.',
      },
    );
    add(
      'strategy-one',
      [
        ...(['join', 'batched', 'auto', 'flatten'] as const).map((strategy) => ({
          name: `Turbine ${strategy}`,
          fn: () =>
            turbine.posts.findMany({
              limit: 500,
              orderBy: { id: 'asc' },
              with: { user: true },
              relationLoadStrategy: strategy,
              ...(strategy === 'flatten' ? { jsonEncoding: 'object' as const } : {}),
            }),
        })),
        ...(['join', 'query'] as const).map((strategy) => ({
          name: `Prisma 7 ${strategy}`,
          fn: () =>
            prisma.post.findMany({
              take: 500,
              orderBy: { id: 'asc' },
              include: { user: true },
              relationLoadStrategy: strategy,
            }),
        })),
        ...authorArms().filter((a) => ['Drizzle', 'Drizzle RC', 'Raw'].includes(a.name)),
      ],
      {
        note: 'Full ordered posts plus full author. Strategy/round-trip differences explicit; no shared snapshot for multi-statement loaders. Flatten explicitly requests per-query object encoding to engage its native LEFT JOIN, verified from emitted SQL; other arms retain the client default.',
      },
    );
    add('cold-user', coldArms(url, poolMax), {
      note: 'Fresh ORM and real pg8.23.1 pool per sample, max=10 for all. Turbine preserves preparedStatements=true and proves its native named path during preflight. SELECT 1 establishes connection untimed. First query timed; disconnect and borrowed-pool end untimed.',
    });
    return {
      scenarios,
      oracle,
      rawPool,
      close,
      encoding,
      versions,
      prepared: {
        preparedStatements: true,
        poolIdentity: true,
        descriptorName: preparedName,
        nativeNamedVerified: true,
        nativeForceCustomPlanUnnamedVerified: true,
      },
    };
  } catch (e) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([e, cleanup], 'Extended setup and cleanup failed');
    }
    throw e;
  }
}

export async function main(): Promise<void> {
  const groups = groupsFromEnv();
  const quick = process.env.EXTENDED_QUICK === '1',
    verifyOnly = process.env.EXTENDED_VERIFY_ONLY === '1';
  const rounds = positive('ROUNDS', quick ? 1 : 100),
    warmup = positive('WARMUP', quick ? 0 : 10, true);
  const coldRounds = positive('COLD_ROUNDS', quick ? 1 : Math.max(10, rounds));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required; use a disposable direct endpoint');
  const suite = await createExtendedSuite(process.env.DATABASE_URL, rounds, warmup, quick);
  const bench = new Bench({ rounds, warmup });
  const errors: unknown[] = [];
  const report: Record<string, unknown> = {
    extendedSemantics: EXTENDED_SEMANTICS,
    unsupportedSemantics: EXTENDED_BOUNDARIES,
    provenance: observedPgIdentity(),
    status: 'running',
    mode: verifyOnly ? 'correctness-only' : quick ? 'bounded-smoke' : 'full',
    groups,
    settings: { rounds, warmup, coldRounds, quick },
    runtime: observedPgIdentity()?.runtime ?? { node: process.version, executable: process.execPath },
    versions: suite.versions,
    profile: {
      driver: 'pg8.23.1',
      turbine: 'supplied-pool',
      prepared: suite.prepared,
      poolMax,
      coldPoolMax: poolMax,
      jsonEncoding: suite.encoding,
      flatten: 'per-query object encoding; native LEFT JOIN verified from emitted SQL',
      drizzleRc: 'jit=true',
      artifactScope:
        process.env.PG_BENCH_ARTIFACT_SCOPE ??
        'local generated client imports local built dist via turbine-orm; campaign owner must establish integrated artifact identity',
    },
    catalog: extendedCatalog.map((s) => ({
      ...s,
      selected: groups.includes(s.group),
      arms: requiredArms(s.id).map((name) => ({
        name,
        status: 'supported',
        preparedPolicy: preparedPolicy(s.id, name),
      })),
      ...(s.id === 'strategy-many'
        ? {
            unsupported: extendedUnsupported,
          }
        : {}),
    })),
    results: bench.results,
    cleanup: { status: 'pending' },
  };
  let sequence: Row[] | undefined;
  try {
    const scenarios = suite.scenarios.filter((s) => groups.includes(extendedCatalog.find((c) => c.id === s.id)!.group));
    report.preflight = await verifyExtended(scenarios, groups, suite.oracle);
    if (!verifyOnly) {
      sequence = (await suite.oracle.query('SELECT last_value, is_called FROM bench_writes_id_seq')).rows;
      const fixture = await readExtendedFixture(suite.oracle);
      const driftHead = await bench.driftProbe(suite.rawPool, 'head');
      let driftMid = driftHead;
      for (const s of scenarios) {
        if (s.id === 'cold-user') {
          driftMid = await bench.driftProbe(suite.rawPool, 'mid');
          const samples = new Map(s.arms.map((a) => [a.name, [] as number[]]));
          for (let i = 0; i < coldRounds; i++)
            for (let k = 0; k < s.arms.length; k++) {
              const arm = s.arms[(i + k) % s.arms.length]!;
              const sample = await arm.cold!();
              assertExtendedExact(`${s.id}/${arm.name} measured returning`, resultOne(sample.value), fixture.users[0]);
              samples.get(arm.name)!.push(sample.ms);
            }
          bench.results.push({
            scenario: s.scenario,
            note: s.options?.note,
            stats: s.arms.map((a) =>
              summarizeSamples(a.name, samples.get(a.name)!, process.env.BENCH_RETAIN_SAMPLES === '1'),
            ),
          });
        } else if (isWrite(s.id)) {
          // Audit the previous measured return/effect in the next untimed setup,
          // then once after the final sample. Verification I/O is never timed.
          let pending: (() => Promise<void>) | undefined;
          const finish = async () => {
            if (pending) {
              const check = pending;
              pending = undefined;
              await check();
            }
          };
          const arms = s.arms.map((arm) => {
            let before: Row[];
            return {
              name: arm.name,
              setup: async (i: number) => {
                await finish();
                await arm.setup!(i);
                before = (await suite.oracle.query(scratchQuery)).rows;
              },
              fn: async (i: number) => {
                const value = await arm.fn(i);
                pending = () => verifyWrite(suite.oracle, s.id, `${s.id}/${arm.name} measured[${i}]`, before, i, value);
                return value;
              },
            };
          });
          await bench.interleave(s.scenario, arms, s.options);
          await finish();
          await suite.oracle.query('TRUNCATE bench_writes RESTART IDENTITY');
        } else await bench.interleave(s.scenario, s.arms, s.options);
      }
      const driftTail = await bench.driftProbe(suite.rawPool, 'tail');
      bench.reportDrift([driftHead, driftMid, driftTail]);
      Object.assign(report, { driftHead, driftMid, driftTail, driftSamples: bench.probes });
      assertExtendedExact(
        'Timed suite preserves every read fixture value',
        await readExtendedFixture(suite.oracle),
        fixture,
      );
    }
    report.status = 'passed';
  } catch (e) {
    errors.push(e);
    report.status = 'failed';
  }
  let restored = errors.length === 0;
  if (sequence)
    try {
      await suite.oracle.query('TRUNCATE bench_writes RESTART IDENTITY');
      await suite.oracle.query("SELECT setval('bench_writes_id_seq', $1::bigint, $2::boolean)", [
        sequence[0]!.last_value,
        sequence[0]!.is_called,
      ]);
      assertExtendedExact('Final scratch empty', (await suite.oracle.query(scratchQuery)).rows, []);
      assertExtendedExact(
        'Final sequence restoration',
        (await suite.oracle.query('SELECT last_value, is_called FROM bench_writes_id_seq')).rows,
        sequence,
      );
      restored = true;
    } catch (e) {
      errors.push(e);
      restored = false;
    }
  try {
    await suite.close();
    report.cleanup = {
      status: restored ? 'passed' : 'unproven',
      clientsDisconnected: true,
      borrowedPoolsEnded: true,
      scratchAndSequenceRestored: restored,
    };
  } catch (e) {
    errors.push(e);
    report.cleanup = { status: 'failed', scratchAndSequenceRestored: restored };
  }
  if (errors.length) {
    report.status = 'failed';
    report.errors = errors.map(errorText);
    process.exitCode = 1;
  }
  console.log('\n=== JSON ===');
  console.log(JSON.stringify(report, null, 2));
  console.log('\nDone.');
}
function errorText(e: unknown): string {
  return e instanceof AggregateError
    ? `${e.message}: ${e.errors.map(errorText).join('; ')}`
    : e instanceof Error
      ? e.message
      : String(e);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error('Extended benchmark error:', errorText(e));
    console.log('\n=== JSON ===');
    console.log(
      JSON.stringify(
        {
          extendedSemantics: EXTENDED_SEMANTICS,
          status: 'failed',
          mode: 'setup-failed',
          results: [],
          errors: [errorText(e)],
          cleanup: { status: 'see-errors' },
        },
        null,
        2,
      ),
    );
    console.log('\nDone.');
    process.exitCode = 1;
  });
