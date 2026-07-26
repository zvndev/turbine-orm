/**
 * turbine-orm/prisma-compat: `createMany` accepts rows of different shapes.
 *
 * Prisma's `createMany` takes heterogeneous rows and emits ONE insert over the
 * UNION of the named columns, binding its own schema-level `@default` for a
 * field a row omits (and `null` for a field it has no default for). Verified
 * directly against @prisma/client 7.9.0 on PostgreSQL 16:
 *
 *   createMany({ data: [{ a: 'r0' }, { a: 'r1', b: 'custom' }] })
 *     -> INSERT INTO "probe_rows" ("a","b","c") VALUES ($1,$2,$3), ($4,$5,$6)
 *        params ["r0","bee","7","r1","custom","7"]     ("bee"/"7" are the @defaults)
 *     -> { count: 2 }, ids ascending in array order
 *
 * Core `createMany` refuses a mixed batch (it has no per-cell DEFAULT form on
 * every engine, see `assertUniformCreateManyRows` in query/writes.ts), so a
 * ported codebase that worked on Prisma started getting E003 from the layer
 * whose whole contract is Prisma parity. The compat layer now splits the rows
 * into contiguous same-shape runs and issues one core `createMany` per run
 * inside ONE transaction: the call stays all-or-nothing, `{ count }` is the
 * total actually inserted, `skipDuplicates` applies to every run, and rows keep
 * the caller's order so server-assigned ids ascend with the array exactly as
 * they do on Prisma.
 *
 * The one deliberate divergence: for a column whose DEFAULT lives only in the
 * DATABASE (not declared in the Prisma schema), Prisma binds null and loses the
 * default, while a run lets the column default apply.
 *
 * Run: npx tsx --test src/test/prisma-compat-createmany-shapes.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it as nodeIt } from 'node:test';
import { TurbineClient } from '../client.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import { introspect } from '../introspect.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

type Models = { Widget: { Row: { id: number; name: string; tier: string; seats: number; slug: string | null } } };

const WIDGET_TABLE = 'compat_shape_widgets';

function widgetMap(): PrismaCompatMap {
  return {
    enums: {},
    models: {
      Widget: {
        table: WIDGET_TABLE,
        accessor: 'compatShapeWidgets',
        fields: { id: 'id', name: 'name', tier: 'tier', seats: 'seats', slug: 'slug' },
        relations: {},
        compoundUniques: {},
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tier 1, DB-less: which statements the layer decides to issue
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  args: Any;
}

/**
 * A recording client. Every `createMany` returns one canned row so a summed
 * `{ count }` is the number of statements issued, and `$transaction` calls are
 * counted so the uniform path can be shown NOT to open one.
 */
function spy(): { db: CompatTurbineClient; calls: Call[]; transactions: () => number } {
  const calls: Call[] = [];
  let transactions = 0;
  const schema: SchemaMetadata = {
    enums: {},
    tables: {
      [WIDGET_TABLE]: mockTable(WIDGET_TABLE, [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'tier', field: 'tier', pgType: 'text' },
        { name: 'seats', field: 'seats', pgType: 'int4' },
        { name: 'slug', field: 'slug', pgType: 'text' },
      ]),
    },
  };
  const table = (): Any =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => (args: Any) => {
          calls.push({ method, args });
          return Promise.resolve([{ id: 1 }]);
        },
      },
    );
  const db = {
    schema,
    table,
    $transaction: (fn: Any) => {
      transactions++;
      return fn({ table });
    },
  };
  return { db: db as unknown as CompatTurbineClient, calls, transactions: () => transactions };
}

function compatOf(db: CompatTurbineClient) {
  return createPrismaCompatClient<Models>(db as unknown as TurbineClient, widgetMap());
}

