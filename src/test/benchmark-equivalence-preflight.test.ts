import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { verifyHeadline, headlineNames } = await import(
  new URL('../../benchmarks/equivalence.ts', import.meta.url).href
);
type Row = Record<string, unknown>;
type Run = (i: number, observe?: (row: unknown) => void) => Promise<unknown>;
type Scenario = { scenario: string; arms: { name: string; fn: Run }[] };

/** Native-result stand-ins, built independently of expectedHeadline/canonical. */
function fixtureSuite() {
  const users = Array.from({ length: 1000 }, (_, i) => ({ id: i + 1, name: `user ${i + 1}` }));
  const posts = Array.from({ length: 10000 }, (_, i) => ({
    id: i + 1,
    user_id: Math.floor(i / 10) + 1,
    title: `post ${i + 1}`,
    view_count: i,
    created_at: new Date('2026-01-01Z'),
  }));
  const comments = Array.from({ length: 50000 }, (_, i) => ({
    id: i + 1,
    post_id: Math.floor(i / 5) + 1,
    user_id: (i % 1000) + 1,
    body: `comment ${i + 1}`,
  }));
  const userPosts = (userId: number, limited: boolean, nested: boolean) => {
    const start = (userId - 1) * 10;
    return posts
      .slice(start, start + (limited ? 5 : 10))
      .map((post) => (nested ? { ...post, comments: comments.slice((post.id - 1) * 5, post.id * 5) } : post));
  };
  const reads = async (name: string, i: number, observe?: (row: unknown) => void) => {
    switch (name) {
      case headlineNames[0]:
        return structuredClone(users.slice(0, 100));
      case headlineNames[1]:
        return structuredClone(users.slice(0, 50).map((u) => ({ ...u, posts: userPosts(u.id, false, false) })));
      case headlineNames[2]:
        return structuredClone(users.slice(0, 10).map((u) => ({ ...u, posts: userPosts(u.id, true, true) })));
      case headlineNames[3]:
        return structuredClone(users[0]);
      case headlineNames[4]:
        return structuredClone({ ...users[0], posts: userPosts(1, false, true) });
      case headlineNames[5]:
        return 1000;
      case headlineNames[6]:
        for (const row of comments) observe?.(row);
        return comments.length;
      case headlineNames[7]:
        posts[0]!.view_count++;
        return structuredClone([posts[0]]);
      case headlineNames[8]:
      case headlineNames[9]:
        return structuredClone([users[0], 10, 50, posts.slice(0, 10).reverse().slice(0, 5), 1000]);
      case headlineNames[10]:
        return structuredClone(users[i % 50]);
      default:
        throw new Error('Unknown stand-in scenario');
    }
  };
  const scenarios: Scenario[] = headlineNames.map((scenario: string, index: number) => ({
    scenario,
    arms: [
      'Turbine',
      'Prisma 7',
      'Drizzle',
      ...([2, 4].includes(index) ? [] : ['Raw']),
      'Drizzle RC',
      'Drizzle RC (no jit)',
    ].map((name) => ({ name, fn: (i: number, observe?: (row: unknown) => void) => reads(scenario, i, observe) })),
  }));
  const queries: string[] = [];
  const db = {
    query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      if (sql.startsWith('UPDATE posts SET view_count = restored.value')) {
        const ids = values![0] as number[];
        const counts = values![1] as number[];
        for (let i = 0; i < ids.length; i++) posts[ids[i]! - 1]!.view_count = counts[i]!;
        return { rows: [] };
      }
      if (sql === 'SELECT * FROM users ORDER BY id ASC') return { rows: structuredClone(users) };
      if (sql === 'SELECT * FROM posts ORDER BY id ASC') return { rows: structuredClone(posts) };
      if (sql === 'SELECT * FROM comments ORDER BY id ASC') return { rows: structuredClone(comments) };
      throw new Error(`Unexpected oracle SQL: ${sql}`);
    },
  };
  return { scenarios, db, posts, comments, queries };
}

