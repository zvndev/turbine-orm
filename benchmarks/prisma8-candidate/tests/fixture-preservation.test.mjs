import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedHeadline, headlineNames } from '../dist/canonical/equivalence.js';
import { readExtendedFixture } from '../dist/canonical/extended-equivalence.js';
import { assertFixturePreserved, preflight } from '../scripts/native.mjs';

const scope = { assertOpen() {} };
function fixture() {
  const state = {
    organizations: Array.from({ length: 5 }, (_, i) => ({ id: String(i + 1) })),
    users: Array.from({ length: 1000 }, (_, i) => ({ id: String(i + 1), email: `user${i + 1}@test` })),
    posts: Array.from({ length: 10000 }, (_, i) => ({
      id: String(i + 1),
      user_id: String((i % 1000) + 1),
      org_id: '1',
      view_count: 0,
      created_at: new Date(0),
    })),
    comments: Array.from({ length: 50000 }, (_, i) => ({
      id: String(i + 1),
      user_id: String((i % 1000) + 1),
      post_id: String((i % 10000) + 1),
      body: 'comment',
    })),
    tags: Array.from({ length: 50 }, (_, i) => ({ id: String(i + 1), name: `tag-${i + 1}` })),
    post_tags: Array.from({ length: 30000 }, (_, i) => ({
      post_id: String(Math.floor(i / 3) + 1),
      tag_id: String((i % 3) + 1),
    })),
    bench_wide: Array.from({ length: 2000 }, (_, i) => ({ id: String(i + 1), t01: 'original payload' })),
  };
  const oracle = {
    async query(sql) {
      if (sql.startsWith('TRUNCATE bench_writes')) return { rows: [] };
      const table = /SELECT \* FROM ([a-z_]+) ORDER BY/i.exec(sql)?.[1];
      assert.ok(state[table], `Unexpected fixture query ${sql}`);
      return { rows: structuredClone(state[table]) };
    },
  };
  return { state, oracle };
}
test('passing read results cannot conceal a changed unqueried fixture row', async () => {
  const { state, oracle } = fixture(),
    names = ['Raw pg 8.22.0', 'Prisma 8 buffered', 'Turbine'];
  const arms = names.map((name) => ({
    name,
    runHeadline: async (_n, i) => structuredClone(state.users[i % 50]),
    dashboard: async () => {
      const result = expectedHeadline(headlineNames[9], state, 0);
      state.bench_wide[500].t01 = 'corrupted during dashboard';
      return result;
    },
  }));
  const cell = { status: 'implemented' };
  const rows = [
    {
      id: 'headline-10',
      index: 10,
      group: 'headline',
      scenario: headlineNames[10],
      arms: Object.fromEntries(names.map((n) => [n, cell])),
    },
    { id: 'dashboard-sequential', group: 'appendix', arms: { Turbine: cell } },
  ];
  const report = {};
  await assert.rejects(
    () => preflight(report, rows, arms, oracle, scope),
    /preserves every read fixture value.*bench_wide/,
  );
  assert.equal(report.cases.length, 151);
  assert.equal(report.fixtureChecks, undefined);
});
test('controls and timing must preserve the original snapshot without rebaselining', async () => {
  const { state, oracle } = fixture(),
    original = await readExtendedFixture(oracle);
  await assertFixturePreserved(oracle, original, scope, 'unchanged controls');
  state.bench_wide[500].t01 = 'corrupted after controls';
  await assert.rejects(() => assertFixturePreserved(oracle, original, scope, 'controls'), /bench_wide/);
  await assert.rejects(() => assertFixturePreserved(oracle, original, scope, 'timing'), /bench_wide/);
});
