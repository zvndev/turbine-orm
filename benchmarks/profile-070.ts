/**
 * A0 profile for turbine-orm 0.70.0: where does the time in the three losing
 * scenarios actually go?
 *
 * The interleaved harness reports WALL time per operation, which folds together
 * four costs with four completely different fixes. This script separates them
 * deterministically rather than by inference, using the fact that a Turbine
 * query is already three separable steps:
 *
 *     const d   = qi.buildFindMany(args);      // 1. BUILD   (SQL generation)
 *     const res = await pool.query(d.sql, …);  // 2. EXECUTE (server+wire+driver)
 *     const out = d.transform(res);            // 3. PARSE   (parseRow/parseNestedRow)
 *
 * EXECUTE is then split again, because it hides the single largest suspect:
 *
 *   - `server`      EXPLAIN (ANALYZE, TIMING OFF) — planning + execution inside
 *                   PostgreSQL, excluding everything the client does. TIMING OFF
 *                   because per-node instrumentation is charged per node
 *                   EXECUTION and the plans under comparison do not execute the
 *                   same number of nodes.
 *   - `driverJson`  the cost of pg's own `json` type parser, i.e. JSON.parse of
 *                   the json_agg payload. Measured as EXECUTE(default parsers)
 *                   minus EXECUTE(identity parsers), on the same SQL against the
 *                   same rows. With identity parsers every cell arrives as the
 *                   raw text the server sent, so the difference is exactly the
 *                   decode the driver would have done.
 *   - `wire`        the residual of EXECUTE after server and driverJson: socket,
 *                   protocol framing, and pg's per-field bookkeeping.
 *
 * The competitor arms are measured the same way where their API allows it, so
 * "Drizzle is faster" can be attributed to a phase rather than left as a total.
 *
 * A V8 CPU profile is then taken of each Turbine scenario through the inspector
 * so the PARSE bucket can be broken down by function self-time. The two are
 * independent instruments and are reported side by side: if the phase split and
 * the sampling profile disagree about which bucket dominates, that disagreement
 * is itself the finding and is reported rather than averaged away.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx profile-070.ts
 *
 * Env:
 *   ROUNDS=150           timed rounds per phase
 *   WARMUP=30            warmup rounds per phase
 *   EXPLAIN_SAMPLES=25   EXPLAIN ANALYZE samples
 *   STREAM_ROUNDS=7      rounds for the 50K streaming scenario
 */

import pg from 'pg';
import inspector from 'node:inspector';
import { promisify } from 'node:util';
import { TurbineClient } from '../generated/turbine/index.js';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.js';
import { drizzle as drizzleRc } from 'drizzle-rc/node-postgres';
import { relations as rcRelations } from './schema-rc.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_070?host=/tmp';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '150', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '30', 10);
const EXPLAIN_SAMPLES = parseInt(process.env['EXPLAIN_SAMPLES'] ?? '25', 10);
const STREAM_ROUNDS = parseInt(process.env['STREAM_ROUNDS'] ?? '7', 10);

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}
const ms = (n: number) => n.toFixed(3);

/** Time one closure `rounds` times after `warmup`, return the median ms. */
async function timeIt(fn: () => Promise<unknown> | unknown, rounds = ROUNDS, warmup = WARMUP) {
  for (let i = 0; i < warmup; i++) await fn();
  const xs: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t = process.hrtime.bigint();
    await fn();
    xs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return med(xs);
}

/**
 * Interleaved timing for CROSS-ARM comparisons: every arm once per round with
 * the start order rotated, so drift over the life of the process is shared
 * rather than charged to whichever arm owned that slice of wall clock. The
 * phase split above is measured contiguously on purpose (it compares phases
 * WITHIN one arm), but any Turbine-vs-competitor number has to come from here
 * or it is not comparable to the primary harness.
 */
