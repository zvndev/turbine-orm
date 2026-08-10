/**
 * Decompose Turbine's streaming overhead over a raw cursor.
 *
 * split-stream.ts established that the cursor PROTOCOL is free: over 50K rows
 * a hand-written DECLARE/FETCH loop costs 44.75ms against 44.18ms for a
 * hand-written keyset loop, and Drizzle's keyset arm lands at 44.63ms. Turbine
 * costs 56.98ms. This attributes the ~12ms difference to named parts:
 *
 *   cursor only          raw DECLARE/FETCH, rows untouched
 *   + parseRow           the same loop, each row put through parseRow
 *   + per-row yield      the same, surfaced through an `async *` generator one
 *                        row at a time (what findManyStream's API promises)
 *   Turbine stream       the real thing
 *
 * and measures separately the SPECULATIVE FIRST FETCH: findManyStream begins
 * with `LIMIT batchSize + 1` hoping to satisfy the whole drain in one round
 * trip, and on overflow throws those rows away and restarts from a cursor. On
 * any result larger than one batch that work is pure waste, and it grows with
 * batchSize, which is why the stream arm gets SLOWER as batchSize rises while
 * every other arm gets faster.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx split-stream2.ts
 */

import pg from 'pg';
import { SCHEMA } from '../generated/turbine/metadata.js';
import { TurbineClient } from '../generated/turbine/index.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_066?host=/tmp';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '15', 10);

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 4, warnOnUnlimited: false });

const meta = SCHEMA.tables['comments']!;
const reverseMap = meta.reverseColumnMap;
const dateCols = meta.dateColumns;
const camelDateFields = new Set<string>();
for (const c of dateCols) camelDateFields.add(reverseMap[c] ?? c);

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

function parseRowLike(row: Record<string, unknown>): Record<string, unknown> {
  const parsed: Record<string, unknown> = {};
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i++) {
    const col = keys[i]!;
    const value = row[col];
    const field = reverseMap[col] ?? col;
    if ((dateCols.has(col) || camelDateFields.has(field)) && value !== null && !(value instanceof Date)) {
      parsed[field] = new Date(value as string);
    } else {
      parsed[field] = value;
    }
  }
  return parsed;
}

async function* rawCursorBatches(batch: number): AsyncGenerator<Record<string, unknown>[]> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DECLARE tb_cur NO SCROLL CURSOR FOR SELECT * FROM comments');
    for (;;) {
      const r = await c.query(`FETCH ${batch} FROM tb_cur`);
      yield r.rows as Record<string, unknown>[];
      if (r.rows.length < batch) break;
    }
    await c.query('CLOSE tb_cur');
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

async function cursorOnly(batch: number): Promise<number> {
  let n = 0;
  for await (const rows of rawCursorBatches(batch)) n += rows.length;
  return n;
}

async function cursorParse(batch: number): Promise<number> {
  let n = 0;
  for await (const rows of rawCursorBatches(batch)) {
    for (const row of rows) {
      parseRowLike(row);
      n++;
    }
  }
  return n;
}

async function* cursorParseYield(batch: number): AsyncGenerator<Record<string, unknown>> {
  for await (const rows of rawCursorBatches(batch)) {
    for (const row of rows) yield parseRowLike(row);
  }
}

async function cursorParseYieldDrain(batch: number): Promise<number> {
  let n = 0;
  for await (const _r of cursorParseYield(batch)) n++;
  return n;
}

async function turbineStream(batch: number): Promise<number> {
  let n = 0;
  for await (const _c of db.comments.findManyStream({ batchSize: batch })) n++;
  return n;
}

/** The work findManyStream does and then discards when the result overflows. */
async function speculativeWaste(batch: number): Promise<number> {
  const r = await pool.query('SELECT * FROM comments LIMIT $1', [batch + 1]);
  for (const row of r.rows as Record<string, unknown>[]) parseRowLike(row);
  return r.rows.length;
}

async function main(): Promise<void> {
  await db.connect();

  for (const batch of [1000, 5000]) {
    const arms: { name: string; fn: () => Promise<number> }[] = [
      { name: 'cursor only', fn: () => cursorOnly(batch) },
      { name: '+ parseRow', fn: () => cursorParse(batch) },
      { name: '+ per-row yield', fn: () => cursorParseYieldDrain(batch) },
      { name: 'Turbine stream', fn: () => turbineStream(batch) },
      { name: '(speculative waste)', fn: () => speculativeWaste(batch) },
    ];
    for (const a of arms) await a.fn();
    const samples = new Map<string, number[]>(arms.map((a) => [a.name, []]));
    for (let round = 0; round < ROUNDS; round++) {
      for (let k = 0; k < arms.length; k++) {
        const a = arms[(round + k) % arms.length]!;
        const t = process.hrtime.bigint();
        await a.fn();
        samples.get(a.name)!.push(Number(process.hrtime.bigint() - t) / 1e6);
      }
    }
    console.log(`\nbatchSize=${batch}`);
    console.log('arm                   median(ms)   delta');
    console.log('-----------------------------------------');
    let prev: number | undefined;
    for (const a of arms) {
      const m = med(samples.get(a.name)!);
      const isDelta = a.name !== '(speculative waste)';
      console.log(
        `${a.name.padEnd(21)} ${m.toFixed(2).padStart(10)}   ${
          isDelta && prev !== undefined ? `+${(m - prev).toFixed(2)}` : ''
        }`,
      );
      if (isDelta) prev = m;
    }
  }

  await db.disconnect();
  await pool.end();
}

await main();
