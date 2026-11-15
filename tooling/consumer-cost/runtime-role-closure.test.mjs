import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { roleManifest, roleSchemaVersion, validateRole, commonIdentity, admitRoles, digest,
  deployRuntime, payloadTree, physicalTree, verifyRuntimePayload, importedRuntimeFiles } from './runtime-role-closure.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'role-closure-'));
const save = (p, v) => writeFile(p, JSON.stringify(v));
const lockFor = manifest => ({ name: manifest.name, lockfileVersion: 3, packages: {
  '': { name: manifest.name, dependencies: manifest.dependencies, ...(manifest.devDependencies ? { devDependencies: manifest.devDependencies } : {}) },
  'node_modules/pg': { version: '8.23.1', integrity: 'sha512-frozen', resolved: 'https://registry.npmjs.org/pg/-/pg-8.23.1.tgz' },
} });

async function frozen(root) {
  const meta = { schemaVersion: roleSchemaVersion, arms: { prisma: { roles: {} } } };
  const tooling = lockFor(roleManifest('prisma', 'tooling'));
  const runtime = lockFor(roleManifest('prisma', 'runtime', tooling));
  for (const [role, lock] of [['tooling', tooling], ['runtime', runtime]]) {
    const dir = join(root, 'prisma', role); await mkdir(dir, { recursive: true });
    const manifest = roleManifest('prisma', role, role === 'runtime' ? tooling : undefined);
    const record = meta.arms.prisma.roles[role] = { role };
    for (const [file, value] of [['package.json', manifest], ['package-lock.json', lock]]) {
      await save(join(dir, file), value); record[file] = digest(await readFile(join(dir, file)));
    }
  }
  meta.arms.prisma.commonIdentity = commonIdentity(runtime, tooling);
  return meta;
}

test('role admission rejects historical identity, missing roles, changed hashes and rehashed contaminated roots', async () => {
  const root = await temp();
  try {
    const meta = await frozen(root);
    await admitRoles(meta, root, 'prisma');
    await assert.rejects(admitRoles({ ...meta, schemaVersion: 1 }, root, 'prisma'), /one-lock/);
    const missing = structuredClone(meta); delete missing.arms.prisma.roles.runtime;
    await assert.rejects(admitRoles(missing, root, 'prisma'), /role/);
    const wrongRole = structuredClone(meta); wrongRole.arms.prisma.roles.runtime.role = 'tooling';
    await assert.rejects(admitRoles(wrongRole, root, 'prisma'), /role/);
    for (const file of ['package.json', 'package-lock.json']) {
      const path = join(root, 'prisma/runtime', file), bytes = await readFile(path);
      await writeFile(path, Buffer.concat([bytes, Buffer.from(' ')]));
      await assert.rejects(admitRoles(meta, root, 'prisma'), /hash mismatch/);
      await writeFile(path, bytes);
    }
    const path = join(root, 'prisma/runtime/package.json');
    const manifest = JSON.parse(await readFile(path)); manifest.dependencies.typescript = '6.0.3';
    await save(path, manifest); meta.arms.prisma.roles.runtime['package.json'] = digest(await readFile(path));
    await assert.rejects(admitRoles(meta, root, 'prisma'), /Contaminated runtime manifest/);
    await rm(join(root, 'prisma/runtime/package-lock.json'));
    await assert.rejects(admitRoles(meta, root, 'prisma'), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime lock rejects optional development promotion and different common transitive identity', () => {
  const tools = lockFor(roleManifest('prisma', 'tooling'));
  const manifest = roleManifest('prisma', 'runtime', tools), runtime = lockFor(manifest);
  validateRole('prisma', 'runtime', manifest, runtime, tools);
  for (const name of ['prisma', 'typescript', '@prisma/dev', 'mysql2']) {
    const changed = structuredClone(runtime); changed.packages[`node_modules/${name}`] = { version: '1', devOptional: true };
    assert.throws(() => validateRole('prisma', 'runtime', manifest, changed, tools), /development tool/);
  }
  runtime.packages['node_modules/pg'].integrity = 'sha512-other';
  assert.throws(() => commonIdentity(runtime, tools), /transitive identity/);
});

test('deployment verifies real emitted and generated assets and refuses missing assets or symlink substitutes', async () => {
  const root = await temp();
  try {
    const source = join(root, 'tooling'), target = join(root, 'runtime');
    await mkdir(join(source, 'out/generated'), { recursive: true }); await mkdir(target);
    for (const [name, bytes] of [['entry.js', 'export {}'], ['workload.js', 'export {}'], ['generated/index.js', 'actual generated entry'], ['generated/query.wasm', 'wasm payload']])
      await writeFile(join(source, 'out', name), bytes);
    const payload = await deployRuntime(source, target, 'prisma', 'esm');
    assert.deepEqual(await payloadTree(join(target, 'out')), payload);
    await rm(join(target, 'out'), { recursive: true });
    for (const file of ['entry.js', 'workload.js', 'generated/index.js', 'generated/query.wasm']) {
      const path = join(source, 'out', file), bytes = await readFile(path); await rm(path);
      await assert.rejects(deployRuntime(source, target, 'prisma', 'esm'), /Missing/);
      await writeFile(path, bytes);
    }
    await rm(join(source, 'out/generated/index.js'));
    await symlink(join(source, 'out/entry.js'), join(source, 'out/generated/index.js'));
    await assert.rejects(deployRuntime(source, target, 'prisma', 'esm'), /real files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('physical roots and imported files reject tooling bridges; post-install/runtime inventory must remain unchanged', async () => {
  const root = await temp();
  try {
    const runtime = join(root, 'runtime'), tooling = join(root, 'tooling');
    for (const dir of [runtime, tooling]) await mkdir(join(dir, 'node_modules/pg'), { recursive: true });
    const runtimeFile = join(runtime, 'node_modules/pg/index.js'), toolingFile = join(tooling, 'node_modules/pg/index.js');
    await writeFile(runtimeFile, 'runtime'); await writeFile(toolingFile, 'tooling');
    const expected = await payloadTree(join(runtime, 'node_modules'), true);
    await verifyRuntimePayload(runtime, expected);
    await writeFile(join(tooling, 'node_modules/pg/tool.js'), 'independent tooling install');
    await verifyRuntimePayload(runtime, expected);
    const modules = await importedRuntimeFiles([pathToFileURL(runtimeFile).href], runtime); assert.equal(Object.keys(modules).length, 1);
    await assert.rejects(importedRuntimeFiles([pathToFileURL(runtimeFile).href, pathToFileURL(toolingFile).href], runtime), /resolution leak/);
    await writeFile(runtimeFile, 'mutated runtime');
    await assert.rejects(verifyRuntimePayload(runtime, expected), /payload changed/);
    await rm(join(runtime, 'node_modules'), { recursive: true });
    await symlink(join(tooling, 'node_modules'), join(runtime, 'node_modules'));
    await assert.rejects(physicalTree(runtime), /resolution leak/);
    await assert.rejects(importedRuntimeFiles([pathToFileURL(runtimeFile).href], runtime), /resolution leak/);
    await rm(join(runtime, 'node_modules'));
    await mkdir(join(runtime, 'shadow/pg'), { recursive: true });
    await symlink(join(runtime, 'shadow'), join(runtime, 'node_modules'));
    await assert.rejects(physicalTree(runtime), /directory alias/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
