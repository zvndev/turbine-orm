/**
 * Differential: generated bulk INSERTs bound positionally on a genuine native
 * handle must be indistinguishable from the ordinary named-parameter path:
 * same rows written, same returned rows (values, types, key order), same
 * errors, same statement events. The reference is the same built statement
 * executed with a copied params array, which the bulk marker does not
 * recognize and which therefore keeps ordinary named binding.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { type BetterSqlite3Database, betterSqlite3Dialect, turbineBetterSqlite3 } from '../better-sqlite3.js';
import { TurbineClient } from '../client.js';
import type { Dialect } from '../dialect.js';
import { recordSqliteBulkInsert, SqlitePool, sqliteDialect } from '../sqlite.js';
import { mockTable, skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const reportsTypes = typeof native?.StatementSync.prototype.columns === 'function';

const requirePeer = createRequire(import.meta.url);
const peer = (() => {
  try {
    return requirePeer(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3') as new (
      path: string,
    ) => BetterSqlite3Database;
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();

const DDL = `CREATE TABLE items(id INTEGER PRIMARY KEY, slug TEXT UNIQUE, display_name TEXT,
  enabled BOOLEAN, payload TEXT, created_at TEXT, bytes BLOB, exact INTEGER, n INTEGER CHECK(n >= 0))`;

function schema() {
  const s = {
    enums: {},
    tables: {
      items: mockTable(
        'items',
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'slug', field: 'slug', pgType: 'text', unique: true },
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
  s.tables.items.dateColumns.add('created_at');
  return s;
}

/** A plain, unwrapped node:sqlite pool + client (the positional fast path). */
function openNode() {
  const handle = new native!.DatabaseSync(':memory:');
  handle.exec(DDL);
  const s = schema();
  const pool = new SqlitePool(handle, { schema: s });
  const client = new TurbineClient({ pool, dialect: sqliteDialect, preparedStatements: false }, s);
  return { handle, pool, client };
}

const createdAt = new Date('2023-11-14T22:13:20.000Z');
function generated(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    slug: `slug-${i}`,
    displayName: i % 7 === 0 ? 'literal :p1 ? $2 :p99' : i % 5 === 0 ? '' : `row ${i} ünicode`,
    enabled: i % 3 === 0 ? null : i % 2 === 0,
    payload: i % 4 === 0 ? null : { i, nested: [true, null, 'x:p3'] },
    createdAt,
    bytes: i % 6 === 0 ? null : Uint8Array.of(i % 256, 0, 255),
    exact: i % 2 === 0 ? 9007199254740993n : -9007199254740993n,
    n: i % 11 === 0 ? null : i,
  }));
}

/** Whole-table dump through the raw handle, bigints as strings, blobs as arrays. */
function dump(handle: InstanceType<NonNullable<typeof native>['DatabaseSync']>) {
  const stmt = handle.prepare('SELECT * FROM items ORDER BY id');
  stmt.setReadBigInts(true);
  return stmt
    .all()
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [
          k,
          typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? [...v] : v,
        ]),
      ),
    );
}

async function closeNode(f: ReturnType<typeof openNode>) {
  await f.client.disconnect();
  await f.pool.end();
  if (f.handle.isOpen) f.handle.close();
}

const { it: itNode } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');

itNode('positional bulk binding writes and returns exactly what named binding does', async () => {
  const fast = openNode();
  const reference = openNode();
  try {
    const data = generated(300);
    const rows = await fast.client.table('items').createMany({ data });
    // Reference: one built statement, copied params (ordinary named binding).
    const q = reference.client.table('items').buildCreateMany({ data });
    const refResult = await reference.pool.query(q.sql, [...q.params]);
    assert.equal(refResult.rows.length, 300);
    assert.deepEqual(dump(fast.handle), dump(reference.handle));
    // Returned rows: same values, types and key order as a read of the reference DB.
    const fastRead = await fast.client.table('items').findMany({ orderBy: { id: 'asc' } });
    const refRead = await reference.client.table('items').findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(fastRead, refRead);
    assert.equal(JSON.stringify(rows), JSON.stringify(fastRead));
    assert.deepEqual(
      rows.slice(0, 2),
      data.slice(0, 2).map((r) => ({
        ...r,
        exact: r.exact.toString(),
        enabled: !reportsTypes && r.enabled !== null ? Number(r.enabled) : r.enabled,
        payload: !reportsTypes && r.payload !== null ? JSON.stringify(r.payload) : r.payload,
      })),
    );
  } finally {
    await closeNode(fast);
    await closeNode(reference);
  }
});

