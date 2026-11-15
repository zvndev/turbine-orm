import { syntheticRun } from './extended-test-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Row } from './equivalence.js';
import type { ExtendedFixture, ExtendedId, ExtendedScenario } from './extended-equivalence.js';
import {
  aggregateRows,
  assertExtendedCatalog,
  assertExtendedExact,
  bulkRows,
  exactDecimal,
  expectedExtended,
  expectedWrite,
  extendedCatalog,
  extendedGroups,
  fixtureCounts,
  flattenTags,
  nativeCounts,
  preparedPolicy,
  requiredArms,
  resultOne,
  verifyWrite,
  writeTime,
} from './extended-equivalence.js';
import { assertExtendedRuns as admitExtendedRuns } from './extended-results.js';
const assertExtendedRuns = (runs: unknown[], options: { allowSmoke?: boolean } = {}) =>
  admitExtendedRuns(runs, { ...options, scope: 'historical' });

const catalog = (): ExtendedScenario[] =>
  extendedCatalog.map((s) => ({
    ...s,
    arms: requiredArms(s.id).map((name) => ({
      name,
      fn: async () => {
        throw new Error('must not execute during catalog admission');
      },
      setup: async () => {},
      cold: async () => ({ value: {}, ms: 0 }),
    })),
  }));
const at = new Date('2024-01-01T00:00:00.000Z');
const fixture = (part: Partial<ExtendedFixture> = {}): ExtendedFixture => ({
  organizations: [],
  users: [],
  posts: [],
  comments: [],
  tags: [],
  post_tags: [],
  bench_wide: [],
  ...part,
});

