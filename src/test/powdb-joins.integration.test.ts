/**
 * turbine-orm/powdb — F2 native-join LIVE integration tests through the REAL
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
// Schema fixture — auto-int PKs + a junction, hasMany / hasOne / belongsTo / m2m.
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
    // Cy is created but has no posts / profile / tags — the empty-stitch case.
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
