/**
 * turbine-orm: writes that take several statements.
 *
 *   - A `createMany` split into chunks (over the engine's bind-parameter
 *     limit) inside `$transaction` runs in a savepoint, so a chunk that fails
 *     and is caught cannot leave the chunks before it to be committed.
 *   - On a pool with no `connect()` (a stateless HTTP driver), the writes and
 *     APIs that need a connection of their own are refused with
 *     `UnsupportedFeatureError` (E017) naming the alternative, instead of a
 *     `TypeError` from inside the driver call.
 *
 * SQLite in memory, no server needed.
 *
 * Run: npx tsx --test src/test/client-v090-tx-writes.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { TimeoutError, UniqueConstraintError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { SqlitePool, sqliteDialect } from '../sqlite.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    items: mockTable('items', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'code', field: 'code', pgType: 'text', unique: true },
    ]),
  },
  enums: {},
};

async function sqliteClient(): Promise<{ db: TurbineClient; codes: () => string[] }> {
  const { DatabaseSync } = await import('node:sqlite');
  const handle = new DatabaseSync(':memory:');
  handle.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)');
  handle.exec("INSERT INTO items (code) VALUES ('taken')");
  const db = new TurbineClient(
    // Two bound values per statement, so five rows insert in three chunks.
    { pool: new SqlitePool(handle), dialect: { ...sqliteDialect, maxBindParameters: 2 }, preparedStatements: false },
    schema,
  );
  const codes = () =>
    (handle.prepare('SELECT code FROM items ORDER BY id').all() as Array<{ code: string }>).map((r) => r.code);
  return { db, codes };
}

describe('chunked createMany inside $transaction', () => {
  it('keeps none of its chunks when a later one fails and the caller commits anyway', async () => {
    const { db, codes } = await sqliteClient();
    let caught: unknown;
    await db.$transaction(async (tx) => {
      await tx.table('items').create({ data: { code: 'before' } });
      try {
        await tx.table('items').createMany({ data: ['a', 'b', 'c', 'd', 'taken'].map((code) => ({ code })) });
      } catch (err) {
        caught = err;
      }
      await tx.table('items').create({ data: { code: 'after' } });
    });
    assert.ok(caught instanceof UniqueConstraintError, `expected the duplicate to fail, got ${String(caught)}`);
    assert.deepEqual(codes(), ['taken', 'before', 'after']);
  });

  it('inserts every chunk when none fails', async () => {
    const { db, codes } = await sqliteClient();
    const rows = await db.$transaction((tx) =>
      tx.table('items').createMany({ data: ['a', 'b', 'c', 'd', 'e'].map((code) => ({ code })) }),
    );
    assert.equal(rows.length, 5);
    assert.deepEqual(codes(), ['taken', 'a', 'b', 'c', 'd', 'e']);
  });
});

describe('a pool with no connect()', () => {
  const connectless = (): PgCompatPool =>
    ({
      query: async () => ({ rows: [], rowCount: 0 }),
      end: async () => {},
    }) as unknown as PgCompatPool;

  const refused = (pattern: RegExp) => (err: unknown) =>
    err instanceof UnsupportedFeatureError && err.code === 'TURBINE_E017' && pattern.test(err.message);

  it('refuses a chunked createMany, naming the rows per call that fit one statement', async () => {
    const db = new TurbineClient(
      { pool: connectless(), dialect: { ...sqliteDialect, maxBindParameters: 2 }, preparedStatements: false },
      schema,
    );
    await assert.rejects(
      db.table('items').createMany({ data: ['a', 'b', 'c'].map((code) => ({ code })) }),
      refused(/createMany of 3 rows on a pool without connect\(\)[\s\S]*Insert at most 2 rows per call/),
    );
  });

  it('refuses a write that reads its row back with a second statement (MySQL)', async () => {
    const db = new TurbineClient({ pool: connectless(), dialect: mysqlDialect, preparedStatements: false }, schema);
    await assert.rejects(
      db.table('items').create({ data: { code: 'x' } }),
      refused(/A mysql write on a pool without connect\(\)[\s\S]*Pass a pool that can check out a connection/),
    );
  });

  it('refuses $transaction, naming what it needs', async () => {
    const db = new TurbineClient({ pool: connectless() }, schema);
    await assert.rejects(
      db.$transaction(async () => 1),
      refused(/needs a connection of its own, and this pool has no `connect\(\)`/),
    );
  });
});

describe('a timed statement in a transaction whose cancel is not confirmed', () => {
  /**
   * A node-postgres-shaped connection whose backend cannot be reached for a
   * cancel (port 1 refuses), and whose first count answers only after the
   * cancel grace period: the statement may or may not have run.
   */
  function unconfirmedCancelPool(sent: string[]): PgCompatPool {
    let slow = true;
    const client = {
      processID: 1,
      secretKey: 2,
      host: '127.0.0.1',
      port: 1,
      query: async (text: string) => {
        sent.push(text.trim());
        if (/count\(/i.test(text) && slow) {
          slow = false;
          await new Promise((resolve) => setTimeout(resolve, 2300));
          return { rows: [{ count: 1 }], rowCount: 1, fields: [] };
        }
        return { rows: [], rowCount: 0, fields: [] };
      },
      release() {},
      on() {},
    };
    return { query: client.query, connect: async () => client, end: async () => {} } as unknown as PgCompatPool;
  }

  it('a nested block that catches the timeout rolls back to its savepoint, and the rest commits', async () => {
    const sent: string[] = [];
    const db = new TurbineClient({ pool: unconfirmedCancelPool(sent) }, schema);
    let caught: unknown;
    await db.$transaction(async (tx) => {
      await assert.rejects(
        tx.$transaction(async (inner) => {
          try {
            await inner.table('items').count({ timeout: 50 });
          } catch (err) {
            caught = err;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }),
        (err: unknown) =>
          err instanceof ValidationError && /nested `\$transaction` block was rolled back/.test(err.message),
      );
    });
    assert.ok(caught instanceof TimeoutError, String(caught));
    assert.ok(
      sent.some((t) => /^ROLLBACK TO SAVEPOINT/.test(t)),
      sent.join(' | '),
    );
    assert.ok(!sent.some((t) => /^RELEASE SAVEPOINT/.test(t)), sent.join(' | '));
    assert.equal(sent.at(-1), 'COMMIT');
  });

  it('ends the transaction: a callback that catches the timeout cannot commit', async () => {
    const sent: string[] = [];
    const db = new TurbineClient({ pool: unconfirmedCancelPool(sent) }, schema);
    let caught: unknown;
    await assert.rejects(
      db.$transaction(async (tx) => {
        try {
          await tx.table('items').count({ timeout: 50 });
        } catch (err) {
          caught = err;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'done';
      }),
      (err: unknown) =>
        err instanceof ValidationError && /rolled back, not committed/.test(err.message) && err.cause === caught,
    );
    assert.ok(caught instanceof TimeoutError, String(caught));
    assert.equal(caught.outcome, 'not-executed');
    assert.match(caught.message, /did not confirm its cancellation[\s\S]*rolls back instead of committing/);
    assert.ok(!sent.includes('COMMIT'), sent.join(' | '));
    assert.ok(sent.includes('ROLLBACK'), sent.join(' | '));
  });
});
