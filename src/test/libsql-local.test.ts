import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import type { TransactionClient } from '../client.js';
import { type LibsqlLocalClient, LibsqlPool, libsqlDialect, turbineLibsql } from '../libsql.js';
import { schemaToSQL } from '../schema-sql.js';
import { definition, schema, user } from './fixtures/libsql-schema.js';

async function database(url = ':memory:') {
  const db = await turbineLibsql(url, schema, { logger: {}, warnOnUnlimited: false });
  try {
    for (const ddl of schemaToSQL(definition, { dialect: libsqlDialect })) await db.rawUnsafe(ddl);
    return db;
  } catch (error) {
    await db.disconnect();
    throw error;
  }
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// No prerequisite skip: this suite requires the actual optional native client.
test('native local file persists exact values after every owned handle closes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turbine-libsql-'));
  const url = `file:${join(dir, 'data.db')}`;
  try {
    const db = await database(url);
    try {
      const versions = await db.rawUnsafe<{ version: string }>('SELECT sqlite_version() AS version');
      assert.match(versions[0]!.version, /^\d+\.\d+\.\d+$/);
      const created = await db.table('users').create({ data: { ...user, id: 9007199254740993n } });
      assert.equal(created.id, '9007199254740993');
      assert.deepEqual(created, { id: '9007199254740993', ...user });
    } finally {
      await db.disconnect();
    }
    await assert.rejects(db.rawUnsafe('SELECT 1'), /closed|disconnect/i);
    const reopened = await turbineLibsql(url, schema, { logger: {} });
    try {
      assert.deepEqual(await reopened.table('users').findMany({ orderBy: { id: 'asc' } }), [
        { id: '9007199254740993', ...user },
      ]);
      assert.deepEqual(await reopened.rawUnsafe('SELECT id, typeof(id) AS kind FROM users'), [
        { id: '9007199254740993', kind: 'integer' },
      ]);
    } finally {
      await reopened.disconnect();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('typed scalar decoding and ordered relations preserve large integers, JSON, booleans, REAL and BLOB', async () => {
  const db = await database();
  try {
    await db.table('users').create({ data: user });
    for (const [id, title, enabled] of [
      [9007199254740993n, 'later', false],
      [2n, 'first', true],
    ] as const) {
      await db.table('posts').create({
        data: { id, userId: 1, title, enabled, profile: { title }, bytes: user.bytes, amount: user.amount },
      });
    }
    for (const strategy of ['join', 'batched', 'flatten'] as const) {
      const result = await db.table('users').findMany({
        where: { id: { in: [1] } },
        orderBy: { id: 'asc' },
        relationLoadStrategy: strategy,
        with: { posts: { orderBy: { id: 'asc' }, limit: 2, where: { title: { contains: 'r' } } } },
      });
      assert.equal(result.length, 1);
      assert.deepEqual(result[0], {
        id: 1,
        ...user,
        posts: [
          {
            id: 2,
            userId: 1,
            title: 'first',
            enabled: true,
            profile: { title: 'first' },
            optionalBytes: null,
            bytes: user.bytes,
            amount: user.amount,
          },
          {
            id: '9007199254740993',
            userId: 1,
            title: 'later',
            enabled: false,
            profile: { title: 'later' },
            optionalBytes: null,
            bytes: user.bytes,
            amount: user.amount,
          },
        ],
      });
    }
    assert.deepEqual(await db.table('posts').updateMany({ where: { userId: 1 }, data: { title: 'updated' } }), {
      count: 2,
    });
    assert.deepEqual(await db.table('posts').deleteMany({ where: { id: 2 } }), { count: 1 });
    for (const enabled of [true, false, true]) {
      await db.table('users').update({ where: { id: 1 }, data: { enabled } });
      assert.equal((await db.table('users').findFirst({ where: { enabled } }))!.enabled, enabled);
    }
  } finally {
    await db.disconnect();
  }
});

test('native bindings preserve order, repeated values, integer storage and literal/comment boundaries', async () => {
  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  const pool = new LibsqlPool(native);
  try {
    assert.deepEqual(
      (await pool.query("SELECT $2 AS b, $1 AS a, $2 AS again, '$3 :p7 ?' AS literal -- $9\n", [7, 'two'])).rows,
      [{ b: 'two', a: 7, again: 'two', literal: '$3 :p7 ?' }],
    );
    assert.deepEqual(
      (
        await pool.query('SELECT typeof($1) AS kind, $1 / 2 AS half, $2 AS bytes', [
          7,
          new Uint8Array([9, 8, 7]).subarray(1),
        ])
      ).rows,
      [{ kind: 'integer', half: 3, bytes: new Uint8Array([8, 7]) }],
    );
    for (const sql of ['SELECT ?', 'SELECT :missing', 'SELECT @missing', 'SELECT $name', 'SELECT $2', 'SELECT :p2']) {
      await assert.rejects(pool.query(sql, [1]), /placeholder|binding|names no value/i);
    }
    await assert.rejects(pool.query('SELECT $1', [Infinity]), /finite/);
    await pool.query('CREATE TABLE t(n INTEGER)');
    for (const sql of [
      'INSERT INTO t VALUES(1); INSERT INTO t VALUES(2)',
      'PRAGMA cache_size=7; SELECT 1',
      'SELECT 1\u0000; SELECT 2',
    ]) {
      await assert.rejects(pool.query(sql), /exactly one statement/);
    }
    assert.deepEqual((await pool.query('SELECT * FROM t')).rows, []);
    await assert.rejects(
      pool.query('CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET n=n+1; END'),
      /exactly one statement/,
    );
    await pool.query('INSERT INTO t VALUES(1)');
    assert.deepEqual((await pool.query('SELECT * FROM t')).rows, [{ n: 1 }]);
  } finally {
    await pool.end();
    assert.equal(native.closed, false);
    native.close();
  }
});

test('callback transactions commit, nested savepoints roll back, and escaped handles refuse', async () => {
  const db = await database();
  let escaped: TransactionClient | undefined;
  try {
    await db.$transaction(async (tx) => {
      escaped = tx;
      await tx.table('users').create({ data: user });
      await assert.rejects(
        tx.$transaction(async (inner) => {
          await inner.table('users').create({ data: { ...user, name: 'nested' } });
          throw new Error('undo nested');
        }),
        /undo nested/,
      );
      assert.equal(await tx.table('users').count(), 1);
    });
    assert.equal(await db.table('users').count(), 1);
    await assert.rejects(escaped!.table('users').findMany(), /ended|committed/);
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table('users').create({ data: { ...user, name: 'rollback' } });
        throw new Error('undo outer');
      }),
      /undo outer/,
    );
    assert.deepEqual(await db.table('users').findMany({ select: { name: true } }), [{ name: 'one' }]);
    await db.transaction(async (connection) => {
      await connection.query('UPDATE users SET name=$1 WHERE id=$2', ['raw', 1]);
    });
    assert.equal((await db.table('users').findFirst())!.name, 'raw');
  } finally {
    await db.disconnect();
  }
});

