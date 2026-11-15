/** Real tarball consumers and shipped processes, with no loader preloads. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { skipGate } from './helpers.js';
import { mysqlSeedFixture, mysqlSeedUrl } from './mysql-seed-helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native = skipGate(
  !mysqlSeedUrl,
  'requires MYSQL_URL / MYSQL_TEST_URL pointing at an exclusively owned disposable MySQL 8 server',
);
function run(command: string, args: string[], cwd: string) {
  const r = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', NO_COLOR: '1' },
  });
  return { code: r.status, output: `${r.stdout}\n${r.stderr}\n${r.error ?? ''}` };
}
function checked(command: string, args: string[], cwd: string) {
  const r = run(command, args, cwd);
  assert.equal(r.code, 0, r.output);
  return r.output;
}
function version(name: string) {
  return `${name}@${JSON.parse(readFileSync(join(repo, 'node_modules', name, 'package.json'), 'utf8')).version}`;
}
function install(cwd: string, args: string[]) {
  checked('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', ...args], cwd);
}
function pack(dir: string) {
  const pkg = join(dir, 'package');
  mkdirSync(join(pkg, 'scripts'), { recursive: true });
  for (const file of [
    'package.json',
    'README.md',
    'LICENSE',
    'tsconfig.json',
    'tsconfig.cjs.json',
    'scripts/finish-cjs-build.mjs',
  ])
    copyFileSync(join(repo, file), join(pkg, file));
  // Match normal publication: checkout-only prepare is absent from a tarball.
  // npm 10 can run prepare even with pack --ignore-scripts. Never run hooks in staging.
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  delete manifest.scripts.prepare;
  writeFileSync(join(pkg, 'package.json'), JSON.stringify(manifest));
  cpSync(join(repo, 'src'), join(pkg, 'src'), { recursive: true });
  cpSync(join(repo, 'types'), join(pkg, 'types'), { recursive: true });
  symlinkSync(join(repo, 'node_modules'), join(pkg, 'node_modules'), 'dir');
  checked(join(repo, 'node_modules/.bin/tsc'), ['-p', join(pkg, 'tsconfig.json')], pkg);
  checked(join(repo, 'node_modules/.bin/tsc'), ['-p', join(pkg, 'tsconfig.cjs.json')], pkg);
  checked(process.execPath, [join(pkg, 'scripts/finish-cjs-build.mjs')], pkg);
  checked('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], pkg);
  const v = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;
  return join(dir, `turbine-orm-${v}.tgz`);
}

describe('MySQL seed packed ESM and CommonJS', () => {
  it('ships strict declarations, optional-peer refusals and real native seed processes', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-seed-packed-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const archive = pack(dir);
    t.diagnostic(
      `Tarball SHA256 ${createHash('sha256').update(readFileSync(archive)).digest('hex')}; actual shipped CLI dispatcher`,
    );
    const consumer = join(dir, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), '{"private":true}');
    install(consumer, ['--omit=optional', archive, version('typescript'), version('@types/node')]);
    const installed = join(consumer, 'node_modules/turbine-orm');
    assert.equal(existsSync(join(consumer, 'node_modules/mysql2')), false);
    assert.equal(existsSync(join(consumer, 'node_modules/tsx')), false);
    const compiler = join(consumer, 'node_modules/typescript/bin/tsc');
    for (const ext of ['mts', 'cts']) {
      writeFileSync(
        join(consumer, `consumer.${ext}`),
        `import {defineMysqlSeed,runMysqlSeed,type MysqlSeedClient,type MysqlSeedTable} from 'turbine-orm/mysql/seed';
type Row={id:number;label:string;n:number};
const seed=defineMysqlSeed(async(tx:MysqlSeedClient)=>{const items:MysqlSeedTable<Row>=tx.table<Row>('items');const rows:Row[]=await items.findMany({where:{n:{gt:0}}});await items.create({data:{id:1,label:'typed',n:rows.length+1}});await tx.$transaction(async(inner)=>{await inner.table<Row>('items').count();});});
if(typeof seed!=='function'||typeof runMysqlSeed!=='function')throw Error('missing exports');
`,
      );
      const flags = [
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--strict',
        '--skipLibCheck',
        'false',
        '--target',
        'ES2023',
      ];
      checked(process.execPath, [compiler, `consumer.${ext}`, '--outDir', 'compiled', ...flags], consumer);
      checked(process.execPath, [join(consumer, 'compiled', `consumer.${ext === 'cts' ? 'cjs' : 'mjs'}`)], consumer);
      writeFileSync(
        join(consumer, `bad.${ext}`),
        `import {defineMysqlSeed} from 'turbine-orm/mysql/seed';defineMysqlSeed(async tx=>{await tx.rawUnsafe('CREATE TABLE nope(id INT)');await tx.$transaction(async inner=>{inner.$connection();});tx.table<{id:number}>('items').create({data:{id:'wrong'}});});`,
      );
      const bad = run(process.execPath, [compiler, `bad.${ext}`, '--noEmit', ...flags], consumer);
      assert.notEqual(bad.code, 0, bad.output);
      assert.match(bad.output, /rawUnsafe/);
      assert.match(bad.output, /\$connection/);
      assert.match(bad.output, /not assignable to type/);
    }
    const entries: { project: string; entry: string; cjs: boolean }[] = [];
    for (const cjs of [false, true]) {
      const project = join(consumer, cjs ? 'commonjs' : 'module');
      mkdirSync(project);
      writeFileSync(join(project, 'package.json'), JSON.stringify({ type: cjs ? 'commonjs' : 'module' }));
      const entry = join(installed, cjs ? 'dist/cjs/cli/index.js' : 'dist/cli/index.js');
      entries.push({ project, entry, cjs });
      const help = checked(process.execPath, [entry, 'seed', '--engine', 'mysql', '--help'], project);
      assert.match(help, /DDL implicitly commits/);
      assert.match(help, /raw SQL/);
      assert.match(help, /tsx/);
      writeFileSync(
        join(project, 'seed.mjs'),
        "import {writeFileSync} from 'node:fs';writeFileSync('effects','imported');export default()=>{};",
      );
      writeFileSync(
        join(project, 'turbine.config.mjs'),
        "export default {engine:'mysql',url:'mysql://127.0.0.1:1/unused',seedFile:'./seed.mjs'};",
      );
      const missing = run(process.execPath, [entry, 'seed'], project);
      assert.equal(missing.code, 1, missing.output);
      assert.match(missing.output, /optional peer dependency 'mysql2'/);
      assert.equal(existsSync(join(project, 'effects')), false);
      const direct = join(project, cjs ? 'direct.cjs' : 'direct.mjs');
      writeFileSync(
        direct,
        cjs
          ? "const {runMysqlSeed}=require('turbine-orm/mysql/seed');runMysqlSeed('mysql://127.0.0.1:1/unused',{tables:{},enums:{}},()=>{}).catch(e=>{console.error(e.message);process.exitCode=1;});"
          : "import {runMysqlSeed} from 'turbine-orm/mysql/seed';await runMysqlSeed('mysql://127.0.0.1:1/unused',{tables:{},enums:{}},()=>{});",
      );
      const refusal = run(process.execPath, [direct], project);
      assert.equal(refusal.code, 1, refusal.output);
      assert.match(refusal.output, /optional peer dependency 'mysql2'/);
    }
    install(consumer, [version('mysql2')]);
    await native.it(
      'loads project-local TS, commits/repeats DML and refuses unsafe operations through installed processes',
      async (t) => {
        const f = await mysqlSeedFixture(t);
        assert.equal(existsSync(join(consumer, 'node_modules/tsx')), false);
        for (const { project, entry, cjs } of entries) {
          for (const ext of ['mjs', 'cjs']) {
            const label = `plain-${cjs ? 'commonjs' : 'esm'}-${ext}`;
            const file = `plain.${ext}`;
            const declaration =
              ext === 'cjs'
                ? "const {defineMysqlSeed}=require('turbine-orm/mysql/seed');module.exports ="
                : "import {defineMysqlSeed} from 'turbine-orm/mysql/seed';await Promise.resolve();export default";
            writeFileSync(
              join(project, file),
              `${declaration} defineMysqlSeed(async tx=>{await tx.table('items').upsert({where:{id:1},create:{id:1,label:'${label}',n:1},update:{label:'${label}'}});});`,
            );
            writeFileSync(
              join(project, 'turbine.config.mjs'),
              `await Promise.resolve();export default {engine:'mysql',url:${JSON.stringify(f.url)},seedFile:'./${file}'};`,
            );
            assert.match(checked(process.execPath, [entry, 'seed'], project), /Seed completed/);
            assert.deepEqual(await f.rows(), [{ id: 1, label, n: 1 }]);
          }
          writeFileSync(
            join(project, 'declaration.mjs'),
            "import {writeFileSync} from 'node:fs';import {defineMysqlSeed} from 'turbine-orm/mysql/seed';export default defineMysqlSeed(()=>writeFileSync('unexpected-direct-callback','ran'));",
          );
          checked(process.execPath, [join(project, 'declaration.mjs')], project);
          assert.equal(existsSync(join(project, 'unexpected-direct-callback')), false);
          const init = join(project, 'init');
          mkdirSync(init);
          writeFileSync(join(init, 'seed.js'), "require('node:fs').writeFileSync('unexpected-init-seed','ran');");
          const shippedCli = join(installed, cjs ? 'dist/cjs/cli/index.js' : 'dist/cli/index.js');
          checked(process.execPath, [shippedCli, 'init', '--engine', 'mysql', '--url', f.url, '--skip-generate'], init);
          assert.equal(existsSync(join(init, 'unexpected-init-seed')), false);
        }
        for (const { project, entry } of entries) {
          writeFileSync(
            join(project, 'chosen.ts'),
            "import {writeFileSync} from 'node:fs';writeFileSync('effects','imported');export default()=>{};",
          );
          writeFileSync(
            join(project, 'turbine.config.mjs'),
            `export default {engine:'mysql',url:${JSON.stringify(f.url)},seedFile:'./chosen.ts'};`,
          );
          const missing = run(process.execPath, [entry, 'seed'], project);
          assert.equal(missing.code, 1, missing.output);
          assert.match(missing.output, /TypeScript MySQL seed \(missing\)/);
          assert.equal(existsSync(join(project, 'effects')), false);
        }
        install(consumer, [version('tsx')]);
        for (const { project, entry, cjs } of entries) {
          rmSync(join(project, 'turbine.config.mjs'));
          writeFileSync(
            join(project, 'turbine.config.ts'),
            `import type {TurbineCliConfig} from 'turbine-orm/cli';export default {engine:'mysql',url:${JSON.stringify(f.url)},seedFile:'./chosen.${cjs ? 'cts' : 'mts'}',seed:'./wrong.mjs'} satisfies TurbineCliConfig;`,
          );
          const seed = join(project, `chosen.${cjs ? 'cts' : 'mts'}`);
          const label = cjs ? 'commonjs' : 'esm';
          writeFileSync(
            seed,
            `import {defineMysqlSeed} from 'turbine-orm/mysql/seed';type Item={id:number;label:string;n:number};export default defineMysqlSeed(async tx=>{await tx.table<Item>('items').upsert({where:{id:1},create:{id:1,label:'${label}',n:1},update:{label:'${label}'}});});`,
          );
          for (let n = 0; n < 2; n++)
            assert.match(checked(process.execPath, [entry, 'seed'], project), /Seed completed/);
          assert.deepEqual(await f.rows(), [{ id: 1, label, n: 1 }]);
          assert.match(
            checked(process.execPath, [entry, 'seed', '--engine', 'mysql', '--help'], project),
            /DML|reads\/DML/,
          );
          assert.match(checked(process.execPath, [entry, 'seed', '--help'], project), /DDL implicitly commits/);
          writeFileSync(
            seed,
            "export default async tx=>{await tx.table('items').create({data:{id:2,label:'rollback',n:1}});throw Error('packed callback failure');};",
          );
          let failed = run(process.execPath, [entry, 'seed'], project);
          assert.equal(failed.code, 1, failed.output);
          assert.match(failed.output, /packed callback failure/);
          assert.deepEqual(await f.rows(), [{ id: 1, label, n: 1 }]);
          writeFileSync(
            seed,
            "export default async tx=>{await tx.table('items').create({data:{id:2,label:'raw',n:1}});await tx.$transaction(async inner=>{await inner.rawUnsafe('CREATE TABLE escaped_ddl(id INT)');});};",
          );
          failed = run(process.execPath, [entry, 'seed'], project);
          assert.equal(failed.code, 1, failed.output);
          assert.match(failed.output, /do not support/);
          assert.deepEqual(await f.rows(), [{ id: 1, label, n: 1 }]);
          writeFileSync(seed, 'export const seed=()=>{};');
          failed = run(process.execPath, [entry, 'seed'], project);
          assert.equal(failed.code, 1, failed.output);
          assert.match(failed.output, /callable default/);
          writeFileSync(
            seed,
            "import {writeFileSync} from 'node:fs';writeFileSync('effects','unsafe import');export default()=>{};",
          );
          for (const flags of [
            ['--dry-run'],
            ['--preview'],
            ['--url', '--verbose'],
            ['--schema', f.database],
            ['seed.sql'],
          ]) {
            const refused = run(process.execPath, [entry, 'seed', ...flags], project);
            assert.equal(refused.code, 1, refused.output);
            assert.equal(existsSync(join(project, 'effects')), false, refused.output);
          }
          // Default discovery remains the shared resolver's .ts/.js convention.
          rmSync(join(project, 'turbine.config.ts'));
          writeFileSync(
            join(project, 'turbine.config.mjs'),
            `export default {engine:'mysql',url:${JSON.stringify(f.url)}};`,
          );
          rmSync(join(project, 'seed.mjs'));
          writeFileSync(join(project, 'seed.js'), `${cjs ? 'module.exports =' : 'export default'} ()=>{};`);
          assert.match(checked(process.execPath, [entry, 'seed'], project), /Seed completed/);
          assert.deepEqual(await f.rows(), [{ id: 1, label, n: 1 }]);
        }
        assert.deepEqual((await f.pool.query("SHOW TABLES LIKE 'escaped_ddl'"))[0], []);
      },
    );
  });
});
