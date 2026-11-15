import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { UniqueConstraintError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { introspectMysqlWith, MysqlPool, mysqlDialect, turbineMysql } from '../mysql.js';
import { jsonValue } from '../query/json-value.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    bulk_count: mockTable(
      'bulk_count',
      [
        { name: 'k', field: 'k', pgType: 'varchar' },
        { name: 'n', field: 'n', pgType: 'int' },
      ],
      {},
      ['k'],
    ),
  },
};

function recordingClient() {
  const calls: { sql: string; values: unknown }[] = [];
  const run = async (sql: string, values?: unknown): Promise<[unknown, unknown]> => {
    calls.push({ sql, values });
    // Deliberately differs from input length: counts must come from the driver.
    return [{ affectedRows: 7 }, []];
  };
  const pool = new MysqlPool({
    query: run,
    execute: run,
    getConnection: async () => ({ query: run, execute: run, release() {} }),
    async end() {},
  });
  const db = new TurbineClient({ pool, dialect: mysqlDialect, preparedStatements: false }, schema);
  return { db, pool, calls, table: db.table('bulk_count') };
}

describe('MySQL bulk INSERT prepared binding', () => {
  it('keeps named public SQL and binds generated cells positionally, using the affected-row count', async () => {
    const { table, calls } = recordingClient();
    const data = [
      { n: 10, k: "a'\\? :p1 $2" },
      { k: 'b', n: 20 },
    ];
    const built = table.buildCreateMany({ data, returning: false });
    assert.equal(built.sql, 'INSERT INTO `bulk_count` (`k`, `n`) VALUES (:p1, :p2), (:p3, :p4)');
    assert.deepEqual(await table.createMany({ data, returning: false }), { count: 7 });
    assert.deepEqual(calls, [
      {
        sql: 'INSERT INTO `bulk_count` (`k`, `n`) VALUES (?, ?), (?, ?)',
        values: [data[0]!.k, 10, 'b', 20],
      },
    ]);
    assert.deepEqual(await table.createMany({ data: [{ k: 'c', n: 30 }] }), []);
    assert.deepEqual(calls[1]!.values, ['c', 30]);
  });

  it('reuses only arity templates, with fresh values across widths, counts and cache eviction', async () => {
    const { table, calls } = recordingClient();
    for (let count = 1; count <= 12; count++) {
      const data = Array.from({ length: count }, (_, i) => ({ k: `a${count}:${i}`, n: i }));
      await table.createMany({ data, returning: false });
      assert.deepEqual(
        calls.at(-1)!.values,
        data.flatMap((r) => [r.k, r.n]),
      );
      assert.equal(calls.at(-1)!.sql.match(/\?/g)!.length, count * 2);
    }
    await table.createMany({ data: [{ k: 'fresh' }], returning: false });
    assert.deepEqual(calls.at(-1)!.values, ['fresh']);
  });

  it('preserves dialect placeholder overrides and exact irregular tuple output', () => {
    const custom = { ...mysqlDialect, paramPlaceholder: (n: number) => `:custom${n}` };
    const input = { table: '`t?:p1`', columns: ['`a`', '`b`'], columnArrayTypes: [], rowValues: [[1, 2], [3]] };
    const built = custom.buildBulkInsertStatement(input);
    assert.equal(built.sql, 'INSERT INTO `t?:p1` (`a`, `b`) VALUES (:custom1, :custom2), (:custom3)');
    assert.deepEqual(built.params, [1, 2, 3]);
    assert.equal(
      mysqlDialect.buildBulkInsertStatement(input).sql,
      'INSERT INTO `t?:p1` (`a`, `b`) VALUES (:p1, :p2), (:p3)',
    );
    const original = mysqlDialect.paramPlaceholder;
    try {
      mysqlDialect.paramPlaceholder = custom.paramPlaceholder;
      assert.equal(mysqlDialect.buildBulkInsertStatement(input).sql, built.sql);
    } finally {
      mysqlDialect.paramPlaceholder = original;
    }
  });

  it('copies and edited statements fall back to named binding; changed values are never cached', async () => {
    const { table, pool, calls } = recordingClient();
    const built = table.buildCreateMany({ data: [{ k: 'a', n: 1 }], returning: false });
    await pool.query(built.sql, [...built.params]);
    assert.deepEqual(calls.at(-1), { sql: built.sql, values: { p1: 'a', p2: 1 } });
    await pool.query(`${built.sql} /* comment */`, built.params);
    assert.deepEqual(calls.at(-1)!.values, { p1: 'a', p2: 1 });
    built.params[0] = 'changed';
    await pool.query(built.sql, built.params);
    assert.deepEqual(calls.at(-1)!.values, ['changed', 1]);
    built.params.push(9);
    await pool.query(built.sql, built.params);
    assert.deepEqual(calls.at(-1)!.values, { p1: 'changed', p2: 1, p3: 9 });
  });

  it('coerces and validates parameters on every execution before calling the driver', async () => {
    const { table, pool, calls } = recordingClient();
    const built = table.buildCreateMany({ data: [{ k: 'a', n: 1 }], returning: false });
    for (const bad of [NaN, Infinity, -Infinity, new Date(NaN)]) {
      built.params[1] = bad;
      await assert.rejects(pool.query(built.sql, built.params), ValidationError);
    }
    assert.equal(calls.length, 0);
    built.params[1] = true;
    await pool.query(built.sql, built.params);
    assert.deepEqual(calls.at(-1)!.values, ['a', 1]);
    built.params[1] = mysqlDialect.inClauseParam!([1, 2]);
    await pool.query(built.sql, built.params);
    assert.deepEqual(calls.at(-1)!.values, { p1: 'a', p2_0: 1, p2_1: 2 });
  });

  it('coerces deleted generated parameter slots to NULL like the established binder', async () => {
    const { table, pool, calls } = recordingClient();
    const built = table.buildCreateMany({ data: [{ k: 'hole', n: 1 }], returning: false });
    delete built.params[1];
    await pool.query(built.sql, built.params);
    assert.deepEqual(calls.at(-1)!.values, ['hole', null]);
    await pool.query(built.sql, built.params.slice());
    assert.deepEqual(calls.at(-1)!.values, { p1: 'hole', p2: null });
    built.params[1] = undefined;
    await pool.query(built.sql, built.params);
    assert.deepEqual(calls.at(-1)!.values, ['hole', null]);
  });

  it('preserves skipDuplicates SQL and count refusal, and leaves ordinary named statements alone', async () => {
    const { table, pool, calls } = recordingClient();
    await table.createMany({ data: [{ k: 'a', n: 1 }], skipDuplicates: true });
    assert.match(calls.at(-1)!.sql, /VALUES \(\?, \?\) ON DUPLICATE KEY UPDATE `k` = `k`$/);
    await assert.rejects(
      table.createMany({ data: [{ k: 'a' }], skipDuplicates: true, returning: false }),
      UnsupportedFeatureError,
    );
    await pool.query('SELECT :p2, :p1, :p2', [1, 2]);
    assert.deepEqual(calls.at(-1)!.values, { p1: 1, p2: 2 });
    await assert.rejects(pool.query('SELECT ?', [1]), ValidationError);
  });

  it('keeps the 65,535-placeholder boundary and chunks one row over it in one transaction', async () => {
    const { table, calls } = recordingClient();
    const data = Array.from({ length: 32768 }, (_, i) => ({ k: `k${i}`, n: i }));
    assert.throws(() => table.buildCreateMany({ data, returning: false }), /over the mysql limit of 65535/);
    assert.deepEqual(await table.createMany({ data, returning: false }), { count: 14 });
    assert.deepEqual(
      calls.map((c) => (Array.isArray(c.values) ? c.values.length : c.sql)),
      ['START TRANSACTION', 65534, 2, 'COMMIT'],
    );
    assert.deepEqual(calls[2]!.values as unknown[], ['k32767', 32767]);
  });
});

