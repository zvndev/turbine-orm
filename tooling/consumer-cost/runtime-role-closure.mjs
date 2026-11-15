/** Versioned role admission and deployment boundary for the existing comparison. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { comparisonPins } from './comparison-fixtures.mjs';

export const roleSchemaVersion = 2;
export const digest = value => createHash('sha256').update(value).digest('hex');
const forbidden = new Set(['prisma', 'typescript', '@prisma/dev', 'mysql2']);
const inside = (root, path) => path === root || path.startsWith(root + sep);

export function roleManifest(arm, role, toolingLock) {
  assert.ok(['runtime', 'tooling'].includes(role), 'Unknown installation role');
  const dependencies = { ...comparisonPins.driver, ...comparisonPins.arms[arm],
    ...(arm === 'turbine' ? { 'turbine-orm': 'file:./candidate.tgz' } : {}) };
  const manifest = { name: `consumer-compare-${arm}-${role}`, private: true, type: 'module', dependencies };
  if (role === 'tooling') manifest.devDependencies = { ...comparisonPins.tools, ...(arm === 'prisma' ? { prisma: '7.10.1' } : {}) };
  // Freeze common transitive choices from the tooling lock; overrides install no roots.
  // Ambiguous versions are left to npm and must match an exact tooling identity below.
  const versions = new Map();
  for (const [path, item] of Object.entries(toolingLock?.packages ?? {})) {
    if (!path) continue;
    const name = path.split('node_modules/').at(-1);
    if (!versions.has(name)) versions.set(name, new Set());
    versions.get(name).add(item.version);
  }
  manifest.overrides = Object.fromEntries([...versions].sort().filter(([name, values]) =>
    values.size === 1 && !Object.hasOwn(dependencies, name) && !forbidden.has(name))
    .map(([name, values]) => [name, [...values][0]]));
  // adapter-pg has a runtime declaration dependency; keep its Node declarations pinned.
  manifest.overrides['@types/node'] = comparisonPins.tools['@types/node'];
  return manifest;
}

export function commonIdentity(runtime, tooling) {
  const identity = lock => Object.entries(lock.packages).filter(([p]) => p).map(([p, item]) => ({
    name: p.split('node_modules/').at(-1), version: item.version,
    integrity: item.integrity ?? null, resolved: item.resolved ?? null,
  }));
  const tools = identity(tooling);
  const result = identity(runtime);
  for (const item of result) assert.ok(tools.some(t => JSON.stringify(t) === JSON.stringify(item)),
    `Runtime/tooling transitive identity mismatch: ${item.name}@${item.version}`);
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function validateRole(arm, role, manifest, lock, toolingLock) {
  assert.deepEqual(manifest, roleManifest(arm, role, role === 'runtime' ? toolingLock : undefined), `Contaminated ${role} manifest: ${arm}`);
  assert.equal(lock.lockfileVersion, 3, 'npm lock v3 required');
  assert.equal(lock.name, manifest.name, 'Lock role/name mismatch');
  assert.equal(lock.packages[''].name, manifest.name, 'Lock root role/name mismatch');
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies'])
    assert.deepEqual(lock.packages[''][key] ?? {}, manifest[key] ?? {}, `Lock root ${key} mismatch`);
  if (role === 'runtime') for (const [path, item] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.equal(forbidden.has(path.split('node_modules/').at(-1)), false, `Runtime lock contains development tool: ${path}`);
    assert.equal(Boolean(item.dev), false, `Runtime lock contains dev dependency: ${path}`);
  }
}

export async function admitRoles(meta, locksRoot, arm) {
  assert.equal(meta.schemaVersion, roleSchemaVersion, 'Separate role locks v2 required; historical one-lock evidence is incompatible');
  const entry = meta.arms[arm]; assert.ok(entry?.roles, `Missing locked roles: ${arm}`);
  const result = {};
  for (const role of ['tooling', 'runtime']) {
    const record = entry.roles[role]; assert.equal(record?.role, role, `Missing/mismatched role: ${arm}/${role}`);
    result[role] = {};
    for (const file of ['package.json', 'package-lock.json']) {
      const bytes = await readFile(join(locksRoot, arm, role, file));
      assert.equal(digest(bytes), record[file], `Role lock hash mismatch: ${arm}/${role}/${file}`);
      result[role][file] = bytes;
    }
  }
  const tooling = JSON.parse(result.tooling['package-lock.json']);
  for (const role of ['tooling', 'runtime']) validateRole(arm, role,
    JSON.parse(result[role]['package.json']), JSON.parse(result[role]['package-lock.json']), tooling);
  assert.deepEqual(commonIdentity(JSON.parse(result.runtime['package-lock.json']), tooling), entry.commonIdentity, 'Common transitive identity changed');
  return result;
}

/** Reject path aliases, package bridges, and external symlinks before any execution. */
export async function physicalTree(root) {
  assert.equal(await realpath(root), resolve(root), `Physical installation root required: ${root}`);
  const walk = async dir => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, ent.name);
      if (ent.isSymbolicLink()) {
        assert.ok(inside(root, await realpath(path)), `Dependency resolution leak: ${path}`);
        assert.equal((await stat(path)).isDirectory(), false, `Dependency directory alias: ${path}`);
      }
      else if (ent.isDirectory()) await walk(path);
    }
  };
  await walk(root);
}

