/**
 * turbine-orm: an exhausted pool is a typed connection error with the fix.
 *
 * pg-pool rejects a checkout that waited longer than `connectionTimeoutMillis`
 * with a plain `Error('timeout exceeded when trying to connect')` and no code,
 * so the most common production connection failure reached callers untyped:
 * `instanceof ConnectionError` and `code === 'TURBINE_E004'` both missed it,
 * on every entry point. The usual cause inside one process is a query on the
 * outer client from inside a `$transaction` callback, which needs a second
 * connection while the transaction holds the first.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/transactions-pool.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { ConnectionError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

function poolTimeout(err: unknown): boolean {
  assert.ok(err instanceof ConnectionError, `expected ConnectionError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E004');
  assert.match(err.message, /Timed out after 100ms waiting for a free connection/);
  assert.match(err.message, /All 1 connections of the pool were checked out/);
  assert.match(err.message, /use `tx` there/);
  assert.match(err.message, /poolSize/);
  assert.equal((err.cause as Error).message, 'timeout exceeded when trying to connect');
  return true;
}

describe('transactions: pool checkout timeouts are ConnectionError E004 (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;

  before(async () => {
    fx = await openFixture('tx90p');
    await fx.reset();
    db = fx.client({ poolSize: 1, connectionTimeoutMs: 100 });
  });
  after(async () => {
    await fx?.close();
  });

  it('every entry point that needs a second connection inside a transaction gets the typed error', async () => {
    const users = db.table(fx.t.users);
    await db.$transaction(async (tx) => {
      await tx.table(fx.t.users).count();
      await assert.rejects(users.count(), poolTimeout, 'pool.query read');
      await assert.rejects(users.create({ data: { email: 'second@x' } }), poolTimeout, 'pool.query write');
      await assert.rejects(db.raw`SELECT 1`, poolTimeout, 'raw');
      await assert.rejects(
        db.$transaction(async () => 'inner'),
        poolTimeout,
        '$transaction checkout',
      );
      await assert.rejects(
        db.transaction(async () => 'inner'),
        poolTimeout,
        'transaction() checkout',
      );
      await assert.rejects(db.pipeline([users.buildCount()]), poolTimeout, 'pipeline checkout');
      await assert.rejects(
        users.create({ data: { email: 'tree@x', posts: { create: [{ title: 't' }] } } }),
        poolTimeout,
        'nested write checkout',
      );
      await assert.rejects(users.findManyStream({ batchSize: 1 }).next(), poolTimeout, 'stream');
    });
    // The pool is healthy once the transaction released its connection.
    assert.equal(await users.count(), 3);
  });
});
