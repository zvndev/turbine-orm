import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it as runtimeIt, type TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createMigration, listMigrationFiles } from '../cli/migrate.js';
import {
  assertSqliteMigrationFiles,
  inspectSqliteMigrationDeploy,
  migrateSqliteDeploy,
  migrateSqliteDown,
  migrateSqliteStatus,
  migrateSqliteUp,
  planSqliteMigrationRollback,
  type SqliteMigrationUpOptions,
} from '../cli/sqlite-migrate.js';
import { sqliteDialect } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const transactionState = (() => {
  if (!native) return false;
  const db = new native.DatabaseSync(':memory:');
  try {
    return typeof db.isTransaction === 'boolean';
  } finally {
    db.close();
  }
})();
const writable = transactionState && !!native && 'setAuthorizer' in native.DatabaseSync.prototype;
const { it: readIt } = skipGate(
  !transactionState,
  'requires node:sqlite readOnly/isTransaction (Node 22.x >= 22.16 or Node >= 24)',
);
const { it } = skipGate(!writable, 'SQLite migration writer requires setAuthorizer/isTransaction (Node >= 24.10)');

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'turbine-sqlite-migrations-'));
  const dir = join(root, 'migrations');
  mkdirSync(dir);
  const filename = join(root, 'db.sqlite');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, dir, filename };
}

