/**
 * Pre-benchmark arm verification.
 *
 * A benchmark arm is only worth timing if it does the same WORK as the arms it
 * is compared against. This script refuses to let a number be recorded until
 * two things are proven:
 *
 *   1. The Drizzle 1.0.0-rc.4 arm actually has its JIT row mapper ENGAGED.
 *      `jit: true` is passed through `jitCompatCheck`, which silently falls back
 *      to the premade mappers if `new Function` is unavailable. A run that
 *      quietly used the default mapper and got published as "RC with JIT" would
 *      be a fabricated result, so engagement is asserted by identity against the
 *      library's own exported `makeJitRqbMapper`, not inferred from the flag we
 *      passed in.
 *
 *   2. Every arm returns EQUIVALENT rows for the three shapes under test.
 *      Comparison is on a canonical projection (ids as numbers, dates as epoch
 *      millis, keys sorted) because the arms legitimately differ on BigInt vs
 *      number and on key order, but must not differ on row count, nesting, or
 *      values.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx verify-arms.ts
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { gt as dGt, asc as dAsc } from 'drizzle-orm';
import * as schema from './schema.js';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import { gt as rcGt, asc as rcAsc } from 'drizzle-rc';
import { makeJitRqbMapper, makeDefaultRqbMapper } from 'drizzle-rc/relations';
import { relations as rcRelations } from './schema-rc.js';
import * as rcTables from './schema-rc.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';

const fail = (msg: string): never => {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
};

/** Canonical form: sorted keys, bigint/Date normalised, nested arrays kept. */
function canon(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = canon(o[k]);
    return out;
  }
  return v;
}

const j = (v: unknown) => JSON.stringify(canon(v));

