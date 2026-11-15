import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(resolve(root, 'package.json'));
const { build } = req('esbuild');
const { values } = parseArgs({ options: { out: { type: 'string' } } });
assert.ok(values.out, '--out required');
const sha = b => createHash('sha256').update(b).digest('hex');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json')));
const dependencies = Object.fromEntries(['pg', 'esbuild'].map(name => {
  const entry = realpathSync(req.resolve(name));
  const pkg = req(`${name}/package.json`);
  assert.equal(pkg.version, lock.packages[`node_modules/${name}`].version, `${name} differs from root lock`);
  return [name, { entry, version: pkg.version, entrySha256: sha(readFileSync(entry)),
    packageSha256: sha(readFileSync(req.resolve(`${name}/package.json`))), integrity: lock.packages[`node_modules/${name}`].integrity }];
}));
const result = await build({
  absWorkingDir: root,
  stdin: { contents: "export { turbineSqlite } from './src/sqlite.ts'; export { defineSchema } from './src/schema-builder.ts'; export { schemaDefToMetadata } from './src/schema-metadata.ts';", resolveDir: root, loader: 'ts' },
  outfile: resolve(values.out), bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
  plugins: [{ name: 'root-driver', setup(b) {
    b.onResolve({ filter: /^(?:#pg|pg)$/ }, () => ({ path: dependencies.pg.entry, external: true }));
  } }],
});
const manifest = { format: 'sqlite-contention-bundle-v1',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  artifactSha256: sha(readFileSync(values.out)), lockSha256: sha(readFileSync(resolve(root, 'package-lock.json'))),
  dependencies, inputs: Object.fromEntries(Object.keys(result.metafile.inputs).filter(x => x !== '<stdin>').sort()
    .map(x => [x, sha(readFileSync(resolve(root, x)))])),
};
writeFileSync(`${values.out}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ artifactSha256: manifest.artifactSha256, inputs: Object.keys(manifest.inputs).length }));
