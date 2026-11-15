/** Independent ordered expectations for the complete extended operation catalog. */

import type { Arm, InterleaveOptions } from './bench-harness.js';
import type { Row, SqlOracle } from './equivalence.js';
import { assertExact, exactInteger } from './equivalence.js';

export const EXTENDED_SEMANTICS = 'extended-exact-ordered-v1';
export const extendedGroups = ['large', 'list', 'relations', 'agg', 'writes', 'strategy', 'cold'] as const;
export type ExtendedGroup = (typeof extendedGroups)[number];
export const extendedCatalog = [
  { id: 'comments-5000', group: 'large', scenario: 'findMany, 5,000 comments (flat)' },
  { id: 'comments-50000', group: 'large', scenario: 'findMany, 50,000 comments (flat)' },
  { id: 'wide-1000', group: 'large', scenario: 'findMany, 1,000 rows x 39 columns (wide)' },
  { id: 'list-page3', group: 'list', scenario: 'list, published posts in org 1, newest first (page 3)' },
  { id: 'list-deep', group: 'list', scenario: 'list, published posts in org 1, newest first (deep offset)' },
  { id: 'to-one', group: 'relations', scenario: 'to-one, 500 posts + author' },
  { id: 'many-to-many', group: 'relations', scenario: 'many-to-many, 200 posts + tags through a junction' },
  { id: 'relation-count', group: 'relations', scenario: 'relation _count, 100 users + their post count' },
  { id: 'relation-filter', group: 'relations', scenario: 'relation filter, 100 users having a published post' },
  { id: 'group-by', group: 'agg', scenario: 'groupBy org, count + avg views, having count > 100' },
  { id: 'create-many', group: 'writes', scenario: 'createMany, 1,000 rows' },
  { id: 'update', group: 'writes', scenario: 'update by primary key' },
  { id: 'upsert', group: 'writes', scenario: 'upsert on a unique column (update path)' },
  { id: 'delete', group: 'writes', scenario: 'delete by unique column' },
  { id: 'strategy-many', group: 'strategy', scenario: 'strategy (to-many), 200 users + posts' },
  { id: 'strategy-one', group: 'strategy', scenario: 'strategy (to-one), 500 posts + author' },
  { id: 'cold-user', group: 'cold', scenario: 'cold start, first query on a fresh client' },
] as const;
export type ExtendedId = (typeof extendedCatalog)[number]['id'];
export const commonArms = ['Turbine', 'Prisma 7', 'Drizzle', 'Drizzle RC', 'Raw'] as const;
export function requiredArms(id: ExtendedId): string[] {
  if (id.startsWith('strategy-'))
    return [
      'Turbine join',
      'Turbine batched',
      'Turbine auto',
      ...(id === 'strategy-one' ? ['Turbine flatten'] : []),
      'Prisma 7 join',
      'Prisma 7 query',
      'Drizzle',
      'Drizzle RC',
      'Raw',
    ];
  return [...commonArms, ...(id === 'list-deep' ? ['Turbine +fCP'] : [])];
}
export function preparedPolicy(id: ExtendedId, name: string): string {
  if (!name.startsWith('Turbine')) return 'unnamed-native-default';
  if (name === 'Turbine +fCP') return 'unnamed-forceCustomPlan';
  if (id === 'create-many') return 'unnamed-variable-arity';
  return 'named-fixed-arity; variable-arity batched child statements remain unnamed';
}
export interface ExtendedArm extends Arm {
  /** Cold query duration excludes connection establishment and client/pool disposal. */
  cold?: () => Promise<{ value: unknown; ms: number }>;
}
export interface ExtendedScenario {
  id: ExtendedId;
  scenario: string;
  arms: ExtendedArm[];
  options?: InterleaveOptions;
}

