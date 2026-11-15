/** Retain measured operation calls while reusing the shared Bench rotation/setup. */
import assert from 'node:assert/strict';
import { type Arm, type ArmStat, Bench, type InterleaveOptions, type ScenarioResult, median, pct } from './bench-harness.js';

export interface OperationSample {
  scenario: string;
  arm: string;
  scenarioId?: string;
  phase?: string;
  rttMs?: number;
  round: number;
  durationMs: number;
}
export function summarizeOperations(samples: OperationSample[]) {
  return [...new Set(samples.map((s) => s.arm))].map((arm) => {
    const values = samples
      .filter((s) => s.arm === arm)
      .map((s) => s.durationMs)
      .sort((a, b) => a - b);
    assert.ok(values.length && values.every((n) => Number.isFinite(n) && n >= 0));
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      arm,
      n: values.length,
      p50Ms: median(values),
      avgMs: sum / values.length,
      minMs: values[0]!,
      p95Ms: pct(values, 0.95),
      p99Ms: values.length >= 100 ? pct(values, 0.99) : null,
      p99Status:
        values.length < 100 ? 'unavailable: n < 100' : 'empirical nearest rank; tail estimate remains sample-limited',
      method: 'p50 midpoint median; p95/p99 nearest rank over retained operation samples',
      serialOperationsPerSecond: sum > 0 ? (1000 * values.length) / sum : null,
      throughputScope: 'serial measured call time only; excludes setup, warmup, exact checks, teardown and idle time',
    };
  });
}

/** Preserve the original report shape, but compute every reported percentile from retained calls. */
type RetainedResult = Omit<ScenarioResult, 'stats'> & {
  stats: (Omit<ArmStat, 'sampleMethod'> & { sampleMethod: string })[];
};
export function retainedResults(results: ScenarioResult[], samples: OperationSample[]): RetainedResult[] {
  return results.map((result) => {
    const summaries = summarizeOperations(samples.filter((s) => s.scenario === result.scenario));
    return {
      ...result,
      stats: result.stats.map((stat) => {
        const s = summaries.find((s) => s.arm === stat.name);
        assert.ok(s, `missing retained result: ${result.scenario}/${stat.name}`);
        return {
          ...stat,
          median: s.p50Ms,
          avg: s.avgMs,
          p95: s.p95Ms,
          min: s.minMs,
          n: s.n,
          samplesMs: samples
            .filter((v) => v.scenario === result.scenario && v.arm === stat.name)
            .map((v) => v.durationMs),
          p99: s.p99Ms,
          p99Status: s.n < 100 ? 'unavailable-small-n' : s.n < 1000 ? 'unstable-tail' : 'estimated',
          sampleMethod: 'milliseconds; p50 arithmetic median; p95/p99 nearest rank',
        };
      }),
    };
  });
}

export async function driftMysql(
  bench: Bench,
  pool: { query(sql: string): Promise<unknown> },
  label: string,
  retained: OperationSample[],
) {
  let calls = 0;
  const before = retained.length;
  await bench.driftProbe(
    {
      query: async (sql: string) => {
        const measured = calls++ >= 500;
        const start = performance.now();
        const result = await pool.query(sql);
        const durationMs = performance.now() - start;
        if (measured)
          retained.push({ scenario: `drift.${label}`, arm: 'oracle SELECT 1', round: calls - 501, durationMs });
        return result;
      },
    },
    label,
  );
  const samples = retained.slice(before);
  assert.equal(calls, 1000, 'shared drift probe contract changed; re-audit warmup/sample admission');
  assert.equal(samples.length, 500);
  return summarizeOperations(samples)[0]!.p50Ms;
}
export async function interleaveMysql(
  bench: Bench,
  scenario: string,
  arms: Arm[],
  options: InterleaveOptions & { rounds: number; warmup: number; id?: string; phase?: string; rttMs?: number },
  retained: OperationSample[],
) {
  const before = retained.length;
  const memoryBefore = process.memoryUsage(),
    cpuBefore = process.cpuUsage(),
    wallStart = performance.now();
  const wrapped = arms.map((arm) => {
    let calls = 0;
    return {
      ...arm,
      fn: async (i: number, observe?: (row: unknown) => void) => {
        const measured = calls++ >= options.warmup;
        const start = performance.now();
        const result = await arm.fn(i, observe);
        const durationMs = performance.now() - start;
        if (measured)
          retained.push({
            scenario,
            scenarioId: options.id,
            phase: options.phase,
            rttMs: options.rttMs,
            arm: arm.name,
            round: i,
            durationMs,
          });
        return result;
      },
    };
  });
  await bench.interleave(scenario, wrapped, options);
  const samples = retained.slice(before);
  for (const arm of arms) {
    const records = samples.filter((s) => s.arm === arm.name);
    assert.equal(records.length, options.rounds, `retained sample completeness: ${scenario}/${arm.name}`);
    assert.deepEqual(
      records.map((s) => s.round),
      Array.from({ length: options.rounds }, (_, i) => i),
    );
  }
  return {
    scenario,
    summary: summarizeOperations(samples),
    sampleScope:
      'performance.now immediately around original Arm.fn await inside shared Bench; excludes wrapper bookkeeping. JSON summaries use these retained calls. Shared Bench stdout uses wider outer bounds and is diagnostic only.',
    resources: {
      scope:
        'whole interleave including untimed warmup/setup and console reporting; client process only; no server CPU or peak-memory claim',
      cpuMicros: process.cpuUsage(cpuBefore),
      wallMs: performance.now() - wallStart,
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      serverCpu: null,
      peakRss: null,
    },
  };
}
