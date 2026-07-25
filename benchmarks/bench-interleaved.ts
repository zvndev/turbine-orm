/**
 * Turbine ORM interleaved benchmark harness.
 *
 * Why this exists alongside bench.ts:
 *   bench.ts measures each ORM in a contiguous block (all 200 Turbine
 *   iterations, then all 200 Prisma, then all 200 Drizzle). Any drift over the
 *   life of the process (JIT state, page cache, autovacuum, thermal) is
 *   attributed to whichever arm happened to occupy that slice of wall clock.
 *
 *   This harness runs every arm ONCE PER ROUND, rotating the arm order each
 *   round, and reports the MEDIAN across rounds. It also runs a hand-written
 *   raw-SQL control arm in most scenarios, so the residual drift and the ORM
 *   overhead above raw pg can both be quantified.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx bench-interleaved.ts
 *
 * Env:
 *   ROUNDS=200      interleaved rounds per scenario
 *   WARMUP=20       warmup calls per arm per scenario
 *   STREAM_ROUNDS=9 interleaved rounds for the 50K streaming scenario
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, count as drizzleCount, gt, asc, sql } from 'drizzle-orm';
import * as schema from './schema.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '200', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '20', 10);
const STREAM_ROUNDS = parseInt(process.env['STREAM_ROUNDS'] ?? '9', 10);

type Arm = { name: string; fn: (i: number) => Promise<unknown> };

interface ArmStat {
  name: string;
  median: number;
  avg: number;
  p95: number;
  min: number;
  n: number;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}
function pct(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

const allResults: { scenario: string; stats: ArmStat[] }[] = [];

/**
 * Run every arm once per round, rotating the starting arm each round so no arm
 * keeps a fixed position in the round and slow-drifting effects spread evenly.
 */
async function interleave(scenario: string, arms: Arm[], rounds = ROUNDS, warmup = WARMUP): Promise<ArmStat[]> {
  for (const arm of arms) {
    for (let i = 0; i < warmup; i++) await arm.fn(i);
  }

  const samples = new Map<string, number[]>();
  for (const a of arms) samples.set(a.name, []);

  for (let r = 0; r < rounds; r++) {
    const offset = r % arms.length; // flip / rotate arm order every round
    for (let k = 0; k < arms.length; k++) {
      const arm = arms[(k + offset) % arms.length]!;
      const start = performance.now();
      await arm.fn(r);
      samples.get(arm.name)!.push(performance.now() - start);
    }
  }

  const stats: ArmStat[] = arms.map((a) => {
    const s = [...samples.get(a.name)!].sort((x, y) => x - y);
    return {
      name: a.name,
      median: median(s),
      avg: s.reduce((x, y) => x + y, 0) / s.length,
      p95: pct(s, 0.95),
      min: s[0]!,
      n: s.length,
    };
  });

  allResults.push({ scenario, stats });
  print(scenario, stats);
  return stats;
}

function print(scenario: string, stats: ArmStat[]) {
  console.log(`\n-- ${scenario} --`);
  console.log('  arm            median      avg      p95      min');
  const ormStats = stats.filter((s) => s.name !== 'Raw');
  const fastest = ormStats.reduce((a, b) => (a.median < b.median ? a : b));
  for (const s of stats) {
    const f = (n: number) => n.toFixed(3).padStart(8);
    const mark = s === fastest ? ' <= fastest ORM' : '';
    console.log(`  ${s.name.padEnd(12)} ${f(s.median)} ${f(s.avg)} ${f(s.p95)} ${f(s.min)}${mark}`);
  }
  const raw = stats.find((s) => s.name === 'Raw');
  if (raw) {
    for (const s of ormStats) {
      console.log(`    ${s.name} overhead above raw pg: +${(s.median - raw.median).toFixed(3)} ms (${(s.median / raw.median).toFixed(2)}x)`);
    }
  }
}

