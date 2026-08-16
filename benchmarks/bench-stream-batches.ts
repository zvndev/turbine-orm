/**
 * Price the batch-yielding stream against the per-row stream.
 *
 * PROFILE-0.70.0.md scenario 3 attributed ~7 ms of the ~13 ms streaming gap to
 * one thing: `findManyStream` does `yield parseRow(row)` per row, so a 50,000
 * row drain is 50,000 promise resolutions and microtask turns. Draining the
 * SAME cursor and changing only how rows leave the loop, a generator yielding
 * BATCHES cost 45.6/48.1 ms where a generator yielding ROWS cost 53.7/55.0 ms.
 *
 * `findManyStreamBatches` is that change made into an API. This measures it end
 * to end through the shipping client, which is the only measurement that counts:
 * the two arms differ ONLY in which method they call, so whatever separates
 * them is the yielding.
 *
 * Method, following the profile's own trap #1 (phases and totals must be
 * measured in the same regime): the arms ROTATE inside each round rather than
 * running in blocks, and the rotation order alternates every round so neither
 * arm permanently owns the warm-cache position. The first WARMUP rounds are
 * discarded. Per-arm medians are reported, plus a paired per-round delta, which
 * is the statistic that survives a noisy machine.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx bench-stream-batches.ts
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_070?host=/tmp';
const ROUNDS = Number.parseInt(process.env['ROUNDS'] ?? '15', 10);
const WARMUP = Number.parseInt(process.env['WARMUP'] ?? '3', 10);
const BATCH = Number.parseInt(process.env['BATCH'] ?? '1000', 10);

const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 4, warnOnUnlimited: false });
const rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

/**
 * The UNWRAPPED QueryInterface for `comments`, and every arm runs against it.
 *
 * `db.comments` is a Proxy (`createErrorModeAccessor` in client.ts) whose `get`
 * trap returns a memoized wrapper per property name. For the two public arms
 * that costs one wrapper call for the whole drain and is immeasurable, but the
 * reconstruction below reaches `qi.parseRow` and `qi.table` INSIDE its row
 * loop, so through the proxy it would pay an extra wrapped call and an
 * error-mode check 50,000 times. Measured, that alone made the reconstruction
 * ~9 ms slower than the code it is supposed to be identical to, which would
 * have been reported as the refactor making things FASTER by 9 ms. All three
 * arms therefore bind the same raw instance and the proxy is out of the
 * comparison entirely.
 */
// biome-ignore lint/suspicious/noExplicitAny: reaches the client's table cache on purpose
const qi: any = (db as any).primaryTableQI('comments');

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

/**
 * Both arms consume every row and touch one field, so neither can be optimized
 * into a no-op and both pay the same consumer-side cost. `checksum` is returned
 * so the two arms can be proved to have seen the same data.
 */
async function perRow(): Promise<{ ms: number; rows: number; checksum: number }> {
  const t0 = performance.now();
  let rows = 0;
  let checksum = 0;
  for await (const row of qi.findManyStream({ batchSize: BATCH })) {
    rows++;
    checksum += (row as { id: number }).id;
  }
  return { ms: performance.now() - t0, rows, checksum };
}

async function perBatch(): Promise<{ ms: number; rows: number; checksum: number }> {
  const t0 = performance.now();
  let rows = 0;
  let checksum = 0;
  for await (const batch of qi.findManyStreamBatches({ batchSize: BATCH })) {
    for (let i = 0; i < batch.length; i++) {
      rows++;
      checksum += (batch[i] as { id: number }).id;
    }
  }
  return { ms: performance.now() - t0, rows, checksum };
}

/**
 * REGRESSION CONTROL: the PRE-CHANGE `findManyStream`, byte for byte.
 *
 * `findManyStream` was refactored to share one `streamRaw` with the new batch
 * method, so it now takes one extra async-generator hop PER BATCH (50 of them
 * here) and reaches its parser through a closure instead of a ternary. Both are
 * expected to be immeasurable, and "expected to be" is not a measurement, so
 * the old body is reconstructed here and run as its own arm.
 *
 * It is the old code, not a paraphrase: the private members it reaches through
 * are the same ones the old method used, on the same built `dist/`, the same
 * pool, the same raw `qi` instance and the same query. `includePii` and `with` are both absent on this
 * query, so the old method's `streamPii` was `false` and its `parseWith` was
 * `null`, which is why those two lines reduce to `this.parseRow` below.
 */
