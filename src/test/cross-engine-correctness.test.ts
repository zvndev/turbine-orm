/**
 * Cross-engine correctness battery: ONE set of assertions, run against every
 * engine that can be reached, so a regression in the shared SQL generators
 * (query/where.ts, query/relations.ts, query/writes.ts) is caught on MySQL and
 * SQL Server and not only on Postgres.
 *
 * WHY THIS FILE EXISTS. The ~3,300-test suite in this directory is
 * Postgres-shaped: every DB-gated test builds a pg client from DATABASE_URL,
 * and there is no switch that redirects it at another engine. So until now the
 * only execution coverage MySQL and SQL Server had was `mysql.test.ts` /
 * `mssql.test.ts`, whose integration tiers are hand-written per engine. A
 * cross-engine regression was therefore caught only if someone REMEMBERED to
 * duplicate the case into each engine file, which is a process guarantee, not a
 * gate. This battery is the shared half: the same expectations, expressed as
 * VALUES (ids, names, counts) rather than as SQL text, so they mean the same
 * thing on every engine.
 *
 * SCOPE. The engines registered:
 *   - sqlite         , always (node:sqlite builtin, no server, so this battery
 *                      runs in the plain `test:unit` lane on every PR)
 *   - better-sqlite3 , when the optional binding loads (CI installs the pinned
 *                      release and names it with TURBINE_SQLITE_BINDING_PEER)
 *   - mysql          , when MYSQL_URL is set (CI's mysql:8 service)
 *   - mssql          , when MSSQL_URL is set (CI's SQL Server 2022 service)
 *   - postgres       , when DATABASE_URL is set (the integration-tests matrix)
 * Postgres has the full suite as well. It runs here because the nested-write
 * cases at the end assert the same database truth on every engine, and the
 * reference engine passing the same assertion is what makes a difference on
 * another engine attributable to that engine.
 *
 * REQUIRED, NOT OPTIONAL, IN CI. Each harness gates through `skipGate`, so a job
 * that names its engine in TURBINE_REQUIRE_ENGINE fails this file when the
 * engine is unreachable. The battery used to register its own `{ skip }` and so
 * skipped silently under that guard. The better-sqlite3 harness follows the
 * binding's own guard instead: TURBINE_REQUIRE_SQLITE_BINDING=1 fails the file
 * when the binding does not load.
 *
 * ISOLATION. The server-backed engines create their OWN database
 * (`turbine_cross`) rather than sharing the one `mysql.test.ts` /
 * `mssql.test.ts` create and drop tables in, or the seed.sql database the rest
 * of the Postgres suite reads. Node's test runner executes files
 * in parallel by default, and two files racing DDL on the same tables is a
 * flake generator, not a gate.
 *
 * NORMALIZATION RULE. Assertions normalize the WIRE TYPE (Number() for
 * counts/aggregates, truthiness for booleans) but never the VALUE. Engines
 * legitimately differ on whether a BIGINT arrives as a number or a string and
 * on whether a boolean is BIT/TINYINT/INTEGER; they do not legitimately differ
 * on WHICH rows come back or in WHAT order. Normalizing the first keeps the
 * battery about the second.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { after, before, beforeEach, describe } from 'node:test';
import type { BetterSqlite3Database } from '../better-sqlite3.js';
import { NotFoundError, UniqueConstraintError, ValidationError } from '../index.js';
import type { SchemaMetadata } from '../schema.js';
import { type GatedRunners, skipGate } from './helpers.js';
import { closeSqliteAfter, sqliteFixtureScope } from './sqlite-fixture-lifetime.js';

// ---------------------------------------------------------------------------
// Fixture, identical row-for-row on every engine (a port of
// src/test/fixtures/seed.sql plus a tags/post_tags m2m junction). The DDL
// differs per engine only in TYPE SPELLING and identity syntax, never in shape.
// ---------------------------------------------------------------------------

const SQLITE_DDL = `
CREATE TABLE organizations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  slug       TEXT NOT NULL UNIQUE
);
CREATE TABLE users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id     INTEGER NOT NULL REFERENCES organizations(id),
  email      TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  name_cs    TEXT NOT NULL COLLATE BINARY,
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
CREATE TABLE profiles (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE REFERENCES users(id),
  bio     TEXT NOT NULL
);
CREATE TABLE tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  assignee_id INTEGER REFERENCES users(id),
  title       TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_tasks_assignee_id ON tasks(assignee_id);
`;

const MYSQL_DDL = [
  `CREATE TABLE organizations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE
  )`,
  `CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    org_id BIGINT NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    name_cs VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    avatar_url VARCHAR(255),
    CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id)
  )`,
  `CREATE INDEX idx_users_org_id ON users(org_id)`,
  `CREATE TABLE posts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    org_id BIGINT NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    published TINYINT(1) NOT NULL DEFAULT 0,
    view_count INT NOT NULL DEFAULT 0,
    CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_posts_org FOREIGN KEY (org_id) REFERENCES organizations(id)
  )`,
  `CREATE INDEX idx_posts_user_id ON posts(user_id)`,
  `CREATE TABLE comments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    body TEXT NOT NULL,
    CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id),
    CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE tags (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE
  )`,
  `CREATE TABLE post_tags (
    post_id BIGINT NOT NULL,
    tag_id BIGINT NOT NULL,
    PRIMARY KEY (post_id, tag_id),
    CONSTRAINT fk_pt_post FOREIGN KEY (post_id) REFERENCES posts(id),
    CONSTRAINT fk_pt_tag FOREIGN KEY (tag_id) REFERENCES tags(id)
  )`,
  `CREATE TABLE profiles (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NULL UNIQUE,
    bio VARCHAR(255) NOT NULL,
    CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE tasks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    assignee_id BIGINT NULL,
    title VARCHAR(255) NOT NULL UNIQUE,
    CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users(id)
  )`,
];

const MSSQL_DDL = [
  `CREATE TABLE organizations (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    slug NVARCHAR(255) NOT NULL UNIQUE
  )`,
  `CREATE TABLE users (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    org_id BIGINT NOT NULL,
    email NVARCHAR(255) NOT NULL UNIQUE,
    name NVARCHAR(255) NOT NULL,
    name_cs NVARCHAR(255) COLLATE Latin1_General_CS_AS NOT NULL,
    role NVARCHAR(50) NOT NULL DEFAULT 'member',
    avatar_url NVARCHAR(255),
    CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id)
  )`,
  `CREATE INDEX IX_users_org_id ON users(org_id)`,
  `CREATE TABLE posts (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    org_id BIGINT NOT NULL,
    title NVARCHAR(255) NOT NULL,
    content NVARCHAR(MAX) NOT NULL,
    published BIT NOT NULL DEFAULT 0,
    view_count INT NOT NULL DEFAULT 0,
    CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_posts_org FOREIGN KEY (org_id) REFERENCES organizations(id)
  )`,
  `CREATE INDEX IX_posts_user_id ON posts(user_id)`,
  `CREATE TABLE comments (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    post_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    body NVARCHAR(MAX) NOT NULL,
    CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id),
    CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE tags (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL UNIQUE
  )`,
  `CREATE TABLE post_tags (
    post_id BIGINT NOT NULL,
    tag_id BIGINT NOT NULL,
    CONSTRAINT pk_post_tags PRIMARY KEY (post_id, tag_id),
    CONSTRAINT fk_pt_post FOREIGN KEY (post_id) REFERENCES posts(id),
    CONSTRAINT fk_pt_tag FOREIGN KEY (tag_id) REFERENCES tags(id)
  )`,
  // A SQL Server UNIQUE constraint admits ONE NULL, not many. The battery is
  // written so at most one profile is ever unowned at a time (the seed has
  // none), so the plain constraint, which introspection reads as a to-one key,
  // holds on every engine.
  `CREATE TABLE profiles (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id BIGINT NULL,
    bio NVARCHAR(255) NOT NULL,
    CONSTRAINT uq_profiles_user UNIQUE (user_id),
    CONSTRAINT fk_profiles_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE tasks (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    assignee_id BIGINT NULL,
    title NVARCHAR(255) NOT NULL UNIQUE,
    CONSTRAINT fk_tasks_assignee FOREIGN KEY (assignee_id) REFERENCES users(id)
  )`,
];

const POSTGRES_DDL = [
  `CREATE TABLE organizations (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE users (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    name_cs TEXT COLLATE "C" NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    avatar_url TEXT
  )`,
  `CREATE INDEX idx_users_org_id ON users(org_id)`,
  `CREATE TABLE posts (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    org_id INTEGER NOT NULL REFERENCES organizations(id),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    view_count INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX idx_posts_user_id ON posts(user_id)`,
  `CREATE TABLE comments (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL
  )`,
  `CREATE INDEX idx_comments_post_id ON comments(post_id)`,
  `CREATE TABLE tags (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  )`,
  `CREATE TABLE post_tags (
    post_id INTEGER NOT NULL REFERENCES posts(id),
    tag_id INTEGER NOT NULL REFERENCES tags(id),
    PRIMARY KEY (post_id, tag_id)
  )`,
  `CREATE TABLE profiles (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER UNIQUE REFERENCES users(id),
    bio TEXT NOT NULL
  )`,
  `CREATE TABLE tasks (
    id INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    assignee_id INTEGER REFERENCES users(id),
    title TEXT NOT NULL UNIQUE
  )`,
  `CREATE INDEX idx_tasks_assignee_id ON tasks(assignee_id)`,
];

/**
 * The seed rows, as data. Each engine renders them with its own identity-insert
 * ceremony, so the ids are FIXED and every assertion below can name them.
 *
 * TWO PROPERTIES OF THIS FIXTURE ARE LOAD-BEARING, and both were missing when it
 * was first written, which made the assertions that depend on them vacuous.
 *
 * 1. DECOY ROWS FOR escapeLike(). `Bob %Editor_` and `100% Sure` carry LIKE
 *    metacharacters, but a row carrying a metacharacter proves nothing on its
 *    own: if `Bob %Editor_` is the ONLY name containing 'Editor', the UNESCAPED
 *    pattern `%%Editor_%` still returns exactly that row and the test passes
 *    whether escapeLike() ran or not. So `Erin Editors` and the post title
 *    `1000 Posts In` exist purely as decoys: they match the unescaped pattern
 *    and NOT the escaped one, which is what makes the escaping assertion
 *    discriminate. The battery asserts the decoys are present (see the negative
 *    controls in the escapeLike test) so a future fixture edit cannot silently
 *    remove the bite.
 *
 * 2. A CASE-SENSITIVE COLUMN, `name_cs`. It holds the same text as `name` but is
 *    declared with a case-sensitive collation on every engine that has one
 *    (utf8mb4_bin on MySQL, Latin1_General_CS_AS on SQL Server). Without it a
 *    `mode: 'insensitive'` assertion cannot fail: MySQL's default collation is
 *    *_ai_ci and SQL Server's is *_CI_AS, so a plain LIKE already matches across
 *    case and the assertion passes even with insensitive-mode handling deleted.
 */
