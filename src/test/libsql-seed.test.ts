import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import type { TransactionClient } from '../client.js';
import { introspectLibsql } from '../libsql/introspect.js';
import { turbineLibsql } from '../libsql.js';
import { defineLibsqlSeed, type LibsqlSeedClient, runLibsqlSeed } from '../libsql-seed.js';

const options = { logger: {}, warnOnUnlimited: false };
async function database(url = ':memory:') {
  const client = createClient({ url, intMode: 'bigint' });
  try {
    await client.execute('CREATE TABLE items(id INTEGER PRIMARY KEY, label TEXT NOT NULL UNIQUE)');
    const source = { client, url };
    return { client, source, schema: await introspectLibsql(source) };
  } catch (error) {
    client.close();
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

test('libSQL seeds declare exact callback types without execution; invalid callbacks never open clients', async () => {
  let calls = 0;
  const fn = defineLibsqlSeed((tx) => {
    const exact: TransactionClient = tx;
    const back: LibsqlSeedClient = exact;
    assert.equal(back, tx);
    calls++;
  });
  assert.equal(defineLibsqlSeed(fn), fn);
  assert.equal(calls, 0);
  assert.throws(() => defineLibsqlSeed(null as never), /callable/);
  await assert.rejects(runLibsqlSeed('remote-invalid', { tables: {}, enums: {} }, null as never), /callable/);
});

test('borrowed native client commits typed writes, savepoints isolate failures, and escaped scopes close', async () => {
  const { client, source, schema } = await database();
  let outer!: LibsqlSeedClient;
  let nested!: LibsqlSeedClient;
  let table!: ReturnType<LibsqlSeedClient['table']>;
  let connection!: ReturnType<LibsqlSeedClient['$connection']>;
  try {
    await runLibsqlSeed(
      source,
      schema,
      async (tx) => {
        outer = tx;
        table = tx.table('items');
        connection = tx.$connection();
        assert.equal('disconnect' in tx, false);
        await tx.table<{ id: number; label: string }>('items').create({ data: { id: 1, label: 'one' } });
        await assert.rejects(
          tx.$transaction(async (inner) => {
            nested = inner;
            await inner.raw`INSERT INTO items VALUES (${2}, ${'nested'})`;
            throw new Error('undo nested');
          }),
          /undo nested/,
        );
        await tx.$transaction(async (inner) => {
          await assert.rejects(tx.raw`SELECT 1`, /outer|scope|block/i);
          await inner.raw`INSERT INTO items VALUES (${3}, ${'savepoint'})`;
        });
        assert.equal(await tx.table('items').count(), 2);
        await assert.rejects(connection.query('COMMIT'), /transaction control|transaction/i);
      },
      options,
    );
    assert.equal(client.closed, false);
    for (const escaped of [outer, nested]) await assert.rejects(escaped.raw`SELECT 1`, /ended|committed|rolled back/);
    await assert.rejects(table.count(), /ended|committed/);
    await assert.rejects(connection.query('SELECT 1'), /ended|committed/);
    assert.deepEqual(
      (await client.execute('SELECT id FROM items ORDER BY id')).rows.map((row) => row[0]),
      [1n, 3n],
    );
    await runLibsqlSeed(
      source,
      schema,
      async (tx) => {
        await tx.raw`INSERT INTO items VALUES (${4}, ${'rerun'})`;
      },
      options,
    );
  } finally {
    client.close();
  }
});

test('every arbitrary callback rejection rolls back; module/external effects remain', async () => {
  const { client, source, schema } = await database();
  const values = [undefined, null, false, 0, '', 'failure', { arbitrary: true }, new Error('failure')];
  const effects: unknown[] = [];
  try {
    for (const value of values) {
      let rejected = false;
      await runLibsqlSeed(
        source,
        schema,
        async (tx) => {
          await tx.raw`INSERT INTO items VALUES (${1}, ${'rolled back'})`;
          effects.push(value);
          throw value;
        },
        options,
      ).then(
        () => assert.fail('must reject'),
        (error: unknown) => {
          rejected = true;
          assert.equal(error, value);
        },
      );
      assert.equal(rejected, true);
      assert.equal((await client.execute('SELECT count(*) FROM items')).rows[0]![0], 0n);
      assert.equal(client.closed, false);
    }
    assert.deepEqual(effects, values);
  } finally {
    client.close();
  }
});

test('owned native clients close after commit and rollback; file persists after reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turbine-libsql-seed-'));
  const url = `file:${join(dir, 'data.db')}`;
  const initial = await database(url);
  initial.client.close();
  const prototype = Object.getPrototypeOf(initial.client) as typeof initial.client;
  const close = prototype.close;
  const closed: (typeof initial.client)[] = [];
  prototype.close = function () {
    closed.push(this);
    close.call(this);
  };
  try {
    await runLibsqlSeed(
      url,
      initial.schema,
      async (tx) => {
        await tx.raw`INSERT INTO items VALUES (${9007199254740993n}, ${'persisted'})`;
      },
      options,
    );
    assert.equal(closed.length, 1);
    assert.equal(closed[0]!.closed, true);
    await assert.rejects(
      runLibsqlSeed(
        url,
        initial.schema,
        async (tx) => {
          await tx.raw`INSERT INTO items VALUES (${2}, ${'rollback'})`;
          throw new Error('rollback');
        },
        options,
      ),
      /rollback/,
    );
    assert.equal(closed.length, 2);
    assert.equal(closed[1]!.closed, true);
    const reopened = createClient({ url, intMode: 'bigint' });
    try {
      assert.deepEqual(
        (await reopened.execute('SELECT id, label FROM items')).rows.map((row) => [row[0], row[1]]),
        [[9007199254740993n, 'persisted']],
      );
      const tx = await reopened.transaction('write');
      await tx.rollback();
      tx.close();
    } finally {
      reopened.close();
    }
  } finally {
    prototype.close = close;
    await rm(dir, { recursive: true, force: true });
  }
});

