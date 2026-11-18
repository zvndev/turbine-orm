/**
 * turbine-orm: concurrent statements on one transaction go to its connection
 * one at a time.
 *
 * A transaction owns ONE connection, and `Promise.all([tx.a(), tx.b()])` (or a
 * batched relation load inside `$transaction`, which loads siblings
 * concurrently) used to hand both statements to the driver at once. pg 8 then
 * queues the second on the client itself, which it logs as deprecated ("Calling
 * client.query() when the client is already executing a query") and which pg 9
 * removes. The transaction state now sends them in order: each statement waits
 * for the one before it, and one that was queued behind a statement that
 * aborted the transaction is refused rather than sent.
 *
 * Runs against a fake connection that counts how many statements it holds at
 * once. No database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, type PgCompatPoolClient, TurbineClient } from '../client.js';
import { TransactionRolledBackError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: { items: mockTable('items', [{ name: 'id', field: 'id', pgType: 'int4' }]) },
  enums: {},
};

function fakeServer() {
  let inFlight = 0;
  let maxInFlight = 0;
  let aborted = false;
  const sent: string[] = [];
  const client = {
    async query(text: string | { text: string }) {
      const sql = typeof text === 'string' ? text : text.text;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        // Hold the statement across several event-loop turns, as a real round
        // trip does, so overlapping sends would be observed.
        await new Promise((resolve) => setTimeout(resolve, 2));
        sent.push(sql);
        const upper = sql.trim().toUpperCase();
        if (upper === 'COMMIT' || upper === 'ROLLBACK') {
          const tag = aborted ? 'ROLLBACK' : upper;
          aborted = false;
          return { rows: [], rowCount: 0, command: tag };
        }
        if (aborted) throw Object.assign(new Error('aborted'), { code: '25P02', severity: 'ERROR' });
        if (upper.includes('FAIL')) {
          aborted = true;
          throw Object.assign(new Error('boom'), { code: '22012', severity: 'ERROR' });
        }
        return { rows: [{ id: 1 }], rowCount: 1, command: 'SELECT' };
      } finally {
        inFlight--;
      }
    },
    release() {},
    on() {},
    off() {},
    removeListener() {},
  } as unknown as PgCompatPoolClient;
  const pool = {
    connect: async () => client,
    query: (...args: unknown[]) => (client.query as (...a: unknown[]) => Promise<unknown>)(...args),
    end: async () => {},
  } as unknown as PgCompatPool;
  return {
    pool,
    sent,
    get maxInFlight() {
      return maxInFlight;
    },
  };
}

describe('statements on one transaction connection', () => {
  it('concurrent accessor, raw and sql statements are sent one at a time, in call order', async () => {
    const fake = fakeServer();
    const db = new TurbineClient({ pool: fake.pool, preparedStatements: false } as never, schema);
    await db.$transaction(async (tx) => {
      await Promise.all([
        tx.rawUnsafe('SELECT 1'),
        tx.table('items').findMany(),
        tx.rawUnsafe('SELECT 2'),
        tx.sql`SELECT 3`.then((rows) => rows),
        tx.rawUnsafe('SELECT 4'),
      ]);
    });
    assert.equal(fake.maxInFlight, 1, 'the connection never held two statements');
    const body = fake.sent.filter((sql) => !/^(BEGIN|COMMIT)/i.test(sql.trim()));
    assert.equal(body.length, 5, body.join(' | '));
    assert.equal(body[0], 'SELECT 1');
    assert.equal(body[2], 'SELECT 2');
    assert.equal(body[4], 'SELECT 4');
    await db.disconnect();
  });

  it('a statement queued behind one that aborts the transaction is refused, not sent', async () => {
    const fake = fakeServer();
    const db = new TurbineClient({ pool: fake.pool, preparedStatements: false } as never, schema);
    const outcome = await db
      .$transaction(async (tx) => {
        const results = await Promise.allSettled([tx.rawUnsafe('SELECT FAIL'), tx.rawUnsafe('SELECT after')]);
        assert.equal(results[0]!.status, 'rejected');
        assert.equal(results[1]!.status, 'rejected');
        assert.ok((results[1] as PromiseRejectedResult).reason instanceof TransactionRolledBackError);
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    assert.ok(outcome instanceof TransactionRolledBackError, String(outcome));
    assert.equal(fake.sent.includes('SELECT after'), false, 'the queued statement never reached the server');
    await db.disconnect();
  });
});
