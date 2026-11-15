/** Original operation catalog, adapted to SQLite without changing production APIs. */
import type { DatabaseSync } from 'node:sqlite';
import type { Arm } from './bench-harness.js';
import { headlineNames } from './equivalence.js';
import { CASES, PAGE } from './postgres-pagination/corpus.mjs';
import {
  aggregate,
  bulkRows,
  type Lane,
  names,
  openLane,
  recentOrder,
  relationCounts,
  type Spec,
} from './sqlite-comparison-clients.js';
import {
  assertExact,
  authors,
  type ComparisonScenario,
  type Fixture,
  nestedUsers,
  type Row,
  type Status,
  tags,
} from './sqlite-equivalence.js';
import { decodeRow, EPOCH } from './sqlite-seed.js';

export interface CatalogRow {
  id: string;
  group: string;
  scenario: string;
  arm: string;
  status: Status;
  reason: string;
}
const extendedIds = [
  'large-5000',
  'large-50000',
  'large-wide',
  'list-page3',
  'list-deep',
  'relations-author',
  'relations-tags',
  'relations-count',
  'relations-filter',
  'agg',
  'writes-bulk',
  'writes-update',
  'writes-upsert',
  'writes-delete',
  'strategy-many',
  'strategy-one',
  'cold',
  'stream-parity',
  'deep-offset',
];
export const requiredIds = [
  ...headlineNames.map((_, i) => `headline-${i}`),
  ...extendedIds,
  ...CASES.flatMap((c: Row) => ['offset', 'provided', 'locate'].map((m) => `pagination-${c.id}-${m}`)),
];
export const boundaryRows: CatalogRow[] = [
  ...names.flatMap((arm) =>
    ['findUnique by PK', 'L2, 50 users + posts', 'dashboard, 5 independent queries'].map((s) => ({
      id: `network-${s}`,
      group: 'latency',
      scenario: `RTT latency: ${s}`,
      arm,
      status: 'not-applicable' as const,
      reason: 'Embedded SQLite has no client/server network round trip; no artificial delay is substituted.',
    })),
  ),
  {
    id: 'pg-custom-plan',
    group: 'list',
    scenario: 'deep-offset forceCustomPlan',
    arm: 'Turbine +fCP',
    status: 'refused',
    reason:
      'PG-specific forceCustomPlan cannot be honored by SQLite; verify E017 instead of substituting another strategy.',
  },
  {
    id: 'pg-named-plan',
    group: 'deep',
    scenario: 'deep-offset named/generic plan promotion',
    arm: 'Raw pg (NAMED)',
    status: 'not-applicable',
    reason:
      'SQLite has no PG named protocol statement or generic-plan promotion. Raw SQLite prepared and fresh prepare arms are separate.',
  },
  {
    id: 'pg-wire-pipeline',
    group: 'headline',
    scenario: headlineNames[8],
    arm: 'PG wire pipeline',
    status: 'not-applicable',
    reason:
      'Turbine public pipeline executes its native sequential SQLite fallback; independent five-read work is preserved.',
  },
  {
    id: 'pg-read-committed',
    group: 'headline',
    scenario: headlineNames[9],
    arm: 'READ COMMITTED isolation',
    status: 'not-applicable',
    reason:
      'All SQLite arms use one native deferred transaction on one connection, a SQLite snapshot rather than PG READ COMMITTED.',
  },
  {
    id: 'prisma-join',
    group: 'relations',
    scenario: 'Prisma relationLoadStrategy join',
    arm: 'Prisma 7 join',
    status: 'refused',
    reason:
      'Prisma SQLite exposes query relation loading only; the supported Prisma 7 arms use its native include API without changing any requested strategy.',
  },
  {
    id: 'pg-server-cursor',
    group: 'stream',
    scenario: 'server cursor FETCH',
    arm: 'Turbine PG cursor',
    status: 'not-applicable',
    reason:
      'SQLite Turbine streams through native StatementSync.iterate; no server cursor exists. Competitor keyset and raw iterator arms remain explicit.',
  },
];
export function buildCatalog(
  lanes: Lane[],
  f: Fixture,
  admin: DatabaseSync,
  file: string,
  fault = 'none',
): { scenarios: ComparisonScenario[]; catalog: CatalogRow[] } {
  const scenarios: ComparisonScenario[] = [],
    catalog: CatalogRow[] = [...boundaryRows];
  const laneArms = (
    fn: (lane: Lane, i: number, observe?: (r: unknown) => void) => unknown,
    setup?: (i: number) => unknown,
  ) =>
    lanes.map((lane) => ({
      name: lane.name,
      fn: async (i: number, o?: (r: unknown) => void) => fn(lane, i, o),
      ...(setup ? { setup: async (i: number) => setup(i) } : {}),
    }));
  const add = (s: ComparisonScenario) => {
    scenarios.push(s);
    for (const a of s.arms)
      catalog.push({
        id: s.id,
        group: s.group,
        scenario: s.scenario,
        arm: a.name,
        status: 'supported',
        reason: s.note ?? 'Exact ordered complete values checked before timing.',
      });
  };
  const find = (table: string, s: Spec, one = false) => laneArms((l) => l.find(table, s, one));
  const reads = (
    id: string,
    group: string,
    scenario: string,
    table: string,
    s: Spec,
    expected: unknown,
    one = false,
    note?: string,
  ) => add({ id, group, scenario, arms: find(table, s, one), expected: () => expected, note });
  const byId = { id: 'asc' };
  reads('headline-0', 'headline', headlineNames[0], 'users', { limit: 100, orderBy: byId }, f.users!.slice(0, 100));
  reads(
    'headline-1',
    'headline',
    headlineNames[1],
    'users',
    { limit: 50, orderBy: byId, with: { posts: { orderBy: byId } } },
    nestedUsers(f, 50),
  );
  reads(
    'headline-2',
    'headline',
    headlineNames[2],
    'users',
    { limit: 10, orderBy: byId, with: { posts: { limit: 5, orderBy: byId, with: { comments: { orderBy: byId } } } } },
    nestedUsers(f, 10, 5, true),
  );
  reads('headline-3', 'headline', headlineNames[3], 'users', { where: { id: 1 } }, f.users![0], true);
  reads(
    'headline-4',
    'headline',
    headlineNames[4],
    'users',
    { where: { id: 1 }, with: { posts: { orderBy: byId, with: { comments: { orderBy: byId } } } } },
    nestedUsers(f, 1, 10, true)[0],
    true,
  );
  add({
    id: 'headline-5',
    group: 'headline',
    scenario: headlineNames[5],
    arms: laneArms((l) => l.count('users')),
    expected: () => 1000,
  });
  const stream = (lane: Lane, batches: boolean, observe?: (r: unknown) => void, native = false) =>
    (async () => {
      let n = 0;
      if (lane.name === 'Turbine') {
        const q = lane.db.table('comments');
        if (batches) {
          for await (const batch of q.findManyStreamBatches({ batchSize: 1000, orderBy: byId }))
            for (const r of batch) {
              observe?.(r);
              n++;
            }
        } else
          for await (const r of q.findManyStream({ batchSize: 1000, orderBy: byId })) {
            observe?.(r);
            n++;
          }
      } else if (native) {
        for (const r of lane.db.prepare('SELECT * FROM comments ORDER BY id').iterate()) {
          observe?.(decodeRow('comments', r));
          n++;
        }
      } else {
        let last = 0;
        for (;;) {
          const batch = await lane.find('comments', { where: { id: { gt: last } }, orderBy: byId, limit: 1000 });
          for (const r of batch) {
            observe?.(r);
            last = r.id;
            n++;
          }
          if (batch.length < 1000) break;
        }
      }
      return n;
    })();
  add({
    id: 'headline-6',
    group: 'headline',
    scenario: headlineNames[6],
    arms: laneArms((l, _i, o) => stream(l, false, o)),
    expected: () => f.comments,
    stream: true,
    note: 'Turbine native iterator row API; other arms use independent 1000-row keyset pages on the same static fixture.',
  });
  const originalPost = f.posts![0]!;
  const readPosts = () =>
    admin
      .prepare('SELECT * FROM posts ORDER BY id')
      .all()
      .map((r) => decodeRow('posts', r));
  const resetPost = () => {
    admin.prepare('UPDATE posts SET view_count=? WHERE id=1').run(originalPost.viewCount);
    assertExact('increment restoration', readPosts(), f.posts);
  };
  add({
    id: 'headline-7',
    group: 'headline',
    scenario: headlineNames[7],
    arms: laneArms(
      (l) =>
        fault === 'write-effect' && l.name === 'Raw'
          ? { ...originalPost, viewCount: originalPost.viewCount + 1 }
          : l.write('increment', 37),
      () => resetPost(),
    ),
    expected: () => ({ ...originalPost, viewCount: originalPost.viewCount + 1 }),
    after: async () =>
      assertExact(
        'increment independent storage effect',
        readPosts(),
        f.posts!.map((p) => (p.id === 1 ? { ...p, viewCount: p.viewCount + 1 } : p)),
      ),
    restore: resetPost,
    note: 'Every arm performs UPDATE RETURNING, checked against the entire native posts table and restored outside timing.',
  });
  const dash = [
    f.users![0],
    f.posts!.filter((p) => p.userId === 1).length,
    f.comments!.filter((c) => c.userId === 1).length,
    f
      .posts!.filter((p) => p.userId === 1)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id)
      .slice(0, 5),
    1000,
  ];
  for (const tx of [false, true])
    add({
      id: `headline-${tx ? 9 : 8}`,
      group: 'headline',
      scenario: headlineNames[tx ? 9 : 8],
      arms: laneArms((l) => l.dashboard(tx)),
      expected: () => dash,
      note: tx
        ? 'One native deferred transaction on one connection; SQLite snapshot semantics differ from PG READ COMMITTED.'
        : 'Five independent reads; no transaction. Turbine uses its public pipeline fallback, Drizzle/raw synchronous APIs and Prisma Promise.all.',
    });
  add({
    id: 'headline-10',
    group: 'headline',
    scenario: headlineNames[10],
    arms: laneArms((l, i) => l.find('users', { where: { id: (i % 50) + 1 } }, true)),
    expected: (i) => f.users![i % 50],
  });
  for (const n of [5000, 50000])
    reads(
      `large-${n}`,
      'large',
      `findMany, ${n.toLocaleString('en-US')} comments (flat)`,
      'comments',
      { limit: n, orderBy: byId },
      f.comments!.slice(0, n),
    );
  reads(
    'large-wide',
    'large',
    'findMany, 1,000 rows x 39 columns (wide)',
    'bench_wide',
    { limit: 1000, orderBy: byId },
    f.bench_wide!.slice(0, 1000),
  );
  const published = f
    .posts!.filter((p) => p.orgId === 1 && p.published)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
  for (const [id, label, offset] of [
    ['list-page3', 'page 3', 40],
    ['list-deep', 'deep offset', 9000],
  ] as const)
    reads(
      id,
      'list',
      `list, published posts in org 1, newest first (${label})`,
      'posts',
      { where: { orgId: 1, published: true }, orderBy: recentOrder, limit: 20, offset },
      published.slice(offset, offset + 20),
      false,
      offset === 9000
        ? 'Original offset 9000 exceeds the 1400 matching rows. This exact empty page is preserved; the separate 24K pagination fixture has populated deep pages.'
        : undefined,
    );
  reads(
    'relations-author',
    'relations',
    'to-one, 500 posts + author',
    'posts',
    { limit: 500, orderBy: byId, with: { user: true } },
    authors(f, 500),
  );
  add({
    id: 'relations-tags',
    group: 'relations',
    scenario: 'many-to-many, 200 posts + tags through a junction',
    arms: laneArms(async (l) => {
      if (['Turbine', 'Drizzle RC', 'Raw'].includes(l.name))
        return l.find('posts', { limit: 200, orderBy: byId, with: { tags: { orderBy: byId } } });
      const rows = await l.find('posts', {
        limit: 200,
        orderBy: byId,
        with: { postTags: { orderBy: { tagId: 'asc' }, with: { tag: true } } },
      });
      return rows.map(({ postTags, ...r }: Row) => ({ ...r, tags: postTags.map((j: Row) => j.tag) }));
    }).concat([
      {
        name: 'Drizzle RC junction',
        fn: async () => {
          const rows = await lanes
            .find((l) => l.name === 'Drizzle RC')!
            .find('posts', {
              limit: 200,
              orderBy: byId,
              with: { postTags: { orderBy: { tagId: 'asc' }, with: { tag: true } } },
            });
          return rows.map(({ postTags, ...r }: Row) => ({ ...r, tags: postTags.map((j: Row) => j.tag) }));
        },
      },
    ]),
    expected: () => tags(f, 200),
    note: 'Turbine detected tags, Drizzle RC native through relation and raw correlated tag JSON return direct tags. Stable Drizzle/Prisma require an explicit junction flattened inside the measured call; the RC explicit junction remains a separate arm. Ordered tag IDs and complete values match.',
  });
  add({
    id: 'relations-count',
    group: 'relations',
    scenario: 'relation _count, 100 users + their post count',
    arms: laneArms((l) => relationCounts(l)),
    expected: () =>
      f
        .users!.slice(0, 100)
        .map((u) => ({ ...u, _count: { posts: f.posts!.filter((p) => p.userId === u.id).length } })),
    note: 'All arms return the complete user row plus _count.posts. Drizzle uses a correlated count through its own query builder.',
  });
  reads(
    'relations-filter',
    'relations',
    'relation filter, 100 users having a published post',
    'users',
    { where: { posts: { some: { published: true } } }, limit: 100, orderBy: byId },
    f.users!.filter((u) => f.posts!.some((p) => p.userId === u.id && p.published)).slice(0, 100),
  );
  add({
    id: 'agg',
    group: 'agg',
    scenario: 'groupBy org, count + avg views, having count > 100',
    arms: laneArms((l) => aggregate(l)),
    normalize: (rows: Row[]) =>
      rows.map((r) => {
        assertExact('aggregate complete row shape', Object.keys(r).sort(), ['_avg', '_count', 'orgId']);
        assertExact('aggregate complete average shape', Object.keys(r._avg), ['viewCount']);
        return { orgId: r.orgId, c: r._count, avgViews: r._avg.viewCount };
      }),
    expected: () =>
      f.organizations!.map((o) => {
        const ps = f.posts!.filter((p) => p.orgId === o.id);
        return { orgId: o.id, c: ps.length, avgViews: ps.reduce((n, p) => n + p.viewCount, 0) / ps.length };
      }),
  });
  const scratch = () =>
    admin
      .prepare('SELECT * FROM bench_writes ORDER BY id')
      .all()
      .map((r) => decodeRow('bench_writes', r));
  const truncate = () => {
    admin.exec("DELETE FROM bench_writes; DELETE FROM sqlite_sequence WHERE name='bench_writes'");
  };
  const row = (slug: string, amount: number) => ({
    id: 1,
    orgId: 1,
    slug,
    label: slug,
    amount,
    active: true,
    createdAt: new Date(EPOCH),
  });
  const seed = (slug: string) => {
    truncate();
    admin.prepare('INSERT INTO bench_writes(org_id,slug,label) VALUES(1,?,?)').run(slug, slug);
  };
  for (const op of ['bulk', 'update', 'upsert', 'delete']) {
    const expected = (i: number) =>
      op === 'bulk'
        ? bulkRows.map((r, k) => ({ id: k + 1, ...r, active: true, createdAt: new Date(EPOCH) }))
        : row(op === 'update' ? 'update' : op === 'upsert' ? 'upsert' : 'delete', op === 'delete' ? 0 : i);
    add({
      id: `writes-${op}`,
      group: 'writes',
      scenario:
        op === 'bulk'
          ? 'createMany, 1,000 rows (full returning)'
          : op === 'update'
            ? 'update by primary key'
            : op === 'upsert'
              ? 'upsert on a unique column (update path)'
              : 'delete by unique column',
      write: op,
      arms: laneArms(
        async (l, i) => {
          const value = await l.write(op, i);
          return op === 'bulk' ? value.sort((a: Row, b: Row) => a.id - b.id) : value;
        },
        () => (op === 'bulk' ? truncate() : seed(op === 'update' ? 'update' : op === 'upsert' ? 'upsert' : 'delete')),
      ),
      expected,
      after: async (_a, i) =>
        assertExact(
          `${op} independent storage effect`,
          scratch(),
          op === 'delete' ? [] : op === 'bulk' ? expected(i) : [expected(i)],
        ),
      restore: () => {
        if (fault !== 'restore' || op !== 'update') truncate();
        assertExact('scratch restoration', scratch(), []);
      },
      note: 'Every arm returns full rows with native RETURNING. Prisma bulk uses supported createManyAndReturn, Turbine retains default returning. Untimed setup resets identity and seed; full storage effect and empty restoration checked.',
    });
  }
  const turbine = lanes.find((l) => l.name === 'Turbine')!;
  for (const many of [true, false])
    add({
      id: many ? 'strategy-many' : 'strategy-one',
      group: 'strategy',
      scenario: many ? 'strategy (to-many), 200 users + posts' : 'strategy (to-one), 500 posts + author',
      arms: (many ? ['join', 'batched', 'auto'] : ['join', 'batched', 'auto', 'flatten']).map((s) => ({
        name: `Turbine ${s}`,
        fn: async () =>
          turbine.find(many ? 'users' : 'posts', {
            limit: many ? 200 : 500,
            orderBy: byId,
            with: many ? { posts: { orderBy: byId } } : { user: true },
            relationLoadStrategy: s,
          }),
      })),
      expected: () => (many ? nestedUsers(f, 200) : authors(f, 500)),
      note: 'Explicit Turbine strategy self-comparison. Default APIs in other scenarios retain auto.',
    });
  const cold: Arm[] = lanes.map((l) => {
    let fresh: Lane | undefined;
    return {
      name: l.name,
      setup: async () => {
        if (fresh) await fresh.close();
        fresh = await openLane(l.name, file);
        if (l.name === 'Prisma 7') await fresh.db.$queryRawUnsafe('SELECT 1');
        else if (l.name === 'Turbine') await fresh.db.rawUnsafe('SELECT 1');
        else if (l.name === 'Raw') fresh.db.prepare('SELECT 1').get();
        else fresh.handle.prepare('SELECT 1').get();
      },
      fn: async () => fresh!.find('users', { where: { id: 1 } }, true),
      dispose: async () => {
        await fresh?.close();
        fresh = undefined;
      },
    } as Arm;
  });
  add({
    id: 'cold',
    group: 'cold',
    scenario: 'cold start, first query on a fresh client',
    arms: cold,
    expected: () => f.users![0],
    note: 'Connection and SELECT 1 established in untimed setup; first model query only. Process imports and module caches remain warm, matching the original scope.',
  });
  const raw = lanes.find((l) => l.name === 'Raw')!;
  add({
    id: 'stream-parity',
    group: 'stream',
    scenario: 'stream parity, rows / batches / duplicate control / keyset / native iterator',
    arms: [
      ...laneArms((l, _i, o) => stream(l, false, o)),
      ...['T batches', 'T batches#2'].map((name) => ({
        name,
        fn: async (_i: number, o?: (r: unknown) => void) => stream(turbine, true, o),
      })),
      { name: 'Raw iterator', fn: async (_i, o) => stream(raw, false, o, true) },
    ],
    expected: () => f.comments,
    stream: true,
    note: 'Same 50K ordered complete rows. Turbine row and batch native iterators, duplicate batch control, ORM/raw keyset pages, and separate raw native iterator. No materialization is substituted.',
  });
  const prepared = raw.db.prepare(
    'SELECT * FROM posts WHERE org_id=? AND published=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',
  );
  add({
    id: 'deep-offset',
    group: 'deep',
    scenario: 'deep-offset, original org/published filter at offset 9000',
    arms: [
      ...find('posts', { where: { orgId: 1, published: true }, orderBy: recentOrder, limit: 20, offset: 9000 }),
      { name: 'Raw prepared', fn: async () => prepared.all(1, 1, 20, 9000).map((r: Row) => decodeRow('posts', r)) },
    ],
    expected: () => published.slice(9000, 9020),
    note: 'Raw default prepares afresh per call; Raw prepared reuses this exact native statement. PG generic/custom plans do not exist in SQLite.',
  });
  for (const c of CASES as Row[]) {
    const table = c.parents ? 'bench_parents' : c.tiny ? 'bench_tiny' : 'bench_page';
    const ordered = c.parents
      ? f[table]!
      : f[table]!.filter((r) => !c.selective || r.bucket === 7)
          .slice()
          .sort((a, b) =>
            a.score === null
              ? b.score === null
                ? a.id - b.id
                : 1
              : b.score === null
                ? -1
                : (c.desc ? -1 : 1) * (a.score - b.score) || a.id - b.id,
          );
    const expected = c.parents
      ? ordered
          .slice(c.offset, c.offset + 3)
          .map((p) => ({ ...p, children: f.bench_children!.filter((ch) => ch.parent === p.id).slice(1, 4) }))
      : ordered.slice(c.offset, c.offset + PAGE);
    const before = ordered[c.offset - 1]!;
    const base: Spec = c.parents
      ? { orderBy: byId, limit: 3, with: { children: { orderBy: byId, offset: 1, limit: 3 } } }
      : {
          where: c.selective ? { bucket: 7 } : { bucket: { gte: 0 } },
          orderBy: [{ score: { sort: c.desc ? 'desc' : 'asc', nulls: 'last' } }, { id: 'asc' }],
          limit: PAGE,
        };
    for (const method of ['offset', 'provided', 'locate'])
      add({
        id: `pagination-${c.id}-${method}`,
        group: 'pagination',
        scenario: `pagination ${c.id}, ${method}`,
        arms: laneArms(async (l) => {
          if (method === 'offset') return l.find(table, { ...base, offset: c.offset });
          const cursor =
            method === 'locate'
              ? (await l.find(table, { ...base, with: undefined, limit: 1, offset: c.offset - 1 }))[0]
              : before;
          if (l.name === 'Turbine' || l.name === 'Prisma 7')
            return l.find(table, {
              ...base,
              cursor: c.parents ? { id: cursor.id } : { score: cursor.score, id: cursor.id },
            });
          // Explicit lexicographic keyset predicate for query builders without a cursor API.
          const after = c.parents
            ? { id: { gt: cursor.id } }
            : cursor.score === null
              ? { AND: [{ score: null }, { id: { gt: cursor.id } }] }
              : {
                  OR: [
                    { score: { [c.desc ? 'lt' : 'gt']: cursor.score } },
                    { AND: [{ score: cursor.score }, { id: { gt: cursor.id } }] },
                    { score: null },
                  ],
                };
          return l.find(table, { ...base, where: base.where ? { AND: [base.where, after] } : after });
        }),
        expected: () => expected,
        note: 'Original 24K pagination corpus, including ties, nulls, tiny/final/empty/selective/mixed-direction pages and nested parent child windows. Provided cursor excludes lookup; locate includes native boundary lookup. Drizzle/raw use explicit lexicographic predicates; Prisma native unique-ID cursor and Turbine ordered-value cursor remain distinct.',
      });
  }
  return { scenarios, catalog };
}
export async function disposeCatalog(scenarios: ComparisonScenario[]): Promise<void> {
  const errors: unknown[] = [];
  for (const s of scenarios)
    for (const a of s.arms)
      try {
        await (a as Arm & { dispose?: () => Promise<void> }).dispose?.();
      } catch (e) {
        errors.push(e);
      }
  if (errors.length) throw new AggregateError(errors, 'Cold client cleanup failed');
}