export function assertExtendedCatalog(scenarios: ExtendedScenario[], groups: readonly string[]): void {
  if (
    !groups.length ||
    new Set(groups).size !== groups.length ||
    groups.some((g) => !extendedGroups.includes(g as ExtendedGroup))
  )
    throw new Error('Expected nonempty, unique, known extended groups');
  const expected = extendedCatalog.filter((s) => groups.includes(s.group));
  if (
    scenarios.length !== expected.length ||
    new Set(scenarios.map((s) => s.id)).size !== expected.length ||
    expected.some((s) => !scenarios.some((a) => a.id === s.id && a.scenario === s.scenario))
  )
    throw new Error('Extended preflight must cover every selected catalog row exactly once');
  for (const s of scenarios) {
    const want = requiredArms(s.id);
    const got = s.arms.map((a) => a.name);
    if (got.length !== want.length || new Set(got).size !== got.length || want.some((a) => !got.includes(a)))
      throw new Error(`Incomplete extended arm coverage for ${s.id}: expected ${want.join(', ')}`);
    if (s.id === 'cold-user' && s.arms.some((a) => !a.cold)) throw new Error('Every cold arm must use a fresh client');
    if (isWrite(s.id) && s.arms.some((a) => !a.setup)) throw new Error('Every write arm needs untimed preparation');
  }
}

export const fixtureCounts = {
  organizations: 5,
  users: 1000,
  posts: 10000,
  comments: 50000,
  tags: 50,
  post_tags: 30000,
  bench_wide: 2000,
} as const;
export type ExtendedFixture = Record<keyof typeof fixtureCounts, Row[]>;
const orderQueries = {
  organizations: 'SELECT * FROM organizations ORDER BY id',
  users: 'SELECT * FROM users ORDER BY id',
  posts: 'SELECT * FROM posts ORDER BY id',
  comments: 'SELECT * FROM comments ORDER BY id',
  tags: 'SELECT * FROM tags ORDER BY id',
  post_tags: 'SELECT * FROM post_tags ORDER BY post_id, tag_id',
  bench_wide: 'SELECT * FROM bench_wide ORDER BY id',
} as const;
export async function readExtendedFixture(db: SqlOracle): Promise<ExtendedFixture> {
  const fixture = {} as ExtendedFixture;
  for (const table of Object.keys(fixtureCounts) as (keyof ExtendedFixture)[]) {
    const rows = (await db.query(orderQueries[table])).rows;
    if (rows.length !== fixtureCounts[table])
      throw new Error(`SEED MISMATCH: ${table}: expected ${fixtureCounts[table]}, got ${rows.length}`);
    fixture[table] = rows;
    const keys = rows.map((r) =>
      table === 'post_tags' ? `${exactInteger(r.post_id)}/${exactInteger(r.tag_id)}` : exactInteger(r.id),
    );
    if (new Set(keys).size !== rows.length) throw new Error(`Duplicate fixture identity: ${table}`);
  }
  if (!fixture.users.some((u) => exactInteger(u.id) === '1')) throw new Error('Fixture requires user id 1');
  return fixture;
}
const cell = (r: Row, camel: string, snake: string) => (Object.hasOwn(r, camel) ? r[camel] : r[snake]);
const same = (a: unknown, b: unknown) => exactInteger(a) === exactInteger(b);
const byId = (a: Row, b: Row) => {
  const x = BigInt(exactInteger(a.id)),
    y = BigInt(exactInteger(b.id));
  return x === y ? 0 : x < y ? -1 : 1;
};

/** Decimal spellings compare as exact reduced fractions, with no parseFloat/rounding tolerance. */
export function fraction(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) throw new Error('Zero denominator');
  let a = numerator < 0n ? -numerator : numerator,
    b = denominator < 0n ? -denominator : denominator;
  while (b) [a, b] = [b, a % b];
  const sign = denominator < 0n ? -1n : 1n;
  return `${(numerator / a) * sign}/${(denominator / a) * sign}`;
}
export function exactDecimal(value: unknown): string {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Nonfinite average');
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Expected decimal average');
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!m) throw new Error(`Invalid decimal average: ${String(value)}`);
  const scale = (m[3]?.length ?? 0) - Number(m[4] ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 1000) throw new Error('Decimal exponent out of bounds');
  const n = BigInt(`${m[1]}${m[2]}${m[3] ?? ''}`);
  return scale >= 0 ? fraction(n, 10n ** BigInt(scale)) : fraction(n * 10n ** BigInt(-scale), 1n);
}

