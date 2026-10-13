/**
 * Row locks (`lock`) against a live MySQL 8.
 *
 * MySQL takes `lock: 'update'` and `lock: 'share'` (the other two modes are
 * E017, covered build-side). Each claim is checked from a second transaction:
 * `skipLocked` hands two workers disjoint rows, `noWait` fails at once with
 * `LockNotAvailableError` (errno 3572), and loading a relation never locks the
 * related table.
 *
 * Run: MYSQL_URL=mysql://user@host:3306/db npx tsx --test src/test/wave-c-locks-mysql.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import type { TransactionClient, TurbineClient } from '../client.js';
import { LockNotAvailableError, SerializationFailureError, ValidationError } from '../errors.js';
import type { RowLockMode } from '../query/types.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const { it, before, after } = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');
const beforeEach: typeof eachTest = MYSQL_URL ? eachTest : () => {};

/**
 * Its own database: test files run in parallel, and mysql.test.ts asserts the
 * exact table list of the URL's. Overridable for a server where this test may
 * use only one named database.
 */
const DATABASE = process.env.TURBINE_ROW_LOCKS_MYSQL_DB ?? 'turbine_row_locks';
const USERS = 'wclk_users';
const POSTS = 'wclk_posts';

type Row = { id: number };
const ids = (rows: readonly Row[]) => rows.map((r) => Number(r.id));

interface Held<T> {
  readonly value: T;
  release(): Promise<void>;
}

/** Run `body` in a transaction that keeps its locks until `release()`. */
async function hold<T>(db: TurbineClient, body: (tx: TransactionClient) => Promise<T>): Promise<Held<T>> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  let ready!: (value: T) => void;
  let failed!: (error: unknown) => void;
  const value = new Promise<T>((resolve, reject) => {
    ready = resolve;
    failed = reject;
  });
  const done = db.$transaction(async (tx) => {
    try {
      ready(await body(tx));
    } catch (error) {
      failed(error);
      throw error;
    }
    await gate;
  });
  done.catch(() => {});
  const v = await value;
  return {
    value: v,
    async release() {
      open();
      await done;
    },
  };
}

function lockNotAvailable(err: unknown): boolean {
  assert.ok(err instanceof LockNotAvailableError, `expected LockNotAvailableError, got ${String(err)}`);
  assert.ok(err instanceof SerializationFailureError);
  assert.equal(err.code, 'TURBINE_E013');
  assert.equal((err.cause as { errno?: number }).errno, 3572, 'ER_LOCK_NOWAIT');
  return true;
}

describe('lock: live MySQL', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool shape, loaded dynamically
  let rawPool: any;
  let db: TurbineClient;

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
    await rawPool.query(`DROP TABLE IF EXISTS ${POSTS}`);
    await rawPool.query(`DROP TABLE IF EXISTS ${USERS}`);
    await rawPool.query(
      `CREATE TABLE ${USERS} (id BIGINT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(64) NOT NULL UNIQUE) ENGINE=InnoDB`,
    );
    await rawPool.query(
      `CREATE TABLE ${POSTS} (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, ` +
        `title VARCHAR(64) NOT NULL, INDEX (user_id), ` +
        `CONSTRAINT fk_wclk_posts_user FOREIGN KEY (user_id) REFERENCES ${USERS}(id)) ENGINE=InnoDB`,
    );
    const { MysqlPool, introspectMysqlWith, turbineMysql } = await import('../mysql.js');
    const pool = new MysqlPool(rawPool);
    const schema: SchemaMetadata = await introspectMysqlWith(
      async (sql, params) => (await pool.query(sql, params)).rows,
      DATABASE,
    );
    db = (await turbineMysql(pool, schema, { warnOnUnlimited: false })) as unknown as TurbineClient;
  });
  beforeEach(async () => {
    await rawPool.query(`DELETE FROM ${POSTS}`);
    await rawPool.query(`DELETE FROM ${USERS}`);
    await rawPool.query(
      `INSERT INTO ${USERS} (id, email) VALUES (1, 'a@x'), (2, 'b@x'), (3, 'c@x'), (4, 'd@x'), (5, 'e@x')`,
    );
    await rawPool.query(`INSERT INTO ${POSTS} (id, user_id, title) VALUES (1, 1, 'p1'), (2, 1, 'p2')`);
  });
  after(async () => {
    if (!rawPool) return;
    await rawPool.query(`DROP DATABASE IF EXISTS \`${DATABASE}\``);
    await rawPool.end();
  });

  async function canLock(table: string, where: Record<string, unknown>, mode: RowLockMode = 'update') {
    try {
      await db.$transaction((tx) => tx.table(table).findMany({ where, lock: { mode, noWait: true } }));
      return true;
    } catch (err) {
      lockNotAvailable(err);
      return false;
    }
  }

  it('skipLocked: two workers claim disjoint rows', async () => {
    const claim = (tx: TransactionClient) =>
      tx.table<Row>(USERS).findMany({ orderBy: { id: 'asc' }, limit: 3, lock: { mode: 'update', skipLocked: true } });
    const first = await hold(db, claim);
    try {
      assert.deepEqual(ids(first.value), [1, 2, 3]);
      const second = await hold(db, claim);
      try {
        assert.deepEqual(ids(second.value), [4, 5]);
      } finally {
        await second.release();
      }
    } finally {
      await first.release();
    }
    assert.deepEqual(ids(await db.$transaction(claim)), [1, 2, 3]);
  });

  it('noWait: errno 3572 is LockNotAvailableError', async () => {
    const held = await hold(db, (tx) => tx.table(USERS).findUnique({ where: { id: 1 }, lock: 'update' }));
    try {
      await assert.rejects(
        db.$transaction((tx) =>
          tx.table(USERS).findUnique({ where: { id: 1 }, lock: { mode: 'update', noWait: true } }),
        ),
        lockNotAvailable,
      );
      assert.equal(await canLock(USERS, { id: 2 }), true);
    } finally {
      await held.release();
    }
  });

  it('share: shared with share, refused to update', async () => {
    const held = await hold(db, (tx) => tx.table(USERS).findUnique({ where: { id: 1 }, lock: 'share' }));
    try {
      assert.equal(await canLock(USERS, { id: 1 }, 'share'), true);
      assert.equal(await canLock(USERS, { id: 1 }, 'update'), false);
    } finally {
      await held.release();
    }
  });

  for (const strategy of ['join', 'batched'] as const) {
    it(`relationLoadStrategy '${strategy}': only the queried table is locked`, async () => {
      const held = await hold(db, (tx) =>
        tx.table<Row & { wclkPosts: Row[] }>(USERS).findMany({
          where: { id: 1 },
          with: { wclkPosts: true },
          relationLoadStrategy: strategy,
          lock: 'update',
        }),
      );
      try {
        assert.equal(held.value[0]?.wclkPosts.length, 2, 'the relation loaded');
        assert.equal(await canLock(USERS, { id: 1 }), false, 'the user is locked');
        assert.equal(await canLock(POSTS, { userId: 1 }), true, 'its posts are not');
      } finally {
        await held.release();
      }
    });
  }

  it('outside a transaction it is E003', async () => {
    await assert.rejects(
      db.table(USERS).findMany({ lock: 'update' }),
      (err: unknown) => err instanceof ValidationError && /needs a transaction/.test(err.message),
    );
  });
});
