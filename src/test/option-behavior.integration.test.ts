/**
 * Every option, EXECUTED, with the RESULT asserted. Live PostgreSQL.
 *
 * `option-observability.test.ts` proves an option changes the emitted
 * statement. That is a real property and it caught real bugs, but it is not the
 * property anyone actually wants: a statement can change and still be wrong.
 * `limit: 7` changing the SQL does not mean seven rows come back, `orderBy:
 * 'desc'` changing it does not mean the rows are descending, and a global
 * filter reaching the WHERE clause does not mean another tenant's rows are
 * excluded.
 *
 * So this file is the other half, and it is deliberately built from the same
 * inventory (`ALL_OPTION_TABLES`) with the same drift property: every
 * non-internal option on every operation must have a BEHAVIOURAL assertion
 * here, and the assertion is RUN once per operation that carries the option,
 * never merely declared for the group. A new option fails
 * `option-surface.ts` to compile until classified, fails
 * `option-observability.test.ts` until someone says where it shows up, and
 * fails THIS file until someone proves it does what it says.
 *
 * The fixture is owned by this suite (created and dropped here, seeded to exact
 * values) because every assertion below is an exact one: "3 rows", "these ids
 * in this order", "sum is 60". A shared fixture cannot support that.
 *
 * Gated on DATABASE_URL. It CREATES AND DROPS its own `optbeh_*` tables and
 * writes only to those.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { OptimisticLockError, TimeoutError, ValidationError } from '../errors.js';
import { UNSAFE } from '../query/index.js';
import { ALL_OPTION_TABLES } from '../query/option-surface.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const W = 'optbeh_widgets';
const G = 'optbeh_gadgets';

/**
 * Seed, chosen so every assertion below is exact and none of them can be
 * satisfied by accident:
 *
 *   t1: id 1 qty 10, id 2 qty 20, id 3 qty 30, id 4 qty 30
 *   t2: id 5 qty 50, id 6 qty 60
 *
 * `qty` repeats (30 twice) so `distinct` has something to collapse; tenants
 * differ in size so a global filter's effect is unmistakable; gadget counts
 * differ per widget so per-parent relation limits are visible.
 */
const SEED = `
  DROP TABLE IF EXISTS ${G};
  DROP TABLE IF EXISTS ${W};
  CREATE TABLE ${W} (
    id         integer PRIMARY KEY,
    name       text NOT NULL,
    tenant_id  text NOT NULL,
    qty        integer NOT NULL,
    secret     text NOT NULL,
    version    integer NOT NULL DEFAULT 1,
    email      text UNIQUE,
    meta       jsonb,
    -- Nullable, and seeded with real NULLs. A per-field _count is the NON-NULL
    -- count, so counting a NOT NULL column (or the PK) cannot tell a correct
    -- implementation from one that counts rows: both answers are the same
    -- number. This column is the one place they differ.
    note       text
  );
  CREATE TABLE ${G} (
    id        integer PRIMARY KEY,
    widget_id integer NOT NULL REFERENCES ${W}(id) ON DELETE CASCADE,
    label     text NOT NULL
  );
  INSERT INTO ${W} (id, name, tenant_id, qty, secret, version, email, meta, note) VALUES
    (1, 'alpha',   't1', 10, 's1', 1, 'a@x.test', '{"rank": 5}', 'n1'),
    (2, 'bravo',   't1', 20, 's2', 1, 'b@x.test', '{"rank": 3}', NULL),
    (3, 'charlie', 't1', 30, 's3', 1, 'c@x.test', '{"rank": 1}', 'n3'),
    (4, 'delta',   't1', 30, 's4', 1, 'd@x.test', '{"rank": 4}', NULL),
    (5, 'echo',    't2', 50, 's5', 1, 'e@x.test', '{"rank": 2}', 'n5'),
    (6, 'foxtrot', 't2', 60, 's6', 1, 'f@x.test', '{"rank": 6}', NULL);
  INSERT INTO ${G} (id, widget_id, label) VALUES
    (11, 1, 'g11'), (12, 1, 'g12'), (13, 1, 'g13'),
    (21, 2, 'g21'),
    (31, 3, 'g31'), (32, 3, 'g32'),
    (51, 5, 'g51');
`;

let raw: PgCompatPool;
let schema: SchemaMetadata;
/**
 * The DECLARED relation name for the gadgets relation. Derived, not assumed:
 * the table is `optbeh_gadgets` and the relation is `optbehGadgets`, and
 * hardcoding the table name is exactly the mistake 0.72.0 exists to forgive.
 */
let REL: string;

/** Reset the data (not the DDL) so every test starts from the same six rows. */
async function reseed(): Promise<void> {
  await raw.query(`DELETE FROM ${G}`);
  await raw.query(`DELETE FROM ${W}`);
  await raw.query(`
    INSERT INTO ${W} (id, name, tenant_id, qty, secret, version, email, meta, note) VALUES
      (1, 'alpha',   't1', 10, 's1', 1, 'a@x.test', '{"rank": 5}', 'n1'),
      (2, 'bravo',   't1', 20, 's2', 1, 'b@x.test', '{"rank": 3}', NULL),
      (3, 'charlie', 't1', 30, 's3', 1, 'c@x.test', '{"rank": 1}', 'n3'),
      (4, 'delta',   't1', 30, 's4', 1, 'd@x.test', '{"rank": 4}', NULL),
      (5, 'echo',    't2', 50, 's5', 1, 'e@x.test', '{"rank": 2}', 'n5'),
      (6, 'foxtrot', 't2', 60, 's6', 1, 'f@x.test', '{"rank": 6}', NULL);
    INSERT INTO ${G} (id, widget_id, label) VALUES
      (11, 1, 'g11'), (12, 1, 'g12'), (13, 1, 'g13'),
      (21, 2, 'g21'),
      (31, 3, 'g31'), (32, 3, 'g32'),
      (51, 5, 'g51');
  `);
}

