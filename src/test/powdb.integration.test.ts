/**
 * turbine-orm/powdb — LIVE integration tests through the REAL in-process
 * `@zvndev/powdb-embedded` napi addon (no server, no socket — runs anywhere the
 * prebuilt binary loads).
 *
 * The whole suite is gated on the addon loading: on a platform without a
 * prebuilt binary (musl / Windows / Intel-mac) the `import()` throws and every
 * test registers as skipped via {@link skipGate}, so `npm run test:unit` stays
 * green without the addon and CI on a supported runner exercises the real
 * engine. Each test opens its own `mkdtemp` data dir and cleans it up.
 *
 * Coverage (the release-hardening fixes):
 *   - RETURNING column-order round-trip (schema column order ≠ insert-arg order)
 *   - error-class mapping (unique / not-null / type-mismatch / parse → typed)
 *   - empty-where guard on the COMPILED filter (FIX 1)
 *   - transactions: single-level commit + rollback
 *   - nested `tx.$transaction` and re-entrant `db.$transaction` throw typed (FIX 2)
 *   - chunked relation load over > MAX_RELATION_KEYS parents (FIX 4)
 *   - E017 unsupported guards (vector / cursor stream)
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { NotNullViolationError, UniqueConstraintError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Addon availability gate — skip cleanly when the prebuilt binary is absent.
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
// Schema fixture — column order deliberately ≠ the order writes pass args, so
// the RETURNING round-trip proves columns are matched by name, not position.
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return {
    name,
    field,
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...opts,
  };
}

function makeTable(
  name: string,
  columns: ColumnMetadata[],
  relations: Record<string, RelationDef> = {},
  pk = 'id',
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
    primaryKey: [pk],
    uniqueColumns: [[pk]],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    // Column order: id, email, name, age, score, created_at — writes below pass
    // them in a DIFFERENT order, exercising name-keyed RETURNING.
    app_user: makeTable(
      'app_user',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('email', 'email', 'string', 'text'),
        col('name', 'name', 'string', 'text', { nullable: true }),
        col('age', 'age', 'number', 'int4', { nullable: true }),
        col('score', 'score', 'number', 'float8', { nullable: true }),
        col('created_at', 'createdAt', 'Date', 'timestamptz', { nullable: true }),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'app_user',
          to: 'post',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
    post: makeTable(
      'post',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('author_id', 'authorId', 'string', 'text'),
        col('title', 'title', 'string', 'text'),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'post',
          to: 'app_user',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
  },
};

// ---------------------------------------------------------------------------
// Per-test harness — fresh data dir + schema DDL, torn down after.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient table accessors are dynamically typed at this seam.
type DB = any;

async function withDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-it-'));
  const db: DB = await turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false });
  try {
    for (const t of Object.keys(schema.tables)) await db.raw([`drop ${t}`]).catch(() => {});
    for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('powdb integration (embedded)', () => {
  it('syncMode:"normal" (addon ≥0.7.1) opens and round-trips a write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'powdb-it-sync-'));
    const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, schema, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(schema)) await db.raw([stmt]);
      const u = await db.table('app_user').create({ data: { name: 'Norm', email: 'norm@x', age: 1, score: 1.5 } });
      assert.equal(u.email, 'norm@x');
      const found = await db.table('app_user').findUnique({ where: { email: 'norm@x' } });
      assert.equal(found.name, 'Norm');
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('create/findUnique round-trips columns by NAME despite arg order ≠ schema order', async () => {
    await withDb(async (db) => {
      const created = await db.table('app_user').create({
        // arg order: age, email, score, name — NOT the schema column order
        data: { age: 42, email: 'ada@x', score: 9.5, name: 'Ada' },
      });
      assert.equal(created.email, 'ada@x');
      assert.equal(created.name, 'Ada');
      assert.equal(created.age, 42);
      assert.equal(created.score, 9.5);
      assert.ok(typeof created.id === 'string' && created.id.length > 0);

      const found = await db.table('app_user').findUnique({ where: { email: 'ada@x' } });
      assert.equal(found.id, created.id);
      assert.equal(found.age, 42);
      assert.equal(found.score, 9.5);
    });
  });

  it('createMany + findMany returns real rows (RETURNING, multi-row)', async () => {
    await withDb(async (db) => {
      const rows = await db.table('app_user').createMany({
        data: [
          { email: 'a@x', name: 'A', age: 1 },
          { email: 'b@x', name: 'B', age: 2 },
        ],
      });
      assert.equal(rows.length, 2);
      const all = await db.table('app_user').findMany({ orderBy: { age: 'asc' }, limit: 10 });
      assert.deepEqual(
        all.map((u: { name: string }) => u.name),
        ['A', 'B'],
      );
    });
  });

  it('maps unique / not-null / type-mismatch errors to typed Turbine errors', async () => {
    await withDb(async (db) => {
      await db.table('app_user').create({ data: { id: 'dup', email: 'dup@x', name: 'Dup' } });
      // unique — same PK
      await assert.rejects(
        () => db.table('app_user').create({ data: { id: 'dup', email: 'dup2@x', name: 'X' } }),
        UniqueConstraintError,
      );
      // not-null — omit required email
      await assert.rejects(
        () => db.table('app_user').create({ data: { name: 'NoEmail' } as never }),
        NotNullViolationError,
      );
      // type mismatch — string into an int column
      await assert.rejects(
        () => db.table('app_user').create({ data: { email: 'z@x', age: 'not-a-number' } as never }),
        ValidationError,
      );
    });
  });

  it('FIX 1: empty-where guard refuses compiled-empty filters and mutates nothing', async () => {
    await withDb(async (db) => {
      await db.table('app_user').createMany({
        data: [
          { email: 'g1@x', age: 10 },
          { email: 'g2@x', age: 20 },
          { email: 'g3@x', age: 30 },
        ],
      });
      const cases: Record<string, unknown>[] = [
        { OR: [] },
        { AND: [] },
        { NOT: {} },
        {},
        { id: undefined },
        { OR: [{ name: undefined }] },
      ];
      for (const where of cases) {
        await assert.rejects(
          () => db.table('app_user').updateMany({ where, data: { age: 0 } }),
          ValidationError,
          `expected guard to reject ${JSON.stringify(where)}`,
        );
        await assert.rejects(
          () => db.table('app_user').deleteMany({ where }),
          ValidationError,
          `expected delete guard to reject ${JSON.stringify(where)}`,
        );
      }
      // nothing was mutated/deleted
      assert.equal(await db.table('app_user').count({}), 3);

      // a REAL predicate still works
      const r = await db.table('app_user').updateMany({ where: { email: 'g1@x' }, data: { age: 111 } });
      assert.equal(r.count, 1);
      const g1 = await db.table('app_user').findUnique({ where: { email: 'g1@x' } });
      assert.equal(g1.age, 111);

      // explicit opt-in still allowed
      const all = await db.table('app_user').updateMany({ where: {}, allowFullTableScan: true, data: { age: 7 } });
      assert.equal(all.count, 3);
    });
  });

  it('single-level $transaction commits and rolls back', async () => {
    await withDb(async (db) => {
      await db.$transaction(async (tx: DB) => {
        await tx.table('app_user').create({ data: { email: 'commit@x', name: 'C' } });
      });
      assert.ok(await db.table('app_user').findUnique({ where: { email: 'commit@x' } }));

      await assert.rejects(
        () =>
          db.$transaction(async (tx: DB) => {
            await tx.table('app_user').create({ data: { email: 'rollback@x', name: 'R' } });
            throw new Error('force rollback');
          }),
        /force rollback/,
      );
      assert.equal(await db.table('app_user').findUnique({ where: { email: 'rollback@x' } }), null);
    });
  });

  it('FIX 2: nested tx.$transaction throws UnsupportedFeatureError (savepoint override)', async () => {
    await withDb(async (db) => {
      await assert.rejects(
        () =>
          db.$transaction(async (tx: DB) => {
            await tx.table('app_user').create({ data: { email: 'outer@x' } });
            await tx.$transaction(async () => {});
          }),
        UnsupportedFeatureError,
      );
    });
  });

  it('FIX 2: re-entrant db.$transaction throws (pool single-writer guard), does not hang', async () => {
    await withDb(async (db) => {
      const guarded = Promise.race([
        db.$transaction(async (tx: DB) => {
          await tx.table('app_user').create({ data: { email: 'reouter@x' } });
          await db.$transaction(async (inner: DB) => {
            await inner.table('app_user').create({ data: { email: 'reinner@x' } });
          });
        }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('HANG: re-entrant tx did not return')), 8000)),
      ]);
      await assert.rejects(() => guarded, UnsupportedFeatureError);
      // the pool still works afterwards (flag cleared)
      assert.equal(typeof (await db.table('app_user').count({})), 'number');
    });
  });

  it('FIX 4: chunked relation load returns every child over > MAX_RELATION_KEYS parents', async () => {
    await withDb(async (db) => {
      const N = 1200; // > MAX_RELATION_KEYS (1000) → at least two chunks
      const users = Array.from({ length: N }, (_, i) => ({ id: `u${i}`, email: `bulk${i}@x`, age: i }));
      for (let i = 0; i < users.length; i += 300) {
        await db.table('app_user').createMany({ data: users.slice(i, i + 300) });
      }
      const posts = users.map((u, i) => ({ id: `p${i}`, authorId: u.id, title: `T${i}` }));
      for (let i = 0; i < posts.length; i += 300) {
        await db.table('post').createMany({ data: posts.slice(i, i + 300) });
      }
      const loaded = await db.table('app_user').findMany({
        where: { email: { startsWith: 'bulk' } },
        with: { posts: true },
        limit: 5000,
      });
      assert.equal(loaded.length, N);
      assert.ok(loaded.every((u: { posts: unknown[] }) => Array.isArray(u.posts) && u.posts.length === 1));
      const totalChildren = loaded.reduce((s: number, u: { posts: unknown[] }) => s + u.posts.length, 0);
      assert.equal(totalChildren, N);
    });
  });

  it('E017: pgvector filters and cursor streaming are unsupported', async () => {
    await withDb(async (db) => {
      await assert.rejects(
        () =>
          db.table('app_user').findMany({
            where: { score: { distance: { to: [1], metric: 'cosine', lt: 1 } } } as never,
          }),
        UnsupportedFeatureError,
      );
      await assert.rejects(() => db.table('app_user').findManyStream().next(), UnsupportedFeatureError);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase B (v0.23.0) — auto/server-generated PKs, manyToMany reads + filters,
// nested writes, composite-key upsert. Own schema (auto-int PKs + a junction).
// These exercise the live engine; the relation-filter cases also guard the
// PowDB subquery-result-cache bug (Turbine resolves filters to literal lists).
// ---------------------------------------------------------------------------

function composite(name: string, columns: ColumnMetadata[], pk: string[]): TableMetadata {
  return { ...makeTable(name, columns), primaryKey: pk, uniqueColumns: [] };
}

const pbSchema: SchemaMetadata = {
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
    ptag: makeTable('ptag', [
      col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
      col('label', 'label', 'string', 'text'),
    ]),
    member_tag: composite(
      'member_tag',
      [col('member_id', 'memberId', 'number', 'int8'), col('tag_id', 'tagId', 'number', 'int8')],
      ['member_id', 'tag_id'],
    ),
    pscore: composite(
      'pscore',
      [
        col('member_id', 'memberId', 'number', 'int8'),
        col('tag_id', 'tagId', 'number', 'int8'),
        col('points', 'points', 'number', 'int8'),
      ],
      ['member_id', 'tag_id'],
    ),
  },
};

async function withPb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-pb-'));
  const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, pbSchema, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(pbSchema)) await db.raw([stmt]);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('powdb integration: Phase B', () => {
  it('auto/server-generated int PK — create/createMany assign monotonic ids', async () => {
    await withPb(async (db) => {
      const a = await db.table('member').create({ data: { name: 'Ada' } });
      const b = await db.table('member').create({ data: { name: 'Bob' } });
      assert.equal(typeof a.id, 'number');
      assert.equal(b.id, a.id + 1);
      const many = await db.table('member').createMany({ data: [{ name: 'Cy' }, { name: 'Di' }] });
      assert.equal(many.length, 2);
      assert.notEqual(many[0].id, many[1].id);
    });
  });

  it('manyToMany nested reads — junction loader stitches targets (empty array, not null)', async () => {
    await withPb(async (db) => {
      const ada = await db.table('member').create({ data: { name: 'Ada' } });
      const bob = await db.table('member').create({ data: { name: 'Bob' } });
      const cy = await db.table('member').create({ data: { name: 'Cy' } });
      const red = await db.table('ptag').create({ data: { label: 'red' } });
      const blue = await db.table('ptag').create({ data: { label: 'blue' } });
      await db.table('member_tag').createMany({
        data: [
          { memberId: ada.id, tagId: red.id },
          { memberId: ada.id, tagId: blue.id },
          { memberId: bob.id, tagId: blue.id },
        ],
      });
      const rows = await db.table('member').findMany({
        where: { id: { in: [ada.id, bob.id, cy.id] } },
        orderBy: { id: 'asc' },
        with: { tags: true },
      });
      const by = Object.fromEntries(rows.map((r: { name: string }) => [r.name, r]));
      assert.equal(by.Ada.tags.length, 2);
      assert.deepEqual(by.Ada.tags.map((t: { label: string }) => t.label).sort(), ['blue', 'red']);
      assert.equal(by.Bob.tags.length, 1);
      assert.ok(Array.isArray(by.Cy.tags) && by.Cy.tags.length === 0);
    });
  });

  it('manyToMany relation filters — some/none/every resolve correctly and DETERMINISTICALLY', async () => {
    await withPb(async (db) => {
      const ada = await db.table('member').create({ data: { name: 'Ada' } });
      const bob = await db.table('member').create({ data: { name: 'Bob' } });
      const cy = await db.table('member').create({ data: { name: 'Cy' } });
      const red = await db.table('ptag').create({ data: { label: 'red' } });
      const blue = await db.table('ptag').create({ data: { label: 'blue' } });
      await db.table('member_tag').createMany({
        data: [
          { memberId: ada.id, tagId: red.id },
          { memberId: ada.id, tagId: blue.id },
          { memberId: bob.id, tagId: blue.id },
        ],
      });
      const names = (rs: { name: string }[]) =>
        rs
          .map((r) => r.name)
          .sort()
          .join(',');
      // Run red BEFORE blue — the pre-cache-bug ordering that returned stale rows.
      assert.equal(names(await db.table('member').findMany({ where: { tags: { some: { label: 'red' } } } })), 'Ada');
      assert.equal(
        names(await db.table('member').findMany({ where: { tags: { some: { label: 'blue' } } } })),
        'Ada,Bob',
      );
      assert.equal(names(await db.table('member').findMany({ where: { tags: { none: { label: 'blue' } } } })), 'Cy');
      assert.equal(
        names(await db.table('member').findMany({ where: { tags: { every: { label: 'blue' } } } })),
        'Bob,Cy',
      );
      void cy;
    });
  });

  it('hasMany/belongsTo relation filters resolve to literal lists (no stale IN-subquery)', async () => {
    await withPb(async (db) => {
      const ada = await db.table('member').create({ data: { name: 'Ada' } });
      const bob = await db.table('member').create({ data: { name: 'Bob' } });
      await db.table('ppost').createMany({
        data: [
          { memberId: ada.id, title: 'x' },
          { memberId: bob.id, title: 'y' },
        ],
      });
      // querying by different titles back-to-back must NOT return stale results
      const x = await db.table('member').findMany({ where: { posts: { some: { title: 'x' } } } });
      const y = await db.table('member').findMany({ where: { posts: { some: { title: 'y' } } } });
      assert.deepEqual(
        x.map((m: { name: string }) => m.name),
        ['Ada'],
      );
      assert.deepEqual(
        y.map((m: { name: string }) => m.name),
        ['Bob'],
      );
    });
  });

  it('nested writes — hasMany create + belongsTo create/connect, atomic rollback on failure', async () => {
    await withPb(async (db) => {
      const eve = await db
        .table('member')
        .create({ data: { name: 'Eve', posts: { create: [{ title: 'P1' }, { title: 'P2' }] } } });
      const full = await db.table('member').findUnique({ where: { id: eve.id }, with: { posts: true } });
      assert.equal(full.posts.length, 2);
      assert.ok(full.posts.every((p: { memberId: number }) => p.memberId === eve.id));
      const post = await db
        .table('ppost')
        .create({ data: { title: 'byFrank', author: { create: { name: 'Frank' } } } });
      const frank = await db.table('member').findFirst({ where: { name: 'Frank' } });
      assert.equal(post.memberId, frank.id);
      // atomic: a failing nested create rolls back the parent
      const dupe = post.id;
      let threw = false;
      try {
        await db
          .table('member')
          .create({ data: { name: 'Zed', posts: { create: [{ title: 'ok' }, { id: dupe, title: 'dupe' }] } } });
      } catch {
        threw = true;
      }
      assert.ok(threw);
      assert.equal((await db.table('member').findMany({ where: { name: 'Zed' } })).length, 0);
    });
  });

  it('composite-key upsert — insert then update branch, exactly one row', async () => {
    await withPb(async (db) => {
      const ins = await db.table('pscore').upsert({
        where: { memberId: 1, tagId: 2 },
        create: { memberId: 1, tagId: 2, points: 10 },
        update: { points: 99 },
      });
      assert.equal(ins.points, 10);
      const upd = await db.table('pscore').upsert({
        where: { memberId: 1, tagId: 2 },
        create: { memberId: 1, tagId: 2, points: 10 },
        update: { points: 99 },
      });
      assert.equal(upd.points, 99);
      const rows = await db.table('pscore').findMany({ where: { memberId: 1, tagId: 2 } });
      assert.equal(rows.length, 1);
    });
  });
});