async function* preChangeFindManyStream(args: { batchSize: number }): AsyncGenerator<Record<string, unknown>> {
  const batchSize = Math.max(1, Math.floor(Number(args.batchSize)));
  qi.currentAction = 'findManyStream';
  const preparedName = qi.preparedNameFor(args, undefined);

  if (batchSize <= 1000) {
    const spec = qi.buildFindMany({ ...args, limit: batchSize + 1 });
    const res = await qi.queryWithTimeout(spec.sql, spec.params, undefined, preparedName);
    if (res.rows.length <= batchSize) {
      for (const row of res.rows) yield qi.parseRow(row, qi.table);
      return;
    }
  }

  const deferred = qi.buildFindMany(args);
  const client = qi.txScoped ? null : await qi.acquireConnection();
  const conn = client ?? {
    query: async (text: string, values?: unknown[]) => await qi.pool.query(text, values),
  };
  try {
    for await (const batch of qi.dialect.openStream(conn, deferred.sql, deferred.params, batchSize, {
      ambientTransaction: qi.txScoped,
    })) {
      for (const row of batch) yield qi.parseRow(row, qi.table);
    }
  } finally {
    client?.release();
  }
}

async function preChange(): Promise<{ ms: number; rows: number; checksum: number }> {
  const t0 = performance.now();
  let rows = 0;
  let checksum = 0;
  for await (const row of preChangeFindManyStream({ batchSize: BATCH })) {
    rows++;
    checksum += (row as { id: number }).id;
  }
  return { ms: performance.now() - t0, rows, checksum };
}

/**
 * MACHINE-STATE CONTROL, not an arm of the comparison.
 *
 * A hand-written DECLARE / FETCH loop that never parses a row. It is the same
 * quantity PROFILE-0.70.0.md measured at 42.19 / 43.47 ms, and it contains none
 * of the code under test, so it is the only way to tell "the arms moved" from
 * "the machine moved" when the absolute numbers do not reproduce the profile's.
 */
async function rawCursorNoParse(): Promise<{ ms: number; rows: number }> {
  const t0 = performance.now();
  const c = await rawPool.connect();
  let rows = 0;
  try {
    await c.query('BEGIN');
    await c.query('DECLARE bsb_cur NO SCROLL CURSOR FOR SELECT * FROM comments');
    for (;;) {
      const r = await c.query(`FETCH ${BATCH} FROM bsb_cur`);
      rows += r.rows.length;
      if (r.rows.length < BATCH) break;
    }
    await c.query('CLOSE bsb_cur');
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  return { ms: performance.now() - t0, rows };
}

async function main(): Promise<void> {
  await db.connect();

  const rowMs: number[] = [];
  const batchMs: number[] = [];
  const oldMs: number[] = [];
  const controlMs: number[] = [];
  const pairedDelta: number[] = [];
  let seenRows = 0;
  let seenChecksum = -1;

  for (let round = 0; round < ROUNDS + WARMUP; round++) {
    const control = await rawCursorNoParse();
    if (round >= WARMUP) controlMs.push(control.ms);

    // Rotate the three arms so no arm permanently owns the warm-cache position.
    const order = [perRow, perBatch, preChange];
    const shift = round % order.length;
    const results = new Map<(typeof order)[number], { ms: number; rows: number; checksum: number }>();
    for (let i = 0; i < order.length; i++) {
      const arm = order[(i + shift) % order.length]!;
      results.set(arm, await arm());
    }
    const row = results.get(perRow)!;
    const batch = results.get(perBatch)!;
    const old = results.get(preChange)!;

    // Same data, or the comparison is meaningless.
    if (seenChecksum < 0) {
      seenRows = row.rows;
      seenChecksum = row.checksum;
    }
    for (const arm of [row, batch, old]) {
      if (arm.rows !== seenRows || arm.checksum !== seenChecksum) {
        throw new Error(`arms disagree: ${arm.rows} rows / checksum ${arm.checksum} vs ${seenRows} / ${seenChecksum}`);
      }
    }

    if (round < WARMUP) continue;
    rowMs.push(row.ms);
    batchMs.push(batch.ms);
    oldMs.push(old.ms);
    pairedDelta.push(row.ms - batch.ms);
  }

  const rowMed = median(rowMs);
  const batchMed = median(batchMs);
  console.log(`rows=${seenRows} batchSize=${BATCH} rounds=${ROUNDS} (warmup ${WARMUP} discarded)`);
  console.log(`findManyStream        median ${rowMed.toFixed(2)} ms   min ${Math.min(...rowMs).toFixed(2)}`);
  console.log(`findManyStreamBatches median ${batchMed.toFixed(2)} ms   min ${Math.min(...batchMs).toFixed(2)}`);
  console.log(
    `delta (median-of-medians) ${(rowMed - batchMed).toFixed(2)} ms   ` +
      `paired median delta ${median(pairedDelta).toFixed(2)} ms   ` +
      `per row ${(((rowMed - batchMed) / seenRows) * 1e6).toFixed(0)} ns`,
  );
  console.log(
    `pre-change findManyStream (regression control) median ${median(oldMs).toFixed(2)} ms   ` +
      `refactor cost ${(rowMed - median(oldMs)).toFixed(2)} ms`,
  );
  console.log(
    `control: raw cursor, no parse, median ${median(controlMs).toFixed(2)} ms ` +
      `(PROFILE-0.70.0.md measured 42.19 / 43.47 ms; a control far off that says the MACHINE moved, not the arms)`,
  );

  await db.disconnect();
  await rawPool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
