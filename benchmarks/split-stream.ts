/**
 * Where does the streaming gap live?
 *
 * The stream scenario is the one place the three arms are NOT doing the same
 * thing, so a single wall number hides the trade:
 *
 *   Turbine  DECLARE CURSOR / FETCH / CLOSE inside a transaction. One stable
 *            snapshot for the whole iteration, no ORDER BY required, no rows
 *            duplicated or missed if the table is written during the walk.
 *   Drizzle  keyset pagination: 50 independent SELECT ... WHERE id > $1
 *            ORDER BY id LIMIT 1000 statements, each on its own snapshot.
 *   Prisma   the same keyset shape via take/cursor/skip.
 *
 * The arms below separate the protocol from the per-row work:
 *   raw keyset  hand-written keyset loop, rows untouched  (the Drizzle floor)
 *   raw cursor  hand-written DECLARE/FETCH loop, rows untouched
 *               (the floor for the guarantee Turbine's stream actually gives)
 *   Turbine     findManyStream
 *
 * (raw cursor - raw keyset) is the price of the snapshot guarantee.
 * (Turbine - raw cursor) is Turbine's own per-row overhead.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx split-stream.ts
 */

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { asc, gt } from 'drizzle-orm';
import * as schema from './schema.js';
import { TurbineClient } from '../generated/turbine/index.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_066?host=/tmp';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '15', 10);
const BATCHES = (process.env['BATCHES'] ?? '1000,5000').split(',').map((x) => parseInt(x, 10));

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const ddb = drizzle(pool, { schema });
const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 4, warnOnUnlimited: false });

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

async function rawKeyset(batch: number): Promise<number> {
  const c = await pool.connect();
  try {
    let n = 0;
    let last = 0;
    for (;;) {
      const r = await c.query('SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2', [last, batch]);
      if (r.rows.length === 0) break;
      n += r.rows.length;
      last = (r.rows[r.rows.length - 1] as { id: number }).id;
      if (r.rows.length < batch) break;
    }
    return n;
  } finally {
    c.release();
  }
}

async function rawCursor(batch: number): Promise<number> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('DECLARE turbine_bench_cur NO SCROLL CURSOR FOR SELECT * FROM comments');
    let n = 0;
    for (;;) {
      const r = await c.query(`FETCH ${batch} FROM turbine_bench_cur`);
      n += r.rows.length;
      if (r.rows.length < batch) break;
    }
    await c.query('CLOSE turbine_bench_cur');
    await c.query('COMMIT');
    return n;
  } finally {
    c.release();
  }
}

async function drizzleKeyset(batch: number): Promise<number> {
  let n = 0;
  let last = 0;
  for (;;) {
    const rows = await ddb
      .select()
      .from(schema.comments)
      .where(gt(schema.comments.id, last))
      .orderBy(asc(schema.comments.id))
      .limit(batch);
    if (rows.length === 0) break;
    for (const row of rows) {
      n++;
      last = row.id as number;
    }
    if (rows.length < batch) break;
  }
  return n;
}

async function turbineStream(batch: number): Promise<number> {
  let n = 0;
  for await (const _c of db.comments.findManyStream({ batchSize: batch })) n++;
  return n;
}

async function main(): Promise<void> {
  await db.connect();

  for (const batch of BATCHES) {
    const arms: { name: string; fn: () => Promise<number> }[] = [
      { name: 'raw keyset', fn: () => rawKeyset(batch) },
      { name: 'raw cursor', fn: () => rawCursor(batch) },
      { name: 'Drizzle keyset', fn: () => drizzleKeyset(batch) },
      { name: 'Turbine stream', fn: () => turbineStream(batch) },
    ];

    for (const a of arms) await a.fn(); // warmup
    const samples = new Map<string, number[]>(arms.map((a) => [a.name, []]));
    const counts = new Map<string, number>();
    for (let round = 0; round < ROUNDS; round++) {
      for (let k = 0; k < arms.length; k++) {
        const a = arms[(round + k) % arms.length]!;
        const t = process.hrtime.bigint();
        const n = await a.fn();
        samples.get(a.name)!.push(Number(process.hrtime.bigint() - t) / 1e6);
        counts.set(a.name, n);
      }
    }

    console.log(`\nbatchSize=${batch}   (${ROUNDS} interleaved rounds)`);
    console.log('arm                 median(ms)   rows');
    console.log('-------------------------------------');
    for (const a of arms) {
      console.log(
        `${a.name.padEnd(19)} ${med(samples.get(a.name)!).toFixed(2).padStart(10)}   ${counts.get(a.name)}`,
      );
    }
  }

  await db.disconnect();
  await pool.end();
}

await main();
