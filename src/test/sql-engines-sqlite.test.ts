/**
 * turbine-orm/sqlite: one handle, one transaction, and who may use it
 *
 * The SQLite engine runs every statement on ONE `node:sqlite` handle. A handle
 * carries one transaction, so a statement issued outside an open
 * `$transaction` used to run inside it: it reported success, other callers
 * read its uncommitted rows, and it was rolled back with the transaction.
 * These tests run against real `node:sqlite` databases (file-backed where a
 * second connection is needed), not a fake.
 *
 * Run: npx tsx --test src/test/sql-engines-sqlite.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe } from 'node:test';
import { withRetry } from '../client.js';
import { ConnectionError, SerializationFailureError, UnsupportedFeatureError } from '../errors.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const { it } = skipGate(!HAVE_NODE_SQLITE, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

const SCHEMA = schemaDefToMetadata(
  defineSchema({
    tags: {
      id: { type: 'serial', primaryKey: true },
      label: { type: 'text', notNull: true },
    },
  }),
);
const DDL = 'CREATE TABLE tags (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL)';

const dir = HAVE_NODE_SQLITE ? mkdtempSync(join(tmpdir(), 'turbine-sql-engines-')) : '';
let fileSeq = 0;
after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A fresh client with the `tags` table. File-backed unless `memory` is set. */
async function open(options: { memory?: boolean; busyTimeoutMs?: number; file?: string } = {}) {
  const target = options.memory ? ':memory:' : (options.file ?? join(dir, `db-${++fileSeq}.sqlite`));
  const db = turbineSqlite(target, SCHEMA, { warnOnUnlimited: false, busyTimeoutMs: options.busyTimeoutMs });
  if (!options.file) await db.pool.query(DDL);
  return { db, target };
}

