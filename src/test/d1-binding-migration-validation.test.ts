import assert from 'node:assert/strict';
import { test } from 'node:test';
import { D1MigrationError, migrateD1 } from '../d1/migrate.js';
import { migrationStatement } from '../d1/migrations/sql.js';
import type { D1DatabaseBinding } from '../d1/types.js';

test('d1-native-migrations SQL admission observes SQLite quotes, comments, BOM and one-statement boundary', () => {
  for (const sql of [
    '/* prefix */\uFEFF CREATE TABLE "begin"([commit] TEXT, `end` TEXT)',
    "INSERT INTO x VALUES('it''s; END -- /*literal*/'); --tail",
    'UPDATE x SET "commit" = "end" /* suffix */;',
    'CREATE TABLE x(id INTEGER DEFAULT (1+2)) -- no newline',
  ])
    assert(migrationStatement(sql).length > 0);
  assert.equal(migrationStatement('\uFEFF --before\n CREATE TABLE x(id); --tail'), 'CREATE TABLE x(id)');
  for (const sql of [
    '/* before */\uFEFF END',
    'BEGIN; COMMIT',
    '/*a*/ PRAGMA writable_schema=1',
    'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; END;',
    'CREATE TABLE x(id); --tail\n BEGIN',
    'CREATE TABLE x(id);;',
    "CREATE TABLE '_turbine_d1_migrations'(id)",
    'CREATE TABLE [SQLITE_SCHEMA](id)',
    'CREATE TABLE x(id) /*missing',
    'CREATE TABLE "x(id)',
    'CREATE TABLE `x(id)',
    'CREATE TABLE [x(id)',
    'CREATE TABLE x(é TEXT)',
    'CREATE TABLE x(id)\0',
    'INSERT INTO x VALUES(:name)',
    "INSERT INTO x VALUES('a\0b')",
    'CREATE TABLE x(id)\u000b',
    `CREATE TABLE x(id)${' '.repeat(100_000)}`,
  ])
    assert.throws(() => migrationStatement(sql), Error, sql);
});

test('d1-native-migrations invalid binding/plan/options are pre-dispatch refusals', async () => {
  let calls = 0;
  const binding: D1DatabaseBinding = {
    prepare() {
      calls++;
      throw new Error('unexpected native preparation');
    },
    batch() {
      calls++;
      throw new Error('unexpected dispatch');
    },
  };
  const invalid = (error: unknown) =>
    error instanceof D1MigrationError && error.phase === 'admission' && error.outcome === 'not-dispatched';
  for (const [db, plan, options] of [
    [null, [], {}],
    [binding, {}, {}],
    [binding, [null], {}],
    [binding, [{ id: 'invalid', statements: ['DELETE FROM x'] }], {}],
    [binding, [{ id: '0001_x', statements: {} }], {}],
    [binding, [], null],
    [binding, [], { signal: {} }],
    [binding, [], { through: 42 }],
    [binding, [], { through: '0001_missing' }],
  ])
    await assert.rejects(() => migrateD1(db as D1DatabaseBinding, plan as never, options as never), invalid);
  assert.equal(calls, 0);
});
