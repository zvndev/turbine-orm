import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { fileHashes, hashBytes, loaderFiles, optionalManifest, rewriteDist, sourceHashes, verifyPayload } from './artifact-contract.mjs';
import { emittedClosure, facadeFiles, profileManifest, profilePayload } from './profiles/contract.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'optional-artifact-contract-'));
  const source = join(root, 'source'), original = join(root, 'original'), optional = join(root, 'optional');
  for (const dir of [source, original, optional]) mkdirSync(dir);
  const put = (base, name, value) => { mkdirSync(dirname(join(base, name)), { recursive: true }); writeFileSync(join(base, name), value); };
  const manifest = { name: 'turbine-orm', version: '1.0.0', type: 'module', dependencies: { pg: '^8.15.0' }, exports: {}, files: ['dist', 'skills', 'LICENSE', 'README.md'] };
  put(source, 'package.json', JSON.stringify(manifest));
  for (const name of ['package-lock.json', 'tsconfig.json', 'tsconfig.cjs.json']) put(source, name, '{}');
  for (const name of ['scripts/build-studio-ui.mjs', 'scripts/finish-cjs-build.mjs', 'scripts/build-optional-package.mjs']) put(source, name, '// fixture input');
  put(source, 'src/sql.ts', 'export const fresh = 1;');
  put(source, 'src/cli/studio-ui.html', '<p>source</p>');
  put(source, 'types/driver.d.ts', 'export {};');
  for (const [name, bytes] of Object.entries({
    'LICENSE': 'fixture license', 'README.md': 'original readme', 'skills/orm/SKILL.md': 'fixture skill',
    'dist/schema-sql.js': 'import pg from "pg"; export const value = 1;',
    'dist/cjs/schema-sql.js': 'const pg = require("pg"); exports.value = 1;',
    'dist/schema-sql.d.ts': 'export declare const value = 1;',
  })) { put(source, name, bytes); put(original, name, bytes); put(optional, name, rewriteDist(name, Buffer.from(bytes))); }
  put(original, 'package.json', JSON.stringify(manifest));
  put(optional, 'package.json', `${JSON.stringify(optionalManifest(manifest), null, 2)}\n`);
  put(source, 'tooling/optional-package/README.md', 'optional readme'); put(optional, 'README.md', 'optional readme');
  for (const name of loaderFiles) { put(source, `tooling/optional-package/${name}`, `// ${name}`); put(optional, `dist/${name}`, `// ${name}`); }
  const inputs = sourceHashes(source);
  const identity = { schemaVersion: 2, inputHashes: inputs, build: { inputSha256: hashBytes(JSON.stringify(inputs)), distHashes: fileHashes(join(source, 'dist')) },
    stagedHashes: fileHashes(optional), rewrites: ['dist/schema-sql.js', 'dist/cjs/schema-sql.js'] };
  return { root, source, original, optional, identity, put };
}

