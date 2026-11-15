import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));

function fingerprint(directory, filter) {
  const hash = createHash('sha256');
  function visit(path) {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', 'results'].includes(item.name)) continue;
      const full = join(path, item.name);
      if (item.isDirectory()) {
        if (item.name !== 'test') visit(full);
      } else if (filter(item.name)) {
        hash.update(full.slice(directory.length));
        hash.update(readFileSync(full));
      }
    }
  }
  visit(directory);
  return hash.digest('hex');
}

export function harnessFingerprint(repository = root) {
  const hash = createHash('sha256');
  hash.update(fingerprint(join(repository, 'benchmarks/evidence'), (name) => /\.(mjs|json|yaml)$/.test(name)));
  // Executable oracle and root dependency/build configuration are outside the harness directory.
  for (const name of [
    'benchmarks/equivalence.ts',
    'package.json',
    'package-lock.json',
    'tsconfig.json',
    'tsconfig.cjs.json',
  ]) {
    hash.update(name);
    hash.update(readFileSync(join(repository, name)));
  }
  return hash.digest('hex');
}

export function sourceFingerprint(repository = root) {
  return fingerprint(join(repository, 'src'), (name) => /\.(ts|cts)$/.test(name));
}
