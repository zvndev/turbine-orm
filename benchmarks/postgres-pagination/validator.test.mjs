import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ARMS, CASES, METHODS, MODES, digest, expected } from './corpus.mjs';
import { comparisons, paginationComparisons, validate, verifyPrepared } from './validate.mjs';
import { planFacts, templates } from './workload.mjs';

// Validator inputs only. These are never emitted or counted as native evidence.
function validatorInput() {
  const hash = 'a'.repeat(64);
  const report = { format: 'postgres-pagination-v1', status: 'passed', config: { rounds: 4, iterations: 1, preparedStatements: true },
    identity: { runtime: { node: 'v22.16.0', sha256: hash }, lockSha256: hash, driver: { sha256: hash, version: 'test' },
      sourceSha256: hash, harnessSha256: hash, serverBinarySha256: hash, sourceHead: hash, command: ['validator-input'] },
    server: { server_version: '18.6' }, samples: [], plans: [],
    cleanup: { errors: [], rootAbsent: true, portClosed: true, processesAbsent: true, socketAbsent: true, datadirAbsent: true, applicationsAbsent: true } };
  for (const c of CASES) for (const method of METHODS) {
    const queries = templates(c, method).map((statement, i) => {
      const document = [{ Plan: { 'Node Type': 'Limit', 'Actual Rows': method === 'locate' && i === 0 ? 1 : expected(c).length, 'Actual Loops': 1 }, 'Planning Time': 1, 'Execution Time': 1 }];
      return { statement, document, facts: planFacts(document) };
    });
    report.plans.push({ case: c.id, method, queries });
    const trace = [{ sql: 'SELECT 1 AS noise', params: [], name: '', rows: 1, rowCount: 1, command: 'SELECT' },
      ...queries.map((q) => ({ ...q.statement, rows: q.facts.rootRows, rowCount: q.facts.rootRows, command: 'SELECT' }))];
    for (const mode of MODES) for (let round = 0; round < 4; round++) for (const arm of ARMS) report.samples.push({
      case: c.id, method, mode, round, arm, position: (round % 2 === 0 ? ARMS : [...ARMS].reverse()).indexOf(arm),
      iterations: 1, warmupIterations: mode === 'warm' ? 6 : 0, elapsedMs: arm === 'raw' ? 1 : 2,
      resultSha256: digest(expected(c)), connections: [12345], newConnections: mode === 'warm' ? 0 : 1,
      trace: structuredClone(trace), warmupTrace: mode === 'warm' ? Array.from({ length: 6 }, () => structuredClone(trace)).flat() : [],
      prepared: queries.filter((q) => q.statement.name).map((q) => ({ name: q.statement.name, statement: q.statement.sql,
        generic_plans: '0', custom_plans: String(mode === 'warm' ? 7 : 1) })),
      cpu: { user: 1, system: 1 }, rssBefore: 100, rssAfter: 100, maxRssKiB: 100,
      backendResources: [{ pid: 12345, cpuTicks: 0, rssKiB: 100 }],
    });
  }
  report.comparisons = comparisons(report.samples);
  report.paginationComparisons = paginationComparisons(report.samples);
  return report;
}
test('complete balanced validator input accepted', () => validate(validatorInput()));
for (const [name, mutate, reason] of [
  ['missing sample', (r) => r.samples.pop(), /Missing\/extra/],
  ['duplicate sample replacing another', (r) => { r.samples[1] = structuredClone(r.samples[0]); }, /Duplicate/],
  ['contradictory comparison', (r) => { r.comparisons[0].turbineSlower = false; }, /Contradictory/],
  ['lookup cost excluded from random access', (r) => { r.paginationComparisons[0].randomAccessSeekMs = 0; }, /Contradictory random-access/],
  ['wrong parameters', (r) => { r.samples[0].trace[1].params[0] = -99; }, /Wire SQL/],
  ['unbounded materialization', (r) => { r.samples[0].trace[1].rows = 24000; }, /Wire SQL/],
  ['missing noise', (r) => { r.samples[0].trace.shift(); }, /query\/materialization/],
  ['wrong independent oracle digest', (r) => { r.samples[0].resultSha256 = 'b'.repeat(64); }, /AssertionError/],
  ['invalid CPU', (r) => { r.samples[0].cpu.user = -1; }, /resource counter/],
  ['wrong connection temperature', (r) => { r.samples[0].newConnections = 0; }, /AssertionError/],
  ['unbalanced arm order', (r) => { r.samples[0].position = 1; }, /AssertionError/],
  ['contradictory plan facts', (r) => { r.plans[0].queries[0].facts.rootRows++; }, /AssertionError/],
  ['duplicate plan', (r) => { r.plans[1] = r.plans[0]; }, /Duplicate plan/],
  ['false cleanup', (r) => { r.cleanup.portClosed = false; }, /AssertionError/],
  ['missing identity', (r) => { delete r.identity.harnessSha256; }, /AssertionError/],
  ['missing prepared observations', (r) => { delete r.samples[0].prepared; }, /Native prepared observations required/],
  ['empty prepared name set', (r) => { r.samples[0].prepared = []; }, /Native prepared name set/],
  ['unexpected prepared name', (r) => { r.samples[0].prepared[0].name = 'other'; }, /Unexpected native prepared name/],
  ['extra prepared name', (r) => { r.samples[0].prepared.push({ ...r.samples[0].prepared[0], name: 'extra' }); }, /Native prepared name set/],
  ['duplicate prepared name', (r) => { const s = r.samples.find((s) => s.prepared.length === 2); s.prepared[1] = { ...s.prepared[0] }; }, /Duplicate native prepared name/],
  ['wrong prepared SQL', (r) => { r.samples[0].prepared[0].statement = 'SELECT 0'; }, /Native prepared SQL/],
  ['no native executions', (r) => { r.samples[0].prepared[0].custom_plans = '0'; }, /Native prepared execution count/],
  ['warmup omitted from native executions', (r) => { r.samples.find((s) => s.mode === 'warm').prepared[0].custom_plans = '1'; }, /Native prepared execution count/],
  ['false named execution configuration', (r) => { r.config.preparedStatements = false; }, /Named execution configuration/],
]) test(`validator rejects ${name}`, () => { const r = validatorInput(); mutate(r); assert.throws(() => validate(r), reason); });