test('native transaction close failure rejects after commit and does not close a borrowed client', async () => {
  const { client, source, schema } = await database();
  const transaction = client.transaction.bind(client);
  const cleanup = new Error('intentional transaction close failure after real close');
  let closes = 0;
  client.transaction = async (mode?: 'write' | 'read' | 'deferred') => {
    const native = await transaction(mode);
    const close = native.close.bind(native);
    native.close = () => {
      close();
      closes++;
      if (closes === 1) throw cleanup;
    };
    return native;
  };
  try {
    await assert.rejects(
      runLibsqlSeed(
        source,
        schema,
        async (tx) => {
          await tx.raw`INSERT INTO items VALUES (${1}, ${'commit before transaction close failure'})`;
        },
        options,
      ),
      (error: unknown) => error === cleanup,
    );
    assert.ok(closes >= 1);
    assert.equal(client.closed, false);
    assert.equal((await client.execute('SELECT count(*) FROM items')).rows[0]![0], 1n);
  } finally {
    client.close();
  }
});

test('owned close failures surface without losing arbitrary callback failures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'turbine-libsql-seed-close-'));
  const url = `file:${join(dir, 'data.db')}`;
  const initial = await database(url);
  initial.client.close();
  const prototype = Object.getPrototypeOf(initial.client) as typeof initial.client;
  const close = prototype.close;
  const cleanup = new Error('intentional owned close failure after real close');
  let closes = 0;
  prototype.close = function () {
    close.call(this);
    closes++;
    throw cleanup;
  };
  try {
    await assert.rejects(
      runLibsqlSeed(
        url,
        initial.schema,
        async (tx) => {
          await tx.raw`INSERT INTO items VALUES (${1}, ${'committed before close error'})`;
        },
        options,
      ),
      (error: unknown) => error === cleanup,
    );
    for (const value of [undefined, null, false, 0, 'callback failure']) {
      await assert.rejects(
        runLibsqlSeed(
          url,
          initial.schema,
          async (tx) => {
            await tx.raw`INSERT INTO items VALUES (${2}, ${'rollback'})`;
            throw value;
          },
          options,
        ),
        (error: unknown) => {
          assert.ok(error instanceof AggregateError);
          assert.deepEqual(error.errors, [value, cleanup]);
          return true;
        },
      );
    }
    assert.equal(closes, 6);
  } finally {
    prototype.close = close;
    const verify = createClient({ url, intMode: 'bigint' });
    try {
      assert.deepEqual(
        (await verify.execute('SELECT id FROM items')).rows.map((row) => row[0]),
        [1n],
      );
    } finally {
      verify.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test('outstanding native execution rolls back before seed settles and late work refuses', {
  timeout: 5000,
}, async () => {
  const { client, source, schema } = await database();
  const entered = gate();
  const resume = gate();
  const transaction = client.transaction.bind(client);
  client.transaction = async (mode?: 'write' | 'read' | 'deferred') => {
    const native = await transaction(mode);
    const execute = native.execute.bind(native);
    native.execute = async (statement) => {
      if (typeof statement !== 'string' && statement.sql.startsWith('INSERT')) {
        entered.resolve();
        await resume.promise;
      }
      return execute(statement);
    };
    return native;
  };
  let pending!: Promise<unknown>;
  let escaped!: LibsqlSeedClient;
  const seed = runLibsqlSeed(
    source,
    schema,
    async (tx) => {
      escaped = tx;
      pending = tx.raw`INSERT INTO items VALUES (${1}, ${'unawaited'})`;
      void pending.catch(() => undefined);
      await entered.promise;
    },
    options,
  );
  const outcome = assert.rejects(seed, /await|outstanding|running|pending/i);
  try {
    await entered.promise;
    // Let the callback settle while the actual native execution is held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    resume.resolve();
    await outcome;
    await Promise.allSettled([pending]);
    assert.equal(client.closed, false);
    assert.equal((await client.execute('SELECT count(*) FROM items')).rows[0]![0], 0n);
    await assert.rejects(escaped.raw`SELECT 1`, /ended|rolled back/);
  } finally {
    resume.resolve();
    await Promise.allSettled([seed, pending]);
    client.close();
  }
});

test('nested independent seed pools retain ancestor ownership and caller native transactions are untouched', async () => {
  const a = await database();
  const b = await database();
  try {
    const root = await turbineLibsql(a.source, a.schema, options);
    try {
      await root.$transaction(async (txA) => {
        await runLibsqlSeed(
          b.source,
          b.schema,
          async (txB) => {
            await assert.rejects(root.raw`SELECT 1`, /Root operations/);
            await assert.rejects(root.disconnect(), /inside its transaction/);
            await txA.raw`INSERT INTO items VALUES (${1}, ${'ancestor'})`;
            await txB.raw`INSERT INTO items VALUES (${2}, ${'independent'})`;
          },
          options,
        );
      });
    } finally {
      await root.disconnect();
    }
    const native = await a.client.transaction('write');
    try {
      await native.execute("INSERT INTO items VALUES(3, 'caller-owned')");
      await assert.rejects(
        runLibsqlSeed(a.source, a.schema, () => assert.fail('not admitted'), options),
        /transaction|connection/i,
      );
      assert.equal(native.closed, false);
      await native.rollback();
    } finally {
      native.close();
    }
    assert.deepEqual(
      (await a.client.execute('SELECT id FROM items')).rows.map((row) => row[0]),
      [1n],
    );
  } finally {
    a.client.close();
    b.client.close();
  }
});

test('local seed adapter refuses remote/sync, permits transactional DDL and deferred constraint rollback', async () => {
  const { client, source, schema } = await database();
  try {
    for (const target of [
      'libsql://example.invalid',
      'https://example.invalid',
      'wss://example.invalid',
      'file:a?syncUrl=x',
    ]) {
      await assert.rejects(
        runLibsqlSeed(target, schema, () => assert.fail('remote callback ran')),
        /local|Remote/,
      );
    }
    await assert.rejects(
      runLibsqlSeed(source, schema, () => undefined, { syncUrl: 'x' } as never),
      /syncUrl/,
    );
    await assert.rejects(
      runLibsqlSeed(
        source,
        schema,
        async (tx) => {
          await tx.rawUnsafe('CREATE TABLE rollback_ddl(n INTEGER)');
          throw new Error('DDL rollback');
        },
        options,
      ),
      /DDL rollback/,
    );
    assert.equal(
      (await client.execute("SELECT count(*) FROM sqlite_schema WHERE name='rollback_ddl'")).rows[0]![0],
      0n,
    );
    await client.execute('PRAGMA foreign_keys=ON');
    await client.execute('CREATE TABLE child(id INTEGER REFERENCES items(id) DEFERRABLE INITIALLY DEFERRED)');
    await assert.rejects(
      runLibsqlSeed(
        source,
        schema,
        async (tx) => {
          await tx.rawUnsafe('INSERT INTO child VALUES(99)');
        },
        options,
      ),
      /foreign key/i,
    );
    assert.equal((await client.execute('SELECT count(*) FROM child')).rows[0]![0], 0n);
  } finally {
    client.close();
  }
});
