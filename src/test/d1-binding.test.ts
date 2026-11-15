import assert from 'node:assert/strict';
import { test } from 'node:test';
import { D1Pool } from '../d1/pool.js';
import { d1Param, d1StatementSql } from '../d1/sql.js';
import type { D1DatabaseBinding, D1PreparedStatement, D1Result } from '../d1/types.js';
import { d1Dialect, turbineD1 } from '../d1.js';
import { InvariantError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { definition } from './fixtures/d1/schema.js';

const schema = schemaDefToMetadata(definition);

/** Recording contract fixture only; native SQL evidence lives in fixtures/d1/runtime.test.ts. */
function fixture() {
  const calls: string[] = [];
  const result: D1Result = { success: true, results: [], meta: { changes: 0, duration: 0, last_row_id: 0 } };
  let finish = async () => result;
  const binding: D1DatabaseBinding = {
    prepare(sql) {
      calls.push(`prepare:${sql}`);
      const statement: D1PreparedStatement = {
        bind(...params) {
          calls.push(`bind:${params.length}`);
          return statement;
        },
        all: async () => (await finish()) as never,
      };
      return statement;
    },
    async batch(statements) {
      calls.push(`batch:${statements.length}`);
      return (await Promise.all(statements.map((statement) => statement.all()))) as never;
    },
  };
  return {
    binding,
    calls,
    result,
    finish: (fn: typeof finish) => {
      finish = fn;
    },
  };
}

test('D1 SQL preflight preserves numbered, reordered and repeated bindings outside quoted text', () => {
  const sql = `/* ?99 */ SELECT $2, $1, $2, '?1;BEGIN', "semi;?88", [x;?66], \`x;?77\` -- ?55\n;`;
  assert.equal(d1StatementSql(sql, 2), sql.replace('$2', '?2').replace('$1', '?1').replace('$2', '?2'));
  assert.equal(d1StatementSql('SELECT ?2,?1,?2', 2), 'SELECT ?2,?1,?2');
  assert.equal(
    d1StatementSql("SELECT 'COMMIT;DELETE', 1; -- trailing comment", 0),
    "SELECT 'COMMIT;DELETE', 1; -- trailing comment",
  );
});

test('D1 rejects multiple statements, session/schema SQL and invalid bindings before preparation', async () => {
  const f = fixture();
  const pool = new D1Pool(f.binding);
  const cases = [
    ['SELECT 1; SELECT 2', []],
    ['SELECT 1;;', []],
    ['BEGIN', []],
    ['COMMIT', []],
    ['SAVEPOINT x', []],
    ['PRAGMA foreign_keys=OFF', []],
    ['CREATE TABLE x(id)', []],
    ['ALTER TABLE x ADD COLUMN n', []],
    ["ATTACH DATABASE 'x' AS other", []],
    ['VACUUM', []],
    ['SELECT ?', [1]],
    ['SELECT ?0', [1]],
    ['SELECT ?2', [1]],
    ['SELECT $0', [1]],
    ['SELECT :p1', [1]],
    ['SELECT $name', [1]],
    ['SELECT 1', [1]],
    ["SELECT 'unterminated", []],
    ['SELECT /* unterminated', []],
    ['SELECT \u0000', []],
  ] as const;
  for (const [sql, params] of cases) {
    await assert.rejects(pool.query(sql, [...params]), { code: /TURBINE_E003|TURBINE_E017/ });
  }
  await assert.rejects(pool.batch([{ sql: 'DELETE FROM posts' }, { sql: 'COMMIT' }]), UnsupportedFeatureError);
  await assert.rejects(pool.batch([{ sql: 'SELECT ?1', params: Array(101).fill(1) }]), ValidationError);
  assert.deepEqual(f.calls, []);
});

test('D1 values preserve binary slices, booleans, safe BigInt, JSON, dates and nulls', () => {
  const buffer = new Uint8Array([9, 1, 2, 9]);
  const view = new DataView(buffer.buffer, 1, 2);
  assert.deepEqual(new Uint8Array(d1Param(view) as ArrayBuffer), new Uint8Array([1, 2]));
  assert.deepEqual(new Uint8Array(d1Param(buffer.subarray(1, 3)) as ArrayBuffer), new Uint8Array([1, 2]));
  const admitted = d1Param(buffer.buffer) as ArrayBuffer;
  buffer.fill(7);
  assert.deepEqual(new Uint8Array(admitted), new Uint8Array([9, 1, 2, 9]));
  assert.equal(d1Param(true), 1);
  assert.equal(d1Param(false), 0);
  assert.equal(d1Param(12n), 12);
  assert.equal(d1Param(undefined), null);
  assert.equal(d1Param(null), null);
  assert.equal(d1Param(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(d1Param({ x: [true] }), '{"x":[true]}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [NaN, Infinity, 2 ** 53, 2n ** 53n, new Date(NaN), Symbol(), () => 1, circular]) {
    assert.throws(() => d1Param(value), ValidationError);
  }
});

test('D1 raw batch preflight, cancellation, ordered metadata and malformed reply controls', async () => {
  const f = fixture();
  const db = turbineD1(f.binding, schema, { warnOnUnlimited: false });
  const control = new AbortController();
  const reason = new Error('cancelled before dispatch');
  control.abort(reason);
  await assert.rejects(db.$batchRaw([{ sql: 'SELECT 1' }], { signal: control.signal }), (error) => error === reason);
  await assert.rejects(
    db.$batchRaw([{ sql: 'DELETE FROM posts' }, { sql: 'SELECT ?1', params: [2n ** 53n] }]),
    ValidationError,
  );
  assert.deepEqual(await db.$batchRaw([]), []);
  assert.deepEqual(f.calls, []);
  const results = await db.$batchRaw([{ sql: 'SELECT ?1', params: [true] }, { sql: 'SELECT 2' }]);
  assert.equal(results.length, 2);
  assert.equal(results[0]?.meta.duration, 0);
  assert.deepEqual(f.calls, ['prepare:SELECT ?1', 'bind:1', 'prepare:SELECT 2', 'batch:2']);
  const malformed = new D1Pool({ ...f.binding, batch: async () => [] });
  await assert.rejects(malformed.batch([{ sql: 'DELETE FROM posts' }]), InvariantError);
  f.result.success = false;
  await assert.rejects(db.rawUnsafe('SELECT 1'), InvariantError);
});

test('D1 batch does not pretend that abort after dispatch cancels native execution', async () => {
  const f = fixture();
  let release!: (value: D1Result) => void;
  f.finish(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const control = new AbortController();
  const db = turbineD1(f.binding, schema);
  const pending = db.$batchRaw([{ sql: 'DELETE FROM posts' }], { signal: control.signal });
  control.abort(new Error('too late'));
  release(f.result);
  assert.deepEqual(await pending, [f.result]);
  assert(f.calls.includes('batch:1'));
});

test('D1 deferred batch rejects cross-client ownership and unsupported plans before side effects', async () => {
  const f = fixture();
  const first = turbineD1(f.binding, schema, { warnOnUnlimited: false });
  const second = turbineD1(f.binding, schema, { warnOnUnlimited: false });
  await assert.rejects(first.$batch([second.table('posts').buildCount()]), /this facade/);
  const query = first.table('posts').buildCount();
  query.reselect = async () => ({ rows: [], rowCount: 0 });
  await assert.rejects(first.$batch([query]), /single-statement/);
  assert.deepEqual(f.calls, []);
});

test('D1 native post-commit transforms do not promise client-side error rollback', async () => {
  const f = fixture();
  const db = turbineD1(f.binding, schema, { warnOnUnlimited: false });
  const query = db.table('posts').buildCount();
  const reason = new Error('transform failed after native success');
  query.transform = () => {
    throw reason;
  };
  await assert.rejects(db.$batch([query]), (error) => error === reason);
  assert(f.calls.includes('batch:1'));
});

test('D1 lifecycle seals hoisted and lazy APIs, while leaving supplied binding available', async () => {
  const f = fixture();
  const db = turbineD1(f.binding, schema, { warnOnUnlimited: false });
  const table = db.table('users');
  const lazy = db.sql`SELECT ${1}`;
  const deferred = table.buildCount();
  await db.connect();
  assert.deepEqual(f.calls, []);
  await db.disconnect();
  await db.end();
  assert.throws(() => table.count(), /disconnected/);
  await assert.rejects(Promise.resolve(lazy), /disconnected/);
  await assert.rejects(db.$batch([deferred]), /disconnected/);
  await f.binding.prepare('SELECT 1').all();
  assert.deepEqual(f.calls, ['prepare:SELECT 1']);
});

test('D1 uses the portable SQLite SQL and schema generation with explicit native lifecycle refusals', () => {
  const statements = schemaToSQL(definition, { dialect: d1Dialect });
  assert(statements.length >= 2);
  assert(statements.some((sql) => sql.includes('INTEGER PRIMARY KEY AUTOINCREMENT')));
  assert.equal(d1Dialect.capabilities.maxBindParameters, 100);
  assert.throws(() => d1Dialect.beginStatement(), UnsupportedFeatureError);
  assert.throws(() => d1Dialect.buildMigrationTrackingTable('history'), UnsupportedFeatureError);
  assert.throws(() => d1Dialect.openStream({} as never, '', [], 1), UnsupportedFeatureError);
  assert.throws(() => turbineD1({} as never, schema), /supplied Worker D1Database/);
  const f = fixture();
  assert.throws(() => turbineD1(f.binding, schema, { globalFilters: { missing: { id: 1 } } }), /names no table/);
  assert.throws(() => turbineD1(f.binding, schema, { dialect: d1Dialect } as never), UnsupportedFeatureError);
  assert.deepEqual(f.calls, []);
});

test('D1 disconnect seals immediately and drains an admitted native batch without closing its binding', async () => {
  const f = fixture();
  let release!: (value: D1Result) => void;
  f.finish(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const db = turbineD1(f.binding, schema);
  const lazy = db.sql`DELETE FROM posts`;
  const pending = db.$batchRaw([{ sql: 'DELETE FROM posts' }]);
  let disconnected = false;
  const ending = db.disconnect().then(() => {
    disconnected = true;
  });
  await Promise.resolve();
  assert.equal(disconnected, false);
  await assert.rejects(db.rawUnsafe('SELECT 1'), /disconnected/);
  const before = f.calls.length;
  await assert.rejects(Promise.resolve(lazy), /disconnected/);
  assert.equal(f.calls.length, before, 'no lazy statement may prepare while a batch drains');
  release(f.result);
  await Promise.all([pending, ending]);
  assert.equal(disconnected, true);
  f.finish(async () => f.result);
  await f.binding.prepare('SELECT 1').all();
  assert.equal(f.calls.at(-1), 'prepare:SELECT 1');
});

test('D1 raw batches retain admitted cardinality after caller array reuse', async () => {
  const f = fixture();
  let release!: (value: D1Result) => void;
  f.finish(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const db = turbineD1(f.binding, schema);
  const statements = [{ sql: 'SELECT 1' }];
  const pending = db.$batchRaw(statements);
  statements.length = 0;
  release(f.result);
  assert.deepEqual(await pending, [f.result]);
  await db.disconnect();
});

test('D1 typed batches retain admitted membership, transform functions and receivers', async () => {
  const f = fixture();
  let release!: (value: D1Result) => void;
  const held = new Promise<D1Result>((resolve) => {
    release = resolve;
  });
  f.finish(() => held);
  f.result.results = [{ count: 3 }];
  const db = turbineD1(f.binding, schema);
  const first = db.table('posts').buildCount();
  const second = db.table('posts').buildCount();
  second.transform = function (this: unknown, result) {
    assert.equal(this, second);
    return Number(result.rows[0]?.count) * 2;
  };
  const queries = [first, second];
  const pending = db.$batch(queries);
  queries.reverse();
  first.transform = () => -999;
  release(f.result);
  assert.deepEqual(await pending, [3, 6]);
  await db.disconnect();
});
