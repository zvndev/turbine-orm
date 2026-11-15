/** Packed/source command processes with a native API fault model, not a server. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sourceRepo = repo;

it('source and packed ESM/CJS seed command processes, strict declarations and ownership/refusal controls', {
  timeout: 180_000,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-seed-pack-'));
  const log = join(dir, 'events.jsonl');
  const state = join(dir, 'rows.json');
  const run = (command: string, args: string[], cwd: string, extra: Record<string, string> = {}) => {
    const r = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        NODE_OPTIONS: '',
        DATABASE_URL: '',
        NO_COLOR: '1',
        MSSQL_FIXTURE_LOG: log,
        MSSQL_FIXTURE_STATE: state,
        ...extra,
      },
    });
    return { status: r.status, output: `${r.stdout}\n${r.stderr}\n${r.error ?? ''}` };
  };
  const ok = (command: string, args: string[], cwd: string, extra?: Record<string, string>) => {
    const r = run(command, args, cwd, extra);
    assert.equal(r.status, 0, r.output);
    return r.output;
  };
  const events = (): { event: string; tx?: number | null; sql?: string }[] =>
    existsSync(log) && readFileSync(log, 'utf8').trim()
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((s) => JSON.parse(s))
      : [];
  const reset = () => {
    writeFileSync(log, '');
    rmSync(state, { force: true });
  };
  try {
    const stage = join(dir, 'stage');
    mkdirSync(join(stage, 'scripts'), { recursive: true });
    for (const file of ['tsconfig.json', 'tsconfig.cjs.json', 'scripts/finish-cjs-build.mjs'])
      copyFileSync(join(repo, file), join(stage, file));
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    delete pkg.scripts;
    writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg));
    cpSync(join(sourceRepo, 'src'), join(stage, 'src'), { recursive: true });
    cpSync(join(repo, 'types'), join(stage, 'types'), { recursive: true });
    const dependencies = join(dir, 'node_modules');
    mkdirSync(dependencies);
    // Do not link tsx yet: JavaScript commands and strict consumers must work
    // before it is available in the project.
    for (const name of ['pg', '@types']) symlinkSync(join(repo, 'node_modules', name), join(dependencies, name), 'dir');
    // Compile the optional literal Neon import, but keep its peer out of the
    // installed SQL Server consumer's resolution path.
    mkdirSync(join(stage, 'node_modules'));
    symlinkSync(join(repo, 'node_modules/@neondatabase'), join(stage, 'node_modules/@neondatabase'), 'dir');
    const driver = join(dependencies, 'mssql');
    mkdirSync(driver);
    writeFileSync(join(driver, 'package.json'), '{"name":"mssql","main":"index.cjs"}');
    copyFileSync(join(repo, 'src/test/fixtures/mssql-seed-driver.cjs'), join(driver, 'index.cjs'));
    copyFileSync(join(repo, 'src/test/fixtures/mssql-cli-driver.cjs'), join(driver, 'mssql-cli-driver.cjs'));
    for (const format of ['esm', 'cjs'])
      ok(
        join(repo, 'node_modules/.bin/tsc'),
        ['-p', join(stage, format === 'esm' ? 'tsconfig.json' : 'tsconfig.cjs.json')],
        repo,
      );
    ok(process.execPath, [join(stage, 'scripts/finish-cjs-build.mjs')], stage);
    const packed = JSON.parse(ok('npm', ['pack', '--ignore-scripts', '--json'], stage)) as { filename: string }[];
    const installed = join(dependencies, 'turbine-orm');
    mkdirSync(installed);
    ok('tar', ['-xzf', join(stage, packed[0]!.filename), '--strip-components=1', '-C', installed], dir);
    for (const format of ['esm', 'cjs']) {
      const consumer = join(dir, format);
      mkdirSync(consumer);
      writeFileSync(join(consumer, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
      const helper = join(installed, format === 'esm' ? 'dist/cli/mssql-seed.js' : 'dist/cjs/cli/mssql-seed.js');
      const cli = join(installed, format === 'esm' ? 'dist/cli/index.js' : 'dist/cjs/cli/index.js');
      const wrapper = join(consumer, 'command.mjs');
      const config = {
        engine: 'mssql',
        url: 'mssql://localhost/disposable',
        schema: 'app',
        include: ['users'],
        exclude: [],
        out: './generated',
        migrationsDir: './migrations',
        seedFile: './seed.mjs',
        importExtension: 'auto',
        keepColumnNames: false,
        legacyToManyUniques: false,
      };
      writeFileSync(join(consumer, 'turbine.config.mjs'), `export default ${JSON.stringify(config)};`);
      const wrapperText = (path: string) =>
        `import { cmdMssqlSeed } from ${JSON.stringify(path)};\nawait cmdMssqlSeed({command:'seed',positional:[]}, ${JSON.stringify(config)}, (url) => import(url));`;
      writeFileSync(wrapper, wrapperText(helper));
      const execute = (extra?: Record<string, string>) => run(process.execPath, [cli, 'seed'], consumer, extra);
      const good = (extra?: Record<string, string>) => {
        const r = execute(extra);
        assert.equal(r.status, 0, r.output);
        return r.output;
      };
      const bad = (pattern: RegExp, extra?: Record<string, string>) => {
        const r = execute(extra);
        assert.notEqual(r.status, 0, r.output);
        assert.match(r.output, pattern);
        return r.output;
      };
      const seed = `import { defineMssqlSeed } from 'turbine-orm/mssql/seed';\nexport default defineMssqlSeed(async tx => {
        if (Object.keys(tx).sort().join(',') !== '$transaction,table') throw Error('unrestricted handle');
        await tx.table('users').create({ data: { email: 'saved', display_name: 'Seed' } });
        const rows = await tx.table('users').findMany();
        if (rows.length !== 1 || rows[0].email !== 'saved') throw Error('readback failed');
      });`;
      writeFileSync(join(consumer, 'seed.mjs'), seed);
      reset();
      assert.match(good(), /Seed completed/);
      let observed = events();
      assert.equal(
        observed.filter((e) => e.event === 'close').length,
        2,
        'introspection and owned factory pools both close',
      );
      const pin = observed.find((e) => e.event === 'begin')!.tx;
      assert.ok(pin);
      assert.ok(observed.filter((e) => e.event === 'request' && e.tx === pin).length >= 3);
      assert.ok(
        observed
          .filter((e) => e.event === 'request' && /seed_schema|INSERT INTO|FROM \[users\]/.test(e.sql ?? ''))
          .every((e) => e.tx === pin),
      );
      assert.equal(JSON.parse(readFileSync(state, 'utf8'))[0].email, 'saved');
      for (const extension of ['cjs', 'js']) {
        config.seedFile = `./seed.${extension}`;
        const cjs = extension === 'cjs' || format === 'cjs';
        writeFileSync(
          join(consumer, `seed.${extension}`),
          cjs
            ? "module.exports = async tx => { await tx.table('users').create({data:{email:'javascript'}}); };"
            : "export default async tx => { await tx.table('users').create({data:{email:'javascript'}}); };",
        );
        writeFileSync(
          join(consumer, 'turbine.config.js'),
          `${format === 'cjs' ? 'module.exports =' : 'export default'} ${JSON.stringify(config)};`,
        );
        writeFileSync(wrapper, wrapperText(helper));
        reset();
        assert.match(good(), /Seed completed/);
        assert.equal(JSON.parse(readFileSync(state, 'utf8'))[0].email, 'javascript');
        rmSync(join(consumer, 'turbine.config.js'));
      }
      config.seedFile = './seed.mjs';
      writeFileSync(wrapper, wrapperText(helper));
      // Source helper process uses the same staged source with an explicit
      // native importer, without editing the working tree's dispatcher.
      if (format === 'esm') {
        writeFileSync(wrapper, wrapperText(join(stage, 'src/cli/mssql-seed.ts')));
        reset();
        ok(process.execPath, ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), wrapper], consumer);
        assert.equal(events().filter((e) => e.event === 'commit').length, 1);
        reset();
        ok(
          process.execPath,
          ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(stage, 'src/cli/index.ts'), 'seed'],
          consumer,
        );
        assert.equal(events().filter((e) => e.event === 'commit').length, 1);
        writeFileSync(wrapper, wrapperText(helper));
      }
      writeFileSync(
        join(consumer, 'seed.mjs'),
        seed.replace('if (rows.length', "throw Error('callback failed'); if (rows.length"),
      );
      reset();
      bad(/callback failed/);
      observed = events();
      assert.equal(observed.filter((e) => e.event === 'commit').length, 0);
      assert.equal(observed.filter((e) => e.event === 'rollback').length, 1);
      assert.equal(observed.filter((e) => e.event === 'close').length, 2);
      assert.equal(existsSync(state), false, 'failed callback must not persist modeled rows');
      writeFileSync(join(consumer, 'seed.mjs'), seed);
      for (const fault of ['begin', 'query', 'commit']) {
        reset();
        bad(new RegExp(`${fault === 'query' ? 'DML' : fault} fault`), { MSSQL_SEED_FAULT: fault });
        assert.equal(events().filter((e) => e.event === 'close').length, 2);
        assert.equal(existsSync(state), false);
      }
      reset();
      bad(/resolution/, { MSSQL_SEED_SCHEMA: 'other' });
      assert.equal(
        events().some((e) => e.sql?.startsWith('INSERT')),
        false,
      );
      writeFileSync(join(consumer, 'seed.mjs'), 'export default {};');
      reset();
      bad(/callable default/);
      assert.equal(
        events().some((e) => e.event === 'begin'),
        false,
      );
      writeFileSync(join(consumer, 'seed.mjs'), seed);
      // Check runtime borrowing with the actual lazily loaded native driver.
      const borrowed = join(consumer, 'borrowed.mjs');
      writeFileSync(
        borrowed,
        `import assert from 'node:assert/strict';
import driver from 'mssql'; import {runMssqlSeed} from 'turbine-orm/mssql/seed';
const native = await new driver.ConnectionPool({}).connect();
const schema = {tables:{users:{name:'users',columns:[{name:'email',field:'email',pgType:'text',tsType:'string',nullable:false,hasDefault:false,isPrimaryKey:false}],primaryKey:[],columnMap:{email:'email'},reverseColumnMap:{email:'email'},dateColumns:new Set(),allColumns:['email'],uniqueColumns:[],dialectTypes:{email:'nvarchar'},pgTypes:{email:'text'},relations:{},indexes:[]}},enums:{}};
try { await runMssqlSeed(native, schema, async tx => {await tx.table('users').create({data:{email:'borrowed'}});throw Error('borrowed failure');}, {schema:'app',logger:{}}); assert.fail('failure missed'); } catch(e) { assert.match(e.message,/borrowed failure/); }
assert.equal(native.closed,false); assert.deepEqual(native.rows,[]); await native.close();`,
      );
      reset();
      ok(process.execPath, [borrowed], consumer);
      assert.equal(events().filter((e) => e.event === 'close').length, 1);
      const declaration = join(consumer, format === 'esm' ? 'consumer.mts' : 'consumer.cts');
      writeFileSync(
        declaration,
        `import {defineMssqlSeed, type MssqlSeedClient} from 'turbine-orm/mssql/seed';
interface User {id:number;email:string}
const fn=defineMssqlSeed(async tx=>{
 const rows=await tx.table<User>('users').findMany({select:{email:true}});
 const email:string=rows[0]!.email;
 // @ts-expect-error selected result excludes id
 const id=rows[0]!.id;
 // @ts-expect-error typo in typed data
 await tx.table<User>('users').create({data:{emali:'x'}});
 // @ts-expect-error no raw control surface
 tx.rawUnsafe('COMMIT');
 // @ts-expect-error no deferred query escape
 tx.table<User>('users').buildCreate({data:{email:'x'}});
 // @ts-expect-error no stream lifetime escape
 tx.table<User>('users').findManyStream();
 await tx.$transaction(async inner=>{
 // @ts-expect-error nested callback cannot reach native connection
 inner.$connection();
 });
});
const callback:(tx:MssqlSeedClient)=>Promise<void>|void=fn; void callback;`,
      );
      ok(
        join(repo, 'node_modules/.bin/tsc'),
        [
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          'false',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--target',
          'ES2023',
          declaration,
        ],
        consumer,
      );
      // Missing optional peer is a separate refusal, not a tsx diagnosis.
      rmSync(driver, { recursive: true });
      reset();
      bad(/mssql.*(?:Install|install)|(?:Install|install).*mssql/);
      mkdirSync(driver);
      writeFileSync(join(driver, 'package.json'), '{"name":"mssql","main":"index.cjs"}');
      copyFileSync(join(repo, 'src/test/fixtures/mssql-seed-driver.cjs'), join(driver, 'index.cjs'));
      copyFileSync(join(repo, 'src/test/fixtures/mssql-cli-driver.cjs'), join(driver, 'mssql-cli-driver.cjs'));
      // Repoint the configured file to TS; no loader preloads are present.
      config.seedFile = './seed.cts';
      writeFileSync(
        join(consumer, 'seed.cts'),
        `export default async (tx: {table(name:string):{create(args:unknown):Promise<unknown>}}) => { await tx.table('users').create({data:{email:'typescript'}}); };`,
      );
      writeFileSync(join(consumer, 'turbine.config.mjs'), `export default ${JSON.stringify(config)};`);
      writeFileSync(wrapper, wrapperText(helper));
      reset();
      bad(/TypeScript SQL Server seed \(missing\).*tsx/);
      symlinkSync(join(repo, 'node_modules/tsx'), join(dependencies, 'tsx'), 'dir');
      reset();
      assert.match(good(), /Seed completed/);
      assert.equal(JSON.parse(readFileSync(state, 'utf8'))[0].email, 'typescript');
      writeFileSync(join(consumer, 'turbine.config.ts'), `export default ${JSON.stringify(config)};`);
      reset();
      assert.match(good(), /Seed completed/);
      assert.equal(JSON.parse(readFileSync(state, 'utf8'))[0].email, 'typescript');
      rmSync(join(consumer, 'turbine.config.ts'));
      ok(
        join(repo, 'node_modules/.bin/tsc'),
        [
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          'false',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--target',
          'ES2023',
          declaration,
        ],
        consumer,
      );
      unlinkSync(join(dependencies, 'tsx'));
      reset();
      const help = ok(process.execPath, [cli, 'seed', '--engine', 'mssql', '--help'], consumer);
      assert.match(help, /defineMssqlSeed/);
      assert.equal(events().length, 0);
      assert.match(ok(process.execPath, [cli, 'seed', '--help'], consumer), /defineMssqlSeed/);
      assert.equal(events().length, 0);
      config.seedFile = './seed.sql';
      writeFileSync(join(consumer, 'seed.sql'), 'COMMIT; DROP TABLE users;');
      writeFileSync(join(consumer, 'turbine.config.mjs'), `export default ${JSON.stringify(config)};`);
      reset();
      bad(/SQL files are not supported/);
      assert.equal(events().length, 0);
      for (const args of [
        ['seed', 'file.js'],
        ['seed', '--dry-run'],
        ['seed', '--url', '--verbose'],
        ['seed', '--schema'],
      ]) {
        reset();
        const r = run(process.execPath, [cli, ...args, '--engine', 'mssql'], consumer);
        assert.notEqual(r.status, 0, `${args}: ${r.output}`);
        assert.equal(events().length, 0);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
