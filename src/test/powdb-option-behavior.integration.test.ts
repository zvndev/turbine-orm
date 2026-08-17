/**
 * The 0.74.0 PowDB option fixes, EXECUTED against a real engine.
 *
 * `powdb-global-filters.test.ts` asserts the emitted PowQL through a recording
 * pool, which proves the option reaches the statement. It cannot prove the
 * statement then EXCLUDES the rows it is supposed to exclude: that rests on
 * PowDB's own `filter` semantics, and the whole reason 0.74.0 exists is that a
 * plausible-looking absence of a filter is exactly what nobody noticed.
 *
 * The one that matters most is the global filter. "The tenant predicate is in
 * the statement" and "another tenant's rows do not come back" are different
 * claims, and only the second is what a multi-tenant application is relying on.
 * So every check here reads or writes ROWS and asserts what came back.
 *
 * Gated on the embedded addon, with a reason `TURBINE_REQUIRE_ENGINE=powdb`
 * recognises, so CI's powdb job fails rather than skips if the addon is absent.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { OptimisticLockError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { UNSAFE } from '../query/index.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

let embeddedAvailable = true;
try {
  await import('@zvndev/powdb-embedded');
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
}

function table(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef> = {}): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    dialectTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    widget: table(
      'widget',
      [
        col('id', 'id', 'number', 'int4'),
        col('name', 'name', 'string', 'text'),
        col('tenant_id', 'tenantId', 'string', 'text'),
        col('qty', 'qty', 'number', 'int4'),
        col('version', 'version', 'number', 'int4'),
        // Nullable, and seeded with real NULLs. A per-field `_count` is the
        // NON-NULL count, so counting a NOT NULL column (or a PK) cannot tell a
        // correct implementation from one that counts rows: the two answers are
        // the same number. This column is the one place they differ.
        col('note', 'note', 'string', 'text', { nullable: true }),
      ],
      {
        gadgets: {
          type: 'hasMany',
          name: 'gadgets',
          from: 'widget',
          to: 'gadget',
          foreignKey: 'widget_id',
          referenceKey: 'id',
        },
      },
    ),
    gadget: table('gadget', [
      col('id', 'id', 'number', 'int4'),
      col('widget_id', 'widgetId', 'number', 'int4'),
      col('label', 'label', 'string', 'text'),
    ]),
  },
};

/** Same six rows as the PostgreSQL behavioural matrix, for the same reasons. */
const ROWS = [
  { id: 1, name: 'alpha', tenantId: 't1', qty: 10, version: 1, note: 'n1' },
  { id: 2, name: 'bravo', tenantId: 't1', qty: 20, version: 1, note: null },
  { id: 3, name: 'charlie', tenantId: 't1', qty: 30, version: 1, note: 'n3' },
  { id: 4, name: 'delta', tenantId: 't1', qty: 30, version: 1, note: null },
  { id: 5, name: 'echo', tenantId: 't2', qty: 50, version: 1, note: 'n5' },
  { id: 6, name: 'foxtrot', tenantId: 't2', qty: 60, version: 1, note: null },
];
const KIDS = [
  { id: 13, widgetId: 1, label: 'g13' },
  { id: 11, widgetId: 1, label: 'g11' },
  { id: 12, widgetId: 1, label: 'g12' },
];

// biome-ignore lint/suspicious/noExplicitAny: dynamically-typed table accessors
type DB = any;

