/**
 * The live MySQL halves of fx-eng-r2.test.ts:
 *
 *   - Every LIKE operator, a JSON substring filter and a JSON_OBJECT key holding
 *     a backslash read the same on a pool Turbine built (which runs with
 *     NO_BACKSLASH_ESCAPES) and on a pool the caller supplied, with and without
 *     that mode. A caller-supplied pool in the server's default mode used to
 *     fail every `contains` with a syntax error, because the clause was
 *     `ESCAPE '\'`.
 *   - `turbineMysql(url)` whose client constructor refuses the config leaves
 *     nothing open: a process that only makes that call exits on its own.
 *   - The introspector sends its relation note to the supplied logger.
 *
 * Uses the database MYSQL_URL names, and only `fxr2_` tables in it.
 *
 * Run: MYSQL_URL=mysql://root@127.0.0.1:3306/db npx tsx --test src/test/fx-eng-r2-mysql.integration.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { TurbineLogEntry } from '../logger.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: mysql2 pools and clients are loosely typed here.
type Any = any;

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysql = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const def = defineSchema({
  fxr2_notes: {
    id: { type: 'integer', primaryKey: true },
    body: { type: 'text', notNull: true },
    meta: { type: 'json' },
  },
});
const meta = schemaDefToMetadata(def);

const ROWS: [number, string][] = [
  [1, '100% sure'],
  [2, 'a_b'],
  [3, 'back\\slash'],
  [4, 'bang!x'],
  [5, 'plain'],
];

/** Each filter and the ids it must return, whatever the pool's sql_mode. */
const CASES: [string, Record<string, unknown>, number[]][] = [
  ['contains %', { body: { contains: '%' } }, [1]],
  ['contains _', { body: { contains: '_' } }, [2]],
  ['contains a backslash', { body: { contains: '\\' } }, [3]],
  ['contains !', { body: { contains: '!' } }, [4]],
  ['startsWith a backslash prefix', { body: { startsWith: 'back\\s' } }, [3]],
  ['endsWith !x', { body: { endsWith: '!x' } }, [4]],
  ['insensitive contains', { body: { contains: 'SURE', mode: 'insensitive' } }, [1]],
  ['insensitive contains !', { body: { contains: 'BANG!', mode: 'insensitive' } }, [4]],
  ['JSON stringContains %', { meta: { path: ['tag'], stringContains: '0%' } }, [1]],
  ['JSON stringContains !', { meta: { path: ['tag'], stringContains: 'g!' } }, [4]],
];