async function interleaveArms(
  arms: { name: string; fn: () => Promise<unknown> }[],
  rounds = ROUNDS,
  warmup = WARMUP,
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

// ─── CPU profiling ──────────────────────────────────────────

interface Frame {
  fn: string;
  file: string;
  selfMs: number;
  pct: number;
}

/**
 * Sample a closure with the V8 CPU profiler and aggregate SELF time per
 * function. Self time (not total) is what identifies the code actually burning
 * cycles rather than the code merely on the stack above it.
 */
async function cpuProfile(
  label: string,
  fn: () => Promise<unknown>,
  iterations: number,
): Promise<Frame[]> {
  const session = new inspector.Session();
  session.connect();
  const post = promisify(session.post.bind(session)) as (m: string, p?: unknown) => Promise<any>;

  await post('Profiler.enable');
  // 100 us: fine enough to resolve a sub-millisecond parse loop without the
  // sampling overhead itself dominating the measurement.
  await post('Profiler.setSamplingInterval', { interval: 100 });
  await post('Profiler.start');
  for (let i = 0; i < iterations; i++) await fn();
  const { profile } = await post('Profiler.stop');
  session.disconnect();

  const byId = new Map<number, any>();
  for (const n of profile.nodes) byId.set(n.id, n);

  // Self time from the sample stream: each sample charges one node.
  const hits = new Map<number, number>();
  const deltas: number[] = profile.timeDeltas ?? [];
  const samples: number[] = profile.samples ?? [];
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]!;
    hits.set(id, (hits.get(id) ?? 0) + (deltas[i] ?? 0));
  }

  const agg = new Map<string, Frame>();
  let total = 0;
  for (const [id, us] of hits) {
    const node = byId.get(id);
    if (!node) continue;
    const cf = node.callFrame;
    const file = String(cf.url || '')
      .replace(/^file:\/\//, '')
      .split('/')
      .slice(-2)
      .join('/');
    const fn2 = cf.functionName || '(anonymous)';
    // (idle) is time awaiting the socket and (program) is V8 itself; the
    // profiler's own `post` is instrument overhead. None is work this code can
    // remove, and leaving them in the denominator makes every real frame look
    // small, so percentages are of ACTIVE JS self time.
    if (fn2 === '(idle)' || fn2 === '(program)' || fn2 === '(garbage collector)') continue;
    if (fn2 === 'post' && file.includes('inspector')) continue;
    const key = `${fn2}@${file}`;
    const cur = agg.get(key) ?? { fn: fn2, file, selfMs: 0, pct: 0 };
    cur.selfMs += us / 1000;
    agg.set(key, cur);
    total += us / 1000;
  }
  const frames = [...agg.values()].sort((a, b) => b.selfMs - a.selfMs);
  for (const f of frames) f.pct = total > 0 ? (f.selfMs / total) * 100 : 0;

  console.log(`\n  CPU profile: ${label}  (${iterations} iters, ${ms(total)} ms ACTIVE JS self time)`);
  console.log('  ' + 'self ms'.padStart(9) + '  ' + 'self %'.padStart(6) + '  function');
  for (const f of frames.slice(0, 14)) {
    console.log(
      `  ${ms(f.selfMs).padStart(9)}  ${f.pct.toFixed(1).padStart(6)}  ${f.fn} [${f.file}]`,
    );
  }
  return frames;
}

/** Roll up frames into coarse buckets so the profile can be compared to the phase split. */
function bucketize(frames: Frame[]): Record<string, number> {
  const b: Record<string, number> = {
    'turbine parse': 0,
    'pg driver': 0,
    'JSON.parse': 0,
    'Date/temporal': 0,
    other: 0,
  };
  for (const f of frames) {
    const k = `${f.fn} ${f.file}`;
    if (/JSON|parse$/i.test(f.fn) && /json/i.test(f.fn)) b['JSON.parse']! += f.selfMs;
    else if (/parseRow|parseNestedRow|decodeJsonWireRow|buildRowDecodePlan|rowPlanMatches|decodeTemporalCell|transform/i.test(f.fn))
      b['turbine parse']! += f.selfMs;
    else if (/Date|parseDbDate|utc/i.test(k)) b['Date/temporal']! += f.selfMs;
    else if (/pg\/|pg-protocol|node-postgres|Result|parseRowAsArray|BufferReader|Parser/i.test(k))
      b['pg driver']! += f.selfMs;
    else b['other']! += f.selfMs;
  }
  return b;
}

// ─── Main ───────────────────────────────────────────────────

