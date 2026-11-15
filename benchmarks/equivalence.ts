/** Exact, ordered benchmark checks. No ORM's result is used as the oracle. */
import { isDeepStrictEqual } from 'node:util';
import type { Arm, InterleaveOptions } from './bench-harness.js';

export type Row = Record<string, unknown>;
export interface SqlOracle {
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
export interface HeadlineScenario {
  scenario: string;
  arms: Arm[];
  options?: InterleaveOptions;
}

/** Only declared integer columns accept driver-specific integer spellings. */
const integerFields = new Set(['id', 'orgId', 'userId', 'postId', 'viewCount']);
const aliases: Record<string, string> = {
  org_id: 'orgId',
  user_id: 'userId',
  post_id: 'postId',
  view_count: 'viewCount',
  avatar_url: 'avatarUrl',
  last_login_at: 'lastLoginAt',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
};

export function exactInteger(value: unknown): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`Unsafe integer in benchmark result: ${value}`);
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value).toString();
  throw new Error(`Expected an exact integer, got ${String(value)}`);
}

/** Preserve array order, missing keys, nulls, text, decimals and every integer bit. */
export function canonical(value: unknown, field?: string): unknown {
  if (value === null) return null;
  if (field && integerFields.has(field)) return { integer: exactInteger(value) };
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error('Invalid Date in benchmark result');
    return { date: value.toISOString() };
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite benchmark number');
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (Array.isArray(value)) return value.map((v) => canonical(v));
  if (value && typeof value === 'object') {
    const out = Object.create(null) as Row;
    for (const [key, cell] of Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) {
      const mapped = Object.hasOwn(aliases, key) ? aliases[key]! : key;
      if (Object.hasOwn(out, mapped)) throw new Error(`Duplicate benchmark field: ${mapped}`);
      out[mapped] = canonical(cell, mapped);
    }
    return out;
  }
  return value;
}

function difference(actual: unknown, expected: unknown, path = '$'): string | undefined {
  if (isDeepStrictEqual(actual, expected)) return undefined;
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    if (Array.isArray(actual) !== Array.isArray(expected)) return path;
    const a = actual as Row;
    const e = expected as Row;
    if (!isDeepStrictEqual(Object.keys(a).sort(), Object.keys(e).sort())) return `${path} (keys/length)`;
    for (const key of Object.keys(e)) {
      const mismatch = difference(a[key], e[key], `${path}.${key}`);
      if (mismatch) return mismatch;
    }
  }
  return path;
}

export function assertExact(label: string, actual: unknown, expected: unknown): void {
  const mismatch = difference(canonical(actual), canonical(expected));
  if (mismatch) throw new Error(`${label}: exact result mismatch at ${mismatch}`);
}

function rows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Array.isArray((value as Row).rows)) return (value as Row).rows as unknown[];
  throw new Error('Expected benchmark rows');
}

function one(value: unknown): unknown {
  if (Array.isArray(value) || (value && typeof value === 'object' && Array.isArray((value as Row).rows))) {
    const result = rows(value);
    if (result.length !== 1) throw new Error(`Expected one benchmark row, got ${result.length}`);
    return result[0];
  }
  return value;
}

export function countValue(value: unknown): string {
  if (Array.isArray(value) || (value && typeof value === 'object')) {
    const row = one(value) as Row;
    const keys = Object.keys(row);
    if (keys.length !== 1) throw new Error('Expected one count column');
    return exactInteger(row[keys[0]!]);
  }
  return exactInteger(value);
}

export function dashboardValue(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length !== 5) throw new Error('Expected five dashboard results');
  return [one(value[0]), countValue(value[1]), countValue(value[2]), rows(value[3]), countValue(value[4])];
}

export const headlineNames = [
  'findMany, 100 users (flat)',
  'findMany, 50 users + posts (L2)',
  'findMany, 10 users -> posts -> comments (L3)',
  'findUnique, single user by PK',
  'findUnique, user + posts + comments (L3)',
  'count, all users',
  'stream, iterate 50K comments (batch 1000)',
  'atomic increment, posts.view_count + 1',
  'pipeline, 5-query dashboard batch',
  'transaction, 5-query dashboard batch',
  'hot findUnique, rotating IDs',
] as const;

