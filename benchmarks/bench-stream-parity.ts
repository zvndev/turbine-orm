/**
 * The 50K streaming scenario, with BOTH Turbine spellings in the same rotation.
 *
 * WHY THIS EXISTS, and what it is correcting.
 *
 * `bench-interleaved.ts` runs ONE Turbine stream arm and picks which method it
 * calls from `TURBINE_STREAM`, defaulting to `findManyStream` (the per-row
 * API). Every competitor arm in that scenario, however, consumes ARRAYS: each
 * issues a keyset page, gets a materialised `T[]` of 1000 rows back, and walks
 * it with a plain synchronous `for` loop. So the default configuration compares
 * an arm that pays one generator suspension PER ROW against four arms that pay
 * one per THOUSAND rows, and reports the difference as Turbine being slower.
 *
 * That is a real API difference and worth knowing, but it is not the only
 * comparison worth publishing, and a suite that shows only the unflattering
 * half of it is not neutral. Turbine ships `findManyStreamBatches`, whose unit
 * of work is exactly the competitors': an array per page, walked synchronously.
 *
 * So this harness runs BOTH, in one rotation, against the same competitors, and
 * reports them side by side. Neither is "the" number; the pair is the result.
 *
 * WHAT THE ARMS ACTUALLY DO ON THE WIRE (measured, `stream-arm-audit.ts`):
 *
 *   Turbine       1 speculative `SELECT … LIMIT 1001` that is DISCARDED, then
 *                 BEGIN / DECLARE NO SCROLL CURSOR / 51x FETCH 1000 / CLOSE /
 *                 COMMIT. 56 statements, 51,001 rows decoded to yield 50,000,
 *                 one unordered sequential scan held open in a transaction.
 *   competitors   51x `SELECT … WHERE id > $1 ORDER BY id ASC LIMIT $2`.
 *                 51 statements, 50,000 rows decoded, an ordered index walk per
 *                 page, no transaction, no cursor.
 *
 * They are therefore NOT the same database work, in either direction: Turbine
 * pays 5 extra round trips and 1001 wasted row decodes, the competitors pay an
 * ORDER BY and 51 planner entries. This harness measures what each approach
 * costs end to end; it does not claim they are the same query.
 *
 * MEMORY IS REPORTED BECAUSE TIME ALONE WOULD MISLEAD. A cursor holds a
 * transaction open and streams at constant memory; keyset paging holds no
 * transaction but re-reads an index per page. Peak heap is sampled at every
 * page boundary, not just at the end, so an arm that materialises and then
 * drops cannot hide.
 *
 * Run (>= 3 times, medians only, per RESULTS-0.72.0.md's rule that a single
 * before/after on this machine proves nothing):
 *   DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx bench-stream-parity.ts
 *
 * Env:
 *   STREAM_ROUNDS=15  interleaved rounds
 *   WARMUP=2          warmup drains per arm
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import { gt, asc } from 'drizzle-orm';
import * as schema from './schema.js';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import { gt as rcGt, asc as rcAsc } from 'drizzle-rc';
import { makeJitRqbMapper } from 'drizzle-rc/relations';
import * as rcSchema from './schema-rc.js';
import { Bench } from './bench-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench?host=/tmp';
const ROUNDS = parseInt(process.env['STREAM_ROUNDS'] ?? '15', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '2', 10);
const BATCH = 1000;

/** Peak heap per arm, sampled at page boundaries during the timed drain. */
const peakHeap = new Map<string, number[]>();

/**
 * Per-round timings, recorded by the arms themselves so PAIRED deltas can be
 * computed.
 *
 * On a shared box, comparing two independently-computed medians is the weak
 * form: each median absorbs whatever the machine was doing during that arm's
 * samples, and the drift floor here reached 220% on a first run. A paired
 * delta subtracts the two arms WITHIN a round, where they are separated by
 * milliseconds rather than by the length of the suite, so a load spike that
 * hits the whole round cancels instead of landing on one arm. The median of
 * the per-round deltas is therefore reportable at noise levels where the
 * difference of the medians is not.
 *
 * `Bench.interleave` does not expose its samples, so the arms record their own.
 * Both clocks bracket exactly the same drain.
 */
const rounds = new Map<string, number[]>();

function timed<T>(arm: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  return fn().then((v) => {
    const list = rounds.get(arm) ?? [];
    list.push(performance.now() - t0);
    rounds.set(arm, list);
    return v;
  });
}

/**
 * Median of the per-round differences between two arms, with the fraction of
 * rounds in which `a` won. The win rate is reported because a median delta of
 * a few percent on a noisy box is only meaningful if it is CONSISTENT: a real
 * difference wins most rounds, a phantom one wins about half.
 */
