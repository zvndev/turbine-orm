/**
 * Differential fuzz: the join and batched relation strategies are one query
 * surface, not two.
 *
 * The 0.64.0 bug class motivating this: the two strategies disagreed about
 * whether a query was VALID (a select typo threw under batched and was
 * silently dropped under join), and `relationLoadStrategy: 'auto'` picks
 * between them on index coverage and table size, so the same program threw or
 * returned `[{}]` depending on the shape of production data. A hand-written
 * regression test pins the one shape that was caught; this suite draws random
 * query args from a seeded PRNG and asserts the general property on each:
 *
 *   1. ACCEPTANCE AGREEMENT: both strategies accept the args, or both throw
 *      with the same error code. A divergence here means 'auto' changes a
 *      query's validity based on data, which is the 0.64.0 class.
 *   2. RESULT EQUALITY: when both accept, the rows are deeply equal. The
 *      batched loader documents its output as equal to the join plan.
 *
 * Runs on the in-memory sqlite engine (same fixture family as sqlite.test.ts)
 * so it lives in the unit lane: no container, deterministic, a few hundred
 * cases in well under a second. Determinism rules the generator must keep:
 * every generated query has a total order (a PK tiebreaker is always
 * appended, top level and relation level), because without one "which rows"
 * and "which N children" are legitimately unspecified and a mismatch would be
 * noise, not a bug.
 *
 * Reproduction: every assertion message carries the seed, case index, and the
 * full args JSON. Re-run a failure with:
 *   TURBINE_FUZZ_SEED=<seed> TURBINE_FUZZ_CASES=<cases> npx tsx --test src/test/strategy-fuzz.test.ts
 * The nightly workflow runs a date-derived seed so the explored space moves;
 * the default seeds below keep the unit lane stable.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, it as nodeIt } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';

// Same probe as sqlite.test.ts: load on Node < 22.5, skip cleanly.
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const it: typeof nodeIt = DatabaseSync
  ? nodeIt
  : (((name: string) =>
      nodeIt(name, { skip: 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof nodeIt);

// ---------------------------------------------------------------------------
// Fixture: the sqlite.test.ts schema with a programmatic, deliberately skewed
// seed. Skew matters for a differential suite: empty relations, shared
// children, one user with most of the posts, NULLs, and duplicate titles are
// where stitching bugs live, not in uniform data.
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE organizations (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free'
);
CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL REFERENCES organizations(id),
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'member',
  avatar_url TEXT
);
CREATE INDEX idx_users_org_id ON users(org_id);
CREATE TABLE posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  org_id     INTEGER NOT NULL REFERENCES organizations(id),
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  published  INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE TABLE comments (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id INTEGER NOT NULL REFERENCES posts(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  body    TEXT NOT NULL
);
CREATE INDEX idx_comments_post_id ON comments(post_id);
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE post_tags (
  post_id INTEGER NOT NULL REFERENCES posts(id),
  tag_id  INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (post_id, tag_id)
);
`;

function seedDatabase(db: DatabaseSyncType): void {
  const ROLES = ['admin', 'editor', 'member', 'member', 'member'];
  const insert = (sql: string) => db.exec(sql);
  insert(`INSERT INTO organizations (id, name, plan) VALUES
    (1, 'Acme', 'enterprise'), (2, 'Beta', 'pro'), (3, 'Empty Org', 'free');`);
  // 30 users; org 3 gets none, user 7 has no avatar and no posts.
  for (let u = 1; u <= 30; u++) {
    const org = (u % 2) + 1;
    const avatar = u % 7 === 0 ? 'NULL' : `'https://a/${u}.png'`;
    insert(`INSERT INTO users (id, org_id, email, name, role, avatar_url) VALUES
      (${u}, ${org}, 'user${u}@example.com', 'User ${u}', '${ROLES[u % 5]}', ${avatar});`);
  }
  // ~100 posts, heavily skewed: user 1 owns every 3rd post, users with u % 7
  // === 0 own none. Duplicate titles on purpose (sort ties need tiebreakers).
  let postId = 0;
  for (let p = 1; p <= 100; p++) {
    const owner = p % 3 === 0 ? 1 : ((p * 7) % 30) + 1;
    if (owner % 7 === 0) continue;
    postId += 1;
    const title = p % 4 === 0 ? 'Duplicate Title' : `Post ${p}`;
    insert(`INSERT INTO posts (id, user_id, org_id, title, content, published, view_count) VALUES
      (${postId}, ${owner}, ${(owner % 2) + 1}, '${title}', 'Body of post ${p}', ${p % 2}, ${(p * 13) % 500});`);
  }
  // ~200 comments; every 5th post has none.
  let commentId = 0;
  for (let c = 1; c <= 250; c++) {
    const post = ((c * 11) % postId) + 1;
    if (post % 5 === 0) continue;
    commentId += 1;
    insert(`INSERT INTO comments (id, post_id, user_id, body) VALUES
      (${commentId}, ${post}, ${(c % 30) + 1}, 'Comment ${c}');`);
  }
  insert(`INSERT INTO tags (id, name) VALUES (1, 'tech'), (2, 'news'), (3, 'draft'), (4, 'rare');`);
  // Tag every 2nd/3rd post; tag 4 tags only post 1; many posts untagged.
  for (let p = 1; p <= postId; p++) {
    if (p % 2 === 0) insert(`INSERT INTO post_tags (post_id, tag_id) VALUES (${p}, 1);`);
    if (p % 3 === 0) insert(`INSERT INTO post_tags (post_id, tag_id) VALUES (${p}, 2);`);
  }
  insert('INSERT INTO post_tags (post_id, tag_id) VALUES (1, 4);');
}

// ---------------------------------------------------------------------------
// Seeded generator (same mulberry32 as sql-safety-fuzz.test.ts).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!;
}

function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}

type FieldKind = 'int' | 'string' | 'nullableString';

interface TableModel {
  name: string;
  fields: Record<string, FieldKind>;
  /** relation name -> target table model key; kept to what BOTH strategies support. */
  relations: Record<string, string>;
}

