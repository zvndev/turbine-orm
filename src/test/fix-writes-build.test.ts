/**
 * Single-row writes on the reselect engine (MySQL) and createMany planning,
 * build-only: the statements a recording pool sees, and every refusal.
 *
 * - `create` re-reads the inserted row by a key whose value is known exactly:
 *   a supplied key, the driver's insert id for a server-numbered key, or a
 *   unique key in data. A key filled by a non-numbering default is refused
 *   before the INSERT.
 * - `upsert` on MySQL looks the row up first whenever `create` could also
 *   collide on a unique key `where` does not pin.
 * - `update` / `upsert` lock and re-read by key when the write may move the row
 *   out of `where`, at any depth of the predicate.
 * - `createMany` is sized before any statement is built (bind parameters and
 *   SQL Server's 1000-row INSERT cap), and its statements share one deadline.
 * - Two rows sharing a key only under a collation are E003 on every engine.
 *
 * The live behaviour is in fix-writes-engines.integration.test.ts.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { postgresDialect } from '../dialect.js';
import { NotFoundError, TimeoutError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { col, expr } from '../index.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { otherCollidingUniqueKey } from '../query/compound-unique.js';
import { QueryInterface } from '../query/index.js';
import { explainConflictKeyCollision } from '../query/writes.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness drives untyped args
type Any = any;

function schema(): SchemaMetadata {
  const acct = mockTable('acct', [
    { name: 'id', field: 'id', pgType: 'char' },
    { name: 'org_id', field: 'orgId', pgType: 'int' },
    { name: 'secret', field: 'secret', pgType: 'varchar' },
    { name: 'email', field: 'email', pgType: 'varchar', unique: true },
  ]);
  const tasks = mockTable('tasks', [
    { name: 'id', field: 'id', pgType: 'int' },
    { name: 'status', field: 'status', pgType: 'varchar' },
    { name: 'version', field: 'version', pgType: 'int' },
    { name: 'deleted_at', field: 'deletedAt', pgType: 'datetime' },
  ]);
  const named = mockTable('named', [
    { name: 'id', field: 'id', pgType: 'int' },
    { name: 'name', field: 'name', pgType: 'varchar', unique: true },
    { name: 'status', field: 'status', pgType: 'varchar' },
    { name: 'nick', field: 'nick', pgType: 'varchar' },
  ]);
  // A nullable unique column with no default: absent from an INSERT it is NULL.
  named.uniqueColumns.push(['nick']);
  const nickCol = named.columns.find((c) => c.name === 'nick')!;
  nickCol.nullable = true;
  const wide = mockTable('wide', [
    { name: 'id', field: 'id', pgType: 'int' },
    { name: 'a', field: 'a', pgType: 'int' },
    { name: 'b', field: 'b', pgType: 'int' },
  ]);
  const nokey = mockTable('nokey', [{ name: 'note', field: 'note', pgType: 'varchar' }], {}, []);
  return { tables: { acct, tasks, named, wide, nokey }, enums: {} } as unknown as SchemaMetadata;
}

function withColumn(s: SchemaMetadata, table: string, column: string, patch: object): SchemaMetadata {
  Object.assign(s.tables[table]!.columns.find((c) => c.name === column)!, patch);
  return s;
}

interface Sent {
  sql: string;
  params: unknown[];
}

/**
 * A pool that records every statement and answers SELECTs from `rowsFor`, and
 * writes with `{ rowCount, insertId }`. `delayMs` slows every statement.
 */
