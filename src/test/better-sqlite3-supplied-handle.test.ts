/**
 * The better-sqlite3 adapter (src/better-sqlite3.ts) against a supplied
 * handle. The real peer is optional and installed only in the binding CI
 * jobs; the adapter's contract is structural, so a node:sqlite-backed
 * handle with the peer's shape (reader/source/raw/safeIntegers, object
 * rows, {changes,lastInsertRowid}) exercises the binding translation:
 * named `:pN` to bare-name objects, NULL defaults, rowless all()/get(),
 * and errcode stamping from the peer's string codes.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import {
  type BetterSqlite3Database,
  introspectBetterSqlite3Database,
  turbineBetterSqlite3,
} from '../better-sqlite3.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { skipGate } from './helpers.js';

const nodeSqlite = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return null;
  }
})();

const gate = skipGate(!nodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

type InnerDb = import('node:sqlite').DatabaseSync;
type InnerStmt = ReturnType<InnerDb['prepare']>;

/** A better-sqlite3-shaped statement over a node:sqlite statement. */
function fakeStatement(inner: InnerStmt, sql: string) {
  inner.setAllowBareNamedParameters(true);
  return {
    source: sql,
    get reader() {
      return inner.columns().length > 0;
    },
    all: (...params: unknown[]) => inner.all(...(params as never[])),
    get: (...params: unknown[]) => inner.get(...(params as never[])),
    run: (...params: unknown[]) => inner.run(...(params as never[])),
    iterate: (...params: unknown[]) => inner.iterate(...(params as never[])),
    columns: () => inner.columns(),
    raw(enabled = true) {
      inner.setReturnArrays(enabled);
      return this;
    },
    safeIntegers(enabled = true) {
      inner.setReadBigInts(enabled);
      return this;
    },
  };
}

function fakeHandle(): BetterSqlite3Database {
  const inner: InnerDb = new nodeSqlite!.DatabaseSync(':memory:');
  const handle = {
    get open() {
      return inner.isOpen;
    },
    get inTransaction() {
      return inner.isTransaction;
    },
    prepare: (sql: string) => fakeStatement(inner.prepare(sql), sql),
    exec: (sql: string) => inner.exec(sql),
    close: () => inner.close(),
  };
  return handle as unknown as BetterSqlite3Database;
}

const meta = schemaDefToMetadata(
  defineSchema({
    users: {
      id: { type: 'integer', primaryKey: true },
      email: { type: 'text', notNull: true, unique: true },
      name: { type: 'text' },
    },
  }),
);

describe('better-sqlite3 supplied-handle adapter', () => {
  gate.it('creates, reads back and counts through the binding translation', async () => {
    const handle = fakeHandle();
    const db = await turbineBetterSqlite3(handle, meta);
    try {
      await db.rawUnsafe('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT)');
      const made = (await db.table('users').create({ data: { email: 'a@x.io', name: 'A' } })) as {
        id: number;
        email: string;
      };
      assert.equal(made.email, 'a@x.io');
      await db.table('users').createMany({
        data: [
          { email: 'b@x.io', name: 'B' },
          { email: 'c@x.io', name: null },
        ],
      });
      const rows = (await db.table('users').findMany({ orderBy: { id: 'asc' }, limit: 10 })) as { email: string }[];
      assert.deepEqual(
        rows.map((r) => r.email),
        ['a@x.io', 'b@x.io', 'c@x.io'],
      );
      assert.equal(await db.table('users').count({ where: { name: 'B' } }), 1);
      const one = (await db.table('users').findUnique({ where: { email: 'c@x.io' } })) as {
        name: string | null;
      } | null;
      assert.equal(one?.name, null);
    } finally {
      await db.disconnect();
      // A supplied handle stays open after disconnect; the caller owns it.
      handle.close();
    }
  });

  gate.it('a duplicate unique value is refused with the constraint error', async () => {
    const handle = fakeHandle();
    const db = await turbineBetterSqlite3(handle, meta);
    try {
      await db.rawUnsafe('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT)');
      await db.table('users').create({ data: { email: 'dup@x.io' } });
      await assert.rejects(db.table('users').create({ data: { email: 'dup@x.io' } }), (err: unknown) => {
        const e = err as { code?: unknown; message?: string };
        return /unique|constraint/i.test(`${String(e.code)} ${e.message ?? ''}`);
      });
    } finally {
      await db.disconnect();
      // A supplied handle stays open after disconnect; the caller owns it.
      handle.close();
    }
  });

  gate.it('introspectBetterSqlite3Database reads the supplied handle', async () => {
    const handle = fakeHandle();
    handle.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT)');
    const schema = introspectBetterSqlite3Database(handle);
    assert.ok(schema.tables.users, 'users table is introspected');
    assert.deepEqual(schema.tables.users!.primaryKey, ['id']);
    handle.close();
  });
});
