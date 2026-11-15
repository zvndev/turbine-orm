/** Native projection and reprepare checks against a disposable MySQL database. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe } from 'node:test';
import { MysqlPool } from '../mysql.js';
import { skipGate } from './helpers.js';

const url = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const native = skipGate(!url, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server');

describe('MySQL native stream projection fidelity', () => {
  native.it(
    'keeps native fields fresh per execution, preserves duplicate names and drains transaction returns',
    { timeout: 10000 },
    async () => {
      const { createPool } = await import('mysql2/promise');
      const u = new URL(url);
      const raw = createPool({
        host: u.hostname,
        port: Number(u.port || 3306),
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database: u.pathname.slice(1),
        namedPlaceholders: true,
        connectionLimit: 1,
        timezone: 'Z',
        supportBigNumbers: true,
        bigNumberStrings: false,
      });
      const pool = new MysqlPool(raw);
      const name = `stream_fields_${process.pid}_${randomBytes(4).toString('hex')}`;
      const quoted = `\`${name}\``;
      const drain = async (sql: string, values: unknown[] = [], size = 31) => {
        const c = await pool.connect();
        const rows: Record<string, unknown>[] = [];
        const stream = c.streamBatches!(sql, values, size);
        try {
          for await (const batch of stream) {
            assert.ok(batch.length > 0 && batch.length <= size);
            rows.push(...batch);
          }
        } finally {
          await stream.return(undefined);
          c.release();
        }
        return rows;
      };
      try {
        await raw.query(`CREATE TABLE ${quoted} (
        id INT PRIMARY KEY, flag TINYINT(1), regular TINYINT,
        huge BIGINT, amount DECIMAL(30,6), payload JSON, stamp DATETIME(3), bytes BLOB, note TEXT
      )`);
        const stamp = new Date('2025-02-03T04:05:06.789Z');
        const total = 257;
        for (let id = 1; id <= total; id++) {
          await raw.execute(`INSERT INTO ${quoted} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id,
            id % 4 === 3 ? null : id % 4,
            id % 2,
            '9007199254740993',
            '12345678901234567890.123456',
            JSON.stringify({ id, text: "quotes'\\ ? :p1 $1 \0 😀" }),
            stamp,
            Buffer.from([0, 255, id % 256]),
            id % 2 ? null : "quotes'\\ ? :p1 $1 \0 😀",
          ]);
        }
        for (const size of [1, 7, 31, 257, 1000]) {
          const sql = `SELECT * FROM ${quoted} ORDER BY id`;
          const rows = await drain(sql, [], size);
          assert.equal(rows.length, total);
          assert.deepEqual(rows, (await pool.query(sql)).rows);
          assert.equal(rows[0]!.flag, true);
          assert.equal(rows[1]!.flag, 2, 'noncanonical boolean values survive');
          assert.equal(rows[2]!.flag, null);
          assert.equal(rows[3]!.flag, false);
          assert.equal(rows[0]!.huge, '9007199254740993');
          assert.equal(rows[0]!.amount, '12345678901234567890.123456');
          assert.deepEqual(rows[0]!.stamp, stamp);
          assert.deepEqual(rows[0]!.bytes, Buffer.from([0, 255, 1]));
        }
        for (const projection of [
          'flag AS renamed, regular AS expression, flag + 0 AS numeric_flag',
          'flag AS collision, regular AS collision',
          'regular AS collision, flag AS collision',
          'flag AS constructor, regular AS toString',
        ]) {
          const sql = `SELECT ${projection} FROM ${quoted} WHERE id > $1 ORDER BY id`;
          const rows = await drain(sql, [0]);
          assert.equal(rows.length, total);
          assert.deepEqual(rows, (await pool.query(sql, [0])).rows);
        }
        assert.deepEqual(await drain(`SELECT * FROM ${quoted} WHERE id < $1`, [0]), []);

        // The exact SQL is reused after DDL. Prepared metadata must come from
        // the current execution, never a SQL- or schema-keyed decoder cache.
        const sameSql = `SELECT flag AS value FROM ${quoted} WHERE id=$1`;
        assert.deepEqual(await drain(sameSql, [1]), [{ value: true }]);
        await raw.query(`ALTER TABLE ${quoted} MODIFY flag TINYINT`);
        assert.deepEqual(await drain(sameSql, [1]), [{ value: 1 }]);
        await raw.query(`ALTER TABLE ${quoted} MODIFY flag TINYINT(1)`);
        assert.deepEqual(await drain(sameSql, [1]), [{ value: true }]);

        const c = await pool.connect();
        try {
          await c.query('START TRANSACTION');
          await c.query(`UPDATE ${quoted} SET flag=$1 WHERE id=$2`, [false, 1]);
          const stream = c.streamBatches!(`SELECT * FROM ${quoted} ORDER BY id`, [], 7);
          assert.equal((await stream.next()).value![0]!.flag, false);
          await stream.return(undefined);
          assert.equal((await c.query(sameSql, [1])).rows[0]!.value, false);
          await c.query('ROLLBACK');
        } finally {
          c.release();
        }
        assert.deepEqual(await drain(sameSql, [1]), [{ value: true }]);
        const c2 = await pool.connect();
        const errorStream = c2.streamBatches!(`SELECT missing FROM ${quoted}`, [], 7);
        try {
          await assert.rejects(errorStream.next(), /Unknown column/);
        } finally {
          await errorStream.return(undefined);
          c2.release();
        }
        assert.equal((await pool.query('SELECT 19 AS ok')).rows[0]!.ok, 19);
        // mysql2 deliberately refuses this projection while constructing its
        // native parser. Callbackless commands receive this on the connection.
        await assert.rejects(
          drain(`SELECT flag AS \`__proto__\` FROM ${quoted} WHERE id > $1`, [0]),
          /private property/,
        );
        assert.equal((await pool.query('SELECT 23 AS ok')).rows[0]!.ok, 23);
      } finally {
        try {
          await raw.query(`DROP TABLE IF EXISTS ${quoted}`);
        } finally {
          await raw.end();
        }
      }
    },
  );
});
