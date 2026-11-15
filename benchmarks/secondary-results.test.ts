import { syntheticRun } from './extended-test-fixture.js';
/** Admission controls use native preflight reports, never invented benchmark evidence. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeSamples } from './bench-harness.js';
import type { ArmStat } from './bench-harness.js';
import { headlineNames } from './equivalence.js';
import { headlineArms, HEADLINE_SEMANTICS } from './semantics.js';
import type { Report, Verification } from './secondary-contract.js';
import {
  assertSecondaryRun as admitSecondaryRun,
  assertSecondaryRuns as admitSecondaryRuns,
  latencyRows,
  type Suite,
  secondarySummary as summarizeSecondary,
} from './secondary-results.js';

const assertSecondaryRun = (report: Report, suite: Suite, timed = true) =>
  admitSecondaryRun(report, suite, timed, { scope: 'historical' });
const assertSecondaryRuns = (reports: Report[], suite: Suite) =>
  admitSecondaryRuns(reports, suite, { scope: 'historical' });
const secondarySummary = (reports: Report[], suite: Suite) =>
  summarizeSecondary(reports, suite, { scope: 'historical' });

const directory = process.env['SECONDARY_POSITIVE_DIRECTORY'];
assert.ok(directory, 'Run secondary-native.mjs first and set SECONDARY_POSITIVE_DIRECTORY');
const paths = { stream: 'bench-stream-parity', latency: 'bench-latency', deepoffset: 'deepoffset' };
const native = (suite: Suite): Report => JSON.parse(readFileSync(join(directory, `${paths[suite]}.json`), 'utf8'));

// These in-memory 1ms cells test schema admission only. They are never written as a campaign or used for performance conclusions.
function shape(suite: Suite): Report {
  const report = native(suite);
  report.timing = true;
  report.rounds = 1;
  report.warmup = 0;
  const cells = new Map<string, { scenario: string; rttMs?: number; stats: ArmStat[] }>();
  for (const v of report.verified) {
    const rttMs = (v as Verification & { rttMs?: number }).rttMs;
    const key = JSON.stringify([v.scenario, rttMs]);
    const cell = cells.get(key) ?? { scenario: v.scenario, ...(rttMs === undefined ? {} : { rttMs }), stats: [] };
    cell.stats.push({ name: v.arm, median: 1, avg: 1, p95: 1, min: 1, n: 1 });
    cells.set(key, cell);
  }
  report.results = [...cells.values()];
  return report;
}

for (const suite of ['stream', 'latency', 'deepoffset'] as const) {
  test(`${suite}: complete native positive and synthetic timing-shape admission`, () => {
    assertSecondaryRun(native(suite), suite, false);
    assert.throws(() => assertSecondaryRun(native(suite), suite), /Correctness-only/);
    const report = shape(suite);
    assertSecondaryRun(report, suite);
    const summary = secondarySummary([report, structuredClone(report)], suite);
    assert.equal(summary.runs, 2);
    assert.ok(summary.catalog.every((s) => s.arms.some((a) => a.name.startsWith('Drizzle RC'))));
  });
  test(`${suite}: held-out catalog/value/route/cleanup/output omissions fail closed`, () => {
    const mutations = [
      (r: Report) => {
        r.secondarySemantics = 'old';
      },
      (r: Report) => {
        r.verified.pop();
      },
      (r: Report) => {
        r.verified.push(r.verified[0]!);
      },
      (r: Report) => {
        r.verified[0]!.valueSha256 = 'a'.repeat(64);
      },
      (r: Report) => {
        r.verified[0]!.trace.wire = [];
      },
      (r: Report) => {
        r.verified[0]!.route = 'read';
      },
      (r: Report) => {
        r.cleanup.closed = false;
      },
      (r: Report) => {
        r.cleanupError = 'cleanup failed';
      },
      (r: Report) => {
        r.error = 'execution failed';
      },
      (r: Report) => {
        r.results.pop();
      },
      (r: Report) => {
        r.results[0]!.stats = r.results[0]!.stats.filter((s) => !s.name.startsWith('Drizzle RC'));
      },
      (r: Report) => {
        r.results[0]!.stats[0]!.median = Number.NaN;
      },
      (r: Report) => {
        r.results[0]!.stats[0]!.n = 0;
      },
    ];
    for (const mutate of mutations) {
      const report = shape(suite);
      mutate(report);
      assert.throws(() => assertSecondaryRun(report, suite));
    }
    const changedFixture = shape(suite);
    changedFixture.fixture!.fingerprint = 'b'.repeat(64);
    assert.throws(() => assertSecondaryRuns([shape(suite), changedFixture], suite), /Fixture changed/);
    const changedSource = shape(suite);
    changedSource.profile.provenance.localDistSha256 = 'a'.repeat(64);
    assert.throws(() => assertSecondaryRuns([shape(suite), changedSource], suite), /provenance changed/);
  });
}
test('latency compatibility view keeps all three scenarios and all RTTs', () => {
  const rows = latencyRows(shape('latency'));
  assert.equal(rows.results.length, 18);
  assert.ok(rows.results.every((r) => Object.keys(r.byRtt).join(',') === '0,1,5,25'));
});

test('unpatched actual aggregate CLI refuses reports without external final admission', (t) => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = mkdtempSync(join(process.env.HOME!, 'secondary-aggregation-fixture-only-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = (name: string, value: unknown) =>
    writeFileSync(join(dir, name), `=== JSON ===\n${JSON.stringify(value)}\nDone.\n`);
  const original = native('stream');
  log('default-run1.log', {
    headlineSemantics: HEADLINE_SEMANTICS,
    settings: { rounds: 1, warmup: 0, streamRounds: 1 },
    armProfile: 'original',
    provenance: original.provenance,
    runtime: original.runtime,
    results: headlineNames.map((scenario) => ({
      scenario,
      stats: headlineArms(scenario).map((name) => summarizeSamples(name, [1], true)),
    })),
  });
  const extended = syntheticRun();
  Object.assign(extended, { provenance: original.provenance, runtime: original.runtime });
  for (const row of extended.results)
    row.stats = row.stats.map((stat) => ({ ...stat, ...summarizeSamples(stat.name, Array(stat.n).fill(1), true) }));
  log('extended-run1.log', extended);
  writeFileSync(
    join(dir, 'env.json'),
    JSON.stringify({
      version: '0.93.1',
      capturedAt: '2026-11-06T00:00:00Z',
      machine: 'schema fixture only',
      node: process.version,
      postgres: '18.6',
      pgDriver: '8.23.1',
      drizzle: '0.45.4',
      drizzleRc: '1.0.0-rc.5',
      prisma: '7.10.1',
    }),
  );
  log('stream-run1.log', shape('stream'));
  log('latency-run1.log', shape('latency'));
  log('deepoffset.log', shape('deepoffset'));
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      join(root, 'node_modules/tsx/dist/loader.mjs'),
      join(root, 'benchmarks/build-results.ts'),
      'build',
      dir,
    ],
    { cwd: root, encoding: 'utf8', timeout: 15000 },
  );
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /External final archive\/expected manifest admission is required/);
  assert.equal(existsSync(join(dir, 'results.json')), false);
});