async function main() {
  const turbine = new TurbineClient({
    connectionString: DATABASE_URL,
    poolSize: 4,
    warnOnUnlimited: false,
    logging: false,
  });
  await turbine.connect();

  // Default-parser pool: what a normal client sees.
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  // Identity-parser pool: every cell arrives as the raw server text, so pg does
  // no JSON.parse and no Date construction. Differencing against `pool` prices
  // the driver's own decode.
  const rawPool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 4,
    types: { getTypeParser: () => (v: string) => v },
  } as pg.PoolConfig);

  const drizzlePool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const ddb = drizzle(drizzlePool, { schema });
  const rcPool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const rcdb = drizzleRc({ client: rcPool, relations: rcRelations, jit: true });

  console.log('='.repeat(78));
  console.log('turbine-orm 0.70.0 — A0 profile');
  console.log(`Node ${process.version}  ROUNDS=${ROUNDS} WARMUP=${WARMUP}`);
  console.log('='.repeat(78));

  async function serverMs(sql: string, params: readonly unknown[]) {
    const xs: number[] = [];
    for (let i = 0; i < EXPLAIN_SAMPLES; i++) {
      const r = await pool.query(
        `EXPLAIN (ANALYZE, TIMING OFF, FORMAT JSON) ${sql}`,
        params as unknown[],
      );
      const plan = (r.rows[0] as any)['QUERY PLAN'][0];
      xs.push((plan['Execution Time'] ?? 0) + (plan['Planning Time'] ?? 0));
    }
    return med(xs);
  }

  async function wireBytes(sql: string, params: readonly unknown[]) {
    const r = await rawPool.query({ text: sql, values: params as unknown[], rowMode: 'array' });
    let n = 0;
    for (const row of r.rows as (string | null)[][]) {
      for (const cell of row) n += cell === null ? 0 : Buffer.byteLength(cell);
    }
    return n;
  }

  // ── Nested scenarios ─────────────────────────────────────
  const scenarios = [
    {
      key: 'L2',
      title: 'findMany L2 — 50 users + posts',
      turbineArgs: { limit: 50, with: { posts: true } } as const,
      qi: () => turbine.users,
      drizzle: () => ddb.query.users.findMany({ limit: 50, with: { posts: true } } as never),
      rc: () => rcdb.query.users.findMany({ limit: 50, with: { posts: true } } as never),
    },
    {
      key: 'L3',
      title: 'findMany L3 — 10 users -> posts -> comments',
      turbineArgs: { limit: 10, with: { posts: { with: { comments: true }, limit: 5 } } } as const,
      qi: () => turbine.users,
      drizzle: () =>
        ddb.query.users.findMany({
          limit: 10,
          with: { posts: { limit: 5, with: { comments: true } } },
        } as never),
      rc: () =>
        rcdb.query.users.findMany({
          limit: 10,
          with: { posts: { limit: 5, with: { comments: true } } },
        } as never),
    },
  ];

  const report: Record<string, unknown> = {};

  for (const sc of scenarios) {
    console.log(`\n${'─'.repeat(78)}\n${sc.title}\n${'─'.repeat(78)}`);
    const qi = sc.qi() as any;

    // One build to get the SQL for EXPLAIN and for the raw-execute arms.
    const d0 = qi.buildFindMany(sc.turbineArgs);
    const sql: string = d0.sql;
    const params: unknown[] = d0.params;

    // ── Phase split, measured in ONE interleaved regime ──────
    //
    // Measuring phases contiguously and the total interleaved does not produce
    // subtractable numbers: a single arm running alone keeps its data in cache
    // and runs materially faster than the same arm sharing the process with
    // three others, so the phases summed to roughly half the interleaved total
    // and the residual was not attributable to anything. Every phase below is
    // therefore a nested prefix of the same work, all rotated against each
    // other in one loop, and each phase is a DIFFERENCE of neighbouring arms.
    //
    //   buildOnly       build
    //   buildExec       build + execute
    //   buildExecParse  build + execute + transform
    //   full            the public API (adds pool checkout, middleware, timeout)
    //
    // The COMPETITOR arms rotate in the SAME loop, which is not a convenience.
    // Measured separately, Turbine's L2 costs 1.28 ms when the only other arms
    // are its own phases and 2.34 ms when Drizzle and the RC rotate between its
    // calls, because the competitors evict its data between rounds. Attributing
    // a 2.3 ms headline to phases measured in the 1.3 ms regime would silently
    // lose half the time, so everything that is subtracted from anything else
    // is measured here, under one memory-pressure regime.
    const phases = await interleaveArms([
      { name: 'full', fn: () => qi.findMany(sc.turbineArgs) },
      {
        name: 'buildExecParse',
        fn: async () => {
          const d = qi.buildFindMany(sc.turbineArgs);
          const r = await pool.query(d.sql, d.params);
          return d.transform(r);
        },
      },
      {
        name: 'buildExec',
        fn: async () => {
          const d = qi.buildFindMany(sc.turbineArgs);
          return pool.query(d.sql, d.params);
        },
      },
      {
        name: 'buildExecRaw',
        fn: async () => {
          const d = qi.buildFindMany(sc.turbineArgs);
          return rawPool.query(d.sql, d.params);
        },
      },
      { name: 'buildOnly', fn: async () => qi.buildFindMany(sc.turbineArgs) },
      { name: 'Drizzle', fn: () => sc.drizzle() as Promise<unknown> },
      { name: 'DrizzleRC', fn: () => sc.rc() as Promise<unknown> },
    ]);

    const tBuild = phases.get('buildOnly')!;
    const tExec = phases.get('buildExec')! - tBuild;
    const tExecRaw = phases.get('buildExecRaw')! - tBuild;
    const tParse = phases.get('buildExecParse')! - phases.get('buildExec')!;
    const tClientOverhead = phases.get('full')! - phases.get('buildExecParse')!;

    const srv = await serverMs(sql, params);
    const bytes = await wireBytes(sql, params);

    const tTotal = phases.get('full')!;
    const tDrizzle = phases.get('Drizzle')!;
    const tRc = phases.get('DrizzleRC')!;

    const dz = (sc.drizzle() as any).toSQL?.() ?? null;
    let dzSrv = 0;
    let dzExec = 0;
    let dzBytes = 0;
    if (dz?.sql) {
      dzSrv = await serverMs(dz.sql, dz.params ?? []);
      dzExec = await timeIt(async () => {
        await pool.query(dz.sql, dz.params ?? []);
      });
      dzBytes = await wireBytes(dz.sql, dz.params ?? []);
    }

    const driverJson = tExec - tExecRaw;
    const wire = tExec - srv - driverJson;

    const phaseFull = phases.get('full')!;
    const pc = (x: number) => `${((x / phaseFull) * 100).toFixed(1)}%`.padStart(6);
    console.log(`\n  Turbine total (public API)      ${ms(phaseFull)} ms  (phase regime)`);
    console.log(`    build   (SQL generation)      ${ms(tBuild)} ms  ${pc(tBuild)}`);
    console.log(`    execute (server+wire+driver)  ${ms(tExec)} ms  ${pc(tExec)}`);
    console.log(`      - server (EXPLAIN ANALYZE)  ${ms(srv)} ms  ${pc(srv)}`);
    console.log(`      - driver JSON.parse         ${ms(driverJson)} ms  ${pc(driverJson)}`);
    console.log(`      - wire/protocol residual    ${ms(wire)} ms  ${pc(wire)}`);
    console.log(`    parse   (transform)           ${ms(tParse)} ms  ${pc(tParse)}`);
    console.log(`    client overhead (pool/mw)     ${ms(tClientOverhead)} ms  ${pc(tClientOverhead)}`);
    console.log(`    [build+exec+parse+overhead]   ${ms(tBuild + tExec + tParse + tClientOverhead)} ms  (must equal total)`);
    console.log(`  wire bytes                      ${bytes.toLocaleString()} B`);
    console.log(`\n  Drizzle 0.45 total              ${ms(tDrizzle)} ms`);
    if (dz?.sql) {
      console.log(`    - server (EXPLAIN ANALYZE)    ${ms(dzSrv)} ms`);
      console.log(`    - execute (same SQL via pg)   ${ms(dzExec)} ms`);
      console.log(`    - map residual (total-exec)   ${ms(tDrizzle - dzExec)} ms`);
      console.log(`    - wire bytes                  ${dzBytes.toLocaleString()} B  (${((bytes / dzBytes) * 100 - 100).toFixed(0)}% more for Turbine)`);
    }
    console.log(`  Drizzle RC 1.0 (jit) total      ${ms(tRc)} ms`);
    console.log(`\n  gap Turbine - Drizzle           ${ms(tTotal - tDrizzle)} ms`);
    console.log(`  gap server-side portion         ${ms(srv - dzSrv)} ms`);
    console.log(`  gap client-side portion         ${ms(tTotal - tDrizzle - (srv - dzSrv))} ms`);

    const frames = await cpuProfile(`Turbine ${sc.key} findMany`, () => qi.findMany(sc.turbineArgs), 400);
    console.log('  buckets:', JSON.stringify(bucketize(frames), (_k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));

    report[sc.key] = {
      tTotal, tBuild, tExec, tExecRaw, tParse, tClientOverhead,
      phaseFull: phases.get('full'), srv, driverJson, wire, bytes,
      tDrizzle, dzSrv, dzExec, dzBytes, tRc,
      turbineSql: sql,
      drizzleSql: dz?.sql ?? null,
    };

    console.log(`\n  SQL (turbine):\n    ${sql.replace(/\s+/g, ' ').slice(0, 300)}…`);
    if (dz?.sql) console.log(`  SQL (drizzle):\n    ${String(dz.sql).replace(/\s+/g, ' ').slice(0, 300)}…`);
  }

  // ── Streaming ────────────────────────────────────────────
  console.log(`\n${'─'.repeat(78)}\nstream — iterate 50K comments (batch 1000)\n${'─'.repeat(78)}`);

  const BATCH = 1000;

  // Turbine's own stream.
  const tStream = await timeIt(
    async () => {
      let n = 0;
      for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) n++;
      return n;
    },
    STREAM_ROUNDS,
    1,
  );

  // Raw CURSOR drain, same server-side mechanism Turbine uses, no transform.
  // This is the honest floor for the cursor protocol.
  const rawCursorDrain = async (parse: null | ((r: any) => unknown)) => {
    const client = await pool.connect();
    let n = 0;
    try {
      await client.query('BEGIN');
      await client.query('DECLARE prof_cur NO SCROLL CURSOR FOR SELECT * FROM comments');
      for (;;) {
        const r = await client.query(`FETCH ${BATCH} FROM prof_cur`);
        if (r.rows.length === 0) break;
        if (parse) for (const row of r.rows) parse(row);
        n += r.rows.length;
        if (r.rows.length < BATCH) break;
      }
      await client.query('CLOSE prof_cur');
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    return n;
  };

  const tRawCursor = await timeIt(() => rawCursorDrain(null), STREAM_ROUNDS, 1);

  // Raw KEYSET drain, which is what the benchmark's raw and Drizzle arms do.
  const rawKeyset = async () => {
    let n = 0;
    let last = 0;
    for (;;) {
      const r = await pool.query('SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2', [
        last,
        BATCH,
      ]);
      if (r.rows.length === 0) break;
      for (const row of r.rows) {
        n++;
        last = Number((row as any).id);
      }
      if (r.rows.length < BATCH) break;
    }
    return n;
  };
  const tRawKeyset = await timeIt(rawKeyset, STREAM_ROUNDS, 1);

  // The transform cost alone: same cursor drain, but running Turbine's parseRow
  // on every row via the public transform of a comments findMany.
  const cd = (turbine.comments as any).buildFindMany({});
  const oneBatch = await pool.query(`SELECT * FROM comments LIMIT ${BATCH}`);
  const tParseBatch = await timeIt(() => cd.transform(oneBatch));
  const rowsTotal = 50000;
  const estParseAll = (tParseBatch * rowsTotal) / BATCH;

  console.log(`\n  Turbine findManyStream          ${ms(tStream)} ms`);
  console.log(`  raw pg CURSOR drain (no parse)  ${ms(tRawCursor)} ms`);
  console.log(`  raw pg KEYSET drain (no parse)  ${ms(tRawKeyset)} ms`);
  console.log(`  cursor-vs-keyset protocol delta ${ms(tRawCursor - tRawKeyset)} ms`);
  console.log(`  parseRow on ${BATCH} rows          ${ms(tParseBatch)} ms`);
  console.log(`  => extrapolated to 50K rows     ${ms(estParseAll)} ms`);
  console.log(`  Turbine - rawCursor (residual)  ${ms(tStream - tRawCursor)} ms`);

  const sframes = await cpuProfile(
    'Turbine findManyStream 50K',
    async () => {
      let n = 0;
      for await (const _c of turbine.comments.findManyStream({ batchSize: BATCH })) n++;
      return n;
    },
    3,
  );
  console.log('  buckets:', JSON.stringify(bucketize(sframes), (_k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));

  report['stream'] = { tStream, tRawCursor, tRawKeyset, tParseBatch, estParseAll };

  console.log('\n=== JSON ===');
  console.log(JSON.stringify(report, null, 2));

  await turbine.disconnect();
  await pool.end();
  await rawPool.end();
  await drizzlePool.end();
  await rcPool.end();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('Profile error:', e);
  process.exit(1);
});
