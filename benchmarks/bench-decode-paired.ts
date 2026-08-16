/**
 * Did the fast temporal decode path move the streaming drain, and by how much?
 *
 * ## Why this harness exists rather than "run the old build, then the new one"
 *
 * Before/after across two builds is two processes on two machine states, and
 * `RESULTS-0.71.0.md` records what that costs: the same L2 statement measured
 * 18% apart across one afternoon, and the 50K drain moved from 42.35 ms to
 * 68.45 ms between two runs of unchanged code. Absolute numbers do not travel.
 *
 * They do not have to here, because the change under test lives ENTIRELY in
 * `pg.types`, a process-global parser table that is read per row at decode
 * time and can be rewritten between two calls. So both versions run in ONE
 * process, on ONE build, against ONE pool, rotating inside every round. The
 * arms differ in exactly one thing: which functions are registered for OIDs
 * 1082 / 1114 / 1115 / 1182 / 1184 / 1185 while the arm runs. Everything else,
 * server time, wire bytes, protocol round trips, row-object construction,
 * `parseRow`, the cursor protocol, is identical between them and cancels.
 *
 *   BEFORE   what turbine-orm 0.71.0 shipped: the regex `date` / `timestamp`
 *            parsers, and pg's own `postgres-date` on `timestamptz`.
 *   AFTER    what `registerUtcTemporalParsers()` installs now.
 *
 * ## The controls, and why each one is here
 *
 *   NEGATIVE CONTROL   the BEFORE profile is measured TWICE per round under
 *                      two arm names. They do byte-identical work, so they
 *                      must land on top of each other; if they do not, the
 *                      rotation is not neutralising position and no
 *                      subtraction below is reportable. This is the instrument
 *                      that caught a contaminated run the CPU gate let through
 *                      during the ceiling measurement.
 *   MACHINE CONTROL    a hand-written DECLARE / FETCH loop that parses nothing.
 *                      It contains none of the code under test, so it
 *                      separates "the arms moved" from "the box moved".
 *   DRIZZLE            0.45.2's keyset drain, the same statement shape
 *                      `bench-interleaved.ts` uses, measured in this same
 *                      rotation. The published 39.49 ms is from another day and
 *                      cannot be compared to today's absolute numbers; the only
 *                      honest way to answer "do we beat Drizzle now" is to run
 *                      it here.
 *
 * Every reported quantity is a PAIRED per-round delta as well as a median, for
 * the reason `bench-stream-batches.ts` gives: pairing survives a noisy machine
 * where medians of separate distributions do not.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx bench-decode-paired.ts
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import { asc, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
// Deep import into the BUILT output on purpose: these three are `@internal`
// exports, not package surface, and the point of the BEFORE arm is to run the
// exact functions that shipped rather than a paraphrase of them.
import { createPgArrayParser, createUtcDateParserGeneral, createUtcTimestampParserGeneral } from '../dist/query/utils.js';
import * as schema from './schema.js';

/**
 * THE LIBRARY'S `pg`, WHICH IS NOT THIS FILE'S `pg`.
 *
 * `benchmarks/` pins its own `pg` 8.22.0 and `turbine-orm` is a `file:..`
 * symlink to the repo root, which has its own copy at the same version. Two
 * copies means TWO `pg.types` parser tables, and the whole design of this
 * harness is rewriting the table Turbine decodes through. The first version
 * imported `pg` here and rewrote the BENCHMARK's table, so every flip was a
 * no-op on the arms it was meant to move; the `assertProfilesDiffer` check
 * below is what caught it, which is why that check is not decoration.
 *
 * `createRequire` rooted at the built module resolves `pg` exactly the way the
 * library does, and `pg` is CJS, so this is the same object the library holds.
 */
const requireFromLib = createRequire(new URL('../dist/query/utils.js', import.meta.url));
const libPg = requireFromLib('pg') as typeof pg;

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_070?host=/tmp';
const ROUNDS = Number.parseInt(process.env['ROUNDS'] ?? '15', 10);
const WARMUP = Number.parseInt(process.env['WARMUP'] ?? '3', 10);
const BATCH = Number.parseInt(process.env['BATCH'] ?? '1000', 10);
const QUIET_IDLE = Number.parseInt(process.env['QUIET_IDLE'] ?? '75', 10);

