/** Install a real tarball; invoke both shipped CLIs without loader preloads. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const mysqlUrl = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const native = skipGate(!mysqlUrl, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server');

function run(command: string, args: string[], cwd: string) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', NO_COLOR: '1' },
  });
  return { code: result.status, output: `${result.stdout}\n${result.stderr}\n${result.error ?? ''}` };
}
function checked(command: string, args: string[], cwd: string) {
  const result = run(command, args, cwd);
  assert.equal(result.code, 0, result.output);
  return result.output;
}

function pack(dir: string) {
  const pkg = join(dir, 'package');
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE', 'scripts/finish-cjs-build.mjs'])
    copyFileSync(join(repo, file), join(pkg, file));
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  // Staging omits checkout lifecycle scripts; npm 10 can still run prepare while packing.
  for (const key of ['prepare', 'prepack', 'postpack']) delete manifest.scripts[key];
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  const tsc = join(repo, 'node_modules/.bin/tsc');
  checked(tsc, ['-p', join(repo, 'tsconfig.json'), '--outDir', join(pkg, 'dist')], repo);
  checked(tsc, ['-p', join(repo, 'tsconfig.cjs.json'), '--outDir', join(pkg, 'dist/cjs')], repo);
  checked(process.execPath, [join(pkg, 'scripts/finish-cjs-build.mjs')], repo);
  checked('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], pkg);
  const version = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
  return join(dir, `turbine-orm-${version}.tgz`);
}

describe('MySQL migration packed ESM and CommonJS', () => {
  it('ships native help/create and strict import/require config consumers, with no database prerequisite', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-cli-packed-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const archive = pack(dir);
    const consumer = join(dir, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true}');
    const versions = ['mysql2', 'tsx', 'typescript', '@types/node'].map(
      (name) => `${name}@${JSON.parse(readFileSync(join(repo, 'node_modules', name, 'package.json'), 'utf8')).version}`,
    );
    checked(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', archive, ...versions],
      consumer,
    );
    const installed = join(consumer, 'node_modules/turbine-orm');
    const tsc = join(consumer, 'node_modules/typescript/bin/tsc');
    for (const ext of ['mts', 'cts']) {
      writeFileSync(
        join(consumer, `consumer.${ext}`),
        `import { resolveConfig, type TurbineCliConfig } from 'turbine-orm/cli';
const config: TurbineCliConfig = {engine:'mysql', url:'mysql://localhost/app', migrationsDir:'./migrations'};
const resolved = resolveConfig(config, {});
if(resolved.engine !== 'mysql') throw new Error('wrong engine');
`,
      );
      checked(
        process.execPath,
        [
          tsc,
          `consumer.${ext}`,
          '--outDir',
          'compiled',
          '--target',
          'ES2023',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--strict',
          '--skipLibCheck',
          'false',
        ],
        consumer,
      );
      checked(process.execPath, [join(consumer, 'compiled', `consumer.${ext === 'mts' ? 'mjs' : 'cjs'}`)], consumer);
      writeFileSync(
        join(consumer, `bad.${ext}`),
        "import type { TurbineCliConfig } from 'turbine-orm/cli';\nconst bad: TurbineCliConfig = {engine:'my-sql'};\n",
      );
      const invalid = run(
        process.execPath,
        [
          tsc,
          `bad.${ext}`,
          '--noEmit',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--strict',
          '--skipLibCheck',
          'false',
        ],
        consumer,
      );
      assert.notEqual(invalid.code, 0, invalid.output);
      assert.match(invalid.output, /bad\.(?:mts|cts)\(2,\d+\): error TS(?:2322|2820)/);
    }
    for (const cjs of [false, true]) {
      const project = join(consumer, cjs ? 'commonjs' : 'module');
      mkdirSync(project);
      writeFileSync(join(project, 'package.json'), JSON.stringify({ type: cjs ? 'commonjs' : 'module' }));
      const entry = join(installed, cjs ? 'dist/cjs/cli/index.js' : 'dist/cli/index.js');
      const help = checked(process.execPath, [entry, 'migrate', '--engine', 'mysql', '--help'], project);
      assert.match(help, /MySQL SQL-first migrations/);
      assert.doesNotMatch(help, /pg_advisory|atomic batch/i);
      checked(process.execPath, [entry, 'migrate', 'create', 'items', '--engine', 'mysql'], project);
      // TypeScript config loading is performed by the installed CLI itself.
      writeFileSync(
        join(project, 'turbine.config.ts'),
        "import type { TurbineCliConfig } from 'turbine-orm/cli';\nexport default {engine:'mysql'} satisfies TurbineCliConfig;\n",
      );
      assert.match(checked(process.execPath, [entry, 'migrate', '--help'], project), /MySQL SQL-first migrations/);
      const bad = run(process.execPath, [entry, 'migrate', 'up', '--out', '--dry-run'], project);
      assert.equal(bad.code, 1, bad.output);
      assert.match(bad.output, /Unsupported MySQL/);
    }
    await native.it('executes installed ESM/CJS native migration lifecycle with .env/TypeScript config', async () => {
      const { createConnection } = await import('mysql2/promise');
      const url = new URL(mysqlUrl);
      const admin = await createConnection({
        host: url.hostname,
        port: Number(url.port || 3306),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      });
      try {
        for (const cjs of [false, true]) {
          const database = `turbine_mysql_packed_${randomBytes(6).toString('hex')}`;
          const project = join(consumer, cjs ? 'commonjs' : 'module');
          const entry = join(installed, cjs ? 'dist/cjs/cli/index.js' : 'dist/cli/index.js');
          await admin.query(`CREATE DATABASE \`${database}\``);
          try {
            url.pathname = `/${database}`;
            writeFileSync(join(project, '.env'), `DATABASE_URL=${url.href}\n`);
            // Replace only this fixture's freshly scaffolded migration.
            rmSync(join(project, 'turbine/migrations'), { recursive: true });
            mkdirSync(join(project, 'turbine/migrations'));
            writeFileSync(
              join(project, 'turbine/migrations/20260101000000_items.sql'),
              '-- UP\nCREATE TABLE items(id INT PRIMARY KEY); INSERT INTO items VALUES(9);\n-- DOWN\nDROP TABLE items;\n',
            );
            const invoke = (args: string[]) => run(process.execPath, [entry, 'migrate', ...args], project);
            const pending = invoke(['status', '--exit-code']);
            assert.equal(pending.code, 2, pending.output);
            assert.match(
              checked(process.execPath, [entry, 'migrate', 'up', '--dry-run'], project),
              /no database or history changes/,
            );
            const [empty] = await admin.execute(
              'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
              [database],
            );
            assert.deepEqual(empty, []);
            for (const args of [
              ['up', '--url'],
              ['up', '--out', '--dry-run'],
              ['deploy', '--force'],
            ]) {
              const bad = invoke(args);
              assert.equal(bad.code, 1, bad.output);
              const [stillEmpty] = await admin.execute(
                'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=?',
                [database],
              );
              assert.deepEqual(stillEmpty, []);
            }
            checked(process.execPath, [entry, 'migrate', 'deploy'], project);
            const [rows] = await admin.query(`SELECT * FROM \`${database}\`.items`);
            assert.deepEqual(rows, [{ id: 9 }]);
            checked(process.execPath, [entry, 'migrate', 'status', '--exit-code'], project);
            checked(process.execPath, [entry, 'migrate', 'down', '--allow-destructive'], project);
            const [history] = await admin.query(`SELECT * FROM \`${database}\`._turbine_migrations`);
            assert.deepEqual(history, []);
            const [gone] = await admin.execute(
              'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
              [database, 'items'],
            );
            assert.deepEqual(gone, []);
            rmSync(join(project, 'turbine/migrations/20260101000000_items.sql'));
            const failed = '20260102000000_partial';
            const sql =
              '-- UP\nCREATE TABLE partial(id INT PRIMARY KEY); INSERT INTO partial VALUES(1); INSERT INTO partial VALUES(1);\n-- DOWN\nDROP TABLE partial;\n';
            writeFileSync(join(project, `turbine/migrations/${failed}.sql`), sql);
            const failure = invoke(['up']);
            assert.equal(failure.code, 1, failure.output);
            assert.match(failure.output, /No rollback is claimed/);
            const [retained] = await admin.query(`SELECT * FROM \`${database}\`.partial`);
            assert.deepEqual(retained, [{ id: 1 }]);
            const dirty = invoke(['status', '--exit-code']);
            assert.equal(dirty.code, 2, dirty.output);
            assert.match(dirty.output, /Dirty/);
            const retry = invoke(['deploy']);
            assert.equal(retry.code, 1, retry.output);
            assert.match(retry.output, /Automatic retry is refused/);
            await admin.query(`DROP TABLE \`${database}\`.partial`);
            const checksum = createHash('sha256').update(sql).digest('hex');
            checked(
              process.execPath,
              [entry, 'migrate', 'recover', failed, checksum, 'rolled-back', '--acknowledge-partial-ddl'],
              project,
            );
            const [state] = await admin.query(`SELECT * FROM \`${database}\`._turbine_migration_state`);
            assert.deepEqual(state, []);
            const [noReplay] = await admin.execute(
              'SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME=?',
              [database, 'partial'],
            );
            assert.deepEqual(noReplay, []);
          } finally {
            await admin.query(`DROP DATABASE \`${database}\``);
          }
        }
      } finally {
        await admin.end();
      }
    });
  });
});
