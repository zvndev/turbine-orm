#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, sha256 } from '../lifecycle-examples/harness.mjs';
import { ownedMysql } from '../lifecycle-examples/mysql-service.mjs';
import { files, installedPayload, pinnedArchive } from '../native-consumer-contracts/harness.mjs';
import { compilerDiagnostics } from './compiler-refusals.mjs';
import { application, ddl, expectedRows, modes, mssqlFixture, negativeStatements, negativeCodes, typeControls } from './corpus.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  assert.ok(['--tarball', '--sha256', '--exact-node', '--out', '--engine'].includes(process.argv[i]), `Unknown option ${process.argv[i]}`);
  assert.ok(process.argv[i + 1] && !process.argv[i + 1].startsWith('--'), `${process.argv[i]} requires a value`);
  assert.equal(args[process.argv[i]], undefined, 'Duplicate option');
  args[process.argv[i]] = process.argv[i + 1];
}
assert.ok(args['--out'], '--out is required');
const out = resolve(args['--out']);
assert.equal(existsSync(out), false, '--out must be new');
mkdirSync(out, { recursive: true });
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const report = { node: process.version, runtime: process.versions, steps: [], services: [], cases: [], controls: [], cleanup: {}, passed: false,
  limits: ['MSSQL declarations only; native MSSQL pending.', 'This harness exercises the programmatic generator; CLI/config has separate command coverage.', 'SQLite compatible exact-int64 driver, integer storage only; no declared-width or arbitrary dynamic storage guarantee.', 'No parser/coercion changes.'] };
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, NODE_OPTIONS: '', NODE_PATH: '', DATABASE_URL: '', TZ: 'UTC' };
let root;
const stops = new Set();
let interrupted;
const onSignal = (signal) => { interrupted = signal; };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
const run = (cwd, binary, argv, childEnv = env, expected = 0) => {
  assert.ok(!interrupted, `Interrupted by ${interrupted}`);
  return command(report, root, cwd, binary, argv, childEnv, expected);
};
const portClosed = (port) => new Promise((resolve, reject) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); reject(new Error(`Owned port ${port} still open`)); });
  socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve(true) : reject(error));
  socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Port check timeout')); });
});
async function refusal(label, fn, pattern) {
  let message;
  try { await fn(); } catch (error) { message = error.message; }
  assert.ok(message, `${label}: unexpectedly accepted`);
  assert.match(message, pattern);
  report.controls.push({ label, message });
}
try {
  assert.ok(args['--exact-node'], '--exact-node is required');
  assert.equal(process.versions.node, args['--exact-node'], 'Exact Node version mismatch');
  const engine = args['--engine'] ?? 'all';
  assert.ok(['all', 'sqlite', 'mysql', 'fixtures'].includes(engine), 'Unsupported engine');
  if (engine === 'all' || engine === 'sqlite') {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const probe = new DatabaseSync(':memory:');
    try { assert.equal(typeof probe.prepare('SELECT 1').columns, 'function', 'node:sqlite declared-type support required'); }
    finally { probe.close(); }
  }
  if (engine === 'all' || engine === 'mysql') {
    assert.ok(env.MYSQL_BASEDIR, 'MYSQL_BASEDIR is required; no external service borrowed');
    assert.ok(existsSync(join(env.MYSQL_BASEDIR, 'bin/mysqld')), 'Native MySQL binary required');
  }
  assert.ok(args['--sha256'], '--sha256 is required');
  report.artifact = pinnedArchive(args['--tarball'], args['--sha256']);
  root = mkdtempSync(join(tmpdir(), 'turbine-native-integer-'));
  report.applicationRoot = root;
  save(join(root, 'package.json'), { private: true, type: 'module' });
  run(root, 'npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact',
    report.artifact.path, 'typescript@6.0.3', '@types/node@22.20.4', 'mysql2@3.24.5']);
  const pkg = join(root, 'node_modules/turbine-orm');
  report.archivePayload = {};
  // Compare the actual installed package to an independently extracted archive.
  const archiveDir = join(root, 'archive');
  mkdirSync(archiveDir);
  run(root, 'tar', ['-xzf', report.artifact.path, '-C', archiveDir]);
  report.archivePayload = files(join(archiveDir, 'package'));
  report.installedPayloadHash = installedPayload(root, report.archivePayload);
  report.dependencies = {};
  for (const name of ['turbine-orm', 'typescript', '@types/node', 'mysql2']) {
    report.dependencies[name] = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'))).version;
  }
  cpSync(join(root, 'package-lock.json'), join(out, 'package-lock.json'));
  report.lockHash = sha256(readFileSync(join(out, 'package-lock.json')));
  const imported = await import(pathToFileURL(join(pkg, 'dist/index.js')));
  const { generate } = imported;
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  const compile = (dir, expected = 0, config = 'tsconfig.json') => run(dir, process.execPath, [tsc, '-p', config], env, expected);
  function generated(dir, schema, target, extra = {}) {
    const prior = process.cwd();
    process.chdir(dir);
    try { return generate({ schema, target, exactNativeIntegers: true, noTimestamp: true, importExtension: 'js', outDir: './generated', ...extra }); }
    finally { process.chdir(prior); }
  }
  function project(name, schema, target, format) {
    const dir = join(root, name);
    mkdirSync(dir);
    save(join(dir, 'package.json'), { private: true, type: format });
    save(join(dir, 'tsconfig.json'), { compilerOptions: { target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext',
      strict: true, exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true, skipLibCheck: false, types: ['node'], outDir: 'build' }, include: ['app.ts', 'generated/**/*.ts'] });
    save(join(dir, 'tsconfig.invalid.json'), { extends: './tsconfig.json', compilerOptions: { noEmit: true }, include: ['invalid.ts', 'generated/**/*.ts'] });
    generated(dir, schema, target);
    const first = files(join(dir, 'generated'));
    assert.ok(Object.keys(first).length === 3);
    generated(dir, schema, target);
    assert.deepEqual(files(join(dir, 'generated')), first, 'Reproducible generation required');
    return dir;
  }
  function typecheck(dir) {
    const controls = typeControls();
    writeFileSync(join(dir, 'invalid.ts'), controls);
    compile(dir, 0, 'tsconfig.invalid.json');
    writeFileSync(join(dir, 'invalid.ts'), controls.replaceAll('// @ts-expect-error intentional refusal', ''));
    const failed = compile(dir, 2, 'tsconfig.invalid.json');
    compilerDiagnostics(failed.output, controls, negativeStatements, negativeCodes);
    report.controls.push({ label: `${dir.split('/').at(-1)} compiler refusals`, count: negativeStatements.length });
  }
  function overrideControls(schema, target, format, scope = target) {
    const dir = project(`override-${scope}-${format}`, schema, target, format);
    generated(dir, schema, target, { columnTypes: { 'samples.value': 'string', 'samples.optional': 'bigint' } });
    const negatives = [
      'const invalidRead: number = value;',
      'const invalidCreate: SampleCreate = { id: 1, parentId: 1, value: 1n, tiny: 7 };',
      'const invalidUpdate: SampleUpdate = { value: { set: 1n } };',
      'const invalidOptional: Sample["optional"] = "1";',
    ];
    const source = `import type { Sample, SampleCreate, SampleUpdate } from './generated/types.js';
const value: Sample['value'] = '9007199254740993';
const nullable: Sample['optional'] = null;
const optional: Sample['optional'] = 1n;
const create: SampleCreate = { id: 1, parentId: 1n, value, optional, tiny: 7 };
const update: SampleUpdate = { value: { set: value }, optional: { set: optional } };
void nullable; void create; void update;
${negatives.map((line) => '// @ts-expect-error override refusal\n' + line).join('\n')}
`;
    writeFileSync(join(dir, 'invalid.ts'), source);
    compile(dir, 0, 'tsconfig.invalid.json');
    writeFileSync(join(dir, 'invalid.ts'), source.replaceAll('// @ts-expect-error override refusal', ''));
    compilerDiagnostics(compile(dir, 2, 'tsconfig.invalid.json').output, source, negatives, negatives.map(() => 2322));
    cpSync(dir, join(out, `override-${scope}-${format}`), { recursive: true });
    report.controls.push({ label: `override-${scope}-${format}`, count: negatives.length });
  }
  const nativeSql = (engine) => `SELECT id, CAST(parent_id AS ${engine === 'mysql' ? 'CHAR' : 'TEXT'}) AS parent_id,
    CAST(value AS ${engine === 'mysql' ? 'CHAR' : 'TEXT'}) AS value, CAST(optional AS ${engine === 'mysql' ? 'CHAR' : 'TEXT'}) AS optional,
    CAST(tiny AS ${engine === 'mysql' ? 'CHAR' : 'TEXT'}) AS tiny, CAST(computed AS ${engine === 'mysql' ? 'CHAR' : 'TEXT'}) AS computed FROM samples ORDER BY id`;
  async function exercise(name, schema, target, url, query) {
    for (const format of ['module', 'commonjs']) {
      const dir = project(`${name}-${format}`, schema, target, format);
      try {
        writeFileSync(join(dir, 'app.ts'), application(target));
        compile(dir);
        typecheck(dir);
        run(dir, process.execPath, ['build/app.js'], { ...env, INTEGER_DATABASE: url, INTEGER_SQL_MODE: name === 'mysql-0' ? modes[0] : modes[1] });
        if (target === 'mysql') {
          const unsigned = await query('SELECT CAST(value AS CHAR) AS value FROM unsigned_samples');
          assert.deepEqual(JSON.parse(JSON.stringify(unsigned)), [{ value: '18446744073709551615' }]);
          save(join(dir, 'unsigned-oracle.json'), unsigned);
        }
        const observed = JSON.parse(readFileSync(join(dir, 'observed.json')));
        assert.equal(observed.length, 11);
        const sql = nativeSql(target);
        const native = await query(sql);
        assert.deepEqual(JSON.parse(JSON.stringify(native)), expectedRows(target), 'Independent exact native storage oracle');
        // Prove the oracle refuses precision loss, even if a program exits zero.
        const rounded = structuredClone(native);
        rounded[0].value = String(Number(rounded[0].value));
        await refusal(`${name}/${format} rounded oracle`, () => assert.deepEqual(rounded, expectedRows(target)), /Expected values/);
        save(join(dir, 'native-oracle.json'), { sql, native });
        report.cases.push({ name, target, format, passed: true, generatedHashes: files(join(dir, 'generated')) });
      } finally {
        cpSync(dir, join(out, `${name}-${format}`), { recursive: true });
      }
      overrideControls(schema, target, format, name);
      await query('DELETE FROM samples');
      await query('DELETE FROM parents');
      if (target === 'mysql') await query('DELETE FROM unsigned_samples');
    }
  }
  if (engine === 'all' || engine === 'sqlite') {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
    const sqlite = await import(pathToFileURL(join(pkg, 'dist/sqlite.js')));
    const filename = join(root, 'integers.sqlite');
    report.sqlite = { filename, version: null };
    const handle = new DatabaseSync(filename);
    try {
      report.sqlite.version = handle.prepare('SELECT sqlite_version() AS v').get().v;
      handle.exec('PRAGMA foreign_keys=ON');
      for (const sql of ddl('sqlite')) handle.exec(sql);
      const schema = sqlite.introspectSqliteDatabase(handle);
      save(join(out, 'sqlite-metadata.json'), schema);
      await exercise('sqlite', schema, 'sqlite', filename, async (sql) => {
        const stmt = handle.prepare(sql);
        if (/^SELECT/.test(sql)) return stmt.all().map((row) => ({ ...row }));
        return stmt.run();
      });
      // SQLite width declarations do not enforce narrow ranges, nor integer storage.
      handle.exec("INSERT INTO parents VALUES (1, 'dynamic')");
      handle.exec("INSERT INTO samples(id,parent_id,value,tiny) VALUES (1,1,'text storage',1)");
      assert.equal(handle.prepare('SELECT typeof(value) AS kind FROM samples').get().kind, 'text');
      report.controls.push({ label: 'SQLite permits text in BIGINT; declaration is not a storage constraint' });
      if (report.node === 'v22.16.0' || report.node === 'v24.10.0') {
        const native = handle.prepare('SELECT 9223372036854775807 AS n');
        await refusal('node:sqlite default driver mode refuses int64 rather than silently rounding', () => native.get(), /too large|safe integer|out of range/i);
      }
    } finally { handle.close(); report.sqlite.closed = true; }
  }
  if (engine === 'all' || engine === 'mysql') {
    const driver = createRequire(join(root, 'package.json'))('mysql2/promise');
    const mysql = await import(pathToFileURL(join(pkg, 'dist/mysql.js')));
    for (const [i, mode] of modes.entries()) {
      const serviceRoot = join(root, `mysql-${i}`);
      mkdirSync(serviceRoot);
      let service;
      try {
        service = await ownedMysql({ root: serviceRoot, mode, env, driver, report,
          run: (cwd, binary, argv, childEnv) => run(cwd, binary, argv, childEnv), registerStop: (stop) => stops.add(stop) });
        assert.equal(report.services.at(-1).version, '8.4.0', 'Exact native MySQL version required');
        await service.admin.query('CREATE DATABASE integer_types');
        const native = await service.connect('integer_types');
        for (const sql of ddl('mysql')) await native.query(sql);
        const url = `mysql://root@127.0.0.1:${service.port}/integer_types`;
        const schema = await mysql.introspectMysql({ connectionString: url, schema: 'integer_types', logger: {} });
        save(join(out, `mysql-${i}-metadata.json`), schema);
        await exercise(`mysql-${i}`, schema, 'mysql', url, async (sql) => (await native.query(sql))[0]);
      } finally { if (service) await service.stop(); }
    }
  }
  // Both module formats compile against the real packed SQL Server declarations.
  // No SQL Server connection is opened or fixture treated as live certification.
  for (const format of ['module', 'commonjs']) {
    const dir = project(`mssql-fixture-${format}`, mssqlFixture(), 'mssql', format);
    typecheck(dir);
    overrideControls(mssqlFixture(), 'mssql', format);
    cpSync(dir, join(out, `mssql-fixture-${format}`), { recursive: true });
    report.cases.push({ name: `mssql-fixture-${format}`, native: false, status: 'declarations pass; native pending' });
  }
  // A real generated graph and actual accessor calls, not merely a type alias.
  const scale = mssqlFixture();
  scale.tables = {};
  const template = mssqlFixture().tables;
  for (let i = 0; i < 128; i++) {
    const name = `records${i}`;
    const next = `records${(i + 1) % 128}`;
    scale.tables[name] = { ...structuredClone(template.samples), name, relations: {
      parent: { type: 'belongsTo', name: 'parent', from: name, to: next, foreignKey: 'parent_id', referenceKey: 'id' },
    } };
  }
  const scaleDir = project('type-scale', scale, 'mssql', 'module');
  writeFileSync(join(scaleDir, 'app.ts'), `import type { TurbineClient } from './generated/index.js';\ndeclare const db: TurbineClient;\n` +
    Array.from({ length: 128 }, (_, i) => `async function use${i}() { const rows = await db.records${i}.findMany({ where: { value: '9007199254740993', parent: { value: '1' } }, select: { value: true }, with: { parent: { select: { value: true } } } }); const v: number | string | undefined = rows[0]?.parent?.value; return v; }`).join('\n'));
  run(scaleDir, process.execPath, [tsc, '-p', 'tsconfig.json', '--extendedDiagnostics']);
  cpSync(scaleDir, join(out, 'type-scale'), { recursive: true });
  report.cases.push({ name: 'type-scale', tables: 128, calls: 128, passed: true });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const stop of stops) { try { await stop(); } catch (error) { cleanupErrors.push(error.stack); } }
  // Stop-owned PIDs and ports checked independently from helper status flags.
  for (const identity of report.services) {
    try {
      let alive = false;
      try { process.kill(identity.pid, 0); alive = true; } catch (error) { assert.equal(error.code, 'ESRCH'); }
      assert.equal(alive, false, 'Owned MySQL PID survived');
      await portClosed(identity.port);
      assert.equal(existsSync(identity.socket), false, 'Owned socket survived');
      cpSync(join(dirname(identity.datadir), 'server.log'), join(out, `mysql-${identity.port}-server.log`));
      rmSync(identity.datadir, { recursive: true, force: true });
      assert.equal(existsSync(identity.datadir), false);
      identity.independentCleanup = { pidAbsent: true, portRefused: true, socketAbsent: true, datadirAbsent: true };
    } catch (error) { cleanupErrors.push(error.stack); }
  }
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); report.cleanup.applicationAbsent = true; }
    catch (error) { cleanupErrors.push(error.stack); }
  }
  if (report.artifact) {
    try { assert.equal(sha256(readFileSync(report.artifact.path)), report.artifact.sha256); report.cleanup.archiveUnchanged = true; }
    catch (error) { cleanupErrors.push(error.stack); }
  }
  if (cleanupErrors.length || interrupted) { report.passed = false; process.exitCode = 1; }
  report.cleanup.errors = cleanupErrors;
  report.interrupted = interrupted;
  report.finished = new Date().toISOString();
  report.harnessHashes = files(resolve(dirname(new URL(import.meta.url).pathname)));
  save(join(out, 'report.json'), report);
  process.off('SIGINT', onSignal);
  process.off('SIGTERM', onSignal);
  console.log(JSON.stringify({ passed: report.passed, cases: report.cases.length, controls: report.controls.length, error: report.error, cleanupErrors, out }));
}