itNode('returning: false, skipDuplicates and onConflict keep their results', async () => {
  const fast = openNode();
  try {
    const data = generated(120);
    assert.deepEqual(await fast.client.table('items').createMany({ data, returning: false }), { count: 120 });
    const dupes = await fast.client
      .table('items')
      .createMany({ data: [data[0]!, { ...data[1]!, id: 10_001, slug: 'slug-new' }, data[2]!], skipDuplicates: true });
    assert.deepEqual(
      dupes.map((r) => (r as { id: number }).id),
      [10_001],
    );
    const upserted = await fast.client.table('items').createMany({
      data: [{ ...data[3]!, n: 4242 }],
      onConflict: { target: ['slug'], update: { n: 4242 } },
    });
    assert.equal((upserted[0] as { n: number }).n, 4242);
    assert.equal(fast.handle.prepare('SELECT COUNT(*) AS c FROM items').get()!.c, 121);
  } finally {
    await closeNode(fast);
  }
});

itNode('a late constraint failure rejects identically and rolls back every chunk', async () => {
  const fast = openNode();
  try {
    const data = generated(200).map((r, i) => (i === 199 ? { ...r, n: -1 } : r));
    await assert.rejects(fast.client.table('items').createMany({ data }), { code: 'TURBINE_E011' });
    assert.equal(fast.handle.prepare('SELECT COUNT(*) AS c FROM items').get()!.c, 0);
    assert.equal(fast.handle.isTransaction, false);
  } finally {
    await closeNode(fast);
  }
});

itNode('sparse and undefined bulk slots bind NULL positionally without shifting', async () => {
  const fast = openNode();
  const reference = openNode();
  try {
    const q = fast.client.table('items').buildCreateMany({ data: [{ id: 1, slug: 'a', displayName: 'x', n: 7 }] });
    delete q.params[2];
    const got = await fast.pool.query(q.sql, q.params);
    const q2 = reference.client
      .table('items')
      .buildCreateMany({ data: [{ id: 1, slug: 'a', displayName: 'x', n: 7 }] });
    delete q2.params[2];
    const want = await reference.pool.query(q2.sql, [...q2.params]);
    assert.deepEqual(got.rows, want.rows);
    assert.equal(got.rows[0].display_name, null);
    assert.equal(got.rows[0].n, 7);
  } finally {
    await closeNode(fast);
    await closeNode(reference);
  }
});

itNode('createMany inside $transaction and statement events keep the named SQL text', async () => {
  const fast = openNode();
  try {
    const events: { sql: string; params?: unknown[] }[] = [];
    fast.client.$on('query', (e) => events.push(e as { sql: string; params?: unknown[] }));
    await fast.client.$transaction(async (tx) => {
      await tx.table('items').createMany({ data: generated(50) });
    });
    assert.equal(fast.handle.prepare('SELECT COUNT(*) AS c FROM items').get()!.c, 50);
    const inserts = events.filter((e) => /^\s*INSERT\b/i.test(e.sql));
    assert.ok(inserts.length >= 1);
    for (const e of inserts) {
      assert.match(e.sql, /:p1\b/, 'observers still see the generated named placeholders');
      assert.doesNotMatch(e.sql, /VALUES \(\?/, 'positional rewrite stays below the event layer');
    }
  } finally {
    await closeNode(fast);
  }
});

itNode('an ineligible handle receives the named binding its dialect always used', async () => {
  // A wrapped prepare can observe the statement, so it never binds
  // positionally. What it receives instead is the binding each dialect sent
  // before positional binding existed: qualified `:pN` keys with bare-name
  // lookup disabled for the node:sqlite dialect, plain `{ p1 }` keys for
  // the better-sqlite3 dialect (qualified keys make its adapter copy the
  // binding object key by key).
  const cases: { dialect: Dialect; keys: string[]; bare: boolean[] }[] = [
    { dialect: sqliteDialect, keys: [':p1', ':p2'], bare: [false] },
    { dialect: betterSqlite3Dialect as Dialect, keys: ['p1', 'p2'], bare: [] },
  ];
  for (const { dialect, keys, bare: wantBare } of cases) {
    const handle = new native!.DatabaseSync(':memory:');
    handle.exec(DDL);
    const s = schema();
    const inserts: string[] = [];
    const bindingKeys: string[][] = [];
    const bare: boolean[] = [];
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
    }) as InstanceType<NonNullable<typeof native>['DatabaseSync']>['prepare'];
    const pool = new SqlitePool(handle, { schema: s });
    const client = new TurbineClient({ pool, dialect, preparedStatements: false }, s);
    try {
      const q = client.table('items').buildCreateMany({ data: [{ id: 1, slug: 'one' }] });
      const result = await pool.query(q.sql, q.params);
      assert.equal(result.rows[0].slug, 'one');
      assert.deepEqual(inserts, [q.sql], 'the handle sees the generated named SQL, never the ? spelling');
      assert.deepEqual(bindingKeys, [keys]);
      assert.deepEqual(bare, wantBare);
    } finally {
      await client.disconnect();
      await pool.end();
      if (handle.isOpen) handle.close();
    }
  }
});

