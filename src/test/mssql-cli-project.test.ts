import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { resolveConfig } from '../cli/config.js';
import { assertMssqlProjectCommand, introspectMssqlProject, mssqlConfigTemplate } from '../cli/mssql-project.js';
import { generate, generateIndex, generateMetadata, generateTypes } from '../generate.js';
import { introspectMssqlWith, type MssqlRowExecutor } from '../mssql.js';

const exec: MssqlRowExecutor = async (sql, params) => {
  assert.deepEqual(params, ['app'], 'all catalog queries must bind the selected namespace');
  if (sql.includes('INFORMATION_SCHEMA.TABLES')) return [{ TABLE_NAME: 'users' }];
  if (sql.includes('sys.identity_columns')) return [{ TABLE_NAME: 'users', COLUMN_NAME: 'id' }];
  if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
    return [
      { TABLE_NAME: 'users', COLUMN_NAME: 'id', DATA_TYPE: 'int', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null },
      { TABLE_NAME: 'users', COLUMN_NAME: 'email', DATA_TYPE: 'nvarchar', IS_NULLABLE: 'NO', COLUMN_DEFAULT: null },
    ];
  }
  if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE'))
    return [{ TABLE_NAME: 'users', COLUMN_NAME: 'id', ORDINAL_POSITION: 1 }];
  if (sql.includes('sys.foreign_keys') || sql.includes('sys.indexes') || sql.includes('sys.check_constraints'))
    return [];
  throw new Error(`Unexpected catalog query: ${sql}`);
};

