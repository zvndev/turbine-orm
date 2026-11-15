/** Engine-specific subsets of the optional package build. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, join, posix } from 'node:path';
import { hashBytes, sourceHashes, loaderFiles, optionalManifest, rewriteDist } from '../artifact-contract.mjs';

export const profiles = Object.freeze({
  d1: ['.', './d1', './sql'],
  sqlite: ['.', './sqlite', './sqlite/seed', './sql'],
  mysql: ['.', './mysql', './sql'],
  'better-sqlite3': ['.', './better-sqlite3', './sql'],
});

export function profileManifest(original, profile) {
  assert.ok(Object.hasOwn(profiles, profile), `Unknown runtime profile: ${profile}`);
  const manifest = optionalManifest(original);
  Object.assign(manifest, {
    name: `turbine-orm-${profile}-runtime-stage`,
    version: `${original.version}-runtime.0`,
    description: `Optional ${profile} runtime-only Turbine package; no CLI or PostgreSQL factory.`,
    main: './dist/cjs/profile.js', types: './dist/profile.d.ts',
    exports: Object.fromEntries(profiles[profile].map(key => [key, key === '.' ? {
      import: { types: './dist/profile.d.ts', default: './dist/profile.js' },
      require: { types: './dist/cjs/profile.d.ts', default: './dist/cjs/profile.js' },
    } : original.exports[key]])),
    files: ['dist', 'LICENSE', 'README.md'],
    peerDependencies: { pg: original.dependencies.pg },
    peerDependenciesMeta: { pg: { optional: true } },
  });
  manifest.imports['#pg'].workerd = './dist/unavailable-pg.js';
  delete manifest.bin;
  if (profile === 'mysql') mysqlManifest(manifest);
  if (profile === 'better-sqlite3') betterSqlite3Manifest(manifest);
  return manifest;
}

// These additions are fixed templates. Original compiler output is never edited
// except by the already reviewed optional-PG specifier transformation.
export function facadeFiles(profile) {
  assert.ok(Object.hasOwn(profiles, profile), `Unknown runtime profile: ${profile}`);
  const modules = [`./${profile}.js`, './errors.js'];
  const esm = modules.map(name => `export * from '${name}';`).join('\n') +
    "\nexport { defineSchema } from './schema-builder.js';\nexport { schemaDefToMetadata } from './schema-metadata.js';\n";
  const cjs = '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n' +
    modules.map(name => `Object.assign(exports, require('${name}'));`).join('\n') +
    "\nexports.defineSchema = require('./schema-builder.js').defineSchema;\nexports.schemaDefToMetadata = require('./schema-metadata.js').schemaDefToMetadata;\n";
  const types = esm + "export type * from './index.js';\n";
  return Object.fromEntries(Object.entries({
    'dist/profile.js': esm, 'dist/cjs/profile.js': cjs,
    'dist/profile.d.ts': types, 'dist/cjs/profile.d.ts': types,
  }).map(([name, text]) => [name, Buffer.from(text)]));
}

/** Derive from emitted syntax, including declaration-only and lazy edges.
 * Unknown dynamic inputs fail closed. The sole opaque edge allowed is the
 * exact reviewed optional loader's require(resolved), resolved from literal pg.
 */
