/** Native service proof: disposable objects only, required-engine gate refuses silent skips. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../cli/config.js';
import { introspectMssqlProject } from '../cli/mssql-project.js';
import { turbineMssql } from '../mssql.js';
import { skipGate } from './helpers.js';

const url = process.env.MSSQL_URL ?? process.env.MSSQL_TEST_URL ?? '';
const native = skipGate(!url, 'requires MSSQL_URL pointing at a disposable SQL Server 2016+ test database');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

native.it('introspects isolated schemas and runs the native CLI init/pull/filter/override lifecycle', async () => {
  const id = randomUUID().replaceAll('-', '');
  const namespace = `turbine_cli_${id}`;
  const table = `cli_rows_${id}`;
  const consumer = mkdtempSync(join(tmpdir(), 'turbine-mssql-native-cli-'));
  // A consumer project has tsx installed; the CLI resolves it from the project to load turbine.config.ts.
  symlinkSync(join(repo, 'node_modules'), join(consumer, 'node_modules'), 'dir');
  const db = await turbineMssql(url, { tables: {}, enums: {} });
  const config = resolveConfig({ engine: 'mssql', url, schema: namespace, include: [table] }, { url });
  function cli(args: string[], success = true) {
    const result = spawnSync(
      process.execPath,
      ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'src/cli/index.ts'), ...args],
      {
        cwd: consumer,
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, DATABASE_URL: url, NO_COLOR: '1' },
      },
    );
    const output = `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`;
    assert.equal(result.status, success ? 0 : 1, output);
    return output;
  }
  try {
    await db.pool.query(`CREATE SCHEMA [${namespace}]`);
    await db.pool.query(
      `CREATE TABLE [${namespace}].[${table}] (id INT IDENTITY PRIMARY KEY, display_name NVARCHAR(100) NOT NULL)`,
    );
    await db.pool.query(`CREATE TABLE [dbo].[${table}] (id INT PRIMARY KEY, different_column BIT NOT NULL)`);
    await db.pool.query(`INSERT INTO [${namespace}].[${table}] (display_name) VALUES (@p1)`, ['native catalog effect']);
    const rows = await db.pool.query(`SELECT display_name FROM [${namespace}].[${table}]`);
    assert.deepEqual(rows.rows, [{ display_name: 'native catalog effect' }]);
    const schema = await introspectMssqlProject(config);
    assert.deepEqual(Object.keys(schema.tables), [table]);
    assert.ok(schema.tables[table]!.columns.some((c) => c.name === 'display_name'));
    assert.equal(schema.tables[table]!.columns[0]!.hasDefault, true);
    const other = await introspectMssqlProject({ ...config, schema: 'dbo' });
    assert.ok(other.tables[table]!.columns.some((c) => c.name === 'different_column'));
    assert.ok(!other.tables[table]!.columns.some((c) => c.name === 'display_name'));
    // Init must use the requested schema and perform no DDL or seeding.
    cli(['init', '--engine', 'mssql', '--schema', namespace, '--include', table, '--out', './generated', '--yes']);
    const nativeTypes = readFileSync(join(consumer, 'generated/types.ts'), 'utf8');
    assert.match(nativeTypes, /displayName: string/);
    assert.doesNotMatch(nativeTypes, /differentColumn/);
    cli(['status']);
    cli(['pull', '--no-timestamp', '--keep-column-names']);
    assert.match(readFileSync(join(consumer, 'generated/types.ts'), 'utf8'), /display_name: string/);
    // Validate a type override and the typo control through the real native connection.
    writeFileSync(
      join(consumer, 'turbine.config.ts'),
      `export default ${JSON.stringify({
        engine: 'mssql',
        schema: namespace,
        include: [table],
        out: './generated',
        columnTypes: { [`${table}.display_name`]: "'native catalog effect'" },
      })};\n`,
    );
    cli(['generate', '--no-timestamp']);
    assert.match(readFileSync(join(consumer, 'generated/types.ts'), 'utf8'), /displayName: 'native catalog effect'/);
    const absent = await introspectMssqlProject({ ...config, schema: `${namespace}_missing` });
    assert.equal(Object.keys(absent.tables).length, 0);
    cli(['pull', '--schema', `${namespace}_missing`, '--out', './empty'], false);
    assert.equal(existsSync(join(consumer, 'empty/index.ts')), false);
    assert.match(cli(['migrate', 'deploy', '--force'], false), /refuse/);
    assert.deepEqual((await db.pool.query(`SELECT display_name FROM [${namespace}].[${table}]`)).rows, rows.rows);
  } finally {
    try {
      await db.pool.query(`DROP TABLE IF EXISTS [${namespace}].[${table}]`);
      await db.pool.query(`DROP TABLE IF EXISTS [dbo].[${table}]`);
      await db.pool.query(`IF SCHEMA_ID(@p1) IS NOT NULL EXEC('DROP SCHEMA [${namespace}]')`, [namespace]);
    } finally {
      await db.disconnect();
      rmSync(consumer, { recursive: true, force: true });
    }
  }
});
