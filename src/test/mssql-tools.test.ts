import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileQueryPlan, SEALED_POOL } from '../cli/compile-query.js';
import {
  createMssqlToolPool,
  introspectMssqlToolClient,
  MSSQL_CATALOG_TOOLS,
  mssqlToolRuntime,
  mssqlToolSupported,
  mssqlToolTransport,
  releaseMssqlToolClient,
} from '../cli/mssql-tools.js';
import { mssqlDialect } from '../mssql.js';
import { mockColumn, mockTable } from './helpers.js';

describe('SQL Server catalog tools', () => {
  it('advertises only catalog, compilation and connection-free tools', () => {
    assert.equal(MSSQL_CATALOG_TOOLS.length, 8);
    for (const name of MSSQL_CATALOG_TOOLS) assert.equal(mssqlToolSupported(name), true);
    for (const name of ['sample_rows', 'explain_query', 'migrate_status', 'table_stats', 'nope']) {
      assert.equal(mssqlToolSupported(name), false, name);
    }
    assert.equal(mssqlToolTransport.transactions, false);
    assert.equal(mssqlToolTransport.readOnlyEnforcement, 'fixed-catalog-queries-only');
    assert.match(mssqlToolTransport.note, /not a consistent snapshot/);
    assert.equal(mssqlToolRuntime().minimumNode, null);
    assert.equal(typeof mssqlToolRuntime().available, 'boolean');
  });

  it('refuses malformed targets without exposing URL credentials', () => {
    for (const url of [
      'postgres://u:private@host/db',
      'mssql://host',
      'mssql://host/db?password=private',
      'mssql://host/db#private',
      'mssql://host/a%2Fb',
      'mssql://u:%xx@host/db',
    ]) {
      assert.throws(
        () => createMssqlToolPool(url, 'dbo'),
        (error: Error) => {
          assert.doesNotMatch(error.message, /private|%xx/);
          return /require mssql:/.test(error.message);
        },
      );
    }
    for (const schema of ['', '\0', 'x\n', 'x'.repeat(129)]) {
      assert.throws(() => createMssqlToolPool('mssql://host/db', schema), /schema identifier/);
    }
  });

  it('refuses public SQL, forged clients and use after transport shutdown', async () => {
    const pool = createMssqlToolPool('mssql://host/db', 'dbo');
    assert.throws(() => pool.query('SELECT 1'), /fixed catalog/);
    assert.throws(() => pool.query('BEGIN READ ONLY'), /fixed catalog/);
    await assert.rejects(introspectMssqlToolClient(SEALED_POOL as never, {}), /active owned/);
    await assert.rejects(releaseMssqlToolClient(SEALED_POOL as never), /owned catalog/);
    await pool.end();
    await pool.end();
    await assert.rejects(pool.connect(), /closed/);
  });

  it('uses the existing sealed compiler for native parameters, paging and nested relations', () => {
    const users = mockTable('users', [
      mockColumn('id', 'id', 'int'),
      mockColumn('display_name', 'displayName', 'nvarchar'),
    ]);
    users.primaryKey = ['id'];
    const posts = mockTable('posts', [mockColumn('id', 'id', 'int'), mockColumn('user_id', 'userId', 'int')]);
    users.relations.posts = {
      name: 'posts',
      type: 'hasMany',
      from: 'users',
      to: 'posts',
      foreignKey: 'user_id',
      referenceKey: 'id',
    };
    const result = compileQueryPlan({
      metadata: { tables: { users, posts }, enums: {} },
      table: users,
      dialect: mssqlDialect,
      operation: 'findMany',
      args: { where: { displayName: 'caller-value' }, limit: 3, with: { posts: true } },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.sql, /FOR JSON PATH/);
    assert.match(result.sql, /@p1/);
    assert.match(result.sql, /OFFSET .* FETCH NEXT/);
    assert.doesNotMatch(result.sql, /caller-value/);
    assert.ok(result.params.includes('caller-value'));
    for (const method of ['query', 'connect', 'end'] as const)
      assert.throws(() => SEALED_POOL[method]('' as never), /compile-query/);
  });
});
