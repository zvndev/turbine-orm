/** Packed, generated strict consumers. All services and mutations are disposable and owned. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ownedPostgres } from '../../tooling/native-consumer-contracts/postgres-service.mjs';

const archive = resolve(process.argv[2]);
const baseline = resolve(process.argv[3]);
const output = resolve(process.argv[4]);
const peer = process.env.TURBINE_PROTOTYPE_LIBSQL_PEER;
assert.ok(peer, 'An installed real @libsql/client peer is required.');
assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact required Node version.');
const root = mkdtempSync(join(tmpdir(), 'turbine-type-cost-native-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const report = {
  node: process.version,
  executable: process.execPath,
  root,
  archive,
  baseline,
  archiveSha256: hash(readFileSync(archive)),
  baselineSha256: hash(readFileSync(baseline)),
  fixtureSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
  commands: [],
  services: [],
  cases: [],
  passed: false,
};
assert.equal(report.baselineSha256, '6018191c40ad15ca0c6951be4f43faba8fbf7ebfe42633bab32b3463bde11eff');
const save = () => json(output, report);
const active = new Map();
const stops = [];
let cleanupPromise;
function processIdentity(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
  return {
    pid,
    pgid: Number(stat[2]),
    starttime: stat[19],
    executable: readlinkSync(`/proc/${pid}/exe`),
    cwd: readlinkSync(`/proc/${pid}/cwd`),
    commandLine: readFileSync(`/proc/${pid}/cmdline`).toString().split('\0'),
  };
}
function absent(pid) {
  return !existsSync(`/proc/${pid}`);
}
function groupAbsent(pgid) {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
}
async function stopCommand(child) {
  if (groupAbsent(child.pid)) return;
  process.kill(-child.pid, 'SIGTERM');
  for (let i = 0; i < 30 && !groupAbsent(child.pid); i++) await delay(100);
  if (!groupAbsent(child.pid)) process.kill(-child.pid, 'SIGKILL');
  for (let i = 0; i < 30 && !groupAbsent(child.pid); i++) await delay(100);
  assert.ok(groupAbsent(child.pid), 'Owned child group did not disappear.');
}
async function run(command, args, cwd = root, expected = 0, env = process.env) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  active.set(child.pid, child);
  const record = { command, args, cwd, pid: child.pid, pgid: child.pid, ports: [] };
  record.live = processIdentity(child.pid);
  report.commands.push(record);
  save();
  let text = '';
  child.stdout.on('data', (data) => {
    text += data;
  });
  child.stderr.on('data', (data) => {
    text += data;
  });
  const closed = new Promise((done, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => done({ code, signal }));
  });
  const deadline = setTimeout(() => {
    void stopCommand(child);
  }, 120_000);
  try {
    Object.assign(record, await closed);
  } finally {
    clearTimeout(deadline);
    await stopCommand(child);
    active.delete(child.pid);
    Object.assign(record, { processAbsent: absent(child.pid), groupAbsent: groupAbsent(child.pid), output: text });
    save();
  }
  assert.equal(record.code, expected, `${command} ${args.join(' ')}\n${text}`);
  return text;
}
async function portClosed(port) {
  return await new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      done(false);
    });
    socket.once('error', () => done(true));
    socket.once('timeout', () => {
      socket.destroy();
      done(false);
    });
  });
}
async function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    for (const child of active.values()) await stopCommand(child);
    for (const stop of stops.reverse()) await stop();
    for (const service of report.services) {
      service.processAbsent = absent(service.pid);
      service.portClosed = await portClosed(service.port);
      assert.ok(service.processAbsent && service.portClosed, 'Owned PostgreSQL did not disappear.');
    }
    rmSync(root, { recursive: true, force: true });
    report.fixtureRemoved = !existsSync(root);
    report.archiveUnchanged = hash(readFileSync(archive)) === report.archiveSha256;
    report.baselineUnchanged = hash(readFileSync(baseline)) === report.baselineSha256;
    save();
  })();
  return cleanupPromise;
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.once(signal, () => {
    report.signal = signal;
    void cleanup().finally(() => process.exit(1));
  });
try {
  const stage = join(root, 'stage');
  const base = join(root, 'base');
  const consumer = join(root, 'consumer');
  for (const dir of [stage, base, consumer]) mkdirSync(dir);
  await run('tar', ['-xzf', archive, '-C', stage]);
  await run('tar', ['-xzf', baseline, '-C', base]);
  json(join(consumer, 'package.json'), { private: true, type: 'module' });
  await run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--omit=optional',
      '--no-audit',
      '--no-fund',
      archive,
      'typescript@6.0.3',
      '@types/node@22.20.4',
    ],
    consumer,
  );
  mkdirSync(join(consumer, 'node_modules/@libsql'), { recursive: true });
  symlinkSync(resolve(peer), join(consumer, 'node_modules/@libsql/client'));
  symlinkSync(join(consumer, 'node_modules'), join(base, 'package/node_modules'));
  const pkg = join(consumer, 'node_modules/turbine-orm');
  const inventory = (dir, prefix = '') =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? inventory(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
    );
  const installedFiles = inventory(join(pkg, 'dist'));
  for (const file of installedFiles)
    assert.equal(hash(readFileSync(join(pkg, 'dist', file))), hash(readFileSync(join(stage, 'package/dist', file))));
  report.installedDistFilesMatchArchive = installedFiles.length;
  report.versions = Object.fromEntries(
    ['typescript', '@types/node', 'pg', '@libsql/client'].map((name) => [
      name,
      JSON.parse(readFileSync(join(consumer, 'node_modules', name, 'package.json'), 'utf8')).version,
    ]),
  );
  report.noAmbientPgTypes = !existsSync(join(consumer, 'node_modules/@types/pg'));
  assert.ok(report.noAmbientPgTypes);

  const load = (file) => import(pathToFileURL(join(pkg, 'dist', file)));
  const gen = await load('generate.js');
  const baseGen = await import(pathToFileURL(join(base, 'package/dist/generate.js')));
  const { generateLibsqlFiles } = await load('libsql/generate.js');
  const { introspectLibsql } = await load('libsql/introspect.js');
  const { introspect } = await load('introspect.js');
  const { introspectSqliteDatabase } = await load('sqlite.js');
  const { createClient } = await import(pathToFileURL(join(resolve(peer), 'lib-esm/node.js')));
  const { DatabaseSync } = await import('node:sqlite');
  const pg = (await import(pathToFileURL(join(consumer, 'node_modules/pg/lib/index.js')))).default;
  const pgRoot = join(root, 'pg');
  mkdirSync(pgRoot);
  const env = {
    ...process.env,
    PG_PREFIX: process.env.PG_PREFIX,
    LD_LIBRARY_PATH: `${process.env.PG_PREFIX}/lib:${process.env.LD_LIBRARY_PATH ?? ''}`,
  };
  const service = await ownedPostgres({
    root: pgRoot,
    env,
    driver: pg,
    report,
    registerStop: (stop) => stops.push(stop),
    run: (cwd, executable, args) => run(executable, args, cwd, 0, env),
  });
  const identity = report.services[0];
  identity.live = processIdentity(identity.pid);
  identity.pgid = identity.live.pgid;
  identity.executable = identity.live.executable;
  const database = `prototype_filters_${process.pid}`;
  await service.client.query(`CREATE DATABASE ${database}`);
  const pgUrl = service.url.replace('/postgres', `/${database}`);
  identity.database = database;
  save();
  const postgres = new pg.Client({ connectionString: pgUrl });
  await postgres.connect();
  const ddl =
    'CREATE TABLE prototype_rows (id INTEGER PRIMARY KEY, "__proto__" TEXT NOT NULL, constructor TEXT, "toString" TEXT); CREATE TABLE mapped_rows (id INTEGER PRIMARY KEY, constructor TEXT, to_string TEXT)';
  try {
    await postgres.query(ddl);
  } finally {
    await postgres.end();
  }
  const libFile = join(root, 'libsql.db');
  const native = createClient({ url: `file:${libFile}`, intMode: 'bigint' });
  let libRaw;
  let libMapped;
  try {
    await native.executeMultiple(ddl);
    report.libsqlVersion = (await native.execute('SELECT sqlite_version()')).rows[0][0];
    libRaw = await introspectLibsql(
      { client: native, url: `file:${libFile}` },
      { include: ['prototype_rows'], keepColumnNames: true },
    );
    libMapped = await introspectLibsql({ client: native, url: `file:${libFile}` }, { include: ['mapped_rows'] });
  } finally {
    native.close();
  }
  const sqliteFile = join(root, 'sqlite.db');
  const sqlite = new DatabaseSync(sqliteFile);
  let sqliteSchema;
  try {
    sqlite.exec(ddl);
    sqliteSchema = introspectSqliteDatabase(sqlite, { include: ['prototype_rows', 'mapped_rows'] });
  } finally {
    sqlite.close();
  }
  const pgRaw = await introspect({ connectionString: pgUrl, include: ['prototype_rows'], keepColumnNames: true });
  const pgMapped = await introspect({ connectionString: pgUrl, include: ['mapped_rows'] });
  const genericFiles = (schema, options) => ({
    'index.ts': gen.generateIndex(schema, options),
    'types.ts': gen.generateTypes(schema, options),
    'metadata.ts': gen.generateMetadata(schema, options),
  });
  const cases = [
    {
      engine: 'libsql',
      target: `file:${libFile}`,
      raw: libRaw,
      mapped: libMapped,
      files: (s) => generateLibsqlFiles(s, { noTimestamp: true }),
    },
    {
      engine: 'sqlite',
      target: sqliteFile,
      raw: sqliteSchema,
      mapped: sqliteSchema,
      files: (s) => genericFiles(s, { target: 'sqlite', exactNativeIntegers: true, noTimestamp: true }),
    },
    {
      engine: 'postgres',
      target: { connectionString: pgUrl },
      raw: pgRaw,
      mapped: pgMapped,
      files: (s) => genericFiles(s, { noTimestamp: true }),
    },
  ];
  for (const schema of [pgRaw, pgMapped])
    for (const [name, current] of Object.entries(genericFiles(schema, { noTimestamp: true }))) {
      const original = {
        'index.ts': baseGen.generateIndex,
        'types.ts': baseGen.generateTypes,
        'metadata.ts': baseGen.generateMetadata,
      }[name](schema, { noTimestamp: true });
      assert.equal(current, original, `PostgreSQL generated ${name} changed.`);
    }
  report.postgresGeneratedBytesUnchanged = true;
  writeFileSync(
    join(consumer, 'forbid-sqlite.cjs'),
    "const Module=require('node:module');const load=Module._load;Module._load=function(name,...rest){if(name==='node:sqlite')throw Error('node:sqlite forbidden');return load.call(this,name,...rest)};",
  );
  writeFileSync(
    join(consumer, 'forbid-sqlite.mjs'),
    "export function resolve(name,context,next){if(name==='node:sqlite')throw Error('node:sqlite forbidden');return next(name,context)}",
  );
  for (const item of cases)
    for (const format of ['esm', 'cjs']) {
      const dir = join(consumer, `${item.engine}-${format}`);
      mkdirSync(dir);
      json(join(dir, 'package.json'), { type: format === 'esm' ? 'module' : 'commonjs' });
      for (const [prefix, schema] of [
        ['raw', item.raw],
        ['mapped', item.mapped],
      ]) {
        mkdirSync(join(dir, prefix));
        for (const [name, source] of Object.entries(item.files(schema))) writeFileSync(join(dir, prefix, name), source);
      }
      const protoField = item.raw.tables.prototype_rows.columns.find((c) => c.name === '__proto__').field;
      const invocation =
        item.engine === 'postgres'
          ? JSON.stringify({ ...item.target, logger: {}, warnOnUnlimited: false })
          : `${JSON.stringify(item.target)}, { logger: {}, warnOnUnlimited: false }`;
      const source = `import assert from 'node:assert/strict';
import { turbine } from './raw/index.js';
import { turbine as mappedTurbine } from './mapped/index.js';
type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
async function rawPrototype() {
 const db = await turbine(${invocation});
 try {
  const row = await db.prototypeRows.create({ data: { id: 1, ['${protoField}']: 'safe', constructor: 'ctor', toString: 'text' } });
  const filter = { id: row.id };
  const selected = await db.prototypeRows.findFirst({ where: filter });
  assert.ok(selected);
  type ConstructorIsExact = Assert<Equal<typeof selected.constructor, string | null>>;
  type ToStringIsExact = Assert<Equal<typeof selected.toString, string | null>>;
  type PrototypeIsExact = Assert<Equal<typeof selected.${protoField}, string>>;
  const proto: string = selected.${protoField}; const ctor: string | null = selected.constructor; const text: string | null = selected.toString;
  assert.equal(proto, 'safe'); assert.equal(ctor, 'ctor'); assert.equal(text, 'text'); assert.equal(selected.id, 1);
  assert.equal(Object.hasOwn(selected, '${protoField}'), true); assert.equal(Object.getPrototypeOf(selected), Object.prototype);
  assert.equal((await db.prototypeRows.findMany({ where: { AND: [{ id: row.id }, { constructor: { startsWith: 'ct' } }] } })).length, 1);
  assert.equal(await db.prototypeRows.count({ where: filter }), 1);
  assert.equal((await db.prototypeRows.findUnique({ where: filter }))!.constructor, 'ctor');
  const updated = await db.prototypeRows.update({ where: filter, data: { constructor: 'next', toString: 'text' }, select: { constructor: true } });
  const exact: string | null = updated.constructor; assert.equal(exact, 'next');
  const [first, many, count] = await db.pipeline(db.prototypeRows.buildFindFirst({ where: filter }), db.prototypeRows.buildFindMany({ where: filter }), db.prototypeRows.buildCount({ where: filter }));
  assert.equal(first!.constructor, 'next'); assert.equal(many.length, 1); assert.equal(count, 1);
  const [written] = await db.pipeline(db.prototypeRows.buildUpdate({ where: filter, data: { constructor: 'last', toString: 'text' } }));
  assert.equal(written.constructor, 'last');
  const [deleted] = await db.pipeline(db.prototypeRows.buildDelete({ where: filter })); assert.equal(deleted.constructor, 'last');
  assert.equal(await db.prototypeRows.count({ where: filter }), 0);
  await db.prototypeRows.create({ data: { id: 2, ['${protoField}']: 'safe', constructor: 'ctor', toString: 'text' } });
  assert.equal((await db.prototypeRows.delete({ where: { id: 2 } })).toString, 'text');
 } finally { await db.disconnect(); }
}
async function main() {
 await rawPrototype();
 const mapped = await mappedTurbine(${invocation});
 try {
  await mapped.mappedRows.create({ data: { id: 1, constructor: 'mapped', toString: 'mapped-text' } });
  const row = await mapped.mappedRows.findFirst({ where: { id: 1 } }); assert.ok(row);
  const text: string | null = row.toString; assert.equal(text, 'mapped-text');
  assert.equal((await mapped.mappedRows.findFirst({ where: { constructor: 'mapped', toString: 'mapped-text' } }))!.constructor, 'mapped');
  await mapped.mappedRows.delete({ where: { id: 1 } });
 } finally { await mapped.disconnect(); }
}
function rejected(db: Awaited<ReturnType<typeof turbine>>) {
 // @ts-expect-error explicit Function is not a string predicate
 void db.prototypeRows.findFirst({ where: { constructor: Function } });
 // @ts-expect-error wrong scalar
 void db.prototypeRows.findMany({ where: { toString: 123 } });
 // @ts-expect-error function operand
 void db.prototypeRows.count({ where: { constructor: { equals: Function } } });
 // @ts-expect-error extra operator beside a valid one
 void db.prototypeRows.delete({ where: { constructor: { equals: 'x', typo: true } } });
 // @ts-expect-error invalid logical control
 void db.prototypeRows.buildFindFirst({ where: { AND: { id: 1 } } });
}
void rejected;
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });`;
      writeFileSync(join(dir, 'consumer.ts'), source);
      json(join(dir, 'tsconfig.json'), {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          exactOptionalPropertyTypes: true,
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'out',
          types: ['node'],
        },
        include: ['**/*.ts'],
        exclude: ['out'],
      });
      const tsc = join(consumer, 'node_modules/typescript/bin/tsc');
      const exactOptionalMatrix = [];
      for (const exact of ['false', 'true']) {
        const options = ['-p', dir, '--exactOptionalPropertyTypes', exact];
        await run(process.execPath, [tsc, ...options]);
        writeFileSync(join(dir, 'consumer.ts'), source.replaceAll('@ts-expect-error', 'removed negative assertion:'));
        const invalid = await run(process.execPath, [tsc, ...options, '--noEmit'], root, 2);
        assert.equal((invalid.match(/error TS/g) ?? []).length, 5, invalid);
        assert.doesNotMatch(invalid, /TS2589|TS2615/);
        writeFileSync(join(dir, 'consumer.ts'), source);
        exactOptionalMatrix.push({ exactOptionalPropertyTypes: exact === 'true', strictNegativeDiagnostics: 5 });
      }
      const guards =
        item.engine === 'libsql'
          ? ['--loader', join(consumer, 'forbid-sqlite.mjs'), '--require', join(consumer, 'forbid-sqlite.cjs')]
          : [];
      const result = await run(process.execPath, [...guards, join(dir, 'out/consumer.js')]);
      report.cases.push({
        engine: item.engine,
        format,
        strictNegativeDiagnostics: 5,
        exactOptionalMatrix,
        runtimePassed: true,
        rawPrototypeRuntime: 'passed',
        mappedTableRuntime: 'passed',
        sourceSha256: hash(source),
        output: result,
      });
      save();
    }
  report.passed = true;
} finally {
  await cleanup();
}
console.log('generated ESM/CJS prototype filters passed: native libSQL/PG/SQLite raw and mapped runtime');