async function labels(db: Awaited<ReturnType<typeof open>>['db']): Promise<string[]> {
  const rows = (await db.table('tags').findMany({ orderBy: { id: 'asc' } })) as { label: string }[];
  return rows.map((r) => r.label);
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

describe('a statement outside an open $transaction is not absorbed into it', () => {
  for (const memory of [false, true]) {
    const where = memory ? ':memory:' : 'a file database';
    it(`a write outside survives the transaction's rollback (${where})`, async () => {
      const { db } = await open({ memory });
      const tx = db
        .$transaction(async (t) => {
          await t.table('tags').create({ data: { label: 'in-tx' } });
          await sleep(150);
          throw new Error('roll it back');
        })
        .then(
          () => 'resolved',
          (err: Error) => err.message,
        );
      await sleep(30);
      // Issued while the transaction is open, through the client.
      const outside = await db.table('tags').create({ data: { label: 'outside' } });
      assert.equal((outside as { label: string }).label, 'outside');
      assert.equal(await tx, 'roll it back');
      assert.deepEqual(await labels(db), ['outside'], 'the acknowledged write outside must not be rolled back');
      await db.disconnect();
    });
  }

  it("a read outside does not see the open transaction's uncommitted rows", async () => {
    const { db } = await open();
    let seenDuringTx = -1;
    const tx = db
      .$transaction(async (t) => {
        await t.table('tags').create({ data: { label: 'uncommitted' } });
        await sleep(120);
        throw new Error('roll it back');
      })
      .catch(() => undefined);
    await sleep(20);
    seenDuringTx = await db.table('tags').count({ where: { label: 'uncommitted' } });
    await tx;
    assert.equal(seenDuringTx, 0, 'a dirty read: the count saw a row that was then rolled back');
    await db.disconnect();
  });

  it('a write outside a committed transaction lands after it, not inside it', async () => {
    const { db } = await open();
    const order: string[] = [];
    const tx = db.$transaction(async (t) => {
      await t.table('tags').create({ data: { label: 'tx-1' } });
      await sleep(80);
      await t.table('tags').create({ data: { label: 'tx-2' } });
      order.push('tx-body-done');
    });
    await sleep(20);
    const outside = db
      .table('tags')
      .create({ data: { label: 'outside' } })
      .then(() => order.push('outside-done'));
    await Promise.all([tx, outside]);
    assert.deepEqual(order, ['tx-body-done', 'outside-done']);
    assert.deepEqual(await labels(db), ['tx-1', 'tx-2', 'outside']);
    await db.disconnect();
  });
});

describe('concurrent transactions on one client queue instead of failing', () => {
  it('three overlapping $transaction calls all commit', async () => {
    const { db } = await open();
    const results = await Promise.allSettled(
      [1, 2, 3].map((i) =>
        db.$transaction(async (t) => {
          await t.table('tags').create({ data: { label: `c${i}` } });
          await sleep(15);
          return i;
        }),
      ),
    );
    assert.deepEqual(
      results.map((r) => (r.status === 'fulfilled' ? r.value : String((r.reason as Error).message))),
      [1, 2, 3],
    );
    assert.deepEqual(await labels(db), ['c1', 'c2', 'c3']);
    await db.disconnect();
  });

  it('isolationLevel is accepted (a SQLite transaction is serializable)', async () => {
    const { db } = await open({ memory: true });
    const value = await db.$transaction(async (t) => t.table('tags').count(), { isolationLevel: 'ReadCommitted' });
    assert.equal(value, 0);
    await db.disconnect();
  });
});

describe('a call through the client from inside its own transaction', () => {
  it('a table operation on the client is refused with E017 instead of deadlocking', async () => {
    const { db } = await open({ memory: true });
    const err = await thrown(() =>
      db.$transaction(async (t) => {
        await t.table('tags').create({ data: { label: 'in-tx' } });
        await db.table('tags').count();
      }),
    );
    assert.ok(err instanceof UnsupportedFeatureError, `expected E017, got ${(err as Error)?.constructor?.name}`);
    assert.match((err as Error).message, /`tx` client/);
    assert.deepEqual(await labels(db), [], 'the transaction rolled back');
    await db.disconnect();
  });

  it('a nested db.$transaction inside the callback is refused with E017', async () => {
    const { db } = await open({ memory: true });
    const err = await thrown(() =>
      db.$transaction(async () => {
        await db.$transaction(async (inner) => inner.table('tags').count());
      }),
    );
    assert.ok(err instanceof UnsupportedFeatureError);
    await db.disconnect();
  });

  it('the tx client itself, and a nested tx.$transaction, still work', async () => {
    const { db } = await open({ memory: true });
    await db.$transaction(async (t) => {
      await t.table('tags').create({ data: { label: 'outer' } });
      await t.$transaction(async (inner) => {
        await inner.table('tags').create({ data: { label: 'inner' } });
      });
    });
    assert.deepEqual(await labels(db), ['outer', 'inner']);
    await db.disconnect();
  });
});

describe('waiting is bounded and leaves the client usable', () => {
  it('a statement queued past busyTimeoutMs fails retryable, then the client recovers', async () => {
    const { db } = await open({ busyTimeoutMs: 40 });
    const tx = db.$transaction(async (t) => {
      await t.table('tags').create({ data: { label: 'slow' } });
      await sleep(200);
    });
    await sleep(10);
    const err = await thrown(() => db.table('tags').create({ data: { label: 'impatient' } }));
    assert.ok(err instanceof SerializationFailureError, `got ${(err as Error)?.constructor?.name}`);
    assert.equal((err as SerializationFailureError).isRetryable, true);
    assert.match((err as Error).message, /busyTimeoutMs \(40 ms\)/);
    await tx;
    await db.table('tags').create({ data: { label: 'after' } });
    assert.deepEqual(await labels(db), ['slow', 'after']);
    await db.disconnect();
  });

  it('a timed-out $transaction is rolled back, and its late writes do not land', async () => {
    const { db } = await open();
    let lateWrite: unknown;
    const err = await thrown(() =>
      db.$transaction(
        async (t) => {
          await t.table('tags').create({ data: { label: 'before-timeout' } });
          await sleep(120);
          try {
            await t.table('tags').create({ data: { label: 'late' } });
          } catch (e) {
            lateWrite = e;
          }
        },
        { timeout: 40 },
      ),
    );
    assert.equal((err as { code?: string }).code, 'TURBINE_E002');
    // The handle is free again and the abandoned transaction is gone.
    await db.table('tags').create({ data: { label: 'next' } });
    await sleep(150);
    assert.ok(lateWrite instanceof Error, 'the abandoned callback must not keep writing');
    assert.deepEqual(await labels(db), ['next']);
    await db.disconnect();
  });

  it('a checkout released with its transaction still open rolls it back', async () => {
    const { db } = await open({ memory: true });
    const client = await db.pool.connect();
    await client.query('BEGIN');
    await client.query("INSERT INTO tags (label) VALUES ('abandoned')");
    client.release();
    const late = await thrown(() => client.query('SELECT 1'));
    assert.ok(late instanceof ConnectionError, 'a released checkout must not run statements');
    await db.table('tags').create({ data: { label: 'next' } });
    assert.deepEqual(await labels(db), ['next']);
    await db.disconnect();
  });

  it('a checkout that opens no transaction (a stream) does not block other callers', async () => {
    const { db } = await open();
    for (const label of ['a', 'b', 'c']) await db.table('tags').create({ data: { label } });
    const seen: string[] = [];
    for await (const row of db.table('tags').findManyStream({ orderBy: { id: 'asc' }, batchSize: 1 })) {
      seen.push((row as { label: string }).label);
      // A write through the client while the stream holds its checkout.
      await db.table('tags').update({ where: { id: (row as { id: number }).id }, data: { label: `${seen.at(-1)}!` } });
    }
    assert.deepEqual(seen, ['a', 'b', 'c']);
    assert.deepEqual(await labels(db), ['a!', 'b!', 'c!']);
    await db.disconnect();
  });
});

describe('SQLITE_BUSY from another connection is a retryable typed error on every path', () => {
  it('table operations, the raw pool, and the raw transaction client', async () => {
    const first = await open();
    const second = await open({ file: first.target, busyTimeoutMs: 20 });
    const holder = first.db.$transaction(async (t) => {
      await t.table('tags').create({ data: { label: 'holder' } });
      await sleep(250);
    });
    await sleep(20);
    // The raw paths first: they never pass through wrapPgError.
    const paths: [string, () => Promise<unknown>][] = [
      ['pool.query', () => second.db.pool.query("INSERT INTO tags (label) VALUES ('x')")],
      ['transaction(client)', () => second.db.transaction((c) => c.query("INSERT INTO tags (label) VALUES ('x')"))],
      ['create', () => second.db.table('tags').create({ data: { label: 'x' } })],
      ['$transaction', () => second.db.$transaction((t) => t.table('tags').create({ data: { label: 'x' } }))],
    ];
    for (const [name, run] of paths) {
      const err = await thrown(run);
      assert.ok(err instanceof SerializationFailureError, `${name}: got ${(err as Error)?.constructor?.name}`);
      assert.equal((err as SerializationFailureError).isRetryable, true, name);
      assert.match((err as Error).message, /SQLITE_BUSY/, name);
    }
    // withRetry gets through once the lock is released.
    const retried = await withRetry(() => second.db.table('tags').create({ data: { label: 'retried' } }), {
      maxAttempts: 20,
      baseDelay: 30,
    });
    assert.equal((retried as { label: string }).label, 'retried');
    await holder;
    assert.deepEqual(await labels(first.db), ['holder', 'retried']);
    await second.db.disconnect();
    await first.db.disconnect();
  });
});
