/** Native-only child barrier. Production migration code has no test hooks. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runner, database, migrations, control, hold] = process.argv.slice(2);
const require = createRequire(pathToFileURL(runner));
const Database = require('libsql');
function publishBarrier(value) {
  // The watcher may run immediately after file creation, before writeFileSync
  // fills it. Publish only the complete JSON within this same owned directory.
  const pending = join(control, 'executed.pending');
  writeFileSync(pending, JSON.stringify(value));
  renameSync(pending, join(control, 'executed.json'));
}
if (hold === 'deploy-only') {
  const { migrateLibsqlDeploy } = await import(pathToFileURL(runner));
  console.log(JSON.stringify(await migrateLibsqlDeploy(database, migrations)));
  process.exit(0);
}
if (hold) {
  const { createClient } = require('@libsql/client/node');
  const client = createClient({ url: pathToFileURL(database).href, intMode: 'bigint', timeout: 0 });
  const mode = hold === 'reader-wal' ? 'WAL' : 'DELETE';
  await client.execute(`PRAGMA journal_mode=${mode}`);
  const tx = await client.transaction(hold === 'writer' ? 'write' : 'read');
  try {
    await tx.execute('SELECT count(*) FROM retained');
    if (hold === 'writer') await tx.execute("INSERT INTO retained VALUES(2,'caller uncommitted')");
    const fields = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
    publishBarrier({ pid: process.pid, startTime: fields[19], ran: true, hold });
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(control, 'release'))) {
      if (Date.now() > deadline) throw new Error('Held native transaction barrier timed out');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
    assert.equal(tx.closed, false);
    assert.equal((await tx.execute('SELECT count(*) FROM retained')).rows[0][0], hold === 'writer' ? 2n : 1n);
    if (hold === 'reader-wal')
      assert.equal((await tx.execute("SELECT count(*) FROM sqlite_schema WHERE name='crash_marker'")).rows[0][0], 0n);
  } finally {
    await tx.rollback();
    tx.close();
    client.close();
  }
  console.log(JSON.stringify({ released: hold, callerOwned: true }));
  process.exit(0);
}
const original = Database.prototype.prepare;
const word = new Int32Array(new SharedArrayBuffer(4));
let paused = false;
Database.prototype.prepare = function (sql) {
  const statement = original.call(this, sql);
  if (!paused && /^CREATE TABLE crash_marker\s*\(/i.test(sql)) {
    const run = statement.run;
    statement.run = function (...args) {
      const result = run.apply(this, args);
      paused = true;
      assert.equal(result.changes, 0);
      const fields = readFileSync('/proc/self/stat', 'utf8').split(') ')[1].split(' ');
      publishBarrier({ pid: process.pid, startTime: fields[19], sql, ran: true });
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(control, 'release'))) {
        if (Date.now() > deadline) throw new Error('Native fixture barrier timed out');
        Atomics.wait(word, 0, 0, 10);
      }
      return result;
    };
  }
  return statement;
};
try {
  const { migrateLibsqlDeploy } = await import(pathToFileURL(runner));
  console.log(JSON.stringify(await migrateLibsqlDeploy(database, migrations)));
  assert.ok(paused, 'Must execute the actual DDL before the native fixture barrier');
} finally {
  Database.prototype.prepare = original;
}
