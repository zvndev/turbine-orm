/** Fresh installed exact-runtime proofs, using the established bounded owner. */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command, installedPayload } from '../../optional-pg-transports/harness.mjs';
import { runWithShutdown } from '../../optional-pg-transports/run.mjs';
import { fileHashes, files, hashFile, sourceHashes } from '../artifact-contract.mjs';
import { definition } from './fixture.mjs';
const here = dirname(fileURLToPath(import.meta.url)), source = resolve(here, '../../..');
const [d1Path, sqlitePath, destination, port] = process.argv.slice(2);
assert.ok(d1Path && sqlitePath && destination && port && !existsSync(destination), 'Usage: node prove.mjs D1_ID SQLITE_ID NEW_ROOT OWNED_PORT');
const root = resolve(destination);
mkdirSync(root, { recursive: true });
const identities = Object.fromEntries([d1Path, sqlitePath].map(path => { const identity = JSON.parse(readFileSync(path)); assert.equal(hashFile(identity.archive), identity.sha256); assert.deepEqual(sourceHashes(source), identity.inputHashes); assert.deepEqual(fileHashes(join(source, 'dist')), identity.build.distHashes); return [identity.profile, { path, identity }]; }));
assert.ok(identities.d1 && identities.sqlite);
const npm = process.env.npm_execpath;
assert.ok(npm, 'Set npm_execpath to the npm CLI JavaScript file, or run through npm exec.');
const tsc = join(source, 'node_modules/typescript/bin/tsc');
const nodeRequire = createRequire(import.meta.url);
const report = { commands: [], node: { path: process.execPath, version: process.version, sha256: hashFile(process.execPath) }, identities, tooling: { typescript: nodeRequire('typescript/package.json').version, nodeTypes: '22.20.4', workerTypes: '5.20261106.1' }, results: [] };
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, NODE_PATH: '', NODE_OPTIONS: '', DATABASE_URL: '', TMPDIR: join(root, 'tmp'), npm_config_cache: join(root, 'npm-cache') };
mkdirSync(env.TMPDIR);
const original = JSON.parse(readFileSync(join(source, 'package.json')));
const normalApi = await import(pathToFileURL(join(source, 'dist/index.js')));
const { generateD1Files } = await import(pathToFileURL(join(source, 'dist/d1/generate.js')));
const schema = normalApi.schemaDefToMetadata(normalApi.defineSchema(definition));
schema.tables.pairs.columns.find(column => column.name === 'computed').isGeneratedStored = true;
await runWithShutdown(report, join(root, 'report.json'), async scope => {
  const run = (cwd, binary, args) => command(report, cwd, binary, args, env, { scope, timeoutMs: 240_000 });
  for (const profile of ['d1', 'sqlite']) {
    const consumer = join(root, `consumer-${profile}`);
    mkdirSync(consumer);
    const { identity, path } = identities[profile];
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { 'turbine-orm': `file:${identity.archive}` } }));
    await run(consumer, process.execPath, [npm, 'install', '--omit=dev', '--no-audit', '--no-fund']);
    const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json')));
    const productionPackages = Object.entries(lock.packages).filter(([path]) => path);
    assert.equal(productionPackages.length, 1, 'Fresh production closure must contain only the aliased runtime profile');
    const installedHashes = installedPayload(join(dirname(path), 'package'), join(consumer, 'node_modules/turbine-orm'));
    const productionBytes = Object.values(installedHashes).length;
    const payloadBytes = files(join(consumer, 'node_modules/turbine-orm')).reduce((total, path) => total + readFileSync(path).length, 0);
    const physicalManifests = files(join(consumer, 'node_modules')).filter(path => path.endsWith('/package.json')).map(path => ({ path, sha256: hashFile(path), ...JSON.parse(readFileSync(path)) })).filter(pkg => pkg.name);
    assert.equal(physicalManifests.length, 1, 'No hidden physical dependency may satisfy a missing driver');
    assert.equal(physicalManifests[0].name, `turbine-orm-${profile}-runtime-stage`);
    const manifest = JSON.parse(readFileSync(join(consumer, 'node_modules/turbine-orm/package.json')));
    const engine = await import(pathToFileURL(join(source, `dist/${profile}.js`)));
    const errors = await import(pathToFileURL(join(source, 'dist/errors.js')));
    const sql = await import(pathToFileURL(join(source, 'dist/sql.js')));
    const expected = { '.': [...new Set([...Object.keys(engine), ...Object.keys(errors), 'defineSchema', 'schemaDefToMetadata'])].sort(), [`./${profile}`]: Object.keys(engine).sort() };
    if (profile === 'sqlite') expected['./sqlite/seed'] = Object.keys(await import(pathToFileURL(join(source, 'dist/sqlite-seed.js')))).sort();
    expected['./sql'] = Object.keys(sql).sort();
    assert.deepEqual(Object.keys(manifest.exports).sort(), Object.keys(expected).sort());
    const excluded = [...new Set([...Object.keys(original.exports).filter(key => key !== '.' && !Object.hasOwn(expected, key)), './dist/index.js', './dist/cli/index.js', './package.json'])];
    writeFileSync(join(consumer, 'expected-namespaces.json'), JSON.stringify(expected));
    writeFileSync(join(consumer, 'excluded-exports.json'), JSON.stringify(excluded));
    cpSync(join(here, 'namespace.mjs'), join(consumer, 'namespace.mjs'));
    const namespaces = JSON.parse((await run(consumer, process.execPath, ['namespace.mjs'])).trim().split('\n').at(-1));
    report.results.push({ profile, productionPackages, productionLockSha256: hashFile(join(consumer, 'package-lock.json')), installedHashes, productionFiles: productionBytes, payloadBytes, namespaces });
    // Tooling is added after the production installation has been recorded.
    await run(consumer, process.execPath, [npm, 'install', '--include=dev', '--save-dev', '--no-audit', '--no-fund', '@types/node@22.20.4', ...(profile === 'd1' ? ['@cloudflare/workers-types@5.20261106.1'] : [])]);
    const negative = `import {TurbineClient,TransactionClient,generate,introspect,schemaPush,schemaDiff,turbineHttp,executePipeline} from 'turbine-orm';
// @ts-expect-error type-only PG constructor has no runtime value
new TurbineClient({},{});
// @ts-expect-error type-only transaction constructor has no runtime value
new TransactionClient({});
${['generate','introspect','schemaPush','schemaDiff','turbineHttp','executePipeline'].map(name => `// @ts-expect-error excluded runtime value is type-only\n${name}({});`).join('\n')}
${excluded.map(entry => `// @ts-expect-error excluded profile subpath\nimport 'turbine-orm/${entry.slice(2)}';`).join('\n')}
`;
    for (const ext of ['mts', 'cts']) writeFileSync(join(consumer, `negative.${ext}`), negative);
    // noUncheckedSideEffectImports ensures even missing side-effect imports are
    // diagnosed, so no @ts-expect-error is satisfied accidentally.
    await run(consumer, process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', 'false', '--noUncheckedSideEffectImports', '--module', 'NodeNext', '--target', 'ES2023', '--types', 'node', 'negative.mts', 'negative.cts']);
    for (const format of ['esm', 'cjs']) {
      const dir = join(consumer, format);
      mkdirSync(join(dir, 'generated'), { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
      if (profile === 'd1') {
        for (const [name, text] of Object.entries(generateD1Files(schema, { noTimestamp: true }))) writeFileSync(join(dir, 'generated', name), text);
        cpSync(join(source, 'src/test/fixtures/d1-generation/consumer.ts.txt'), join(dir, 'consumer.ts'));
      } else {
        const previousCwd = process.cwd();
        try {
          process.chdir(consumer);
          normalApi.generate({ schema, target: 'sqlite', exactNativeIntegers: true, outDir: join(dir, 'generated'), noTimestamp: true });
        } finally { process.chdir(previousCwd); }
        writeFileSync(join(dir, 'consumer.ts'), `import {turbine} from './generated/index.js'; import {DatabaseSync} from 'node:sqlite'; const db=turbine(new DatabaseSync(':memory:')); async function check(){ const rows=await db.users.findMany({select:{displayName:true}}); const label:string=rows[0]!.displayName;\n// @ts-expect-error projection excludes id\nrows[0]!.id;\n// @ts-expect-error generated create requirements retained\nawait db.users.create({data:{}}); return label; } void check;`);
      }
      await run(consumer, process.execPath, [tsc, '--strict', '--skipLibCheck', 'false', '--exactOptionalPropertyTypes', '--noUncheckedIndexedAccess', '--module', 'NodeNext', '--target', 'ES2023', '--types', 'node', '--outDir', dir, join(dir, 'consumer.ts')]);
    }
    cpSync(join(here, 'fixture.mjs'), join(consumer, 'fixture.mjs'));
    if (profile === 'sqlite') {
      cpSync(join(here, 'sqlite.mjs'), join(consumer, 'sqlite.mjs'));
      for (const format of ['esm', 'cjs']) {
        const output = await command(report, consumer, process.execPath, ['sqlite.mjs'], { ...env, FORMAT: format }, { scope, timeoutMs: 60_000 });
        report.results.push(JSON.parse(output.trim().split('\n').at(-1)));
      }
    } else {
      const output = await run(consumer, process.execPath, [join(here, 'native-d1.mjs'), consumer, join(root, 'native'), port]);
      report.results.push(JSON.parse(output.trim().split('\n').at(-1)));
      await run(consumer, process.execPath, [tsc, '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', 'NodeNext', '--target', 'ES2023', '--types', 'node', 'namespace-worker.ts']);
    }
    installedPayload(join(dirname(path), 'package'), join(consumer, 'node_modules/turbine-orm'));
  }
  assert.deepEqual(sourceHashes(source), identities.d1.identity.inputHashes, 'Proof changed source inputs');
  report.strict = { skipLibCheck: false, strict: true, negativeFormats: ['mts', 'cts'], generatedFormats: ['esm', 'cjs'] };
});
console.log(JSON.stringify({ success: report.success, report: join(root, 'report.json') }));
