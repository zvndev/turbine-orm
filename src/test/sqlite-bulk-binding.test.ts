/** Generated bulk binds must preserve the ordinary named-parameter contract. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { SqlitePool, sqliteDialect } from '../sqlite.js';
import { mockTable, skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
const reportsTypes = typeof native?.StatementSync.prototype.columns === 'function';

async function fixture(run: (f: Awaited<ReturnType<typeof open>>) => Promise<void>, dialect = sqliteDialect) {
  const f = open(dialect);
  try {
    await run(f);
  } finally {
    await f.client.disconnect();
    await f.pool.end();
    if (f.handle.isOpen) f.handle.close();
    assert.throws(() => f.handle.prepare('SELECT 1'), { code: 'ERR_INVALID_STATE' });
  }
}

function open(dialect: Dialect) {
  const handle = new native!.DatabaseSync(':memory:');
  try {
    handle.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, display_name TEXT DEFAULT 'default',
      enabled BOOLEAN, payload TEXT, created_at TEXT, bytes BLOB, exact INTEGER, n INTEGER CHECK(n >= 0))`);
    const schema = {
      enums: {},
      tables: {
        items: mockTable(
          'items',
          [
            { name: 'id', field: 'id', pgType: 'int4' },
            { name: 'display_name', field: 'displayName', pgType: 'text' },
            { name: 'enabled', field: 'enabled', pgType: 'bool' },
            { name: 'payload', field: 'payload', pgType: 'jsonb' },
            { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
            { name: 'bytes', field: 'bytes', pgType: 'bytea' },
            { name: 'exact', field: 'exact', pgType: 'int8' },
            { name: 'n', field: 'n', pgType: 'int4' },
          ],
          {},
          ['id'],
        ),
      },
    };
    schema.tables.items.dateColumns.add('created_at');
    const bindingKeys: string[][] = [];
    const bare: boolean[] = [];
    const inserts: string[] = [];
    const prepare = handle.prepare.bind(handle);
    handle.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      if (!/^INSERT\b/.test(sql)) return stmt;
      inserts.push(sql);
      const allow = stmt.setAllowBareNamedParameters.bind(stmt);
      stmt.setAllowBareNamedParameters = (enabled: boolean) => {
        bare.push(enabled);
        return allow(enabled);
      };
      const all = stmt.all.bind(stmt);
      stmt.all = ((...args: Parameters<typeof stmt.all>) => {
        bindingKeys.push(Object.keys(args[0] ?? {}));
        return all(...args);
      }) as typeof stmt.all;
      return stmt;
    }) as DatabaseSync['prepare'];
    const pool = new SqlitePool(handle, { schema });
    const client = new TurbineClient({ pool, dialect, preparedStatements: false }, schema);
    return { handle, pool, client, bindingKeys, bare, inserts };
  } catch (error) {
    handle.close();
    throw error;
  }
}

it('generated bulk binds exact names while public and native SQL keep their named placeholders', async () => {
  await fixture(async ({ client, pool, bare, bindingKeys, inserts }) => {
    const q = client.table('items').buildCreateMany({ data: [{ id: 1, displayName: 'literal :p1 ? $2' }] });
    assert.equal(q.sql, 'INSERT INTO "items" ("id", "display_name") VALUES (:p1, :p2) RETURNING *');
    const result = await pool.query(q.sql, q.params);
    assert.equal(result.rows[0].display_name, 'literal :p1 ? $2');
    assert.deepEqual(inserts, [q.sql]);
    assert.deepEqual(bare, [false]);
    assert.deepEqual(bindingKeys, [[':p1', ':p2']]);
  });
});

it('copied arrays, edited SQL and changed arity keep ordinary binding', async () => {
  await fixture(async ({ client, pool, handle, bare, bindingKeys }) => {
    const q = client.table('items').buildCreateMany({ data: [{ id: 1, displayName: 'one' }] });
    await pool.query(q.sql, [...q.params]);
    q.params[0] = 2;
    await pool.query(`${q.sql} /* edited */`, q.params);
    q.params[0] = 3;
    await pool.query(q.sql.replace(':p2', '$p2'), q.params);
    q.params[0] = 4;
    q.params.push('extra');
    await assert.rejects(pool.query(q.sql, q.params));
    assert.deepEqual(bare, []);
    assert.deepEqual(bindingKeys.slice(0, 2), [
      ['p1', 'p2'],
      ['p1', 'p2'],
    ]);
    assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM items').get()!.n, 3);
  });
});

it('deleted and explicitly undefined bulk slots bind NULL without shifting later values', async () => {
  await fixture(async ({ client, pool }) => {
    const q = client.table('items').buildCreateMany({ data: [{ id: 1, displayName: 'first', n: 7 }] });
    delete q.params[1];
    assert.deepEqual((await pool.query(q.sql, q.params)).rows[0], {
      id: 1,
      display_name: null,
      enabled: null,
      payload: null,
      created_at: null,
      bytes: null,
      exact: null,
      n: 7,
    });
    q.params[0] = 2;
    q.params[1] = undefined;
    assert.equal((await pool.query(q.sql, q.params)).rows[0].n, 7);
  });
});

it('custom placeholders keep the ordinary portable numbered binding path', async () => {
  const dialect = { ...sqliteDialect, paramPlaceholder: (i: number) => `$${i}` };
  await fixture(async ({ client, bare, bindingKeys }) => {
    const rows = await client.table('items').createMany({ data: [{ id: 1, n: 3 }] });
    assert.equal((rows[0] as { n: number }).n, 3);
    assert.deepEqual(bare, []);
    assert.deepEqual(bindingKeys, [['p1', 'p2']]);
  }, dialect);
});

it('compatible statements without the bare-name switch still bind the exact names', async () => {
  await fixture(async ({ client, handle, bare, bindingKeys }) => {
    const prepare = handle.prepare.bind(handle);
    handle.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      Object.defineProperty(stmt, 'setAllowBareNamedParameters', { value: undefined });
      return stmt;
    }) as DatabaseSync['prepare'];
    const rows = await client.table('items').createMany({ data: [{ id: 1, n: 2 }] });
    assert.equal((rows[0] as { n: number }).n, 2);
    assert.deepEqual(bare, []);
    assert.deepEqual(bindingKeys, [[':p1', ':p2']]);
  });
});

it('mutated dialect functions and mixed placeholder spellings retain ordinary binding', async () => {
  const original = sqliteDialect.paramPlaceholder;
  try {
    sqliteDialect.paramPlaceholder = (i: number) => `$p${i}`;
    await fixture(async ({ client, bare, bindingKeys }) => {
      const rows = await client.table('items').createMany({ data: [{ id: 1, n: 2 }] });
      assert.equal((rows[0] as { n: number }).n, 2);
      assert.deepEqual(bare, []);
      assert.deepEqual(bindingKeys, [['p1', 'p2']]);
    });
  } finally {
    sqliteDialect.paramPlaceholder = original;
  }
  const dialect = {
    ...sqliteDialect,
    paramPlaceholder(i: number) {
      this.paramPlaceholder = original;
      return `$p${i}`;
    },
  };
  await fixture(async ({ client, bare, bindingKeys, inserts }) => {
    const rows = await client.table('items').createMany({ data: [{ id: 3, n: 4 }] });
    assert.equal((rows[0] as { n: number }).n, 4);
    assert.match(inserts[0]!, /VALUES \(\$p1, :p2\)/);
    assert.deepEqual(bare, []);
    assert.deepEqual(bindingKeys, [['p1', 'p2']]);
  }, dialect);
});

it('full returning keeps every field and exact value across bulk chunks and fresh executions', async () => {
  await fixture(async ({ client, handle, bare }) => {
    const createdAt = new Date('2023-11-14T22:13:20.000Z');
    const data = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      displayName: `row ${i}`,
      enabled: i % 2 === 0,
      payload: { i, values: [false, null] },
      createdAt,
      bytes: Uint8Array.of(i % 256, 255),
      exact: 9007199254740993n,
      n: i,
    }));
    const rows = await client.table('items').createMany({ data });
    assert.deepEqual(
      rows,
      data.map((r) => ({
        ...r,
        exact: '9007199254740993',
        enabled: reportsTypes ? r.enabled : Number(r.enabled),
        payload: reportsTypes ? r.payload : JSON.stringify(r.payload),
      })),
    );
    assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM items').get()!.n, 1000);
    assert.ok(bare.length > 1);
    assert.ok(bare.every((v) => v === false));
    const stored = handle.prepare('SELECT id,display_name,n,exact FROM items ORDER BY id');
    stored.setReadBigInts(true);
    assert.deepEqual(
      stored.all().map((row) => ({ ...row })),
      data.map((r) =>
        Object.assign(
          {},
          {
            id: BigInt(r.id),
            display_name: r.displayName,
            n: BigInt(r.n),
            exact: r.exact,
          },
        ),
      ),
    );
    handle.exec('DELETE FROM items');
    const result = await client.table('items').createMany({ data: [{ id: 9, displayName: 'new', n: 1 }] });
    assert.equal((result[0] as { displayName: string }).displayName, 'new');
  });
});

it('late constraint failure rolls back every bulk chunk, and validation sends no partial writes', async () => {
  await fixture(async ({ client, handle, inserts }) => {
    const data = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, n: i === 199 ? -1 : i }));
    await assert.rejects(client.table('items').createMany({ data }), { code: 'TURBINE_E011' });
    assert.ok(inserts.length > 1);
    assert.equal(handle.prepare('SELECT COUNT(*) AS n FROM items').get()!.n, 0);
    for (const rows of [
      [{ id: 1, n: 1 }, { id: 2 }],
      [{ id: 1 }, { id: 2, n: 1 }],
    ]) {
      const before = inserts.length;
      await assert.rejects(client.table('items').createMany({ data: rows }), { code: 'TURBINE_E003' });
      assert.equal(inserts.length, before);
    }
    if (typeof handle.isTransaction === 'boolean') assert.equal(handle.isTransaction, false);
    else handle.exec('BEGIN; ROLLBACK;');
  });
});
