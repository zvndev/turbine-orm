import assert from 'node:assert/strict';

export function assertEvidenceProvenance(baseline, run) {
  assert.deepEqual(run.source, baseline.source, 'Live tests and effects used different source provenance');
  assert.equal(run.harnessSha256, baseline.harnessSha256, 'Live tests and effects used different harness provenance');
  for (const key of ['node', 'v8', 'sourcePg', 'sourceMysql2']) {
    assert.ok(typeof baseline.runtime[key] === 'string' && baseline.runtime[key], `Missing baseline runtime ${key}`);
    assert.equal(run.runtime[key], baseline.runtime[key], `Native runtime provenance differs: ${key}`);
  }
  assert.deepEqual(run.installed, baseline.installed, 'Native dependency pins changed between phases');
}

// Explicit identities prevent a filtered, renamed or emptied suite certifying a run.
export const REQUIRED_CASES = {
  postgresql: ['observes bounded native PostgreSQL rows and rejects materialized cursor substitutes'],
  mysql: [
    'audits both actual native routes and verifies all arms, effects and cleanup',
    'rejects raw materialization even with a correct independently consumed digest; restores audit methods',
    'rejects turbine-source materialization even with a correct independently consumed digest; restores audit methods',
    'rejects a forged correct digest without observing any driver command',
    'rejects native corruption introduced only during the timed repetition and cleans up',
    'rejects plausible transaction returns with a different real committed effect',
    'discards only the failed raw checkout after a consumer error and recovers the shared pool',
  ],
};

export function assertServerVersion(engine, expected, actual = expected) {
  assert.ok(Object.hasOwn(REQUIRED_CASES, engine), 'Only postgresql and mysql native gates are supported');
  assert.match(
    expected ?? '',
    engine === 'postgresql' ? /^18\.6$/ : /^8\.4\.\d+$/,
    'An exact supported server version is required',
  );
  // PostgreSQL distributors append build information; MySQL suffixes identify
  // different products/builds and are intentionally not silently discarded.
  const observed = engine === 'postgresql' ? actual.split(' ')[0] : actual;
  assert.equal(observed, expected, 'Actual server version differs from the exact requested version');
}

export function assertTestEvents(engine, events) {
  const cases = events.filter((event) => ['test:pass', 'test:fail'].includes(event.type));
  assert.ok(cases.length, 'No required native test events');
  assert.ok(
    cases.every((event) => event.type === 'test:pass' && !event.skip && !event.todo),
    'Native tests failed, skipped or were marked todo',
  );
  const tests = cases
    .filter((event) => event.kind === 'test')
    .map((event) => event.name)
    .sort();
  assert.deepEqual(tests, [...REQUIRED_CASES[engine]].sort(), 'Required native test identities/count differ');
  const summaries = events.filter((event) => event.type === 'test:summary');
  assert.equal(summaries.length, 1, 'Missing or duplicate final native test summary');
  const counts = summaries[0].counts;
  assert.equal(counts.tests, tests.length);
  assert.equal(counts.passed, tests.length);
  for (const name of ['failed', 'cancelled', 'skipped', 'todo']) assert.equal(counts[name], 0, `Native ${name} cases`);
  assert.equal(summaries[0].success, true, 'Native test summary is unsuccessful');
  return { required: tests.length, passed: tests.length, failed: 0, skipped: 0, cancelled: 0, todo: 0, names: tests };
}
