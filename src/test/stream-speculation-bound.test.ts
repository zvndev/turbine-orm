/**
 * turbine-orm, findManyStream speculative-fetch bound
 *
 * `findManyStream` opens with a speculative `LIMIT batchSize + 1` so a drain
 * that fits in one batch never pays for BEGIN / DECLARE / CLOSE / COMMIT. On
 * OVERFLOW those rows cannot be reused (they were read outside the cursor's
 * transaction), so the cursor re-reads from row one and the fetch was pure
 * waste, `batchSize + 1` rows of it.
 *
 * That made the waste grow with the one number a caller raises when they expect
 * MORE rows, so raising `batchSize` for throughput made large drains slower.
 * The speculation is now bounded BY `batchSize` instead: at or below the
 * default it is unchanged, above it the cursor is used directly.
 *
 * These tests fail if the bound is removed (every "above the bound" case starts
 * issuing the speculative SELECT again) and equally if the bound is applied too
 * eagerly (the "at the bound" cases would stop using it). Row-level parity
 * across the boundary is asserted separately, because a bound that changed
 * RESULTS rather than round trips would be a far worse bug than the one it
 * fixes.
 *
 * Run: npx tsx --test src/test/stream-speculation-bound.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  return {
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
    enums: {},
  };
}

interface Harness {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool shape
  pool: any;
  queries: string[];
  /** Rows handed to the caller across every FETCH and every speculative SELECT. */
  rowsServed: { count: number };
}

/**
 * Mock pool serving `total` rows of `users`, through either the speculative
 * SELECT or a cursor, whichever the code under test asks for.
 */
function harnessFor(total: number): Harness {
  const queries: string[] = [];
  const rowsServed = { count: 0 };
  let cursorPos = 0;

  const rowsFrom = (start: number, n: number): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (let i = start; i < Math.min(start + n, total); i++) out.push({ id: i + 1, name: `u${i + 1}` });
    return out;
  };

  const query = async (text: string, _values?: unknown[]) => {
    queries.push(text);
    let rows: Record<string, unknown>[] = [];
    const fetch = /^FETCH (\d+) FROM/.exec(text);
    if (fetch) {
      rows = rowsFrom(cursorPos, Number(fetch[1]));
      cursorPos += rows.length;
    } else if (text.startsWith('SELECT')) {
      // The speculative fetch. Its LIMIT is bound as a parameter, so serve the
      // whole table and let the caller decide; it only ever asks once.
      const limit = Array.isArray(_values) ? Number(_values[_values.length - 1]) : total;
      rows = rowsFrom(0, Number.isFinite(limit) ? limit : total);
    }
    rowsServed.count += rows.length;
    return { rows, rowCount: rows.length };
  };

  const client = { query, release() {} };
  return { pool: { query, connect: async () => client }, queries, rowsServed };
}

async function drain(
  total: number,
  batchSize?: number,
): Promise<{ rows: Record<string, unknown>[]; harness: Harness }> {
  const harness = harnessFor(total);
  const q = new QueryInterface<Record<string, unknown>>(harness.pool, 'users', buildSchema(), undefined, {
    warnOnUnlimited: false,
  });
  const rows: Record<string, unknown>[] = [];
  const args = batchSize === undefined ? {} : { batchSize };
  for await (const row of q.findManyStream(args)) rows.push(row as Record<string, unknown>);
  return { rows, harness };
}

const speculated = (h: Harness): boolean => h.queries.some((q) => q.startsWith('SELECT'));
const usedCursor = (h: Harness): boolean => h.queries.some((q) => q.startsWith('DECLARE'));

describe('findManyStream speculative-fetch bound', () => {
  it('still speculates when no batch size is given', async () => {
    const { rows, harness } = await drain(5);
    assert.equal(rows.length, 5);
    assert.equal(speculated(harness), true, 'the default drain should still try one statement');
    assert.equal(usedCursor(harness), false, 'and should not open a cursor');
  });

  it('still speculates exactly AT the bound', async () => {
    const { rows, harness } = await drain(5, 1000);
    assert.equal(rows.length, 5);
    assert.equal(speculated(harness), true, 'the bound is inclusive');
    assert.equal(usedCursor(harness), false);
  });

  it('does not speculate above the bound, even when the drain would have fit', async () => {
    // This is the case the bound gives up: 5 rows would have come back in one
    // statement. It costs four round trips and wastes no rows, which is the
    // trade the bound is making.
    const { rows, harness } = await drain(5, 2000);
    assert.equal(rows.length, 5, 'all rows still arrive');
    assert.equal(speculated(harness), false, 'no speculative SELECT above the bound');
    assert.equal(usedCursor(harness), true, 'the cursor is used instead');
  });

  it('fetches each row exactly once on an overflowing drain above the bound', async () => {
    // The actual bug, and it needs a drain that OVERFLOWS: the speculative
    // fetch is only wasted when it fails, and unbounded it wasted
    // `batchSize + 1` rows, so 2,001 of the 2,500 here would be read twice.
    const { rows, harness } = await drain(2500, 2000);
    assert.equal(rows.length, 2500);
    assert.equal(harness.rowsServed.count, 2500, 'no row should be fetched and then thrown away');
  });

  it('yields identical rows either side of the bound', async () => {
    const below = await drain(2500, 1000);
    const above = await drain(2500, 2000);
    assert.deepEqual(above.rows, below.rows, 'the bound must change round trips, never results');
    assert.equal(below.rows.length, 2500);
  });

  it('overflow below the bound still reaches the cursor and yields every row', async () => {
    // Unchanged behaviour, asserted so the bound cannot be widened into the
    // range it is supposed to leave alone without a test noticing.
    const { rows, harness } = await drain(25, 10);
    assert.equal(rows.length, 25);
    assert.equal(speculated(harness), true, 'it should have tried the speculative fetch');
    assert.equal(usedCursor(harness), true, 'and then fallen back to the cursor');
  });
});