test('full original catalog has 17 rows, seven groups and independent stable/RC arms', () => {
  assert.equal(extendedCatalog.length, 17);
  assert.deepEqual([...new Set(extendedCatalog.map((s) => s.group))], extendedGroups);
  assertExtendedCatalog(catalog(), extendedGroups);
  assert.equal(
    catalog().reduce((n, s) => n + s.arms.length, 0),
    93,
  );
});
for (const entry of extendedCatalog) {
  test(`catalog refuses omitted ${entry.id} before execution`, () => {
    assert.throws(
      () =>
        assertExtendedCatalog(
          catalog().filter((s) => s.id !== entry.id),
          extendedGroups,
        ),
      /every selected catalog row/,
    );
  });
  test(`catalog refuses omitted RC arm for ${entry.id}`, () => {
    const scenarios = catalog();
    scenarios.find((s) => s.id === entry.id)!.arms = scenarios
      .find((s) => s.id === entry.id)!
      .arms.filter((a) => a.name !== 'Drizzle RC');
    assert.throws(() => assertExtendedCatalog(scenarios, extendedGroups), /Incomplete extended arm coverage/);
  });
}
test('catalog refuses duplicates, unknown groups and missing fresh-client executor', () => {
  const duplicate = catalog();
  duplicate[0] = duplicate[1]!;
  assert.throws(() => assertExtendedCatalog(duplicate, extendedGroups));
  assert.throws(() => assertExtendedCatalog([], []));
  assert.throws(() => assertExtendedCatalog([], ['typo']));
  assert.throws(() => assertExtendedCatalog([], ['list', 'list']));
  const cold = catalog().filter((s) => s.id === 'cold-user');
  delete cold[0]!.arms[0]!.cold;
  assert.throws(() => assertExtendedCatalog(cold, ['cold']), /fresh client/);
});
test('ordering uses id tie keys before offset; original deep filtered row stays empty', () => {
  const posts = Array.from({ length: 60 }, (_, i) => ({
    id: String(i + 1),
    org_id: '1',
    published: true,
    created_at: at,
  }));
  const f = fixture({ posts });
  assert.deepEqual(
    (expectedExtended('list-page3', f) as Row[]).map((p) => p.id),
    Array.from({ length: 20 }, (_, i) => String(20 - i)),
  );
  assert.deepEqual(expectedExtended('list-deep', f), []);
});
test('large and wide expectations retain complete rows and original result sizes', () => {
  const comments = Array.from({ length: 50000 }, (_, i) => ({ id: String(i + 1), body: `body-${i}` }));
  const bench_wide = Array.from({ length: 2000 }, (_, i) => ({ id: i + 1, t20: `wide-${i}`, d03: at }));
  const f = fixture({ comments, bench_wide });
  assert.equal((expectedExtended('comments-5000', f) as Row[]).length, 5000);
  assert.deepEqual(expectedExtended('comments-50000', f), comments);
  assert.deepEqual((expectedExtended('wide-1000', f) as Row[])[999], bench_wide[999]);
});
test('relation oracles independently follow foreign keys, count all posts and sort tags', () => {
  const users = [
    { id: '1', name: 'first', avatar_url: null },
    { id: '2', name: 'second', avatar_url: 'x' },
  ];
  const posts = [
    { id: '4', user_id: '2', published: false, title: 'fourth' },
    { id: '5', user_id: '1', published: true, title: 'fifth' },
  ];
  const tags = [
    { id: '2', name: 'two', slug: 'two' },
    { id: '9', name: 'nine', slug: 'nine' },
  ];
  const f = fixture({
    users,
    posts,
    tags,
    post_tags: [
      { post_id: '4', tag_id: '9' },
      { post_id: '4', tag_id: '2' },
    ],
  });
  assert.deepEqual(expectedExtended('to-one', f), [
    { ...posts[0], user: users[1] },
    { ...posts[1], user: users[0] },
  ]);
  assert.deepEqual(expectedExtended('many-to-many', f), [
    { ...posts[0], tags },
    { ...posts[1], tags: [] },
  ]);
  assert.deepEqual(expectedExtended('relation-filter', f), [users[0]]);
  assert.deepEqual(
    expectedExtended('relation-count', f),
    users.map((u) => ({ ...u, _count: { posts: '1' } })),
  );
  assert.deepEqual(expectedExtended('strategy-many', f), [
    { ...users[0], posts: [posts[1]] },
    { ...users[1], posts: [posts[0]] },
  ]);
  assert.deepEqual(expectedExtended('strategy-one', f), expectedExtended('to-one', f));
  assert.deepEqual(expectedExtended('cold-user', f), users[0]);
});
test('aggregate oracle uses integer arithmetic and HAVING, including a nonterminating average', () => {
  const posts = Array.from({ length: 101 }, (_, i) => ({ id: i + 1, org_id: '9', view_count: i === 100 ? 3 : 2 }));
  posts.push(...Array.from({ length: 100 }, (_, i) => ({ id: i + 102, org_id: '1', view_count: 777 })));
  assert.deepEqual(expectedExtended('group-by', fixture({ posts })), [{ orgId: '9', c: '101', avgViews: '203/101' }]);
  assert.equal(exactDecimal('93.5000000000000000'), '187/2');
  assert.equal(exactDecimal(93.5), '187/2');
  assert.equal(exactDecimal('1.2500e-2'), '1/80');
  assert.notEqual(exactDecimal('0.3333333333333333'), '1/3');
  for (const value of [NaN, Infinity, null, 'nan', '1/3', '1e99999']) assert.throws(() => exactDecimal(value));
});
test('exact checks retain arbitrary precision and reject missing, extra, reordered and mistyped values', () => {
  assertExtendedExact('exact ids', [{ id: 9007199254740993n, tagId: 11n }], [{ id: '9007199254740993', tag_id: '11' }]);
  assert.throws(
    () => assertExtendedExact('unsafe', [{ id: Number('9007199254740993') }], [{ id: '9007199254740993' }]),
    /Unsafe integer/,
  );
  const expected = [
    { id: '1', body: '0001', nullable: null, created_at: at },
    { id: '2', body: '2', nullable: null, created_at: at },
  ];
  for (const bad of [
    [],
    expected.slice().reverse(),
    [{ ...expected[0], nullable: undefined }, expected[1]],
    [{ ...expected[0], extra: 1 }, expected[1]],
    [{ ...expected[0], body: 1 }, expected[1]],
    [{ ...expected[0], created_at: at.toISOString() }, expected[1]],
  ])
    assert.throws(() => assertExtendedExact('mutation', bad, expected), /exact result mismatch/);
  assert.throws(
    () => assertExtendedExact('invalid date', [{ createdAt: new Date('invalid') }], expected),
    /Invalid Date/,
  );
});
test('junction flattening validates target and source identities rather than hiding wrong joins', () => {
  assert.deepEqual(
    flattenTags([
      { id: 7n, title: 'p', postTags: [{ postId: 7n, tagId: 4n, tag: { id: 4n, name: 'tag', slug: 'tag' } }] },
    ]),
    [{ id: 7n, title: 'p', tags: [{ id: 4n, name: 'tag', slug: 'tag' }] }],
  );
  for (const j of [
    { postId: 8, tagId: 4, tag: { id: 4 } },
    { postId: 7, tagId: 4, tag: { id: 5 } },
    { postId: 7, tagId: 4, tag: { id: 4 }, extra: 1 },
  ])
    assert.throws(() => flattenTags([{ id: 7, postTags: [j] }]));
});
test('native count/aggregate adapters refuse missing or extra fields', () => {
  assert.deepEqual(nativeCounts([{ id: 1, _count: { posts: 10 } }]), [{ id: 1, _count: { posts: '10' } }]);
  assert.throws(() => nativeCounts([{ id: 1, _count: { posts: 10, comments: 3 } }]));
  assert.deepEqual(aggregateRows([{ orgId: 1n, _count: 2000, _avg: { viewCount: 93.5 } }], true), [
    { orgId: 1n, c: '2000', avgViews: '187/2' },
  ]);
  assert.throws(() => aggregateRows([{ orgId: 1, _count: 2000, _avg: { viewCount: 93.5 }, extra: true }], true));
  assert.throws(() => aggregateRows([{ orgId: 1, c: Number('9007199254740993'), avgViews: '93.5' }], false));
  assert.throws(() => resultOne([]));
  assert.throws(() => resultOne([{ id: 1 }, { id: 2 }]));
});
const writeBefore = (id: ExtendedId): Row[] =>
  [`${id}-target`, 'sentinel-a', 'sentinel-b'].map((slug, i) => ({
    id: String(i + 1),
    org_id: '1',
    slug,
    label: slug,
    amount: -777,
    active: true,
    created_at: writeTime,
  }));
