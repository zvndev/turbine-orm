import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  createMysqlToolPool,
  introspectMysqlToolClient,
  mysqlToolRuntime,
  mysqlToolTransport,
  validateMysqlToolOptions,
} from '../cli/mysql-tools.js';
import importOptionalPeer from '../optional-peer-import.cjs';

const peer = createRequire(import.meta.url)('mysql2/promise') as {
  createConnection: (config: unknown) => Promise<unknown>;
};
const url = 'mysql://reader:private-password@127.0.0.1:3306/app';

function native(version = '8.4.0') {
  const calls: { sql: string; values?: unknown }[] = [];
  const socket = new PassThrough();
  let destroyed = 0;
  let failure = '';
  const connection = {
    async query(sql: string, values?: unknown): Promise<[unknown, unknown]> {
      calls.push({ sql, values });
      if (failure && sql.includes(failure))
        throw Object.assign(new Error('private stored literal'), { code: 'ER_TEST' });
      return [sql.includes('VERSION()') ? [{ version }] : [], []];
    },
    async execute(sql: string, values?: unknown) {
      return connection.query(sql, values);
    },
    on: socket.on.bind(socket),
    destroy() {
      destroyed++;
    },
  };
  return {
    connection,
    calls,
    socket,
    get destroyed() {
      return destroyed;
    },
    fail: (sql: string) => {
      failure = sql;
    },
  };
}

