import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const url = process.env.DATABASE_URL;
const { before, after, it } = skipGate(!url, 'DATABASE_URL not set');
const table = 'qa_tuple_cursor';
const schema: SchemaMetadata = {
  tables: {
    [table]: mockTable(table, [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'sort_key', field: 'sortKey', pgType: 'int4' },
    ]),
  },
  enums: {},
};
interface Row {
  id: number;
  sortKey: number;
}
const oracle = Array.from({ length: 300 }, (_, i) => ({ id: i + 1, sortKey: (i + 1) % 7 }));
let pool: pg.Pool;
let db: TurbineClient;

describe('tuple cursor PostgreSQL values', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: url, max: 1 });
    await pool.query(`CREATE TABLE ${table} (id int PRIMARY KEY, sort_key int NOT NULL)`);
    await pool.query(`INSERT INTO ${table} SELECT g, g % 7 FROM generate_series(1,300) g`);
    db = new TurbineClient({ pool, preparedStatements: true }, schema);
  });
  after(async () => {
    if (pool) {
      try {
        await pool.query(`DROP TABLE IF EXISTS ${table}`);
      } finally {
        await pool.end();
      }
    }
  });

  for (const direction of ['asc', 'desc'] as const) {
    it(`walks every exact row ${direction} across warmed templates`, async () => {
      const expected = [...oracle].sort(
        (a, b) => (direction === 'asc' ? 1 : -1) * (a.sortKey - b.sortKey || a.id - b.id),
      );
      const q = db.table<Row>(table);
      let cursor = expected[0]!;
      const found: Row[] = [];
      for (let i = 0; i < 50; i++) {
        const args = { orderBy: { sortKey: direction }, cursor, limit: 13 };
        const tuple = await q.findMany({ ...args, cursorPredicate: 'tuple' });
        assert.deepEqual(tuple, await q.findMany(args));
        found.push(...tuple);
        if (!tuple.length) break;
        cursor = tuple[tuple.length - 1]!;
      }
      assert.deepEqual(found, expected.slice(1));
      assert.ok(q.cacheStats().hits > 10);
    });
  }

  it('shares the page with transaction, pipeline and both stream paths', async () => {
    const q = db.table<Row>(table);
    const args = {
      cursorPredicate: 'tuple' as const,
      cursor: { sortKey: 3, id: 70 },
      orderBy: { sortKey: 'asc' as const },
      limit: 9,
    };
    const expected = [...oracle]
      .sort((a, b) => a.sortKey - b.sortKey || a.id - b.id)
      .filter((r) => r.sortKey > 3 || (r.sortKey === 3 && r.id > 70))
      .slice(0, 9);
    assert.deepEqual(await q.findMany(args), expected);
    assert.deepEqual(await db.$transaction((tx) => tx.table<Row>(table).findMany(args)), expected);
    assert.deepEqual(await db.pipeline([q.buildFindMany(args)]), [expected]);
    const rows: Row[] = [];
    for await (const row of q.findManyStream({ ...args, batchSize: 2 })) rows.push(row);
    assert.deepEqual(rows, expected);
    const batches: Row[] = [];
    for await (const batch of q.findManyStreamBatches({ ...args, batchSize: 2 })) batches.push(...batch);
    assert.deepEqual(batches, expected);
  });
});
