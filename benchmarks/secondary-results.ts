/** Result validation for complete benchmark runs. Historical/text-only or incomplete runs are refused. */
import assert from 'node:assert/strict';
import { assertPgProvenance, assertPgSamples, type PgAdmissionOptions } from './pg-admission.js';
import { median } from './bench-harness.js';
import {
  assertRoute,
  DEEP_SCENARIO,
  LATENCY_SCENARIOS,
  SECONDARY_SEMANTICS,
  STREAM_SCENARIO,
} from './secondary-admission.js';
import type { Report, Verification } from './secondary-contract.js';

export const SECONDARY_CATALOG = {
  stream: [
    {
      scenario: STREAM_SCENARIO,
      arms: ['T rows', 'T batches', 'T batches#2', 'Drizzle', 'Drizzle RC', 'Prisma 7 pages', 'Raw'],
    },
  ],
  latency: [
    { scenario: LATENCY_SCENARIOS[0], arms: ['Turbine', 'Prisma 7', 'Drizzle', 'Drizzle RC', 'Raw'] },
    {
      scenario: LATENCY_SCENARIOS[1],
      arms: [
        'Turbine join',
        'Turbine batched',
        'Turbine auto',
        'Prisma 7',
        'Prisma 7 query',
        'Drizzle',
        'Drizzle RC',
        'Raw',
      ],
    },
    {
      scenario: LATENCY_SCENARIOS[2],
      arms: ['Turbine pipeline', 'Prisma 7 $tx', 'Drizzle tx', 'Drizzle RC tx', 'Raw tx'],
    },
  ],
  deepoffset: ['list, published posts in org 1, newest first (page 3)', DEEP_SCENARIO].map((scenario) => ({
    scenario,
    arms: [
      'Turbine named',
      'Turbine forceCustomPlan',
      'raw pg (unnamed)',
      'raw pg (NAMED)',
      'Drizzle',
      'Drizzle RC',
      'Prisma 7',
    ],
  })),
} as const;
export type Suite = keyof typeof SECONDARY_CATALOG;
const key = (scenario: string, rtt?: unknown) => JSON.stringify([scenario, rtt ?? null]);

export function assertSecondaryRun(report: Report, suite: Suite, timed = true, options: PgAdmissionOptions = {}): void {
  assert.equal(report.secondarySemantics, SECONDARY_SEMANTICS, 'Incompatible or missing secondary semantics');
  assert.equal(report.suite, suite);
  assert.equal(report.status, 'passed');
  assert.equal(report.error, undefined, 'Passed report retains an execution error');
  assert.equal(report.cleanupError, undefined, 'Passed report retains a cleanup error');
  assert.equal(report.timing, timed, 'Correctness-only reports cannot supply final comparison timings');
  assert.equal(report.cleanup.closed, true, 'Incomplete secondary cleanup');
  assert.ok(report.fixture, 'Missing original fixture');
  assert.ok(report.fixture.fingerprint.match(/^[a-f\d]{64}$/), 'Missing fixture identity');
  assert.deepEqual(report.fixture.counts, {
    organizations: 5,
    users: 1000,
    posts: 10000,
    comments: 50000,
    tags: 50,
    post_tags: 30000,
    bench_wide: 2000,
  });
  assert.deepEqual(report.profile.versions, {
    pg: '8.23.1',
    'drizzle-orm': '0.45.4',
    'drizzle-rc': '1.0.0-rc.5',
    '@prisma/client': '7.10.1',
    '@prisma/adapter-pg': '7.10.1',
    prisma: '7.10.1',
  });
  assert.ok(
    report.profile.provenance && typeof report.profile.provenance === 'object',
    'Missing full secondary profile provenance',
  );
  if (options.scope !== 'historical') {
    const provenance = report.profile.provenance;
    for (const field of ['generatedSha256', 'benchmarkLockSha256'])
      assert.match(
        String(provenance[field as keyof typeof provenance]),
        /^[a-f0-9]{64}$/,
        `Missing secondary provenance ${field}`,
      );
    assert.match(String(provenance.head), /^[a-f0-9]{40}$/);
    for (const value of [provenance.branch, provenance.path, provenance.rootPgPath, provenance.benchmarkPgPath])
      assert.ok(typeof value === 'string' && value.length > 0, 'Missing secondary source/driver identity');
    assert.ok(
      provenance.artifact && /^[a-f0-9]{64}$/.test(provenance.artifact.sha256),
      'Missing secondary archive identity',
    );
    assert.ok(provenance.installedDistSha256 || provenance.localDistSha256, 'Missing executed distribution identity');
  }
  if (suite === 'deepoffset') assert.equal(report.offset, 9000, 'Original deep-offset catalog requires offset 9000');
  const rtts: (number | undefined)[] = suite === 'latency' ? [0, 1, 5, 25] : [undefined];
  if (suite === 'latency') assert.deepEqual(report.rtts, rtts, 'Missing original RTT topology');
  const expected = new Map(
    rtts.flatMap((rtt) => SECONDARY_CATALOG[suite].map((s) => [key(s.scenario, rtt), [...s.arms].sort()] as const)),
  );
  const verified = new Map<string, Verification[]>();
  for (const v of report.verified) {
    const k = key(v.scenario, (v as Verification & { rttMs?: number }).rttMs);
    assert.ok(expected.has(k), `Unexpected secondary scenario: ${k}`);
    assert.ok(v.valueSha256.match(/^[a-f\d]{64}$/));
    const role = v.arm.startsWith('T')
      ? 'turbine'
      : v.arm.startsWith('Drizzle RC')
        ? 'rc'
        : v.arm.startsWith('Drizzle')
          ? 'stable'
          : v.arm.startsWith('Prisma')
            ? 'prisma'
            : 'raw';
    assert.equal(v.role, role, 'Catalog arm/pool identity mismatch');
    const route =
      suite === 'stream'
        ? role === 'turbine'
          ? 'cursor'
          : 'keyset'
        : suite === 'deepoffset'
          ? v.arm === 'Turbine named' || v.arm === 'raw pg (NAMED)'
            ? 'named'
            : 'unnamed'
          : v.scenario === LATENCY_SCENARIOS[0]
            ? role === 'turbine'
              ? 'named'
              : role === 'raw'
                ? 'unnamed'
                : 'read'
            : v.scenario === LATENCY_SCENARIOS[1]
              ? v.arm === 'Turbine batched' || v.arm === 'Prisma 7 query'
                ? 'batched'
                : 'join'
              : role === 'turbine'
                ? 'pipeline'
                : 'transaction';
    assert.equal(v.route, route, 'Catalog route weakened or relabeled');
    assertRoute(v.trace, role, v.route);
    if (v.preparedName !== undefined)
      assert.equal(v.trace.commands[0]!.name, v.preparedName, 'Descriptor/observed name mismatch');
    verified.set(k, [...(verified.get(k) ?? []), v]);
  }
  assert.equal(verified.size, expected.size, 'Incomplete verified secondary catalog');
  for (const [k, arms] of expected) {
    const v = verified.get(k)!;
    assert.deepEqual(v.map((x) => x.arm).sort(), arms, `Missing/duplicate verified arms in ${k}`);
    assert.equal(new Set(v.map((x) => x.valueSha256)).size, 1, `Different complete values in ${k}`);
  }
  assertPgProvenance(report, options);
  assert.ok(Number.isSafeInteger(report.rounds) && Number(report.rounds) > 0, 'Declared suite rounds required');
  assert.ok(Number.isSafeInteger(report.warmup) && Number(report.warmup) >= 0, 'Declared suite warmup required');
  if (!timed) {
    assert.equal(report.results.length, 0);
    return;
  }
  const actual = new Map(report.results.map((s) => [key(s.scenario, (s as typeof s & { rttMs?: number }).rttMs), s]));
  assert.equal(actual.size, report.results.length, 'Duplicate timed scenario');
  assert.equal(actual.size, expected.size, 'Incomplete timed secondary catalog');
  for (const [k, arms] of expected) {
    const result = actual.get(k);
    assert.ok(result, `Missing timed secondary scenario ${k}`);
    assert.deepEqual(result.stats.map((s) => s.name).sort(), arms, `Missing/duplicate timed arms in ${k}`);
    for (const s of result.stats) {
      assertPgSamples(s, Number(report.rounds), options);
    }
  }
}

