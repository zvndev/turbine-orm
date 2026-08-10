/**
 * The scenarios the headline suite does not reach.
 *
 * `bench-interleaved.ts` measures ten shapes, and their distribution is skewed:
 * three are `findUnique`, the largest non-stream result is 100 rows, nothing
 * measures a write other than one atomic increment, and nothing measures
 * aggregation, to-one relations, many-to-many, or relation filters. That set
 * flatters small hot reads, which is not where applications spend their time.
 *
 * This file adds the missing shapes on the same interleaved harness
 * (`bench-harness.ts`), against the same fixture, so the two are directly
 * comparable. Where an ORM cannot express a shape the way the others do, the
 * arm is written the way that ORM's own documentation prescribes and the
 * scenario carries a `note` saying so, printed with the numbers. A comparison
 * whose arms differ is still worth having; one that hides it is not.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx bench-extended.ts
 *
 * Env:
 *   ROUNDS=100     rounds per scenario (heavy scenarios scale down from this)
 *   WARMUP=10      warmup calls per arm per scenario
 *   GROUPS=...     comma-separated subset of:
 *                  large,list,relations,agg,writes,strategy,cold
 */

import pg from 'pg';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, asc, avg, count as drizzleCount, desc, eq, exists, gt, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { TurbineClient } from '../generated/turbine/index.js';
import { Bench } from './bench-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '100', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '10', 10);
const ALL_GROUPS = ['large', 'list', 'relations', 'agg', 'writes', 'strategy', 'cold'] as const;
type Group = (typeof ALL_GROUPS)[number];
const GROUPS = new Set<Group>(
  (process.env['GROUPS'] ? process.env['GROUPS'].split(',') : ALL_GROUPS).map((g) => g.trim() as Group),
);

