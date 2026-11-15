/** Run from a physical package consumer with a matching optional native peer. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [format, binding, mode, reportPath, compiler] = process.argv.slice(2);
assert.ok(['esm', 'cjs'].includes(format));
assert.ok(['node', 'better'].includes(binding));
assert.ok(['catalog', 'full'].includes(mode));
const cwd = process.cwd();
const require = createRequire(join(cwd, 'consumer.cjs'));
const packageRoot = join(cwd, 'node_modules/turbine-orm');
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const report = {
  node: process.version,
  abi: process.versions.modules,
  format,
  binding,
  mode,
  exports: {},
  commands: [],
};
async function load(entry) {
  const key = entry === '.' ? '.' : `./${entry}`;
  const specifier = entry === '.' ? 'turbine-orm' : `turbine-orm/${entry}`;
  const condition = format === 'esm' ? 'import' : 'require';
  const target = resolve(packageRoot, manifest.exports[key][condition].default);
  report.exports[key] = { condition, target, sha256: sha(target) };
  if (format === 'cjs') {
    assert.equal(require.resolve(specifier), target);
    return require(specifier);
  }
  assert.notEqual(target, resolve(packageRoot, manifest.exports[key].require.default));
  return import(pathToFileURL(target).href);
}
const names = ['SQLITExUpper', 'ordinary_records', 'sqliteArchive', 'sqlitex_records', 'sqliteλ_records'];
const q = (name) => `"${name.replace(/"/g, '""')}"`;
const accessor = (name) => name.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
const rows = names.map((name) => ({ name, id: 7, full_name: name }));
let native, db;
function run(label, binary, args, expectedFailure = false) {
  const result = spawnSync(binary, args, { cwd, encoding: 'utf8', timeout: 45000, env: process.env });
  report.commands.push({
    label,
    binary,
    args,
    cwd,
    code: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: result.stdout,
    stderr: result.stderr,
    expectedFailure,
  });
  assert.equal(result.error, undefined, label);
  if (expectedFailure) {
    assert.notEqual(result.status, 0, label);
    assert.match(result.stdout + result.stderr, /TS2339/);
    assert.match(result.stdout + result.stderr, /missingColumn/);
  } else assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
}
try {
  const api = await load(binding === 'node' ? 'sqlite' : 'better-sqlite3');
  const Constructor = binding === 'node' ? require('node:sqlite').DatabaseSync : require('better-sqlite3');
  native = new Constructor(':memory:');
  const isOpen = () => (binding === 'node' ? native.isOpen : native.open);
  report.sqlite = native.prepare('SELECT sqlite_version() AS version').get().version;
  report.pg = JSON.parse(readFileSync(join(cwd, 'node_modules/pg/package.json'), 'utf8')).version;
  if (binding === 'better') {
    report.peer = JSON.parse(readFileSync(join(cwd, 'node_modules/better-sqlite3/package.json'), 'utf8')).version;
    assert.equal(report.peer, '12.11.1');
    report.nativeBinarySha256 = sha(join(cwd, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
  }
  native.exec('CREATE TABLE ordinary_records(id INTEGER PRIMARY KEY AUTOINCREMENT,full_name TEXT NOT NULL)');
  for (const name of names.filter((name) => name !== 'ordinary_records'))
    native.exec(`CREATE TABLE ${q(name)}(id INTEGER PRIMARY KEY,full_name TEXT NOT NULL)`);
  for (const name of names) native.prepare(`INSERT INTO ${q(name)} VALUES(?,?)`).run(7, name);
  native.exec('ANALYZE');
  report.stored = names.map((name) => ({ name, ...native.prepare(`SELECT * FROM ${q(name)}`).get() }));
  assert.deepEqual(report.stored, rows);
  report.nativeCatalog = native
    .prepare("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.ok(report.nativeCatalog.includes('sqlite_sequence'));
  assert.ok(report.nativeCatalog.includes('sqlite_stat1'));
  report.reservedRefusals = [];
  for (const name of ['sqlite_reserved', 'SQLITE_reserved', 'SqLiTe_reserved']) {
    assert.throws(
      () => native.exec(`CREATE TABLE ${q(name)}(id INTEGER)`),
      (error) => {
        assert.match(error.message, /reserved for internal use/);
        report.reservedRefusals.push({ name, code: error.code, message: error.message });
        return true;
      },
    );
  }
  const introspect = binding === 'node' ? api.introspectSqliteDatabase : api.introspectBetterSqlite3Database;
  const originalPrepare = native.prepare;
  const statements = [];
  native.prepare = (sql) => {
    statements.push(sql);
    return originalPrepare.call(native, sql);
  };
  let schema;
  try {
    schema = introspect(native);
  } finally {
    native.prepare = originalPrepare;
  }
  report.introspectionSql = statements;
  report.catalog = Object.keys(schema.tables);
  console.log(JSON.stringify({ node: report.node, format, binding, catalog: report.catalog, stored: report.stored }));
  assert.deepEqual(report.catalog, names, 'every legitimate native user table must be exposed');
  assert.equal(statements.filter((sql) => /SELECT name, sql FROM main.sqlite_master/.test(sql)).length, 1);
  for (const name of names) assert.deepEqual(schema.tables[name].allColumns, ['id', 'full_name']);
  native.exec(
    "CREATE TEMP TABLE sqliteTempOnly(id INTEGER); ATTACH ':memory:' AS other; CREATE TABLE other.sqliteAttachedOnly(id INTEGER); BEGIN",
  );
  if (binding === 'node') {
    assert.deepEqual(Object.keys(introspect(native, { include: ['sqliteArchive'] }).tables), ['sqliteArchive']);
    assert.deepEqual(
      Object.keys(introspect(native, { exclude: ['sqliteArchive'] }).tables),
      names.filter((name) => name !== 'sqliteArchive'),
    );
    report.includeExclude = 'checked through the builtin introspector options';
  } else report.includeExclude = 'optional handle helper has no options parameter';
  assert.equal(binding === 'node' ? native.isTransaction : native.inTransaction, true);
  native.exec('ROLLBACK');
  assert.deepEqual(Object.keys(introspect(native).tables), names);
  assert.equal(isOpen(), true);
  db =
    binding === 'node'
      ? api.turbineSqlite(native, schema, { logger: {} })
      : await api.turbineBetterSqlite3(native, schema, { logger: {} });
  for (const name of names)
    assert.deepEqual(await db.table(name).findMany({ orderBy: { id: 'asc' } }), [{ id: 7, fullName: name }]);
  await db.disconnect();
  assert.equal(isOpen(), true);
  report.borrowedHandleSurvived = true;
  if (mode === 'full') {
    assert.ok(compiler, 'explicit owned TypeScript compiler required');
    const generator = await load('.');
    const dir = mkdtempSync(join(cwd, `generated-${format}-${binding}-`));
    const packageType = format === 'esm' ? 'module' : 'commonjs';
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: packageType }));
    const generated = generator.generate({
      schema,
      target: 'sqlite',
      sqliteBinding: binding === 'node' ? 'node:sqlite' : 'better-sqlite3',
      outDir: dir,
      importExtension: 'js',
      noTimestamp: true,
      logger: {},
    });
    report.generated = generated.files.map((path) => ({ path: resolve(dir, path), sha256: sha(resolve(dir, path)) }));
    const lines = [
      "import assert from 'node:assert/strict';",
      "import { turbine } from './index.js';",
      'async function main() {',
      "const db = await turbine(':memory:', {logger:{}});",
      'try {',
    ];
    for (const name of names) {
      lines.push(
        `await db.rawUnsafe(${JSON.stringify(`CREATE TABLE ${q(name)}(id INTEGER PRIMARY KEY,full_name TEXT NOT NULL)`)});`,
      );
      lines.push(`await db[${JSON.stringify(accessor(name))}].create({data:{id:7,fullName:${JSON.stringify(name)}}});`);
      lines.push(
        `assert.deepEqual(await db[${JSON.stringify(accessor(name))}].findMany({orderBy:{id:'asc'}}),[{id:7,fullName:${JSON.stringify(name)}}]);`,
      );
    }
    lines.push(
      "const typed: string = (await db.sqliteArchive.findUnique({where:{id:7}}))!.fullName; assert.equal(typed,'sqliteArchive');",
      "await db.$transaction(async tx => { await tx.sqlitexRecords.create({data:{id:8,fullName:'tx'}}); });",
      "assert.equal((await db.sqlitexRecords.findUnique({where:{id:8}}))!.fullName,'tx');",
      '} finally { await db.disconnect(); }',
      '}',
      'main().catch(error=>{ console.error(error); process.exitCode=1; });',
    );
    writeFileSync(join(dir, 'use.ts'), `${lines.join('\n')}\n`);
    const typeRoot = resolve(compiler, '../../../@types');
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          outDir: 'out',
          types: ['node'],
          typeRoots: [typeRoot],
        },
        include: ['*.ts'],
        exclude: ['out', 'invalid.ts'],
      }),
    );
    run('strict-positive', process.execPath, [compiler, '-p', join(dir, 'tsconfig.json')]);
    writeFileSync(join(dir, 'out/package.json'), JSON.stringify({ type: packageType }));
    run('generated-native', process.execPath, [join(dir, 'out/use.js')]);
    writeFileSync(
      join(dir, 'invalid.ts'),
      "import { turbine } from './index.js'; async function bad() { const db=await turbine(':memory:'); const row=await db.sqliteArchive.findFirst(); return row!.missingColumn; } void bad;\n",
    );
    const negativeConfig = JSON.parse(readFileSync(join(dir, 'tsconfig.json'), 'utf8'));
    negativeConfig.compilerOptions.noEmit = true;
    negativeConfig.exclude = ['out'];
    writeFileSync(join(dir, 'tsconfig.invalid.json'), JSON.stringify(negativeConfig));
    run('strict-unmarked-negative', process.execPath, [compiler, '-p', join(dir, 'tsconfig.invalid.json')], true);
    report.strictSkipLibCheck = false;
  }
  report.success = true;
} catch (error) {
  report.success = false;
  report.error = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  await db?.disconnect();
  if (native && (binding === 'node' ? native.isOpen : native.open)) native.close();
  report.closed = native ? !(binding === 'node' ? native.isOpen : native.open) : true;
  if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