test('deferred ORM batches and native batches are atomic with exact input order and effects', async () => {
  const db = await database();
  try {
    const [created, count] = await db.$transaction([
      db.table('users').buildCreate({ data: user }),
      db.table('users').buildCount(),
    ]);
    assert.deepEqual(created, { id: 1, ...user });
    assert.equal(count, 1);
    await assert.rejects(
      db.$transaction([
        db.table('users').buildCreate({ data: { ...user, name: 'second' } }),
        db.table('users').buildCreate({ data: user }),
      ]),
    );
    assert.deepEqual(await db.table('users').findMany({ select: { name: true } }), [{ name: 'one' }]);
  } finally {
    await db.disconnect();
  }
  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  let batchCalls = 0;
  const original = native.batch.bind(native);
  native.batch = (...args) => {
    batchCalls++;
    return original(...args);
  };
  const pool = new LibsqlPool(native, true);
  try {
    const result = await pool.batch([
      { text: 'CREATE TABLE t(n INTEGER UNIQUE)' },
      { text: 'INSERT INTO t VALUES($1)', values: [4] },
      { text: 'SELECT n FROM t' },
      { text: 'UPDATE t SET n=n+1 RETURNING n' },
    ]);
    assert.equal(batchCalls, 1);
    assert.deepEqual(
      result.map((r) => r.rows),
      [[], [], [{ n: 4 }], [{ n: 5 }]],
    );
    assert.equal(result[1]!.rowCount, 1);
    await assert.rejects(
      pool.batch([
        { text: 'INSERT INTO t VALUES(6)' },
        { text: 'INSERT INTO t VALUES(5)' },
        { text: 'INSERT INTO t VALUES(7)' },
      ]),
    );
    assert.equal(batchCalls, 2);
    assert.deepEqual((await pool.query('SELECT n FROM t ORDER BY n')).rows, [{ n: 5 }]);
    await assert.rejects(pool.batch([{ text: 'COMMIT' }]), /transaction control/);
  } finally {
    await pool.end();
    assert.equal(native.closed, true);
  }
});

