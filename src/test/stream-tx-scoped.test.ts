/**
 * turbine-orm: findManyStream inside a caller-owned transaction
 *
 * The cursor path (taken only when the result OVERFLOWS `batchSize`) used to
 * `pool.connect()` and unconditionally `release()` even when the interface was
 * transaction-scoped. Inside `$transaction` that connection IS the caller's
 * transaction: the dialect's own BEGIN/COMMIT committed the caller's
 * uncommitted work mid-stream, and the release handed back a connection the
 * caller still owned, so the outer COMMIT/ROLLBACK ran on a released client.
 *
 * These tests drive the real cursor path with a recording pool.
 *
 * Run: npx tsx --test src/test/stream-tx-scoped.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ]),
  },
  enums: {},
};

interface Harness {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool stands in for pg.Pool
  pool: any;
  queries: string[];
  connects: { count: number };
  releases: { count: number };
}

/**
 * A pool that records every statement, every checkout and every release.
 * Rows come from `rowFactory`, so a test can force the overflow that sends
 * findManyStream down the cursor path.
 */
function createHarness(rowFactory: (sql: string) => unknown[]): Harness {
  const queries: string[] = [];
  const connects = { count: 0 };
  const releases = { count: 0 };

  // pg accepts both a SQL string and a { name, text, values } config (the
  // prepared-statement form findMany uses), so the mock reads either.
  const query = async (textOrConfig: string | { text: string }, _values?: unknown[]) => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    queries.push(text);
    const rows = rowFactory(text);
    return { rows, rowCount: rows.length };
  };

  const client = {
    query,
    release() {
      releases.count += 1;
    },
  };

  const pool = {
    query,
    connect: async () => {
      connects.count += 1;
      return client;
    },
  };

  return { pool, queries, connects, releases };
}

/** Rows for the speculative fetch (overflowing) and then two cursor FETCHes. */
function overflowRows(sql: string): unknown[] {
  if (sql.includes('FETCH')) {
    // Two full batches then an empty one ends the cursor loop.
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ];
    }
    if (fetchCalls === 2) return [{ id: 3, name: 'Carol' }];
    return [];
  }
  if (sql.startsWith('SELECT')) {
    // batchSize + 1 rows: overflow, so the cursor path opens.
    return [
      { id: 1, name: 'Alice' },
      { id: 2, name: 'Bob' },
      { id: 3, name: 'Carol' },
    ];
  }
  return [];
}

let fetchCalls = 0;

function makeQi(harness: Harness, txScoped: boolean): QueryInterface<Record<string, unknown>> {
  return new QueryInterface<Record<string, unknown>>(harness.pool, 'users', schema, undefined, {
    _txScoped: txScoped,
  });
}

describe('findManyStream: cursor path inside a transaction', () => {
  it('does not check out or release a connection, and issues no BEGIN/COMMIT', async () => {
    fetchCalls = 0;
    const harness = createHarness(overflowRows);
    const rows: unknown[] = [];

    for await (const row of makeQi(harness, true).findManyStream({ batchSize: 2 })) {
      rows.push(row);
    }

    assert.equal(rows.length, 3, 'all rows drain through the cursor');
    assert.ok(
      harness.queries.some((q) => q.includes('DECLARE')),
      'the overflow must actually take the cursor path',
    );
    assert.equal(harness.connects.count, 0, 'must not check out a connection inside a transaction');
    assert.equal(harness.releases.count, 0, "must not release the caller's transaction connection");
    assert.equal(
      harness.queries.filter((q) => q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK').length,
      0,
      "the stream must not open or end the caller's transaction",
    );
  });

  it('the ambient connection is still usable after the stream finishes', async () => {
    fetchCalls = 0;
    const harness = createHarness(overflowRows);
    const qi = makeQi(harness, true);

    for await (const _row of qi.findManyStream({ batchSize: 2 })) {
      // drain
    }

    // A follow-up query on the same transaction-scoped interface still runs:
    // nothing was committed or released out from under it.
    const after = await qi.findMany({ limit: 1 });
    assert.equal(after.length, 3);
    assert.equal(harness.releases.count, 0);
  });

  it('an error mid-stream does not roll back the ambient transaction', async () => {
    fetchCalls = 0;
    const harness = createHarness((sql) => {
      if (sql.includes('FETCH')) throw new Error('boom');
      return overflowRows(sql);
    });

    await assert.rejects(async () => {
      for await (const _row of makeQi(harness, true).findManyStream({ batchSize: 2 })) {
        // drain
      }
    }, /boom/);

    assert.equal(
      harness.queries.filter((q) => q === 'ROLLBACK').length,
      0,
      "the caller's $transaction owns the rollback, not the stream",
    );
    assert.equal(harness.releases.count, 0);
  });

  it('breaking out of the stream early still CLOSEs the cursor', async () => {
    // The cursor lives on the CALLER's connection here, so skipping CLOSE would
    // leave it open until their transaction ends. The dialect closes it in a
    // `finally`, which the generator's return path (triggered by `break`) runs.
    fetchCalls = 0;
    const harness = createHarness(overflowRows);

    for await (const _row of makeQi(harness, true).findManyStream({ batchSize: 2 })) {
      break; // abandon the stream after the first row
    }

    assert.ok(
      harness.queries.some((q) => q.startsWith('CLOSE ')),
      `early exit must close the cursor, got: ${harness.queries.join(' | ')}`,
    );
    assert.equal(
      harness.queries.filter((q) => q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK').length,
      0,
      "an early exit must still not end the caller's transaction",
    );
    assert.equal(harness.releases.count, 0);
  });

  it('outside a transaction the cursor path still checks out and releases a connection', async () => {
    fetchCalls = 0;
    const harness = createHarness(overflowRows);
    const rows: unknown[] = [];

    for await (const row of makeQi(harness, false).findManyStream({ batchSize: 2 })) {
      rows.push(row);
    }

    assert.equal(rows.length, 3);
    assert.equal(harness.connects.count, 1, 'pool-scoped streaming keeps its dedicated connection');
    assert.equal(harness.releases.count, 1, 'and releases it');
    assert.ok(harness.queries.includes('BEGIN'), 'and still wraps the cursor in its own transaction');
    assert.ok(harness.queries.includes('COMMIT'));
  });

  it('breaking out early outside a transaction closes the cursor, commits and releases', async () => {
    // Without the CLOSE/COMMIT in a `finally`, an early `break` returned a
    // connection to the pool mid-transaction with a live cursor on it.
    fetchCalls = 0;
    const harness = createHarness(overflowRows);

    for await (const _row of makeQi(harness, false).findManyStream({ batchSize: 2 })) {
      break;
    }

    assert.ok(
      harness.queries.some((q) => q.startsWith('CLOSE ')),
      `early exit must close the cursor, got: ${harness.queries.join(' | ')}`,
    );
    assert.ok(harness.queries.includes('COMMIT'), 'and must end the transaction it opened');
    assert.equal(harness.releases.count, 1, 'and must release its dedicated connection');
  });
});
