/**
 * Price the hand-written L2 control statement under BOTH JSON encodings.
 *
 * WHY THIS EXISTS. The interleaved suite's `Raw` arm runs a hand-written L2
 * statement that builds its nested rows with `json_build_object`, because that
 * is what Turbine emitted when the arm was written. Turbine's PostgreSQL
 * default is now `json_build_array`, so on that one scenario the control is
 * doing strictly more work than the ORM it is supposed to bound, and Turbine's
 * "overhead above raw pg" on L2 comes out BELOW 1.00x.
 *
 * That number is real but it is not the claim a reader will take from it.
 * "Faster than hand-written SQL" would be false: it is faster than one
 * particular hand-written statement that spells the encoding the slower way.
 * The honest fix is to measure the control both ways and publish both, so the
 * like-for-like overhead is visible next to the recorded one.
 *
 * The recorded arm is deliberately NOT changed. It is the arm 0.50.0, 0.66.0
 * and 0.70.0 measured, and rewriting it would silently break comparability
 * across every published run to make one current number look better.
 *
 *   DATABASE_URL="postgresql:///turbine_bench_070?host=/tmp" npx tsx raw-l2-encoding.ts
 */

import pg from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgresql:///turbine_bench_070?host=/tmp';
const ROUNDS = Number.parseInt(process.env['ROUNDS'] ?? '200', 10);
const WARMUP = Number.parseInt(process.env['WARMUP'] ?? '20', 10);

/** Byte-for-byte the statement the suite's `Raw` arm runs. */
const OBJECT_L2 = `
    SELECT u.*, COALESCE((
      SELECT json_agg(json_build_object('id', p.id, 'userId', p.user_id, 'orgId', p.org_id,
        'title', p.title, 'content', p.content, 'published', p.published,
        'viewCount', p.view_count, 'createdAt', p.created_at, 'updatedAt', p.updated_at))
      FROM posts p WHERE p.user_id = u.id), '[]'::json) AS posts
    FROM users u LIMIT 50`;

/** The same statement with the only difference being the encoding function. */
const ARRAY_L2 = `
    SELECT u.*, COALESCE((
      SELECT json_agg(json_build_array(p.id, p.user_id, p.org_id,
        p.title, p.content, p.published,
        p.view_count, p.created_at, p.updated_at))
      FROM posts p WHERE p.user_id = u.id), '[]'::json) AS posts
    FROM users u LIMIT 50`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

  // Interleaved, alternating which encoding leads, for the same reason the main
  // harness interleaves: run them in blocks and any drift lands on one of them.
  const samples = new Map<string, number[]>([
    ['object', []],
    ['array', []],
  ]);
  const arms: [string, string][] = [
    ['object', OBJECT_L2],
    ['array', ARRAY_L2],
  ];

  for (const [, sql] of arms) for (let i = 0; i < WARMUP; i++) await pool.query(sql);

  for (let r = 0; r < ROUNDS; r++) {
    for (let k = 0; k < arms.length; k++) {
      const [name, sql] = arms[(k + (r % arms.length)) % arms.length]!;
      const t = performance.now();
      await pool.query(sql);
      samples.get(name)!.push(performance.now() - t);
    }
  }

  const obj = median(samples.get('object')!);
  const arr = median(samples.get('array')!);

  // Prove the two statements return the same nested data, so the timing
  // difference cannot be one of them returning less.
  const o = await pool.query(OBJECT_L2);
  const a = await pool.query(ARRAY_L2);
  const oChildren = o.rows.reduce((n, r) => n + (r.posts as unknown[]).length, 0);
  const aChildren = a.rows.reduce((n, r) => n + (r.posts as unknown[]).length, 0);

  console.log('\n=== raw hand-written L2 control, both JSON encodings ===');
  console.log(`rows ${o.rows.length}/${a.rows.length}, nested children ${oChildren}/${aChildren}`);
  if (o.rows.length !== a.rows.length || oChildren !== aChildren) {
    console.error('The two statements do not return the same data. Refusing to report.');
    process.exit(1);
  }
  console.log(`  raw L2, json_build_object (the recorded control arm)  ${obj.toFixed(3)} ms`);
  console.log(`  raw L2, json_build_array  (encoding-matched control)  ${arr.toFixed(3)} ms`);
  console.log(`  object / array = ${(obj / arr).toFixed(2)}x`);
  console.log(`\n=== JSON ===\n${JSON.stringify({ object: obj, array: arr, ratio: obj / arr }, null, 2)}`);

  await pool.end();
}

main().catch((err) => {
  console.error('\nError:', err);
  process.exit(1);
});
