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
 * SCOPE. Postgres is deliberately absent: it already has the full suite, and
 * adding it here would only duplicate. The engines registered are the ones with
 * no shared coverage at all:
 *   - sqlite   , always (node:sqlite builtin, no server, so this battery runs
 *                in the plain `test:unit` lane on every PR)
 *   - mysql    , when MYSQL_URL is set (CI's mysql:8 service)
 *   - mssql    , when MSSQL_URL is set (CI's SQL Server 2022 service)
 *
 * ISOLATION. The server-backed engines create their OWN database
 * (`turbine_cross`) rather than sharing the one `mysql.test.ts` /
 * `mssql.test.ts` create and drop tables in. Node's test runner executes files
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
import { after, before, beforeEach, describe, it as nodeIt } from 'node:test';
import { UniqueConstraintError, ValidationError } from '../index.js';
import type { SchemaMetadata } from '../schema.js';

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

/** Delete order (children first) shared by every engine's reseed. */
const TABLES_CHILD_FIRST = ['post_tags', 'comments', 'posts', 'tags', 'users', 'organizations'];

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
  /** Reason to skip, or '' to run. */
  skip: string;
  connect(): Promise<void>;
  reseed(): Promise<void>;
  close(): Promise<void>;
  /** biome-ignore lint/suspicious/noExplicitAny: TurbineClient kept loose so this file loads in the unit lane. */
  client(): any;
  schema(): SchemaMetadata;
  /**
   * `createMany` returns the inserted rows everywhere EXCEPT MySQL, whose
   * result strategy is count-not-rows (documented in src/mysql.ts). The battery
   * still asserts the rows LANDED, it just reads them back on MySQL.
   */
  createManyReturnsRows: boolean;
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

function sqliteHarness(): EngineHarness {
  let db: DatabaseSyncType;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, see EngineHarness.
  let c: any;
  let s: SchemaMetadata;
  const lit = (v: unknown) =>
    v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  const insert = (table: string, rows: Record<string, unknown>[]) =>
    rows.map(
      (r) => `INSERT INTO ${table} (${Object.keys(r).join(', ')}) VALUES (${Object.values(r).map(lit).join(', ')});`,
    );
  return {
    name: 'sqlite',
    skip: DatabaseSync ? '' : 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)',
    createManyReturnsRows: true,
    async connect() {
      const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
      // `!` is safe: connect() runs only when `skip` is '', which is exactly
      // the case where the node:sqlite probe above found DatabaseSync.
      db = new DatabaseSync!(':memory:');
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(SQLITE_DDL);
      s = introspectSqliteDatabase(db);
      c = turbineSqlite(db, s);
      await this.reseed();
    },
    async reseed() {
      for (const t of TABLES_CHILD_FIRST) db.exec(`DELETE FROM ${t};`);
      const stmts = [
        ...insert('organizations', ORGS),
        ...insert('users', USERS),
        ...insert('posts', POSTS),
        ...insert('comments', COMMENTS),
        ...insert('tags', TAGS),
        ...insert('post_tags', POST_TAGS),
      ];
      for (const stmt of stmts) db.exec(stmt);
    },
    async close() {
      await c.disconnect();
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
    skip: MYSQL_URL ? '' : 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server',
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
      const pool = new MysqlPool(rawPool);
      s = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'turbine_cross');
      c = await turbineMysql(pool, s);
      await this.reseed();
    },
    async reseed() {
      await rawPool.query('SET FOREIGN_KEY_CHECKS=0');
      for (const t of TABLES_CHILD_FIRST) await rawPool.query(`TRUNCATE TABLE \`${t}\``);
      await rawPool.query('SET FOREIGN_KEY_CHECKS=1');
      for (const [table, rows] of [
        ['organizations', ORGS],
        ['users', USERS],
        ['posts', POSTS],
        ['comments', COMMENTS],
        ['tags', TAGS],
        ['post_tags', POST_TAGS],
      ] as [string, Record<string, unknown>[]][]) {
        const { sql, params } = insert(table, rows);
        await rawPool.query(sql, params);
      }
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
    skip: MSSQL_URL ? '' : 'requires MSSQL_URL pointing at a SQL Server 2016+ instance',
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
      const pool = new MssqlPool(rawPool, mssql.default ?? mssql);
      s = await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo');
      c = await turbineMssql(pool, s);
      await this.reseed();
    },
    async reseed() {
      for (const t of TABLES_CHILD_FIRST) await rawPool.request().batch(`DELETE FROM ${t}`);
      await rawPool.request().batch(insertBatch('organizations', ORGS, true));
      await rawPool.request().batch(insertBatch('users', USERS, true));
      await rawPool.request().batch(insertBatch('posts', POSTS, true));
      await rawPool.request().batch(insertBatch('comments', COMMENTS, true));
      await rawPool.request().batch(insertBatch('tags', TAGS, true));
      await rawPool.request().batch(insertBatch('post_tags', POST_TAGS, false));
    },
    async close() {
      await rawPool.close();
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
  const it: typeof nodeIt = h.skip
    ? (((name: string) => nodeIt(name, { skip: h.skip }, () => {})) as typeof nodeIt)
    : nodeIt;

  describe(`cross-engine correctness: ${h.name}`, () => {
    before(async () => {
      if (h.skip) return;
      await h.connect();
    });
    after(async () => {
      if (h.skip) return;
      await h.close();
    });
    beforeEach(async () => {
      if (h.skip) return;
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
      if (h.name === 'sqlite') {
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
  });
}

registerBattery(sqliteHarness());
registerBattery(mysqlHarness());
registerBattery(mssqlHarness());
