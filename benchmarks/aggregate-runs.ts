/**
 * Aggregate the three full benchmark runs into medians of medians.
 *
 * Each `bench-interleaved.ts` run already reports a median over 200 interleaved
 * rounds per arm. Three full runs are taken because a whole PROCESS can be
 * unlucky (JIT state, page cache, thermal), and the median across runs is what
 * survives that. Reporting a single run's numbers, or the mean of three, would
 * let one bad process move a published figure.
 *
 * Also computes, per arm, the geometric mean of its ratio to the fastest ORM in
 * each scenario, and the geometric mean of overhead above hand-written pg over
 * the scenarios that have a raw control. Geometric rather than arithmetic
 * because these are ratios: an arm 2x slower on one scenario and 2x faster on
 * another is even, and only the geometric mean says so.
 *
 * Run:
 *   npx tsx aggregate-runs.ts <run1.log> <run2.log> <run3.log>
 */

import { readFileSync } from 'node:fs';

interface Stat { name: string; median: number; avg: number; p95: number; min: number; n: number }
interface Scenario { scenario: string; stats: Stat[]; note?: string }
interface RunJson { driftHead: number; driftMid: number; driftTail: number; results: Scenario[] }

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

function parseRun(path: string): RunJson {
  const txt = readFileSync(path, 'utf8');
  const i = txt.indexOf('=== JSON ===');
  if (i < 0) throw new Error(`no JSON block in ${path}`);
  // The harness prints a trailing "Done." after the JSON, so slice to the last
  // closing brace rather than to end-of-file.
  const rest = txt.slice(i + '=== JSON ==='.length);
  const end = rest.lastIndexOf('}');
  if (end < 0) throw new Error(`unterminated JSON block in ${path}`);
  return JSON.parse(rest.slice(0, end + 1));
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: tsx aggregate-runs.ts <run.log>...');
  process.exit(1);
}
const runs = files.map(parseRun);

// Scenario order from the first run; arms from the union, in first-seen order.
const scenarios = runs[0]!.results.map((r) => r.scenario);
const arms: string[] = [];
for (const r of runs[0]!.results) for (const s of r.stats) if (!arms.includes(s.name)) arms.push(s.name);

const table: { scenario: string; byArm: Map<string, number> }[] = [];
for (const sc of scenarios) {
  const byArm = new Map<string, number>();
  for (const arm of arms) {
    const vals: number[] = [];
    for (const run of runs) {
      const s = run.results.find((r) => r.scenario === sc)?.stats.find((x) => x.name === arm);
      if (s) vals.push(s.median);
    }
    if (vals.length) byArm.set(arm, med(vals));
  }
  table.push({ scenario: sc, byArm });
}

const ORMS = arms.filter((a) => a !== 'Raw');

console.log(`Aggregated from ${runs.length} runs: ${files.join(', ')}\n`);
const w = Math.max(...scenarios.map((s) => s.length)) + 2;
console.log(
  'scenario'.padEnd(w) + arms.map((a) => a.padStart(12)).join('') + '   winner',
);
console.log('-'.repeat(w + arms.length * 12 + 12));
for (const row of table) {
  let best = '';
  let bestV = Infinity;
  for (const a of ORMS) {
    const v = row.byArm.get(a);
    if (v !== undefined && v < bestV) { bestV = v; best = a; }
  }
  console.log(
    row.scenario.padEnd(w) +
      arms.map((a) => {
        const v = row.byArm.get(a);
        return (v === undefined ? '-' : v.toFixed(3)).padStart(12);
      }).join('') +
      '   ' + best,
  );
}

// Geometric means.
console.log('\ngeometric mean of ratio to the fastest ORM per scenario:');
for (const a of ORMS) {
  let logSum = 0;
  let n = 0;
  for (const row of table) {
    const v = row.byArm.get(a);
    if (v === undefined) continue;
    let best = Infinity;
    for (const o of ORMS) {
      const x = row.byArm.get(o);
      if (x !== undefined && x < best) best = x;
    }
    logSum += Math.log(v / best);
    n++;
  }
  console.log(`  ${a.padEnd(12)} ${Math.exp(logSum / n).toFixed(3)}x  (${n} scenarios)`);
}

console.log('\ngeometric mean of overhead above hand-written pg (scenarios with a raw control):');
for (const a of ORMS) {
  let logSum = 0;
  let n = 0;
  for (const row of table) {
    const v = row.byArm.get(a);
    const raw = row.byArm.get('Raw');
    if (v === undefined || raw === undefined) continue;
    logSum += Math.log(v / raw);
    n++;
  }
  if (n) console.log(`  ${a.padEnd(12)} ${Math.exp(logSum / n).toFixed(3)}x  (${n} scenarios)`);
}

// Win/loss record, ORM vs ORM.
console.log('\nhead-to-head record (scenarios won by row against column):');
const pad = 12;
console.log(''.padEnd(pad) + ORMS.map((a) => a.padStart(pad)).join(''));
for (const a of ORMS) {
  const cells = ORMS.map((b) => {
    if (a === b) return '-'.padStart(pad);
    let win = 0;
    let tot = 0;
    for (const row of table) {
      const x = row.byArm.get(a);
      const y = row.byArm.get(b);
      if (x === undefined || y === undefined) continue;
      tot++;
      if (x < y) win++;
    }
    return `${win}/${tot}`.padStart(pad);
  });
  console.log(a.padEnd(pad) + cells.join(''));
}

// Drift.
console.log('\ndrift probes (SELECT 1, ms) per run:');
for (let i = 0; i < runs.length; i++) {
  const r = runs[i]!;
  const xs = [r.driftHead, r.driftMid, r.driftTail];
  const spread = ((Math.max(...xs) - Math.min(...xs)) / Math.min(...xs)) * 100;
  console.log(
    `  run ${i + 1}: head ${r.driftHead.toFixed(4)}  mid ${r.driftMid.toFixed(4)}  tail ${r.driftTail.toFixed(4)}  spread ${spread.toFixed(1)}%`,
  );
}

console.log('\n=== MACHINE ===');
console.log(JSON.stringify(
  table.map((r) => ({ scenario: r.scenario, ...Object.fromEntries(r.byArm) })),
  null,
  2,
));
