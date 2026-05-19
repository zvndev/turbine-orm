/**
 * turbine-orm — Event emitter ($on / $off) tests
 *
 * Verifies that query events are emitted to registered listeners
 * and that error handling works correctly. No real database needed.
 *
 * Run: npx tsx --test src/test/event-emitter.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import type { QueryEvent } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock pool
// ---------------------------------------------------------------------------

function createMockPool(rows: unknown[] = [{ id: 1 }]): PgCompatPool {
  return {
    query: async () => ({ rows: rows as Record<string, unknown>[], rowCount: rows.length, fields: [] }),
    connect: async () => ({
      query: async () => ({ rows: rows as Record<string, unknown>[], rowCount: rows.length, fields: [] }),
      release: () => {},
    }),
    end: async () => {},
  } as unknown as PgCompatPool;
}

function createSchema(): SchemaMetadata {
  return {
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'email', field: 'email', pgType: 'text' },
      ]),
    },
    enums: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('$on / $off event emitter', () => {
  it('emits query events after findMany', async () => {
    const pool = createMockPool([{ id: 1, name: 'Alice', email: 'a@b.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await db.table('users').findMany();

    assert.equal(events.length, 1);
    assert.equal(events[0]!.model, 'users');
    assert.equal(events[0]!.action, 'findMany');
    assert.ok(events[0]!.sql.includes('SELECT'));
    assert.ok(events[0]!.duration >= 0);
    assert.equal(events[0]!.rows, 1);
    assert.ok(events[0]!.timestamp instanceof Date);
    assert.equal(events[0]!.error, undefined);
  });

  it('emits query events after create', async () => {
    const pool = createMockPool([{ id: 2, name: 'Bob', email: 'b@c.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await db.table('users').create({ data: { name: 'Bob', email: 'b@c.com' } });

    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, 'create');
  });

  it('emits events after update', async () => {
    const pool = createMockPool([{ id: 1, name: 'Updated', email: 'a@b.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await db.table('users').update({ where: { id: 1 }, data: { name: 'Updated' } });

    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, 'update');
  });

  it('emits events after delete', async () => {
    const pool = createMockPool([{ id: 1, name: 'Alice', email: 'a@b.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await db.table('users').delete({ where: { id: 1 } });

    assert.equal(events.length, 1);
    assert.equal(events[0]!.action, 'delete');
  });

  it('$off removes the listener', async () => {
    const pool = createMockPool();
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    const listener = (e: QueryEvent) => events.push(e);
    db.$on('query', listener);

    await db.table('users').findMany();
    assert.equal(events.length, 1);

    db.$off('query', listener);
    await db.table('users').findMany();
    assert.equal(events.length, 1); // still 1
  });

  it('listener errors do not crash the query', async () => {
    const pool = createMockPool([{ id: 1, name: 'Alice', email: 'a@b.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    db.$on('query', () => {
      throw new Error('listener kaboom');
    });

    const result = await db.table('users').findMany();
    assert.equal(result.length, 1);
  });

  it('includes error in event when query fails', async () => {
    const failPool: PgCompatPool = {
      query: async () => {
        throw new Error('pg error');
      },
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0, fields: [] }), release: () => {} }),
      end: async () => {},
    } as unknown as PgCompatPool;

    const db = new TurbineClient({ pool: failPool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await assert.rejects(async () => db.table('users').findMany());

    assert.equal(events.length, 1);
    assert.ok(events[0]!.error instanceof Error);
    assert.equal(events[0]!.rows, 0);
  });

  it('redacts params in safe mode', async () => {
    const pool = createMockPool([{ id: 1, name: 'Alice', email: 'a@b.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'safe' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await db.table('users').findUnique({ where: { id: 1 } });

    assert.equal(events.length, 1);
    assert.ok(events[0]!.params.every((p) => p === '[REDACTED]'));
  });

  it('does not redact params in verbose mode', async () => {
    const pool = createMockPool([{ id: 1, name: 'Alice', email: 'a@b.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await db.table('users').findUnique({ where: { id: 1 } });

    assert.equal(events.length, 1);
    assert.ok(events[0]!.params.some((p) => p === 1));
  });

  it('QueryEvent has correct shape', async () => {
    const pool = createMockPool([{ id: 1, name: 'Alice', email: 'a@b.com' }]);
    const db = new TurbineClient({ pool, errorMessages: 'verbose' }, createSchema());

    const events: QueryEvent[] = [];
    db.$on('query', (e) => events.push(e));

    await db.table('users').findMany({ where: { name: 'Alice' } });

    const event = events[0]!;
    assert.equal(typeof event.sql, 'string');
    assert.ok(Array.isArray(event.params));
    assert.equal(typeof event.duration, 'number');
    assert.equal(typeof event.model, 'string');
    assert.equal(typeof event.action, 'string');
    assert.equal(typeof event.rows, 'number');
    assert.ok(event.timestamp instanceof Date);
  });
});