test('native plan counters reject malformed and unsafe values', () => {
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, false, '', '1e0', '-1', '9007199254740992']) {
    const r = validatorInput();
    r.samples[0].prepared[0].generic_plans = value;
    assert.throws(() => validate(r), /Invalid native prepared plan counter/);
  }
});
test('native prepared observations require empty observations for an unnamed-only sample', () => {
  verifyPrepared({ trace: [{ name: '', sql: 'SELECT 1' }], warmupTrace: [], prepared: [] });
  assert.throws(() => verifyPrepared({ trace: [], warmupTrace: [] }), /Native prepared observations required/);
});
test('generic and custom native plans sum across measured and warmup execution', () => {
  const r = validatorInput();
  const entry = r.samples.find((s) => s.mode === 'warm').prepared[0];
  entry.generic_plans = '2'; entry.custom_plans = 5;
  validate(r);
});

test('missing required native service fails and retains a finalized report', () => {
  const out = mkdtempSync(join(tmpdir(), 'pagination-validator-'));
  try {
    const file = join(out, 'report.json');
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'benchmarks/postgres-pagination/run.mjs', '--out', file], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, PG_PREFIX: join(out, 'missing') } });
    assert.equal(child.status, 1, child.stderr);
    const r = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(r.status, 'failed');
    // Node20/26 unit lanes also refuse the exact measurement runtime, without skipping.
    assert.match(r.failures[0].message, /Required owned native PG18.6 service|Exact Node22.16.0 or Node24.10.0 required/);
    assert.equal(r.samples.length, 0);
    assert.equal(r.cleanup.rootAbsent, true);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