function migration(dir: string, name: string, up: string, down = 'DROP TABLE items;') {
  const file = join(dir, `${name}.sql`);
  writeFileSync(file, `-- UP\n${up}\n-- DOWN\n${down}\n`);
  return file;
}
const FIRST = '20260101000000_first';
const SECOND = '20260102000000_second';
const THIRD = '20260103000000_third';
function withDb<T>(filename: string, fn: (db: DatabaseSync) => T): T {
  const db = new native!.DatabaseSync(filename);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
function rows(filename: string) {
  return withDb(filename, (db) => db.prepare('SELECT id, name, checksum FROM _turbine_migrations ORDER BY id').all());
}
function schema(filename: string) {
  return withDb(filename, (db) => db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY name').all());
}
function legacy(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}
function digest(content: string | Buffer) {
  return createHash('sha256').update(content).digest('hex');
}

describe('native SQLite migration lifecycle', () => {
  readIt('missing and existing untracked databases stay byte/schema unchanged under all inspectors', async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER PRIMARY KEY);');
    assert.equal((await migrateSqliteStatus(f.filename, f.dir))[0]?.applied, false);
    assert.equal((await inspectSqliteMigrationDeploy(f.filename, f.dir)).pending.length, 1);
    assert.deepEqual(await planSqliteMigrationRollback(f.filename, f.dir), { toRollback: [], stoppedAt: null });
    assert.equal(existsSync(f.filename), false);
    withDb(f.filename, (db) => db.exec('CREATE TABLE original(id INTEGER); INSERT INTO original VALUES (1)'));
    const beforeSchema = schema(f.filename);
    const before = readFileSync(f.filename);
    const files = readdirSync(f.root);
    await migrateSqliteStatus(f.filename, f.dir);
    await inspectSqliteMigrationDeploy(f.filename, f.dir);
    await planSqliteMigrationRollback(f.filename, f.dir);
    assert.deepEqual(readFileSync(f.filename), before);
    assert.deepEqual(schema(f.filename), beforeSchema);
    assert.deepEqual(readdirSync(f.root), files);
  });

  it('creates, applies, steps, deploys, reports, reruns and rolls back real SQLite SQL', async (t) => {
    const f = fixture(t);
    const created = createMigration(f.dir, 'items', {
      up: 'CREATE TABLE items(id INTEGER PRIMARY KEY);',
      down: 'DROP TABLE items;',
    });
    assert.match(readFileSync(created.path, 'utf8'), /-- UP[\s\S]+-- DOWN/);
    const up = await migrateSqliteUp(f.filename, f.dir);
    assert.equal(up.applied.length, 1);
    assert.deepEqual(up.errors, []);
    assert.equal(rows(f.filename)[0]?.checksum, digest(readFileSync(created.path)));
    assert.equal((await migrateSqliteStatus(f.filename, f.dir))[0]?.checksumValid, true);
    const bytes = readFileSync(f.filename);
    await inspectSqliteMigrationDeploy(f.filename, f.dir);
    await planSqliteMigrationRollback(f.filename, f.dir);
    await migrateSqliteStatus(f.filename, f.dir);
    assert.deepEqual(readFileSync(f.filename), bytes);
    assert.deepEqual((await migrateSqliteDeploy(f.filename, f.dir)).applied, []);
    await assert.rejects(migrateSqliteDown(f.filename, f.dir), /DESTRUCTIVE/);
    const down = await migrateSqliteDown(f.filename, f.dir, { allowDestructive: true });
    assert.equal(down.rolledBack.length, 1);
    assert.deepEqual(rows(f.filename), []);
    assert.equal(
      withDb(f.filename, (db) => db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'items'").get()),
      undefined,
    );
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
  });

  it('uses lexical UP order and reverse application IDs, including out-of-order history', async (t) => {
    const f = fixture(t);
    migration(f.dir, SECOND, 'CREATE TABLE items(id INTEGER PRIMARY KEY);', 'DROP TABLE items;');
    migration(f.dir, THIRD, 'INSERT INTO items VALUES (3);', 'DELETE FROM items WHERE id=3;');
    const first = await migrateSqliteUp(f.filename, f.dir, { step: 1 });
    assert.deepEqual(
      first.applied.map((m) => m.name),
      [SECOND],
    );
    migration(f.dir, FIRST, 'INSERT INTO items VALUES (1);', 'DELETE FROM items WHERE id=1;');
    const preview = await inspectSqliteMigrationDeploy(f.filename, f.dir);
    assert.deepEqual(
      preview.pending.map((m) => m.name),
      [FIRST, THIRD],
    );
    assert.equal(preview.outOfOrder.length, 1);
    const next = await migrateSqliteDeploy(f.filename, f.dir);
    assert.deepEqual(
      next.applied.map((m) => m.name),
      [FIRST, THIRD],
    );
    assert.deepEqual(next.outOfOrder, preview.outOfOrder);
    assert.deepEqual(
      rows(f.filename).map((r) => r.name),
      [SECOND, FIRST, THIRD],
    );
    const plan = await planSqliteMigrationRollback(f.filename, f.dir, { step: 2 });
    assert.deepEqual(
      plan.toRollback.map((m) => m.name),
      [THIRD, FIRST],
    );
    const down = await migrateSqliteDown(f.filename, f.dir, { step: 2, allowDestructive: true });
    assert.deepEqual(
      down.rolledBack.map((m) => m.name),
      [THIRD, FIRST],
    );
    assert.deepEqual(
      rows(f.filename).map((r) => r.name),
      [SECOND],
    );
  });

  it('up refuses data loss and deploy opts in, including SQLite quoted names', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      'CREATE TABLE [items;odd](id INTEGER); INSERT INTO [items;odd] VALUES (1);',
      'DROP TABLE [items;odd];',
    );
    await migrateSqliteUp(f.filename, f.dir);
    migration(f.dir, SECOND, 'DROP TABLE [items;odd];', '-- irreversible');
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
    assert.equal(rows(f.filename).length, 1);
    const result = await migrateSqliteDeploy(f.filename, f.dir);
    assert.equal(result.applied.length, 1);
    assert.ok(result.destructive.length > 0);
  });

  it('SQL failure rolls back the WHOLE selected batch and every tracking write, then retries', async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1);');
    const second = migration(
      f.dir,
      SECOND,
      'INSERT INTO items VALUES(2); INSERT INTO absent VALUES(3);',
      'DELETE FROM items WHERE id=2;',
    );
    const result = await migrateSqliteUp(f.filename, f.dir);
    assert.deepEqual(result.applied, []);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.file.name, SECOND);
    assert.match(result.errors[0]!.error, /absent/);
    assert.deepEqual(schema(f.filename), []);
    writeFileSync(second, '-- UP\nINSERT INTO items VALUES(2);\n-- DOWN\nDELETE FROM items WHERE id=2;');
    assert.equal((await migrateSqliteUp(f.filename, f.dir)).applied.length, 2);
    assert.equal(rows(f.filename).length, 2);
    assert.deepEqual(
      withDb(f.filename, (db) => db.prepare('SELECT id FROM items ORDER BY id').all()).map((r) => r.id),
      [1, 2],
    );
  });

  it('DOWN SQL failure keeps all selected migrations and effects intact', async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER); INSERT INTO items VALUES(1);', 'DELETE FROM absent;');
    migration(f.dir, SECOND, 'INSERT INTO items VALUES(2);', 'DELETE FROM items WHERE id=2;');
    await migrateSqliteUp(f.filename, f.dir);
    const result = await migrateSqliteDown(f.filename, f.dir, { step: 2, allowDestructive: true });
    assert.deepEqual(result.rolledBack, []);
    assert.equal(result.errors.length, 1);
    assert.equal(rows(f.filename).length, 2);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM items').get()?.n),
      2,
    );
  });

  it('does not cross a missing or comment-only DOWN section', async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);', '-- cannot reverse');
    migration(f.dir, SECOND, 'INSERT INTO items VALUES(2);', 'DELETE FROM items WHERE id=2;');
    await migrateSqliteUp(f.filename, f.dir);
    const plan = await planSqliteMigrationRollback(f.filename, f.dir, { step: 2 });
    assert.equal(plan.stoppedAt?.name, FIRST);
    await assert.rejects(
      migrateSqliteDown(f.filename, f.dir, { step: 2, allowDestructive: true }),
      /no migrations rolled back/,
    );
    assert.equal(rows(f.filename).length, 2);
  });

  it('validates exact SHA256 and legacy hashes; inspectors never upgrade old hashes', async (t) => {
    const f = fixture(t);
    const file = migration(
      f.dir,
      FIRST,
      "CREATE TABLE items(id INTEGER, text TEXT); INSERT INTO items VALUES(1, 'é😀');",
    );
    await migrateSqliteUp(f.filename, f.dir);
    const oldHash = legacy(readFileSync(file, 'utf8'));
    withDb(f.filename, (db) => db.prepare('UPDATE _turbine_migrations SET checksum=?').run(oldHash));
    const before = readFileSync(f.filename);
    assert.equal((await migrateSqliteStatus(f.filename, f.dir))[0]?.checksumValid, true);
    assert.deepEqual((await inspectSqliteMigrationDeploy(f.filename, f.dir)).mismatches, []);
    await planSqliteMigrationRollback(f.filename, f.dir);
    assert.equal(rows(f.filename)[0]?.checksum, oldHash);
    assert.deepEqual(readFileSync(f.filename), before);
    await migrateSqliteUp(f.filename, f.dir);
    assert.equal(rows(f.filename)[0]?.checksum, digest(readFileSync(file)));
  });

  it('accepts the existing SQLite dialect tracking schema, column order and UTC timestamps', async (t) => {
    const f = fixture(t);
    const file = migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
    withDb(f.filename, (db) => {
      db.exec(sqliteDialect.buildMigrationTrackingTable('"_turbine_migrations"'));
      db.exec('CREATE TABLE items(id INTEGER);');
      db.prepare('INSERT INTO _turbine_migrations(name,checksum,applied_at) VALUES(?,?,?)').run(
        FIRST,
        legacy(readFileSync(file, 'utf8')),
        '2024-02-03 04:05:06',
      );
    });
    const before = readFileSync(f.filename);
    const status = await migrateSqliteStatus(f.filename, f.dir);
    assert.equal(status[0]?.appliedAt?.toISOString(), '2024-02-03T04:05:06.000Z');
    assert.equal(status[0]?.checksumValid, true);
    assert.deepEqual(readFileSync(f.filename), before);
    assert.deepEqual((await migrateSqliteUp(f.filename, f.dir)).errors, []);
    assert.equal(rows(f.filename)[0]?.checksum, digest(readFileSync(file)));
  });

  it('refuses wrong legacy/empty/SHA256 hashes and missing files, with explicit modified rebaseline', async (t) => {
    const f = fixture(t);
    const file = migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
    await migrateSqliteUp(f.filename, f.dir);
    for (const invalid of ['wronglegacy', '', 'f'.repeat(64)]) {
      withDb(f.filename, (db) => db.prepare('UPDATE _turbine_migrations SET checksum=?').run(invalid));
      assert.equal((await migrateSqliteStatus(f.filename, f.dir))[0]?.checksumValid, false);
      await assert.rejects(migrateSqliteUp(f.filename, f.dir), /drift/i);
      await assert.rejects(planSqliteMigrationRollback(f.filename, f.dir), /drift/i);
      await assert.rejects(migrateSqliteDown(f.filename, f.dir, { allowDestructive: true }), /drift/i);
    }
    const rebase = await migrateSqliteUp(f.filename, f.dir, { allowDrift: true });
    assert.equal(rebase.rebaselined.length, 1);
    assert.equal(rows(f.filename)[0]?.checksum, digest(readFileSync(file)));
    rmSync(file);
    assert.equal((await migrateSqliteStatus(f.filename, f.dir))[0]?.missingFile, true);
    assert.equal((await inspectSqliteMigrationDeploy(f.filename, f.dir)).mismatches[0]?.type, 'missing');
    await assert.rejects(migrateSqliteUp(f.filename, f.dir, { allowDrift: true }), /deleted/i);
    await assert.rejects(
      migrateSqliteDown(f.filename, f.dir, { allowDrift: true, allowDestructive: true }),
      /deleted/i,
    );
  });

  it('refusal and SQL failure do not durably rebaseline or upgrade checksums', async (t) => {
    const f = fixture(t);
    const first = migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
    await migrateSqliteUp(f.filename, f.dir);
    const oldHash = legacy(readFileSync(first, 'utf8'));
    withDb(f.filename, (db) => db.prepare('UPDATE _turbine_migrations SET checksum=?').run(oldHash));
    migration(f.dir, SECOND, 'DROP TABLE items; SELECT * FROM missing;');
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
    assert.equal(rows(f.filename)[0]?.checksum, oldHash);
    const failed = await migrateSqliteDeploy(f.filename, f.dir, { allowDrift: true });
    assert.equal(failed.errors.length, 1);
    assert.deepEqual(failed.rebaselined, []);
    assert.equal(rows(f.filename)[0]?.checksum, oldHash);
  });

  it('enforces immediate and deferred foreign keys and native cascading rollback', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      `CREATE TABLE parent(id INTEGER PRIMARY KEY);
      CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE);
      INSERT INTO parent VALUES(1); INSERT INTO child VALUES(1,1);`,
      'DROP TABLE child; DROP TABLE parent;',
    );
    assert.deepEqual((await migrateSqliteUp(f.filename, f.dir)).errors, []);
    const file = migration(f.dir, SECOND, 'INSERT INTO child VALUES(2,99);');
    assert.match((await migrateSqliteUp(f.filename, f.dir)).errors[0]!.error, /FOREIGN KEY/);
    writeFileSync(
      file,
      '-- UP\nCREATE TABLE deferred(parent_id REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED); INSERT INTO deferred VALUES(99);\n-- DOWN\nDROP TABLE deferred;',
    );
    assert.match((await migrateSqliteUp(f.filename, f.dir)).errors[0]!.error, /FOREIGN KEY/);
    assert.equal(
      withDb(f.filename, (db) => db.prepare("SELECT 1 FROM sqlite_schema WHERE name='deferred'").get()),
      undefined,
    );
    writeFileSync(file, '-- UP\nDELETE FROM parent WHERE id=1;\n-- DOWN\nSELECT 1;');
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
    assert.deepEqual((await migrateSqliteDeploy(f.filename, f.dir)).errors, []);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM child').get()?.n),
      0,
    );
  });

  for (const sql of [
    'COMMIT;',
    'END;',
    'BEGIN;',
    'ROLLBACK;',
    'SAVEPOINT own;',
    'RELEASE own;',
    'PRAGMA foreign_keys=OFF;',
    'PRAGMA writable_schema=ON;',
    "ATTACH ':memory:' AS other;",
    'DETACH main;',
  ]) {
    it(`refuses transaction/dialect control: ${sql}`, async (t) => {
      const f = fixture(t);
      migration(f.dir, FIRST, `CREATE TABLE items(id INTEGER); ${sql}`);
      await assert.rejects(migrateSqliteDeploy(f.filename, f.dir), /transaction|PRAGMA|ATTACH|unsupported/i);
      assert.deepEqual(schema(f.filename), []);
      rmSync(join(f.dir, `${FIRST}.sql`));
      migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
      assert.equal((await migrateSqliteUp(f.filename, f.dir)).applied.length, 1);
    });
  }

  for (const sql of [
    "DELETE FROM '_turbine_migrations';",
    'DROP TABLE [_turbine_migrations];',
    'ALTER TABLE `_turbine_migrations` RENAME TO history;',
    'CREATE TEMP TABLE _turbine_migrations(id);',
    'CREATE TRIGGER steal AFTER INSERT ON items BEGIN DELETE FROM _turbine_migrations; END; INSERT INTO items VALUES(1);',
    'CREATE TRIGGER history_trigger AFTER INSERT ON _turbine_migrations BEGIN SELECT 1; END;',
    'CREATE TABLE evil(ref REFERENCES _turbine_migrations(id) ON DELETE CASCADE);',
    "UPDATE sqlite_sequence SET seq=100000 WHERE name='_turbine_migrations';",
  ]) {
    it(`protects history from user SQL: ${sql.slice(0, 60)}`, async (t) => {
      const f = fixture(t);
      migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
      await migrateSqliteUp(f.filename, f.dir);
      const before = rows(f.filename);
      migration(f.dir, SECOND, sql);
      await assert.rejects(migrateSqliteDeploy(f.filename, f.dir), /tracking metadata|must not reference/);
      assert.deepEqual(rows(f.filename), before);
      assert.equal(
        withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM items').get()?.n),
        0,
      );
    });
  }

  it('refuses no-transaction/empty sections and bad options before any effects', async (t) => {
    const f = fixture(t);
    writeFileSync(join(f.dir, `${FIRST}.sql`), '-- turbine:no-transaction\n-- UP\nCREATE TABLE items(id);');
    await assert.rejects(migrateSqliteDeploy(f.filename, f.dir), /no-transaction/);
    assert.deepEqual(schema(f.filename), []);
    writeFileSync(join(f.dir, `${FIRST}.sql`), '-- UP\n-- todo\n-- DOWN\nSELECT 1;');
    await assert.rejects(migrateSqliteDeploy(f.filename, f.dir), /no executable UP/);
    for (const options of [
      { schema: 'public' },
      { schema: '' },
      { adapter: {} },
      { dialect: {} },
      { step: 0 },
      { step: -1 },
      { step: NaN },
      { step: 1.5 },
      { lockWaitMs: -1 },
      { lockWaitMs: Infinity },
    ]) {
      const missing = join(f.root, 'must-not-create.sqlite');
      await assert.rejects(migrateSqliteUp(missing, f.dir, options as SqliteMigrationUpOptions));
      assert.equal(existsSync(missing), false);
    }
    await assert.rejects(migrateSqliteUp('postgresql://example/db', f.dir), /filename/);
    await assert.rejects(migrateSqliteStatus(f.filename, f.dir, { schema: 'public' }), /main/);
    await assert.rejects(migrateSqliteStatus(f.filename, f.dir, { dialect: {} } as never), /dialect/);
  });

  it('refuses malformed tracking tables and triggers without changing bytes', async (t) => {
    const f = fixture(t);
    withDb(f.filename, (db) =>
      db.exec('CREATE TABLE _turbine_migrations(id INTEGER, name TEXT, applied_at TEXT, checksum TEXT);'),
    );
    const before = readFileSync(f.filename);
    await assert.rejects(migrateSqliteStatus(f.filename, f.dir), /tracking metadata/);
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /tracking metadata/);
    assert.deepEqual(readFileSync(f.filename), before);
  });

  it('real native conflict ROLLBACK loses transaction ownership safely and permits retry', async (t) => {
    const f = fixture(t);
    const file = migration(
      f.dir,
      FIRST,
      'CREATE TABLE items(id INTEGER UNIQUE); INSERT INTO items VALUES(1); INSERT OR ROLLBACK INTO items VALUES(1);',
    );
    const result = await migrateSqliteUp(f.filename, f.dir);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.error, /released its writer lock/);
    assert.deepEqual(result.applied, []);
    assert.deepEqual(schema(f.filename), []);
    writeFileSync(
      file,
      '-- UP\nCREATE TABLE items(id INTEGER); INSERT INTO items VALUES(1);\n-- DOWN\nDROP TABLE items;',
    );
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
  });

  it('supports native trigger bodies without splitting their internal semicolons', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      `CREATE TABLE items(id INTEGER); CREATE TABLE audit(id INTEGER);
      CREATE TRIGGER audit_insert AFTER INSERT ON items BEGIN INSERT INTO audit VALUES(new.id); INSERT INTO audit VALUES(new.id+10); END;
      INSERT INTO items VALUES(2);`,
      'DROP TABLE audit; DROP TABLE items;',
    );
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
    assert.deepEqual(
      withDb(f.filename, (db) => db.prepare('SELECT id FROM audit ORDER BY id').all()).map((r) => r.id),
      [2, 12],
    );
  });

  it('native autoincrement still works while direct tracking-sequence writes are protected', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      'CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO items DEFAULT VALUES;',
    );
    assert.equal((await migrateSqliteUp(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT id FROM items').get()?.id),
      1,
    );
    assert.equal(rows(f.filename)[0]?.id, 1);
  });

  it('renames and drops AUTOINCREMENT tables while preserving the history sequence', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      'CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO items DEFAULT VALUES;',
    );
    await migrateSqliteUp(f.filename, f.dir);
    migration(f.dir, SECOND, 'ALTER TABLE items RENAME TO renamed;', 'ALTER TABLE renamed RENAME TO items;');
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT id FROM renamed').get()?.id),
      1,
    );
    assert.equal((await migrateSqliteDown(f.filename, f.dir, { allowDestructive: true })).rolledBack.length, 1);
    assert.equal((await migrateSqliteDown(f.filename, f.dir, { allowDestructive: true })).rolledBack.length, 1);
    assert.deepEqual(rows(f.filename), []);
  });

  it('requires consent for explicit user sequence inserts without blocking native AUTOINCREMENT', async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER PRIMARY KEY AUTOINCREMENT);');
    await migrateSqliteUp(f.filename, f.dir);
    const before = readFileSync(f.filename);
    const history = rows(f.filename);
    migration(f.dir, SECOND, "INSERT INTO sqlite_sequence(name, seq) VALUES('items', 40);");
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
    assert.deepEqual(rows(f.filename), history);
    assert.deepEqual(readFileSync(f.filename), before);
    assert.equal((await migrateSqliteUp(f.filename, f.dir, { allowDestructive: true })).applied.length, 1);
    migration(f.dir, THIRD, 'INSERT INTO items DEFAULT VALUES;');
    assert.equal((await migrateSqliteUp(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT id FROM items').get()?.id),
      41,
    );
  });

  it('allows user columns named like history while protecting actual history table references', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      `CREATE TABLE items(id INTEGER PRIMARY KEY, "_turbine_migrations" TEXT);
       INSERT INTO items VALUES(1, 'original');`,
    );
    await migrateSqliteUp(f.filename, f.dir);
    migration(
      f.dir,
      SECOND,
      `UPDATE items SET "_turbine_migrations" = 'new' WHERE id = 1;
       CREATE TABLE copied AS SELECT "_turbine_migrations" AS value FROM items;`,
    );
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT value FROM copied').get()?.value),
      'new',
    );
    const history = rows(f.filename);
    migration(f.dir, THIRD, 'CREATE TABLE copied_history AS SELECT name FROM _turbine_migrations;');
    await assert.rejects(migrateSqliteDeploy(f.filename, f.dir), /tracking metadata/);
    assert.deepEqual(rows(f.filename), history);
  });

  it('allows a temporary user index named like history when SQLite authorizes its REINDEX', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      `CREATE TEMP TABLE scratch(value);
       CREATE INDEX temp."_turbine_migrations" ON scratch(value);
       INSERT INTO scratch VALUES('indexed');
       CREATE TABLE items AS SELECT value FROM scratch;`,
    );
    assert.equal((await migrateSqliteUp(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT value FROM items').get()?.value),
      'indexed',
    );
    assert.equal(rows(f.filename).length, 1);
  });

  it('rejects NUL-containing migration sources before executing a truncated prefix', async (t) => {
    const f = fixture(t);
    const file = migration(f.dir, FIRST, 'CREATE TABLE items(id);\0INSERT INTO items VALUES(1);');
    await assert.rejects(migrateSqliteDeploy(f.filename, f.dir), /NUL/);
    assert.deepEqual(schema(f.filename), []);
    assert.throws(() => assertSqliteMigrationFiles(listMigrationFiles(f.dir), 'up'), /NUL/);
    assert.ok(readFileSync(file, 'utf8').includes('\0'));
  });

  it('requires consent for a CTE replacement and replacements in existing triggers', async (t) => {
    const f = fixture(t);
    withDb(f.filename, (db) =>
      db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT);
      INSERT INTO items VALUES(1,'original'); CREATE TABLE inputs(id INTEGER);
      CREATE TRIGGER copy_value AFTER INSERT ON inputs BEGIN REPLACE INTO items VALUES(1,'changed'); END;`),
    );
    const file = migration(f.dir, FIRST, "WITH source AS (SELECT 1) REPLACE INTO items VALUES(1,'changed');");
    for (const sql of [
      "WITH source AS (SELECT 1) REPLACE INTO items VALUES(1,'changed');",
      'INSERT INTO inputs VALUES(1);',
    ]) {
      writeFileSync(file, `-- UP\n${sql}\n-- DOWN\nSELECT 1;`);
      await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
      assert.equal(
        withDb(f.filename, (db) => db.prepare('SELECT value FROM items').get()?.value),
        'original',
      );
      assert.equal(
        withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM inputs').get()?.n),
        0,
      );
    }
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT value FROM items').get()?.value),
      'changed',
    );
  });

  it('rolls back when tracking constraints ignore an insert instead of recording the migration', async (t) => {
    const f = fixture(t);
    withDb(f.filename, (db) =>
      db.exec(`CREATE TABLE _turbine_migrations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      checksum TEXT NOT NULL, applied_at TEXT NOT NULL ON CONFLICT IGNORE);`),
    );
    migration(f.dir, FIRST, 'CREATE TABLE items(id); INSERT INTO items VALUES(1);');
    const before = readFileSync(f.filename);
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /history write/);
    assert.deepEqual(readFileSync(f.filename), before);
    assert.deepEqual(rows(f.filename), []);
  });

  it('accepts a legacy tracking primary key without AUTOINCREMENT and refuses extra generated columns', async (t) => {
    const f = fixture(t);
    withDb(f.filename, (db) =>
      db.exec(`CREATE TABLE _turbine_migrations(
      id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')));`),
    );
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
    assert.equal((await migrateSqliteUp(f.filename, f.dir)).applied.length, 1);
    withDb(f.filename, (db) =>
      db.exec('ALTER TABLE _turbine_migrations ADD COLUMN hidden TEXT GENERATED ALWAYS AS (name);'),
    );
    await assert.rejects(migrateSqliteStatus(f.filename, f.dir), /tracking metadata/);
  });

  it('refuses a rollback file changed between checksum inspection and the execution snapshot', async (t) => {
    const f = fixture(t);
    const file = migration(f.dir, FIRST, 'CREATE TABLE items(id); INSERT INTO items VALUES(1);', 'SELECT 1;');
    await migrateSqliteUp(f.filename, f.dir);
    const script = join(f.root, 'changed-rollback.mjs');
    writeFileSync(
      script,
      `import assert from 'node:assert/strict'; import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      const {migrateSqliteDown}=await import(${JSON.stringify(pathToFileURL(resolve('src/cli/sqlite-migrate.ts')).href)});
      const original=fs.readFileSync; let reads=0;
      fs.readFileSync=function(path,...args){
        if(path===process.argv[4] && ++reads===5) fs.writeFileSync(path, '-- UP\\nCREATE TABLE items(id); INSERT INTO items VALUES(1);\\n-- DOWN\\nDELETE FROM items;');
        return original.call(this,path,...args);
      }; syncBuiltinESMExports();
      try {
        await assert.rejects(migrateSqliteDown(process.argv[2],process.argv[3],{allowDestructive:true}), /changed after checksum validation/);
        assert.equal(reads,5,'fixture must modify the final execution snapshot');
      } finally { fs.readFileSync=original; syncBuiltinESMExports(); }`,
    );
    execFileSync(
      process.execPath,
      ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, script, f.filename, f.dir, file],
      { stdio: 'pipe' },
    );
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM items').get()?.n),
      1,
    );
    assert.equal(rows(f.filename).length, 1);
  });

  it('requires opt-in for SQLite REPLACE spellings and schema-default replacement', async (t) => {
    const f = fixture(t);
    migration(
      f.dir,
      FIRST,
      "CREATE TABLE items(id INTEGER PRIMARY KEY ON CONFLICT REPLACE, text TEXT); INSERT INTO items VALUES(1,'original');",
    );
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
    await migrateSqliteDeploy(f.filename, f.dir);
    const second = migration(f.dir, SECOND, "INSERT INTO items VALUES(1,'changed');");
    for (const sql of [
      "INSERT INTO items VALUES(1,'changed');",
      "REPLACE items VALUES(1,'changed');",
      "INSERT OR REPLACE INTO items VALUES(1,'changed');",
    ]) {
      writeFileSync(second, `-- UP\n${sql}\n-- DOWN\nSELECT 1;`);
      await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
      assert.equal(
        withDb(f.filename, (db) => db.prepare('SELECT text FROM items').get()?.text),
        'original',
      );
    }
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT text FROM items').get()?.text),
      'changed',
    );
  });

  it('checks transaction ownership before any migration SQL, using an isolated native-handle fault fixture', async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
    const script = join(f.root, 'missing-transaction.mjs');
    const moduleUrl = pathToFileURL(resolve('src/cli/sqlite-migrate.ts')).href;
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
    writeFileSync(
      script,
      `import assert from 'node:assert/strict'; import {DatabaseSync} from 'node:sqlite';
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) { if (sql === 'BEGIN IMMEDIATE') return; return exec.call(this,sql); };
      const {migrateSqliteUp} = await import(${JSON.stringify(moduleUrl)});
      await assert.rejects(migrateSqliteUp(process.argv[2],process.argv[3]), /transaction ownership was lost/);`,
    );
    execFileSync(process.execPath, ['--import', loader, script, f.filename, f.dir], { stdio: 'pipe' });
    assert.deepEqual(schema(f.filename), []);
  });

  it('native authorizer catches destructive work hidden behind an existing trigger', async (t) => {
    const f = fixture(t);
    withDb(f.filename, (db) =>
      db.exec(`CREATE TABLE items(id); CREATE TABLE victim(id); INSERT INTO victim VALUES(1);
      CREATE TRIGGER hidden_delete AFTER INSERT ON items BEGIN DELETE FROM victim; END;`),
    );
    migration(f.dir, FIRST, 'INSERT INTO items VALUES(1);');
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /DESTRUCTIVE/);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM victim').get()?.n),
      1,
    );
    assert.equal((await migrateSqliteDeploy(f.filename, f.dir)).applied.length, 1);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM victim').get()?.n),
      0,
    );
  });

  it('contends with another native writer, times out, then waits for release and rereads history', async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
    await migrateSqliteUp(f.filename, f.dir);
    const second = migration(f.dir, SECOND, 'INSERT INTO items VALUES(2);');
    const childPath = join(f.root, 'lock-holder.mjs');
    writeFileSync(
      childPath,
      `import {DatabaseSync} from 'node:sqlite';
      const db = new DatabaseSync(process.argv[2]); db.exec('BEGIN IMMEDIATE');
      db.exec('INSERT INTO items VALUES(2)');
      db.prepare('INSERT INTO _turbine_migrations(name,checksum) VALUES(?,?)').run(process.argv[3],process.argv[4]);
      process.send('locked');
      process.on('message', message => { if (message === 'release') { db.exec('COMMIT'); db.close(); process.exit(0); }
        else setTimeout(() => { db.exec('COMMIT'); db.close(); process.exit(0); }, message.releaseAfter); });`,
    );
    const child = spawn(process.execPath, [childPath, f.filename, SECOND, digest(readFileSync(second))], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const exited = once(child, 'exit');
    assert.equal((await once(child, 'message'))[0], 'locked');
    assert.equal((await migrateSqliteStatus(f.filename, f.dir))[1]?.applied, false);
    await assert.rejects(migrateSqliteUp(f.filename, f.dir), /lock/);
    let waits = 0;
    const start = performance.now();
    await assert.rejects(
      migrateSqliteUp(f.filename, f.dir, { lockWaitMs: 60, onLockWait: () => waits++ }),
      /within 60ms/,
    );
    assert.ok(performance.now() - start >= 40);
    assert.equal(waits, 1);
    child.send({ releaseAfter: 120 });
    const applied = await migrateSqliteUp(f.filename, f.dir, { lockWaitMs: 1500 });
    assert.deepEqual(applied.applied, []);
    assert.equal((await exited)[0], 0);
    assert.equal(rows(f.filename).length, 2);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM items').get()?.n),
      1,
    );
    assert.deepEqual((await migrateSqliteUp(f.filename, f.dir)).applied, []);
  });

  it('an actual runner killed after SQL execution recovers its journal and retries without partial history', {
    timeout: 15000,
  }, async (t) => {
    const f = fixture(t);
    withDb(f.filename, (db) => db.exec('CREATE TABLE original(id INTEGER); INSERT INTO original VALUES(42);'));
    const beforeSchema = schema(f.filename);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER, data BLOB); INSERT INTO items VALUES(1, zeroblob(1024));');
    migration(
      f.dir,
      SECOND,
      `INSERT INTO items WITH RECURSIVE n(id) AS (SELECT 2 UNION ALL SELECT id+1 FROM n WHERE id<8000)
      SELECT id, zeroblob(1024) FROM n;`,
    );
    const script = join(f.root, 'interrupted-runner.mjs');
    const moduleUrl = pathToFileURL(resolve('src/cli/sqlite-migrate.ts')).href;
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
    // Instrument only this isolated process/fixture, never shared source.
    writeFileSync(
      script,
      `import {DatabaseSync} from 'node:sqlite';
      const exec = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) { const result = exec.call(this,sql);
        if (sql.startsWith('INSERT INTO items')) { process.stdout.write('sql-executed\\n'); process.kill(process.pid, 'SIGSTOP'); }
        return result; };
      const {migrateSqliteUp} = await import(${JSON.stringify(moduleUrl)});
      await migrateSqliteUp(process.argv[2], process.argv[3]);`,
    );
    const child = spawn(process.execPath, ['--import', loader, script, f.filename, f.dir], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    const exited = once(child, 'exit');
    let errorText = '';
    child.stderr.on('data', (data) => {
      errorText += String(data);
    });
    const signal = await Promise.race([
      once(child.stdout, 'data'),
      exited.then(() => {
        throw new Error(`Runner exited before SQL: ${errorText}`);
      }),
    ]);
    assert.match(String(signal[0]), /sql-executed/);
    assert.ok(existsSync(`${f.filename}-journal`), 'an uncommitted native journal exists before interruption');
    child.kill('SIGKILL');
    assert.equal((await exited)[1], 'SIGKILL');
    assert.deepEqual(schema(f.filename), beforeSchema);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT id FROM original').get()?.id),
      42,
    );
    const retry = await migrateSqliteDeploy(f.filename, f.dir);
    assert.equal(retry.applied.length, 2);
    assert.equal(rows(f.filename).length, 2);
    assert.equal(
      withDb(f.filename, (db) => db.prepare('SELECT count(*) AS n FROM items').get()?.n),
      8000,
    );
  });
});