/** Extend the shared exact-value conventions only for additional declared fields. */
function extendedValue(value: unknown, field?: string): unknown {
  if (value === null || value instanceof Date) return value;
  if (field === 'tagId' || field === 'tag_id' || field === 'postCount' || field === 'c')
    return { exact: exactInteger(value) };
  if (Array.isArray(value)) return value.map((v) => extendedValue(v));
  if (value && typeof value === 'object') {
    const result: Row = {};
    for (const [key, v] of Object.entries(value)) {
      const name = key === 'tag_id' ? 'tagId' : key;
      if (Object.hasOwn(result, name)) throw new Error(`Duplicate extended field: ${name}`);
      result[name] = extendedValue(v, name);
    }
    return result;
  }
  return value;
}
export function assertExtendedExact(label: string, actual: unknown, expected: unknown): void {
  assertExact(label, extendedValue(actual), extendedValue(expected));
}
export function resultRows(value: unknown): Row[] {
  if (Array.isArray(value)) return value as Row[];
  if (value && typeof value === 'object' && Array.isArray((value as Row).rows)) return (value as { rows: Row[] }).rows;
  throw new Error('Expected complete extended rows');
}
export function resultOne(value: unknown): Row {
  if (Array.isArray(value) || (value && typeof value === 'object' && Array.isArray((value as Row).rows))) {
    const rows = resultRows(value);
    if (rows.length !== 1) throw new Error(`Expected exactly one returning row, got ${rows.length}`);
    return rows[0]!;
  }
  if (!value || typeof value !== 'object') throw new Error('Expected one complete row');
  return value as Row;
}
export function sortedReturning(value: unknown): Row[] {
  return [...resultRows(value)].sort(byId);
}

export function expectedExtended(id: ExtendedId, fixture: ExtendedFixture): unknown {
  const { users, posts, comments, tags } = fixture;
  const postUser = (p: Row) => cell(p, 'userId', 'user_id');
  const author = () =>
    posts.slice(0, 500).map((p) => ({ ...p, user: users.find((u) => same(u.id, postUser(p))) ?? null }));
  switch (id) {
    case 'comments-5000':
      return comments.slice(0, 5000);
    case 'comments-50000':
      return comments;
    case 'wide-1000':
      return fixture.bench_wide.slice(0, 1000);
    case 'list-page3':
    case 'list-deep':
      return posts
        .filter((p) => same(cell(p, 'orgId', 'org_id'), 1) && p.published === true)
        .sort(
          (a, b) =>
            (cell(b, 'createdAt', 'created_at') as Date).getTime() -
              (cell(a, 'createdAt', 'created_at') as Date).getTime() || -byId(a, b),
        )
        .slice(id === 'list-page3' ? 40 : 9000, (id === 'list-page3' ? 40 : 9000) + 20);
    case 'to-one':
    case 'strategy-one':
      return author();
    case 'many-to-many':
      return posts.slice(0, 200).map((p) => ({
        ...p,
        tags: fixture.post_tags
          .filter((j) => same(cell(j, 'postId', 'post_id'), p.id))
          .map((j) => {
            const tag = tags.find((t) => same(t.id, cell(j, 'tagId', 'tag_id')));
            if (!tag) throw new Error('Orphan tag');
            return tag;
          })
          .sort(byId),
      }));
    case 'relation-count':
      return users
        .slice(0, 100)
        .map((u) => ({ ...u, _count: { posts: String(posts.filter((p) => same(postUser(p), u.id)).length) } }));
    case 'relation-filter':
      return users.filter((u) => posts.some((p) => same(postUser(p), u.id) && p.published === true)).slice(0, 100);
    case 'strategy-many':
      return users.slice(0, 200).map((u) => ({ ...u, posts: posts.filter((p) => same(postUser(p), u.id)) }));
    case 'cold-user':
      return users.find((u) => same(u.id, 1));
    case 'group-by': {
      const groups = new Map<string, { count: bigint; sum: bigint }>();
      for (const p of posts) {
        const key = exactInteger(cell(p, 'orgId', 'org_id'));
        const g = groups.get(key) ?? { count: 0n, sum: 0n };
        g.count++;
        g.sum += BigInt(exactInteger(cell(p, 'viewCount', 'view_count')));
        groups.set(key, g);
      }
      return [...groups]
        .sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0))
        .filter(([, g]) => g.count > 100n)
        .map(([orgId, g]) => ({ orgId, c: g.count.toString(), avgViews: fraction(g.sum, g.count) }));
    }
    default:
      throw new Error(`Write expectations require an independently seeded scratch state: ${id}`);
  }
}

