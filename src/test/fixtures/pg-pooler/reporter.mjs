import assert from 'node:assert/strict';

const expectedContracts = [
  'real admin mode/capacity admission, not an endpoint-name heuristic',
  'session mode retains the physical backend between transactions and queues the second client',
  'session hub readiness, one listener, channel UNLISTEN, final cleanup and same-backend reborrow',
  'transaction mode pins inside BEGIN but a held logical client switches physical backend after COMMIT',
  'transaction-mode NOTIFY commits exactly, rollback suppresses it; listener stays on a direct session',
  'declared transaction hub/WS and invocation LISTEN refusals happen before checkout',
  'actual WS relay through transaction PgBouncer: callback pin, commit/rollback, NOTIFY and invocation scope',
  'actual WS session pool: dedicated LISTEN, exact payload, explicit unsubscribe then disconnect',
  'misdeclared hub accepts LISTEN but loses physical affinity and cannot clean the original listener',
  'misdeclared WS persistent session is accepted but checkout moves to a different backend',
];

export function assertContractEvidence(log) {
  const events = log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const passed = events.filter((event) => event.type === 'test:pass');
  assert.ok(!events.some((event) => event.type === 'test:fail'), 'native contract failure');
  assert.ok(
    passed.every((event) => !event.data.skip && !event.data.todo),
    'native contracts must not skip or todo',
  );
  assert.deepEqual(
    passed
      .filter((event) => event.data.nesting === 1)
      .map((event) => event.data.name)
      .sort(),
    [...expectedContracts].sort(),
    'each substantive native contract must complete exactly once',
  );
  const summary = events.filter((event) => event.type === 'test:summary').at(-1)?.data;
  assert.ok(summary?.success, 'successful native test summary required');
  for (const key of ['failed', 'cancelled', 'skipped', 'todo']) assert.equal(summary.counts[key], 0, key);
  assert.equal(summary.counts.tests, 11);
  assert.equal(summary.counts.passed, 11);
  assert.equal(passed.length, 11);
  return { contracts: expectedContracts.length, counts: summary.counts };
}

// Both exact runtimes expose the same structured events, independent of their default text reporter.
export default async function* reporter(source) {
  for await (const event of source) {
    yield `${JSON.stringify(event, (_key, value) => (value instanceof Error ? { name: value.name, message: value.message, stack: value.stack } : value))}\n`;
  }
}