// ---------------------------------------------------------------------------
// Parser profiles. Captured BEFORE any TurbineClient exists, because
// constructing one registers the AFTER profile process-wide and reading the
// table afterwards would hand back Turbine's own parsers.
// ---------------------------------------------------------------------------
type Parse = (value: string) => unknown;
const getParser = (oid: number): Parse =>
  (libPg.types.getTypeParser as unknown as (id: number, format: 'text') => Parse)(oid, 'text');
const setParser = (oid: number, parse: Parse): void =>
  (libPg.types.setTypeParser as unknown as (id: number, p: Parse) => void)(oid, parse);

const PG_DEFAULT: Readonly<Record<number, Parse>> = {
  1082: getParser(1082),
  1114: getParser(1114),
  1115: getParser(1115),
  1182: getParser(1182),
  1184: getParser(1184),
  1185: getParser(1185),
};

/** turbine-orm 0.71.0's parser table, reconstructed from the shipped functions. */
const BEFORE_PROFILE: Readonly<Record<number, Parse>> = (() => {
  const date = createUtcDateParserGeneral(PG_DEFAULT[1082] as Parse) as Parse;
  const ts = createUtcTimestampParserGeneral(PG_DEFAULT[1114] as Parse) as Parse;
  return {
    1082: date,
    1114: ts,
    1115: createPgArrayParser(ts) as unknown as Parse,
    1182: createPgArrayParser(date) as unknown as Parse,
    // 0.71.0 registered NOTHING for the timestamptz pair: they stayed on pg's
    // own parsers, which is the whole thing this release changes.
    1184: PG_DEFAULT[1184] as Parse,
    1185: PG_DEFAULT[1185] as Parse,
  };
})();

const { TurbineClient } = await import('../generated/turbine/index.js');
const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 4, warnOnUnlimited: false });

/** The table as the constructor above just left it: the AFTER profile. */
const AFTER_PROFILE: Readonly<Record<number, Parse>> = {
  1082: getParser(1082),
  1114: getParser(1114),
  1115: getParser(1115),
  1182: getParser(1182),
  1184: getParser(1184),
  1185: getParser(1185),
};

function installProfile(profile: Readonly<Record<number, Parse>>): void {
  for (const oid of [1082, 1114, 1115, 1182, 1184, 1185]) setParser(oid, profile[oid] as Parse);
}

/**
 * The arms must be measuring a real difference, so prove the two profiles are
 * actually different functions AND that they decode the fixture's column
 * identically. A profile pair that decoded differently would not be a
 * before/after of the same result, and one that was the same function would be
 * measuring nothing.
 */
function assertProfilesDiffer(): void {
  if (AFTER_PROFILE[1184] === BEFORE_PROFILE[1184]) {
    throw new Error('BEFORE and AFTER share the same 1184 parser: nothing to measure. Is dist/ stale?');
  }
  const wire = '2026-08-15 12:25:43.476603-04';
  const before = (BEFORE_PROFILE[1184] as Parse)(wire) as Date;
  const after = (AFTER_PROFILE[1184] as Parse)(wire) as Date;
  if (!(before instanceof Date) || !(after instanceof Date) || before.getTime() !== after.getTime()) {
    throw new Error(`BEFORE and AFTER decode ${wire} differently: ${String(before)} vs ${String(after)}`);
  }
  console.log(`profiles verified: 1184 differs by identity, agrees on value (${after.toISOString()})`);
}

// ---------------------------------------------------------------------------
// Machine gate. CPU idle, never load average: this box idles at load 4-6 while
// 85% idle, so a load gate never opens. Sampled from os.cpus() cumulative
// counters rather than by spawning anything, because a sampler that costs CPU
// contaminates the measurement it is guarding.
// ---------------------------------------------------------------------------
function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  return { idle, total };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function idlePct(windowMs = 1000): Promise<number> {
  const a = cpuTotals();
  await sleep(windowMs);
  const b = cpuTotals();
  const dTotal = b.total - a.total;
  return dTotal <= 0 ? 100 : ((b.idle - a.idle) / dTotal) * 100;
}

