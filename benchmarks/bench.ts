/**
 * Turbine ORM Benchmark — vs Prisma 7 & Drizzle v2
 *
 * Setup:
 *   cd benchmarks
 *   npm install
 *   npx prisma generate
 *   DATABASE_URL=postgres://localhost:5432/turbine_bench npx tsx bench.ts
 *
 * Options (env vars):
 *   ITERATIONS=200   Number of measured iterations per scenario
 *   WARMUP=20        Warmup iterations (not measured)
 *   DATABASE_URL     PostgreSQL connection string
 */

import pg from 'pg';

// ─── Turbine ────────────────────────────────────────────────
import { TurbineClient } from '../generated/turbine/index.js';

// ─── Prisma ─────────────────────────────────────────────────
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

// ─── Drizzle ────────────────────────────────────────────────
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, count as drizzleCount, gt, asc, sql } from 'drizzle-orm';
import * as schema from './schema.js';

// ─── Config ─────────────────────────────────────────────────

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';
const ITERATIONS = parseInt(process.env['ITERATIONS'] ?? '200', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '20', 10);

// ─── Measurement helpers ────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const i = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, i)]!;
}

interface BenchResult {
  orm: string;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  ops: number;
}

async function measure(orm: string, fn: () => Promise<unknown>): Promise<BenchResult> {
  // Warmup — primes connection pools and query plan caches
  for (let i = 0; i < WARMUP; i++) await fn();

  // Collect samples
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;

  return {
    orm,
    avg,
    p50: percentile(sorted, 0.50),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    ops: 1000 / avg,
  };
}

// ─── Output formatting ─────────────────────────────────────

const allResults: { scenario: string; results: BenchResult[] }[] = [];

function printScenario(scenario: string, results: BenchResult[]) {
  allResults.push({ scenario, results });

  console.log(`\n── ${scenario} ──`);
  const top = '┌────────────┬──────────┬──────────┬──────────┬──────────┬──────────┐';
  const hdr = '│ ORM        │ avg (ms) │ p50 (ms) │ p95 (ms) │ p99 (ms) │  ops/sec │';
  const sep = '├────────────┼──────────┼──────────┼──────────┼──────────┼──────────┤';
  const bot = '└────────────┴──────────┴──────────┴──────────┴──────────┴──────────┘';

  console.log(top);
  console.log(hdr);
  console.log(sep);

  for (const r of results) {
    const pad = (n: number) => n.toFixed(2).padStart(8);
    console.log(
      `│ ${r.orm.padEnd(10)} │ ${pad(r.avg)} │ ${pad(r.p50)} │ ${pad(r.p95)} │ ${pad(r.p99)} │ ${pad(r.ops)} │`,
    );
  }
  console.log(bot);

  const fastest = results.reduce((a, b) => (a.avg < b.avg ? a : b));
  for (const r of results) {
    if (r === fastest) {
      console.log(`  ★ ${r.orm} — fastest`);
    } else {
      console.log(`    ${r.orm} — ${(r.avg / fastest.avg).toFixed(2)}x slower`);
    }
  }
}

