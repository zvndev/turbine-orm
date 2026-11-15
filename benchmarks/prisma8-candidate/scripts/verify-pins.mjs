import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const here = fileURLToPath(new URL('../', import.meta.url));
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const json = (file) => JSON.parse(readFileSync(file, 'utf8'));
export function treeDigest(root) {
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === 'node_modules') continue;
      const name = `${prefix}${entry.name}`;
      assert.ok(!entry.isSymbolicLink(), `Mutable dependency symlink refused: ${name}`);
      if (entry.isDirectory()) walk(join(dir, entry.name), `${name}/`);
      else files.push([name, sha256(readFileSync(join(dir, entry.name)))]);
    }
  };
  walk(root);
  assert.ok(files.length, `Empty package tree: ${root}`);
  return sha256(JSON.stringify(files));
}
export function verifyRuntime(
  pin,
  actual = {
    version: process.version,
    sha256: sha256(readFileSync(process.execPath)),
    platform: process.platform,
    arch: process.arch,
  },
) {
  for (const key of ['version', 'sha256', 'platform', 'arch'])
    assert.equal(actual[key], pin[key], `Pinned runtime ${key} mismatch`);
  return { ...actual, executable: realpathSync(process.execPath), versions: process.versions };
}
export function verifyPins() {
  const pins = json(join(here, 'identity.json'));
  const runtime = verifyRuntime(pins.runtime);
  const lock = json(join(here, 'package-lock.json'));
  assert.equal(sha256(readFileSync(join(here, 'package-lock.json'))), pins.lockSha256, 'Candidate lockfile changed');
  const manifest = json(join(here, 'package.json'));
  for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/, `Nonexact direct pin: ${name}`);
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, `Manifest/lock mismatch: ${name}`);
  }
  for (const [path, item] of Object.entries(lock.packages)) {
    assert.ok(!item.link, `Linked mutable dependency: ${path}`);
    if (path) assert.ok(item.integrity?.startsWith('sha512-'), `Missing immutable integrity: ${path}`);
    assert.ok(
      !/(^|\/)node_modules\/@prisma\/client$/.test(path),
      'Prisma 7 client must not be overwritten by this candidate',
    );
  }
  for (const [name, pin] of Object.entries(pins.packages)) {
    const dir = join(here, 'node_modules', name);
    const installed = json(join(dir, 'package.json'));
    assert.equal(installed.version, pin.version, `Installed package mismatch: ${name}`);
    assert.equal(lock.packages[`node_modules/${name}`]?.integrity, pin.integrity, `Integrity drift: ${name}`);
    assert.equal(treeDigest(dir), pin.treeSha256, `Installed payload drift: ${name}`);
  }
  const facade = json(join(here, 'node_modules/@prisma/orm-postgres/package.json'));
  const cli = json(join(here, 'node_modules/prisma/package.json'));
  assert.equal(facade.dependencies.pg, '8.22.0', 'Candidate driver contract changed');
  assert.equal(cli.dependencies['@prisma/orm-toolchain'], '8.0.0-rc.23', 'CLI toolchain mismatch');
  for (const [file, pin] of Object.entries(pins.files)) {
    assert.equal(sha256(readFileSync(resolve(here, file))), pin, `Immutable fixture/helper drift: ${file}`);
  }
  for (const [file, pin] of Object.entries(json(join(here, 'canonical/manifest.json')))) {
    assert.equal(sha256(readFileSync(join(here, 'canonical', file))), pin.sha256, `Canonical copy drift: ${file}`);
    const bytes = execFileSync('git', ['show', `${pin.commit}:${pin.source}`], { cwd: here });
    assert.equal(sha256(bytes), pin.sha256, `Canonical source identity mismatch: ${file}`);
  }
  return { pins, runtime };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { pins, runtime } = verifyPins();
  console.log(
    JSON.stringify({ status: 'passed', runtime, packages: pins.packages, lockSha256: pins.lockSha256 }, null, 2),
  );
}
