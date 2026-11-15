import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}
export function rootDriver(base = root) {
  const require = createRequire(join(base, 'package.json'));
  const entry = realpathSync(require.resolve('pg'));
  const pkg = realpathSync(require.resolve('pg/package.json'));
  const expected = realpathSync(join(base, 'node_modules/pg/package.json'));
  assert.equal(pkg, expected, 'Driver must resolve from root installation');
  const lock = JSON.parse(readFileSync(join(base, 'package-lock.json')));
  const version = JSON.parse(readFileSync(pkg)).version;
  assert.equal(version, lock.packages['node_modules/pg'].version, 'Driver must match root lock');
  const identities = Object.fromEntries(files(dirname(pkg)).map(p => [p.slice(dirname(pkg).length + 1), sha(p)]));
  const dependencies = {};
  function visit(parent, names) {
    for (const name of names) {
      const dependencyEntry = realpathSync(createRequire(parent).resolve(name));
      let dir = dirname(dependencyEntry);
      while (!readPackage(dir, name)) {
        assert.notEqual(dirname(dir), dir, 'Resolved driver dependency package required');
        dir = dirname(dir);
      }
      const p = join(dir, 'package.json');
      const key = relative(base, dir).split(sep).join('/');
      if (dependencies[key]) continue;
      const v = JSON.parse(readFileSync(p)).version;
      assert.equal(v, lock.packages[key]?.version, 'Driver dependency must match root lock');
      dependencies[key] = { entry: dependencyEntry, version: v, integrity: lock.packages[key].integrity,
        files: Object.fromEntries(files(dirname(p)).map(f => [f.slice(dirname(p).length + 1), sha(f)])) };
      visit(dependencyEntry, Object.keys(JSON.parse(readFileSync(p)).dependencies ?? {}));
    }
  }
  visit(entry, Object.keys(JSON.parse(readFileSync(pkg)).dependencies ?? {}));
  return { pg: require('pg'), identity: { entry, pkg, version, integrity: lock.packages['node_modules/pg'].integrity,
    entrySha256: sha(entry), files: identities, dependencies } };
}
function readPackage(dir, name) {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'))).name === name; } catch { return false; }
}
