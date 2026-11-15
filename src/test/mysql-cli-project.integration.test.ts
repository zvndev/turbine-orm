/** Native MySQL project certification. Each run owns a fresh, disposable database. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../cli/config.js';
import { generateMysqlProject, initMysqlProject } from '../cli/mysql-project.js';
import { turbineMysql } from '../mysql.js';
import { skipGate } from './helpers.js';

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysql = skipGate(
  !MYSQL_URL,
  'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server with CREATE/DROP DATABASE',
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repo, 'src/cli/index.ts');
const loader = join(repo, 'node_modules/tsx/dist/loader.mjs');

describe('MySQL native CLI project lifecycle', () => {
  mysql.it(
    'inits additively, introspects real relations, filters types, pulls via CLI and executes native writes/reads',
    async () => {
      const { createConnection } = await import('mysql2/promise');
      const url = new URL(MYSQL_URL);
      const database = `turbine_mysql_cli_${randomBytes(8).toString('hex')}`;
      const admin = await createConnection({
        host: url.hostname,
        port: url.port ? Number(url.port) : 3306,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      });
      const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-project-'));
      const previousCwd = process.cwd();
      const previousUrl = process.env.DATABASE_URL;
      let created = false;
      let active: Awaited<ReturnType<typeof turbineMysql>> | undefined;
      try {
        await admin.query(`CREATE DATABASE \`${database}\``);
        created = true;
        url.pathname = `/${database}`;
        url.search = '';
        url.hash = '';
        process.chdir(dir);
        delete process.env.DATABASE_URL;
        symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
        const config = resolveConfig({ engine: 'mysql', url: url.href }, {});
        writeFileSync('.gitignore', '/venv\n');
        const initial = await initMysqlProject(config, { force: true });
        assert.ok(initial.created.includes('turbine.config.ts'));
        assert.equal(existsSync(join(dir, config.out)), false, 'empty init must not generate a client');
        assert.match(readFileSync('.gitignore', 'utf8'), /\/\.env/);
        const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], {
          cwd: repo,
          encoding: 'utf8',
        });
        assert.equal(gitDir.status, 0, gitDir.stderr);
        const ignored = spawnSync(
          'git',
          ['--git-dir', gitDir.stdout.trim(), '--work-tree', dir, 'check-ignore', '--no-index', '.env'],
          {
            cwd: dir,
            encoding: 'utf8',
          },
        );
        assert.equal(ignored.status, 0, ignored.stderr);
        assert.equal(ignored.stdout.trim(), '.env');
        assert.doesNotMatch(readFileSync('turbine.config.ts', 'utf8'), /mysql:\/\//);
        assert.equal(readFileSync('.env', 'utf8'), `DATABASE_URL=${JSON.stringify(config.url)}\n`);
        const migrations = readdirSync(config.migrationsDir);
        assert.equal(migrations.length, 1);
        assert.match(readFileSync(join(config.migrationsDir, migrations[0]!), 'utf8'), /AUTO_INCREMENT/);
        const [empty] = await admin.query(
          `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${database}'`,
        );
        assert.deepEqual(empty, [], 'init must not apply its starter SQL');
        await assert.rejects(generateMysqlProject(config), /matched 0 tables/);
        const emptyGenerated = await generateMysqlProject(config, { allowEmpty: true, noTimestamp: true });
        assert.equal(Object.keys(emptyGenerated.schema.tables).length, 0);
        rmSync(config.out, { recursive: true });
        await admin.query(`CREATE TABLE \`${database}\`.users (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        display_name VARCHAR(255), settings JSON
      )`);
        await admin.query(`CREATE TABLE \`${database}\`.posts (
        id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL, FOREIGN KEY (user_id) REFERENCES \`${database}\`.users(id)
      )`);
        await admin.query(`CREATE TABLE \`${database}\`.audit (id INT PRIMARY KEY, payload JSON)`);
        await admin.query(`CREATE TABLE \`${database}\`._turbine_migration_state (id INT PRIMARY KEY)`);
        const generated = await generateMysqlProject(
          {
            ...config,
            columnTypes: { 'users.settings': '{ theme: string }' },
          },
          { noTimestamp: true, zod: true },
        );
        assert.equal(Object.keys(generated.schema.tables).length, 3);
        assert.ok(generated.schema.tables.users!.relations.posts);
        assert.equal(generated.schema.tables.users!.columns.find((col) => col.name === 'id')!.hasDefault, true);
        assert.match(readFileSync(join(config.out, 'types.ts'), 'utf8'), /settings: \{ theme: string \}/);
        assert.match(readFileSync(join(config.out, 'index.ts'), 'utf8'), /export async function turbine/);
        const filtered = await generateMysqlProject(
          {
            ...config,
            include: ['users'],
            keepColumnNames: true,
            columnTypes: { 'users.settings': '{ theme: string }', 'audit.payload': '{ event: string }' },
          },
          { noTimestamp: true },
        );
        assert.deepEqual(Object.keys(filtered.schema.tables), ['users']);
        assert.match(readFileSync(join(config.out, 'types.ts'), 'utf8'), /display_name/);
        await assert.rejects(
          generateMysqlProject({
            ...config,
            include: ['users'],
            columnTypes: { 'audit.missing': 'string' },
          }),
          /columnTypes/,
        );
        active = await turbineMysql(config.url, generated.schema, { connectionLimit: 2 });
        const user = await active.table('users').create({
          data: { email: 'native@example.test', displayName: 'Native', settings: { theme: 'dark' } },
        });
        assert.ok(user.id);
        assert.equal(user.email, 'native@example.test');
        await active.table('posts').create({ data: { userId: user.id, title: 'Native post' } });
        const rows = await active.table('users').findMany({ where: { id: user.id }, with: { posts: true } });
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.email, 'native@example.test');
        assert.deepEqual(rows[0]!.settings, { theme: 'dark' });
        assert.equal((rows[0]!.posts as { title: string }[])[0]!.title, 'Native post');
        await admin.query(`ALTER TABLE \`${database}\`.posts ADD UNIQUE KEY posts_one_user(user_id)`);
        const originalConfig = readFileSync('turbine.config.ts', 'utf8');
        // CLI loading is exercised with the actual TS config in both package modes.
        for (const type of ['module', 'commonjs']) {
          writeFileSync('package.json', JSON.stringify({ type }));
          for (const legacy of [false, true]) {
            writeFileSync(
              'turbine.config.ts',
              `export default { engine: 'mysql', url: ${JSON.stringify(config.url)}, legacyToManyUniques: ${legacy} };`,
            );
            const pulled = spawnSync(process.execPath, ['--import', loader, cli, 'pull', '--no-timestamp'], {
              cwd: dir,
              encoding: 'utf8',
              timeout: 30_000,
              env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
            });
            assert.equal(pulled.status, 0, `${pulled.stdout}\n${pulled.stderr}`);
            // The to-one is named with the singular; the opt-out keeps the plural array.
            const relation = legacy ? 'posts' : 'post';
            assert.match(
              readFileSync(join(config.out, 'types.ts'), 'utf8'),
              legacy ? /posts: RelationDescriptor<.*'hasMany'/ : /post: RelationDescriptor<.*'hasOne'/,
            );
            const metadata = await generateMysqlProject(
              { ...config, legacyToManyUniques: legacy },
              { noTimestamp: true },
            );
            assert.deepEqual(Object.keys(metadata.schema.tables.users!.relations), [relation]);
            const relational = await turbineMysql(config.url, metadata.schema);
            try {
              const related = await relational.table('users').findMany({ with: { [relation]: true } });
              const post: Record<string, unknown> = { id: 1, userId: user.id, title: 'Native post' };
              assert.deepEqual(related[0]![relation], legacy ? [post] : post);
            } finally {
              await relational.disconnect();
            }
          }
          writeFileSync('turbine.config.ts', originalConfig);
          const child = spawnSync(
            process.execPath,
            ['--import', loader, cli, 'pull', '--include', 'users', '--no-timestamp'],
            {
              cwd: dir,
              encoding: 'utf8',
              timeout: 30_000,
              env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
            },
          );
          assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
          assert.match(child.stdout, /Found 1 tables/);
          assert.match(readFileSync(join(config.out, 'index.ts'), 'utf8'), /turbineMysql/);
          for (const command of [['status'], ['init', '--force', '--yes']]) {
            const result = spawnSync(process.execPath, ['--import', loader, cli, ...command], {
              cwd: dir,
              encoding: 'utf8',
              timeout: 30_000,
              env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
            });
            assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
            assert.match(result.stdout, /MySQL database/);
          }
        }
        const before = [
          'turbine.config.ts',
          '.env',
          join(config.out, 'index.ts'),
          join(config.migrationsDir, migrations[0]!),
        ].map((path) => readFileSync(path));
        await initMysqlProject(config, { force: true });
        const after = [
          'turbine.config.ts',
          '.env',
          join(config.out, 'index.ts'),
          join(config.migrationsDir, migrations[0]!),
        ].map((path) => readFileSync(path));
        assert.deepEqual(after, before, 'rerunning init must preserve user files');
        const [counts] = await admin.query(`SELECT COUNT(*) AS n FROM \`${database}\`.users`);
        assert.equal((counts as { n: number }[])[0]!.n, 1);
      } finally {
        await active?.disconnect();
        process.chdir(previousCwd);
        if (previousUrl === undefined) delete process.env.DATABASE_URL;
        else process.env.DATABASE_URL = previousUrl;
        try {
          if (created) await admin.query(`DROP DATABASE \`${database}\``);
        } finally {
          await admin.end();
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );
});
