import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import { assertContractEvidence } from './fixtures/pg-pooler/reporter.mjs';

const contract = readFileSync(new URL('./fixtures/pg-pooler/contract.mjs', import.meta.url), 'utf8');
const names = [...contract.matchAll(/await test\.test\(\s*'([^']+)'/g)].map((match) => match[1]!);
assert.equal(names.length, 10);
interface FixtureEvent {
  type: string;
  data: { name?: string; nesting?: number; success?: boolean; counts?: Record<string, number> };
}
const baseline = (): FixtureEvent[] => [
  ...[...names, 'parent'].map((name, index) => ({
    type: 'test:pass',
    data: { name, nesting: index < 10 ? 1 : 0 },
  })),
  {
    type: 'test:summary',
    data: { success: true, counts: { tests: 11, passed: 11, failed: 0, cancelled: 0, skipped: 0, todo: 0 } },
  },
];
const encode = (events: unknown[]) => events.map((event) => JSON.stringify(event)).join('\n');

it('admits exactly the complete substantive native pooler contract', () => {
  assert.equal(assertContractEvidence(encode(baseline())).contracts, 10);
});

for (const fault of [
  'missing',
  'duplicate',
  'renamed',
  'no-summary',
  'skip',
  'todo',
  'cancelled',
  'failed',
  'false-summary',
]) {
  it(`rejects incomplete pooler evidence: ${fault}`, () => {
    const events = baseline();
    if (fault === 'missing') events.splice(4, 1);
    else if (fault === 'duplicate') events.splice(4, 1, events[3]!);
    else if (fault === 'renamed') events[4]!.data.name = 'unrelated test';
    else if (fault === 'no-summary') events.pop();
    else if (fault === 'skip' || fault === 'todo')
      Object.assign(events[4]!.data, { [fault]: 'required behavior omitted' });
    else if (fault === 'false-summary') events.at(-1)!.data.success = false;
    else events.at(-1)!.data.counts![fault as 'cancelled' | 'failed'] = 1;
    assert.throws(() => assertContractEvidence(encode(events)));
  });
}