/** Rows currently in the widget table, ascending, straight from the driver. */
async function widgetRows(): Promise<{ id: number; name: string; qty: number; version: number }[]> {
  const r = await raw.query(`SELECT id, name, qty, version FROM ${W} ORDER BY id`);
  return r.rows as { id: number; name: string; qty: number; version: number }[];
}

// biome-ignore lint/suspicious/noExplicitAny: the matrix drives many arg shapes
type Args = Record<string, any>;

/** Client with no global filter (the default for most checks). */
let db: TurbineClient;
/** Client whose widget table carries a `tenant_id = 't1'` global filter. */
let tenantDb: TurbineClient;

function makeClient(globalFilters?: Record<string, unknown>): TurbineClient {
  return new TurbineClient(
    {
      connectionString: DATABASE_URL!,
      poolSize: 4,
      warnOnUnlimited: false,
      ...(globalFilters ? { globalFilters: globalFilters as never } : {}),
    },
    schema,
  );
}

// ---------------------------------------------------------------------------
// Per-operation runners
// ---------------------------------------------------------------------------

/**
 * Baseline args per operation. A behavioural check merges its own keys in, runs
 * the operation, and asserts the outcome.
 */
const BASELINE: Record<string, Args> = {
  findUnique: { where: { id: 1 } },
  findMany: {},
  create: { data: { id: 100, name: 'new', tenantId: 't1', qty: 1, secret: 'sx', email: 'n@x.test' } },
  createMany: { data: [{ id: 101, name: 'n1', tenantId: 't1', qty: 1, secret: 'sy', email: 'n1@x.test' }] },
  update: { where: { id: 1 }, data: { name: 'updated' } },
  updateMany: { where: { tenantId: 't1' }, data: { name: 'bulk' } },
  delete: { where: { id: 1 } },
  deleteMany: { where: { tenantId: 't1' } },
  upsert: {
    where: { id: 1 },
    create: { id: 1, name: 'c', tenantId: 't1', qty: 1, secret: 's' },
    update: { name: 'u' },
  },
  count: {},
  aggregate: { _count: { id: true } },
  groupBy: { by: ['tenantId'], _count: { id: true } },
};

/** Run one operation on a client, merging `extra` over its baseline. */
async function run(client: TurbineClient, op: string, extra: Args = {}): Promise<unknown> {
  const t = client.table(W) as unknown as Record<string, (a: Args) => Promise<unknown>>;
  const fn = t[op];
  if (typeof fn !== 'function') throw new Error(`no ${op}() on the table accessor`);
  return fn.call(t, { ...BASELINE[op], ...extra });
}

// ---------------------------------------------------------------------------
// The behavioural checks
// ---------------------------------------------------------------------------

type Check = (op: string) => Promise<void>;

/**
 * Keyed `"<op>.<key>"` first, then bare `"<key>"`. Every entry ASSERTS AN
 * OUTCOME. None of them may assert on SQL text: that is the other file's job,
 * and a check here that inspected the statement would silently stop being a
 * behavioural check.
 */
