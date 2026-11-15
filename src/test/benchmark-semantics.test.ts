import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { headlineNames } = await import(new URL('../../benchmarks/equivalence.ts', import.meta.url).href);
const { HEADLINE_SEMANTICS, assertHeadlineRuns: admitHeadlineRuns } = await import(
  new URL('../../benchmarks/semantics.ts', import.meta.url).href
);
const assertHeadlineRuns = (runs: Parameters<typeof admitHeadlineRuns>[0]) =>
  admitHeadlineRuns(runs, { scope: 'historical' });
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = () => ({
  headlineSemantics: HEADLINE_SEMANTICS,
  armProfile: 'original' as const,
  settings: { rounds: 1, warmup: 0, streamRounds: 1 },
  driftHead: 1,
  driftMid: 1,
  driftTail: 1,
  results: (headlineNames as string[]).map((scenario, index) => ({
    scenario,
    stats: ['Turbine', 'Prisma 7', 'Drizzle', 'Drizzle RC', ...(index === 2 || index === 4 ? [] : ['Raw'])].map(
      (name) => ({
        name,
        median: 1,
        avg: 1,
        p95: 1,
        min: 1,
        n: 1,
      }),
    ),
  })),
});

describe('benchmark campaign semantic boundary', () => {
  it('requires a supported marker, full scenarios and matching arm catalogs', () => {
    assert.equal(assertHeadlineRuns([run(), run()]), HEADLINE_SEMANTICS);
    assert.throws(() => assertHeadlineRuns([]), /No headline runs/);
    for (const marker of [undefined, 'old', 'exact-ordered-v1', 'exact-ordered-v2']) {
      assert.throws(() => assertHeadlineRuns([run(), { ...run(), headlineSemantics: marker }]), /headlineSemantics/);
    }
    const missing = run();
    missing.results.pop();
    assert.throws(() => assertHeadlineRuns([missing]), /scenario catalog/);
    const missingRc = run();
    for (const result of missingRc.results) result.stats = result.stats.filter((arm) => arm.name !== 'Drizzle RC');
    assert.throws(() => assertHeadlineRuns([missingRc]), /Exact headline arm catalog/);
    const missingArm = run();
    missingArm.results[0]!.stats.pop();
    assert.throws(() => assertHeadlineRuns([run(), missingArm]), /Exact headline arm catalog/);
  });

  it('both CLI aggregators refuse unversioned logs before writing results', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-benchmark-semantics-'));
    const invoke = (script: string, args: string[]) =>
      spawnSync(process.execPath, ['--import', 'tsx', join(root, 'benchmarks', script), ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 15_000,
      });
    try {
      const old = { ...run(), headlineSemantics: undefined };
      const log = (value: unknown) => `ROUNDS=1 WARMUP=0\n=== JSON ===\n${JSON.stringify(value)}\n`;
      const valid = join(dir, 'valid.log');
      const legacy = join(dir, 'default-run1.log');
      writeFileSync(valid, log(run()));
      writeFileSync(legacy, log(old));
      writeFileSync(join(dir, 'env.json'), '{}');
      const aggregated = invoke('aggregate-runs.ts', [valid, valid]);
      assert.equal(aggregated.status, 1, aggregated.stderr);
      assert.match(aggregated.stderr, /Complete retained actual sample array required/);
      for (const [script, args] of [
        ['aggregate-runs.ts', [legacy, valid]],
        ['aggregate-runs.ts', [valid, legacy]],
        ['build-results.ts', ['build', dir]],
      ] as const) {
        const result = invoke(script, [...args]);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /unsupported headlineSemantics|Complete retained actual sample array required/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