const MODELS: Record<string, TableModel> = {
  users: {
    name: 'users',
    fields: { id: 'int', orgId: 'int', email: 'string', name: 'string', role: 'string', avatarUrl: 'nullableString' },
    relations: { posts: 'posts', comments: 'comments' },
  },
  posts: {
    name: 'posts',
    fields: {
      id: 'int',
      userId: 'int',
      orgId: 'int',
      title: 'string',
      content: 'string',
      published: 'int',
      viewCount: 'int',
    },
    relations: { user: 'users', comments: 'comments', tags: 'tags' },
  },
  comments: {
    name: 'comments',
    fields: { id: 'int', postId: 'int', userId: 'int', body: 'string' },
    relations: { user: 'users', post: 'posts' },
  },
  tags: {
    name: 'tags',
    fields: { id: 'int', name: 'string' },
    relations: {},
  },
};

const STRING_POOL = ['User 3', 'Post 8', 'Duplicate Title', 'admin', 'member', 'tech', 'Comment', 'nope%_', "O'Brien"];

function randomValue(rng: () => number, kind: FieldKind): number | string | null {
  if (kind === 'int') return Math.floor(rng() * 60);
  if (kind === 'nullableString' && chance(rng, 0.3)) return null;
  return pick(rng, STRING_POOL);
}

function randomFieldFilter(rng: () => number, kind: FieldKind): unknown {
  const value = randomValue(rng, kind);
  if (value === null) return null; // null equality / IS NULL path
  const numericOps = ['equals', 'not', 'gt', 'gte', 'lt', 'lte', 'in', 'notIn'] as const;
  const stringOps = ['equals', 'not', 'contains', 'startsWith', 'endsWith', 'in'] as const;
  const op = kind === 'int' ? pick(rng, numericOps) : pick(rng, stringOps);
  if (op === 'equals' && chance(rng, 0.5)) return value; // bare scalar form
  if (op === 'in' || op === 'notIn') {
    const extra = randomValue(rng, kind === 'nullableString' ? 'string' : kind);
    return { [op]: [value, extra].filter((v) => v !== null) };
  }
  const filter: Record<string, unknown> = { [op]: value };
  if (kind !== 'int' && chance(rng, 0.25)) filter.mode = 'insensitive';
  return filter;
}

