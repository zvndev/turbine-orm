import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.out, '--out is required');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const source = readFileSync(values.source ?? resolve(root, 'src/sqlite.ts'), 'utf8');
// Expose real helpers only in the measurement bundle, never the public module.
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/sqlite.ts'],
  outfile: resolve(values.out),
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  metafile: true,
  plugins: [{
    name: 'sqlite-source-snapshot',
    setup(b) {
      b.onResolve({ filter: /^(?:#pg|pg)$/ }, () => ({ path: resolve(root, 'node_modules/pg/lib/index.js'), external: true }));
      b.onLoad({ filter: /\/src\/sqlite\.ts$/ }, () => ({
        contents: `${source}\nexport const __queryCost = { toNamedBinding, statementReturnsRows, resultColumnDecoders, normalizeRow, rewritePositionalPlaceholders };`,
        loader: 'ts', resolveDir: resolve(root, 'src'),
      }));
    },
  }],
});
const manifest = {
  format: 'sqlite-query-cost-bundle-v1',
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sqliteSourceSha256: hash(source),
  artifactSha256: hash(readFileSync(values.out)),
  lockSha256: hash(readFileSync(resolve(root, 'package-lock.json'))),
  esbuild: JSON.parse(readFileSync(resolve(root, 'node_modules/esbuild/package.json'))).version,
  inputs: Object.fromEntries(Object.keys(result.metafile.inputs).sort().map((file) => [file,
    file === 'src/sqlite.ts' ? hash(source) : hash(readFileSync(resolve(root, file))),
  ])),
};
writeFileSync(`${values.out}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