async function main() {
  console.log('Interleaved harness: every arm once per round, order rotated per round, medians reported.');
  console.log(`ROUNDS=${ROUNDS} WARMUP=${WARMUP} STREAM_ROUNDS=${STREAM_ROUNDS} Node ${process.version}`);

  const turbine = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await turbine.connect();

  const prismaPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });

  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const drizzleDb = drizzle(drizzlePool, { schema });

  const rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

  const u = await turbine.users.count();
  const p = await turbine.posts.count();
  const c = await turbine.comments.count();
  console.log(`Data: ${u} users, ${p} posts, ${c} comments`);
  if (u !== 1000 || p !== 10000 || c !== 50000) {
    console.error('SEED MISMATCH, expected 1000/10000/50000. Refusing to report numbers.');
    process.exit(1);
  }

  // Drift probe, run at the head and the tail of the suite. The difference
  // between the two is the residual drift floor for this process.
  const driftProbe = async (label: string) => {
    for (let i = 0; i < 500; i++) await rawPool.query('SELECT 1'); // warm, never measured
    const s: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t = performance.now();
      await rawPool.query('SELECT 1');
      s.push(performance.now() - t);
    }
    s.sort((a, b) => a - b);
    const m = median(s);
    console.log(`\n[drift probe ${label}] SELECT 1 median ${m.toFixed(4)} ms (n=500)`);
    return m;
  };

  const driftHead = await driftProbe('head');

  // 1. findMany flat
  await interleave('findMany, 100 users (flat)', [
    { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 100 }) },
    { name: 'Prisma 7', fn: () => prisma.user.findMany({ take: 100 }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findMany({ limit: 100 }) },
    { name: 'Raw', fn: () => rawPool.query('SELECT * FROM users LIMIT 100') },
  ]);

  // 2. findMany L2
  const rawL2 = `
    SELECT u.*, COALESCE((
      SELECT json_agg(json_build_object('id', p.id, 'userId', p.user_id, 'orgId', p.org_id,
        'title', p.title, 'content', p.content, 'published', p.published,
        'viewCount', p.view_count, 'createdAt', p.created_at, 'updatedAt', p.updated_at))
      FROM posts p WHERE p.user_id = u.id), '[]'::json) AS posts
    FROM users u LIMIT 50`;
  await interleave('findMany, 50 users + posts (L2)', [
    { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 50, with: { posts: true } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findMany({ take: 50, include: { posts: true } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findMany({ limit: 50, with: { posts: true } }) },
    { name: 'Raw', fn: () => rawPool.query(rawL2) },
  ]);

  // 3. findMany L3 (no hand-written raw equivalent, ORM arms only)
  await interleave('findMany, 10 users -> posts -> comments (L3)', [
    { name: 'Turbine', fn: () => turbine.users.findMany({ limit: 10, with: { posts: { with: { comments: true }, limit: 5 } } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findMany({ take: 10, include: { posts: { take: 5, include: { comments: true } } } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findMany({ limit: 10, with: { posts: { limit: 5, with: { comments: true } } } }) },
  ]);

  // 4. findUnique by PK
  await interleave('findUnique, single user by PK', [
    { name: 'Turbine', fn: () => turbine.users.findUnique({ where: { id: 1 } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findUnique({ where: { id: BigInt(1) } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, 1) }) },
    { name: 'Raw', fn: () => rawPool.query('SELECT * FROM users WHERE id = $1', [1]) },
  ]);

  // 5. findUnique nested L3
  await interleave('findUnique, user + posts + comments (L3)', [
    { name: 'Turbine', fn: () => turbine.users.findUnique({ where: { id: 1 }, with: { posts: { with: { comments: true } } } }) },
    { name: 'Prisma 7', fn: () => prisma.user.findUnique({ where: { id: BigInt(1) }, include: { posts: { include: { comments: true } } } }) },
    { name: 'Drizzle', fn: () => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, 1), with: { posts: { with: { comments: true } } } }) },
  ]);

  const driftMid = await driftProbe('mid');

  // 6. count
  await interleave('count, all users', [
    { name: 'Turbine', fn: () => turbine.users.count() },
    { name: 'Prisma 7', fn: () => prisma.user.count() },
    { name: 'Drizzle', fn: () => drizzleDb.select({ value: drizzleCount() }).from(schema.users) },
    { name: 'Raw', fn: () => rawPool.query('SELECT count(*) FROM users') },
  ]);

  // 7. streaming 50K
  const BATCH = 1000;
  await interleave(
    'stream, iterate 50K comments (batch 1000)',
    [
      {
        name: 'Turbine',
        fn: async () => {
          let n = 0;
          for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) n++;
          return n;
        },
      },
      {
        name: 'Prisma 7',
        fn: async () => {
          let n = 0;
          let cursor: { id: bigint } | undefined;
          for (;;) {
            const batch = await prisma.comment.findMany({
              take: BATCH,
              ...(cursor ? { cursor, skip: 1 } : {}),
              orderBy: { id: 'asc' },
            });
            if (batch.length === 0) break;
            n += batch.length;
            if (batch.length < BATCH) break;
            cursor = { id: batch[batch.length - 1]!.id };
          }
          return n;
        },
      },
      {
        name: 'Drizzle',
        fn: async () => {
          let n = 0;
          let lastId = 0;
          for (;;) {
            const batch = await drizzleDb
              .select()
              .from(schema.comments)
              .where(gt(schema.comments.id, lastId))
              .orderBy(asc(schema.comments.id))
              .limit(BATCH);
            if (batch.length === 0) break;
            for (const row of batch) {
              n++;
              lastId = row.id;
            }
            if (batch.length < BATCH) break;
          }
          return n;
        },
      },
      {
        name: 'Raw',
        fn: async () => {
          let n = 0;
          let lastId = 0;
          for (;;) {
            const res = await rawPool.query(
              'SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2',
              [lastId, BATCH],
            );
            if (res.rows.length === 0) break;
            for (const row of res.rows) {
              n++;
              lastId = Number(row.id);
            }
            if (res.rows.length < BATCH) break;
          }
          return n;
        },
      },
    ],
    STREAM_ROUNDS,
    1,
  );

  // 8. atomic increment
  await interleave('atomic increment, posts.view_count + 1', [
    { name: 'Turbine', fn: () => turbine.posts.update({ where: { id: 1 }, data: { viewCount: { increment: 1 } } }) },
    { name: 'Prisma 7', fn: () => prisma.post.update({ where: { id: BigInt(1) }, data: { viewCount: { increment: 1 } } }) },
    { name: 'Drizzle', fn: () => drizzleDb.update(schema.posts).set({ viewCount: sql`${schema.posts.viewCount} + 1` }).where(eq(schema.posts.id, 1)) },
    { name: 'Raw', fn: () => rawPool.query('UPDATE posts SET view_count = view_count + 1 WHERE id = $1', [1]) },
  ]);

  // 9. pipeline 5-query dashboard batch
  await interleave('pipeline, 5-query dashboard batch', [
    {
      name: 'Turbine',
      fn: () =>
        turbine.pipeline(
          turbine.users.buildFindUnique({ where: { id: 1 } }),
          turbine.posts.buildCount({ where: { userId: 1 } }),
          turbine.comments.buildCount({ where: { userId: 1 } }),
          turbine.posts.buildFindMany({ where: { userId: 1 }, orderBy: { createdAt: 'desc' }, limit: 5 }),
          turbine.users.buildCount(),
        ),
    },
    {
      name: 'Prisma 7',
      fn: () =>
        prisma.$transaction([
          prisma.user.findUnique({ where: { id: BigInt(1) } }),
          prisma.post.count({ where: { userId: BigInt(1) } }),
          prisma.comment.count({ where: { userId: BigInt(1) } }),
          prisma.post.findMany({ where: { userId: BigInt(1) }, orderBy: { createdAt: 'desc' }, take: 5 }),
          prisma.user.count(),
        ]),
    },
    {
      name: 'Drizzle',
      fn: () =>
        drizzleDb.transaction(async (tx) => [
          await tx.query.users.findFirst({ where: eq(schema.users.id, 1) }),
          await tx.select({ v: drizzleCount() }).from(schema.posts).where(eq(schema.posts.userId, 1)),
          await tx.select({ v: drizzleCount() }).from(schema.comments).where(eq(schema.comments.userId, 1)),
          await tx.query.posts.findMany({ where: eq(schema.posts.userId, 1), limit: 5 }),
          await tx.select({ v: drizzleCount() }).from(schema.users),
        ]),
    },
    {
      name: 'Raw',
      fn: async () => {
        const client = await rawPool.connect();
        try {
          await client.query('SELECT * FROM users WHERE id = $1', [1]);
          await client.query('SELECT count(*) FROM posts WHERE user_id = $1', [1]);
          await client.query('SELECT count(*) FROM comments WHERE user_id = $1', [1]);
          await client.query('SELECT * FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5', [1]);
          await client.query('SELECT count(*) FROM users');
        } finally {
          client.release();
        }
      },
    },
  ]);

  // 10. hot findUnique, rotating ids
  await interleave('hot findUnique, rotating IDs', [
    { name: 'Turbine', fn: (i) => turbine.users.findUnique({ where: { id: (i % 50) + 1 } }) },
    { name: 'Prisma 7', fn: (i) => prisma.user.findUnique({ where: { id: BigInt((i % 50) + 1) } }) },
    { name: 'Drizzle', fn: (i) => drizzleDb.query.users.findFirst({ where: eq(schema.users.id, (i % 50) + 1) }) },
    { name: 'Raw', fn: (i) => rawPool.query('SELECT * FROM users WHERE id = $1', [(i % 50) + 1]) },
  ]);

  const driftTail = await driftProbe('tail');
  const probes = [driftHead, driftMid, driftTail];
  const driftPct = ((Math.max(...probes) - Math.min(...probes)) / Math.min(...probes)) * 100;
  console.log(
    `\n[drift floor] SELECT 1 median head ${driftHead.toFixed(4)} / mid ${driftMid.toFixed(4)} / tail ${driftTail.toFixed(4)} ms = ${driftPct.toFixed(1)}% spread over the suite`,
  );

  // Machine-readable dump for the writeup.
  console.log('\n=== JSON ===');
  console.log(JSON.stringify({ driftHead, driftMid, driftTail, results: allResults }, null, 2));

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
