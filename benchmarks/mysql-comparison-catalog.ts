/** Full operation catalog from the original comparison entry points. */
import { headlineNames } from './equivalence.js';
import type { Adapter } from './mysql-comparison-adapters.js';
import { FIXTURE_TIME } from './mysql-comparison-config.js';
import { authors, dashboardExpected, type Fixture, nestedUsers, type Row } from './mysql-equivalence.js';
export const ARM_NAMES = ['Turbine', 'Raw', 'Drizzle', 'Drizzle RC', 'Prisma 7'] as const;
export const ORIGINAL_MYSQL_IDS = [
  'headline.flat',
  'headline.l2',
  'headline.l3',
  'headline.unique',
  'headline.unique-l3',
  'headline.count',
  'headline.stream',
  'headline.increment',
  'headline.pipeline',
  'headline.transaction',
  'headline.hot',
  'large.comments-5000',
  'large.comments-50000',
  'large.wide',
  'list.offset-40',
  'list.offset-9000',
  'relations.author',
  'relations.tags',
  'relations.count',
  'relations.filter',
  'agg.groups',
  'writes.bulk',
  'writes.update',
  'writes.upsert',
  'writes.delete',
  'writes.bulk-count',
  'strategy.posts.join',
  'strategy.posts.batched',
  'strategy.posts.auto',
  'strategy.user.join',
  'strategy.user.batched',
  'strategy.user.auto',
  'strategy.user.flatten',
  'cold.first',
  'stream.rows',
  'stream.batches',
  'stream.keyset',
  'stream.parity',
  'stream.native',
  'deep.text',
  'deep.offset',
  'latency.unique',
  'latency.l2',
  'latency.dashboard',
  'latency.l2-join',
  'latency.l2-batched',
  'latency.l2-auto',
] as const;
export interface Scenario {
  id: string;
  group: string;
  name: string;
  note: string;
  run: (adapter: Adapter, i: number, observe?: (row: unknown) => void) => Promise<unknown>;
  expected?: (fixture: Fixture, i: number) => unknown;
  write?: 'increment' | 'bulk' | 'bulk-count' | 'update' | 'upsert' | 'delete';
  stream?: boolean;
  strategy?: boolean;
  cold?: boolean;
  unsupported?: Partial<Record<(typeof ARM_NAMES)[number], string>>;
}
export const bulkRows: Row[] = Array.from({ length: 1000 }, (_, i) => ({
  orgId: (i % 5) + 1,
  slug: `bulk-${i}`,
  label: `Bulk row ${i}`,
  amount: i % 997,
  active: true,
  createdAt: FIXTURE_TIME,
}));
export function catalog(): Scenario[] {
  const out: Scenario[] = [];
  const add = (s: Omit<Scenario, 'note'> & { note?: string }) =>
    out.push({ ...s, note: s.note ?? 'Complete ordered rows, original projection and volume; id ASC breaks ties.' });
  add({
    id: 'headline.flat',
    group: 'headline',
    name: headlineNames[0],
    run: (a) => a.find('users', { take: 100 }),
    expected: (f) => f.users.slice(0, 100),
  });
  add({
    id: 'headline.l2',
    group: 'headline',
    name: headlineNames[1],
    run: (a) => a.find('users', { take: 50, relation: 'posts' }),
    expected: (f) => nestedUsers(f, 50),
    note: 'Native relation APIs; raw L2 uses a single lateral/window JSON statement with explicit child ordering. Raw deeper/junction relations use explicit batched SQL and stitching. All decoded values and ordering must match.',
  });
  add({
    id: 'headline.l3',
    group: 'headline',
    name: headlineNames[2],
    run: (a) => a.find('users', { take: 10, relation: 'l3', postLimit: 5 }),
    expected: (f) => nestedUsers(f, 10, 5, true),
  });
  add({
    id: 'headline.unique',
    group: 'headline',
    name: headlineNames[3],
    run: async (a) => (await a.find('users', { id: 1, take: 1, unique: true }))[0],
    expected: (f) => f.users[0],
  });
  add({
    id: 'headline.unique-l3',
    group: 'headline',
    name: headlineNames[4],
    run: async (a) => (await a.find('users', { id: 1, take: 1, unique: true, relation: 'l3' }))[0],
    expected: (f) => nestedUsers(f, 1, undefined, true, 1)[0],
  });
  add({
    id: 'headline.count',
    group: 'headline',
    name: headlineNames[5],
    run: (a) => a.count('users'),
    expected: (f) => f.users.length,
  });
  add({
    id: 'headline.stream',
    group: 'headline',
    name: headlineNames[6],
    stream: true,
    run: (a, _i, observe) => a.stream('rows', observe),
    note: 'Turbine native mysql2 incremental result on one checkout; other arms independent id-keyset pages of 1000. Static fixture equivalence only; not cursor/snapshot equivalence.',
  });
  add({
    id: 'headline.increment',
    group: 'headline',
    name: headlineNames[7],
    write: 'increment',
    run: (a) => a.increment(),
    note: 'MySQL has no RETURNING. Turbine/Prisma native return paths, raw/Drizzle explicit transaction+reselect. Full returned row and all stored post columns checked; counter restored outside timing.',
  });
  add({
    id: 'headline.pipeline',
    group: 'headline',
    name: headlineNames[8],
    run: (a) => a.dashboard(false),
    expected: dashboardExpected,
    unsupported: {
      Turbine:
        'MySQL does not implement the PostgreSQL extended-query pipeline. See latency.dashboard independent pool-read equivalent; no one-RTT claim.',
    },
    note: 'Competitors retain five independent concurrent pool reads; Turbine native pipeline unavailable. No speed win may be inferred from a missing arm.',
  });
  add({
    id: 'headline.transaction',
    group: 'headline',
    name: headlineNames[9],
    run: (a) => a.dashboard(true),
    expected: dashboardExpected,
    note: 'Five sequential reads on one pinned connection in one explicit READ COMMITTED transaction for every arm. No cross-statement shared-snapshot claim.',
  });
  add({
    id: 'headline.hot',
    group: 'headline',
    name: headlineNames[10],
    run: async (a, i) => (await a.find('users', { id: (i % 50) + 1, take: 1, unique: true }))[0],
    expected: (f, i) => f.users[i % 50],
  });
  for (const n of [5000, 50000])
    add({
      id: `large.comments-${n}`,
      group: 'large',
      name: `findMany, ${n.toLocaleString('en-US')} comments (flat)`,
      run: (a) => a.find('comments', { take: n }),
      expected: (f) => f.comments.slice(0, n),
    });
  add({
    id: 'large.wide',
    group: 'large',
    name: 'findMany, 1,000 rows x 39 columns (wide)',
    run: (a) => a.find('benchWide', { take: 1000 }),
    expected: (f) => f.bench_wide.slice(0, 1000),
  });
  for (const [label, offset] of [
    ['page 3', 40],
    ['deep offset', 9000],
  ] as const)
    add({
      id: `list.offset-${offset}`,
      group: 'list',
      name: `list, published posts in org 1, newest first (${label})`,
      run: (a) => a.find('posts', { orgId: 1, published: true, newest: true, take: 20, skip: offset }),
      expected: (f) =>
        f.posts
          .filter((p) => p.orgId === 1 && p.published === true)
          .sort((a, b) => Number(b.id) - Number(a.id))
          .slice(offset, offset + 20),
      note:
        offset === 9000
          ? 'Original org 1 has 1400 published rows: offset 9000 is intentionally empty. MySQL has no PostgreSQL generic-plan/forceCustomPlan equivalent; empty work is not deep-page performance evidence.'
          : 'createdAt DESC, id DESC; fixture deliberately has timestamp ties.',
    });
  add({
    id: 'relations.author',
    group: 'relations',
    name: 'to-one, 500 posts + author',
    run: (a) => a.find('posts', { take: 500, relation: 'user' }),
    expected: (f) => authors(f, 500),
  });
  add({
    id: 'relations.tags',
    group: 'relations',
    name: 'many-to-many, 200 posts + tags through a junction',
    run: (a) => a.find('posts', { take: 200, relation: 'tags' }),
    expected: (f) =>
      f.posts.slice(0, 200).map((p) => ({
        ...p,
        tags: f.post_tags.filter((t) => t.postId === p.id).map((t) => f.tags.find((tag) => tag.id === t.tagId)),
      })),
    note: 'Turbine native junction detection returns tags; Prisma/Drizzle explicit junction results are flattened inside the measured call. All tag fields and tag-id order checked.',
  });
  add({
    id: 'relations.count',
    group: 'relations',
    name: 'relation _count, 100 users + their post count',
    run: (a) => a.find('users', { take: 100, relation: 'count' }),
    expected: (f) =>
      f.users.slice(0, 100).map((u) => ({ ...u, _count: { posts: f.posts.filter((p) => p.userId === u.id).length } })),
    note: 'Full parent projection in every arm; Drizzle uses a correlated SQL count through its own builder and reshapes it inside the measured call.',
  });
  add({
    id: 'relations.filter',
    group: 'relations',
    name: 'relation filter, 100 users having a published post',
    run: (a) => a.find('users', { take: 100, havingPublished: true }),
    expected: (f) =>
      f.users.filter((u) => f.posts.some((p) => p.userId === u.id && p.published === true)).slice(0, 100),
    note: 'Turbine/Prisma native some filter; Drizzle uses EXISTS through its own query builder.',
  });
  add({
    id: 'agg.groups',
    group: 'agg',
    name: 'groupBy org, count + avg views, having count > 100',
    run: (a) => a.aggregate(),
    expected: (f) =>
      [1, 2, 3, 4, 5].map((orgId) => {
        const posts = f.posts.filter((p) => p.orgId === orgId);
        return {
          orgId,
          count: posts.length,
          avgViews: posts.reduce((n, p) => n + Number(p.viewCount), 0) / posts.length,
        };
      }),
  });
  for (const kind of ['bulk', 'update', 'upsert', 'delete'] as const)
    add({
      id: `writes.${kind}`,
      group: 'writes',
      name: {
        bulk: 'createMany, 1,000 rows',
        update: 'update by primary key',
        upsert: 'upsert on a unique column (update path)',
        delete: 'delete by unique column',
      }[kind],
      write: kind,
      ...(kind === 'bulk'
        ? {
            unsupported: {
              Turbine:
                'Default createMany writes the rows but returns []; original full-row return contract is unavailable. Tested boundary; explicit count variant is writes.bulk-count.',
            },
          }
        : {}),
      run: (a, i) =>
        kind === 'bulk'
          ? a.bulk(bulkRows)
          : kind === 'update'
            ? a.update(i)
            : kind === 'upsert'
              ? a.upsert(i)
              : a.delete(),
      note:
        kind === 'bulk'
          ? 'Original native createMany result contracts differ: Prisma returns count, raw/Drizzle return native result headers; Turbine default returns no rows and is unsupported for full-row results. Storage effects are exact; this is not return-work parity. Scratch truncation is untimed.'
          : 'Full returned scratch row; raw/Drizzle include explicit transaction/reselect emulation in timing. Scratch preparation and restoration are untimed.',
    });
  add({
    id: 'writes.bulk-count',
    group: 'writes',
    name: 'createMany, 1,000 rows, explicit count result',
    write: 'bulk-count',
    run: (a) => a.bulkCount(bulkRows),
    note: 'Turbine explicitly requests returning:false; Prisma native count; raw/Drizzle map affectedRows inside the measured call. Every arm returns {count:1000}; every stored field is independently verified. This is a count-result equivalent alongside the retained original default-result entry.',
  });
  for (const [relation, n, strategies] of [
    ['posts', 200, ['join', 'batched', 'auto']],
    ['user', 500, ['join', 'batched', 'auto', 'flatten']],
  ] as const)
    for (const strategy of strategies)
      add({
        id: `strategy.${relation}.${strategy}`,
        group: 'strategy',
        name: `strategy (${relation === 'posts' ? 'to-many' : 'to-one'}), ${n} ${relation === 'posts' ? 'users + posts' : 'posts + author'} [${strategy}]`,
        strategy: true,
        unsupported: {
          Raw: 'Turbine-specific strategy selector; raw native relation baseline is in the relation scenarios.',
          Drizzle: 'No Turbine strategy selector. Native relation arm is in the relation scenarios.',
          'Drizzle RC': 'No Turbine strategy selector. Native RC relation arm is in the relation scenarios.',
          'Prisma 7': 'No Turbine strategy selector. Native Prisma relation arm is in the relation scenarios.',
        },
        run: (a) => a.find(relation === 'posts' ? 'users' : 'posts', { take: n, relation, strategy }),
        expected: (f) => (relation === 'posts' ? nestedUsers(f, n) : authors(f, n)),
        note: 'Turbine-only strategy diagnostic. Same complete ordered values; no cross-ORM winner claim.',
      });
  add({
    id: 'cold.first',
    group: 'cold',
    name: 'cold start, first query on a fresh client',
    cold: true,
    run: async (a) => (await a.find('users', { id: 1, take: 1, unique: true }))[0],
    expected: (f) => f.users[0],
    note: 'Fresh ORM client and pool each sample; SELECT 1 establishes one connection untimed. Only first actual user read timed. mariadb transport is distinct.',
  });
  for (const mode of ['rows', 'batches', 'keyset'] as const)
    add({
      id: `stream.${mode}`,
      group: 'stream',
      name: `stream parity, 50K comments [${mode}]`,
      stream: true,
      run: (a, _i, observe) => a.stream(mode, observe),
      unsupported:
        mode === 'keyset'
          ? {}
          : {
              Raw: 'Raw keyset arm appears in stream.keyset; no ORM row/batch iterator API.',
              Drizzle: 'Native comparable keyset arm appears in stream.keyset.',
              'Drizzle RC': 'Native comparable keyset arm appears in stream.keyset.',
              'Prisma 7': 'Native comparable keyset arm appears in stream.keyset.',
            },
      note: 'Every ordered comment and all five columns observed by untimed preflight. Native Turbine rows/batches and independent keyset arms differ in query count, backpressure and snapshot behavior.',
    });
  add({
    id: 'stream.parity',
    group: 'stream',
    name: 'stream, iterate 50K comments (batch 1000), rows/batches/keyset',
    stream: true,
    run: (a, _i, observe) => a.stream('rows', observe),
    note: 'Original interleaved stream-parity table: Turbine rows, Turbine batches, identical Turbine batches#2 negative control, and each competitor keyset arm. All values are checked before timing. Static-result equivalence only.',
  });
  add({
    id: 'stream.native',
    group: 'stream',
    name: 'stream, native iterator equivalents, 50K comments',
    stream: true,
    unsupported: {
      'Prisma 7':
        'Prisma 7.10.1 has no native async row iterator; its native id-keyset equivalent remains stream.keyset.',
    },
    run: (a, _i, observe) => a.stream('native', observe),
    note: 'Turbine native row API, raw mysql2 text query.stream(), Drizzle stable and RC select.iterator(). Protocol and checkout release/discard behavior differ; no snapshot-equivalence claim.',
  });
  add({
    id: 'deep.text',
    group: 'deep',
    name: 'deep pagination, raw mysql2 text-protocol control',
    unsupported: {
      Turbine: 'Explicit raw driver text/binary control, not a Turbine default API.',
      Drizzle: 'Native Drizzle text path is already deep.offset.',
      'Drizzle RC': 'Native RC text path is already deep.offset.',
      'Prisma 7': 'adapter-mariadb binary transport is distinct.',
    },
    run: async (a) => a.deepText!(),
    expected: () => [],
    note: 'Same native MySQL SQL/filter/order/empty page as deep.offset Raw binary execute; query() is text, execute() uses cached server preparation. No PostgreSQL generic-plan inference.',
  });
  add({
    id: 'deep.offset',
    group: 'deep',
    name: 'deep pagination, original offset 9000',
    run: (a) => a.find('posts', { orgId: 1, published: true, newest: true, take: 20, skip: 9000 }),
    expected: () => [],
    note: 'Native MySQL offset equivalent, original empty result retained. PostgreSQL named/unnamed generic-plan and forceCustomPlan controls are not applicable to MySQL.',
  });
  for (const [id, name, run, expected] of [
    [
      'unique',
      'findUnique by PK',
      async (a: Adapter) => (await a.find('users', { id: 1, take: 1, unique: true }))[0],
      (f: Fixture) => f.users[0],
    ],
    [
      'l2',
      'L2, 50 users + posts',
      (a: Adapter) => a.find('users', { take: 50, relation: 'posts' }),
      (f: Fixture) => nestedUsers(f, 50),
    ],
    ['dashboard', 'dashboard, 5 independent queries', (a: Adapter) => a.dashboard(false), dashboardExpected],
  ] as const)
    add({
      id: `latency.${id}`,
      group: 'latency',
      name,
      run,
      expected,
      note: 'Applicable via an owned TCP delay proxy at RTTS=0,1,5,25. Every arm uses that proxy including the 0ms baseline. Five-read dashboard is independent pool reads; MySQL has no native PG pipeline.',
    });
  for (const strategy of ['join', 'batched', 'auto'])
    add({
      id: `latency.l2-${strategy}`,
      group: 'latency',
      name: `L2, 50 users + posts [Turbine ${strategy}]`,
      strategy: true,
      unsupported: {
        Raw: 'Turbine-specific selector; raw baseline is latency.l2.',
        Drizzle: 'Native strategy baseline is latency.l2.',
        'Drizzle RC': 'Native RC strategy baseline is latency.l2.',
        'Prisma 7': 'Native Prisma strategy baseline is latency.l2.',
      },
      run: (a) => a.find('users', { take: 50, relation: 'posts', strategy }),
      expected: (f) => nestedUsers(f, 50),
      note: 'Explicit native Turbine relation selector at each proxy RTT, with the same full ordered values as latency.l2. The MySQL implementation may choose the same effective plan for several selectors.',
    });
  return out;
}
