import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type ResolvedConfig, resolveConfig } from '../cli/config.js';
import { parseMigrationContent } from '../cli/migrate.js';
import {
  assertSqliteProjectCommand,
  generateSqliteProject,
  initSqliteProject,
  introspectSqliteProject,
  sqliteConfigTemplate,
} from '../cli/sqlite-project.js';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const Database: typeof NativeDatabase | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const [major, minor] = process.versions.node.split('.').map(Number);
const sqlite = skipGate(
  !Database || major! < 22 || (major === 22 && minor! < 12),
  'SQLite CLI project workflows require node:sqlite (Node >= 22.12)',
);

async function project(fn: (dir: string, config: ResolvedConfig) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-project-'));
  const savedCwd = process.cwd();
  const savedUrl = process.env.DATABASE_URL;
  process.chdir(dir);
  delete process.env.DATABASE_URL;
  try {
    await fn(dir, resolveConfig({ engine: 'sqlite', url: './app.sqlite', importExtension: 'js' }, {}));
  } finally {
    process.chdir(savedCwd);
    if (savedUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedUrl;
    rmSync(dir, { recursive: true, force: true });
  }
}

function schema(path: string): void {
  const db = new Database!(path);
  try {
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT, settings JSON);
      CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL);
      CREATE TABLE _turbine_migrations (id INTEGER PRIMARY KEY);
      CREATE TABLE _private_data (id INTEGER PRIMARY KEY);
      CREATE VIEW user_emails AS SELECT email FROM users;
      INSERT INTO users (email, display_name, settings) VALUES ('first@example.test', 'First', '{"theme":"dark"}');
      INSERT INTO posts (user_id, title) VALUES (1, 'SQLite SQL migrations');
    `);
  } finally {
    db.close();
  }
}

describe('SQLite project helper workflows', () => {
  sqlite.it(
    'filters valid overrides with their tables while still rejecting invalid table and column names',
    async () => {
      await project(async (_dir, config) => {
        schema(config.url);
        for (const filters of [{ include: ['posts'] }, { exclude: ['users'] }]) {
          const selected = { ...config, ...filters, columnTypes: { 'users.settings': '{ theme: string }' } };
          const result = await generateSqliteProject(selected);
          assert.ok(result.schema.tables.posts);
          assert.equal(result.schema.tables.users, undefined);
          await assert.rejects(
            () => generateSqliteProject({ ...selected, columnTypes: { 'userz.settings': 'string' } }),
            /names no table/,
          );
          await assert.rejects(
            () => generateSqliteProject({ ...selected, columnTypes: { 'users.setings': 'string' } }),
            /names no table|names no column/,
          );
        }
      });
    },
  );

  sqlite.it('initializes a durable fresh database and SQL-first scaffold without applying SQL', async () => {
    await project(async (dir, config) => {
      const result = await initSqliteProject({ ...config, url: '' });
      assert.equal(result.databasePath, join(dir, 'turbine/dev.sqlite'));
      assert.equal(result.existingDatabase, false);
      assert.equal(result.generated, undefined);
      assert.ok(statSync(result.databasePath).size > 0, 'new database must have a durable SQLite header');
      const db = new Database!(result.databasePath, { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()!.n, 0);
      } finally {
        db.close();
      }
      const configSource = readFileSync('turbine.config.ts', 'utf8');
      assert.match(configSource, /engine: 'sqlite'/);
      assert.match(configSource, /\.\/turbine\/dev\.sqlite/);
      assert.doesNotMatch(configSource, /schemaFile:|seedFile:|:memory:/);
      const files = readdirSync(config.migrationsDir);
      assert.equal(files.length, 1);
      const sql = readFileSync(join(config.migrationsDir, files[0]!), 'utf8');
      const parsed = parseMigrationContent(sql);
      assert.match(parsed.up, /CREATE TABLE users/);
      assert.match(parsed.down, /DROP TABLE users/);
      assert.equal(existsSync(config.schemaFile), false);
      assert.equal(existsSync(config.out), false);
      const before = readFileSync(result.databasePath);
      const again = await initSqliteProject({ ...config, url: '' }, { force: true });
      assert.equal(again.existingDatabase, true);
      assert.deepEqual(again.created, []);
      assert.deepEqual(readdirSync(config.migrationsDir), files);
      assert.equal(readFileSync('turbine.config.ts', 'utf8'), configSource);
      assert.deepEqual(readFileSync(result.databasePath), before);
    });
  });

  sqlite.it('initializes an existing schema, preserving data and deriving deterministic relations', async () => {
    await project(async (_dir, config) => {
      schema(config.url);
      const before = readFileSync(config.url);
      const result = await initSqliteProject(config, { noTimestamp: true });
      assert.equal(result.existingDatabase, true);
      assert.deepEqual(result.generated?.files, ['types.ts', 'metadata.ts', 'index.ts']);
      assert.deepEqual(readdirSync(config.migrationsDir), []);
      assert.deepEqual(readFileSync(config.url), before);
      const metadata = await introspectSqliteProject(config);
      assert.deepEqual(Object.keys(metadata.tables), ['_private_data', 'posts', 'users']);
      assert.equal(metadata.tables.posts!.relations.user!.to, 'users');
      assert.equal(metadata.tables.users!.relations.posts!.to, 'posts');
      assert.equal(metadata.tables.user_emails, undefined, 'views are omitted by the existing native introspector');
      const generated = ['index.ts', 'types.ts', 'metadata.ts'].map((name) =>
        readFileSync(join(config.out, name), 'utf8'),
      );
      assert.match(generated[0]!, /turbine-orm\/sqlite/);
      assert.match(generated[0]!, /export function turbine\(\s*target:/);
      assert.doesNotMatch(generated[0]!, /new BaseTurbineClient|connectionString:/);
      await generateSqliteProject(config, { noTimestamp: true });
      assert.deepEqual(
        ['index.ts', 'types.ts', 'metadata.ts'].map((name) => readFileSync(join(config.out, name), 'utf8')),
        generated,
      );
      assert.deepEqual(await introspectSqliteProject(config), metadata);
      // No leaked read handle: exclusive schema/data writes still succeed after success and after validation failure.
      await assert.rejects(
        () => introspectSqliteProject({ ...config, relationNames: { users: { missing: 'renamed' } } }),
        /has no relation/,
      );
      const db = new Database!(config.url);
      try {
        db.exec('BEGIN EXCLUSIVE; ALTER TABLE users ADD COLUMN active BOOLEAN; UPDATE users SET active = 1; COMMIT');
        assert.equal(db.prepare('SELECT active FROM users').get()!.active, 1);
      } finally {
        db.close();
      }
    });
  });

  sqlite.it('honors filters, relation renames, column types, raw fields and import extensions', async () => {
    await project(async (_dir, config) => {
      schema(config.url);
      const changed = {
        ...config,
        include: ['users', 'posts'],
        relationNames: { users: { posts: 'articles' } },
        columnTypes: { 'users.settings': '{ theme: string }' },
        keepColumnNames: true,
      };
      for (const importExtension of ['js', 'ts', 'none'] as const) {
        await generateSqliteProject({ ...changed, importExtension }, { noTimestamp: true, zod: true });
        const types = readFileSync(join(config.out, 'types.ts'), 'utf8');
        const index = readFileSync(join(config.out, 'index.ts'), 'utf8');
        assert.match(types, /display_name/);
        assert.match(types, /settings.*\{ theme: string \}/);
        assert.match(types, /articles/);
        const ext = importExtension === 'none' ? '' : `.${importExtension}`;
        assert.ok(index.includes(`from './metadata${ext}'`));
        assert.ok(index.includes(`from './types${ext}'`));
        assert.ok(statSync(join(config.out, 'zod.ts')).size > 100);
      }
      assert.deepEqual(
        Object.keys((await introspectSqliteProject({ ...config, include: ['_turbine_migrations'] })).tables),
        ['_turbine_migrations'],
      );
      const filtered = await introspectSqliteProject({ ...config, exclude: ['users', '_private_data'] });
      assert.deepEqual(Object.keys(filtered.tables), ['posts']);
      assert.deepEqual(Object.keys(filtered.tables.posts!.relations), []);
      await assert.rejects(
        () => generateSqliteProject({ ...config, columnTypes: { 'users.missing': 'string' } }),
        /columnTypes/,
      );
    });
  });

  sqlite.it('does not create missing databases or output, and requires explicit empty-client consent', async () => {
    await project(async (_dir, config) => {
      await assert.rejects(() => introspectSqliteProject(config), /does not exist/);
      await assert.rejects(() => generateSqliteProject(config), /does not exist/);
      assert.equal(existsSync(config.url), false);
      assert.equal(existsSync(config.out), false);
      const db = new Database!(config.url);
      db.close();
      await assert.rejects(() => generateSqliteProject(config), /matched 0 tables/);
      assert.equal(existsSync(config.out), false);
      const allowed = await generateSqliteProject(config, { allowEmpty: true, noTimestamp: true });
      assert.equal(Object.keys(allowed.schema.tables).length, 0);
      assert.match(readFileSync(join(config.out, 'index.ts'), 'utf8'), /turbineSqlite/);
    });
  });

  sqlite.it('preserves collisions, alternative config files and existing migrations even with force', async () => {
    await project(async (_dir, config) => {
      schema(config.url);
      mkdirSync(config.out, { recursive: true });
      mkdirSync(config.migrationsDir, { recursive: true });
      writeFileSync(join(config.out, 'index.ts'), '// custom generated entry\n');
      writeFileSync('turbine.config.mjs', "export default { engine: 'sqlite' };\n");
      writeFileSync(
        join(config.migrationsDir, '20260101000000_existing.sql'),
        '-- UP\nSELECT 1;\n-- DOWN\nSELECT 1;\n',
      );
      const result = await initSqliteProject(config, { force: true });
      assert.deepEqual(result.created, []);
      assert.equal(result.generated, undefined);
      assert.equal(readFileSync(join(config.out, 'index.ts'), 'utf8'), '// custom generated entry\n');
      assert.equal(existsSync(join(config.out, 'types.ts')), false);
      assert.equal(existsSync('turbine.config.ts'), false);
      assert.deepEqual(readdirSync(config.migrationsDir), ['20260101000000_existing.sql']);
    });
  });

  sqlite.it('refuses unsupported schema workflows before scaffolding files', async () => {
    await project(async (_dir, config) => {
      for (const args of [{ withSchema: true }]) {
        await assert.rejects(() => initSqliteProject(config, args), /SQL migrations/);
        assert.equal(existsSync(config.url), false);
      }
      await assert.rejects(() => generateSqliteProject({ ...config, schemaFileConfigured: true }), /SQL migrations/);
      for (const command of ['doctor', 'studio', 'migrate-from-prisma']) {
        assert.throws(() => assertSqliteProjectCommand(command), /not supported for SQLite.*SQL migrations/);
      }
      for (const command of [
        'init',
        'generate',
        'gen',
        'g',
        'pull',
        'status',
        'info',
        'seed',
        's',
        'migrate',
        'migration',
        'm',
        'mcp',
        'capabilities',
        'schema',
        'compile',
        'explain-error',
      ]) {
        assert.doesNotThrow(() => assertSqliteProjectCommand(command));
      }
      assert.match(sqliteConfigTemplate({ ...config, url: './quote"file.sqlite' }), /quote\\"file/);
      assert.equal(existsSync('turbine.config.ts'), false);
    });
  });

  sqlite.it('produces strict ESM/CommonJS-friendly consumer types and an executable typed query', async () => {
    await project(async (dir, config) => {
      schema(config.url);
      await generateSqliteProject(config, { noTimestamp: true });
      const usage = `import { turbine } from './generated/turbine/index.js';
const db = turbine('./app.sqlite', { logger: {} });
async function main() {
  const users = await db.users.findMany({ select: { email: true }, with: { posts: true } });
  const email: string = users[0]!.email;
  const title: string = users[0]!.posts[0]!.title;
  if (email !== 'first@example.test' || title !== 'SQLite SQL migrations') throw new Error('unexpected query result');
  await db.disconnect();
}
void main();
// @ts-expect-error invalid field must be diagnosed
void db.users.findMany({ where: { emali: 'bad' } });
`;
      const paths = {
        'turbine-orm': [join(repo, 'src/index.ts')],
        'turbine-orm/sqlite': [join(repo, 'src/sqlite.ts')],
      };
      writeFileSync(
        'tsconfig.json',
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            target: 'ES2023',
            skipLibCheck: true,
            types: ['node'],
            typeRoots: [join(repo, 'node_modules/@types')],
            paths,
          },
          include: ['**/*.ts', join(repo, 'types/**/*.d.ts')],
        }),
      );
      for (const type of ['module', 'commonjs']) {
        writeFileSync('package.json', JSON.stringify({ type }));
        writeFileSync('usage.ts', usage);
        const checked = spawnSync(join(repo, 'node_modules/.bin/tsc'), ['--noEmit', '-p', dir], { encoding: 'utf8' });
        assert.equal(checked.status, 0, checked.stdout + checked.stderr);
        writeFileSync('usage.ts', usage.replace('// @ts-expect-error invalid field must be diagnosed', ''));
        const invalid = spawnSync(join(repo, 'node_modules/.bin/tsc'), ['--noEmit', '-p', dir], { encoding: 'utf8' });
        assert.notEqual(invalid.status, 0, 'invalid generated-client call must fail');
        assert.match(invalid.stdout + invalid.stderr, /emali/);
        // Execute only the valid query in each module mode. tsx resolves source
        // aliases from this fixture; no shared dist/ output is touched.
        writeFileSync('usage.ts', usage.slice(0, usage.indexOf('// @ts-expect-error')));
        const runtime = spawnSync(
          process.execPath,
          ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(dir, 'usage.ts')],
          { encoding: 'utf8', env: { ...process.env, TSX_TSCONFIG_PATH: join(dir, 'tsconfig.json') } },
        );
        assert.equal(runtime.status, 0, runtime.stdout + runtime.stderr);
      }
    });
  });
});
