/** Actual installed production CLI processes in an isolated package. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, it } from 'node:test';
import { defineSchema } from '../schema-builder.js';
import { skipGate } from './helpers.js';
import { pushChecked, pushFixture, pushRepo, pushRun, pushUrl, stageMysqlPush } from './mysql-push-helpers.js';

const native = skipGate(!pushUrl, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server');
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const binaries = process.env.TURBINE_MYSQL_PUSH_NODE_BINARIES?.split(delimiter) ?? [process.execPath];
function ok(result: { code: number | null; output: string }, code = 0, pattern?: RegExp) {
  assert.equal(result.code, code, result.output);
  assert.ok(result.output.trim());
  if (pattern) assert.match(result.output, pattern);
}

describe('MySQL push installed process integration', () => {
  it('packs the production dispatcher and executes ESM/CommonJS without loader preloads', async (t) => {
    const stage = stageMysqlPush();
    t.after(() => rmSync(stage, { recursive: true, force: true }));
    const tsc = join(pushRepo, 'node_modules/typescript/bin/tsc');
    pushChecked(process.execPath, [tsc, '-p', 'tsconfig.json'], stage);
    pushChecked(process.execPath, [tsc, '-p', 'tsconfig.cjs.json'], stage);
    pushChecked(process.execPath, [join(stage, 'scripts/finish-cjs-build.mjs')], stage);
    pushChecked('npm', ['pack', '--ignore-scripts', '--pack-destination', stage], stage);
    const version = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8')).version;
    const archive = join(stage, `turbine-orm-${version}.tgz`);
    const hash = sha(readFileSync(archive));
    t.diagnostic(`Integrated artifact SHA256 ${hash}`);
    if (process.env.TURBINE_MYSQL_PUSH_ARTIFACT_DIR) {
      const target = process.env.TURBINE_MYSQL_PUSH_ARTIFACT_DIR;
      mkdirSync(target, { recursive: true });
      copyFileSync(archive, join(target, `mysql-push-${process.env.TURBINE_MYSQL_PUSH_MODE ?? 'native'}.tgz`));
    }
    unlinkSync(join(stage, 'node_modules')); // Prevent the no-peer consumer from resolving the build host's peers.
    const consumer = join(stage, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true}');
    pushChecked(
      'npm',
      ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock', archive],
      consumer,
    );
    assert.equal(existsSync(join(consumer, 'node_modules/mysql2')), false);
    for (const binary of binaries) {
      const runtime = pushChecked(binary, ['--version'], consumer).trim();
      assert.match(runtime, /^v\d+\./);
      t.diagnostic(`Actual packed runtime ${runtime}`);
      for (const cjs of [false, true]) {
        const entry = join(consumer, 'node_modules/turbine-orm', cjs ? 'dist/cjs/cli/index.js' : 'dist/cli/index.js');
        const project = join(consumer, `${runtime}-${cjs ? 'cjs' : 'esm'}`);
        mkdirSync(project);
        writeFileSync(join(project, 'package.json'), JSON.stringify({ type: cjs ? 'commonjs' : 'module' }));
        writeFileSync(join(project, 'schema.mjs'), 'export default {tables:{},enums:{}};');
        writeFileSync(
          join(project, 'turbine.config.mjs'),
          "export default {engine:'mysql',url:'mysql://127.0.0.1:1/unused',schemaFile:'./schema.mjs'};",
        );
        ok(pushRun(binary, [entry, 'push', '--engine', 'mysql', '--help'], project), 0, /DDL is not atomic/);
        ok(pushRun(binary, [entry, 'push', '--engine', 'mysql', '--dry-run'], project), 1, /optional mysql2 peer/);
        ok(pushRun(binary, [entry, 'push', '--engine', 'postgresql', '--yes'], project), 1, /Unknown flag/);
      }
    }
    const mysqlVersion = JSON.parse(readFileSync(join(pushRepo, 'node_modules/mysql2/package.json'), 'utf8')).version;
    pushChecked(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', `mysql2@${mysqlVersion}`],
      consumer,
    );
    for (const binary of binaries)
      for (const cjs of [false, true]) {
        const runtime = pushChecked(binary, ['--version'], consumer).trim();
        await native.it(
          `${runtime} ${cjs ? 'CommonJS' : 'ESM'} preview/apply/failure/recovery with native effects`,
          async () =>
            pushFixture(async (f) => {
              const entry = join(
                consumer,
                'node_modules/turbine-orm',
                cjs ? 'dist/cjs/cli/index.js' : 'dist/cli/index.js',
              );
              writeFileSync(join(f.dir, 'package.json'), JSON.stringify({ type: cjs ? 'commonjs' : 'module' }));
              const run = (args: string[]) => pushRun(binary, [entry, ...args], f.dir);
              const desired = (extra = false) =>
                defineSchema({
                  users: {
                    id: { type: 'serial', primaryKey: true },
                    label: { type: 'varchar', maxLength: 40, ...(extra ? { unique: true } : {}) },
                    ...(extra ? { enabled: { type: 'boolean' as const, notNull: true, default: true } } : {}),
                  },
                });
              f.schema(desired());
              ok(
                run(['push', '--schema-file', '--dry-run', '--yes', '--engine', 'mysql']),
                1,
                /explicit non-flag operand/,
              );
              assert.deepEqual(await f.query('SHOW TABLES'), []);
              assert.equal(existsSync(f.migrations), false);
              ok(run(['push', '--dry-run', '--exit-code']), 2, /CREATE TABLE `users`/);
              assert.deepEqual(await f.query('SHOW TABLES'), []);
              assert.equal(existsSync(f.migrations), false);
              ok(run(['push', '--engine', 'mysql', '--yes']), 0, /Applied journaled migration/);
              const first = readdirSync(f.migrations);
              assert.equal(first.length, 1);
              const original = readFileSync(join(f.migrations, first[0]!), 'utf8');
              assert.deepEqual(await f.query('SELECT checksum FROM _turbine_migrations'), [
                { checksum: sha(original) },
              ]);
              await f.query("INSERT INTO users(label) VALUES('duplicate'),('duplicate')");
              f.schema(desired(true));
              ok(run(['push', '--engine', 'mysql', '--yes']), 1, /Every MySQL ALTER/);
              assert.equal(readdirSync(f.migrations).length, 1);
              ok(run(['push', '--engine', 'mysql', '--yes', '--allow-destructive']), 1, /Duplicate entry/);
              const dirty = await f.query(
                'SELECT name,checksum,completed_statements,total_statements FROM _turbine_migration_state',
              );
              assert.equal(dirty.length, 1);
              assert.equal(dirty[0]!.completed_statements, 1);
              assert.equal(dirty[0]!.total_statements, 2);
              assert.deepEqual(await f.query('SELECT id,label,enabled FROM users ORDER BY id'), [
                { id: 1, label: 'duplicate', enabled: 1 },
                { id: 2, label: 'duplicate', enabled: 1 },
              ]);
              const path = join(f.migrations, `${dirty[0]!.name}.sql`);
              const preserved = readFileSync(path, 'utf8');
              assert.equal(dirty[0]!.checksum, sha(preserved));
              ok(run(['migrate', 'status', '--engine', 'mysql', '--exit-code']), 2, /Dirty/);
              for (const flag of ['--yes', '--dry-run']) ok(run(['push', '--engine', 'mysql', flag]), 1, /dirty/);
              ok(
                run([
                  'migrate',
                  'recover',
                  String(dirty[0]!.name),
                  '0'.repeat(64),
                  'rolled-back',
                  '--engine',
                  'mysql',
                  '--acknowledge-partial-ddl',
                ]),
                1,
                /checksum|match|exact/,
              );
              await f.query('ALTER TABLE users DROP COLUMN enabled');
              await f.query('DELETE FROM users WHERE id=2');
              ok(
                run([
                  'migrate',
                  'recover',
                  String(dirty[0]!.name),
                  String(dirty[0]!.checksum),
                  'rolled-back',
                  '--engine',
                  'mysql',
                  '--acknowledge-partial-ddl',
                ]),
                0,
                /manually reconciled/,
              );
              ok(run(['push', '--engine', 'mysql', '--yes', '--allow-destructive']), 1, /pending/);
              ok(run(['migrate', 'up', '--engine', 'mysql', '--allow-destructive']), 0, /1 migration/);
              ok(run(['push', '--engine', 'mysql', '--yes']), 0, /No supported schema changes/);
              assert.deepEqual(await f.query('SELECT id,label,enabled FROM users'), [
                { id: 1, label: 'duplicate', enabled: 1 },
              ]);
              assert.equal(readFileSync(path, 'utf8'), preserved);
              assert.equal(readFileSync(join(f.migrations, first[0]!), 'utf8'), original);
              writeFileSync(
                join(f.migrations, '20990101000000_unrelated.sql'),
                '-- UP\nCREATE TABLE unrelated(id INT);\n-- DOWN\nDROP TABLE unrelated;',
              );
              ok(run(['push', '--engine', 'mysql', '--yes']), 1, /pending/);
              assert.deepEqual(
                await f.query(
                  "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='unrelated'",
                ),
                [],
              );
            }, consumer),
        );
      }
  });
});