itNode('identifiers containing parameter-like text keep named bulk binding', async () => {
  // The positional spelling is derived textually, so a quoted identifier
  // containing `:p<digits>` must refuse the rewrite: deriving anyway would
  // prepare a statement against a table named `we?ird`. The handle is
  // genuine and eligible, so only the in-order/count check stands between
  // this createMany and the rewrite.
  const handle = new native!.DatabaseSync(':memory:');
  handle.exec(
    'CREATE TABLE "we:p1ird"(id INTEGER PRIMARY KEY, "id:p2" TEXT, ":p3" TEXT, "?1" TEXT, "?" TEXT);' +
      'CREATE TABLE plain_t(id INTEGER PRIMARY KEY, "x:p2" TEXT DEFAULT \'zz\')',
  );
  const s = {
    enums: {},
    tables: {
      'we:p1ird': mockTable(
        'we:p1ird',
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'id:p2', field: 'second', pgType: 'text' },
          { name: ':p3', field: 'third', pgType: 'text' },
          { name: '?1', field: 'fourth', pgType: 'text' },
          { name: '?', field: 'fifth', pgType: 'text' },
        ],
        {},
        ['id'],
      ),
      plain_t: mockTable(
        'plain_t',
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'x:p2', field: 'y', pgType: 'text' },
        ],
        {},
        ['id'],
      ),
    },
  };
  const pool = new SqlitePool(handle, { schema: s });
  const client = new TurbineClient({ pool, dialect: sqliteDialect, preparedStatements: false }, s);
  try {
    const data = [
      { id: 1, second: 'a:p1', third: 'b?1', fourth: 'c?', fifth: 'd' },
      { id: 2, second: 'e', third: 'f', fourth: 'g', fifth: 'h:p9' },
    ];
    const rows = await client.table('we:p1ird').createMany({ data });
    assert.deepEqual(rows, data);
    assert.deepEqual(
      handle
        .prepare('SELECT * FROM "we:p1ird" ORDER BY id')
        .all()
        .map((r) => ({ ...r })),
      [
        { id: 1, 'id:p2': 'a:p1', ':p3': 'b?1', '?1': 'c?', '?': 'd' },
        { id: 2, 'id:p2': 'e', ':p3': 'f', '?1': 'g', '?': 'h:p9' },
      ],
    );
    // The count half on its own: here the only parameter-like token is in
    // the RETURNING list, continuing the sequence (:p1 in VALUES, "x:p2"
    // after it), so the token order looks perfect and only `seen === count`
    // refuses the rewrite.
    const returned = await client.table('plain_t').createMany({ data: [{ id: 1 }], select: { id: true, y: true } });
    assert.deepEqual(returned, [{ id: 1, y: 'zz' }]);
  } finally {
    await client.disconnect();
    await pool.end();
    if (handle.isOpen) handle.close();
  }
});

