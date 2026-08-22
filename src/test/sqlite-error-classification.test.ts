/**
 * turbine-orm/sqlite, driver-error classification
 *
 * The typed-error table (`TURBINE_E0NN` + `.docsUrl` on every failure) is a
 * headline feature, and on SQLite one family of failures escaped it: the ones a
 * new user meets first. Constraint violations were already annotated with the
 * Postgres SQLSTATE that `wrapPgError` classifies, so UNIQUE / FK / NOT NULL /
 * CHECK came out typed. `SQLITE_ERROR` (primary code 1) has no SQLSTATE to
 * borrow: `wrapPgError` does not classify Postgres's own 42P01 / 42703 / 42601
 * either. So `no such table: users` reached the caller as a bare Error with
 * `code: 'ERR_SQLITE_ERROR'`, no `TURBINE_E0NN` and no `.docsUrl`.
 *
 * These run against a real in-process `:memory:` database, not a fake: the
 * mapping is a claim about what `node:sqlite` actually throws.
 *
 * Run: npx tsx --test src/test/sqlite-error-classification.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CheckConstraintError,
  ForeignKeyError,
  NotNullViolationError,
  TurbineError,
  UniqueConstraintError,
  ValidationError,
} from '../errors.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';

const SCHEMA = schemaDefToMetadata(
  defineSchema({
    users: {
      id: { type: 'serial', primaryKey: true },
      email: { type: 'text', notNull: true, unique: true },
      name: { type: 'text', notNull: true },
    },
  }),
);

/** Open a `:memory:` database; `sql` is applied first when given. */
function open(sql?: string[]) {
  const db = turbineSqlite(':memory:', SCHEMA, { warnOnUnlimited: false });
  return {
    db,
    ready: (async () => {
      for (const s of sql ?? []) await db.raw([s] as unknown as TemplateStringsArray);
    })(),
  };
}

/** The error `fn` threw, or a failure if it threw nothing. */
async function thrown(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected the operation to throw');
}

describe('SQLITE_ERROR becomes a typed ValidationError', () => {
  it('no such table', async () => {
    const { db, ready } = open();
    await ready;
    const err = await thrown(() => db.table('users').findMany({ limit: 1 }));
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${(err as Error)?.constructor?.name}`);
    assert.equal((err as ValidationError).code, 'TURBINE_E003');
    assert.equal((err as ValidationError).docsUrl, 'https://turbineorm.dev/errors#e003');
    // The driver's own text is the diagnosis and is kept.
    assert.match((err as Error).message, /no such table: users/);
    assert.match((err as Error).message, /has no table "users"/);
    await db.disconnect();
  });

  it('no such column', async () => {
    const { db, ready } = open(['CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, name TEXT)']);
    await ready;
    const err = await thrown(() => db.raw`SELECT nope FROM users`);
    assert.ok(err instanceof ValidationError);
    assert.match((err as Error).message, /has no column "nope"/);
    await db.disconnect();
  });

  it('a syntax error', async () => {
    const { db, ready } = open();
    await ready;
    const err = await thrown(() => db.raw`SELEKT 1`);
    assert.ok(err instanceof ValidationError);
    assert.match((err as Error).message, /SQLite rejected the statement/);
    assert.match((err as Error).message, /syntax error/);
    await db.disconnect();
  });

  it('every one of them is a TurbineError carrying a docs link', async () => {
    const { db, ready } = open();
    await ready;
    for (const run of [
      () => db.table('users').findMany({ limit: 1 }),
      () => db.raw`SELEKT 1`,
      () => db.raw`SELECT nope FROM sqlite_master`,
    ]) {
      const err = await thrown(run);
      assert.ok(err instanceof TurbineError, 'a driver error must not reach the caller raw');
      assert.ok(!(err as { errcode?: number }).errcode, 'and must not still be the node:sqlite object');
      assert.match(String((err as TurbineError).docsUrl), /turbineorm\.dev\/errors#e\d{3}/);
    }
    await db.disconnect();
  });
});

describe('the constraint families stay classified', () => {
  it('UNIQUE / NOT NULL / FK / CHECK each keep their own code', async () => {
    const { db, ready } = open([
      'PRAGMA foreign_keys = ON',
      'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, age INTEGER CHECK (age >= 0))',
      'CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id))',
      "INSERT INTO users (id, email, name) VALUES (1, 'a@b.c', 'A')",
    ]);
    await ready;

    const dup = await thrown(() => db.raw`INSERT INTO users (email, name) VALUES ('a@b.c', 'B')`);
    assert.ok(dup instanceof UniqueConstraintError, 'UNIQUE');
    assert.equal((dup as UniqueConstraintError).code, 'TURBINE_E008');

    const nn = await thrown(() => db.raw`INSERT INTO users (email) VALUES ('x@y.z')`);
    assert.ok(nn instanceof NotNullViolationError, 'NOT NULL');
    assert.equal((nn as NotNullViolationError).code, 'TURBINE_E010');

    const fk = await thrown(() => db.raw`INSERT INTO posts (id, user_id) VALUES (1, 999)`);
    assert.ok(fk instanceof ForeignKeyError, 'FOREIGN KEY');
    assert.equal((fk as ForeignKeyError).code, 'TURBINE_E009');

    const chk = await thrown(() => db.raw`INSERT INTO users (email, name, age) VALUES ('c@d.e', 'C', -5)`);
    assert.ok(chk instanceof CheckConstraintError, 'CHECK');
    assert.equal((chk as CheckConstraintError).code, 'TURBINE_E011');

    await db.disconnect();
  });

  it('a statement that succeeds still succeeds (anti-vacuous)', async () => {
    const { db, ready } = open([
      'CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL)',
    ]);
    await ready;
    const row = await db.table<{ id: number; email: string; name: string }>('users').create({
      data: { email: 'ok@example.com', name: 'OK' },
    });
    assert.equal(row.email, 'ok@example.com');
    assert.equal((await db.table('users').findMany({ limit: 10 })).length, 1);
    await db.disconnect();
  });
});

describe('sqlite logic errors preserve the driver error as `cause`', () => {
  // Added 0.76.0 alongside `ValidationError`'s optional `{ cause }`. The value
  // is the STACK: without it a `no such table` surfaces with Turbine's frames
  // and none of the driver's. Asserted per shape because each of the three
  // return paths in `sqliteLogicError` constructs its own error.
  for (const [label, sql] of [
    ['no such table', 'SELECT * FROM definitely_not_here'],
    ['no such column', 'SELECT definitely_not_a_column FROM users'],
    ['neither spelling', 'SELEC 1'],
  ] as const) {
    it(`${label}: the ValidationError carries the driver error`, async () => {
      const { db, ready } = open();
      await ready;
      const err = await thrown(() => db.raw([sql] as unknown as TemplateStringsArray));
      await db.disconnect();
      assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
      assert.equal((err as ValidationError).code, 'TURBINE_E003');
      // Anti-vacuous: `'cause' in err` would be satisfied by `cause: undefined`,
      // which is exactly what forwarding an absent argument would produce.
      assert.ok((err as { cause?: unknown }).cause, 'the driver error must be attached as cause');
    });
  }
});
