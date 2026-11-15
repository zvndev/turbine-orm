/**
 * The unique foreign key to-one, beyond the shapes in
 * relation-unique-fk-parity.test.ts:
 *
 * 1. `legacyToManyUniques: true` restores the earlier output (`users.profiles`,
 *    hasMany) on every entry point that derives relations, and `relationNames`
 *    still renames where it is supported. A rename whose source is the OLD
 *    plural name no longer matches anything, and must say so.
 * 2. Each foreign key is decided on its own. A second foreign key over the same
 *    unique column, to a parent it does not compare cleanly with, stays to-many
 *    without turning the first one to-many too.
 * 3. SQLite: a unique child key referencing a case-folding (NOCASE) parent key
 *    is not a to-one, because two child values ('a', 'A') can reference the one
 *    parent 'a'. node:sqlite and better-sqlite3 used to call it a to-one while
 *    libSQL and D1 did not. A rowid-alias parent key holds only integers, so a
 *    collation elsewhere in the parent never blocks its to-one.
 *
 * Code-first, node:sqlite, libSQL and D1 run in the unit lane; better-sqlite3,
 * PostgreSQL and MySQL under the same gates as the parity file.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import { createClient } from '@libsql/client/node';
import type { BetterSqlite3Database } from '../better-sqlite3.js';
import { introspectD1 } from '../d1/introspect.js';
import { introspect, introspectPostgresCatalog } from '../introspect.js';
import { introspectLibsql } from '../libsql/introspect.js';
import type { LibsqlLocalClient } from '../libsql/pool.js';
import { introspectMssqlWith } from '../mssql.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { executeDdl, withNative } from './fixtures/d1-introspection/native.js';
import { catalogColumn, catalogFixture } from './fixtures/mssql-introspection-metadata.js';
import { skipGate } from './helpers.js';

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const BetterSqlite3: (new (path: string) => BetterSqlite3Database) | undefined = (() => {
  try {
    return createRequire(import.meta.url)(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3');
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const DB_NAME = 'turbine_unique_fk_options';

const sqlite = skipGate(!DatabaseSync, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');
const better = skipGate(!BetterSqlite3, 'requires the optional better-sqlite3 peer (set TURBINE_SQLITE_BINDING_PEER)');
const postgres = skipGate(!DATABASE_URL, 'requires DATABASE_URL pointing at a PostgreSQL server');
const mysql = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const silent = { logger: {} };
const BASIC = [
  'CREATE TABLE users (id INTEGER PRIMARY KEY)',
  'CREATE TABLE profiles (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users (id))',
];
// MySQL ignores an inline REFERENCES, so its foreign key is table-level.
const BASIC_MYSQL = [
  'CREATE TABLE users (id INT PRIMARY KEY)',
  'CREATE TABLE profiles (id INT PRIMARY KEY, user_id INT UNIQUE, FOREIGN KEY (user_id) REFERENCES users (id))',
];
const OBSOLETE_RENAME = /relationNames: table "users" has no relation "profiles"\. Derived relations: profile\./;

/** `users` relations as `name: type`. */
const usersRelations = (schema: SchemaMetadata) =>
  Object.fromEntries(Object.entries(schema.tables.users!.relations).map(([name, rel]) => [name, rel.type]));
const assertDefault = (schema: SchemaMetadata, entry: string) =>
  assert.deepEqual(usersRelations(schema), { profile: 'hasOne' }, `${entry}: default`);
const assertLegacy = (schema: SchemaMetadata, entry: string) =>
  assert.deepEqual(usersRelations(schema), { profiles: 'hasMany' }, `${entry}: legacyToManyUniques`);
/** The relation from `table` to `to`, whatever it is called. */
const relationTo = (schema: SchemaMetadata, table: string, to: string): RelationDef | undefined =>
  Object.values(schema.tables[table]!.relations).find((rel) => rel.to === to);

