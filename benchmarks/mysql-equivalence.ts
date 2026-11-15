/** Independent flat mysql2 oracle and omission-sensitive exact checks. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import { assertExact, canonical, exactInteger } from './equivalence.js';
import { bind, COUNTS, FIXTURE_TIME } from './mysql-comparison-config.js';
export type Row = Record<string, unknown>;
const aliases: Record<string, string> = {
  org_id: 'orgId',
  user_id: 'userId',
  post_id: 'postId',
  tag_id: 'tagId',
  view_count: 'viewCount',
  avatar_url: 'avatarUrl',
  last_login_at: 'lastLoginAt',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
};
const ints = new Set([
  'id',
  'orgId',
  'userId',
  'postId',
  'tagId',
  'viewCount',
  'amount',
  'count',
  ...Array.from({ length: 10 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`),
]);
const bool = (key: string) => key === 'published' || key === 'active' || /^b0[1-5]$/.test(key);
export function decodeRaw(value: unknown): Row[] {
  assert.ok(Array.isArray(value), 'raw SELECT must return rows');
  return value.map((row: Row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, v]) => {
        const mapped = aliases[key] ?? key;
        if (v !== null && ints.has(mapped)) {
          const n = Number(exactInteger(v));
          assert.ok(Number.isSafeInteger(n), `unsafe raw integer ${mapped}`);
          return [mapped, n];
        }
        if (v !== null && bool(mapped)) {
          assert.ok(v === 0 || v === 1 || v === true || v === false, `invalid raw boolean ${mapped}`);
          return [mapped, v === 1 || v === true];
        }
        return [mapped, v];
      }),
    ),
  );
}
function exactShape(value: unknown, key?: string): unknown {
  if (value === null) return null;
  if (key && ints.has(key)) return exactInteger(value);
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((v) => exactShape(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, exactShape(v, k)]));
  return value;
}
export function assertMysqlExact(label: string, actual: unknown, expected: unknown) {
  assertExact(label, exactShape(actual), exactShape(expected));
}
export const resultHash = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(exactShape(value))))
    .digest('hex');
export interface Fixture {
  organizations: Row[];
  users: Row[];
  posts: Row[];
  comments: Row[];
  tags: Row[];
  post_tags: Row[];
  bench_wide: Row[];
  bench_writes: Row[];
}
export async function readMysqlFixture(pool: Pool): Promise<Fixture> {
  const fixture: Row = {};
  for (const [table, n] of Object.entries(COUNTS)) {
    const [rows] = await pool.execute(
      `SELECT * FROM \`${table}\` ORDER BY ${table === 'post_tags' ? 'post_id,tag_id' : 'id'}`,
    );
    const decoded = decodeRaw(rows);
    assert.equal(decoded.length, n, `SEED MISMATCH ${table}: original fixture volume required`);
    fixture[table] = decoded;
  }
  const f = fixture as unknown as Fixture;
  // Identity, null and tie preconditions are checked independently from ORM output.
  for (const [i, u] of f.users.entries())
    assertMysqlExact(`fixture user ${i + 1}`, u, {
      id: i + 1,
      orgId: (i % 5) + 1,
      email: `user${i + 1}@bench.example.com`,
      name: `User ${i + 1}`,
      role: (i + 1) % 10 === 0 ? 'admin' : (i + 1) % 5 === 0 ? 'editor' : 'member',
      avatarUrl: null,
      lastLoginAt: null,
      createdAt: FIXTURE_TIME,
    });
  for (const [i, p] of f.posts.entries()) {
    const u = Math.floor(i / 10) + 1,
      j = (i % 10) + 1;
    assertMysqlExact(`fixture post ${i + 1}`, p, {
      id: i + 1,
      userId: u,
      orgId: ((u - 1) % 5) + 1,
      title: `Post ${j} from user ${u}`,
      content: `Content body for post ${j} by user ${u}. Lorem ipsum dolor sit amet consectetur.`,
      published: j % 3 !== 0,
      viewCount: (j * 17) % 500,
      createdAt: FIXTURE_TIME,
      updatedAt: FIXTURE_TIME,
    });
  }
  for (const [i, c] of f.comments.entries()) {
    const p = Math.floor(i / 5) + 1,
      j = (i % 5) + 1;
    assertMysqlExact(`fixture comment ${i + 1}`, c, {
      id: i + 1,
      postId: p,
      userId: ((p + j - 1) % 1000) + 1,
      body: `Comment ${j} on post ${p}. Great article, thanks for sharing!`,
      createdAt: FIXTURE_TIME,
    });
  }
  const organizations = [
    ['Acme Inc', 'acme', 'enterprise'],
    ['Beta LLC', 'beta', 'pro'],
    ['Gamma Co', 'gamma', 'pro'],
    ['Delta Corp', 'delta', 'free'],
    ['Epsilon Studios', 'epsilon', 'free'],
  ];
  for (const [i, o] of f.organizations.entries())
    assertMysqlExact(`fixture organization ${i + 1}`, o, {
      id: i + 1,
      name: organizations[i]![0],
      slug: organizations[i]![1],
      plan: organizations[i]![2],
      createdAt: FIXTURE_TIME,
    });
  for (const [i, t] of f.tags.entries())
    assertMysqlExact(`fixture tag ${i + 1}`, t, { id: i + 1, name: `Tag ${i + 1}`, slug: `tag-${i + 1}` });
  for (let p = 1; p <= 10000; p++) {
    const ids = [0, 17, 31].map((off) => (((p % 50) + off) % 50) + 1).sort((a, b) => a - b);
    assertMysqlExact(
      `fixture junction ${p}`,
      f.post_tags.slice((p - 1) * 3, p * 3),
      ids.map((tagId) => ({ postId: p, tagId })),
    );
  }
  for (const [j, row] of f.bench_wide.entries()) {
    const i = j + 1;
    const expected: Row = { id: i };
    for (let k = 0; k < 20; k++) expected[`t${String(k + 1).padStart(2, '0')}`] = `row ${i} text value ${k + 1}`;
    for (let k = 0; k < 10; k++) expected[`n${String(k + 1).padStart(2, '0')}`] = (i * (k + 3)) % 10000;
    for (let k = 0; k < 5; k++) expected[`b${String(k + 1).padStart(2, '0')}`] = (i + k) % 2 === 0;
    for (let k = 0; k < 3; k++)
      expected[`d${String(k + 1).padStart(2, '0')}`] = new Date(1700000000000 + i * (k + 1) * 1000);
    assertMysqlExact(`fixture wide ${i}`, row, expected);
  }
  return f;
}
export function nestedUsers(f: Fixture, n: number, postLimit?: number, comments = false, id?: number) {
  return f.users
    .filter((u) => id === undefined || u.id === id)
    .slice(0, n)
    .map((u) => ({
      ...u,
      posts: f.posts
        .filter((p) => p.userId === u.id)
        .slice(0, postLimit)
        .map((p) => (comments ? { ...p, comments: f.comments.filter((c) => c.postId === p.id) } : p)),
    }));
}
export function authors(f: Fixture, n: number) {
  return f.posts.slice(0, n).map((p) => ({ ...p, user: f.users.find((u) => u.id === p.userId) ?? null }));
}
export function dashboardExpected(f: Fixture) {
  return [
    f.users[0],
    10,
    f.comments.filter((c) => c.userId === 1).length,
    f.posts
      .filter((p) => p.userId === 1)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 5),
    f.users.length,
  ];
}
export function incrementExpected(f: Fixture) {
  return f.posts.map((p) => (p.id === 1 ? { ...p, viewCount: Number(p.viewCount) + 1 } : p));
}
export async function postsNow(pool: Pool) {
  return decodeRaw((await pool.execute('SELECT * FROM posts ORDER BY id'))[0]);
}
export async function scratchNow(pool: Pool) {
  return decodeRaw((await pool.execute('SELECT * FROM bench_writes ORDER BY id'))[0]);
}
export async function restorePosts(pool: Pool, f: Fixture) {
  const after = await postsNow(pool);
  assert.equal(after.length, f.posts.length, 'post count corrupted; refusing to conceal fixture loss');
  for (let i = 0; i < after.length; i++)
    if (resultHash(after[i]) !== resultHash(f.posts[i])) {
      const p = f.posts[i]!;
      await pool.execute(
        'UPDATE posts SET user_id=?,org_id=?,title=?,content=?,published=?,view_count=?,created_at=?,updated_at=? WHERE id=?',
        bind([p.userId, p.orgId, p.title, p.content, p.published, p.viewCount, p.createdAt, p.updatedAt, p.id]),
      );
    }
  assertMysqlExact('restored posts', await postsNow(pool), f.posts);
}
/** Each fault starts with a known-good native value, then changes one obligation. */
export function correctnessControls(f: Fixture) {
  const passed: string[] = [];
  const reject = (name: string, fn: () => void) => {
    assert.throws(fn, /mismatch|unsafe|Unsafe|Expected/);
    passed.push(name);
  };
  assertMysqlExact('positive full user', f.users[0], f.users[0]);
  reject('changed scalar', () => assertMysqlExact('scalar', { ...f.users[0], name: 'changed' }, f.users[0]));
  reject('missing nullable column', () => {
    const { avatarUrl, ...row } = f.users[0]!;
    assertMysqlExact('missing', row, f.users[0]);
  });
  const recent = dashboardExpected(f)[3] as Row[];
  reject('wrong tie ordering', () => assertMysqlExact('order', [...recent].reverse(), recent));
  reject('dropped stream tail', () => assertMysqlExact('stream', f.comments.slice(0, -1), f.comments));
  reject('duplicate stream row', () => assertMysqlExact('stream', [...f.comments, f.comments[0]], f.comments));
  reject('unchanged write effect', () => assertMysqlExact('effect', f.posts, incrementExpected(f)));
  reject('wrong write target', () =>
    assertMysqlExact(
      'effect',
      f.posts.map((p) => (p.id === 2 ? { ...p, viewCount: Number(p.viewCount) + 1 } : p)),
      incrementExpected(f),
    ),
  );
  reject('rounded bigint', () => assertMysqlExact('bigint', { id: 9007199254740992 }, { id: '9007199254740993' }));
  return passed;
}