describe('prisma-compat createMany, statement planning', () => {
  nodeIt('uniform rows are ONE createMany on the plain path, no transaction', async () => {
    const { db, calls, transactions } = spy();
    const data = [{ name: 'a' }, { name: 'b' }];
    const res = await compatOf(db).Widget.createMany({ data });
    assert.deepEqual(
      calls.map((c) => c.method),
      ['createMany'],
    );
    // The very array the caller passed, so the emitted SQL cannot differ from
    // what the ungrouped path produced.
    assert.equal(calls[0]!.args.data.length, 2);
    assert.deepEqual(calls[0]!.args, { data: calls[0]!.args.data });
    assert.equal(transactions(), 0);
    assert.deepEqual(res, { count: 1 }, 'count is the rows the single statement returned');
  });

  nodeIt('mixed rows become one createMany per contiguous run inside one transaction', async () => {
    const { db, calls, transactions } = spy();
    const res = await compatOf(db).Widget.createMany({
      data: [{ name: 'a' }, { name: 'b', tier: 'pro' }, { name: 'c', tier: 'pro' }, { name: 'd' }],
    });
    assert.deepEqual(
      calls.map((c) => c.args.data.map((r: Any) => r.name)),
      [['a'], ['b', 'c'], ['d']],
      'contiguous same-shape runs, in the order the caller wrote them',
    );
    assert.equal(transactions(), 1, 'all runs share ONE transaction, so the call stays atomic');
    assert.deepEqual(res, { count: 3 }, 'counts sum across runs');
  });

  nodeIt('skipDuplicates is carried onto every run', async () => {
    const { db, calls } = spy();
    await compatOf(db).Widget.createMany({
      data: [{ name: 'a' }, { name: 'b', tier: 'pro' }],
      skipDuplicates: true,
    });
    assert.equal(calls.length, 2);
    assert.ok(
      calls.every((c) => c.args.skipDuplicates === true),
      'a run without it would insert a row Prisma would have skipped',
    );
  });

  nodeIt('a mixed batch is not built as one deferred statement in $transaction([...])', async () => {
    const { db } = spy();
    const compat = compatOf(db);
    const { COMPAT_DEFERRED } = await import('../prisma-compat.js');
    const uniform = compat.Widget.createMany({ data: [{ name: 'a' }, { name: 'b' }] }) as Any;
    const mixed = compat.Widget.createMany({ data: [{ name: 'a' }, { name: 'b', tier: 'pro' }] }) as Any;
    assert.equal(uniform[COMPAT_DEFERRED].nested(), false, 'one statement, still batchable');
    assert.equal(mixed[COMPAT_DEFERRED].nested(), true, 'several statements, run sequentially in the batch tx');
    await uniform;
    await mixed;
  });

  nodeIt('an empty data array is still the single zero-row call', async () => {
    const { db, calls, transactions } = spy();
    await compatOf(db).Widget.createMany({ data: [] });
    assert.deepEqual(
      calls.map((c) => c.method),
      ['createMany'],
    );
    assert.equal(transactions(), 0);
  });
});

