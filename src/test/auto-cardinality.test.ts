/**
 * turbine-orm, `relationLoadStrategy: 'auto'` cardinality rules
 *
 * Index presence alone is the wrong signal for a TO-ONE relation: compiled into
 * the join plan it is a correlated subquery the engine re-evaluates once per
 * parent row, so its cost scales with the parent set size no matter how well the
 * correlation column is indexed. `'auto'` therefore prefers the batched loader
 * for a to-one relation whose parent set is potentially large (no `limit`, or a
 * `limit` above AUTO_TO_ONE_JOIN_MAX_ROWS) and keeps the single-statement join
 * when the `limit` bounds it small.
 *
 * The reserved `_count` key is the mirror case: an inline `_count` is also one
 * correlated COUNT(*) per parent row, so its unindexed-probe fallback only pays
 * for itself when there are many parents; for a handful the extra round-trip
 * costs more than the repeated small scans.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type pg from 'pg';
import type { QueryEvent } from '../query/deferred.js';
import {
  AUTO_ASSUMED_ROUND_TRIP_MS,
  AUTO_JOIN_PENALTY_MS_PER_ROW,
  AUTO_TO_ONE_JOIN_MAX_ROWS,
  AUTO_TO_ONE_JOIN_ROWS_MAX,
  AUTO_TO_ONE_JOIN_ROWS_MIN,
  QueryInterface,
} from '../query/index.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { IndexMetadata, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

afterEach(() => resetWarnOnce(WARN_NS.autoStrategy));

const idx = (name: string, columns: string[]): IndexMetadata => ({ name, columns, unique: false, definition: '' });

/** Records every statement; answers with one stitchable parent row. */
function capturePool(): { pool: pg.Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const respond = (sql: string): pg.QueryResult => {
    if (/FROM "order_items"/.test(sql)) {
      return { rows: [{ id: 1, order_id: 7 }], rowCount: 1 } as unknown as pg.QueryResult;
    }
    if (/FROM "orders"/.test(sql)) return { rows: [{ id: 7, vendor_id: 3 }], rowCount: 1 } as unknown as pg.QueryResult;
    return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
  };
  const pool = {
    query: (arg: unknown, params?: unknown[]) => {
      const sql = typeof arg === 'string' ? arg : (arg as { text: string }).text;
      const p = (typeof arg === 'string' ? params : (arg as { values?: unknown[] }).values) ?? [];
      calls.push({ sql, params: p });
      return Promise.resolve(respond(sql));
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

/**
 * order_items → order (belongsTo, INDEXED FK), order → vendor (belongsTo,
 * INDEXED FK), order_items → notes (hasMany, INDEXED child FK), order_items →
 * flags (hasMany, UNINDEXED child FK, used for the `_count` cases).
 */
function schema(): SchemaMetadata {
  const orderItems = mockTable(
    'order_items',
    [
      { name: 'id', field: 'id' },
      { name: 'order_id', field: 'orderId' },
    ],
    {
      order: {
        type: 'belongsTo',
        name: 'order',
        from: 'order_items',
        to: 'orders',
        foreignKey: 'order_id',
        referenceKey: 'id',
      },
      notes: {
        type: 'hasMany',
        name: 'notes',
        from: 'order_items',
        to: 'notes',
        foreignKey: 'order_item_id',
        referenceKey: 'id',
      },
      flags: {
        type: 'hasMany',
        name: 'flags',
        from: 'order_items',
        to: 'flags',
        foreignKey: 'order_item_id',
        referenceKey: 'id',
      },
    },
  );
  orderItems.indexes = [idx('idx_order_items_order_id', ['order_id'])];
  const orders = mockTable(
    'orders',
    [
      { name: 'id', field: 'id' },
      { name: 'vendor_id', field: 'vendorId' },
    ],
    {
      vendor: {
        type: 'belongsTo',
        name: 'vendor',
        from: 'orders',
        to: 'vendors',
        foreignKey: 'vendor_id',
        referenceKey: 'id',
      },
    },
  );
  orders.indexes = [idx('idx_orders_vendor_id', ['vendor_id'])];
  const vendors = mockTable('vendors', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  const notes = mockTable('notes', [
    { name: 'id', field: 'id' },
    { name: 'order_item_id', field: 'orderItemId' },
  ]);
  notes.indexes = [idx('idx_notes_order_item_id', ['order_item_id'])];
  const flags = mockTable('flags', [
    { name: 'id', field: 'id' },
    { name: 'order_item_id', field: 'orderItemId' },
  ]);
  flags.uniqueColumns = [['id']]; // order_item_id UNINDEXED
  return { enums: {}, tables: { order_items: orderItems, orders, vendors, notes, flags } };
}

function db(opts?: Record<string, unknown>): {
  q: QueryInterface<Record<string, unknown>>;
  calls: { sql: string; params: unknown[] }[];
} {
  const { pool, calls } = capturePool();
  return { q: new QueryInterface(pool, 'order_items', schema(), [], opts), calls };
}

describe("'auto', to-one cardinality", () => {
  it('an unbounded to-one include loads batched even though the FK is indexed', async () => {
    const { q, calls } = db();
    await q.findMany({ with: { order: { with: { vendor: true } } } } as never);
    const base = calls.find((c) => /FROM "order_items"/.test(c.sql))!;
    assert.doesNotMatch(base.sql, /json_build_object/, 'the to-one subquery left the base statement');
    assert.ok(
      calls.some((c) => /FROM "orders"/.test(c.sql)),
      'a flat follow-up loads the to-one parent',
    );
  });

  it('a small limit keeps the to-one include in the single-statement join', async () => {
    const { q, calls } = db();
    await q.findMany({ limit: 50, with: { order: { with: { vendor: true } } } } as never);
    assert.equal(calls.length, 1, 'bounded parent set → one statement');
    assert.match(calls[0]!.sql, /json_build_object/);
  });

  it('a limit above the threshold loads batched again', async () => {
    const { q, calls } = db();
    await q.findMany({ limit: 5000, with: { order: true } } as never);
    assert.ok(calls.length > 1, 'unbounded-in-practice parent set → batched');
  });

  it('the default threshold is the assumed round trip divided by the per-row penalty', () => {
    // The three constants must stay algebraically consistent, and the derived
    // default must reproduce the 1000 rows this heuristic has always shipped —
    // an unconfigured client must not silently change plans.
    assert.equal(
      AUTO_TO_ONE_JOIN_MAX_ROWS,
      Math.round(AUTO_ASSUMED_ROUND_TRIP_MS / AUTO_JOIN_PENALTY_MS_PER_ROW),
      'the default must be derived, not independently hard-coded',
    );
    assert.equal(AUTO_TO_ONE_JOIN_MAX_ROWS, 1000, 'back-compat: the shipped default is unchanged');
  });

  it('autoRoundTripMs derives the threshold, and brackets it correctly', async () => {
    // 0.13ms (a loopback link, measured) → round(0.13 / 0.0007) = 186 rows.
    const threshold = Math.round(0.13 / AUTO_JOIN_PENALTY_MS_PER_ROW);
    assert.equal(threshold, 186);

    const under = db({ autoRoundTripMs: 0.13 });
    await under.q.findMany({ limit: threshold, with: { order: true } } as never);
    assert.equal(under.calls.length, 1, `limit ${threshold} is AT the threshold → join`);

    const over = db({ autoRoundTripMs: 0.13 });
    await over.q.findMany({ limit: threshold + 1, with: { order: true } } as never);
    assert.ok(over.calls.length > 1, `limit ${threshold + 1} is above the threshold → batched`);

    // The same limit that batches on a fast link stays on the join plan for a
    // cross-region one, which is the entire point of deriving from latency.
    const farAway = db({ autoRoundTripMs: 35 });
    await farAway.q.findMany({ limit: threshold + 1, with: { order: true } } as never);
    assert.equal(farAway.calls.length, 1, 'a 35ms link pays for far more per-row join work');
  });

  it('a derived threshold is clamped, an explicit row count is not', async () => {
    // An absurdly fast reading must not push the switch into the band where the
    // join plan wins by a lot on a handful of rows.
    const tiny = db({ autoRoundTripMs: 0.000001 });
    await tiny.q.findMany({ limit: AUTO_TO_ONE_JOIN_ROWS_MIN, with: { order: true } } as never);
    assert.equal(tiny.calls.length, 1, `clamped up to ${AUTO_TO_ONE_JOIN_ROWS_MIN} rows → still join`);

    const huge = db({ autoRoundTripMs: 10_000 });
    await huge.q.findMany({ limit: AUTO_TO_ONE_JOIN_ROWS_MAX + 1, with: { order: true } } as never);
    assert.ok(huge.calls.length > 1, `clamped down to ${AUTO_TO_ONE_JOIN_ROWS_MAX} rows → batched`);

    // An explicit row count is an instruction, not an estimate: no clamping.
    const explicitTiny = db({ autoToOneJoinMaxRows: 10 });
    await explicitTiny.q.findMany({ limit: 50, with: { order: true } } as never);
    assert.ok(explicitTiny.calls.length > 1, 'an explicit 10 is honoured below the clamp floor');
  });

  it('an explicit autoToOneJoinMaxRows overrides autoRoundTripMs', async () => {
    const { q, calls } = db({ autoRoundTripMs: 35, autoToOneJoinMaxRows: 10 });
    await q.findMany({ limit: 50, with: { order: true } } as never);
    assert.ok(calls.length > 1, 'the explicit row count wins over the derived one');
  });

  it('autoToOneJoinMaxRows tunes the threshold', async () => {
    const tight = db({ autoToOneJoinMaxRows: 10 });
    await tight.q.findMany({ limit: 50, with: { order: true } } as never);
    assert.ok(tight.calls.length > 1, 'limit 50 is above a threshold of 10 → batched');

    const loose = db({ autoToOneJoinMaxRows: 100_000 });
    await loose.q.findMany({ limit: 5000, with: { order: true } } as never);
    assert.equal(loose.calls.length, 1, 'limit 5000 is under a threshold of 100000 → join');
  });

  it('a to-many include with an indexed FK is unaffected by the rule', async () => {
    const { q, calls } = db();
    await q.findMany({ with: { notes: true } } as never); // unbounded, to-many, indexed
    assert.equal(calls.length, 1, 'to-many keeps its existing behavior');
    assert.match(calls[0]!.sql, /json_agg/);
  });

  it('an explicit relationLoadStrategy always wins', async () => {
    const { q, calls } = db();
    await q.findMany({ with: { order: true }, relationLoadStrategy: 'join' } as never);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /json_build_object/);
  });

  it('findUnique / findFirst keep the join (their parent set is one row)', async () => {
    const unique = db();
    await unique.q.findUnique({ where: { id: 1 }, with: { order: true } } as never);
    assert.equal(unique.calls.length, 1);

    const first = db();
    await first.q.findFirst({ with: { order: true } } as never);
    assert.equal(first.calls.length, 1);
  });

  it('emits the statements of the explicit batched strategy, byte for byte', async () => {
    const auto = db();
    await auto.q.findMany({ with: { order: { with: { vendor: true } } } } as never);
    const explicit = db();
    await explicit.q.findMany({
      with: { order: { with: { vendor: true } } },
      relationLoadStrategy: 'batched',
    } as never);
    assert.deepEqual(
      auto.calls.map((c) => c.sql),
      explicit.calls.map((c) => c.sql),
    );
  });

  it("tags the query events 'auto-batched' and notes the reason once", async () => {
    const events: QueryEvent[] = [];
    const { pool } = capturePool();
    const q = new QueryInterface(pool, 'order_items', schema(), [], {
      _onQuery: (e: QueryEvent) => events.push(e),
    } as never);
    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...a: unknown[]) => warnings.push(a.map(String).join(' '));
    try {
      await q.findMany({ with: { order: true } } as never);
      await q.findMany({ with: { order: true } } as never);
    } finally {
      console.warn = original;
    }
    assert.ok(events.some((e) => e.strategy === 'auto-batched'));
    const notes = warnings.filter((w) => /auto strategy: to-one relation/.test(w));
    assert.equal(notes.length, 1, 'once per relation');
    assert.match(notes[0]!, /"order" on "order_items" loads batched/);
    assert.match(notes[0]!, /1000 rows/);
  });

  it('does not tag events for the bounded (join) plan', async () => {
    const events: QueryEvent[] = [];
    const { pool } = capturePool();
    const q = new QueryInterface(pool, 'order_items', schema(), [], {
      _onQuery: (e: QueryEvent) => events.push(e),
    } as never);
    await q.findMany({ limit: 10, with: { order: true } } as never);
    assert.ok(!events.some((e) => e.strategy === 'auto-batched'));
  });
});

describe("'auto', relation _count", () => {
  it('a _count on an UNINDEXED FK stays inline for a bounded parent set', async () => {
    const { q, calls } = db();
    await q.findMany({ limit: 30, with: { _count: { flags: true } } } as never);
    assert.equal(calls.length, 1, 'no extra round-trip for 30 parents');
    assert.match(calls[0]!.sql, /_count__flags/);
  });

  it('a _count on an UNINDEXED FK still falls back for an unbounded parent set', async () => {
    const { q, calls } = db();
    await q.findMany({ with: { _count: { flags: true } } } as never);
    assert.ok(
      calls.some((c) => /GROUP BY/.test(c.sql)),
      'many parents → one grouped COUNT follow-up',
    );
  });

  it('a normal relation on an UNINDEXED FK still falls back, bounded or not', async () => {
    const bounded = db();
    await bounded.q.findMany({ limit: 30, with: { flags: true } } as never);
    assert.ok(
      bounded.calls.some((c) => /FROM "flags"/.test(c.sql) && !/json_agg/.test(c.sql)),
      'unindexed to-many keeps its existing fallback',
    );
  });

  it('an INDEXED _count emits unchanged SQL, bounded or not', async () => {
    const bounded = db();
    await bounded.q.findMany({ limit: 30, with: { _count: { notes: true } } } as never);
    const unbounded = db();
    await unbounded.q.findMany({ with: { _count: { notes: true } } } as never);
    assert.equal(bounded.calls.length, 1);
    assert.equal(unbounded.calls.length, 1);
    for (const c of [...bounded.calls, ...unbounded.calls]) assert.match(c.sql, /_count__notes/);
  });
});