export function emittedClosure(available, manifest, typescript) {
  const ts = typescript;
  const selected = new Set(), external = new Set(), edges = [];
  const pending = Object.values(manifest.exports).flatMap(value =>
    ['import', 'require'].flatMap(condition => ['types', 'default'].map(kind => value[condition][kind].slice(2))));
  function target(from, specifier) {
    if (specifier === '#pg') {
      for (const value of Object.values(manifest.imports['#pg'])) add(from, value.slice(2), specifier);
    } else if (specifier.startsWith('.')) {
      let name = posix.normalize(posix.join(posix.dirname(from), specifier));
      if (/\.d\.(?:ts|cts)$/.test(from)) name = name.replace(/\.js$/, '.d.ts').replace(/\.cjs$/, '.d.cts');
      if (manifest.name === 'turbine-orm-better-sqlite3-runtime-stage') assertBetterSqlite3HelperImport(from, name, available);
      add(from, name, specifier);
    } else {
      // A node: specifier never resolves from disk; isBuiltin alone would make
      // the answer depend on the auditing Node (node:sqlite is absent on Node 20).
      assert.ok(specifier.startsWith('node:') || isBuiltin(specifier) || specifier === 'pg' ||
        (manifest.name === 'turbine-orm-better-sqlite3-runtime-stage' && ['better-sqlite3', 'better-sqlite3/package.json'].includes(specifier)) ||
        (manifest.name === 'turbine-orm-mysql-runtime-stage' && ['mysql2', 'mysql2/promise', 'mysql2/package.json'].includes(specifier)),
        `Unreviewed external input: ${from}: ${specifier}`);
      external.add(specifier);
      edges.push({ from, external: specifier });
    }
  }
  function add(from, name, specifier) {
    assert.ok(name.startsWith('dist/') && available[name], `Missing emitted target: ${from}: ${specifier} -> ${name}`);
    pending.push(name); edges.push({ from, target: name, specifier });
  }
  while (pending.length) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    assert.ok(available[name], `Missing emitted root: ${name}`);
    selected.add(name);
    if (name.startsWith('dist/cjs/')) add(name, 'dist/cjs/package.json', 'CJS package scope');
    if (manifest.name === 'turbine-orm-mysql-runtime-stage' && mysqlHelperEdges(name, available, target, edges)) continue;
    if (manifest.name === 'turbine-orm-better-sqlite3-runtime-stage' && betterSqlite3HelperEdges(name, available, target, edges)) continue;
    if (!/\.(?:js|cjs|ts|cts)$/.test(name)) continue;
    const sf = ts.createSourceFile(name, available[name].toString(), ts.ScriptTarget.Latest, true);
    assert.equal(sf.parseDiagnostics.length, 0, `Invalid emitted syntax: ${name}`);
    const requires = new Set(['require']);
    const moduleNamespaces = new Set();
    const moduleNames = new Set(['module', 'node:module']);
    const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
    const constant = node => ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0;
    function unwrapped(node) {
      while (ts.isParenthesizedExpression(node) || (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.CommaToken && node.left.getText(sf) === '0')) {
        node = ts.isParenthesizedExpression(node) ? node.expression : node.right;
      }
      return node;
    }
    function reference(node) {
      while (node.parent && (ts.isParenthesizedExpression(node.parent) ||
          (ts.isBinaryExpression(node.parent) && node.parent.right === node &&
          node.parent.operatorToken.kind === ts.SyntaxKind.CommaToken && node.parent.left.getText(sf) === '0'))) node = node.parent;
      return node;
    }
    const factory = node => {
      node = unwrapped(node);
      return (ts.isIdentifier(node) && node.text === 'createRequire') ||
        (ts.isPropertyAccessExpression(node) && node.name.text === 'createRequire' &&
        ts.isIdentifier(node.expression) && moduleNamespaces.has(node.expression.text));
    };
    const factoryCall = node => ts.isCallExpression(node) && factory(node.expression);
    const moduleLoad = node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) &&
      requires.has(node.expression.text) && literal(node.arguments[0]) && moduleNames.has(node.arguments[0].text);
    function moduleBindings(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && literal(node.moduleSpecifier) &&
          moduleNames.has(node.moduleSpecifier.text)) {
        // This is a bounded emitted-syntax contract, not interprocedural alias analysis.
        // Unsupported aliases/namespaces/reexports must refuse before subset selection.
        const clause = ts.isImportDeclaration(node) && node.importClause;
        assert.ok(clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.every(item => item.name.text === 'createRequire' &&
            (!item.propertyName || item.propertyName.text === 'createRequire')), `Unsupported module loader import: ${name}`);
      }
      if (moduleLoad(node)) {
        const parent = node.parent;
        assert.ok(constant(parent) && parent.initializer === node, `Unsupported module loader escape: ${name}`);
        moduleNamespaces.add(parent.name.text);
      }
      ts.forEachChild(node, moduleBindings);
    }
    moduleBindings(sf);
    function aliases(node) {
      if (ts.isVariableDeclaration(node) && node.initializer && factoryCall(node.initializer)) {
        assert.ok(constant(node), `Unsupported mutable loader binding: ${name}`);
        requires.add(node.name.text);
      }
      ts.forEachChild(node, aliases);
    }
    aliases(sf);
    function visit(node) {
      if (ts.isIdentifier(node) && (requires.has(node.text) || node.text === 'createRequire' || moduleNamespaces.has(node.text))) {
        const parent = node.parent;
        const propertyName = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === node;
        const importName = ts.isImportSpecifier(parent);
        const binding = constant(parent) && parent.name === node && parent.initializer &&
          (factoryCall(parent.initializer) || moduleLoad(parent.initializer));
        if (!propertyName && !importName && !binding) {
          let value = reference(node);
          if (ts.isPropertyAccessExpression(value.parent) && value.parent.expression === value) {
            const member = value.parent.name.text;
            assert.ok(moduleNamespaces.has(node.text) ? member === 'createRequire' : requires.has(node.text) && member === 'resolve',
              `Unsupported loader member: ${name}: ${value.parent.getText(sf)}`);
            value = reference(value.parent);
          }
          assert.ok(ts.isCallExpression(value.parent) && value.parent.expression === value,
            `Unsupported loader alias or escape: ${name}: ${node.getText(sf)}`);
        }
      }
      if (factoryCall(node)) {
        const value = reference(node), parent = value.parent;
        assert.ok((constant(parent) && parent.initializer === value && requires.has(parent.name.text)) ||
          (ts.isCallExpression(parent) && parent.expression === value), `Unsupported factory loader escape: ${name}`);
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier), `Opaque module declaration: ${name}`);
        target(name, node.moduleSpecifier.text);
      }
      if (ts.isImportTypeNode(node)) {
        assert.ok(ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal), `Opaque import type: ${name}`);
        target(name, node.argument.literal.text);
      }
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        assert.ok(ts.isStringLiteral(node.moduleReference.expression), `Opaque import equals: ${name}`);
        target(name, node.moduleReference.expression.text);
      }
      if (ts.isCallExpression(node)) {
        const expr = node.expression;
        const loading = expr.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(expr) && requires.has(expr.text)) ||
          factoryCall(expr) ||
          (ts.isPropertyAccessExpression(expr) && expr.name.text === 'resolve' && ts.isIdentifier(expr.expression) && requires.has(expr.expression.text));
        if (loading) {
          const arg = node.arguments[0];
          if (literal(arg)) {
            if (moduleNames.has(arg.text)) assert.ok(moduleLoad(node) && constant(node.parent) &&
              moduleNamespaces.has(node.parent.name.text), `Unsupported dynamic module loader: ${name}`);
            target(name, arg.text);
          }
          else {
            assert.ok(['dist/optional-pg.js', 'dist/optional-pg.cjs'].includes(name) &&
              node.getText(sf) === 'require(resolved)', `Opaque dynamic input: ${name}: ${node.getText(sf)}`);
            external.add('pg');
          }
        }
      }
      // URL-based assets are inputs too, even when they are not JavaScript.
      if (ts.isNewExpression(node) && node.expression.getText(sf) === 'URL' && node.arguments?.length === 2 &&
          node.arguments[1].getText(sf) === 'import.meta.url') {
        assert.ok(ts.isStringLiteral(node.arguments[0]), `Opaque asset input: ${name}`);
        target(name, node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    for (const ref of sf.referencedFiles) target(name, `./${ref.fileName}`);
    for (const ref of sf.typeReferenceDirectives) {
      assert.equal(ref.fileName, 'node', `Unreviewed declaration reference: ${name}`);
      external.add('@types/node');
    }
  }
  return { inventory: [...selected].sort(), external: [...external].sort(), edges };
}

