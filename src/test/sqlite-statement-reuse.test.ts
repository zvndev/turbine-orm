/** Reused native statements still describe the executed projection and bind every call. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { SqlitePool, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
type AuthorizingDatabase = { setAuthorizer(callback: (action: number) => number): void };
const authorizerCodes = native?.constants as unknown as { SQLITE_READ: number; SQLITE_DENY: number; SQLITE_OK: number };

function owned(schema = { tables: {}, enums: {} }, file = ':memory:'): SqlitePool {
  return turbineSqlite(file, schema, { logger: {} }).pool as SqlitePool;
}

/** Test SQL is fixed here, with no semicolons inside literals or trigger bodies. */
async function exec(pools: SqlitePool[], sql: string): Promise<void> {
  for (const statement of sql.split(';')) {
    if (statement.trim()) for (const pool of pools) await pool.query(statement);
  }
}

/**
 * Whether this runtime's wildcard reader follows a reprepare, asked the way the
 * product asks it: the reader is `all()` unless `all()` loses a column added
 * between prepare and the first step (then `iterate()`), and it must follow a
 * grow and a shrink of a statement that already ran.
 */
const wildcardReuse = (() => {
  if (!native) return false;
  const { all, iterate } = native.StatementSync.prototype;
  if (typeof iterate !== 'function') return false;
  const read = (reader: typeof all | typeof iterate, stmt: object) => [
    ...(Reflect.apply(reader, stmt, []) as Iterable<Record<string, unknown>>),
  ];
  let reader: typeof all | typeof iterate = iterate;
  const first = new native.DatabaseSync(':memory:');
  try {
    first.exec('CREATE TABLE t(a); INSERT INTO t VALUES(1)');
    const stmt = first.prepare('SELECT *, 2 AS b FROM t');
    first.exec('ALTER TABLE t ADD COLUMN b DEFAULT 3');
    const [row, ...rest] = read(all, stmt);
    if (row && rest.length === 0 && Object.keys(row).length === 2 && row.a === 1 && row.b === 2) reader = all;
  } catch {
    // An all() that cannot answer is not trusted with a wildcard.
  } finally {
    first.close();
  }
  const db = new native.DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE t(a); INSERT INTO t VALUES(1)');
    const stmt = db.prepare('SELECT * FROM t');
    read(reader, stmt);
    db.exec('ALTER TABLE t ADD COLUMN b DEFAULT 3');
    const grown = read(reader, stmt);
    db.exec('ALTER TABLE t DROP COLUMN b');
    const shrunk = read(reader, stmt);
    return (
      grown.length === 1 &&
      Object.keys(grown[0]!).length === 2 &&
      grown[0]!.b === 3 &&
      shrunk.length === 1 &&
      Object.keys(shrunk[0]!).length === 1
    );
  } catch {
    return false;
  } finally {
    db.close();
  }
})();

function retained(pool: SqlitePool, sql: string): object | undefined {
  const internals = pool as unknown as {
    queryPlans: { entries: Map<string, object> };
    statements: WeakMap<object, object>;
  };
  const plan = internals.queryPlans.entries.get(sql);
  return plan && internals.statements?.get(plan);
}

function exact(actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected);
  if (actual === null || typeof actual !== 'object') return;
  assert.equal(Object.getPrototypeOf(actual), Object.getPrototypeOf(expected));
  assert.deepEqual(Reflect.ownKeys(actual), Reflect.ownKeys(expected as object));
  for (const key of Reflect.ownKeys(actual)) {
    const a: PropertyDescriptor = Object.getOwnPropertyDescriptor(actual, key)!;
    const b: PropertyDescriptor = Object.getOwnPropertyDescriptor(expected, key)!;
    assert.deepEqual({ ...a, value: undefined }, { ...b, value: undefined });
    exact(a.value, b.value);
  }
}

