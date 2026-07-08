/**
 * Turbine ORM — jsonEncoding: 'object' vs 'positional' payload benchmark
 *
 * Turbine's `with` relations come back as `json_agg(json_build_object('k', v, …))`,
 * so every key name repeats in every nested object of every row. The opt-in
 * `positional` encoding emits `json_agg(json_build_array(v, …))` instead and maps
 * positions back to keys client-side — same information, far fewer bytes on
 * wide/deeply-nested trees. This bench quantifies the win.
 *
 * It is SELF-CONTAINED: it creates + seeds its own throwaway tables, so any
 * empty Postgres works. It reports, for the SAME nested query under each
 * encoding: raw relation-payload bytes (summed length of the JSON strings pg
 * returns for the relation columns) and end-to-end findMany() ms.
 *
 * Setup:
 *   DATABASE_URL=postgres://localhost:5432/turbine_bench npx tsx benchmarks/json-encoding-bench.ts
 *
 * Options (env vars):
 *   USERS=200        Parent rows
 *   CHILDREN=40      Child rows per parent
 *   ITERATIONS=30    Measured findMany() iterations per encoding
 *   WARMUP=5         Warmup iterations (not measured)
 */

import pg from 'pg';
import { TurbineClient } from '../src/client.js';
import { introspect } from '../src/introspect.js';
import type { QueryInterface } from '../src/query/index.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost:5432/turbine_bench';
const USERS = Number.parseInt(process.env.USERS ?? '200', 10);
const CHILDREN = Number.parseInt(process.env.CHILDREN ?? '40', 10);
const ITERATIONS = Number.parseInt(process.env.ITERATIONS ?? '30', 10);
const WARMUP = Number.parseInt(process.env.WARMUP ?? '5', 10);

// A wide child table so key-name repetition dominates the payload.
const CHILD_COLS = [
  'title text',
  'body text',
  'status text',
  'category text',
  'priority int',
  'score int',
  'views int',
  'likes int',
  'is_published boolean',
  'is_pinned boolean',
  'created_at timestamptz',
  'updated_at timestamptz',
];

async function seed(pool: pg.Pool): Promise<void> {
  await pool.query('DROP TABLE IF EXISTS bench_events');
  await pool.query('DROP TABLE IF EXISTS bench_owners');
  await pool.query('CREATE TABLE bench_owners (id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL)');
  await pool.query(
    `CREATE TABLE bench_events (
      id BIGSERIAL PRIMARY KEY,
      owner_id BIGINT NOT NULL REFERENCES bench_owners(id),
      ${CHILD_COLS.join(', ')}
    )`,
  );

  for (let u = 0; u < USERS; u++) {
    const { rows } = await pool.query('INSERT INTO bench_owners (name) VALUES ($1) RETURNING id', [`owner ${u}`]);
    const ownerId = rows[0].id;
    const values: unknown[] = [];
    const tuples: string[] = [];
    for (let c = 0; c < CHILDREN; c++) {
      const base = values.length;
      tuples.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, now(), now())`,
      );
      values.push(
        ownerId,
        `Event title ${c} for owner ${u}`,
        `A reasonably sized body of text describing event ${c}.`,
        'active',
        'general',
        c % 5,
        c * 7,
        c * 3,
        c * 2,
        c % 2 === 0,
        c % 3 === 0,
      );
    }
    await pool.query(
      `INSERT INTO bench_events (owner_id, title, body, status, category, priority, score, views, likes, is_published, is_pinned, created_at, updated_at) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

/** Sum the byte length of the JSON strings pg returns for the relation column. */
async function measurePayloadBytes(pool: pg.Pool, sql: string, params: unknown[], relCol: string): Promise<number> {
  const { rows } = await pool.query(sql, params);
  let bytes = 0;
  for (const row of rows) {
    const v = row[relCol];
    bytes += typeof v === 'string' ? Buffer.byteLength(v) : Buffer.byteLength(JSON.stringify(v));
  }
  return bytes;
}

async function timeFindMany(db: TurbineClient, relName: string): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < WARMUP + ITERATIONS; i++) {
    const t0 = performance.now();
    await db.table('bench_owners').findMany({ with: { [relName]: true } });
    const dt = performance.now() - t0;
    if (i >= WARMUP) samples.push(dt);
  }
  return samples;
}

function stats(samples: number[]): { avg: number; p50: number; p95: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const avg = samples.reduce((s, x) => s + x, 0) / samples.length;
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]!;
  return { avg, p50: p(0.5), p95: p(0.95) };
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });

  console.log(`\nSeeding ${USERS} owners × ${CHILDREN} events (${USERS * CHILDREN} child rows)…`);
  await seed(pool);

  const schema = await introspect({ connectionString: DATABASE_URL });
  // The introspected hasMany relation from bench_owners → bench_events.
  const relName = Object.keys(schema.tables.bench_owners?.relations ?? {}).find(
    (r) => schema.tables.bench_owners!.relations[r]!.to === 'bench_events',
  );
  if (!relName) throw new Error('could not find bench_owners → bench_events relation after introspection');

  const objDb = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 5 }, schema);
  const posDb = new TurbineClient(
    { connectionString: DATABASE_URL, poolSize: 5, jsonEncoding: 'positional' },
    schema,
  );
  await objDb.connect();
  await posDb.connect();

  // --- Payload bytes: run the exact SQL each encoding generates, over the wire.
  const objQi = objDb.table('bench_owners') as unknown as QueryInterface<object>;
  const posQi = posDb.table('bench_owners') as unknown as QueryInterface<object>;
  const objD = objQi.buildFindMany({ with: { [relName]: true } } as never);
  const posD = posQi.buildFindMany({ with: { [relName]: true } } as never);

  const objBytes = await measurePayloadBytes(pool, objD.sql, objD.params, relName);
  const posBytes = await measurePayloadBytes(pool, posD.sql, posD.params, relName);

  // --- Parity guard: the parsed results must be identical.
  const objRows = objD.transform(await pool.query(objD.sql, objD.params));
  const posRows = posD.transform(await pool.query(posD.sql, posD.params));
  const parity = JSON.stringify(objRows) === JSON.stringify(posRows);

  // --- End-to-end timing.
  const objTimes = stats(await timeFindMany(objDb, relName));
  const posTimes = stats(await timeFindMany(posDb, relName));

  const reduction = ((objBytes - posBytes) / objBytes) * 100;

  console.log('\n=== jsonEncoding payload benchmark ===');
  console.log(`relation: bench_owners.${relName} (hasMany, ${CHILD_COLS.length + 2} columns/row)`);
  console.log(`parsed-output parity: ${parity ? 'IDENTICAL ✓' : 'MISMATCH ✗'}`);
  console.log('');
  console.log('Relation payload bytes (wire):');
  console.log(`  object     : ${objBytes.toLocaleString()} bytes`);
  console.log(`  positional : ${posBytes.toLocaleString()} bytes`);
  console.log(`  reduction  : ${reduction.toFixed(1)}%`);
  console.log('');
  console.log('End-to-end findMany() ms (avg / p50 / p95):');
  console.log(`  object     : ${objTimes.avg.toFixed(2)} / ${objTimes.p50.toFixed(2)} / ${objTimes.p95.toFixed(2)}`);
  console.log(`  positional : ${posTimes.avg.toFixed(2)} / ${posTimes.p50.toFixed(2)} / ${posTimes.p95.toFixed(2)}`);

  await objDb.disconnect();
  await posDb.disconnect();
  await pool.query('DROP TABLE IF EXISTS bench_events');
  await pool.query('DROP TABLE IF EXISTS bench_owners');
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
