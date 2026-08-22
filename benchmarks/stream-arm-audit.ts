/**
 * Stream-arm audit: are the streaming arms in `bench-interleaved.ts` doing the
 * same work?
 *
 * This file times NOTHING. It exists because a 17% gap between two arms is only
 * a result if the arms are comparable, and the only way to know that is to look
 * at what each one puts on the wire. It answers three questions with evidence
 * rather than with reasoning about the source:
 *
 *   (a) Which Turbine API does the stream arm call? The repo ships two
 *       (`findManyStream` yields rows, `findManyStreamBatches` yields `T[]`)
 *       and the harness picks between them from an env var, so the default is
 *       a fact about the harness and not about Turbine.
 *   (b) Does each competitor arm use a server-side CURSOR, or does it page with
 *       keyset pagination, or does it materialise the whole result? These have
 *       different round-trip counts, different SQL, and different peak memory,
 *       and only the first is what Turbine's stream does.
 *   (c) Do the arms decode the same rows: same count, same columns, same
 *       runtime types?
 *
 * Every arm's pool is wrapped so that each statement it issues is recorded
 * verbatim. `pg.Pool.query` is the single funnel for all four arms (Turbine,
 * Prisma via PrismaPg, Drizzle, Drizzle RC and the raw control all sit on a
 * `pg.Pool`), so nothing reaches the server unseen.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx stream-arm-audit.ts
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { gt, asc } from 'drizzle-orm';
import * as schema from './schema.js';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import { gt as rcGt, asc as rcAsc } from 'drizzle-rc';
import * as rcSchema from './schema-rc.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench?host=/tmp';
const BATCH = 1000;

/** One statement as it went to the server. */
interface Stmt {
  text: string;
  rows: number;
}

/**
 * Wire recorder. Wraps `query` on a live pool AND on every connection the pool
 * hands out, because a cursor drain does not go through `pool.query` at all: it
 * checks a client out and issues BEGIN / DECLARE / FETCH on that client
 * directly. Recording only the pool would have shown the cursor arm issuing
 * zero statements, which is exactly the kind of missing evidence that makes an
 * audit worse than none.
 */
class WireLog {
  readonly stmts: Stmt[] = [];
  private recording = false;
  /**
   * Re-entrancy depth. `pool.query` is NOT a peer of `client.query`, it is
   * implemented ON TOP of it: pg checks a connection out and calls
   * `client.query` internally. With both wrapped, every pool-routed statement
   * was recorded twice, which inflated each keyset arm's 51 statements to 102
   * and Turbine's 56 to 57 (only its speculative fetch goes through the pool;
   * the cursor drain talks to a checked-out client directly, so it was NOT
   * doubled and the two errors did not even scale together). Counting the
   * OUTERMOST call only reports what the arm issued.
   */
  private depth = 0;

  attach(pool: pg.Pool): void {
    const self = this;
    const origQuery = pool.query.bind(pool);
    // biome-ignore lint/suspicious/noExplicitAny: pg's query() has 6 overloads; the audit wrapper is intentionally signature-agnostic.
    (pool as any).query = async (...args: any[]) => {
      self.depth++;
      try {
        const res = await (origQuery as any)(...args);
        self.record(args[0], res, 1);
        return res;
      } finally {
        self.depth--;
      }
    };

    const origConnect = pool.connect.bind(pool);
    // biome-ignore lint/suspicious/noExplicitAny: same reason as above.
    const audit = (client: any) => {
      if (!client || client.__audited) return client;
      client.__audited = true;
      const cq = client.query.bind(client);
      // biome-ignore lint/suspicious/noExplicitAny: signature-agnostic wrapper.
      client.query = async (...qargs: any[]) => {
        const res = await cq(...qargs);
        // depth > 0 means an enclosing `pool.query` already recorded this.
        self.record(qargs[0], res, 0);
        return res;
      };
      return client;
    };
    // `connect` has BOTH a promise form and a callback form, and pg's own
    // internals use the callback one. Wrapping only the promise form returned
    // `undefined` to those callers and crashed the pool, so both are handled.
    // biome-ignore lint/suspicious/noExplicitAny: same reason as above.
    (pool as any).connect = (...args: any[]) => {
      if (typeof args[0] === 'function') {
        const cb = args[0];
        return (origConnect as any)((err: unknown, client: any, release: unknown) =>
          cb(err, audit(client), release),
        );
      }
      return (origConnect as any)(...args).then(audit);
    };
  }

