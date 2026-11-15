import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  assertExact,
  assertIncrementEffect,
  countValue,
  dashboardValue,
  expectedHeadline,
  headlineNames,
} from '../dist/canonical/equivalence.js';
import {
  aggregateRows,
  assertExtendedExact,
  expectedExtended,
  flattenTags,
  isWrite,
  prepareWrite,
  scratchQuery,
  verifyWrite,
} from '../dist/canonical/extended-equivalence.js';
import { execute as awaitExecution } from './execution.mjs';
import { drain, receipt, streamFor } from './native.mjs';

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b),
    n = sorted.length;
  return {
    n,
    unit: 'ms',
    median: n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2,
    mean: sorted.reduce((a, b) => a + b, 0) / n,
    min: sorted[0],
    p95: sorted[Math.ceil(n * 0.95) - 1],
    p99: null,
    firstRow: null,
    peakMemory: null,
    samples,
  };
}
export async function timing(report, rows, arms, oracle, scope, rounds, warmup, fixture, full) {
  assert.ok(fixture && full, 'Timing requires independent pinned fixtures');
  const streamOracle = receipt();
  for (const row of fixture.comments) streamOracle.row(row);
  const expectedStream = streamOracle.done();
  // Wire observers are an untimed admission tool; remove them before warmup/sampling.
  for (const arm of arms) arm.trace?.detach();
  report.results = [];
  report.executionChecks = [];
  for (const row of rows) {
    const selected = arms.filter((arm) => row.arms[arm.name]?.status === 'implemented');
    if (!selected.length) continue;
    const run = async (arm, i) => {
      if (row.index === 6) return drain(streamFor(arm), undefined, undefined, scope);
      if (row.group === 'headline') return await arm.runHeadline(row.index, i);
      if (row.group === 'appendix') return await arm.dashboard(row.id.slice('dashboard-'.length));
      return await arm.runExtended(row.id, i);
    };
    const initial =
      row.index === 7 ? (await oracle.query('SELECT view_count FROM posts WHERE id=1')).rows[0].view_count : undefined;
    const setup = async () => {
      if (isWrite(row.id)) {
        await prepareWrite(oracle, row.id);
        return (await oracle.query(scratchQuery)).rows;
      }
      if (row.index === 7) {
        await oracle.query('UPDATE posts SET view_count=$1 WHERE id=1', [initial]);
        return (await oracle.query('SELECT * FROM posts ORDER BY id')).rows;
      }
    };
    const execute = async (arm, i, phase) => {
      scope.assertOpen();
      const before = await setup();
      const start = performance.now();
      // All arms pay the same eager snapshot boundary, including getter work.
      let value = await awaitExecution(scope, async () => structuredClone(await run(arm, i)), `${row.id}/${arm.name}`);
      const elapsed = performance.now() - start;
      // Full result/effect verification stays outside each arm's measured interval.
      const label = `${row.id}/${arm.name}/${phase}/${i}`;
      if (row.index === 6) assertExact(`${label} stream result`, value, expectedStream);
      else if (row.index === 7) {
        assertIncrementEffect(label, before, (await oracle.query('SELECT * FROM posts ORDER BY id')).rows);
        assertExact(`${label} returning`, value, (await oracle.query('SELECT * FROM posts WHERE id=1')).rows[0]);
      } else if (row.group === 'headline') {
        if (row.index === 5) value = countValue(value);
        if (row.index === 9) value = dashboardValue(value);
        assertExact(label, value, expectedHeadline(row.scenario, fixture, i));
      } else if (row.group === 'appendix') {
        assertExact(label, dashboardValue(value), expectedHeadline(headlineNames[9], fixture, i));
      } else if (isWrite(row.id)) await verifyWrite(oracle, row.id, label, before, i, value);
      else {
        if (row.id === 'group-by') value = aggregateRows(value, false);
        if (row.id === 'many-to-many' && arm.name.startsWith('Prisma 8')) value = flattenTags(value);
        assertExtendedExact(label, value, expectedExtended(row.id, full));
      }
      report.executionChecks.push({ id: row.id, arm: arm.name, phase, i, status: 'passed' });
      return elapsed;
    };
    for (const arm of selected) for (let i = 0; i < warmup; i++) await execute(arm, i, 'warmup');
    const values = new Map(selected.map((arm) => [arm.name, []]));
    for (let round = 0; round < rounds; round++)
      for (let k = 0; k < selected.length; k++) {
        const arm = selected[(k + round) % selected.length];
        values.get(arm.name).push(await execute(arm, round, 'round'));
      }
    report.results.push({
      id: row.id,
      scenario: row.scenario,
      arms: Object.fromEntries([...values].map(([name, samples]) => [name, stats(samples)])),
    });
    if (row.index === 7) await oracle.query('UPDATE posts SET view_count=$1 WHERE id=1', [initial]);
  }
}