/** Flat driver SELECTs plus independent in-memory relation assembly, no JSON/compiler reuse. */
export async function readFixture(db: SqlOracle) {
  const users = (await db.query('SELECT * FROM users ORDER BY id ASC')).rows;
  const posts = (await db.query('SELECT * FROM posts ORDER BY id ASC')).rows;
  const comments = (await db.query('SELECT * FROM comments ORDER BY id ASC')).rows;
  if (users.length !== 1000 || posts.length !== 10000 || comments.length !== 50000) {
    throw new Error(`SEED MISMATCH: expected 1000/10000/50000, got ${users.length}/${posts.length}/${comments.length}`);
  }
  if (!users.some((u) => exactInteger(u.id) === '1') || !posts.some((p) => exactInteger(p.id) === '1')) {
    throw new Error('SEED MISMATCH: user/post id 1 must exist');
  }
  return { users, posts, comments };
}

type Fixture = Awaited<ReturnType<typeof readFixture>>;
const cell = (r: Row, camel: string, snake: string) => r[camel] ?? r[snake];
const belongs = (r: Row, camel: string, snake: string, id: unknown) =>
  exactInteger(cell(r, camel, snake)) === exactInteger(id);

export function expectedHeadline(name: string, fixture: Fixture, i: number): unknown {
  const { users, posts, comments } = fixture;
  const nested = (limit: number, postLimit?: number, withComments = false, selected = users) =>
    selected.slice(0, limit).map((u) => ({
      ...u,
      posts: posts
        .filter((p) => belongs(p, 'userId', 'user_id', u.id))
        .slice(0, postLimit)
        .map((p) =>
          withComments ? { ...p, comments: comments.filter((c) => belongs(c, 'postId', 'post_id', p.id)) } : p,
        ),
    }));
  switch (name) {
    case headlineNames[0]:
      return users.slice(0, 100);
    case headlineNames[1]:
      return nested(50);
    case headlineNames[2]:
      return nested(10, 5, true);
    case headlineNames[3]:
      return users.find((u) => exactInteger(u.id) === '1');
    case headlineNames[4]: {
      const user = nested(
        1,
        undefined,
        true,
        users.filter((u) => exactInteger(u.id) === '1'),
      )[0];
      return user;
    }
    case headlineNames[5]:
      return String(users.length);
    case headlineNames[6]:
      return comments;
    case headlineNames[8]:
    case headlineNames[9]: {
      const recent = posts
        .filter((p) => belongs(p, 'userId', 'user_id', 1))
        .sort((a, b) => {
          const time = (r: Row) => (cell(r, 'createdAt', 'created_at') as Date).getTime();
          const byTime = time(b) - time(a);
          if (byTime) return byTime;
          const ai = BigInt(exactInteger(a.id));
          const bi = BigInt(exactInteger(b.id));
          return ai === bi ? 0 : ai > bi ? -1 : 1;
        })
        .slice(0, 5);
      return [
        users.find((u) => exactInteger(u.id) === '1'),
        String(posts.filter((p) => belongs(p, 'userId', 'user_id', 1)).length),
        String(comments.filter((c) => belongs(c, 'userId', 'user_id', 1)).length),
        recent,
        String(users.length),
      ];
    }
    case headlineNames[10]:
      return users.find((u) => exactInteger(u.id) === String((i % 50) + 1));
    default:
      throw new Error(`No independent oracle for scenario: ${name}`);
  }
}

/** Check all columns of all posts; a successful return is not proof a write happened. */
export function assertIncrementEffect(label: string, before: Row[], after: Row[]): void {
  if (!before.length || !before.some((p) => exactInteger(p.id) === '1'))
    throw new Error('Increment oracle needs post id 1');
  const expected = before.map((p) => {
    if (exactInteger(p.id) !== '1') return p;
    const key = Object.hasOwn(p, 'view_count') ? 'view_count' : 'viewCount';
    return { ...p, [key]: BigInt(exactInteger(p[key])) + 1n };
  });
  assertExact(`${label} write effect`, after, expected);
}