test('exclusive leases queue siblings, refuse reentrancy and close every acquired native transaction', async () => {
  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  let acquired = 0;
  let closed = 0;
  const transaction = native.transaction.bind(native);
  native.transaction = async (mode?: 'write' | 'read' | 'deferred') => {
    const tx = await transaction(mode);
    acquired++;
    const close = tx.close.bind(tx);
    tx.close = () => {
      closed++;
      close();
    };
    return tx;
  };
  const db = await turbineLibsql({ client: native, url: ':memory:' }, schema, { logger: {} });
  for (const ddl of schemaToSQL(definition, { dialect: libsqlDialect })) await db.rawUnsafe(ddl);
  const entered = gate();
  const proceed = gate();
  const order: string[] = [];
  try {
    const first = db.$transaction(async (tx) => {
      order.push('first');
      entered.resolve();
      await assert.rejects(db.table('users').count(), /Root operations/);
      await assert.rejects(
        db.$transaction(async () => 0),
        /Root operations/,
      );
      await assert.rejects(db.disconnect(), /inside its transaction/);
      await tx.table('users').create({ data: user });
      await proceed.promise;
      order.push('commit first');
    });
    await entered.promise;
    const second = db.$transaction(async (tx) => {
      order.push('second');
      assert.equal(await tx.table('users').count(), 1);
    });
    const ordinary = db
      .table('users')
      .count()
      .then((n) => {
        order.push('ordinary');
        return n;
      });
    assert.deepEqual(order, ['first']);
    proceed.resolve();
    await first;
    await second;
    assert.equal(await ordinary, 1);
    assert.deepEqual(order, ['first', 'commit first', 'second', 'ordinary']);
    assert.equal(acquired, 2);
    assert.equal(closed, 2);
    await db.disconnect();
    await db.disconnect();
    assert.equal(native.closed, false);
    assert.deepEqual((await native.execute('SELECT count(*) AS n FROM users')).rows[0]![0], 1n);
  } finally {
    proceed.resolve();
    await db.disconnect();
    native.close();
  }
});

test('release rolls back owned native transactions before reuse; closing waits for an active lease', async () => {
  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  const pool = new LibsqlPool(native, true);
  await pool.query('CREATE TABLE t(n INTEGER)');
  const lease = await pool.connect();
  await lease.query('BEGIN');
  await lease.query('INSERT INTO t VALUES(1)');
  const next = pool.query('SELECT * FROM t');
  lease.release();
  lease.release();
  assert.deepEqual((await next).rows, []);
  await assert.rejects(lease.query('SELECT 1'), /lease has ended/);
  const held = await pool.connect();
  await held.query('BEGIN');
  let ended = false;
  const ending = pool.end().then(() => {
    ended = true;
  });
  await Promise.resolve();
  assert.equal(ended, false);
  await assert.rejects(pool.query('SELECT 1'), /closed/);
  held.release();
  await ending;
  assert.equal(native.closed, true);
});

test('timeouts roll back at callback boundaries and late work cannot escape cancellation', async () => {
  const db = await database();
  const proceed = gate();
  const finished = gate();
  let lateError: unknown;
  try {
    await assert.rejects(
      db.$transaction(
        async (tx) => {
          await tx.table('users').create({ data: user });
          await proceed.promise;
          try {
            await tx.table('users').create({ data: { ...user, name: 'late' } });
          } catch (error) {
            lateError = error;
          } finally {
            finished.resolve();
          }
        },
        { timeout: 20 },
      ),
      /timed out/,
    );
    assert.equal(await db.table('users').count(), 0);
    proceed.resolve();
    await finished.promise;
    assert.match(String(lateError), /timed out|ended/);
    assert.equal(await db.table('users').count(), 0);
    const abort = new AbortController();
    abort.abort(new Error('cancelled before start'));
    await assert.rejects(db.table('users').findManyStream({ signal: abort.signal }).next(), /cancelled before start/);
    await assert.rejects(db.table('users').findManyStream({ batchSize: 1001 }).next(), /incremental streaming/);
    assert.equal(await db.table('users').count(), 0);
  } finally {
    proceed.resolve();
    await db.disconnect();
  }
});

