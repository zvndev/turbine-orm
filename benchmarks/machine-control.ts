/**
 * Machine-state control. Contains NO turbine-orm code, and imports none.
 *
 * Why this file exists, and it is not a formality. The 0.70.0 round's absolute
 * numbers came in roughly 35% below the 0.66.0 round's on every arm including
 * hand-written `pg`, and the only reason that was read as "the machine is
 * faster today" rather than "Turbine got faster" is that a control containing
 * none of Turbine's code moved by the same proportion. Without such a control
 * a contended box is indistinguishable from a regression, and a quiet box is
 * indistinguishable from an improvement. Absolute values across dates are a
 * property of the machine; only ratios within a run belong to the software.
 *
 * So this measures four fixed shapes through raw `pg` alone:
 *
 *   - `SELECT 1`            protocol + scheduler floor
 *   - flat 100 users        small result, parse-bound
 *   - L2 50 users + posts   the multi-millisecond shape the headline turns on
 *   - 50K keyset drain      the streaming shape
 *
 * Run it BEFORE and AFTER the suites. If the two disagree by more than the
 * drift floor, the box moved underneath the run and the numbers in between are
 * not publishable. Run it with nothing else running; that is the point.
 *
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx machine-control.ts <label>
 */

import pg from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_070?host=/tmp';
const LABEL = process.argv[2] ?? 'control';
const ROUNDS = Number.parseInt(process.env['ROUNDS'] ?? '200', 10);
const WARMUP = Number.parseInt(process.env['WARMUP'] ?? '20', 10);

/** The same L2 statement the benchmark's raw arm runs, kept in sync by hand. */
const RAW_L2 = `
    SELECT u.*, COALESCE((
      SELECT json_agg(json_build_object('id', p.id, 'userId', p.user_id, 'orgId', p.org_id,
        'title', p.title, 'content', p.content, 'published', p.published,
        'viewCount', p.view_count, 'createdAt', p.created_at, 'updatedAt', p.updated_at))
      FROM posts p WHERE p.user_id = u.id), '[]'::json) AS posts
    FROM users u LIMIT 50`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  if (s.length === 0) return Number.NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

async function time(fn: () => Promise<unknown>, rounds: number, warmup: number): Promise<number> {
  for (let i = 0; i < warmup; i++) await fn();
  const s: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t = performance.now();
    await fn();
    s.push(performance.now() - t);
  }
  return median(s);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

  const probe = await time(() => pool.query('SELECT 1'), 500, 500);
  const flat = await time(() => pool.query('SELECT * FROM users LIMIT 100'), ROUNDS, WARMUP);
  const l2 = await time(() => pool.query(RAW_L2), ROUNDS, WARMUP);

  const drain = await time(async () => {
    let n = 0;
    let lastId = 0;
    for (;;) {
      const res = await pool.query('SELECT * FROM comments WHERE id > $1 ORDER BY id ASC LIMIT $2', [lastId, 1000]);
      if (res.rows.length === 0) break;
      for (const row of res.rows) {
        n++;
        lastId = Number(row.id);
      }
      if (res.rows.length < 1000) break;
    }
    if (n !== 50000) throw new Error(`drain returned ${n} rows, expected 50000`);
    return n;
  }, 9, 1);

  const out = {
    label: LABEL,
    at: new Date().toISOString(),
    node: process.version,
    loadavg: (await import('node:os')).loadavg(),
    'SELECT 1': probe,
    'raw flat 100 users': flat,
    'raw L2 50 users + posts': l2,
    'raw 50K keyset drain': drain,
  };
  console.log(`\n=== machine control: ${LABEL} ===`);
  console.log(`node ${out.node}  loadavg ${out.loadavg.map((n) => n.toFixed(2)).join(' ')}`);
  console.log(`  SELECT 1                 ${probe.toFixed(4)} ms`);
  console.log(`  raw flat 100 users       ${flat.toFixed(3)} ms`);
  console.log(`  raw L2 50 users + posts  ${l2.toFixed(3)} ms`);
  console.log(`  raw 50K keyset drain     ${drain.toFixed(3)} ms`);
  console.log(`\n=== JSON ===\n${JSON.stringify(out, null, 2)}`);

  await pool.end();
}

main().catch((err) => {
  console.error('\nControl error:', err);
  process.exit(1);
});