async function main(): Promise<void> {
  const bench = new Bench({ rounds: ROUNDS, warmup: WARMUP });
  console.log('Extended suite: the shapes the headline ten do not cover.');
  console.log(`ROUNDS=${ROUNDS} WARMUP=${WARMUP} GROUPS=${[...GROUPS].join(',')} Node ${process.version}`);

  const turbine = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await turbine.connect();
  const prismaPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });
  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const drizzleDb = drizzle(drizzlePool, { schema });
  const rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

  // The fixture is a precondition, not a detail: every number below is a
  // function of these counts, so a stale or half-seeded database must refuse to
  // report rather than publish a comparison of a different dataset.
  const counts = await rawPool.query<{ t: string; n: number }>(`
    SELECT 'users' AS t, COUNT(*)::int AS n FROM users
    UNION ALL SELECT 'posts', COUNT(*)::int FROM posts
    UNION ALL SELECT 'comments', COUNT(*)::int FROM comments
    UNION ALL SELECT 'tags', COUNT(*)::int FROM tags
    UNION ALL SELECT 'post_tags', COUNT(*)::int FROM post_tags
    UNION ALL SELECT 'bench_wide', COUNT(*)::int FROM bench_wide
  `);
  const got = Object.fromEntries(counts.rows.map((r) => [r.t, r.n]));
  const want = { users: 1000, posts: 10000, comments: 50000, tags: 50, post_tags: 30000, bench_wide: 2000 };
  for (const [t, n] of Object.entries(want)) {
    if (got[t] !== n) {
      console.error(`SEED MISMATCH: ${t} is ${got[t]}, expected ${n}. Re-run seed-neon.ts. Refusing to report.`);
      process.exit(1);
    }
  }
  console.log(`Data: ${Object.entries(got).map(([t, n]) => `${n} ${t}`).join(', ')}`);

  const driftHead = await bench.driftProbe(rawPool, 'head');

  // -------------------------------------------------------------------------
  // Large result sets. The headline suite's biggest non-stream read is 100
  // rows, which is far too few for per-row decode cost to appear at all.
  // -------------------------------------------------------------------------
  if (GROUPS.has('large')) {
    for (const n of [5000, 50000]) {
      await bench.interleave(
        `findMany, ${n.toLocaleString()} comments (flat)`,
        [
          { name: 'Turbine', fn: () => turbine.comments.findMany({ limit: n }) },
          { name: 'Prisma 7', fn: () => prisma.comment.findMany({ take: n }) },
          { name: 'Drizzle', fn: () => drizzleDb.query.comments.findMany({ limit: n }) },
          { name: 'Raw', fn: () => rawPool.query('SELECT * FROM comments LIMIT $1', [n]) },
        ],
        { rounds: n >= 50000 ? Math.max(10, Math.floor(ROUNDS / 10)) : ROUNDS, warmup: 5 },
      );
    }

    await bench.interleave(
      'findMany, 1,000 rows x 39 columns (wide)',
      [
        { name: 'Turbine', fn: () => turbine.benchWide.findMany({ limit: 1000 }) },
        { name: 'Prisma 7', fn: () => prisma.benchWide.findMany({ take: 1000 }) },
        { name: 'Drizzle', fn: () => drizzleDb.query.benchWide.findMany({ limit: 1000 }) },
        { name: 'Raw', fn: () => rawPool.query('SELECT * FROM bench_wide LIMIT 1000') },
      ],
      { rounds: Math.max(20, Math.floor(ROUNDS / 2)) },
    );
  }

  // -------------------------------------------------------------------------
  // List pages: where + orderBy + limit/offset. The single most common query in
  // a web application, and entirely absent from the headline suite.
  // -------------------------------------------------------------------------
  if (GROUPS.has('list')) {
    const listRaw = 'SELECT * FROM posts WHERE org_id = $1 AND published = $2 ORDER BY created_at DESC, id DESC LIMIT $3 OFFSET $4';
    for (const [label, offset] of [
      ['page 3', 40],
      ['deep offset', 9000],
    ] as const) {
      // The deep page gets a fifth arm. Turbine names its prepared statements,
      // which is what wins the hot small-query scenarios (node-postgres skips
      // `Parse` only for a statement already parsed BY NAME). The cost of that
      // is here: PostgreSQL promotes a named statement to a value-blind GENERIC
      // plan on its sixth execution, and with `OFFSET` bound as a parameter the
      // generic plan cannot know the offset is 9,000. Drizzle and Prisma never
      // name statements, so they never reach the cliff, and never get the
      // Parse-skip either. It is a real trade with a per-query remedy, so the
      // remedy is measured next to the default rather than described.
      const deepArms =
        offset >= 9000
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
          : [];
      await bench.interleave(`list, published posts in org 1, newest first (${label})`, [
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
              where: { orgId: BigInt(1), published: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 20,
              skip: offset,
            }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            drizzleDb.query.posts.findMany({
              where: and(eq(schema.posts.orgId, 1), eq(schema.posts.published, true)),
              orderBy: [desc(schema.posts.createdAt), desc(schema.posts.id)],
              limit: 20,
              offset,
            }),
        },
        ...deepArms,
        { name: 'Raw', fn: () => rawPool.query(listRaw, [1, true, 20, offset]) },
      ], {
        note:
          offset >= 9000
            ? '`Turbine +fCP` is the same query with `forceCustomPlan: true`, which sends that one ' +
              'statement UNNAMED so PostgreSQL re-plans it for the actual offset. The gap between the two ' +
              'Turbine arms is the generic-plan cliff, not ORM overhead: a hand-written raw pg query with ' +
              'a statement NAME reproduces it exactly (0.563 ms against 0.307 ms unnamed, measured ' +
              'separately), and Drizzle and Prisma avoid it only because they never name statements.'
            : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Relations the headline suite never touches: to-one, many-to-many, relation
  // counts, and relation filters.
  // -------------------------------------------------------------------------
  if (GROUPS.has('relations')) {
    const toOneRaw = `
      SELECT p.*, (
        SELECT json_build_object('id', u.id, 'orgId', u.org_id, 'email', u.email, 'name', u.name,
          'role', u.role, 'avatarUrl', u.avatar_url, 'lastLoginAt', u.last_login_at, 'createdAt', u.created_at)
        FROM users u WHERE u.id = p.user_id
      ) AS "user"
      FROM posts p LIMIT 500`;
    await bench.interleave('to-one, 500 posts + author', [
      { name: 'Turbine', fn: () => turbine.posts.findMany({ limit: 500, with: { user: true } }) },
      { name: 'Prisma 7', fn: () => prisma.post.findMany({ take: 500, include: { user: true } }) },
      { name: 'Drizzle', fn: () => drizzleDb.query.posts.findMany({ limit: 500, with: { user: true } }) },
      { name: 'Raw', fn: () => rawPool.query(toOneRaw) },
    ]);

    await bench.interleave(
      'many-to-many, 200 posts + tags through a junction',
      [
        { name: 'Turbine', fn: () => turbine.posts.findMany({ limit: 200, with: { tags: true } }) },
        {
          name: 'Prisma 7',
          fn: () => prisma.post.findMany({ take: 200, include: { postTags: { include: { tag: true } } } }),
        },
        {
          name: 'Drizzle',
          fn: () => drizzleDb.query.posts.findMany({ limit: 200, with: { postTags: { with: { tag: true } } } }),
        },
      ],
      {
        note:
          'RESULT SHAPES DIFFER, and that is the finding. Turbine detects the junction from its two ' +
          'foreign keys and returns post.tags[]. Prisma and Drizzle both require the junction as an ' +
          'explicit model/table here, so each returns post.postTags[].tag, one level deeper, and the ' +
          'caller flattens it. Each arm is written the way that ORM prescribes.',
      },
    );

    await bench.interleave(
      'relation _count, 100 users + their post count',
      [
        { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 100, with: { _count: { posts: true } } }) },
        {
          name: 'Prisma 7',
          fn: () => prisma.user.findMany({ take: 100, include: { _count: { select: { posts: true } } } }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            drizzleDb
              .select({
                id: schema.users.id,
                name: schema.users.name,
                postCount: sql<number>`(SELECT count(*) FROM posts WHERE posts.user_id = ${schema.users.id})`,
              })
              .from(schema.users)
              .limit(100),
        },
      ],
      {
        note:
          "Drizzle's relational API has no relation-count primitive, so its arm is a hand-written " +
          'correlated subquery through the query builder, which is what its docs prescribe. It also ' +
          'therefore selects two columns rather than the whole row.',
      },
    );

    const relFilterRaw = 'SELECT * FROM users u WHERE EXISTS (SELECT 1 FROM posts p WHERE p.user_id = u.id AND p.published) LIMIT 100';
    await bench.interleave(
      'relation filter, 100 users having a published post',
      [
        {
          name: 'Turbine',
          fn: () => turbine.users.findMany({ where: { posts: { some: { published: true } } }, limit: 100 }),
        },
        {
          name: 'Prisma 7',
          fn: () => prisma.user.findMany({ where: { posts: { some: { published: true } } }, take: 100 }),
        },
        {
          name: 'Drizzle',
          fn: () =>
            drizzleDb
              .select()
              .from(schema.users)
              .where(
                exists(
                  drizzleDb
                    .select({ one: sql`1` })
                    .from(schema.posts)
                    .where(and(eq(schema.posts.userId, schema.users.id), eq(schema.posts.published, true))),
                ),
              )
              .limit(100),
        },
        { name: 'Raw', fn: () => rawPool.query(relFilterRaw) },
      ],
      {
        note:
          "Drizzle's relational API has no relation filter (some/none/every), so its arm builds the " +
          'EXISTS subquery by hand through the query builder.',
      },
    );
  }

  // -------------------------------------------------------------------------
  // Aggregation. 0.53 built a lot of groupBy/HAVING machinery that has never
  // been benchmarked against anything.
  // -------------------------------------------------------------------------
  if (GROUPS.has('agg')) {
    const aggRaw = `
      SELECT org_id, count(*) AS c, avg(view_count) AS avg_views
      FROM posts GROUP BY org_id HAVING count(*) > 100 ORDER BY org_id`;
    await bench.interleave('groupBy org, count + avg views, having count > 100', [
      {
        name: 'Turbine',
        fn: () =>
          turbine.posts.groupBy({
            by: ['orgId'],
            _count: true,
            _avg: { viewCount: true },
            having: { _count: { gt: 100 } },
            orderBy: { orgId: 'asc' },
          }),
      },
      {
        name: 'Prisma 7',
        fn: () =>
          prisma.post.groupBy({
            by: ['orgId'],
            _count: true,
            _avg: { viewCount: true },
            having: { orgId: { _count: { gt: 100 } } },
            orderBy: { orgId: 'asc' },
          }),
      },
      {
        name: 'Drizzle',
        fn: () =>
          drizzleDb
            .select({
              orgId: schema.posts.orgId,
              c: drizzleCount(),
              avgViews: avg(schema.posts.viewCount),
            })
            .from(schema.posts)
            .groupBy(schema.posts.orgId)
            .having(gt(drizzleCount(), 100))
            .orderBy(asc(schema.posts.orgId)),
      },
      { name: 'Raw', fn: () => rawPool.query(aggRaw) },
    ]);
  }

  // -------------------------------------------------------------------------
  // Writes. Everything here runs against `bench_writes`, a scratch table no
  // read scenario touches: a bulk-insert benchmark that grew `posts` would
  // change the cost of every read measured after it.
  // -------------------------------------------------------------------------
  if (GROUPS.has('writes')) {
    const BULK = 1000;
    const bulkRows = Array.from({ length: BULK }, (_, i) => ({
      orgId: (i % 5) + 1,
      slug: `bulk-${i}`,
      label: `Bulk row ${i}`,
      amount: i % 997,
    }));
    const truncate = () => rawPool.query('TRUNCATE bench_writes RESTART IDENTITY');
    await bench.interleave(
      `createMany, ${BULK.toLocaleString()} rows`,
      [
        { name: 'Turbine', setup: truncate, fn: () => turbine.benchWrites.createMany({ data: bulkRows }) },
        {
          name: 'Prisma 7',
          setup: truncate,
          fn: () => prisma.benchWrite.createMany({ data: bulkRows.map((r) => ({ ...r, orgId: BigInt(r.orgId) })) }),
        },
        { name: 'Drizzle', setup: truncate, fn: () => drizzleDb.insert(schema.benchWrites).values(bulkRows) },
        {
          name: 'Raw',
          setup: truncate,
          fn: () =>
            rawPool.query(
              `INSERT INTO bench_writes (org_id, slug, label, amount)
               SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::int[])`,
              [
                bulkRows.map((r) => r.orgId),
                bulkRows.map((r) => r.slug),
                bulkRows.map((r) => r.label),
                bulkRows.map((r) => r.amount),
              ],
            ),
        },
      ],
      { rounds: Math.max(15, Math.floor(ROUNDS / 5)), warmup: 3 },
    );

    // One dedicated row per arm, so no arm's update is measured against a row
    // another arm just touched.
    await truncate();
    const armSlugs = ['turbine', 'prisma', 'drizzle', 'raw'];
    const inserted = await rawPool.query<{ id: string; slug: string }>(
      `INSERT INTO bench_writes (org_id, slug, label)
       SELECT 1, s, s FROM UNNEST($1::text[]) AS s RETURNING id::text, slug`,
      [armSlugs.map((s) => `upd-${s}`)],
    );
    const idFor = Object.fromEntries(inserted.rows.map((r) => [r.slug, Number(r.id)]));

    await bench.interleave('update by primary key', [
      {
        name: 'Turbine',
        fn: (i) => turbine.benchWrites.update({ where: { id: idFor['upd-turbine']! }, data: { amount: i } }),
      },
      {
        name: 'Prisma 7',
        fn: (i) => prisma.benchWrite.update({ where: { id: BigInt(idFor['upd-prisma']!) }, data: { amount: i } }),
      },
      {
        name: 'Drizzle',
        fn: (i) =>
          drizzleDb.update(schema.benchWrites).set({ amount: i }).where(eq(schema.benchWrites.id, idFor['upd-drizzle']!)),
      },
      {
        name: 'Raw',
        fn: (i) => rawPool.query('UPDATE bench_writes SET amount = $1 WHERE id = $2', [i, idFor['upd-raw']!]),
      },
    ]);

    await bench.interleave(
      'upsert on a unique column (update path)',
      [
        {
          name: 'Turbine',
          fn: (i) =>
            turbine.benchWrites.upsert({
              where: { slug: 'ups-turbine' },
              create: { orgId: 1, slug: 'ups-turbine', label: 'upsert', amount: i },
              update: { amount: i },
            }),
        },
        {
          name: 'Prisma 7',
          fn: (i) =>
            prisma.benchWrite.upsert({
              where: { slug: 'ups-prisma' },
              create: { orgId: BigInt(1), slug: 'ups-prisma', label: 'upsert', amount: i },
              update: { amount: i },
            }),
        },
        {
          name: 'Drizzle',
          fn: (i) =>
            drizzleDb
              .insert(schema.benchWrites)
              .values({ orgId: 1, slug: 'ups-drizzle', label: 'upsert', amount: i })
              .onConflictDoUpdate({ target: schema.benchWrites.slug, set: { amount: i } }),
        },
        {
          name: 'Raw',
          fn: (i) =>
            rawPool.query(
              `INSERT INTO bench_writes (org_id, slug, label, amount) VALUES (1, 'ups-raw', 'upsert', $1)
               ON CONFLICT (slug) DO UPDATE SET amount = EXCLUDED.amount`,
              [i],
            ),
        },
      ],
      {
        note:
          'The first call of each arm inserts and every call after it updates, so the warmup covers the ' +
          'insert path and the measured rounds are all the update path.',
      },
    );

    // Delete needs a row per round, created untimed so the measurement is the
    // delete and not the insert that fed it.
    const delSlug = (arm: string, i: number) => `del-${arm}-${i}`;
    const seedDelete = (arm: string) => async (i: number) => {
      await rawPool.query('INSERT INTO bench_writes (org_id, slug, label) VALUES (1, $1, $1)', [delSlug(arm, i)]);
    };
    await bench.interleave('delete by unique column', [
      {
        name: 'Turbine',
        setup: seedDelete('turbine'),
        fn: (i) => turbine.benchWrites.delete({ where: { slug: delSlug('turbine', i) } }),
      },
      {
        name: 'Prisma 7',
        setup: seedDelete('prisma'),
        fn: (i) => prisma.benchWrite.delete({ where: { slug: delSlug('prisma', i) } }),
      },
      {
        name: 'Drizzle',
        setup: seedDelete('drizzle'),
        fn: (i) => drizzleDb.delete(schema.benchWrites).where(eq(schema.benchWrites.slug, delSlug('drizzle', i))),
      },
      {
        name: 'Raw',
        setup: seedDelete('raw'),
        fn: (i) => rawPool.query('DELETE FROM bench_writes WHERE slug = $1', [delSlug('raw', i)]),
      },
    ]);

    await truncate();
  }

  // -------------------------------------------------------------------------
  // Relation strategies. `auto` is the DEFAULT and has no published number, and
  // `flatten` has only ever been compared against Turbine's own join plan.
  // Turbine-only arms: the point is which of our strategies to use, not who
  // wins.
  // -------------------------------------------------------------------------
  if (GROUPS.has('strategy')) {
    await bench.interleave(
      'strategy (to-many), 200 users + posts',
      (['join', 'batched', 'auto'] as const).map((s) => ({
        name: s,
        fn: () => turbine.users.findMany({ limit: 200, with: { posts: true }, relationLoadStrategy: s }),
      })),
      {
        note:
          'Turbine-only. `auto` is the shipped default. DO NOT READ A RECOMMENDATION OUT OF THIS ROW: ' +
          'these numbers are measured over a Unix socket, where a round trip is ~0.05 ms, and `batched` ' +
          'buys its win by spending an EXTRA round trip per relation. bench-latency.ts runs this same ' +
          'shape through a delay proxy and the ordering INVERTS by 1 ms of RTT: at 25 ms, batched is ' +
          '54.0 ms against join at 29.5 ms. `auto` choosing join is right for anything on a real link.',
      },
    );

    await bench.interleave(
      'strategy (to-one), 500 posts + author',
      (['join', 'batched', 'auto', 'flatten'] as const).map((s) => ({
        name: s,
        fn: () => turbine.posts.findMany({ limit: 500, with: { user: true }, relationLoadStrategy: s }),
      })),
      {
        note:
          'Turbine-only. `flatten` applies to to-one relations only, which is why it appears here and ' +
          'not above. The same socket caveat as the to-many row applies to `batched`; `flatten` does ' +
          'NOT spend an extra round trip (it is one statement, a LEFT JOIN), so its win here is not a ' +
          'socket artifact.',
      },
    );
  }

  const driftMid = await bench.driftProbe(rawPool, 'mid');

  // -------------------------------------------------------------------------
  // Cold start. The headline suite publishes a HOT findUnique and no cold one,
  // so the cost of an ORM's first query on a fresh client is unmeasured. The
  // connection itself is established untimed, because that cost is the driver's
  // and is identical for all three; what is timed is the first real query,
  // which is where statement building, `Parse`, and any lazy initialisation
  // land.
  // -------------------------------------------------------------------------
  if (GROUPS.has('cold')) {
    const COLD_ROUNDS = Math.max(10, Math.floor(ROUNDS / 5));
    const coldArms: { name: string; run: () => Promise<number> }[] = [
      {
        name: 'Turbine',
        run: async () => {
          const c = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
          await c.connect();
          await c.raw`SELECT 1`;
          const t = performance.now();
          await c.users.findUnique({ where: { id: 1 } });
          const ms = performance.now() - t;
          await c.disconnect();
          return ms;
        },
      },
      {
        name: 'Prisma 7',
        run: async () => {
          const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
          const c = new PrismaClient({ adapter: new PrismaPg(pool) });
          await c.$queryRaw`SELECT 1`;
          const t = performance.now();
          await c.user.findUnique({ where: { id: BigInt(1) } });
          const ms = performance.now() - t;
          await c.$disconnect();
          await pool.end();
          return ms;
        },
      },
      {
        name: 'Drizzle',
        run: async () => {
          const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
          const d = drizzle(pool, { schema });
          await d.execute(sql`SELECT 1`);
          const t = performance.now();
          await d.query.users.findFirst({ where: eq(schema.users.id, 1) });
          const ms = performance.now() - t;
          await pool.end();
          return ms;
        },
      },
    ];

    const cold = new Map<string, number[]>(coldArms.map((a) => [a.name, []]));
    for (let r = 0; r < COLD_ROUNDS; r++) {
      for (let k = 0; k < coldArms.length; k++) {
        const arm = coldArms[(r + k) % coldArms.length]!;
        cold.get(arm.name)!.push(await arm.run());
      }
    }
    const coldStats = coldArms.map((a) => {
      const s = cold.get(a.name)!.sort((x, y) => x - y);
      return { name: a.name, median: s[Math.floor(s.length / 2)]!, min: s[0]!, n: s.length };
    });
    console.log('\n-- cold start, first query on a fresh client (connection established untimed) --');
    console.log('  arm            median      min');
    for (const s of coldStats) {
      console.log(`  ${s.name.padEnd(12)} ${s.median.toFixed(3).padStart(8)} ${s.min.toFixed(3).padStart(8)}`);
    }
    bench.results.push({
      scenario: 'cold start, first query on a fresh client',
      stats: coldStats.map((s) => ({ ...s, avg: Number.NaN, p95: Number.NaN })),
      note: 'The connection is established untimed; only the first real query is measured.',
    });
  }

  const driftTail = await bench.driftProbe(rawPool, 'tail');
  bench.reportDrift([driftHead, driftMid, driftTail]);

  console.log('\n=== JSON ===');
  console.log(JSON.stringify({ driftHead, driftMid, driftTail, results: bench.results }, null, 2));

  await turbine.disconnect();
  await prisma.$disconnect();
  await drizzlePool.end();
  await prismaPool.end();
  await rawPool.end();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nBenchmark error:', err);
  process.exit(1);
});