  private record(arg0: unknown, res: unknown, allowedDepth: number): void {
    if (!this.recording) return;
    if (this.depth !== allowedDepth) return;
    const text =
      typeof arg0 === 'string' ? arg0 : ((arg0 as { text?: string } | null)?.text ?? String(arg0));
    const rows = (res as { rows?: unknown[] } | null)?.rows?.length ?? 0;
    this.stmts.push({ text, rows });
  }

  start(): void {
    this.stmts.length = 0;
    this.recording = true;
  }

  stop(): Stmt[] {
    this.recording = false;
    return [...this.stmts];
  }
}

/** Collapse repeated identical statements so a 50-round-trip drain prints as one line. */
function summarize(stmts: Stmt[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < stmts.length) {
    const text = stmts[i]!.text;
    let j = i;
    let rows = 0;
    while (j < stmts.length && stmts[j]!.text === text) {
      rows += stmts[j]!.rows;
      j++;
    }
    const n = j - i;
    const oneLine = text.replace(/\s+/g, ' ').trim();
    const shown = oneLine.length > 150 ? `${oneLine.slice(0, 150)}...` : oneLine;
    out.push(`    ${String(n).padStart(3)}x [${String(rows).padStart(6)} rows]  ${shown}`);
    i = j;
  }
  return out;
}

/** Deep-ish runtime type signature of a row, so two arms' shapes can be diffed. */
function shapeOf(row: Record<string, unknown>): string {
  return Object.keys(row)
    .sort()
    .map((k) => {
      const v = row[k];
      const t =
        v === null
          ? 'null'
          : v instanceof Date
            ? 'Date'
            : Array.isArray(v)
              ? 'array'
              : typeof v;
      return `${k}:${t}`;
    })
    .join(', ');
}

interface ArmResult {
  name: string;
  rows: number;
  firstShape: string;
  peakHeapMb: number;
  stmts: Stmt[];
  sampleRow: Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log('='.repeat(100));
  console.log('STREAM ARM AUDIT, no timings, wire traffic and row shapes only');
  console.log(`Node ${process.version}  DATABASE_URL=${DATABASE_URL}`);
  console.log('='.repeat(100));

  const turbineLog = new WireLog();
  const prismaLog = new WireLog();
  const drizzleLog = new WireLog();
  const rcLog = new WireLog();
  const rawLog = new WireLog();

  const turbine = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await turbine.connect();
  // Turbine owns its pool internally; reach it the same way the client does.
  turbineLog.attach((turbine as unknown as { pool: pg.Pool }).pool);

  const prismaPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  prismaLog.attach(prismaPool);
  const prisma = new PrismaClient({ adapter: new PrismaPg(prismaPool) });

  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  drizzleLog.attach(drizzlePool);
  const drizzleDb = drizzle(drizzlePool, { schema });

  const rcPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  rcLog.attach(rcPool);
  const rcDb = drizzleRc({ client: rcPool, relations: rcSchema.relations, jit: true });

  const rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  rawLog.attach(rawPool);

  const results: ArmResult[] = [];

  /**
   * Peak heap is sampled at every batch boundary rather than only at the end.
   * The question it answers is "does this arm ever HOLD 50,000 rows", and an
   * arm that materialises and then drops them would look identical to a
   * streaming one if only the final value were read.
   */
  async function runArm(
    name: string,
    log: WireLog,
    drain: (onBatch: () => void, keep: (r: Record<string, unknown>) => void) => Promise<number>,
  ): Promise<void> {
    global.gc?.();
    await new Promise((r) => setTimeout(r, 50));
    const baseHeap = process.memoryUsage().heapUsed;
    let peak = baseHeap;
    let first: Record<string, unknown> | undefined;
    log.start();
    const n = await drain(
      () => {
        const h = process.memoryUsage().heapUsed;
        if (h > peak) peak = h;
      },
      (r) => {
        if (first === undefined) first = r;
      },
    );
    const stmts = log.stop();
    results.push({
      name,
      rows: n,
      firstShape: first ? shapeOf(first) : '(no rows)',
      peakHeapMb: (peak - baseHeap) / 1024 / 1024,
      stmts,
      sampleRow: first ?? {},
    });
  }

  // --- Turbine, per-row API (what the harness runs by DEFAULT) ---
  await runArm('Turbine findManyStream', turbineLog, async (onBatch, keep) => {
    let n = 0;
    for await (const c of turbine.comments.findManyStream({ batchSize: BATCH })) {
      keep(c as unknown as Record<string, unknown>);
      n++;
      if (n % BATCH === 0) onBatch();
    }
    return n;
  });

  // --- Turbine, batch API ---
  await runArm('Turbine findManyStreamBatches', turbineLog, async (onBatch, keep) => {
    let n = 0;
    for await (const batch of turbine.comments.findManyStreamBatches({ batchSize: BATCH })) {
      onBatch();
      for (const c of batch) {
        keep(c as unknown as Record<string, unknown>);
        n++;
      }
    }
    return n;
  });

