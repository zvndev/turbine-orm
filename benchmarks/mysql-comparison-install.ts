/** Isolated, locked consumer of an explicit archive. No root manifest/lock mutation. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [artifactInput, expectedSha256] = process.argv.slice(2);
assert.ok(
  artifactInput && /^[a-f0-9]{64}$/.test(expectedSha256 ?? ''),
  'usage: exact-node24 benchmarks/mysql-comparison-install.ts ARCHIVE SHA256',
);
assert.equal(process.version, 'v24.10.0', 'baseline consumer install requires exact Node24.10.0');
const artifact = resolve(artifactInput);
const bytes = readFileSync(artifact);
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, expectedSha256, 'explicit archive hash mismatch');
const root = join(repository, 'benchmarks/node_modules/.mysql-comparison-installed');
assert.ok(!existsSync(root), `consumer already exists: ${root}; use a fresh prepared checkout`);
mkdirSync(root, { recursive: true });
const benchmark = join(root, 'benchmarks');
mkdirSync(benchmark);
mkdirSync(join(benchmark, 'prisma'));
for (const name of readdirSync(join(repository, 'benchmarks')))
  if (name.endsWith('.ts') || ['equivalence.ts', 'comparison-versions.json'].includes(name))
    copyFileSync(join(repository, 'benchmarks', name), join(benchmark, name));
copyFileSync(join(repository, 'benchmarks/prisma/mysql.prisma'), join(benchmark, 'prisma/mysql.prisma'));
mkdirSync(join(benchmark, 'mysql-preparation'));
for (const name of ['native.mjs', 'oracle.mjs', 'provenance.mjs'])
  copyFileSync(join(repository, 'benchmarks/mysql-preparation', name), join(benchmark, 'mysql-preparation', name));
const manifest = JSON.parse(readFileSync(join(repository, 'benchmarks/package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(repository, 'benchmarks/package-lock.json'), 'utf8'));
const pkg = JSON.parse(execFileSync('tar', ['-xOf', artifact, 'package/package.json'], { encoding: 'utf8' }));
assert.equal(pkg.name, 'turbine-orm');
manifest.dependencies['turbine-orm'] = `file:${artifact}`;
lock.packages[''].dependencies['turbine-orm'] = `file:${artifact}`;
delete lock.packages['..'];
lock.packages['node_modules/turbine-orm'] = {
  version: pkg.version,
  resolved: `file:${artifact}`,
  integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  dependencies: pkg.dependencies,
  bin: pkg.bin,
  engines: pkg.engines,
  peerDependencies: pkg.peerDependencies,
  peerDependenciesMeta: pkg.peerDependenciesMeta,
};
writeFileSync(join(benchmark, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(join(benchmark, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
const cache = join(root, 'cache');
const env = {
  ...process.env,
  XDG_CACHE_HOME: join(cache, 'xdg'),
  npm_config_cache: cache,
  PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
  NODE_OPTIONS: '',
};
execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: benchmark, env, stdio: 'inherit' });
execFileSync(
  process.execPath,
  [join(benchmark, 'node_modules/prisma/build/index.js'), 'generate', '--schema', 'prisma/mysql.prisma'],
  { cwd: benchmark, env, stdio: 'inherit' },
);
const identity = {
  format: 'mysql-comparison-consumer-v1',
  repository,
  root,
  benchmark,
  artifact,
  sha256,
  node: process.version,
  executable: process.execPath,
  originalLockSha256: createHash('sha256')
    .update(readFileSync(join(repository, 'benchmarks/package-lock.json')))
    .digest('hex'),
  installedLockSha256: createHash('sha256')
    .update(readFileSync(join(benchmark, 'package-lock.json')))
    .digest('hex'),
  command: [process.execPath, ...process.argv.slice(1)],
  lifecycleScripts: 'disabled; Prisma generate explicitly executed',
};
writeFileSync(join(root, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify(identity, null, 2));