export function profilePayload(original, source, originalManifest, profile, originalFiles) {
  if (profile === 'mysql') assertMysqlBinding(original, source, originalFiles);
  if (profile === 'better-sqlite3') assertBetterSqlite3Binding(original, source, originalFiles);
  const manifest = profileManifest(originalManifest, profile);
  const available = Object.fromEntries(originalFiles.filter(name => name.startsWith('dist/')).map(name =>
    [name, rewriteDist(name, readFileSync(join(original, name)))]));
  for (const name of loaderFiles) available[`dist/${name}`] = readFileSync(join(source, 'tooling/optional-package', name));
  Object.assign(available, facadeFiles(profile));
  const ts = createRequire(join(source, 'package.json'))('typescript');
  const closure = emittedClosure(available, manifest, ts);
  const readme = readFileSync(join(source, `tooling/optional-package/profiles/${['mysql', 'better-sqlite3'].includes(profile) ? `${profile}-README.md` : 'README.md'}`), 'utf8').replaceAll('{{PROFILE}}', profile);
  const payload = Object.fromEntries(closure.inventory.map(name => [name, available[name]]));
  Object.assign(payload, {
    'package.json': Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    'LICENSE': readFileSync(join(original, 'LICENSE')),
    'README.md': Buffer.from(readme),
  });
  return { manifest, payload, closure };
}