const ORGS = [
  { id: 1, name: 'Acme Inc', slug: 'acme' },
  { id: 2, name: 'Beta LLC', slug: 'beta' },
];
const USERS = [
  {
    id: 1,
    org_id: 1,
    email: 'user1@example.com',
    name: 'Alice Admin',
    name_cs: 'Alice Admin',
    role: 'admin',
    avatar_url: 'https://a/1.png',
  },
  {
    id: 2,
    org_id: 1,
    email: 'user2@example.com',
    name: 'Bob %Editor_',
    name_cs: 'Bob %Editor_',
    role: 'editor',
    avatar_url: 'https://a/2.png',
  },
  {
    id: 3,
    org_id: 1,
    email: 'user3@example.com',
    name: 'Carol Member',
    name_cs: 'Carol Member',
    role: 'member',
    avatar_url: null,
  },
  {
    id: 4,
    org_id: 2,
    email: 'user4@example.com',
    name: 'Dave Admin',
    name_cs: 'Dave Admin',
    role: 'admin',
    avatar_url: null,
  },
  // Decoy for escapeLike: contains 'Editor' followed by a character, so the
  // UNESCAPED form of `contains: '%Editor_'` sweeps it in and the escaped form
  // does not (it has neither a literal '%' nor a literal '_').
  {
    id: 5,
    org_id: 2,
    email: 'user5@example.com',
    name: 'Erin Editors',
    name_cs: 'Erin Editors',
    role: 'member',
    avatar_url: null,
  },
];
const POSTS = [
  { id: 1, user_id: 1, org_id: 1, title: 'Hello World', content: 'First post body', published: 1, view_count: 100 },
  { id: 2, user_id: 1, org_id: 1, title: 'Second Post', content: 'More content', published: 1, view_count: 75 },
  { id: 3, user_id: 1, org_id: 1, title: 'Draft Post', content: 'Not ready', published: 0, view_count: 0 },
  { id: 4, user_id: 2, org_id: 1, title: '100% Sure', content: 'By the editor', published: 1, view_count: 42 },
  { id: 5, user_id: 4, org_id: 2, title: 'Org 2 Post', content: 'Across orgs', published: 1, view_count: 60 },
];
const COMMENTS = [
  { id: 1, post_id: 1, user_id: 2, body: 'Nice post!' },
  { id: 2, post_id: 1, user_id: 3, body: 'I agree' },
  { id: 3, post_id: 2, user_id: 2, body: 'Solid follow up' },
  { id: 4, post_id: 4, user_id: 1, body: 'Approved by admin' },
];
const TAGS = [
  { id: 1, name: 'tech' },
  { id: 2, name: 'news' },
  { id: 3, name: 'draft' },
];
const POST_TAGS = [
  { post_id: 1, tag_id: 1 },
  { post_id: 1, tag_id: 2 },
  { post_id: 2, tag_id: 1 },
  { post_id: 3, tag_id: 3 },
];
// The nested-write tables. `profiles.user_id` is a NULLABLE UNIQUE foreign key,
// so introspection reads users -> profiles as a to-one (hasOne) relation that
// can be disconnected; `tasks.assignee_id` is a nullable plain one, a to-many
// that `disconnect` and `set` can clear. Every other foreign key in the fixture
// is NOT NULL, and those operations refuse on a NOT NULL key by design.
// User 5 owns nothing but task 5, so a belongsTo `delete` through task 5 can
// remove that user without a foreign-key violation.
const PROFILES = [
  { id: 1, user_id: 1, bio: 'Alice bio' },
  { id: 2, user_id: 2, bio: 'Bob bio' },
];
const TASKS = [
  { id: 1, assignee_id: 1, title: 'Write docs' },
  { id: 2, assignee_id: 1, title: 'Fix bug' },
  { id: 3, assignee_id: 2, title: 'Review change' },
  { id: 4, assignee_id: null, title: 'Unassigned' },
  { id: 5, assignee_id: 5, title: 'Erin task' },
];

/** Delete order (children first) shared by every engine's reseed. */
const TABLES_CHILD_FIRST = ['tasks', 'profiles', 'post_tags', 'comments', 'posts', 'tags', 'users', 'organizations'];

/** Every seeded table with its rows, parents first: the insert order of each reseed. */
const SEED: [string, Record<string, unknown>[]][] = [
  ['organizations', ORGS],
  ['users', USERS],
  ['posts', POSTS],
  ['comments', COMMENTS],
  ['tags', TAGS],
  ['post_tags', POST_TAGS],
  ['profiles', PROFILES],
  ['tasks', TASKS],
];

// ---------------------------------------------------------------------------
// Row shapes (loose: the wire type of a bigint/boolean is engine-specific, and
// normalizing it is the assertions' job, not the type's).
// ---------------------------------------------------------------------------

interface UserRow {
  id: number;
  orgId: number;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  posts?: PostRow[];
  organization?: { id: number; name: string } | null;
}
interface PostRow {
  id: number;
  userId: number;
  orgId: number;
  title: string;
  content: string;
  published: unknown;
  viewCount: number;
  user?: UserRow | null;
  comments?: CommentRow[];
  tags?: { id: number; name: string }[];
}
interface CommentRow {
  id: number;
  postId: number;
  userId: number;
  body: string;
}

/** Wire-type normalizer: engines disagree on bigint-as-string, never on value. */
const n = (v: unknown): number => Number(v);
const ids = (rows: { id: unknown }[]): number[] => rows.map((r) => n(r.id));

// ---------------------------------------------------------------------------
// Engine harnesses
// ---------------------------------------------------------------------------

interface EngineHarness {
  name: string;
  /** False when the engine cannot be reached here; `runners` then registers every test as skipped. */
  available: boolean;
  /**
   * From `skipGate`, so an engine a CI job names in `TURBINE_REQUIRE_ENGINE`
   * FAILS this file when it is unreachable instead of skipping it. Each
   * harness passes its reason as a literal, which is what lets
   * scripts/check-skip-gate-reasons.ts read it.
   */
  runners: GatedRunners;
  connect(): Promise<void>;
  reseed(): Promise<void>;
  close(): Promise<void>;
  /** biome-ignore lint/suspicious/noExplicitAny: TurbineClient kept loose so this file loads in the unit lane. */
  client(): any;
  schema(): SchemaMetadata;
  /**
   * Rows straight from the driver, never through Turbine: the database truth a
   * write is checked against. Keys are the column names. The SQL must be
   * portable (unquoted lowercase identifiers, no placeholders).
   */
  raw(sql: string): Promise<Record<string, unknown>[]>;
  /**
   * `createMany` returns the inserted rows everywhere EXCEPT MySQL, whose
   * result strategy is count-not-rows (documented in src/mysql.ts). The battery
   * still asserts the rows LANDED, it just reads them back on MySQL.
   */
  createManyReturnsRows: boolean;
  /**
   * A second client over the SAME connection pool, configured with global
   * filters (a tenant scope). Never disconnected on its own: the pool belongs
   * to the harness and `close()` ends it.
   */
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see client().
  filtered(globalFilters: Record<string, Record<string, unknown>>): Promise<any>;
}

