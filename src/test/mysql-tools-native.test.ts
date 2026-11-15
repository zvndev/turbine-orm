import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, before, describe } from 'node:test';
import type { Connection, RowDataPacket } from 'mysql2/promise';
import { compileQueryPlan } from '../cli/compile-query.js';
import {
  createMysqlToolPool,
  introspectMysqlToolClient,
  mysqlToolIndexSummary,
  sampleMysqlToolRows,
} from '../cli/mysql-tools.js';
import { MysqlPool, mysqlDialect } from '../mysql.js';
import type { PgCompatPool } from '../pg-types.js';
import { skipGate } from './helpers.js';

const endpoint = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const { it } = skipGate(!endpoint, 'requires MYSQL_URL pointing at disposable native MySQL 8');
const database = `turbine_tools_${randomBytes(6).toString('hex')}`;
const q = mysqlDialect.quoteIdentifier;
let admin: Connection;
let pool: PgCompatPool;
let url: string;
let adminId: number;
const peer = createRequire(import.meta.url)('mysql2/promise') as typeof import('mysql2/promise');
const originalCreate = peer.createConnection;
const ownedConnections: Connection[] = [];

async function rows(sql: string): Promise<RowDataPacket[]> {
  return (await admin.query<RowDataPacket[]>(sql))[0];
}

before(async () => {
  if (!endpoint) return;
  const mysql = await import('mysql2/promise');
  const parsed = new URL(endpoint);
  admin = await mysql.createConnection({
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    namedPlaceholders: true,
  });
  await admin.query(`CREATE DATABASE ${q(database)}`);
  await admin.query(`USE ${q(database)}`);
  await admin.query(`CREATE TABLE users(id INT PRIMARY KEY, display_name VARCHAR(100) NOT NULL,
    email VARCHAR(100), api_key VARCHAR(100), flag INT NOT NULL DEFAULT 0) ENGINE=InnoDB`);
  await admin.query(`CREATE TABLE posts(id INT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(100),
    CONSTRAINT posts_user_fk FOREIGN KEY(user_id) REFERENCES users(id)) ENGINE=InnoDB`);
  await admin.query('CREATE INDEX names_prefix ON users(display_name(12) DESC) INVISIBLE');
  await admin.query("CREATE INDEX names_expression ON users((CONCAT(display_name, 'private-expression-literal')))");
  await admin.query(
    "CREATE UNIQUE INDEX mixed_expression ON users(display_name,(CONCAT(email, 'private-unique-literal')))",
  );
  await admin.query(
    "INSERT INTO users VALUES (1, 'First', 'pii@example.test', 'private-api-key', 0), (2, 'Second', 'other@example.test', 'other-key', 0)",
  );
  await admin.query("INSERT INTO posts VALUES (1,1,'Actual post'),(2,1,'Second post')");
  adminId = Number((await rows('SELECT CONNECTION_ID() AS id'))[0]!.id);
  parsed.pathname = `/${database}`;
  url = parsed.toString();
  peer.createConnection = (async (options: Parameters<typeof originalCreate>[0]) => {
    const connection = await originalCreate(options);
    ownedConnections.push(connection);
    return connection;
  }) as typeof originalCreate;
  pool = createMysqlToolPool(url, database);
});

after(async () => {
  peer.createConnection = originalCreate;
  if (!admin) return;
  try {
    await pool?.end();
    await admin.query(`DROP DATABASE ${q(database)}`);
  } finally {
    await admin.end();
  }
});

