/**
 * A0 follow-up experiments for 0.70.0.
 *
 * The main profile (profile-070.ts) localised each gap to a phase. These three
 * experiments test the specific MECHANISM behind each one, because a phase is
 * not yet a fix.
 *
 *   1. STREAM. The residual over a raw cursor drain is 11.6 ms but parseRow
 *      extrapolates to only 3.8 ms of it. Hypothesis: the missing ~8 ms is the
 *      async generator itself, because `findManyStream` yields ONE ROW at a
 *      time and 50,000 yields is 50,000 promise resolutions and microtask
 *      turns, while every competitor arm loops a fetched batch synchronously.
 *      Tested by draining the identical cursor four ways, changing only how the
 *      rows leave the loop.
 *
 *   2. SQL SHAPE. Turbine's nested read emits a correlated scalar subquery per
 *      relation with `json_build_object` and casts every bigint to `::text`;
 *      Drizzle emits `LEFT JOIN LATERAL` with `json_build_array` and no casts.
 *      Those are three independent differences (join shape, key repetition,
 *      bigint casting) and this prices them one at a time against the same
 *      data, so a recommendation names the one that pays.
 *
 *   3. BIGINT PARITY. If the `::text` cast changes what the caller receives
 *      (string vs number) then it is not purely a performance question and any
 *      proposal to drop it has to say so. Checked, not assumed.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx profile-070-followup.ts
 */

import pg from 'pg';
import { TurbineClient } from '../generated/turbine/index.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_070?host=/tmp';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '150', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '30', 10);
const STREAM_ROUNDS = parseInt(process.env['STREAM_ROUNDS'] ?? '9', 10);
const EXPLAIN_SAMPLES = parseInt(process.env['EXPLAIN_SAMPLES'] ?? '60', 10);
const BATCH = 1000;

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}
const p = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const ms = (n: number) => n.toFixed(3);

async function interleave(
  arms: { name: string; fn: () => Promise<unknown> }[],
  rounds: number,
  warmup: number,
): Promise<Map<string, number>> {
  for (const a of arms) for (let i = 0; i < warmup; i++) await a.fn();
  const s = new Map<string, number[]>(arms.map((a) => [a.name, []]));
  for (let r = 0; r < rounds; r++) {
    for (let k = 0; k < arms.length; k++) {
      const a = arms[(r + k) % arms.length]!;
      const t = process.hrtime.bigint();
      await a.fn();
      s.get(a.name)!.push(Number(process.hrtime.bigint() - t) / 1e6);
    }
  }
  return new Map([...s].map(([n, xs]) => [n, med(xs)]));
}

