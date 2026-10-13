/**
 * turbine-orm: MySQL writes that return their row by re-reading it.
 *
 * MySQL has no RETURNING, so a single-row write runs the statement and then a
 * SELECT. Those statements now share one transaction with the row locked, so
 * the row returned is the row this call wrote: of several concurrent deletes of
 * one row exactly one reports it, and an update that changes a column its
 * `where` names returns the updated row instead of "not found".
 *
 * Run: MYSQL_URL=mysql://user@host:3306/db npx tsx --test src/test/builder-timeouts-mysql.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { NotFoundError, TimeoutError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const { it, before, after } = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const TABLE = 'bt_items';
/** Its own database: test files run in parallel, and mysql.test.ts asserts the exact table list of the URL's. */
const DATABASE = 'turbine_builder_timeouts';

interface Item {
  id: number;
  name: string;
  status: string;
  n: number;
}

describe('MySQL reselect writes run in one transaction (live MySQL)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool shape, loaded dynamically
  let rawPool: any;
  let db: TurbineClient;
  const items = () => db.table<Item>(TABLE);
  const count = async (where: string): Promise<number> => {
    const [rows] = await rawPool.query(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE ${where}`);
    return Number((rows as { n: number }[])[0]!.n);
  };

  before(async () => {
    const { createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    const server = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    const admin = createPool(server);
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${DATABASE}\``);
    await admin.end();
    rawPool = createPool({
      ...server,
      database: DATABASE,
      namedPlaceholders: true,
      supportBigNumbers: true,
      timezone: 'Z',
      connectionLimit: 8,
    });
    await rawPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await rawPool.query(
      `CREATE TABLE ${TABLE} (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL UNIQUE, ` +
        `status VARCHAR(16) NOT NULL DEFAULT 'open', n INT NOT NULL DEFAULT 0)`,
    );
    const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
    const pool = new MysqlPool(rawPool);
    const schema: SchemaMetadata = await introspectMysqlWith(
      async (sql, params) => (await pool.query(sql, params)).rows,
      DATABASE,
    );
    db = (await turbineMysql(pool, schema)) as unknown as TurbineClient;
  });
  after(async () => {
    if (!rawPool) return;
    await rawPool.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await rawPool.end();
  });

  it('of concurrent deletes of one row, exactly one returns it', async () => {
    for (let round = 0; round < 5; round++) {
      const created = await items().create({ data: { name: `del-${round}` } });
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, () => items().delete({ where: { id: created.id } })),
      );
      const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
      const rejected = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
      assert.equal(fulfilled.length, 1, `round ${round}: deletes that reported the row`);
      for (const r of rejected) assert.ok(r.reason instanceof NotFoundError, String(r.reason));
      assert.equal(await count(`id = ${Number(created.id)}`), 0);
    }
  });

  it('a delete that matches nothing reports NotFoundError and leaves no open transaction', async () => {
    await assert.rejects(items().delete({ where: { id: 987654 } }), NotFoundError);
    // Every pooled connection is free again: a full pool of reads still runs.
    const reads = await Promise.all(Array.from({ length: 8 }, () => items().count()));
    assert.equal(reads.length, 8);
  });

  it('an update that changes a column its where names returns the updated row', async () => {
    await items().create({ data: { name: 'mover', status: 'open' } });
    const updated = await items().update({ where: { name: 'mover' }, data: { name: 'moved', status: 'done' } });
    assert.equal(updated.name, 'moved');
    assert.equal(updated.status, 'done');
    await assert.rejects(items().update({ where: { name: 'mover' }, data: { name: 'again' } }), NotFoundError);
  });

  it('concurrent increments through update each return a distinct value', async () => {
    await items().create({ data: { name: 'counter', n: 0 } });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => items().update({ where: { name: 'counter' }, data: { n: { increment: 1 } } })),
    );
    const seen = results.map((r) => Number(r.n)).sort((a, b) => a - b);
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6]);
  });

  it('a timed-out write is rolled back, and its connection never returns to the pool mid-transaction', async () => {
    const row = await items().create({ data: { name: 'locked', n: 0 } });
    // A second session holds the row lock, so the update waits and times out.
    const blocker = await rawPool.getConnection();
    try {
      await blocker.query('START TRANSACTION');
      await blocker.query(`SELECT * FROM ${TABLE} WHERE id = ? FOR UPDATE`, [row.id]);
      await assert.rejects(
        items().update({ where: { id: row.id }, data: { n: 99 }, timeout: 300 }),
        (err: unknown) => err instanceof TimeoutError && err.outcome === 'not-executed',
      );
    } finally {
      await blocker.query('COMMIT');
      blocker.release();
    }
    // Every pooled connection, the timed-out one included, now commits what it writes.
    await Promise.all(Array.from({ length: 16 }, (_, i) => items().create({ data: { name: `after-${i}` } })));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await count(`name LIKE 'after-%'`), 16);
    assert.equal(await count(`id = ${Number(row.id)} AND n = 0`), 1, 'the timed-out update was applied');
  });

  it('createMany over the bind-parameter limit inserts every row in one transaction', async () => {
    // 3 columns per row: 25,000 rows bind 75,000 values, over MySQL's 65,535.
    const data = Array.from({ length: 25_000 }, (_, i) => ({ name: `bulk-${i}`, status: 'bulk', n: i }));
    const rows = await items().createMany({ data });
    assert.equal(await count(`status = 'bulk'`), 25_000);
    assert.ok(Array.isArray(rows));
    // A duplicate in the LAST chunk rolls every earlier chunk back.
    const bad = Array.from({ length: 25_000 }, (_, i) => ({ name: `bulk2-${i}`, status: 'bulk2', n: i }));
    bad[24_999] = { name: 'bulk-0', status: 'bulk2', n: 0 };
    await assert.rejects(items().createMany({ data: bad }));
    assert.equal(await count(`status = 'bulk2'`), 0);
  });
});