function recording(
  dialect: Dialect,
  table: string,
  opts: {
    s?: SchemaMetadata;
    rowsFor?: (sql: string) => Record<string, unknown>[];
    insertId?: unknown;
    rowCount?: number;
    delayMs?: number;
    options?: Record<string, unknown>;
  } = {},
) {
  const sent: Sent[] = [];
  const query = async (text: unknown, values?: unknown[]) => {
    const sql = typeof text === 'string' ? text : (text as { text: string }).text;
    const params = typeof text === 'string' ? (values ?? []) : ((text as { values?: unknown[] }).values ?? []);
    sent.push({ sql, params });
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (/^\s*select/i.test(sql)) {
      const rows = opts.rowsFor?.(sql) ?? [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: opts.rowCount ?? 1, insertId: opts.insertId ?? 0 };
  };
  const qi: Any = new QueryInterface(
    { query, connect: async () => ({ query, release() {} }) } as Any,
    table,
    opts.s ?? schema(),
    undefined,
    { dialect, sqlCache: false, preparedStatements: false, warnOnUnlimited: false, ...opts.options },
  );
  return { qi, sent, sqls: () => sent.map((s) => s.sql) };
}

const e017 = (pattern: RegExp) => (err: unknown) => {
  assert.ok(err instanceof UnsupportedFeatureError, `expected UnsupportedFeatureError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E017');
  assert.match(err.message, pattern);
  return true;
};

const e003 = (pattern: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E003');
  assert.match(err.message, pattern);
  return true;
};

describe('MySQL create: the inserted row is re-read by a key whose value is known exactly', () => {
  it('a key filled by a non-numbering default (DEFAULT (UUID())) is refused before the INSERT', async () => {
    const { qi, sent } = recording(mysqlDialect, 'acct');
    await assert.rejects(
      qi.create({ data: { orgId: 2, secret: 's' } }),
      e017(/create on "acct" without "id" in data.*crypto\.randomUUID\(\)/),
    );
    assert.deepEqual(sent, [], 'nothing is sent, not even BEGIN');
  });

  it('the RETURNING engines are unaffected', () => {
    for (const dialect of [postgresDialect, sqliteDialect, mssqlDialect]) {
      assert.doesNotThrow(() => makeQuery('acct', schema(), { dialect }).buildCreate({ data: { orgId: 2 } }));
    }
  });

  it('a supplied key is re-read by its value', async () => {
    const { qi, sent } = recording(mysqlDialect, 'acct', { rowsFor: () => [{ id: 'k1', org_id: 2 }] });
    await qi.create({ data: { id: 'k1', orgId: 2 } });
    assert.deepEqual(sent[2], { sql: 'SELECT * FROM `acct` WHERE `id` = :p1', params: ['k1'] });
  });

  it('a number supplied for a text key is re-read as the text MySQL stored, not compared numerically', async () => {
    const { qi, sent } = recording(mysqlDialect, 'acct', { rowsFor: () => [{ id: '0', org_id: 2 }] });
    await qi.create({ data: { id: 0, orgId: 2 } });
    assert.deepEqual(sent[1]!.params, [0, 2], 'the INSERT binds what the caller passed');
    assert.deepEqual(sent[2]!.params, ['0'], "'0zz' = 0 is true on MySQL; '0zz' = '0' is not");
  });

  it('without the key, a unique key supplied in full is used instead', async () => {
    const { qi, sent } = recording(mysqlDialect, 'acct', { rowsFor: () => [{ id: 'u', email: 'a@x' }] });
    await qi.create({ data: { orgId: 2, email: 'a@x' } });
    assert.deepEqual(sent[2], { sql: 'SELECT * FROM `acct` WHERE `email` = :p1', params: ['a@x'] });
  });

  it("a server-numbered integer key is re-read by the driver's insert id", async () => {
    const { qi, sent } = recording(mysqlDialect, 'tasks', { insertId: 42, rowsFor: () => [{ id: 42 }] });
    await qi.create({ data: { status: 'open' } });
    assert.deepEqual(sent[2], { sql: 'SELECT * FROM `tasks` WHERE `id` = :p1', params: [42] });
  });

  it('an insert id of 0 is never used as a key: E017, and the insert is rolled back', async () => {
    const { qi, sqls } = recording(mysqlDialect, 'tasks', { insertId: 0, rowsFor: () => [{ id: 1 }] });
    await assert.rejects(qi.create({ data: { status: 'open' } }), e017(/reported no generated value for "id"/));
    assert.deepEqual(
      sqls().map((s) => s.split(' ')[0]),
      ['START', 'INSERT', 'ROLLBACK'],
    );
  });

  it('isGenerated decides when the metadata records it', () => {
    const notGenerated = withColumn(schema(), 'tasks', 'id', { isGenerated: false });
    assert.throws(
      () => makeQuery('tasks', notGenerated, { dialect: mysqlDialect }).buildCreate({ data: { status: 'x' } }),
      e017(/without "id" in data/),
    );
    const generated = withColumn(schema(), 'acct', 'id', { isGenerated: true });
    assert.doesNotThrow(() =>
      makeQuery('acct', generated, { dialect: mysqlDialect }).buildCreate({ data: { orgId: 1 } }),
    );
  });

  it('a table with no primary key and no unique key in data is refused (it used to return the first row)', () => {
    assert.throws(
      () => makeQuery('nokey', schema(), { dialect: mysqlDialect }).buildCreate({ data: { note: 'n' } }),
      e017(/which has no primary key.*Supply every column of a unique key/),
    );
  });

  it('a re-read that matches two rows is refused and rolled back', async () => {
    const { qi, sqls } = recording(mysqlDialect, 'acct', { rowsFor: () => [{ id: 'a' }, { id: 'b' }] });
    await assert.rejects(qi.create({ data: { id: 'a', orgId: 1 } }), e017(/matched 2 rows/));
    assert.equal(sqls().at(-1), 'ROLLBACK');
  });
});

describe('MySQL upsert: a create that could collide on another unique key looks the row up first', () => {
  const ARGS = { where: { name: 'a' }, create: { id: 2, name: 'a', status: 'new' }, update: { status: 'updated' } };

  it('create setting the primary key while where pins name takes the lookup', () => {
    assert.equal(makeQuery('named', schema(), { dialect: mysqlDialect }).upsertNeedsLookup(ARGS), true);
  });

  it('a batched upsert of that shape is refused, naming the other key', () => {
    assert.throws(
      () => makeQuery('named', schema(), { dialect: mysqlDialect }).buildUpsert(ARGS),
      e017(/also sets another unique key \(id\).*Call `upsert\(\)` unbatched/),
    );
  });

  it('shapes that cannot collide elsewhere keep the one statement', () => {
    const qi = makeQuery('named', schema(), { dialect: mysqlDialect });
    // The key is left to the server.
    assert.equal(qi.upsertNeedsLookup({ ...ARGS, create: { name: 'a', status: 'new' } }), false);
    // where pins the primary key, which every other key's collision would have to share.
    assert.equal(qi.upsertNeedsLookup({ ...ARGS, where: { id: 2 } }), true, 'name is another key create sets');
    assert.equal(
      qi.upsertNeedsLookup({ where: { id: 2 }, create: { id: 2, status: 'new' }, update: { status: 'u' } }),
      false,
    );
    // A NULL never collides.
    assert.equal(qi.upsertNeedsLookup({ ...ARGS, create: { name: 'a', nick: null } }), false);
    assert.equal(qi.upsertNeedsLookup({ ...ARGS, create: { name: 'a', nick: 'n' } }), true);
  });

  it('the other engines name their conflict target, so they never take this lookup', () => {
    for (const dialect of [postgresDialect, sqliteDialect, mssqlDialect]) {
      assert.equal(makeQuery('named', schema(), { dialect }).upsertNeedsLookup(ARGS), false, dialect.name);
    }
  });

  it('the rule: a key containing a pinned key, a NULL member, or no member set never collides', () => {
    const meta = schema().tables.named as TableMetadata;
    meta.uniqueColumns.push(['name', 'status']);
    const state = (set: Record<string, 'value' | 'null'>) => (c: string) => set[c] ?? 'absent';
    assert.equal(otherCollidingUniqueKey(meta, [['name']], state({ name: 'value', status: 'value' })), undefined);
    assert.deepEqual(otherCollidingUniqueKey(meta, [['name']], state({ id: 'value' })), ['id']);
    assert.equal(otherCollidingUniqueKey(meta, [['name']], state({ nick: 'null' })), undefined);
    assert.equal(otherCollidingUniqueKey(meta, [['id']], state({})), undefined);
    // An absent NOT NULL member may still take a value, so the uncertain answer is the key.
    assert.deepEqual(otherCollidingUniqueKey(meta, [['id']], state({ status: 'value' })), ['name', 'status']);
  });

  it('the multi-row upsert uses the same rule', () => {
    const qi = makeQuery('named', schema(), { dialect: mysqlDialect });
    assert.throws(
      () => qi.buildCreateMany({ data: [{ id: 1, name: 'a' }], onConflict: { target: ['name'], update: ['id'] } }),
      e017(/another unique key \(id\) that a row in data can collide on/),
    );
    assert.doesNotThrow(() =>
      qi.buildCreateMany({ data: [{ name: 'a', status: 's' }], onConflict: { target: ['name'], update: ['status'] } }),
    );
  });
});

describe('MySQL update: a write that moves the row out of where is re-read by its key', () => {
  const kinds = (sqls: string[]) => sqls.map((s) => s.split(' ')[0]);

  it('NOT: { status } with data status locks by where and re-reads by the primary key', async () => {
    const { qi, sent, sqls } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 1, status: 'done' }] });
    const row = await qi.update({ where: { id: 1, NOT: { status: 'done' } }, data: { status: 'done' } });
    assert.equal(row.status, 'done');
    assert.deepEqual(kinds(sqls()), ['START', 'SELECT', 'UPDATE', 'SELECT', 'COMMIT']);
    assert.match(sent[1]!.sql, /^SELECT `id` FROM `tasks` WHERE .* FOR UPDATE$/);
    assert.deepEqual(sent[3], { sql: 'SELECT * FROM `tasks` WHERE `id` = :p1', params: [1] });
  });

  it('a global filter the write leaves (a soft delete) is detected too', async () => {
    const { qi, sent } = recording(mysqlDialect, 'tasks', {
      rowsFor: () => [{ id: 3 }],
      options: { globalFilters: { tasks: { deletedAt: null } } },
    });
    await qi.update({ where: { id: 3 }, data: { deletedAt: new Date() } });
    assert.match(sent[1]!.sql, /FOR UPDATE$/);
    assert.deepEqual(sent[3], { sql: 'SELECT * FROM `tasks` WHERE `id` = :p1', params: [3] });
  });

  it('an integer increment of the key is applied to the locked key', async () => {
    const { qi, sent } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 2 }] });
    await qi.update({ where: { id: 2 }, data: { id: { increment: 100 } } });
    assert.deepEqual(sent[3]!.params, [102]);
  });

  it('a key changed by an expression or divide is refused before the UPDATE is sent', async () => {
    for (const data of [{ id: expr.add(col('id'), 1) }, { id: { divide: 2 } }]) {
      const { qi, sqls } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 2 }] });
      await assert.rejects(qi.update({ where: { id: 2 }, data }), (err: unknown) => err instanceof Error);
      assert.ok(!sqls().some((s) => s.startsWith('UPDATE')), `no UPDATE for ${JSON.stringify(Object.keys(data))}`);
    }
    const { qi } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 2 }] });
    await assert.rejects(
      qi.update({ where: { id: 2 }, data: { id: { divide: 2 } } }),
      e017(/changes the key "id" with `divide`/),
    );
  });

  it('the version column of an optimistic lock counts as written', async () => {
    const { qi, sent } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 1, version: 4 }] });
    await qi.update({
      where: { id: 1, version: 3 },
      data: { status: 's' },
      optimisticLock: { field: 'version', expected: 3 },
    });
    assert.match(sent[1]!.sql, /FOR UPDATE$/);
    assert.deepEqual(sent[3], { sql: 'SELECT * FROM `tasks` WHERE `id` = :p1', params: [1] });
  });

  it('a write that reads none of its where columns keeps the two-statement form', async () => {
    const { qi, sqls } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 1 }] });
    await qi.update({ where: { id: 1 }, data: { status: 's' } });
    assert.deepEqual(sqls(), [
      'START TRANSACTION',
      'UPDATE `tasks` SET `status` = :p1 WHERE `id` = :p2',
      'SELECT * FROM `tasks` WHERE `id` = :p1',
      'COMMIT',
    ]);
  });

  it('a where that matched several rows is refused and rolled back, unless the write is full-table', async () => {
    const { qi, sqls } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 1 }, { id: 2 }] });
    await assert.rejects(qi.update({ where: { id: 1 }, data: { status: 's' } }), e017(/matched 2 rows/));
    assert.equal(sqls().at(-1), 'ROLLBACK');
    const del = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 1 }, { id: 2 }] });
    await assert.rejects(del.qi.delete({ where: { id: 1 } }), e017(/matched 2 rows/));
    assert.ok(!del.sqls().some((s) => s.startsWith('DELETE')), 'refused before the DELETE');
  });

  it('a lock that finds no row writes nothing and reports NotFoundError', async () => {
    const { qi, sqls } = recording(mysqlDialect, 'tasks', { rowsFor: () => [] });
    await assert.rejects(qi.update({ where: { id: 9, NOT: { status: 'x' } }, data: { status: 'x' } }), NotFoundError);
    assert.ok(!sqls().some((s) => s.startsWith('UPDATE')));
  });

  it('upsert: an update that moves the row is re-read by its new key', async () => {
    const { qi, sent } = recording(mysqlDialect, 'named', { rowsFor: () => [{ id: 1, name: 'b' }] });
    await qi.upsert({ where: { name: 'a' }, create: { name: 'a' }, update: { name: 'b' } });
    assert.match(sent[1]!.sql, /^SELECT `id` FROM `named` WHERE `name` = :p1 FOR UPDATE$/);
    assert.deepEqual(sent[3], { sql: 'SELECT * FROM `named` WHERE `id` = :p1', params: [1] });
  });
});

describe('createMany is sized before any statement is built', () => {
  const rowsOf = (n: number, cols: string[]) =>
    Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map((c) => [c, i])));
  const statementShape = (sent: Sent[]) =>
    sent.filter((s) => s.sql.startsWith('INSERT')).map((s) => (s.sql.match(/\), \(/g)?.length ?? 0) + 1);

  for (const [n, cols, expected] of [
    [1200, ['id'], [1000, 200]],
    [1050, ['id', 'a'], [1000, 50]],
    [800, ['id', 'a', 'b'], [699, 101]],
    [600, ['id', 'a', 'b'], [600]],
  ] as const) {
    it(`SQL Server: ${n} rows x ${cols.length} columns run as ${expected.join(' + ')} rows`, async () => {
      const { qi, sent } = recording(mssqlDialect, 'wide');
      const out = await qi.createMany({ data: rowsOf(n, [...cols]) });
      assert.ok(Array.isArray(out));
      assert.deepEqual(statementShape(sent), [...expected]);
      for (const s of sent) {
        assert.ok(s.params.length <= 2098, `${s.params.length} parameters`);
      }
      if (expected.length > 1) {
        assert.equal(sent[0]!.sql, 'BEGIN TRANSACTION');
        assert.equal(sent.at(-1)!.sql, 'COMMIT TRANSACTION');
      }
    });
  }

  it('PostgreSQL binds one array per column, so any number of rows is one statement', async () => {
    const { qi, sent } = recording(postgresDialect, 'wide');
    await qi.createMany({ data: rowsOf(70_000, ['id', 'a']) });
    assert.equal(sent.length, 1);
    assert.match(sent[0]!.sql, /UNNEST/);
  });

  it('a pipeline (buildCreateMany) still refuses a statement the engine cannot take', () => {
    assert.throws(() =>
      makeQuery('wide', schema(), { dialect: mssqlDialect }).buildCreateMany({ data: rowsOf(1200, ['id']) }),
    );
  });
});

describe('the statements of one write share one deadline', () => {
  it('a re-read write whose statements together outlast the timeout is a timeout, and rolls back', async () => {
    // Each statement alone fits the 100 ms timeout; the UPDATE and its re-read together do not.
    const { qi, sqls } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 1 }], delayMs: 60 });
    await assert.rejects(qi.update({ where: { id: 1 }, data: { status: 's' }, timeout: 100 }), (err: unknown) => {
      assert.ok(err instanceof TimeoutError, String(err));
      assert.equal((err as TimeoutError).outcome, 'not-executed');
      return true;
    });
    assert.ok(!sqls().includes('COMMIT'));
  });

  it('a write that finishes inside the deadline commits', async () => {
    const { qi, sqls } = recording(mysqlDialect, 'tasks', { rowsFor: () => [{ id: 1 }], delayMs: 5 });
    await qi.update({ where: { id: 1 }, data: { status: 's' }, timeout: 2000 });
    assert.equal(sqls().at(-1), 'COMMIT');
  });
});

describe('two rows sharing a conflict key under a collation are E003', () => {
  const qi = () => makeQuery('named', schema(), { dialect: postgresDialect }) as Any;
  const ctx = () => qi().ctx;
  const args = { onConflict: { target: ['name'], update: ['status'] } };

  it('PostgreSQL 21000 and SQL Server 8672, wrapped or not, name the cause', () => {
    for (const err of [
      { code: '21000' },
      { sqlstate: '21000', cause: { code: '21000' } },
      { number: 8672 },
      { message: 'wrapped', cause: { number: 8672 } },
    ]) {
      const out = explainConflictKeyCollision(ctx(), args, err);
      assert.ok(out instanceof ValidationError, JSON.stringify(err));
      assert.match((out as Error).message, /two rows in this call share the conflict key \(name\)/);
      assert.equal((out as Error & { cause?: unknown }).cause, err);
    }
  });

  it('any other error, or a createMany without onConflict, is returned as it was', () => {
    const unique = { code: '23505' };
    assert.equal(explainConflictKeyCollision(ctx(), args, unique), unique);
    const cardinality = { code: '21000' };
    assert.equal(explainConflictKeyCollision(ctx(), {}, cardinality), cardinality);
  });

  it('MySQL: a re-read that finds fewer rows than were written is refused and rolled back', async () => {
    const { qi: my, sqls } = recording(mysqlDialect, 'named', { rowsFor: () => [{ id: 1, name: 'A' }] });
    await assert.rejects(
      my.createMany({
        data: [
          { name: 'A', status: '1' },
          { name: 'a', status: '2' },
        ],
        onConflict: { target: ['name'], update: ['status'] },
      }),
      e003(/two rows in this call share the conflict key \(name\)/),
    );
    assert.equal(sqls().at(-1), 'ROLLBACK');
  });
});

function numsSchema(): SchemaMetadata {
  const nums = mockTable('nums', [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'n', field: 'n', pgType: 'int4' },
    { name: 'w', field: 'w', pgType: 'int(11) unsigned' },
    { name: 'big', field: 'big', pgType: 'bigint' },
    { name: 'flag', field: 'flag', pgType: 'tinyint(1)' },
    { name: 'price', field: 'price', pgType: 'decimal' },
    { name: 'ratio', field: 'ratio', pgType: 'float8' },
  ]);
  return { tables: { nums }, enums: {} } as unknown as SchemaMetadata;
}

describe('divide on a MySQL integer column truncates, as PostgreSQL does', () => {
  const setOf = (dialect: Dialect, key: string, divisor: number) =>
    makeQuery('nums', numsSchema(), { dialect, sqlCache: false })
      .buildUpdateMany({ where: { id: 1 }, data: { [key]: { divide: divisor } } })
      .sql.match(/SET (.*?) WHERE/)![1]!;

  it('an integer column, in any spelling, compiles to DIV', () => {
    assert.equal(setOf(mysqlDialect, 'n', 2), '`n` = `n` DIV :p1');
    assert.equal(setOf(mysqlDialect, 'w', 2), '`w` = `w` DIV :p1');
    assert.equal(setOf(mysqlDialect, 'big', 2), '`big` = `big` DIV :p1');
  });

  it('BOOLEAN (tinyint(1)), decimal and float columns keep decimal division', () => {
    assert.equal(setOf(mysqlDialect, 'flag', 2), '`flag` = `flag` / :p1');
    assert.equal(setOf(mysqlDialect, 'price', 2), '`price` = `price` / :p1');
    assert.equal(setOf(mysqlDialect, 'ratio', 2), '`ratio` = `ratio` / :p1');
  });

  it('the statement depends on the column type only, never on the divisor', () => {
    assert.equal(setOf(mysqlDialect, 'n', 2.5), setOf(mysqlDialect, 'n', 3));
  });

  it('the other engines keep /', () => {
    assert.equal(setOf(postgresDialect, 'n', 2), '"n" = "n" / $1');
    assert.equal(setOf(sqliteDialect, 'n', 2), '"n" = "n" / :p1');
    assert.match(setOf(mssqlDialect, 'n', 2), /\[n\] = \[n\] \/ @p1/);
  });

  it('update, upsert and createMany onConflict all compile through the same rule', async () => {
    const { qi, sqls } = recording(mysqlDialect, 'nums', { s: numsSchema(), rowsFor: () => [{ id: 1, n: 1 }] });
    await qi.update({ where: { id: 1 }, data: { n: { divide: 2 } } });
    await qi.upsert({ where: { id: 1 }, create: { id: 1, n: 1 }, update: { n: { divide: 2 } } });
    await qi.createMany({ data: [{ id: 1, n: 1 }], onConflict: { target: ['id'], update: { n: { divide: 2 } } } });
    const divides = sqls().filter((s) => s.includes('DIV'));
    assert.equal(divides.length, 3, sqls().join('\n'));
  });
});

describe('a Date written to a date column binds its UTC date on every SQL engine', () => {
  const END_OF_DAY = new Date('1999-12-31T23:59:59.999Z');
  function datesSchema(dateType = 'date'): SchemaMetadata {
    const ev = mockTable('ev', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'day', field: 'day', pgType: dateType },
      { name: 'at', field: 'at', pgType: 'timestamp' },
    ]);
    return { tables: { ev }, enums: {} } as unknown as SchemaMetadata;
  }
  const createParams = (dialect: Dialect, s = datesSchema(), options: Record<string, unknown> = {}) =>
    makeQuery('ev', s, { dialect, sqlCache: false, ...options }).buildCreate({
      data: { id: 1, day: END_OF_DAY, at: END_OF_DAY },
    }).params;

  for (const dialect of [mysqlDialect, sqliteDialect, mssqlDialect, postgresDialect]) {
    it(`${dialect.name}: the date column gets 1999-12-31`, () => {
      assert.ok(createParams(dialect).includes('1999-12-31'));
    });
  }

  it('an introspected upper-case DATE is the same column kind', () => {
    assert.ok(createParams(sqliteDialect, datesSchema('DATE')).includes('1999-12-31'));
  });

  it('a zone-less timestamp keeps the Date off PostgreSQL (MySQL reads a literal in the session zone)', () => {
    assert.ok(createParams(mysqlDialect).includes(END_OF_DAY));
    assert.ok(createParams(postgresDialect).includes('1999-12-31 23:59:59.999'));
  });

  it('utcTimestamps: false turns the rewrite off on every engine', () => {
    for (const dialect of [mysqlDialect, sqliteDialect, postgresDialect]) {
      const params = createParams(dialect, datesSchema(), { utcTimestamps: false });
      assert.ok(!params.includes('1999-12-31'), dialect.name);
    }
  });

  it('update and createMany bind the same value', () => {
    const q = makeQuery('ev', datesSchema(), { dialect: mysqlDialect, sqlCache: false });
    assert.ok(q.buildUpdateMany({ where: { id: 1 }, data: { day: END_OF_DAY } }).params.includes('1999-12-31'));
    assert.ok(q.buildCreateMany({ data: [{ id: 1, day: END_OF_DAY }] }).params.includes('1999-12-31'));
  });
});

const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const sqliteGate = skipGate(!HAVE_NODE_SQLITE, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

describe('SQLite: a chunked createMany inside $transaction is all or nothing', () => {
  sqliteGate.it('a duplicate key in the second chunk, caught in the callback, leaves no row', async () => {
    const db = turbineSqlite(
      ':memory:',
      schemaDefToMetadata(
        defineSchema({ fw_bulk: { id: { type: 'integer', primaryKey: true }, a: { type: 'integer' } } }),
      ),
    );
    try {
      await db.rawUnsafe('CREATE TABLE fw_bulk (id INTEGER PRIMARY KEY, a INTEGER)');
      const rows = Array.from({ length: 20_000 }, (_, i) => ({ id: i + 1, a: i }));
      rows[18_000] = { id: 5, a: 0 };
      const caught = await db.$transaction(async (tx) => {
        try {
          await tx.table('fw_bulk').createMany({ data: rows });
        } catch (err) {
          return (err as Error).constructor.name;
        }
        return 'no error';
      });
      assert.equal(caught, 'UniqueConstraintError');
      assert.equal(await db.table('fw_bulk').count(), 0, 'the first chunk was rolled back with the second');
    } finally {
      await db.disconnect();
    }
  });
});