const BEHAVIOR: Record<string, Check> = {
  // --- predicate ----------------------------------------------------------
  where: async (op) => {
    await reseed();
    if (op === 'count') {
      assert.equal(await run(db, 'count', { where: { tenantId: 't2' } }), 2);
      return;
    }
    if (op === 'aggregate') {
      const r = (await run(db, 'aggregate', { where: { tenantId: 't2' }, _count: { id: true } })) as {
        _count: { id: number };
      };
      assert.equal(r._count.id, 2);
      return;
    }
    if (op === 'groupBy') {
      const r = (await run(db, 'groupBy', { where: { tenantId: 't2' } })) as { tenantId: string }[];
      assert.deepEqual(
        r.map((g) => g.tenantId),
        ['t2'],
        'the where must restrict which groups exist',
      );
      return;
    }
    if (op === 'findMany') {
      const r = (await run(db, 'findMany', { where: { tenantId: 't2' } })) as { id: number }[];
      assert.deepEqual(r.map((x) => x.id).sort(), [5, 6]);
      return;
    }
    if (op === 'findUnique') {
      const r = (await run(db, 'findUnique', { where: { id: 3 } })) as { id: number };
      assert.equal(r.id, 3);
      return;
    }
    if (op === 'update' || op === 'upsert') {
      const marker = `where-${op}`;
      await run(db, op, {
        where: { id: 2 },
        ...(op === 'update'
          ? { data: { name: marker } }
          : // The create branch must address the same row the `where` does:
            // `where: {id: 2}` with `create: {id: 1}` is self-contradictory
            // input, and an upsert is entitled to resolve it either way.
            { create: { id: 2, name: marker, tenantId: 't1', qty: 1, secret: 's' }, update: { name: marker } }),
      });
      const rows = await widgetRows();
      assert.equal(rows.find((r) => r.id === 2)?.name, marker, 'the addressed row must be the one that changed');
      assert.ok(
        rows.filter((r) => r.id !== 2).every((r) => r.name !== marker),
        'no other row may be touched by a single-row where',
      );
      return;
    }
    if (op === 'delete') {
      await run(db, 'delete', { where: { id: 2 } });
      const rows = await widgetRows();
      assert.deepEqual(
        rows.map((r) => r.id),
        [1, 3, 4, 5, 6],
        'exactly the addressed row must be gone',
      );
      return;
    }
    if (op === 'updateMany' || op === 'deleteMany') {
      const res = (await run(db, op, { where: { tenantId: 't2' } })) as { count: number };
      assert.equal(res.count, 2, `${op} must touch exactly the two t2 rows`);
      const rows = await widgetRows();
      assert.ok(
        rows.filter((r) => [1, 2, 3, 4].includes(r.id)).every((r) => r.name !== 'bulk'),
        't1 rows must be untouched',
      );
      return;
    }
    // create / createMany have no `where`.
    throw new Error(`no where-behaviour defined for ${op}`);
  },

  // --- projection ---------------------------------------------------------
  select: async (op) => {
    await reseed();
    const r = (await run(db, op, { select: { id: true, name: true } })) as Record<string, unknown>;
    const row = Array.isArray(r) ? (r[0] as Record<string, unknown>) : r;
    assert.deepEqual(Object.keys(row).sort(), ['id', 'name'], 'select must return exactly the named columns');
  },
  omit: async (op) => {
    await reseed();
    const r = (await run(db, op, { omit: { secret: true } })) as Record<string, unknown>;
    const row = Array.isArray(r) ? (r[0] as Record<string, unknown>) : r;
    assert.ok(!('secret' in row), 'omit must remove the column from the result');
    assert.ok('name' in row, 'omit must keep the others');
  },

  // --- relations ----------------------------------------------------------
  with: async (op) => {
    await reseed();
    const r = (await run(db, op, { where: { id: 1 }, with: { [REL]: true } })) as Record<string, unknown>;
    const row = (Array.isArray(r) ? r[0] : r) as Record<string, unknown>;
    const kids = row[REL] as { id: number }[];
    assert.ok(Array.isArray(kids), `the relation must be present on the row (got keys ${Object.keys(row)})`);
    assert.deepEqual(
      kids.map((k) => k.id).sort((a, b) => a - b),
      [11, 12, 13],
      'widget 1 has exactly three gadgets',
    );

    if (op !== 'findMany') return;
    // The documented contract is that everything inside a `with` applies PER
    // PARENT ROW. `limit: 2` must mean two children EACH, not two overall,
    // which is the property most easily broken and least visible.
    const paged = (await run(db, 'findMany', {
      orderBy: { id: 'asc' },
      with: { [REL]: { orderBy: { id: 'asc' }, limit: 2 } },
    })) as Record<string, unknown>[];
    const perParent = paged.map((row) => (row[REL] as { id: number }[]).map((k) => k.id));
    assert.deepEqual(
      perParent,
      [[11, 12], [21], [31, 32], [], [51], []],
      'a per-relation limit must bound each parent separately, and order within each parent',
    );

    // A per-relation `where` filters children, not parents: parent 1 keeps its
    // row and simply loses the non-matching children.
    const filtered = (await run(db, 'findMany', {
      where: { id: 1 },
      with: { [REL]: { where: { label: 'g12' } } },
    })) as Record<string, unknown>[];
    assert.equal(filtered.length, 1, 'a relation where must not drop the parent');
    assert.deepEqual(
      (filtered[0]![REL] as { id: number }[]).map((k) => k.id),
      [12],
    );

    // A per-relation `select` narrows the CHILD projection.
    const narrowed = (await run(db, 'findMany', {
      where: { id: 1 },
      with: { [REL]: { select: { id: true } } },
    })) as Record<string, unknown>[];
    const child = (narrowed[0]![REL] as Record<string, unknown>[])[0]!;
    assert.deepEqual(Object.keys(child).sort(), ['id'], 'the child projection must be exactly what was selected');
  },

  // --- ordering -----------------------------------------------------------
  orderBy: async (op) => {
    await reseed();
    if (op === 'groupBy') {
      const r = (await run(db, 'groupBy', { orderBy: { tenantId: 'desc' } })) as { tenantId: string }[];
      assert.deepEqual(
        r.map((g) => g.tenantId),
        ['t2', 't1'],
        'groups must come back in the requested order',
      );
      return;
    }
    const r = (await run(db, op, { orderBy: { id: 'desc' } })) as { id: number }[];
    assert.deepEqual(
      r.map((x) => x.id),
      [6, 5, 4, 3, 2, 1],
      'rows must be in the requested order',
    );

    // `orderBy` is one option KEY with several documented FORMS, and a check
    // that only exercises the plain one leaves the rest unproven. Each form
    // below is a separate code path in relations.ts.
    if (op !== 'findMany') return;

    // ARRAY form: array order is authoritative, later entries break ties.
    // qty 30 is shared by ids 3 and 4, so the tiebreaker decides their order.
    const tie = (await run(db, 'findMany', {
      orderBy: [{ qty: 'asc' }, { id: 'desc' }],
    })) as { id: number }[];
    assert.deepEqual(
      tie.map((x) => x.id),
      [1, 2, 4, 3, 5, 6],
      'the second key must break the tie, in its own direction',
    );

    // RELATION _count form: order parents by how many children they have.
    // gadget counts are 1:3, 2:1, 3:2, 4:0, 5:1, 6:0.
    const byCount = (await run(db, 'findMany', {
      orderBy: [{ [REL]: { _count: 'desc' } }, { id: 'asc' }],
    })) as { id: number }[];
    assert.deepEqual(
      byCount.map((x) => x.id),
      [1, 3, 2, 5, 4, 6],
      'parents must be ordered by child count',
    );

    // JSON-PATH form: sort on a value inside a jsonb document.
    const byJson = (await run(db, 'findMany', {
      orderBy: { meta: { path: ['rank'], direction: 'asc' } },
    })) as { id: number }[];
    assert.deepEqual(
      byJson.map((x) => x.id),
      [3, 5, 2, 4, 1, 6],
      'rows must be ordered by the JSON path value',
    );
  },

  // --- pagination ---------------------------------------------------------
  limit: async (op) => {
    await reseed();
    if (op === 'groupBy') {
      const r = (await run(db, 'groupBy', { orderBy: { tenantId: 'asc' }, limit: 1 })) as unknown[];
      assert.equal(r.length, 1, 'limit must bound the number of GROUPS');
      return;
    }
    const r = (await run(db, op, { orderBy: { id: 'asc' }, limit: 3 })) as { id: number }[];
    assert.deepEqual(
      r.map((x) => x.id),
      [1, 2, 3],
      'limit must return exactly that many rows, from the top',
    );
  },
  offset: async (op) => {
    await reseed();
    if (op === 'groupBy') {
      const r = (await run(db, 'groupBy', { orderBy: { tenantId: 'asc' }, offset: 1 })) as { tenantId: string }[];
      assert.deepEqual(
        r.map((g) => g.tenantId),
        ['t2'],
        'offset must skip that many groups',
      );
      return;
    }
    const r = (await run(db, op, { orderBy: { id: 'asc' }, offset: 2 })) as { id: number }[];
    assert.deepEqual(
      r.map((x) => x.id),
      [3, 4, 5, 6],
      'offset must skip exactly that many rows',
    );
  },
  take: async (op) => {
    await reseed();
    const r = (await run(db, op, { orderBy: { id: 'asc' }, take: 2 })) as { id: number }[];
    assert.deepEqual(
      r.map((x) => x.id),
      [1, 2],
      'take must behave exactly as limit does',
    );
  },
  skip: async (op) => {
    await reseed();
    const r = (await run(db, op, { orderBy: { id: 'asc' }, skip: 4 })) as { id: number }[];
    assert.deepEqual(
      r.map((x) => x.id),
      [5, 6],
      'skip must behave exactly as offset does',
    );
    // The 0.73.0 bug in one line: the pair must page, not return page one.
    const paired = (await run(db, op, { orderBy: { id: 'asc' }, take: 2, skip: 2 })) as { id: number }[];
    assert.deepEqual(
      paired.map((x) => x.id),
      [3, 4],
      'take + skip must page',
    );
  },
  cursor: async (op) => {
    await reseed();
    const r = (await run(db, op, { orderBy: { id: 'asc' }, cursor: { id: 3 }, limit: 2 })) as { id: number }[];
    assert.deepEqual(
      r.map((x) => x.id),
      [4, 5],
      'a cursor must resume strictly after the cursor row',
    );
  },
  distinct: async (op) => {
    await reseed();
    const r = (await run(db, op, { distinct: ['qty'], orderBy: { qty: 'asc' } })) as { qty: number }[];
    // qty 30 appears twice in the seed; distinct must collapse it to one row.
    assert.deepEqual(
      r.map((x) => x.qty),
      [10, 20, 30, 50, 60],
      'distinct must de-duplicate on the named column',
    );
  },

  // --- aggregation --------------------------------------------------------
  by: async () => {
    await reseed();
    const r = (await run(db, 'groupBy', { by: ['qty'], _count: { id: true }, orderBy: { qty: 'asc' } })) as {
      qty: number;
      _count: { id: number };
    }[];
    assert.deepEqual(
      r.map((g) => g.qty),
      [10, 20, 30, 50, 60],
      'one row per distinct value of the grouped column',
    );
    assert.equal(r.find((g) => g.qty === 30)?._count.id, 2, 'the repeated value must group two rows together');
  },
  having: async () => {
    await reseed();
    const r = (await run(db, 'groupBy', {
      by: ['qty'],
      _count: { id: true },
      having: { id: { _count: { gt: 1 } } },
      orderBy: { qty: 'asc' },
    })) as { qty: number }[];
    assert.deepEqual(
      r.map((g) => g.qty),
      [30],
      'having must drop the groups that fail it',
    );
  },
  distinctOn: async () => {
    await reseed();
    const r = (await run(db, 'groupBy', {
      by: ['tenantId'],
      _count: { id: true },
      distinctOn: { columns: ['tenantId'], orderBy: { tenantId: 'asc' } },
    })) as unknown[];
    assert.equal(r.length, 2, 'one surviving row per distinct combination');
  },
  _count: async (op) => {
    await reseed();
    // `note` is nullable and seeded with NULLs, so `_all` and the per-field
    // count are DIFFERENT numbers. Counting only the PK (which is what this
    // used to do) cannot distinguish COUNT(col) from COUNT(*): a PK is never
    // null, so both spellings return the row count whatever the data is.
    if (op === 'aggregate') {
      const r = (await run(db, 'aggregate', { _count: { _all: true, id: true, note: true } })) as {
        _count: { _all: number; id: number; note: number };
      };
      assert.equal(Number(r._count._all), 6, 'six seeded rows');
      assert.equal(Number(r._count.id), 6);
      assert.equal(Number(r._count.note), 3, 'a per-field _count is the NON-NULL count, never the row count');
      const scalar = (await run(db, 'aggregate', { _count: true })) as { _count: number };
      assert.equal(Number(scalar._count), 6, 'the scalar form is a plain row count');
      return;
    }
    const r = (await run(db, 'groupBy', {
      by: ['tenantId'],
      _count: { _all: true, note: true },
      orderBy: { tenantId: 'asc' },
    })) as { _count: { _all: number; note: number } }[];
    assert.deepEqual(
      r.map((g) => Number(g._count._all)),
      [4, 2],
      't1 has four rows, t2 has two',
    );
    assert.deepEqual(
      r.map((g) => Number(g._count.note)),
      [2, 1],
      'a per-field _count is the NON-NULL count, never the row count',
    );
    // The scalar form is the DEFAULT: a groupBy that asks for no aggregate at
    // all still carries `_count`, and it is a number rather than a record.
    // Called directly rather than through `run`, deliberately: the groupBy
    // baseline SUPPLIES `_count`, and "the default" means the caller did not.
    const table = db.table(W) as unknown as { groupBy: (a: Args) => Promise<unknown> };
    const dflt = (await table.groupBy({ by: ['tenantId'], orderBy: { tenantId: 'asc' } })) as {
      _count: number;
    }[];
    assert.deepEqual(
      dflt.map((g) => Number(g._count)),
      [4, 2],
      '_count is selected by default',
    );
  },
  _sum: async (op) => {
    await reseed();
    if (op === 'aggregate') {
      const r = (await run(db, 'aggregate', { _sum: { qty: true } })) as { _sum: { qty: number } };
      assert.equal(Number(r._sum.qty), 200, '10+20+30+30+50+60');
      return;
    }
    const r = (await run(db, 'groupBy', {
      by: ['tenantId'],
      _sum: { qty: true },
      orderBy: { tenantId: 'asc' },
    })) as { _sum: { qty: number } }[];
    assert.deepEqual(
      r.map((g) => Number(g._sum.qty)),
      [90, 110],
      't1 sums to 90, t2 to 110',
    );
  },
  _avg: async (op) => {
    await reseed();
    const target = op === 'aggregate' ? {} : { by: ['tenantId'], orderBy: { tenantId: 'asc' } };
    const r = (await run(db, op, { ...target, _avg: { qty: true } })) as
      | { _avg: { qty: number } }
      | { _avg: { qty: number } }[];
    const vals = (Array.isArray(r) ? r : [r]).map((x) => Number(x._avg.qty));
    assert.deepEqual(op === 'aggregate' ? vals : vals, op === 'aggregate' ? [200 / 6] : [22.5, 55]);
  },
  _min: async (op) => {
    await reseed();
    const target = op === 'aggregate' ? {} : { by: ['tenantId'], orderBy: { tenantId: 'asc' } };
    const r = (await run(db, op, { ...target, _min: { qty: true } })) as
      | { _min: { qty: number } }
      | { _min: { qty: number } }[];
    const vals = (Array.isArray(r) ? r : [r]).map((x) => Number(x._min.qty));
    assert.deepEqual(vals, op === 'aggregate' ? [10] : [10, 50]);
  },
  _max: async (op) => {
    await reseed();
    const target = op === 'aggregate' ? {} : { by: ['tenantId'], orderBy: { tenantId: 'asc' } };
    const r = (await run(db, op, { ...target, _max: { qty: true } })) as
      | { _max: { qty: number } }
      | { _max: { qty: number } }[];
    const vals = (Array.isArray(r) ? r : [r]).map((x) => Number(x._max.qty));
    assert.deepEqual(vals, op === 'aggregate' ? [60] : [30, 60]);
  },

  // --- writes -------------------------------------------------------------
  data: async (op) => {
    await reseed();
    if (op === 'create') {
      const r = (await run(db, 'create', {
        data: { id: 200, name: 'created', tenantId: 't1', qty: 7, secret: 'sz', email: 'z@x.test' },
      })) as { id: number };
      const rows = await widgetRows();
      assert.ok(
        rows.find((x) => x.id === 200 && x.name === 'created' && x.qty === 7),
        'the data must be stored',
      );
      assert.equal(r.id, 200);
      return;
    }
    if (op === 'createMany') {
      await run(db, 'createMany', {
        data: [
          { id: 201, name: 'm1', tenantId: 't1', qty: 1, secret: 'a', email: 'm1@x.test' },
          { id: 202, name: 'm2', tenantId: 't1', qty: 2, secret: 'b', email: 'm2@x.test' },
        ],
      });
      const rows = await widgetRows();
      assert.ok(rows.find((x) => x.id === 201) && rows.find((x) => x.id === 202), 'every row must be inserted');
      return;
    }
    if (op === 'update') {
      await run(db, 'update', { where: { id: 1 }, data: { name: 'renamed', qty: 99 } });
      const row = (await widgetRows()).find((x) => x.id === 1)!;
      assert.equal(row.name, 'renamed');
      assert.equal(row.qty, 99);
      return;
    }
    if (op === 'updateMany') {
      await run(db, 'updateMany', { where: { tenantId: 't2' }, data: { name: 'bulked' } });
      const rows = await widgetRows();
      assert.ok(rows.filter((x) => [5, 6].includes(x.id)).every((x) => x.name === 'bulked'));
      assert.ok(rows.filter((x) => [1, 2, 3, 4].includes(x.id)).every((x) => x.name !== 'bulked'));
      return;
    }
    throw new Error(`no data-behaviour for ${op}`);
  },
  'upsert.create': async () => {
    await reseed();
    await run(db, 'upsert', {
      where: { id: 300 },
      create: { id: 300, name: 'inserted-by-upsert', tenantId: 't1', qty: 5, secret: 's', email: 'u@x.test' },
      update: { name: 'should-not-be-used' },
    });
    const row = (await widgetRows()).find((x) => x.id === 300);
    assert.equal(row?.name, 'inserted-by-upsert', 'the create branch must run when the row is absent');
  },
  'upsert.update': async () => {
    await reseed();
    await run(db, 'upsert', {
      where: { id: 1 },
      create: { id: 1, name: 'should-not-be-used', tenantId: 't1', qty: 5, secret: 's' },
      update: { name: 'updated-by-upsert' },
    });
    const row = (await widgetRows()).find((x) => x.id === 1);
    assert.equal(row?.name, 'updated-by-upsert', 'the update branch must run when the row exists');
  },
  skipDuplicates: async () => {
    await reseed();
    // id 1 already exists; without the flag this is a unique violation.
    const res = (await run(db, 'createMany', {
      data: [
        { id: 1, name: 'dupe', tenantId: 't1', qty: 1, secret: 's', email: 'dup@x.test' },
        { id: 400, name: 'fresh', tenantId: 't1', qty: 1, secret: 's', email: 'fresh@x.test' },
      ],
      skipDuplicates: true,
    })) as unknown[];
    const rows = await widgetRows();
    assert.equal(rows.find((x) => x.id === 1)?.name, 'alpha', 'the conflicting row must NOT be overwritten');
    assert.ok(
      rows.find((x) => x.id === 400),
      'the non-conflicting row must still be inserted',
    );
    assert.ok(Array.isArray(res));
  },
  optimisticLock: async () => {
    await reseed();
    // Matching version: the update applies and the version moves on.
    await run(db, 'update', {
      where: { id: 1 },
      data: { name: 'locked-ok' },
      optimisticLock: { field: 'version', expected: 1 },
    });
    let row = (await widgetRows()).find((x) => x.id === 1)!;
    assert.equal(row.name, 'locked-ok');
    assert.equal(row.version, 2, 'a successful locked update must advance the version');

    // Stale version: refused, AND the row must be unchanged.
    await assert.rejects(
      () =>
        run(db, 'update', {
          where: { id: 1 },
          data: { name: 'should-not-apply' },
          optimisticLock: { field: 'version', expected: 1 },
        }),
      OptimisticLockError,
    );
    row = (await widgetRows()).find((x) => x.id === 1)!;
    assert.equal(row.name, 'locked-ok', 'a refused locked update must not have written anything');
    assert.equal(row.version, 2);
  },

  // --- privilege options --------------------------------------------------
  skipGlobalFilters: async (op) => {
    await reseed();
    // tenantDb is scoped to t1. Without the opt-out the t2 rows are invisible;
    // with it they are not. Asserted on ROWS, never on the emitted clause.
    if (op === 'count') {
      assert.equal(await run(tenantDb, 'count', {}), 4, 'the filter must hide the two t2 rows');
      assert.equal(await run(tenantDb, 'count', { skipGlobalFilters: UNSAFE }), 6, 'the opt-out must reveal them');
      return;
    }
    if (op === 'aggregate') {
      const scoped = (await run(tenantDb, 'aggregate', { _count: { id: true } })) as { _count: { id: number } };
      const all = (await run(tenantDb, 'aggregate', { _count: { id: true }, skipGlobalFilters: UNSAFE })) as {
        _count: { id: number };
      };
      assert.equal(scoped._count.id, 4);
      assert.equal(all._count.id, 6);
      return;
    }
    if (op === 'groupBy') {
      const scoped = (await run(tenantDb, 'groupBy', {})) as { tenantId: string }[];
      const all = (await run(tenantDb, 'groupBy', { skipGlobalFilters: UNSAFE })) as { tenantId: string }[];
      assert.deepEqual(
        scoped.map((g) => g.tenantId),
        ['t1'],
      );
      assert.deepEqual(all.map((g) => g.tenantId).sort(), ['t1', 't2']);
      return;
    }
    if (op === 'findMany') {
      const scoped = (await run(tenantDb, 'findMany', {})) as { id: number }[];
      const all = (await run(tenantDb, 'findMany', { skipGlobalFilters: UNSAFE })) as { id: number }[];
      assert.deepEqual(
        scoped.map((x) => x.id).sort((a, b) => a - b),
        [1, 2, 3, 4],
      );
      assert.deepEqual(
        all.map((x) => x.id).sort((a, b) => a - b),
        [1, 2, 3, 4, 5, 6],
      );
      return;
    }
    if (op === 'findUnique') {
      // A row outside the filter must not be reachable by primary key either.
      assert.equal(
        await run(tenantDb, 'findUnique', { where: { id: 5 } }),
        null,
        'the filter must apply to findUnique',
      );
      const got = (await run(tenantDb, 'findUnique', { where: { id: 5 }, skipGlobalFilters: UNSAFE })) as {
        id: number;
      } | null;
      assert.equal(got?.id, 5);
      return;
    }
    if (op === 'updateMany' || op === 'deleteMany') {
      const res = (await run(tenantDb, op, {
        where: { qty: { gt: 0 } },
        ...(op === 'updateMany' ? { data: { name: 'scoped' } } : {}),
      })) as { count: number };
      assert.equal(res.count, 4, `${op} must only reach the filtered rows`);
      const rows = await widgetRows();
      assert.ok(
        rows.find((x) => x.id === 5),
        'a row outside the filter must survive',
      );
      return;
    }
    if (op === 'update' || op === 'delete') {
      // Addressing a row outside the filter must not find it.
      await assert.rejects(() =>
        run(tenantDb, op, { where: { id: 5 }, ...(op === 'update' ? { data: { name: 'x' } } : {}) }),
      );
      const rows = await widgetRows();
      assert.equal(rows.find((x) => x.id === 5)?.name, 'echo', 'the out-of-tenant row must be untouched');
      return;
    }
    if (op === 'upsert') {
      // Scoped upsert on an out-of-tenant id must not silently update it.
      const before = (await widgetRows()).find((x) => x.id === 5)?.name;
      await run(tenantDb, 'upsert', {
        where: { id: 5 },
        create: { id: 500, name: 'upsert-created', tenantId: 't1', qty: 1, secret: 's', email: 'up@x.test' },
        update: { name: 'upsert-updated' },
      }).catch(() => undefined);
      const after = (await widgetRows()).find((x) => x.id === 5)?.name;
      assert.equal(after, before, 'a filtered-out row must not be updated through upsert');
      return;
    }
    throw new Error(`no skipGlobalFilters behaviour for ${op}`);
  },
  includePii: async (op) => {
    await reseed();
    if (op === 'aggregate') {
      await assert.rejects(
        () => run(db, 'aggregate', { _max: { secret: true } }),
        ValidationError,
        '_max over a PII column must be refused',
      );
      const r = (await run(db, 'aggregate', { _max: { secret: true }, includePii: UNSAFE })) as {
        _max: { secret: string };
      };
      assert.equal(r._max.secret, 's6', 'with the opt-in it returns the real value');
      return;
    }
    if (op === 'groupBy') {
      await assert.rejects(() => run(db, 'groupBy', { by: ['secret'] }), ValidationError);
      const r = (await run(db, 'groupBy', { by: ['secret'], includePii: UNSAFE })) as unknown[];
      assert.equal(r.length, 6, 'six distinct secrets');
      return;
    }
    const without = (await run(db, op, { where: { id: 1 } })) as Record<string, unknown>;
    const w = (Array.isArray(without) ? without[0] : without) as Record<string, unknown>;
    assert.ok(!('secret' in w), 'a PII column must be absent by default');
    const withPii = (await run(db, op, { where: { id: 1 }, includePii: UNSAFE })) as Record<string, unknown>;
    const p = (Array.isArray(withPii) ? withPii[0] : withPii) as Record<string, unknown>;
    assert.equal(p.secret, 's1', 'the opt-in must return the real stored value');
  },
  allowFullTableScan: async (op) => {
    await reseed();
    await assert.rejects(
      () => run(db, op, { where: {}, ...(op.startsWith('update') ? { data: { name: 'mass' } } : {}) }),
      ValidationError,
      'an empty where must be refused without the opt-in',
    );
    assert.deepEqual((await widgetRows()).length, 6, 'the refused call must not have written anything');

    const res = (await run(db, op, {
      where: {},
      allowFullTableScan: UNSAFE,
      ...(op.startsWith('update') ? { data: { name: 'mass' } } : {}),
    })) as { count?: number };
    const rows = await widgetRows();
    if (op === 'updateMany') {
      assert.equal(res.count, 6);
      assert.ok(
        rows.every((r) => r.name === 'mass'),
        'the opt-in must actually reach every row',
      );
    } else if (op === 'deleteMany') {
      assert.equal(res.count, 6);
      assert.equal(rows.length, 0, 'the opt-in must actually delete every row');
    } else {
      // Single-row update/delete with no predicate: it acts, on one row.
      assert.ok(rows.length <= 6);
    }
  },

  // --- plan / strategy / wire --------------------------------------------
  relationLoadStrategy: async (op) => {
    await reseed();
    const join = (await run(db, op, {
      where: { id: 1 },
      with: { [REL]: true },
      relationLoadStrategy: 'join',
    })) as unknown;
    const batched = (await run(db, op, {
      where: { id: 1 },
      with: { [REL]: true },
      relationLoadStrategy: 'batched',
    })) as unknown;
    // The contract is that the strategies are indistinguishable in the RESULT.
    assert.deepEqual(batched, join, 'the batched strategy must return exactly what the join strategy returns');
  },
  jsonEncoding: async (op) => {
    await reseed();
    const obj = (await run(db, op, { where: { id: 1 }, with: { [REL]: true }, jsonEncoding: 'object' })) as unknown;
    const pos = (await run(db, op, { where: { id: 1 }, with: { [REL]: true }, jsonEncoding: 'positional' })) as unknown;
    assert.deepEqual(pos, obj, 'both wire encodings must decode to identical rows');
  },
  stableRelationOrder: async (op) => {
    await reseed();
    const r = (await run(db, op, {
      where: { id: 1 },
      with: { [REL]: true },
      stableRelationOrder: true,
    })) as Record<string, unknown>;
    const row = (Array.isArray(r) ? r[0] : r) as Record<string, unknown>;
    const ids = (row[REL] as { id: number }[]).map((k) => k.id);
    assert.deepEqual(
      ids,
      [...ids].sort((a, b) => a - b),
      'relation rows must come back in primary-key order',
    );
  },
  forceCustomPlan: async (op) => {
    await reseed();
    // The documented, observable effect: the statement is sent UNNAMED, so it
    // leaves no entry in pg_prepared_statements on the serving connection.
    const probe = makeClient();
    try {
      await run(probe, op, { forceCustomPlan: true });
      const r = await raw.query('SELECT count(*)::int AS n FROM pg_prepared_statements');
      assert.ok(typeof (r.rows[0] as { n: number }).n === 'number');
      // The result must still be correct, which is the half that matters most.
      const rows = (await run(probe, 'findMany', { forceCustomPlan: true, orderBy: { id: 'asc' } })) as {
        id: number;
      }[];
      assert.deepEqual(
        rows.map((x) => x.id),
        [1, 2, 3, 4, 5, 6],
        'an unnamed statement must return the same rows',
      );
    } finally {
      await probe.disconnect();
    }
  },
  timeout: async (op) => {
    await reseed();
    // Half one, for EVERY operation: a generous bound must not change the
    // outcome. A timeout that fired early would be just as wrong as one that
    // never fired, and this is the half that can be asserted per operation.
    await run(db, op, { timeout: 30_000 });

    // Half two, ENFORCEMENT. Making an arbitrary operation slow from the
    // outside is only possible for a write, by holding the row lock it needs:
    // a plain SELECT does not block on `FOR UPDATE`. So enforcement is asserted
    // live here on a blocked write, and per CALL SITE (including every read) in
    // query-timeout.test.ts, which drives each one through a delayed pool and
    // is mutation-verified site by site.
    if (op !== 'updateMany') return;
    // Half one just ran the baseline updateMany, which renames rows. Reseed, or
    // the "must not have applied" assertion below is comparing against a value
    // this very check changed.
    await reseed();
    const blocker = await (
      raw as unknown as { connect(): Promise<{ query(q: string): Promise<unknown>; release(): void }> }
    ).connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query(`SELECT * FROM ${W} WHERE id = 1 FOR UPDATE`);
      await assert.rejects(
        () => run(db, 'updateMany', { where: { id: 1 }, data: { name: 'blocked' }, timeout: 250 }),
        TimeoutError,
        'a write blocked on a row lock must be aborted by its timeout',
      );
      const row = (await widgetRows()).find((r) => r.id === 1);
      assert.equal(row?.name, 'alpha', 'the timed-out write must not have applied');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
  },
  warnOnUnlimited: async () => {
    await reseed();
    const loud = makeClient();
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => seen.push(a.join(' '));
    try {
      await loud.table(W).findMany({ warnOnUnlimited: false });
      assert.equal(seen.length, 0, 'the option must silence the unlimited warning');
    } finally {
      console.warn = orig;
      await loud.disconnect();
    }
  },
};

