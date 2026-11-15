import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { root, sha, rootDriver } from './driver.mjs';

export async function bundle(out) {
  const require = createRequire(join(root, 'package.json'));
  const { identity } = rootDriver();
  const { build } = require('esbuild');
  const locked = JSON.parse(readFileSync(join(root, 'package-lock.json'))).packages;
  assert.equal(require('esbuild/package.json').version, locked['node_modules/esbuild'].version, 'Root locked bundler required');
  const result = await build({
    absWorkingDir: root,
    stdin: { contents: "export { TurbineClient } from './src/client.ts'; export { defineSchema } from './src/schema-builder.ts'; export { schemaDefToMetadata } from './src/schema-metadata.ts';", resolveDir: root, loader: 'ts' },
    outfile: out, bundle: true, platform: 'node', format: 'esm', packages: 'external', metafile: true,
    plugins: [{ name: 'locked-root-driver', setup(b) { b.onResolve({ filter: /^(?:#pg|pg)$/ }, () => ({ path: identity.entry, external: true })); } }],
  });
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const manifest = { execution: 'branch-source-bundle', installedArtifactExecuted: false,
    head: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), path: root, status: git(['status', '--short']),
    bundleSha256: sha(out), lockSha256: sha(join(root, 'package-lock.json')), driver: identity,
    esbuild: { version: require('esbuild/package.json').version, entrySha256: sha(require.resolve('esbuild')) },
    metafile: result.metafile,
    inputs: Object.fromEntries(Object.keys(result.metafile.inputs).filter(f => f !== '<stdin>').sort().map(f => [f, sha(join(root, f))])),
  };
  writeFileSync(out + '.json', JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const require = createRequire(join(root, 'package.json'));
  try { assert.ok(process.argv[2], 'Source bundle destination required'); await bundle(process.argv[2]); }
  finally { require('esbuild').stop(); }
}
