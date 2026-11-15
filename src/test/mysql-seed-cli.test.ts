import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../cli/config.js';
import { assertMysqlSeedArguments, cmdMysqlSeed, showMysqlSeedHelp } from '../cli/mysql-seed.js';
import { skipGate } from './helpers.js';
import { mysqlSeedFixture, mysqlSeedPartialRevokeFixture, mysqlSeedUrl } from './mysql-seed-helpers.js';

const inheritedDatabaseUrl = process.env.DATABASE_URL;
beforeEach(() => {
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  if (inheritedDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = inheritedDatabaseUrl;
});

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native = skipGate(
  !mysqlSeedUrl,
  'requires MYSQL_URL / MYSQL_TEST_URL pointing at an exclusively owned disposable MySQL 8 server',
);
function processRun(cwd: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'src/cli/index.ts'), ...args],
    {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, NODE_OPTIONS: '', DATABASE_URL: '', NO_COLOR: '1' },
    },
  );
  return { code: result.status, output: `${result.stdout}\n${result.stderr}\n${result.error ?? ''}` };
}

describe('MySQL trusted seed command', () => {
  native.it('refuses partial trigger revokes before executing the seed callback', async (t) => {
    const f = await mysqlSeedPartialRevokeFixture(t);
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-seed-revokes-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      `export default ${JSON.stringify({ engine: 'mysql', url: f.limitedUrl, seedFile: './seed.mjs' })};`,
    );
    writeFileSync(
      join(dir, 'seed.mjs'),
      `import {writeFileSync} from 'node:fs';
      export default async tx => {
        writeFileSync('callback-ran', 'unexpected');
        await tx.table('items').create({data:{id:42,label:'must never execute',n:1}});
        throw Error('callback failure');
      };`,
    );
    const result = processRun(dir, ['seed']);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /partial revokes/);
    assert.equal(existsSync(join(dir, 'callback-ran')), false);
    assert.deepEqual(await f.rows(), []);
    assert.deepEqual(await f.effects(), []);
  });

  it('refuses unsupported options and swallowed operands before any module import', async () => {
    const args = { command: 'seed', engine: 'mysql' as const, positional: [] };
    for (const key of ['dryRun', 'preview', 'schema', 'schemaFile', 'allowDestructive', 'force', 'step', 'out']) {
      assert.throws(() => assertMysqlSeedArguments({ ...args, [key]: true }), /does not support/);
    }
    assert.throws(() => assertMysqlSeedArguments({ ...args, positional: ['seed.sql'] }), /positional/);
    assert.throws(() => assertMysqlSeedArguments({ ...args, url: '' }), /requires/);
    assert.throws(
      () => assertMysqlSeedArguments(args, ['seed', '--url', '--dry-run', '--engine', 'mysql']),
      /requires a value/,
    );
    assert.throws(() => assertMysqlSeedArguments(args, ['seed', '--preview']), /Unsupported/);
    assert.doesNotThrow(() => assertMysqlSeedArguments(args, ['seed', '--engine', 'mysql', '--verbose']));
    const config = resolveConfig(
      { engine: 'mysql', url: 'mysql://127.0.0.1:1/app', seedFile: 'missing-seed-file.mjs' },
      {},
    );
    await assert.rejects(() => cmdMysqlSeed(args, config), /file not found/);
  });

  it('prints the MySQL DML boundary and rejects SQL files without connecting', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-seed-cli-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const help = processRun(dir, ['seed', '--engine', 'mysql', '--help']);
    assert.equal(help.code, 0, help.output);
    assert.match(help.output, /DDL implicitly commits/);
    assert.match(help.output, /captured connections/);
    writeFileSync(join(dir, 'seed.sql'), 'CREATE TABLE should_never_exist(id INT)');
    await assert.rejects(
      () =>
        cmdMysqlSeed(
          { command: 'seed', positional: [] },
          resolveConfig({ engine: 'mysql', url: 'mysql://127.0.0.1:1/app', seedFile: join(dir, 'seed.sql') }, {}),
        ),
      /SQL seed files are not supported/,
    );
    const malformed = processRun(dir, ['seed', '--engine', 'mysql', '--url', '--dry-run']);
    assert.equal(malformed.code, 1, malformed.output);
    assert.match(malformed.output, /requires a value|requires a MySQL/);
    assert.equal(existsSync(join(dir, 'effects')), false);
    // Keep the exported help function reachable to the source typecheck too.
    assert.equal(typeof showMysqlSeedHelp, 'function');
  });

  native.it(
    'executes discovered and explicitly selected trusted JS/TS defaults, repeats and rolls back in actual processes',
    async (t) => {
      const f = await mysqlSeedFixture(t);
      const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-seed-source-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      // Loader is project-local, independent of this test process's preload.
      const { symlinkSync } = await import('node:fs');
      symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
      for (const ext of ['mjs', 'cjs', 'ts', 'mts', 'cts']) {
        const filename = `chosen.${ext}`;
        const cjs = ext === 'cjs';
        const source = `${cjs ? 'module.exports =' : 'export default'} async (tx) => {
await tx.table('items').upsert({where:{id:1},create:{id:1,label:'${ext}',n:1},update:{label:'${ext}'}});
};`;
        writeFileSync(join(dir, filename), source);
        writeFileSync(
          join(dir, 'turbine.config.mjs'),
          `export default {engine:'mysql',url:${JSON.stringify(f.url)},seedFile:'${filename}',seed:'wrong.cjs'};`,
        );
        for (let n = 0; n < 2; n++) {
          const result = processRun(dir, ['seed']);
          assert.equal(result.code, 0, result.output);
          assert.match(result.output, /Seed completed/);
        }
        assert.deepEqual(await f.rows(), [{ id: 1, label: ext, n: 1 }]);
      }
      writeFileSync(
        join(dir, 'seed.js'),
        "export default async tx => { await tx.table('items').update({where:{id:1},data:{label:'discovered'}}); };\n",
      );
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'turbine.config.mjs'), `export default {engine:'mysql',url:${JSON.stringify(f.url)}};`);
      assert.equal(processRun(dir, ['seed']).code, 0);
      assert.deepEqual(await f.rows(), [{ id: 1, label: 'discovered', n: 1 }]);
      writeFileSync(
        join(dir, 'seed.js'),
        "import {writeFileSync} from 'node:fs'; writeFileSync('effects','module import'); export default async tx => { await tx.table('items').create({data:{id:2,label:'rollback',n:1}}); throw Error('seed callback failed'); };\n",
      );
      const failed = processRun(dir, ['seed']);
      assert.equal(failed.code, 1, failed.output);
      assert.match(failed.output, /seed callback failed/);
      assert.deepEqual(await f.rows(), [{ id: 1, label: 'discovered', n: 1 }]);
      assert.equal(readFileSync(join(dir, 'effects'), 'utf8'), 'module import');
      for (const body of ['export const seed=()=>{};', 'export default 7;']) {
        writeFileSync(join(dir, 'seed.js'), body);
        const result = processRun(dir, ['seed']);
        assert.equal(result.code, 1, result.output);
        assert.match(result.output, /callable default/);
      }
      writeFileSync(
        join(dir, 'seed.js'),
        "export default async tx=>{await tx.table('items').create({data:{id:2,label:'raw refusal',n:1}}); await tx.rawUnsafe('CREATE TABLE escaped_ddl(id INT)');};",
      );
      const refused = processRun(dir, ['seed']);
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, /do not support/);
      assert.deepEqual(await f.rows(), [{ id: 1, label: 'discovered', n: 1 }]);
      for (const argv of [
        ['seed', '--dry-run'],
        ['seed', '--schema', f.database],
        ['seed', 'seed.sql'],
        ['seed', '--url', '--verbose'],
      ]) {
        const result = processRun(dir, argv);
        assert.equal(result.code, 1, result.output);
        assert.doesNotMatch(result.output, /Seed completed/);
      }
      const initDir = join(dir, 'init');
      mkdirSync(initDir);
      writeFileSync(
        join(initDir, 'seed.js'),
        "import {writeFileSync} from 'node:fs';writeFileSync('unexpected-seed','ran');export default()=>{};",
      );
      const init = processRun(initDir, ['init', '--engine', 'mysql', '--url', f.url, '--skip-generate']);
      assert.equal(init.code, 0, init.output);
      assert.equal(existsSync(join(initDir, 'unexpected-seed')), false);
      {
        writeFileSync(
          join(dir, 'seed.js'),
          "export default async tx=>{await tx.table('items').update({where:{id:1},data:{label:'dispatcher'}});};",
        );
        for (const argv of [['seed'], ['seed', '--engine', 'mysql']]) {
          const result = processRun(dir, argv);
          assert.equal(result.code, 0, result.output);
          assert.match(result.output, /Seed completed/);
        }
        assert.deepEqual(await f.rows(), [{ id: 1, label: 'dispatcher', n: 1 }]);
        const help = processRun(dir, ['seed', '--help']);
        assert.equal(help.code, 0, help.output);
        assert.match(help.output, /DDL implicitly commits/);
      }
    },
  );
});
