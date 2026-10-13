/**
 * Page walks over an order that ties visit every row exactly once (live PostgreSQL).
 *
 * A paginated `findMany` whose `orderBy` can tie is cut from a total order (the
 * primary key appended, in the last term's direction), the same order the
 * cursor pages after it use. Without that, a page boundary inside a run of
 * tied rows falls in a different place on each page, so rows are skipped or
 * repeated, and a cursor walk that starts from a `limit`-only first page skips
 * the tied rows page 1 did not happen to return.
 *
 * Creates and drops its own table:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/builder-timeouts-pages.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const TABLE = 'bt_pages';
const ROWS = 300;
const PAGE = 7;

function schema(): SchemaMetadata {
  const table = mockTable(TABLE, [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'grp', field: 'grp', pgType: 'int4' },
  ]);
  table.columns.find((c) => c.name === 'grp')!.nullable = true;
  return { enums: {}, tables: { [TABLE]: table } };
}

interface Row {
  id: number;
  name: string;
  grp: number | null;
}

type Order = Record<string, 'asc' | 'desc'>;

describe('page walks over tied orders visit every row once', () => {
  let admin: pg.Client;
  let db: TurbineClient;
  const rows = () => db.table<Row>(TABLE);

  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin.query(`CREATE TABLE ${TABLE} (id int PRIMARY KEY, name text NOT NULL, grp int)`);
    // Inserted in a scrambled id order, so the heap order is not the id order.
    const ids = Array.from({ length: ROWS }, (_, i) => ((i * 7919) % ROWS) + 1);
    await admin.query(
      `INSERT INTO ${TABLE} (id, name, grp)
       SELECT id, (ARRAY['a','b','c'])[1 + id % 3], CASE WHEN id % 4 = 0 THEN NULL ELSE id % 5 END
       FROM unnest($1::int[]) AS id`,
      [ids],
    );
    await admin.query(`ANALYZE ${TABLE}`);
    db = new TurbineClient({ connectionString: DATABASE_URL, poolSize: 2, warnOnUnlimited: false }, schema());
  });

  after(async () => {
    await db?.disconnect();
    await admin?.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await admin?.end();
  });

  function assertEveryRowOnce(seen: number[], label: string): void {
    const duplicates = seen.filter((id, i) => seen.indexOf(id) !== i);
    assert.deepEqual(duplicates, [], `${label}: rows returned on more than one page`);
    assert.equal(new Set(seen).size, ROWS, `${label}: rows never returned`);
  }

  const orders: Order[] = [{ name: 'asc' }, { name: 'desc' }, { grp: 'asc' }, { grp: 'desc' }];

  for (const orderBy of orders) {
    const label = JSON.stringify(orderBy);

    it(`offset walk ${label}`, async () => {
      const seen: number[] = [];
      for (let offset = 0; offset < ROWS + PAGE; offset += PAGE) {
        const page = await rows().findMany({ orderBy, limit: PAGE, offset });
        seen.push(...page.map((r) => r.id));
      }
      assertEveryRowOnce(seen, label);
    });

    it(`cursor walk from a limit-only first page ${label}`, async () => {
      const seen: number[] = [];
      let page = await rows().findMany({ orderBy, limit: PAGE });
      while (page.length > 0) {
        seen.push(...page.map((r) => r.id));
        const last = page[page.length - 1]!;
        const key = Object.keys(orderBy)[0] as 'name' | 'grp';
        page = await rows().findMany({ orderBy, limit: PAGE, cursor: { [key]: last[key], id: last.id } });
        assert.ok(seen.length <= ROWS, `${label}: the walk did not end`);
      }
      assertEveryRowOnce(seen, label);
    });
  }
});