function paired(a: string, b: string): { delta: number; pct: number; winRate: number } | undefined {
  const xa = rounds.get(a);
  const xb = rounds.get(b);
  if (!xa || !xb || xa.length !== xb.length || xa.length === 0) return undefined;
  const deltas = xa.map((v, i) => v - xb[i]!);
  const wins = deltas.filter((d) => d < 0).length;
  const mb = med(xb);
  return { delta: med(deltas), pct: (med(deltas) / mb) * 100, winRate: wins / deltas.length };
}

function sampler(arm: string): { onPage: () => void; done: () => void } {
  const base = process.memoryUsage().heapUsed;
  let peak = base;
  return {
    onPage: () => {
      const h = process.memoryUsage().heapUsed;
      if (h > peak) peak = h;
    },
    done: () => {
      const list = peakHeap.get(arm) ?? [];
      list.push((peak - base) / 1024 / 1024);
      peakHeap.set(arm, list);
    },
  };
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return Number.NaN;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

async function main(): Promise<void> {
  const bench = new Bench({ rounds: ROUNDS, warmup: WARMUP });
  console.log('='.repeat(96));
  console.log('50K STREAM PARITY, both Turbine spellings in one rotation');
  console.log(`ROUNDS=${ROUNDS} WARMUP=${WARMUP} BATCH=${BATCH} Node ${process.version}`);
  console.log('='.repeat(96));

  const turbine = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await turbine.connect();

  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const drizzleDb = drizzle(drizzlePool, { schema });

  const rcPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });
  const rcDb = drizzleRc({ client: rcPool, relations: rcSchema.relations, jit: true });

  const rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

  /**
   * The `T batches` drain, shared by the real arm and its negative control so
   * the two are the SAME CODE and not two copies that could drift apart. A
   * negative control written out twice would eventually stop being one.
   */
  const turbineBatchDrain = async (armName: string): Promise<number> => {
    const s = sampler(armName);
    let n = 0;
    for await (const batch of turbine.comments.findManyStreamBatches({ batchSize: BATCH })) {
      s.onPage();
      for (const _c of batch) n++;
    }
    s.done();
    return n;
  };

  /**
   * Assert the RC arm's JIT mapper really engaged. `drizzleRc(pool, config)`
   * silently discards the config (it destructures `client` off the pool, finds
   * nothing, and builds its own), so an arm labelled "jit" can quietly be
   * running the interpreted mapper. Same check `bench-interleaved.ts` makes,
   * for the same reason: an unverified arm label is how a suite comes to
   * publish a number for code it never ran.
   */
  const jitProbe = makeJitRqbMapper.toString();
  if (jitProbe.length < 20) {
    console.error('Could not verify the RC JIT mapper. Refusing to report numbers.');
    process.exit(1);
  }
  const rcRows = await rcDb.select().from(rcSchema.comments).limit(1);
  if (rcRows.length !== 1 || typeof rcRows[0]!.id !== 'number') {
    console.error('RC arm did not return the expected row shape. Refusing to report numbers.');
    process.exit(1);
  }
  console.log('RC arm: jit mapper present, row shape verified.\n');

  const driftHead = await bench.driftProbe(rawPool, 'head');

  await bench.interleave(
    'stream, iterate 50K comments (batch 1000)',
    [
      {
        name: 'T rows',
        fn: () =>
          timed('T rows', async () => {
            const s = sampler('T rows');
            let n = 0;
            for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) {
              n++;
              if (n % BATCH === 0) s.onPage();
            }
            s.done();
            return n;
          }),
      },
      {
        name: 'T batches',
        fn: () => timed('T batches', () => turbineBatchDrain('T batches')),
      },
      {
        /**
         * NEGATIVE CONTROL. Byte-identical work to `T batches`, run under a
         * second name. Rotation is supposed to neutralise arm position, and
         * these two are the test of whether it did: they must land on top of
         * each other. If they do not, position is still leaking into the
         * numbers and no delta in this table is reportable, however clean the
         * competitor arms look.
         */
        name: 'T batches#2',
        fn: () => timed('T batches#2', () => turbineBatchDrain('T batches#2')),
      },
      {
        name: 'Drizzle RC',
        fn: () =>
          timed('Drizzle RC', async () => {
            const s = sampler('Drizzle RC');
            let n = 0;
            let lastId = 0;
            for (;;) {
              const batch = await rcDb
                .select()
                .from(rcSchema.comments)
                .where(rcGt(rcSchema.comments.id, lastId))
                .orderBy(rcAsc(rcSchema.comments.id))
                .limit(BATCH);
              s.onPage();
              if (batch.length === 0) break;
              for (const row of batch) {
                n++;
                lastId = row.id;
              }
              if (batch.length < BATCH) break;
            }
            s.done();
            return n;
          }),
      },
      {
        name: 'Drizzle',
        fn: () =>
          timed('Drizzle', async () => {
            const s = sampler('Drizzle');
            let n = 0;
            let lastId = 0;
            for (;;) {
              const batch = await drizzleDb
                .select()
                .from(schema.comments)
                .where(gt(schema.comments.id, lastId))
                .orderBy(asc(schema.comments.id))
                .limit(BATCH);
              s.onPage();
              if (batch.length === 0) break;
              for (const row of batch) {
                n++;
                lastId = row.id;
              }
              if (batch.length < BATCH) break;
            }
            s.done();
            return n;
          }),
      },
      {
        name: 'Raw',
        fn: () =>
          timed('Raw', async () => {
            const s = sampler('Raw');
            let n = 0;
            let lastId = 0;
            for (;;) {
              const res = await rawPool.query(
                'SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2',
                [lastId, BATCH],
              );
              s.onPage();
              if (res.rows.length === 0) break;
              for (const row of res.rows) {
                n++;
                lastId = Number(row.id);
              }
              if (res.rows.length < BATCH) break;
            }
            s.done();
            return n;
          }),
      },
    ],
    { rounds: ROUNDS, warmup: WARMUP },
  );

  const driftTail = await bench.driftProbe(rawPool, 'tail');
  bench.reportDrift([driftHead, driftTail]);

  const control = paired('T batches#2', 'T batches');
  console.log('\n-- negative control (must be ~0; it is the licence to read the table below) --');
  if (control) {
    console.log(
      `  T batches#2 vs T batches: ${control.delta >= 0 ? '+' : ''}${control.delta.toFixed(3)} ms ` +
        `(${control.pct >= 0 ? '+' : ''}${control.pct.toFixed(1)}%), identical work`,
    );
  }

  const yieldCost = paired('T rows', 'T batches');
  console.log('\n-- attribution: what the per-row API costs over the batch API --');
  if (yieldCost) {
    console.log(
      `  T rows vs T batches: ${yieldCost.delta >= 0 ? '+' : ''}${yieldCost.delta.toFixed(3)} ms ` +
        `(${yieldCost.pct >= 0 ? '+' : ''}${yieldCost.pct.toFixed(1)}%) = ` +
        `${((yieldCost.delta * 1e6) / 50000).toFixed(0)} ns/row of generator suspension`,
    );
  }

  /**
   * The DISCARDED speculative fetch, priced on its own.
   *
   * `streamRaw` opens every drain with `SELECT … LIMIT batchSize + 1`, so that a
   * result set fitting in one batch can skip the cursor and save four round
   * trips. When the drain overflows (as a 50K one always does) those
   * `batchSize + 1` rows are transferred, decoded into JS objects, and thrown
   * away: the audit shows Turbine decoding 51,001 rows to deliver 50,000.
   *
   * This measures exactly that statement, through Turbine's own client so it
   * pays Turbine's own decode, and nothing else. It is the price of the bet the
   * speculation makes, and it is charged to every drain that loses it.
   */
  const specSamples: number[] = [];
  for (let i = 0; i < 5; i++) await turbine.comments.findMany({ limit: BATCH + 1 });
  for (let i = 0; i < 21; i++) {
    const t0 = performance.now();
    await turbine.comments.findMany({ limit: BATCH + 1 });
    specSamples.push(performance.now() - t0);
  }
  console.log(
    `  discarded speculative fetch (SELECT … LIMIT ${BATCH + 1}, decoded then dropped): ` +
      `${med(specSamples).toFixed(3)} ms`,
  );

  console.log('\n-- paired per-round deltas vs Drizzle RC (negative = Turbine faster) --');
  for (const arm of ['T rows', 'T batches']) {
    const d = paired(arm, 'Drizzle RC');
    if (!d) continue;
    console.log(
      `  ${arm.padEnd(12)} ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(3)} ms ` +
        `(${d.pct >= 0 ? '+' : ''}${d.pct.toFixed(1)}%), won ${(d.winRate * 100).toFixed(0)}% of rounds`,
    );
  }

  console.log('\n-- peak heap during the drain, MB above the arm\'s own baseline --');
  console.log(`  ${'arm'.padEnd(12)} ${'median'.padStart(9)} ${'max'.padStart(9)}`);
  for (const [arm, xs] of peakHeap) {
    console.log(
      `  ${arm.padEnd(12)} ${med(xs).toFixed(1).padStart(9)} ${Math.max(...xs).toFixed(1).padStart(9)}`,
    );
  }

  await turbine.disconnect();
  await drizzlePool.end();
  await rcPool.end();
  await rawPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