function printMarkdownSummary() {
  console.log('\n\n═══ Markdown summary (for README) ═══\n');
  console.log('| Scenario | Turbine | Prisma 7 | Drizzle v2 |');
  console.log('|----------|---------|----------|------------|');
  for (const { scenario, results } of allResults) {
    const cells = ['Turbine', 'Prisma 7', 'Drizzle'].map((name) => {
      const r = results.find((r) => r.orm === name);
      return r ? `${r.avg.toFixed(2)} ms` : 'N/A';
    });
    console.log(`| ${scenario} | ${cells.join(' | ')} |`);
  }
  console.log('\n| Scenario | Turbine | Prisma 7 | Drizzle v2 |');
  console.log('|----------|---------|----------|------------|');
  for (const { scenario, results } of allResults) {
    const fastest = results.reduce((a, b) => (a.avg < b.avg ? a : b));
    const cells = ['Turbine', 'Prisma 7', 'Drizzle'].map((name) => {
      const r = results.find((r) => r.orm === name);
      if (!r) return 'N/A';
      if (r === fastest) return '**1.00x**';
      return `${(r.avg / fastest.avg).toFixed(2)}x`;
    });
    console.log(`| ${scenario} | ${cells.join(' | ')} |`);
  }
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Turbine ORM Benchmark — vs Prisma 7 & Drizzle v2          ║');
  console.log(`║  Iterations: ${String(ITERATIONS).padEnd(4)} │ Warmup: ${String(WARMUP).padEnd(4)}                        ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // ── Setup ORMs ──────────────────────────────────────────────

  console.log('\nConnecting...');

  // Turbine — uses its own internal pg.Pool
  const turbine = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await turbine.connect();

  // Prisma 7 — adapter-pg pattern (no more Rust binary engine)
  const prismaPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const prismaAdapter = new PrismaPg(prismaPool);
  const prisma = new PrismaClient({ adapter: prismaAdapter });

  // Drizzle — node-postgres driver with relational schema
  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const drizzleDb = drizzle(drizzlePool, { schema });

  // Verify data
  const userCount = await turbine.users.count();
  const postCount = await turbine.posts.count();
  const commentCount = await turbine.comments.count();
  console.log(`Data: ${userCount} users, ${postCount} posts, ${commentCount} comments`);
  console.log(`Node ${process.version} | ${ITERATIONS} iterations | ${WARMUP} warmup\n`);

  // ── Scenario 1: findMany flat ─────────────────────────────

  {
    const results = [
      await measure('Turbine', () => turbine.users.findMany({ limit: 100 })),
      await measure('Prisma 7', () => prisma.user.findMany({ take: 100 })),
      await measure('Drizzle', () => drizzleDb.query.users.findMany({ limit: 100 })),
    ];
    printScenario('findMany — 100 users (flat)', results);
  }

  // ── Scenario 2: findMany L2 (users + posts) ──────────────

  {
    const results = [
      await measure('Turbine', () =>
        turbine.users.findMany({ limit: 50, with: { posts: true } }),
      ),
      await measure('Prisma 7', () =>
        prisma.user.findMany({ take: 50, include: { posts: true } }),
      ),
      await measure('Drizzle', () =>
        drizzleDb.query.users.findMany({ limit: 50, with: { posts: true } }),
      ),
    ];
    printScenario('findMany — 50 users + posts (L2 nested)', results);
  }

  // ── Scenario 3: findMany L3 (users + posts + comments) ───

  {
    const results = [
      await measure('Turbine', () =>
        turbine.users.findMany({
          limit: 10,
          with: { posts: { with: { comments: true }, limit: 5 } },
        }),
      ),
      await measure('Prisma 7', () =>
        prisma.user.findMany({
          take: 10,
          include: { posts: { take: 5, include: { comments: true } } },
        }),
      ),
      await measure('Drizzle', () =>
        drizzleDb.query.users.findMany({
          limit: 10,
          with: { posts: { limit: 5, with: { comments: true } } },
        }),
      ),
    ];
    printScenario('findMany — 10 users → posts → comments (L3 nested)', results);
  }

  // ── Scenario 4: findUnique by PK ─────────────────────────

  {
    const results = [
      await measure('Turbine', () => turbine.users.findUnique({ where: { id: 1 } })),
      await measure('Prisma 7', () => prisma.user.findUnique({ where: { id: BigInt(1) } })),
      await measure('Drizzle', () =>
        drizzleDb.query.users.findFirst({ where: eq(schema.users.id, 1) }),
      ),
    ];
    printScenario('findUnique — single user by PK', results);
  }

  // ── Scenario 5: findUnique nested ────────────────────────

  {
    const results = [
      await measure('Turbine', () =>
        turbine.users.findUnique({
          where: { id: 1 },
          with: { posts: { with: { comments: true } } },
        }),
      ),
      await measure('Prisma 7', () =>
        prisma.user.findUnique({
          where: { id: BigInt(1) },
          include: { posts: { include: { comments: true } } },
        }),
      ),
      await measure('Drizzle', () =>
        drizzleDb.query.users.findFirst({
          where: eq(schema.users.id, 1),
          with: { posts: { with: { comments: true } } },
        }),
      ),
    ];
    printScenario('findUnique — user + posts + comments (L3)', results);
  }

  // ── Scenario 6: count ────────────────────────────────────

  {
    const results = [
      await measure('Turbine', () => turbine.users.count()),
      await measure('Prisma 7', () => prisma.user.count()),
      await measure('Drizzle', () =>
        drizzleDb.select({ value: drizzleCount() }).from(schema.users),
      ),
    ];
    printScenario('count — all users', results);
  }

  // ── Scenario 7: streaming 50K rows ───────────────────────
  //
  // Iterate every row in the comments table (50K rows, ~4 MB raw text).
  // Turbine uses its native server-side cursor (`findManyStream` →
  // DECLARE CURSOR + FETCH). Prisma and Drizzle have no native stream,
  // so the closest fair comparison is keyset pagination in a loop.
  //
  // Measured: wall-clock ms to drain the entire set. Not iterated via
  // `measure()` because the work per call is ~1 second — we do 3 runs
  // and take the median.

  {
    const BATCH = 1000;

    async function turbineStream(): Promise<number> {
      let n = 0;
      for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) {
        n++;
      }
      return n;
    }

    async function prismaStream(): Promise<number> {
      let n = 0;
      let cursor: { id: bigint } | undefined;
      while (true) {
        const batch = await prisma.comment.findMany({
          take: BATCH,
          ...(cursor ? { cursor, skip: 1 } : {}),
          orderBy: { id: 'asc' },
        });
        if (batch.length === 0) break;
        for (const _c of batch) n++;
        if (batch.length < BATCH) break;
        cursor = { id: batch[batch.length - 1]!.id };
      }
      return n;
    }

    async function drizzleStream(): Promise<number> {
      let n = 0;
      let lastId = 0;
      while (true) {
        const batch = await drizzleDb
          .select()
          .from(schema.comments)
          .where(gt(schema.comments.id, lastId))
          .orderBy(asc(schema.comments.id))
          .limit(BATCH);
        if (batch.length === 0) break;
        for (const c of batch) {
          n++;
          lastId = c.id;
        }
        if (batch.length < BATCH) break;
      }
      return n;
    }

    async function runStreamed(name: string, fn: () => Promise<number>): Promise<BenchResult> {
      // Warmup once so connection is hot
      await fn();
      const samples: number[] = [];
      for (let i = 0; i < 3; i++) {
        const start = performance.now();
        const n = await fn();
        const ms = performance.now() - start;
        samples.push(ms);
        if (i === 0) console.log(`  ${name}: drained ${n} rows`);
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
      return {
        orm: name,
        avg,
        p50: sorted[1]!,
        p95: sorted[2]!,
        p99: sorted[2]!,
        min: sorted[0]!,
        max: sorted[2]!,
        ops: 1000 / avg,
      };
    }

    const results = [
      await runStreamed('Turbine', turbineStream),
      await runStreamed('Prisma 7', prismaStream),
      await runStreamed('Drizzle', drizzleStream),
    ];
    printScenario('stream — iterate 50K comments (batch 1000)', results);
  }

  // ── Scenario 8: atomic counter ───────────────────────────
  //
  // Atomic `view_count + 1` on a single row. All three ORMs support this
  // without dropping to raw SQL; the point of the scenario isn't a perf
  // duel, it's to confirm each ORM actually issues a single UPDATE with
  // a column-reference rather than a read-modify-write round-trip.

  {
    const TARGET_POST_ID = 1;
    const results = [
      await measure('Turbine', () =>
        turbine.posts.update({
          where: { id: TARGET_POST_ID },
          data: { viewCount: { increment: 1 } },
        }),
      ),
      await measure('Prisma 7', () =>
        prisma.post.update({
          where: { id: BigInt(TARGET_POST_ID) },
          data: { viewCount: { increment: 1 } },
        }),
      ),
      await measure('Drizzle', () =>
        drizzleDb
          .update(schema.posts)
          .set({ viewCount: sql`${schema.posts.viewCount} + 1` })
          .where(eq(schema.posts.id, TARGET_POST_ID)),
      ),
    ];
    printScenario('atomic increment — posts.view_count + 1', results);
  }

  // ── Summary ──────────────────────────────────────────────

  printMarkdownSummary();

  // ── Cleanup ──────────────────────────────────────────────

  await turbine.disconnect();
  await prisma.$disconnect();
  await drizzlePool.end();
  await prismaPool.end();

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nBenchmark error:', err);
  process.exit(1);
});
