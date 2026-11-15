import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bench, summarizeSamples } from './bench-harness.js';

test('retained samples preserve acquisition order and derive actual nearest-rank tails', () => {
  const input = Array.from({ length: 100 }, (_, i) => 100 - i);
  const stat = summarizeSamples('arm', input, true);
  assert.deepEqual(stat.samplesMs, input);
  assert.notEqual(stat.samplesMs, input);
  assert.equal(stat.median, 50.5);
  assert.equal(stat.p95, 95);
  assert.equal(stat.p99, 99);
  assert.equal(stat.n, 100);
  assert.equal(stat.p99Status, 'unstable-tail');
  assert.equal(summarizeSamples('small', [4, 1, 3]).p99, null);
  assert.equal(summarizeSamples('small', [4, 1, 3]).p99Status, 'unavailable-small-n');
  assert.equal(summarizeSamples('large', Array(1000).fill(1)).p99Status, 'estimated');
  assert.equal(summarizeSamples('default', input).samplesMs, undefined);
  for (const invalid of [[], [-1], [NaN], [Infinity]]) assert.throws(() => summarizeSamples('bad', invalid));
});

test('retention leaves setup, warmup, measured work and rotating order intact', async () => {
  const calls: string[] = [];
  const bench = new Bench({ rounds: 3, warmup: 1, retainSamples: true });
  const arms = ['a', 'b'].map((name) => ({
    name,
    setup: async (i: number) => {
      calls.push(`setup:${name}:${i}`);
    },
    fn: async (i: number) => {
      calls.push(`call:${name}:${i}`);
    },
  }));
  const stats = await bench.interleave('test', arms);
  assert.deepEqual(calls, [
    'setup:a:0',
    'call:a:0',
    'setup:b:0',
    'call:b:0',
    'setup:a:0',
    'call:a:0',
    'setup:b:0',
    'call:b:0',
    'setup:b:1',
    'call:b:1',
    'setup:a:1',
    'call:a:1',
    'setup:a:2',
    'call:a:2',
    'setup:b:2',
    'call:b:2',
  ]);
  for (const stat of stats) {
    assert.equal(stat.n, 3);
    assert.equal(stat.samplesMs?.length, 3);
    assert.deepEqual(stat, summarizeSamples(stat.name, stat.samplesMs!, true));
  }
  const hidden = await bench.interleave('override', arms, { rounds: 1, warmup: 0, retainSamples: false });
  assert.equal(hidden[0]!.samplesMs, undefined);
});

test('verification runs for warmup and samples outside both retained and printed durations', async (t) => {
  let clock = 0;
  let verified = 0;
  const logs: string[] = [];
  t.mock.method(performance, 'now', () => clock);
  t.mock.method(console, 'log', (...args: unknown[]) => logs.push(args.join(' ')));
  const bench = new Bench({ rounds: 3, warmup: 2, retainSamples: true });
  const stats = await bench.interleave('synthetic-clock-control', [
    {
      name: 'Turbine',
      setup: async () => {
        clock += 1000;
      },
      fn: async () => {
        clock += 1;
        return { value: 42 };
      },
      verify: async (value) => {
        assert.deepEqual(value, { value: 42 });
        clock += 100;
        verified++;
      },
    },
  ]);
  assert.equal(verified, 5);
  assert.deepEqual(stats[0]!.samplesMs, [1, 1, 1]);
  assert.equal(stats[0]!.median, 1);
  assert.ok(logs.some((line) => line.includes('Turbine') && line.includes('1.000')));
  assert.ok(logs.every((line) => !line.includes('101.000')));
  await assert.rejects(
    bench.interleave(
      'rejection-control',
      [
        {
          name: 'arm',
          fn: async () => 42,
          verify: async () => {
            throw new Error('invalid measured effect');
          },
        },
      ],
      { warmup: 0 },
    ),
    /invalid measured effect/,
  );
  assert.equal(bench.results.length, 1);
});
