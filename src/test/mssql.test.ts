/**
 * turbine-orm/mssql — two-tier tests.
 *
 *  1. **Build-only + mock-driver** (this lane, `test:unit`, NO DB): assert the
 *     real `mssqlDialect` emits SQL Server SQL with zero Postgres-token leakage
 *     (the `FOR JSON PATH` relation engine, `OUTPUT`/`MERGE` writes, `OFFSET/FETCH`
 *     paging, `@pN` params, `[…]` quoting), and prove the `'output'` result
 *     strategy returns the affected row from `OUTPUT INSERTED.*` in ONE statement
 *     through a mock `mssql` driver that records `request.input('pN', …)` bindings.
 *     This is the critical local proof since no SQL Server is available.
 *  2. **Real integration** (gated on `MSSQL_URL`): the full findMany / nested-with /
 *     create(output) / upsert(MERGE) / update / delete / transaction suite against a
 *     real SQL Server 2022. Skips cleanly with no server (locally) and runs in CI's
 *     mssql service container.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { QueryInterface } from '../index.js';
import {
  introspectMssqlWith,
  MssqlPool,
  type MssqlRowExecutor,
  mssqlDialect,
  mssqlTypeToTs,
  turbineMssql,
} from '../mssql.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// ===========================================================================
// Tier 1a — build-only conformance (real mssqlDialect, no DB)
// ===========================================================================

const usersTable = mockTable(
  'users',
  [
    { name: 'id', field: 'id', pgType: 'bigint' },
    { name: 'name', field: 'name', pgType: 'nvarchar' },
    { name: 'role', field: 'role', pgType: 'nvarchar' },
    // JSON is stored as NVARCHAR on SQL Server; mark it `json` so the build-only
    // tests exercise the dialect's JSON-operator routing (buildJsonContains).
    { name: 'metadata', field: 'metadata', pgType: 'json' },
    { name: 'embedding', field: 'embedding', pgType: 'vector' },
  ],
  {
    posts: {
      name: 'posts',
      type: 'hasMany',
      from: 'users',
      to: 'posts',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);
const postsTable = mockTable(
  'posts',
  [
    { name: 'id', field: 'id', pgType: 'bigint' },
    { name: 'user_id', field: 'userId', pgType: 'bigint' },
    { name: 'title', field: 'title', pgType: 'nvarchar' },
  ],
  {
    author: {
      name: 'author',
      type: 'belongsTo',
      from: 'posts',
      to: 'users',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);
const schema: SchemaMetadata = { tables: { users: usersTable, posts: postsTable }, enums: {} };

function q(): QueryInterface<Record<string, unknown>> {
  // biome-ignore lint/suspicious/noExplicitAny: build-only; pool unused.
  return new QueryInterface<Record<string, unknown>>(null as any, 'users', schema, [], { dialect: mssqlDialect });
}

/** Postgres-isms the SQL Server engine must NEVER emit, across reads AND writes. */
const FORBIDDEN =
  /json_agg|json_build_object|::json|::int|::float|ILIKE|\$\d|"users"|"posts"|`users`|`posts`|RETURNING|ON CONFLICT|UNNEST|= ANY|!= ALL|\bLIMIT\b/;

