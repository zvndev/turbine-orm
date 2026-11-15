/** Installed-package evidence for the supplied tested tarball (or a normal local pack). */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixture = process.env.TURBINE_LIBSQL_FIXTURE_DIR ?? mkdtempSync(join(tmpdir(), 'turbine-libsql-package-'));
const preserve = process.env.TURBINE_LIBSQL_PRESERVE === '1';
mkdirSync(fixture, { recursive: true });
const nativeVersion = '0.18.0';
const report = { node: process.version, client: nativeVersion, fixture, commands: [], passed: false };
let archive;
let cleanupFailure;
const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
function run(command, args, cwd = fixture, expected = 0) {
  const child = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 90_000 });
  report.commands.push({ command, args, cwd, pid: child.pid, exit: child.status, signal: child.signal });
  assert.equal(
    child.status,
    expected,
    `${command} ${args.join(' ')}\n${child.stdout}\n${child.stderr}\n${child.error ?? ''}`,
  );
  return `${child.stdout}${child.stderr}`;
}
function json(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function code(path, value) {
  writeFileSync(path, value);
}
const conditions = (entry) => ({
  import: { types: `./dist/${entry}.d.ts`, default: `./dist/${entry}.js` },
  require: { types: `./dist/cjs/${entry}.d.ts`, default: `./dist/cjs/${entry}.js` },
});
try {
  archive = process.argv[2] && resolve(process.argv[2]);
  if (!archive) {
    assert.ok(existsSync(join(repo, 'dist/libsql.js')), 'Build the library first.');
    const output = run('npm', ['pack', '--json', '--pack-destination', fixture], repo);
    const start = output.match(/^\[\r?\n\s+\{/m);
    assert.ok(start, 'npm pack JSON output is required');
    const pack = JSON.parse(output.slice(start.index));
    assert.equal(pack.length, 1);
    archive = join(fixture, pack[0].filename);
  }
  assert.ok(existsSync(archive), 'The supplied archive must exist');
  report.archive = archive;
  report.sha256 = hash(archive);
  const manifest = JSON.parse(run('tar', ['-xzOf', archive, 'package/package.json']));
  assert.deepEqual(manifest.exports['./libsql'], conditions('libsql'));
  assert.deepEqual(manifest.exports['./libsql/generate'], conditions('libsql/generate'));
  assert.deepEqual(manifest.peerDependenciesMeta['@libsql/client'], { optional: true });
  const consumer = join(fixture, 'consumer');
  mkdirSync(consumer);
  json(join(consumer, 'package.json'), { private: true, type: 'module' });
  run('npm', ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', archive], consumer);
  // Driver omission must fail at actual construction, while unrelated public entries import.
  const omitted = `
import assert from 'node:assert/strict';
import { turbineLibsql } from 'turbine-orm/libsql';
import 'turbine-orm'; import 'turbine-orm/serverless';
await assert.rejects(turbineLibsql(':memory:', { tables: {}, enums: {} }), /optional @libsql\\/client/);
console.log('omitted native peer correctly refused');
`;
  code(join(consumer, 'omitted.mjs'), omitted);
  const omission = run(process.execPath, ['omitted.mjs'], consumer);
  assert.match(omission, /correctly refused/);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `@libsql/client@${nativeVersion}`], consumer);
  const packagePath = join(consumer, 'node_modules/turbine-orm');
  const { generateLibsqlFiles } = await import(pathToFileURL(join(packagePath, 'dist/libsql/generate.js')).href);
  const { defineSchema, schemaDefToMetadata } = await import(pathToFileURL(join(packagePath, 'dist/index.js')).href);
  const schema = schemaDefToMetadata(
    defineSchema({
      users: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', notNull: true },
        enabled: { type: 'boolean', notNull: true },
        bytes: { type: 'bytea', notNull: true },
        amount: { type: 'numeric', notNull: true },
      },
      posts: {
        id: { type: 'serial', primaryKey: true },
        userId: { type: 'integer', notNull: true, references: 'users.id' },
        title: { type: 'text', notNull: true },
      },
    }),
  );
  const source = `
import assert from 'node:assert/strict';
import { turbine } from './generated/index.js';
import type { User, TurbineClient } from './generated/index.js';
async function main() {
  const db = await turbine(':memory:', { logger: {}, warnOnUnlimited: false });
  try {
    await db.rawUnsafe('CREATE TABLE admission_probe(n INTEGER)');
    await assert.rejects(db.$transaction(async tx => {
      await tx.rawUnsafe('INSERT INTO admission_probe VALUES(1)');
      await tx.rawUnsafe('\\uFEFFCOMMIT');
    }), /byte-order mark/);
    assert.deepEqual(await db.rawUnsafe('SELECT * FROM admission_probe'), []);
    const other = await turbine(':memory:', { logger: {} });
    try {
      await db.$transaction(async tx => other.$transaction(async otherTx => {
        await assert.rejects(db.rawUnsafe('SELECT 7'), /Root operations/);
        await assert.rejects(db.$transaction(async () => 1), /Root operations/);
        await assert.rejects(db.disconnect(), /Cannot disconnect/);
        assert.deepEqual(await tx.rawUnsafe('SELECT 1 AS n'), [{n:1}]);
        assert.deepEqual(await otherTx.rawUnsafe('SELECT 2 AS n'), [{n:2}]);
      }));
    } finally { await other.disconnect(); }
    await db.rawUnsafe('CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL, bytes BLOB NOT NULL, amount NUMERIC NOT NULL)');
    await db.rawUnsafe('CREATE TABLE posts(id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL)');
    const user: User = await db.users.create({ data: { id: 9007199254740993n, name: 'one', enabled: true, bytes: new Uint8Array([0, 255]), amount: 2.5 } });
    assert.deepEqual(user, { id: '9007199254740993', name: 'one', enabled: true, bytes: new Uint8Array([0, 255]), amount: 2.5 });
    await db.posts.create({ data: { id: 1, userId: 9007199254740993n, title: 'first' } });
    const bytes: Uint8Array = user.bytes;
    const amount: number | string = user.amount;
    assert.deepEqual(bytes, new Uint8Array([0, 255])); assert.equal(amount, 2.5);
    const rows = await db.users.findMany({ with: { posts: { orderBy: { id: 'asc' } } } });
    const id: number | string | undefined = rows[0]?.id;
    const title: string | undefined = rows[0]?.posts[0]?.title;
    assert.equal(id, '9007199254740993'); assert.equal(title, 'first');
    await db.$transaction(async (tx) => { await tx.users.update({ where: { id: '9007199254740993' }, data: { name: 'changed' } }); });
    const [users, count] = await db.$transaction([db.users.buildFindMany(), db.posts.buildCount()]);
    const typedName: string | undefined = users[0]?.name;
    const typedCount: number = count;
    assert.equal(typedName, 'changed'); assert.equal(typedCount, 1);
    console.log('strict generated consumer passed');
  } finally { await db.disconnect(); }
}
// This function is typechecked but never run.
function invalid(db: TurbineClient) {
  // @ts-expect-error unknown field must be rejected
  void db.users.findMany({ where: { nonexistent: 1 } });
  // @ts-expect-error invalid write type must be rejected
  void db.users.create({ data: { name: false, enabled: true } });
}
void invalid;
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
`;
  for (const format of ['esm', 'cjs']) {
    const dir = join(consumer, format);
    mkdirSync(join(dir, 'generated'), { recursive: true });
    json(join(dir, 'package.json'), { type: format === 'esm' ? 'module' : 'commonjs' });
    for (const [file, contents] of Object.entries(generateLibsqlFiles(schema, { noTimestamp: true })))
      code(join(dir, 'generated', file), contents);
    code(join(dir, 'consumer.ts'), source);
    json(join(dir, 'tsconfig.json'), {
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: false,
        outDir: './output',
        types: ['node'],
      },
      include: ['**/*.ts'],
      exclude: ['output'],
    });
    // Install only compiler ambient types. No @types/pg can mask declaration leaks.
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--save-dev',
        'typescript@6.0.3',
        '@types/node@22.20.4',
      ],
      consumer,
    );
    assert.equal(existsSync(join(consumer, 'node_modules/@types/pg')), false);
    run(join(consumer, 'node_modules/.bin/tsc'), ['-p', join(dir, 'tsconfig.json')], consumer);
    const output = run(process.execPath, [join(dir, 'output/consumer.js')], consumer);
    assert.match(output, /strict generated consumer passed/);
    console.log(`${format}: exact native generated execution passed`);
  }
  // A source guard must fail if its expected generator contract is removed.
  const generator = join(packagePath, 'dist/generate.js');
  const original = readFileSync(generator, 'utf8');
  const marker = '/** Bind this schema synchronously;';
  assert.ok(original.includes(marker), 'nonempty generator identity marker');
  code(generator, original.replace(marker, '/** Changed generator contract;'));
  try {
    code(
      join(consumer, 'generator-control.mjs'),
      `import { generateLibsqlFiles } from 'turbine-orm/libsql/generate';\nimport assert from 'node:assert/strict';\nassert.throws(() => generateLibsqlFiles(${JSON.stringify(schema)}), /generation contract changed/);\nconsole.log('generator mutation rejected');\n`,
    );
    assert.match(run(process.execPath, ['generator-control.mjs'], consumer), /mutation rejected/);
  } finally {
    code(generator, original);
  }
  // Forbid node:sqlite loading in both installed module formats. This also
  // detects an accidentally inherited declared-type probe on relation reads.
  code(
    join(consumer, 'forbid-sqlite.cjs'),
    `const Module = require('node:module'); const original = Module._load; Module._load = function(specifier, ...args) { if (specifier === 'node:sqlite') throw new Error('node:sqlite forbidden'); return original.call(this, specifier, ...args); };`,
  );
  for (const format of ['esm', 'cjs'])
    run(process.execPath, ['--require', './forbid-sqlite.cjs', join(consumer, format, 'output/consumer.js')], consumer);
  assert.equal(hash(archive), report.sha256, 'The supplied archive must remain unchanged');
  report.passed = true;
  console.log(
    JSON.stringify({
      scope: 'unchanged packed exports with installed optional native client',
      node: process.version,
      client: nativeVersion,
      fixture,
      archive,
      formats: ['esm', 'cjs'],
      omission: 'failed closed',
      generatorMutation: 'failed closed',
      nodeSqlite: 'forbidden in both consumers',
    }),
  );
} catch (error) {
  report.failure = String(error);
  throw error;
} finally {
  try {
    if (!preserve) rmSync(fixture, { recursive: true, force: true });
    report.fixtureRemoved = !existsSync(fixture);
  } catch (error) {
    cleanupFailure = error;
    report.cleanupFailure = String(error);
    report.passed = false;
  } finally {
    if (process.env.TURBINE_LIBSQL_REPORT) json(process.env.TURBINE_LIBSQL_REPORT, report);
  }
}
if (cleanupFailure) throw cleanupFailure;
