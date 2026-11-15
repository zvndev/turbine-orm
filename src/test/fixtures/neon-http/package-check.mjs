// Build first. This fixture stages package integration without editing the source manifest.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const fixture = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixture, '../../../..');
const evidence = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'turbine-neon-http-package-'));
mkdirSync(evidence, { recursive: true });
const stage = join(evidence, 'stage');
const consumer = join(evidence, 'consumer');
mkdirSync(stage);
mkdirSync(consumer);
cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
const original = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = { ...original, scripts: {}, devDependencies: {}, files: ['dist'] };
manifest.exports['./neon-http'] = {
  import: { types: './dist/neon-http.d.ts', default: './dist/neon-http.js' },
  require: { types: './dist/cjs/neon-http.d.ts', default: './dist/cjs/neon-http.js' },
};
manifest.peerDependencies = { ...manifest.peerDependencies, '@neondatabase/serverless': '^1.2.0' };
manifest.peerDependenciesMeta = { ...manifest.peerDependenciesMeta, '@neondatabase/serverless': { optional: true } };
writeFileSync(join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
const run = (program, args, cwd = consumer) =>
  execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const pack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json'], stage))[0];
assert.ok(pack.filename);
const tarball = join(stage, pack.filename);
writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
const install = run('npm', [
  'install',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  tarball,
  '@neondatabase/serverless@1.2.0',
  '@types/node@22',
]);
writeFileSync(join(evidence, 'install.log'), install);
cpSync(join(fixture, 'consumer.mjs'), join(consumer, 'consumer.mjs'));
const types = `import { neon } from '@neondatabase/serverless';
import { turbineNeonHttp, type SchemaMetadata } from 'turbine-orm/neon-http';
declare const schema: SchemaMetadata;
interface Item { id: number; label: string }
const sql = neon('postgresql://fixture_user:fixture_password@database.invalid/fixture_database');
const db = turbineNeonHttp(sql, schema);
const table = db.table<Item>('items');
const rows: Promise<{ id: number }[]> = table.findMany({ select: { id: true }, limit: 1 });
const batch: Promise<[{ count: number }, { id: number }[]]> = db.batch([
 table.buildUpdateMany({ where: { id: 7 }, data: { label: 'new' } }),
 table.buildFindMany({ select: { id: true }, limit: 1 }),
]);
// @ts-expect-error interactive callbacks are not part of the stateless transaction contract
db.$transaction(async () => 1);
void [rows, batch];
`;
writeFileSync(join(consumer, 'consumer.mts'), types);
writeFileSync(join(consumer, 'consumer.cts'), types);
writeFileSync(
  join(consumer, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2023', 'DOM'],
      strict: true,
      skipLibCheck: false,
      noEmit: true,
      types: ['node'],
    },
    include: ['consumer.mts', 'consumer.cts'],
  }),
);
const typesOutput = run(join(root, 'node_modules/.bin/tsc'), ['-p', join(consumer, 'tsconfig.json')]);
writeFileSync(
  join(evidence, 'strict-types.log'),
  typesOutput || 'Strict ESM/CJS consumers passed; skipLibCheck=false.\n',
);
const formats = ['esm', 'cjs'].map((mode) => JSON.parse(run(process.execPath, ['consumer.mjs', mode])));
const controls = [];
for (const fault of ['omit-id', 'omit-param', 'reverse-results', 'omit-batch-result']) {
  const result = spawnSync(process.execPath, ['consumer.mjs', 'esm'], {
    cwd: consumer,
    env: { ...process.env, NEON_HTTP_FAULT: fault },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0, `${fault} control must fail`);
  assert.match(result.stderr, /AssertionError|unexpected number of results/);
  writeFileSync(join(evidence, `${fault}.log`), result.stderr);
  controls.push({ fault, status: result.status });
}
const installedPackage = join(consumer, 'node_modules/turbine-orm/package.json');
const integratedManifest = readFileSync(installedPackage, 'utf8');
const noExport = JSON.parse(integratedManifest);
delete noExport.exports['./neon-http'];
writeFileSync(installedPackage, JSON.stringify(noExport));
try {
  const result = spawnSync(process.execPath, ['consumer.mjs', 'esm'], { cwd: consumer, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
  controls.push({ fault: 'missing-export', status: result.status });
  writeFileSync(join(evidence, 'missing-export.log'), result.stderr);
} finally {
  writeFileSync(installedPackage, integratedManifest);
}
const peer = join(consumer, 'node_modules/@neondatabase/serverless');
renameSync(peer, `${peer}-omitted`);
try {
  const result = spawnSync(process.execPath, ['consumer.mjs', 'cjs'], { cwd: consumer, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MODULE_NOT_FOUND/);
  controls.push({ fault: 'missing-driver', status: result.status });
  writeFileSync(join(evidence, 'missing-driver.log'), result.stderr);
} finally {
  renameSync(`${peer}-omitted`, peer);
}
const installedClient = join(consumer, 'node_modules/turbine-orm/dist/neon-http/client.js');
const guardedClient = readFileSync(installedClient, 'utf8');
// The ESM build calls refuse directly. Anchor on the specific callback-refusal method.
const refusal = /transaction\(\.\.\._args\) \{\s*return refuse\('Interactive transaction callback'\);\s*\}/;
assert.match(guardedClient, refusal);
writeFileSync(installedClient, guardedClient.replace(refusal, 'transaction(..._args) { return _args[0]?.(); }'));
try {
  const result = spawnSync(process.execPath, ['consumer.mjs', 'esm'], { cwd: consumer, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing expected exception/);
  controls.push({ fault: 'missing-callback-refusal', status: result.status });
  writeFileSync(join(evidence, 'missing-callback-refusal.log'), result.stderr);
} finally {
  writeFileSync(installedClient, guardedClient);
}
const bundle = await build({
  stdin: {
    contents:
      "import { turbineNeonHttp } from 'turbine-orm/neon-http'; import { neon } from '@neondatabase/serverless'; export { turbineNeonHttp, neon };",
    resolveDir: consumer,
    sourcefile: 'edge-consumer.mjs',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  conditions: ['edge-light', 'browser'],
  external: ['node:async_hooks'],
  metafile: true,
  format: 'esm',
});
const inputs = Object.keys(bundle.metafile.inputs);
assert.ok(inputs.some((path) => path.endsWith('/dist/neon-http.js')));
assert.ok(inputs.some((path) => path.includes('@neondatabase/serverless')));
assert.ok(!inputs.some((path) => /node_modules\/(pg|pg-pool|pg-protocol)\//.test(path)));
// This is a pure adapter/driver graph, without the test-only Node consumer imports.
writeFileSync(join(evidence, 'edge-metafile.json'), JSON.stringify(bundle.metafile, null, 2));
const identity = {
  scope: 'staged optional export and peer integration, installed packed package; intercepted fetch protocol fixture',
  sourceHead: run('git', ['rev-parse', 'HEAD'], root).trim(),
  tarball,
  sha256: createHash('sha256').update(readFileSync(tarball)).digest('hex'),
  node: process.version,
  neon: '1.2.0',
  formats,
  strictTypes: 'ESM and CJS, skipLibCheck=false',
  controls,
  edge: 'browser/edge-light bundling only, no edge runtime execution',
};
// Source identity is checked using raw bytes because formatting is part of the file.
identity.sourceManifestSha256 = createHash('sha256')
  .update(readFileSync(join(root, 'package.json')))
  .digest('hex');
writeFileSync(join(evidence, 'identity.json'), JSON.stringify(identity, null, 2));
console.log(JSON.stringify(identity, null, 2));
