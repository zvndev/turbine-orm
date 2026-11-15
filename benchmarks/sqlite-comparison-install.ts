/** Install an explicit archive using an adapted COPY of the baseline lock, never a floating npm install. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { comparisonRoot, sha256, verifyInstalledArtifact } from './sqlite-comparison-identity.js';

export function installSqliteArtifact(archive: string, expected: string, destination: string) {
  assert.equal(process.version, 'v24.10.0', 'Exact Node v24.10.0 required');
  const path = resolve(archive);
  assert.match(expected, /^[a-f0-9]{64}$/i);
  assert.equal(sha256(path), expected.toLowerCase(), 'SQLite artifact SHA256 mismatch');
  assert.ok(!existsSync(destination), 'Use a fresh installation directory');
  const benchmarkDirectory = join(comparisonRoot, 'benchmarks');
  const manifest = JSON.parse(readFileSync(join(benchmarkDirectory, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(benchmarkDirectory, 'package-lock.json'), 'utf8'));
  const packed = JSON.parse(execFileSync('tar', ['-xOzf', path, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(packed.name, 'turbine-orm');
  const specifier = `file:${path}`;
  manifest.dependencies['turbine-orm'] = specifier;
  manifest.scripts = {};
  lock.packages[''].dependencies['turbine-orm'] = specifier;
  delete lock.packages['..'];
  lock.packages['node_modules/turbine-orm'] = Object.fromEntries(
    ['version', 'license', 'dependencies', 'bin', 'engines', 'peerDependencies', 'peerDependenciesMeta']
      .filter((key) => packed[key] !== undefined)
      .map((key) => [key, packed[key]]),
  );
  Object.assign(lock.packages['node_modules/turbine-orm'], {
    resolved: specifier,
    integrity: `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`,
  });
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(destination, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  const npm = execFileSync('which', ['npm'], { encoding: 'utf8' }).trim();
  execFileSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: destination,
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}` },
    stdio: 'inherit',
    timeout: 180000,
  });
  const installedLock = JSON.parse(readFileSync(join(destination, 'node_modules/.package-lock.json'), 'utf8'));
  for (const [key, info] of Object.entries(lock.packages)) {
    const original = info as { version?: string };
    if (key.startsWith('node_modules/') && installedLock.packages[key])
      assert.equal(installedLock.packages[key].version, original.version, `Locked dependency drift: ${key}`);
  }
  const extraction = join(destination, 'archive-verification');
  mkdirSync(extraction);
  let evidence;
  try {
    evidence = verifyInstalledArtifact(path, expected, join(destination, 'node_modules/turbine-orm'), extraction);
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
  const link = join(benchmarkDirectory, 'node_modules/turbine-orm');
  assert.equal(JSON.parse(readFileSync(join(link, 'package.json'), 'utf8')).name, 'turbine-orm');
  const previous = `${link}.sqlite-previous`,
    next = `${link}.sqlite-next`;
  assert.ok(!existsSync(previous) && !existsSync(next), 'Stale SQLite installation swap');
  symlinkSync(join(destination, 'node_modules/turbine-orm'), next, 'dir');
  renameSync(link, previous);
  try {
    renameSync(next, link);
  } catch (error) {
    renameSync(previous, link);
    rmSync(next);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true });
  const identity = {
    ...evidence,
    baselineLockSha256: sha256(join(benchmarkDirectory, 'package-lock.json')),
    adaptedLock: join(destination, 'package-lock.json'),
    adaptedLockSha256: sha256(join(destination, 'package-lock.json')),
    node: process.version,
    executable: process.execPath,
    baselineDependencyVersionsPreserved: true,
  };
  writeFileSync(join(destination, 'installation.json'), `${JSON.stringify(identity, null, 2)}\n`);
  return identity;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 5, 'usage: sqlite-comparison-install.ts ARCHIVE SHA256 NEW_DIRECTORY');
  console.log(JSON.stringify(installSqliteArtifact(process.argv[2]!, process.argv[3]!, resolve(process.argv[4]!))));
}
