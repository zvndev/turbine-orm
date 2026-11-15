import assert from 'node:assert/strict';
import { headlineNames } from './equivalence.js';
import { assertPgProvenance, assertPgSamples, type PgAdmissionOptions } from './pg-admission.js';

export const HEADLINE_SEMANTICS = 'exact-ordered-pg-supplied-named-v2';
export interface HeadlineRun {
  headlineSemantics?: unknown;
  settings?: { rounds: number; warmup: number; streamRounds: number };
  armProfile?: 'original' | 'rc-nojit-control';
  provenance?: unknown;
  results: { scenario: string; stats: { name: string; n?: number }[] }[];
}
export function headlineArms(scenario: string, noJit = false): string[] {
  assert.ok(headlineNames.includes(scenario as (typeof headlineNames)[number]), 'Unknown headline scenario');
  return [
    'Turbine',
    'Prisma 7',
    'Drizzle',
    'Drizzle RC',
    ...([headlineNames[2], headlineNames[4]].includes(scenario as (typeof headlineNames)[2]) ? [] : ['Raw']),
    ...(noJit ? ['Drizzle RC (no jit)'] : []),
  ];
}
/** Exact independent arm set, sample-derived statistics and external final identity precede repeat equality. */
export function assertHeadlineRuns(runs: HeadlineRun[], options: PgAdmissionOptions = {}): typeof HEADLINE_SEMANTICS {
  assert.ok(runs.length, 'No headline runs to aggregate');
  let baseline: unknown;
  for (const [i, run] of runs.entries()) {
    assert.equal(run.headlineSemantics, HEADLINE_SEMANTICS, `Run ${i + 1}: unsupported headlineSemantics`);
    const names = run.results.map((r) => r.scenario);
    assert.ok(
      names.length === headlineNames.length &&
        new Set(names).size === names.length &&
        headlineNames.every((name) => names.includes(name)),
      'Incomplete headline scenario catalog',
    );
    if (options.scope !== 'historical') {
      assert.ok(run.settings, 'Declared headline rounds/warmup/streamRounds required');
      assert.ok(Number.isSafeInteger(run.settings.rounds) && run.settings.rounds > 0);
      assert.ok(Number.isSafeInteger(run.settings.streamRounds) && run.settings.streamRounds > 0);
      assert.ok(Number.isSafeInteger(run.settings.warmup) && run.settings.warmup >= 0);
      assert.ok(
        run.armProfile === 'original' || run.armProfile === 'rc-nojit-control',
        'Versioned headline arm profile required',
      );
    }
    for (const row of run.results) {
      const expected = headlineArms(row.scenario, run.armProfile === 'rc-nojit-control');
      assert.deepEqual(
        row.stats.map((s) => s.name).sort(),
        expected.sort(),
        `Exact headline arm catalog required for ${row.scenario}`,
      );
      for (const stat of row.stats) {
        const n = run.settings
          ? row.scenario === headlineNames[6]
            ? run.settings.streamRounds
            : run.settings.rounds
          : Number(stat.n);
        assertPgSamples(stat, n, options);
      }
    }
    assertPgProvenance(run, options);
    const comparable = { settings: run.settings, armProfile: run.armProfile, provenance: run.provenance };
    if (baseline !== undefined) assert.deepEqual(comparable, baseline, 'Headline repeat provenance/settings changed');
    baseline = comparable;
  }
  return HEADLINE_SEMANTICS;
}
