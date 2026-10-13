/**
 * turbine-orm: the TransactionClient registration slot
 *
 * query/builder.ts opens an implicit transaction for a nested write (and for
 * an upsert that looks its row up first) and needs `TransactionClient` to do
 * it. It cannot import client.ts (client.ts imports query/), and it no longer
 * reaches it with a dynamic `import()`, which made a non-splitting bundler wrap
 * the whole client graph in lazy-init closures. client.ts registers the class
 * in src/transaction-client-slot.ts when it is evaluated instead.
 *
 * This file must NOT load client.ts before its last test: the first tests
 * prove what happens when the slot is empty (a typed error, only on the path
 * that needs the class, before any connection is checked out), and the last
 * one loads client.ts and proves the registration. node:test runs each file in
 * its own process and the tests below in order.
 *
 * Run: npx tsx --test src/test/transaction-client-slot.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { registeredTransactionClient } from '../transaction-client-slot.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    users: mockTable(
      'users',
      [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    posts: mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'user_id', field: 'userId' },
    ]),
  },
  enums: {},
};

function createHarness() {
  const statements: string[] = [];
  let connects = 0;
  const query = async (textOrConfig: string | { text: string }) => {
    statements.push(typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text);
    return { rows: [{ id: 1, name: 'Alice' }], rowCount: 1 };
  };
  const client = { query, release() {} };
  const pool = {
    query,
    connect: async () => {
      connects += 1;
      return client;
    },
  };
  return {
    // biome-ignore lint/suspicious/noExplicitAny: mock pool stands in for pg.Pool
    pool: pool as any,
    statements,
    connects: () => connects,
  };
}

function assertSlotError(err: unknown): true {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E003');
  assert.match(err.message, /on "users" outside a transaction/);
  assert.match(err.message, /TurbineClient was never loaded/);
  assert.match(err.message, /db\.\$transaction\(\)/);
  return true;
}

describe('TransactionClient slot', () => {
  it('is empty in a process that never loaded client.ts', () => {
    // Anti-vacuous: if an import above ever starts pulling client.ts in, every
    // empty-slot assertion below would be testing a filled slot.
    assert.equal(registeredTransactionClient(), undefined);
  });

  it('an empty slot fails a nested write with E003 before any connection is checked out', async () => {
    const h = createHarness();
    const qi = new QueryInterface<Record<string, unknown>>(h.pool, 'users', schema);

    await assert.rejects(
      () => qi.create({ data: { name: 'Alice', posts: { create: [{ title: 'Hi' }] } } } as never),
      assertSlotError,
    );
    await assert.rejects(
      () => qi.update({ where: { id: 1 }, data: { posts: { create: [{ title: 'Hi' }] } } } as never),
      assertSlotError,
    );
    assert.equal(h.connects(), 0, 'no checkout, so no BEGIN and no stray ROLLBACK');
    assert.deepEqual(h.statements, []);
  });

  it('an empty slot fails a lookup-first upsert the same way', async () => {
    const h = createHarness();
    const qi = new QueryInterface<Record<string, unknown>>(h.pool, 'users', schema);

    // `where` is not pinned to `create`, so upsert looks the row up in a
    // transaction of its own (upsertLookupReason).
    await assert.rejects(
      () => qi.upsert({ where: { id: 5 }, create: { name: 'Alice' }, update: { name: 'Bob' } } as never),
      assertSlotError,
    );
    assert.equal(h.connects(), 0);
  });

  it('an empty slot leaves every path that needs no transaction working', async () => {
    const h = createHarness();
    const qi = new QueryInterface<Record<string, unknown>>(h.pool, 'users', schema);

    const rows = await qi.findMany({ where: { id: 1 } } as never);
    assert.equal(rows.length, 1);
    const created = await qi.create({ data: { name: 'Alice' } } as never);
    assert.equal((created as { name: string }).name, 'Alice');
    assert.equal(h.statements.length, 2);
    assert.ok(!h.statements.some((s) => s === 'BEGIN'), 'a plain write opens no transaction');
  });

  it('loading client.ts registers its own TransactionClient, and the nested write runs in one transaction', async () => {
    const { TransactionClient } = await import('../client.js');
    assert.equal(registeredTransactionClient(), TransactionClient);

    const h = createHarness();
    const qi = new QueryInterface<Record<string, unknown>>(h.pool, 'users', schema);
    await qi.create({ data: { name: 'Alice', posts: { create: [{ title: 'Hi' }] } } } as never);

    assert.equal(h.connects(), 1);
    assert.equal(h.statements[0], 'BEGIN');
    assert.equal(h.statements.at(-1), 'COMMIT');
    assert.ok(
      h.statements.some((s) => /INSERT INTO "posts"/.test(s)),
      'the nested create ran through the transaction',
    );
  });
});
