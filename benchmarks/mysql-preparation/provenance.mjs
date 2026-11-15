import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTIFACT_SHA, DRIVER_VERSION } from './oracle.mjs';
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// Benchmarks may have their own dependency installation; all arms use the root lock.
export const require = createRequire(join(ROOT, 'package.json'));
export const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function tree(root, base = root) {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .flatMap((name) => {
        if (name === 'node_modules' || name === '.git') return [];
        const path = join(root, name);
        return statSync(path).isDirectory() ? Object.entries(tree(path, base)) : [[relative(base, path), hash(path)]];
      }),
  );
}
export function provenance(artifact, executable) {
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json')));
  const driverRoot = dirname(require.resolve('mysql2/package.json'));
  const driver = JSON.parse(readFileSync(join(driverRoot, 'package.json')));
  assert.equal(driver.version, DRIVER_VERSION, 'pinned mysql2 version');
  assert.equal(lock.packages['node_modules/mysql2'].version, DRIVER_VERSION);
  assert.equal(hash(artifact), ARTIFACT_SHA, 'immutable production artifact');
  const files = { ...tree(join(ROOT, 'src'), ROOT), ...tree(join(ROOT, 'benchmarks/mysql-preparation'), ROOT) };
  const dependencies = Object.fromEntries(
    Object.keys(lock.packages)
      .filter((n) => n && !n.includes('/node_modules/', 13))
      .map((name) => [
        name,
        { version: lock.packages[name].version, integrity: lock.packages[name].integrity ?? null },
      ]),
  );
  return {
    runtime: {
      node: process.version,
      pid: process.pid,
      executable: process.execPath,
      binarySha256: hash(process.execPath),
      versions: process.versions,
      platform: process.platform,
      arch: process.arch,
    },
    source: {
      head: git('rev-parse', 'HEAD'),
      branch: git('branch', '--show-current'),
      worktree: ROOT,
      status: git('status', '--porcelain'),
      files,
      executableSha256: hash(executable),
      oracleSha256: hash(join(ROOT, 'benchmarks/mysql-preparation/oracle.mjs')),
    },
    dependencies: {
      lockSha256: hash(join(ROOT, 'package-lock.json')),
      driver: {
        version: driver.version,
        integrity: lock.packages['node_modules/mysql2'].integrity,
        files: tree(driverRoot),
      },
      resolved: dependencies,
    },
    artifact: {
      path: resolve(artifact),
      sha256: hash(artifact),
      exercised: false,
      purpose: 'Production-byte provenance only; source is exercised by this campaign.',
    },
  };
}
