import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timing } from '../scripts/timing.mjs';

const scope = { assertOpen() {} };
const user = { id: 1n, email: 'correct@example.test' };
const fixture = {
  users: [user],
  posts: [],
  comments: [
    { id: 1n, body: 'first' },
    { id: 2n, body: 'last' },
  ],
};
const cell = { status: 'implemented' };
const report = () => ({ metrics: {}, executionChecks: [] });

test('timing rejects values that become incorrect only after warmup', async () => {
  let calls = 0;
  const arm = { name: 'Turbine', runHeadline: async () => (++calls === 1 ? user : { ...user, email: 'wrong' }) };
  const row = {
    id: 'headline-3',
    group: 'headline',
    index: 3,
    scenario: 'findUnique, single user by PK',
    arms: { Turbine: cell },
  };
  await assert.rejects(
    () => timing(report(), [row], [arm], {}, scope, 1, 1, fixture, fixture),
    /exact result mismatch/,
  );
});

test('timing rejects a truncated stream after a complete warmup drain', async () => {
  let calls = 0;
  const arm = {
    name: 'Turbine',
    route: 'buffered',
    stream: async function* () {
      yield fixture.comments[0];
      if (++calls === 1) yield fixture.comments[1];
    },
  };
  const row = {
    id: 'headline-6',
    group: 'headline',
    index: 6,
    scenario: 'stream, iterate 50K comments (batch 1000)',
    arms: { Turbine: cell },
  };
  await assert.rejects(() => timing(report(), [row], [arm], {}, scope, 1, 1, fixture, fixture), /stream.*mismatch/);
});

test('timing checks independent write effects after the measured call', async () => {
  let rows = [],
    calls = 0;
  const oracle = {
    async query(sql) {
      if (sql.startsWith('TRUNCATE')) rows = [];
      else if (sql.startsWith('INSERT'))
        rows = ['update-target', 'sentinel-a', 'sentinel-b'].map((slug, i) => ({
          id: String(i + 1),
          slug,
          amount: -777,
        }));
      return { rows: structuredClone(rows) };
    },
  };
  const arm = {
    name: 'Turbine',
    async runExtended(_id, i) {
      const value = { ...rows[0], amount: i };
      if (++calls === 1) rows[0] = value;
      return value;
    },
  };
  const row = { id: 'update', group: 'write', scenario: 'update by unique key', arms: { Turbine: cell } };
  await assert.rejects(
    () => timing(report(), [row], [arm], oracle, scope, 1, 1, fixture, fixture),
    /actual write effect/,
  );
});

test('verified warmups and measured samples have separate complete receipts', async () => {
  const out = report();
  const row = {
    id: 'headline-3',
    group: 'headline',
    index: 3,
    scenario: 'findUnique, single user by PK',
    arms: { Turbine: cell },
  };
  await timing(out, [row], [{ name: 'Turbine', runHeadline: async () => user }], {}, scope, 2, 1, fixture, fixture);
  assert.equal(out.executionChecks.length, 3);
  assert.deepEqual(
    out.executionChecks.map((r) => r.phase),
    ['warmup', 'round', 'round'],
  );
  assert.equal(out.results[0].arms.Turbine.samples.length, 2);
});
