/**
 * turbine-orm/mysql — two-tier tests.
 *
 *  1. **Build-only + mock-driver** (this lane, `test:unit`, NO DB): assert the
 *     real `mysqlDialect` emits MySQL SQL with zero Postgres-token leakage, and
 *     prove the `reselect` result strategy issues the write THEN the re-SELECT
 *     with correctly-bound NAMED params through a mock mysql2 driver. This is the
 *     critical local proof since no MySQL server is available.
 *  2. **Real integration** (gated on `MYSQL_URL` / `MYSQL_TEST_URL`): the full
 *     findMany / nested-with / create(reselect) / upsert / update / delete /
 *     transaction suite against a real MySQL 8. Skips cleanly with no server
 *     (locally) and runs in CI's mysql:8 service container.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { OptimisticLockError, QueryInterface } from '../index.js';
import {
  introspectMysqlWith,
  MysqlPool,
  type MysqlRowExecutor,
  mysqlDialect,
  mysqlTypeToTs,
  turbineMysql,
} from '../mysql.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// ===========================================================================
// Tier 1a — build-only conformance (real mysqlDialect, no DB)
// ===========================================================================

const usersTable = mockTable(
  'users',
  [
    { name: 'id', field: 'id', pgType: 'bigint' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'role', field: 'role', pgType: 'text' },
    { name: 'metadata', field: 'metadata', pgType: 'json' },
    { name: 'embedding', field: 'embedding', pgType: 'vector' },
  ],
  {
    posts: {
      name: 'posts',
      type: 'hasMany',
      from: 'users',
      to: 'posts',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);
const postsTable = mockTable(
  'posts',
  [
    { name: 'id', field: 'id', pgType: 'bigint' },
    { name: 'user_id', field: 'userId', pgType: 'bigint' },
    { name: 'title', field: 'title', pgType: 'text' },
  ],
  {
    author: {
      name: 'author',
      type: 'belongsTo',
      from: 'posts',
      to: 'users',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);
const schema: SchemaMetadata = { tables: { users: usersTable, posts: postsTable }, enums: {} };

function q(): QueryInterface<Record<string, unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: build-only; pool unused.
  return new QueryInterface<Record<string, unknown>>(null as any, 'users', schema, [], { dialect: mysqlDialect });
}

/** Postgres-isms the MySQL engine must NEVER emit, across reads AND writes. */
const FORBIDDEN =
  /json_agg|json_build_object|::json|::int|::float|ILIKE|\$\d|"users"|"posts"|RETURNING|ON CONFLICT|UNNEST|= ANY|!= ALL/;