export function countRows(value: unknown): Row[] {
  return resultRows(value).map((row) => {
    const { postCount, ...rest } = row;
    return { ...rest, _count: { posts: exactInteger(postCount) } };
  });
}
export function nativeCounts(value: unknown): Row[] {
  return resultRows(value).map((row) => {
    const count = row._count as Row;
    if (!count || Object.keys(count).join(',') !== 'posts') throw new Error('Expected only posts in relation _count');
    return { ...row, _count: { posts: exactInteger(count.posts) } };
  });
}
export function aggregateRows(value: unknown, native: boolean): Row[] {
  return resultRows(value).map((row) => {
    const keys = Object.keys(row).sort().join(',');
    if (keys !== (native ? '_avg,_count,orgId' : 'avgViews,c,orgId'))
      throw new Error(`Unexpected groupBy projection: ${keys}`);
    if (native && Object.keys(row._avg as Row).join(',') !== 'viewCount') throw new Error('Expected viewCount average');
    return {
      orgId: row.orgId,
      c: exactInteger(native ? row._count : row.c),
      avgViews: exactDecimal(native ? (row._avg as Row).viewCount : row.avgViews),
    };
  });
}
export function flattenTags(value: unknown): Row[] {
  return resultRows(value).map((p) => {
    const { postTags, ...rest } = p;
    if (!Array.isArray(postTags)) throw new Error('Missing explicit junction collection');
    return {
      ...rest,
      tags: postTags.map((j: Row) => {
        if (Object.keys(j).sort().join(',') !== 'postId,tag,tagId') throw new Error('Unexpected junction projection');
        const tag = j.tag as Row;
        if (!tag || !same(tag.id, j.tagId) || !same(j.postId, p.id)) throw new Error('Incorrect junction identity');
        return tag;
      }),
    };
  });
}

export const writeTime = new Date('2023-11-14T22:13:20.000Z');
export const bulkRows = Array.from({ length: 1000 }, (_, i) => ({
  orgId: (i % 5) + 1,
  slug: `bulk-${i}`,
  label: `Bulk row ${i}`,
  amount: i % 997,
  active: true,
  createdAt: writeTime,
}));
export function isWrite(id: ExtendedId): boolean {
  return ['create-many', 'update', 'upsert', 'delete'].includes(id);
}
export const scratchQuery = 'SELECT * FROM bench_writes ORDER BY id';
export async function prepareWrite(db: SqlOracle, id: ExtendedId): Promise<void> {
  if (!isWrite(id)) throw new Error(`Not a write: ${id}`);
  await db.query('TRUNCATE bench_writes RESTART IDENTITY');
  if (id !== 'create-many')
    await db.query(
      `INSERT INTO bench_writes (org_id, slug, label, amount, active, created_at)
     SELECT 1, s, s, -777, true, $2::timestamptz FROM unnest($1::text[]) s`,
      [[`${id}-target`, 'sentinel-a', 'sentinel-b'], writeTime],
    );
}
export function expectedWrite(id: ExtendedId, before: Row[], i: number): { returning: unknown; after: Row[] } {
  if (id === 'create-many') {
    if (before.length) throw new Error('Bulk insert requires an empty scratch table');
    const after = bulkRows.map((r, n) => ({ id: String(n + 1), ...r }));
    return { returning: after, after };
  }
  if (
    before.length !== 3 ||
    !same(before[0]!.id, 1) ||
    before[0]!.slug !== `${id}-target` ||
    before[0]!.amount !== -777 ||
    before[1]!.slug !== 'sentinel-a' ||
    before[2]!.slug !== 'sentinel-b'
  )
    throw new Error('Missing nontrivial write prerequisite');
  const row = before[0]!;
  if (id === 'delete') return { returning: row, after: before.slice(1) };
  if (id !== 'update' && id !== 'upsert') throw new Error(`Not a write: ${id}`);
  const updated = { ...row, amount: i };
  return { returning: updated, after: [updated, ...before.slice(1)] };
}
export async function verifyWrite(
  db: SqlOracle,
  id: ExtendedId,
  label: string,
  before: Row[],
  i: number,
  value: unknown,
): Promise<void> {
  const expected = expectedWrite(id, before, i);
  assertExtendedExact(
    `${label} returning`,
    id === 'create-many' ? resultRows(value) : resultOne(value),
    expected.returning,
  );
  assertExtendedExact(`${label} actual write effect`, (await db.query(scratchQuery)).rows, expected.after);
}

