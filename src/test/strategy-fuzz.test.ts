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
 * ...AND A SECOND ARM ON POSTGRESQL, because the sqlite arm alone has a blind
 * spot that shipped a bug. The batched loader's per-parent `limit` pushdown
 * (`ROW_NUMBER() OVER (PARTITION BY fk …)`) is gated on
 * `dialect.name === 'postgresql'`, so on sqlite the generator's limited
 * relations exercise the client-side slice and nothing else, and the pushdown
 * went out changing which rows a DEFAULT-strategy query returned. The PG arm
 * (gated on DATABASE_URL, read-only against the seeded fixture) therefore
 * generates limited relations with and WITHOUT a total order, and asserts the
 * property the sqlite arm cannot express: a relation whose ordering leaves
 * ties is never rewritten, because with ties the two plans are each free to
 * keep different rows. See `partitionOrderBy` in query/batched-loader.ts.
 *
 * ...AND A THIRD AND FOURTH ARM ON THE JSON WIRE ENCODING, which is a second
 * axis of exactly the same kind. `jsonEncoding` decides whether a relation row
 * is emitted as `json_build_object('id', …)` or as a key-less
 * `json_build_array(…)` decoded by position client-side, and `'positional'` is
 * the PostgreSQL DEFAULT. Two encodings of one query surface, so they owe the
 * same two properties the strategies do, and the failure mode is worse: a
 * mis-served template is not an error, it is a positional array handed to a
 * parser expecting keyed objects, which returns WRONG ROWS silently. The
 * dedicated tests in json-encoding-positional.test.ts pin chosen shapes; these
 * arms draw the shapes from the same seeded PRNG the strategy arms use.
 *
 *   ARM 3 reuses the seeded fixture and the strategy generator, and interleaves
 *   the two encodings on ONE client so the SQL-template cache is under test
 *   alongside the encoders.
 *   ARM 4 exists because the seeded fixture answers only ONE of the questions.
 *   Its only column type from JSON_WIRE_COERCION_OIDS (the set whose JSON
 *   rendering does not match the driver's, so the builder bakes `::text` casts
 *   into the expressions) is `int8`. Positional drops the KEYS and passes each
 *   expression through verbatim, so fidelity should be preserved for all of
 *   them, and arm 4 is where that is proved rather than asserted: its own DDL
 *   carries every type in that set, and a precondition test fails if any of
 *   them stops being represented.
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
import pgDriver from 'pg';
import { TurbineClient } from '../client.js';
import { TurbineError } from '../errors.js';
import { introspect } from '../introspect.js';
import { JSON_WIRE_COERCION_OIDS } from '../query/utils.js';
import { camelToSnake, type SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

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

/**
 * A THIRD AXIS, and the same "two paths must agree" shape as the other two: a
 * column has TWO legal spellings on every caller-facing argument, the camelCase
 * FIELD name and the snake_case COLUMN name the DDL declares. `resolveColumnName`
 * accepts both (`camelToSnake` is idempotent on an already-snake string), so
 * `userId` and `user_id` name one column and must produce one query.
 *
 * The class this closes: several sites tested `key in meta.columnMap`, which
 * knows only the FIELD spelling, and were therefore reachable-but-divergent
 * rather than simply wrong. The batched loader's per-parent limit pushdown
 * DECLINED on a snake-spelled orderBy (silently falling back to fetching every
 * child and slicing client-side), and its correlation-key projection matched
 * the caller's `select` / `omit` keys by raw string, which force-added and then
 * DELETED a column the caller had asked for. Both are invisible to a suite that
 * only ever writes the camelCase spelling, and both are exactly what the
 * acceptance-agreement and row-equality assertions below detect.
 *
 * The generator therefore spells each field name it emits either way, at
 * random. `camelToSnake` leaves single-word fields (`id`, `email`, `title`)
 * untouched, so the axis genuinely varies only on the multi-word ones
 * (`orgId`, `userId`, `viewCount`, `postId`, `avatarUrl`) - which are also the
 * relation correlation keys, i.e. precisely the columns the loader machinery
 * matches by name.
 */
function spell(rng: () => number, field: string): string {
  return chance(rng, 0.35) ? camelToSnake(field) : field;
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
    where[spell(rng, field)] = randomFieldFilter(rng, model.fields[field]!);
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
  if (chance(rng, 0.7)) {
    orderBy.push({ [spell(rng, pick(rng, Object.keys(model.fields)))]: pick(rng, ['asc', 'desc'] as const) });
  }
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
    return { projection: { select: Object.fromEntries(keep.map((f) => [spell(rng, f), true])) }, refused: false };
  }
  if (chance(rng, 0.2)) {
    return { projection: { omit: { [spell(rng, pick(rng, fields))]: true } }, refused: false };
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

type Outcome = { ok: true; rows: unknown[] } | { ok: false; code: string; message: string };

/** Run `args` on `target` under one strategy, normalizing a TurbineError into a value. */
async function runOn(
  target: TurbineClient,
  table: string,
  args: Record<string, unknown>,
  strategy: 'join' | 'batched' | 'auto',
): Promise<Outcome> {
  try {
    const rows = await target.table(table).findMany({ ...args, relationLoadStrategy: strategy } as never);
    return { ok: true, rows };
  } catch (err) {
    if (err instanceof TurbineError) return { ok: false, code: err.code, message: err.message };
    throw err; // a non-Turbine error is a bug regardless of agreement
  }
}

async function runWith(
  table: string,
  args: Record<string, unknown>,
  strategy: 'join' | 'batched' | 'auto',
): Promise<Outcome> {
  return runOn(client, table, args, strategy);
}

describe('strategy differential fuzz (join vs batched vs auto)', () => {
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

// ---------------------------------------------------------------------------
// PostgreSQL arm: the same differential, on the engine where the batched
// loader's per-parent `limit` is REWRITTEN rather than sliced client-side.
// ---------------------------------------------------------------------------

/**
 * The seeded fixture's tables, as the generator sees them.
 *
 * `sortFields` is deliberately restricted to columns that are part of NO
 * unique key, so whether a generated relation `orderBy` totally orders its
 * target is decided by ONE thing: whether the PK tiebreaker was appended. The
 * precondition test below re-derives that from the live metadata, so a fixture
 * change that adds a unique constraint fails loudly instead of quietly turning
 * every "non-total" case into a total one.
 */
interface PgModel {
  filterFields: Record<string, 'int' | 'string' | 'bool'>;
  sortFields: string[];
  /** relation name -> [target model, 'many' | 'one'] */
  relations: Record<string, [string, 'many' | 'one']>;
}

const PG_MODELS: Record<string, PgModel> = {
  organizations: {
    filterFields: { name: 'string', plan: 'string' },
    sortFields: ['name', 'plan', 'createdAt'],
    relations: { users: ['users', 'many'], posts: ['posts', 'many'] },
  },
  users: {
    filterFields: { name: 'string', role: 'string', orgId: 'int' },
    sortFields: ['name', 'role', 'orgId', 'lastLoginAt', 'createdAt'],
    relations: { posts: ['posts', 'many'], comments: ['comments', 'many'], organization: ['organizations', 'one'] },
  },
  posts: {
    filterFields: { title: 'string', published: 'bool', viewCount: 'int', userId: 'int' },
    sortFields: ['title', 'published', 'viewCount', 'userId', 'createdAt'],
    relations: { comments: ['comments', 'many'], user: ['users', 'one'], organization: ['organizations', 'one'] },
  },
  comments: {
    filterFields: { body: 'string', postId: 'int', userId: 'int' },
    sortFields: ['body', 'postId', 'userId', 'createdAt'],
    relations: { post: ['posts', 'one'], user: ['users', 'one'] },
  },
};

const PG_STRINGS = ['Alice Admin', 'member', 'admin', 'Hello World', 'Nice post!', 'pro', 'nope%_', "O'Brien"];

function pgWhere(rng: () => number, model: PgModel): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const fields = Object.keys(model.filterFields);
  const field = pick(rng, fields);
  const kind = model.filterFields[field]!;
  if (kind === 'bool') where[field] = chance(rng, 0.5);
  else if (kind === 'int') {
    const op = pick(rng, ['equals', 'gt', 'lt', 'in'] as const);
    const v = 1 + Math.floor(rng() * 8);
    where[field] = op === 'in' ? { in: [v, v + 1] } : op === 'equals' ? v : { [op]: v };
  } else {
    const op = pick(rng, ['equals', 'contains', 'startsWith', 'not'] as const);
    where[field] = { [op]: pick(rng, PG_STRINGS) };
  }
  return where;
}

/**
 * A relation `orderBy`, plus whether it TOTALLY orders the target. `total`
 * cases append the primary key; the rest deliberately stop at a column that
 * can repeat, which is the class the pushdown must decline.
 */
function pgOrderBy(rng: () => number, model: PgModel, total: boolean): Array<Record<string, unknown>> {
  const orderBy: Array<Record<string, unknown>> = [];
  const field = pick(rng, model.sortFields);
  const dir = pick(rng, ['asc', 'desc'] as const);
  // A third of the sorts spell the direction as `{ sort, nulls }`, which moves
  // rows across the limit boundary and so must survive into the window.
  orderBy.push(
    chance(rng, 0.33) ? { [field]: { sort: dir, nulls: pick(rng, ['first', 'last'] as const) } } : { [field]: dir },
  );
  if (total) orderBy.push({ id: 'asc' });
  return orderBy;
}

interface PgCase {
  table: string;
  args: Record<string, unknown>;
  /** Limited relations whose ordering is total, so the pushdown MAY rewrite them. */
  eligible: number;
  /** Limited relations whose ordering is not total, so it must not. */
  ineligible: number;
}

function pgWith(
  rng: () => number,
  model: PgModel,
  depth: number,
  tally: { eligible: number; ineligible: number },
): Record<string, unknown> | undefined {
  const withClause: Record<string, unknown> = {};
  for (const [rel, [targetName, cardinality]] of Object.entries(model.relations)) {
    if (!chance(rng, depth === 0 ? 0.55 : 0.3)) continue;
    const target = PG_MODELS[targetName]!;
    if (cardinality === 'one') {
      // To-one relations take no limit; include them for stitching coverage.
      withClause[rel] = chance(rng, 0.5) ? true : { where: pgWhere(rng, target) };
      continue;
    }
    const options: Record<string, unknown> = {};
    if (chance(rng, 0.3)) options.where = pgWhere(rng, target);
    // 55% limited, and of those roughly half are deliberately NOT totally
    // ordered: that is the population the pushdown has to refuse.
    const limited = chance(rng, 0.55);
    const total = !limited || chance(rng, 0.5);
    if (limited) {
      options.limit = 1 + Math.floor(rng() * 3);
      if (total) tally.eligible += 1;
      else tally.ineligible += 1;
    }
    options.orderBy = pgOrderBy(rng, target, total);
    if (chance(rng, 0.25))
      options.select = { id: true, ...(chance(rng, 0.5) ? { [pick(rng, target.sortFields)]: true } : {}) };
    if (depth < 1) {
      const nested = pgWith(rng, target, depth + 1, tally);
      if (nested) options.with = nested;
    }
    withClause[rel] = options;
  }
  return Object.keys(withClause).length > 0 ? withClause : undefined;
}

function pgCase(rng: () => number): PgCase {
  const table = pick(rng, ['organizations', 'users', 'posts'] as const);
  const model = PG_MODELS[table]!;
  const tally = { eligible: 0, ineligible: 0 };
  // The TOP-LEVEL query keeps a total order: this arm is about which CHILDREN
  // a relation limit keeps, and an unordered parent page would make the whole
  // comparison noise for a reason that has nothing to do with the pushdown.
  const args: Record<string, unknown> = { orderBy: [{ pick: 0 }] };
  args.orderBy = [{ [pick(rng, model.sortFields)]: pick(rng, ['asc', 'desc'] as const) }, { id: 'asc' }];
  if (chance(rng, 0.5)) args.where = pgWhere(rng, model);
  if (chance(rng, 0.4)) args.limit = 2 + Math.floor(rng() * 6);
  const withClause = pgWith(rng, model, 0, tally);
  if (withClause) args.with = withClause;
  return { table, args, eligible: tally.eligible, ineligible: tally.ineligible };
}

const PG_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!PG_URL, 'DATABASE_URL not set');
if (!PG_URL) {
  console.log('⚠ Skipping the PostgreSQL fuzz arm: DATABASE_URL not set');
}
const PG_CASES_PER_SEED = process.env.TURBINE_FUZZ_CASES ? Number(process.env.TURBINE_FUZZ_CASES) : 40;

describe('strategy differential fuzz on PostgreSQL (the per-parent limit pushdown)', () => {
  let pg: TurbineClient;
  let pgSchema: SchemaMetadata;
  let emitted: string[] = [];

  pgGate.before(async () => {
    pgSchema = await introspect({ connectionString: PG_URL! });
    pg = new TurbineClient({ connectionString: PG_URL!, poolSize: 5, warnOnUnlimited: false }, pgSchema);
    pg.$on('query', (e) => emitted.push(e.sql));
    await pg.connect();
  });

  pgGate.after(async () => {
    await pg.disconnect();
  });

  pgGate.it("the generator's sort columns are genuinely non-unique in the live schema", () => {
    // The whole arm rests on "no PK tiebreaker means ties are possible". If a
    // fixture change made one of these columns unique, the ineligible half of
    // the domain would silently become eligible and the invariant below would
    // stop testing anything.
    for (const [table, model] of Object.entries(PG_MODELS)) {
      const meta = pgSchema.tables[table];
      assert.ok(meta, `fixture is missing table "${table}"`);
      const uniqueSets = [meta.primaryKey, ...meta.uniqueColumns];
      for (const field of model.sortFields) {
        // Annotated: `assert.ok` is an assertion function, so leaving this to
        // inference makes the type depend on a flow node that reads it back.
        const column: string = meta.columnMap[field] ?? field;
        assert.ok(meta.allColumns.includes(column), `${table}.${field} is not a column any more`);
        for (const set of uniqueSets) {
          assert.notDeepEqual(set, [column], `${table}.${field} became a unique key; it can no longer produce ties`);
        }
      }
    }
  });

  for (const seed of SEEDS) {
    pgGate.it(`seed ${seed}: pushdown eligibility + equality over ${PG_CASES_PER_SEED} cases`, async () => {
      const rng = mulberry32(seed);
      let eligibleCases = 0;
      let ineligibleCases = 0;
      let wrappersSeen = 0;
      for (let i = 0; i < PG_CASES_PER_SEED; i++) {
        const testCase = pgCase(rng);
        const repro = () => `seed=${seed} case=${i} table=${testCase.table}\nargs=${JSON.stringify(testCase.args)}`;
        const join = await runOn(pg, testCase.table, testCase.args, 'join');

        for (const strategy of ['batched', 'auto'] as const) {
          emitted = [];
          const other = await runOn(pg, testCase.table, testCase.args, strategy);
          const wrappers = emitted.filter((s) => s.includes('ROW_NUMBER'));
          wrappersSeen += wrappers.length;

          // 1. ACCEPTANCE AGREEMENT, the 0.64.0 property.
          assert.equal(join.ok, other.ok, `join and ${strategy} disagree about validity: ${repro()}`);
          if (!join.ok && !other.ok) {
            assert.equal(join.code, other.code, `join and ${strategy} threw different codes: ${repro()}`);
          }

          // 2. THE ELIGIBILITY INVARIANT. One statement per limited relation
          // node at most (a chunked follow-up would add more, but the fixture
          // is far below MAX_RELATION_KEYS), so the count of rewritten
          // statements can never exceed the number of TOTALLY ORDERED limited
          // relations. Any excess is a relation whose ordering leaves ties
          // being rewritten, which is exactly the shape that made the two
          // plans return different children.
          assert.ok(
            wrappers.length <= testCase.eligible,
            `${strategy} rewrote ${wrappers.length} follow-up(s) but only ${testCase.eligible} relation(s) are ` +
              `totally ordered (${testCase.ineligible} are not): ${repro()}\n${wrappers.join('\n')}`,
          );

          // 3. RESULT EQUALITY, but only where the answer is determined: with
          // an ineligible limited relation in the tree, WHICH children the
          // limit keeps is not forced on EITHER plan, so a mismatch there
          // would be noise rather than a defect. Assertion 2 is what covers
          // that half of the domain.
          if (join.ok && other.ok && testCase.ineligible === 0) {
            assert.deepEqual(other.rows, join.rows, `result mismatch join vs ${strategy}: ${repro()}`);
          }
        }
        if (testCase.eligible > 0) eligibleCases += 1;
        if (testCase.ineligible > 0) ineligibleCases += 1;
      }
      // Vacuity guards, in the style of the sqlite arm: both halves of the
      // eligibility rule must actually have been exercised.
      assert.ok(ineligibleCases > 0, `seed ${seed}: no case carried a non-total limited relation; assertion 2 is idle`);
      assert.ok(eligibleCases > 0, `seed ${seed}: no case carried a totally-ordered limited relation`);
      assert.ok(wrappersSeen > 0, `seed ${seed}: the pushdown never engaged; the arm proves nothing about it`);
    });
  }
});

// ---------------------------------------------------------------------------
// ARM 3: the JSON wire encoding, over the SAME seeded random args.
//
// `jsonEncoding: 'object'` and `'positional'` are two renderings of one query
// surface, so they owe the same two properties the strategies do: they accept
// and reject the same args, and when both accept they return deeply equal rows.
//
// The two encodings are driven PER QUERY on ONE client, deliberately. A
// QueryInterface holds one SQL-template LRU keyed by query SHAPE, and the two
// encodings have the same shape: without the `|je=` cache-key segment the
// second call is served the first's statement and its rows are decoded by the
// wrong parser, which produces wrong values and no error at all. Interleaving
// them cold/cold/hot/hot on one client is what puts that under test.
// ---------------------------------------------------------------------------

type Encoding = 'object' | 'positional';

/** Run `args` under one encoding, normalizing a TurbineError into a value. */
async function runEncoded(
  target: TurbineClient,
  table: string,
  args: Record<string, unknown>,
  jsonEncoding: Encoding,
): Promise<Outcome> {
  try {
    const rows = await target.table(table).findMany({ ...args, relationLoadStrategy: 'join', jsonEncoding } as never);
    return { ok: true, rows };
  } catch (err) {
    if (err instanceof TurbineError) return { ok: false, code: err.code, message: err.message };
    throw err;
  }
}

describe('encoding differential fuzz on PostgreSQL (object vs positional)', () => {
  let pg2: TurbineClient;
  let emittedSql: string[] = [];

  pgGate.before(async () => {
    const s = await introspect({ connectionString: PG_URL! });
    pg2 = new TurbineClient({ connectionString: PG_URL!, poolSize: 5, warnOnUnlimited: false }, s);
    pg2.$on('query', (e) => emittedSql.push(e.sql));
    await pg2.connect();
  });

  pgGate.after(async () => {
    await pg2.disconnect();
  });

  for (const seed of SEEDS) {
    pgGate.it(
      `seed ${seed}: acceptance + deep row equality across encodings over ${PG_CASES_PER_SEED} cases`,
      async () => {
        const rng = mulberry32(seed);
        let withRelations = 0;
        let objectStatements = 0;
        let positionalStatements = 0;
        for (let i = 0; i < PG_CASES_PER_SEED; i++) {
          const testCase = pgCase(rng);
          const repro = () => `seed=${seed} case=${i} table=${testCase.table}\nargs=${JSON.stringify(testCase.args)}`;
          if (testCase.args.with) withRelations += 1;

          emittedSql = [];
          // Cold both ways, then HOT both ways in the reverse order: a warm entry
          // being handed to the other encoding is the failure this ordering hunts.
          const objCold = await runEncoded(pg2, testCase.table, testCase.args, 'object');
          const posCold = await runEncoded(pg2, testCase.table, testCase.args, 'positional');
          const posHot = await runEncoded(pg2, testCase.table, testCase.args, 'positional');
          const objHot = await runEncoded(pg2, testCase.table, testCase.args, 'object');

          // 1. ACCEPTANCE AGREEMENT.
          for (const [name, other] of [
            ['positional (cold)', posCold],
            ['positional (warm)', posHot],
            ['object (warm)', objHot],
          ] as const) {
            assert.equal(
              objCold.ok,
              other.ok,
              `encodings disagree about validity (object ${objCold.ok ? 'accepted' : 'threw'}, ${name} ${
                other.ok ? 'accepted' : 'threw'
              }): ${repro()}`,
            );
            if (!objCold.ok && !other.ok) {
              assert.equal(objCold.code, other.code, `object and ${name} threw different codes: ${repro()}`);
            }
          }

          if (!objCold.ok) continue;

          // 2. DEEP ROW EQUALITY, cold and warm, in both directions.
          assert.deepEqual((posCold as { rows: unknown[] }).rows, objCold.rows, `cold mismatch: ${repro()}`);
          assert.deepEqual((posHot as { rows: unknown[] }).rows, objCold.rows, `warm positional mismatch: ${repro()}`);
          assert.deepEqual((objHot as { rows: unknown[] }).rows, objCold.rows, `warm object mismatch: ${repro()}`);

          // 3. VACUITY GUARD. The two arms must actually have emitted different
          // statements; without this the whole arm would pass if `jsonEncoding`
          // were silently ignored.
          objectStatements += emittedSql.filter((s) => s.includes('json_build_object')).length;
          positionalStatements += emittedSql.filter((s) => s.includes('json_build_array')).length;
          if (testCase.args.with) {
            assert.ok(
              emittedSql.some((s) => s.includes('json_build_object')) &&
                emittedSql.some((s) => s.includes('json_build_array')),
              `a case with relations emitted only one encoder: ${repro()}`,
            );
          }
        }
        assert.ok(withRelations > 0, `seed ${seed}: no generated case carried a \`with\`; the arm proves nothing`);
        assert.ok(objectStatements > 0, `seed ${seed}: json_build_object never emitted`);
        assert.ok(positionalStatements > 0, `seed ${seed}: json_build_array never emitted`);
      },
    );
  }
});

// ---------------------------------------------------------------------------
// ARM 4: encoding fidelity across the JSON-wire COERCION types.
//
// The seeded fixture is BIGINT ids and text/bool/int4/timestamptz/jsonb columns,
// so of JSON_WIRE_COERCION_OIDS it exercises `int8` and nothing else. Those are
// exactly the types whose JSON rendering does NOT match what the driver returns
// for the same column, which is why the builder bakes `::text` casts into the
// relation expressions and re-parses them on the way back
// (see the JSON_WIRE_COERCION_OIDS comment block in query/relations.ts).
//
// `buildJsonRow` drops only the KEYS and passes each expression through
// verbatim, so positional should preserve every one of those casts. "Should" is
// the reason this arm exists: it owns a fixture carrying every type in the set,
// and the precondition test below FAILS if a type in the set stops being
// represented, so the coverage claim cannot quietly rot.
// ---------------------------------------------------------------------------

const ENC_DDL = `
DROP TABLE IF EXISTS encfuzz_children CASCADE;
DROP TABLE IF EXISTS encfuzz_parents CASCADE;
CREATE TABLE encfuzz_parents (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label TEXT NOT NULL
);
CREATE TABLE encfuzz_children (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id      BIGINT NOT NULL REFERENCES encfuzz_parents(id),
  ord            INTEGER NOT NULL,
  c_numeric      NUMERIC(20,4),
  c_bigint       BIGINT,
  c_bytea        BYTEA,
  c_date         DATE,
  c_interval     INTERVAL,
  c_point        POINT,
  c_circle       CIRCLE,
  c_numeric_arr  NUMERIC(20,4)[],
  c_bigint_arr   BIGINT[],
  c_bytea_arr    BYTEA[],
  c_date_arr     DATE[],
  c_interval_arr INTERVAL[],
  c_point_arr    POINT[],
  c_ts_arr       TIMESTAMP[],
  c_tstz_arr     TIMESTAMPTZ[],
  c_text         TEXT,
  c_int          INTEGER,
  c_bool         BOOLEAN,
  c_jsonb        JSONB
);
CREATE INDEX idx_encfuzz_children_parent ON encfuzz_children(parent_id);

INSERT INTO encfuzz_parents (label)
  SELECT 'p' || g FROM generate_series(1, 12) g;

-- Row 1 of every parent carries real values in every column; row 2 carries
-- NULLs, so the coercion path is exercised against absent values too; rows 3+
-- vary so ordering and limits have something to choose between. Parent 12 gets
-- no children at all (empty-relation stitching).
INSERT INTO encfuzz_children (
  parent_id, ord, c_numeric, c_bigint, c_bytea, c_date, c_interval, c_point, c_circle,
  c_numeric_arr, c_bigint_arr, c_bytea_arr, c_date_arr, c_interval_arr, c_point_arr,
  c_ts_arr, c_tstz_arr, c_text, c_int, c_bool, c_jsonb
)
SELECT
  p.id,
  n,
  CASE WHEN n = 2 THEN NULL ELSE (1000.5001 + n)::numeric(20,4) END,
  CASE WHEN n = 2 THEN NULL ELSE 9007199254740993 + n END,
  CASE WHEN n = 2 THEN NULL ELSE decode('deadbeef', 'hex') END,
  CASE WHEN n = 2 THEN NULL ELSE DATE '2024-03-05' + n END,
  CASE WHEN n = 2 THEN NULL ELSE INTERVAL '1 day 02:03:04' END,
  CASE WHEN n = 2 THEN NULL ELSE point(n, n + 1) END,
  CASE WHEN n = 2 THEN NULL ELSE circle(point(n, n), n + 1) END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[1.2345, 2.5]::numeric(20,4)[] END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[9007199254740993, 1]::bigint[] END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[decode('00ff', 'hex')]::bytea[] END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[DATE '2024-03-05']::date[] END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[INTERVAL '3 hours']::interval[] END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[point(1,2)]::point[] END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[TIMESTAMP '2024-03-05 06:07:08.123']::timestamp[] END,
  CASE WHEN n = 2 THEN NULL ELSE ARRAY[TIMESTAMPTZ '2024-03-05 06:07:08.123+00']::timestamptz[] END,
  CASE WHEN n = 2 THEN NULL ELSE 'child ' || n END,
  n * 7,
  n % 2 = 0,
  CASE WHEN n = 2 THEN NULL ELSE jsonb_build_object('n', n) END
FROM encfuzz_parents p
CROSS JOIN generate_series(1, 5) n
WHERE p.id < 12;
`;

/** Every column of `encfuzz_children` the generator may project or sort on. */
const ENC_CHILD_FIELDS = [
  'id',
  'parentId',
  'ord',
  'cNumeric',
  'cBigint',
  'cBytea',
  'cDate',
  'cInterval',
  'cPoint',
  'cCircle',
  'cNumericArr',
  'cBigintArr',
  'cByteaArr',
  'cDateArr',
  'cIntervalArr',
  'cPointArr',
  'cTsArr',
  'cTstzArr',
  'cText',
  'cInt',
  'cBool',
  'cJsonb',
] as const;

/**
 * Random findMany args over `encfuzz_parents`, whose only job is to move which
 * columns land in which POSITION: that is the whole of what the positional
 * decode depends on, so `select` / `omit` are the interesting dimension and
 * both are generated, alongside relation `limit` / `orderBy` / `where` and a
 * nested to-one back to the parent.
 */
function encCase(rng: () => number): Record<string, unknown> {
  const fields = ENC_CHILD_FIELDS;
  const childOptions: Record<string, unknown> = {};
  const projection = Math.floor(rng() * 3);
  if (projection === 1) {
    // `select`, in the caller's own key order (which the emitted order follows).
    const keep = fields.filter(() => chance(rng, 0.45));
    if (keep.length === 0) keep.push('id');
    childOptions.select = Object.fromEntries(keep.map((f) => [f, true]));
  } else if (projection === 2) {
    childOptions.omit = Object.fromEntries(fields.filter(() => chance(rng, 0.25)).map((f) => [f, true]));
  }
  if (chance(rng, 0.4)) childOptions.where = { cInt: { gt: Math.floor(rng() * 20) } };
  if (chance(rng, 0.5)) childOptions.limit = 1 + Math.floor(rng() * 3);
  // Always totally ordered: `ord` repeats across parents but is unique WITHIN a
  // parent, and the PK tiebreaker settles everything else.
  childOptions.orderBy = [{ ord: pick(rng, ['asc', 'desc'] as const) }, { id: 'asc' }];
  if (chance(rng, 0.3)) childOptions.with = { encfuzzParent: true };

  const args: Record<string, unknown> = {
    orderBy: [{ id: 'asc' }],
    with: { encfuzzChildren: chance(rng, 0.15) ? true : childOptions },
  };
  if (chance(rng, 0.3)) args.where = { label: { contains: 'p1' } };
  if (chance(rng, 0.3)) args.limit = 3 + Math.floor(rng() * 6);
  return args;
}

describe('encoding fidelity fuzz on PostgreSQL (JSON-wire coercion types)', () => {
  let encDb: TurbineClient;
  let encSchema: SchemaMetadata;

  pgGate.before(async () => {
    const client = new pgDriver.Client({ connectionString: PG_URL! });
    await client.connect();
    try {
      await client.query(ENC_DDL);
    } finally {
      await client.end();
    }
    encSchema = await introspect({ connectionString: PG_URL! });
    encDb = new TurbineClient({ connectionString: PG_URL!, poolSize: 5, warnOnUnlimited: false }, encSchema);
    await encDb.connect();
  });

  pgGate.after(async () => {
    await encDb.disconnect();
  });

  pgGate.it('the fixture carries every JSON-wire coercion type', () => {
    // THE VACUITY GUARD FOR THIS WHOLE ARM. `::text` casts are emitted for
    // exactly the types in JSON_WIRE_COERCION_OIDS, so if the fixture stops
    // carrying one of them, this arm silently stops proving anything about it.
    const meta = encSchema.tables.encfuzz_children;
    assert.ok(meta, 'fixture table encfuzz_children is missing');
    const present = new Set(Object.values(meta.pgTypes ?? {}));
    const missing = Object.keys(JSON_WIRE_COERCION_OIDS).filter((t) => !present.has(t));
    assert.deepEqual(
      missing,
      [],
      `these coercion types are not in the fixture, so the arm does not cover them: ${missing.join(', ')}`,
    );
  });

  pgGate.it('the relation SQL actually carries ::text casts (so there is something to preserve)', () => {
    const qi = encDb.table('encfuzz_parents') as unknown as {
      buildFindMany(a: unknown): { sql: string };
    };
    const positional = qi.buildFindMany({ with: { encfuzzChildren: true }, jsonEncoding: 'positional' }).sql;
    const object = qi.buildFindMany({ with: { encfuzzChildren: true }, jsonEncoding: 'object' }).sql;
    assert.match(positional, /json_build_array/);
    assert.match(object, /json_build_object/);
    // Same cast set on both sides: positional drops the keys, nothing else.
    const casts = (sql: string) => (sql.match(/::text/g) ?? []).length;
    assert.ok(casts(positional) > 0, 'no ::text casts emitted; the fidelity claim is untested');
    assert.equal(casts(positional), casts(object), 'the two encodings must cast the same columns');
  });

  for (const seed of SEEDS) {
    pgGate.it(`seed ${seed}: object and positional agree on typed values over ${PG_CASES_PER_SEED} cases`, async () => {
      const rng = mulberry32(seed);
      let compared = 0;
      let sawTypedCell = false;
      for (let i = 0; i < PG_CASES_PER_SEED; i++) {
        const args = encCase(rng);
        const repro = () => `seed=${seed} case=${i}\nargs=${JSON.stringify(args)}`;
        const obj = await runEncoded(encDb, 'encfuzz_parents', args, 'object');
        const pos = await runEncoded(encDb, 'encfuzz_parents', args, 'positional');

        assert.equal(obj.ok, pos.ok, `encodings disagree about validity: ${repro()}`);
        if (!obj.ok && !pos.ok) {
          assert.equal(obj.code, pos.code, `encodings threw different codes: ${repro()}`);
          continue;
        }
        if (!obj.ok) continue;

        // Deep equality covers value AND runtime type for Date / Buffer /
        // string-vs-number, which is exactly where the coercion set bites:
        // `numeric` and `int8` come back as strings, `date` as a Date, `bytea`
        // as a Buffer, and a lost cast turns each into something else.
        assert.deepEqual((pos as { rows: unknown[] }).rows, obj.rows, `typed value mismatch: ${repro()}`);
        compared += 1;
        for (const parent of obj.rows as Record<string, unknown>[]) {
          const kids = parent.encfuzzChildren as Record<string, unknown>[] | undefined;
          for (const kid of kids ?? []) {
            if (typeof kid.cNumeric === 'string' || Buffer.isBuffer(kid.cBytea) || kid.cDate instanceof Date) {
              sawTypedCell = true;
            }
          }
        }
      }
      assert.ok(compared > 0, `seed ${seed}: every case threw; the equality half never ran`);
      assert.ok(
        sawTypedCell,
        `seed ${seed}: no coercion-typed cell was ever returned, so equality proved nothing about fidelity`,
      );
    });
  }
});
