import assert from 'node:assert/strict';
import { ARMS, CASES, METHODS, MODES, digest, expected } from './corpus.mjs';
import { planFacts, templates, verifyTrace } from './workload.mjs';

export const median = (values) => {
  const xs = [...values].sort((a, b) => a - b);
  return xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
};
export function comparisons(samples) {
  return CASES.flatMap((c) => MODES.flatMap((mode) => METHODS.map((method) => {
    const select = (arm) => samples.filter((s) => s.case === c.id && s.mode === mode && s.method === method && s.arm === arm);
    const rawMs = median(select('raw').map((s) => s.elapsedMs / s.iterations));
    const turbineMs = median(select('turbine').map((s) => s.elapsedMs / s.iterations));
    const pairedRatios = select('raw').sort((a, b) => a.round - b.round).map((raw) => {
      const turbine = select('turbine').find((s) => s.round === raw.round);
      return turbine.elapsedMs / raw.elapsedMs;
    });
    return { case: c.id, mode, method, rawMs, turbineMs, turbineOverRaw: turbineMs / rawMs,
      turbineSlower: turbineMs > rawMs, pairedRatios, medianPairedRatio: median(pairedRatios) };
  })));
}
export function paginationComparisons(samples) {
  return CASES.flatMap((c) => MODES.flatMap((mode) => ARMS.map((arm) => {
    const time = (method) => median(samples.filter((s) => s.case === c.id && s.mode === mode && s.arm === arm && s.method === method).map((s) => s.elapsedMs / s.iterations));
    const offsetMs = time('offset');
    const suppliedCursorMs = time('provided');
    const randomAccessSeekMs = time('locate');
    return { case: c.id, mode, arm, offsetMs, suppliedCursorMs, randomAccessSeekMs,
      suppliedOverOffset: suppliedCursorMs / offsetMs, randomAccessOverOffset: randomAccessSeekMs / offsetMs,
      suppliedSlower: suppliedCursorMs > offsetMs, randomAccessSlower: randomAccessSeekMs > offsetMs,
      suppliedCursorExcludesLookup: true, randomAccessIncludesLookup: true };
  })));
}
function nonnegative(n, label) { assert.ok(Number.isFinite(n) && n >= 0, label); }
function planCount(value) {
  assert.ok(typeof value === 'number' || (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)), 'Invalid native prepared plan counter');
  const count = Number(value);
  assert.ok(Number.isSafeInteger(count) && count >= 0, 'Invalid native prepared plan counter');
  return count;
}
export function verifyPrepared(sample) {
  assert.ok(Array.isArray(sample.prepared), 'Native prepared observations required');
  const expected = new Map();
  for (const call of [...sample.warmupTrace, ...sample.trace]) {
    if (!call.name) continue;
    const entry = expected.get(call.name) ?? { sql: call.sql, count: 0 };
    assert.equal(entry.sql, call.sql, 'Conflicting SQL for native prepared name');
    entry.count++;
    expected.set(call.name, entry);
  }
  assert.equal(sample.prepared.length, expected.size, 'Native prepared name set differs from observed execution');
  const seen = new Set();
  for (const prepared of sample.prepared) {
    assert.ok(!seen.has(prepared.name), 'Duplicate native prepared name');
    seen.add(prepared.name);
    const entry = expected.get(prepared.name);
    assert.ok(entry, 'Unexpected native prepared name');
    assert.equal(prepared.statement, entry.sql, 'Native prepared SQL differs from observed execution');
    assert.equal(planCount(prepared.generic_plans) + planCount(prepared.custom_plans), entry.count, 'Native prepared execution count differs from warmup and measured traces');
  }
}
export function validate(report) {
  assert.equal(report.format, 'postgres-pagination-v1');
  assert.equal(report.status, 'passed');
  assert.ok(['v22.16.0', 'v24.10.0'].includes(report.identity.runtime.node));
  assert.equal(report.server.server_version, '18.6');
  for (const x of [report.identity.runtime.sha256, report.identity.lockSha256, report.identity.driver.sha256,
    report.identity.sourceSha256, report.identity.harnessSha256, report.identity.serverBinarySha256]) assert.match(x, /^[a-f0-9]{64}$/);
  assert.ok(report.identity.driver.version && report.identity.sourceHead && report.identity.command.length);
  const { rounds, iterations } = report.config;
  assert.equal(report.config.preparedStatements, true, 'Named execution configuration required');
  assert.ok(Number.isInteger(rounds) && rounds >= 4 && rounds % 2 === 0);
  assert.ok(Number.isInteger(iterations) && iterations >= 1 && iterations <= 100);
  const keys = new Set();
  const count = CASES.length * METHODS.length * MODES.length * ARMS.length * rounds;
  assert.equal(report.samples.length, count, 'Missing/extra measured samples');
  for (const s of report.samples) {
    const c = CASES.find((c) => c.id === s.case);
    assert.ok(c && METHODS.includes(s.method) && MODES.includes(s.mode) && ARMS.includes(s.arm));
    assert.ok(Number.isInteger(s.round) && s.round >= 0 && s.round < rounds);
    const key = [s.case, s.method, s.mode, s.arm, s.round].join('/');
    assert.ok(!keys.has(key), `Duplicate sample ${key}`); keys.add(key);
    assert.equal(s.position, (s.round % 2 === 0 ? ARMS : [...ARMS].reverse()).indexOf(s.arm));
    assert.equal(s.iterations, iterations);
    assert.equal(s.resultSha256, digest(expected(c)));
    assert.equal(s.connections.length, 1, 'Exactly one observed pg connection required');
    assert.ok(Number.isInteger(s.connections[0]) && s.connections[0] > 1);
    assert.equal(s.newConnections, s.mode === 'connection-cold' ? 1 : 0);
    assert.equal(s.warmupIterations, s.mode === 'warm' ? 6 : 0);
    verifyTrace(s.trace, c, s.method, iterations);
    verifyTrace(s.warmupTrace, c, s.method, s.warmupIterations);
    verifyPrepared(s);
    for (const value of [s.elapsedMs, s.cpu.user, s.cpu.system, s.rssBefore, s.rssAfter, s.maxRssKiB]) nonnegative(value, 'Invalid measured resource counter');
    assert.ok(s.elapsedMs > 0 && s.rssAfter > 0);
    assert.equal(s.backendResources.length, 1);
    for (const resource of s.backendResources) {
      assert.equal(resource.pid, s.connections[0]);
      nonnegative(resource.cpuTicks, 'Invalid backend CPU ticks');
      assert.ok(resource.rssKiB > 0);
    }
  }
  assert.deepEqual(report.comparisons, comparisons(report.samples), 'Contradictory comparisons');
  assert.deepEqual(report.paginationComparisons, paginationComparisons(report.samples), 'Contradictory random-access comparisons');
  assert.equal(report.plans.length, CASES.length * METHODS.length);
  const planKeys = new Set();
  for (const p of report.plans) {
    const c = CASES.find((c) => c.id === p.case);
    assert.ok(c && METHODS.includes(p.method));
    const key = `${p.case}/${p.method}`;
    assert.ok(!planKeys.has(key), 'Duplicate plan'); planKeys.add(key);
    assert.equal(p.queries.length, templates(c, p.method).length);
    p.queries.forEach((q, i) => {
      assert.deepEqual(q.statement, templates(c, p.method)[i]);
      assert.deepEqual(q.facts, planFacts(q.document));
      assert.equal(q.facts.rootRows, p.method === 'locate' && i === 0 ? 1 : expected(c).length);
    });
  }
  assert.ok(report.cleanup.rootAbsent && report.cleanup.portClosed && report.cleanup.processesAbsent && report.cleanup.socketAbsent && report.cleanup.datadirAbsent && report.cleanup.applicationsAbsent);
  assert.equal(report.cleanup.errors.length, 0);
  return report;
}