async function waitQuiet(hold = 5, timeoutMs = 900_000): Promise<number> {
  const started = Date.now();
  let held = 0;
  let last = 0;
  for (;;) {
    last = await idlePct();
    if (last >= QUIET_IDLE) {
      held++;
      if (held >= hold) {
        console.log(`[gate] quiet: ${held} consecutive samples, idle ${last.toFixed(1)}%`);
        return last;
      }
    } else {
      if (held > 0) console.log(`[gate] contention at hold=${held} (idle ${last.toFixed(1)}%), resetting`);
      held = 0;
    }
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for a quiet machine');
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  return s.length % 2 ? (s[(s.length - 1) / 2] as number) : (((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2);
}

// ---------------------------------------------------------------------------
const rawPool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
/**
 * A pool whose every OID returns the raw text: the DECODE-FREE floor.
 *
 * `rawPool` above is the harness's drift yardstick, and it is NOT a floor for
 * Turbine, which is easy to misread: it uses this file's own `pg` on its own
 * default parsers, so it pays the full stock `postgres-date` cost on
 * `created_at` and lands ABOVE the fast-path arms. Constant across arms, so it
 * still answers "did the box move"; useless for "how much decoding is left".
 * This second pool answers that one.
 */
const identityPool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 2,
  types: { getTypeParser: () => (v: string) => v },
} as unknown as pg.PoolConfig);
const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const drizzleDb = drizzle(drizzlePool, { schema });

// The unwrapped QueryInterface, for the reason bench-stream-batches.ts records:
// `db.comments` is a Proxy whose `get` trap costs a wrapped call, and reaching
// through it inside a 50,000-iteration loop is measurable.
// biome-ignore lint/suspicious/noExplicitAny: reaches the client's table cache on purpose
const qi: any = (db as any).primaryTableQI('comments');

interface Sample {
  ms: number;
  rows: number;
  checksum: number;
}

async function perRow(): Promise<Sample> {
  const t0 = performance.now();
  let rows = 0;
  let checksum = 0;
  for await (const row of qi.findManyStream({ batchSize: BATCH })) {
    rows++;
    checksum += (row as { id: number }).id;
  }
  return { ms: performance.now() - t0, rows, checksum };
}

async function perBatch(): Promise<Sample> {
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

/** Drizzle 0.45.2, the keyset drain bench-interleaved.ts measures. */
async function drizzleDrain(): Promise<Sample> {
  const t0 = performance.now();
  let rows = 0;
  let checksum = 0;
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
      rows++;
      checksum += row.id;
      lastId = row.id;
    }
    if (batch.length < BATCH) break;
  }
  return { ms: performance.now() - t0, rows, checksum };
}

/** The same rows off the wire through a hand-written DECLARE / FETCH loop. */
async function rawCursor(pool: pg.Pool, cursorName: string): Promise<{ ms: number; rows: number }> {
  const t0 = performance.now();
  const c = await pool.connect();
  let rows = 0;
  try {
    await c.query('BEGIN');
    await c.query(`DECLARE ${cursorName} NO SCROLL CURSOR FOR SELECT * FROM comments`);
    for (;;) {
      const r = await c.query(`FETCH ${BATCH} FROM ${cursorName}`);
      rows += r.rows.length;
      if (r.rows.length < BATCH) break;
    }
    await c.query(`CLOSE ${cursorName}`);
    await c.query('COMMIT');
  } finally {
    c.release();
  }
  return { ms: performance.now() - t0, rows };
}

interface Arm {
  key: string;
  label: string;
  profile: Readonly<Record<number, Parse>> | null;
  run: () => Promise<Sample>;
}

