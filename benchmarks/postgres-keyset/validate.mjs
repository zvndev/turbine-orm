import assert from 'node:assert/strict';
import { digest } from '../postgres-pagination/corpus.mjs';
import { assertNativeRoute } from './native-route.mjs';
import { compileTuple } from './candidate.mjs';
import { ARMS, CASES, METHODS, MODES, REFUSALS, planFacts, statements, verifyTrace } from './workload.mjs';

export function comparisons(samples) {
  const pairs = [], lookupCharges = [];
  for (const s of samples) {
    if (s.arm === 'expanded-or') {
      const other = samples.find((t) => t.arm === 'tuple' && t.case === s.case && t.method === s.method && t.mode === s.mode && t.round === s.round);
      assert.ok(other, 'Missing tuple comparison pair');
      pairs.push({ case: s.case, method: s.method, mode: s.mode, round: s.round,
        expandedMsPerOperation: s.elapsedMs / s.iterations, tupleMsPerOperation: other.elapsedMs / other.iterations,
        tupleOverExpanded: other.elapsedMs / other.iterations / (s.elapsedMs / s.iterations),
        expandedQueriesPerOperation: s.queryCount / s.iterations, tupleQueriesPerOperation: other.queryCount / other.iterations,
        expandedRowsPerOperation: s.fetchedRows / s.iterations, tupleRowsPerOperation: other.fetchedRows / other.iterations });
    }
    if (s.method === 'provided') {
      const located = samples.find((t) => t.method === 'locate' && t.case === s.case && t.arm === s.arm && t.mode === s.mode && t.round === s.round);
      assert.ok(located, 'Missing lookup-inclusive comparison pair');
      lookupCharges.push({ case: s.case, arm: s.arm, mode: s.mode, round: s.round,
        providedMsPerOperation: s.elapsedMs / s.iterations, locateMsPerOperation: located.elapsedMs / located.iterations,
        locateOverProvided: located.elapsedMs / located.iterations / (s.elapsedMs / s.iterations),
        providedQueriesPerOperation: s.queryCount / s.iterations, locateQueriesPerOperation: located.queryCount / located.iterations,
        providedRowsPerOperation: s.fetchedRows / s.iterations, locateRowsPerOperation: located.fetchedRows / located.iterations });
    }
  }
  return { pairs, lookupCharges };
}

export function verifySample(s, c) {
  assert.ok(ARMS.includes(s.arm) && METHODS.includes(s.method) && MODES.includes(s.mode));
  assert.ok(Number.isInteger(s.iterations) && s.iterations > 0);
  assert.ok(Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start);
  assert.equal(s.elapsedMs, s.end - s.start);
  verifyTrace(s.trace, c, s.arm, s.method, s.iterations);
  for (const [i, q] of s.trace.entries()) assert.ok(q.start >= (i ? s.trace[i - 1].end : s.start) && q.end <= s.end && q.end >= q.start && q.elapsedMs === q.end - q.start, 'Charged query timing boundary must include lookup and page');
  const warmups = s.mode === 'warm' ? 6 : 0;
  verifyTrace(s.warmupTrace, c, s.arm, s.method, warmups);
  for (const q of s.warmupTrace) assert.ok(q.end <= s.start, 'Warmup must precede measured boundary');
  assert.equal(s.queryCount, s.trace.length);
  assert.equal(s.fetchedRows, s.trace.reduce((n, q) => n + q.rowCount, 0));
  assert.equal(s.position, s.round % 2 === 0 ? ARMS.indexOf(s.arm) : 1 - ARMS.indexOf(s.arm));
  assert.ok(Number.isInteger(s.backendPid) && s.backendPid > 0);
}

