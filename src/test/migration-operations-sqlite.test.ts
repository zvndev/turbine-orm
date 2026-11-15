import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { migrateSqliteDeploy, migrateSqliteStatus, migrateSqliteUp } from '../cli/sqlite-migrate.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(
  !native || !('setAuthorizer' in native.DatabaseSync.prototype),
  'SQLite migration writer requires setAuthorizer/isTransaction (Node >= 24.10)',
);
const first = '20260101000000_first';
const second = '20260102000000_second';
const third = '20260103000000_third';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'turbine-migration-operations-sqlite-'));
  const filename = join(root, 'db.sqlite');
  const dir = join(root, 'migrations');
  mkdirSync(dir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (name: string, up: string) => {
    const path = join(dir, `${name}.sql`);
    writeFileSync(path, `-- UP\n${up}\n-- DOWN\nDROP TABLE items;\n`);
    return path;
  };
  const read = (sql: string) => {
    const db = new native!.DatabaseSync(filename);
    try {
      return db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  };
  const history = () => read('SELECT id,name,checksum,applied_at FROM _turbine_migrations ORDER BY id');
  return { filename, dir, write, read, history };
}

it('active readers cause a failed commit to roll back the entire selected batch', async (t) => {
  const f = fixture(t);
  f.write(first, 'CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1);');
  await migrateSqliteDeploy(f.filename, f.dir);
  const before = f.history();
  const b = f.write(second, 'INSERT INTO items VALUES(2);');
  const c = f.write(third, 'INSERT INTO items VALUES(3);');
  const reader = new native!.DatabaseSync(f.filename);
  try {
    reader.exec('BEGIN');
    assert.deepEqual(
      reader
        .prepare('SELECT * FROM items ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 1 }],
    );
    const result = await migrateSqliteDeploy(f.filename, f.dir);
    assert.deepEqual(result.applied, []);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.error, /locked/);
    assert.deepEqual(f.history(), before);
    assert.deepEqual(f.read('SELECT * FROM items ORDER BY id'), [{ id: 1 }]);
  } finally {
    reader.close();
  }
  const result = await migrateSqliteDeploy(f.filename, f.dir);
  assert.deepEqual(
    result.applied.map((file) => file.name),
    [second, third],
  );
  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    f
      .history()
      .slice(1)
      .map((row) => [row.name, row.checksum]),
    [
      [second, hash(readFileSync(b, 'utf8'))],
      [third, hash(readFileSync(c, 'utf8'))],
    ],
  );
  assert.deepEqual(f.read('SELECT * FROM items ORDER BY id'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

it('drift consent cannot rewrite history when authorizer admission refuses pending SQL', async (t) => {
  const f = fixture(t);
  const path = f.write(first, 'CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1);');
  await migrateSqliteDeploy(f.filename, f.dir);
  const before = f.history();
  writeFileSync(path, `${readFileSync(path, 'utf8')}-- changed bytes\n`);
  f.write(second, 'INSERT INTO items VALUES(2); PRAGMA user_version=7;');
  await assert.rejects(migrateSqliteUp(f.filename, f.dir, { allowDrift: true }), /PRAGMA/);
  assert.deepEqual(f.history(), before);
  assert.deepEqual(f.read('SELECT * FROM items ORDER BY id'), [{ id: 1 }]);
  assert.equal((await migrateSqliteStatus(f.filename, f.dir))[0]!.checksumValid, false);
});

it('killed writer releases exclusion and hot-journal recovery removes the whole uncommitted batch', {
  timeout: 20_000,
}, async (t) => {
  const f = fixture(t);
  f.write(first, 'CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES(1);');
  await migrateSqliteDeploy(f.filename, f.dir);
  const before = f.history();
  const b = f.write(second, 'CREATE TABLE pending(id INTEGER PRIMARY KEY);');
  // A large native statement keeps the transaction observable until its process is killed.
  const c = f.write(
    third,
    'WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<3000000) INSERT INTO pending SELECT x FROM n;',
  );
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/test/fixtures/migration-operations-child.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MIGRATION_OPERATIONS_ENGINE: 'sqlite',
      MIGRATION_OPERATIONS_URL: f.filename,
      MIGRATION_OPERATIONS_DIR: f.dir,
      MIGRATION_OPERATIONS_SCHEMA: 'main',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    const deadline = Date.now() + 8000;
    while (
      Date.now() < deadline &&
      !(existsSync(`${f.filename}-journal`) && statSync(`${f.filename}-journal`).size > 512)
    ) {
      assert.equal(child.exitCode, null, stderr);
      await delay(10);
    }
    assert.ok(existsSync(`${f.filename}-journal`), `native writer did not create a journal: ${stderr}`);
    await assert.rejects(migrateSqliteDeploy(f.filename, f.dir), /migration lock/);
    child.kill('SIGKILL');
    await exited;
    assert.equal(child.signalCode, 'SIGKILL');
    // A writable native open performs SQLite's normal hot-journal recovery.
    assert.deepEqual(f.history(), before);
    assert.deepEqual(f.read("SELECT name FROM sqlite_schema WHERE name='pending'"), []);
    // Keep the same migration bytes for retry; confirm their complete effects.
    const result = await migrateSqliteDeploy(f.filename, f.dir);
    assert.deepEqual(
      result.applied.map((file) => file.name),
      [second, third],
    );
    assert.deepEqual(result.errors, []);
    assert.deepEqual(f.read('SELECT count(*) AS n,min(id) AS lo,max(id) AS hi,sum(id) AS total FROM pending'), [
      { n: 3000000, lo: 1, hi: 3000000, total: 4500001500000 },
    ]);
    assert.deepEqual(
      f
        .history()
        .slice(1)
        .map((row) => [row.name, row.checksum]),
      [
        [second, hash(readFileSync(b, 'utf8'))],
        [third, hash(readFileSync(c, 'utf8'))],
      ],
    );
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});