  // --- Prisma 7 keyset ---
  await runArm('Prisma 7', prismaLog, async (onBatch, keep) => {
    let n = 0;
    let cursor: { id: bigint } | undefined;
    for (;;) {
      const batch = await prisma.comment.findMany({
        take: BATCH,
        ...(cursor ? { cursor, skip: 1 } : {}),
        orderBy: { id: 'asc' },
      });
      onBatch();
      if (batch.length === 0) break;
      for (const r of batch) keep(r as unknown as Record<string, unknown>);
      n += batch.length;
      if (batch.length < BATCH) break;
      cursor = { id: batch[batch.length - 1]!.id };
    }
    return n;
  });

  // --- Drizzle 0.45.2 keyset ---
  await runArm('Drizzle 0.45.2', drizzleLog, async (onBatch, keep) => {
    let n = 0;
    let lastId = 0;
    for (;;) {
      const batch = await drizzleDb
        .select()
        .from(schema.comments)
        .where(gt(schema.comments.id, lastId))
        .orderBy(asc(schema.comments.id))
        .limit(BATCH);
      onBatch();
      if (batch.length === 0) break;
      for (const row of batch) {
        keep(row as unknown as Record<string, unknown>);
        n++;
        lastId = row.id;
      }
      if (batch.length < BATCH) break;
    }
    return n;
  });

  // --- Drizzle 1.0.0-rc.4 (jit) keyset ---
  await runArm('Drizzle RC jit', rcLog, async (onBatch, keep) => {
    let n = 0;
    let lastId = 0;
    for (;;) {
      const batch = await rcDb
        .select()
        .from(rcSchema.comments)
        .where(rcGt(rcSchema.comments.id, lastId))
        .orderBy(rcAsc(rcSchema.comments.id))
        .limit(BATCH);
      onBatch();
      if (batch.length === 0) break;
      for (const row of batch) {
        keep(row as unknown as Record<string, unknown>);
        n++;
        lastId = row.id;
      }
      if (batch.length < BATCH) break;
    }
    return n;
  });

  // --- Raw pg keyset ---
  await runArm('Raw pg keyset', rawLog, async (onBatch, keep) => {
    let n = 0;
    let lastId = 0;
    for (;;) {
      const res = await rawPool.query(
        'SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2',
        [lastId, BATCH],
      );
      onBatch();
      if (res.rows.length === 0) break;
      for (const row of res.rows) {
        keep(row as Record<string, unknown>);
        n++;
        lastId = Number(row.id);
      }
      if (res.rows.length < BATCH) break;
    }
    return n;
  });

  // ---------------------------------------------------------------- report
  console.log('\n\n### (a)+(b) WIRE TRAFFIC PER ARM\n');
  for (const r of results) {
    console.log(`  ${r.name}`);
    console.log(`    statements issued: ${r.stmts.length}`);
    for (const line of summarize(r.stmts)) console.log(line);
    console.log('');
  }

  console.log('\n### (c) ROW COUNTS, SHAPES, PEAK HEAP\n');
  console.log(
    `  ${'arm'.padEnd(30)} ${'rows'.padStart(7)} ${'stmts'.padStart(6)} ${'peak heap MB'.padStart(13)}`,
  );
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(30)} ${String(r.rows).padStart(7)} ${String(r.stmts.length).padStart(6)} ${r.peakHeapMb.toFixed(1).padStart(13)}`,
    );
  }

  console.log('\n  row shapes (runtime types of the first row):');
  for (const r of results) {
    console.log(`    ${r.name.padEnd(30)} ${r.firstShape}`);
  }

  const shapes = new Set(results.map((r) => r.firstShape));
  const counts = new Set(results.map((r) => r.rows));
  console.log('');
  console.log(`  distinct row counts across arms: ${[...counts].join(', ')} ${counts.size === 1 ? 'IDENTICAL' : 'DIFFER'}`);
  console.log(`  distinct row shapes across arms: ${shapes.size} ${shapes.size === 1 ? 'IDENTICAL' : 'DIFFER'}`);

  console.log('\n  sample row per arm (first row, JSON):');
  for (const r of results) {
    console.log(
      `    ${r.name.padEnd(30)} ${JSON.stringify(r.sampleRow, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)).slice(0, 160)}`,
    );
  }

  await turbine.disconnect();
  await prisma.$disconnect();
  await prismaPool.end();
  await drizzlePool.end();
  await rcPool.end();
  await rawPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
