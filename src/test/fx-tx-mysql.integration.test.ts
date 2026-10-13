/**
 * turbine-orm: the transaction rules that are NOT PostgreSQL's, on a real
 * MySQL server.
 *
 * PostgreSQL refuses every statement after a failed one until a rollback; MySQL
 * undoes only the failed statement and carries on, so the local refusal must
 * stay off there. Nested blocks hand out their own handle on every engine, and
 * the engine's own comment and string grammar decides what counts as
 * transaction-control SQL.
 *
 * Run: MYSQL_URL=mysql://user@host:3306/db npx tsx --test src/test/fx-tx-mysql.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { UniqueConstraintError, ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const { it, before, after } = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

const TABLE = 'fxtx_m_items';

describe('transactions on MySQL: no abort state, own block handles, MySQL lexing (live MySQL)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool shape, loaded dynamically
  let rawPool: any;
  let db: TurbineClient;
  const count = async (where: string): Promise<number> => {
    const [rows] = await rawPool.query(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE ${where}`);
    return Number((rows as { n: number }[])[0]?.n);
  };

  before(async () => {
    const { createPool } = await import('mysql2/promise');
    rawPool = createPool({ uri: MYSQL_URL, namedPlaceholders: true, supportBigNumbers: true, timezone: 'Z' });
    await rawPool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await rawPool.query(
      `CREATE TABLE ${TABLE} (id BIGINT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(64) NOT NULL UNIQUE, n INT NOT NULL DEFAULT 0)`,
    );
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

  const reset = async () => {
    await rawPool.query(`DELETE FROM ${TABLE}`);
    await rawPool.query(`INSERT INTO ${TABLE} (name, n) VALUES ('seed', 10)`);
  };

  it('a statement after a caught failure is sent, and the transaction commits what succeeded', async () => {
    await reset();
    await db.$transaction(async (tx) => {
      await tx.table(TABLE).create({ data: { name: 'before' } });
      await assert.rejects(tx.table(TABLE).create({ data: { name: 'seed' } }), UniqueConstraintError);
      await assert.rejects(tx.rawUnsafe(`SELECT * FROM ${TABLE}_missing`), /fxtx_m_items_missing/);
      // MySQL undoes only the failed statement and has no aborted state: this one is sent and runs.
      await tx.table(TABLE).create({ data: { name: 'after' } });
      assert.equal((await tx.table(TABLE).findMany({})).length, 3);
    });
    assert.equal(await count("name IN ('before', 'after')"), 2, 'no local refusal on an engine that keeps going');
    assert.equal(await count("name = 'seed'"), 1, 'the failed statement left nothing behind');
  });

  it('a nested block that fails is undone alone, and the outer commits', async () => {
    await reset();
    await db.$transaction(async (tx) => {
      await tx.table(TABLE).create({ data: { name: 'outer-1' } });
      await assert.rejects(
        tx.$transaction(async (block) => {
          await block.table(TABLE).create({ data: { name: 'inner' } });
          await block.table(TABLE).create({ data: { name: 'seed' } });
        }),
        UniqueConstraintError,
      );
      await tx.table(TABLE).create({ data: { name: 'outer-2' } });
    });
    assert.equal(await count("name IN ('outer-1', 'outer-2')"), 2);
    assert.equal(await count("name = 'inner'"), 0, 'the block was rolled back to its savepoint');
  });

  it('the outer handle inside an open block is refused, the block handle works', async () => {
    await reset();
    await db.$transaction(async (tx) => {
      await assert.rejects(
        tx.$transaction(async () => {
          await tx.table(TABLE).create({ data: { name: 'through-outer' } });
        }),
        (err: unknown) => err instanceof ValidationError && /outer `tx`/.test(err.message),
      );
      await tx.$transaction(async (block) => {
        await block.table(TABLE).create({ data: { name: 'through-block' } });
      });
    });
    assert.equal(await count("name = 'through-outer'"), 0);
    assert.equal(await count("name = 'through-block'"), 1);
  });

  it('COMMIT, ROLLBACK and SAVEPOINT on a raw path are refused, and the writes still roll back', async () => {
    await reset();
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table(TABLE).create({ data: { name: 'early' } });
        for (const text of ['COMMIT', 'ROLLBACK', 'SAVEPOINT x', 'START TRANSACTION', 'SELECT 1; COMMIT']) {
          await assert.rejects(
            tx.rawUnsafe(text),
            (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
            text,
          );
        }
        await tx.table(TABLE).create({ data: { name: 'late' } });
        throw new Error('the callback fails');
      }),
      /the callback fails/,
    );
    assert.equal(await count("name IN ('early', 'late')"), 0);
  });

  it("MySQL's own comment and string forms hide a statement start the lexer must not see", async () => {
    await reset();
    await db.$transaction(async (tx) => {
      // `#` and `-- ` start a comment on MySQL, so what follows the `;` below is not a statement.
      await tx.rawUnsafe('SELECT 1 # x; COMMIT');
      await tx.rawUnsafe('SELECT 2 -- x; ROLLBACK');
      // A backslash escapes the quote on MySQL, so the string runs on past the `;`.
      await tx.rawUnsafe("SELECT 'a \\' ; COMMIT' AS note");
      await tx.rawUnsafe("SELECT 'it''s ; COMMIT' AS note");
      await tx.table(TABLE).create({ data: { name: 'ran' } });
    });
    assert.equal(await count("name = 'ran'"), 1);
  });
});