it('reuses admitted native statements and drops them after errors or teardown', async () => {
  const pool = owned();
  const sql = 'SELECT $1 AS value';
  try {
    await pool.query(sql, [1]);
    const first = retained(pool, sql);
    assert.ok(first, 'a native statement is retained for the admitted shape');
    await pool.query(sql, [2]);
    assert.equal(retained(pool, sql), first);
    // An arity change gets another admission record, so old bindings cannot leak.
    assert.deepEqual((await pool.query(sql)).rows, [{ value: null }]);
    assert.notEqual(retained(pool, sql), first);
    await pool.query(sql, ['x'.repeat(8192)]);
    assert.equal(retained(pool, sql), undefined, 'large bindings are not retained');
    await pool.query(sql, [Uint8Array.of(1, 2)]);
    assert.equal(retained(pool, sql), undefined, 'caller objects are not retained');
    const date = new Date('2023-11-14T22:13:20.000Z');
    assert.deepEqual((await pool.query(sql, [date])).rows, [{ value: date.toISOString() }]);
    assert.ok(retained(pool, sql), 'dates retain only their converted native string');
    assert.deepEqual((await pool.query(sql, [{ ok: true }])).rows, [{ value: '{"ok":true}' }]);
    assert.ok(retained(pool, sql), 'small JSON values retain only their converted native string');
    await pool.query(sql, [{ large: 'x'.repeat(8192) }]);
    assert.equal(retained(pool, sql), undefined, 'the converted JSON payload participates in the cap');
    await pool.query('CREATE TABLE changing(v)');
    await pool.query('SELECT * FROM changing');
    await pool.query('DROP TABLE changing');
    await assert.rejects(pool.query('SELECT * FROM changing'), /no such table/);
    assert.equal(retained(pool, 'SELECT * FROM changing'), undefined);
    await exec(
      [pool],
      'CREATE TABLE large(v); WITH RECURSIVE n(v) AS (VALUES(1) UNION ALL SELECT v+1 FROM n WHERE v<129) INSERT INTO large SELECT v FROM n',
    );
    assert.equal((await pool.query('SELECT * FROM large')).rows.length, 129);
    assert.equal(retained(pool, 'SELECT * FROM large'), undefined, 'large results keep fresh native preparation');
    await pool.query('PRAGMA cache_size');
    assert.equal(retained(pool, 'PRAGMA cache_size'), undefined, 'prepare-time PRAGMAs are never retained');
    for (let i = 0; i < 140; i++) await pool.query(`SELECT ${i} AS value /* churn */`);
    assert.equal(retained(pool, 'SELECT 139 AS value /* churn */'), undefined, 'unadmitted shapes are not retained');
    await pool.end();
    assert.equal(retained(pool, sql), undefined);
  } finally {
    await pool.end();
  }
});

it('differentially matches fresh preparation over generated bindings, DDL and rollback', async () => {
  const schema = schemaDefToMetadata(defineSchema({ changing: { payload: { type: 'json' } } }));
  const pools = [owned(schema), owned(schema)];
  // The exposed native handle is the fresh-preparation reference path.
  void pools[1]!.db;
  const check = async (sql: string, params: unknown[] = []) => {
    const expected = await pools[1]!.query(sql, params);
    exact(await pools[0]!.query(sql, params), expected);
    return expected.rows;
  };
  try {
    const values = [null, 0, 1, -0, -3, 1.25, 9007199254740993n, '', 'null', '{"a":1}', Uint8Array.of(0, 255)];
    for (let round = 0; round < 4; round++) {
      await exec(
        pools,
        `DROP TABLE IF EXISTS changing; CREATE TABLE changing(v ${round % 2 ? 'INTEGER' : 'BOOLEAN'}, payload TEXT);
        INSERT INTO changing VALUES(1,'{"x":[true,null]}'),(0,'null'),(NULL,'invalid')`,
      );
      for (const sql of [
        'SELECT * FROM changing WHERE rowid=$1',
        'SELECT v AS "__proto__", payload AS "constructor", v+0 AS "1", v AS "toString" FROM changing WHERE rowid=$1',
        'SELECT v AS x, payload AS x, v+0 AS x FROM changing WHERE rowid=$1',
      ]) {
        for (const id of [1, 3, 2, 99, 1]) await check(sql, [id]);
      }
      for (const value of values)
        await check('SELECT $1 AS "__proto__", $2 AS "constructor", $1 AS "2"', [value, value]);
      for (const pool of pools) await pool.query('BEGIN');
      await exec(
        pools,
        "DROP TABLE changing; CREATE TABLE changing(v BOOLEAN,payload TEXT); INSERT INTO changing VALUES(1,'[]')",
      );
      await check('SELECT * FROM changing');
      for (const pool of pools) await pool.query('ROLLBACK');
      await check('SELECT * FROM changing');
      for (const pool of pools) await pool.query('SAVEPOINT s');
      await exec(pools, 'ALTER TABLE changing ADD COLUMN extra BOOLEAN DEFAULT 1');
      await check('SELECT * FROM changing');
      for (const pool of pools) {
        await pool.query('ROLLBACK TO s');
        await pool.query('RELEASE s');
      }
      await check('SELECT * FROM changing');
      await exec(pools, 'CREATE TEMP TABLE changing(v INTEGER); INSERT INTO temp.changing VALUES(0)');
      await check('SELECT * FROM changing');
      await exec(pools, 'DROP TABLE temp.changing');
      await check('SELECT * FROM changing');
    }
    for (const sql of ['SELECT abs(-9223372036854775808)', 'SELECT * FROM missing', 'SELECT 1; SELECT 2']) {
      const errors: unknown[] = [];
      for (const pool of pools) {
        try {
          await pool.query(sql);
          assert.fail('query must fail');
        } catch (error) {
          const e = error as Error & { code?: unknown; cause?: Error };
          errors.push([e.constructor, e.message, e.code, e.cause?.constructor, e.cause?.message]);
        }
      }
      exact(errors[0], errors[1]);
    }
  } finally {
    for (const pool of pools) await pool.end();
  }
});

