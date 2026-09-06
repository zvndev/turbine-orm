/**
 * turbine-orm, multi-field cursor pagination against a live PostgreSQL.
 *
 * A cursor over more than one field is a KEYSET seek: `(a, b) > ($1, $2)` in
 * the total order the `orderBy` declares. It used to compile to the
 * conjunction `a > $1 AND b > $2`, which drops every row whose first key
 * EQUALS the cursor's, so paging a table with few distinct values of the
 * leading key skipped most of it and never said so.
 *
 * Every page here is asserted against the row-value form issued as raw SQL,
 * and the whole walk is asserted to visit every id exactly once.
 *
 * Creates and drops its own `qa78_*` table, so it needs only a reachable
 * Postgres:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/keyset-cursor.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping keyset cursor integration tests: DATABASE_URL not set');
}

const TABLE = 'qa78_keyset_posts';
const ROWS = 600;
const PAGE = 50;

const DDL = [
  `DROP TABLE IF EXISTS ${TABLE} CASCADE`,
  `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, view_count int NOT NULL, author_id int NOT NULL, title text)`,
  // Three distinct view_count values over 600 rows: the shape that makes a
  // conjunction seek lose rows (every row sharing the cursor's view_count
  // but with a smaller id was skipped).
  `INSERT INTO ${TABLE} (view_count, author_id, title)
     SELECT g % 3, g % 7, 'post ' || g FROM generate_series(1, ${ROWS}) g`,
];

interface Row {
  id: number;
  viewCount: number;
  authorId: number;
  title: string | null;
}

let pool: pg.Pool;
let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe('multi-field cursor is a keyset seek (live)', () => {
  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
    for (const sql of DDL) await pool.query(sql);
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 4, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    if (pool) {
      await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
      await pool.end();
    }
  });

  /**
   * Walk the whole table page by page through the ORM, checking each page
   * against the raw row-value keyset issued directly, and return every id
   * visited in order.
   */
  async function walk(opts: {
    orderBy: Record<string, 'asc' | 'desc'>[];
    where?: Record<string, unknown>;
    rawWhere: string;
    rawOrder: string;
    rawSeek: (cursor: Row) => { sql: string; params: unknown[] };
  }): Promise<number[]> {
    const visited: number[] = [];
    let cursor: Row | undefined;
    for (let page = 0; page < ROWS / PAGE + 2; page++) {
      const args: Record<string, unknown> = { orderBy: opts.orderBy, limit: PAGE };
      if (opts.where) args.where = opts.where;
      if (cursor) args.cursor = { viewCount: cursor.viewCount, id: cursor.id };
      const rows = (await db.table(TABLE).findMany(args as never)) as unknown as Row[];

      const seek = cursor ? opts.rawSeek(cursor) : { sql: '', params: [] };
      const predicates = [opts.rawWhere, seek.sql].filter(Boolean);
      const raw = await pool.query<{ id: number }>(
        `SELECT id FROM ${TABLE}${predicates.length ? ` WHERE ${predicates.join(' AND ')}` : ''} ` +
          `ORDER BY ${opts.rawOrder} LIMIT ${PAGE}`,
        seek.params,
      );
      assert.deepEqual(
        rows.map((r) => r.id),
        raw.rows.map((r) => r.id),
        `page ${page} differs from the raw row-value keyset`,
      );

      if (rows.length === 0) break;
      visited.push(...rows.map((r) => r.id));
      cursor = rows[rows.length - 1]!;
      if (rows.length < PAGE) break;
    }
    return visited;
  }

  it('asc/asc: 600 rows, 3 distinct leading values, every id visited exactly once', async () => {
    const visited = await walk({
      orderBy: [{ viewCount: 'asc' }, { id: 'asc' }],
      rawWhere: '',
      rawOrder: 'view_count ASC, id ASC',
      rawSeek: (c) => ({ sql: '(view_count, id) > ($1, $2)', params: [c.viewCount, c.id] }),
    });
    assert.equal(visited.length, ROWS, `visited ${visited.length} of ${ROWS} rows`);
    assert.equal(new Set(visited).size, ROWS, 'an id was visited twice');
    const expected = await pool.query<{ id: number }>(`SELECT id FROM ${TABLE} ORDER BY view_count ASC, id ASC`);
    assert.deepEqual(
      visited,
      expected.rows.map((r) => r.id),
    );
  });

  it('desc/asc mixed directions: every id visited exactly once in the declared order', async () => {
    const visited = await walk({
      orderBy: [{ viewCount: 'desc' }, { id: 'asc' }],
      rawWhere: '',
      rawOrder: 'view_count DESC, id ASC',
      // No row-value form for a mixed direction; the expanded keyset IS the truth.
      rawSeek: (c) => ({ sql: '(view_count < $1 OR (view_count = $1 AND id > $2))', params: [c.viewCount, c.id] }),
    });
    assert.equal(visited.length, ROWS, `visited ${visited.length} of ${ROWS} rows`);
    assert.equal(new Set(visited).size, ROWS, 'an id was visited twice');
    const expected = await pool.query<{ id: number }>(`SELECT id FROM ${TABLE} ORDER BY view_count DESC, id ASC`);
    assert.deepEqual(
      visited,
      expected.rows.map((r) => r.id),
    );
  });

  it('with a where: the seek composes with the filter and still visits every matching id once', async () => {
    const visited = await walk({
      orderBy: [{ viewCount: 'asc' }, { id: 'asc' }],
      where: { authorId: { in: [1, 2, 3] } },
      rawWhere: 'author_id IN (1, 2, 3)',
      rawOrder: 'view_count ASC, id ASC',
      rawSeek: (c) => ({ sql: '(view_count, id) > ($1, $2)', params: [c.viewCount, c.id] }),
    });
    const expected = await pool.query<{ id: number }>(
      `SELECT id FROM ${TABLE} WHERE author_id IN (1, 2, 3) ORDER BY view_count ASC, id ASC`,
    );
    assert.equal(visited.length, expected.rows.length, `visited ${visited.length} of ${expected.rows.length} rows`);
    assert.equal(new Set(visited).size, expected.rows.length, 'an id was visited twice');
    assert.deepEqual(
      visited,
      expected.rows.map((r) => r.id),
    );
  });

  it('a single-field cursor is unchanged: plain `id > $1` walk visits every id once', async () => {
    const visited: number[] = [];
    let last: number | undefined;
    for (;;) {
      const args: Record<string, unknown> = { orderBy: { id: 'asc' }, limit: PAGE };
      if (last !== undefined) args.cursor = { id: last };
      const rows = (await db.table(TABLE).findMany(args as never)) as unknown as Row[];
      if (rows.length === 0) break;
      visited.push(...rows.map((r) => r.id));
      last = rows[rows.length - 1]!.id;
      if (rows.length < PAGE) break;
    }
    assert.equal(visited.length, ROWS);
    assert.equal(new Set(visited).size, ROWS);
  });
});
