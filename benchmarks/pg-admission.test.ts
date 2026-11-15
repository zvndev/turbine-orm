/** Schema fixtures only. Artificial durations below are never benchmark measurements. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { summarizeSamples } from './bench-harness.js';
import { assertHeadlineRuns, headlineArms } from './semantics.js';
import { assertExtendedRuns } from './extended-results.js';
import { assertSecondaryRun, assertSecondaryRuns, SECONDARY_CATALOG, type Suite } from './secondary-results.js';
import type { Report } from './secondary-contract.js';
import { syntheticRun } from './extended-test-fixture.js';
import { PG_FINAL_ADMISSION, type PgAdmissionContext, type PgIdentity } from './pg-admission.js';

const directory = process.env.SECONDARY_POSITIVE_DIRECTORY;
assert.ok(directory, 'Real native positives with actual observed identities are required');
const load = (name: string) => JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'));
const identity: PgIdentity = load('observed-identity');
const admission: PgAdmissionContext = { format: PG_FINAL_ADMISSION, expected: identity };
const options = { admission };
const samples = (name: string, n: number) =>
  summarizeSamples(
    name,
    Array.from({ length: n }, (_, i) => i + 1),
    true,
  );
function headline() {
  const r = load('headline');
  r.armProfile = 'original';
  r.settings = { rounds: 2, warmup: 0, streamRounds: 1 };
  r.results = r.catalog.map((row: { scenario: string }) => ({
    scenario: row.scenario,
    stats: headlineArms(row.scenario).map((name) => samples(name, row.scenario.startsWith('stream,') ? 1 : 2)),
  }));
  return r;
}
function extended() {
  const r = syntheticRun();
  Object.assign(r, { provenance: structuredClone(identity), runtime: identity.runtime });
  for (const row of r.results) row.stats = row.stats.map((stat) => samples(stat.name, stat.n));
  return r;
}
function secondary(suite: Suite): Report {
  const r: Report = load(suite);
  r.timing = true;
  r.rounds = 2;
  r.warmup = 0;
  const cells = new Map<string, { scenario: string; rttMs?: number; stats: ReturnType<typeof samples>[] }>();
  for (const v of r.verified) {
    const rttMs = (v as typeof v & { rttMs?: number }).rttMs;
    const key = JSON.stringify([v.scenario, rttMs]);
    const cell = cells.get(key) ?? { scenario: v.scenario, ...(rttMs === undefined ? {} : { rttMs }), stats: [] };
    cell.stats.push(samples(v.arm, 2));
    cells.set(key, cell);
  }
  r.results = [...cells.values()];
  return r;
}

test('F1/F3 complete original 239 cells pass sample/provenance schema admission only', () => {
  const h = headline(),
    e = extended();
  assertHeadlineRuns([h, structuredClone(h)], options);
  assertExtendedRuns([e, structuredClone(e)], options);
  let count =
    h.results.reduce((n: number, row: { stats: unknown[] }) => n + row.stats.length, 0) +
    e.results.reduce((n, row) => n + row.stats.length, 0);
  for (const suite of Object.keys(SECONDARY_CATALOG) as Suite[]) {
    const r = secondary(suite);
    assertSecondaryRuns([r, structuredClone(r)], suite, options);
    count += r.results.reduce((n, row) => n + row.stats.length, 0);
  }
  assert.equal(count, 239);
});
test('F1 Raw is mandatory on exactly nine headline rows and absent on the two L3 rows', () => {
  const complete = headline();
  let required = 0,
    absent = 0;
  for (const row of complete.results) {
    const r = structuredClone(complete);
    const target = r.results.find((v: typeof row) => v.scenario === row.scenario);
    if (row.stats.some((s: { name: string }) => s.name === 'Raw')) {
      required++;
      target.stats = target.stats.filter((s: { name: string }) => s.name !== 'Raw');
    } else {
      absent++;
      target.stats.push(samples('Raw', 2));
    }
    assert.throws(() => assertHeadlineRuns([r], options), /Exact headline arm catalog/);
  }
  assert.equal(required, 9);
  assert.equal(absent, 2);
});
for (const [name, make, validate] of [
  ['headline', headline, (r: ReturnType<typeof headline>, o = options) => assertHeadlineRuns([r], o)],
  ['extended', extended, (r: ReturnType<typeof extended>, o = options) => assertExtendedRuns([r], o)],
  ...(['stream', 'latency', 'deepoffset'] as const).map(
    (suite) =>
      [suite, () => secondary(suite), (r: Report, o = options) => assertSecondaryRun(r, suite, true, o)] as const,
  ),
] as const) {
  test(`${name}: F2 absent/mismatched identity and external manifest fail before equality`, () => {
    const r = make();
    assert.throws(() => validate(r as never, {} as typeof options), /External final/);
    for (const key of ['provenance', 'runtime']) {
      const bad = structuredClone(r) as Record<string, unknown>;
      delete bad[key];
      assert.throws(() => validate(bad as never), /provenance|runtime/i);
    }
    const bad = structuredClone(r) as typeof r & { provenance: PgIdentity; runtime: PgIdentity['runtime'] };
    bad.provenance.runtime.node = 'v26.12.0';
    bad.runtime = bad.provenance.runtime;
    assert.throws(() => validate(bad as never), /Node24.10/);
    const wrong = structuredClone(options);
    wrong.admission.expected.artifact.sha256 = 'b'.repeat(64);
    assert.throws(() => validate(r as never, wrong), /external|expected/i);
    const missing = structuredClone(options);
    missing.admission.expected.manifests.harness = Object.fromEntries(
      Object.entries(missing.admission.expected.manifests.harness).slice(0, 1),
    );
    assert.throws(() => validate(r as never, missing), /Missing required executed input/);
  });
  test(`${name}: F1/F3 partial samples and altered statistics fail`, () => {
    for (const mutation of [
      (s: Record<string, unknown>) => {
        s.n = 0;
      },
      (s: Record<string, unknown>) => {
        s.n = Number(s.n) + 1;
      },
      (s: Record<string, unknown>) => {
        delete s.samplesMs;
      },
      (s: Record<string, unknown>) => {
        (s.samplesMs as number[]).pop();
      },
      (s: Record<string, unknown>) => {
        s.median = -1;
      },
      (s: Record<string, unknown>) => {
        s.avg = 999;
      },
      (s: Record<string, unknown>) => {
        s.p95 = 999;
      },
      (s: Record<string, unknown>) => {
        s.p99 = 999;
      },
      (s: Record<string, unknown>) => {
        delete s.sampleMethod;
      },
      (s: Record<string, unknown>) => {
        s.p99Status = 'estimated';
      },
    ]) {
      const r = make();
      mutation(r.results[0]!.stats[0]! as unknown as Record<string, unknown>);
      assert.throws(() => validate(r as never));
    }
  });
}
test('F4 complete versioned extended flatten refusal cannot disappear or change', () => {
  for (const mutate of [
    (r: ReturnType<typeof extended>) => {
      delete (r as Partial<typeof r>).unsupportedSemantics;
    },
    (r: ReturnType<typeof extended>) => {
      delete (r.catalog as { id: string; unsupported?: unknown }[]).find((row) => row.id === 'strategy-many')!
        .unsupported;
    },
    (r: ReturnType<typeof extended>) => {
      (r.catalog as { id: string; unsupported?: unknown }[]).find((row) => row.id === 'strategy-many')!.unsupported =
        [];
    },
  ]) {
    const r = extended();
    mutate(r);
    assert.throws(() => assertExtendedRuns([r, structuredClone(r)], options), /unsupported/i);
  }
});

for (const suite of ['stream', 'latency', 'deepoffset'] as const)
  test(`F2 ${suite}: matching absent legacy profile objects are refused`, () => {
    const r = secondary(suite);
    delete (r.profile as Partial<typeof r.profile>).provenance;
    assert.throws(() => assertSecondaryRuns([r, structuredClone(r)], suite, options), /provenance/);
  });
test('bounded smoke cannot become final evidence through allowSmoke', () => {
  const r = extended();
  r.mode = 'bounded-smoke';
  r.settings.quick = true;
  assert.throws(() => assertExtendedRuns([r], { ...options, allowSmoke: true }), /smoke logs/);
});
