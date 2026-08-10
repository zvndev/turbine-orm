/**
 * Where does the nested-read gap actually live?
 *
 * The interleaved harness reports WALL time, which folds together three costs
 * that have completely different fixes:
 *   1. server-side planning + execution   (fix = change the SQL we generate)
 *   2. bytes on the wire                  (fix = change the projection/encoding)
 *   3. client-side decode + transform     (fix = change the row parser)
 *
 * This splits them:
 *   - EXPLAIN (ANALYZE, TIMING OFF) reports the server's own planning and
 *     execution time and excludes everything the client does with the rows.
 *     TIMING OFF because per-node instrumentation is charged per node
 *     EXECUTION, and the two plan shapes under comparison do not execute the
 *     same number of nodes, so leaving it on would bias the comparison toward
 *     whichever shape has fewer.
 *   - wire bytes are measured on a pool whose type parsers are the identity
 *     function, so every cell is the raw text Postgres actually sent. (Reading
 *     a json column through the default parser and stringifying it back does
 *     NOT measure this: it measures JSON.stringify of a parsed object.)
 *   - client cost is the residual.
 *
 * The Turbine arms include `jsonEncoding: 'positional'`, because that option
 * already emits the same json_build_array shape Drizzle uses, so it isolates
 * the cost of the key strings from the cost of the plan shape.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_066?host=/tmp" npx tsx split-l2-l3.ts
 */

import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { TurbineClient } from '../generated/turbine/index.js';
import { SCHEMA } from '../generated/turbine/metadata.js';
import { QueryInterface } from '../dist/index.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_066?host=/tmp';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '120', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '25', 10);
const EXPLAIN_SAMPLES = parseInt(process.env['EXPLAIN_SAMPLES'] ?? '40', 10);

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
const ddb = drizzle(pool, { schema });

// A pool that does no value parsing at all, so a measured cell is the exact
// text the server put on the wire.
const rawPool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: 2,
  types: { getTypeParser: () => (v: string) => v },
} as pg.PoolConfig);

const db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 4, warnOnUnlimited: false });
const dbPos = new TurbineClient({
  connectionString: DATABASE_URL,
  poolSize: 4,
  warnOnUnlimited: false,
  jsonEncoding: 'positional',
});

// NOTE the 4th positional parameter is `middlewares`; options is the 5th.
const qiObj = new QueryInterface(null as never, 'users', SCHEMA, undefined, { sqlCache: false });
const qiPos = new QueryInterface(null as never, 'users', SCHEMA, undefined, {
  sqlCache: false,
  jsonEncoding: 'positional',
});

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

async function serverMs(sql: string, params: readonly unknown[]): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < EXPLAIN_SAMPLES; i++) {
    const r = await pool.query(`EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${sql}`, params as unknown[]);
    const plan = (r.rows[0] as Record<string, [Record<string, number>]>)['QUERY PLAN']![0]!;
    times.push((plan['Execution Time'] ?? 0) + (plan['Planning Time'] ?? 0));
  }
  return med(times);
}

async function wireBytes(sql: string, params: readonly unknown[]): Promise<number> {
  const r = await rawPool.query({ text: sql, values: params as unknown[], rowMode: 'array' });
  let n = 0;
  for (const row of r.rows as (string | null)[][]) {
    for (const cell of row) n += cell === null ? 0 : Buffer.byteLength(cell);
  }
  return n;
}

async function planText(sql: string, params: readonly unknown[]): Promise<string> {
  const r = await pool.query(`EXPLAIN ${sql}`, params as unknown[]);
  return (r.rows as { 'QUERY PLAN': string }[]).map((x) => x['QUERY PLAN']).join('\n');
}

interface Arm {
  name: string;
  sql: string;
  params: readonly unknown[];
  run: () => Promise<unknown>;
}

/** Interleaved wall clock: every arm once per round, rotating start order. */
async function interleavedWall(arms: Arm[]): Promise<Map<string, number>> {
  for (const a of arms) for (let i = 0; i < WARMUP; i++) await a.run();
  const samples = new Map<string, number[]>(arms.map((a) => [a.name, []]));
  for (let round = 0; round < ROUNDS; round++) {
    for (let k = 0; k < arms.length; k++) {
      const a = arms[(round + k) % arms.length]!;
      const t = process.hrtime.bigint();
      await a.run();
      samples.get(a.name)!.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  return new Map([...samples].map(([n, xs]) => [n, med(xs)]));
}

async function main(): Promise<void> {
  await db.connect();
  await dbPos.connect();

  const L2 = { limit: 50, with: { posts: true } } as const;
  const L3 = { limit: 10, with: { posts: { with: { comments: true }, limit: 5 } } } as const;

  const scenarios = [
    {
      name: 'L2  50 users + posts',
      arms: [
        { name: 'Turbine object', ...tArm(qiObj, db, L2) },
        { name: 'Turbine positional', ...tArm(qiPos, dbPos, L2) },
        {
          name: 'Drizzle',
          ...dArm(ddb.query.users.findMany(L2 as never), () => ddb.query.users.findMany(L2 as never)),
        },
      ],
    },
    {
      name: 'L3  10 users > posts > comments',
      arms: [
        { name: 'Turbine object', ...tArm(qiObj, db, L3) },
        { name: 'Turbine positional', ...tArm(qiPos, dbPos, L3) },
        {
          name: 'Drizzle',
          ...dArm(ddb.query.users.findMany(L3 as never), () => ddb.query.users.findMany(L3 as never)),
        },
      ],
    },
  ];

  for (const s of scenarios) {
    console.log(`\n\n############ ${s.name} ############`);
    for (const a of s.arms) {
      console.log(`\n----- ${a.name} SQL -----\n${a.sql}`);
    }
    for (const a of s.arms) {
      console.log(`\n----- ${a.name} PLAN -----\n${await planText(a.sql, a.params)}`);
    }

    const wall = await interleavedWall(s.arms);
    console.log('\narm                   server(ms)   wall(ms)   client(ms)   wire(KB)');
    console.log('--------------------------------------------------------------------');
    for (const a of s.arms) {
      const sv = await serverMs(a.sql, a.params);
      const by = await wireBytes(a.sql, a.params);
      const w = wall.get(a.name)!;
      console.log(
        `${a.name.padEnd(21)} ${sv.toFixed(3).padStart(9)} ${w.toFixed(3).padStart(10)} ${(w - sv)
          .toFixed(3)
          .padStart(12)} ${(by / 1024).toFixed(1).padStart(10)}`,
      );
    }
  }

  await db.disconnect();
  await dbPos.disconnect();
  await pool.end();
  await rawPool.end();
}

function tArm(
  qi: QueryInterface<never>,
  client: TurbineClient,
  args: object,
): { sql: string; params: readonly unknown[]; run: () => Promise<unknown> } {
  const d = qi.buildFindMany(args as never);
  return { sql: d.sql, params: d.params, run: () => client.users.findMany(args as never) };
}

function dArm(
  q: { toSQL(): { sql: string; params: unknown[] } },
  run: () => Promise<unknown>,
): { sql: string; params: readonly unknown[]; run: () => Promise<unknown> } {
  const s = q.toSQL();
  return { sql: s.sql, params: s.params, run };
}

await main();
