/** Actual archive + optional unapplied export patch; all mutation stays in disposable fixture roots. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
assert.ok(process.argv[2], 'Supply a built actual archive.');
const archive = resolve(process.argv[2]);
const patch = process.argv[3] && resolve(process.argv[3]);
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const archiveSha256 = hash(archive);
const expectedSha256 = process.env.TURBINE_LIBSQL_INTROSPECTION_SHA256;
if (expectedSha256) {
  assert.match(expectedSha256, /^[a-f0-9]{64}$/, 'Expected archive SHA256 must be lowercase hexadecimal.');
  assert.equal(archiveSha256, expectedSha256, 'Archive SHA256 must match the tested artifact.');
  assert.equal(patch, undefined, 'Pinned installed evidence cannot apply an export overlay.');
}
const reportPath = process.env.TURBINE_LIBSQL_INTROSPECTION_REPORT;
const peer = process.env.TURBINE_LIBSQL_INTROSPECTION_PEER;
assert.ok(peer, 'Set TURBINE_LIBSQL_INTROSPECTION_PEER to an installed @libsql/client package (native prerequisite).');
const root = mkdtempSync(join(tmpdir(), 'turbine-libsql-introspection-package-'));
const report = { node: process.version, root, archive, patch, expectedSha256, commands: [], passed: false };
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const save = () => {
  if (reportPath) json(reportPath, report);
};
const active = new Map();
async function stop() {
  for (const [pid, child] of active) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await new Promise((done) => child.once('close', done));
  }
}
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, async () => {
    await stop();
    rmSync(root, { recursive: true, force: true });
    save();
    process.exit(1);
  });
async function run(command, args, cwd = root, expected = 0) {
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  active.set(child.pid, child);
  const record = { command, args, cwd, pid: child.pid, pgid: child.pid, ports: [] };
  report.commands.push(record);
  save();
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const timeout = setTimeout(() => {
    process.kill(-child.pid, 'SIGTERM');
  }, 90_000);
  let status;
  try {
    status = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => done({ code, signal }));
    });
  } finally {
    clearTimeout(timeout);
    active.delete(child.pid);
  }
  Object.assign(record, status, { processAbsent: !existsSync(`/proc/${child.pid}`) });
  save();
  assert.equal(status.code, expected, `${command} ${args.join(' ')}\n${output}`);
  return output;
}
try {
  report.sha256 = archiveSha256;
  // Extract into the fixture; the input archive is immutable throughout.
  const stage = join(root, 'stage');
  mkdirSync(stage);
  await run('tar', ['-xzf', archive, '-C', stage]);
  const packageRoot = join(stage, 'package');
  if (patch) await run('git', ['apply', patch], packageRoot);
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  assert.ok(
    manifest.exports['./libsql/introspect'],
    'Catalog export must be integrated or supplied as an unapplied patch.',
  );
  let installedArchive = archive;
  if (patch) {
    const packed = JSON.parse(
      await run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], packageRoot),
    );
    installedArchive = join(root, packed[0].filename);
    report.stagedArchiveSha256 = hash(installedArchive);
    if (process.env.TURBINE_LIBSQL_INTROSPECTION_STAGED_ARCHIVE) {
      cpSync(installedArchive, process.env.TURBINE_LIBSQL_INTROSPECTION_STAGED_ARCHIVE);
      report.stagedArchive = process.env.TURBINE_LIBSQL_INTROSPECTION_STAGED_ARCHIVE;
    }
  }
  report.installedArchive = installedArchive;
  report.installedSha256 = hash(installedArchive);
  const consumer = join(root, 'consumer');
  mkdirSync(consumer);
  json(join(consumer, 'package.json'), { private: true, type: 'module' });
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      installedArchive,
      'typescript@6.0.3',
      '@types/node@22.20.4',
    ],
    consumer,
  );
  assert.equal(existsSync(join(consumer, 'node_modules/@types/pg')), false);
  writeFileSync(
    join(consumer, 'omission.mjs'),
    `import assert from 'node:assert/strict';
import { introspectLibsql } from 'turbine-orm/libsql/introspect';
import 'turbine-orm'; import 'turbine-orm/serverless';
await assert.rejects(introspectLibsql(':memory:'), /optional @libsql\\/client/);
console.log('missing optional peer refused');`,
  );
  assert.match(await run(process.execPath, ['omission.mjs'], consumer), /missing optional peer refused/);
  mkdirSync(join(consumer, 'node_modules/@libsql'), { recursive: true });
  symlinkSync(resolve(peer), join(consumer, 'node_modules/@libsql/client'));
  const packagePath = join(consumer, 'node_modules/turbine-orm');
  const { introspectLibsql } = await import(pathToFileURL(join(packagePath, 'dist/libsql/introspect.js')));
  const { generateLibsqlFiles } = await import(pathToFileURL(join(packagePath, 'dist/libsql/generate.js')));
  const { createClient } = await import(pathToFileURL(join(resolve(peer), 'lib-esm/node.js')));
  const url = `file:${join(root, 'catalog.db')}`;
  const native = createClient({ url, intMode: 'bigint' });
  let schema;
  let prototypeSchema;
  try {
    await native.executeMultiple(readFileSync(join(repo, 'src/test/fixtures/libsql-introspection.sql'), 'utf8'));
    await native.execute(
      'CREATE TABLE prototype_rows (id INTEGER PRIMARY KEY, "__proto__" TEXT NOT NULL, constructor TEXT, toString TEXT)',
    );
    prototypeSchema = await introspectLibsql(
      { client: native, url },
      { include: ['prototype_rows'], keepColumnNames: true },
    );
    report.nativeVersion = (await native.execute('SELECT sqlite_version()')).rows[0][0];
    schema = await introspectLibsql(
      { client: native, url },
      {
        include: [
          'parents',
          'profiles',
          'partial_profiles',
          'composite_parents',
          'composite_links',
          'generated_records',
          'audit_events',
          'café_records',
        ],
        logger: {},
      },
    );
    assert.equal(native.closed, false);
  } finally {
    native.close();
  }
  const usage = `import assert from 'node:assert/strict';
import { turbine } from './generated/index.js';
import type { TurbineClient } from './generated/index.js';
import { turbine as prototypeTurbine } from './prototype-generated/index.js';
import { introspectLibsql } from 'turbine-orm/libsql/introspect';
async function main() {
 const prototypeDb = await prototypeTurbine(${JSON.stringify(url)}, { logger: {}, warnOnUnlimited: false });
 try {
  const created = await prototypeDb.prototypeRows.create({ data: { ['__proto__']: 'safe', constructor: 'ctor', toString: 'string' } });
  const selected = await prototypeDb.prototypeRows.findFirst({ where: { id: created.id, constructor: 'ctor', toString: 'string' } });
  for (const row of [created, selected]) {
   assert.ok(row);
   const value: string = row.__proto__;
   assert.equal(value, 'safe'); assert.equal(Object.hasOwn(row, '__proto__'), true);
   assert.equal(Object.getPrototypeOf(row), Object.prototype);
   assert.equal(row.constructor, 'ctor'); assert.equal(row.toString, 'string');
  }
 } finally { await prototypeDb.disconnect(); }
 const metadata = await introspectLibsql(${JSON.stringify(url)}, { include: ['parents', 'profiles'] });
 assert.equal(metadata.tables.parents!.relations.profile!.type, 'hasOne');
 const db = await turbine(${JSON.stringify(url)}, { logger: {}, warnOnUnlimited: false });
 try {
  const generated = await db.generatedRecords.create({ data: { quantity: 4 } });
  const total: number | string | null = generated.virtualTotal;
  assert.equal(total, 8);
  const parent = await db.parents.create({ data: {} });
  await db.profiles.create({ data: { parentId: parent.id, label: 'one' } });
  await db.partialProfiles.createMany({ data: [{ parentId: parent.id, active: 0 }, { parentId: parent.id, active: 0 }] });
  const rows = await db.parents.findMany({ where: { id: parent.id }, with: { profile: true, partialProfiles: true } });
  const label: string | undefined = rows[0]?.profile?.label;
  const many: number = rows[0]!.partialProfiles.length;
  assert.equal(label, 'one'); assert.equal(many, 2);
  const key = await db.compositeParents.create({ data: { tenantId: 7, code: 'a' } });
  await db.compositeLinks.create({ data: { tenantId: key.tenantId, code: key.code } });
  const composite = await db.compositeParents.findFirst({ with: { compositeLink: true } });
  const compositeCode: string | undefined = composite?.compositeLink?.code ?? undefined;
  assert.equal(compositeCode, 'a');
  const unicode = await db.caféRecords.create({ data: { "odd'column": 'quoted', naïve: 'é' } });
  const quoted: string = unicode["odd'column"]; const accent: string | null = unicode.naïve;
  assert.equal(quoted, 'quoted'); assert.equal(accent, 'é');
  const blob = await db.auditEvents.create({ data: { payload: new Uint8Array([0,255]), amount: 2.5 } });
  const bytes: Uint8Array = blob.payload; const amount: number | string | null = blob.amount;
  assert.deepEqual(bytes, new Uint8Array([0,255])); assert.equal(amount, 2.5);
  console.log('strict introspected generated native consumer passed');
 } finally { await db.disconnect(); }
}
function invalid(db: TurbineClient) {
 // @ts-expect-error required composite key
 void db.compositeParents.create({ data: { code: 'a' } });
 // @ts-expect-error non-writable virtual column
 void db.generatedRecords.create({ data: { quantity: 4, virtualTotal: 8 } });
 // @ts-expect-error non-writable stored column
 void db.generatedRecords.update({ where: { id: 1 }, data: { storedTotal: 8 } });
 // @ts-expect-error hasOne accessor is not an array
 void db.parents.findFirst({ with: { profile: true } }).then(p => p?.profile?.[0]);
 // @ts-expect-error partial unique index is not a compound selector
 void db.partialProfiles.findUnique({ where: { parentId: 1 } });
}
void invalid;
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });`;
  writeFileSync(
    join(consumer, 'forbid-sqlite.cjs'),
    `const Module = require('node:module'); const load = Module._load; Module._load = function(name, ...args) { if (name === 'node:sqlite') throw new Error('node:sqlite forbidden'); return load.call(this, name, ...args); };`,
  );
  writeFileSync(
    join(consumer, 'forbid-sqlite-loader.mjs'),
    `export function resolve(name, context, next) { if (name === 'node:sqlite') throw new Error('node:sqlite forbidden'); return next(name, context); }`,
  );
  for (const format of ['esm', 'cjs']) {
    const dir = join(consumer, format);
    mkdirSync(join(dir, 'generated'), { recursive: true });
    json(join(dir, 'package.json'), { type: format === 'esm' ? 'module' : 'commonjs' });
    for (const [name, contents] of Object.entries(generateLibsqlFiles(schema, { noTimestamp: true })))
      writeFileSync(join(dir, 'generated', name), contents);
    mkdirSync(join(dir, 'prototype-generated'));
    for (const [name, contents] of Object.entries(generateLibsqlFiles(prototypeSchema, { noTimestamp: true })))
      writeFileSync(join(dir, 'prototype-generated', name), contents);
    writeFileSync(join(dir, 'consumer.ts'), usage);
    json(join(dir, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        outDir: 'output',
        types: ['node'],
      },
      include: ['**/*.ts'],
      exclude: ['output'],
    });
    await run(process.execPath, [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', dir], consumer);
    // Prove every negative assertion is meaningful by removing its suppression.
    writeFileSync(join(dir, 'consumer.ts'), usage.replaceAll('// @ts-expect-error', '// removed negative control:'));
    const rejected = await run(
      process.execPath,
      [join(consumer, 'node_modules/typescript/bin/tsc'), '-p', dir, '--noEmit'],
      consumer,
      2,
    );
    assert.equal((rejected.match(/error TS/g) ?? []).length, 5, rejected);
    writeFileSync(join(dir, 'consumer.ts'), usage);
    // Each format uses a fresh data set while retaining the same catalog.
    const reset = createClient({ url, intMode: 'bigint' });
    try {
      await reset.executeMultiple(
        'DELETE FROM profiles; DELETE FROM partial_profiles; DELETE FROM parents; DELETE FROM composite_links; DELETE FROM composite_parents; DELETE FROM audit_events; DELETE FROM generated_records; DELETE FROM café_records;',
      );
    } finally {
      reset.close();
    }
    assert.match(
      await run(
        process.execPath,
        ['--loader', './forbid-sqlite-loader.mjs', '--require', './forbid-sqlite.cjs', join(dir, 'output/consumer.js')],
        consumer,
      ),
      /consumer passed/,
    );
  }
  assert.equal(hash(archive), report.sha256);
  report.passed = true;
  console.log(
    JSON.stringify({
      node: process.version,
      native: report.nativeVersion,
      formats: ['esm', 'cjs'],
      missingPeer: 'refused',
      strictNegativeDiagnostics: 5,
      archiveUnchanged: true,
    }),
  );
} finally {
  await stop();
  rmSync(root, { recursive: true, force: true });
  report.fixtureRemoved = !existsSync(root);
  save();
}
