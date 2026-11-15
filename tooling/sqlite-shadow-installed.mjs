/** Physical installed ESM/CJS consumers; retain all database files after closure. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [format, binding, evidenceRoot, compiler] = process.argv.slice(2);
assert.ok(['esm', 'cjs'].includes(format));
assert.ok(['node', 'better'].includes(binding));
assert.ok(evidenceRoot && compiler);
const cwd = process.cwd();
const require = createRequire(join(cwd, 'consumer.cjs'));
const root = join(cwd, `${format}-${binding}`);
mkdirSync(root);
const report = { node: process.version, versions: process.versions, format, binding, exports: [], commands: [] };
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const q = (s) => `"${s.replaceAll('"', '""')}"`;
const plain = (v) => JSON.parse(JSON.stringify(v, (_, value) => value instanceof Set ? [...value] : value));
async function load(entry, baseline = false) {
  const packageRoot = baseline ? join(evidenceRoot, 'baseline/node_modules/turbine-orm') : join(cwd, 'node_modules/turbine-orm');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const key = entry ? `./${entry}` : '.';
  const specifier = entry ? `turbine-orm/${entry}` : 'turbine-orm';
  const condition = format === 'esm' ? 'import' : 'require';
  const target = resolve(packageRoot, manifest.exports[key][condition].default);
  report.exports.push({ baseline, entry: key, condition, target, sha256: sha(target) });
  if (!baseline) {
    if (format === 'cjs') assert.equal(require.resolve(specifier), target);
    else {
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `console.log(import.meta.resolve(${JSON.stringify(specifier)}))`], { cwd, encoding: 'utf8', timeout: 10000 });
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(probe.stdout.trim(), pathToFileURL(target).href);
    }
  }
  return format === 'cjs' ? require(target) : import(pathToFileURL(target).href);
}

const ddl = `PRAGMA foreign_keys=ON;
  CREATE VIRTUAL TABLE search_docs USING fts5(title, body);
  INSERT INTO search_docs VALUES('alpha', 'native λ body');
  INSERT INTO search_docs VALUES('beta', 'second');
  CREATE TABLE articles(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL UNIQUE, payload BLOB, score REAL NOT NULL, optional_text TEXT);
  INSERT INTO articles VALUES(7, 'full λ', X'00FFA17F', 1.25, NULL);
  CREATE TABLE profiles(id INTEGER PRIMARY KEY, record_id INTEGER NOT NULL UNIQUE REFERENCES articles(id), label TEXT NOT NULL);
  INSERT INTO profiles VALUES(9,7,'profile');
  CREATE INDEX articles_score ON articles(score);
  CREATE TABLE computed(id INTEGER PRIMARY KEY, n INTEGER NOT NULL, doubled INTEGER GENERATED ALWAYS AS (n*2) STORED);
  INSERT INTO computed(id,n) VALUES(3,11);
  CREATE TABLE strict_keys(id TEXT PRIMARY KEY) STRICT;
  INSERT INTO strict_keys VALUES('strict λ');
  CREATE TABLE without_keys(id INTEGER PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
  INSERT INTO without_keys VALUES(13, 'without');
  CREATE TABLE "Mixed_data"(id INTEGER PRIMARY KEY, value TEXT);
  CREATE TABLE "_articles_idx"(id INTEGER PRIMARY KEY, value TEXT);
  CREATE TABLE "ordinary_config"(id INTEGER PRIMARY KEY, value TEXT);
  CREATE TABLE "sqliteλ_docsize"(id INTEGER PRIMARY KEY, value TEXT);
  CREATE TABLE _prisma_migrations(id INTEGER);
  CREATE VIEW view_only AS SELECT label FROM articles;
  ANALYZE;`;
const ordinary = ['Mixed_data', '_articles_idx', 'articles', 'computed', 'ordinary_config', 'profiles', 'search_docs', 'sqliteλ_docsize', 'strict_keys', 'without_keys'];
const shadows = ['search_docs_config', 'search_docs_content', 'search_docs_data', 'search_docs_docsize', 'search_docs_idx'];
let native, readonly, client;
const open = (db) => db && (binding === 'node' ? db.isOpen : db.open);
function snapshot(db) {
  const definitions = db.prepare('SELECT type,name,tbl_name,sql FROM main.sqlite_master ORDER BY type,name').all();
  const rows = {};
  for (const { name } of db.prepare("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name").all()) {
    const columns = db.prepare(`PRAGMA main.table_xinfo(${q(name)})`).all().filter((c) => c.hidden !== 1);
    const projection = columns.flatMap((c, i) => [`typeof(${q(c.name)}) AS t${i}`, `hex(${q(c.name)}) AS h${i}`]).join(',');
    rows[name] = db.prepare(`SELECT ${projection} FROM main.${q(name)}`).all().map((r) => ({ ...r })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return plain({ definitions, rows });
}
function run(label, args, diagnostics) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: process.env, encoding: 'utf8', timeout: 60000 });
  report.commands.push({ label, binary: process.execPath, args, cwd: root, code: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.error, undefined);
  if (diagnostics) {
    assert.notEqual(result.status, 0);
    for (const pattern of diagnostics) assert.match(result.stdout + result.stderr, pattern);
  } else assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
}
try {
  const entry = binding === 'node' ? 'sqlite' : 'better-sqlite3';
  const api = await load(entry);
  const previous = await load(entry, true);
  const Constructor = binding === 'node' ? require('node:sqlite').DatabaseSync : require('better-sqlite3');
  const introspect = binding === 'node' ? api.introspectSqliteDatabase : api.introspectBetterSqlite3Database;
  const oldIntrospect = binding === 'node' ? previous.introspectSqliteDatabase : previous.introspectBetterSqlite3Database;
  native = new Constructor(join(root, 'native.db'));
  native.exec(ddl);
  for (const name of ['Mixed_data', '_articles_idx', 'ordinary_config', 'sqliteλ_docsize']) native.prepare(`INSERT INTO ${q(name)} VALUES(?,?)`).run(17, `ordinary ${name} λ`);
  report.sqlite = native.prepare('SELECT sqlite_version() AS v').get().v;
  report.compileOptions = native.prepare('PRAGMA compile_options').all();
  report.pg = JSON.parse(readFileSync(join(cwd, 'node_modules/pg/package.json'))).version;
  if (binding === 'better') {
    assert.equal(JSON.parse(readFileSync(join(cwd, 'node_modules/better-sqlite3/package.json'))).version, '12.11.1');
    report.peer = '12.11.1';
    report.nativeBinarySha256 = sha(join(cwd, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'));
    assert.equal(process.versions.modules, process.versions.node.startsWith('22.') ? '127' : '137');
  }
  report.nativeRows = native.prepare('PRAGMA main.table_list').all();
  assert.deepEqual(report.nativeRows.filter((r) => r.schema === 'main' && r.type === 'shadow').map((r) => r.name).sort(), shadows);
  assert.equal(report.nativeRows.find((r) => r.name === 'search_docs').type, 'virtual');
  for (const name of ordinary.filter((n) => n !== 'search_docs')) assert.equal(report.nativeRows.find((r) => r.name === name).type, 'table');
  const before = snapshot(native);
  report.before = before;
  const oldSchema = oldIntrospect(native);
  assert.deepEqual(Object.keys(oldSchema.tables), [...ordinary, ...shadows].sort(), 'actual installed old package exposes native shadows');
  const statements = [];
  const prepare = native.prepare;
  native.prepare = function (sql) { statements.push(sql); return prepare.call(this, sql); };
  const schema = introspect(native);
  native.prepare = prepare;
  report.sql = statements;
  assert.equal(statements[0], "SELECT name, sql FROM main.sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' ORDER BY name");
  assert.equal(statements[1], 'PRAGMA main.table_list');
  assert.equal(statements.filter((s) => s === 'PRAGMA main.table_list').length, 1);
  assert.ok(!statements.slice(2).some((s) => shadows.some((name) => s.includes(q(name)))));
  assert.deepEqual(Object.keys(schema.tables), ordinary);
  const expected = { ...oldSchema, tables: Object.fromEntries(Object.entries(oldSchema.tables).filter(([name]) => !shadows.includes(name))) };
  Object.setPrototypeOf(expected.tables, Object.getPrototypeOf(oldSchema.tables));
  assert.deepEqual(schema, expected, 'complete ordered metadata equals previous selected metadata');
  report.schema = plain(schema);
  report.previousSchema = plain(oldSchema);
  assert.deepEqual(schema.tables.articles.primaryKey, ['id']);
  assert.ok(schema.tables.articles.uniqueColumns.some((cols) => JSON.stringify(cols) === '["label"]'));
  assert.ok(schema.tables.articles.indexes.some((index) => index.name === 'articles_score'));
  assert.equal(schema.tables.computed.columns.find((c) => c.name === 'doubled').isGeneratedStored, true);
  assert.equal(schema.tables.strict_keys.columns[0].nullable, false);
  assert.equal(schema.tables.without_keys.columns[0].nullable, false);
  assert.ok(Object.values(schema.tables.articles.relations).some((r) => r.to === 'profiles' && r.type === 'hasOne'));
  if (binding === 'node') {
    const all = [...ordinary, ...shadows, '_prisma_migrations'].sort();
    assert.deepEqual(introspect(native, { include: all }), oldIntrospect(native, { include: all }));
    assert.deepEqual(Object.keys(introspect(native, { include: ['search_docs', 'search_docs_data'], exclude: ['search_docs_data'] }).tables), ['search_docs']);
    assert.deepEqual(Object.keys(introspect(native, { exclude: ['articles'] }).tables), ordinary.filter((n) => n !== 'articles'));
    assert.deepEqual(Object.keys(introspect(native, { include: [] }).tables), ordinary);
    report.explicitOverrides = true;
  } else report.explicitOverrides = 'no options parameter on optional helper';
  native.exec("CREATE TEMP TABLE temp_data(id INTEGER); ATTACH ':memory:' AS other; CREATE VIRTUAL TABLE other.foreign_docs USING fts5(title); BEGIN");
  assert.deepEqual(Object.keys(introspect(native).tables), ordinary);
  assert.equal(binding === 'node' ? native.isTransaction : native.inTransaction, true);
  native.exec('ROLLBACK');
  assert.deepEqual(snapshot(native), before, 'introspection preserves complete main definitions and native stored values');
  readonly = binding === 'node' ? new Constructor(join(root, 'native.db'), { readOnly: true }) : new Constructor(join(root, 'native.db'), { readonly: true });
  readonly.exec('BEGIN');
  assert.deepEqual(introspect(readonly), schema);
  assert.equal(binding === 'node' ? readonly.isTransaction : readonly.inTransaction, true);
  readonly.exec('ROLLBACK');
  readonly.close();
  client = binding === 'node' ? api.turbineSqlite(native, schema, { logger: {} }) : await api.turbineBetterSqlite3(native, schema, { logger: {} });
  const articles = await client.table('articles').findMany({ orderBy: { id: 'asc' } });
  assert.deepEqual(articles.map((r) => ({ ...r, payload: Buffer.from(r.payload).toString('hex') })), [{ id: 7, label: 'full λ', payload: '00ffa17f', score: 1.25, optionalText: null }]);
  assert.deepEqual(await client.table('search_docs').findMany({ orderBy: { title: 'asc' } }), [{ title: 'alpha', body: 'native λ body' }, { title: 'beta', body: 'second' }]);
  for (const name of ['Mixed_data', '_articles_idx', 'ordinary_config', 'sqliteλ_docsize']) assert.deepEqual(await client.table(name).findMany(), [{ id: 17, value: `ordinary ${name} λ` }]);
  await client.disconnect();
  assert.equal(open(native), true);
  assert.equal(native.prepare('SELECT COUNT(*) AS n FROM search_docs').get().n, 2);
  report.borrowedHandleSurvived = true;
  report.after = snapshot(native);
  assert.deepEqual(report.after, before);

  const generator = await load('');
  const generated = join(root, 'generated');
  mkdirSync(generated);
  writeFileSync(join(generated, 'package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
  generator.generate({ schema, target: 'sqlite', sqliteBinding: binding === 'node' ? 'node:sqlite' : 'better-sqlite3', outDir: generated, importExtension: 'js', noTimestamp: true, logger: {} });
  const suffix = format === 'esm' ? 'mts' : 'cts';
  const use = `import assert from 'node:assert/strict';
import { turbine } from './index.js';
async function main() {
 const db=await turbine(${JSON.stringify(join(generated, 'generated.db'))}, {logger:{}});
 try {
  await db.rawUnsafe('CREATE TABLE articles(id INTEGER PRIMARY KEY AUTOINCREMENT,label TEXT NOT NULL UNIQUE,payload BLOB,score REAL NOT NULL,optional_text TEXT)');
  await db.rawUnsafe('CREATE VIRTUAL TABLE search_docs USING fts5(title,body)');
  await db.articles.create({data:{id:19,label:'generated λ',payload:Buffer.from('00ffaa','hex'),score:2.5,optionalText:null}});
  const row=(await db.articles.findUnique({where:{id:19}}))!;
  const typed: string=row.label; assert.equal(typed,'generated λ');
  assert.deepEqual({...row,payload:Buffer.from(row.payload!).toString('hex')},{id:19,label:'generated λ',payload:'00ffaa',score:2.5,optionalText:null});
  await db.searchDocs.create({data:{title:'generated',body:'virtual λ'}});
  assert.deepEqual(await db.searchDocs.findMany(),[{title:'generated',body:'virtual λ'}]);
  await db.articles.update({where:{id:19},data:{optionalText:'updated'}});
  assert.equal((await db.articles.findUnique({where:{id:19}}))!.optionalText,'updated');
  const sentinel={};
  await assert.rejects(db.$transaction(async tx=>{await tx.articles.create({data:{id:20,label:'rollback',score:0}});throw sentinel;}),e=>e===sentinel);
  assert.equal(await db.articles.findUnique({where:{id:20}}),null);
  await db.articles.delete({where:{id:19}}); assert.deepEqual(await db.articles.findMany(),[]);
 } finally {await db.disconnect();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
`;
  writeFileSync(join(generated, `use.${suffix}`), use);
  const config = { compilerOptions: { strict: true, skipLibCheck: false, target: 'ES2023', module: 'NodeNext', moduleResolution: 'NodeNext', outDir: 'out', types: ['node'], typeRoots: [resolve(dirname(compiler), '../../@types')] }, include: ['*.ts', `use.${suffix}`], exclude: ['out', `invalid.${suffix}`] };
  writeFileSync(join(generated, 'tsconfig.json'), JSON.stringify(config));
  run('strict-positive', [compiler, '-p', join(generated, 'tsconfig.json')]);
  writeFileSync(join(generated, 'out/package.json'), JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
  run('generated-native', [join(generated, 'out', format === 'esm' ? 'use.mjs' : 'use.cjs')]);
  writeFileSync(join(generated, `invalid.${suffix}`), `import { turbine } from './index.js'; async function bad(){ const db=await turbine(':memory:'); db.searchDocsData; const row=await db.articles.findFirst(); return row!.missingColumn; } void bad;\n`);
  config.include.push(`invalid.${suffix}`); config.exclude = ['out']; config.compilerOptions.noEmit = true;
  writeFileSync(join(generated, 'tsconfig.invalid.json'), JSON.stringify(config));
  run('strict-unmarked-negative', [compiler, '-p', join(generated, 'tsconfig.invalid.json')], [/TS2339/, /searchDocsData/, /missingColumn/]);
  report.strictSkipLibCheck = false;
  report.consumerExtension = suffix;
  report.loadedNativeMaps = readFileSync('/proc/self/maps', 'utf8').split('\n').filter((line) => line.includes('.node'));
  report.success = true;
} catch (error) {
  report.error = { message: error.message, stack: error.stack };
  throw error;
} finally {
  await client?.disconnect();
  if (open(readonly)) readonly.close();
  if (open(native)) native.close();
  report.closed = !open(native) && !open(readonly);
  writeFileSync(join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