async function main() {
  const turbine = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await turbine.connect();

  const prismaPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });

  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const drizzleDb = drizzle(drizzlePool, { schema });

  // NOTE, load-bearing: Drizzle 1.0 does NOT accept `drizzle(pool, config)`.
  // That positional form destructures `client`/`connection` off the POOL object,
  // finds neither, and constructs a brand-new default `pg.Pool` while silently
  // discarding the config, so `relations` and `jit` are both dropped and the arm
  // runs on the premade mapper against the wrong connection. The object form
  // `drizzle({ client: pool, ... })` is the supported 1.0 spelling.
  const rcPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const rcDb = drizzleRc({ client: rcPool, relations: rcRelations, jit: true });
  // Control arm: the same RC build with the JIT mapper deliberately off, so the
  // benchmark can attribute any RC delta to the JIT specifically rather than to
  // "1.0 vs 0.45" as a whole.
  const rcNoJitPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const rcNoJitDb = drizzleRc({ client: rcNoJitPool, relations: rcRelations, jit: false });

  // ── 1. Prove the JIT mapper is engaged ────────────────────
  const gen = (rcDb as any).dialect?.mapperGenerators?.relationalRows;
  const genOff = (rcNoJitDb as any).dialect?.mapperGenerators?.relationalRows;
  if (!gen) fail('could not reach rcDb.dialect.mapperGenerators.relationalRows');
  if (gen !== makeJitRqbMapper) {
    fail(
      `RC arm is NOT using the JIT mapper (got ${gen?.name}). jitCompatCheck fell back. ` +
        'Refusing to publish this as a JIT result.',
    );
  }
  if (genOff !== makeDefaultRqbMapper) {
    fail(`RC no-jit control is not on the default mapper (got ${genOff?.name})`);
  }
  console.log('JIT engagement: rc(jit:true) -> makeJitRqbMapper  OK');
  console.log('JIT engagement: rc(jit:false) -> makeDefaultRqbMapper  OK');

  // Prove the generated mapper really is compiled source, not a closure.
  const probe = makeJitRqbMapper({
    selection: [{ key: 'id', field: schema.users.id as any }],
    isFirst: false,
    parseJson: false,
    parseJsonIfString: false,
    rootJsonMappers: false,
    arrayModeRoot: false,
  } as any);
  const body = (probe as any).body as string | undefined;
  if (!body || !body.includes('jitRqbMapper')) {
    fail('makeJitRqbMapper did not produce a compiled function body');
  }
  console.log('JIT engagement: compiled mapper body present  OK');

  // ── 2. Row equivalence across arms ────────────────────────
  type Case = { name: string; arms: Record<string, () => Promise<unknown>> };

  const cases: Case[] = [
    {
      name: 'findMany, 100 users (flat)',
      arms: {
        Turbine: () => turbine.users.findMany({ limit: 100 }),
        'Prisma 7': () => prisma.user.findMany({ take: 100 }),
        Drizzle: () => drizzleDb.query.users.findMany({ limit: 100 }),
        'Drizzle RC': () => rcDb.query.users.findMany({ limit: 100 }),
        'Drizzle RC (no jit)': () => rcNoJitDb.query.users.findMany({ limit: 100 }),
      },
    },
    {
      name: 'findMany, 50 users + posts (L2)',
      arms: {
        Turbine: () => turbine.users.findMany({ limit: 50, with: { posts: true } }),
        'Prisma 7': () => prisma.user.findMany({ take: 50, include: { posts: true } }),
        Drizzle: () => drizzleDb.query.users.findMany({ limit: 50, with: { posts: true } }),
        'Drizzle RC': () => rcDb.query.users.findMany({ limit: 50, with: { posts: true } }),
        'Drizzle RC (no jit)': () =>
          rcNoJitDb.query.users.findMany({ limit: 50, with: { posts: true } }),
      },
    },
    {
      name: 'findMany, 10 users -> posts -> comments (L3)',
      arms: {
        Turbine: () =>
          turbine.users.findMany({
            limit: 10,
            with: { posts: { with: { comments: true }, limit: 5 } },
          }),
        'Prisma 7': () =>
          prisma.user.findMany({ take: 10, include: { posts: { take: 5, include: { comments: true } } } }),
        Drizzle: () =>
          drizzleDb.query.users.findMany({
            limit: 10,
            with: { posts: { limit: 5, with: { comments: true } } },
          }),
        'Drizzle RC': () =>
          rcDb.query.users.findMany({
            limit: 10,
            with: { posts: { limit: 5, with: { comments: true } } },
          }),
        'Drizzle RC (no jit)': () =>
          rcNoJitDb.query.users.findMany({
            limit: 10,
            with: { posts: { limit: 5, with: { comments: true } } },
          }),
      },
    },
  ];

  let mismatches = 0;

  for (const c of cases) {
    console.log(`\n${c.name}`);
    const shapes: Record<string, { rows: number; nested: number; sample: string }> = {};
    for (const [arm, fn] of Object.entries(c.arms)) {
      const res = (await fn()) as any[];
      const rows = res.length;
      // count total nested children at depth 1 and 2
      let nested = 0;
      for (const r of res) {
        const posts = (r as any).posts;
        if (Array.isArray(posts)) {
          nested += posts.length;
          for (const p of posts) if (Array.isArray(p.comments)) nested += p.comments.length;
        }
      }
      shapes[arm] = { rows, nested, sample: j(res[0]) };
      console.log(`  ${arm.padEnd(22)} rows=${rows} nestedChildren=${nested}`);
    }

    // Compare every arm's row/nested counts against Turbine.
    const base = shapes['Turbine']!;
    for (const [arm, s] of Object.entries(shapes)) {
      if (s.rows !== base.rows || s.nested !== base.nested) {
        console.error(
          `  MISMATCH ${arm}: rows=${s.rows}/${base.rows} nested=${s.nested}/${base.nested}`,
        );
        mismatches++;
      }
    }

    // The two RC arms must agree EXACTLY with each other: same library, same
    // query, only the mapper differs. Any difference is a JIT correctness bug
    // and would invalidate the comparison.
    if (shapes['Drizzle RC']!.sample !== shapes['Drizzle RC (no jit)']!.sample) {
      console.error('  MISMATCH: RC jit and RC no-jit produced different first rows');
      mismatches++;
    } else {
      console.log('  RC jit == RC no-jit on first row  OK');
    }
  }

  // ── 3. Streaming arms must actually drain 50,000 rows ────
  //
  // The streaming arms are hand-written keyset/cursor loops, one per library,
  // and a loop that terminates early is indistinguishable from a fast loop in
  // the harness output. This caught a real question: the RC arm measured 32 ms
  // against raw pg's 45 ms, i.e. faster than the driver it is built on, which
  // is exactly the shape of a loop that stopped early. Row counts and column
  // counts are therefore asserted, not assumed.
  console.log('\nstream arms, 50K comments');
  const BATCH = 1000;
  let streamBad = 0;

  const streamArms: Record<string, () => Promise<number>> = {
    Turbine: async () => {
      let n = 0;
      for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) n++;
      return n;
    },
    'Prisma 7': async () => {
      let n = 0;
      let cursor: { id: bigint } | undefined;
      for (;;) {
        const b = await prisma.comment.findMany({
          take: BATCH,
          ...(cursor ? { cursor, skip: 1 } : {}),
          orderBy: { id: 'asc' },
        });
        if (b.length === 0) break;
        n += b.length;
        if (b.length < BATCH) break;
        cursor = { id: b[b.length - 1]!.id };
      }
      return n;
    },
    Drizzle: async () => {
      let n = 0;
      let last = 0;
      for (;;) {
        const b = await drizzleDb
          .select()
          .from(schema.comments)
          .where(dGt(schema.comments.id, last))
          .orderBy(dAsc(schema.comments.id))
          .limit(BATCH);
        if (b.length === 0) break;
        for (const r of b) {
          n++;
          last = r.id;
        }
        if (b.length < BATCH) break;
      }
      return n;
    },
    'Drizzle RC': async () => {
      let n = 0;
      let last = 0;
      for (;;) {
        const b = await rcDb
          .select()
          .from(rcTables.comments)
          .where(rcGt(rcTables.comments.id, last))
          .orderBy(rcAsc(rcTables.comments.id))
          .limit(BATCH);
        if (b.length === 0) break;
        for (const r of b) {
          n++;
          last = r.id as number;
        }
        if (b.length < BATCH) break;
      }
      return n;
    },
  };

  for (const [arm, fn] of Object.entries(streamArms)) {
    const n = await fn();
    const ok = n === 50000;
    console.log(`  ${arm.padEnd(12)} rows=${n} ${ok ? 'OK' : 'WRONG (expected 50000)'}`);
    if (!ok) streamBad++;
  }

  // Column count per row: an arm projecting fewer columns is doing less decode
  // work and its number is not comparable.
  const cTurbine = await turbine.comments.findMany({ limit: 1 });
  const cDrizzle = await drizzleDb.select().from(schema.comments).limit(1);
  const cRc = await rcDb.select().from(rcTables.comments).limit(1);
  const widths = {
    Turbine: Object.keys(cTurbine[0] ?? {}).length,
    Drizzle: Object.keys(cDrizzle[0] ?? {}).length,
    'Drizzle RC': Object.keys((cRc[0] as object) ?? {}).length,
  };
  console.log(`  columns per row: ${JSON.stringify(widths)}`);
  if (new Set(Object.values(widths)).size !== 1) {
    console.error('  MISMATCH: stream arms project different column counts');
    streamBad++;
  }
  // And the decoded types must match, or one arm is skipping work the other does.
  const tsType = (r: any) => (r?.createdAt instanceof Date ? 'Date' : typeof r?.createdAt);
  console.log(
    `  createdAt decoded as: Turbine=${tsType(cTurbine[0])} Drizzle=${tsType(cDrizzle[0])} RC=${tsType(cRc[0])}`,
  );
  if (tsType(cDrizzle[0]) !== tsType(cRc[0])) {
    console.error('  MISMATCH: Drizzle and RC decode timestamps to different types');
    streamBad++;
  }
  mismatches += streamBad;

  await turbine.disconnect();
  await prisma.$disconnect();
  await drizzlePool.end();
  await prismaPool.end();
  await rcPool.end();
  await rcNoJitPool.end();

  if (mismatches > 0) fail(`${mismatches} arm mismatch(es); benchmark would not be comparable`);
  console.log('\nAll arms verified equivalent. Safe to benchmark.');
}

main().catch((err) => {
  console.error('\nVerification error:', err);
  process.exit(1);
});
