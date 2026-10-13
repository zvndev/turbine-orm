/**
 * PowDB follows the same rule as the SQL engines: a PII-tagged column named in
 * `select` is refused unless the read passes `includePii: UNSAFE`.
 *
 * PowDB projects through its own `projectionPlan`, not `resolveProjection`, so
 * the rule is written twice and this file is what keeps the two in step. It
 * also covers the case the rule must NOT break: a loader that adds a
 * PII-tagged correlation column to the child fetch itself, which is stripped
 * from every row before the caller sees it.
 *
 * Runs on the in-process embedded addon, gated on the prebuilt binary loading.
 *
 * Run: npx tsx --test src/test/security-perimeter-pii-select-powdb.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { UnsupportedFeatureError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { UNSAFE } from '../query/index.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

function col(name: string, field: string, tsType: string, pgType: string, opts: Partial<ColumnMetadata> = {}) {
  return {
    name,
    field,
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: '',
    ...opts,
  } as ColumnMetadata;
}

function table(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef> = {}): TableMetadata {
  return {
    name,
    columns,
    columnMap: Object.fromEntries(columns.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(columns.map((c) => [c.name, c.field])),
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

/** `owner(id, name, email[PII]) -> items`; `item(id, owner_id[PII], title, note[PII]) -> owner`. */
function schema(): SchemaMetadata {
  const id = { isGenerated: true, hasDefault: true };
  return {
    enums: {},
    tables: {
      owner: table(
        'owner',
        [
          col('id', 'id', 'number', 'int8', id),
          col('name', 'name', 'string', 'text'),
          col('email', 'email', 'string', 'text', { pii: true }),
        ],
        {
          items: {
            type: 'hasMany',
            name: 'items',
            from: 'owner',
            to: 'item',
            foreignKey: 'owner_id',
            referenceKey: 'id',
          },
        },
      ),
      item: table(
        'item',
        [
          col('id', 'id', 'number', 'int8', id),
          col('owner_id', 'ownerId', 'number', 'int8', { pii: true }),
          col('title', 'title', 'string', 'text'),
          col('note', 'note', 'string', 'text', { pii: true }),
        ],
        {
          owner: {
            type: 'belongsTo',
            name: 'owner',
            from: 'item',
            to: 'owner',
            foreignKey: 'owner_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient table accessors are dynamically typed at this seam.
type DB = any;

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const powdb = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

async function withDb(fn: (db: DB, ownerId: unknown) => Promise<void>): Promise<void> {
  const s = schema();
  const dir = mkdtempSync(join(tmpdir(), 'powdb-pii-select-'));
  const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, s, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(s)) await db.rawUnsafe(stmt);
    await db.table('owner').create({ data: { name: 'Ada', email: 'ada@x.test' } });
    const ada = await db.table('owner').findFirst({ where: { name: 'Ada' } });
    await db.table('item').createMany({
      data: [
        { ownerId: ada.id, title: 'i1', note: 'n1' },
        { ownerId: ada.id, title: 'i2', note: 'n2' },
      ],
    });
    await fn(db, ada.id);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

const NAMES_PII = (field: string) => new RegExp(`names "${field}", which is tagged PII`);

describe('PowDB: a PII column in select needs includePii: UNSAFE', () => {
  powdb.it('top level: refused without the opt-in, returned with it', async () => {
    await withDb(async (db, ownerId) => {
      await assert.rejects(
        () => db.table('owner').findMany({ where: { id: ownerId }, select: { email: true } }),
        (err: Error) => NAMES_PII('email').test(err.message) && /E003/.test(err.message),
      );
      await assert.rejects(
        () => db.table('owner').findUnique({ where: { id: ownerId }, select: { email: true } }),
        (err: Error) => NAMES_PII('email').test(err.message),
      );
      const rows = await db
        .table('owner')
        .findMany({ where: { id: ownerId }, select: { email: true }, includePii: UNSAFE });
      assert.equal(rows[0].email, 'ada@x.test');
    });
  });

  powdb.it('a request body cannot supply the opt-in', async () => {
    await withDb(async (db, ownerId) => {
      const body = JSON.parse('{"select":{"email":true},"includePii":true}') as Record<string, unknown>;
      await assert.rejects(() => db.table('owner').findMany({ where: { id: ownerId }, ...body }));
    });
  });

  powdb.it('a relation select naming a PII column is refused, and passes under the opt-in', async () => {
    await withDb(async (db, ownerId) => {
      await assert.rejects(
        () =>
          db.table('owner').findMany({
            where: { id: ownerId },
            with: { items: { select: { note: true } } },
          }),
        (err: Error) => NAMES_PII('note').test(err.message),
      );
      const rows = await db.table('owner').findMany({
        where: { id: ownerId },
        with: { items: { select: { note: true }, orderBy: { title: 'asc' } } },
        includePii: UNSAFE,
      });
      assert.deepEqual(
        rows[0].items.map((i: Record<string, unknown>) => i.note),
        ['n1', 'n2'],
      );
    });
  });

  powdb.it('single-row writes cannot return a PII column through select', async () => {
    await withDb(async (db, ownerId) => {
      await assert.rejects(
        () => db.table('owner').create({ data: { name: 'Bo', email: 'bo@x.test' }, select: { email: true } }),
        (err: Error) => NAMES_PII('email').test(err.message),
      );
      await assert.rejects(
        () => db.table('owner').update({ where: { id: ownerId }, data: { name: 'Ada2' }, select: { email: true } }),
        (err: Error) => NAMES_PII('email').test(err.message),
      );
      const ok = await db
        .table('owner')
        .update({ where: { id: ownerId }, data: { name: 'Ada3' }, select: { name: true } });
      assert.equal(ok.name, 'Ada3');
    });
  });

  powdb.it('omit, predicates and an untagged select are unchanged', async () => {
    await withDb(async (db, ownerId) => {
      const rows = await db.table('owner').findMany({ where: { email: 'ada@x.test' }, omit: { name: true } });
      assert.equal(rows.length, 1);
      assert.equal('email' in rows[0], false);
      const named = await db.table('owner').findMany({ where: { id: ownerId }, select: { name: true } });
      assert.equal(named[0].name, 'Ada');
    });
  });
});

describe('PowDB: a PII-tagged correlation column the loader adds is not a refusal', () => {
  // item.owner_id is the hasMany correlation key and is tagged PII. A relation
  // `select: { title: true }` omits it, so the loader adds it to the child fetch
  // to bucket rows, and strips it again. Refusing that would break a read that
  // names no PII at all.
  for (const strategy of [undefined, 'batched', 'join'] as const) {
    powdb.it(`hasMany select without the key (strategy ${strategy ?? 'default'})`, async (t) => {
      await withDb(async (db, ownerId) => {
        let rows: Record<string, unknown>[];
        try {
          rows = await db.table('owner').findMany({
            where: { id: ownerId },
            with: { items: { select: { title: true }, orderBy: { title: 'asc' } } },
            ...(strategy ? { relationLoadStrategy: strategy } : {}),
          });
        } catch (err) {
          if (err instanceof UnsupportedFeatureError) {
            t.skip('addon predates the serverJoins capability (E017)');
            return;
          }
          throw err;
        }
        const items = rows[0]!.items as Record<string, unknown>[];
        assert.deepEqual(
          items.map((i) => i.title),
          ['i1', 'i2'],
          'the relation must come back populated, or the next assertion is vacuous',
        );
        for (const item of items) {
          assert.equal('ownerId' in item, false, 'the key the loader added is stripped');
          assert.equal('note' in item, false);
        }
      });
    });
  }

  powdb.it('belongsTo select without the key still resolves its owner', async () => {
    await withDb(async (db) => {
      const items = await db.table('item').findMany({
        with: { owner: { select: { name: true } } },
        select: { title: true },
        orderBy: { title: 'asc' },
      });
      assert.deepEqual(
        items.map((i: Record<string, unknown>) => (i.owner as Record<string, unknown>).name),
        ['Ada', 'Ada'],
      );
    });
  });

  powdb.it('naming the tagged key yourself is still refused', async () => {
    await withDb(async (db, ownerId) => {
      await assert.rejects(
        () =>
          db.table('owner').findMany({
            where: { id: ownerId },
            with: { items: { select: { ownerId: true, title: true } } },
            relationLoadStrategy: 'batched',
          }),
        (err: Error) => NAMES_PII('ownerId').test(err.message),
      );
    });
  });
});
