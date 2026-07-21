/**
 * turbine-orm/powdb: F2 native-join LIVE integration tests through the REAL
 * in-process `@zvndev/powdb-embedded` napi addon (no server, no socket).
 *
 * The acceptance contract for native joins is deep-equality: for every relation
 * shape, `relationLoadStrategy: 'join'` must return output byte-identical to the
 * default keyed loaders (same seed, same args). These tests seed parent / child
 * / junction fixtures and assert that equivalence across the matrix, then check
 * that `explain()` returns a real plan.
 *
 * Gated on the addon loading (skips cleanly where no prebuilt binary exists),
 * exactly like `powdb.integration.test.ts`.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { ReadOnlyError, UnsupportedFeatureError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Addon availability gate.
// ---------------------------------------------------------------------------

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

// ---------------------------------------------------------------------------
// Schema fixture: auto-int PKs + a junction, hasMany / hasOne / belongsTo / m2m.
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

function makeTable(
  name: string,
  columns: ColumnMetadata[],
  relations: Record<string, RelationDef> = {},
  pk: string[] = ['id'],
): TableMetadata {
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
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: pk,
    uniqueColumns: pk.length === 1 ? [pk] : [],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    member: makeTable(
      'member',
      [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('name', 'name', 'string', 'text'),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'member',
          to: 'ppost',
          foreignKey: 'member_id',
          referenceKey: 'id',
        },
        profile: {
          type: 'hasOne',
          name: 'profile',
          from: 'member',
          to: 'pprofile',
          foreignKey: 'member_id',
          referenceKey: 'id',
        },
        tags: {
          type: 'manyToMany',
          name: 'tags',
          from: 'member',
          to: 'ptag',
          foreignKey: 'id',
          referenceKey: 'id',
          through: { table: 'member_tag', sourceKey: 'member_id', targetKey: 'tag_id' },
        },
      },
    ),
    ppost: makeTable(
      'ppost',
      [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('member_id', 'memberId', 'number', 'int8'),
        col('title', 'title', 'string', 'text'),
        col('views', 'views', 'number', 'int8'),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'ppost',
          to: 'member',
          foreignKey: 'member_id',
          referenceKey: 'id',
        },
      },
    ),
    pprofile: makeTable('pprofile', [
      col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
      col('member_id', 'memberId', 'number', 'int8'),
      col('bio', 'bio', 'string', 'text'),
    ]),
    ptag: makeTable('ptag', [
      col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
      col('label', 'label', 'string', 'text'),
    ]),
    member_tag: {
      ...makeTable('member_tag', [
        col('member_id', 'memberId', 'number', 'int8'),
        col('tag_id', 'tagId', 'number', 'int8'),
      ]),
      primaryKey: ['member_id', 'tag_id'],
      uniqueColumns: [],
    },
  },
};

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient table accessors are dynamically typed at this seam.
type DB = any;

/** Seed the fixtures once; every case queries the same data both ways. */
async function withSeeded(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-joins-'));
  const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, schema, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
    const ada = await db.table('member').create({ data: { name: 'Ada' } });
    const bob = await db.table('member').create({ data: { name: 'Bob' } });
    // Cy is created but has no posts / profile / tags (the empty-stitch case).
    await db.table('member').create({ data: { name: 'Cy' } });
    await db.table('ppost').createMany({
      data: [
        { memberId: ada.id, title: 'a1', views: 10 },
        { memberId: ada.id, title: 'a2', views: 30 },
        { memberId: ada.id, title: 'a3', views: 20 },
        { memberId: bob.id, title: 'b1', views: 5 },
        { memberId: bob.id, title: 'b2', views: 40 },
      ],
    });
    await db.table('pprofile').createMany({
      data: [
        { memberId: ada.id, bio: 'ada bio' },
        { memberId: bob.id, bio: 'bob bio' },
      ],
    });
    const red = await db.table('ptag').create({ data: { label: 'red' } });
    const blue = await db.table('ptag').create({ data: { label: 'blue' } });
    const green = await db.table('ptag').create({ data: { label: 'green' } });
    await db.table('member_tag').createMany({
      data: [
        { memberId: ada.id, tagId: red.id },
        { memberId: ada.id, tagId: blue.id },
        { memberId: bob.id, tagId: green.id },
      ],
    });
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Assert `findMany(args)` returns deep-equal output under the native-join
 * strategy and the default keyed loaders. `normalize` optionally canonicalizes
 * each row before comparison (used for m2m, whose per-parent child order is not
 * a documented semantic on either path).
 */
async function assertParity(
  db: DB,
  base: Record<string, unknown>,
  normalize: (rows: unknown[]) => unknown = (r) => r,
): Promise<void> {
  const viaJoin = await db.table('member').findMany({ ...base, relationLoadStrategy: 'join' });
  const viaLoader = await db.table('member').findMany({ ...base });
  assert.deepEqual(normalize(viaJoin), normalize(viaLoader));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('powdb F2 integration: join vs loader parity (embedded)', () => {
  it('hasMany with relation where + orderBy + per-parent limit', async () => {
    await withSeeded(async (db) => {
      await assertParity(db, {
        orderBy: { id: 'asc' },
        with: { posts: { where: { views: { gte: 10 } }, orderBy: { views: 'desc' }, limit: 2 } },
      });
    });
  });

  it('hasMany, unfiltered', async () => {
    await withSeeded(async (db) => {
      await assertParity(db, { orderBy: { id: 'asc' }, with: { posts: true } });
    });
  });

  it('hasOne', async () => {
    await withSeeded(async (db) => {
      await assertParity(db, { orderBy: { id: 'asc' }, with: { profile: true } });
    });
  });

  it('belongsTo (from the child side)', async () => {
    await withSeeded(async (db) => {
      const viaJoin = await db
        .table('ppost')
        .findMany({ orderBy: { id: 'asc' }, with: { author: true }, relationLoadStrategy: 'join' });
      const viaLoader = await db.table('ppost').findMany({ orderBy: { id: 'asc' }, with: { author: true } });
      assert.deepEqual(viaJoin, viaLoader);
    });
  });

  it('manyToMany', async () => {
    await withSeeded(async (db) => {
      // m2m per-parent child ordering is not a documented semantic on either
      // path, so compare each member's tags as an id-sorted set.
      const sortTags = (rows: unknown[]) =>
        (rows as { tags: { id: number }[] }[]).map((r) => ({
          ...r,
          tags: [...r.tags].sort((a, b) => a.id - b.id),
        }));
      await assertParity(db, { orderBy: { id: 'asc' }, with: { tags: true } }, sortTags);
    });
  });

  it('parent where with scalar filters', async () => {
    await withSeeded(async (db) => {
      await assertParity(db, {
        where: { name: { in: ['Ada', 'Bob'] } },
        orderBy: { id: 'asc' },
        with: { posts: true },
      });
    });
  });

  it('relation where (posts filtered)', async () => {
    await withSeeded(async (db) => {
      await assertParity(db, {
        orderBy: { id: 'asc' },
        with: { posts: { where: { views: { gt: 15 } }, orderBy: { views: 'asc' } } },
      });
    });
  });

  it('relation select that omits the FK column returns the same children both ways', async () => {
    await withSeeded(async (db) => {
      // `select: { title: true }` drops the correlation column (member_id) from
      // the projection. The join stitches via __tpk regardless; the loader must
      // force-fetch member_id and strip it, so both return the same posts (never
      // an empty list, and never leaking member_id).
      await assertParity(db, { orderBy: { id: 'asc' }, with: { posts: { select: { title: true } } } });
      const rows = await db
        .table('member')
        .findMany({ orderBy: { id: 'asc' }, with: { posts: { select: { title: true } } } });
      const ada = rows.find((r: { name: string }) => r.name === 'Ada');
      assert.equal(ada.posts.length, 3, 'Ada keeps her 3 posts even without the FK selected');
      assert.deepEqual(Object.keys(ada.posts[0]).sort(), ['id', 'title'], 'only id + title, no leaked member_id');
    });
  });

  it('a member with no children stitches to [] / null, identically both ways', async () => {
    await withSeeded(async (db) => {
      // Cy has no posts, no profile, no tags.
      await assertParity(db, { where: { name: 'Cy' }, with: { posts: true, profile: true } });
    });
  });

  it('explain() returns a non-empty plan with a scan node', async () => {
    await withSeeded(async (db) => {
      const first = await db.table('member').findFirst({ orderBy: { id: 'asc' } });
      const lines = await db.table('member').explain({ where: { id: first.id } });
      assert.ok(lines.length > 0, 'explain must return plan lines');
      assert.match(lines.join('\n'), /Scan/, 'plan should name a scan node (Index/Seq/Range)');
    });
  });
});

describe('powdb integration: client-level relationLoadStrategy activates single-statement loads (fix 8)', () => {
  it('turbinePowDB({ relationLoadStrategy: "join" }) emits ONE non-loader statement without a per-query arg', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-clientjoin-'));
    const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, schema, {
      relationLoadStrategy: 'join',
      warnOnUnlimited: false,
    });
    const emitted: string[] = [];
    db.$on('query', (e: { sql: string }) => emitted.push(e.sql));
    try {
      for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
      const ada = await db.table('member').create({ data: { name: 'Ada' } });
      await db.table('ppost').createMany({ data: [{ memberId: ada.id, title: 'a1', views: 1 }] });
      emitted.length = 0; // ignore the seeding statements
      const rows = await db.table('member').findMany({ orderBy: { id: 'asc' }, with: { posts: true } });
      // The client-level strategy must reach the query and take a single-statement
      // path, never the N+1 keyed loaders (which would emit the base scan plus one
      // loader per relation). On a >= 0.18 engine 'join' prefers a nested
      // projection (` as t0`); on an older engine it emits a native ` join `.
      // Either way it is exactly one statement, and never the keyed loader.
      assert.equal(
        emitted.length,
        1,
        `client-level strategy must emit one statement (not N+1 loaders), saw: ${emitted.join(' | ')}`,
      );
      assert.match(
        emitted[0]!,
        / join | as t0/,
        'the single statement is a native join (< 0.18) or a nested projection (>= 0.18)',
      );
      assert.equal(rows[0].posts.length, 1);
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Datetime correlation: the parent key is a Date (stored as int micros), so the
// join's __tpk cell and the parent's shaped Date must normalize to the same
// bucket key on BOTH strategies. A `at` column marked unique makes the relation
// join-eligible (a non-unique correlation would fall back to the loader).
// ---------------------------------------------------------------------------

const dtSchema: SchemaMetadata = (() => {
  const slot = makeTable(
    'slot',
    [
      col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
      col('at', 'at', 'Date', 'timestamptz'),
    ],
    {
      events: {
        type: 'hasMany',
        name: 'events',
        from: 'slot',
        to: 'sevent',
        foreignKey: 'slot_at',
        referenceKey: 'at',
      },
    },
  );
  // Mark the datetime correlation column unique so joinEligible activates the
  // native join path (otherwise it silently falls back to the keyed loader).
  slot.uniqueColumns = [['id'], ['at']];
  return {
    enums: {},
    tables: {
      slot,
      sevent: makeTable('sevent', [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('slot_at', 'slotAt', 'Date', 'timestamptz'),
        col('label', 'label', 'string', 'text'),
      ]),
    },
  };
})();

describe('powdb F2 integration: datetime correlation key (embedded)', () => {
  it('hasMany correlated on a datetime column stitches identically under join and loader', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-dtjoin-'));
    const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, dtSchema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(dtSchema)) await db.raw([stmt]);
      const t0 = new Date('2024-01-01T00:00:00.000Z');
      const t1 = new Date('2024-06-15T12:30:00.000Z');
      const s0 = await db.table('slot').create({ data: { at: t0 } });
      const s1 = await db.table('slot').create({ data: { at: t1 } });
      await db.table('sevent').createMany({
        data: [
          { slotAt: s0.at, label: 'a' },
          { slotAt: s0.at, label: 'b' },
          { slotAt: s1.at, label: 'c' },
        ],
      });
      const base = { orderBy: { id: 'asc' as const }, with: { events: true } };
      const viaJoin = await db.table('slot').findMany({ ...base, relationLoadStrategy: 'join' });
      const viaLoader = await db.table('slot').findMany({ ...base });
      assert.deepEqual(viaJoin, viaLoader);
      // Both strategies actually resolve the datetime-correlated children (the
      // pre-fix join returned [] because getTime() ms never matched the micros
      // cell, and the loader keyed by Date object identity).
      assert.equal(viaJoin[0].events.length, 2);
      assert.equal(viaJoin[1].events.length, 1);
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Transaction proxy carries the PowDB pool's readonly + capabilities (fix 4).
// ---------------------------------------------------------------------------

describe('powdb integration: $transaction inherits pool readonly + capabilities (embedded)', () => {
  it('a write inside $transaction on a readonly-marked client throws E018 before the wire', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-rotx-'));
    // A writable engine handle marked read-only at the client level: the engine
    // WOULD accept the write, so only the local guard (carried into the tx proxy
    // pool) refuses it. Without the fix the tx proxy dropped `readonly` and the
    // write succeeded.
    const db: DB = await turbinePowDB({ embedded: dir }, schema, { readonly: true, warnOnUnlimited: false });
    try {
      await assert.rejects(
        () =>
          db.$transaction(async (tx: DB) => {
            await tx.table('member').create({ data: { name: 'z' } });
          }),
        ReadOnlyError,
      );
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a per-query join inside $transaction on a 0.12 engine throws typed E017 (not raw E003)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-captx-'));
    // assumeEngineVersion 0.12.0 → serverJoins false. Without the fix the tx
    // proxy fell back to ALL_POWDB_CAPABILITIES (serverJoins true) and emitted
    // join PowQL a pre-0.13 engine would reject as a raw parse error.
    const db: DB = await turbinePowDB({ embedded: dir }, schema, {
      assumeEngineVersion: '0.12.0',
      warnOnUnlimited: false,
    });
    try {
      for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
      await db.table('member').create({ data: { name: 'Ada' } });
      await assert.rejects(
        () =>
          db.$transaction(async (tx: DB) => {
            await tx.table('member').findMany({ with: { posts: true }, relationLoadStrategy: 'join' });
          }),
        UnsupportedFeatureError,
      );
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