const url = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL;
const native = skipGate(!url, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

describe('MySQL bulk count native fidelity and atomicity', () => {
  native.it('preserves binary-protocol values, defaults, errors, chunk rollback and transaction scope', async () => {
    const { createPool } = await import('mysql2/promise');
    const u = new URL(url!);
    const raw = createPool({
      host: u.hostname,
      port: Number(u.port || 3306),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.slice(1),
      namedPlaceholders: true,
      timezone: 'Z',
      supportBigNumbers: true,
      bigNumberStrings: false,
    });
    const pool = new MysqlPool(raw);
    try {
      await raw.query('DROP TABLE IF EXISTS bulk_count_native, bulk_count_chunk');
      await raw.query(`CREATE TABLE bulk_count_native (
        k VARCHAR(100) PRIMARY KEY, n BIGINT, active BOOLEAN, payload JSON, day DATE,
        stamp DATETIME(3), bytes BLOB, note VARCHAR(100) DEFAULT 'untouched'
      )`);
      await raw.query('CREATE TABLE bulk_count_chunk (k VARCHAR(50) PRIMARY KEY, n INT NOT NULL)');
      const meta = await introspectMysqlWith(
        async (sql, values) => (await pool.query(sql, values)).rows,
        u.pathname.slice(1),
        { include: ['bulk_count_native', 'bulk_count_chunk'] },
      );
      const db = await turbineMysql(pool, meta);
      const table = db.table('bulk_count_native');
      const sparse = table.buildCreateMany({ data: [{ k: 'deleted-slot', n: 1 }], returning: false });
      assert.deepEqual(sparse.params, ['deleted-slot', 1]);
      delete sparse.params[1];
      await pool.query(sparse.sql, sparse.params);
      assert.equal((await table.findUnique({ where: { k: 'deleted-slot' } }))!.n, null);
      await raw.execute('DELETE FROM bulk_count_native WHERE k = ?', ['deleted-slot']);
      const stamp = new Date('2025-02-03T04:05:06.789Z');
      const key = "quotes'\\ ? :p1 $1 \u0000 😀";
      const bytes = Buffer.from([0, 39, 92, 255]);
      const data = [
        {
          k: key,
          n: 9007199254740993n,
          active: true,
          payload: { text: key, list: [1, null] },
          day: stamp,
          stamp,
          bytes,
        },
        { k: 'null', n: null, active: false, payload: jsonValue(null), day: null, stamp: null, bytes: null },
      ];
      assert.deepEqual(await table.createMany({ data, returning: false }), { count: 2 });
      const [stored] = await raw.query('SELECT * FROM bulk_count_native ORDER BY k');
      const rows = stored as Record<string, unknown>[];
      assert.equal(rows.length, 2);
      const value = rows.find((r) => r.k === key)!;
      assert.ok(value);
      assert.equal(value.n, '9007199254740993');
      assert.equal(value.active, 1);
      assert.deepEqual(value.payload, { text: key, list: [1, null] });
      assert.equal((value.day as Date).toISOString(), '2025-02-03T00:00:00.000Z');
      assert.equal((value.stamp as Date).toISOString(), stamp.toISOString());
      assert.deepEqual(value.bytes, bytes);
      assert.equal(value.note, 'untouched');
      assert.equal(rows.find((r) => r.k === 'null')!.payload, null);
      assert.deepEqual(await table.createMany({ data: [], returning: false }), { count: 0 });
      assert.deepEqual(await table.createMany({ data: [{ k: 'default', note: undefined }], returning: false }), {
        count: 1,
      });
      assert.deepEqual(await table.createMany({ data: [{ k: 'explicit-null', note: null }], returning: false }), {
        count: 1,
      });
      assert.equal((await table.findUnique({ where: { k: 'default' } }))!.note, 'untouched');
      assert.equal((await table.findUnique({ where: { k: 'explicit-null' } }))!.note, null);
      await assert.rejects(
        table.createMany({ data: [{ k: 'new-before-error' }, { k: key }], returning: false }),
        UniqueConstraintError,
      );
      assert.equal(await table.count(), 4, 'a failed statement writes no prefix');
      await assert.rejects(
        table.createMany({ data: [{ k: 'bad-json', payload: '{' }], returning: false }),
        ValidationError,
      );
      await assert.rejects(
        table.createMany({ data: [{ k: 'bad-number', n: NaN }], returning: false }),
        ValidationError,
      );
      await assert.rejects(
        table.createMany({ data: [{ k: 'mismatch' }, { k: 'mismatch2', n: 1 }], returning: false }),
        ValidationError,
      );
      assert.equal(await table.count(), 4);

      const chunk = db.table('bulk_count_chunk');
      const many = Array.from({ length: 32768 }, (_, i) => ({ k: `k${i}`, n: i }));
      assert.deepEqual(await chunk.createMany({ data: many, returning: false }), { count: many.length });
      assert.equal(await chunk.count(), many.length);
      await raw.query('DELETE FROM bulk_count_chunk');
      const duplicate = [...many.slice(0, -1), { k: 'k0', n: 1 }];
      await assert.rejects(chunk.createMany({ data: duplicate, returning: false }), UniqueConstraintError);
      assert.equal(await chunk.count(), 0, 'second-chunk error rolls back the first');
      const invalid = [...many.slice(0, -1), { k: 'bad-tail', n: NaN }];
      await assert.rejects(chunk.createMany({ data: invalid, returning: false }), ValidationError);
      assert.equal(await chunk.count(), 0, 'second-chunk binding error rolls back the first');
      await assert.rejects(
        db.$transaction(async (tx) => {
          assert.deepEqual(await tx.table('bulk_count_chunk').createMany({ data: many, returning: false }), {
            count: many.length,
          });
          throw new Error('rollback bulk');
        }),
        /rollback bulk/,
      );
      assert.equal(await chunk.count(), 0);
      await db.$transaction(async (tx) => {
        assert.deepEqual(
          await tx.table('bulk_count_chunk').createMany({ data: [{ k: 'committed', n: 1 }], returning: false }),
          { count: 1 },
        );
      });
      assert.equal(await chunk.count(), 1);
      await db.disconnect();
    } finally {
      try {
        await raw.query('DROP TABLE IF EXISTS bulk_count_native, bulk_count_chunk');
      } finally {
        await raw.end();
      }
    }
  });
});