/** Boot an embedded PowDB, seed it, run `fn`, tear the directory down. */
async function withDb(fn: (db: DB) => Promise<void>, options: Record<string, unknown> = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-optbeh-'));
  const db: DB = await turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false, ...options });
  try {
    for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
    for (const r of ROWS) await db.table('widget').create({ data: r });
    for (const k of KIDS) await db.table('gadget').create({ data: k });
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

const TENANT = { widget: { tenantId: 't1' } };
const ids = (rows: { id: number }[]): number[] => rows.map((r) => r.id).sort((a, b) => a - b);

describe('powdb options, executed against the real engine', () => {
  // -------------------------------------------------------------------------
  // Global filters. The whole point: ROWS, not statements.
  // -------------------------------------------------------------------------

  it('a global filter actually excludes the other tenant rows', async () => {
    await withDb(
      async (db) => {
        const rows = await db.table('widget').findMany({});
        assert.deepEqual(ids(rows), [1, 2, 3, 4], 'only the filtered tenant may come back');
        assert.equal(await db.table('widget').count({}), 4, 'count must agree with findMany');
      },
      { globalFilters: TENANT },
    );
  });

  it('skipGlobalFilters: UNSAFE actually returns the hidden rows', async () => {
    await withDb(
      async (db) => {
        const rows = await db.table('widget').findMany({ skipGlobalFilters: UNSAFE });
        assert.deepEqual(ids(rows), [1, 2, 3, 4, 5, 6]);
      },
      { globalFilters: TENANT },
    );
  });

  it('a filtered-out row is not reachable by primary key', async () => {
    await withDb(
      async (db) => {
        assert.equal(await db.table('widget').findUnique({ where: { id: 5 } }), null);
        const got = await db.table('widget').findUnique({ where: { id: 5 }, skipGlobalFilters: UNSAFE });
        assert.equal(got?.id, 5);
      },
      { globalFilters: TENANT },
    );
  });

  it('a filtered write cannot reach another tenant rows', async () => {
    await withDb(
      async (db) => {
        const res = await db.table('widget').updateMany({ where: { qty: { gt: 0 } }, data: { name: 'scoped' } });
        assert.equal(res.count, 4, 'only the four in-tenant rows may be updated');
        const all = await db.table('widget').findMany({ skipGlobalFilters: UNSAFE, orderBy: { id: 'asc' } });
        assert.deepEqual(
          all.filter((r: { id: number }) => r.id >= 5).map((r: { name: string }) => r.name),
          ['echo', 'foxtrot'],
          'the out-of-tenant rows must be untouched',
        );
      },
      { globalFilters: TENANT },
    );
  });

  it('the empty-where guard still sees the USER predicate, not the global filter', async () => {
    await withDb(
      async (db) => {
        await assert.rejects(
          () => db.table('widget').deleteMany({ where: {} }),
          ValidationError,
          'a configured global filter must not satisfy the mass-mutation guard',
        );
        const all = await db.table('widget').findMany({ skipGlobalFilters: UNSAFE });
        assert.equal(all.length, 6, 'nothing may have been deleted');
      },
      { globalFilters: TENANT },
    );
  });

  it('the opt-in mass delete is still scoped to the filter', async () => {
    await withDb(
      async (db) => {
        const res = await db.table('widget').deleteMany({ where: {}, allowFullTableScan: UNSAFE });
        assert.equal(res.count, 4);
        const left = await db.table('widget').findMany({ skipGlobalFilters: UNSAFE });
        assert.deepEqual(ids(left), [5, 6], 'the other tenant rows must survive a scoped mass delete');
      },
      { globalFilters: TENANT },
    );
  });

  it('an unconfigured client is unaffected', async () => {
    await withDb(async (db) => {
      const rows = await db.table('widget').findMany({});
      assert.deepEqual(ids(rows), [1, 2, 3, 4, 5, 6]);
    });
  });

  // -------------------------------------------------------------------------
  // Optimistic locking
  // -------------------------------------------------------------------------

  it('a matching version updates the row and advances the version', async () => {
    await withDb(async (db) => {
      await db.table('widget').update({
        where: { id: 1 },
        data: { name: 'locked-ok' },
        optimisticLock: { field: 'version', expected: 1 },
      });
      const row = await db.table('widget').findUnique({ where: { id: 1 } });
      assert.equal(row.name, 'locked-ok');
      assert.equal(row.version, 2, 'a successful locked update must advance the version');
    });
  });

  it('a stale version is refused AND writes nothing', async () => {
    await withDb(async (db) => {
      await db.table('widget').update({
        where: { id: 1 },
        data: { name: 'first-writer' },
        optimisticLock: { field: 'version', expected: 1 },
      });
      await assert.rejects(
        () =>
          db.table('widget').update({
            where: { id: 1 },
            data: { name: 'lost-update' },
            optimisticLock: { field: 'version', expected: 1 },
          }),
        OptimisticLockError,
        'the second writer must be told it lost the race',
      );
      const row = await db.table('widget').findUnique({ where: { id: 1 } });
      assert.equal(row.name, 'first-writer', 'the losing write must not have applied');
      assert.equal(row.version, 2);
    });
  });

  // -------------------------------------------------------------------------
  // The rest of the 0.74.0 set
  // -------------------------------------------------------------------------

  it('stableRelationOrder puts relation rows in primary-key order', async () => {
    await withDb(async (db) => {
      // The children were inserted 13, 11, 12 deliberately, so insertion order
      // and key order differ and the assertion cannot pass by accident.
      const [row] = await db.table('widget').findMany({
        where: { id: 1 },
        with: { gadgets: true },
        stableRelationOrder: true,
      });
      assert.deepEqual(
        row.gadgets.map((g: { id: number }) => g.id),
        [11, 12, 13],
      );
    });
  });

  it('jsonEncoding is refused rather than ignored', async () => {
    await withDb(async (db) => {
      await assert.rejects(
        () => db.table('widget').findMany({ with: { gadgets: true }, jsonEncoding: 'object' }),
        UnsupportedFeatureError,
      );
    });
  });

  it('allowFullTableScan actually reaches every row on update and delete', async () => {
    await withDb(async (db) => {
      await assert.rejects(() => db.table('widget').updateMany({ where: {}, data: { name: 'x' } }), ValidationError);
      const res = await db
        .table('widget')
        .updateMany({ where: {}, data: { name: 'mass' }, allowFullTableScan: UNSAFE });
      assert.equal(res.count, 6);
      const rows = await db.table('widget').findMany({});
      assert.ok(
        rows.every((r: { name: string }) => r.name === 'mass'),
        'every row must have been updated',
      );
    });
  });

  // -------------------------------------------------------------------------
  // Core pagination / ordering / projection, on the real engine
  // -------------------------------------------------------------------------

  it('limit, offset and the Prisma aliases page correctly', async () => {
    await withDb(async (db) => {
      const page = await db.table('widget').findMany({ orderBy: { id: 'asc' }, limit: 3 });
      assert.deepEqual(
        page.map((r: { id: number }) => r.id),
        [1, 2, 3],
      );
      const skipped = await db.table('widget').findMany({ orderBy: { id: 'asc' }, offset: 4 });
      assert.deepEqual(
        skipped.map((r: { id: number }) => r.id),
        [5, 6],
      );
      // The 0.73.0 pair, on this engine.
      const paired = await db.table('widget').findMany({ orderBy: { id: 'asc' }, take: 2, skip: 2 });
      assert.deepEqual(
        paired.map((r: { id: number }) => r.id),
        [3, 4],
        'take + skip must page',
      );
    });
  });

  it('orderBy sorts, and select narrows', async () => {
    await withDb(async (db) => {
      const desc = await db.table('widget').findMany({ orderBy: { id: 'desc' } });
      assert.deepEqual(
        desc.map((r: { id: number }) => r.id),
        [6, 5, 4, 3, 2, 1],
      );
      const [narrow] = await db.table('widget').findMany({ where: { id: 1 }, select: { id: true, name: true } });
      assert.deepEqual(Object.keys(narrow).sort(), ['id', 'name']);
    });
  });

  it('aggregate and groupBy compute the real numbers', async () => {
    await withDb(async (db) => {
      const agg = await db.table('widget').aggregate({ _sum: { qty: true }, _count: { id: true } });
      assert.equal(Number(agg._sum.qty), 200, '10+20+30+30+50+60');
      assert.equal(Number(agg._count.id), 6);
      // Scalar `_count` (the default shape): a plain row count per group.
      const scalar = await db.table('widget').groupBy({
        by: ['tenantId'],
        _sum: { qty: true },
        orderBy: { tenantId: 'asc' },
      });
      assert.deepEqual(
        scalar.map((g: { tenantId: string }) => g.tenantId),
        ['t1', 't2'],
      );
      assert.deepEqual(
        scalar.map((g: { _count: number }) => Number(g._count)),
        [4, 2],
      );
      assert.deepEqual(
        scalar.map((g: { _sum: { qty: number } }) => Number(g._sum.qty)),
        [90, 110],
      );

      // Record `_count`: `_all` is the row count, a named field is that
      // column's non-null count. PowDB used to drop this shape entirely and
      // return rows carrying no `_count` key at all.
      // `note` is nullable and seeded with NULLs, so `_all` (4 and 2) and the
      // per-field count (2 and 1) are DIFFERENT numbers. Counting the PK here
      // instead would let an implementation that emits `count(*)` for both pass.
      const groups = await db.table('widget').groupBy({
        by: ['tenantId'],
        _count: { _all: true, note: true },
        orderBy: { tenantId: 'asc' },
      });
      assert.deepEqual(
        groups.map((g: { tenantId: string }) => g.tenantId),
        ['t1', 't2'],
      );
      assert.deepEqual(
        groups.map((g: { _count: { _all: number; note: number } }) => [Number(g._count._all), Number(g._count.note)]),
        [
          [4, 2],
          [2, 1],
        ],
        'a per-field _count is the NON-NULL count, never the row count',
      );
      // ...and the scalar key must NOT also appear: the record form replaces it.
      assert.equal(
        typeof (groups[0] as { _count: unknown })._count,
        'object',
        'the record form must not degrade into the scalar count',
      );
    });
  });
});