describe('MySQL read-only tool transport', () => {
  it('validates malformed URLs and config before optional peer load or connection', (t) => {
    const mock = t.mock.method(peer, 'createConnection', async () => {
      throw new Error('must not connect');
    });
    for (const value of [
      '',
      'postgres://host/app',
      'mysql://host',
      'mysql://host/app?multipleStatements=true',
      'mysql://host/app#password',
      'mysql://host/a/b',
      'mysql://host/%zz',
      'mysql://u:%zz@host/app',
      'mysql://host/app%00',
      'mysql://host/app%0a',
      'mysql://u:secret%0a@host/app',
      'mysql://host:99999/app',
      'mysql://host:0/app',
    ]) {
      assert.throws(() => createMysqlToolPool(value, 'app'), /MySQL/);
    }
    assert.throws(() => createMysqlToolPool(url, 'other'), /schema must match/);
    assert.throws(() => createMysqlToolPool(url, 'app', { include: [''] }), /include/);
    assert.throws(() => validateMysqlToolOptions({ exclude: 'users' as unknown as string[] }), /exclude/);
    assert.throws(
      () => validateMysqlToolOptions(null as unknown as Parameters<typeof validateMysqlToolOptions>[0]),
      /filters must be an object/,
    );
    assert.equal(mock.mock.callCount(), 0);
  });

  it('discovery is honest and connection free', (t) => {
    const mock = t.mock.method(peer, 'createConnection', async () => {
      throw new Error('must not connect');
    });
    assert.equal(mysqlToolRuntime().available, true);
    assert.equal(mysqlToolRuntime().minimumNode, null);
    assert.equal(mysqlToolTransport.cursors, false);
    assert.equal(mysqlToolTransport.pipeline, false);
    assert.equal(mysqlToolTransport.statementTimeout, false);
    assert.equal(mysqlToolTransport.readOnlyEnforcement, 'transaction-read-only-consistent-snapshot');
    assert.equal(mock.mock.callCount(), 0);
  });

  it('reports a missing optional peer without connecting', (t) => {
    t.mock.method(importOptionalPeer, 'peerPackageVersion', () => null);
    const facts = mysqlToolRuntime();
    assert.equal(facts.available, false);
    assert.match(facts.reason!, /optional peer mysql2/);
  });

  it('refuses unsupported servers before snapshot setup and closes their owned connections', async (t) => {
    for (const version of ['5.7.44', '10.11-MariaDB', '9.0.0']) {
      const fixture = native(version);
      t.mock.method(peer, 'createConnection', async () => fixture.connection);
      const pool = createMysqlToolPool(url, 'app');
      await assert.rejects(pool.connect(), /native MySQL 8/);
      await pool.end();
      assert.equal(fixture.destroyed, 1);
      assert.deepEqual(
        fixture.calls.map(({ sql }) => sql),
        ['SELECT VERSION() AS version'],
      );
    }
  });

  it('establishes the snapshot before returning a handle and reuses native parameter binding', async (t) => {
    const fixture = native();
    let config: Record<string, unknown> = {};
    t.mock.method(peer, 'createConnection', async (value: Record<string, unknown>) => {
      config = value;
      return fixture.connection;
    });
    const pool = createMysqlToolPool(url, 'app');
    assert.equal(fixture.calls.length, 0, 'factory is lazy');
    const client = await pool.connect();
    assert.deepEqual(
      fixture.calls.map((call) => call.sql),
      [
        'SELECT VERSION() AS version',
        'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ',
        'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
      ],
    );
    assert.equal(config.multipleStatements, false);
    assert.equal(config.namedPlaceholders, true);
    await introspectMysqlToolClient(client);
    assert.deepEqual(fixture.calls.at(-1)?.values, { p1: 'app' });
    await assert.rejects(client.query('COMMIT'), /arbitrary SQL/);
    await assert.rejects(client.query('SELECT 1'), /arbitrary SQL/);
    client.release();
    assert.equal(fixture.destroyed, 1);
    client.release();
    await pool.end();
    assert.equal(fixture.destroyed, 1);
    await assert.rejects(client.query('SELECT 1'), /arbitrary SQL/);
    await assert.rejects(introspectMysqlToolClient(client), /active MySQL/);
  });

  it('closes on query and setup failures without echoing native literal values', async (t) => {
    for (const failing of ['START TRANSACTION', 'information_schema.TABLES']) {
      const fixture = native();
      fixture.fail(failing);
      t.mock.method(peer, 'createConnection', async () => fixture.connection);
      const pool = createMysqlToolPool(url, 'app');
      await assert.rejects(
        async () => {
          const client = await pool.connect();
          await introspectMysqlToolClient(client);
        },
        (error: Error) => {
          assert.match(error.message, /ER_TEST/);
          assert.doesNotMatch(JSON.stringify(error) + error.message, /private stored|private-password/);
          return true;
        },
      );
      await pool.end();
      assert.equal(fixture.destroyed, 1);
    }
  });

  it('destroys active owned handles on shutdown and refuses unscoped or later queries', async (t) => {
    const fixtures = [native(), native()];
    let count = 0;
    t.mock.method(peer, 'createConnection', async () => fixtures[count++]!.connection);
    const pool = createMysqlToolPool(url, 'app');
    const a = await pool.connect();
    const b = await pool.connect();
    await assert.rejects(pool.query('SELECT 1'), /scoped read-only/);
    await pool.end();
    await pool.end();
    a.release();
    b.release();
    assert.deepEqual(
      fixtures.map((fixture) => fixture.destroyed),
      [1, 1],
    );
    await assert.rejects(pool.connect(), /closed/);
    await assert.rejects(a.query('SELECT 1'), /arbitrary SQL/);
  });

  it('waits for an in-flight connect during shutdown and destroys only its new connection', async (t) => {
    const fixture = native();
    let resolve!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((done) => {
      entered = done;
    });
    t.mock.method(peer, 'createConnection', () => {
      entered();
      return new Promise((done) => {
        resolve = done;
      });
    });
    const pool = createMysqlToolPool(url, 'app');
    const checkingOut = pool.connect();
    const refusal = assert.rejects(checkingOut, /closed/);
    await started;
    let ended = false;
    const ending = pool.end().then(() => {
      ended = true;
    });
    await Promise.resolve();
    assert.equal(ended, false);
    resolve(fixture.connection);
    await refusal;
    await ending;
    assert.equal(fixture.destroyed, 1);
    assert.equal(fixture.calls.length, 0);
  });

  it('closes on an idle native error and refuses transaction commands', async (t) => {
    const fixture = native();
    t.mock.method(peer, 'createConnection', async () => fixture.connection);
    const pool = createMysqlToolPool(url, 'app');
    const client = await pool.connect();
    fixture.socket.emit('error', new Error('private stored literal'));
    assert.equal(fixture.destroyed, 1);
    await assert.rejects(client.query('SELECT 1'), /arbitrary SQL/);
    const other = native();
    t.mock.method(peer, 'createConnection', async () => other.connection);
    const second = await pool.connect();
    await assert.rejects(second.query('ROLLBACK'), /arbitrary SQL/);
    second.release();
    assert.equal(other.destroyed, 1);
    await pool.end();
  });
});