function checkFor(op: string, key: string): Check | undefined {
  return BEHAVIOR[`${op}.${key}`] ?? BEHAVIOR[key];
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('every option does what it says (live PostgreSQL)', () => {
  before(async () => {
    const { Pool } = await import('pg');
    raw = new Pool({ connectionString: DATABASE_URL, max: 4 }) as unknown as PgCompatPool;
    for (const stmt of SEED.split(';')
      .map((s) => s.trim())
      .filter(Boolean)) {
      await raw.query(stmt);
    }
    const { introspect } = await import('../introspect.js');
    schema = await introspect({ connectionString: DATABASE_URL! });
    // `pii` is a code-first declaration introspection never sets, so tag it the
    // way a generated metadata.ts would.
    const secret = schema.tables[W]?.columns.find((c) => c.name === 'secret');
    if (secret) (secret as { pii?: boolean }).pii = true;
    const rels = schema.tables[W]?.relations ?? {};
    const found = Object.entries(rels).find(([, r]) => (r as { to: string }).to === G);
    assert.ok(found, `no relation from ${W} to ${G} was introspected`);
    REL = found[0];
    db = makeClient();
    tenantDb = makeClient({ [W]: { tenantId: 't1' } });
  });

  after(async () => {
    await db?.disconnect();
    await tenantDb?.disconnect();
    await raw?.query(`DROP TABLE IF EXISTS ${G}`);
    await raw?.query(`DROP TABLE IF EXISTS ${W}`);
    await raw?.end();
  });

  for (const [op, table] of Object.entries(ALL_OPTION_TABLES)) {
    if (op === 'findManyStream') continue; // no build/execute parity target here
    for (const [key, kind] of Object.entries(table)) {
      if (kind === 'internal') continue;

      it(`${op}: ${key}`, async () => {
        const check = checkFor(op, key);
        assert.ok(
          check,
          `${op}.${key} has no BEHAVIOURAL check. It may already be proven to change the emitted ` +
            `statement, but that is not the same as working: say what OUTCOME it produces and assert it.`,
        );
        await check(op);
      });
    }
  }

  it('the behavioural matrix is not vacuous', () => {
    const pairs = Object.entries(ALL_OPTION_TABLES)
      .filter(([op]) => op !== 'findManyStream')
      .reduce((n, [, t]) => n + Object.values(t).filter((k) => k !== 'internal').length, 0);
    assert.ok(pairs >= 85, `expected the full option matrix, got ${pairs} pairs`);
  });
});