export function assertSecondaryRuns(reports: Report[], suite: Suite, options: PgAdmissionOptions = {}): void {
  assert.ok(reports.length, 'No secondary runs');
  for (const report of reports) {
    assertSecondaryRun(report, suite, true, options);
    assert.equal(
      report.fixture!.fingerprint,
      reports[0]!.fixture!.fingerprint,
      'Fixture changed between repeated runs',
    );
    assert.equal(report.rounds, reports[0]!.rounds, 'Round counts differ');
    assert.equal(report.warmup, reports[0]!.warmup, 'Warmup counts differ');
    assert.deepEqual(report.provenance, reports[0]!.provenance, 'Secondary repeat executed provenance changed');
    assert.deepEqual(report.runtime, reports[0]!.runtime, 'Secondary repeat runtime changed');
    assert.deepEqual(report.profile, reports[0]!.profile, 'Execution profile or source/artifact provenance changed');
  }
}

/** Keep all original scenarios/arms and RC separate; no combined stable/RC geomean. */
export function secondarySummary(reports: Report[], suite: Suite, options: PgAdmissionOptions = {}) {
  assertSecondaryRuns(reports, suite, options);
  return {
    admissionScope: options.scope ?? 'final',
    secondarySemantics: SECONDARY_SEMANTICS,
    suite,
    runs: reports.length,
    fixture: reports[0]!.fixture,
    profile: reports[0]!.profile,
    catalog: reports[0]!.results.map((scenario) => ({
      scenario: scenario.scenario,
      ...('rttMs' in scenario ? { rttMs: scenario.rttMs } : {}),
      note: scenario.note,
      arms: scenario.stats.map((arm) => ({
        name: arm.name,
        median: median(
          reports
            .map(
              (report) =>
                report.results
                  .find(
                    (s) =>
                      key(s.scenario, (s as typeof s & { rttMs?: number }).rttMs) ===
                      key(scenario.scenario, (scenario as typeof scenario & { rttMs?: number }).rttMs),
                  )!
                  .stats.find((s) => s.name === arm.name)!.median,
            )
            .sort((a, b) => a - b),
        ),
      })),
    })),
  };
}

/** Compatibility view for the old site's three-series latency chart; full catalog remains in secondarySummary. */
export function latencyRows(report: Report) {
  const rows = new Map<string, { scenario: string; arm: string; byRtt: Record<string, number> }>();
  for (const s of report.results)
    for (const stat of s.stats) {
      const k = JSON.stringify([s.scenario, stat.name]);
      const row = rows.get(k) ?? { scenario: s.scenario, arm: stat.name, byRtt: {} };
      row.byRtt[String((s as typeof s & { rttMs: number }).rttMs)] = stat.median;
      rows.set(k, row);
    }
  return { rtts: report.rtts as number[], rounds: report.rounds as number, results: [...rows.values()] };
}