export function validate(report) {
  assert.equal(report.format, 'postgres-keyset-v1');
  assert.equal(report.status, 'passed');
  assert.ok(!report.signal && !report.config.fault, 'Successful evidence cannot carry a signal or fault');
  for (const name of ['fsync', 'synchronous_commit', 'full_page_writes']) assert.equal(report.setup.settings.find(s => s.name === name)?.setting, 'on', 'Required native durability');
  assert.equal(report.services.length, 1);
  assert.equal(report.services[0].server_version, '18.6');
  assert.equal(report.services[0].stopped, true);
  assert.ok(Number.isInteger(report.config.rounds) && report.config.rounds >= 4 && report.config.rounds % 2 === 0);
  assert.ok(report.config.rounds <= 40);
  assert.ok(Number.isInteger(report.config.iterations) && report.config.iterations > 0 && report.config.iterations <= 100);
  const identity = report.identity;
  assert.ok(identity, 'Source/runtime provenance required');
  assert.match(identity.sourceHead, /^[a-f0-9]{40}$/);
  assert.ok(identity.branch && identity.worktree && identity.command.length >= 3);
  assert.ok(['v22.16.0', 'v24.10.0'].includes(identity.runtime.node));
  assert.ok(identity.runtime.executable && identity.runtime.versions?.v8);
  assert.equal(identity.runtime.versions.node, identity.runtime.node.slice(1));
  const sha = (value) => assert.match(value, /^[a-f0-9]{64}$/);
  for (const value of [identity.lockSha256, identity.runtime.sha256, identity.serverBinarySha256, identity.initdbSha256]) sha(value);
  for (const [map, marker] of [[identity.sourceFiles, 'src/client.ts'], [identity.harnessFiles, 'benchmarks/postgres-keyset/candidate.mjs'], [identity.driver.files, 'node_modules/pg/package.json']]) {
    assert.ok(map && Object.hasOwn(map, marker), `Provenance marker missing: ${marker}`);
    for (const value of Object.values(map)) sha(value);
  }
  sha(report.serverLogSha256);
  assert.match(identity.driver.version, /^\d+\.\d+\.\d+$/);
  assert.equal(identity.driver.lockedVersion, identity.driver.version);
  assert.ok(identity.driver.resolvedEntry); sha(identity.driver.resolvedSha256);
  assert.equal(identity.driverDependencies.pg.version, identity.driver.version);
  for (const dependency of [...Object.values(identity.driverDependencies), identity.tsx]) {
    assert.match(dependency.version, /^\d+\.\d+\.\d+$/);
    assert.equal(dependency.version, dependency.lockedVersion, 'Dependency lock identity required');
    assert.ok(Object.keys(dependency.files).length);
    for (const value of Object.values(dependency.files)) sha(value);
  }
  assert.equal(identity.sourceSha256, digest(identity.sourceFiles));
  assert.equal(identity.harnessSha256, digest(identity.harnessFiles));
  assert.equal(identity.artifact, null, 'Source benchmark must not imply artifact certification');
  assert.deepEqual(report.refusals, REFUSALS.map((request) => ({ request, result: compileTuple(request) })));
  assert.deepEqual(report.corpus, CASES.map((c) => ({ ...c, expectedSha256: digest(c.expected), statements: Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(METHODS.map((method) => [method, statements(c, arm, method)]))])) })));
  const samples = new Map();
  for (const s of report.samples) {
    const c = CASES.find((c) => c.id === s.case);
    assert.ok(c, 'Unknown case');
    verifySample(s, c);
    assert.equal(s.iterations, report.config.iterations);
    assert.ok(Number.isInteger(s.round) && s.round >= 0 && s.round < report.config.rounds);
    const key = [s.case, s.method, s.mode, s.round, s.arm].join('/');
    assert.ok(!samples.has(key), 'Duplicate sample'); samples.set(key, s);
  }
  for (const c of CASES) for (const method of METHODS) for (const mode of MODES) for (let round = 0; round < report.config.rounds; round++) for (const arm of ARMS) {
    assert.ok(samples.has([c.id, method, mode, round, arm].join('/')), 'Missing sample');
  }
  const plans = new Set();
  for (const p of report.plans) {
    const c = CASES.find((c) => c.id === p.case);
    assert.ok(c && ARMS.includes(p.arm) && METHODS.includes(p.method), 'Unknown plan');
    const key = [p.case, p.method, p.arm].join('/');
    assert.ok(!plans.has(key), 'Duplicate plan'); plans.add(key);
    assert.deepEqual(p.queries.map((q) => q.statement), statements(c, p.arm, p.method));
    for (const q of p.queries) {
      assert.deepEqual(q.facts, planFacts(q.document));
      assert.equal(q.document[0].Plan['Actual Rows'], q.statement.role === 'lookup' ? 1 : c.expected.length);
    }
  }
  assert.equal(plans.size, CASES.length * ARMS.length * METHODS.length, 'Missing plan');
  const deep = report.plans.find(p => p.case === 'deep' && p.arm === 'tuple' && p.method === 'provided');
  assert.ok(deep.queries[0].facts.nodes.some(n => n.index && /ROW\(items\.score, items\.id\) > ROW/.test(n.indexCondition ?? '')), 'Deep tuple cursor must reach native index condition');
  assertNativeRoute(report.nativeExecutions, report.samples);
  assert.deepEqual(report.comparisons, comparisons(report.samples), 'Retain all paired costs and lookup charges, including losses');
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.cleanup.errors, []);
  for (const key of ['processesAbsent', 'portClosed', 'datadirAbsent', 'socketAbsent', 'rootAbsent']) assert.equal(report.cleanup[key], true, key);
  assert.ok(report.cleanup.ownedPids.includes(report.services[0].pid));
  for (const s of report.samples) assert.ok(report.cleanup.ownedPids.includes(s.backendPid));
  return true;
}