async function main() {
  const turbine = new TurbineClient({
    connectionString: DATABASE_URL,
    poolSize: 4,
    warnOnUnlimited: false,
    logging: false,
  });
  await turbine.connect();
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  const rawPool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 2,
    types: { getTypeParser: () => (v: string) => v },
  } as pg.PoolConfig);
  const ddb = drizzle(new pg.Pool({ connectionString: DATABASE_URL, max: 4 }), { schema });

  // Turbine with the positional wire encoding, which emits json_build_array
  // instead of json_build_object for relation subqueries.
  const turbinePos = new TurbineClient({
    connectionString: DATABASE_URL,
    poolSize: 4,
    warnOnUnlimited: false,
    logging: false,
    jsonEncoding: 'positional',
  });
  await turbinePos.connect();

  console.log('='.repeat(78));
  console.log('A0 follow-up: mechanism tests');
  console.log('='.repeat(78));

  // ═══ 1. STREAM: where do the missing milliseconds go? ═══
  console.log(`\n${'─'.repeat(78)}\n1. stream 50K — isolating async-generator overhead\n${'─'.repeat(78)}`);

  /** Drain the cursor, doing `mode` with each row. Server work is identical. */
  const drain = async (mode: 'none' | 'parse' | 'genRow' | 'genBatch') => {
    const client = await pool.connect();
    let n = 0;
    const qi = turbine.comments as any;
    const d = qi.buildFindMany({});
    try {
      await client.query('BEGIN');
      await client.query('DECLARE fu_cur NO SCROLL CURSOR FOR SELECT * FROM comments');

      // Yielding generators, defined over the same FETCH loop.
      async function* batches() {
        for (;;) {
          const r = await client!.query(`FETCH ${BATCH} FROM fu_cur`);
          if (r.rows.length === 0) return;
          yield r.rows;
          if (r.rows.length < BATCH) return;
        }
      }
      async function* rowsOneAtATime() {
        for await (const b of batches()) for (const row of b) yield d.transform({ rows: [row] })[0];
      }

      if (mode === 'genRow') {
        for await (const _r of rowsOneAtATime()) n++;
      } else if (mode === 'genBatch') {
        for await (const b of batches()) {
          const parsed = d.transform({ rows: b });
          n += parsed.length;
        }
      } else {
        for (;;) {
          const r = await client.query(`FETCH ${BATCH} FROM fu_cur`);
          if (r.rows.length === 0) break;
          if (mode === 'parse') n += d.transform({ rows: r.rows }).length;
          else n += r.rows.length;
          if (r.rows.length < BATCH) break;
        }
      }
      await client.query('CLOSE fu_cur');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    return n;
  };

  const streamArms = await interleave(
    [
      {
        name: 'turbine findManyStream',
        fn: async () => {
          let n = 0;
          for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) n++;
          return n;
        },
      },
      { name: 'cursor, no parse       ', fn: () => drain('none') },
      { name: 'cursor + parse (sync)  ', fn: () => drain('parse') },
      { name: 'cursor + parse, gen/row', fn: () => drain('genRow') },
      { name: 'cursor + parse, gen/batch', fn: () => drain('genBatch') },
    ],
    STREAM_ROUNDS,
    1,
  );

  const base = streamArms.get('cursor, no parse       ')!;
  for (const [name, v] of streamArms) {
    console.log(`  ${name.padEnd(26)} ${ms(v).padStart(8)} ms   (+${ms(v - base)} over no-parse)`);
  }
  const genOverhead =
    streamArms.get('cursor + parse, gen/row')! - streamArms.get('cursor + parse (sync)  ')!;
  console.log(`\n  per-row async-generator overhead: ${ms(genOverhead)} ms over 50K rows`);
  console.log(`  = ${((genOverhead / 50000) * 1e6).toFixed(2)} ns per row`);

  // ═══ 2. SQL SHAPE ═══
  console.log(`\n${'─'.repeat(78)}\n2. L2 SQL shape — pricing the three differences\n${'─'.repeat(78)}`);

  const qiUsers = turbine.users as any;
  const tDeferred = qiUsers.buildFindMany({ limit: 50, with: { posts: true } });
  const tSql: string = tDeferred.sql;
  const tParams: unknown[] = tDeferred.params;
  const dToSql = (
    ddb.query.users.findMany({ limit: 50, with: { posts: true } } as never) as any
  ).toSQL();
  const dSql: string = dToSql.sql;
  const dParams: unknown[] = dToSql.params ?? [];

  // Turbine's SQL with the ::text casts stripped: same correlated-subquery
  // shape, same key repetition, bigints emitted as JSON numbers.
  const tSqlNoCast = tSql.replace(/::text/g, '');

  // A hand-written LATERAL equivalent of Turbine's own projection, so the join
  // shape is the ONLY thing that differs from tSqlNoCast.
  const lateralSql = `
    SELECT u."id", u."org_id", u."email", u."name", u."role", u."avatar_url",
           u."last_login_at", u."created_at", COALESCE(lat.posts, '[]'::json) AS posts
    FROM "users" u
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
        'id', t0."id", 'userId', t0."user_id", 'orgId', t0."org_id",
        'title', t0."title", 'content', t0."content", 'published', t0."published",
        'viewCount', t0."view_count", 'createdAt', t0."created_at",
        'updatedAt', t0."updated_at")) AS posts
      FROM "posts" t0 WHERE t0."user_id" = u."id"
    ) lat ON TRUE
    LIMIT 50`;

  const lateralArraySql = lateralSql.replace(
    /json_build_object\([\s\S]*?\)\)/,
    `json_build_array(t0."id", t0."user_id", t0."org_id", t0."title", t0."content",
       t0."published", t0."view_count", t0."created_at", t0."updated_at"))`,
  );

  const shapes: { name: string; sql: string; params: unknown[] }[] = [
    { name: 'turbine (subquery, obj, ::text)', sql: tSql, params: tParams },
    { name: 'turbine minus ::text casts     ', sql: tSqlNoCast, params: tParams },
    { name: 'lateral + json_build_object    ', sql: lateralSql, params: [] },
    { name: 'lateral + json_build_array     ', sql: lateralArraySql, params: [] },
    { name: 'drizzle (lateral, array)       ', sql: dSql, params: dParams },
  ];

  console.log('\n  wall-clock execute (pool.query, interleaved) and server time:\n');
  const execArms = await interleave(
    shapes.map((s) => ({ name: s.name, fn: async () => pool.query(s.sql, s.params) })),
    ROUNDS,
    WARMUP,
  );

  for (const s of shapes) {
    const xs: number[] = [];
    for (let i = 0; i < EXPLAIN_SAMPLES; i++) {
      const r = await pool.query(
        `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${s.sql}`,
        s.params,
      );
      const plan = (r.rows[0] as any)['QUERY PLAN'][0];
      xs.push((plan['Execution Time'] ?? 0) + (plan['Planning Time'] ?? 0));
    }
    // Bytes MUST be measured on the identity-parser pool. Through the default
    // pool a json column arrives already parsed, so `String(cell)` measures
    // "[object Object]" for an object encoding and a comma-joined list for an
    // array encoding, which inverts the comparison.
    const res = await rawPool.query({ text: s.sql, values: s.params, rowMode: 'array' });
    let bytes = 0;
    for (const row of res.rows as unknown[][])
      for (const c of row) bytes += c == null ? 0 : Buffer.byteLength(String(c));
    console.log(
      `  ${s.name}  exec ${ms(execArms.get(s.name)!).padStart(7)} ms | ` +
        `server med ${ms(med(xs)).padStart(6)} p10 ${ms(p(xs, 0.1)).padStart(6)} p90 ${ms(p(xs, 0.9)).padStart(6)} | ` +
        `~${(bytes / 1024).toFixed(0)} KB`,
    );
  }

  // Plan shapes, so the difference is visible and not just numeric.
  for (const s of [shapes[0]!, shapes[4]!]) {
    const r = await pool.query(`EXPLAIN ${s.sql}`, s.params);
    const txt = (r.rows as { 'QUERY PLAN': string }[]).map((x) => x['QUERY PLAN']).join('\n');
    console.log(`\n  PLAN — ${s.name.trim()}:`);
    for (const line of txt.split('\n').slice(0, 8)) console.log(`    ${line}`);
  }

  // ═══ 3. BIGINT PARITY ═══
  console.log(`\n${'─'.repeat(78)}\n3. bigint representation in nested rows\n${'─'.repeat(78)}`);
  const tRows: any[] = await turbine.users.findMany({ limit: 1, with: { posts: true } });
  const dRows: any[] = (await ddb.query.users.findMany({
    limit: 1,
    with: { posts: true },
  } as never)) as any[];
  const tp = tRows[0]?.posts?.[0];
  const dp = dRows[0]?.posts?.[0];
  console.log(`  turbine  post.id = ${JSON.stringify(tp?.id)}  typeof ${typeof tp?.id}`);
  console.log(`  drizzle  post.id = ${JSON.stringify(dp?.id)}  typeof ${typeof dp?.id}`);
  console.log(`  turbine  top-level user.id typeof ${typeof tRows[0]?.id}`);
  console.log(
    `  => nested bigint parity: ${typeof tp?.id === typeof dp?.id ? 'SAME' : 'DIFFERENT'}`,
  );

  // ═══ 4. DECISIVE: does the encoding Turbine ALREADY ships close the gap? ═══
  //
  // Experiment 2 priced the server-side difference on hand-written SQL. This
  // asks the question that actually decides the recommendation: with
  // `jsonEncoding: 'positional'` turned on, does the SHIPPING client beat
  // Drizzle end to end, parse included? The positional path decodes each
  // relation from an array back into objects, so it moves work from the server
  // onto parseNestedRow and the net result cannot be assumed from experiment 2.
  console.log(`\n${'─'.repeat(78)}\n4. end-to-end: jsonEncoding 'object' vs 'positional' vs Drizzle\n${'─'.repeat(78)}`);

  const e2e: { label: string; arms: { name: string; fn: () => Promise<unknown> }[] }[] = [
    {
      label: 'L2  50 users + posts',
      arms: [
        { name: 'turbine object    ', fn: () => turbine.users.findMany({ limit: 50, with: { posts: true } }) },
        { name: 'turbine positional', fn: () => turbinePos.users.findMany({ limit: 50, with: { posts: true } }) },
        { name: 'drizzle 0.45      ', fn: () => ddb.query.users.findMany({ limit: 50, with: { posts: true } } as never) as Promise<unknown> },
      ],
    },
    {
      label: 'L3  10 users > posts > comments',
      arms: [
        {
          name: 'turbine object    ',
          fn: () => turbine.users.findMany({ limit: 10, with: { posts: { with: { comments: true }, limit: 5 } } }),
        },
        {
          name: 'turbine positional',
          fn: () => turbinePos.users.findMany({ limit: 10, with: { posts: { with: { comments: true }, limit: 5 } } }),
        },
        {
          name: 'drizzle 0.45      ',
          fn: () => ddb.query.users.findMany({ limit: 10, with: { posts: { limit: 5, with: { comments: true } } } } as never) as Promise<unknown>,
        },
      ],
    },
  ];

  for (const sc of e2e) {
    const r = await interleave(sc.arms, ROUNDS, WARMUP);
    const dz = r.get('drizzle 0.45      ')!;
    console.log(`\n  ${sc.label}`);
    for (const [n, v] of r) {
      const rel = v / dz;
      console.log(`    ${n}  ${ms(v).padStart(7)} ms   ${rel.toFixed(2)}x drizzle`);
    }
  }

  // Equivalence: positional must return the same rows as object encoding, or
  // the speedup is not a speedup.
  const oRows = JSON.stringify(await turbine.users.findMany({ limit: 50, with: { posts: true } }));
  const pRows = JSON.stringify(await turbinePos.users.findMany({ limit: 50, with: { posts: true } }));
  console.log(`\n  positional == object rows: ${oRows === pRows ? 'IDENTICAL' : 'DIFFERENT (!!)'}`);

  await turbine.disconnect();
  await turbinePos.disconnect();
  await pool.end();
  await rawPool.end();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Follow-up error:', e);
  process.exit(1);
});