describe('native MySQL read-only tool snapshots', () => {
  it('reads actual structural metadata and withholds expression literals', async () => {
    const client = await pool.connect();
    try {
      const metadata = await introspectMysqlToolClient(client);
      assert.deepEqual(Object.keys(metadata.tables).sort(), ['posts', 'users']);
      assert.deepEqual(metadata.tables.users!.primaryKey, ['id']);
      assert.ok(Object.values(metadata.tables.posts!.relations).some((relation) => relation.to === 'users'));
      const indexes = metadata.tables.users!.indexes;
      assert.equal(indexes.length, 3);
      const summaries = indexes.map(mysqlToolIndexSummary);
      assert.ok(summaries.every(Boolean));
      assert.doesNotMatch(
        JSON.stringify({ metadata, summaries }),
        /private-expression-literal|private-unique-literal|private-api-key|pii@example/,
      );
      const prefix = summaries.find((index) => index!.name === 'names_prefix')!;
      assert.deepEqual(prefix.columns, ['display_name']);
      assert.deepEqual(
        indexes.find((index) => index.name === 'names_prefix')!.columns,
        [],
        'prefix keys must not prove whole-column coverage',
      );
      assert.equal(prefix.visible, false);
      assert.deepEqual(prefix.keys, [
        { column: 'display_name', expressionWithheld: false, prefixLength: 12, direction: 'desc' },
      ]);
      const expression = summaries.find((index) => index!.name === 'names_expression')!;
      assert.equal(expression.columnsWithheld, true);
      assert.deepEqual(expression.columns, []);
      assert.equal(expression.definitionWithheld, true);
      const mixed = summaries.find((index) => index!.name === 'mixed_expression')!;
      assert.deepEqual(mixed.columns, ['display_name']);
      assert.equal(mixed.columnsWithheld, true);
      assert.deepEqual(indexes.find((index) => index.name === 'mixed_expression')!.columns, []);
      assert.deepEqual(metadata.tables.users!.uniqueColumns, []);
      const ambiguous = compileQueryPlan({
        metadata,
        table: metadata.tables.users!,
        operation: 'findUnique',
        args: { where: { displayName: 'First' } },
        dialect: mysqlDialect,
      });
      assert.equal(ambiguous.ok, false);
      const sampled = await sampleMysqlToolRows(client, 'users', ['id', 'display_name'], 1);
      assert.equal(sampled.rows.length, 1);
      assert.deepEqual(Object.keys(sampled.rows[0]!).sort(), ['display_name', 'id']);
      await assert.rejects(sampleMysqlToolRows(client, 'users', ['id; DROP TABLE posts'], 1), /catalog columns/);
      await assert.rejects(sampleMysqlToolRows(client, 'users', ['id'], 101), /limit/);
      await assert.rejects(sampleMysqlToolRows(client, 'unknown', ['id'], 1), /table metadata/);
    } finally {
      client.release();
    }
  });

  it('uses one repeatable-read snapshot with independent per-call owned connections', async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const rawA = ownedConnections.at(-2)!;
      const rawB = ownedConnections.at(-1)!;
      const aid = (await rawA.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id'))[0][0]!.id;
      const bid = (await rawB.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id'))[0][0]!.id;
      assert.notEqual(aid, bid);
      assert.notEqual(aid, adminId);
      assert.notEqual(bid, adminId);
      assert.equal((await rawA.query<RowDataPacket[]>('SELECT flag FROM users WHERE id = 1'))[0][0]!.flag, 0);
      await admin.query('UPDATE users SET flag = 7 WHERE id = 1');
      assert.equal((await rawA.query<RowDataPacket[]>('SELECT flag FROM users WHERE id = 1'))[0][0]!.flag, 0);
      const later = await pool.connect();
      try {
        assert.equal(
          (await ownedConnections.at(-1)!.query<RowDataPacket[]>('SELECT flag FROM users WHERE id = 1'))[0][0]!.flag,
          7,
        );
      } finally {
        later.release();
      }
    } finally {
      a.release();
      b.release();
      await admin.query('UPDATE users SET flag = 0 WHERE id = 1');
    }
  });

  it('natively rejects DML and refuses all exposed DDL with no canary effects', async () => {
    await admin.query("INSERT INTO users VALUES (99,'write-positive',NULL,NULL,0)");
    await admin.query('DELETE FROM users WHERE id=99');
    for (const sql of [
      "INSERT INTO users VALUES (99,'must-not-appear',NULL,NULL,0)",
      'UPDATE users SET flag=99 WHERE id=1',
      'DELETE FROM users WHERE id=1',
      'CREATE TABLE forbidden_table(id INT)',
      'ALTER TABLE users ADD COLUMN forbidden_column INT',
      'DROP TABLE posts',
    ]) {
      const client = await pool.connect();
      try {
        const raw = ownedConnections.at(-1)!;
        if (/^(INSERT|UPDATE|DELETE)/.test(sql)) {
          await assert.rejects(raw.query(sql), { code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' });
        }
        await assert.rejects(client.query(sql), /arbitrary SQL/);
      } finally {
        client.release();
      }
    }
    assert.deepEqual(
      (await rows('SELECT id, flag FROM users ORDER BY id')).map((row) => [row.id, row.flag]),
      [
        [1, 0],
        [2, 0],
      ],
    );
    assert.equal((await rows('SELECT COUNT(*) AS n FROM posts'))[0]!.n, 2);
    assert.equal(
      (
        await rows(
          "SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='forbidden_table'",
        )
      )[0]!.n,
      0,
    );
    assert.equal(
      (
        await rows(
          "SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND COLUMN_NAME='forbidden_column'",
        )
      )[0]!.n,
      0,
    );
  });

  it('compiles with the sealed pool, then independently executes SQL against fixture results', async () => {
    const client = await pool.connect();
    const metadata = await introspectMysqlToolClient(client);
    client.release();
    const report = compileQueryPlan({
      metadata,
      table: metadata.tables.users!,
      operation: 'findMany',
      args: { select: { id: true, displayName: true }, where: { id: { gte: 1 } }, orderBy: { id: 'asc' }, limit: 2 },
      dialect: mysqlDialect,
    });
    assert.equal(report.ok, true);
    if (!report.ok) throw new Error('compile failed');
    assert.match(report.sql, /`users`/);
    assert.match(report.sql, /:p1/);
    assert.doesNotMatch(report.sql, /\$\d|json_agg|::/);
    const mysql = await import('mysql2/promise');
    const nativePool = mysql.createPool({ uri: url, namedPlaceholders: true });
    const executor = new MysqlPool(nativePool);
    try {
      const result = await executor.query(report.sql, report.params);
      assert.deepEqual(result.rows, [
        { id: 1, display_name: 'First' },
        { id: 2, display_name: 'Second' },
      ]);
      const count = compileQueryPlan({
        metadata,
        table: metadata.tables.posts!,
        operation: 'count',
        args: { where: { userId: 1 } },
        dialect: mysqlDialect,
      });
      assert.equal(count.ok, true);
      if (!count.ok) throw new Error('count compile failed');
      const counted = await executor.query(count.sql, count.params);
      assert.equal(Number(Object.values(counted.rows[0]!)[0]), 2);
      for (const [operation, args, expected] of [
        ['findUnique', { select: { id: true }, where: { id: 2 } }, [{ id: 2 }]],
        ['findFirst', { select: { id: true }, orderBy: { id: 'desc' } }, [{ id: 2 }]],
      ] as const) {
        const plan = compileQueryPlan({
          metadata,
          table: metadata.tables.users!,
          operation,
          args: { ...args },
          dialect: mysqlDialect,
        });
        assert.equal(plan.ok, true);
        if (!plan.ok) throw new Error('compile failed');
        assert.deepEqual((await executor.query(plan.sql, plan.params)).rows, expected);
      }
      for (const [operation, args, expected] of [
        ['aggregate', { _sum: { flag: true }, _count: { _all: true } }, [0, 2]],
        ['groupBy', { by: ['flag'], _count: { _all: true } }, [0, 2]],
      ] as const) {
        const plan = compileQueryPlan({
          metadata,
          table: metadata.tables.users!,
          operation,
          args: { ...args },
          dialect: mysqlDialect,
        });
        assert.equal(plan.ok, true);
        if (!plan.ok) throw new Error('compile failed');
        const actual = await executor.query(plan.sql, plan.params);
        assert.equal(actual.rows.length, 1);
        assert.deepEqual(
          Object.values(actual.rows[0]!)
            .map(Number)
            .sort((a, b) => a - b),
          expected,
        );
      }
    } finally {
      await executor.end();
    }
  });

  it('destroys checked-out sockets on shutdown without closing the independent owner connection', async () => {
    const owned = createMysqlToolPool(url, database);
    const client = await owned.connect();
    const id = (await ownedConnections.at(-1)!.query<RowDataPacket[]>('SELECT CONNECTION_ID() AS id'))[0][0]!.id;
    assert.equal(
      (await rows(`SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ID=${Number(id)}`))[0]!.n,
      1,
    );
    await owned.end();
    await assert.rejects(introspectMysqlToolClient(client), /active MySQL/);
    // The admin connection is untouched. The server reaps the destroyed socket's
    // thread asynchronously, so under a loaded server the first PROCESSLIST read
    // can still list it: wait a bounded time for it to go.
    assert.equal((await rows('SELECT CONNECTION_ID() AS id'))[0]!.id, adminId);
    const deadline = Date.now() + 10_000;
    let listed = 1;
    while (listed !== 0 && Date.now() < deadline) {
      listed = Number(
        (await rows(`SELECT COUNT(*) AS n FROM information_schema.PROCESSLIST WHERE ID=${Number(id)}`))[0]!.n,
      );
      if (listed !== 0) await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(listed, 0, 'destroyed socket still listed after 10 s');
    assert.equal((await rows('SELECT COUNT(*) AS n FROM users'))[0]!.n, 2);
  });
});