it('reused writes and transaction controls preserve effects, change counts and rollback', async () => {
  const pools = [owned(), owned()];
  void pools[1]!.db;
  const check = async (sql: string, values: unknown[] = []) => {
    const expected = await pools[1]!.query(sql, values);
    const actual = await pools[0]!.query(sql, values);
    exact(actual, expected);
    return actual;
  };
  try {
    await check('CREATE TABLE effects(id INTEGER PRIMARY KEY, v INTEGER)');
    for (let i = 0; i < 4; i++) {
      await check('BEGIN');
      assert.ok(retained(pools[0]!, 'BEGIN'), 'transaction controls reuse native statements');
      const insert = await check('INSERT INTO effects(v) VALUES($1)', [i]);
      assert.equal(insert.rowCount, 1);
      assert.ok(retained(pools[0]!, 'INSERT INTO effects(v) VALUES($1)'));
      await check('SAVEPOINT s');
      await check('UPDATE effects SET v=$1 RETURNING *', [i + 10]);
      await check('ROLLBACK TO s');
      await check('RELEASE s');
      await check(i % 2 ? 'COMMIT' : 'ROLLBACK');
      await check('SELECT * FROM effects ORDER BY id');
      await check('SELECT * FROM effects ORDER BY id');
    }
    await check('DELETE FROM effects WHERE v=$1', [3]);
    await check('DELETE FROM effects RETURNING *');
    await check('SELECT * FROM effects');
  } finally {
    for (const pool of pools) await pool.end();
  }
});

