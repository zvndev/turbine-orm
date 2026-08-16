/**
 * Turn a round's run logs into exactly the figures the README, the site and the
 * results writeup quote, so those surfaces are transcribed from one computation
 * rather than each being derived by hand from the table.
 *
 * The pairwise "N times faster than X" figure is the GEOMETRIC MEAN of the
 * per-scenario ratio X/Turbine, which is the definition the earlier published
 * runs used (checked against RESULTS-0.66.0.md: it reproduces that run's
 * published 1.82x against Prisma from its own table). Arithmetic means are
 * wrong for ratios, and quoting the ratio of two geometric means only happens
 * to agree because the per-scenario normalizer cancels.
 *
 *   npx tsx summarize-round.ts <dir> <prefix>
 */

import { readFileSync } from 'node:fs';

interface Stat { name: string; median: number }
interface Scenario { scenario: string; stats: Stat[] }
interface RunJson { driftHead: number; driftMid: number; driftTail: number; results: Scenario[] }

const dir = process.argv[2];
const prefix = process.argv[3];
if (!dir || !prefix) {
  console.error('usage: tsx summarize-round.ts <dir> <prefix>');
  process.exit(1);
}

function med(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}
function geo(xs: number[]): number {
  return Math.exp(xs.reduce((a, b) => a + Math.log(b), 0) / xs.length);
}
function parse(p: string): RunJson {
  const t = readFileSync(p, 'utf8');
  const i = t.indexOf('=== JSON ===');
  if (i < 0) throw new Error(`no JSON block in ${p}`);
  const rest = t.slice(i + '=== JSON ==='.length);
  return JSON.parse(rest.slice(0, rest.lastIndexOf('}') + 1));
}

const runs = [1, 2, 3].map((i) => parse(`${dir}/${prefix}-run${i}.log`));
const scenarios = runs[0]!.results.map((r) => r.scenario);
const arms: string[] = [];
for (const r of runs[0]!.results) for (const s of r.stats) if (!arms.includes(s.name)) arms.push(s.name);

const table = new Map<string, Map<string, number>>();
for (const sc of scenarios) {
  const m = new Map<string, number>();
  for (const arm of arms) {
    const v = runs
      .map((r) => r.results.find((x) => x.scenario === sc)?.stats.find((s) => s.name === arm)?.median)
      .filter((x): x is number => x != null);
    if (v.length) m.set(arm, med(v));
  }
  table.set(sc, m);
}

const ORMS = arms.filter((a) => a !== 'Raw');
console.log(`\n### ${prefix} ###\n`);
console.log('| Scenario | ' + arms.join(' | ') + ' | winner |');
console.log('|---' .repeat(arms.length + 2) + '|');
for (const sc of scenarios) {
  const m = table.get(sc)!;
  let best = '';
  let bv = Infinity;
  for (const a of ORMS) {
    const v = m.get(a);
    if (v != null && v < bv) { bv = v; best = a; }
  }
  const cells = arms.map((a) => {
    const v = m.get(a);
    if (v == null) return 'n/a';
    const s = v >= 10 ? v.toFixed(3) : v.toFixed(3);
    return a === best ? `**${s} ms**` : `${s} ms`;
  });
  console.log(`| ${sc} | ${cells.join(' | ')} | ${best} |`);
}

console.log('\npairwise geometric mean of (arm / Turbine) over all 10 scenarios:');
for (const a of ORMS) {
  if (a === 'Turbine') continue;
  const rs: number[] = [];
  for (const sc of scenarios) {
    const m = table.get(sc)!;
    const t = m.get('Turbine');
    const v = m.get(a);
    if (t != null && v != null) rs.push(v / t);
  }
  console.log(`  Turbine is ${geo(rs).toFixed(3)}x faster than ${a}  (n=${rs.length})`);
}

console.log('\ngeometric mean of ratio to the fastest ORM per scenario:');
for (const a of ORMS) {
  const rs: number[] = [];
  for (const sc of scenarios) {
    const m = table.get(sc)!;
    let bv = Infinity;
    for (const o of ORMS) { const v = m.get(o); if (v != null && v < bv) bv = v; }
    const v = m.get(a);
    if (v != null && Number.isFinite(bv)) rs.push(v / bv);
  }
  console.log(`  ${a.padEnd(12)} ${geo(rs).toFixed(3)}x`);
}

console.log('\noverhead above hand-written pg (scenarios with a raw control):');
for (const a of ORMS) {
  const rs: number[] = [];
  for (const sc of scenarios) {
    const m = table.get(sc)!;
    const r = m.get('Raw');
    const v = m.get(a);
    if (r != null && v != null) rs.push(v / r);
  }
  console.log(`  ${a.padEnd(12)} ${geo(rs).toFixed(3)}x  (n=${rs.length})`);
}

console.log('\nhead-to-head, scenarios won by Turbine:');
for (const a of ORMS) {
  if (a === 'Turbine') continue;
  let w = 0;
  let n = 0;
  for (const sc of scenarios) {
    const m = table.get(sc)!;
    const t = m.get('Turbine');
    const v = m.get(a);
    if (t != null && v != null) { n++; if (t < v) w++; }
  }
  console.log(`  vs ${a.padEnd(12)} ${w}/${n}`);
}

console.log('\ndrift probes (SELECT 1, ms):');
for (const [i, r] of runs.entries()) {
  const p = [r.driftHead, r.driftMid, r.driftTail];
  const spread = ((Math.max(...p) - Math.min(...p)) / Math.min(...p)) * 100;
  console.log(`  run ${i + 1}: ${p.map((x) => x.toFixed(4)).join(' / ')}  spread ${spread.toFixed(1)}%`);
}