// --- sqlite ----------------------------------------------------------------

// node:sqlite is a builtin only on Node >= 22.5, so probe for it WITHOUT a
// static import: a static import crashes the whole unit lane on Node 20 with
// ERR_UNKNOWN_BUILTIN_MODULE instead of skipping this engine.
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

/** The seed as SQLite statements, shared by both SQLite drivers. */
function sqliteSeedStatements(): string[] {
  const lit = (v: unknown) =>
    v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  return SEED.flatMap(([table, rows]) =>
    rows.map(
      (r) => `INSERT INTO ${table} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(lit).join(', ')});`,
    ),
  );
}

function sqliteHarness(): EngineHarness {
  let db: DatabaseSyncType;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see EngineHarness.
  let c: any;
  let s: SchemaMetadata;
  return {
    name: 'sqlite',
    available: Boolean(DatabaseSync),
    runners: skipGate(!DatabaseSync, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)'),
    createManyReturnsRows: true,
    async connect() {
      const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
      // `!` is safe: connect() runs only when the node:sqlite probe above
      // found DatabaseSync.
      db = closeSqliteAfter(new DatabaseSync!(':memory:'), sqliteCleanup);
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(SQLITE_DDL);
      s = introspectSqliteDatabase(db);
      c = turbineSqlite(db, s);
      await this.reseed();
    },
    async filtered(globalFilters) {
      const { turbineSqlite } = await import('../sqlite.js');
      return turbineSqlite(db, s, { globalFilters });
    },
    async reseed() {
      for (const t of TABLES_CHILD_FIRST) db.exec(`DELETE FROM ${t};`);
      for (const stmt of sqliteSeedStatements()) db.exec(stmt);
    },
    async raw(sql) {
      return db.prepare(sql).all() as Record<string, unknown>[];
    },
    async close() {
      await c.disconnect();
    },
    client: () => c,
    schema: () => s,
  };
}

// --- better-sqlite3 --------------------------------------------------------

// The optional binding is not a dependency of this repository. CI installs the
// pinned release outside the checkout and names it with
// TURBINE_SQLITE_BINDING_PEER; TURBINE_REQUIRE_SQLITE_BINDING=1 turns a binding
// that does not load into a failure of this file, the guard
// src/test/sqlite-binding.test.ts uses for the same peer.
const BetterSqlite3: (new (path: string) => BetterSqlite3Database) | undefined = (() => {
  try {
    return createRequire(import.meta.url)(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3');
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();

function betterSqlite3Harness(): EngineHarness {
  let db: BetterSqlite3Database;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see EngineHarness.
  let c: any;
  let s: SchemaMetadata;
  const exec = (sql: string) => db.exec(sql);
  return {
    name: 'better-sqlite3',
    available: Boolean(BetterSqlite3),
    runners: skipGate(!BetterSqlite3, 'requires the optional better-sqlite3 peer (set TURBINE_SQLITE_BINDING_PEER)'),
    createManyReturnsRows: true,
    async connect() {
      const { introspectBetterSqlite3Database, turbineBetterSqlite3 } = await import('../better-sqlite3.js');
      db = new BetterSqlite3!(':memory:');
      exec('PRAGMA foreign_keys = ON');
      exec(SQLITE_DDL);
      s = introspectBetterSqlite3Database(db);
      c = await turbineBetterSqlite3(db, s);
      await this.reseed();
    },
    async filtered(globalFilters) {
      const { turbineBetterSqlite3 } = await import('../better-sqlite3.js');
      return turbineBetterSqlite3(db, s, { globalFilters });
    },
    async reseed() {
      for (const t of TABLES_CHILD_FIRST) exec(`DELETE FROM ${t};`);
      for (const stmt of sqliteSeedStatements()) exec(stmt);
    },
    async raw(sql) {
      return db.prepare(sql).all() as Record<string, unknown>[];
    },
    async close() {
      try {
        await c.disconnect();
      } finally {
        // A supplied handle stays caller owned: the client never closes it.
        db.close();
      }
    },
    client: () => c,
    schema: () => s,
  };
}

// --- mysql -----------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';

function mysqlHarness(): EngineHarness {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool, loaded dynamically only when gated on.
  let rawPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: MysqlPool, loaded dynamically only when gated on.
  let pool: any;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see EngineHarness.
  let c: any;
  let s: SchemaMetadata;
  const insert = (table: string, rows: Record<string, unknown>[]) => {
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    const values = rows.map((r) => cols.map((k) => r[k]));
    return {
      sql: `INSERT INTO \`${table}\` (${cols.map((k) => `\`${k}\``).join(', ')}) VALUES ${values
        .map(() => `(${cols.map(() => '?').join(', ')})`)
        .join(', ')}`,
      params: values.flat(),
    };
  };
  return {
    name: 'mysql',
    available: Boolean(MYSQL_URL),
    runners: skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server'),
    createManyReturnsRows: false,
    async connect() {
      const { createPool } = await import('mysql2/promise');
      const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
      const url = new URL(MYSQL_URL);
      const base = {
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
      // Own database, so this battery can never race mysql.test.ts, which
      // creates and DROPS the same table names in the URL's database. Node runs
      // test files in parallel by default.
      const admin = createPool({ ...base, multipleStatements: false });
      await admin.query('CREATE DATABASE IF NOT EXISTS `turbine_cross`');
      await admin.end();
      rawPool = createPool({
        ...base,
        database: 'turbine_cross',
        namedPlaceholders: true,
        supportBigNumbers: true,
        bigNumberStrings: false,
        timezone: 'Z',
        multipleStatements: false,
      });
      // Matches src/mysql.ts: NO_BACKSLASH_ESCAPES makes MySQL's string literal
      // rules match the Postgres ones the generators assume.
      rawPool.on('connection', (conn: { query: (s: string, cb: () => void) => void }) => {
        conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')", () => {});
      });
      await rawPool.query('SET FOREIGN_KEY_CHECKS=0');
      for (const t of TABLES_CHILD_FIRST) await rawPool.query(`DROP TABLE IF EXISTS \`${t}\``);
      await rawPool.query('SET FOREIGN_KEY_CHECKS=1');
      for (const stmt of MYSQL_DDL) await rawPool.query(stmt);
      pool = new MysqlPool(rawPool);
      s = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'turbine_cross');
      c = await turbineMysql(pool, s);
      await this.reseed();
    },
    async filtered(globalFilters) {
      const { turbineMysql } = await import('../mysql.js');
      return turbineMysql(pool, s, { globalFilters });
    },
    async reseed() {
      await rawPool.query('SET FOREIGN_KEY_CHECKS=0');
      for (const t of TABLES_CHILD_FIRST) await rawPool.query(`TRUNCATE TABLE \`${t}\``);
      await rawPool.query('SET FOREIGN_KEY_CHECKS=1');
      for (const [table, rows] of SEED) {
        const { sql, params } = insert(table, rows);
        await rawPool.query(sql, params);
      }
    },
    async raw(sql) {
      return (await rawPool.query(sql))[0];
    },
    async close() {
      await rawPool.end();
    },
    client: () => c,
    schema: () => s,
  };
}

// --- mssql -----------------------------------------------------------------

const MSSQL_URL = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';

