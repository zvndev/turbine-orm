/**
 * Real-network benchmark. Every other timing in this repository is measured
 * over a Unix socket, and the one file that varies latency (`bench-latency.ts`)
 * MODELS it with an in-process TCP proxy that delays each chunk by RTT/2.
 *
 * That proxy is honest about what it is, and it cannot answer three questions:
 *
 *   1. `jsonEncoding: 'positional'` is the PostgreSQL default since 0.71 and its
 *      headline is a ~34% smaller relation payload. The proxy delays chunks, so
 *      it models LATENCY and not BANDWIDTH, and the published tables say in so
 *      many words that this saving "does not appear in these tables at all".
 *      A real link is the only place the byte count can turn into wall clock.
 *   2. `pipeline()` is one round trip against roughly seven. The proxy predicts
 *      the advantage grows from 2.7x to 6.9x. Predicted, not observed.
 *   3. `relationLoadStrategy: 'batched'` is fastest on a socket and, per the
 *      model, slower once a round trip costs anything. A recommendation that
 *      inverts on the axis the harness simulates deserves a measurement.
 *
 * Usage:  DATABASE_URL=<direct endpoint> npx tsx benchmarks/bench-network.ts
 *
 * The URL must be a DIRECT endpoint, never a pooler: a pooled connection
 * multiplexes backends and would make per-connection timing meaningless. This
 * script refuses a pooler using the same `detectPooler` the CLI uses.
 */

import pg from 'pg';
import { detectPooler } from '../src/connection-url.js';
import { TurbineClient } from '../generated/turbine/index.js';
import { Bench, median } from './bench-harness.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required (a DIRECT endpoint, not a pooler)');
  process.exit(1);
}
const pooled = detectPooler(DATABASE_URL);
if (pooled.pooled) {
  console.error(`Refusing to benchmark a pooled endpoint (${pooled.signal}). Use the direct host.`);
  process.exit(1);
}

const ROUNDS = parseInt(process.env['ROUNDS'] ?? '30', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '5', 10);

const db = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
// A plain driver pool for the two measurements that must NOT go through the
// ORM: the round-trip floor, and the server's own payload bytes.
const raw = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

/** Median of `n` trivial round trips, the floor every number here sits on. */
async function measureRtt(n = 25): Promise<number> {
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = process.hrtime.bigint();
    await raw.query('select 1');
    ms.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  return median(ms.sort((a, b) => a - b));
}

/**
 * Wire bytes of the relation payload, measured once rather than per round.
 * Runs the two encodings as raw SQL so the number is the server's output and
 * not an artifact of how the client parses it.
 */
async function payloadBytes(): Promise<{ object: number; positional: number }> {
  const objectSql = `
    select u.id, coalesce((select json_agg(json_build_object('id', p.id, 'title', p.title, 'content', p.content))
      from posts p where p.user_id = u.id), '[]'::json)::text as rel
    from users u limit 200`;
  const positionalSql = `
    select u.id, coalesce((select json_agg(json_build_array(p.id, p.title, p.content))
      from posts p where p.user_id = u.id), '[]'::json)::text as rel
    from users u limit 200`;
  const sum = async (sql: string) => {
    const r = await raw.query<{ rel: string }>(sql);
    return r.rows.reduce((n, row) => n + Buffer.byteLength(row.rel ?? '', 'utf8'), 0);
  };
  return { object: await sum(objectSql), positional: await sum(positionalSql) };
}

async function main(): Promise<void> {
  const rtt = await measureRtt();
  console.log(`\nReal-network benchmark. RTT median ${rtt.toFixed(2)} ms, ROUNDS=${ROUNDS}, WARMUP=${WARMUP}, Node ${process.version}\n`);

  const bytes = await payloadBytes();
  const saved = ((1 - bytes.positional / bytes.object) * 100).toFixed(1);
  console.log(`Relation payload over 200 parents: object ${(bytes.object / 1024).toFixed(1)} kB, positional ${(bytes.positional / 1024).toFixed(1)} kB (${saved}% smaller)\n`);

  const bench = new Bench({ rounds: ROUNDS, warmup: WARMUP });

  // 1. THE BANDWIDTH CLAIM. Same rows, same tree, two encodings.
  await bench.interleave('l2-encoding', [
    { name: 'positional', fn: () => db.users.findMany({ limit: 200, orderBy: { id: 'asc' }, with: { posts: true }, jsonEncoding: 'positional' }) },
    { name: 'object', fn: () => db.users.findMany({ limit: 200, orderBy: { id: 'asc' }, with: { posts: true }, jsonEncoding: 'object' }) },
  ]);

  await bench.interleave('l3-encoding', [
    { name: 'positional', fn: () => db.users.findMany({ limit: 50, orderBy: { id: 'asc' }, with: { posts: { with: { comments: true } } }, jsonEncoding: 'positional' }) },
    { name: 'object', fn: () => db.users.findMany({ limit: 50, orderBy: { id: 'asc' }, with: { posts: { with: { comments: true } } }, jsonEncoding: 'object' }) },
  ]);

  // 2. THE ROUND-TRIP CLAIM. One flush against a sequential transaction.
  await bench.interleave('pipeline', [
    {
      name: 'pipeline()',
      fn: () => db.pipeline([
        db.users.buildFindUnique({ where: { id: 1 } }),
        db.posts.buildCount({ where: { userId: 1 } }),
        db.comments.buildCount({ where: { userId: 1 } }),
        db.posts.buildFindMany({ where: { userId: 1 }, orderBy: { id: 'asc' }, limit: 5 }),
        db.users.buildCount({}),
      ]),
    },
    {
      name: 'sequential',
      fn: async () => {
        await db.users.findUnique({ where: { id: 1 } });
        await db.posts.count({ where: { userId: 1 } });
        await db.comments.count({ where: { userId: 1 } });
        await db.posts.findMany({ where: { userId: 1 }, orderBy: { id: 'asc' }, limit: 5 });
        await db.users.count({});
      },
    },
  ]);

  // 3. THE RECOMMENDATION THAT INVERTS. One statement against one per relation.
  await bench.interleave('strategy', [
    { name: 'join', fn: () => db.users.findMany({ limit: 200, orderBy: { id: 'asc' }, with: { posts: true }, relationLoadStrategy: 'join' }) },
    { name: 'batched', fn: () => db.users.findMany({ limit: 200, orderBy: { id: 'asc' }, with: { posts: true }, relationLoadStrategy: 'batched' }) },
  ]);

  // 4. THE FLOOR. A point read is nearly all round trip on a real link.
  await bench.interleave('point-read', [
    { name: 'turbine', fn: () => db.users.findUnique({ where: { id: 1 } }) },
    { name: 'raw pg', fn: () => raw.query('select * from users where id = $1', [1]) },
  ]);

  await db.disconnect();
  await raw.end();
}

await main();