describe('turbine-orm/mysql — dialect conformance (no Postgres leakage)', () => {
  it('placeholders are NAMED :pN (not positional ?) and identifiers are backticked', () => {
    const sql = q().buildFindMany({ where: { id: 1 }, limit: 1 }).sql;
    assert.match(sql, /:p\d/, 'must use named :pN placeholders');
    assert.match(sql, /`users`/, 'must backtick identifiers');
    assert.doesNotMatch(sql, /\?/, 'must NOT use positional ? placeholders');
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('case-insensitive contains → LOWER() LIKE LOWER(), backticks, :pN, no ILIKE', () => {
    const d = q().buildFindMany({ where: { name: { contains: 'Ada', mode: 'insensitive' } }, limit: 5 });
    assert.match(d.sql, /LOWER\(`name`\) LIKE LOWER\(:p\d\) ESCAPE/);
    // LIMIT is an inline integer literal on MySQL (mysql2's binary protocol sends
    // numbers as DOUBLE, which LIMIT rejects), NOT a :pN param — so it must not
    // appear in params.
    assert.match(d.sql, /LIMIT 5$/);
    assert.doesNotMatch(d.sql, /LIMIT :p\d/);
    assert.doesNotMatch(d.sql, FORBIDDEN);
    assert.deepEqual(d.params, ['%Ada%']);
  });

  it('nested with → JSON_OBJECT / JSON_ARRAYAGG / CAST(... AS JSON) wrap, no json_agg', () => {
    const sql = q().buildFindMany({ with: { posts: { with: { author: true } } } }).sql;
    assert.match(sql, /JSON_ARRAYAGG/);
    assert.match(sql, /JSON_OBJECT\('id', t0\.`id`/);
    assert.match(sql, /COALESCE\(JSON_ARRAYAGG/);
    // nested to-one subresult is CAST(... AS JSON)-wrapped (no string double-encoding)
    assert.match(sql, /COALESCE\(CAST\(\(SELECT JSON_OBJECT/);
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('ordered+limited to-many uses the inner-subquery rewrite (aggSupportsInlineOrderBy=false)', () => {
    const sql = q().buildFindMany({ with: { posts: { orderBy: { title: 'asc' }, limit: 3 } } }).sql;
    // inner subquery alias t0i with ORDER BY / LIMIT before JSON_ARRAYAGG; LIMIT
    // is an inline integer literal on MySQL (not a :pN param).
    assert.match(sql, /FROM \(SELECT .* ORDER BY t0\.`title` ASC LIMIT 3\) t0i/);
    assert.match(sql, /JSON_ARRAYAGG/);
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('IN list → JSON_TABLE single-placeholder (length-stable), no = ANY', () => {
    const d = q().buildFindMany({ where: { role: { in: ['admin', 'editor'] } } });
    assert.match(d.sql, /`role` IN \(SELECT `v` FROM JSON_TABLE\(:p\d, '\$\[\*\]'/);
    assert.deepEqual(d.params, ['["admin","editor"]']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('count → CAST(COUNT(*) AS SIGNED), not ::int', () => {
    const sql = q().buildCount({ where: { role: 'admin' } }).sql;
    assert.match(sql, /CAST\(COUNT\(\*\) AS SIGNED\)/);
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('create → INSERT with no RETURNING, named placeholders', () => {
    const d = q().buildCreate({ data: { id: 1, name: 'Ada' } });
    assert.equal(d.sql, 'INSERT INTO `users` (`id`, `name`) VALUES (:p1, :p2)');
    assert.deepEqual(d.params, [1, 'Ada']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('createMany → multi-row VALUES + ON DUPLICATE KEY UPDATE (skipDuplicates)', () => {
    const d = q().buildCreateMany({
      data: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
      skipDuplicates: true,
    });
    assert.equal(
      d.sql,
      'INSERT INTO `users` (`id`, `name`) VALUES (:p1, :p2), (:p3, :p4) ON DUPLICATE KEY UPDATE `id` = `id`',
    );
    assert.deepEqual(d.params, [1, 'Ada', 2, 'Grace']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('upsert → INSERT ... ON DUPLICATE KEY UPDATE (no ON CONFLICT / RETURNING)', () => {
    const d = q().buildUpsert({ where: { id: 1 }, create: { id: 1, name: 'Ada' }, update: { name: 'Ada L.' } });
    assert.match(d.sql, /^INSERT INTO `users` \(`id`, `name`\) VALUES \(:p1, :p2\) ON DUPLICATE KEY UPDATE/);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('update / delete emit no RETURNING', () => {
    const upd = q().buildUpdate({ where: { id: 1 }, data: { name: 'Ada L.' } }).sql;
    const del = q().buildDelete({ where: { id: 1 } }).sql;
    assert.match(upd, /^UPDATE `users` SET/);
    assert.match(del, /^DELETE FROM `users`/);
    assert.doesNotMatch(`${upd} ${del}`, FORBIDDEN);
  });

  it('JSON containment filter → JSON_CONTAINS', () => {
    const d = q().buildFindMany({ where: { metadata: { contains: { role: 'admin' } } } });
    assert.match(d.sql, /JSON_CONTAINS\(`metadata`, :p\d\)/);
    assert.deepEqual(d.params, ['{"role":"admin"}']);
  });

  it('capability flags + resultStrategy report the MySQL feature set', () => {
    assert.equal(mysqlDialect.name, 'mysql');
    assert.equal(mysqlDialect.resultStrategy, 'reselect');
    assert.equal(mysqlDialect.supportsReturning, false);
    assert.equal(mysqlDialect.supportsVector, false);
    assert.equal(mysqlDialect.supportsListenNotify, false);
    assert.equal(mysqlDialect.supportsRLS, false);
    assert.equal(mysqlDialect.supportsAdvisoryLock, true);
    assert.equal(mysqlDialect.aggSupportsInlineOrderBy, false);
  });

  it('transaction begin composes isolation BEFORE START TRANSACTION', () => {
    assert.equal(mysqlDialect.beginStatement(), 'START TRANSACTION');
    assert.equal(
      mysqlDialect.beginStatement('SERIALIZABLE'),
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; START TRANSACTION',
    );
  });

  it('type mapping: TINYINT(1)→boolean, bigint→number, decimal→string, json→unknown, datetime→Date', () => {
    assert.equal(mysqlTypeToTs('tinyint', false, 'tinyint(1)'), 'boolean');
    assert.equal(mysqlTypeToTs('tinyint', false, 'tinyint(4)'), 'number');
    assert.equal(mysqlTypeToTs('bigint', false), 'number');
    assert.equal(mysqlTypeToTs('decimal', true), 'string | null');
    assert.equal(mysqlTypeToTs('json', false), 'unknown');
    assert.equal(mysqlTypeToTs('datetime', false), 'Date');
    assert.equal(mysqlTypeToTs('varchar', true), 'string | null');
  });

  it('gates pgvector ops behind supportsVector → UnsupportedFeatureError', async () => {
    const { UnsupportedFeatureError } = await import('../errors.js');
    // biome-ignore lint/suspicious/noExplicitAny: exercising the vector orderBy surface
    const vectorArgs: any = { orderBy: { embedding: { distance: { to: [1, 2, 3], metric: 'l2' } } } };
    assert.throws(
      () => q().buildFindMany(vectorArgs),
      (err: unknown) => err instanceof UnsupportedFeatureError && /unsupported on "mysql"/.test((err as Error).message),
    );
  });

  it('no Postgres tokens leak across the full read/write surface', () => {
    const i = q();
    const statements = [
      i.buildFindMany({ where: { name: { contains: 'Ada', mode: 'insensitive' } }, limit: 5 }).sql,
      i.buildFindMany({ with: { posts: { with: { author: true } } } }).sql,
      i.buildFindMany({ with: { posts: { orderBy: { title: 'asc' }, limit: 3 } } }).sql,
      i.buildFindMany({ where: { role: { in: ['a', 'b'] } } }).sql,
      i.buildCreate({ data: { id: 1, name: 'Ada' } }).sql,
      i.buildCreateMany({ data: [{ id: 1, name: 'Ada' }], skipDuplicates: true }).sql,
      i.buildUpsert({ where: { id: 1 }, create: { id: 1, name: 'Ada' }, update: { name: 'L' } }).sql,
      i.buildUpdate({ where: { id: 1 }, data: { name: 'L' } }).sql,
      i.buildDelete({ where: { id: 1 } }).sql,
      i.buildCount().sql,
    ];
    for (const sql of statements) assert.doesNotMatch(sql, FORBIDDEN, `leaked a Postgres token: ${sql}`);
  });
});

// ===========================================================================
// Tier 1b — mock-driver: prove the real MysqlPool binds NAMED params and the
// reselect flow issues write-then-SELECT with correct bindings (no MySQL server)
// ===========================================================================

interface MockCall {
  sql: string;
  binding: unknown;
  method: 'query' | 'execute';
}

/** A fake mysql2 pool/connection that records calls and returns canned rows/headers. */
function fakeMysql2(
  opts: { rowsFor?: (sql: string) => Record<string, unknown>[]; insertId?: number; affectedRows?: number } = {},
) {
  const calls: MockCall[] = [];
  const isSelect = (sql: string) => /^\s*(?:select|show|with)/i.test(sql);
  const run =
    (method: 'query' | 'execute') =>
    async (sql: string, binding?: unknown): Promise<[unknown, unknown]> => {
      calls.push({ sql, binding, method });
      if (isSelect(sql)) return [opts.rowsFor?.(sql) ?? [], []];
      // write → ResultSetHeader
      return [{ affectedRows: opts.affectedRows ?? 1, insertId: opts.insertId ?? 0 }, []];
    };
  const conn = { query: run('query'), execute: run('execute'), release: () => {} };
  const pool = {
    query: run('query'),
    execute: run('execute'),
    getConnection: async () => conn,
    end: async () => {},
  };
  return { pool, calls };
}

function reselectQuery(pool: MysqlPool): QueryInterface<Record<string, unknown>> {
  return new QueryInterface<Record<string, unknown>>(
    // biome-ignore lint/suspicious/noExplicitAny: MysqlPool stands in for pg.Pool
    pool as any,
    'users',
    schema,
    [],
    { dialect: mysqlDialect, preparedStatements: false, sqlCache: false },
  );
}

describe('turbine-orm/mysql — MysqlPool binds NAMED placeholders', () => {
  it('converts positional params into a { p1, p2, ... } object via mysql2 execute()', async () => {
    const { pool, calls } = fakeMysql2({ rowsFor: () => [{ id: 5 }] });
    const mp = new MysqlPool(pool);
    await mp.query('SELECT * FROM `users` WHERE `id` = :p1 AND `org_id` = :p2', [5, 9]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'execute', 'parameterized statements use execute() (prepared)');
    assert.deepEqual(calls[0]!.binding, { p1: 5, p2: 9 });
  });

  it('parameter-less statements use query() with no binding', async () => {
    const { pool, calls } = fakeMysql2();
    const mp = new MysqlPool(pool);
    await mp.query('START TRANSACTION');
    assert.equal(calls[0]!.method, 'query');
    assert.equal(calls[0]!.binding, undefined);
  });

  it('splits the dialect isolation+begin compound across two statements on one connection', async () => {
    const { pool, calls } = fakeMysql2();
    const mp = new MysqlPool(pool);
    const client = await mp.connect();
    await client.query(mysqlDialect.beginStatement('SERIALIZABLE'));
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.sql, 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    assert.equal(calls[1]!.sql, 'START TRANSACTION');
  });

  it('booleans coerce to 1/0 in the binding', async () => {
    const { pool, calls } = fakeMysql2();
    const mp = new MysqlPool(pool);
    await mp.query('UPDATE `posts` SET `published` = :p1 WHERE `id` = :p2', [true, 3]);
    assert.deepEqual(calls[0]!.binding, { p1: 1, p2: 3 });
  });
});

describe('turbine-orm/mysql — reselect result strategy (mock driver)', () => {
  it('create: INSERT (no RETURNING) then SELECT by primary key, NAMED params bound', async () => {
    const { pool, calls } = fakeMysql2({ rowsFor: () => [{ id: 1, name: 'Ada' }] });
    const created = await reselectQuery(new MysqlPool(pool)).create({ data: { id: 1, name: 'Ada' } });

    assert.deepEqual(created, { id: 1, name: 'Ada' });
    assert.equal(calls.length, 2, 'write + reselect SELECT');
    assert.match(calls[0]!.sql, /^INSERT INTO `users`/);
    assert.doesNotMatch(calls[0]!.sql, /RETURNING/);
    assert.deepEqual(calls[0]!.binding, { p1: 1, p2: 'Ada' });
    assert.equal(calls[1]!.sql, 'SELECT * FROM `users` WHERE `id` = :p1');
    assert.deepEqual(calls[1]!.binding, { p1: 1 }, 're-SELECT binds the PK by name');
  });

  it('create without a PK falls back to the driver insertId for the re-SELECT', async () => {
    const { pool, calls } = fakeMysql2({ rowsFor: () => [{ id: 42, name: 'Hopper' }], insertId: 42 });
    const created = await reselectQuery(new MysqlPool(pool)).create({ data: { name: 'Hopper' } });

    assert.deepEqual(created, { id: 42, name: 'Hopper' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1]!.binding, { p1: 42 }, 're-SELECT binds mysql2 insertId');
  });

  it('update: UPDATE then SELECT by the same where', async () => {
    const { pool, calls } = fakeMysql2({ rowsFor: () => [{ id: 1, name: 'Ada L.' }] });
    const updated = await reselectQuery(new MysqlPool(pool)).update({ where: { id: 1 }, data: { name: 'Ada L.' } });

    assert.deepEqual(updated, { id: 1, name: 'Ada L.' });
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.sql, /^UPDATE `users` SET/);
    assert.doesNotMatch(calls[0]!.sql, /RETURNING/);
    assert.equal(calls[1]!.sql, 'SELECT * FROM `users` WHERE `id` = :p1');
  });

  it('delete: SELECT the row first, then DELETE (row is gone after)', async () => {
    const { pool, calls } = fakeMysql2({ rowsFor: () => [{ id: 1, name: 'Ada' }] });
    const deleted = await reselectQuery(new MysqlPool(pool)).delete({ where: { id: 1 } });

    assert.deepEqual(deleted, { id: 1, name: 'Ada' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.sql, 'SELECT * FROM `users` WHERE `id` = :p1', 'pre-SELECT before DELETE');
    assert.match(calls[1]!.sql, /^DELETE FROM `users`/);
  });

  it('optimistic-lock conflict (0 rows updated) throws OptimisticLockError, not the stale row', async () => {
    // reselect engines re-fetch by `where` WITHOUT the version predicate, so a
    // version conflict must be detected from affected-rows — regression guard.
    const versioned: SchemaMetadata = {
      tables: {
        users: mockTable(
          'users',
          [
            { name: 'id', field: 'id', pgType: 'bigint' },
            { name: 'name', field: 'name', pgType: 'text' },
            { name: 'version', field: 'version', pgType: 'integer' },
          ],
          {},
        ),
      },
      enums: {},
    };
    const { pool, calls } = fakeMysql2({ affectedRows: 0, rowsFor: () => [{ id: 1, name: 'stale', version: 8 }] });
    const qi = new QueryInterface<Record<string, unknown>>(
      // biome-ignore lint/suspicious/noExplicitAny: MysqlPool stands in for pg.Pool
      new MysqlPool(pool) as any,
      'users',
      versioned,
      [],
      { dialect: mysqlDialect, preparedStatements: false, sqlCache: false },
    );
    await assert.rejects(
      qi.update({ where: { id: 1 }, data: { name: 'next' }, optimisticLock: { field: 'version', expected: 7 } }),
      (e: unknown) => e instanceof OptimisticLockError && e.versionField === 'version' && e.expectedVersion === 7,
    );
    // Only the version-checked UPDATE ran; the stale re-SELECT must NOT be issued.
    assert.equal(calls.length, 1, 'no re-SELECT after a detected conflict');
    assert.match(calls[0]!.sql, /^UPDATE `users` SET/);
  });
});

describe('turbine-orm/mysql — introspector (mock executor)', () => {
  it('maps information_schema rows into SchemaMetadata (columns, PK, FK relations, m2m, indexes, enums)', async () => {
    // Canned information_schema responses keyed by the leading table name.
    const exec: MysqlRowExecutor = async (sql) => {
      if (/information_schema\.TABLES/.test(sql))
        return [
          { TABLE_NAME: 'organizations' },
          { TABLE_NAME: 'users' },
          { TABLE_NAME: 'posts' },
          { TABLE_NAME: 'post_tags' },
          { TABLE_NAME: 'tags' },
        ];
      if (/information_schema\.COLUMNS/.test(sql))
        return [
          col('organizations', 'id', 'bigint', 'bigint', 'NO', 'PRI', 'auto_increment'),
          col('organizations', 'plan', 'enum', "enum('free','pro')", 'NO', '', ''),
          col('users', 'id', 'bigint', 'bigint', 'NO', 'PRI', 'auto_increment'),
          col('users', 'org_id', 'bigint', 'bigint', 'NO', 'MUL', ''),
          col('users', 'email', 'varchar', 'varchar(255)', 'NO', 'UNI', ''),
          col('users', 'created_at', 'datetime', 'datetime', 'NO', '', ''),
          col('posts', 'id', 'bigint', 'bigint', 'NO', 'PRI', 'auto_increment'),
          col('posts', 'user_id', 'bigint', 'bigint', 'NO', 'MUL', ''),
          col('post_tags', 'post_id', 'bigint', 'bigint', 'NO', 'PRI', ''),
          col('post_tags', 'tag_id', 'bigint', 'bigint', 'NO', 'PRI', ''),
          col('tags', 'id', 'bigint', 'bigint', 'NO', 'PRI', 'auto_increment'),
        ];
      if (/CONSTRAINT_NAME = 'PRIMARY'/.test(sql))
        return [
          pk('organizations', 'id', 1),
          pk('users', 'id', 1),
          pk('posts', 'id', 1),
          pk('tags', 'id', 1),
          pk('post_tags', 'post_id', 1),
          pk('post_tags', 'tag_id', 2),
        ];
      if (/REFERENCED_TABLE_NAME IS NOT NULL/.test(sql))
        return [
          fk('users', 'org_id', 'organizations', 'id', 'fk_users_org', 1),
          fk('posts', 'user_id', 'users', 'id', 'fk_posts_user', 1),
          fk('post_tags', 'post_id', 'posts', 'id', 'fk_pt_post', 1),
          fk('post_tags', 'tag_id', 'tags', 'id', 'fk_pt_tag', 1),
        ];
      if (/information_schema\.STATISTICS/.test(sql))
        return [
          idx('users', 'PRIMARY', 0, 'id', 1),
          idx('users', 'email', 0, 'email', 1),
          idx('users', 'idx_users_org_id', 1, 'org_id', 1),
        ];
      return [];
    };

    const meta = await introspectMysqlWith(exec, 'app');
    assert.deepEqual(Object.keys(meta.tables).sort(), ['organizations', 'post_tags', 'posts', 'tags', 'users']);
    assert.deepEqual(meta.tables.users!.primaryKey, ['id']);
    assert.deepEqual(meta.tables.post_tags!.primaryKey, ['post_id', 'tag_id']);
    assert.equal(meta.tables.users!.reverseColumnMap.org_id, 'orgId');
    assert.ok(meta.tables.users!.dateColumns.has('created_at'));
    // relations
    assert.equal(meta.tables.users!.relations.posts?.type, 'hasMany');
    assert.equal(meta.tables.users!.relations.organization?.type, 'belongsTo');
    assert.equal(meta.tables.posts!.relations.user?.type, 'belongsTo');
    // many-to-many auto-detection through post_tags
    assert.equal(meta.tables.posts!.relations.tags?.type, 'manyToMany');
    assert.equal(meta.tables.posts!.relations.tags?.through?.table, 'post_tags');
    // unique + index + enum
    assert.ok(meta.tables.users!.uniqueColumns.some((c) => c.length === 1 && c[0] === 'email'));
    assert.ok(meta.tables.users!.indexes.some((i) => i.name === 'idx_users_org_id'));
    assert.deepEqual(meta.enums['organizations.plan'], ['free', 'pro']);
  });
});

// Tiny row-builders for the introspector mock.
function col(t: string, c: string, dt: string, ct: string, nn: string, key: string, extra: string) {
  return {
    TABLE_NAME: t,
    COLUMN_NAME: c,
    DATA_TYPE: dt,
    COLUMN_TYPE: ct,
    IS_NULLABLE: nn,
    COLUMN_KEY: key,
    COLUMN_DEFAULT: null,
    EXTRA: extra,
    CHARACTER_MAXIMUM_LENGTH: null,
  };
}
function pk(t: string, c: string, pos: number) {
  return { TABLE_NAME: t, COLUMN_NAME: c, ORDINAL_POSITION: pos };
}
function fk(t: string, c: string, rt: string, rc: string, name: string, pos: number) {
  return {
    TABLE_NAME: t,
    COLUMN_NAME: c,
    REFERENCED_TABLE_NAME: rt,
    REFERENCED_COLUMN_NAME: rc,
    CONSTRAINT_NAME: name,
    ORDINAL_POSITION: pos,
  };
}
function idx(t: string, name: string, nonUnique: number, c: string, seq: number) {
  return { TABLE_NAME: t, INDEX_NAME: name, NON_UNIQUE: nonUnique, COLUMN_NAME: c, SEQ_IN_INDEX: seq };
}

// ===========================================================================
// Tier 2 — real integration tests (gated on MYSQL_URL / MYSQL_TEST_URL)
// ===========================================================================

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const gate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

// MySQL port of src/test/fixtures/seed.sql (+ a tags/post_tags m2m junction).
const DDL = [
  `CREATE TABLE organizations (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(255) NOT NULL UNIQUE,
    plan VARCHAR(50) NOT NULL DEFAULT 'free',
    metadata JSON,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE users (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    org_id BIGINT NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    avatar_url VARCHAR(255),
    last_login_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_posts_org FOREIGN KEY (org_id) REFERENCES organizations(id)
  )`,
  `CREATE INDEX idx_posts_user_id ON posts(user_id)`,
  `CREATE TABLE comments (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
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

const SEED = [
  `INSERT INTO organizations (id, name, slug, plan, metadata) VALUES
    (1, 'Acme Inc', 'acme', 'enterprise', '{"tier":"enterprise"}'),
    (2, 'Beta LLC', 'beta', 'pro', '{"tier":"pro"}')`,
  `INSERT INTO users (id, org_id, email, name, role, avatar_url) VALUES
    (1, 1, 'user1@example.com', 'Alice Admin',  'admin',  'https://a/1.png'),
    (2, 1, 'user2@example.com', 'Bob Editor',   'editor', 'https://a/2.png'),
    (3, 1, 'user3@example.com', 'Carol Member', 'member', NULL),
    (4, 2, 'user4@example.com', 'Dave Admin',   'admin',  NULL)`,
  `INSERT INTO posts (id, user_id, org_id, title, content, published, view_count) VALUES
    (1, 1, 1, 'Hello World',  'First post body', 1, 100),
    (2, 1, 1, 'Second Post',  'More content',    1, 75),
    (3, 1, 1, 'Draft Post',   'Not ready',       0, 0),
    (4, 2, 1, 'Editor Post',  'By the editor',   1, 42),
    (5, 4, 2, 'Org 2 Post',   'Across orgs',     1, 60)`,
  `INSERT INTO comments (post_id, user_id, body) VALUES
    (1, 2, 'Nice post!'), (1, 3, 'I agree'), (2, 2, 'Solid follow up'), (4, 1, 'Approved by admin')`,
  `INSERT INTO tags (id, name) VALUES (1, 'tech'), (2, 'news'), (3, 'draft')`,
  `INSERT INTO post_tags (post_id, tag_id) VALUES (1, 1), (1, 2), (2, 1), (3, 3)`,
];

const ALL_TABLES = ['post_tags', 'comments', 'posts', 'tags', 'users', 'organizations'];

interface UserRow {
  id: number;
  orgId: number;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  posts?: PostRow[];
}
interface PostRow {
  id: number;
  userId: number;
  orgId: number;
  title: string;
  content: string;
  published: number;
  viewCount: number;
  user?: UserRow;
  comments?: CommentRow[];
  tags?: TagRow[];
}
interface CommentRow {
  id: number;
  postId: number;
  userId: number;
  body: string;
  user?: UserRow;
}
interface TagRow {
  id: number;
  name: string;
}

describe('turbine-orm/mysql — integration (real MySQL 8)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool is loaded dynamically only when gated on.
  let rawPool: any;
  let pool: MysqlPool;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, kept loose to avoid importing types into the unit lane
  let client: any;
  let dbSchema: SchemaMetadata;

  gate.before(async () => {
    const { createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    rawPool = createPool({
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      namedPlaceholders: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      timezone: 'Z',
      multipleStatements: false,
      // biome-ignore lint/suspicious/noExplicitAny: mysql2 typeCast field shape
      typeCast: (field: any, next: () => unknown) => (field.type === 'JSON' ? field.string() : next()),
    });
    // The 'connection' event yields the raw (callback) connection even on a
    // mysql2/promise pool, so `.catch()` on its non-thenable query() would throw
    // "result of query that is not a promise" — use the callback form (mirrors
    // the same fix in src/mysql.ts).
    rawPool.on('connection', (conn: { query: (s: string, cb: () => void) => void }) => {
      conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')", () => {});
    });
    pool = new MysqlPool(rawPool);
    // Build the schema once via the introspector (dogfood) after creating tables.
    await resetSchema();
    const dbName = new URL(MYSQL_URL).pathname.replace(/^\//, '');
    dbSchema = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, dbName);
    client = await turbineMysql(pool, dbSchema);
  });

  gate.after(async () => {
    if (!MYSQL_URL) return;
    await dropAll();
    await rawPool.end();
  });

  beforeEach(async () => {
    if (!MYSQL_URL) return;
    await reseed();
  });

  async function dropAll() {
    await rawPool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of ALL_TABLES) await rawPool.query(`DROP TABLE IF EXISTS \`${t}\``);
    await rawPool.query('SET FOREIGN_KEY_CHECKS=1');
  }
  async function resetSchema() {
    await dropAll();
    for (const stmt of DDL) await rawPool.query(stmt);
    for (const stmt of SEED) await rawPool.query(stmt);
  }
  async function reseed() {
    await rawPool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of ALL_TABLES) await rawPool.query(`TRUNCATE TABLE \`${t}\``);
    await rawPool.query('SET FOREIGN_KEY_CHECKS=1');
    for (const stmt of SEED) await rawPool.query(stmt);
  }

  gate.it('introspection discovers tables, PKs, relations, m2m', () => {
    assert.deepEqual(
      Object.keys(dbSchema.tables).sort(),
      ['comments', 'organizations', 'post_tags', 'posts', 'tags', 'users'].sort(),
    );
    assert.deepEqual(dbSchema.tables.post_tags!.primaryKey, ['post_id', 'tag_id']);
    assert.equal(dbSchema.tables.users!.relations.posts?.type, 'hasMany');
    assert.equal(dbSchema.tables.posts!.relations.tags?.type, 'manyToMany');
  });

  gate.it('findMany with where + orderBy + limit', async () => {
    const admins = await client
      .table('users')
      .findMany({ where: { role: 'admin' }, orderBy: { id: 'asc' }, limit: 10 });
    assert.deepEqual(
      admins.map((u: UserRow) => u.id),
      [1, 4],
    );
    assert.equal(admins[0].name, 'Alice Admin');
  });

  gate.it('comparison + IN operators (JSON_TABLE)', async () => {
    const hot = await client.table('posts').findMany({ where: { viewCount: { gt: 50 } } });
    assert.deepEqual(hot.map((p: PostRow) => p.id).sort(), [1, 2, 5]);
    const staff = await client
      .table('users')
      .findMany({ where: { role: { in: ['admin', 'editor'] } }, orderBy: { id: 'asc' } });
    assert.deepEqual(
      staff.map((u: UserRow) => u.role),
      ['admin', 'editor', 'admin'],
    );
  });

  gate.it('case-insensitive contains (LOWER LIKE LOWER)', async () => {
    const found = await client.table('users').findMany({ where: { name: { contains: 'alice', mode: 'insensitive' } } });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, 1);
  });

  gate.it('nested with: deep tree is real objects, not strings (CAST AS JSON wrap)', async () => {
    const users = await client.table('users').findMany({
      where: { id: 1 },
      with: { posts: { with: { comments: { with: { user: true } } } } },
    });
    const alice = users[0];
    assert.ok(Array.isArray(alice.posts));
    assert.equal(alice.posts.length, 3);
    const post = alice.posts.find((p: PostRow) => p.id === 1);
    assert.equal(post.title, 'Hello World');
    assert.ok(Array.isArray(post.comments));
    assert.equal(post.comments.length, 2);
    assert.equal(typeof post.comments[0].user, 'object');
    assert.equal(typeof post.comments[0].user.email, 'string');
    // JSON round-trip proves no embedded strings-of-JSON anywhere.
    const reparsed = JSON.parse(JSON.stringify(alice));
    assert.equal(typeof reparsed.posts[0].comments[0].body, 'string');
  });

  gate.it('belongsTo + manyToMany nesting', async () => {
    const posts = await client.table('posts').findMany({ where: { id: 4 }, with: { user: true } });
    assert.equal(posts[0].user.name, 'Bob Editor');
    assert.ok(!Array.isArray(posts[0].user));
    const tagged = await client.table('posts').findMany({ where: { id: 1 }, with: { tags: true } });
    assert.deepEqual(tagged[0].tags.map((t: TagRow) => t.name).sort(), ['news', 'tech']);
  });

  gate.it('ordered + limited to-many selects the right rows (inner-subquery rewrite)', async () => {
    const users = await client.table('users').findMany({
      where: { id: 1 },
      with: { posts: { orderBy: { viewCount: 'desc' }, limit: 2 } },
    });
    // JSON_ARRAYAGG order is not guaranteed by MySQL, so assert the SET (sorted desc).
    assert.deepEqual(
      users[0].posts.map((p: PostRow) => p.viewCount).sort((a: number, b: number) => b - a),
      [100, 75],
    );
  });

  gate.it('create returns the inserted row with a generated id (reselect via insertId)', async () => {
    const created = await client
      .table('users')
      .create({ data: { orgId: 2, email: 'new@example.com', name: 'New User', role: 'member' } });
    assert.equal(typeof created.id, 'number');
    assert.equal(created.email, 'new@example.com');
    assert.equal(created.role, 'member');
  });

  gate.it('createMany inserts rows; returns an empty array (no RETURNING, documented policy)', async () => {
    const result = await client.table('tags').createMany({ data: [{ name: 'alpha' }, { name: 'beta' }] });
    assert.deepEqual(result, [], 'MySQL createMany returns [] — rows are still inserted');
    const all = await client.table('tags').findMany({ where: { name: { in: ['alpha', 'beta'] } } });
    assert.equal(all.length, 2);
  });

  gate.it('upsert inserts then updates on conflict (ON DUPLICATE KEY UPDATE)', async () => {
    const updated = await client
      .table('tags')
      .upsert({ where: { id: 1 }, create: { id: 1, name: 'tech' }, update: { name: 'technology' } });
    assert.equal(updated.name, 'technology');
  });

  gate.it('update returns the updated row (boolean coerces to 1)', async () => {
    const updated = await client.table('posts').update({ where: { id: 3 }, data: { published: true, viewCount: 5 } });
    assert.equal(updated.id, 3);
    assert.equal(updated.published, 1);
    assert.equal(updated.viewCount, 5);
  });

  gate.it('updateMany / deleteMany return affected counts', async () => {
    const upd = await client.table('posts').updateMany({ where: { orgId: 1 }, data: { viewCount: 0 } });
    assert.equal(upd.count, 4);
    const del = await client.table('comments').deleteMany({ where: { postId: 1 } });
    assert.equal(del.count, 2);
  });

  gate.it('delete returns the removed row (pre-SELECT then DELETE)', async () => {
    const tmp = await client.table('tags').create({ data: { name: 'temp-del' } });
    const removed = await client.table('tags').delete({ where: { id: tmp.id } });
    assert.equal(removed.name, 'temp-del');
    assert.equal(await client.table('tags').findUnique({ where: { id: tmp.id } }), null);
  });

  gate.it('count + aggregate use CAST (not ::int/::float)', async () => {
    assert.equal(await client.table('posts').count({ where: { published: true } }), 4);
    const agg = await client
      .table('posts')
      .aggregate({ _count: true, _sum: { viewCount: true }, _avg: { viewCount: true }, _max: { viewCount: true } });
    assert.equal(agg._count, 5);
    assert.equal(Number(agg._sum.viewCount), 277);
    assert.equal(agg._max.viewCount, 100);
    assert.equal(typeof agg._avg.viewCount, 'number');
  });

  gate.it('groupBy aggregates per group', async () => {
    const groups = await client.table('posts').groupBy({ by: ['userId'], _count: true, orderBy: { userId: 'asc' } });
    const u1 = groups.find((g: { userId: number }) => g.userId === 1);
    assert.equal((u1 as { _count: number })._count, 3);
  });

  gate.it('commits a $transaction and rolls back on throw', async () => {
    await client.$transaction(async (tx: typeof client) => {
      await tx.table('tags').create({ data: { name: 'committed' } });
    });
    assert.equal((await client.table('tags').findMany({ where: { name: 'committed' } })).length, 1);

    await assert.rejects(
      client.$transaction(async (tx: typeof client) => {
        await tx.table('tags').create({ data: { name: 'rolled-back' } });
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal((await client.table('tags').findMany({ where: { name: 'rolled-back' } })).length, 0);
  });

  gate.it('nested savepoint rolls back inner without losing outer', async () => {
    await client.$transaction(async (tx: typeof client) => {
      await tx.table('tags').create({ data: { name: 'outer' } });
      await tx
        .$transaction(async (inner: typeof client) => {
          await inner.table('tags').create({ data: { name: 'inner' } });
          throw new Error('inner-fail');
        })
        .catch(() => {});
    });
    assert.equal((await client.table('tags').findMany({ where: { name: 'outer' } })).length, 1);
    assert.equal((await client.table('tags').findMany({ where: { name: 'inner' } })).length, 0);
  });

  gate.it('UNIQUE violation surfaces a typed error (E008)', async () => {
    await assert.rejects(
      client.table('users').create({ data: { orgId: 1, email: 'user1@example.com', name: 'Dup' } }),
      (err: unknown) => (err as { code?: string }).code === 'TURBINE_E008',
    );
  });

  gate.it('unsupported features throw UnsupportedFeatureError', async () => {
    const { UnsupportedFeatureError } = await import('../errors.js');
    await assert.rejects(
      client.$listen('ch', () => {}),
      UnsupportedFeatureError,
    );
    await assert.rejects(client.$notify('ch', 'x'), UnsupportedFeatureError);
    await assert.rejects(
      client.$transaction(async () => {}, { sessionContext: { 'app.tenant': '1' } }),
      UnsupportedFeatureError,
    );
  });
});