export async function payloadTree(root, allowLinks = false) {
  const files = {};
  const walk = async dir => {
    for (const ent of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, ent.name), key = relative(root, path);
      if (ent.isDirectory()) await walk(path);
      else if (ent.isFile()) { const bytes = await readFile(path); files[key] = { bytes: bytes.length, sha256: digest(bytes) }; }
      else if (allowLinks && ent.isSymbolicLink()) files[key] = { bytes: 0, symlink: await readlink(path) };
      else assert.fail(`Deployment payload must contain real files: ${path}`);
    }
  };
  await walk(root); return files;
}

export async function deployRuntime(fixture, runtimeFixture, arm, format) {
  const source = join(fixture, 'out');
  const payload = await payloadTree(source);
  const ext = format === 'esm' ? 'js' : 'cjs';
  for (const file of [`entry.${ext}`, `workload.${ext}`]) assert.ok(payload[file], `Missing emitted asset: ${file}`);
  if (arm === 'prisma') {
    assert.ok(payload['generated/index.js'], 'Missing generated Prisma entry');
    assert.ok(Object.keys(payload).some(f => f.startsWith('generated/') && f.endsWith('.wasm')), 'Missing generated Prisma WASM');
  }
  await cp(source, join(runtimeFixture, 'out'), { recursive: true, errorOnExist: true, force: false });
  assert.deepEqual(await payloadTree(join(runtimeFixture, 'out')), payload, 'Deployment payload hash mismatch');
  return payload;
}

export async function verifyRuntimePayload(project, expected) {
  await physicalTree(project);
  const actual = await payloadTree(join(project, 'node_modules'), true);
  assert.deepEqual(actual, expected, 'Runtime dependency payload changed');
  return { status: 'measured', installedPayloadSha256: digest(JSON.stringify(actual)), files: Object.keys(actual).length };
}

/** Coverage is separate from samples and fails closed on every external file URL. */
export async function importedRuntimeFiles(urls, project) {
  const { fileURLToPath } = await import('node:url');
  const modules = {};
  for (const url of urls) {
    if (!url.startsWith('file:')) continue;
    const path = fileURLToPath(url);
    assert.ok(inside(project, path) && inside(project, await realpath(path)), `Runtime import resolution leak: ${path}`);
    const bytes = await readFile(path); modules[relative(project, path)] = { bytes: bytes.length, sha256: digest(bytes) };
  }
  assert.ok(Object.keys(modules).some(p => p.startsWith('node_modules/pg/')), 'Runtime pg import missing');
  return modules;
}