describe('turbine-orm/mssql — dialect conformance (no Postgres leakage)', () => {
  it('placeholders are NAMED @pN (not positional ? or $N) and identifiers are bracketed', () => {
    const sql = q().buildFindMany({ where: { id: 1 }, limit: 1 }).sql;
    assert.match(sql, /@p\d/, 'must use named @pN placeholders');
    assert.match(sql, /\[users\]/, 'must bracket-quote identifiers');
    assert.doesNotMatch(sql, /\?/, 'must NOT use positional ? placeholders');
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('outer LIMIT → OFFSET/FETCH with an injected stable ORDER BY (no LIMIT keyword)', () => {
    const sql = q().buildFindMany({ where: { role: 'admin' }, limit: 10, offset: 5 }).sql;
    assert.match(sql, /OFFSET @p\d ROWS FETCH NEXT @p\d ROWS ONLY/);
    assert.doesNotMatch(sql, /\bLIMIT\b/);
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('outer LIMIT with a user ORDER BY does NOT inject the (SELECT NULL) order', () => {
    const sql = q().buildFindMany({ orderBy: { id: 'asc' }, limit: 3 }).sql;
    assert.match(sql, /ORDER BY \[id\] ASC OFFSET 0 ROWS FETCH NEXT @p\d ROWS ONLY/);
    assert.doesNotMatch(sql, /SELECT NULL/);
  });

  it('findUnique single-row limit uses OFFSET/FETCH 1 (no LIMIT 1)', () => {
    const sql = q().buildFindUnique({ where: { id: 1 } }).sql;
    assert.match(sql, /ORDER BY \(SELECT NULL\) OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY/);
    assert.doesNotMatch(sql, /\bLIMIT\b/);
  });

  it('case-insensitive contains → LOWER() LIKE LOWER(), bracketed, @pN, no ILIKE', () => {
    const d = q().buildFindMany({ where: { name: { contains: 'Ada', mode: 'insensitive' } }, limit: 5 });
    assert.match(d.sql, /LOWER\(\[name\]\) LIKE LOWER\(@p\d\) ESCAPE/);
    assert.deepEqual(d.params.slice(0, 1), ['%Ada%']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('nested with → FOR JSON PATH, ISNULL empty-array, WITHOUT_ARRAY_WRAPPER + JSON_QUERY, no json_agg', () => {
    const sql = q().buildFindMany({ with: { posts: { with: { author: true } } } }).sql;
    assert.match(sql, /FOR JSON PATH/);
    assert.match(sql, /ISNULL\(\(SELECT /);
    assert.match(sql, /'\[\]'\)/, 'to-many coalesces to an empty JSON array');
    assert.match(sql, /WITHOUT_ARRAY_WRAPPER/, 'to-one author uses WITHOUT_ARRAY_WRAPPER');
    assert.match(sql, /JSON_QUERY\(\(SELECT TOP 1/, 'nested to-one embedded as real JSON');
    assert.match(sql, /INCLUDE_NULL_VALUES/);
    assert.match(sql, /\[posts\] t0/);
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('ordered+limited to-many uses OFFSET/FETCH inside the FOR JSON subquery', () => {
    const d = q().buildFindMany({ with: { posts: { orderBy: { title: 'asc' }, limit: 3 } } });
    assert.match(d.sql, /ORDER BY t0\.\[title\] ASC OFFSET 0 ROWS FETCH NEXT @p\d ROWS ONLY FOR JSON PATH/);
    assert.deepEqual(d.params, [3]);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('IN list → OPENJSON single-placeholder (length-stable), no = ANY', () => {
    const d = q().buildFindMany({ where: { role: { in: ['admin', 'editor'] } } });
    assert.match(d.sql, /\[role\] IN \(SELECT \[value\] FROM OPENJSON\(@p\d\)\)/);
    assert.deepEqual(d.params, ['["admin","editor"]']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('count → CAST(COUNT(*) AS INT), not ::int', () => {
    const sql = q().buildCount({ where: { role: 'admin' } }).sql;
    assert.match(sql, /CAST\(COUNT\(\*\) AS INT\)/);
    assert.doesNotMatch(sql, FORBIDDEN);
  });

  it('create → INSERT … OUTPUT INSERTED.* VALUES (output strategy, no RETURNING)', () => {
    const d = q().buildCreate({ data: { id: 1, name: 'Ada' } });
    assert.equal(d.sql, 'INSERT INTO [users] ([id], [name]) OUTPUT INSERTED.* VALUES (@p1, @p2)');
    assert.deepEqual(d.params, [1, 'Ada']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('createMany → multi-row VALUES + OUTPUT INSERTED.*', () => {
    const d = q().buildCreateMany({
      data: [
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ],
    });
    assert.equal(d.sql, 'INSERT INTO [users] ([id], [name]) OUTPUT INSERTED.* VALUES (@p1, @p2), (@p3, @p4)');
    assert.deepEqual(d.params, [1, 'Ada', 2, 'Grace']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('upsert → MERGE … WHEN MATCHED … WHEN NOT MATCHED … OUTPUT INSERTED.* ; (ends with semicolon)', () => {
    const d = q().buildUpsert({ where: { id: 1 }, create: { id: 1, name: 'Ada' }, update: { name: 'Ada L.' } });
    assert.match(d.sql, /^MERGE INTO \[users\] AS T USING \(VALUES \(@p1, @p2\)\) AS S \(\[id\], \[name\]\)/);
    assert.match(d.sql, /ON \(T\.\[id\] = S\.\[id\]\)/);
    assert.match(d.sql, /WHEN MATCHED THEN UPDATE SET \[name\] = @p3/);
    assert.match(d.sql, /WHEN NOT MATCHED THEN INSERT \(\[id\], \[name\]\) VALUES \(S\.\[id\], S\.\[name\]\)/);
    assert.match(d.sql, /OUTPUT INSERTED\.\*;$/, 'MERGE must end with a semicolon');
    assert.deepEqual(d.params, [1, 'Ada', 'Ada L.']);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('update injects OUTPUT INSERTED.* between SET and WHERE', () => {
    const d = q().buildUpdate({ where: { id: 1 }, data: { name: 'Ada L.' } });
    assert.match(d.sql, /^UPDATE \[users\] SET \[name\] = @p\d OUTPUT INSERTED\.\* WHERE \[id\] = @p\d$/);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('delete injects OUTPUT DELETED.* between FROM and WHERE', () => {
    const d = q().buildDelete({ where: { id: 1 } });
    assert.match(d.sql, /^DELETE FROM \[users\] OUTPUT DELETED\.\* WHERE \[id\] = @p\d$/);
    assert.doesNotMatch(d.sql, FORBIDDEN);
  });

  it('JSON containment filter → OPENJSON EXISTS', () => {
    const d = q().buildFindMany({ where: { metadata: { contains: { role: 'admin' } } } });
    assert.match(d.sql, /EXISTS \(SELECT 1 FROM OPENJSON\(\[metadata\]\) WHERE \[value\] = @p\d\)/);
    assert.deepEqual(d.params, ['{"role":"admin"}']);
  });

  it('capability flags + resultStrategy report the SQL Server feature set', () => {
    assert.equal(mssqlDialect.name, 'mssql');
    assert.equal(mssqlDialect.resultStrategy, 'output');
    assert.equal(mssqlDialect.supportsReturning, false);
    assert.equal(mssqlDialect.supportsVector, false);
    assert.equal(mssqlDialect.supportsListenNotify, false);
    assert.equal(mssqlDialect.supportsRLS, false);
    assert.equal(mssqlDialect.supportsAdvisoryLock, true);
    // The FOR JSON relation override is present (the sanctioned Phase-3 seam).
    assert.equal(typeof mssqlDialect.buildRelationSubquery, 'function');
    assert.equal(typeof mssqlDialect.buildLimitOffset, 'function');
    assert.equal(typeof mssqlDialect.buildUpdateStatement, 'function');
    assert.equal(typeof mssqlDialect.buildDeleteStatement, 'function');
  });

  it('transaction begin composes isolation BEFORE BEGIN TRANSACTION (different keywords)', () => {
    assert.equal(mssqlDialect.beginStatement(), 'BEGIN TRANSACTION');
    assert.equal(
      mssqlDialect.beginStatement('SERIALIZABLE'),
      'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE; BEGIN TRANSACTION',
    );
    assert.equal(mssqlDialect.commitStatement(), 'COMMIT TRANSACTION');
    assert.equal(mssqlDialect.rollbackStatement(), 'ROLLBACK TRANSACTION');
    assert.equal(mssqlDialect.savepointStatement('sp_1'), 'SAVE TRANSACTION sp_1');
    assert.equal(mssqlDialect.rollbackToSavepointStatement('sp_1'), 'ROLLBACK TRANSACTION sp_1');
    // SQL Server has no RELEASE SAVEPOINT → empty (the shim no-ops it).
    assert.equal(mssqlDialect.releaseSavepointStatement('sp_1'), '');
  });

  it('type mapping: bit→boolean, bigint→number, decimal→string, datetime2→Date, uniqueidentifier→string', () => {
    assert.equal(mssqlTypeToTs('bit', false), 'boolean');
    assert.equal(mssqlTypeToTs('bigint', false), 'number');
    assert.equal(mssqlTypeToTs('int', false), 'number');
    assert.equal(mssqlTypeToTs('decimal', true), 'string | null');
    assert.equal(mssqlTypeToTs('money', false), 'string');
    assert.equal(mssqlTypeToTs('datetime2', false), 'Date');
    assert.equal(mssqlTypeToTs('datetimeoffset', false), 'Date');
    assert.equal(mssqlTypeToTs('uniqueidentifier', false), 'string');
    assert.equal(mssqlTypeToTs('nvarchar', true), 'string | null');
    assert.equal(mssqlTypeToTs('varbinary', false), 'Uint8Array');
  });

  it('bulk insert enforces the 1000-row / 2100-param SQL Server limits', () => {
    const tooManyRows = Array.from({ length: 1001 }, (_, i) => ({ id: i }));
    assert.throws(() => q().buildCreateMany({ data: tooManyRows }), /1000 rows/);
  });

  it('gates pgvector ops behind supportsVector → UnsupportedFeatureError', async () => {
    const { UnsupportedFeatureError } = await import('../errors.js');
    // biome-ignore lint/suspicious/noExplicitAny: exercising the vector orderBy surface
    const vectorArgs: any = { orderBy: { embedding: { distance: { to: [1, 2, 3], metric: 'l2' } } } };
    assert.throws(
      () => q().buildFindMany(vectorArgs),
      (err: unknown) => err instanceof UnsupportedFeatureError && /unsupported on "mssql"/.test((err as Error).message),
    );
  });

  it('no Postgres tokens leak across the full read/write surface', () => {
    const i = q();
    const statements = [
      i.buildFindMany({ where: { name: { contains: 'Ada', mode: 'insensitive' } }, limit: 5 }).sql,
      i.buildFindMany({ with: { posts: { with: { author: true } } } }).sql,
      i.buildFindMany({ with: { posts: { orderBy: { title: 'asc' }, limit: 3 } } }).sql,
      i.buildFindMany({ where: { role: { in: ['a', 'b'] } } }).sql,
      i.buildFindUnique({ where: { id: 1 } }).sql,
      i.buildCreate({ data: { id: 1, name: 'Ada' } }).sql,
      i.buildCreateMany({ data: [{ id: 1, name: 'Ada' }] }).sql,
      i.buildUpsert({ where: { id: 1 }, create: { id: 1, name: 'Ada' }, update: { name: 'L' } }).sql,
      i.buildUpdate({ where: { id: 1 }, data: { name: 'L' } }).sql,
      i.buildDelete({ where: { id: 1 } }).sql,
      i.buildCount().sql,
    ];
    for (const sql of statements) assert.doesNotMatch(sql, FORBIDDEN, `leaked a Postgres token: ${sql}`);
  });
});

// ===========================================================================
// Tier 1b — mock-driver: prove the real MssqlPool binds @pN inputs and the
// 'output' result strategy returns the row from OUTPUT INSERTED.* in ONE
// statement (no SQL Server server needed).
// ===========================================================================

interface MockCall {
  sql: string;
  inputs: Record<string, unknown>;
  via: 'pool' | 'tx' | 'batch';
}

/** A fake `mssql` module + ConnectionPool that records request.input() bindings. */
function fakeMssql(opts: { rowsFor?: (sql: string) => Record<string, unknown>[] } = {}) {
  const calls: MockCall[] = [];
  const txEvents: string[] = [];

  class FakeRequest {
    inputs: Record<string, unknown> = {};
    constructor(public parent: unknown) {}
    input(name: string, value: unknown): this {
      this.inputs[name] = value;
      return this;
    }
    async query(sql: string) {
      const via = this.parent === pool ? 'pool' : 'tx';
      calls.push({ sql, inputs: this.inputs, via });
      const rows = opts.rowsFor?.(sql) ?? [];
      return { recordset: rows, rowsAffected: [rows.length] };
    }
    async batch(sql: string) {
      calls.push({ sql, inputs: this.inputs, via: 'batch' });
      return { recordset: [], rowsAffected: [0] };
    }
  }

  class FakeTransaction {
    async begin(level?: number) {
      txEvents.push(`begin:${level}`);
    }
    async commit() {
      txEvents.push('commit');
    }
    async rollback() {
      txEvents.push('rollback');
    }
  }

  const pool = {
    async connect() {
      return pool;
    },
    request() {
      return new FakeRequest(pool);
    },
    async close() {},
    connected: true,
  };

  const sqlNS = {
    ISOLATION_LEVEL: {
      READ_UNCOMMITTED: 1,
      READ_COMMITTED: 2,
      REPEATABLE_READ: 3,
      SERIALIZABLE: 4,
      SNAPSHOT: 5,
    },
    Request: FakeRequest,
    Transaction: FakeTransaction,
    // biome-ignore lint/suspicious/noExplicitAny: only ConnectionPool's instance shape matters to the shim
    ConnectionPool: class {} as any,
    async connect() {
      return pool;
    },
  };

  // biome-ignore lint/suspicious/noExplicitAny: structural mssql module/pool for the shim
  return { pool: pool as any, sqlNS: sqlNS as any, calls, txEvents };
}

function mssqlQuery(pool: MssqlPool): QueryInterface<Record<string, unknown>> {
  return new QueryInterface<Record<string, unknown>>(
    // biome-ignore lint/suspicious/noExplicitAny: MssqlPool stands in for pg.Pool
    pool as any,
    'users',
    schema,
    [],
    { dialect: mssqlDialect, preparedStatements: false, sqlCache: false },
  );
}

describe('turbine-orm/mssql — MssqlPool binds @pN inputs', () => {
  it('binds positional params into request.input(pN, value) by name', async () => {
    const { pool, sqlNS, calls } = fakeMssql({ rowsFor: () => [{ id: 5 }] });
    const mp = new MssqlPool(pool, sqlNS);
    await mp.query('SELECT * FROM [users] WHERE [id] = @p1 AND [org_id] = @p2', [5, 9]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.inputs, { p1: 5, p2: 9 });
  });

  it('booleans bind as JS booleans (SQL Server BIT), not 1/0', async () => {
    const { pool, sqlNS, calls } = fakeMssql();
    const mp = new MssqlPool(pool, sqlNS);
    await mp.query('UPDATE [posts] SET [published] = @p1 WHERE [id] = @p2', [true, 3]);
    assert.deepEqual(calls[0]!.inputs, { p1: true, p2: 3 });
  });

  it('routes BEGIN/COMMIT through the mssql Transaction API with the mapped isolation level', async () => {
    const { pool, sqlNS, txEvents } = fakeMssql();
    const mp = new MssqlPool(pool, sqlNS);
    const client = await mp.connect();
    await client.query(mssqlDialect.beginStatement('SERIALIZABLE'));
    await client.query(mssqlDialect.commitStatement());
    assert.deepEqual(txEvents, ['begin:4', 'commit']);
  });

  it('RELEASE SAVEPOINT (empty statement) is a no-op', async () => {
    const { pool, sqlNS, calls } = fakeMssql();
    const mp = new MssqlPool(pool, sqlNS);
    const client = await mp.connect();
    await client.query(mssqlDialect.releaseSavepointStatement('sp_1'));
    assert.equal(calls.length, 0, 'empty release statement runs no SQL');
  });
});

describe('turbine-orm/mssql — output result strategy (mock driver)', () => {
  it('create: single INSERT … OUTPUT INSERTED.* returns the row in ONE statement (no reselect)', async () => {
    const { pool, sqlNS, calls } = fakeMssql({
      rowsFor: (sql) => (/^INSERT/.test(sql) ? [{ id: 7, name: 'Grace' }] : []),
    });
    const created = await mssqlQuery(new MssqlPool(pool, sqlNS)).create({ data: { id: 7, name: 'Grace' } });

    assert.deepEqual(created, { id: 7, name: 'Grace' });
    assert.equal(calls.length, 1, 'output strategy is a single statement (no reselect SELECT)');
    assert.match(calls[0]!.sql, /OUTPUT INSERTED\.\*/);
    assert.doesNotMatch(calls[0]!.sql, /RETURNING/);
    assert.deepEqual(calls[0]!.inputs, { p1: 7, p2: 'Grace' });
  });

  it('upsert: single MERGE … OUTPUT INSERTED.* returns the row, params bound by name', async () => {
    const { pool, sqlNS, calls } = fakeMssql({
      rowsFor: (sql) => (/MERGE/.test(sql) ? [{ id: 1, name: 'Ada L.' }] : []),
    });
    const updated = await mssqlQuery(new MssqlPool(pool, sqlNS)).upsert({
      where: { id: 1 },
      create: { id: 1, name: 'Ada' },
      update: { name: 'Ada L.' },
    });

    assert.deepEqual(updated, { id: 1, name: 'Ada L.' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /^MERGE INTO \[users\]/);
    assert.match(calls[0]!.sql, /OUTPUT INSERTED\.\*;$/);
    assert.deepEqual(calls[0]!.inputs, { p1: 1, p2: 'Ada', p3: 'Ada L.' });
  });

  it('update: single UPDATE … OUTPUT INSERTED.* returns the updated row', async () => {
    const { pool, sqlNS, calls } = fakeMssql({
      rowsFor: (sql) => (/^UPDATE/.test(sql) ? [{ id: 1, name: 'Ada L.' }] : []),
    });
    const updated = await mssqlQuery(new MssqlPool(pool, sqlNS)).update({ where: { id: 1 }, data: { name: 'Ada L.' } });

    assert.deepEqual(updated, { id: 1, name: 'Ada L.' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /^UPDATE \[users\] SET .* OUTPUT INSERTED\.\* WHERE/);
  });

  it('delete: single DELETE … OUTPUT DELETED.* returns the removed row', async () => {
    const { pool, sqlNS, calls } = fakeMssql({
      rowsFor: (sql) => (/^DELETE/.test(sql) ? [{ id: 1, name: 'Ada' }] : []),
    });
    const deleted = await mssqlQuery(new MssqlPool(pool, sqlNS)).delete({ where: { id: 1 } });

    assert.deepEqual(deleted, { id: 1, name: 'Ada' });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /^DELETE FROM \[users\] OUTPUT DELETED\.\* WHERE/);
  });

  it('createMany: single multi-row INSERT … OUTPUT INSERTED.* returns the rows', async () => {
    const rows = [
      { id: 1, name: 'Ada' },
      { id: 2, name: 'Grace' },
    ];
    const { pool, sqlNS, calls } = fakeMssql({ rowsFor: (sql) => (/^INSERT/.test(sql) ? rows : []) });
    const created = await mssqlQuery(new MssqlPool(pool, sqlNS)).createMany({ data: rows });

    assert.deepEqual(created, rows);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /OUTPUT INSERTED\.\* VALUES \(@p1, @p2\), \(@p3, @p4\)/);
    assert.deepEqual(calls[0]!.inputs, { p1: 1, p2: 'Ada', p3: 2, p4: 'Grace' });
  });
});

// ===========================================================================
// Tier 1c — introspector (mock executor)
// ===========================================================================

describe('turbine-orm/mssql — introspector (mock executor)', () => {
  it('maps INFORMATION_SCHEMA + sys.* rows into SchemaMetadata (columns, PK, FK relations, m2m, indexes)', async () => {
    const exec: MssqlRowExecutor = async (sql) => {
      if (/INFORMATION_SCHEMA\.TABLES/.test(sql))
        return [
          { TABLE_NAME: 'organizations' },
          { TABLE_NAME: 'users' },
          { TABLE_NAME: 'posts' },
          { TABLE_NAME: 'post_tags' },
          { TABLE_NAME: 'tags' },
        ];
      if (/sys\.identity_columns/.test(sql))
        return [
          { TABLE_NAME: 'organizations', COLUMN_NAME: 'id' },
          { TABLE_NAME: 'users', COLUMN_NAME: 'id' },
          { TABLE_NAME: 'posts', COLUMN_NAME: 'id' },
          { TABLE_NAME: 'tags', COLUMN_NAME: 'id' },
        ];
      if (/INFORMATION_SCHEMA\.COLUMNS/.test(sql))
        return [
          col('organizations', 'id', 'bigint'),
          col('organizations', 'plan', 'nvarchar', 'NO', 50),
          col('users', 'id', 'bigint'),
          col('users', 'org_id', 'bigint'),
          col('users', 'email', 'nvarchar', 'NO', 255),
          col('users', 'created_at', 'datetime2'),
          col('posts', 'id', 'bigint'),
          col('posts', 'user_id', 'bigint'),
          col('post_tags', 'post_id', 'bigint'),
          col('post_tags', 'tag_id', 'bigint'),
          col('tags', 'id', 'bigint'),
        ];
      if (/PRIMARY KEY/.test(sql))
        return [
          pk('organizations', 'id', 1),
          pk('users', 'id', 1),
          pk('posts', 'id', 1),
          pk('tags', 'id', 1),
          pk('post_tags', 'post_id', 1),
          pk('post_tags', 'tag_id', 2),
        ];
      if (/sys\.foreign_keys/.test(sql))
        return [
          fk('users', 'org_id', 'organizations', 'id', 'fk_users_org', 1),
          fk('posts', 'user_id', 'users', 'id', 'fk_posts_user', 1),
          fk('post_tags', 'post_id', 'posts', 'id', 'fk_pt_post', 1),
          fk('post_tags', 'tag_id', 'tags', 'id', 'fk_pt_tag', 1),
        ];
      if (/sys\.indexes/.test(sql))
        return [idx('users', 'UQ_users_email', 1, 'email', 1), idx('users', 'IX_users_org_id', 0, 'org_id', 1)];
      return [];
    };

    const meta = await introspectMssqlWith(exec, 'dbo');
    assert.deepEqual(Object.keys(meta.tables).sort(), ['organizations', 'post_tags', 'posts', 'tags', 'users']);
    assert.deepEqual(meta.tables.users!.primaryKey, ['id']);
    assert.deepEqual(meta.tables.post_tags!.primaryKey, ['post_id', 'tag_id']);
    assert.equal(meta.tables.users!.reverseColumnMap.org_id, 'orgId');
    assert.ok(meta.tables.users!.dateColumns.has('created_at'));
    // identity columns are flagged hasDefault
    assert.equal(meta.tables.users!.columns.find((c) => c.name === 'id')!.hasDefault, true);
    // relations
    assert.equal(meta.tables.users!.relations.posts?.type, 'hasMany');
    assert.equal(meta.tables.users!.relations.organization?.type, 'belongsTo');
    assert.equal(meta.tables.posts!.relations.user?.type, 'belongsTo');
    // many-to-many auto-detection through post_tags
    assert.equal(meta.tables.posts!.relations.tags?.type, 'manyToMany');
    assert.equal(meta.tables.posts!.relations.tags?.through?.table, 'post_tags');
    // unique + index
    assert.ok(meta.tables.users!.uniqueColumns.some((c) => c.length === 1 && c[0] === 'email'));
    assert.ok(meta.tables.users!.indexes.some((i) => i.name === 'IX_users_org_id'));
  });
});

// Tiny row-builders for the introspector mock.
function col(t: string, c: string, dt: string, nn = 'NO', maxLen: number | null = null) {
  return {
    TABLE_NAME: t,
    COLUMN_NAME: c,
    DATA_TYPE: dt,
    IS_NULLABLE: nn,
    COLUMN_DEFAULT: null,
    CHARACTER_MAXIMUM_LENGTH: maxLen,
  };
}
function pk(t: string, c: string, pos: number) {
  return { TABLE_NAME: t, COLUMN_NAME: c, ORDINAL_POSITION: pos };
}
function fk(t: string, c: string, rt: string, rc: string, name: string, pos: number) {
  return {
    CONSTRAINT_NAME: name,
    TABLE_NAME: t,
    COLUMN_NAME: c,
    REFERENCED_TABLE_NAME: rt,
    REFERENCED_COLUMN_NAME: rc,
    ORDINAL_POSITION: pos,
  };
}
function idx(t: string, name: string, isUnique: number, c: string, seq: number) {
  return { TABLE_NAME: t, INDEX_NAME: name, IS_UNIQUE: isUnique, COLUMN_NAME: c, SEQ: seq };
}

// ===========================================================================
// Tier 2 — real integration tests (gated on MSSQL_URL)
// ===========================================================================

const MSSQL_URL = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const gate = skipGate(!MSSQL_URL, 'requires MSSQL_URL pointing at a SQL Server 2016+ instance');

// SQL Server port of src/test/fixtures/seed.sql (+ a tags/post_tags m2m junction).
const DDL = [
  `CREATE TABLE organizations (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL,
    slug NVARCHAR(255) NOT NULL UNIQUE,
    [plan] NVARCHAR(50) NOT NULL DEFAULT 'free',
    metadata NVARCHAR(MAX),
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  )`,
  `CREATE TABLE users (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    org_id BIGINT NOT NULL,
    email NVARCHAR(255) NOT NULL UNIQUE,
    name NVARCHAR(255) NOT NULL,
    role NVARCHAR(50) NOT NULL DEFAULT 'member',
    avatar_url NVARCHAR(255),
    last_login_at DATETIME2,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_users_org FOREIGN KEY (org_id) REFERENCES organizations(id)
  )`,
  `CREATE INDEX IX_users_org_id ON users(org_id)`,
  `CREATE TABLE posts (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id BIGINT NOT NULL,
    org_id BIGINT NOT NULL,
    title NVARCHAR(255) NOT NULL,
    content NVARCHAR(MAX) NOT NULL,
    published BIT NOT NULL DEFAULT 0,
    view_count INT NOT NULL DEFAULT 0,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id),
    CONSTRAINT fk_posts_org FOREIGN KEY (org_id) REFERENCES organizations(id)
  )`,
  `CREATE INDEX IX_posts_user_id ON posts(user_id)`,
  `CREATE TABLE comments (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    post_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    body NVARCHAR(MAX) NOT NULL,
    created_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
    CONSTRAINT fk_comments_post FOREIGN KEY (post_id) REFERENCES posts(id),
    CONSTRAINT fk_comments_user FOREIGN KEY (user_id) REFERENCES users(id)
  )`,
  `CREATE TABLE tags (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL UNIQUE
  )`,
  `CREATE TABLE post_tags (
    post_id BIGINT NOT NULL,
    tag_id BIGINT NOT NULL,
    CONSTRAINT pk_post_tags PRIMARY KEY (post_id, tag_id),
    CONSTRAINT fk_pt_post FOREIGN KEY (post_id) REFERENCES posts(id),
    CONSTRAINT fk_pt_tag FOREIGN KEY (tag_id) REFERENCES tags(id)
  )`,
];

const SEED = [
  `SET IDENTITY_INSERT organizations ON;
   INSERT INTO organizations (id, name, slug, [plan], metadata) VALUES
    (1, 'Acme Inc', 'acme', 'enterprise', '{"tier":"enterprise"}'),
    (2, 'Beta LLC', 'beta', 'pro', '{"tier":"pro"}');
   SET IDENTITY_INSERT organizations OFF;`,
  `SET IDENTITY_INSERT users ON;
   INSERT INTO users (id, org_id, email, name, role, avatar_url) VALUES
    (1, 1, 'user1@example.com', 'Alice Admin',  'admin',  'https://a/1.png'),
    (2, 1, 'user2@example.com', 'Bob Editor',   'editor', 'https://a/2.png'),
    (3, 1, 'user3@example.com', 'Carol Member', 'member', NULL),
    (4, 2, 'user4@example.com', 'Dave Admin',   'admin',  NULL);
   SET IDENTITY_INSERT users OFF;`,
  `SET IDENTITY_INSERT posts ON;
   INSERT INTO posts (id, user_id, org_id, title, content, published, view_count) VALUES
    (1, 1, 1, 'Hello World',  'First post body', 1, 100),
    (2, 1, 1, 'Second Post',  'More content',    1, 75),
    (3, 1, 1, 'Draft Post',   'Not ready',       0, 0),
    (4, 2, 1, 'Editor Post',  'By the editor',   1, 42),
    (5, 4, 2, 'Org 2 Post',   'Across orgs',     1, 60);
   SET IDENTITY_INSERT posts OFF;`,
  `INSERT INTO comments (post_id, user_id, body) VALUES
    (1, 2, 'Nice post!'), (1, 3, 'I agree'), (2, 2, 'Solid follow up'), (4, 1, 'Approved by admin')`,
  `SET IDENTITY_INSERT tags ON;
   INSERT INTO tags (id, name) VALUES (1, 'tech'), (2, 'news'), (3, 'draft');
   SET IDENTITY_INSERT tags OFF;`,
  `INSERT INTO post_tags (post_id, tag_id) VALUES (1, 1), (1, 2), (2, 1), (3, 3)`,
];

const ALL_TABLES = ['post_tags', 'comments', 'posts', 'tags', 'users', 'organizations'];

interface UserRow {
  id: number;
  orgId: number;
  email: string;
  name: string;
  role: string;
  posts?: PostRow[];
}
interface PostRow {
  id: number;
  userId: number;
  title: string;
  viewCount: number;
  published: boolean;
  user?: UserRow;
  comments?: { id: number; body: string; user?: UserRow }[];
  tags?: { id: number; name: string }[];
}

describe('turbine-orm/mssql — integration (real SQL Server)', () => {
  // biome-ignore lint/suspicious/noExplicitAny: mssql pool loaded dynamically only when gated on.
  let rawPool: any;
  let pool: MssqlPool;
  // biome-ignore lint/suspicious/noExplicitAny: TurbineClient, kept loose to avoid importing into the unit lane
  let client: any;
  let dbSchema: SchemaMetadata;

  gate.before(async () => {
    // `mssql` ships no bundled types — widen the specifier so tsc treats it as
    // `any` (TS7016) without @types/mssql. This path only runs when gated on.
    const mssqlSpecifier: string = 'mssql';
    // biome-ignore lint/suspicious/noExplicitAny: dynamic mssql import only on the gated path
    const mod: any = await import(mssqlSpecifier);
    const mssql = mod.default ?? mod;
    const url = new URL(MSSQL_URL);
    rawPool = await new mssql.ConnectionPool({
      server: url.hostname,
      port: url.port ? Number(url.port) : 1433,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ''),
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    pool = new MssqlPool(rawPool, mssql.default ?? mssql);
    await resetSchema();
    dbSchema = await introspectMssqlWith(async (sql, params) => (await pool.query(sql, params)).rows, 'dbo');
    client = await turbineMssql(pool, dbSchema);
  });

  gate.after(async () => {
    if (!MSSQL_URL) return;
    await dropAll();
    await rawPool.close();
  });

  beforeEach(async () => {
    if (!MSSQL_URL) return;
    await reseed();
  });

  async function dropAll() {
    for (const t of ALL_TABLES) await rawPool.request().batch(`IF OBJECT_ID('${t}','U') IS NOT NULL DROP TABLE ${t}`);
  }
  async function resetSchema() {
    await dropAll();
    for (const stmt of DDL) await rawPool.request().batch(stmt);
    for (const stmt of SEED) await rawPool.request().batch(stmt);
  }
  async function reseed() {
    for (const t of ALL_TABLES) await rawPool.request().batch(`DELETE FROM ${t}`);
    for (const stmt of SEED) await rawPool.request().batch(stmt);
  }

  gate.it('introspection discovers tables, PKs, relations, m2m', () => {
    assert.deepEqual(
      Object.keys(dbSchema.tables).sort(),
      ['comments', 'organizations', 'post_tags', 'posts', 'tags', 'users'].sort(),
    );
    assert.deepEqual(dbSchema.tables.post_tags!.primaryKey, ['post_id', 'tag_id']);
    assert.equal(dbSchema.tables.users!.relations.posts?.type, 'hasMany');
    assert.equal(dbSchema.tables.posts!.relations.tags?.type, 'manyToMany');
  });

  gate.it('findMany with where + orderBy + OFFSET/FETCH paging', async () => {
    const admins = await client
      .table('users')
      .findMany({ where: { role: 'admin' }, orderBy: { id: 'asc' }, limit: 10 });
    assert.deepEqual(
      admins.map((u: UserRow) => u.id),
      [1, 4],
    );
  });

  gate.it('IN operator via OPENJSON', async () => {
    const staff = await client
      .table('users')
      .findMany({ where: { role: { in: ['admin', 'editor'] } }, orderBy: { id: 'asc' } });
    assert.deepEqual(
      staff.map((u: UserRow) => u.role),
      ['admin', 'editor', 'admin'],
    );
  });

  gate.it('nested with via FOR JSON PATH returns a real object tree (parity with PG)', async () => {
    const users = await client.table('users').findMany({
      where: { id: 1 },
      with: { posts: { with: { comments: { with: { user: true } } } } },
    });
    const alice = users[0];
    assert.ok(Array.isArray(alice.posts));
    assert.equal(alice.posts.length, 3);
    const post = alice.posts.find((p: PostRow) => p.id === 1);
    assert.equal(post.title, 'Hello World');
    assert.ok(Array.isArray(post.comments));
    assert.equal(post.comments.length, 2);
    assert.equal(typeof post.comments[0].user, 'object');
    assert.equal(typeof post.comments[0].user.email, 'string');
  });

  gate.it('belongsTo + manyToMany nesting (WITHOUT_ARRAY_WRAPPER + junction)', async () => {
    const posts = await client.table('posts').findMany({ where: { id: 4 }, with: { user: true } });
    assert.equal(posts[0].user.name, 'Bob Editor');
    assert.ok(!Array.isArray(posts[0].user));
    const tagged = await client.table('posts').findMany({ where: { id: 1 }, with: { tags: true } });
    assert.deepEqual(tagged[0].tags.map((t: { name: string }) => t.name).sort(), ['news', 'tech']);
  });

  gate.it('ordered + limited to-many (OFFSET/FETCH inside FOR JSON)', async () => {
    const users = await client.table('users').findMany({
      where: { id: 1 },
      with: { posts: { orderBy: { viewCount: 'desc' }, limit: 2 } },
    });
    assert.deepEqual(
      users[0].posts.map((p: PostRow) => p.viewCount),
      [100, 75],
    );
  });

  gate.it('create returns the inserted row via OUTPUT INSERTED.* (one statement)', async () => {
    const created = await client
      .table('users')
      .create({ data: { orgId: 2, email: 'new@example.com', name: 'New User', role: 'member' } });
    assert.equal(typeof created.id, 'number');
    assert.equal(created.email, 'new@example.com');
  });

  gate.it('createMany returns the inserted rows via OUTPUT INSERTED.*', async () => {
    const result = await client.table('tags').createMany({ data: [{ name: 'alpha' }, { name: 'beta' }] });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((t: { name: string }) => t.name).sort(), ['alpha', 'beta']);
  });

  gate.it('upsert via MERGE inserts then updates on conflict', async () => {
    const updated = await client
      .table('tags')
      .upsert({ where: { id: 1 }, create: { id: 1, name: 'tech' }, update: { name: 'technology' } });
    assert.equal(updated.name, 'technology');
  });

  gate.it('update returns the updated row (BIT round-trips as boolean)', async () => {
    const updated = await client.table('posts').update({ where: { id: 3 }, data: { published: true, viewCount: 5 } });
    assert.equal(updated.id, 3);
    assert.equal(updated.published, true);
    assert.equal(updated.viewCount, 5);
  });

  gate.it('delete returns the removed row', async () => {
    const tmp = await client.table('tags').create({ data: { name: 'temp-del' } });
    const removed = await client.table('tags').delete({ where: { id: tmp.id } });
    assert.equal(removed.name, 'temp-del');
    assert.equal(await client.table('tags').findUnique({ where: { id: tmp.id } }), null);
  });

  gate.it('count + aggregate use CAST (not ::int/::float)', async () => {
    assert.equal(await client.table('posts').count({ where: { published: true } }), 4);
    const agg = await client.table('posts').aggregate({ _count: true, _sum: { viewCount: true } });
    assert.equal(agg._count, 5);
    assert.equal(Number(agg._sum.viewCount), 277);
  });

  gate.it('commits a $transaction and rolls back on throw', async () => {
    await client.$transaction(async (tx: typeof client) => {
      await tx.table('tags').create({ data: { name: 'committed' } });
    });
    assert.equal((await client.table('tags').findMany({ where: { name: 'committed' } })).length, 1);

    await assert.rejects(
      client.$transaction(async (tx: typeof client) => {
        await tx.table('tags').create({ data: { name: 'rolled-back' } });
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal((await client.table('tags').findMany({ where: { name: 'rolled-back' } })).length, 0);
  });

  gate.it('nested savepoint rolls back inner without losing outer (SAVE TRANSACTION)', async () => {
    await client.$transaction(async (tx: typeof client) => {
      await tx.table('tags').create({ data: { name: 'outer' } });
      await tx
        .$transaction(async (inner: typeof client) => {
          await inner.table('tags').create({ data: { name: 'inner' } });
          throw new Error('inner-fail');
        })
        .catch(() => {});
    });
    assert.equal((await client.table('tags').findMany({ where: { name: 'outer' } })).length, 1);
    assert.equal((await client.table('tags').findMany({ where: { name: 'inner' } })).length, 0);
  });

  gate.it('UNIQUE violation surfaces a typed error (E008)', async () => {
    await assert.rejects(
      client.table('users').create({ data: { orgId: 1, email: 'user1@example.com', name: 'Dup' } }),
      (err: unknown) => (err as { code?: string }).code === 'TURBINE_E008',
    );
  });

  gate.it('unsupported features throw UnsupportedFeatureError', async () => {
    const { UnsupportedFeatureError } = await import('../errors.js');
    await assert.rejects(
      client.$listen('ch', () => {}),
      UnsupportedFeatureError,
    );
    await assert.rejects(
      client.$transaction(async () => {}, { sessionContext: { 'app.tenant': '1' } }),
      UnsupportedFeatureError,
    );
  });
});
