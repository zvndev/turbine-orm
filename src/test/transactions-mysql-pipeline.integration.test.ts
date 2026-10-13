/**
 * turbine-orm: `pipeline()` on an engine without RETURNING (MySQL).
 *
 * A MySQL write is a deferred query with a `reselect` plan: run the write,
 * then fetch the row it wrote. `$transaction([...])` ran that plan, but the
 * pipeline's sequential path sent the bare write and handed its row-less
 * result to the transform, so a pipelined `create` or `update` failed as "not
 * found" after the write had happened. The pipeline now runs the plan, and a
 * transform that rejects its result rolls the batch back, as on Postgres.
 *
 * Run: MYSQL_URL=mysql://user@host:3306/db npx tsx --test src/test/transactions-mysql-pipeline.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { NotFoundError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const { it, before, after } = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const TABLE = 'tx90m_items';

describe('transactions: pipeline on MySQL runs reselect plans (live MySQL)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool shape, loaded dynamically
  let rawPool: any;
  let db: TurbineClient;
  const count = async (where: string): Promise<number> => {
    const [rows] = await rawPool.query(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE ${where}`);
    return Number((rows as { n: number }[])[0]!.n);
  };

  before(async () => {
    const { createPool } = await import('mysql2/promise');
    rawPool = createPool({ uri: MYSQL_URL, namedPlaceholders: true, supportBigNumbers: true, timezone: 'Z' });
    await rawPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await rawPool.query(
      `CREATE TABLE ${TABLE} (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL UNIQUE, n INT NOT NULL DEFAULT 0)`,
    );
    await rawPool.query(`INSERT INTO ${TABLE} (name, n) VALUES ('seed', 10)`);
    const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
    const pool = new MysqlPool(rawPool);
    const dbName = new URL(MYSQL_URL).pathname.replace(/^\//, '');
    const schema: SchemaMetadata = await introspectMysqlWith(
      async (sql, params) => (await pool.query(sql, params)).rows,
      dbName,
    );
    db = (await turbineMysql(pool, schema)) as unknown as TurbineClient;
  });
  after(async () => {
    if (!rawPool) return;
    await rawPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await rawPool.end();
  });

  it('a pipelined create and update return their rows, like $transaction([...])', async () => {
    const items = db.table<{ id: number; name: string; n: number }>(TABLE);
    const [created, updated] = await db.pipeline([
      items.buildCreate({ data: { name: 'piped' } }),
      items.buildUpdate({ where: { name: 'seed' }, data: { n: { increment: 1 } } }),
    ]);
    assert.equal((created as { name: string }).name, 'piped');
    assert.equal((updated as { n: number }).n, 11);
    const [again] = await db.$transaction([items.buildCreate({ data: { name: 'batched' } })]);
    assert.equal((again as { name: string }).name, 'batched');
  });

  it('a transform that rejects its result rolls the batch back', async () => {
    const items = db.table(TABLE);
    await assert.rejects(
      db.pipeline([
        items.buildCreate({ data: { name: 'rolled-back' } }),
        items.buildUpdate({ where: { id: 999 }, data: { n: 1 } }),
      ]),
      NotFoundError,
    );
    assert.equal(await count("name = 'rolled-back'"), 0);
  });
});