function randomWhere(rng: () => number, model: TableModel, depth: number): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const fields = Object.keys(model.fields);
  const n = 1 + Math.floor(rng() * 2);
  for (let i = 0; i < n; i++) {
    const field = pick(rng, fields);
    where[field] = randomFieldFilter(rng, model.fields[field]!);
  }
  if (depth < 2 && chance(rng, 0.25)) {
    const combinator = pick(rng, ['OR', 'AND', 'NOT'] as const);
    if (combinator === 'NOT') where.NOT = randomWhere(rng, model, depth + 1);
    else where[combinator] = [randomWhere(rng, model, depth + 1), randomWhere(rng, model, depth + 1)];
  }
  // Relation filters (some/none/every) compile into the BASE query on both
  // strategies, but they are part of the acceptance surface, so keep them in.
  if (depth < 2 && chance(rng, 0.15)) {
    const relNames = Object.keys(model.relations);
    if (relNames.length > 0) {
      const rel = pick(rng, relNames);
      const target = MODELS[model.relations[rel]!]!;
      where[rel] = { [pick(rng, ['some', 'none', 'every'] as const)]: randomWhere(rng, target, depth + 1) };
    }
  }
  return where;
}

/** Always totally ordered: a random key first, the PK as final tiebreaker. */
function randomOrderBy(rng: () => number, model: TableModel): Array<Record<string, 'asc' | 'desc'>> {
  const orderBy: Array<Record<string, 'asc' | 'desc'>> = [];
  if (chance(rng, 0.7)) orderBy.push({ [pick(rng, Object.keys(model.fields))]: pick(rng, ['asc', 'desc'] as const) });
  orderBy.push({ id: 'asc' });
  return orderBy;
}

/**
 * `refused` marks a projection the 0.65 shape rules reject (E003). These stay
 * in the domain so the fuzz proves every strategy refuses them identically:
 * the review of the 0.65 fix found the first generator never produced them,
 * which is how a presence-vs-truthy refusal mismatch between the strategies
 * survived the suite. The flag is threaded up to generateCase so a case never
 * carries BOTH a refused shape and a planted name corruption: with two
 * independent faults the strategies legitimately surface different FIRST
 * errors (join compiles relations depth-first, batched resolves all names
 * before any load), so code parity is only asserted per isolated fault.
 */
function randomProjection(
  rng: () => number,
  model: TableModel,
): { projection: { select?: object; omit?: object }; refused: boolean } {
  const fields = Object.keys(model.fields);
  if (chance(rng, 0.06)) {
    const shape = pick(rng, ['pair', 'emptySelect', 'allFalseSelect'] as const);
    if (shape === 'pair') {
      return { projection: { select: { id: true }, omit: { [pick(rng, fields)]: true } }, refused: true };
    }
    if (shape === 'emptySelect') return { projection: { select: {} }, refused: true };
    return { projection: { select: { [pick(rng, fields)]: false } }, refused: true };
  }
  if (chance(rng, 0.3)) {
    const keep = fields.filter(() => chance(rng, 0.5));
    if (keep.length === 0) keep.push('id');
    return { projection: { select: Object.fromEntries(keep.map((f) => [f, true])) }, refused: false };
  }
  if (chance(rng, 0.2)) {
    return { projection: { omit: { [pick(rng, fields)]: true } }, refused: false };
  }
  return { projection: {}, refused: false };
}

function randomWith(
  rng: () => number,
  model: TableModel,
  depth: number,
): { withClause: Record<string, unknown> | undefined; refused: boolean } {
  const relNames = Object.keys(model.relations);
  if (relNames.length === 0) return { withClause: undefined, refused: false };
  const withClause: Record<string, unknown> = {};
  let refused = false;
  for (const rel of relNames) {
    if (!chance(rng, depth === 0 ? 0.6 : 0.3)) continue;
    const target = MODELS[model.relations[rel]!]!;
    if (chance(rng, 0.3)) {
      withClause[rel] = true;
      continue;
    }
    const options: Record<string, unknown> = {};
    if (chance(rng, 0.4)) options.where = randomWhere(rng, target, depth + 1);
    const limited = chance(rng, 0.4);
    if (limited) options.limit = 1 + Math.floor(rng() * 4);
    // A limited relation MUST be totally ordered or "which N children" is
    // unspecified and a strategy mismatch would be noise. Unlimited relations
    // get the tiebreaker too, for the same reason at the whole-list level.
    options.orderBy = randomOrderBy(rng, target);
    const proj = randomProjection(rng, target);
    refused = refused || proj.refused;
    Object.assign(options, proj.projection);
    if (depth < 2) {
      const nested = randomWith(rng, target, depth + 1);
      refused = refused || nested.refused;
      if (nested.withClause && Object.keys(nested.withClause).length > 0) options.with = nested.withClause;
    }
    withClause[rel] = options;
  }
  return { withClause: Object.keys(withClause).length > 0 ? withClause : undefined, refused };
}

