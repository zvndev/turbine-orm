/** Nested updates must retain the parent's optimistic version check. Fails until fixed. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { OptimisticLockError, ValidationError } from '../errors.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: (new (path: string) => SqliteDatabase) | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!DatabaseSync, 'requires node:sqlite (Node >= 22.5)');

async function fixture(run: (db: TurbineClient, raw: SqliteDatabase) => Promise<void>): Promise<void> {
  const raw = new DatabaseSync!(':memory:');
  raw.exec(`
    CREATE TABLE parents (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, note TEXT);
    CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id), note TEXT);
    INSERT INTO parents VALUES (1, 5, 'original');
  `);
  const schema = introspectSqliteDatabase(raw);
  assert.equal(schema.tables.parents?.relations.children?.type, 'hasMany');
  const db = turbineSqlite(raw, schema);
  try {
    await run(db, raw);
  } finally {
    await db.disconnect();
    raw.close();
  }
}

describe('optimisticLock on an update containing a relation operation', () => {
  it('refuses a duplicate version assignment before writing the parent or child', async () => {
    await fixture(async (db, raw) => {
      await assert.rejects(
        db.table('parents').update({
          where: { id: 1 },
          data: { version: 9, children: { create: { id: 1, note: 'child' } } },
          optimisticLock: { field: 'version', expected: 5 },
        } as never),
        ValidationError,
      );
      assert.equal(raw.prepare('SELECT version FROM parents WHERE id = 1').get()?.version, 5);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM children').get()?.n, 0);
    });
  });

  it('rejects a stale version and rolls back every nested effect', async () => {
    await fixture(async (db, raw) => {
      await assert.rejects(
        db.table('parents').update({
          where: { id: 1 },
          data: { note: 'stale', children: { create: { id: 1, note: 'child' } } },
          optimisticLock: { field: 'version', expected: 4 },
        } as never),
        OptimisticLockError,
      );
      assert.equal(raw.prepare('SELECT note FROM parents WHERE id = 1').get()?.note, 'original');
      assert.equal(raw.prepare('SELECT count(*) AS n FROM children').get()?.n, 0);
    });
  });

  it('bumps the parent version exactly once for a relation-only update', async () => {
    await fixture(async (db, raw) => {
      const result = await db.table('parents').update({
        where: { id: 1 },
        data: { children: { create: { id: 1, note: 'child' } } },
        optimisticLock: { field: 'version', expected: 5 },
      } as never);
      assert.equal(result.version, 6);
      assert.equal(raw.prepare('SELECT version FROM parents WHERE id = 1').get()?.version, 6);
      assert.equal(raw.prepare('SELECT count(*) AS n FROM children').get()?.n, 1);
    });
  });
});
