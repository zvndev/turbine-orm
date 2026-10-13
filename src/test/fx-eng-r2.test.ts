/**
 * Three engine-factory and dialect gaps, no database needed:
 *
 *   - MySQL's LIKE clause named `ESCAPE '\'`, which is an unterminated string
 *     unless the session runs with NO_BACKSLASH_ESCAPES. Turbine sets that mode
 *     only on connections it opens, so every contains / startsWith / endsWith
 *     was a syntax error on a pool the caller supplied. The escape character is
 *     now a dialect property (`likeEscapeCharacter`) that the operand escaper
 *     and the emitted clause both follow; MySQL names `!`.
 *   - The engine factories leaked what they had opened when a later step threw
 *     (the version probe, or the client constructor refusing a config), and
 *     `turbineSqlite(path)` never closed its handle on `disconnect()`.
 *   - The SQLite / MySQL / SQL Server introspectors sent relation-naming notes
 *     to the console whatever `IntrospectOptions.logger` said.
 *
 * The live halves (both MySQL session modes, a process that must exit) are in
 * fx-eng-r2-mysql.integration.test.ts.
 *
 * Run: npx tsx --test src/test/fx-eng-r2.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { type Dialect, postgresDialect } from '../dialect.js';
import { ConnectionError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { TurbineLogEntry, TurbineLogger } from '../logger.js';
import { introspectMssqlWith, MssqlPool, mssqlDialect, turbineMssql } from '../mssql.js';
import { mysqlDialect, turbineMysql } from '../mysql.js';
import { powdbDialect } from '../powdb.js';
import { escapeLike } from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { sqliteDialect } from '../sqlite.js';
import { HAVE_NODE_SQLITE } from './fix-where-engines.js';
import { makeQuery, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: driver doubles and patched prototypes are loosely typed.
type Any = any;

const EMPTY: SchemaMetadata = { tables: {}, enums: {} };
/** A static global filter naming no table: refused by the client CONSTRUCTOR (E003). */
const REFUSED_CONFIG = { globalFilters: { noSuchTable: { id: 1 } } } as never;

// ---------------------------------------------------------------------------
// LIKE escape character
// ---------------------------------------------------------------------------

const DIALECTS: [string, Dialect][] = [
  ['postgresql', postgresDialect],
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
  ['powdb', powdbDialect],
];

const likeDocs = schemaDefToMetadata(
  defineSchema({
    docs: {
      id: { type: 'serial', primaryKey: true },
      title: { type: 'text', notNull: true },
      meta: { type: 'jsonb' },
    },
  }),
);

function docsQuery(dialect: Dialect) {
  return makeQuery<Any>('docs', likeDocs, { warnOnUnlimited: false, dialect });
}

describe('the LIKE escape character and the operand escaper agree on every dialect', () => {
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: every metacharacter, and the escape character itself, is prefixed by the clause's character`, () => {
      const c = dialect.likeEscapeCharacter ?? '\\';
      assert.equal(c.length, 1, 'one character');
      assert.ok(!["'", '%', '_'].includes(c), `"${c}" cannot be a LIKE escape character`);
      const escapeOperand = (v: string) => dialect.escapeLikePattern?.(v) ?? escapeLike(v);
      assert.equal(escapeOperand(`a${c}b%c_d`), `a${c}${c}b${c}%c${c}_d`);
      assert.equal(escapeOperand('plain'), 'plain');
    });

    // PowDB compiles PowQL through its own interface; the SQL builder is not its path.
    if (name === 'powdb') continue;
    it(`${name}: the emitted clause names that character`, () => {
      const c = dialect.likeEscapeCharacter ?? '\\';
      const { sql } = docsQuery(dialect).buildFindMany({ where: { title: { contains: 'x' } } } as never);
      assert.ok(sql.endsWith(`ESCAPE '${c}'`), sql);
    });
  }

  it('MySQL names a character that reads the same with and without NO_BACKSLASH_ESCAPES', () => {
    // The premise of the fix: a backslash in the clause is mode-dependent text.
    assert.equal(mysqlDialect.likeEscapeCharacter, '!');
    assert.equal(postgresDialect.likeEscapeCharacter, undefined, 'absent on PostgreSQL, so no engine inherits it');
    const q = docsQuery(mysqlDialect);
    for (const where of [
      { title: { contains: '100%' } },
      { title: { startsWith: 'a_b' } },
      { title: { endsWith: 'x\\' } },
      { title: { contains: 'BANG!', mode: 'insensitive' } },
      { meta: { path: ['k'], stringContains: '50%' } },
    ]) {
      const { sql } = q.buildFindMany({ where } as never);
      assert.ok(!sql.includes('\\'), `no backslash anywhere in the MySQL statement: ${sql}`);
      assert.match(sql, /ESCAPE '!'$/);
    }
  });

  it('MySQL escapes the operand for `!`, on the build and on the cache-hit path alike', () => {
    const q = docsQuery(mysqlDialect);
    assert.deepEqual(q.buildFindMany({ where: { title: { contains: 'warm' } } } as never).params, ['%warm%']);
    const hit = q.buildFindMany({ where: { title: { contains: 'a!b%c_d\\e' } } } as never);
    assert.equal(q.cacheStats().hits, 1, 'the second build is a template-cache hit');
    // A backslash is an ordinary character under `ESCAPE '!'`, so it is left alone.
    assert.deepEqual(hit.params, ['%a!!b!%c!_d\\e%']);
    assert.deepEqual(q.buildFindMany({ where: { title: { startsWith: '!' } } } as never).params, ['!!%']);
  });
});

