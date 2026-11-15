/** Final admission reads independent pinned inputs, never just two matching declarations. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ComparisonFinalManifest, Engine } from './comparison-results.js';

export const inputHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
export function inputTree(root: string, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry): [string, string][] => {
        if (['node_modules', '.git'].includes(entry.name)) return [];
        const path = join(root, entry.name),
          key = prefix + entry.name;
        assert.ok(!entry.isSymbolicLink(), `Mutable input symlink: ${path}`);
        return entry.isDirectory() ? Object.entries(inputTree(path, key + '/')) : [[key, inputHash(path)]];
      }),
  );
}
export function verifyInputTree(root: string, expected: Record<string, string>, prefix = '') {
  assert.deepEqual(inputTree(root, prefix), expected, `Complete actual input tree ${root}`);
}

/** Complete input superset, including unused files; this is not a loaded-module trace. */
export function runtimeInventory(root: string, executable: string) {
  const files: Record<string, string> = {},
    visited = new Set<string>();
  function visit(path: string) {
    const actual = realpathSync(path);
    if (visited.has(actual)) return;
    visited.add(actual);
    if (statSync(actual).isDirectory()) for (const name of readdirSync(actual).sort()) visit(join(actual, name));
    else files[actual] = inputHash(actual);
  }
  visit(root);
  visit(executable);
  const linked = execFileSync('ldd', [executable], { encoding: 'utf8' });
  for (const match of linked.matchAll(/\/[^\s()]+/g)) visit(match[0]);
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    root: realpathSync(root),
    files: sorted,
    sha256: createHash('sha256').update(JSON.stringify(sorted)).digest('hex'),
  };
}
export function verifyRuntimeInventory(
  root: string,
  executable: string,
  expected: { files: Record<string, string>; sha256: string },
) {
  const actual = runtimeInventory(root, executable);
  assert.deepEqual(actual.files, expected.files, 'Complete actual runtime inventory');
  assert.equal(actual.sha256, expected.sha256, 'Runtime inventory digest');
}

export function assertFrozenInventory(expected: ComparisonFinalManifest, engine: Engine) {
  const locations = expected.inventory;
  assert.ok(locations, 'Independent repository and installed benchmark roots are required');
  for (const path of [locations.repository, locations.benchmark])
    assert.equal(realpathSync(path), resolve(path), 'Frozen inventory roots must be canonical');
  const { repository, benchmark } = locations;
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), expected.head);
  assert.equal(
    execFileSync('git', ['status', '--porcelain'], {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    }).trim(),
    '',
    'Final input source must be clean',
  );
  if (engine === 'mysql') {
    const e = expected as import('./comparison-results.js').MysqlFinalManifest;
    verifyInputTree(join(repository, 'src'), e.hashes.source, 'src/');
    assert.deepEqual(inputTree(e.artifact.packageRoot), e.artifact.payload, 'Complete installed Turbine tree');
    for (const item of Object.values(e.packages)) verifyInputTree(item.root, item.files);
    for (const [group, directory] of [
      ['turbineGenerated', 'generated/turbine-mysql'],
      ['prismaGenerated', 'generated/prisma-mysql'],
    ] as const)
      assert.deepEqual(inputTree(join(benchmark, directory), directory + '/'), e.hashes[group], `Complete ${group}`);
    for (const [path, hash] of Object.entries(e.hashes.benchmark))
      assert.equal(inputHash(join(repository, path)), hash, `Pinned benchmark input ${path}`);
    assert.equal(inputHash(join(repository, 'package-lock.json')), e.hashes.rootLock);
    assert.equal(inputHash(join(repository, 'benchmarks/package-lock.json')), e.hashes.benchmarkLock);
  } else {
    const e = expected as import('./comparison-results.js').SqliteFinalManifest;
    for (const [path, tree] of [
      [join(repository, 'src'), e.source],
      [join(repository, 'dist'), e.localDist],
      [join(benchmark, 'generated'), e.generated],
    ] as const)
      verifyInputTree(path, tree.files);
    assert.deepEqual(
      inputTree(e.artifact.installedPackageRoot),
      e.artifact.installedFiles,
      'Complete installed SQLite archive',
    );
    for (const [name, item] of Object.entries(e.dependencies)) {
      assert.ok(item.root, `Independent ${name} root missing`);
      verifyInputTree(item.root, item.files);
    }
    for (const [path, hash] of Object.entries(e.hashes))
      assert.equal(inputHash(join(repository, path)), hash, `Frozen SQLite input ${path}`);
  }
  const runtime =
    engine === 'mysql'
      ? (expected as import('./comparison-results.js').MysqlFinalManifest).runtime.executable
      : (expected as import('./comparison-results.js').SqliteFinalManifest).node.executable;
  assert.ok(expected.runtimeClosure, 'Independent complete runtime inventory missing');
  verifyRuntimeInventory(benchmark, runtime, expected.runtimeClosure);
}
