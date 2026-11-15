/** Optional native proof requires an explicitly supplied disposable SQL Server database. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createMssqlToolPool,
  introspectMssqlToolClient,
  mssqlToolIndexSummary,
  releaseMssqlToolClient,
} from '../cli/mssql-tools.js';
import { turbineMssql } from '../mssql.js';
import { skipGate } from './helpers.js';

const url = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const native = skipGate(!url, 'requires MSSQL_URL pointing at a disposable SQL Server 2016+ test database');
native.it(
  'reads native scoped catalogs and withholds default/computed/filter literals without executing data SQL',
  async () => {
    const schema = `turbine_tools_${randomUUID().replaceAll('-', '')}`;
    const db = await turbineMssql(url, { tables: {}, enums: {} });
    const pool = createMssqlToolPool(url, schema);
    try {
      await db.pool.query(`CREATE SCHEMA [${schema}]`);
      await db.pool.query(`CREATE TABLE [${schema}].[users] (
      id INT IDENTITY PRIMARY KEY,
      display_name NVARCHAR(100) NOT NULL DEFAULT 'private-default@example.test',
      derived AS (display_name + 'private-computed@example.test') PERSISTED)`);
      await db.pool.query(`CREATE INDEX [filtered_name] ON [${schema}].[users](display_name)
      WHERE display_name <> 'private-filter@example.test'`);
      await db.pool.query(`CREATE TABLE [${schema}].[posts] (id INT PRIMARY KEY,
      user_id INT NOT NULL REFERENCES [${schema}].[users](id))`);
      await db.pool.query(`INSERT INTO [${schema}].[users](display_name) VALUES (@p1)`, ['unchanged sentinel']);
      const client = await pool.connect();
      try {
        const metadata = await introspectMssqlToolClient(client, {});
        assert.deepEqual(Object.keys(metadata.tables), ['posts', 'users']);
        const users = metadata.tables.users!;
        assert.equal(users.columns.find((column) => column.name === 'id')!.isGenerated, true);
        assert.equal(users.columns.find((column) => column.name === 'derived')!.isGeneratedStored, true);
        assert.equal(users.columns.find((column) => column.name === 'display_name')!.hasDefault, true);
        assert.equal(
          mssqlToolIndexSummary(users.indexes.find((index) => index.name === 'filtered_name')!)!.partial,
          true,
        );
        assert.ok(Object.values(metadata.tables.posts!.relations).some((relation) => relation.to === 'users'));
        assert.doesNotMatch(
          JSON.stringify(metadata),
          /private-default|private-computed|private-filter|unchanged sentinel/,
        );
        assert.throws(() => client.query(`DELETE FROM [${schema}].[users]`), /fixed catalog/);
        const rows = await db.pool.query(`SELECT display_name FROM [${schema}].[users]`);
        assert.deepEqual(rows.rows, [{ display_name: 'unchanged sentinel' }]);
        const filtered = await introspectMssqlToolClient(client, { exclude: ['posts'] });
        assert.deepEqual(Object.keys(filtered.tables), ['users']);
      } finally {
        await releaseMssqlToolClient(client);
      }
    } finally {
      await pool.end();
      try {
        await db.pool.query(`DROP TABLE IF EXISTS [${schema}].[posts]`);
        await db.pool.query(`DROP TABLE IF EXISTS [${schema}].[users]`);
        await db.pool.query(`IF SCHEMA_ID(@p1) IS NOT NULL EXEC('DROP SCHEMA [${schema}]')`, [schema]);
      } finally {
        await db.disconnect();
      }
    }
  },
);
