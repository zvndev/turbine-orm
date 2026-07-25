/**
 * Measure the `relationLoadStrategy: 'auto'` to-one cardinality heuristic.
 *
 * Shape: `posts.findMany({ limit: N, with: { user: true } })`. `posts.user` is a
 * belongsTo (to-one) whose correlation column is `users.id`, the primary key, so
 * it is perfectly indexed and the ONLY thing that can move the plan is the
 * parent-row cardinality rule (AUTO_TO_ONE_JOIN_MAX_ROWS, default 1000).
 *
 * Three arms interleaved per parent-set size, order rotated per round:
 *   join    - explicit single-statement correlated subquery
 *   batched - explicit base query + one flat follow-up per relation
 *   auto    - the 0.41+ implicit default that picks between them
 *
 * Also records, via the query-event stream, how many statements each arm
 * actually issued, so the plan `auto` chose is observed rather than assumed.
 *
 * Run:
 *   DATABASE_URL="postgresql:///turbine_bench?host=/tmp" npx tsx bench-auto-strategy.ts
 */

import { TurbineClient } from '../generated/turbine/index.js';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/turbine_bench';
const ROUNDS = parseInt(process.env['ROUNDS'] ?? '15', 10);
const WARMUP = parseInt(process.env['WARMUP'] ?? '3', 10);

const SIZES: (number | undefined)[] = [1, 5, 10, 25, 50, 100, 200, 400, 800, 1000, 1001, 1500, 2000, 4000, 8000, 10000, undefined];

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
}

async function main() {
  const db = new TurbineClient({ connectionString: DATABASE_URL, logging: false });
  await db.connect();

  // Count statements per operation so the chosen plan is observed, not assumed.
  let stmtCount = 0;
  const anyDb = db as unknown as { $on?: (ev: string, cb: (e: unknown) => void) => void };
  if (typeof anyDb.$on === 'function') {
    anyDb.$on('query', () => {
      stmtCount++;
    });
  }

  type Strategy = 'join' | 'batched' | 'auto';
  const strategies: Strategy[] = ['join', 'batched', 'auto'];

  const run = (limit: number | undefined, strategy: Strategy) =>
    db.posts.findMany({
      ...(limit === undefined ? {} : { limit }),
      with: { user: true },
      relationLoadStrategy: strategy,
    } as never);

  console.log(`auto to-one cardinality probe. ROUNDS=${ROUNDS} WARMUP=${WARMUP} Node ${process.version}`);
  console.log('shape: posts.findMany({ limit: N, with: { user: true } }), posts.user = belongsTo on the users PK\n');

  const table: {
    n: string;
    join: number;
    batched: number;
    auto: number;
    autoStmts: number;
    joinStmts: number;
    rows: number;
  }[] = [];

  for (const limit of SIZES) {
    const label = limit === undefined ? 'unbounded (10000)' : String(limit);
    const times: Record<Strategy, number[]> = { join: [], batched: [], auto: [] };
    const stmts: Record<Strategy, number> = { join: 0, batched: 0, auto: 0 };
    let rows = 0;

    for (const s of strategies) {
      for (let i = 0; i < WARMUP; i++) await run(limit, s);
    }

    // Observe statement counts once per strategy, outside the timed loop.
    for (const s of strategies) {
      stmtCount = 0;
      const res = (await run(limit, s)) as unknown[];
      stmts[s] = stmtCount;
      rows = res.length;
    }

    for (let r = 0; r < ROUNDS; r++) {
      const offset = r % strategies.length;
      for (let k = 0; k < strategies.length; k++) {
        const s = strategies[(k + offset) % strategies.length]!;
        const t = performance.now();
        await run(limit, s);
        times[s].push(performance.now() - t);
      }
    }

    const j = median(times.join);
    const b = median(times.batched);
    const a = median(times.auto);
    const best = Math.min(j, b);
    const picked = Math.abs(a - j) < Math.abs(a - b) ? 'join' : 'batched';
    const fastestName = j <= b ? 'join' : 'batched';

    table.push({ n: label, join: j, batched: b, auto: a, autoStmts: stmts.auto, joinStmts: stmts.join, rows });

    console.log(
      `n=${label.padEnd(17)} rows=${String(rows).padStart(5)}  join ${j.toFixed(2).padStart(8)} ms  batched ${b
        .toFixed(2)
        .padStart(8)} ms  auto ${a.toFixed(2).padStart(8)} ms  | stmts join=${stmts.join} batched=${stmts.batched} auto=${stmts.auto}` +
        `  | fastest=${fastestName}  auto looks like=${picked}  auto vs fastest=${(a / best).toFixed(2)}x`,
    );
  }

  console.log('\n=== JSON ===');
  console.log(JSON.stringify(table, null, 2));

  await db.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
