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
import { eq, count as drizzleCount } from 'drizzle-orm';
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
