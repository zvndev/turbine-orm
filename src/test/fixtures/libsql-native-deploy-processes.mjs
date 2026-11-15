/** Reuses the existing kernel-owned native command supervisor, no new harness. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bounded, ownedChild } from '../../../tooling/optional-pg-transports/lifecycle.mjs';
import { sameProcess, signalOwned } from './neon-http/native-lifecycle.mjs';

async function executed(path, closed) {
  let watcher;
  try {
    await bounded(
      new Promise((resolve, reject) => {
        const check = () => {
          if (existsSync(path)) resolve();
        };
        watcher = watch(fileURLToPath(new URL('.', pathToFileURL(path))), check);
        closed.then(() => reject(new Error('Native deploy child exited before DDL barrier')));
        check();
      }),
      15_000,
      'Actual uncommitted native DDL barrier',
    );
    const result = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(result.ran, true);
    assert.equal(sameProcess(result), true);
    return result;
  } finally {
    watcher?.close();
  }
}
export async function processControls({ runner, inspector, root, node = process.execPath, loader, report }) {
  const { migrateLibsqlDeploy } = await import(pathToFileURL(runner));
  const { inspectLibsqlMigrations } = await import(pathToFileURL(inspector));
  const { createRequire } = await import('node:module');
  const { createClient } = createRequire(pathToFileURL(runner))('@libsql/client/node');
  const childFile = fileURLToPath(new URL('./libsql-native-deploy-child.mjs', import.meta.url));
  report.processControls = [];
  async function deployProcess(database, migrations, dir, expected) {
    const record = { action: 'deploy-only', expected, ports: [] };
    report.deployCommands ??= [];
    report.deployCommands.push(record);
    const handle = ownedChild(
      node,
      [...(loader ? ['--import', loader] : []), childFile, runner, database, migrations, dir, 'deploy-only'],
      { cwd: root, deadlineMs: 20_000, env: { ...process.env, NODE_OPTIONS: '', NODE_V8_COVERAGE: '', TMPDIR: root } },
      record,
    );
    let output = '';
    handle.child.stdout.on('data', (c) => {
      output += c;
    });
    handle.child.stderr.on('data', (c) => {
      output += c;
    });
    try {
      await handle.closed;
      await handle.stop();
      record.output = output;
      assert.equal(record.code, expected, output);
      return output;
    } finally {
      await handle.stop();
    }
  }

  for (const action of ['concurrent', 'SIGTERM', 'SIGKILL', 'reader-delete', 'reader-wal', 'writer']) {
    const dir = join(root, action);
    mkdirSync(dir);
    const migrations = join(dir, 'migrations');
    mkdirSync(migrations);
    const database = join(dir, 'local.db');
    let caller = createClient({ url: pathToFileURL(database).href, intMode: 'bigint', timeout: 0 });
    await caller.executeMultiple(
      "CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retained VALUES(1,'preserved');",
    );
    caller.close();
    const names = ['20260101000000_first', '20260102000000_second'];
    writeFileSync(
      join(migrations, `${names[0]}.sql`),
      '-- UP\nCREATE TABLE crash_marker(id INTEGER PRIMARY KEY); INSERT INTO crash_marker VALUES(1);\n',
    );
    writeFileSync(
      join(migrations, `${names[1]}.sql`),
      '-- UP\nCREATE TABLE later(id INTEGER); INSERT INTO later VALUES(2);\n',
    );
    const record = { action, database, ports: [] };
    report.processControls.push(record);
    const handle = ownedChild(
      node,
      [
        ...(loader ? ['--import', loader] : []),
        childFile,
        runner,
        database,
        migrations,
        dir,
        ...(['reader-delete', 'reader-wal', 'writer'].includes(action) ? [action] : []),
      ],
      {
        cwd: root,
        deadlineMs: 40_000,
        env: { ...process.env, NODE_OPTIONS: '', NODE_V8_COVERAGE: '', TMPDIR: root },
      },
      record,
    );
    let output = '';
    handle.child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    handle.child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    try {
      const owner = await executed(join(dir, 'executed.json'), handle.closed);
      record.barrier = owner;
      const during = await inspectLibsqlMigrations(database, migrations);
      assert.equal(during.historyState, 'uninitialized', 'No uncommitted journal visible to independent native reader');
      if (action === 'reader-delete')
        assert.match(await deployProcess(database, migrations, dir, 1), /COMMIT.*uncertain/);
      else if (action === 'reader-wal')
        assert.deepEqual((await migrateLibsqlDeploy(database, migrations)).applied, names);
      else
        await assert.rejects(
          migrateLibsqlDeploy(database, migrations),
          /writer lock/,
          'Second actual deployer must compete for native writer lock',
        );
      if (['concurrent', 'reader-delete', 'reader-wal', 'writer'].includes(action))
        writeFileSync(join(dir, 'release'), 'owned barrier release\n');
      else assert.equal(signalOwned(owner, action), true, 'Signal only verified child identity');
      await bounded(handle.closed, 20_000, 'Owned native child completion');
      await handle.stop();
      record.output = output;
      if (['reader-delete', 'reader-wal', 'writer'].includes(action)) {
        assert.equal(record.code, 0, output);
        assert.equal(JSON.parse(output).callerOwned, true);
        assert.deepEqual(
          JSON.parse(await deployProcess(database, migrations, dir, 0)).applied,
          action === 'reader-wal' ? [] : names,
          'Actual replay after caller process release',
        );
      } else if (action === 'concurrent') {
        assert.equal(record.code, 0, output);
        assert.deepEqual(JSON.parse(output).applied, names);
      } else {
        assert.equal(record.signal, action, JSON.stringify(record));
        assert.equal((await inspectLibsqlMigrations(database, migrations)).historyState, 'uninitialized');
        caller = createClient({ url: pathToFileURL(database).href, intMode: 'bigint', timeout: 0 });
        try {
          assert.equal(
            (await caller.execute("SELECT count(*) FROM sqlite_schema WHERE name IN ('crash_marker','later')"))
              .rows[0][0],
            0n,
          );
        } finally {
          caller.close();
        }
        assert.deepEqual(
          (await migrateLibsqlDeploy(database, migrations)).applied,
          names,
          'Same exact files must replay after killed partial DDL',
        );
      }
      assert.deepEqual((await migrateLibsqlDeploy(database, migrations)).applied, []);
      caller = createClient({ url: pathToFileURL(database).href, intMode: 'bigint', timeout: 0 });
      try {
        assert.deepEqual(
          (await caller.execute('SELECT * FROM retained')).rows.map((r) => [r[0], r[1]]),
          [[1n, 'preserved']],
        );
        assert.equal((await caller.execute('SELECT id FROM crash_marker')).rows[0][0], 1n);
        assert.equal((await caller.execute('SELECT id FROM later')).rows[0][0], 2n);
        assert.deepEqual(
          (await inspectLibsqlMigrations(database, migrations)).history.map((r) => r.name),
          names,
        );
      } finally {
        caller.close();
      }
      record.passed = true;
    } finally {
      await handle.stop();
      record.output = output;
      assert.equal(record.reaped, true);
      assert.deepEqual(record.remainingPids, []);
      assert.deepEqual(record.remainingGroups, []);
    }
  }
  return report;
}