describe('MSSQL CLI project contracts', () => {
  const inheritedUrl = process.env.DATABASE_URL;
  beforeEach(() => {
    delete process.env.DATABASE_URL;
  });
  afterEach(() => {
    if (inheritedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = inheritedUrl;
  });

  it('retains environment precedence and explicit CLI URL overrides', () => {
    process.env.DATABASE_URL = 'mssql://environment/db';
    assert.equal(resolveConfig({ engine: 'mssql', url: 'mssql://file/db' }, {}).url, process.env.DATABASE_URL);
    assert.equal(
      resolveConfig({ engine: 'mssql', url: 'mssql://file/db' }, { url: 'mssql://flag/db' }).url,
      'mssql://flag/db',
    );
  });

  it('selects the canonical engine and dbo default without changing PostgreSQL defaults', () => {
    assert.equal(resolveConfig({}, {}).engine, 'postgresql');
    assert.equal(resolveConfig({}, {}).schema, 'public');
    assert.equal(resolveConfig({ engine: 'mssql' }, {}).schema, 'dbo');
    assert.equal(resolveConfig({ engine: 'mssql', schema: 'app' }, {}).schema, 'app');
    assert.equal(resolveConfig({ engine: 'postgresql' }, { engine: 'mssql' }).engine, 'mssql');
    assert.throws(() => resolveConfig({ engine: 'sqlserver' as never }, { engine: 'mssql' }), /Unknown CLI engine/);
  });

  it('rejects mixed URLs, adapter misuse and ignored TLS query options without exposing secrets', () => {
    for (const url of [
      'postgres://host/db',
      './app.sqlite',
      'mysql://host/db',
      'mssql://host',
      'mssql:///db',
      'mssql://host/db?',
      'mssql://host/db#',
      'mssql://host/a%2Fb',
      'mssql://sa:%ZZ@host/db',
      'mssql://host/db\n',
    ]) {
      assert.throws(() => resolveConfig({ engine: 'mssql', url }, {}), /MSSQL CLI requires/);
    }
    assert.throws(() => resolveConfig({ url: 'mssql://host/db' }, {}), /requires engine "mssql"/);
    assert.throws(() => resolveConfig({ engine: 'sqlite', url: 'mssql://host/db' }, {}), /requires engine "mssql"/);
    assert.throws(() => resolveConfig({ engine: 'mssql', adapter: {} as never }, {}), /PostgreSQL adapters/);
    const secret = 'mssql://sa:PRIVATE_PASSWORD@host/db?encrypt=true';
    assert.throws(
      () => resolveConfig({ engine: 'mssql', url: secret }, {}),
      (err: Error) => {
        assert.match(err.message, /query parameters/);
        assert.doesNotMatch(err.message, /PRIVATE_PASSWORD/);
        return true;
      },
    );
  });

  it('refuses unsupported project commands and code-first/native introspection flags before connection', async () => {
    for (const command of [
      'init',
      'pull',
      'gen',
      'g',
      'generate',
      'status',
      'info',
      'seed',
      's',
      'migrate',
      'migration',
      'm',
    ])
      assertMssqlProjectCommand(command);
    for (const command of ['push', 'diff', 'studio', 'mcp', 'doctor', 'observe', 'migrate-from-prisma']) {
      assert.throws(() => assertMssqlProjectCommand(command), /not supported for MSSQL/);
    }
    const config = resolveConfig({ engine: 'mssql', url: 'mssql://host/db' }, {});
    for (const override of [{ schemaFileConfigured: true }, { schema: './schema.ts' }]) {
      await assert.rejects(
        introspectMssqlProject({ ...config, ...override }),
        /not supported|namespace|does not support/,
      );
    }
    await assert.rejects(introspectMssqlProject(config, { includeViews: true }), /does not support/);
    await assert.rejects(introspectMssqlProject(config, { withSchema: true }), /not supported/);
    await assert.rejects(introspectMssqlProject({ ...config, url: '' }), /requires a database URL/);
  });

  it('scaffolds schema/filter/type settings with credentials kept in the environment', () => {
    const template = mssqlConfigTemplate(
      resolveConfig(
        {
          engine: 'mssql',
          url: 'mssql://sa:PRIVATE_PASSWORD@host/db',
          schema: "app']",
          include: ['users'],
          columnTypes: { 'users.email': 'string' },
          relationNames: {},
          keepColumnNames: true,
        },
        {},
      ),
    );
    assert.match(template, /process.env.DATABASE_URL/);
    assert.match(template, /app'\]/);
    assert.match(template, /users.email/);
    assert.doesNotMatch(template, /PRIVATE_PASSWORD/);
  });

  it('emits deterministic async factories from native metadata without changing shared emitters', async () => {
    const schema = await introspectMssqlWith(exec, 'app');
    assert.equal(schema.tables.users!.columns.length, 2);
    assert.equal(schema.tables.users!.columns[0]!.hasDefault, true);
    const options = { target: 'mssql', noTimestamp: true } as const;
    const output = generateIndex(schema, options);
    assert.match(output, /export async function turbine/);
    assert.match(output, /Parameters<typeof turbineMssql>\[0\]/);
    assert.match(output, /Promise<TurbineClient>/);
    assert.match(output, /await turbineMssql\(target, SCHEMA/);
    assert.match(output, /readonly users:/);
    assert.equal(output, generateIndex(schema, options));
    assert.equal(generateTypes(schema, options), generateTypes(schema, { noTimestamp: true }));
    assert.equal(generateMetadata(schema, options), generateMetadata(schema, { noTimestamp: true }));
    for (const importExt of ['', '.js', '.ts']) {
      assert.ok(generateIndex(schema, { ...options, importExt }).includes(`from './metadata${importExt}'`));
    }
    const dir = mkdtempSync(join(process.cwd(), '.mssql-generated-'));
    try {
      generate({ schema, ...options, outDir: dir, importExtension: 'js' });
      assert.equal(
        readFileSync(join(dir, 'index.ts'), 'utf8'),
        generateIndex(schema, { ...options, importMode: 'js' }),
      );
      // An unknown target is refused before the output directory is touched.
      const refused = join(dir, 'invalid-target');
      assert.throws(
        () => generate({ schema, target: 'sqlserver' as never, outDir: refused }),
        /Unknown generation target/,
      );
      assert.equal(existsSync(refused), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
