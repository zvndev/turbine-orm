/** Exact source/build/payload contract for the optional package build. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { profilePayload } from './profiles/contract.mjs';

export const loaderFiles = ['optional-pg.cjs', 'optional-pg.js', 'unavailable-pg.cjs', 'unavailable-pg.js'];
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
export const hashFile = path => hashBytes(readFileSync(path));

export function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    assert.ok(entry.isFile() || entry.isDirectory(), `Unexpected file type: ${join(root, entry.name)}`);
    const path = join(root, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }).sort();
}

export function fileHashes(root) {
  return Object.fromEntries(files(root).map(path => [relative(root, path), hashFile(path)]));
}

export function sourceHashes(source) {
  // The Studio module is recreated by prebuild; its HTML and generator are inputs.
  const inputs = files(join(source, 'src')).filter(path => {
    const name = relative(join(source, 'src'), path);
    return !name.startsWith('test/') && name !== 'cli/studio-ui.generated.ts';
  });
  for (const tree of ['types', 'skills', 'tooling/optional-package']) inputs.push(...files(join(source, tree)));
  for (const path of ['LICENSE', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json',
    'tsconfig.cjs.json', 'scripts/build-studio-ui.mjs', 'scripts/finish-cjs-build.mjs', 'scripts/build-optional-package.mjs']) {
    inputs.push(join(source, path));
  }
  return Object.fromEntries(inputs.sort().map(path => [relative(source, path), hashFile(path)]));
}

export function optionalManifest(original) {
  const manifest = structuredClone(original);
  for (const key of Object.keys(manifest)) if (key.startsWith('//')) delete manifest[key];
  Object.assign(manifest, {
    name: 'turbine-orm-optional-stage',
    version: `${original.version}-optional.0`,
    private: true,
    description: 'Optional Turbine package built from the same source with optional engine drivers.',
    dependencies: {},
    peerDependencies: { ...original.peerDependencies, pg: original.dependencies.pg },
    peerDependenciesMeta: { ...original.peerDependenciesMeta, pg: { optional: true } },
    imports: { '#pg': {
      workerd: './dist/optional-pg.js',
      'edge-light': './dist/unavailable-pg.js',
      browser: './dist/unavailable-pg.js',
      default: './dist/optional-pg.js',
    } },
  });
  delete manifest.devDependencies;
  delete manifest.scripts;
  delete manifest['lint-staged'];
  return manifest;
}

export function rewriteDist(path, bytes) {
  if (!path.endsWith('.js')) return bytes;
  const previous = bytes.toString('utf8');
  if (path.startsWith('dist/cjs/')) {
    let loader = relative(dirname(path), 'dist/optional-pg.cjs').split('\\').join('/');
    if (!loader.startsWith('.')) loader = `./${loader}`;
    return Buffer.from(previous.replace(/require\((["'])(?:pg|#pg)\1\)/g, `require(${JSON.stringify(loader)})`));
  }
  return Buffer.from(previous.replace(/(\bfrom\s+)(["'])pg\2/g, '$1\'#pg\''));
}

export function verifyPayload(original, optional, source, identity) {
  assert.equal(identity.schemaVersion, identity.profile ? 3 : 2, 'Fresh build identity required');
  assert.deepEqual(sourceHashes(source), identity.inputHashes, 'Source inputs changed or omitted');
  assert.equal(identity.build.inputSha256, hashBytes(JSON.stringify(identity.inputHashes)), 'Build/source identity mismatch');
  assert.deepEqual(fileHashes(join(source, 'dist')), identity.build.distHashes, 'Build outputs changed or omitted');
  assert.deepEqual(identity.stagedHashes, fileHashes(optional), 'Staged payload changed or omitted');
  const a = JSON.parse(readFileSync(join(original, 'package.json')));
  const current = JSON.parse(readFileSync(join(source, 'package.json')));
  assert.deepEqual(optionalManifest(a), optionalManifest(current), 'Original package contract changed');
  let expected = {};
  let rewrites = [];
  let declarations = 0;
  let dist = 0;
  for (const path of files(original)) {
    const name = relative(original, path);
    const bytes = readFileSync(path);
    if (name === 'package.json') {
      expected[name] = Buffer.from(`${JSON.stringify(optionalManifest(a), null, 2)}\n`);
    } else if (name === 'README.md') {
      assert.equal(hashFile(join(source, name)), hashBytes(bytes), `Default package drift: ${name}`);
      expected[name] = readFileSync(join(source, 'tooling/optional-package/README.md'));
    } else {
      assert.equal(hashFile(join(source, name)), hashBytes(bytes), `Default package drift: ${name}`);
      expected[name] = name.startsWith('dist/') ? rewriteDist(name, bytes) : bytes;
      if (!expected[name].equals(bytes)) rewrites.push(name);
      if (name.startsWith('dist/')) dist++;
      if (/\.d\.(?:ts|cts)$/.test(name)) declarations++;
    }
  }
  for (const name of loaderFiles) expected[`dist/${name}`] = readFileSync(join(source, 'tooling/optional-package', name));
  let profileReport = {};
  if (identity.profile) {
    const selected = profilePayload(original, source, a, identity.profile, files(original).map(path => relative(original, path)));
    expected = selected.payload;
    // The descriptor is evidence, never an authority for subset selection.
    assert.deepEqual(identity.closure, selected.closure, 'Runtime profile closure mismatch');
    rewrites = Object.keys(expected).filter(name => name.startsWith('dist/') &&
      Object.hasOwn(identity.build.distHashes, name.slice(5)) && !expected[name].equals(readFileSync(join(original, name))));
    const originalDist = selected.closure.inventory.filter(name => Object.hasOwn(identity.build.distHashes, name.slice(5)));
    declarations = originalDist.filter(name => /\.d\.(?:ts|cts)$/.test(name)).length;
    dist = originalDist.length - rewrites.length;
    profileReport = { profile: identity.profile, closure: selected.closure, exportsIdentical: false,
      selectedDefaultDistFiles: originalDist.length, profileDistFiles: selected.closure.inventory.length,
      addedDistFiles: selected.closure.inventory.filter(name => !originalDist.includes(name)) };
  }
  assert.deepEqual(files(optional).map(path => relative(optional, path)).sort(), Object.keys(expected).sort(), 'Optional payload inventory mismatch');
  for (const [name, bytes] of Object.entries(expected)) {
    assert.ok(readFileSync(join(optional, name)).equals(bytes), `Undeclared optional payload transformation: ${name}`);
  }
  assert.deepEqual([...identity.rewrites].sort(), rewrites.sort(), 'Import rewrite inventory mismatch');
  return { declarationsIdentical: declarations, defaultDistIdentical: dist, changedDist: rewrites,
    exactOptionalPayload: true, sourceInputsValidated: true, exportsIdentical: true, originalDependencyRetained: true, ...profileReport };
}