function firstScenario(scenarios: Scenario[], index: number): Scenario {
  const [selected] = scenarios.splice(index, 1);
  scenarios.unshift(selected!);
  return selected!;
}

describe('benchmark complete preflight', () => {
  it('checks every scenario/arm, every streamed row and all 50 rotating ids; restores writes', async () => {
    const { scenarios, db, posts, queries } = fixtureSuite();
    const visits: string[] = [];
    const hotInputs: number[] = [];
    for (const scenario of scenarios)
      for (const arm of scenario.arms) {
        const run = arm.fn;
        arm.fn = async (i, observe) => {
          visits.push(`${scenario.scenario}/${arm.name}`);
          if (scenario.scenario === headlineNames[10]) hotInputs.push(i);
          return run(i, observe);
        };
      }
    await verifyHeadline(scenarios, db);
    const expectedVisits = scenarios.flatMap((s) => s.arms.map((a) => `${s.scenario}/${a.name}`));
    assert.ok(expectedVisits.length > 50);
    assert.deepEqual([...new Set(visits)], expectedVisits);
    assert.deepEqual(
      [...new Set(hotInputs)],
      Array.from({ length: 50 }, (_, i) => i),
    );
    assert.equal(posts[0]!.view_count, 0);
    assert.equal(queries.filter((sql) => sql.startsWith('UPDATE')).length, 6);
  });

  it('rejects missing scenarios and missing arms before querying the database', async () => {
    const { scenarios, db, queries } = fixtureSuite();
    await assert.rejects(() => verifyHeadline(scenarios.slice(1), db), /every scenario/);
    scenarios[0]!.arms.pop();
    await assert.rejects(() => verifyHeadline(scenarios, db), /Incomplete arm coverage/);
    assert.equal(queries.length, 0);
  });

  it('rejects a same-count wrong column from the selected timed callback', async () => {
    const { scenarios, db } = fixtureSuite();
    const arm = scenarios[0]!.arms[0]!;
    const original = arm.fn;
    arm.fn = async (i) => {
      const rows = (await original(i)) as Row[];
      rows[99]!.name = 'wrong final row';
      return rows;
    };
    await assert.rejects(() => verifyHeadline(scenarios, db), /Turbine.*99.name/);
  });

  it('rejects the wrong dashboard order with equal counts and columns', async () => {
    const { scenarios, db } = fixtureSuite();
    const scenario = firstScenario(scenarios, 8);
    const arm = scenario.arms[0]!;
    const original = arm.fn;
    arm.fn = async (i) => {
      const result = (await original(i)) as unknown[];
      (result[3] as Row[]).reverse();
      return result;
    };
    await assert.rejects(() => verifyHeadline(scenarios, db), /dashboard batch.*Turbine.*3.0.id/);
  });

  it('rejects a plausible write return when the wrong row changed and restores the counters', async () => {
    const { scenarios, db, posts, queries } = fixtureSuite();
    const scenario = firstScenario(scenarios, 7);
    scenario.arms[0]!.fn = async () => {
      posts[1]!.view_count++;
      return { ...posts[0], view_count: 1 };
    };
    await assert.rejects(() => verifyHeadline(scenarios, db), /Turbine.*write effect/);
    assert.equal(posts[0]!.view_count, 0);
    assert.equal(posts[1]!.view_count, 1);
    assert.equal(queries.filter((sql) => sql.startsWith('UPDATE')).length, 1);
  });

  it('rejects a wrong stream cell even when the returned drain count is right', async () => {
    const { scenarios, db, comments } = fixtureSuite();
    const scenario = firstScenario(scenarios, 6);
    scenario.arms[0]!.fn = async (_i, observe) => {
      observe?.({ ...comments[0], body: 'wrong body' });
      return 50000;
    };
    await assert.rejects(() => verifyHeadline(scenarios, db), /streamed row 0.*body/);
  });

  it('rejects a stream callback that only returns the expected count', async () => {
    const { scenarios, db } = fixtureSuite();
    firstScenario(scenarios, 6).arms[0]!.fn = async () => 50000;
    await assert.rejects(() => verifyHeadline(scenarios, db), /observed count/);
  });
});