/** Pinned MySQL package validation for the existing internal peer helper.
 * No loader is added or rewritten. Requalify these pins after library changes.
 */
export const mysqlDriver = '3.24.6';
export const mysqlPins = Object.freeze({
  // Exact inputs include binary provenance and native unique-selector projection.
  source: '7060b7648e8b7c59f1dbbfed4f101d817d09cb594347e3ab85d26ecb4465478c',
  dist: 'd2e424ab46ca4c9c46ac7767a3893d94b2c604037952f0b9ba9b4203eebd14ba',
  helpers: {
    'dist/optional-peer-import.cjs': '5c1ffa76fa4f35f1cbd8bf82975a59a5cd142668c3b3db0c00c7e82413281ebd',
    'dist/cjs/optional-peer-import.cjs': '4401af07cbb45d8865447bc7645beaa17a20c07b6a3bb85341cf2b312c365323',
  },
});

export function mysqlManifest(manifest) {
  manifest.dependencies = { mysql2: mysqlDriver };
  // The exact shared query/introspection graph still reaches the reviewed PG
  // loader. Keep its input declared, without installing it or exporting PG.
  assert.ok(manifest.peerDependencies.pg && manifest.peerDependenciesMeta.pg.optional);
  assert.deepEqual(Object.keys(manifest.exports), ['.', './mysql', './sql']);
}

export function assertMysqlBinding(original, source, originalFiles) {
  const inputs = Object.fromEntries(Object.entries(sourceHashes(source)).filter(([name]) =>
    !name.startsWith('tooling/optional-package/') && name !== 'scripts/build-optional-package.mjs'));
  assert.equal(hashBytes(JSON.stringify(inputs)), mysqlPins.source,
    'MySQL pinned source/build inputs changed; fresh qualification and explicit pins required');
  const dist = Object.fromEntries(originalFiles.filter(name => name.startsWith('dist/')).sort().map(name =>
    [name.slice(5), hashBytes(readFileSync(join(original, name)))]));
  assert.equal(hashBytes(JSON.stringify(dist)), mysqlPins.dist,
    'MySQL pinned normal emitted inventory/bytes changed; fresh qualification required');
}

export function mysqlHelperEdges(name, available, target, edges) {
  if (!Object.hasOwn(mysqlPins.helpers, name)) return false;
  assert.equal(hashBytes(available[name]), mysqlPins.helpers[name], 'MySQL internal peer helper changed');
  // The pinned helper's only selected runtime callers are the pinned mysql.js
  // files. They call it with the literal mysql2/promise. The unused version
  // namespace is retained byte for byte, including its fs and manifest inputs.
  target(name, 'mysql2/promise');
  target(name, 'mysql2/package.json');
  target(name, 'node:fs');
  if (name.startsWith('dist/cjs/')) target(name, '../optional-peer-import.cjs');
  else {
    assert.equal(available['optional-peer-import.cjs'], undefined,
      'Review the formerly absent ESM-location peer fallback');
    edges.push({ from: name, absentCaughtFallback: 'optional-peer-import.cjs',
      reason: 'Exact pinned helper catches missing sibling outside dist; CJS sibling is retained.' });
  }
  return true;
}

