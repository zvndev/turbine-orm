import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { TransactionClient } from '../client.js';
import { introspectSqliteDatabase } from '../sqlite.js';
import { defineSqliteSeed, runSqliteSeed } from '../sqlite-seed.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const sqlite = skipGate(!native, 'SQLite seeds require node:sqlite (Node >=22.5)');

describe('SQLite seed lifecycle', () => {
  it('declares callbacks without invoking them and rejects invalid callbacks', () => {
    let calls = 0;
    const fn = () => {
      calls++;
    };
    assert.equal(defineSqliteSeed(fn), fn);
    assert.equal(calls, 0);
    assert.throws(() => defineSqliteSeed(null as never), /callable/);
  });

  sqlite.it('commits awaited typed writes and keeps a borrowed handle open until its caller closes it', async () => {
    const handle = new native!.DatabaseSync(':memory:');
    try {
      handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
      const schema = introspectSqliteDatabase(handle);
      let escaped: TransactionClient | undefined;
      await runSqliteSeed(
        handle,
        schema,
        defineSqliteSeed(async (tx) => {
          escaped = tx;
          assert.equal('disconnect' in tx, false);
          assert.equal('close' in tx, false);
          await tx.table<{ id: number; label: string }>('items').create({ data: { id: 1, label: 'committed' } });
          assert.equal(handle.prepare('SELECT label FROM items').get()!.label, 'committed');
        }),
      );
      assert.equal(handle.prepare('SELECT label FROM items').get()!.label, 'committed');
      await assert.rejects(() => escaped!.raw`SELECT 1`, /committed/i);
      handle.exec("INSERT INTO items VALUES (2, 'still open')");
      assert.equal(handle.prepare('SELECT count(*) AS n FROM items').get()!.n, 2);
    } finally {
      handle.close();
    }
  });

  sqlite.it(
    'rolls back failure, permits a rerun and leaves external side effects outside its transaction',
    async () => {
      const handle = new native!.DatabaseSync(':memory:');
      try {
        handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
        const schema = introspectSqliteDatabase(handle);
        const effects: string[] = [];
        await assert.rejects(
          () =>
            runSqliteSeed(handle, schema, async (tx) => {
              await tx.raw`INSERT INTO items VALUES (${1}, ${'rolled back'})`;
              effects.push('outside SQLite');
              throw new Error('seed failure');
            }),
          /seed failure/,
        );
        assert.equal(handle.prepare('SELECT count(*) AS n FROM items').get()!.n, 0);
        assert.deepEqual(effects, ['outside SQLite']);
        await runSqliteSeed(handle, schema, async (tx) => {
          await tx.raw`INSERT INTO items VALUES (${1}, ${'rerun'})`;
        });
        assert.equal(handle.prepare('SELECT label FROM items').get()!.label, 'rerun');
      } finally {
        handle.close();
      }
    },
  );

  sqlite.it('never commits, rolls back or closes a caller-owned native transaction', async () => {
    const handle = new native!.DatabaseSync(':memory:');
    try {
      handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
      const schema = introspectSqliteDatabase(handle);
      handle.exec('BEGIN; INSERT INTO items VALUES (17)');
      let called = false;
      await assert.rejects(
        () =>
          runSqliteSeed(handle, schema, () => {
            called = true;
          }),
        /transaction/i,
      );
      assert.equal(called, false);
      assert.equal(handle.prepare('SELECT id FROM items').get()!.id, 17);
      handle.exec('ROLLBACK');
      assert.equal(handle.prepare('SELECT count(*) AS n FROM items').get()!.n, 0);
    } finally {
      handle.close();
    }
  });

  sqlite.it('rolls back a deferred foreign-key violation at commit and can retry on the same handle', async () => {
    const handle = new native!.DatabaseSync(':memory:');
    try {
      handle.exec(`PRAGMA foreign_keys = ON;
        CREATE TABLE parents (id INTEGER PRIMARY KEY);
        CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id) DEFERRABLE INITIALLY DEFERRED);`);
      const schema = introspectSqliteDatabase(handle);
      let completed = false;
      await assert.rejects(
        () =>
          runSqliteSeed(handle, schema, async (tx) => {
            await tx.raw`INSERT INTO children VALUES (${1}, ${99})`;
            completed = true;
          }),
        /foreign key/i,
      );
      assert.equal(completed, true, 'callback returns before deferred constraint fails at commit');
      assert.equal(handle.prepare('SELECT count(*) AS n FROM children').get()!.n, 0);
      await runSqliteSeed(handle, schema, async (tx) => {
        await tx.raw`INSERT INTO parents VALUES (${99})`;
        await tx.raw`INSERT INTO children VALUES (${1}, ${99})`;
      });
      assert.equal(handle.prepare('SELECT parent_id FROM children').get()!.parent_id, 99);
    } finally {
      handle.close();
    }
  });

  sqlite.it('closes each owned file handle after commit and rollback, before resolving or rejecting', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-seed-owned-'));
    const file = join(dir, 'app.sqlite');
    const initial = new native!.DatabaseSync(file);
    initial.exec('CREATE TABLE items (id INTEGER PRIMARY KEY)');
    const schema = introspectSqliteDatabase(initial);
    initial.close();
    const closed: import('node:sqlite').DatabaseSync[] = [];
    const prototype = native!.DatabaseSync.prototype;
    const close = prototype.close;
    prototype.close = function () {
      closed.push(this);
      close.call(this);
    };
    try {
      await runSqliteSeed(file, schema, async (tx) => {
        await tx.raw`INSERT INTO items VALUES (${1})`;
      });
      assert.equal(closed.length, 1);
      assert.throws(() => closed[0]!.exec('SELECT 1'), /not open|closed/i);
      await assert.rejects(
        () =>
          runSqliteSeed(file, schema, async (tx) => {
            await tx.raw`INSERT INTO items VALUES (${2})`;
            throw new Error('rollback');
          }),
        /rollback/,
      );
      assert.equal(closed.length, 2);
      assert.throws(() => closed[1]!.exec('SELECT 1'), /not open|closed/i);
      const verify = new native!.DatabaseSync(file);
      try {
        assert.deepEqual(
          verify
            .prepare('SELECT id FROM items')
            .all()
            .map((row) => row.id),
          [1],
        );
        verify.exec('BEGIN EXCLUSIVE; ROLLBACK');
      } finally {
        verify.close();
      }
    } finally {
      prototype.close = close;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