export interface ExtendedPreflight {
  status: 'passed';
  cases: number;
  scenarios: number;
  groups: readonly string[];
  fixtureCounts: typeof fixtureCounts;
}
function assertReadPrerequisite(id: ExtendedId, value: unknown): void {
  const lengths: Partial<Record<ExtendedId, number>> = {
    'comments-5000': 5000,
    'comments-50000': 50000,
    'wide-1000': 1000,
    'list-page3': 20,
    'list-deep': 0,
    'to-one': 500,
    'many-to-many': 200,
    'relation-count': 100,
    'relation-filter': 100,
    'group-by': 5,
    'strategy-many': 200,
    'strategy-one': 500,
  };
  if (id === 'cold-user') {
    if (!value) throw new Error('Missing cold-query prerequisite');
    return;
  }
  if (!Array.isArray(value) || value.length !== lengths[id])
    throw new Error(`SEED MISMATCH: nontrivial expected result size for ${id}`);
  if (id === 'to-one' || id === 'strategy-one') {
    if (value.some((p: Row) => !p.user)) throw new Error('SEED MISMATCH: missing author');
  }
  if (id === 'many-to-many' && value.some((p: Row) => !Array.isArray(p.tags) || p.tags.length !== 3))
    throw new Error('SEED MISMATCH: expected three tags per selected post');
  if (id === 'strategy-many' && value.some((u: Row) => !Array.isArray(u.posts) || u.posts.length !== 10))
    throw new Error('SEED MISMATCH: expected ten posts per selected user');
}
export async function verifyExtended(
  scenarios: ExtendedScenario[],
  groups: readonly string[],
  db: SqlOracle,
): Promise<ExtendedPreflight> {
  assertExtendedCatalog(scenarios, groups);
  const fixture = await readExtendedFixture(db);
  const scratch = (await db.query(scratchQuery)).rows;
  if (scratch.length) throw new Error('Extended suite requires an empty, disposable bench_writes table');
  const sequence = (await db.query('SELECT last_value, is_called FROM bench_writes_id_seq')).rows;
  let cases = 0;
  const errors: unknown[] = [];
  try {
    for (const s of scenarios) {
      const expected = isWrite(s.id) ? undefined : expectedExtended(s.id, fixture);
      if (!isWrite(s.id)) assertReadPrerequisite(s.id, expected);
      for (const arm of s.arms) {
        for (const i of isWrite(s.id) ? [0, 3] : [0]) {
          const label = `${s.id} / ${arm.name} [${i}]`;
          if (arm.setup) await arm.setup(i);
          const before = isWrite(s.id) ? (await db.query(scratchQuery)).rows : [];
          const value = await arm.fn(i);
          if (isWrite(s.id)) await verifyWrite(db, s.id, label, before, i, value);
          else assertExtendedExact(label, s.id === 'cold-user' ? resultOne(value) : resultRows(value), expected);
          cases++;
        }
      }
      console.log(`[extended exact preflight] ${s.id}: ${s.arms.map((a) => a.name).join(', ')} OK`);
    }
    assertExtendedExact(
      'Extended preflight preserves every read fixture value',
      await readExtendedFixture(db),
      fixture,
    );
  } catch (e) {
    errors.push(e);
  }
  try {
    await db.query('TRUNCATE bench_writes RESTART IDENTITY');
    await db.query("SELECT setval('bench_writes_id_seq', $1::bigint, $2::boolean)", [
      sequence[0]!.last_value,
      sequence[0]!.is_called,
    ]);
    assertExtendedExact('Preflight scratch restoration', (await db.query(scratchQuery)).rows, scratch);
    assertExtendedExact(
      'Preflight sequence restoration',
      (await db.query('SELECT last_value, is_called FROM bench_writes_id_seq')).rows,
      sequence,
    );
  } catch (e) {
    errors.push(e);
  }
  if (errors.length) throw new AggregateError(errors, 'Extended exact preflight or restoration failed');
  return { status: 'passed', cases, scenarios: scenarios.length, groups, fixtureCounts };
}

export const EXTENDED_BOUNDARIES = 'pg-extended-unsupported-v1';
export const extendedUnsupported = [
  { name: 'Turbine flatten', reason: 'Flatten supports to-one; to-many has no native flatten plan.' },
] as const;