function withSqliteFile(ddl: string[], check: (file: string) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-unique-fk-'));
    const file = join(dir, 'db.sqlite');
    const db = new DatabaseSync!(file);
    try {
      for (const stmt of ddl) db.exec(stmt);
    } finally {
      db.close();
    }
    try {
      await check(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

async function withLibsql(
  ddl: string[],
  check: (source: { client: LibsqlLocalClient; url: string }, raw: ReturnType<typeof createClient>) => Promise<void>,
) {
  const client = createClient({ url: ':memory:', intMode: 'bigint', concurrency: 1 });
  try {
    for (const stmt of ddl) await client.execute(stmt);
    await check({ client, url: ':memory:' }, client);
  } finally {
    client.close();
  }
}

/** A throwaway MySQL database per call; `MysqlRowExecutor`-shaped `exec`. */
async function withMysql(
  name: string,
  ddl: string[],
  check: (exec: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>, url: string) => Promise<void>,
) {
  const mysql2 = await import('mysql2/promise');
  const { MysqlPool } = await import('../mysql.js');
  const u = new URL(MYSQL_URL);
  const base = {
    host: u.hostname,
    port: u.port ? Number(u.port) : 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
  const database = `${DB_NAME}_${name}`;
  const admin = await mysql2.createConnection(base);
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE \`${database}\``);
  const raw = mysql2.createPool({ ...base, database, namedPlaceholders: true, connectionLimit: 1 });
  try {
    for (const stmt of ddl) await raw.query(stmt);
    const pool = new MysqlPool(raw as never);
    const target = new URL(MYSQL_URL);
    target.pathname = `/${database}`;
    await check(async (sql, params) => (await pool.query(sql, params)).rows, target.toString());
  } finally {
    await raw.end();
    await admin.query(`DROP DATABASE \`${database}\``);
    await admin.end();
  }
}

// ---------------------------------------------------------------------------
// 1. The opt-out and renames
// ---------------------------------------------------------------------------

describe('legacyToManyUniques and relationNames on every entry point', () => {
  it('schemaDefToMetadata', () => {
    const def = defineSchema({
      users: { id: { type: 'integer', primaryKey: true } },
      profiles: {
        id: { type: 'integer', primaryKey: true },
        userId: { type: 'integer', unique: true, references: 'users.id' },
      },
    });
    assertDefault(schemaDefToMetadata(def), 'schemaDefToMetadata');
    assertLegacy(schemaDefToMetadata(def, { legacyToManyUniques: true }), 'schemaDefToMetadata');
  });

  sqlite.it(
    'introspectSqliteDatabase, introspectSqlite and introspect() on node:sqlite',
    withSqliteFile(BASIC, async (file) => {
      const { introspectSqlite, introspectSqliteDatabase, sqliteDialect } = await import('../sqlite.js');
      const db = new DatabaseSync!(file);
      try {
        assertDefault(introspectSqliteDatabase(db, silent), 'introspectSqliteDatabase');
        assertLegacy(
          introspectSqliteDatabase(db, { ...silent, legacyToManyUniques: true }),
          'introspectSqliteDatabase',
        );
      } finally {
        db.close();
      }
      assertDefault(await introspectSqlite({ connectionString: file, ...silent }), 'introspectSqlite');
      assertLegacy(
        await introspectSqlite({ connectionString: file, legacyToManyUniques: true, ...silent }),
        'introspectSqlite',
      );
      const generic = (options: object) =>
        introspect({ connectionString: file, dialect: sqliteDialect, ...silent, ...options });
      assertDefault(await generic({}), 'introspect');
      assertLegacy(await generic({ legacyToManyUniques: true }), 'introspect');
      const renamed = await generic({ relationNames: { users: { profile: 'details' } } });
      assert.equal(renamed.tables.users!.relations.details?.type, 'hasOne');
      const legacyRenamed = await generic({
        legacyToManyUniques: true,
        relationNames: { users: { profiles: 'details' } },
      });
      assert.equal(legacyRenamed.tables.users!.relations.details?.type, 'hasMany');
      await assert.rejects(generic({ relationNames: { users: { profiles: 'details' } } }), OBSOLETE_RENAME);
    }),
  );

  better.it('introspectBetterSqlite3Database', async () => {
    const { introspectBetterSqlite3Database } = await import('../better-sqlite3.js');
    const db = new BetterSqlite3!(':memory:');
    try {
      for (const stmt of BASIC) db.exec(stmt);
      assertDefault(introspectBetterSqlite3Database(db, silent), 'introspectBetterSqlite3Database');
      assertLegacy(
        introspectBetterSqlite3Database(db, { ...silent, legacyToManyUniques: true }),
        'introspectBetterSqlite3Database',
      );
    } finally {
      db.close();
    }
  });

  it('introspectLibsql', async () => {
    await withLibsql(BASIC, async (source) => {
      assertDefault(await introspectLibsql(source, silent), 'introspectLibsql');
      assertLegacy(await introspectLibsql(source, { ...silent, legacyToManyUniques: true }), 'introspectLibsql');
      const renamed = await introspectLibsql(source, { ...silent, relationNames: { users: { profile: 'details' } } });
      assert.equal(renamed.tables.users!.relations.details?.type, 'hasOne');
      await assert.rejects(
        introspectLibsql(source, { ...silent, relationNames: { users: { profiles: 'details' } } }),
        OBSOLETE_RENAME,
      );
    });
  });

  it('introspectD1', async () => {
    await withNative(async (binding) => {
      await executeDdl(binding, BASIC.join(';'));
      assertDefault(await introspectD1(binding, silent), 'introspectD1');
      assertLegacy(await introspectD1(binding, { ...silent, legacyToManyUniques: true }), 'introspectD1');
      const renamed = await introspectD1(binding, { ...silent, relationNames: { users: { profile: 'details' } } });
      assert.equal(renamed.tables.users!.relations.details?.type, 'hasOne');
      await assert.rejects(
        introspectD1(binding, { ...silent, relationNames: { users: { profiles: 'details' } } }),
        OBSOLETE_RENAME,
      );
    });
  });

  it('introspectMssqlWith (catalog fixture)', async () => {
    const fixture = catalogFixture();
    const schema = await introspectMssqlWith(fixture.exec, 'app', silent);
    const legacy = await introspectMssqlWith(fixture.exec, 'app', { ...silent, legacyToManyUniques: true });
    assert.equal(schema.tables.parents!.relations.profile?.type, 'hasOne');
    assert.equal(schema.tables.parents!.relations.profiles, undefined);
    assert.equal(legacy.tables.parents!.relations.profiles?.type, 'hasMany');
    assert.equal(legacy.tables.parents!.relations.profile, undefined);
  });

  mysql.it('introspectMysqlWith, introspectMysql and introspect() on MySQL', async () => {
    const { introspectMysql, introspectMysqlWith, mysqlDialect } = await import('../mysql.js');
    await withMysql('entry', BASIC_MYSQL, async (exec, url) => {
      const database = new URL(url).pathname.slice(1);
      assertDefault(await introspectMysqlWith(exec, database, silent), 'introspectMysqlWith');
      assertLegacy(
        await introspectMysqlWith(exec, database, { ...silent, legacyToManyUniques: true }),
        'introspectMysqlWith',
      );
      assertDefault(await introspectMysql({ connectionString: url, ...silent }), 'introspectMysql');
      assertLegacy(
        await introspectMysql({ connectionString: url, legacyToManyUniques: true, ...silent }),
        'introspectMysql',
      );
      const generic = (options: object) =>
        introspect({ connectionString: url, dialect: mysqlDialect, ...silent, ...options });
      const renamed = await generic({ relationNames: { users: { profile: 'details' } } });
      assert.equal(renamed.tables.users!.relations.details?.type, 'hasOne');
      await assert.rejects(generic({ relationNames: { users: { profiles: 'details' } } }), OBSOLETE_RENAME);
    });
  });

  postgres.it('introspect, introspectPostgresCatalog and the MCP schema tools on PostgreSQL', async () => {
    const { default: pg } = await import('pg');
    const { runReadOnlyTool } = await import('../cli/mcp.js');
    const admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    try {
      const found = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DB_NAME]);
      if (found.rowCount === 0) await admin.query(`CREATE DATABASE ${DB_NAME}`);
    } finally {
      await admin.end();
    }
    const u = new URL(DATABASE_URL);
    u.pathname = `/${DB_NAME}`;
    const url = u.toString();
    const schema = 'ufk_entry';
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    const dir = mkdtempSync(join(tmpdir(), 'turbine-unique-fk-mcp-'));
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.query(`CREATE SCHEMA ${schema}`);
      // Transaction-scoped search_path, so no session state outlives the setup.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('search_path', $1, true)`, [schema]);
      for (const stmt of BASIC) await client.query(stmt);
      await client.query('COMMIT');
      const opts = { connectionString: url, schema, ...silent };
      assertDefault(await introspect(opts), 'introspect');
      assertLegacy(await introspect({ ...opts, legacyToManyUniques: true }), 'introspect');
      assertDefault(await introspectPostgresCatalog(opts), 'introspectPostgresCatalog');
      assertLegacy(
        await introspectPostgresCatalog({ ...opts, legacyToManyUniques: true }),
        'introspectPostgresCatalog',
      );
      const renamed = await introspect({ ...opts, relationNames: { users: { profile: 'details' } } });
      assert.equal(renamed.tables.users!.relations.details?.type, 'hasOne');
      await assert.rejects(introspect({ ...opts, relationNames: { users: { profiles: 'details' } } }), OBSOLETE_RENAME);
      // The MCP server derives its own relations; the opt-out must reach them.
      const mcp = { url, schema, migrationsDir: dir };
      const detail = (await runReadOnlyTool(mcp, 'table_detail', { table: 'users' })) as { relations: RelationDef[] };
      assert.deepEqual(
        detail.relations.map((r) => [r.name, r.type]),
        [['profile', 'hasOne']],
      );
      const legacy = (await runReadOnlyTool({ ...mcp, legacyToManyUniques: true }, 'table_detail', {
        table: 'users',
      })) as { relations: RelationDef[] };
      assert.deepEqual(
        legacy.relations.map((r) => [r.name, r.type]),
        [['profiles', 'hasMany']],
      );
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await client.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Each foreign key is decided on its own
// ---------------------------------------------------------------------------

describe('each foreign key over a unique column is decided on its own', () => {
  // `profiles.user_id` is unique and references both an INTEGER key and a TEXT
  // key. The TEXT one does not compare the way the join does (a TEXT '01' and
  // '1' both match INTEGER 1), so only `codes` stays to-many.
  const MIXED = [
    'CREATE TABLE users (id INTEGER PRIMARY KEY)',
    'CREATE TABLE codes (id TEXT PRIMARY KEY)',
    'CREATE TABLE profiles (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE, FOREIGN KEY (user_id) REFERENCES users (id), FOREIGN KEY (user_id) REFERENCES codes (id))',
  ];
  const assertMixed = (schema: SchemaMetadata, engine: string) => {
    assert.deepEqual(usersRelations(schema), { profile: 'hasOne' }, engine);
    assert.deepEqual(
      Object.entries(schema.tables.codes!.relations).map(([name, rel]) => [name, rel.type]),
      [['profiles', 'hasMany']],
      engine,
    );
  };

  sqlite.it('node:sqlite', async () => {
    const { introspectSqliteDatabase } = await import('../sqlite.js');
    const db = new DatabaseSync!(':memory:');
    try {
      for (const stmt of MIXED) db.exec(stmt);
      assertMixed(introspectSqliteDatabase(db, silent), 'node:sqlite');
    } finally {
      db.close();
    }
  });

  better.it('better-sqlite3', async () => {
    const { introspectBetterSqlite3Database } = await import('../better-sqlite3.js');
    const db = new BetterSqlite3!(':memory:');
    try {
      for (const stmt of MIXED) db.exec(stmt);
      assertMixed(introspectBetterSqlite3Database(db, silent), 'better-sqlite3');
    } finally {
      db.close();
    }
  });

  it('libSQL', async () => {
    await withLibsql(MIXED, async (source) => assertMixed(await introspectLibsql(source, silent), 'libSQL'));
  });

  it('SQL Server (catalog fixture)', async () => {
    // `text_profiles.parent_code` is unique and already references
    // `text_parents.code` (same type and collation). A second key to a parent
    // with a case-insensitive collation does not compare the same way.
    const fixture = catalogFixture();
    fixture.tables.push('ci_parents');
    fixture.columns.push(
      catalogColumn('ci_parents', 'code', {
        DATA_TYPE: 'nvarchar',
        CHARACTER_MAXIMUM_LENGTH: 20,
        NUMERIC_PRECISION: null,
        NUMERIC_SCALE: null,
        COLLATION_NAME: 'Latin1_General_100_CI_AS',
      }),
    );
    fixture.primary.push({ TABLE_NAME: 'ci_parents', COLUMN_NAME: 'code', ORDINAL_POSITION: 1 });
    fixture.foreign.push({
      TABLE_NAME: 'text_profiles',
      COLUMN_NAME: 'parent_code',
      REFERENCED_TABLE_NAME: 'ci_parents',
      REFERENCED_COLUMN_NAME: 'code',
      TABLE_SCHEMA: 'app',
      REFERENCED_TABLE_SCHEMA: 'app',
      CONSTRAINT_NAME: 'FK_text_profiles_ci',
      ORDINAL_POSITION: 1,
    });
    const schema = await introspectMssqlWith(fixture.exec, 'app', silent);
    assert.equal(schema.tables.text_parents!.relations.textProfile?.type, 'hasOne');
    assert.deepEqual(
      Object.entries(schema.tables.ci_parents!.relations).map(([name, rel]) => [name, rel.type]),
      [['textProfiles', 'hasMany']],
    );
  });

  mysql.it('MySQL', async () => {
    const { introspectMysqlWith } = await import('../mysql.js');
    // VARCHAR(20) to VARCHAR(40) is a valid MySQL foreign key, but not the same
    // comparison domain, so only `narrow_codes` gets the to-one.
    const ddl = [
      'CREATE TABLE narrow_codes (code VARCHAR(20) PRIMARY KEY)',
      'CREATE TABLE wide_codes (code VARCHAR(40) PRIMARY KEY)',
      'CREATE TABLE profiles (id INT PRIMARY KEY, code VARCHAR(20) UNIQUE, FOREIGN KEY (code) REFERENCES narrow_codes (code), FOREIGN KEY (code) REFERENCES wide_codes (code))',
    ];
    await withMysql('per_fk', ddl, async (exec, url) => {
      const schema = await introspectMysqlWith(exec, new URL(url).pathname.slice(1), silent);
      assert.deepEqual(
        Object.entries(schema.tables.narrow_codes!.relations).map(([name, rel]) => [name, rel.type]),
        [['profile', 'hasOne']],
      );
      assert.deepEqual(
        Object.entries(schema.tables.wide_codes!.relations).map(([name, rel]) => [name, rel.type]),
        [['profiles', 'hasMany']],
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 3. SQLite: a case-folding parent key
// ---------------------------------------------------------------------------

describe('SQLite: a unique key referencing a case-folding parent key stays to-many', () => {
  const FOLDED = [
    'CREATE TABLE parents (code TEXT COLLATE NOCASE PRIMARY KEY)',
    'CREATE TABLE children (id INTEGER PRIMARY KEY, parent_code TEXT UNIQUE REFERENCES parents (code))',
  ];
  // Both rows satisfy the enforced foreign key, so parent 'a' has two children.
  const ROWS = ["INSERT INTO parents VALUES ('a')", "INSERT INTO children VALUES (1, 'a'), (2, 'A')"];
  const MATCHES = "SELECT COUNT(*) AS n FROM children c JOIN parents p ON p.code = c.parent_code WHERE p.code = 'a'";
  // The control: a rowid-alias parent key holds only integers, so the NOCASE
  // column beside it does not block the to-one.
  const ROWID = [
    'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT COLLATE NOCASE)',
    'CREATE TABLE profiles (id INTEGER PRIMARY KEY, user_id INTEGER UNIQUE REFERENCES users (id))',
  ];
  const assertFolded = (schema: SchemaMetadata, matches: number, engine: string) => {
    assert.equal(matches, 2, `${engine}: both children reference parent 'a'`);
    assert.equal(relationTo(schema, 'parents', 'children')?.type, 'hasMany', engine);
  };

  sqlite.it('node:sqlite', async () => {
    const { introspectSqliteDatabase } = await import('../sqlite.js');
    const db = new DatabaseSync!(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      for (const stmt of [...FOLDED, ...ROWS, ...ROWID]) db.exec(stmt);
      const schema = introspectSqliteDatabase(db, silent);
      assertFolded(schema, Number((db.prepare(MATCHES).get() as { n: number }).n), 'node:sqlite');
      assert.deepEqual(usersRelations(schema), { profile: 'hasOne' });
    } finally {
      db.close();
    }
  });

  better.it('better-sqlite3', async () => {
    const { introspectBetterSqlite3Database } = await import('../better-sqlite3.js');
    const db = new BetterSqlite3!(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      for (const stmt of [...FOLDED, ...ROWS, ...ROWID]) db.exec(stmt);
      const schema = introspectBetterSqlite3Database(db, silent);
      assertFolded(schema, Number((db.prepare(MATCHES).get() as { n: number }).n), 'better-sqlite3');
      assert.deepEqual(usersRelations(schema), { profile: 'hasOne' });
    } finally {
      db.close();
    }
  });

  it('libSQL', async () => {
    await withLibsql(['PRAGMA foreign_keys = ON', ...FOLDED, ...ROWS, ...ROWID], async (source, raw) => {
      const schema = await introspectLibsql(source, silent);
      const matches = Number((await raw.execute(MATCHES)).rows[0]!.n);
      assertFolded(schema, matches, 'libSQL');
      assert.deepEqual(usersRelations(schema), { profile: 'hasOne' });
    });
  });

  it('D1', async () => {
    await withNative(async (binding) => {
      // D1 enforces foreign keys without a PRAGMA.
      await executeDdl(binding, [...FOLDED, ...ROWS, ...ROWID].join(';'));
      const schema = await introspectD1(binding, silent);
      const matches = Number((await binding.prepare(MATCHES).all<{ n: number }>()).results[0]!.n);
      assertFolded(schema, matches, 'D1');
      assert.deepEqual(usersRelations(schema), { profile: 'hasOne' });
    });
  });
});
