import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateTiming } from '../scripts/validate-report.mjs';

function example() {
  const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  return {
    settings: { rounds: 10, warmup: 2 },
    metrics: { status: 'measured-separate-appendix' },
    catalog: [
      {
        id: 'point',
        scenario: 'point lookup',
        arms: { Turbine: { status: 'implemented' }, unsupported: { status: 'refused' } },
      },
    ],
    results: [
      {
        id: 'point',
        scenario: 'point lookup',
        arms: {
          Turbine: {
            n: 10,
            unit: 'ms',
            samples,
            median: 5.5,
            mean: 5.5,
            min: 1,
            p95: 10,
            p99: null,
            firstRow: null,
            peakMemory: null,
          },
        },
      },
    ],
    executionChecks: [
      ...Array.from({ length: 2 }, (_, i) => ({ id: 'point', arm: 'Turbine', phase: 'warmup', i, status: 'passed' })),
      ...Array.from({ length: 10 }, (_, i) => ({ id: 'point', arm: 'Turbine', phase: 'round', i, status: 'passed' })),
    ],
  };
}

test('complete timing samples and execution receipts are admitted', () => {
  assert.doesNotThrow(() => validateTiming(example()));
});

test('missing scenarios, arms and samples cannot become successful timing evidence', () => {
  for (const corrupt of [
    (r) => {
      r.results = [];
    },
    (r) => {
      r.results[0].arms = {};
    },
    (r) => {
      r.results[0].arms.Turbine.samples.pop();
    },
    (r) => {
      r.results[0].arms.unsupported = { ...r.results[0].arms.Turbine };
    },
  ]) {
    const out = example();
    corrupt(out);
    assert.throws(() => validateTiming(out), /Missing|Incomplete/);
  }
});

test('statistics agree with retained finite samples and unavailable metrics stay null', () => {
  for (const [corrupt, message] of [
    [
      (r) => {
        r.results[0].arms.Turbine.mean = 0;
      },
      /mean disagrees/,
    ],
    [
      (r) => {
        r.results[0].arms.Turbine.p95 = 1;
      },
      /p95 disagrees/,
    ],
    [
      (r) => {
        r.results[0].arms.Turbine.samples[0] = Number.NaN;
      },
      /Invalid timing sample/,
    ],
    [
      (r) => {
        r.results[0].arms.Turbine.p99 = 10;
      },
      /Unmeasured p99/,
    ],
  ]) {
    const out = example();
    corrupt(out);
    assert.throws(() => validateTiming(out), message);
  }
});

test('every warmup and measured call needs its own successful correctness receipt', () => {
  for (const corrupt of [
    (r) => {
      r.executionChecks.pop();
    },
    (r) => {
      r.executionChecks[1] = { ...r.executionChecks[0] };
    },
    (r) => {
      r.executionChecks[0].status = 'failed';
    },
  ]) {
    const out = example();
    corrupt(out);
    assert.throws(() => validateTiming(out));
  }
});
