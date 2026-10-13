/**
 * prisma-compat: a cursor names a row, and a page placed by a row that no
 * longer exists is empty.
 *
 * Prisma reads the cursor row's ordered values in a subquery, so when the row
 * has been deleted the comparison is against NULL and the page is `[]`. The
 * adapter's inclusive cursor gets the same answer whatever the order, including
 * the common `orderBy: { id: 'asc' }` where the cursor already carries every
 * ordered value. Core's own (exclusive) cursor is a position, not a row, and
 * still seeks from the value it was given.
 *
 * Live: needs DATABASE_URL.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/where-hardening-compat-cursor.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap } from '../schema.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the compat delegates are untyped here
type Any = any;

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

const MAP: PrismaCompatMap = {
  enums: {},
  models: {
    Item: {
      table: 'wh_cc_items',
      accessor: 'whCcItems',
      fields: { id: 'id', rank: 'rank' },
      relations: {},
      compoundUniques: {},
    },
  },
};

const ids = (rows: unknown): number[] => (rows as { id: number }[]).map((r) => r.id);

describe('prisma-compat: a cursor whose row was deleted', () => {
  let db: TurbineClient;
  let compat: Any;

  live.before(async () => {
    await runSql([
      'DROP TABLE IF EXISTS wh_cc_items',
      'CREATE TABLE wh_cc_items (id int PRIMARY KEY, rank int NOT NULL)',
      'INSERT INTO wh_cc_items SELECT g, 10 - g FROM generate_series(1, 8) g',
      // The row a client paged to, then deleted before asking for the next page.
      'DELETE FROM wh_cc_items WHERE id = 3',
    ]);
    const schema = await introspect({ connectionString: DATABASE_URL!, include: ['wh_cc_items'] });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 1, warnOnUnlimited: false }, schema);
    compat = createPrismaCompatClient(db, MAP);
  });

  live.after(async () => {
    await db?.disconnect();
    await runSql(['DROP TABLE IF EXISTS wh_cc_items']);
  });

  live.it('the skip: 1 idiom ordered by the cursor field gives an empty page', async () => {
    const rows = await compat.Item.findMany({ cursor: { id: 3 }, skip: 1, take: 2, orderBy: { id: 'asc' } });
    assert.deepEqual(ids(rows), []);
  });

  live.it('without skip, and with no orderBy at all, the page is empty too', async () => {
    assert.deepEqual(ids(await compat.Item.findMany({ cursor: { id: 3 }, take: 2, orderBy: { id: 'asc' } })), []);
    assert.deepEqual(ids(await compat.Item.findMany({ cursor: { id: 3 }, take: 2 })), []);
  });

  live.it('ordered by another field, a deleted cursor row is an empty page', async () => {
    const rows = await compat.Item.findMany({ cursor: { id: 3 }, skip: 1, take: 2, orderBy: { rank: 'desc' } });
    assert.deepEqual(ids(rows), []);
  });

  live.it('a cursor row that exists starts the page at that row', async () => {
    assert.deepEqual(
      ids(await compat.Item.findMany({ cursor: { id: 4 }, skip: 1, take: 2, orderBy: { id: 'asc' } })),
      [5, 6],
    );
    assert.deepEqual(ids(await compat.Item.findMany({ cursor: { id: 4 }, take: 2, orderBy: { id: 'asc' } })), [4, 5]);
    assert.deepEqual(ids(await compat.Item.findMany({ cursor: { id: 4 }, take: 2, orderBy: { id: 'desc' } })), [4, 2]);
  });

  live.it("core's exclusive cursor still seeks from the value it was given", async () => {
    const rows = await db.table('wh_cc_items').findMany({ cursor: { id: 3 }, orderBy: { id: 'asc' }, limit: 2 });
    assert.deepEqual(ids(rows), [4, 5]);
  });
});
