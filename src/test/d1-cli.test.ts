import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type D1ProjectConfig,
  d1CleanupResolved,
  requireD1State,
  resolveD1Context,
  withLocalD1,
} from '../cli/d1-local.js';
import { captureD1Plan, inspectD1Migrations } from '../cli/d1-migrations.js';
import { assertD1Arguments } from '../cli/d1-project.js';
import type { D1DatabaseBinding } from '../d1/types.js';

const base = tmpdir();
const original = process.cwd();
function fixture(run: (config: D1ProjectConfig) => Promise<void> | void) {
  const root = mkdtempSync(join(base, 'd1-local-project-'));
  process.chdir(root);
  const config: D1ProjectConfig = {
    engine: 'd1',
    url: '',
    schema: 'main',
    out: './generated',
    migrationsDir: './migrations',
    schemaFile: './schema.ts',
    importExtension: 'js',
    keepColumnNames: false,
    legacyToManyUniques: false,
    include: [],
    exclude: [],
    d1: { binding: 'DB', databaseId: 'test-local', persist: './state' },
  };
  return Promise.resolve()
    .then(() => run(config))
    .finally(() => {
      process.chdir(original);
      rmSync(root, { recursive: true, force: true });
    });
}

test('D1 closed raw admission catches missing operands before shared parser can swallow engine', () => {
  for (const raw of [
    ['pull', '--out', '--engine', 'd1'],
    ['generate', '--engine', 'd1', '--include'],
    ['init', '--out', '--engine', 'd1'],
    ['migrate', 'deploy', '--engine'],
    ['migrate', 'down', '--engine', 'd1'],
    ['status', '--url', 'file:x', '--engine', 'd1'],
    ['pull', '--engine', 'd1', '--force'],
    ['init', '--engine', 'd1', '--skip-generate'],
  ])
    assert.throws(() => assertD1Arguments(raw));
  for (const raw of [
    ['init', '--engine', 'd1'],
    ['pull', '--out', './next', '--engine', 'd1'],
    ['migrate', 'list', '--engine', 'd1'],
  ])
    assert.doesNotThrow(() => assertD1Arguments(raw));
});

test('D1 path/config admission refuses persistence/output/plan aliases and symlink ancestry', () =>
  fixture((config) => {
    for (const override of [
      { out: './state/generated' },
      { migrationsDir: './state' },
      { out: '../outside' },
      { url: 'https://remote' },
      { exactNativeIntegers: true },
    ])
      assert.throws(() => resolveD1Context({ ...config, ...override }));
    mkdirSync('target');
    symlinkSync('target', 'linked');
    assert.throws(() => resolveD1Context({ ...config, out: './linked/output' }));
    assert.throws(() => requireD1State(resolveD1Context(config)), /uninitialized/);
    assert.equal(existsSync('state'), false);
  }));

test('D1 plan validation uses unchanged conservative SQL admission for every pending entry', () => {
  const first = { id: '0001_items', statements: ['CREATE TABLE items(id INTEGER PRIMARY KEY)'] };
  for (const sql of [
    'PRAGMA user_version=1',
    'BEGIN',
    'CREATE TRIGGER bad AFTER INSERT ON items BEGIN SELECT 1; END',
    'SELECT 1; SELECT 2',
    'DROP TABLE _turbine_d1_migrations',
  ])
    assert.throws(() => captureD1Plan([first, { id: '0002_invalid', statements: [sql] }]));
  assert.throws(() => captureD1Plan([first, first]));
  const input = [first];
  const captured = captureD1Plan(input);
  first.statements[0] = 'changed';
  assert.equal(captured[0]?.statements[0], 'CREATE TABLE items(id INTEGER PRIMARY KEY)');
});

test('D1 status is read-only and refuses partial native snapshot responses', async () => {
  const sql: string[] = [];
  const result = { success: true, results: [], meta: { changes: 0, duration: 0, last_row_id: 0 } };
  const binding: D1DatabaseBinding = {
    prepare(text) {
      sql.push(text);
      return {
        bind() {
          throw Error('unexpected bind');
        },
        async all() {
          return result;
        },
      };
    },
    async batch(statements) {
      assert.equal(statements.length, 1);
      return [result];
    },
  };
  assert.deepEqual(await inspectD1Migrations(binding, []), { historyState: 'uninitialized', applied: [], pending: [] });
  assert(sql.every((text) => text.startsWith('SELECT ')));
  binding.batch = async () => [];
  await assert.rejects(inspectD1Migrations(binding, []), /could not be read/);
});

test('D1 failed disposal preserves thrown null/undefined and retains unresolved lock', () =>
  fixture(async (config) => {
    const context = resolveD1Context(config);
    mkdirSync(context.persist);
    class BrokenRuntime {
      ready = Promise.resolve(new URL('http://127.0.0.1:12345'));
      async getD1Database() {
        return {} as D1DatabaseBinding;
      }
      async dispose() {
        throw Error('dispose-fault');
      }
    }
    for (const primary of [null, undefined, new Error('unknown dispatch')]) {
      let caught = false;
      try {
        await withLocalD1(
          context,
          async () => {
            throw primary;
          },
          BrokenRuntime,
        );
      } catch (error) {
        caught = true;
        assert.equal(error, primary);
      }
      assert(caught);
      assert.equal(d1CleanupResolved(context), false);
      assert.equal(readFileSync(join(context.persist, '.turbine-d1.lock'), 'utf8'), `${process.pid}\n`);
      // Test-only runtime has no process or admitted operation. Explicit fixture cleanup.
      rmSync(join(context.persist, '.turbine-d1.lock'));
    }
  }));

test('D1 rejects another live owner lock without removing or changing it', () =>
  fixture(async (config) => {
    const context = resolveD1Context(config);
    mkdirSync(context.persist);
    const lock = join(context.persist, '.turbine-d1.lock');
    writeFileSync(lock, 'another-live-owner');
    class Runtime {
      ready = Promise.resolve(new URL('http://127.0.0.1:12345'));
      async getD1Database(): Promise<D1DatabaseBinding> {
        throw Error('must not start');
      }
      async dispose() {}
    }
    await assert.rejects(
      withLocalD1(context, async () => {}, Runtime),
      /in use/,
    );
    assert.equal(readFileSync(lock, 'utf8'), 'another-live-owner');
  }));