/** Finite better-sqlite3-only admission for the existing peer helper. */
export const betterSqlite3Driver = '12.11.1';
export const betterSqlite3Pins = Object.freeze({
  source: '7060b7648e8b7c59f1dbbfed4f101d817d09cb594347e3ab85d26ecb4465478c',
  dist: 'd2e424ab46ca4c9c46ac7767a3893d94b2c604037952f0b9ba9b4203eebd14ba',
  helpers: {
    'dist/optional-peer-import.cjs': '5c1ffa76fa4f35f1cbd8bf82975a59a5cd142668c3b3db0c00c7e82413281ebd',
    'dist/cjs/optional-peer-import.cjs': '4401af07cbb45d8865447bc7645beaa17a20c07b6a3bb85341cf2b312c365323',
  },
  callers: {
    'dist/better-sqlite3.js': 'a9ef2745e9282ea99d10b12ac566063042ab42813a744d0a045ca5d12279c691',
    'dist/cjs/better-sqlite3.js': 'd9842e16aa18bc1d86426b2047e8fca15e98cd6797f1809e57fdcb3eba65ad0a',
  },
});

export function betterSqlite3Manifest(manifest) {
  manifest.dependencies = { 'better-sqlite3': betterSqlite3Driver };
  assert.equal(manifest.private, true);
  assert.ok(manifest.peerDependencies.pg && manifest.peerDependenciesMeta.pg.optional);
  assert.deepEqual(Object.keys(manifest.exports), ['.', './better-sqlite3', './sql']);
}

export function assertBetterSqlite3Binding(original, source, originalFiles) {
  // All normal library/build inputs, including unselected source, are pinned.
  // Distribution tools/templates are separately bound in full by the original
  // schemaVersion 3 descriptor; they cannot contain their own content hash.
  const inputs = Object.fromEntries(Object.entries(sourceHashes(source)).filter(([name]) =>
    !name.startsWith('tooling/optional-package/') && name !== 'scripts/build-optional-package.mjs'));
  assert.equal(hashBytes(JSON.stringify(inputs)), betterSqlite3Pins.source,
    'better-sqlite3 pinned source/build inputs changed; fresh qualification and explicit pins required');
  const dist = Object.fromEntries(originalFiles.filter(name => name.startsWith('dist/')).sort().map(name =>
    [name.slice(5), hashBytes(readFileSync(join(original, name)))]));
  assert.equal(hashBytes(JSON.stringify(dist)), betterSqlite3Pins.dist,
    'better-sqlite3 pinned normal emitted inventory/bytes changed; fresh qualification required');
}

export function assertBetterSqlite3HelperImport(from, name, available) {
  if (!Object.hasOwn(betterSqlite3Pins.helpers, name)) return;
  const pin = betterSqlite3Pins.callers[from] ??
    (from === 'dist/cjs/optional-peer-import.cjs' && name === 'dist/optional-peer-import.cjs'
      ? betterSqlite3Pins.helpers[from] : undefined);
  assert.ok(pin, `Unreviewed better-sqlite3 helper caller: ${from}`);
  assert.equal(hashBytes(available[from]), pin, `better-sqlite3 literal helper caller changed: ${from}`);
}

export function betterSqlite3HelperEdges(name, available, target, edges) {
  if (!Object.hasOwn(betterSqlite3Pins.helpers, name)) return false;
  assert.equal(hashBytes(available[name]), betterSqlite3Pins.helpers[name], 'better-sqlite3 internal peer helper changed');
  // Both normal emitted callers are fixed, including their literal argument.
  // No additional caller, loader alias, or dynamic argument is qualified.
  for (const [caller, pin] of Object.entries(betterSqlite3Pins.callers)) {
    assert.ok(available[caller], `Missing better-sqlite3 literal helper caller: ${caller}`);
    assert.equal(hashBytes(available[caller]), pin, `better-sqlite3 literal helper caller changed: ${caller}`);
  }
  target(name, 'better-sqlite3');
  // Preserve the dormant version namespace and its finite fs/manifest inputs.
  target(name, 'better-sqlite3/package.json');
  target(name, 'node:fs');
  if (name.startsWith('dist/cjs/')) target(name, '../optional-peer-import.cjs');
  else {
    assert.equal(available['optional-peer-import.cjs'], undefined,
      'Review the formerly absent ESM-location peer fallback');
    edges.push({ from: name, absentCaughtFallback: 'optional-peer-import.cjs',
      reason: 'Exact pinned helper catches missing sibling outside dist; CJS sibling is retained.' });
  }
  return true;
}
