import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MysqlPool } from '../mysql.js';
import { defineMysqlSeed, type MysqlSeedClient, type MysqlSeedTable, runMysqlSeed } from '../mysql-seed.js';
import { skipGate } from './helpers.js';
import { mysqlSeedFixture, mysqlSeedPartialRevokeFixture, mysqlSeedUrl } from './mysql-seed-helpers.js';

const native = skipGate(
  !mysqlSeedUrl,
  'requires MYSQL_URL / MYSQL_TEST_URL pointing at an exclusively owned disposable MySQL 8 server',
);
type Item = { id: number; label: string; n: number };

describe('MySQL DML seed lifecycle', () => {
  it('declares without executing and validates before opening a pool', async () => {
    let calls = 0;
    const fn = () => {
      calls++;
    };
    assert.equal(defineMysqlSeed(fn), fn);
    assert.equal(calls, 0);
    assert.throws(() => defineMysqlSeed(null as never), /callable/);
    await assert.rejects(
      () => runMysqlSeed('mysql://127.0.0.1:1/unused', { tables: {}, enums: {} }, null as never),
      /callable/,
    );
  });

  native.it(
    'commits typed DML, no-op and repeat seeds while preserving a borrowed pool and its SQL mode',
    async (t) => {
      const f = await mysqlSeedFixture(t);
      const mode = (await f.pool.query('SELECT @@sql_mode AS mode'))[0];
      await runMysqlSeed(f.pool, f.schema, () => {});
      const seed = defineMysqlSeed(async (tx) => {
        const items = tx.table<Item>('items');
        await items.upsert({
          where: { id: 1 },
          create: { id: 1, label: "quote'\\; DROP TABLE items; --", n: 3 },
          update: { n: 3 },
        });
        assert.equal((await items.findUnique({ where: { id: 1 } }))!.n, 3);
        assert.equal(await items.count(), 1);
      });
      await runMysqlSeed(f.pool, f.schema, seed);
      await runMysqlSeed(f.pool, f.schema, seed);
      assert.deepEqual(await f.rows(), [{ id: 1, label: "quote'\\; DROP TABLE items; --", n: 3 }]);
      assert.deepEqual((await f.pool.query('SELECT @@sql_mode AS mode'))[0], mode);
      await f.pool.query("INSERT INTO items VALUES (2, 'caller still owns pool', 2)");
      assert.equal(((await f.rows()) as Item[]).length, 2);
    },
  );

  native.it('rolls back preceding writes on callback error while external effects survive', async (t) => {
    const f = await mysqlSeedFixture(t);
    const external: string[] = [];
    await assert.rejects(
      () =>
        runMysqlSeed(f.pool, f.schema, async (tx) => {
          await tx.table<Item>('items').create({ data: { id: 1, label: 'rolled back', n: 2 } });
          await tx.table('children').create({ data: { id: 1, itemId: 1 } });
          external.push('outside transaction');
          throw new Error('callback failed');
        }),
      /callback failed/,
    );
    assert.deepEqual(await f.rows(), []);
    assert.deepEqual((await f.pool.query('SELECT * FROM children'))[0], []);
    assert.deepEqual(external, ['outside transaction']);
    await runMysqlSeed(f.pool, f.schema, async (tx) => {
      await tx.table('items').create({ data: { id: 1, label: 'retry', n: 1 } });
    });
    assert.deepEqual(await f.rows(), [{ id: 1, label: 'retry', n: 1 }]);
  });

  native.it('keeps writes on an explicitly captured separate connection outside the rollback boundary', async (t) => {
    const f = await mysqlSeedFixture(t);
    await assert.rejects(
      () =>
        runMysqlSeed(f.pool, f.schema, async (tx) => {
          await tx.table('items').create({ data: { id: 1, label: 'transaction', n: 1 } });
          await f.pool.execute('INSERT INTO items VALUES (?, ?, ?)', [9, 'external connection', 1]);
          throw new Error('rollback callback only');
        }),
      /rollback callback only/,
    );
    assert.deepEqual(await f.rows(), [{ id: 9, label: 'external connection', n: 1 }]);
  });

  native.it('commits and rolls back typed bulk insert, update and delete effects together', async (t) => {
    const f = await mysqlSeedFixture(t);
    await f.pool.execute('INSERT INTO items VALUES (?, ?, ?), (?, ?, ?)', [1, 'one', 1, 2, 'two', 1]);
    const change = async (tx: MysqlSeedClient) => {
      const items = tx.table<Item>('items');
      await items.update({ where: { id: 1 }, data: { label: 'updated' } });
      await items.delete({ where: { id: 2 } });
      assert.deepEqual(
        await items.createMany({
          data: [
            { id: 3, label: 'three', n: 3 },
            { id: 4, label: 'four', n: 3 },
          ],
          returning: false,
        }),
        { count: 2 },
      );
      await items.updateMany({ where: { n: 3 }, data: { n: { increment: 1 } } });
      await items.deleteMany({ where: { id: 4 } });
      assert.deepEqual(await items.findMany({ orderBy: { id: 'asc' }, limit: 10 }), [
        { id: 1, label: 'updated', n: 1 },
        { id: 3, label: 'three', n: 4 },
      ]);
    };
    await assert.rejects(
      () =>
        runMysqlSeed(f.pool, f.schema, async (tx) => {
          await change(tx);
          throw new Error('bulk rollback');
        }),
      /bulk rollback/,
    );
    assert.deepEqual(await f.rows(), [
      { id: 1, label: 'one', n: 1 },
      { id: 2, label: 'two', n: 1 },
    ]);
    await runMysqlSeed(f.pool, f.schema, change);
    assert.deepEqual(await f.rows(), [
      { id: 1, label: 'updated', n: 1 },
      { id: 3, label: 'three', n: 4 },
    ]);
  });

  native.it('refuses unawaited native work and rolls back its writes', async (t) => {
    const f = await mysqlSeedFixture(t);
    let work: Promise<unknown> | undefined;
    await assert.rejects(
      () =>
        runMysqlSeed(f.pool, f.schema, (tx) => {
          work = tx.table('items').create({ data: { id: 1, label: 'not awaited', n: 1 } });
          void work.catch(() => {});
        }),
      /still running|await|unfinished/i,
    );
    await work?.catch(() => {});
    assert.deepEqual(await f.rows(), []);
  });

  native.it('refuses every raw, DDL, control and accessor escape before an implicit commit', async (t) => {
    const f = await mysqlSeedFixture(t);
    for (const key of [
      'raw',
      'rawUnsafe',
      'sql',
      '$connection',
      'client',
      'pool',
      'schema',
      'disconnect',
      'end',
      'pipeline',
      'transaction',
      'constructor',
    ]) {
      await assert.rejects(
        () =>
          runMysqlSeed(f.pool, f.schema, async (tx) => {
            await tx.table('items').create({ data: { id: 1, label: key, n: 1 } });
            const operation = (tx as unknown as Record<string, (sql: string) => unknown>)[key]!;
            await operation('CREATE TABLE escaped_ddl (id INT)');
          }),
        /MySQL seed handles do not support/,
      );
      assert.deepEqual(await f.rows(), [], key);
    }
    for (const key of [
      'pool',
      'client',
      'schema',
      'buildCreate',
      'findManyStream',
      'explain',
      'constructor',
      '__proto__',
    ]) {
      await assert.rejects(
        () =>
          runMysqlSeed(f.pool, f.schema, async (tx) => {
            const items = tx.table('items');
            assert.equal(Object.getPrototypeOf(items), null);
            assert.equal(Object.isFrozen(items), true);
            await items.create({ data: { id: 1, label: key, n: 1 } });
            Reflect.get(items, key);
          }),
        /MySQL seed handles do not support/,
      );
      assert.deepEqual(await f.rows(), [], key);
    }
    assert.deepEqual((await f.pool.query("SHOW TABLES LIKE 'escaped_ddl'"))[0], []);
  });

  native.it('wraps all nested callbacks and preserves savepoint, outer-handle and settled guards', async (t) => {
    const f = await mysqlSeedFixture(t);
    let escaped!: MysqlSeedClient;
    let inner!: MysqlSeedClient;
    let items!: MysqlSeedTable<Item>;
    await runMysqlSeed(f.pool, f.schema, async (tx) => {
      escaped = tx;
      items = tx.table<Item>('items');
      await items.create({ data: { id: 1, label: 'outer', n: 1 } });
      await assert.rejects(
        () =>
          tx.$transaction(async (nested) => {
            inner = nested;
            await nested.table('items').create({ data: { id: 2, label: 'nested rollback', n: 1 } });
            assert.throws(() => Reflect.get(nested, '$connection'), /do not support/);
            await assert.rejects(() => items.count(), /block|scope|nested/i);
            throw new Error('savepoint failed');
          }),
        /savepoint failed/,
      );
      await assert.rejects(async () => inner.table('items').count(), /closed|rolled.back|scope|block|settled/i);
      assert.equal(
        await tx.$transaction(async (nested) => {
          await nested.table('items').create({ data: { id: 3, label: 'nested commit', n: 1 } });
          return 7;
        }),
        7,
      );
      await assert.rejects(() => tx.$transaction([] as never), /callback/);
      assert.equal(await items.count(), 2);
    });
    await assert.rejects(() => items.create({ data: { id: 4, label: 'escaped', n: 1 } }), /committed|closed|settled/i);
    await assert.rejects(() => escaped.$transaction(async () => {}), /committed|closed|settled/i);
    assert.deepEqual(await f.rows(), [
      { id: 1, label: 'outer', n: 1 },
      { id: 3, label: 'nested commit', n: 1 },
    ]);
  });

  native.it('rolls back actual unique, check and foreign-key failures and remains reusable', async (t) => {
    const f = await mysqlSeedFixture(t);
    for (const kind of ['unique', 'check', 'foreign']) {
      await assert.rejects(
        () =>
          runMysqlSeed(f.pool, f.schema, async (tx) => {
            await tx.table('items').create({ data: { id: 1, label: 'first', n: 1 } });
            if (kind === 'unique') await tx.table('items').create({ data: { id: 2, label: 'first', n: 1 } });
            else if (kind === 'check') await tx.table('items').create({ data: { id: 2, label: 'check', n: 0 } });
            else await tx.table('children').create({ data: { id: 2, itemId: 999 } });
          }),
        /constraint|duplicate|foreign|check/i,
      );
      assert.deepEqual(await f.rows(), [], kind);
    }
    await runMysqlSeed(f.pool, f.schema, () => {});
  });

  native.it('refuses nontransactional tables, triggers and view metadata before invoking the callback', async (t) => {
    const f = await mysqlSeedFixture(t);
    let calls = 0;
    await f.pool.query('CREATE TABLE nontransactional (id INT) ENGINE=MyISAM');
    await assert.rejects(
      () =>
        runMysqlSeed(f.pool, f.schema, () => {
          calls++;
        }),
      /InnoDB/,
    );
    await f.pool.query('DROP TABLE nontransactional');
    await f.pool.query('CREATE TRIGGER items_trigger BEFORE INSERT ON items FOR EACH ROW SET NEW.n = 10');
    await assert.rejects(
      () =>
        runMysqlSeed(f.pool, f.schema, () => {
          calls++;
        }),
      /triggers/,
    );
    await f.pool.query('DROP TRIGGER items_trigger');
    await f.pool.query('CREATE VIEW item_view AS SELECT * FROM items');
    const schema = {
      ...f.schema,
      tables: { ...f.schema.tables, item_view: { ...f.schema.tables.items!, name: 'item_view' } },
    };
    await assert.rejects(
      () =>
        runMysqlSeed(f.pool, schema, () => {
          calls++;
        }),
      /base tables|views/,
    );
    assert.equal(calls, 0);
    assert.deepEqual(await f.rows(), []);
  });

  native.it('refuses a hidden-trigger catalog without a direct TRIGGER grant', async (t) => {
    const f = await mysqlSeedFixture(t);
    const user = `seed_${f.database.slice(-16)}`;
    await f.admin.query(`CREATE USER '${user}'@'%'`);
    t.after(async () => {
      const { createConnection } = await import('mysql2/promise');
      const admin = await createConnection(f.config);
      try {
        await admin.query(`DROP USER '${user}'@'%'`);
      } finally {
        await admin.end();
      }
    });
    await f.admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON \`${f.database}\`.* TO '${user}'@'%'`);
    await f.pool.query('CREATE TRIGGER hidden_trigger BEFORE INSERT ON items FOR EACH ROW SET NEW.n = 10');
    const { createPool } = await import('mysql2/promise');
    const pool = createPool({ ...f.config, user, password: '', database: f.database, namedPlaceholders: true });
    try {
      assert.deepEqual(
        (await pool.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()'))[0],
        [],
      );
      let called = false;
      await assert.rejects(
        () =>
          runMysqlSeed(pool, f.schema, () => {
            called = true;
          }),
        /TRIGGER privilege/,
      );
      assert.equal(called, false);
      assert.deepEqual(await f.rows(), []);
      await f.pool.query('DROP TRIGGER hidden_trigger');
      await f.admin.query(`GRANT TRIGGER ON \`${f.database}\`.* TO '${user}'@'%'`);
      await runMysqlSeed(pool, f.schema, async (tx) => {
        await tx.table('items').create({ data: { id: 1, label: 'direct database grant', n: 1 } });
      });
      assert.deepEqual(await f.rows(), [{ id: 1, label: 'direct database grant', n: 1 }]);
    } finally {
      await pool.end();
    }
  });

  native.it('refuses partial revokes before a hidden trigger can escape rollback', async (t) => {
    const f = await mysqlSeedPartialRevokeFixture(t);
    assert.deepEqual(
      (
        await f.limited.query('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()')
      )[0],
      [],
    );
    const [grants] = await f.limited.query('SHOW GRANTS');
    assert.match(JSON.stringify(grants), /GRANT TRIGGER ON \*\.\*/);
    assert.match(JSON.stringify(grants), /REVOKE TRIGGER/);
    let called = false;
    await assert.rejects(
      () =>
        runMysqlSeed(f.limited, f.schema, async (tx) => {
          called = true;
          await tx.table('items').create({ data: { id: 41, label: 'must never execute', n: 1 } });
          throw new Error('callback failure');
        }),
      /partial revokes/,
    );
    assert.equal(called, false);
    assert.deepEqual(await f.rows(), []);
    assert.deepEqual(await f.effects(), []);
  });

  native.it('refuses an existing transaction without committing, rolling back or closing its pool', async (t) => {
    const f = await mysqlSeedFixture(t);
    const connection = await f.pool.getConnection();
    let releases = 0;
    const borrowed = {
      query: connection.query.bind(connection),
      execute: connection.execute.bind(connection),
      async getConnection() {
        return {
          query: connection.query.bind(connection),
          execute: connection.execute.bind(connection),
          release() {
            releases++;
          },
        };
      },
      async end() {
        assert.fail('borrowed pool closed');
      },
    };
    try {
      await connection.beginTransaction();
      await connection.query("INSERT INTO items VALUES (1, 'caller pending', 1)");
      let called = false;
      await assert.rejects(
        () =>
          runMysqlSeed(borrowed, f.schema, () => {
            called = true;
          }),
        /idle autocommit|caller-owned transaction/,
      );
      assert.equal(called, false);
      assert.equal(releases, 1);
      assert.deepEqual(await f.rows(), []);
      assert.deepEqual((await connection.query('SELECT id FROM items'))[0], [{ id: 1 }]);
      await connection.rollback();
      assert.deepEqual((await connection.query('SELECT id FROM items'))[0], []);
      await assert.rejects(() => runMysqlSeed(new MysqlPool(f.pool) as never, f.schema, () => {}), /not a MysqlPool/);
    } finally {
      connection.release();
    }
  });

  native.it('closes an owned pool after success, callback failure and catalog refusal', async (t) => {
    const f = await mysqlSeedFixture(t);
    const close = MysqlPool.prototype.end;
    const closed: MysqlPool[] = [];
    MysqlPool.prototype.end = async function () {
      closed.push(this);
      await close.call(this);
    };
    try {
      await runMysqlSeed(f.url, f.schema, async (tx) => {
        await tx.table('items').create({ data: { id: 1, label: 'owned', n: 1 } });
      });
      await assert.rejects(
        () =>
          runMysqlSeed(f.url, f.schema, async (tx) => {
            await tx.table('items').create({ data: { id: 2, label: 'rolled back', n: 1 } });
            throw new Error('owned failure');
          }),
        /owned failure/,
      );
      await f.pool.query('CREATE TABLE refused (id INT) ENGINE=MyISAM');
      await assert.rejects(() => runMysqlSeed(f.url, f.schema, () => {}), /InnoDB/);
      assert.equal(closed.length, 3);
      for (const pool of closed) await assert.rejects(() => pool.query('SELECT 1'), /closed|ended/i);
      assert.deepEqual(await f.rows(), [{ id: 1, label: 'owned', n: 1 }]);
    } finally {
      MysqlPool.prototype.end = close;
    }
  });
});