function connectionConfig(): Record<string, unknown> {
  const url = new URL(MYSQL_URL);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

async function createMysqlPool(noBackslashEscapes: boolean): Promise<Any> {
  const { createPool } = await import('mysql2/promise');
  const pool: Any = createPool({ ...connectionConfig(), namedPlaceholders: true, connectionLimit: 2 });
  if (noBackslashEscapes) {
    // This test's own pool: the mode Turbine sets on the pools it builds.
    pool.on('connection', (conn: { query: (sql: string, cb: () => void) => void }) => {
      conn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')", () => {});
    });
  }
  return pool;
}

describe('MySQL LIKE and JSON keys read the same in both sql_modes', () => {
  mysql.it('on a caller-supplied pool without NO_BACKSLASH_ESCAPES, one with it, and an owned pool', async () => {
    const { mysqlDialect, turbineMysql } = await import('../mysql.js');
    const setup = await createMysqlPool(false);
    try {
      await setup.query('DROP TABLE IF EXISTS `fxr2_notes`');
      for (const stmt of schemaToSQL(def, { dialect: mysqlDialect })) await setup.query(stmt);
      for (const [id, body] of ROWS) {
        await setup.execute('INSERT INTO `fxr2_notes` (id, body, meta) VALUES (?, ?, ?)', [
          id,
          body,
          JSON.stringify({ tag: body }),
        ]);
      }

      const plain = await createMysqlPool(false);
      const nbe = await createMysqlPool(true);
      try {
        // The premise, so this cannot pass vacuously: the two caller pools
        // really are in different modes, and the old clause fails on one.
        await assert.rejects(() => plain.query("SELECT 'x' LIKE 'x' ESCAPE '\\'"), /syntax/i);
        const [[ok]] = await nbe.query("SELECT 'x' LIKE 'x' ESCAPE '\\' AS m");
        assert.equal(Number(ok.m), 1);

        const clients: [string, Any][] = [
          ['caller pool, default mode', await turbineMysql(plain, meta, { warnOnUnlimited: false })],
          ['caller pool, NO_BACKSLASH_ESCAPES', await turbineMysql(nbe, meta, { warnOnUnlimited: false })],
          ['owned pool', await turbineMysql(MYSQL_URL, meta, { warnOnUnlimited: false })],
        ];
        try {
          for (const [label, db] of clients) {
            for (const [name, where, ids] of CASES) {
              const rows = await db.table('fxr2_notes').findMany({ where, orderBy: { id: 'asc' } });
              assert.deepEqual(
                rows.map((r: Any) => r.id),
                ids,
                `${label}: ${name}`,
              );
            }
            const key = 'a\\b';
            const [row] = await db.rawUnsafe(`SELECT ${mysqlDialect.buildJsonObject([[key, '1']])} AS j`);
            const j = typeof row.j === 'string' ? JSON.parse(row.j) : row.j;
            assert.deepEqual(Object.keys(j), [key], `${label}: a JSON_OBJECT key holding a backslash`);
          }
        } finally {
          for (const [, db] of clients) await db.disconnect();
        }
      } finally {
        await plain.end();
        await nbe.end();
      }
    } finally {
      await setup.query('DROP TABLE IF EXISTS `fxr2_notes`');
      await setup.end();
    }
  });
});

describe('turbineMysql(url) leaves nothing open when the client constructor refuses the config', () => {
  mysql.it('a process that only makes that call exits on its own', () => {
    const repoRoot = resolve(import.meta.dirname, '../..');
    const tsxLoader = pathToFileURL(resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
    const mysqlModule = pathToFileURL(resolve(repoRoot, 'src/mysql.ts')).href;
    const dir = mkdtempSync(join(tmpdir(), 'turbine-fx-eng-r2-exit-'));
    try {
      const script = join(dir, 'refused.mts');
      writeFileSync(
        script,
        [
          `import { turbineMysql } from ${JSON.stringify(mysqlModule)};`,
          'try {',
          '  await turbineMysql(process.env.FXR2_MYSQL_URL!, { tables: {}, enums: {} }, {',
          '    globalFilters: { noSuchTable: { id: 1 } },',
          '  } as never);',
          "  console.log('constructed');",
          '} catch (err) {',
          '  console.log((err as { code?: string }).code);',
          '}',
        ].join('\n'),
      );
      const child = spawnSync(process.execPath, ['--import', tsxLoader, script], {
        cwd: repoRoot,
        env: { ...process.env, FXR2_MYSQL_URL: MYSQL_URL },
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(
        child.signal,
        null,
        'the process was still running after 20s: the pool the factory built was left open',
      );
      assert.equal(child.status, 0, child.stderr);
      assert.equal(child.stdout.trim(), 'TURBINE_E003', 'the constructor refused the config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the MySQL introspector sends relation notes to the supplied logger', () => {
  mysql.it('introspectMysqlWith({ logger })', async () => {
    const { introspectMysqlWith, MysqlPool } = await import('../mysql.js');
    const raw = await createMysqlPool(false);
    const pool = new MysqlPool(raw);
    try {
      await raw.query('DROP TABLE IF EXISTS `fxr2_posts`');
      await raw.query('DROP TABLE IF EXISTS `fxr2_users`');
      await raw.query('CREATE TABLE `fxr2_users` (id INT PRIMARY KEY)');
      // The relation from `author_id` would be named `fxr2User`, which the
      // `fxr2_user` column already is, so it is renamed and a note is logged.
      await raw.query(
        'CREATE TABLE `fxr2_posts` (id INT PRIMARY KEY, fxr2_user TEXT, author_id INT, ' +
          'FOREIGN KEY (author_id) REFERENCES `fxr2_users`(id))',
      );
      const entries: TurbineLogEntry[] = [];
      const original = console.warn;
      const consoleLines: unknown[] = [];
      console.warn = (...args: unknown[]) => {
        consoleLines.push(args);
      };
      let schema: Any;
      try {
        schema = await introspectMysqlWith(
          async (sql, params) => (await pool.query(sql, params)).rows,
          String(connectionConfig().database),
          {
            include: ['fxr2_users', 'fxr2_posts'],
            logger: { warn: (_message, entry) => void entries.push(entry) },
          },
        );
      } finally {
        console.warn = original;
      }
      assert.deepEqual(consoleLines, [], 'nothing went to the console');
      assert.ok(schema.tables.fxr2_posts.relations.fxr2UserRel, Object.keys(schema.tables.fxr2_posts.relations).join());
      assert.deepEqual(
        entries.map((e) => e.code),
        ['introspect-relation-renamed'],
      );
    } finally {
      await raw.query('DROP TABLE IF EXISTS `fxr2_posts`');
      await raw.query('DROP TABLE IF EXISTS `fxr2_users`');
      await raw.end();
    }
  });
});