/** Every selected arm is checked before the first warmup, drift probe or timing. */
export async function verifyHeadline(scenarios: HeadlineScenario[], db: SqlOracle): Promise<void> {
  if (
    scenarios.length !== headlineNames.length ||
    new Set(scenarios.map((s) => s.scenario)).size !== headlineNames.length ||
    headlineNames.some((name) => !scenarios.some((s) => s.scenario === name))
  ) {
    throw new Error('Headline preflight must cover every scenario exactly once');
  }
  const optional = ['Drizzle RC', 'Drizzle RC (no jit)'].filter((name) =>
    scenarios.some((s) => s.arms.some((a) => a.name === name)),
  );
  for (const scenario of scenarios) {
    const needsRaw = ![headlineNames[2], headlineNames[4]].includes(
      scenario.scenario as (typeof headlineNames)[2] | (typeof headlineNames)[4],
    );
    const expected = ['Turbine', 'Prisma 7', 'Drizzle', ...(needsRaw ? ['Raw'] : []), ...optional];
    const actual = scenario.arms.map((a) => a.name);
    if (
      actual.length !== expected.length ||
      new Set(actual).size !== actual.length ||
      expected.some((name) => !actual.includes(name))
    ) {
      throw new Error(`Incomplete arm coverage for ${scenario.scenario}: expected ${expected.join(', ')}`);
    }
  }
  const fixture = await readFixture(db);
  for (const scenario of scenarios) {
    if (!scenario.arms.length) throw new Error(`No arms in ${scenario.scenario}`);
    for (const arm of scenario.arms) {
      // The rotating-id call's entire 50-shape cycle is part of its contract.
      const inputs = scenario.scenario === headlineNames[10] ? Array.from({ length: 50 }, (_, i) => i) : [0];
      for (const i of inputs) {
        const label = `${scenario.scenario} / ${arm.name} [${i}]`;
        if (scenario.scenario === headlineNames[7]) {
          const before = (await db.query('SELECT * FROM posts ORDER BY id ASC')).rows;
          try {
            const result = await arm.fn(i);
            const after = (await db.query('SELECT * FROM posts ORDER BY id ASC')).rows;
            assertIncrementEffect(label, before, after);
            const expected = after.find((p) => exactInteger(p.id) === '1');
            assertExact(`${label} returning`, one(result), expected);
          } finally {
            // Restore the counter even when the arm changed the wrong post.
            // Other column corruption intentionally fails the run; do not conceal it.
            await db.query(
              'UPDATE posts SET view_count = restored.value FROM unnest($1::bigint[], $2::int[]) AS restored(id, value) WHERE posts.id = restored.id',
              [before.map((p) => p.id), before.map((p) => cell(p, 'viewCount', 'view_count'))],
            );
          }
        } else if (scenario.scenario === headlineNames[6]) {
          let n = 0;
          const result = await arm.fn(i, (row) => {
            if (n >= fixture.comments.length) throw new Error(`${label}: extra streamed row ${n}`);
            assertExact(`${label} streamed row ${n}`, row, fixture.comments[n]);
            n++;
          });
          assertExact(`${label} drained count`, exactInteger(result), String(fixture.comments.length));
          assertExact(`${label} observed count`, n, fixture.comments.length);
        } else {
          const value = await arm.fn(i);
          const expected = expectedHeadline(scenario.scenario, fixture, i);
          const actual = scenario.scenario.includes('dashboard')
            ? dashboardValue(value)
            : scenario.scenario === headlineNames[5]
              ? countValue(value)
              : scenario.scenario.includes('findUnique')
                ? one(value)
                : rows(value);
          assertExact(label, actual, expected);
        }
      }
    }
    console.log(`[exact preflight] ${scenario.scenario}: ${scenario.arms.map((a) => a.name).join(', ')} OK`);
  }
}