function mssqlHarness(): EngineHarness {
  // biome-ignore lint/suspicious/noExplicitAny: mssql pool, loaded dynamically only when gated on.
  let rawPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: MssqlPool, loaded dynamically only when gated on.
  let pool: any;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see EngineHarness.
  let c: any;
  let s: SchemaMetadata;
  const lit = (v: unknown) =>
    v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const insertBatch = (table: string, rows: Record<string, unknown>[], identity: boolean) => {
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    const body = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${rows
      .map((r) => `(${cols.map((k) => lit(r[k])).join(', ')})`)
      .join(', ')};`;
    return identity ? `SET IDENTITY_INSERT ${table} ON; ${body} SET IDENTITY_INSERT ${table} OFF;` : body;
  };
  return {
    name: 'mssql',
    available: Boolean(MSSQL_URL),
    runners: skipGate(!MSSQL_URL, 'requires MSSQL_URL pointing at a SQL Server 2016+ instance'),
    createManyReturnsRows: true,
    async connect() {
      // `mssql` ships no bundled types; widen the specifier so tsc treats it as
      // `any` (TS7016) without @types/mssql. Only runs on the gated path.
      const mssqlSpecifier: string = 'mssql';
      // biome-ignore lint/suspicious/noExplicitAny: dynamic mssql import, gated.
      const mod: any = await import(mssqlSpecifier);
      const mssql = mod.default ?? mod;
      const { MssqlPool, introspectMssqlWith, turbineMssql } = await import('../mssql.js');
      const url = new URL(MSSQL_URL);
      const base = {
        server: url.hostname,
        port: url.port ? Number(url.port) : 1433,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        options: { encrypt: false, trustServerCertificate: true },
      };
      // Own database (see the MySQL note): mssql.test.ts drops these same table
      // names in the URL's database, and test files run in parallel.
      const admin = await new mssql.ConnectionPool({ ...base, database: 'master' }).connect();
      await admin.request().batch("IF DB_ID('turbine_cross') IS NULL CREATE DATABASE turbine_cross");
      await admin.close();
      rawPool = await new mssql.ConnectionPool({ ...base, database: 'turbine_cross' }).connect();
      for (const t of TABLES_CHILD_FIRST) {
        await rawPool.request().batch(`IF OBJECT_ID('${t}','U') IS NOT NULL DROP TABLE ${t}`);
      }
      for (const stmt of MSSQL_DDL) await rawPool.request().batch(stmt);
      pool = new MssqlPool(rawPool, mssql.default ?? mssql);
      s = await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo');
      c = await turbineMssql(pool, s);
      await this.reseed();
    },
    async filtered(globalFilters) {
      const { turbineMssql } = await import('../mssql.js');
      return turbineMssql(pool, s, { globalFilters });
    },
    async reseed() {
      for (const t of TABLES_CHILD_FIRST) await rawPool.request().batch(`DELETE FROM ${t}`);
      // post_tags is the one table with no identity column.
      for (const [table, rows] of SEED) await rawPool.request().batch(insertBatch(table, rows, table !== 'post_tags'));
    },
    async raw(sql) {
      return (await rawPool.request().query(sql)).recordset;
    },
    async close() {
      await rawPool.close();
    },
    client: () => c,
    schema: () => s,
  };
}

// --- postgres --------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL ?? '';

function postgresHarness(): EngineHarness {
  // biome-ignore lint/suspicious/noExplicitAny: pg pool, loaded dynamically only when gated on.
  let rawPool: any;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see EngineHarness.
  let c: any;
  let s: SchemaMetadata;
  const insert = (table: string, rows: Record<string, unknown>[]) => {
    const cols = Object.keys(rows[0] as Record<string, unknown>);
    let n = 0;
    return {
      sql: `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${rows
        .map(() => `(${cols.map(() => `$${++n}`).join(', ')})`)
        .join(', ')}`,
      params: rows.flatMap((r) => cols.map((k) => r[k])),
    };
  };
  return {
    name: 'postgres',
    available: Boolean(DATABASE_URL),
    runners: skipGate(!DATABASE_URL, 'requires DATABASE_URL pointing at a PostgreSQL server'),
    createManyReturnsRows: true,
    async connect() {
      const { default: pg } = await import('pg');
      const { TurbineClient } = await import('../client.js');
      const { introspect } = await import('../introspect.js');
      // Own database, as on the other servers: the rest of the suite owns the
      // URL's database and its seed.sql tables share these names.
      const admin = new pg.Client({ connectionString: DATABASE_URL });
      await admin.connect();
      try {
        const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'turbine_cross'");
        if (found.rowCount === 0) await admin.query('CREATE DATABASE turbine_cross');
      } finally {
        await admin.end();
      }
      const url = new URL(DATABASE_URL);
      url.pathname = '/turbine_cross';
      rawPool = new pg.Pool({ connectionString: url.toString(), max: 2 });
      for (const t of TABLES_CHILD_FIRST) await rawPool.query(`DROP TABLE IF EXISTS ${t} CASCADE`);
      for (const stmt of POSTGRES_DDL) await rawPool.query(stmt);
      s = await introspect({ connectionString: url.toString() });
      c = new TurbineClient({ connectionString: url.toString(), poolSize: 5 }, s);
      await this.reseed();
    },
    async filtered(globalFilters) {
      const { TurbineClient } = await import('../client.js');
      return new TurbineClient({ pool: rawPool, globalFilters }, s);
    },
    async reseed() {
      await rawPool.query(`TRUNCATE ${TABLES_CHILD_FIRST.join(', ')} RESTART IDENTITY`);
      for (const [table, rows] of SEED) {
        const { sql, params } = insert(table, rows);
        await rawPool.query(sql, params);
        // Explicit ids do not advance an identity column, and the next
        // generated key would collide with a seeded row.
        if (table !== 'post_tags') {
          await rawPool.query(
            `SELECT setval(pg_get_serial_sequence('${table}', 'id'), (SELECT MAX(id) FROM ${table}))`,
          );
        }
      }
    },
    async raw(sql) {
      return (await rawPool.query(sql)).rows;
    },
    async close() {
      try {
        await c.disconnect();
      } finally {
        await rawPool.end();
      }
    },
    client: () => c,
    schema: () => s,
  };
}

// ---------------------------------------------------------------------------
// The battery
// ---------------------------------------------------------------------------

function registerBattery(h: EngineHarness): void {
  // Registering with { skip } (rather than not registering) makes an
  // unreachable engine show as SKIPPED in the reporter. A silently absent
  // engine is exactly how "the suite never touches MySQL" went unnoticed.
  // And the skip goes through skipGate, so the CI job that exists to run an
  // engine fails instead of reporting a battery it never ran.
  const { it } = h.runners;

  describe(`cross-engine correctness: ${h.name}`, () => {
    before(async () => {
      if (!h.available) return;
      await h.connect();
    });
    after(async () => {
      if (!h.available) return;
      await h.close();
    });
    beforeEach(async () => {
      if (!h.available) return;
      await h.reseed();
    });

    // Untyped on purpose: h.client() is `any` (see EngineHarness), so results
    // are annotated at the call sites that dereference a relation.
    const users = () => h.client().table('users');
    const posts = () => h.client().table('posts');

    // --- where.ts ----------------------------------------------------------

    it('equality + orderBy + limit returns exactly the matching rows in order', async () => {
      const admins = await users().findMany({ where: { role: 'admin' }, orderBy: { id: 'asc' }, limit: 10 });
      assert.deepEqual(ids(admins), [1, 4]);
      assert.equal(admins[0]?.name, 'Alice Admin');
    });

    it('gt/gte/lt/lte compare on the column, not on its text rendering', async () => {
      assert.deepEqual(
        ids(await posts().findMany({ where: { viewCount: { gt: 60 } }, orderBy: { id: 'asc' } })),
        [1, 2],
      );
      assert.deepEqual(
        ids(await posts().findMany({ where: { viewCount: { gte: 60 } }, orderBy: { id: 'asc' } })),
        [1, 2, 5],
      );
      assert.deepEqual(ids(await posts().findMany({ where: { viewCount: { lt: 42 } }, orderBy: { id: 'asc' } })), [3]);
      assert.deepEqual(
        ids(await posts().findMany({ where: { viewCount: { lte: 42 } }, orderBy: { id: 'asc' } })),
        [3, 4],
      );
    });

    it('in / notIn / not select the same complementary row sets', async () => {
      const inRoles = await users().findMany({ where: { role: { in: ['admin', 'editor'] } }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(inRoles), [1, 2, 4]);
      const notIn = await users().findMany({ where: { role: { notIn: ['admin', 'editor'] } }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(notIn), [3, 5]);
      const not = await users().findMany({ where: { role: { not: 'member' } }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(not), [1, 2, 4]);
    });

    it('contains / startsWith / endsWith treat LIKE metacharacters in the VALUE as literals', async () => {
      // escapeLike() must escape % and _ in the bound value on every engine. If
      // it does not, `%Editor_` degrades to a wildcard and matches extra rows.
      assert.deepEqual(ids(await users().findMany({ where: { name: { contains: '%Editor_' } } })), [2]);
      assert.deepEqual(ids(await posts().findMany({ where: { title: { startsWith: '100%' } } })), [4]);
      assert.deepEqual(
        ids(await users().findMany({ where: { name: { endsWith: 'Admin' } }, orderBy: { id: 'asc' } })),
        [1, 4],
      );
      // A bare `_` must not act as "any single character".
      assert.deepEqual(ids(await users().findMany({ where: { name: { contains: '_' } } })), [2]);
    });

    it('mode: insensitive matches across case, and the same query without it does NOT', async () => {
      // Runs against `name_cs`, declared with an explicitly case-SENSITIVE
      // collation on every engine (BINARY / utf8mb4_bin / Latin1_General_CS_AS).
      // Against the ordinary `name` column this assertion cannot fail: SQLite's
      // LIKE is ASCII-case-insensitive by default, MySQL's default collation is
      // *_ai_ci and SQL Server's is *_CI_AS, so a plain LIKE already matches
      // across case and the test would pass with insensitive-mode handling
      // deleted outright. The negative half is what makes it discriminate.
      const insensitive = await users().findMany({ where: { nameCs: { contains: 'alice', mode: 'insensitive' } } });
      assert.deepEqual(ids(insensitive), [1], 'insensitive mode should match "Alice Admin" from "alice"');

      // The negative half is what makes the positive half mean anything, but it
      // is not expressible on every engine, and saying so is the point of this
      // battery. SQLite's LIKE is ASCII-case-insensitive REGARDLESS of the
      // column's collation: collation governs `=` and ORDER BY, not LIKE, so a
      // case-sensitive `contains` needs `PRAGMA case_sensitive_like=ON`, which
      // is a connection-wide setting Turbine deliberately does not touch.
      // That is a real cross-engine divergence in `contains`, recorded here
      // rather than hidden by dropping the assertion everywhere.
      const sensitive = await users().findMany({ where: { nameCs: { contains: 'alice' } } });
      // Both SQLite drivers run the same library, so both behave this way.
      if (h.name === 'sqlite' || h.name === 'better-sqlite3') {
        assert.deepEqual(ids(sensitive), [1], 'sqlite LIKE is case-insensitive by default, so this matches');
      } else {
        assert.deepEqual(sensitive, [], 'without insensitive mode the case-sensitive column must NOT match');
      }
    });

    it('null / not-null filters split the table exactly', async () => {
      const withAvatar = await users().findMany({ where: { avatarUrl: { not: null } }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(withAvatar), [1, 2]);
      const without = await users().findMany({ where: { avatarUrl: null }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(without), [3, 4, 5]);
    });

    it('nested AND / OR / NOT combinators compose', async () => {
      const rows = await users().findMany({
        where: {
          AND: [{ orgId: 1 }, { OR: [{ role: 'admin' }, { role: 'editor' }] }],
          NOT: { email: 'user1@example.com' },
        },
        orderBy: { id: 'asc' },
      });
      assert.deepEqual(ids(rows), [2]);
    });

    it('relation filter `some` matches parents with at least one matching child', async () => {
      const rows = await users().findMany({ where: { posts: { some: { published: 1 } } }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(rows), [1, 2, 4]);
    });

    it('relation filter `none` matches parents with no matching child', async () => {
      const rows = await users().findMany({ where: { posts: { none: {} } }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(rows), [3, 5]);
    });

    it('relation filter `every` includes childless parents (vacuous truth)', async () => {
      const rows = await users().findMany({ where: { posts: { every: { published: 1 } } }, orderBy: { id: 'asc' } });
      // user 1 has an unpublished post (id 3) so is excluded; users 3 and 5 have
      // no posts at all and are included, which is the SQL NOT EXISTS semantics
      // every engine must reproduce.
      assert.deepEqual(ids(rows), [2, 3, 4, 5]);
    });

    it('many-to-many relation filter resolves through the junction table', async () => {
      const rows = await posts().findMany({ where: { tags: { some: { name: 'tech' } } }, orderBy: { id: 'asc' } });
      assert.deepEqual(ids(rows), [1, 2]);
    });

    it('limit + offset paginate deterministically under an explicit order', async () => {
      const page1 = await posts().findMany({ orderBy: { id: 'asc' }, limit: 2 });
      const page2 = await posts().findMany({ orderBy: { id: 'asc' }, limit: 2, offset: 2 });
      assert.deepEqual(ids(page1), [1, 2]);
      assert.deepEqual(ids(page2), [3, 4]);
    });

    // --- relations.ts ------------------------------------------------------

    it('hasMany `with` nests the children under each parent', async () => {
      const rows: UserRow[] = await users().findMany({ where: { id: 1 }, with: { posts: true } });
      assert.equal(rows.length, 1);
      assert.deepEqual(
        ids(rows[0]?.posts ?? []).sort((a, b) => a - b),
        [1, 2, 3],
      );
    });

    it('belongsTo `with` yields a single object, not an array', async () => {
      const rows: PostRow[] = await posts().findMany({ where: { id: 1 }, with: { user: true } });
      assert.ok(rows[0]?.user && !Array.isArray(rows[0].user), 'to-one relation must be an object');
      assert.equal(rows[0]?.user?.name, 'Alice Admin');
    });

    it('a childless parent gets [] for a to-many relation, never null', async () => {
      const rows: UserRow[] = await users().findMany({ where: { id: 3 }, with: { posts: true } });
      assert.deepEqual(rows[0]?.posts, []);
    });

    it('two-level nested `with` parses the whole tree', async () => {
      const rows: UserRow[] = await users().findMany({
        where: { id: 1 },
        with: { posts: { with: { comments: true }, orderBy: { id: 'asc' } } },
      });
      const post1 = rows[0]?.posts?.[0];
      assert.equal(n(post1?.id), 1);
      assert.deepEqual(
        ids(post1?.comments ?? []).sort((a, b) => a - b),
        [1, 2],
      );
    });

    it('per-relation where + orderBy + limit apply per parent row', async () => {
      const rows: UserRow[] = await users().findMany({
        where: { id: 1 },
        with: { posts: { where: { published: 1 }, orderBy: { viewCount: 'desc' }, limit: 1 } },
      });
      assert.equal(rows[0]?.posts?.length, 1);
      assert.equal(n(rows[0]?.posts?.[0]?.id), 1);
    });

    it('per-relation select narrows the child projection to the named fields', async () => {
      const rows: UserRow[] = await users().findMany({
        where: { id: 1 },
        with: { posts: { select: { id: true, title: true } } },
      });
      const child = rows[0]?.posts?.[0] as unknown as Record<string, unknown>;
      assert.deepEqual(Object.keys(child).sort(), ['id', 'title']);
    });

    it('many-to-many `with` loads through the junction', async () => {
      const rows: PostRow[] = await posts().findMany({ where: { id: 1 }, with: { tags: true } });
      assert.deepEqual((rows[0]?.tags ?? []).map((t) => t.name).sort(), ['news', 'tech']);
    });

    it("relationLoadStrategy 'batched' returns byte-for-byte what 'join' returns", async () => {
      // The batched loader is a whole second read path (one flat follow-up query
      // per relation, stitched client-side). Its output is contractually equal
      // to the join plan's, and that contract has only ever been checked on
      // Postgres.
      const args = { orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } } };
      const join = await users().findMany({ ...args, relationLoadStrategy: 'join' });
      const batched = await users().findMany({ ...args, relationLoadStrategy: 'batched' });
      assert.deepEqual(batched, join);
    });

    it('a child row read through a relation equals the same row read directly', async () => {
      // The TIEBREAKER for the test above. "The two strategies disagree" does
      // not say WHICH one is wrong, and the answer is not a matter of taste:
      // the driver's own value for a plain top-level read is the truth, and a
      // relation load is the same row by a different route. Asserting against
      // it names the side that diverged instead of leaving a diff to squint at.
      const direct: PostRow[] = await posts().findMany({ orderBy: { id: 'asc' } });
      const byId = new Map(direct.map((p) => [String(p.id), p]));
      for (const strategy of ['join', 'batched'] as const) {
        const parents: UserRow[] = await users().findMany({
          orderBy: { id: 'asc' },
          with: { posts: { orderBy: { id: 'asc' } } },
          relationLoadStrategy: strategy,
        });
        for (const child of parents.flatMap((u) => u.posts ?? [])) {
          const truth = byId.get(String(child.id));
          assert.ok(truth, `relation returned a post id ${String(child.id)} that a direct read does not have`);
          assert.deepEqual(
            child,
            truth,
            `${h.name}: a post loaded via relationLoadStrategy '${strategy}' differs from the same post read directly`,
          );
        }
      }
    });

    // --- aggregates --------------------------------------------------------

    it('count honours the same where clause findMany does', async () => {
      assert.equal(n(await users().count({ where: { role: 'admin' } })), 2);
      assert.equal(n(await posts().count({ where: { viewCount: { gt: 60 } } })), 2);
    });

    it('aggregate computes _count/_sum/_avg/_min/_max over the filtered set', async () => {
      const agg = await posts().aggregate({
        where: { orgId: 1 },
        _count: true,
        _sum: { viewCount: true },
        _avg: { viewCount: true },
        _min: { viewCount: true },
        _max: { viewCount: true },
      });
      assert.equal(n(agg._count), 4);
      assert.equal(n(agg._sum?.viewCount), 217);
      // Rounded on purpose: 217/4 is 54.25, but SQL Server's AVG over an INT
      // column does INTEGER division and returns 54. That is a documented
      // engine difference in the aggregate's TYPE, not in which rows it read,
      // so the battery asserts the value to the precision every engine agrees on.
      assert.equal(Math.round(n(agg._avg?.viewCount)), 54);
      assert.equal(n(agg._min?.viewCount), 0);
      assert.equal(n(agg._max?.viewCount), 100);
    });

    it('groupBy returns one row per group with its aggregate', async () => {
      const rows = (await posts().groupBy({ by: ['userId'], _count: true, orderBy: { userId: 'asc' } })) as {
        userId: unknown;
        _count: unknown;
      }[];
      assert.deepEqual(
        rows.map((r) => [n(r.userId), n(r._count)]),
        [
          [1, 3],
          [2, 1],
          [4, 1],
        ],
      );
    });

    // --- writes.ts ---------------------------------------------------------

    it('create returns the inserted row with its generated key', async () => {
      const row = await users().create({
        data: { orgId: 1, email: 'new@example.com', name: 'New User', nameCs: 'New User', role: 'member' },
      });
      assert.ok(n(row.id) > 0, 'create must return the generated primary key');
      assert.equal(row.email, 'new@example.com');
      assert.equal(n(await users().count({ where: { email: 'new@example.com' } })), 1);
    });

    it('createMany inserts every row', async () => {
      const created = await users().createMany({
        data: [
          { orgId: 1, email: 'm1@example.com', name: 'M One', nameCs: 'M One', role: 'member' },
          { orgId: 1, email: 'm2@example.com', name: 'M Two', nameCs: 'M Two', role: 'member' },
        ],
      });
      if (h.createManyReturnsRows) assert.equal(created.length, 2);
      // The rows landing is the contract on EVERY engine; MySQL's reselect
      // strategy is count-not-rows, so read back rather than trust the return.
      assert.equal(n(await users().count({ where: { email: { in: ['m1@example.com', 'm2@example.com'] } } })), 2);
    });

    it('update returns the updated row, not the pre-update one', async () => {
      const row = await users().update({ where: { id: 3 }, data: { role: 'editor' } });
      assert.equal(row.role, 'editor');
      const reread = await users().findUnique({ where: { id: 3 } });
      assert.equal(reread?.role, 'editor');
    });

    it('atomic increment reads and writes in one statement', async () => {
      const row = await posts().update({ where: { id: 1 }, data: { viewCount: { increment: 5 } } });
      assert.equal(n(row.viewCount), 105);
    });

    it('updateMany / deleteMany report the number of rows they touched', async () => {
      const updated = await posts().updateMany({ where: { published: 0 }, data: { title: 'Reworked' } });
      assert.equal(n(updated.count), 1);
      // Deleted on comments, not posts: every low-view post is referenced by a
      // comment or a post_tags row, and a real FK violation would be testing the
      // fixture rather than deleteMany.
      const comments = h.client().table('comments');
      const deleted = await comments.deleteMany({ where: { postId: 1 } });
      assert.equal(n(deleted.count), 2);
      assert.equal(n(await comments.count()), COMMENTS.length - 2);
    });

    it('delete returns the row it removed', async () => {
      const row = await posts().delete({ where: { id: 5 } });
      assert.equal(n(row.id), 5);
      assert.equal(await posts().findUnique({ where: { id: 5 } }), null);
    });

    it('upsert inserts when absent and updates when present', async () => {
      const inserted = await users().upsert({
        where: { email: 'ups@example.com' },
        create: { orgId: 1, email: 'ups@example.com', name: 'Upsert One', nameCs: 'Upsert One', role: 'member' },
        update: { name: 'Should Not Happen' },
      });
      assert.equal(inserted.name, 'Upsert One');
      const updated = await users().upsert({
        where: { email: 'ups@example.com' },
        create: {
          orgId: 1,
          email: 'ups@example.com',
          name: 'Should Not Happen',
          nameCs: 'Should Not Happen',
          role: 'member',
        },
        update: { name: 'Upsert Two' },
      });
      assert.equal(updated.name, 'Upsert Two');
      assert.equal(n(await users().count({ where: { email: 'ups@example.com' } })), 1);
    });

    // `upsert` finds the row `where` names. One conflict statement compares
    // `create`'s values instead, so these shapes look the row up first; before
    // that, the first inserted a new row every time, the second updated (or on
    // MySQL, re-read) the wrong row, and the empty update was a syntax error.
    const newUser = (email: string) => ({ orgId: 1, email, name: 'Never', nameCs: 'Never', role: 'member' });

    it('upsert `where: { id }` with a keyless `create` updates that row and inserts nothing', async () => {
      const row = await users().upsert({
        where: { id: 1 },
        create: newUser('never@example.com'),
        update: { name: 'Alice Renamed' },
      });
      assert.equal(n(row.id), 1);
      assert.equal(row.name, 'Alice Renamed');
      assert.equal(n(await users().count()), USERS.length);
    });

    it('upsert `where: { email: a }` with `create: { email: b }` updates and returns a', async () => {
      const row = await users().upsert({
        where: { email: 'user1@example.com' },
        create: newUser('user2@example.com'),
        update: { name: 'Alice Again' },
      });
      assert.equal(row.email, 'user1@example.com');
      assert.equal(row.name, 'Alice Again');
      assert.equal((await users().findUnique({ where: { id: 2 } }))?.name, 'Bob %Editor_');
    });

    it('upsert with an empty `update` returns the row unchanged, and inserts when it is missing', async () => {
      const found = await users().upsert({ where: { id: 1 }, create: newUser('x@example.com'), update: {} });
      assert.equal(found.name, 'Alice Admin');
      const made = await users().upsert({
        where: { email: 'e@example.com' },
        create: newUser('e@example.com'),
        update: {},
      });
      assert.equal(made.email, 'e@example.com');
      assert.equal(n(await users().count()), USERS.length + 1);
    });

    // A unique key plus a column that narrows (`email` beside `name`) is not
    // one conflict target, so it looks the row up by the whole `where`: SQLite
    // rejected `ON CONFLICT ("email", "name")`, and MySQL's target-less
    // `ON DUPLICATE KEY UPDATE` updated the `email` row whatever its name.
    const keyAndName = (email: string, name: string) => ({
      where: { email, name },
      create: { orgId: 1, email, name, nameCs: name, role: 'member' },
      update: { role: 'editor' },
    });

    it('upsert `where: { key, other column }`: a matching row is updated', async () => {
      const row = await users().upsert(keyAndName('user1@example.com', 'Alice Admin'));
      assert.equal(n(row.id), 1);
      assert.equal(row.role, 'editor');
      assert.equal(n(await users().count()), USERS.length);
    });

    it('upsert `where: { key, other column }`: a missing key is inserted', async () => {
      const row = await users().upsert(keyAndName('fresh@example.com', 'Fresh'));
      assert.equal(row.email, 'fresh@example.com');
      assert.equal(row.role, 'member');
      assert.equal(n(await users().count()), USERS.length + 1);
    });

    it('upsert `where: { key, other column }`: a key held by a non-matching row conflicts, unchanged', async () => {
      await assert.rejects(() => users().upsert(keyAndName('user1@example.com', 'Not Alice')), UniqueConstraintError);
      const alice = await users().findUnique({ where: { id: 1 } });
      assert.equal(alice?.name, 'Alice Admin');
      assert.equal(alice?.role, USERS[0]!.role);
      assert.equal(n(await users().count()), USERS.length);
    });

    // MySQL and SQL Server cannot put the filter on their conflict statement,
    // so 0.80 refused this call there (E017). The lookup carries the filter on
    // every engine: another tenant's row is invisible to it, and never updated.
    it('a tenant-filtered upsert runs, and never updates another tenant row', async () => {
      const scoped = await h.filtered({ users: { orgId: 1 } });
      const mine = await scoped
        .table('users')
        .upsert({ where: { id: 1 }, create: newUser('y@example.com'), update: { name: 'Scoped' } });
      assert.equal(mine.name, 'Scoped');
      await assert.rejects(
        () =>
          scoped
            .table('users')
            .upsert({ where: { id: 4 }, create: newUser('user4@example.com'), update: { name: 'Hijack' } }),
        UniqueConstraintError,
      );
      assert.equal((await users().findUnique({ where: { id: 4 } }))?.name, 'Dave Admin');
    });

    it('a unique violation surfaces as UniqueConstraintError (E008), not a raw driver error', async () => {
      await assert.rejects(
        () =>
          users().create({
            data: { orgId: 1, email: 'user1@example.com', name: 'Dup', nameCs: 'Dup', role: 'member' },
          }),
        (err: unknown) => {
          assert.ok(err instanceof UniqueConstraintError, `expected UniqueConstraintError, got ${String(err)}`);
          assert.equal(err.code, 'TURBINE_E008');
          return true;
        },
      );
    });

    it('the empty-where guard refuses a mass mutation on every engine', async () => {
      await assert.rejects(
        () => users().deleteMany({ where: {} }),
        (err: unknown) => err instanceof ValidationError,
      );
      // and the row count is untouched
      assert.equal(n(await users().count()), USERS.length);
    });

    // --- reads that must not silently widen --------------------------------

    it('findUnique on a missing key returns null rather than throwing', async () => {
      assert.equal(await users().findUnique({ where: { id: 9999 } }), null);
    });

    it('select narrows the top-level projection to exactly the named fields', async () => {
      const rows = await users().findMany({ where: { id: 1 }, select: { id: true, email: true } });
      assert.deepEqual(Object.keys(rows[0] as Record<string, unknown>).sort(), ['email', 'id']);
    });

    // --- nested-write.ts ---------------------------------------------------
    //
    // Every case below checks the DATABASE after the write, read straight from
    // the driver (h.raw), not only the tree the write returns: the returned
    // tree is a read the nested-write engine performs itself, so a write that
    // reached the wrong row, or none, can still come back looking right.

    const tasks = () => h.client().table('tasks');
    const profiles = () => h.client().table('profiles');
    /** Rows of a portable query as plain values: integer columns as numbers, text as text. */
    const truth = async (sql: string): Promise<unknown[][]> =>
      (await h.raw(sql)).map((r) =>
        Object.values(r).map((v) =>
          v === null || (typeof v === 'string' && !/^-?\d+$/.test(v)) ? v : n(v as number | string | bigint),
        ),
      );
    const taskOwners = () => truth('SELECT id, assignee_id FROM tasks ORDER BY id');
    // By bio, not id: a generated key is not predictable across reseeds (SQLite
    // AUTOINCREMENT, for one, never reuses an id after a DELETE).
    const profileOwners = () => truth('SELECT bio, user_id FROM profiles ORDER BY bio');
    const userIdByEmail = async (email: string): Promise<number | undefined> => {
      const rows = await truth(`SELECT id FROM users WHERE email = '${email}'`);
      return rows.length === 0 ? undefined : (rows[0]?.[0] as number);
    };
    const newUserData = (email: string) => ({ orgId: 1, email, name: 'Nested', nameCs: 'Nested', role: 'member' });

    it('the unique foreign key introspects as the to-one users.profile, the name PostgreSQL gives it', () => {
      const rel = h.schema().tables.users?.relations.profile;
      assert.equal(rel?.type, 'hasOne');
      assert.equal(rel?.to, 'profiles');
      assert.equal(rel?.foreignKey, 'user_id');
      assert.equal(h.schema().tables.users?.relations.profiles, undefined);
    });

    it('nested create: hasMany rows of mixed shape and a hasOne row land with the new parent key', async () => {
      const made = await users().create({
        data: {
          ...newUserData('nest@example.com'),
          posts: {
            create: [
              { orgId: 1, title: 'Nested A', content: 'a' },
              { orgId: 1, title: 'Nested B', content: 'b', published: 1, viewCount: 7 },
            ],
          },
          tasks: { create: { title: 'Nested task' } },
          profile: { create: { bio: 'Nested bio' } },
        },
      });
      const id = await userIdByEmail('nest@example.com');
      assert.ok(id, 'the parent row must exist');
      assert.equal(n(made.id), id);
      // The omitted fields of the first post take their column defaults, which
      // is what splitting a mixed-shape array into same-shape runs is for.
      assert.deepEqual(
        await truth(
          `SELECT user_id, title, published, view_count FROM posts WHERE title IN ('Nested A', 'Nested B') ORDER BY title`,
        ),
        [
          [id, 'Nested A', 0, 0],
          [id, 'Nested B', 1, 7],
        ],
      );
      assert.deepEqual(await truth(`SELECT assignee_id FROM tasks WHERE title = 'Nested task'`), [[id]]);
      assert.deepEqual(await truth(`SELECT user_id, bio FROM profiles WHERE bio = 'Nested bio'`), [[id, 'Nested bio']]);
      // The returned tree is the rows that landed.
      const postIds = (await truth(`SELECT id FROM posts WHERE user_id = ${id} ORDER BY id`)).map((r) => r[0]);
      assert.deepEqual(
        ids(made.posts).sort((a, b) => a - b),
        postIds,
      );
      assert.equal(made.tasks.length, 1);
      assert.equal(made.profile?.bio, 'Nested bio');
    });

    it('nested create two levels deep writes the grandchildren under the new child', async () => {
      const made = await users().create({
        data: {
          ...newUserData('deep@example.com'),
          posts: {
            create: {
              orgId: 1,
              title: 'Deep post',
              content: 'd',
              comments: {
                create: [
                  { userId: 1, body: 'deep one' },
                  { userId: 2, body: 'deep two' },
                ],
              },
            },
          },
        },
      });
      const id = await userIdByEmail('deep@example.com');
      const [[postId]] = (await truth(`SELECT id FROM posts WHERE user_id = ${id}`)) as [[number]];
      assert.deepEqual(
        await truth(`SELECT post_id, user_id, body FROM comments WHERE post_id = ${postId} ORDER BY body`),
        [
          [postId, 1, 'deep one'],
          [postId, 2, 'deep two'],
        ],
      );
      assert.deepEqual((made.posts[0]?.comments ?? []).map((c: CommentRow) => c.body).sort(), ['deep one', 'deep two']);
    });

    it('nested connect points existing children at the parent, in create and in update', async () => {
      await users().update({ where: { id: 3 }, data: { posts: { connect: { id: 4 } } } });
      assert.deepEqual(await truth('SELECT id, user_id FROM posts ORDER BY id'), [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 3],
        [5, 4],
      ]);
      const made = await users().create({
        data: { ...newUserData('conn@example.com'), tasks: { connect: [{ id: 4 }, { id: 3 }] } },
      });
      const id = await userIdByEmail('conn@example.com');
      assert.deepEqual(await taskOwners(), [
        [1, 1],
        [2, 1],
        [3, id],
        [4, id],
        [5, 5],
      ]);
      assert.deepEqual(ids(made.tasks).sort(), [3, 4]);
    });

    it('nested connectOrCreate connects the row that exists and creates the one that does not', async () => {
      await users().update({
        where: { id: 3 },
        data: {
          tasks: {
            connectOrCreate: [
              { where: { title: 'Unassigned' }, create: { title: 'Unassigned' } },
              { where: { title: 'Fresh task' }, create: { title: 'Fresh task' } },
            ],
          },
        },
      });
      assert.deepEqual(await truth('SELECT title, assignee_id FROM tasks WHERE assignee_id = 3 ORDER BY title'), [
        ['Fresh task', 3],
        ['Unassigned', 3],
      ]);
      assert.equal(n((await truth('SELECT COUNT(*) FROM tasks'))[0]?.[0]), TASKS.length + 1);
    });

    it('nested update changes the owned child only, and refuses a child of another parent', async () => {
      await users().update({
        where: { id: 1 },
        data: {
          posts: { update: { where: { id: 2 }, data: { title: 'Second Renamed', viewCount: { increment: 5 } } } },
        },
      });
      assert.deepEqual(await truth('SELECT title, view_count FROM posts WHERE id = 2'), [['Second Renamed', 80]]);
      await assert.rejects(
        () =>
          users().update({
            where: { id: 1 },
            data: { posts: { update: { where: { id: 4 }, data: { title: 'Hijack' } } } },
          }),
        NotFoundError,
      );
      assert.deepEqual(await truth('SELECT title FROM posts WHERE id = 4'), [['100% Sure']]);
    });

    it("nested upsert updates an owned child and creates instead of touching another parent's", async () => {
      await users().update({
        where: { id: 1 },
        data: {
          tasks: {
            upsert: [
              { where: { id: 1 }, create: { title: 'Never created' }, update: { title: 'Docs written' } },
              { where: { id: 3 }, create: { title: 'Mine now' }, update: { title: 'Hijacked' } },
            ],
          },
        },
      });
      assert.deepEqual(await truth('SELECT title, assignee_id FROM tasks ORDER BY title'), [
        ['Docs written', 1],
        ['Erin task', 5],
        ['Fix bug', 1],
        ['Mine now', 1],
        ['Review change', 2],
        ['Unassigned', null],
      ]);
    });

    it('nested delete removes the owned child only, and refuses a child of another parent', async () => {
      await users().update({ where: { id: 1 }, data: { tasks: { delete: { id: 2 } } } });
      assert.deepEqual(
        (await taskOwners()).map((r) => r[0]),
        [1, 3, 4, 5],
      );
      await assert.rejects(
        () => users().update({ where: { id: 1 }, data: { tasks: { delete: { id: 3 } } } }),
        NotFoundError,
      );
      assert.deepEqual(
        (await taskOwners()).map((r) => r[0]),
        [1, 3, 4, 5],
      );
    });

    it('nested disconnect clears a nullable foreign key, and refuses a NOT NULL one', async () => {
      await users().update({ where: { id: 1 }, data: { tasks: { disconnect: [{ id: 1 }] } } });
      assert.deepEqual(await taskOwners(), [
        [1, null],
        [2, 1],
        [3, 2],
        [4, null],
        [5, 5],
      ]);
      await assert.rejects(
        () => users().update({ where: { id: 1 }, data: { posts: { disconnect: { id: 1 } } } }),
        ValidationError,
      );
      assert.deepEqual(await truth('SELECT user_id FROM posts WHERE id = 1'), [[1]]);
    });

    it('nested set replaces the whole relation: old children cleared, named ones connected, others untouched', async () => {
      await users().update({ where: { id: 1 }, data: { tasks: { set: [{ id: 3 }, { id: 4 }] } } });
      assert.deepEqual(await taskOwners(), [
        [1, null],
        [2, null],
        [3, 1],
        [4, 1],
        [5, 5],
      ]);
    });

    it('hasOne connect re-points an existing row, and connectOrCreate creates once then connects', async () => {
      await users().update({ where: { id: 3 }, data: { profile: { connect: { id: 2 } } } });
      assert.deepEqual(await profileOwners(), [
        ['Alice bio', 1],
        ['Bob bio', 3],
      ]);
      const cocArgs = { where: { userId: 4 }, create: { bio: 'Dave bio' } };
      await users().update({ where: { id: 4 }, data: { profile: { connectOrCreate: cocArgs } } });
      await users().update({ where: { id: 4 }, data: { profile: { connectOrCreate: cocArgs } } });
      assert.deepEqual(await profileOwners(), [
        ['Alice bio', 1],
        ['Bob bio', 3],
        ['Dave bio', 4],
      ]);
    });

    it('hasOne update and upsert write the related row, creating it when the parent has none', async () => {
      await users().update({
        where: { id: 1 },
        data: { profile: { update: { where: { id: 1 }, data: { bio: 'Alice 2' } } } },
      });
      await users().update({
        where: { id: 2 },
        data: { profile: { upsert: { where: { id: 2 }, create: { bio: 'Never' }, update: { bio: 'Bob 2' } } } },
      });
      await users().update({
        where: { id: 3 },
        data: { profile: { upsert: { where: { id: 999 }, create: { bio: 'Carol bio' }, update: { bio: 'Never' } } } },
      });
      assert.deepEqual(await profileOwners(), [
        ['Alice 2', 1],
        ['Bob 2', 2],
        ['Carol bio', 3],
      ]);
    });

    it('hasOne delete: true removes the related row, and disconnect: true unlinks it', async () => {
      await users().update({ where: { id: 2 }, data: { profile: { delete: true } } });
      await users().update({ where: { id: 1 }, data: { profile: { disconnect: true } } });
      assert.deepEqual(await profileOwners(), [['Alice bio', null]]);
      assert.equal(
        await profiles()
          .count({ where: { userId: 1 } })
          .then(n),
        0,
      );
    });

    it('belongsTo create and connect in a create fold the parent keys into the INSERT', async () => {
      const made: PostRow = await posts().create({
        data: {
          title: 'BT post',
          content: 'x',
          organization: { connect: { id: 2 } },
          user: { create: { orgId: 2, email: 'bt@example.com', name: 'BT', nameCs: 'BT' } },
        },
      });
      const id = await userIdByEmail('bt@example.com');
      assert.ok(id, 'the related row must exist');
      assert.deepEqual(await truth(`SELECT user_id, org_id FROM posts WHERE title = 'BT post'`), [[id, 2]]);
      assert.equal(made.user?.email, 'bt@example.com');
    });

    it('belongsTo connectOrCreate connects an existing row and creates a missing one', async () => {
      await tasks().create({
        data: {
          title: 'COC one',
          user: {
            connectOrCreate: { where: { email: 'user3@example.com' }, create: newUserData('user3@example.com') },
          },
        },
      });
      await tasks().create({
        data: {
          title: 'COC two',
          user: { connectOrCreate: { where: { email: 'coc@example.com' }, create: newUserData('coc@example.com') } },
        },
      });
      const id = await userIdByEmail('coc@example.com');
      assert.ok(id);
      assert.deepEqual(await truth(`SELECT title, assignee_id FROM tasks WHERE title LIKE 'COC%' ORDER BY title`), [
        ['COC one', 3],
        ['COC two', id],
      ]);
      assert.equal(n((await truth('SELECT COUNT(*) FROM users'))[0]?.[0]), USERS.length + 1);
    });

    it('belongsTo connect and update in an update re-point the parent and write the related row', async () => {
      await posts().update({ where: { id: 3 }, data: { user: { connect: { id: 2 } } } });
      assert.deepEqual(await truth('SELECT user_id FROM posts WHERE id = 3'), [[2]]);
      await posts().update({ where: { id: 4 }, data: { user: { update: { data: { name: 'Bob Renamed' } } } } });
      assert.deepEqual(await truth('SELECT id, name FROM users WHERE id IN (1, 2) ORDER BY id'), [
        [1, 'Alice Admin'],
        [2, 'Bob Renamed'],
      ]);
    });

    it('belongsTo upsert updates the row the parent points at, and creates one for a parent pointing nowhere', async () => {
      await tasks().update({
        where: { id: 1 },
        data: {
          user: { upsert: { where: { id: 1 }, create: newUserData('never@example.com'), update: { role: 'owner' } } },
        },
      });
      assert.deepEqual(await truth('SELECT role FROM users WHERE id = 1'), [['owner']]);
      await tasks().update({
        where: { id: 4 },
        data: {
          user: { upsert: { where: { id: 1 }, create: newUserData('ups4@example.com'), update: { role: 'x' } } },
        },
      });
      const id = await userIdByEmail('ups4@example.com');
      assert.ok(id, 'a parent pointing at nothing takes the create branch');
      assert.deepEqual(await truth('SELECT assignee_id FROM tasks WHERE id = 4'), [[id]]);
      assert.deepEqual(await truth('SELECT role FROM users WHERE id = 1'), [['owner']]);
      assert.equal(await userIdByEmail('never@example.com'), undefined);
    });

    it('belongsTo disconnect clears the key; delete also removes the row; a NOT NULL key refuses both', async () => {
      await tasks().update({ where: { id: 1 }, data: { user: { disconnect: true } } });
      await tasks().update({ where: { id: 5 }, data: { user: { delete: true } } });
      assert.deepEqual(await taskOwners(), [
        [1, null],
        [2, 1],
        [3, 2],
        [4, null],
        [5, null],
      ]);
      assert.deepEqual(
        (await truth('SELECT id FROM users ORDER BY id')).map((r) => r[0]),
        [1, 2, 3, 4],
      );
      await assert.rejects(
        () => posts().update({ where: { id: 1 }, data: { user: { disconnect: true } } }),
        ValidationError,
      );
      assert.deepEqual(await truth('SELECT user_id FROM posts WHERE id = 1'), [[1]]);
    });

    it('a nested create that fails on its last child leaves nothing behind', async () => {
      await assert.rejects(
        () =>
          users().create({
            data: {
              ...newUserData('rollback@example.com'),
              posts: { create: { orgId: 1, title: 'Rollback post', content: 'r' } },
              // 'Write docs' is task 1's title, and title is UNIQUE.
              tasks: { create: [{ title: 'Rollback task' }, { title: 'Write docs' }] },
            },
          }),
        UniqueConstraintError,
      );
      assert.equal(await userIdByEmail('rollback@example.com'), undefined);
      assert.deepEqual(await truth(`SELECT id FROM posts WHERE title = 'Rollback post'`), []);
      assert.deepEqual(await truth(`SELECT id FROM tasks WHERE title = 'Rollback task'`), []);
      assert.equal(n((await truth('SELECT COUNT(*) FROM users'))[0]?.[0]), USERS.length);
    });

    it('a nested update that fails after earlier writes rolls back the scalar update and every nested write', async () => {
      await assert.rejects(
        () =>
          users().update({
            where: { id: 1 },
            data: {
              name: 'Changed',
              tasks: { create: { title: 'Rollback task' }, disconnect: { id: 1 } },
              // User 1 already has profile 1, and profiles.user_id is UNIQUE.
              profile: { create: { bio: 'Second profile' } },
            },
          }),
        UniqueConstraintError,
      );
      assert.deepEqual(await truth('SELECT name FROM users WHERE id = 1'), [['Alice Admin']]);
      assert.deepEqual(await truth(`SELECT id FROM tasks WHERE title = 'Rollback task'`), []);
      assert.deepEqual(await taskOwners(), [
        [1, 1],
        [2, 1],
        [3, 2],
        [4, null],
        [5, 5],
      ]);
      assert.deepEqual(await profileOwners(), [
        ['Alice bio', 1],
        ['Bob bio', 2],
      ]);
    });
  });
}

registerBattery(sqliteHarness());
registerBattery(betterSqlite3Harness());
registerBattery(mysqlHarness());
registerBattery(mssqlHarness());
registerBattery(postgresHarness());

// Register native teardown after the existing client teardown hooks.
const sqliteCleanup = sqliteFixtureScope();
