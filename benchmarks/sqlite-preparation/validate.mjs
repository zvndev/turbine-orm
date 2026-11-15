import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ARMS, CAPACITY, CASES } from './workload.mjs';

const sha = (value) => assert.match(value, /^[a-f0-9]{64}$/);
const text = (value) => assert.ok(typeof value === 'string' && value.length > 0);
const count = (value) => assert.ok(Number.isSafeInteger(value) && value >= 0, 'invalid preparation counter');
function counters(value) {
  for (const key of ['prepares', 'hits', 'evictions', 'retained', 'peak']) count(value[key]);
  assert.ok(value.retained <= value.peak && value.peak <= CAPACITY && value.peak <= value.prepares);
  assert.ok(value.evictions + value.retained <= value.prepares);
}
const controlKey = (c) => JSON.stringify([c.control, c.arm ?? null, c.reuse ?? null]);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function validate(report) {
  assert.equal(report.format, 'sqlite-preparation-v1');
  assert.ok(['v22.16.0', 'v24.10.0'].includes(report.runtime.node));
  assert.match(report.runtime.binarySha256, /^[a-f0-9]{64}$/);
  for (const key of ['executable', 'platform', 'arch']) text(report.runtime[key]);
  text(report.runtime.sqlite.version);
  text(report.runtime.sqlite.source);
  assert.match(report.source.head, /^[a-f0-9]{40}$/);
  assert.equal(typeof report.source.branch, 'string');
  assert.equal(typeof report.source.status, 'string');
  text(report.source.worktree);
  sha(report.dependencies.lockSha256);
  text(report.dependencies.tsx);
  for (const name of [
    'src/sqlite.ts',
    ...['run', 'workload', 'controls', 'memory', 'validate', 'workload.test'].map(
      (n) => `benchmarks/sqlite-preparation/${n}.mjs`,
    ),
  ])
    sha(report.source.files[name]);
  for (const value of Object.values(report.source.files)) sha(value);
  assert.equal(report.config.capacity, CAPACITY);
  assert.ok(Number.isSafeInteger(report.config.rounds) && report.config.rounds >= 4 && report.config.rounds <= 100);
  assert.ok(
    Number.isSafeInteger(report.config.iterations) &&
      report.config.iterations >= 128 &&
      report.config.iterations <= 100000,
  );
  assert.equal(report.samples.length, CASES.length * ARMS.length * 2 * report.config.rounds);
  const seen = new Set();
  for (const s of report.samples) {
    assert.ok(CASES.includes(s.name) && ARMS.includes(s.arm));
    assert.ok(s.phase === 'cold' || s.phase === 'warm');
    assert.ok(Number.isSafeInteger(s.round) && s.round >= 0 && s.round < report.config.rounds);
    const key = `${s.name}:${s.arm}:${s.phase}:${s.round}`;
    assert.ok(!seen.has(key), `duplicate ${key}`);
    seen.add(key);
    assert.deepStrictEqual([...s.order].sort(), [...ARMS].sort());
    assert.ok(Number.isFinite(s.ms) && s.ms > 0);
    assert.ok(Number.isFinite(s.cpuMicros) && s.cpuMicros >= 0);
    const n = s.phase === 'cold' ? 1 : report.config.iterations;
    assert.equal(s.operations, n * (s.name === 'transaction' ? 4 : 1));
    assert.equal(s.checkedResults, s.operations);
    const expectedCounter = s.name.startsWith('write-') ? n : s.name === 'transaction' ? Math.ceil(n / 2) : 0;
    assert.equal(s.counter, expectedCounter);
    counters(s.preparation);
    count(s.timedPrepares);
    count(s.timedHits);
    assert.ok(s.preparation.prepares >= s.timedPrepares && s.preparation.hits >= s.timedHits);
    assert.equal(s.timedPrepares + s.timedHits, s.operations);
    if (!s.arm.endsWith('reuse')) {
      assert.equal(s.timedPrepares, s.operations);
      assert.equal(s.preparation.retained, 0);
      assert.equal(s.preparation.hits, 0);
      assert.equal(s.preparation.evictions, 0);
    } else if (s.phase === 'warm') {
      assert.equal(s.timedPrepares, s.name === 'shapes-churn' ? s.operations : 0);
    }
  }
  const expectedControls = [
    ...ARMS.map((arm) => ({ control: 'binding-errors-bounds', arm })),
    ...[false, true].map((reuse) => ({ control: 'native-schema-auto-reprepare-and-explicit-invalidation', reuse })),
    ...['pool-fresh', 'pool-reuse'].flatMap((arm) => [
      { control: 'external-schema-decoder-invalidation', arm },
      { control: 'active-stream-ownership-fresh-iterator', arm },
    ]),
    { control: 'borrowed-handle-survives-disconnect' },
    { control: 'owned-handle-refuses-after-disconnect' },
  ];
  assert.deepStrictEqual(report.controls.map(controlKey).sort(), expectedControls.map(controlKey).sort());
  let documentedUnsupported = 0;
  for (const c of report.controls) {
    if (c.control === 'external-schema-decoder-invalidation') {
      assert.deepStrictEqual(c.freshPool, [{ v: 1 }]);
      if (c.status === 'unsupported-existing-stale-decode') {
        // Historical v1 evidence keeps its original observed limitation.
        assert.notEqual(c.passed, true);
        assert.deepStrictEqual(c.observed, [{ v: true }]);
        documentedUnsupported++;
      } else {
        assert.equal(c.status, 'passed-current-decode');
        assert.equal(c.passed, true);
        assert.deepStrictEqual(c.observed, [{ v: 1 }]);
      }
    } else assert.equal(c.passed, true);
    if (c.control === 'binding-errors-bounds') counters(c);
  }
  assert.equal(report.controls.filter((c) => c.passed === true).length, 14 - documentedUnsupported);
  assert.equal(report.memory.length, ARMS.length);
  assert.deepStrictEqual(report.memory.map((m) => m.arm).sort(), [...ARMS].sort());
  for (const m of report.memory) {
    assert.equal(m.checkedResults, 8192);
    assert.deepStrictEqual(
      m.snapshots.map((s) => s.phase),
      ['before-fixture', 'fixture', 'after-4096-shapes', 'after-8192-shapes', 'references-cleared', 'handle-closed'],
    );
    for (const s of m.snapshots) {
      assert.ok(s.rss > 0 && s.heapUsed > 0);
      if (s.preparation) counters(s.preparation);
    }
    assert.equal(m.snapshots.at(-1).preparation.retained, 0);
  }
  assert.equal(report.comparisons.length, CASES.length * 2);
  const comparisons = new Set();
  for (const c of report.comparisons) {
    assert.ok(CASES.includes(c.name) && ['native', 'pool'].includes(c.family));
    const key = `${c.name}:${c.family}`;
    assert.ok(!comparisons.has(key), 'duplicate comparison');
    comparisons.add(key);
    const series = (suffix) =>
      report.samples
        .filter((s) => s.name === c.name && s.phase === 'warm' && s.arm === `${c.family}-${suffix}`)
        .sort((a, b) => a.round - b.round)
        .map((s) => s.ms);
    const fresh = series('fresh'),
      reuse = series('reuse'),
      control = series('control');
    const delta = fresh.map((v, i) => v - reuse[i]),
      noise = fresh.map((v, i) => v - control[i]);
    for (const [key, value] of Object.entries({
      freshMedianMs: median(fresh),
      reuseMedianMs: median(reuse),
      pairedFreshMinusReuseMs: delta,
      identicalFreshMinusControlMs: noise,
      pairedMedianMs: median(delta),
      controlMedianMs: median(noise),
      deltaRangeMs: [Math.min(...delta), Math.max(...delta)],
      controlRangeMs: [Math.min(...noise), Math.max(...noise)],
    }))
      assert.deepStrictEqual(c[key], value, `comparison ${key} differs from raw samples`);
  }
  assert.deepStrictEqual(report.cleanup, {
    nativeHandlesClosed: true,
    memoryChildrenExited: true,
    servicesStarted: 0,
    fixtureFilesCreated: 0,
  });
  return {
    samples: report.samples.length,
    checkedTimedResults: report.samples.reduce((n, s) => n + s.checkedResults, 0),
    checkedMemoryResults: report.memory.reduce((n, m) => n + m.checkedResults, 0),
    documentedUnsupported,
  };
}

if (process.argv[1]?.endsWith('/validate.mjs')) {
  assert.ok(process.argv[2], 'usage: node --import tsx validate.mjs report.json');
  console.log(JSON.stringify(validate(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
}