const ARMS: Arm[] = [
  { key: 'stream.before', label: 'findManyStream        BEFORE', profile: BEFORE_PROFILE, run: perRow },
  { key: 'stream.after', label: 'findManyStream        AFTER ', profile: AFTER_PROFILE, run: perRow },
  { key: 'batches.before', label: 'findManyStreamBatches BEFORE', profile: BEFORE_PROFILE, run: perBatch },
  { key: 'batches.after', label: 'findManyStreamBatches AFTER ', profile: AFTER_PROFILE, run: perBatch },
  // NEGATIVE CONTROL: byte-identical to `batches.before`. Must land on it.
  { key: 'batches.before2', label: 'findManyStreamBatches BEFORE (neg control)', profile: BEFORE_PROFILE, run: perBatch },
  { key: 'drizzle', label: 'Drizzle 0.45.2 keyset drain', profile: null, run: drizzleDrain },
];

async function main(): Promise<void> {
  console.log('=== Fast temporal decode: paired before/after on one build, one process ===\n');
  console.log(`node ${process.version}, rounds=${ROUNDS} warmup=${WARMUP} batch=${BATCH}`);
  assertProfilesDiffer();

  await db.connect();
  console.log('\nWaiting for a quiet machine before any timing...');
  const idleBefore = await waitQuiet();

  const samples = new Map<string, number[]>(ARMS.map((a) => [a.key, []]));
  const controlMs: number[] = [];
  const floorMs: number[] = [];
  const paired = { stream: [] as number[], batches: [] as number[], negControl: [] as number[], vsDrizzle: [] as number[] };
  let seenRows = 0;
  let seenChecksum = -1;

  for (let round = 0; round < ROUNDS + WARMUP; round++) {
    installProfile(AFTER_PROFILE);
    const control = await rawCursor(rawPool, 'bdp_cur');
    const floor = await rawCursor(identityPool, 'bdp_floor');
    if (control.rows !== 50_000 || floor.rows !== 50_000) {
      throw new Error(`controls drained ${control.rows} / ${floor.rows} rows`);
    }
    if (round >= WARMUP) {
      controlMs.push(control.ms);
      floorMs.push(floor.ms);
    }

    // Rotate so no arm permanently owns the warm-cache position, AND flip the
    // direction on alternate rounds. Rotation alone is not enough for the
    // negative control: a pure rotation holds every PAIR of arms at a constant
    // separation, so `batches.before` would sit two slots ahead of its clone in
    // every single round and any position-2 effect would land on the paired
    // delta as a systematic bias rather than averaging out. Reversing swaps
    // which of the two goes first.
    const base = round % 2 === 0 ? ARMS : [...ARMS].reverse();
    const shift = round % ARMS.length;
    const results = new Map<string, Sample>();
    for (let i = 0; i < base.length; i++) {
      const arm = base[(i + shift) % base.length] as Arm;
      if (arm.profile) installProfile(arm.profile);
      results.set(arm.key, await arm.run());
    }

    // Every arm must have seen the same 50,000 rows, or nothing below is a
    // comparison. The checksum also proves the decode profiles did not change
    // WHICH rows came back, only how fast they were turned into objects.
    for (const arm of ARMS) {
      const s = results.get(arm.key) as Sample;
      if (seenChecksum < 0) {
        seenRows = s.rows;
        seenChecksum = s.checksum;
      }
      if (s.rows !== seenRows || s.checksum !== seenChecksum) {
        throw new Error(`arm ${arm.key} disagrees: ${s.rows} rows / ${s.checksum} vs ${seenRows} / ${seenChecksum}`);
      }
    }

    if (round < WARMUP) {
      if (round === WARMUP - 1) console.log('(warmup complete)\n');
      continue;
    }
    for (const arm of ARMS) (samples.get(arm.key) as number[]).push((results.get(arm.key) as Sample).ms);
    paired.stream.push((results.get('stream.before') as Sample).ms - (results.get('stream.after') as Sample).ms);
    paired.batches.push((results.get('batches.before') as Sample).ms - (results.get('batches.after') as Sample).ms);
    paired.negControl.push(
      (results.get('batches.before') as Sample).ms - (results.get('batches.before2') as Sample).ms,
    );
    paired.vsDrizzle.push((results.get('batches.after') as Sample).ms - (results.get('drizzle') as Sample).ms);
  }

  // Leave the process on the shipping profile.
  installProfile(AFTER_PROFILE);

  const med = (key: string): number => median(samples.get(key) as number[]);
  console.log(`rows=${seenRows} batchSize=${BATCH}\n`);
  console.log(`  ${'arm'.padEnd(44)} ${'median'.padStart(9)} ${'min'.padStart(8)}`);
  for (const arm of ARMS) {
    const xs = samples.get(arm.key) as number[];
    console.log(`  ${arm.label.padEnd(44)} ${median(xs).toFixed(2).padStart(6)} ms ${Math.min(...xs).toFixed(2).padStart(6)}`);
  }
  console.log(
    `  ${'raw cursor, STOCK pg parsers (drift control)'.padEnd(44)} ${median(controlMs).toFixed(2).padStart(6)} ms ${Math.min(...controlMs).toFixed(2).padStart(6)}`,
  );
  console.log(
    `  ${'raw cursor, NO parsing at all (floor)'.padEnd(44)} ${median(floorMs).toFixed(2).padStart(6)} ms ${Math.min(...floorMs).toFixed(2).padStart(6)}`,
  );
  console.log(
    `    (the drift control still pays pg's own timestamptz decode, so it is NOT a floor for the arms;\n` +
      `     it is constant across arms and therefore answers "did the box move", nothing else.\n` +
      `     stock decode cost on this fixture: ${(median(controlMs) - median(floorMs)).toFixed(2)} ms)`,
  );

  // Internal validity FIRST: if the negative control fails, nothing else is
  // reportable and saying so has to come before the numbers, not after them.
  const negMedian = Math.abs(median(paired.negControl));
  const negPct = (negMedian / med('batches.before')) * 100;
  console.log(
    `\n  negative control: two byte-identical BEFORE arms differ by a paired median of ` +
      `${negMedian.toFixed(2)} ms (${negPct.toFixed(1)}%)` +
      (negPct > 3 ? '  *** FAILED: this run is contaminated and NOT reportable ***' : '  ok'),
  );

  const winStream = median(paired.stream);
  const winBatches = median(paired.batches);
  console.log('\n  THE RESULT (paired per-round deltas, positive = AFTER is faster):');
  console.log(
    `    findManyStream         ${med('stream.before').toFixed(2)} -> ${med('stream.after').toFixed(2)} ms   ` +
      `paired ${winStream >= 0 ? '+' : ''}${winStream.toFixed(2)} ms  ` +
      `(${((winStream / med('stream.before')) * 100).toFixed(1)}%, ${((winStream / seenRows) * 1e6).toFixed(0)} ns/row)`,
  );
  console.log(
    `    findManyStreamBatches  ${med('batches.before').toFixed(2)} -> ${med('batches.after').toFixed(2)} ms   ` +
      `paired ${winBatches >= 0 ? '+' : ''}${winBatches.toFixed(2)} ms  ` +
      `(${((winBatches / med('batches.before')) * 100).toFixed(1)}%, ${((winBatches / seenRows) * 1e6).toFixed(0)} ns/row)`,
  );

  const vsDrizzle = median(paired.vsDrizzle);
  console.log('\n  AGAINST DRIZZLE 0.45.2, measured in this same rotation:');
  console.log(`    Drizzle                ${med('drizzle').toFixed(2)} ms`);
  console.log(`    Turbine batches AFTER  ${med('batches.after').toFixed(2)} ms`);
  console.log(
    `    paired delta           ${vsDrizzle >= 0 ? '+' : ''}${vsDrizzle.toFixed(2)} ms  ` +
      `-> Turbine is ${vsDrizzle < 0 ? 'FASTER' : 'SLOWER'} by ${Math.abs(vsDrizzle).toFixed(2)} ms ` +
      `(ratio ${(med('batches.after') / med('drizzle')).toFixed(3)}x)`,
  );
  console.log(
    `    BEFORE this change     ${med('batches.before').toFixed(2)} ms ` +
      `(ratio ${(med('batches.before') / med('drizzle')).toFixed(3)}x)`,
  );

  const idleAfter = await idlePct();
  console.log(`\n=== Machine: idle ${idleBefore.toFixed(1)}% before, ${idleAfter.toFixed(1)}% after ===`);

  await db.disconnect();
  await rawPool.end();
  await identityPool.end();
  await drizzlePool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
