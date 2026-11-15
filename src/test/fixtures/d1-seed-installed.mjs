/** Actual normal archive, independent installed CLI processes and generated consumers. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, installedPayload } from '../../../tooling/optional-pg-transports/harness.mjs';
import { bounded } from '../../../tooling/optional-pg-transports/lifecycle.mjs';
import { runWithShutdown } from '../../../tooling/optional-pg-transports/run.mjs';

const [evidence, archive, pin] = process.argv.slice(2);
assert(evidence && archive && /^[a-f0-9]{64}$/.test(pin));
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
assert.equal(hash(archive), pin);
const root = resolve(evidence),
  consumer = join(root, 'consumer'),
  reference = join(root, 'reference');
assert(!existsSync(root));
mkdirSync(consumer, { recursive: true });
mkdirSync(reference);
execFileSync('tar', ['-xzf', archive, '-C', reference]);
const manifest = JSON.parse(readFileSync(join(reference, 'package/package.json')));
assert.equal(manifest.scripts.prepare, undefined);
assert.equal(manifest.dependencies.pg, '^8.15.0');
const tools = resolve('node_modules'),
  npm = process.env.TURBINE_W94_NPM_CLI;
assert(npm && existsSync(npm), 'Explicit npm CLI required.');
const report = { archive, pin, node: process.version, commands: [], cells: [], failuresExpected: [] };
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const project = {
  engine: 'd1',
  d1: { binding: 'DB', databaseId: 'installed-seed', persist: './state' },
  out: './generated-esm',
  migrationsDir: './migrations',
};
writeFileSync(join(consumer, 'turbine.config.mjs'), `export default ${JSON.stringify(project)};\n`);
const values = [
  {
    id: 1,
    label: "seed ' ; -- ☃",
    n: 1.25,
    active: 1,
    missing: null,
    data: [0, 127, 128, 255],
    exact: '9007199254740993',
  },
  { id: 2, label: '', n: -2.5, active: 0, missing: null, data: [], exact: '2026-11-07T12:00:00.000Z' },
];
const seed = {
  version: 1,
  operations: [
    {
      table: 'items',
      columns: ['id', 'label', 'n', 'active', 'missing', 'data', 'exact'],
      rows: values.map((x) => [x.id, x.label, x.n, !!x.active, x.missing, { bytes: x.data }, x.exact]),
    },
  ],
};
const migration = [
  {
    id: '0001_items',
    statements: [
      'CREATE TABLE items(id INTEGER PRIMARY KEY,label TEXT NOT NULL UNIQUE,n REAL,active INTEGER,missing TEXT,data BLOB,exact TEXT)',
    ],
  },
];
const cwdBefore = process.cwd();
await runWithShutdown(report, join(root, 'report.json'), async (scope) => {
  const run = (cwd, args) => command(report, cwd, process.execPath, args, process.env, { scope, timeoutMs: 180000 });
  async function refusal(label, cwd, args, pattern) {
    let failed = false;
    try {
      await run(cwd, args);
    } catch {
      failed = true;
    }
    const c = report.commands.at(-1);
    assert(failed, label);
    assert.match(c.stdout + c.stderr, pattern);
    report.failuresExpected.push({ label, commandIndex: report.commands.length - 1, code: c.code });
  }
  await run(consumer, [npm, 'install', '--offline', '--omit=dev', archive]);
  const installed = join(consumer, 'node_modules/turbine-orm');
  report.initialPayload = installedPayload(join(reference, 'package'), installed);
  assert(!existsSync(join(consumer, 'node_modules/miniflare')));
  const require = createRequire(join(consumer, 'package.json'));
  assert.throws(() => require.resolve('miniflare'), { code: 'MODULE_NOT_FOUND' });
  assert.throws(() => require.resolve('workerd'), { code: 'MODULE_NOT_FOUND' });
  const bins = { esm: join(installed, 'dist/cli/index.js'), cjs: join(installed, 'dist/cjs/cli/index.js') };
  for (const format of ['esm', 'cjs']) {
    assert.equal(
      manifest.exports['./cli'][format === 'esm' ? 'import' : 'require'].default,
      `./dist/${format === 'esm' ? '' : 'cjs/'}cli/config.js`,
    );
    for (const alias of ['seed', 's']) {
      await run(consumer, [bins[format], alias, '--engine', 'd1', '--help']);
      await run(consumer, [bins[format], alias, '--help']);
    }
    await refusal(
      `missing-tool-${format}`,
      consumer,
      [bins[format], 'init', '--engine', 'd1', '--yes'],
      /optional miniflare/,
    );
    assert(!existsSync(join(consumer, 'state')) && !existsSync(join(consumer, 'migrations')));
  }
  // The normal config graph is byte-identical to current baseline: type exports emit no loader.
  const configEsm = await import(pathToFileURL(join(installed, manifest.exports['./cli'].import.default)));
  const configCjs = require(join(installed, manifest.exports['./cli'].require.default));
  assert.deepEqual(Object.keys(configEsm).sort(), Object.keys(configCjs).sort());
  const configLock = readFileSync(join(consumer, 'package-lock.json'));
  writeFileSync(join(root, 'no-tool-install.lock.json'), configLock);
  await run(consumer, [npm, 'install', '--offline', '--save-exact', 'miniflare@4.20260730.0']);
  const { Miniflare } = require('miniflare');
  report.miniflare = require('miniflare/package.json').version;
  assert.equal(report.miniflare, '4.20260730.0');
  const runtimeRequire = createRequire(require.resolve('miniflare'));
  const workerd = runtimeRequire('workerd').default;
  report.workerd = {
    version: execFileSync(workerd, ['--version'], { encoding: 'utf8' }).trim(),
    sha256: hash(workerd),
    package: runtimeRequire('workerd/package.json').version,
  };
  assert.equal(report.workerd.version, 'workerd 2026-07-30');
  assert.equal(report.workerd.package, '1.20260730.1');
  await run(consumer, [bins.esm, 'init', '--engine', 'd1', '--yes']);
  writeFileSync(join(consumer, 'migrations/plan.json'), JSON.stringify(migration));
  await run(consumer, [bins.cjs, 'migrate', 'deploy']);
  const seedPath = join(consumer, 'migrations/seed.json');
  writeFileSync(seedPath, JSON.stringify(seed));
  const result = await run(consumer, [bins.esm, 'seed']);
  assert.deepEqual(JSON.parse(result.trim().split('\n').at(-1)), { insertedRows: 2, statements: 2 });
  await run(consumer, [bins.cjs, 'status']);
  // A native duplicate in row two must undo row one too.
  const failed = structuredClone(seed);
  failed.operations[0].rows[0][0] = 3;
  failed.operations[0].rows[0][1] = 'third';
  failed.operations[0].rows[1][0] = 4;
  writeFileSync(seedPath, JSON.stringify(failed));
  await refusal('atomic-native-constraint', consumer, [bins.cjs, 'seed'], /outcome is unknown/);
  async function runtime(script, check) {
    console.info(`D1 seed installed native root ${consumer}/state, DB=installed-seed, loopback0 before launch.`);
    const mf = new Miniflare({
      cf: false,
      modules: true,
      script,
      d1Databases: { DB: 'installed-seed' },
      d1Persist: join(consumer, 'state'),
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      host: '127.0.0.1',
      port: 0,
      inspectorPort: 0,
    });
    try {
      const url = await bounded(mf.ready, 30000, 'installed workerd startup');
      console.info(`D1 seed installed ready: ${url.origin}`);
      await check(mf);
    } finally {
      await bounded(mf.dispose(), 5000, 'installed workerd disposal');
    }
  }
  const stored = async () => {
    let rows;
    await runtime('export default {fetch(){return new Response("ready")}}', async (mf) => {
      const db = await mf.getD1Database('DB');
      rows = (
        await db.prepare('SELECT id,label,n,active,missing,hex(data) AS bytes,exact FROM items ORDER BY id').all()
      ).results;
    });
    return rows;
  };
  const expected = values.map((x) => ({
    id: x.id,
    label: x.label,
    n: x.n,
    active: x.active,
    missing: x.missing,
    bytes: Buffer.from(x.data).toString('hex').toUpperCase(),
    exact: x.exact,
  }));
  assert.deepEqual(await stored(), expected);
  writeFileSync(seedPath, JSON.stringify(seed));
  const mfDir = join(consumer, 'node_modules/miniflare'),
    heldDir = join(consumer, 'node_modules/miniflare-held');
  renameSync(mfDir, heldDir);
  try {
    await refusal('missing-tool-seed', consumer, [bins.cjs, 'seed'], /optional miniflare/);
    assert(!existsSync(join(consumer, 'state/.turbine-d1.lock')));
  } finally {
    renameSync(heldDir, mfDir);
  }
  assert.deepEqual(await stored(), expected);
  // Recovery is a fresh, non-conflicting declarative insert, then independently reopen.
  const recovery = structuredClone(seed);
  recovery.operations[0].rows = [[3, 'third', 3.5, true, null, { bytes: [254] }, '1.000000000000000001']];
  writeFileSync(seedPath, JSON.stringify(recovery));
  const recovered = await run(consumer, [bins.cjs, 's']);
  assert.deepEqual(JSON.parse(recovered.trim().split('\n').at(-1)), { insertedRows: 1, statements: 1 });
  values.push({ id: 3, label: 'third', n: 3.5, active: 1, missing: null, data: [254], exact: '1.000000000000000001' });
  await run(consumer, [bins.esm, 'generate', '--no-timestamp', '--import-ext', 'js']);
  mkdirSync(join(consumer, 'cjs'));
  writeFileSync(join(consumer, 'cjs/package.json'), '{"type":"commonjs"}');
  await run(consumer, [bins.cjs, 'generate', '--out', './cjs/generated', '--no-timestamp', '--import-ext', 'js']);
  const verify = (path) =>
    `import { turbine } from '${path}';\nimport type { D1DatabaseBinding } from 'turbine-orm/d1';\nimport type { D1SeedPlan } from 'turbine-orm/cli';\nconst authored = {version:1,operations:[{table:'items',columns:['id'],rows:[[4]]}]} satisfies D1SeedPlan;\nexport async function verify(binding: D1DatabaseBinding) { const db=turbine(binding); const rows=await db.items.findMany({orderBy:{id:'asc'}}); await db.disconnect(); return rows.map(x=>({id:x.id,label:x.label,n:x.n,active:x.active,missing:x.missing,data:Array.from(x.data??[]),exact:x.exact})); }\n`;
  writeFileSync(join(consumer, 'verify.mts'), verify('./generated-esm/index.js'));
  writeFileSync(join(consumer, 'cjs/verify.cts'), verify('./generated/index.js'));
  mkdirSync(join(consumer, 'node_modules/@cloudflare'), { recursive: true });
  symlinkSync(
    join(tools, '@cloudflare/workers-types'),
    join(consumer, 'node_modules/@cloudflare/workers-types'),
    'dir',
  );
  report.workersTypes = JSON.parse(readFileSync(join(tools, '@cloudflare/workers-types/package.json'))).version;
  assert.equal(report.workersTypes, '5.20261106.1');
  for (const format of ['esm', 'cjs'])
    writeFileSync(
      join(consumer, `worker-strict-${format}.mts`),
      `import type {D1Database} from '@cloudflare/workers-types';\nimport {verify} from '${format === 'esm' ? './verify.mjs' : './cjs/verify.cjs'}';\nexport async function run(env:{DB:D1Database}){return verify(env.DB)}\n`,
    );
  const tsconfig = {
    compilerOptions: {
      strict: true,
      skipLibCheck: false,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      outDir: './build',
      types: ['node'],
      typeRoots: [join(tools, '@types')],
    },
    include: ['verify.mts', 'worker-strict-*.mts', 'generated-esm/**/*.ts', 'cjs/**/*.ts', 'cjs/**/*.cts'],
  };
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(tsconfig));
  await run(consumer, [join(tools, 'typescript/bin/tsc'), '-p', 'tsconfig.json']);
  writeFileSync(
    join(consumer, 'negative.mts'),
    `import type {D1SeedPlan} from 'turbine-orm/cli'; const bad:D1SeedPlan={version:1,operations:[{table:'items',columns:['data'],rows:[[{bytes:['bad']}]]}]};import type {Item} from './generated-esm/types.js';const badId:Item['id']='bad-generated-id';`,
  );
  writeFileSync(
    join(consumer, 'tsconfig-negative.json'),
    JSON.stringify({
      ...tsconfig,
      compilerOptions: { ...tsconfig.compilerOptions, noEmit: true },
      include: ['negative.mts'],
    }),
  );
  await refusal(
    'unmarked-negative-plan-type',
    consumer,
    [join(tools, 'typescript/bin/tsc'), '-p', 'tsconfig-negative.json'],
    /TS2322/,
  );
  mkdirSync(join(consumer, 'build/cjs'), { recursive: true });
  writeFileSync(join(consumer, 'build/cjs/package.json'), '{"type":"commonjs"}');
  const esbuild = createRequire(join(tools, '../package.json'))('esbuild');
  for (const format of ['esm', 'cjs']) {
    const compiled = format === 'esm' ? './build/verify.mjs' : './build/cjs/verify.cjs';
    let native;
    await runtime('export default {fetch(){return new Response("ready")}}', async (mf) => {
      const mod =
        format === 'esm' ? await import(pathToFileURL(join(consumer, compiled))) : require(join(consumer, compiled));
      native = await mod.verify(await mf.getD1Database('DB'));
      assert.deepEqual(native, values);
      const bound = await mf.getD1Database('DB');
      const helperPath = join(installed, `dist/${format === 'esm' ? '' : 'cjs/'}cli/d1-seed.js`);
      const helper = format === 'esm' ? await import(pathToFileURL(helperPath)) : require(helperPath);
      const trace = [];
      let preparedSeed = false,
        dispatches = 0;
      const traced = {
        prepare(text) {
          const statement = bound.prepare(text);
          if (text.startsWith('INSERT ')) preparedSeed = true;
          if (!text.includes('?1')) return statement;
          return {
            all: statement.all.bind(statement),
            bind(...params) {
              trace.push({
                sql: text,
                params: params.map((value) =>
                  value instanceof ArrayBuffer ? { bytes: Array.from(new Uint8Array(value)) } : value,
                ),
              });
              return statement.bind(...params);
            },
          };
        },
        async batch(statements) {
          const isSeed = preparedSeed;
          preparedSeed = false;
          const results = await bound.batch(statements);
          if (isSeed) {
            dispatches++;
            trace.push({ batchStatements: statements.length, acknowledgements: results });
            throw null;
          }
          return results;
        },
      };
      const lost = {
        version: 1,
        operations: [
          {
            table: 'items',
            columns: ['id', 'label', 'n', 'active', 'missing', 'data', 'exact'],
            rows: [[4, 'lost-response', 4.5, true, null, { bytes: [0, 255] }, '9007199254740995']],
          },
        ],
      };
      await assert.rejects(helper.executeD1Seed(traced, helper.captureD1Seed(lost), migration), (error) => {
        assert(error instanceof helper.D1SeedError);
        assert.equal(error.phase, 'dispatch');
        assert.equal(error.outcome, 'unknown');
        assert.equal(error.cause, null);
        return true;
      });
      assert.equal(dispatches, 1);
      assert.deepEqual(
        (await bound.prepare('SELECT id,label,hex(data) AS bytes,exact FROM items WHERE id=4').all()).results,
        [{ id: 4, label: 'lost-response', bytes: '00FF', exact: '9007199254740995' }],
      );
      writeFileSync(join(root, `installed-native-${format}-sql-binds-results.json`), JSON.stringify(trace, null, 2));
      await bound.prepare('DELETE FROM items WHERE id=4').all();
      report.installedUnknown ??= [];
      report.installedUnknown.push({ format, exactFalsyCause: true, dispatches, durableCommittedRow: true });

      await bound.prepare('UPDATE items SET exact=?1 WHERE id=1').bind('rounded-wrong-value').all();
      const wrongNative = await mod.verify(bound);
      assert.throws(() => assert.deepEqual(wrongNative, values));
      await bound.prepare('UPDATE items SET exact=?1 WHERE id=1').bind(values[0].exact).all();
      await bound.prepare('DELETE FROM items WHERE id=2').all();
      const omittedNative = await mod.verify(bound);
      assert.throws(() => assert.deepEqual(omittedNative, values));
      const restore = values[1];
      await bound
        .prepare('INSERT INTO items(id,label,n,active,missing,data,exact) VALUES(?1,?2,?3,?4,?5,?6,?7)')
        .bind(
          restore.id,
          restore.label,
          restore.n,
          restore.active,
          restore.missing,
          new Uint8Array(restore.data).buffer,
          restore.exact,
        )
        .all();
      assert.deepEqual(await mod.verify(bound), values);
      report.usefulControls ??= [];
      report.usefulControls.push({ format, wrongNativeValueDetected: true, omittedNativeRowDetected: true });
      assert.deepEqual(
        (await (await mf.getD1Database('DB')).prepare('SELECT count(*) AS n FROM items').all()).results,
        [{ n: 3 }],
      );
    });
    const worker = join(consumer, `worker-${format}.mjs`);
    writeFileSync(
      worker,
      `import {run} from './build/worker-strict-${format}.mjs';export default {async fetch(request,env){return Response.json(await run(env))}}`,
    );
    const bundle = await esbuild.build({
      absWorkingDir: consumer,
      entryPoints: [worker],
      bundle: true,
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      format: 'esm',
      // Existing D1 generated-consumer bridge: retain the actual workerd builtin in ESM.
      plugins: [
        {
          name: 'd1-native-builtin-bridge',
          setup(builder) {
            builder.onResolve({ filter: /^node:async_hooks$/ }, (args) =>
              args.namespace === 'builtin-bridge'
                ? { path: args.path, external: true }
                : { path: args.path, namespace: 'builtin-bridge' },
            );
            builder.onLoad({ filter: /.*/, namespace: 'builtin-bridge' }, () => ({
              contents: "export {AsyncLocalStorage} from 'node:async_hooks';",
              loader: 'js',
            }));
          },
        },
      ],
      write: false,
      metafile: true,
    });
    const branch = format === 'esm' ? 'dist/d1.js' : 'dist/cjs/d1.js';
    assert(Object.keys(bundle.metafile.inputs).some((x) => x.endsWith(`turbine-orm/${branch}`)));
    assert(!Object.keys(bundle.metafile.inputs).some((x) => /node_modules\/(pg|miniflare|workerd)\//.test(x)));
    writeFileSync(join(root, `worker-${format}-graph.json`), JSON.stringify(bundle.metafile, null, 2));
    writeFileSync(join(root, `worker-${format}.mjs`), bundle.outputFiles[0].contents);
    await runtime(bundle.outputFiles[0].text, async (mf) => {
      const response = await mf.dispatchFetch('http://seed/');
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), values);
    });
    report.cells.push({
      format,
      generatedNode: true,
      generatedWorker: true,
      rows: native.length,
      actualExport: branch,
    });
  }
  report.finalPayload = installedPayload(join(reference, 'package'), installed);
  assert.deepEqual(report.finalPayload, report.initialPayload);
  writeFileSync(join(root, 'tooling-install.lock.json'), readFileSync(join(consumer, 'package-lock.json')));
  report.completeValues = values;
  assert.equal(existsSync(join(consumer, 'state/.turbine-d1.lock')), false);
  rmSync(join(consumer, 'state'), { recursive: true });
  report.stateRemoved = true;
});
assert.equal(process.cwd(), cwdBefore);
console.log(
  `Installed D1 seed ${process.version}: ESM/CJS CLI, strict authoring/generated Node+Worker, atomicity/recovery/no-tool and full payload PASS.`,
);