describe('MySQL JSON_OBJECT keys read the same in every sql_mode', () => {
  it('a key without a backslash stays a plain quoted literal (byte-identical SQL)', () => {
    assert.equal(mysqlDialect.buildJsonObject([['createdAt', 't0.x']]), "JSON_OBJECT('createdAt', t0.x)");
    assert.equal(mysqlDialect.buildJsonObject([["o'b", 't0.x']]), "JSON_OBJECT('o''b', t0.x)");
  });

  it('a key holding a backslash is written as its UTF-8 bytes', () => {
    // `'a\\b'` is one backslash by default and two under NO_BACKSLASH_ESCAPES.
    assert.equal(
      mysqlDialect.buildJsonObject([['a\\b', 't0.x']]),
      "JSON_OBJECT(CONVERT(X'615c62' USING utf8mb4), t0.x)",
    );
    assert.equal(
      mysqlDialect.buildJsonObject([["we'ird\\", 't0.x']]),
      "JSON_OBJECT(CONVERT(X'7765276972645c' USING utf8mb4), t0.x)",
    );
  });
});

// ---------------------------------------------------------------------------
// Factories close what they opened
// ---------------------------------------------------------------------------

const sqlite = skipGate(!HAVE_NODE_SQLITE, 'requires node:sqlite (Node >= 22.5)');

describe('turbineSqlite closes a handle it opened, and only that one', () => {
  const dir = HAVE_NODE_SQLITE ? mkdtempSync(join(tmpdir(), 'turbine-fx-eng-r2-')) : '';
  after(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  /** Count DatabaseSync.close() calls while `fn` runs (the factory's handle is otherwise unreachable). */
  async function countCloses(fn: () => unknown): Promise<number> {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const original = DatabaseSync.prototype.close;
    let closes = 0;
    DatabaseSync.prototype.close = function (this: unknown) {
      closes++;
      return original.call(this);
    };
    try {
      await fn();
    } finally {
      DatabaseSync.prototype.close = original;
    }
    return closes;
  }

  sqlite.it('a constructor refusal closes the handle opened from a path', async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const closes = await countCloses(() =>
      assert.throws(() => turbineSqlite(join(dir, 'refused.db'), EMPTY, REFUSED_CONFIG), ValidationError),
    );
    assert.equal(closes, 1);
  });

  sqlite.it("a constructor refusal leaves the caller's handle open", async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const handle = new DatabaseSync(':memory:');
    assert.throws(() => turbineSqlite(handle, EMPTY, REFUSED_CONFIG), ValidationError);
    assert.equal(handle.isOpen, true);
    handle.close();
  });

  sqlite.it('disconnect() closes a handle opened from a path, and later queries are refused', async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const db: Any = turbineSqlite(join(dir, 'owned.db'), EMPTY, { warnOnUnlimited: false });
    const handle = db.pool.db;
    assert.deepEqual(await db.raw`SELECT 1 AS one`, [{ one: 1 }]);
    await db.disconnect();
    assert.equal(handle.isOpen, false, 'the handle Turbine opened is closed');
    await assert.rejects(() => db.raw`SELECT 1 AS one`, ConnectionError);
    await db.disconnect(); // idempotent
  });

  sqlite.it('disconnect(options) and end(options) still return the client result', async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const a: Any = turbineSqlite(join(dir, 'a.db'), EMPTY, { warnOnUnlimited: false });
    const b: Any = turbineSqlite(join(dir, 'b.db'), EMPTY, { warnOnUnlimited: false });
    const handles = [a.pool.db, b.pool.db];
    const done = { timedOut: false, forcedConnections: 0 };
    assert.deepEqual([await a.disconnect({ timeoutMs: 1000 }), await b.end({ timeoutMs: 1000 })], [done, done]);
    assert.deepEqual(
      handles.map((h) => h.isOpen),
      [false, false],
    );
  });

  sqlite.it("disconnect() leaves the caller's handle open", async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const handle = new DatabaseSync(':memory:');
    const db: Any = turbineSqlite(handle, EMPTY, { warnOnUnlimited: false });
    await db.disconnect();
    assert.equal(handle.isOpen, true);
    handle.exec('SELECT 1');
    handle.close();
  });
});