for (const id of ['create-many', 'update', 'upsert', 'delete'] as const) {
  test(`${id}: independently reject plausible returning with absent/extra/wrong actual writes`, async () => {
    const before = id === 'create-many' ? [] : writeBefore(id);
    const expected = expectedWrite(id, before, 3);
    await verifyWrite({ query: async () => ({ rows: expected.after }) }, id, id, before, 3, expected.returning);
    await assert.rejects(
      verifyWrite({ query: async () => ({ rows: before }) }, id, id, before, 3, expected.returning),
      /actual write effect/,
    );
    await assert.rejects(
      verifyWrite(
        { query: async () => ({ rows: [...expected.after, { id: '9999' }] }) },
        id,
        id,
        before,
        3,
        expected.returning,
      ),
      /actual write effect/,
    );
    await assert.rejects(
      verifyWrite({ query: async () => ({ rows: expected.after }) }, id, id, before, 3, []),
      /returning|exactly one/,
    );
    if (id !== 'create-many') {
      const changed = expected.after.map((r, i) => (i === expected.after.length - 1 ? { ...r, amount: 55 } : r));
      await assert.rejects(
        verifyWrite({ query: async () => ({ rows: changed }) }, id, id, before, 3, expected.returning),
        /actual write effect/,
      );
    }
  });
}
test('write prerequisites prevent vacuous success and preserve bulk scale', () => {
  assert.equal(bulkRows.length, 1000);
  assert.throws(() => expectedWrite('update', [], 0), /prerequisite/);
  assert.throws(() => expectedWrite('create-many', writeBefore('update'), 0), /empty/);
});

/** Synthetic timings exist only to test JSON admission, never as measured evidence. */
test('aggregation admits complete matching reports, with smoke requiring explicit separate admission', () => {
  assert.equal(assertExtendedRuns([syntheticRun(), syntheticRun()]), 'extended-exact-ordered-v1');
  assert.throws(() => assertExtendedRuns([]), /No extended runs/);
  assert.throws(() => assertExtendedRuns([syntheticRun(true)]), /smoke logs/);
  assert.equal(assertExtendedRuns([syntheticRun(true)], { allowSmoke: true }), 'extended-exact-ordered-v1');
});
for (const entry of extendedCatalog)
  test(`aggregation rejects missing RC and omitted catalog row: ${entry.id}`, () => {
    const missingArm = syntheticRun();
    const row = missingArm.results.find((s) => s.scenario === entry.scenario)!;
    row.stats = row.stats.filter((a) => a.name !== 'Drizzle RC');
    assert.throws(() => assertExtendedRuns([missingArm]), /arms/);
    const missingRow = syntheticRun();
    missingRow.results = missingRow.results.filter((s) => s.scenario !== entry.scenario);
    assert.throws(() => assertExtendedRuns([missingRow]), /scenario catalog/);
  });
test('aggregation refuses stale semantics, false cleanup, weakened prepared policy and malformed timings', () => {
  const mutations: ((r: ReturnType<typeof syntheticRun>) => void)[] = [
    (r) => {
      r.extendedSemantics = 'historical';
    },
    (r) => {
      r.status = 'failed';
    },
    (r) => {
      r.mode = 'correctness-only';
    },
    (r) => {
      r.groups.pop();
    },
    (r) => {
      r.preflight.cases--;
    },
    (r) => {
      r.preflight.scenarios--;
    },
    (r) => {
      Reflect.set(r.preflight.fixtureCounts, 'comments', 50);
    },
    (r) => {
      r.cleanup.borrowedPoolsEnded = false;
    },
    (r) => {
      r.cleanup.scratchAndSequenceRestored = false;
    },
    (r) => {
      r.profile.poolMax = 2;
    },
    (r) => {
      r.profile.prepared.preparedStatements = false;
    },
    (r) => {
      r.profile.prepared.nativeNamedVerified = false;
    },
    (r) => {
      r.profile.prepared.nativeForceCustomPlanUnnamedVerified = false;
    },
    (r) => {
      r.versions.drizzleRc = '0.45.4';
    },
    (r) => {
      r.catalog[0]!.arms[0]!.preparedPolicy = 'unnamed-native-default';
    },
    (r) => {
      r.catalog[0]!.selected = false;
    },
    (r) => {
      r.results[0]!.stats[0]!.n = 0;
    },
    (r) => {
      r.results[0]!.stats[0]!.median = NaN;
    },
    (r) => {
      r.results[0]!.stats[0]!.p95 = Infinity;
    },
    (r) => {
      r.results[0]!.stats[0]!.min = -1;
    },
    (r) => {
      r.driftTail = NaN;
    },
  ];
  for (const mutate of mutations) {
    const run = syntheticRun();
    mutate(run);
    assert.throws(() => assertExtendedRuns([run]));
  }
  const changed = syntheticRun();
  changed.profile.jsonEncoding = 'object';
  assert.throws(() => assertExtendedRuns([syntheticRun(), changed]), /campaign profile/);
});
