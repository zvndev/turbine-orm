import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bench } from './bench-harness.js';
import {
  driftMysql,
  interleaveMysql,
  type OperationSample,
  retainedResults,
  summarizeOperations,
} from './mysql-comparison-samples.js';

test('retains every measured arm/round and excludes warmup and setup', async () => {
  const samples: OperationSample[] = [],
    calls: string[] = [];
  const arms = ['a', 'b'].map((name) => ({
    name,
    setup: async () => {
      calls.push(`setup:${name}`);
    },
    fn: async () => {
      calls.push(name);
      return name;
    },
  }));
  const result = await interleaveMysql(
    new Bench({ rounds: 3, warmup: 2 }),
    'probe',
    arms,
    { rounds: 3, warmup: 2 },
    samples,
  );
  assert.deepEqual(
    samples.map((s) => [s.arm, s.round]),
    [
      ['a', 0],
      ['b', 0],
      ['b', 1],
      ['a', 1],
      ['a', 2],
      ['b', 2],
    ],
  );
  assert.equal(calls.length, 20);
  assert.equal(result.summary[0]!.p99Ms, null);
  assert.equal(result.summary[0]!.n, 3);
});

test('tail summaries use actual samples, never medians of other cells', () => {
  const samples = Array.from({ length: 100 }, (_, round) => ({
    scenario: 'probe',
    arm: 'a',
    round,
    durationMs: round + 1,
  }));
  const s = summarizeOperations(samples)[0]!;
  assert.equal(s.p50Ms, 50.5);
  assert.equal(s.p95Ms, 95);
  assert.equal(s.p99Ms, 99);
  assert.equal(s.n, 100);
  assert.equal(summarizeOperations(samples.slice(0, 99))[0]!.p99Ms, null);
});

test('failed operations cannot become successful retained samples', async () => {
  const samples: OperationSample[] = [];
  await assert.rejects(
    interleaveMysql(
      new Bench({ rounds: 1, warmup: 0 }),
      'probe',
      [
        {
          name: 'a',
          fn: async () => {
            throw new Error('forced');
          },
        },
      ],
      { rounds: 1, warmup: 0 },
      samples,
    ),
    /forced/,
  );
  assert.deepEqual(samples, []);
});

test('legacy JSON percentiles are replaced with summaries of retained call samples', () => {
  const samples = [1, 3, 20].map((durationMs, round) => ({ scenario: 'probe', arm: 'a', round, durationMs }));
  const result = retainedResults(
    [{ scenario: 'probe', stats: [{ name: 'a', median: 999, avg: 999, p95: 999, min: 999, n: 999 }] }],
    samples,
  )[0]!;
  assert.deepEqual(result.stats, [
    {
      name: 'a',
      median: 3,
      avg: 8,
      p95: 20,
      min: 1,
      n: 3,
      samplesMs: [1, 3, 20],
      p99: null,
      p99Status: 'unavailable-small-n',
      sampleMethod: 'milliseconds; p50 arithmetic median; p95/p99 nearest rank',
    },
  ]);
});

test('drift retains exactly 500 measured calls after the shared 500-call warmup', async () => {
  const samples: OperationSample[] = [];
  let calls = 0;
  const value = await driftMysql(
    new Bench({ rounds: 1, warmup: 0 }),
    {
      query: async (sql) => {
        assert.equal(sql, 'SELECT 1');
        calls++;
        return [];
      },
    },
    'control',
    samples,
  );
  assert.equal(calls, 1000);
  assert.equal(samples.length, 500);
  assert.deepEqual(
    samples.map((s) => s.round),
    Array.from({ length: 500 }, (_, i) => i),
  );
  assert.equal(value, summarizeOperations(samples)[0]!.p50Ms);
});