describe('turbineMysql ends a pool it built when a later step throws', () => {
  /**
   * Patch the mysql2/promise pool prototype so the factory's own pool answers
   * the version probe without a server, and count `end()` on it.
   */
  async function withPatchedPool(version: string, fn: (ends: () => number) => Promise<void>): Promise<void> {
    const mod: Any = await import('mysql2/promise');
    const createPool = mod.createPool ?? mod.default.createPool;
    const sample = createPool({ host: '127.0.0.1', port: 1 });
    const proto = Object.getPrototypeOf(sample);
    await sample.end();
    const { query, end } = proto;
    let ends = 0;
    proto.query = async () => [[{ v: version }], []];
    proto.end = function (this: unknown) {
      ends++;
      return end.call(this);
    };
    try {
      await fn(() => ends);
    } finally {
      proto.query = query;
      proto.end = end;
    }
  }

  it('on a constructor refusal', async () => {
    await withPatchedPool('8.4.0', async (ends) => {
      await assert.rejects(() => turbineMysql('mysql://root@127.0.0.1:1/none', EMPTY, REFUSED_CONFIG), ValidationError);
      assert.equal(ends(), 1);
    });
  });

  it('on a refused server version', async () => {
    await withPatchedPool('10.11.2-MariaDB', async (ends) => {
      await assert.rejects(() => turbineMysql('mysql://root@127.0.0.1:1/none', EMPTY), ConnectionError);
      assert.equal(ends(), 1);
    });
  });

  it('never ends a pool the caller supplied', async () => {
    let ends = 0;
    const callerPool = {
      getConnection: async () => {
        throw new Error('unused');
      },
      query: async () => [[{ v: '8.4.0' }], []],
      execute: async () => [[], []],
      end: async () => {
        ends++;
      },
    };
    await assert.rejects(() => turbineMysql(callerPool as Any, EMPTY, REFUSED_CONFIG), ValidationError);
    assert.equal(ends, 0);
  });
});

describe('turbineMssql closes a pool it built when a later step throws', () => {
  /** A raw `mssql` pool double that answers the version probe and counts close(). */
  function rawPoolDouble(counter: { closes: number }) {
    return {
      request: () => ({
        input: () => {},
        query: async () => ({ recordset: [{ v: 16 }], rowsAffected: [1] }),
      }),
      close: async () => {
        counter.closes++;
      },
    };
  }

  it('on a constructor refusal', async () => {
    // Through the engine's own loader, so it is the same module instance (and
    // no static specifier needs a declaration file `mssql` does not ship).
    const { default: importOptionalPeer } = await import('../optional-peer-import.cjs');
    const mod: Any = await importOptionalPeer('mssql');
    const ns = mod.default ?? mod;
    const original = ns.ConnectionPool.prototype.connect;
    const counter = { closes: 0 };
    ns.ConnectionPool.prototype.connect = async () => rawPoolDouble(counter);
    try {
      await assert.rejects(() => turbineMssql('mssql://sa:x@127.0.0.1:1/none', EMPTY, REFUSED_CONFIG), ValidationError);
    } finally {
      ns.ConnectionPool.prototype.connect = original;
    }
    assert.equal(counter.closes, 1);
  });

  it('never closes a pool the caller supplied', async () => {
    const counter = { closes: 0 };
    const callerPool = new MssqlPool(rawPoolDouble(counter) as Any, {} as never);
    await assert.rejects(() => turbineMssql(callerPool, EMPTY, REFUSED_CONFIG), ValidationError);
    const rawCaller = rawPoolDouble(counter);
    await assert.rejects(() => turbineMssql(rawCaller as Any, EMPTY, REFUSED_CONFIG), ValidationError);
    assert.equal(counter.closes, 0);
  });
});

