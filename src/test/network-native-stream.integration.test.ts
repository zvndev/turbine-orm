/** Requires disposable live engine databases; driver doubles are tested separately. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { TurbineClient } from '../client.js';
import { TimeoutError, ValidationError } from '../errors.js';
import { mssqlDialect, turbineMssql } from '../mssql.js';
import { mysqlDialect, turbineMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const mysqlUrl = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mssqlUrl = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const engines = [
  {
    name: 'mysql',
    url: mysqlUrl,
    dialect: mysqlDialect,
    gate: skipGate(!mysqlUrl, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server'),
  },
  {
    name: 'mssql',
    url: mssqlUrl,
    dialect: mssqlDialect,
    gate: skipGate(!mssqlUrl, 'requires MSSQL_URL / MSSQL_TEST_URL pointing at a disposable SQL Server 2016+ instance'),
  },
] as const;

interface Row {
  id: number;
  isEnabled: boolean;
  prefs: { id: number };
  huge: string;
  payload: Uint8Array;
}
const total = 2507;

for (const engine of engines) {
  describe(`${engine.name}: live native streaming`, () => {
    const name = `native_stream_${process.pid}_${randomBytes(4).toString('hex')}`;
    const quoted = engine.dialect.quoteIdentifier(name);
    const schema: SchemaMetadata = {
      tables: {
        [name]: mockTable(name, [
          { name: 'id', field: 'id', pgType: 'int' },
          { name: 'is_enabled', field: 'isEnabled', pgType: engine.name === 'mysql' ? 'tinyint(1)' : 'bit' },
          { name: 'prefs', field: 'prefs', pgType: 'json' },
          { name: 'huge', field: 'huge', pgType: 'bigint' },
          { name: 'payload', field: 'payload', pgType: engine.name === 'mysql' ? 'blob' : 'varbinary' },
        ]),
      },
      enums: {},
    };
    let db: TurbineClient | undefined;
    const table = () => db!.table<Row>(name);

    engine.gate.before(async () => {
      db =
        engine.name === 'mysql'
          ? await turbineMysql(engine.url, schema, { logger: {}, connectionLimit: 1, warnOnUnlimited: false })
          : await turbineMssql(engine.url, schema, { logger: {}, warnOnUnlimited: false });
      const flag = engine.name === 'mysql' ? 'TINYINT(1)' : 'BIT';
      const json = engine.name === 'mysql' ? 'JSON' : 'NVARCHAR(MAX)';
      const binary = engine.name === 'mysql' ? 'BLOB' : 'VARBINARY(MAX)';
      await db.rawUnsafe(
        `CREATE TABLE ${quoted} (id INT PRIMARY KEY, is_enabled ${flag} NOT NULL, prefs ${json}, huge BIGINT, payload ${binary})`,
      );
      for (let start = 1; start <= total; start += 200) {
        const params: unknown[] = [];
        const tuples: string[] = [];
        for (let id = start; id <= Math.min(total, start + 199); id++) {
          const offset = params.length;
          params.push(id, id % 2 === 1, JSON.stringify({ id }), 9007199254740993n, Buffer.from([id % 256, 0, 255]));
          tuples.push(`($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`);
        }
        await db.rawUnsafe(
          `INSERT INTO ${quoted} (id, is_enabled, prefs, huge, payload) VALUES ${tuples.join(', ')}`,
          ...params,
        );
      }
    });

    engine.gate.after(async () => {
      if (db) {
        try {
          await db.rawUnsafe(`DROP TABLE ${quoted}`);
        } finally {
          await db.disconnect();
        }
      }
    });

    engine.gate.it(
      'drains actual ordered rows with boolean/JSON/bigint/binary parity and exact cardinality',
      async () => {
        let expected = 1;
        let batches = 0;
        for await (const batch of table().findManyStreamBatches({ orderBy: { id: 'asc' }, batchSize: 1001 })) {
          batches++;
          assert.ok(batch.length > 0 && batch.length <= 1001);
          for (const row of batch) {
            const id = expected++;
            assert.equal(row.id, id);
            assert.equal(row.isEnabled, id % 2 === 1);
            assert.deepEqual(row.prefs, { id });
            assert.equal(row.huge, '9007199254740993');
            assert.deepEqual([...row.payload], [id % 256, 0, 255]);
          }
        }
        assert.equal(expected - 1, total);
        assert.equal(batches, 3);
        assert.equal(Number((await db!.rawUnsafe(`SELECT COUNT(*) AS n FROM ${quoted}`))[0]!.n), total);
      },
    );

    engine.gate.it('early break and consumer failure leave the pool usable', async () => {
      for await (const row of table().findManyStream({ orderBy: { id: 'asc' }, batchSize: 1001 })) {
        assert.equal(row.id, 1);
        break;
      }
      await assert.rejects(async () => {
        for await (const batch of table().findManyStreamBatches({ batchSize: 1001 })) {
          assert.equal(batch.length, 1001);
          throw new Error('consumer failure');
        }
      }, /consumer failure/);
      assert.equal(Number((await db!.rawUnsafe(`SELECT COUNT(*) AS n FROM ${quoted}`))[0]!.n), total);
    });

    engine.gate.it(
      'cancels a pending native read with the original AbortSignal reason',
      { timeout: 5000 },
      async () => {
        const connection = await db!.pool.connect();
        const controller = new AbortController();
        const reason = new Error('cancel pending native request');
        const sql = engine.name === 'mysql' ? 'SELECT SLEEP(10) AS slept' : "WAITFOR DELAY '00:00:10'; SELECT 1 AS id";
        const stream = engine.dialect.openStream(connection, sql, [], 5, { signal: controller.signal });
        const pending = assert.rejects(stream.next(), (error) => error === reason);
        await delay(25);
        controller.abort(reason);
        try {
          await pending;
        } finally {
          await stream.return(undefined);
          connection.release();
        }
        assert.equal((await db!.rawUnsafe('SELECT 19 AS ok'))[0]!.ok, 19);
      },
    );

    engine.gate.it(
      'transaction early break preserves uncommitted effects and an outer failure still rolls them back',
      async () => {
        await assert.rejects(
          db!.$transaction(async (tx) => {
            await tx.rawUnsafe(`UPDATE ${quoted} SET is_enabled=$1 WHERE id=$2`, false, 1);
            const stream = tx.table<Row>(name).findManyStreamBatches({ orderBy: { id: 'asc' }, batchSize: 1001 });
            assert.equal((await stream.next()).value![0]!.isEnabled, false);
            await stream.return(undefined);
            assert.equal(
              (await tx.rawUnsafe(`SELECT is_enabled AS value FROM ${quoted} WHERE id=$1`, 1))[0]!.value,
              false,
            );
            throw new Error('roll back the actual write');
          }),
          /roll back the actual write/,
        );
        assert.equal((await table().findUnique({ where: { id: 1 } }))!.isEnabled, true);
      },
    );

    engine.gate.it('savepoint end closes abandoned native state and late buffered rows refuse', async () => {
      await db!.$transaction(async (tx) => {
        let stream: AsyncGenerator<Row, void, undefined> | undefined;
        await tx.$transaction(async (inner) => {
          stream = inner.table<Row>(name).findManyStream({ batchSize: 1001 });
          await stream.next();
        });
        await assert.rejects(stream!.next(), ValidationError);
        await stream!.return(undefined);
        assert.equal((await tx.rawUnsafe('SELECT 23 AS ok'))[0]!.ok, 23);
      });
    });

    engine.gate.it('idle expiry cancels native state and returns pool capacity', async () => {
      const stream = table().findManyStreamBatches({ batchSize: 1001, idleTimeoutMs: 15 });
      assert.equal((await stream.next()).value!.length, 1001);
      await delay(80);
      await assert.rejects(stream.next(), TimeoutError);
      await stream.return(undefined);
      assert.equal((await db!.rawUnsafe('SELECT 29 AS ok'))[0]!.ok, 29);
    });
  });
}
