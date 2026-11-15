/** Versioned evidence for one narrow smoke scope. This schema cannot certify an engine. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const TEST_FILE = 'src/test/studio-timeout-integration.test.ts';
export const IMAGE =
  'yugabytedb/yugabyte:2026.1.2.0-b137@sha256:b6dba322c7340e1a87affd9b4715fa938354b6ab81b0b0833b07f6b5d085e274';
const OUTCOMES = ['passed', 'failed', 'readiness-failed', 'skipped', 'missing', 'incomplete', 'unsupported'];
const LIVE_TEST = 'the yugabytedb adapter timeout SQL runs in a transaction without a syntax error';
const SQL_TEST = 'every adapter uses set_config(), never the unparameterizable `SET LOCAL ... = $1` form';

export function newEvidence(head = 'unknown') {
  return {
    schemaVersion: 1,
    scope: 'ysql-statement-timeout-smoke-v1',
    supportStatus: 'candidate',
    certified: false,
    outcome: 'incomplete',
    observedAt: new Date().toISOString(),
    head,
    image: { requested: IMAGE, id: 'unknown' },
    engine: { name: 'unknown', version: 'unknown' },
    driver: { name: 'unknown', version: 'unknown' },
    transport: 'unknown',
    runtime: { name: 'node', version: process.version },
    readiness: { outcome: 'missing', attempts: 0 },
    tests: { file: TEST_FILE, outcome: 'not-run', exitCode: null, counts: null, logSha256: 'unknown' },
    failureCode: 'unknown',
  };
}

export function redact(text) {
  // Never persist connection URLs or driver errors verbatim. The launcher uses
  // no connection secrets in argv. Query parameters can contain secrets too.
  return String(text).replace(/\b(?:postgres(?:ql)?|https?):\/\/[^\s'"<>]+/gi, '[redacted-url]');
}

export function parseTestOutcome(tap, exitCode) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    if (matches.length !== 1) return { outcome: 'incomplete', exitCode, counts: null, logSha256: digest(tap) };
    counts[key] = Number(matches[0][1]);
  }
  let outcome = 'incomplete';
  if (exitCode !== 0 || counts.fail > 0 || counts.cancelled > 0) outcome = 'failed';
  else if (counts.skipped > 0 || counts.todo > 0) outcome = 'skipped';
  else if (
    !/^(?:\s*not ok\b|Bail out!)/m.test(tap) &&
    counts.tests === 2 &&
    counts.pass === 2 &&
    [LIVE_TEST, SQL_TEST].every((name) =>
      tap.split('\n').some((line) => /^\s+ok \d+ - /.test(line) && line.trim().endsWith(`- ${name}`)),
    )
  )
    outcome = 'passed';
  return { outcome, exitCode, counts, logSha256: digest(tap) };
}

function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function validateEvidence(record, tap = '') {
  assert.equal(record.schemaVersion, 1, 'unsupported evidence schema');
  assert.equal(record.scope, 'ysql-statement-timeout-smoke-v1', 'unsupported evidence scope');
  assert.equal(record.supportStatus, 'candidate', 'smoke evidence must stay candidate');
  assert.equal(record.certified, false, 'smoke evidence must never certify an engine');
  assert.ok(OUTCOMES.includes(record.outcome), 'invalid evidence outcome');
  assert.ok(
    typeof record.observedAt === 'string' && Number.isFinite(Date.parse(record.observedAt)),
    'missing observation timestamp',
  );
  assert.equal(new Date(record.observedAt).toISOString(), record.observedAt, 'invalid observation timestamp');
  assert.ok(record.head === 'unknown' || /^[a-f0-9]{40}$/.test(record.head), 'invalid head');
  assert.equal(record.image.requested, IMAGE, 'unexpected image');
  assert.ok(record.image.id === 'unknown' || /^sha256:[a-f0-9]{64}$/.test(record.image.id), 'invalid image identity');
  assert.ok(['unknown', 'yugabytedb'].includes(record.engine.name), 'unexpected engine');
  for (const value of [record.engine.version, record.driver.version, record.runtime.version, record.failureCode]) {
    assert.ok(typeof value === 'string' && value.length > 0, 'missing version or failure observation');
    assert.equal(redact(value), value, 'evidence contains a URL');
  }
  assert.ok(['unknown', 'pg'].includes(record.driver.name), 'unexpected driver');
  assert.ok(['unknown', 'tcp'].includes(record.transport), 'unexpected transport');
  assert.equal(record.runtime.name, 'node', 'unexpected runtime');
  assert.ok(['missing', 'ready', 'failed'].includes(record.readiness.outcome), 'invalid readiness');
  assert.ok(Number.isSafeInteger(record.readiness.attempts) && record.readiness.attempts >= 0, 'invalid attempts');
  assert.equal(record.tests.file, TEST_FILE, 'unexpected test scope');
  assert.ok(
    ['not-run', 'passed', 'failed', 'skipped', 'incomplete'].includes(record.tests.outcome),
    'invalid test outcome',
  );
  assert.ok(
    record.tests.exitCode === null || (Number.isSafeInteger(record.tests.exitCode) && record.tests.exitCode >= 0),
    'invalid process exit code',
  );
  assert.ok(
    record.tests.logSha256 === 'unknown' || /^[a-f0-9]{64}$/.test(record.tests.logSha256),
    'invalid test log digest',
  );
  if (record.tests.counts !== null) {
    for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
      assert.ok(
        Number.isSafeInteger(record.tests.counts?.[key]) && record.tests.counts[key] >= 0,
        'invalid test counts',
      );
    }
  }

  if (record.outcome === 'passed' || record.tests.outcome === 'passed') {
    assert.equal(record.outcome, 'passed', 'successful tests require a complete smoke observation');
    assert.equal(record.readiness.outcome, 'ready', 'missing readiness observation');
    assert.ok(record.readiness.attempts > 0, 'readiness never attempted');
    assert.equal(record.engine.name, 'yugabytedb', 'missing engine observation');
    assert.match(record.engine.version, /^\d+\.\d+\.\d+\.\d+-b\d+$/, 'missing Yugabyte server version');
    assert.equal(record.driver.name, 'pg', 'missing driver observation');
    assert.match(record.driver.version, /^\d+\.\d+\.\d+/, 'missing driver version');
    assert.equal(record.transport, 'tcp', 'missing transport observation');
    assert.match(record.runtime.version, /^v\d+\.\d+\.\d+/, 'missing runtime version');
    assert.match(record.head, /^[a-f0-9]{40}$/, 'missing head observation');
    assert.match(record.image.id, /^sha256:[a-f0-9]{64}$/, 'missing image observation');
    assert.equal(record.tests.outcome, 'passed', 'tests did not pass');
    assert.deepEqual(
      {
        outcome: record.tests.outcome,
        exitCode: record.tests.exitCode,
        counts: record.tests.counts,
        logSha256: record.tests.logSha256,
      },
      parseTestOutcome(tap, record.tests.exitCode),
      'test log does not match observed outcome',
    );
    assert.equal(
      parseTestOutcome(tap, record.tests.exitCode).outcome,
      'passed',
      'missing successful test observations',
    );
  }
  return record;
}

/** Polling has an explicit terminal failure; transient exceptions never imply readiness. */
export async function waitForYsql(
  probe,
  { attempts = 60, delayMs = 5000, pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {},
) {
  assert.ok(Number.isSafeInteger(attempts) && attempts > 0, 'attempts must be positive');
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const version = await probe();
      // YSQL reports PostgreSQL's version followed by a distinct -YB- version.
      // Store only the server version, excluding compiler/build URLs.
      const match = /^PostgreSQL \d+(?:\.\d+)*-YB-(\d+\.\d+\.\d+\.\d+-b\d+)(?:\s|$)/.exec(version);
      assert.ok(match, 'endpoint is not an observed YugabyteDB server');
      return { outcome: 'ready', attempts: attempt, version: match[1] };
    } catch {
      if (attempt < attempts) await pause(delayMs);
    }
  }
  return { outcome: 'failed', attempts, version: 'unknown' };
}