it('wildcards keep fresh preparation on a builtin without native iteration', () => {
  const source = new URL('../sqlite.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    import { DatabaseSync, StatementSync } from 'node:sqlite';
    delete StatementSync.prototype.iterate;
    const { turbineSqlite } = await import(${JSON.stringify(source)});
    const pool = turbineSqlite(':memory:', { tables:{}, enums:{} }, {logger:{}}).pool;
    try {
      await pool.query('CREATE TABLE t(v)');
      await pool.query('INSERT INTO t VALUES(1)');
      await pool.query('SELECT * FROM t');
      const plan = pool.queryPlans.entries.get('SELECT * FROM t');
      assert.ok(plan);
      assert.equal(pool.statements.get(plan), undefined);
      await pool.query('ALTER TABLE t ADD COLUMN extra DEFAULT 2');
      assert.deepEqual((await pool.query('SELECT * FROM t')).rows, [{v:1,extra:2}]);
    } finally { await pool.end(); }
  `,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

it('a reused wildcard follows external grow, shrink and attached database replacement', {
  skip: !wildcardReuse && 'this runtime reads a wildcard width before stepping, so no wildcard is reused',
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-statement-reuse-'));
  const file = join(dir, 'db.sqlite');
  const pool = owned(undefined, file);
  const writer = new native!.DatabaseSync(file);
  try {
    writer.exec('CREATE TABLE changing(v INTEGER); INSERT INTO changing VALUES(1)');
    const sql = 'SELECT * FROM changing';
    await pool.query(sql);
    const stmt = retained(pool, sql);
    assert.ok(stmt);
    writer.exec('ALTER TABLE changing ADD COLUMN extra INTEGER DEFAULT 7');
    assert.deepEqual((await pool.query(sql)).rows, [{ v: 1, extra: 7 }]);
    assert.equal(retained(pool, sql), stmt, 'exercise native reprepare of the retained statement');
    writer.exec('ALTER TABLE changing DROP COLUMN extra');
    assert.deepEqual((await pool.query(sql)).rows, [{ v: 1 }]);
    await exec([pool], "ATTACH ':memory:' AS extra; CREATE TABLE extra.t(v INTEGER); INSERT INTO extra.t VALUES(2)");
    assert.deepEqual((await pool.query('SELECT * FROM extra.t')).rows, [{ v: 2 }]);
    await exec(
      [pool],
      "DETACH extra; ATTACH ':memory:' AS extra; CREATE TABLE extra.t(v TEXT); INSERT INTO extra.t VALUES('new')",
    );
    assert.deepEqual((await pool.query('SELECT * FROM extra.t')).rows, [{ v: 'new' }]);
  } finally {
    await pool.end();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('borrowed and exposed handles reauthorize each execution after a policy change', {
  skip: typeof (native?.DatabaseSync.prototype as AuthorizingDatabase | undefined)?.setAuthorizer !== 'function',
}, async () => {
  for (const borrowed of [true, false]) {
    const pool = borrowed
      ? new SqlitePool(new native!.DatabaseSync(':memory:'))
      : (turbineSqlite(':memory:', { tables: {}, enums: {} }, { logger: {} }).pool as SqlitePool);
    try {
      await pool.query('CREATE TABLE protected_values(v)');
      await pool.query('INSERT INTO protected_values VALUES(1)');
      await pool.query('SELECT * FROM protected_values');
      if (borrowed) assert.equal(retained(pool, 'SELECT * FROM protected_values'), undefined);
      else assert.equal(Boolean(retained(pool, 'SELECT * FROM protected_values')), wildcardReuse);
      const db = pool.db as typeof pool.db & AuthorizingDatabase;
      assert.equal(retained(pool, 'SELECT * FROM protected_values'), undefined);
      let allowed = true;
      db.setAuthorizer((action) =>
        action === authorizerCodes.SQLITE_READ && !allowed ? authorizerCodes.SQLITE_DENY : authorizerCodes.SQLITE_OK,
      );
      assert.deepEqual((await pool.query('SELECT * FROM protected_values')).rows, [{ v: 1 }]);
      allowed = false;
      await assert.rejects(pool.query('SELECT * FROM protected_values'), /prohibited|not authorized/);
      allowed = true;
      assert.deepEqual((await pool.query('SELECT * FROM protected_values')).rows, [{ v: 1 }]);
    } finally {
      await pool.end();
    }
  }
});

it('keeps the readonly native handle declaration usable by typed pool subclasses', async () => {
  const db = new native!.DatabaseSync(':memory:');
  class TypedPool extends SqlitePool {
    declare readonly db: typeof db;
  }
  const pool = new TypedPool(db);
  try {
    assert.equal(pool.db, db);
    assert.deepEqual((await pool.query('SELECT 1 AS value')).rows, [{ value: 1 }]);
  } finally {
    await pool.end();
  }
});

it('exposes the native handle through a readonly pool proxy without touching its private traps', async () => {
  const pool = owned();
  const sql = 'SELECT 1 AS value';
  let proxy: SqlitePool;
  proxy = new Proxy(pool, {
    get(target, key) {
      assert.ok(['query', 'connect', 'end', 'db'].includes(String(key)), 'only the public interface is forwarded');
      const value = Reflect.get(target, key, proxy);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set() {
      return false;
    },
  });
  try {
    assert.deepEqual((await proxy.query(sql)).rows, [{ value: 1 }]);
    assert.ok(retained(pool, sql));
    const handle = proxy.db;
    assert.equal(handle, pool.db);
    assert.equal(retained(pool, sql), undefined, 'proxy exposure disables reuse on the actual pool');
    assert.deepEqual((await proxy.query(sql)).rows, [{ value: 1 }]);
  } finally {
    await proxy.end();
  }
});