// ---------------------------------------------------------------------------
// Introspection notes reach the supplied logger
// ---------------------------------------------------------------------------

/**
 * `posts.author_id` references `users`, and `posts` already has columns named
 * `user` (the relation's derived name) and `author`, so the relation is renamed
 * to `userRel` and a note is logged.
 */
function recordingLogger(): { logger: TurbineLogger; entries: TurbineLogEntry[] } {
  const entries: TurbineLogEntry[] = [];
  const logger: TurbineLogger = {
    warn: (_message, entry) => {
      entries.push(entry);
    },
  };
  return { logger, entries };
}

/** Fail the test if anything reaches the console's warn while `fn` runs. */
async function withoutConsoleWarn<T>(fn: () => Promise<T> | T): Promise<T> {
  const original = console.warn;
  const lines: unknown[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    return await fn();
  } finally {
    console.warn = original;
    assert.deepEqual(lines, [], 'the note went to the console instead of the supplied logger');
  }
}

const RENAMED = 'introspect-relation-renamed';

describe('engine introspectors send relation notes to IntrospectOptions.logger', () => {
  const SQLITE_DDL = [
    'CREATE TABLE users (id INTEGER PRIMARY KEY)',
    'CREATE TABLE posts (id INTEGER PRIMARY KEY, user TEXT, author TEXT, author_id INTEGER REFERENCES users(id))',
  ];

  sqlite.it('SQLite, through introspectSqliteDatabase', async () => {
    const { introspectSqliteDatabase } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const db = new DatabaseSync(':memory:');
    for (const s of SQLITE_DDL) db.exec(s);
    const rec = recordingLogger();
    const schema = await withoutConsoleWarn(() => introspectSqliteDatabase(db, { logger: rec.logger }));
    db.close();
    assert.ok(schema.tables.posts?.relations.userRel, 'the fixture really does rename the relation');
    assert.deepEqual(
      rec.entries.map((e) => e.code),
      [RENAMED],
    );
  });

  sqlite.it('SQLite, end to end through introspect({ dialect, logger })', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-fx-eng-r2-introspect-'));
    try {
      const file = join(dir, 'app.db');
      const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
      const db = new DatabaseSync(file);
      for (const s of SQLITE_DDL) db.exec(s);
      db.close();
      const rec = recordingLogger();
      await withoutConsoleWarn(() =>
        introspect({ connectionString: file, dialect: sqliteDialect, logger: rec.logger }),
      );
      assert.deepEqual(
        rec.entries.map((e) => e.code),
        [RENAMED],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SQL Server, through introspectMssqlWith', async () => {
    const rows = (sql: string): Record<string, unknown>[] => {
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) return [{ TABLE_NAME: 'posts' }, { TABLE_NAME: 'users' }];
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
        const col = (t: string, c: string, type: string) => ({
          TABLE_NAME: t,
          COLUMN_NAME: c,
          DATA_TYPE: type,
          IS_NULLABLE: 'YES',
          COLUMN_DEFAULT: null,
          CHARACTER_MAXIMUM_LENGTH: null,
        });
        return [
          col('posts', 'id', 'int'),
          col('posts', 'user', 'nvarchar'),
          col('posts', 'author', 'nvarchar'),
          col('posts', 'author_id', 'int'),
          col('users', 'id', 'int'),
        ];
      }
      if (sql.includes("'PRIMARY KEY'")) {
        return [
          { TABLE_NAME: 'posts', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 },
          { TABLE_NAME: 'users', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 },
        ];
      }
      if (sql.includes('sys.foreign_keys')) {
        return [
          {
            CONSTRAINT_NAME: 'fk_posts_author',
            TABLE_NAME: 'posts',
            COLUMN_NAME: 'author_id',
            REFERENCED_TABLE_NAME: 'users',
            REFERENCED_COLUMN_NAME: 'id',
            ORDINAL_POSITION: 1,
          },
        ];
      }
      return [];
    };
    const rec = recordingLogger();
    const schema = await withoutConsoleWarn(() =>
      introspectMssqlWith(async (sql) => rows(sql), 'dbo', { logger: rec.logger }),
    );
    assert.ok(schema.tables.posts?.relations.userRel, 'the fixture really does rename the relation');
    assert.deepEqual(
      rec.entries.map((e) => e.code),
      [RENAMED],
    );
  });
});
