/** Real SQL effects through the isolated transport, without an installed driver. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import type { Dialect } from '../../dialect.js';
import { ValidationError } from '../../errors.js';
import type { PgCompatPoolClient, PgCompatQueryConfig } from '../../pg-types.js';
import { TransactionState } from '../../transaction-state.js';
import { createTransactionPool, guardTransactionConnection } from '../../transaction-transport.js';

// Only these dialect members are consumed by TransactionState. Keeping this
// test adapter independent of an engine entry point exercises the boundary.
const dialect = {
  capabilities: { abortsTransactionOnError: false, statementSyntax: 'sqlite' },
  savepointStatement: (name: string) => `SAVEPOINT ${name}`,
  releaseSavepointStatement: (name: string) => `RELEASE SAVEPOINT ${name}`,
  rollbackToSavepointStatement: (name: string) => `ROLLBACK TO SAVEPOINT ${name}`,
} as Pick<
  Dialect,
  'capabilities' | 'savepointStatement' | 'releaseSavepointStatement' | 'rollbackToSavepointStatement'
>;

export async function run(): Promise<void> {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)');
  const sent: Array<string | PgCompatQueryConfig> = [];
  let releases = 0;
  let steps = 0;
  let closed = 0;
  const client = {
    query: async (statement: string | PgCompatQueryConfig, values?: unknown[]) => {
      sent.push(statement);
      const sql = typeof statement === 'string' ? statement : statement.text;
      const params = (typeof statement === 'string' ? values : statement.values) ?? [];
      const prepared = db.prepare(sql);
      if (prepared.columns().length > 0) {
        const rows = prepared.all(...(params as never[]));
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: Number(prepared.run(...(params as never[])).changes) };
    },
    async *streamBatches(text: string, values: unknown[], batchSize: number) {
      const rows = db.prepare(text).iterate(...(values as never[]));
      try {
        let batch: Record<string, unknown>[] = [];
        for (const row of rows) {
          steps++;
          batch.push(row);
          if (batch.length === batchSize) {
            yield batch;
            batch = [];
          }
        }
        if (batch.length > 0) yield batch;
      } finally {
        rows.return?.();
        closed++;
      }
    },
    release() {
      releases++;
    },
  } as PgCompatPoolClient;

  try {
    db.exec('BEGIN');
    const state = new TransactionState(client, dialect, { userTransaction: true });
    const capabilities = { native: true };
    const pool = createTransactionPool(client, state, state.rootScope, { readonly: false, capabilities });
    const flags = pool as typeof pool & { readonly: boolean; capabilities: unknown };
    assert.equal(flags.readonly, false);
    assert.equal(flags.capabilities, capabilities);
    const raw = guardTransactionConnection(client, state, state.rootScope, '$connection()');
    const prepared = { name: 'insert-item', text: 'INSERT INTO items VALUES (?, ?)', values: [1, 'kept'] };
    const result = await (pool.query as unknown as typeof client.query)(prepared as never);
    assert.equal(result.rowCount, 1);
    assert.equal(sent[0], prepared, 'prepared config identity reaches the driver');
    await state.enter(() =>
      assert.rejects(
        state.withBlock(async (scope) => {
          const inner = createTransactionPool(client, state, scope);
          await inner.query('INSERT INTO items VALUES (?, ?)', [2, 'rolled back']);
          const before = sent.length;
          await assert.rejects(pool.query('INSERT INTO items VALUES (?, ?)', [3, 'wrong scope']), /outer `tx`/);
          assert.equal(sent.length, before, 'outer-handle refusal sends no SQL');
          throw new Error('undo this block');
        }, state.rootScope),
        /undo this block/,
      ),
    );
    assert.deepEqual(
      db
        .prepare('SELECT id, label FROM items ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [{ id: 1, label: 'kept' }],
    );
    const beforeControl = sent.length;
    await assert.rejects(raw.query('COMMIT'), ValidationError);
    await assert.rejects(raw.query('ROLLBACK'), ValidationError);
    assert.equal(sent.length, beforeControl);
    assert.equal(db.isTransaction, true);
    assert.throws(() => raw.release(), /must not release/);
    assert.equal(releases, 0);
    const borrowed = await pool.connect();
    borrowed.release();
    assert.equal(releases, 0, 'a scoped checkout cannot release the owner');
    await borrowed.query('INSERT INTO items VALUES (?, ?)', [4, 'also kept']);

    const stream = pool.streamBatches!('SELECT id FROM items ORDER BY id', [], 1);
    assert.deepEqual(
      (await stream.next()).value?.map((row) => ({ ...row })),
      [{ id: 1 }],
    );
    assert.equal(steps, 1, 'one pull must not consume the next batch');
    await stream.return(undefined);
    assert.equal(closed, 1);
    const expired = raw.streamBatches!('SELECT id FROM items ORDER BY id', [], 1);
    await expired.next();
    state.end('committed');
    db.exec('COMMIT');
    const atEnd = sent.length;
    await assert.rejects(expired.next(), /transaction committed/);
    assert.equal(closed, 2, 'an expired pull still closes the native iterator');
    await assert.rejects(pool.query('INSERT INTO items VALUES (?, ?)', [5, 'too late']), ValidationError);
    await assert.rejects(raw.query('INSERT INTO items VALUES (?, ?)', [6, 'too late']), ValidationError);
    await assert.rejects(pool.connect(), ValidationError);
    assert.equal(sent.length, atEnd);
    assert.deepEqual(
      db
        .prepare('SELECT id FROM items ORDER BY id')
        .all()
        .map((row) => row.id),
      [1, 4],
    );
    assert.equal(releases, 0);

    // The same connection can serve a new transaction without accepting an
    // old handle's writes. Rollback must also undo a successfully issued write.
    db.exec('BEGIN');
    const next = new TransactionState(client, dialect);
    const nextPool = createTransactionPool(client, next, next.rootScope);
    await nextPool.query('INSERT INTO items VALUES (?, ?)', [7, 'undo']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get()!.n, 3);
    await assert.rejects(pool.query('DELETE FROM items'), ValidationError);
    next.end('was rolled back');
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items').get()!.n, 2);
  } finally {
    db.close();
  }
}
