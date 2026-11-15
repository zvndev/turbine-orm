import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { describe } from 'node:test';
import { resolveConfig } from '../cli/config.js';
import { initSqliteProject } from '../cli/sqlite-project.js';
import { skipGate } from './helpers.js';

const Database: typeof NativeDatabase | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const [major, minor] = process.versions.node.split('.').map(Number);
const sqlite = skipGate(
  !Database || major! < 22 || (major === 22 && minor! < 12),
  'SQLite CLI project workflows require node:sqlite (Node >= 22.12)',
);

async function project(run: (path: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-init-'));
  const previous = process.cwd();
  const url = process.env.DATABASE_URL;
  process.chdir(dir);
  delete process.env.DATABASE_URL;
  try {
    await run(join(dir, 'app.sqlite'));
  } finally {
    process.chdir(previous);
    if (url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = url;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SQLite init classifies actual user tables', () => {
  sqlite.it('preserves reserved-prefix lookalikes without scaffolding an unrelated migration', async () => {
    for (const name of ['sqliteArchive', 'sqlitex_records', 'SQLITEArchive', 'sqliteé_records', '_private_data']) {
      await project(async (path) => {
        const db = new Database!(path);
        db.exec(`CREATE TABLE "${name}"(id INTEGER PRIMARY KEY, value TEXT, bytes BLOB);
          INSERT INTO "${name}" VALUES(1, 'complete 雪', X'00FF10'), (2, NULL, X'');`);
        const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY id`).all();
        db.close();
        const before = readFileSync(path);
        const config = resolveConfig({ engine: 'sqlite', url: path }, {});
        const result = await initSqliteProject(config, { skipGenerate: true });
        assert.equal(result.existingDatabase, true);
        assert.equal(result.generated, undefined);
        assert.deepEqual(readdirSync(config.migrationsDir), [], `${name} is a user table`);
        assert.deepEqual(readFileSync(path), before);
        const reopened = new Database!(path);
        try {
          assert.deepEqual(reopened.prepare(`SELECT * FROM "${name}" ORDER BY id`).all(), rows);
          reopened.exec('BEGIN EXCLUSIVE; ROLLBACK');
        } finally {
          reopened.close();
        }
        const files = result.created.map((file) => [file, readFileSync(file)] as const);
        const repeated = await initSqliteProject(config, { force: true, skipGenerate: true });
        assert.deepEqual(repeated.created, []);
        for (const [file, bytes] of files) assert.deepEqual(readFileSync(file), bytes);
        assert.deepEqual(readFileSync(path), before);
      });
    }
  });

  sqlite.it(
    'keeps empty, native internal-only and migration-journal-only projects eligible for a starter',
    async () => {
      for (const sql of [
        '',
        'CREATE TABLE retired(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO retired DEFAULT VALUES; DROP TABLE retired;',
        'CREATE TABLE _turbine_migrations(id INTEGER PRIMARY KEY, checksum TEXT);',
      ]) {
        await project(async (path) => {
          const db = new Database!(path);
          db.exec(`PRAGMA user_version = 0; ${sql}`);
          const catalog = db.prepare('SELECT type, name FROM sqlite_master ORDER BY name').all();
          db.close();
          const before = readFileSync(path);
          const config = resolveConfig({ engine: 'sqlite', url: path }, {});
          const result = await initSqliteProject(config);
          assert.equal(result.generated, undefined);
          const migrations = readdirSync(config.migrationsDir);
          assert.equal(migrations.length, 1, JSON.stringify(catalog));
          assert.match(readFileSync(join(config.migrationsDir, migrations[0]!), 'utf8'), /CREATE TABLE users/);
          assert.deepEqual(readFileSync(path), before);
        });
      }
    },
  );

  sqlite.it('respects skipSchema for a new empty database and preserves refusals before project writes', async () => {
    await project(async (path) => {
      const config = resolveConfig({ engine: 'sqlite', url: path }, {});
      await assert.rejects(() => initSqliteProject(config, { withSchema: true }), /SQL migrations/);
      assert.equal(existsSync(path), false);
      assert.equal(existsSync('turbine.config.ts'), false);
      const result = await initSqliteProject(config, { skipSchema: true });
      assert.equal(result.existingDatabase, false);
      assert.deepEqual(readdirSync(config.migrationsDir), []);
      assert.equal(result.generated, undefined);
      writeFileSync('caller.txt', 'preserved');
      const before = readFileSync(path);
      await assert.rejects(() => initSqliteProject({ ...config, schema: 'attached' }), /main/);
      assert.equal(readFileSync('caller.txt', 'utf8'), 'preserved');
      assert.deepEqual(readFileSync(path), before);
    });
  });
});
