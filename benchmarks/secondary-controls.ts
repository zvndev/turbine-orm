/** Held-out mutations wrap real original-suite arms. Positive native preflights are required first. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLatency } from './bench-latency.js';
import { runStream } from './bench-stream-parity.js';
import { runDeepOffset } from './deepoffset.js';
import type { RunOptions, Scenario } from './secondary-contract.js';

const destination = resolve(process.argv[2]!);
assert.ok(process.argv[2], 'Existing native positive report directory required');
const suites = { stream: runStream, latency: runLatency, deepoffset: runDeepOffset };
for (const file of ['bench-stream-parity', 'bench-latency', 'deepoffset']) {
  const positive = JSON.parse(readFileSync(join(destination, `${file}.json`), 'utf8'));
  assert.equal(positive.status, 'passed');
  assert.equal(positive.cleanup.closed, true);
  assert.ok(positive.verified.length >= 7, 'Missing positive original-suite prerequisite');
}
const cases: { name: string; suite: keyof typeof suites; pattern: RegExp; mutate: (scenarios: Scenario[]) => void }[] =
  [
    {
      name: 'stream-late-content',
      suite: 'stream',
      pattern: /exact result mismatch/,
      mutate: (scenarios) => {
        const arm = scenarios[0]!.arms[0]!;
        const fn = arm.fn;
        arm.fn = (i, observe) => {
          let n = 0;
          return fn(i, (row) =>
            observe?.(++n === 49999 ? { ...(row as object), body: 'wrong held-out content' } : row),
          );
        };
      },
    },
    {
      name: 'stream-missing-value-observation',
      suite: 'stream',
      pattern: /Stream omitted complete row values/,
      mutate: (scenarios) => {
        const arm = scenarios[0]!.arms[0]!;
        const fn = arm.fn;
        arm.fn = (i, observe) => {
          let n = 0;
          return fn(i, (row) => {
            if (++n < 50000) observe?.(row);
          });
        };
      },
    },
    {
      name: 'stream-page-as-native',
      suite: 'stream',
      pattern: /different pool\/driver route/,
      mutate: (scenarios) => {
        scenarios[0]!.arms[0]!.fn = scenarios[0]!.arms.find((a) => a.name === 'Raw')!.fn;
      },
    },
    {
      name: 'latency-null-field-omission',
      suite: 'latency',
      pattern: /exact result mismatch/,
      mutate: (scenarios) => {
        const arm = scenarios[0]!.arms[0]!;
        const fn = arm.fn;
        arm.fn = async (i) => {
          const row = { ...((await fn(i)) as object) } as Record<string, unknown>;
          delete row.avatarUrl;
          return row;
        };
      },
    },
    {
      name: 'latency-nested-content',
      suite: 'latency',
      pattern: /exact result mismatch/,
      mutate: (scenarios) => {
        const arm = scenarios[1]!.arms[0]!;
        const fn = arm.fn;
        arm.fn = async (i) => {
          const rows = (await fn(i)) as { posts: { content: string }[] }[];
          rows[49]!.posts[9]!.content = 'wrong held-out child content';
          return rows;
        };
      },
    },
    {
      name: 'latency-dashboard-order',
      suite: 'latency',
      pattern: /exact result mismatch/,
      mutate: (scenarios) => {
        const arm = scenarios[2]!.arms[0]!;
        const fn = arm.fn;
        arm.fn = async (i) => {
          const dashboard = (await fn(i)) as unknown[];
          (dashboard[3] as unknown[]).reverse();
          return dashboard;
        };
      },
    },
    {
      name: 'latency-transaction-as-pipeline',
      suite: 'latency',
      pattern: /different pool\/driver route/,
      mutate: (scenarios) => {
        scenarios[2]!.arms[0]!.fn = scenarios[2]!.arms.find((a) => a.name === 'Raw tx')!.fn;
      },
    },
    {
      name: 'deep-tied-page-order',
      suite: 'deepoffset',
      pattern: /exact result mismatch/,
      mutate: (scenarios) => {
        assert.ok((scenarios[0]!.expected as unknown[]).length > 1, 'Nonempty independent page prerequisite');
        const arm = scenarios[0]!.arms[0]!;
        const fn = arm.fn;
        arm.fn = async (i) => ((await fn(i)) as unknown[]).reverse();
      },
    },
    {
      name: 'deep-force-custom-actually-named',
      suite: 'deepoffset',
      pattern: /Prepared name route mismatch/,
      mutate: (scenarios) => {
        for (const scenario of scenarios) scenario.arms[1]!.fn = scenario.arms[0]!.fn;
      },
    },
  ];
const results = [];
for (const test of cases) {
  const path = join(destination, `control-${test.name}.json`);
  const options: RunOptions = { verifyOnly: true, mutate: test.mutate, reportPath: path };
  await assert.rejects(suites[test.suite](options), test.pattern, `Held-out defect escaped: ${test.name}`);
  const report = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(report.status, 'failed');
  assert.equal(report.cleanup.closed, true, 'Failed preflight leaked clients');
  assert.equal(report.results.length, 0, 'A failed preflight reached timing');
  results.push({ name: test.name, suite: test.suite, rejected: true, error: report.error, cleanup: report.cleanup });
  console.log(`[held-out rejection] ${test.name}: ${report.error}`);
}
writeFileSync(join(destination, 'controls.json'), `${JSON.stringify({ status: 'passed', cases: results }, null, 2)}\n`);
