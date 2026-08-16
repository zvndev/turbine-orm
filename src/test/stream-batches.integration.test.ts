/**
 * turbine-orm, findManyStreamBatches against a live PostgreSQL
 *
 * The build-only suite (`stream-batches.test.ts`) proves the two streaming APIs
 * share one statement builder and one row parser, using a mock pool that serves
 * rows the test itself wrote. That deliberately cannot see the half of a row's
 * value that the DRIVER decides: pg type parsers turn `timestamptz` into a
 * `Date`, `jsonb` into an object, `text[]` into an array, and `bigint` into a
 * number only because the client registered a parser for it.
 *
 * So the parity claim is re-run here over real rows off a real cursor, on the
 * shared fixture (`fixtures/seed.sql`), read-only: whatever the per-row API
 * yields, the batch API must yield the same, in the same order, with the same
 * values of the same JS types.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/stream-batches.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping findManyStreamBatches integration tests: DATABASE_URL not set');
}
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

let schema: SchemaMetadata;
let db: TurbineClient;
/** A second client with the positional wire encoding, a different decode path. */
let positionalDb: TurbineClient;

// biome-ignore lint/suspicious/noExplicitAny: these suites drive untyped table accessors
type Any = any;

/** Drain the per-row API into an array. */
async function viaRows(table: Any, args: Any): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const row of table.findManyStream(args)) out.push(row);
  return out;
}

/** Drain the batch API, keeping the batch boundaries. */
async function viaBatches(table: Any, args: Any): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for await (const batch of table.findManyStreamBatches(args)) out.push(batch);
  return out;
}

/**
 * The whole contract in one assertion: same rows, same order, same JS values,
 * and every batch non-empty and within `batchSize`.
 *
 * The reference is a plain `findMany` with the same arguments rather than a row
 * COUNT, for two reasons. A count only proves the drains are the same length,
 * and it would pin this suite to the fixture's exact population, which other
 * suites in the same database are free to change. `findMany` pins the values.
 */
async function assertParity(table: Any, args: Any): Promise<void> {
  const { batchSize: _drop, ...findManyArgs } = args ?? {};
  const reference = await table.findMany(findManyArgs);
  const rows = await viaRows(table, args);
  const batches = await viaBatches(table, args);
  const flattened = batches.flat();

  assert.ok(reference.length > 0, 'the fixture must actually contain rows, or this asserts nothing');
  assert.deepEqual(rows, reference, 'the per-row drain must match findMany');
  assert.deepEqual(flattened, rows, 'the batch drain must return exactly the same rows in the same order');

  const limit = args?.batchSize ?? 1000;
  for (const batch of batches) {
    assert.ok(Array.isArray(batch), 'every yielded value must be an array');
    assert.ok(batch.length > 0, 'an empty batch must never be yielded');
    assert.ok(batch.length <= limit, `a batch may never exceed batchSize (${batch.length} > ${limit})`);
  }
}

describe('findManyStreamBatches: live parity with findManyStream', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5, warnOnUnlimited: false }, schema);
    positionalDb = new TurbineClient(
      { connectionString: DATABASE_URL!, poolSize: 3, warnOnUnlimited: false, jsonEncoding: 'positional' },
      schema,
    );
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    if (positionalDb) await positionalDb.disconnect();
  });

  it('over the cursor path, with driver-parsed timestamps and bigints', async () => {
    // A batchSize far below the fixture's size forces DECLARE / FETCH and a
    // short final batch. The rows carry a timestamptz and a bigint FK, both
    // parsed by the driver, which is what this run adds over the mock suite.
    const comments = (db as Any).comments;
    await assertParity(comments, { orderBy: { id: 'asc' }, batchSize: 3 });

    const batches = await viaBatches(comments, { orderBy: { id: 'asc' }, batchSize: 3 });
    assert.ok(batches.length > 1, 'batchSize 3 must overflow the fixture and open a cursor');
    const first = batches[0]!;
    assert.equal(first.length, 3, 'a full batch is exactly batchSize rows');
    assert.ok((first[0] as { createdAt: unknown }).createdAt instanceof Date, 'driver type parsing must survive');
  });

  it('over the speculative fast path, where no cursor is opened at all', async () => {
    // At the default batch size the whole table fits inside one batch, so this
    // exercises the branch that returns before DECLARE and yields one array.
    const batches = await viaBatches((db as Any).comments, { orderBy: { id: 'asc' } });
    assert.equal(batches.length, 1, 'a result set that fits in one batch arrives as one batch');
    await assertParity((db as Any).comments, { orderBy: { id: 'asc' } });
  });

  it('with nested relations, two levels deep', async () => {
    await assertParity((db as Any).users, {
      orderBy: { id: 'asc' },
      batchSize: 2,
      with: { posts: { with: { comments: true } }, organization: true },
    });
  });

  it('with the positional wire encoding, a different relation decode path', async () => {
    await assertParity((positionalDb as Any).users, { orderBy: { id: 'asc' }, batchSize: 3, with: { posts: true } });
  });

  it("with relationLoadStrategy: 'flatten', where the to-one relation is a join, not JSON", async () => {
    await assertParity((db as Any).users, {
      orderBy: { id: 'asc' },
      batchSize: 3,
      with: { organization: true },
      relationLoadStrategy: 'flatten',
    });
  });

  it('with select and omit projections', async () => {
    await assertParity((db as Any).posts, { orderBy: { id: 'asc' }, batchSize: 4, select: { id: true, title: true } });
    await assertParity((db as Any).posts, { orderBy: { id: 'asc' }, batchSize: 4, omit: { content: true } });
  });

  it('inside a caller-owned transaction, riding the transaction’s own connection', async () => {
    await db.$transaction(async (tx) => {
      // No BEGIN/COMMIT of its own and no checkout: if the batch path got that
      // wrong, the transaction would be gone by the time this callback returns.
      const before = await (tx as Any).comments.count();
      await assertParity((tx as Any).comments, { orderBy: { id: 'asc' }, batchSize: 3 });
      assert.equal(await (tx as Any).comments.count(), before, 'the transaction must still be usable after the drains');
    });
  });

  it('releases its connection when the consumer breaks after the first batch', async () => {
    // A leaked connection is invisible until the pool is exhausted, so this
    // breaks out more times than the pool has connections and then reads again.
    const before = await (db as Any).comments.count();
    for (let i = 0; i < 8; i++) {
      for await (const batch of (db as Any).comments.findManyStreamBatches({ orderBy: { id: 'asc' }, batchSize: 3 })) {
        assert.equal(batch.length, 3);
        break;
      }
    }
    assert.equal(await (db as Any).comments.count(), before, 'the pool must still hand out a connection');
  });
});