test('payload verification proves exact redirections and every loader, not a changed-name allowlist', () => {
  for (const fault of ['executable', 'missing-loader', 'changed-loader', 'extra-file', 'skill']) {
    const f = fixture();
    try {
      assert.equal(verifyPayload(f.original, f.optional, f.source, f.identity).exactOptionalPayload, true);
      if (fault === 'executable') f.put(f.optional, 'dist/schema-sql.js', readFileSync(join(f.optional, 'dist/schema-sql.js')) + '\nexport const surprise = 42;');
      if (fault === 'missing-loader') rmSync(join(f.optional, 'dist/optional-pg.cjs'));
      if (fault === 'changed-loader') f.put(f.optional, 'dist/optional-pg.cjs', 'module.exports = {};');
      if (fault === 'extra-file') f.put(f.optional, 'dist/extra.js', 'export const surprise = 42;');
      if (fault === 'skill') f.put(f.optional, 'skills/orm/SKILL.md', 'unreported skill change');
      // Even a correspondingly edited payload receipt must not legitimize a fault.
      f.identity.stagedHashes = fileHashes(f.optional);
      assert.throws(() => verifyPayload(f.original, f.optional, f.source, f.identity), /payload (?:inventory|transformation)/, fault);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('source identity covers new/deleted inputs, packed documents and the Studio generator', () => {
  for (const name of ['src/sql.ts', 'src/new.ts', 'types/driver.d.ts', 'skills/orm/SKILL.md', 'LICENSE', 'scripts/build-studio-ui.mjs']) {
    const f = fixture();
    try {
      f.put(f.source, name, 'changed input');
      assert.throws(() => verifyPayload(f.original, f.optional, f.source, f.identity), /Source inputs changed or omitted/, name);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
  const f = fixture();
  try {
    delete f.identity.inputHashes['LICENSE'];
    assert.throws(() => verifyPayload(f.original, f.optional, f.source, f.identity), /Source inputs changed or omitted/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('direct staging builds fresh source and refuses inputs that change during that build', () => {
  const f = fixture();
  try {
    // A small deterministic build command tests the actual CLI's sequencing;
    // repository compilation and tarball equality are separate integration checks.
    cpSync(join(repository, 'scripts/build-optional-package.mjs'), join(f.source, 'scripts/build-optional-package.mjs'));
    cpSync(join(repository, 'tooling/optional-package/artifact-contract.mjs'), join(f.source, 'tooling/optional-package/artifact-contract.mjs'));
    mkdirSync(join(f.source, 'tooling/optional-package/profiles'));
    cpSync(join(repository, 'tooling/optional-package/profiles/contract.mjs'), join(f.source, 'tooling/optional-package/profiles/contract.mjs'));
    const manifest = JSON.parse(readFileSync(join(f.source, 'package.json')));
    manifest.scripts = { build: 'node build.mjs' };
    writeFileSync(join(f.source, 'package.json'), JSON.stringify(manifest));
    const build = `import {readFileSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
rmSync('dist',{recursive:true,force:true});mkdirSync('dist/cjs',{recursive:true});
writeFileSync('dist/schema-sql.js','import pg from "pg";\\n'+readFileSync('src/sql.ts','utf8'));
for(let i=0;i<5;i++)writeFileSync('dist/cjs/entry'+i+'.js','const pg = require("pg");');
writeFileSync('dist/cjs/package.json','{"type":"commonjs"}');
`;
    f.put(f.source, 'build.mjs', build);
    f.put(f.source, 'src/sql.ts', 'export const fresh = 917;');
    const run = output => execFileSync(process.execPath, [join(f.source, 'scripts/build-optional-package.mjs'), '--out', output], { cwd: f.source, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const output = join(f.root, 'fresh-stage');
    run(output);
    assert.match(readFileSync(join(output, 'package/dist/schema-sql.js'), 'utf8'), /fresh = 917/);
    const identity = JSON.parse(readFileSync(join(output, 'identity.json')));
    assert.equal(identity.schemaVersion, 2);
    assert.deepEqual(identity.build.distHashes, fileHashes(join(f.source, 'dist')));
    f.put(f.source, 'build.mjs', build + "writeFileSync('src/sql.ts','export const fresh = 999;');\n");
    assert.throws(() => run(join(f.root, 'drift-stage')), /Source inputs changed during build/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('profile contract narrows runtime exports and adds only type-only root forwarding', () => {
  const original = { version: '1.0.0', dependencies: { pg: '^8.15.0' }, bin: { turbine: 'dist/cli/index.js' },
    exports: Object.fromEntries(['sqlite', 'sqlite/seed', 'd1', 'sql', 'cli'].map(name => [`./${name}`, { import: { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` }, require: { types: `./dist/cjs/${name}.d.ts`, default: `./dist/cjs/${name}.js` } }])),
  };
  for (const [profile, exports] of [['sqlite', ['.', './sqlite', './sqlite/seed', './sql']], ['d1', ['.', './d1', './sql']]]) {
    const manifest = profileManifest(original, profile);
    assert.deepEqual(Object.keys(manifest.exports), exports);
    assert.equal(manifest.private, true);
    assert.equal(manifest.bin, undefined);
    assert.deepEqual(manifest.dependencies, {});
    assert.deepEqual(manifest.peerDependencies, { pg: '^8.15.0' });
    assert.equal(manifest.imports['#pg'].workerd, './dist/unavailable-pg.js');
    const facade = facadeFiles(profile);
    assert.match(facade['dist/profile.d.ts'].toString(), /export type \* from '.\/index.js'/);
    assert.doesNotMatch(facade['dist/profile.js'].toString(), /index\.js|TurbineClient|generate|schemaPush/);
  }
  assert.throws(() => profileManifest(original, 'postgres'), /Unknown runtime profile/);
});

test('emitted closure retains runtime, declarations, literal lazy targets, conditional loaders, CJS scope and assets', () => {
  const manifest = { exports: { '.': {
    import: { types: './dist/a.d.ts', default: './dist/a.js' },
    require: { types: './dist/cjs/a.d.ts', default: './dist/cjs/a.js' },
  } }, imports: { '#pg': { workerd: './dist/edge.js', default: './dist/optional-pg.js' } } };
  const available = Object.fromEntries(Object.entries({
    'dist/a.js': "import '#pg'; import './b.js'; const req = createRequire('/'); req('node:sqlite'); import('./lazy.js'); new URL('./data.bin', import.meta.url);",
    'dist/a.d.ts': "export type { B } from './b.js'; export type Q = import('./only-types.js').Q;",
    'dist/b.js': "export const b=1;", 'dist/b.d.ts': 'export type B=number;',
    'dist/only-types.d.ts': 'export type Q=string;', 'dist/lazy.js': 'export {};', 'dist/data.bin': 'opaque bytes',
    'dist/cjs/a.js': "require('../b.js');", 'dist/cjs/a.d.ts': "export type { Q } from '../only-types.js';",
    'dist/cjs/package.json': '{"type":"commonjs"}', 'dist/edge.js': 'export {};',
    'dist/optional-pg.js': "require.resolve('pg'); require(resolved);", 'dist/unrelated.js': 'throw Error();',
  }).map(([name, value]) => [name, Buffer.from(value)]));
  const result = emittedClosure(available, manifest, ts);
  assert.deepEqual(result.inventory, Object.keys(available).filter(name => name !== 'dist/unrelated.js').sort());
  assert.deepEqual(result.external, ['node:sqlite', 'pg']);
  for (const name of ['dist/only-types.d.ts', 'dist/lazy.js', 'dist/data.bin', 'dist/edge.js', 'dist/cjs/package.json']) {
    const broken = { ...available }; delete broken[name];
    assert.throws(() => emittedClosure(broken, manifest, ts), /Missing emitted (?:target|root)/, name);
  }
  for (const code of ['import(opaque)', 'const req=createRequire("/"); req(opaque)', 'new URL(opaque, import.meta.url)']) {
    assert.throws(() => emittedClosure({ ...available, 'dist/a.js': Buffer.from(code) }, manifest, ts), /Opaque (?:dynamic|asset) input/);
  }
});

test('profile verifier independently reconstructs payload, rewrites and original declaration counts', () => {
  const f = fixture();
  try {
    symlinkSync(join(repository, 'node_modules'), join(f.source, 'node_modules'));
    const manifest = JSON.parse(readFileSync(join(f.source, 'package.json')));
    manifest.exports = Object.fromEntries(['d1', 'sql'].map(name => [`./${name}`, {
      import: { types: `./dist/${name}.d.ts`, default: `./dist/${name}.js` },
      require: { types: `./dist/cjs/${name}.d.ts`, default: `./dist/cjs/${name}.js` },
    }]));
    for (const root of [f.source, f.original]) {
      f.put(root, 'package.json', JSON.stringify(manifest));
      for (const prefix of ['dist/', 'dist/cjs/']) {
        for (const name of ['d1', 'sql', 'schema-builder', 'schema-metadata', 'errors', 'index']) {
          f.put(root, `${prefix}${name}.js`, name === 'd1' ? prefix.includes('cjs') ? 'const pg=require("pg");' : 'import pg from "#pg";' : '');
          f.put(root, `${prefix}${name}.d.ts`, '');
        }
      }
      f.put(root, 'dist/cjs/package.json', '{"type":"commonjs"}');
    }
    f.put(f.source, 'tooling/optional-package/profiles/README.md', 'Optional {{PROFILE}} package build');
    const selected = profilePayload(f.original, f.source, manifest, 'd1', Object.keys(fileHashes(f.original)));
    rmSync(f.optional, { recursive: true }); mkdirSync(f.optional);
    for (const [name, value] of Object.entries(selected.payload)) f.put(f.optional, name, value);
    const inputs = sourceHashes(f.source);
    const identity = { schemaVersion: 3, profile: 'd1', closure: selected.closure, inputHashes: inputs,
      build: { inputSha256: hashBytes(JSON.stringify(inputs)), distHashes: fileHashes(join(f.source, 'dist')) },
      stagedHashes: fileHashes(f.optional), rewrites: ['dist/cjs/d1.js'] };
    const result = verifyPayload(f.original, f.optional, f.source, identity);
    assert.equal(result.exactOptionalPayload, true);
    assert.equal(result.declarationsIdentical, 12);
    assert.equal(result.addedDistFiles.filter(name => name.includes('profile.')).length, 4);
    assert.deepEqual(result.changedDist, ['dist/cjs/d1.js']);
    for (const fault of ['dist/cjs/d1.js', 'dist/index.d.ts', 'dist/unavailable-pg.js', 'dist/profile.js']) {
      const bytes = readFileSync(join(f.optional, fault));
      rmSync(join(f.optional, fault)); identity.stagedHashes = fileHashes(f.optional);
      assert.throws(() => verifyPayload(f.original, f.optional, f.source, identity), /payload inventory mismatch/);
      f.put(f.optional, fault, Buffer.concat([bytes, Buffer.from('\n// undeclared byte change')]));
      identity.stagedHashes = fileHashes(f.optional);
      assert.throws(() => verifyPayload(f.original, f.optional, f.source, identity), /payload transformation/);
      f.put(f.optional, fault, bytes);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

const loaderManifest = { exports: { '.': {
  import: { types: './dist/main.d.ts', default: './dist/main.js' },
  require: { types: './dist/main.d.ts', default: './dist/main.js' },
} }, imports: {} };
const loaderInput = code => Object.fromEntries(Object.entries({
  'dist/main.js': code, 'dist/main.d.ts': 'export declare function run(): number;',
  'dist/lazy.cjs': 'module.exports = 83;',
}).map(([path, bytes]) => [path, Buffer.from(bytes)]));

for (const [name, code] of Object.entries({
  renamedFactory: "import {createRequire as makeRequire} from 'node:module'; const localRequire=makeRequire(import.meta.url); export const run=()=>localRequire('./lazy.cjs');",
  renamedOpaqueFactory: "import {createRequire as makeRequire} from 'node:module'; const localRequire=makeRequire(import.meta.url); export const run=()=>localRequire(process.env.TARGET);",
  transferredLoader: "import {createRequire} from 'node:module'; const localRequire=createRequire(import.meta.url); const load=localRequire; export const run=()=>load('./lazy.cjs');",
  transferredFactory: "import {createRequire} from 'node:module'; const make=createRequire; export const run=()=>make(import.meta.url)('./lazy.cjs');",
  escapedLoader: "import {createRequire} from 'node:module'; const localRequire=createRequire(import.meta.url); export const loaders={load:localRequire};",
  escapedFactoryResult: "import {createRequire} from 'node:module'; export const run=()=>createRequire(import.meta.url);",
  namespaceAlias: "import * as factory from 'node:module'; const make=factory['createRequire']; export const run=()=>make(import.meta.url)('./lazy.cjs');",
  cjsNamespaceEscape: "const factory=require('node:module'); const copy=factory; exports.run=()=>copy.createRequire(__filename)('./lazy.cjs');",
})) {
  test(`closure refuses unsupported loader alias or escape: ${name}`, () => {
    assert.throws(() => emittedClosure(loaderInput(code), loaderManifest, ts), /Unsupported .*loader/);
  });
}

test('selected direct and immediate createRequire outputs execute with their complete lazy input', () => {
  for (const code of [
    "import {createRequire} from 'node:module'; const load=createRequire(import.meta.url); export const run=()=>load('./lazy.cjs');",
    "import {createRequire} from 'node:module'; export const run=()=>createRequire(import.meta.url)('./lazy.cjs');",
  ]) {
    const root = mkdtempSync(join(tmpdir(), 'profile-loader-execution-'));
    try {
      const available = loaderInput(code);
      const selected = emittedClosure(available, loaderManifest, ts);
      assert.ok(selected.inventory.includes('dist/lazy.cjs'));
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      mkdirSync(join(root, 'dist'));
      for (const name of selected.inventory) writeFileSync(join(root, name), available[name]);
      assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', "import {run} from './dist/main.js'; console.log(run())"],
        { cwd: root, encoding: 'utf8', timeout: 10000 }).trim(), '83');
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