runtimeIt(
  'validates input and refuses unsupported node:sqlite migration capabilities before database creation',
  async (t) => {
    const f = fixture(t);
    migration(f.dir, FIRST, 'CREATE TABLE items(id INTEGER);');
    await assert.rejects(migrateSqliteUp('postgresql://example/db', f.dir), /filename/);
    if (!writable) await assert.rejects(migrateSqliteUp(f.filename, f.dir), /node:sqlite|setAuthorizer|isTransaction/);
    assert.equal(existsSync(f.filename), false);
  },
);

runtimeIt('static preflight rejects unsafe sections and permits native trigger BEGIN/CASE/END bodies', (t) => {
  const f = fixture(t);
  const file = migration(f.dir, FIRST, 'CREATE TABLE items(id);');
  for (const sql of [
    'END;',
    'SELECT 1; COMMIT;',
    'SAVEPOINT x;',
    'ROLLBACK TO x;',
    '-- comment\nBEGIN;',
    'CREATE TRIGGER t AFTER INSERT ON items BEGIN SELECT CASE WHEN 1 THEN 2 ELSE 3 END; END; COMMIT;',
  ]) {
    writeFileSync(file, `-- UP\n${sql}\n-- DOWN\nSELECT 1;`);
    assert.throws(() => assertSqliteMigrationFiles(listMigrationFiles(f.dir), 'up'), /transaction control/);
  }
  writeFileSync(
    file,
    `-- UP\nCREATE TABLE items(id); CREATE TRIGGER t AFTER INSERT ON items
    BEGIN SELECT CASE WHEN 1 THEN 'COMMIT;' ELSE 'END;' END; SELECT 1; END; SELECT 'BEGIN;';\n-- DOWN\n-- irreversible`,
  );
  assert.doesNotThrow(() => assertSqliteMigrationFiles(listMigrationFiles(f.dir), 'up'));
  assert.throws(() => assertSqliteMigrationFiles(listMigrationFiles(f.dir), 'down'), /no executable DOWN/);
  writeFileSync(file, '-- turbine:no-transaction\n-- UP\nSELECT 1;');
  assert.throws(() => assertSqliteMigrationFiles(listMigrationFiles(f.dir), 'up'), /no-transaction/);
  assert.equal(existsSync(f.filename), false);
});
