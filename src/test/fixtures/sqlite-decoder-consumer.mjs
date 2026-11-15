// Copy into an installed tarball consumer and run with esm or cjs as argv[2].
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

assert.ok(['esm', 'cjs'].includes(process.argv[2]));
const { SqlitePool, turbineSqlite } =
  process.argv[2] === 'cjs' ? createRequire(import.meta.url)('turbine-orm/sqlite') : await import('turbine-orm/sqlite');
const descriptions = typeof StatementSync.prototype.columns === 'function';
const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-decoder-packed-'));
const db = new DatabaseSync(join(dir, 'app.sqlite'));
const nativeStreaming = typeof db.isTransaction === 'boolean' && typeof StatementSync.prototype.iterate === 'function';
const writer = new DatabaseSync(join(dir, 'app.sqlite'));
const pool = new SqlitePool(db);
const client = await pool.connect();
let checkedRows = 0;
const sql = 'SELECT v AS value FROM changing WHERE rowid = $1';
async function check(value) {
  assert.deepEqual((await client.query(sql, [1])).rows, [{ value }]);
  checkedRows++;
  if (nativeStreaming) {
    const rows = [];
    for await (const batch of client.streamBatches(sql, [1], 1)) rows.push(...batch);
    assert.deepEqual(rows, [{ value }]);
    checkedRows++;
  }
}
const replace = (handle, type) =>
  handle.exec(`DROP TABLE IF EXISTS changing;
  CREATE TABLE changing(v ${type}); INSERT INTO changing VALUES(1)`);
try {
  db.exec('PRAGMA journal_mode=WAL');
  replace(db, 'BOOLEAN');
  await check(descriptions ? true : 1);
  replace(writer, 'INTEGER');
  await check(1);
  await client.query('BEGIN');
  replace(db, 'BOOLEAN');
  await check(descriptions ? true : 1);
  await client.query('ROLLBACK');
  await check(1);
  db.exec('CREATE TEMP TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1)');
  await check(descriptions ? true : 1);
  db.exec('DROP TABLE temp.changing');
  await check(1);
  db.exec('DROP TABLE main.changing');
  await assert.rejects(client.query(sql, [1]), /no such table/);
  replace(writer, 'BOOLEAN');
  await check(descriptions ? true : 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM changing').get().n, 1);
  if (!nativeStreaming) {
    await assert.rejects(client.streamBatches(sql, [1], 1).next(), /DatabaseSync.isTransaction/);
  }
} finally {
  client.release();
  await pool.end();
  writer.close();
  rmSync(dir, { recursive: true, force: true });
}
const borrowed = new DatabaseSync(':memory:');
const app = turbineSqlite(borrowed, { tables: {}, enums: {} }, { logger: {}, warnOnUnlimited: false });
try {
  replace(borrowed, 'BOOLEAN');
  assert.deepEqual(await app.rawUnsafe(sql, 1), [{ value: descriptions ? true : 1 }]);
  replace(borrowed, 'INTEGER');
  assert.deepEqual(await app.rawUnsafe(sql, 1), [{ value: 1 }]);
  await app.disconnect();
  assert.equal(borrowed.prepare('SELECT v FROM changing').get().v, 1);
} finally {
  await app.disconnect();
  borrowed.close();
}
console.log(
  JSON.stringify({
    mode: process.argv[2],
    node: process.version,
    descriptions,
    checkedRows,
    cleanup: { handlesClosed: true, fixtureRemoved: true, borrowedSurvivedDisconnect: true },
  }),
);