/**
 * With ~15% probability, plant one invalid name somewhere and record it. Both
 * strategies must refuse the query (this is the 0.64.0 acceptance property).
 */
function maybeCorrupt(rng: () => number, args: Record<string, unknown>): boolean {
  if (!chance(rng, 0.15)) return false;
  const bogus = pick(rng, ['titel', 'naem', 'view_countt', 'doesNotExist'] as const);
  const site = pick(rng, ['select', 'omit', 'where', 'orderBy', 'relationSelect'] as const);
  if (site === 'select') args.select = { id: true, [bogus]: true };
  else if (site === 'omit') args.omit = { [bogus]: true };
  else if (site === 'where') args.where = { ...(args.where as object), [bogus]: 1 };
  else if (site === 'orderBy') args.orderBy = [{ [bogus]: 'asc' }, { id: 'asc' }];
  else {
    // Bury the typo one level down, inside a relation's select: exactly where
    // the join strategy used to silently drop it while batched threw.
    const withClause = (args.with as Record<string, unknown> | undefined) ?? {};
    withClause.posts = { select: { id: true, [bogus]: true }, orderBy: [{ id: 'asc' }] };
    args.with = withClause;
  }
  return true;
}

function generateCase(rng: () => number): { table: string; args: Record<string, unknown>; corrupted: boolean } {
  const table = pick(rng, ['users', 'posts', 'comments'] as const);
  const model = MODELS[table]!;
  const args: Record<string, unknown> = {
    orderBy: randomOrderBy(rng, model),
  };
  if (chance(rng, 0.6)) args.where = randomWhere(rng, model, 0);
  // Sometimes force a where that matches NOTHING: zero base rows is the shape
  // whose validation the batched path used to skip entirely, so the empty
  // case must stay in the explored domain by construction, not by luck.
  if (chance(rng, 0.08)) args.where = { id: { gt: 1_000_000 } };
  if (chance(rng, 0.5)) args.limit = 1 + Math.floor(rng() * 10);
  if (chance(rng, 0.3)) args.offset = Math.floor(rng() * 6);
  const proj = randomProjection(rng, model);
  Object.assign(args, proj.projection);
  // Root tables are chosen so `with` is always available; corruption may add one.
  const nested = randomWith(rng, model, 0);
  if (nested.withClause) args.with = nested.withClause;
  // Never plant a name corruption on a case that already carries a refused
  // projection shape: two independent faults surface different FIRST errors
  // per strategy (see randomProjection's comment), and the code-parity
  // assertion is a per-fault contract, not a first-fault-ordering one.
  const corrupted = proj.refused || nested.refused ? false : maybeCorrupt(rng, args);
  return { table, args, corrupted };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const envSeed = process.env.TURBINE_FUZZ_SEED;
const SEEDS: readonly number[] = envSeed ? [Number(envSeed) >>> 0] : [7, 1042, 0x5eed];
const CASES_PER_SEED = process.env.TURBINE_FUZZ_CASES ? Number(process.env.TURBINE_FUZZ_CASES) : 150;

let db: DatabaseSyncType;
let schema: SchemaMetadata;
let client: TurbineClient;

beforeEach(() => {
  if (!DatabaseSync) return;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  seedDatabase(db);
  schema = introspectSqliteDatabase(db);
  client = turbineSqlite(db, schema);
});

afterEach(async () => {
  if (!DatabaseSync) return;
  await client.disconnect();
});

type Outcome = { ok: true; rows: unknown[] } | { ok: false; code: string; message: string };

async function runWith(
  table: string,
  args: Record<string, unknown>,
  strategy: 'join' | 'batched' | 'auto',
): Promise<Outcome> {
  try {
    const rows = await client.table(table).findMany({ ...args, relationLoadStrategy: strategy } as never);
    return { ok: true, rows };
  } catch (err) {
    if (err instanceof TurbineError) return { ok: false, code: err.code, message: err.message };
    throw err; // a non-Turbine error is a bug regardless of agreement
  }
}

describe('strategy differential fuzz (join vs batched vs auto)', () => {
  it('the fixture has the skew the generator assumes', async () => {
    // Precondition, so a silent seed change cannot hollow out the suite: there
    // must be parents with EMPTY relations and parents with many children.
    if (!DatabaseSync) return;
    const rows = (await client.table('users').findMany({
      with: { posts: true },
      orderBy: { id: 'asc' },
    } as never)) as Array<{ posts: unknown[] }>;
    const counts = rows.map((r) => r.posts.length);
    assert.ok(
      counts.some((c) => c === 0),
      'no user with zero posts; empty-relation stitching is untested',
    );
    assert.ok(
      counts.some((c) => c >= 10),
      'no user with many posts; skewed stitching is untested',
    );
  });

  for (const seed of SEEDS) {
    it(`seed ${seed}: acceptance agreement + deep result equality over ${CASES_PER_SEED} cases`, async () => {
      if (!DatabaseSync) return;
      const rng = mulberry32(seed);
      let planted = 0;
      let rejected = 0;
      for (let i = 0; i < CASES_PER_SEED; i++) {
        const testCase = generateCase(rng);
        if (testCase.corrupted) planted += 1;
        const repro = () =>
          `seed=${seed} case=${i} table=${testCase.table}\nTURBINE_FUZZ_SEED=${seed} TURBINE_FUZZ_CASES=${CASES_PER_SEED} npx tsx --test src/test/strategy-fuzz.test.ts\nargs=${JSON.stringify(testCase.args)}`;
        // 'auto' is the DEFAULT and has a third code path that is neither
        // endpoint (runAutoSplit: a partial with on the join plan, the rest
        // batched), so it is compared as a first-class participant.
        const join = await runWith(testCase.table, testCase.args, 'join');
        const batched = await runWith(testCase.table, testCase.args, 'batched');
        const auto = await runWith(testCase.table, testCase.args, 'auto');

        // 1. Acceptance agreement, the 0.64.0 property, across all three.
        for (const [name, other] of [
          ['batched', batched],
          ['auto', auto],
        ] as const) {
          assert.equal(
            join.ok,
            other.ok,
            `strategies disagree about validity (join ${join.ok ? 'accepted' : 'threw'}, ${name} ${
              other.ok ? 'accepted' : 'threw'
            }): ${repro()}\n${join.ok ? '' : `join: ${(join as { message: string }).message}\n`}${
              other.ok ? '' : `${name}: ${(other as { message: string }).message}`
            }`,
          );
          if (!join.ok && !other.ok) {
            assert.equal(join.code, other.code, `join and ${name} threw different codes: ${repro()}`);
          }
        }

        if (!join.ok) {
          rejected += 1;
          continue;
        }

        // 2. A corrupted query must not be accepted.
        if (testCase.corrupted) {
          assert.fail(`every strategy ACCEPTED a query with a planted invalid name: ${repro()}`);
        }

        // 3. Deep result equality (order is pinned by the generated
        // tiebreakers). The casts are sound: assertion 1 proved batched/auto
        // agree with join, and join.ok is true here.
        assert.deepEqual(
          (batched as { rows: unknown[] }).rows,
          join.rows,
          `result mismatch join vs batched: ${repro()}`,
        );
        assert.deepEqual((auto as { rows: unknown[] }).rows, join.rows, `result mismatch join vs auto: ${repro()}`);
      }
      // Preconditions on the run itself, so the suite cannot go quietly
      // vacuous: corruption must actually be planted, some cases must be
      // rejected (each planted corruption must be, by assertion 2), and some
      // must be accepted so the equality half runs.
      assert.ok(planted > 0, `seed ${seed}: the generator planted no corruption; assertion 2 never ran`);
      assert.ok(
        rejected >= planted,
        `seed ${seed}: fewer rejections (${rejected}) than planted corruptions (${planted})`,
      );
      assert.ok(rejected < CASES_PER_SEED, `seed ${seed}: every case was rejected; the equality half never ran`);
    });
  }
});