test('remote URLs, sync settings, unsafe inherited lifecycles and caller transaction theft refuse', async () => {
  for (const target of [
    'https://example.invalid/db',
    'libsql://example.invalid',
    'wss://example.invalid',
    'file://remote/db',
    'file:local?syncUrl=x',
    'file:',
  ]) {
    await assert.rejects(turbineLibsql(target, schema), /local|Remote/);
  }
  await assert.rejects(turbineLibsql(':memory:', schema, { syncUrl: 'libsql://example.invalid' } as never), /syncUrl/);
  for (const builder of [
    'buildMigrationTrackingTable',
    'buildMigrationSelectApplied',
    'buildMigrationUpdateChecksum',
    'buildMigrationInsertApplied',
    'buildMigrationDeleteApplied',
  ] as const) {
    assert.throws(() => libsqlDialect[builder]('history'), /Native schema migrations/);
  }
  await assert.rejects(libsqlDialect.introspector!.introspect({} as never), /introspection/);
  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  try {
    const tx = await native.transaction('write');
    try {
      await tx.execute('CREATE TABLE caller(n INTEGER)');
      await assert.rejects(turbineLibsql({ client: native, url: ':memory:' }, schema), /transaction|connection/i);
      assert.equal(tx.closed, false);
      await tx.execute('INSERT INTO caller VALUES(9)');
      await tx.commit();
    } finally {
      tx.close();
    }
    const db = await turbineLibsql({ client: native, url: ':memory:' }, schema, { logger: {} });
    try {
      await assert.rejects(
        db.$transaction(async () => 0, { sessionContext: { 'app.tenant': '1' } }),
        /sessionContext/,
      );
      await assert.rejects(
        db.$transaction(async () => 0, { readOnly: true }),
        /readOnly/,
      );
      await assert.rejects(db.rawUnsafe('BEGIN'), /Unscoped/);
      assert.deepEqual(await db.rawUnsafe('SELECT * FROM caller'), [{ n: 9 }]);
    } finally {
      await db.disconnect();
    }
    assert.equal(native.closed, false);
  } finally {
    native.close();
  }
  const lossy = createClient({ url: ':memory:', intMode: 'string' });
  try {
    await assert.rejects(turbineLibsql({ client: lossy, url: ':memory:' }, schema), /intMode/);
    assert.equal(lossy.closed, false);
  } finally {
    lossy.close();
  }
  await assert.rejects(
    turbineLibsql({ client: { protocol: 'https', closed: false } as LibsqlLocalClient, url: ':memory:' }, schema),
    /native local/,
  );
});

test('native signed integer limits, write constraints, and REAL storage stay exact', async () => {
  const db = await database();
  try {
    await db.table('users').create({ data: user });
    for (const [id, title] of [
      [-9223372036854775808n, 'min'],
      [9223372036854775807n, 'max'],
    ] as const) {
      await db
        .table('posts')
        .create({ data: { id, userId: 1, title, enabled: true, profile: {}, bytes: new Uint8Array(), amount: 3 } });
    }
    assert.deepEqual(
      await db.table('posts').findMany({ select: { id: true, title: true, amount: true }, orderBy: { id: 'asc' } }),
      [
        { id: '-9223372036854775808', title: 'min', amount: 3 },
        { id: '9223372036854775807', title: 'max', amount: 3 },
      ],
    );
    assert.deepEqual(await db.rawUnsafe('SELECT typeof(amount) AS kind FROM posts ORDER BY id'), [
      { kind: 'real' },
      { kind: 'real' },
    ]);
    await assert.rejects(db.table('users').create({ data: user }), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'TURBINE_E008');
      return true;
    });
    await assert.rejects(
      db.table('posts').create({
        data: { id: 3, userId: 99, title: 'orphan', enabled: false, profile: {}, bytes: new Uint8Array(), amount: 0 },
      }),
      (error: unknown) => {
        assert.equal((error as { code: string }).code, 'TURBINE_E009');
        return true;
      },
    );
    await assert.rejects(db.rawUnsafe('SELECT $1', 9223372036854775808n), /64-bit/);
    await assert.rejects(db.disconnect({ timeoutMs: 1 }), /Forced disconnect/);
    assert.equal(await db.table('users').count(), 1);
    await db.disconnect();
    assert.deepEqual(await db.disconnect({}), { timedOut: false, forcedConnections: 0 });
  } finally {
    await db.disconnect();
  }
});

test('actual second local connection reports a native writer lock and recovers after rollback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turbine-libsql-lock-'));
  const url = `file:${join(dir, 'data.db')}`;
  const owner = createClient({ url, intMode: 'bigint' });
  const contender = createClient({ url, intMode: 'bigint' });
  const pool = new LibsqlPool(contender);
  let tx: Awaited<ReturnType<typeof owner.transaction>> | undefined;
  try {
    await owner.execute('CREATE TABLE t(n INTEGER)');
    await contender.execute('PRAGMA busy_timeout=1');
    tx = await owner.transaction('write');
    await tx.execute('INSERT INTO t VALUES(1)');
    await assert.rejects(pool.query('INSERT INTO t VALUES(2)'), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'TURBINE_E013');
      return true;
    });
    await tx.rollback();
    assert.equal((await pool.query('INSERT INTO t VALUES(3)')).rowCount, 1);
    assert.deepEqual((await pool.query('SELECT n FROM t')).rows, [{ n: 3 }]);
  } finally {
    tx?.close();
    await pool.end();
    owner.close();
    contender.close();
    await rm(dir, { recursive: true, force: true });
  }
});
