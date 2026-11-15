import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mysql2/promise';
import {
  inspectMysqlMigrationDeploy,
  migrateMysqlDeploy,
  migrateMysqlStatus,
  recoverMysqlMigration,
} from '../cli/mysql-migrate.js';
import { skipGate } from './helpers.js';

const target = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL;
const { it } = skipGate(!target, 'requires MYSQL_URL pointing at disposable native MySQL 8');
const first = '20260101000000_first';
const second = '20260102000000_second';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function fixture(t: TestContext) {
  const url = new URL(target!);
  const config = {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    dateStrings: true,
  };
  const admin = await createConnection(config);
  const database = `migration_ops_${process.pid}_${randomBytes(5).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'turbine-migration-operations-mysql-'));
  await admin.query(`CREATE DATABASE \`${database}\``);
  url.pathname = `/${database}`;
  const connection = await createConnection({ ...config, database });
  t.after(async () => {
    try {
      await connection.end();
      await admin.query(`DROP DATABASE \`${database}\``);
    } finally {
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const query = async (sql: string, values?: (string | number)[]) =>
    (await connection.execute(sql, values))[0] as Array<Record<string, unknown>>;
  const write = (name: string, up: string) => {
    const path = join(dir, `${name}.sql`);
    writeFileSync(path, `-- UP\n${up}\n-- DOWN\nDROP TABLE items;\n`);
    return path;
  };
  const blocked = async () => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const [rows] = await admin.execute('SELECT ID FROM information_schema.PROCESSLIST WHERE DB=? AND INFO LIKE ?', [
        database,
        'UPDATE items%',
      ]);
      const row = (rows as Array<{ ID: number }>)[0];
      if (row) return Number(row.ID);
      await delay(20);
    }
    throw new Error('native migration never reached the row lock');
  };
  const lock = `turbine:${hash(database).slice(0, 56)}`;
  return { admin, connection, database, dir, url: url.href, query, write, blocked, lock };
}

it('active application row locks serialize deploys and preserve exact history order', {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t);
  f.write(first, 'CREATE TABLE items(id INT PRIMARY KEY, value INT NOT NULL); INSERT INTO items VALUES(1,10);');
  await migrateMysqlDeploy(f.url, f.dir);
  const path = f.write(second, 'UPDATE items SET value=value+1 WHERE id=1;');
  await f.connection.beginTransaction();
  await f.query('SELECT * FROM items WHERE id=1 FOR UPDATE');
  const running = migrateMysqlDeploy(f.url, f.dir);
  let waiting: ReturnType<typeof migrateMysqlDeploy> | undefined;
  try {
    const pid = await f.blocked();
    assert.equal(Number((await f.query('SELECT IS_USED_LOCK(?) AS owner', [f.lock]))[0]!.owner), pid);
    await assert.rejects(migrateMysqlDeploy(f.url, f.dir), /migration lock/);
    let observed!: () => void;
    const ready = new Promise<void>((resolve) => {
      observed = resolve;
    });
    waiting = migrateMysqlDeploy(f.url, f.dir, { lockWaitMs: 5000, onLockWait: observed });
    await ready;
  } finally {
    await f.connection.rollback();
  }
  const [a, b] = await Promise.all([running, waiting!]);
  assert.deepEqual(
    a.applied.map((file) => file.name),
    [second],
  );
  assert.deepEqual(b.applied, []);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  assert.deepEqual(await f.query('SELECT * FROM items ORDER BY id'), [{ id: 1, value: 11 }]);
  const history = await f.query('SELECT name,checksum FROM _turbine_migrations ORDER BY id');
  assert.deepEqual(
    history.map((row) => row.name),
    [first, second],
  );
  assert.equal(history[1]!.checksum, hash(readFileSync(path, 'utf8')));
  assert.deepEqual(await f.query('SELECT * FROM _turbine_migration_state'), []);
});

it('killed process and native connection retain durable DDL, exact dirty intent and manual recovery', {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t);
  f.write(first, 'CREATE TABLE items(id INT PRIMARY KEY, value INT NOT NULL); INSERT INTO items VALUES(1,10);');
  await migrateMysqlDeploy(f.url, f.dir);
  const before = await f.query('SELECT id,name,checksum,applied_at FROM _turbine_migrations ORDER BY id');
  const path = f.write(second, 'CREATE TABLE durable(id INT PRIMARY KEY); UPDATE items SET value=value+1 WHERE id=1;');
  await f.connection.beginTransaction();
  await f.query('SELECT * FROM items WHERE id=1 FOR UPDATE');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/test/fixtures/migration-operations-child.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MIGRATION_OPERATIONS_ENGINE: 'mysql',
      MIGRATION_OPERATIONS_URL: f.url,
      MIGRATION_OPERATIONS_DIR: f.dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let pid: number | undefined;
  try {
    pid = await f.blocked();
    assert.equal(Number((await f.query('SELECT IS_USED_LOCK(?) AS owner', [f.lock]))[0]!.owner), pid, stderr);
    child.kill('SIGKILL');
    await exited;
    // Killing the client need not cancel a server-side query blocked on a row.
    // Terminate only the exact backend observed in this owned database.
    await f.admin.query(`KILL CONNECTION ${pid}`);
    pid = undefined;
    await f.connection.rollback();
    const plan = await inspectMysqlMigrationDeploy(f.url, f.dir);
    assert.deepEqual(plan.dirty, {
      name: second,
      checksum: hash(readFileSync(path, 'utf8')),
      direction: 'up',
      completedStatements: 1,
      totalStatements: 2,
    });
    assert.deepEqual(await f.query('SELECT * FROM durable'), []);
    assert.deepEqual(await f.query('SELECT * FROM items ORDER BY id'), [{ id: 1, value: 10 }]);
    assert.deepEqual(await f.query('SELECT id,name,checksum,applied_at FROM _turbine_migrations ORDER BY id'), before);
    await assert.rejects(migrateMysqlDeploy(f.url, f.dir), /Automatic retry is refused/);
    const recovery = {
      name: second,
      checksum: plan.dirty!.checksum,
      outcome: 'rolled-back' as const,
      acknowledgePartialDdl: true as const,
    };
    await assert.rejects(recoverMysqlMigration(f.url, f.dir, { ...recovery, checksum: '0'.repeat(64) }), /exact dirty/);
    assert.equal((await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty!.completedStatements, 1);
    await f.connection.query('DROP TABLE durable');
    await recoverMysqlMigration(f.url, f.dir, recovery);
    assert.equal((await inspectMysqlMigrationDeploy(f.url, f.dir)).dirty, null);
    assert.deepEqual(
      (await migrateMysqlDeploy(f.url, f.dir)).applied.map((file) => file.name),
      [second],
    );
    assert.deepEqual(await f.query('SELECT * FROM items ORDER BY id'), [{ id: 1, value: 11 }]);
    assert.deepEqual(
      (await migrateMysqlStatus(f.url, f.dir)).map((status) => [status.file.name, status.checksumValid]),
      [
        [first, true],
        [second, true],
      ],
    );
    assert.equal((await f.query('SELECT IS_FREE_LOCK(?) AS free', [f.lock]))[0]!.free, 1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    if (pid) await f.admin.query(`KILL CONNECTION ${pid}`).catch(() => {});
    await f.connection.rollback();
  }
});
