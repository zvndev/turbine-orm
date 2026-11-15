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

  it('a timed-out write never commits, claims no rollback, and its connection never returns to the pool mid-transaction', async () => {
    const row = await items().create({ data: { name: 'locked', n: 0 } });
    // A second session holds the row lock, so the update waits and times out.
    const blocker = await rawPool.getConnection();
    try {
      await blocker.query('START TRANSACTION');
      await blocker.query(`SELECT * FROM ${TABLE} WHERE id = ? FOR UPDATE`, [row.id]);
      // mysql2 cannot cancel the waiting UPDATE, so no rollback is confirmed
      // when the call rejects: COMMIT was never sent, and the connection is
      // discarded rather than reused.
      await assert.rejects(
        items().update({ where: { id: row.id }, data: { n: 99 }, timeout: 300 }),
        (err: unknown) =>
          err instanceof TimeoutError &&
          err.outcome === 'unknown' &&
          /COMMIT was never sent/.test(err.message) &&
          !/was rolled back/.test(err.message),
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

  it('a COMMIT the server applied but whose answer was lost on the network is TransactionOutcomeUnknownError', async () => {
    const net = await import('node:net');
    const { createPool } = await import('mysql2/promise');
    const { MysqlPool, turbineMysql } = await import('../mysql.js');
    const { TransactionOutcomeUnknownError } = await import('../errors.js');
    const url = new URL(MYSQL_URL);
    // A TCP proxy in front of the real server: it forwards everything, but once
    // the client sends COMMIT it stops passing the server's bytes back and then
    // closes the client's socket. The server commits; the driver hears nothing.
    const statements: string[] = [];
    const proxy = net.createServer((client) => {
      const server = net.connect({ host: url.hostname, port: Number(url.port || 3306) });
      let deaf = false;
      client.on('data', (chunk: Buffer) => {
        // COM_QUERY: a 4-byte packet header, command byte 0x03, then (with query
        // attributes, MySQL 8.0.23+) two count bytes before the text.
        if (chunk.length > 5 && chunk[4] === 0x03) {
          const text = chunk.subarray(5).toString('utf8');
          const sql = text.slice(text.search(/[A-Za-z]/));
          statements.push(sql);
          if (sql === 'COMMIT') {
            deaf = true;
            setTimeout(() => client.destroy(), 300);
          }
        }
        server.write(chunk);
      });
      server.on('data', (chunk: Buffer) => {
        if (!deaf) client.write(chunk);
      });
      client.on('close', () => server.end());
      server.on('close', () => client.destroy());
      client.on('error', () => {});
      server.on('error', () => {});
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const raw = createPool({
      host: '127.0.0.1',
      port: (proxy.address() as { port: number }).port,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: DATABASE,
      namedPlaceholders: true,
      supportBigNumbers: true,
      timezone: 'Z',
      connectionLimit: 2,
    });
    try {
      const logs: string[] = [];
      const local = (await turbineMysql(new MysqlPool(raw), db.schema, {
        logging: true,
        logger: { debug: (_message, entry) => logs.push(entry.code) },
      })) as unknown as TurbineClient;
      // The caller's transaction, then a write Turbine runs in a transaction of its own.
      const outcomes = [
        await local
          .$transaction((tx) => tx.table<Item>(TABLE).create({ data: { name: 'lost-commit-tx' } }))
          .catch((err: unknown) => err),
        await local
          .table<Item>(TABLE)
          .create({ data: { name: 'lost-commit-implicit' } })
          .catch((err: unknown) => err),
      ];
      for (const outcome of outcomes) {
        assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
        assert.ok(outcome.cause instanceof Error, 'the driver error is the cause');
      }
      // No ROLLBACK after a COMMIT: it could not tell a commit from a rollback.
      assert.ok(!statements.includes('ROLLBACK'), statements.join(' | '));
      assert.equal(logs.filter((code) => code === 'transaction-outcome-unknown').length, 1, logs.join(', '));
      assert.ok(!logs.includes('transaction-rolled-back'), logs.join(', '));
      // The truth: the server committed both.
      assert.equal(await count(`name IN ('lost-commit-tx', 'lost-commit-implicit')`), 2);
    } finally {
      await raw.end().catch(() => {});
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("a nested write's timeout bounds the whole call: it never commits past it, and claims no rollback", async () => {
    await rawPool.query('DROP TABLE IF EXISTS bt_child');
    await rawPool.query('DROP TABLE IF EXISTS bt_parent');
    await rawPool.query('CREATE TABLE bt_parent (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL UNIQUE)');
    await rawPool.query(
      'CREATE TABLE bt_child (id INT AUTO_INCREMENT PRIMARY KEY, parent_id INT NOT NULL, ' +
        'title VARCHAR(60) NOT NULL UNIQUE, FOREIGN KEY (parent_id) REFERENCES bt_parent(id))',
    );
    // A child titled `slow...` takes 600 ms to insert: the nested write's last statement.
    await rawPool.query(
      "CREATE TRIGGER bt_child_slow BEFORE INSERT ON bt_child FOR EACH ROW DO IF(NEW.title LIKE 'slow%', SLEEP(0.6), 0)",
    );
    try {
      const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
      const pool = new MysqlPool(rawPool);
      const schema = await introspectMysqlWith(async (sql, params) => (await pool.query(sql, params)).rows, DATABASE, {
        include: ['bt_parent', 'bt_child'],
      });
      const relation = Object.entries(schema.tables.bt_child!.relations).find(([, r]) => r.type === 'belongsTo')![0];
      const local = (await turbineMysql(pool, schema)) as unknown as TurbineClient;
      const saved = async (name: string) => {
        const [rows] = await rawPool.query('SELECT COUNT(*) AS n FROM bt_parent WHERE name = ?', [name]);
        return Number((rows as { n: number }[])[0]!.n);
      };
      const start = performance.now();
      const outcome = await local
        .table('bt_child')
        .create({ data: { title: 'slow-1', [relation]: { create: { name: 'timed-out' } } }, timeout: 150 })
        .catch((err: unknown) => err);
      const elapsed = performance.now() - start;
      assert.ok(outcome instanceof TimeoutError, `got ${String(outcome)}`);
      assert.ok(elapsed < 550, `the call ran ${Math.round(elapsed)} ms past a 150 ms timeout`);
      // mysql2 cannot cancel the running INSERT, so no rollback is confirmed: COMMIT was never sent.
      assert.equal(outcome.outcome, 'unknown');
      assert.match(outcome.message, /COMMIT was never sent/);
      assert.doesNotMatch(outcome.message, /was rolled back/);
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(await saved('timed-out'), 0, 'the timed-out nested write committed');
      // Control: without a timeout it waits for the slow INSERT and commits.
      await local.table('bt_child').create({ data: { title: 'slow-2', [relation]: { create: { name: 'waited' } } } });
      assert.equal(await saved('waited'), 1);
    } finally {
      await rawPool.query('DROP TABLE IF EXISTS bt_child');
      await rawPool.query('DROP TABLE IF EXISTS bt_parent');
    }
  });

  it("createMany in a caller's transaction whose deadline passes between chunks: unknown until its savepoint rollback is confirmed", async () => {
    const { MysqlPool, turbineMysql } = await import('../mysql.js');
    for (const refuseRollbackTo of [true, false]) {
      // The client's own pool, its checkouts refusing ROLLBACK TO before it is sent.
      const pool = new MysqlPool(rawPool);
      const connect = pool.connect.bind(pool);
      pool.connect = async () => {
        const client = await connect();
        const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = (text: unknown, values?: unknown) => {
          const sql = typeof text === 'string' ? text : (text as { text: string }).text;
          if (refuseRollbackTo && sql.startsWith('ROLLBACK TO'))
            return Promise.reject(new Error('injected: ROLLBACK TO refused before dispatch'));
          return query(text, values);
        };
        return client;
      };
      const local = (await turbineMysql(pool, db.schema)) as unknown as TurbineClient;
      // 25,000 rows bind past MySQL's limit, so they take two INSERTs. The first
      // one's query event holds the thread past the write's deadline.
      let held = false;
      local.$on('query', (e) => {
        if (held || !e.sql.startsWith('INSERT')) return;
        held = true;
        const start = performance.now();
        while (performance.now() - start < 1800) {}
      });
      const status = refuseRollbackTo ? 'dl-refused' : 'dl-acked';
      const data = Array.from({ length: 25_000 }, (_, i) => ({ name: `${status}-${i}`, status, n: i }));
      let blockError: unknown;
      let inside = -1;
      const outcome = await local
        .$transaction(async (tx) => {
          blockError = await tx
            .table<Item>(TABLE)
            .createMany({ data, timeout: 1500 })
            .catch((err: unknown) => err);
          const [row] = await tx.rawUnsafe<{ n: number }>(
            `SELECT COUNT(*) AS n FROM ${TABLE} WHERE status = '${status}'`,
          );
          inside = Number(row!.n);
          return 'returned';
        })
        .catch((err: unknown) => err);
      assert.ok(blockError instanceof TimeoutError, `got ${String(blockError)}`);
      if (refuseRollbackTo) {
        // The first chunk is still in the transaction: the write is not reported as having made no change.
        assert.ok(inside > 0, `inside the transaction: ${inside}`);
        assert.equal(blockError.outcome, 'unknown');
        assert.equal((outcome as { code?: string }).code, 'TURBINE_E019');
      } else {
        assert.equal(inside, 0);
        assert.equal(blockError.outcome, 'not-executed');
        assert.equal(outcome, 'returned');
      }
      assert.equal(await count(`status = '${status}'`), 0);
    }
  });

  it("a nested write in a caller's transaction whose statement outlives its deadline: the error says what the savepoint rollback did", async () => {
    await rawPool.query('DROP TABLE IF EXISTS bt_child');
    await rawPool.query('DROP TABLE IF EXISTS bt_parent');
    await rawPool.query('CREATE TABLE bt_parent (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL UNIQUE)');
    await rawPool.query(
      'CREATE TABLE bt_child (id INT AUTO_INCREMENT PRIMARY KEY, parent_id INT NOT NULL, ' +
        'title VARCHAR(60) NOT NULL UNIQUE, FOREIGN KEY (parent_id) REFERENCES bt_parent(id))',
    );
    // A child titled `slow...` takes 350 ms to insert, well past the call's 80 ms.
    await rawPool.query(
      "CREATE TRIGGER bt_child_slow BEFORE INSERT ON bt_child FOR EACH ROW DO IF(NEW.title LIKE 'slow%', SLEEP(0.35), 0)",
    );
    try {
      const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
      for (const refuseRollbackTo of [false, true]) {
        const pool = new MysqlPool(rawPool);
        const connect = pool.connect.bind(pool);
        pool.connect = async () => {
          const client = await connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = (text: unknown, values?: unknown) => {
            const sql = typeof text === 'string' ? text : (text as { text: string }).text;
            if (refuseRollbackTo && sql.startsWith('ROLLBACK TO'))
              return Promise.reject(new Error('injected: ROLLBACK TO refused before dispatch'));
            return query(text, values);
          };
          return client;
        };
        const schema = await introspectMysqlWith(
          async (sql, params) => (await pool.query(sql, params)).rows,
          DATABASE,
          {
            include: ['bt_parent', 'bt_child'],
          },
        );
        const relation = Object.entries(schema.tables.bt_child!.relations).find(([, r]) => r.type === 'belongsTo')![0];
        const local = (await turbineMysql(pool, schema)) as unknown as TurbineClient;
        const tag = refuseRollbackTo ? 'refused' : 'acked';
        let caught: unknown;
        let elapsed = 0;
        let inside = -1;
        const outcome = await local
          .$transaction(async (tx) => {
            const start = performance.now();
            caught = await tx
              .table('bt_child')
              .create({
                data: { title: `slow-${tag}`, [relation]: { create: { name: `undone-${tag}` } } },
                timeout: 80,
              })
              .catch((err: unknown) => err);
            elapsed = performance.now() - start;
            if (refuseRollbackTo) return 'returned';
            const [row] = await tx.rawUnsafe<{ n: number }>(
              `SELECT COUNT(*) AS n FROM bt_parent WHERE name = 'undone-${tag}'`,
            );
            inside = Number(row!.n);
            await tx.table('bt_parent').create({ data: { name: `after-${tag}` } });
            return 'committed';
          })
          .catch((err: unknown) => err);
        assert.ok(caught instanceof TimeoutError, `got ${String(caught)}`);
        // mysql2 cannot cancel the INSERT; nothing may say it can still complete once a rollback answered.
        assert.match(caught.message, /could not be cancelled on the server\./);
        assert.doesNotMatch(caught.message, /may still complete/);
        if (refuseRollbackTo) {
          assert.equal(caught.outcome, 'unknown');
          assert.match(caught.message, /A savepoint rollback was not acknowledged; the transaction cannot commit\./);
          // The INSERT is still running, so the callback's return is refused too: nothing commits.
          assert.ok(outcome instanceof Error && /cannot commit/.test(outcome.message), String(outcome));
        } else {
          // The ROLLBACK TO waited for the INSERT to end, then undid it with the parent.
          assert.ok(elapsed > 300, `delivered after ${Math.round(elapsed)} ms, before the INSERT ended`);
          assert.equal(inside, 0);
          assert.equal(caught.outcome, 'not-executed');
          assert.match(caught.message, /A savepoint rollback undid the write; the transaction can continue\./);
          assert.equal(outcome, 'committed');
        }
        await new Promise((r) => setTimeout(r, 500));
        const [rows] = await rawPool.query('SELECT name FROM bt_parent WHERE name LIKE ?', [`%-${tag}`]);
        assert.deepEqual(
          (rows as { name: string }[]).map((r) => r.name),
          refuseRollbackTo ? [] : [`after-${tag}`],
        );
      }
    } finally {
      await rawPool.query('DROP TABLE IF EXISTS bt_child');
      await rawPool.query('DROP TABLE IF EXISTS bt_parent');
    }
  });
});
