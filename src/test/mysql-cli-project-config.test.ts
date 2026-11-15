import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mysqlDatabaseFromUrl, resolveConfig, validateCliEngineUrl } from '../cli/config.js';
import { assertMysqlProjectCommand, introspectMysqlProject, mysqlConfigTemplate } from '../cli/mysql-project.js';

function withoutEnv(fn: () => void): void {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
}

const url = 'mysql://user:secret@127.0.0.1:3306/app';
describe('MySQL project configuration', () => {
  it('resolves the explicit engine, URL database and existing flag/environment precedence', () => {
    withoutEnv(() => {
      const config = resolveConfig({ engine: 'mysql', url }, {});
      assert.equal(config.engine, 'mysql');
      assert.equal(config.schema, 'app');
      assert.equal(config.url, url);
      assert.equal(mysqlDatabaseFromUrl('mysql://localhost/a%20b'), 'a b');
      assert.equal(mysqlDatabaseFromUrl('mysql://[::1]/app'), 'app');
      process.env.DATABASE_URL = 'mysql://localhost/from_env';
      assert.equal(resolveConfig({ engine: 'mysql', url }, {}).schema, 'from_env');
      assert.equal(resolveConfig({ engine: 'mysql', url }, { url: 'mysql://localhost/from_flag' }).schema, 'from_flag');
      assert.throws(() => resolveConfig({ engine: 'mysql', url, schema: 'app' }, {}), /schema must match/);
      delete process.env.DATABASE_URL;
      assert.equal(resolveConfig({}, {}).engine, 'postgresql');
      assert.throws(() => resolveConfig({ url }, {}), /requires engine "mysql"/);
      assert.throws(() => resolveConfig({ engine: 'mysql', url, adapter: {} as never }, {}), /adapters/);
      const template = mysqlConfigTemplate(config);
      assert.match(template, /engine: 'mysql'/);
      assert.match(template, /process.env.DATABASE_URL/);
      assert.doesNotMatch(template, /secret|127\.0\.0\.1/);
    });
  });

  it('rejects mixed engines, malformed URLs and ignored connection options without echoing secrets', () => {
    for (const value of [
      '',
      ' ',
      'postgres://localhost/app',
      'host=localhost dbname=app',
      'file:./app.db',
      'mysql://localhost',
      'mysql:///app',
      'mysql://localhost/a/b',
      'mysql://localhost/a%2Fb',
      'mysql://localhost/a%00b',
      'mysql://localhost/a%ZZ',
      'mysql://u:%ZZ@localhost/app',
      'mysql://localhost:65536/app',
      'mysql://localhost/app?ssl=true',
      'mysql://localhost/app#secret',
      'mysql://localhost/app?',
      'mysql://localhost/app#',
      'mysql://localhost/app\n',
    ]) {
      assert.throws(
        () => mysqlDatabaseFromUrl(value),
        (error: unknown) => {
          assert.ok(error instanceof TypeError);
          assert.match(error.message, /MySQL CLI requires mysql:/);
          assert.doesNotMatch(error.message, /ZZ|ssl=true|secret/);
          return true;
        },
      );
    }
    assert.throws(() => validateCliEngineUrl('postgresql', url), /requires engine "mysql"/);
    assert.throws(() => validateCliEngineUrl('sqlite', url), /local database path/);
    assert.doesNotThrow(() => validateCliEngineUrl('mysql', url));
  });

  it('allows only implemented commands and rejects unsupported config before native peer loading', async () => {
    for (const command of ['init', 'generate', 'pull', 'gen', 'g', 'status', 'info', 'migrate', 'migration', 'm']) {
      assert.doesNotThrow(() => assertMysqlProjectCommand(command));
    }
    for (const command of ['push', 'diff', 'seed', 'studio', 'mcp', 'doctor', 'observe']) {
      assert.throws(() => assertMysqlProjectCommand(command), /not supported for MySQL/);
    }
    let config!: ReturnType<typeof resolveConfig>;
    withoutEnv(() => {
      config = resolveConfig({ engine: 'mysql', url }, {});
    });
    for (const args of [{ includeViews: true }, { withSchema: true }]) {
      await assert.rejects(introspectMysqlProject(config, args), /does not support|use SQL migrations/);
    }
    for (const invalid of [
      { include: 'users' },
      { exclude: [7] },
      { out: '' },
      { migrationsDir: null },
      { columnTypes: [] },
      { columnTypes: { 'users.settings': 1 } },
      { relationNames: [] },
      { relationNames: { users: { posts: 1 } } },
      { importExtension: 'bad' },
      { keepColumnNames: 'true' },
    ]) {
      await assert.rejects(
        introspectMysqlProject({ ...config, ...invalid } as unknown as typeof config),
        /MySQL config/,
      );
    }
    await assert.rejects(introspectMysqlProject({ ...config, schemaFileConfigured: true }), /use SQL migrations/);
    await assert.rejects(introspectMysqlProject({ ...config, engine: 'postgresql' }), /require engine/);
    await assert.rejects(introspectMysqlProject({ ...config, schema: 'other' }), /schema must match/);
  });
});
