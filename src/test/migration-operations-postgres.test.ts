import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { deriveLockId, migrateDeploy, migrateDown, migrateStatus, migrateUp } from '../cli/migrate.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL;
const { it } = skipGate(!url, 'requires DATABASE_URL pointing at disposable direct PostgreSQL');
const first = '20260101000000_first';
const second = '20260102000000_second';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function legacy(text: string): string {
  let value = 0;
  for (let i = 0; i < text.length; i++) value = ((value << 5) - value + text.charCodeAt(i)) | 0;
  return Math.abs(value).toString(36);
}

async function until<T>(probe: () => Promise<T | undefined>, message: string): Promise<T> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(message);
}

async function fixture(t: TestContext) {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const schema = `migration_ops_${process.pid}_${randomBytes(5).toString('hex')}`;
  const dir = mkdtempSync(join(tmpdir(), 'turbine-migration-operations-pg-'));
  const q = `"${schema}"`;
  const children: Array<ReturnType<typeof spawn>> = [];
  t.after(async () => {
    try {
      for (const child of children) {
        const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exit;
        }
      }
      await admin.query(`DROP SCHEMA ${q} CASCADE`);
    } finally {
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await admin.query(`CREATE SCHEMA ${q}`);
  const write = (name: string, up: string, down = 'DROP TABLE items;') => {
    const path = join(dir, `${name}.sql`);
    writeFileSync(path, `-- UP\n${up}\n-- DOWN\n${down}\n`);
    return path;
  };
  const history = async () =>
    (await admin.query(`SELECT id, name, checksum, applied_at FROM ${q}._turbine_migrations ORDER BY id`)).rows;
  const options = { schema };
  const child = () => {
    const runner = spawn(process.execPath, ['--import', 'tsx', 'src/test/fixtures/migration-operations-child.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MIGRATION_OPERATIONS_ENGINE: 'postgres',
        MIGRATION_OPERATIONS_URL: url,
        MIGRATION_OPERATIONS_DIR: dir,
        MIGRATION_OPERATIONS_SCHEMA: schema,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(runner);
    let stderr = '';
    runner.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = new Promise<void>((resolve) => runner.once('exit', () => resolve()));
    return { runner, exited, errors: () => stderr };
  };
  const sleeping = () =>
    until(async () => {
      // The caller may hold a row-lock transaction: statistics otherwise keep its first snapshot.
      await admin.query('SELECT pg_stat_clear_snapshot()');
      const { rows } = await admin.query<{ pid: number }>(
        "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND query LIKE $1 AND state='active'",
        [`%/* ${schema} */%`],
      );
      return rows[0]?.pid;
    }, 'migration never reached its native blocked statement');
  return { admin, schema, q, dir, write, history, options, child, sleeping };
}

for (const invalid of ['DROP TABLE items;', 'BEGIN; SELECT 1; COMMIT;', '-- no executable SQL']) {
  it(`refused UP preserves exact history before drift rebaseline: ${invalid}`, async (t) => {
    const f = await fixture(t);
    const path = f.write(first, 'CREATE TABLE items(id integer PRIMARY KEY); INSERT INTO items VALUES(1);');
    assert.equal((await migrateUp(url!, f.dir, f.options)).applied.length, 1);
    const before = await f.history();
    writeFileSync(path, `${readFileSync(path, 'utf8')}-- changed bytes\n`);
    f.write(second, invalid);
    await assert.rejects(
      migrateUp(url!, f.dir, { ...f.options, allowDrift: true }),
      /DESTRUCTIVE|manage transactions|no executable/i,
    );
    assert.deepEqual(await f.history(), before, 'a refused batch must not bless modified history');
    assert.deepEqual((await f.admin.query(`SELECT * FROM ${f.q}.items ORDER BY id`)).rows, [{ id: 1 }]);
    assert.equal((await migrateStatus(url!, f.dir, f.options))[0]!.checksumValid, false);
  });
}

for (const direction of ['up', 'down'] as const) {
  it(`refused ${direction.toUpperCase()} leaves verified legacy checksum unchanged`, async (t) => {
    const f = await fixture(t);
    const path = f.write(first, 'CREATE TABLE items(id integer PRIMARY KEY);');
    await migrateUp(url!, f.dir, f.options);
    const oldHash = legacy(readFileSync(path, 'utf8'));
    await f.admin.query(`UPDATE ${f.q}._turbine_migrations SET checksum=$1`, [oldHash]);
    const before = await f.history();
    f.write(second, 'DROP TABLE items;');
    const operation = direction === 'up' ? migrateUp : migrateDown;
    await assert.rejects(operation(url!, f.dir, f.options), /DESTRUCTIVE/);
    assert.deepEqual(await f.history(), before);
    // Successful admission still upgrades the same legacy format.
    if (direction === 'up') {
      rmSync(join(f.dir, `${second}.sql`));
      assert.equal((await migrateUp(url!, f.dir, f.options)).errors.length, 0);
      assert.equal((await f.history())[0]!.checksum, hash(readFileSync(path, 'utf8')));
    }
  });
}

it('active row locks delay DDL; simultaneous deploy waits and rereads committed history', {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t);
  f.write(first, 'CREATE TABLE items(id integer PRIMARY KEY); INSERT INTO items VALUES(1);');
  await migrateUp(url!, f.dir, f.options);
  const path = f.write(second, `/* ${f.schema} */ ALTER TABLE items ADD COLUMN note text DEFAULT 'kept';`);
  await f.admin.query('BEGIN');
  await f.admin.query(`SELECT * FROM ${f.q}.items FOR UPDATE`);
  const firstRun = migrateDeploy(url!, f.dir, f.options);
  let secondRun: ReturnType<typeof migrateDeploy> | undefined;
  try {
    await f.sleeping();
    await assert.rejects(migrateDeploy(url!, f.dir, f.options), /migration lock/);
    let waiting!: () => void;
    const observed = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    secondRun = migrateDeploy(url!, f.dir, { ...f.options, lockWaitMs: 5000, onLockWait: waiting });
    await observed;
  } finally {
    await f.admin.query('ROLLBACK');
  }
  const [a, b] = await Promise.all([firstRun, secondRun!]);
  assert.deepEqual(
    a.applied.map((file) => file.name),
    [second],
  );
  assert.deepEqual(b.applied, []);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  const history = await f.history();
  assert.deepEqual(
    history.map((row) => row.name),
    [first, second],
  );
  assert.equal(history[1]!.checksum, hash(readFileSync(path, 'utf8')));
  assert.deepEqual((await f.admin.query(`SELECT * FROM ${f.q}.items ORDER BY id`)).rows, [{ id: 1, note: 'kept' }]);
});

it('terminated backend loses its lock and rolls back the current file before retry', { timeout: 20_000 }, async (t) => {
  const f = await fixture(t);
  f.write(
    first,
    `/* ${f.schema} */ CREATE TABLE items(id integer PRIMARY KEY); INSERT INTO items VALUES(1); SELECT pg_sleep(30);`,
  );
  const running = migrateDeploy(url!, f.dir, f.options).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  const pid = await f.sleeping();
  await f.admin.query('SELECT pg_terminate_backend($1)', [pid]);
  const result = await running;
  assert.ok('error' in result || ('value' in result && result.value.errors.length === 1));
  assert.deepEqual(await f.history(), []);
  assert.equal((await f.admin.query('SELECT to_regclass($1) AS name', [`${f.schema}.items`])).rows[0]!.name, null);
  f.write(first, 'CREATE TABLE items(id integer PRIMARY KEY); INSERT INTO items VALUES(1);');
  assert.deepEqual(
    (await migrateDeploy(url!, f.dir, f.options)).applied.map((file) => file.name),
    [first],
  );
  assert.deepEqual((await f.admin.query(`SELECT * FROM ${f.q}.items`)).rows, [{ id: 1 }]);
});

it('killed deploy preserves earlier file commit and retries only the rolled back file', {
  timeout: 20_000,
}, async (t) => {
  const f = await fixture(t);
  const a = f.write(first, 'CREATE TABLE items(id integer PRIMARY KEY); INSERT INTO items VALUES(1);');
  const b = f.write(second, `/* ${f.schema} */ INSERT INTO items VALUES(2); SELECT pg_sleep(1.5);`);
  const child = f.child();
  await f.sleeping();
  assert.deepEqual(
    (await f.history()).map((row) => row.name),
    [first],
  );
  assert.deepEqual((await f.admin.query(`SELECT * FROM ${f.q}.items ORDER BY id`)).rows, [{ id: 1 }]);
  child.runner.kill('SIGKILL');
  await child.exited;
  const lockId = deriveLockId((await f.admin.query('SELECT current_database() AS name')).rows[0]!.name);
  await until(async () => {
    const row = (await f.admin.query('SELECT pg_try_advisory_lock($1) AS owned', [lockId])).rows[0]!;
    if (!row.owned) return undefined;
    await f.admin.query('SELECT pg_advisory_unlock($1)', [lockId]);
    return true;
  }, `migration session did not release its lock: ${child.errors()}`);
  assert.deepEqual(
    (await migrateDeploy(url!, f.dir, f.options)).applied.map((file) => file.name),
    [second],
  );
  assert.deepEqual((await f.admin.query(`SELECT * FROM ${f.q}.items ORDER BY id`)).rows, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(
    (await f.history()).map((row) => [row.name, row.checksum]),
    [
      [first, hash(readFileSync(a, 'utf8'))],
      [second, hash(readFileSync(b, 'utf8'))],
    ],
  );
});