itNode('recorded text that only looks like :p1..:pN in order binds exactly as named binding does', async () => {
  // recordSqliteBulkInsert is the seam the dialects record through; driving
  // it directly puts arbitrary text in front of the derivation. Every case
  // must give the named-binding result on an eligible handle: bind
  // positionally only when the text is provably the generated sequence,
  // otherwise fall back. The reference is the same statement with copied
  // params, which the marker does not recognize.
  const setup = (handle: InstanceType<NonNullable<typeof native>['DatabaseSync']>) => {
    handle.exec(
      'CREATE TABLE t(a TEXT, b TEXT); CREATE TABLE "we:p1ird"(a TEXT, b TEXT);' +
        'CREATE TABLE t2("id:p2" TEXT, b TEXT); CREATE TABLE t3("?" TEXT, b TEXT)',
    );
    const pool = new SqlitePool(handle, { schema: schema() });
    const dumpAll = () => ({
      t: handle.prepare('SELECT * FROM t').all(),
      weird: handle.prepare('SELECT * FROM "we:p1ird"').all(),
      t2: handle.prepare('SELECT * FROM t2').all(),
      t3: handle.prepare('SELECT * FROM t3').all(),
    });
    const clear = () => handle.exec('DELETE FROM t; DELETE FROM "we:p1ird"; DELETE FROM t2; DELETE FROM t3');
    return { pool, dumpAll, clear };
  };
  const fastHandle = new native!.DatabaseSync(':memory:');
  const refHandle = new native!.DatabaseSync(':memory:');
  const fast = setup(fastHandle);
  const ref = setup(refHandle);
  const cases: { name: string; sql: string; values: unknown[] }[] = [
    { name: 'plain in-order', sql: 'INSERT INTO t VALUES (:p1, :p2) RETURNING *', values: ['x', 'y'] },
    { name: 'parameter used twice', sql: 'INSERT INTO t VALUES (:p1, :p1) RETURNING *', values: ['x'] },
    { name: 'out of order', sql: 'INSERT INTO t VALUES (:p2, :p1) RETURNING *', values: ['first', 'second'] },
    { name: 'literal :p2', sql: "INSERT INTO t VALUES (:p1, ':p2') RETURNING *", values: ['x'] },
    { name: 'literal ?1 and ?', sql: "INSERT INTO t VALUES (:p1, '?1 ?') RETURNING *", values: ['x'] },
    { name: 'block comment', sql: 'INSERT INTO t VALUES (:p1 /* :p9 ?1 */, :p2) RETURNING *', values: ['x', 'y'] },
    { name: 'line comment', sql: 'INSERT INTO t VALUES (:p1, -- :p9\n :p2) RETURNING *', values: ['x', 'y'] },
    { name: 'table identifier', sql: 'INSERT INTO "we:p1ird" VALUES (:p1, :p2) RETURNING *', values: ['x', 'y'] },
    {
      name: 'column identifier',
      sql: 'INSERT INTO t2 ("id:p2", b) VALUES (:p1, :p2) RETURNING *',
      values: ['x', 'y'],
    },
    { name: 'question identifier', sql: 'INSERT INTO t3 ("?", b) VALUES (:p1, :p2) RETURNING *', values: ['x', 'y'] },
    {
      name: 'returning aliases',
      sql: 'INSERT INTO t VALUES (:p1, :p2) RETURNING a AS ":p1", b AS "?1"',
      values: ['x', 'y'],
    },
    {
      name: 'literal in returning expression',
      sql: "INSERT INTO t VALUES (:p1, :p2) RETURNING a || ':p3' AS c, b",
      values: ['x', 'y'],
    },
  ];
  try {
    for (const { name, sql, values } of cases) {
      fast.clear();
      ref.clear();
      const params = [...values];
      recordSqliteBulkInsert(params, sql);
      const got = await fast.pool.query(sql, params);
      const want = await ref.pool.query(sql, [...values]);
      assert.deepEqual(got.rows, want.rows, name);
      assert.deepEqual(fast.dumpAll(), ref.dumpAll(), name);
    }
  } finally {
    await fast.pool.end();
    await ref.pool.end();
    if (fastHandle.isOpen) fastHandle.close();
    if (refHandle.isOpen) refHandle.close();
  }
});

describe('positional bulk binding (better-sqlite3)', {
  skip: !peer && 'optional better-sqlite3 peer not installed',
}, () => {
  // The handle comes from TURBINE_SQLITE_BINDING_PEER like the rest of the
  // binding tests: CI installs the peer outside the repository, where the
  // factory's bare-name load cannot resolve it. The path-owned case, the
  // one that binds positionally, is checked by the installed consumer,
  // fixtures/sqlite-binding-consumer.mjs, where the bare name resolves as
  // it does in an application.
  it('supplied-handle createMany matches the node:sqlite result row for row', async () => {
    if (!native) return;
    const fast = openNode();
    const raw = new peer!(':memory:');
    const db = await turbineBetterSqlite3(raw, schema(), { logger: {} });
    try {
      await db.rawUnsafe(DDL);
      const data = generated(150);
      const a = await fast.client.table('items').createMany({ data });
      const b = await db.table('items').createMany({ data });
      assert.equal(JSON.stringify(b), JSON.stringify(a));
      const read = await db.table('items').findMany({ orderBy: { id: 'asc' } });
      assert.equal(JSON.stringify(read), JSON.stringify(a));
    } finally {
      await closeNode(fast);
      await db.disconnect();
      await db.pool.end();
      if (raw.open) raw.close();
    }
  });
});