// ---------------------------------------------------------------------------
// Tier 2, live Postgres
// ---------------------------------------------------------------------------

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('prisma-compat createMany, live Postgres', () => {
  let db: TurbineClient;
  let compat: Any;

  const drop = `DROP TABLE IF EXISTS ${WIDGET_TABLE}`;
  // `tier` and `seats` DEFAULT, so an omitted field proves the difference
  // between the column default applying and NULL being written over it.
  const create = `CREATE TABLE ${WIDGET_TABLE} (
     id    serial PRIMARY KEY,
     name  text NOT NULL,
     tier  text NOT NULL DEFAULT 'free',
     seats int  NOT NULL DEFAULT 3,
     slug  text UNIQUE
   )`;

  const raw = async (client: TurbineClient, sql: string) =>
    client.raw([sql] as unknown as TemplateStringsArray) as Promise<unknown>;

  before(async () => {
    if (!url) return;
    const admin = new TurbineClient({ connectionString: url }, { enums: {}, tables: {} });
    await raw(admin, drop);
    await raw(admin, create);
    await admin.disconnect();

    db = new TurbineClient({ connectionString: url }, await introspect({ connectionString: url }));
    compat = createPrismaCompatClient<Models>(db, widgetMap());
  });

  after(async () => {
    if (!url) return;
    await raw(db, drop);
    await db.disconnect();
  });

  const rows = () => compat.Widget.findMany({ orderBy: { id: 'asc' } });
  const wipe = () => compat.Widget.deleteMany();

  it('inserts every row, applies the defaults, and returns the total count', async () => {
    await wipe();
    const res = await compat.Widget.createMany({
      data: [{ name: 'a' }, { name: 'b', tier: 'pro' }, { name: 'c' }, { name: 'd', seats: 9 }],
    });
    assert.deepEqual(res, { count: 4 });

    const all = await rows();
    assert.deepEqual(
      all.map((r: Any) => r.name),
      ['a', 'b', 'c', 'd'],
      'serial ids ascend with the caller array, as they do on Prisma',
    );
    // The omitted columns took their DEFAULT, they were not NULLed out, and the
    // fields only later rows name actually reached the database.
    assert.deepEqual(
      all.map((r: Any) => [r.tier, r.seats]),
      [
        ['free', 3],
        ['pro', 3],
        ['free', 3],
        ['free', 9],
      ],
    );
  });

  it('is atomic: a failure in a later run rolls the earlier runs back', async () => {
    await wipe();
    await compat.Widget.create({ data: { name: 'seed', slug: 'taken' } });
    await assert.rejects(
      compat.Widget.createMany({
        // Run 1 ({ name }) inserts, run 2 ({ name, slug }) hits the unique.
        data: [{ name: 'first' }, { name: 'second', slug: 'taken' }],
      }),
      (e: unknown) => e instanceof TurbineError && e.code === TurbineErrorCode.UNIQUE_VIOLATION,
    );
    const all = await rows();
    assert.deepEqual(
      all.map((r: Any) => r.name),
      ['seed'],
      'the row the first run inserted was rolled back with the failing one',
    );
  });

  it('skipDuplicates skips conflicting rows in every run and counts only the inserts', async () => {
    await wipe();
    await compat.Widget.create({ data: { name: 'seed', slug: 'dup' } });
    const res = await compat.Widget.createMany({
      skipDuplicates: true,
      data: [
        { name: 'x', slug: 'dup' }, // conflicts, skipped
        { name: 'y', slug: 'fresh', tier: 'pro' }, // its own run
        { name: 'z', slug: 'other' }, // back to the first shape, a third run
      ],
    });
    assert.deepEqual(res, { count: 2 }, 'the count is what was actually inserted, not what was offered');
    const all = await rows();
    assert.deepEqual(
      all.map((r: Any) => r.name),
      ['seed', 'y', 'z'],
    );
  });

  it('a uniform batch still goes through as ONE statement', async () => {
    await wipe();
    const seen: string[] = [];
    const listener = (e: { sql: string }) => {
      if (new RegExp(`INSERT INTO "${WIDGET_TABLE}"`).test(e.sql)) seen.push(e.sql);
    };
    db.$on('query', listener);
    try {
      const res = await compat.Widget.createMany({ data: [{ name: 'u1' }, { name: 'u2' }, { name: 'u3' }] });
      assert.deepEqual(res, { count: 3 });
    } finally {
      db.$off('query', listener);
    }
    assert.equal(seen.length, 1);
    assert.equal(
      seen[0],
      `INSERT INTO "${WIDGET_TABLE}" ("name") SELECT * FROM UNNEST($1::text[]) RETURNING *`,
      'the column-major UNNEST form the ungrouped path always emitted',
    );
  });

  it('$transaction([...]) still runs a mixed createMany atomically', async () => {
    await wipe();
    await assert.rejects(
      compat.$transaction([
        compat.Widget.createMany({ data: [{ name: 'p' }, { name: 'q', tier: 'pro' }] }),
        // Same slug twice in one batch: the second call violates the unique.
        compat.Widget.create({ data: { name: 'r', slug: 'once' } }),
        compat.Widget.create({ data: { name: 's', slug: 'once' } }),
      ]),
      (e: unknown) => e instanceof TurbineError && e.code === TurbineErrorCode.UNIQUE_VIOLATION,
    );
    assert.deepEqual(await rows(), []);

    const out = await compat.$transaction([
      compat.Widget.createMany({ data: [{ name: 'p' }, { name: 'q', tier: 'pro' }] }),
      compat.Widget.create({ data: { name: 'r' } }),
    ]);
    assert.deepEqual(out[0], { count: 2 });
    assert.deepEqual(
      (await rows()).map((r: Any) => [r.name, r.tier]),
      [
        ['p', 'free'],
        ['q', 'pro'],
        ['r', 'free'],
      ],
    );
  });
});
