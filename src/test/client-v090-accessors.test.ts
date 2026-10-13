/**
 * turbine-orm: a method replaced on a table accessor after it was first used
 * is the one that runs. Spies, mocks and APM instrumentation install
 * themselves by assignment, often long after the accessor first ran a query;
 * the accessor used to keep calling the method it saw first.
 *
 * Run: npx tsx --test src/test/client-v090-accessors.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: { users: mockTable('users', [{ name: 'id', field: 'id', pgType: 'int4' }]) },
  enums: {},
};

/** A pool that answers every statement with one row and records the text. */
function recordingPool(label: string, log: string[]): PgCompatPool {
  const answer = async (text: string) => {
    log.push(`${label}: ${text.trim().split(/\s+/)[0]}`);
    return { rows: [{ id: 1, count: 1 }], rowCount: 1, fields: [] };
  };
  return {
    query: answer,
    connect: async () => ({ query: answer, release() {} }),
    end: async () => {},
  } as unknown as PgCompatPool;
}

type Users = Record<string, (...args: unknown[]) => Promise<unknown>>;

describe('a method replaced after first use', () => {
  it('runs on the client accessor, and the original it wraps still works', async () => {
    const log: string[] = [];
    const db = new TurbineClient({ pool: recordingPool('primary', log) }, schema);
    const users = db.table('users') as unknown as Users;
    await users.findMany?.({ limit: 1 });
    await users.count?.();

    const original = users.findMany as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    users.findMany = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };
    const rows = await (db.table('users') as unknown as Users).findMany?.({ limit: 1 });
    assert.equal(calls, 1, 'the replacement ran');
    assert.deepEqual(rows, [{ id: 1, count: 1 }], 'and called through to the original');

    users.count = async () => 42;
    assert.equal(await users.count?.(), 42);
  });

  it('picks up a patch on the QueryInterface prototype', async () => {
    const db = new TurbineClient({ pool: recordingPool('primary', []) }, schema);
    const users = db.table('users') as unknown as Users;
    await users.count?.();
    const proto = QueryInterface.prototype as unknown as Users;
    const original = proto.count as (...a: unknown[]) => Promise<unknown>;
    let seen = 0;
    proto.count = function (this: unknown, ...args: unknown[]) {
      seen++;
      return original.apply(this, args);
    };
    try {
      await users.count?.();
      assert.equal(seen, 1);
    } finally {
      proto.count = original;
    }
  });

  it('runs a read replaced on a replica-routed accessor, which still routes when it calls through', async () => {
    const log: string[] = [];
    const db = new TurbineClient(
      { pool: recordingPool('primary', log), replicas: [recordingPool('replica', log)] },
      schema,
    );
    const users = db.table('users') as unknown as Users;
    await users.findMany?.({ limit: 1 });
    assert.deepEqual(log, ['replica: SELECT']);

    const original = users.findMany as (...a: unknown[]) => Promise<unknown>;
    let calls = 0;
    users.findMany = (...args: unknown[]) => {
      calls++;
      return original(...args);
    };
    await users.findMany?.({ limit: 1 });
    assert.equal(calls, 1);
    assert.deepEqual(log, ['replica: SELECT', 'replica: SELECT']);
  });

  it('runs on a transaction accessor', async () => {
    const db = new TurbineClient({ pool: recordingPool('primary', []) }, schema);
    const calls = await db.$transaction(async (tx) => {
      const users = tx.table('users') as unknown as Users;
      await users.findMany?.({ limit: 1 });
      let n = 0;
      users.findMany = async () => {
        n++;
        return [];
      };
      await (tx.table('users') as unknown as Users).findMany?.({ limit: 1 });
      return n;
    });
    assert.equal(calls, 1);
  });
});
