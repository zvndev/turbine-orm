import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { command } from './optional-pg-transports/harness.mjs';
import { runWithShutdown } from './optional-pg-transports/run.mjs';

const [installed, evidence, lane, revision = 'v1'] = process.argv.slice(2);
assert.ok(['independent', 'combined'].includes(lane));
const pkg = join(installed, 'node_modules/turbine-orm');
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json')));
const ownRequire = createRequire(join(pkg, 'package.json'));
const report = { node: process.version, lane, revision, commands: [], cases: [], clients: [], servicesStarted: 0 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = name => '"' + name.replaceAll('"', '""') + '"';
const tree = dir => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = join(dir, entry.name);
  return entry.isDirectory() ? Object.entries(tree(file)).map(([name, bytes]) => [entry.name + '/' + name, bytes])
    : [[entry.name, readFileSync(file).toString('base64')]];
}));
const rows = (file, name) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare(`SELECT * FROM ${quote(name)} ORDER BY id`).all(); }
  finally { db.close(); }
};
const create = (file, name) => {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE ${quote(name)}(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL UNIQUE, bytes BLOB);
      INSERT INTO ${quote(name)} VALUES(1, 'complete 雪', X'00FF10'), (2, 'second', NULL);`);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().some(row => row.name.startsWith('sqlite_autoindex_')));
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get());
  } finally { db.close(); }
};

await runWithShutdown(report, join(evidence, `installed-${lane}-${revision}-${process.versions.node}.json`), async scope => {
  assert.equal(manifest.scripts.prepare, undefined, 'normal package removes checkout prepare');
  assert.throws(() => ownRequire.resolve('better-sqlite3'), /Cannot find module/);
  for (const format of ['esm', 'cjs']) {
    const condition = format === 'esm' ? 'import' : 'require';
    const configEntry = resolve(pkg, manifest.exports['./cli'][condition].default);
    const sqliteEntry = resolve(pkg, manifest.exports['./sqlite'][condition].default);
    const load = async file => format === 'esm' ? import(pathToFileURL(file)) : ownRequire(file);
    const configApi = await load(configEntry);
    const projectApi = await load(join(pkg, format === 'esm' ? 'dist/cli/sqlite-project.js' : 'dist/cjs/cli/sqlite-project.js'));
    const type = format === 'esm' ? 'module' : 'commonjs';
    const fixture = label => {
      const dir = join(installed, `sqlite-init-${revision}-${process.versions.node}`, format, label);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type }));
      return dir;
    };
    const init = async (dir, args = {}, overrides = {}) => {
      const previous = process.cwd(); process.chdir(dir);
      try {
        return await projectApi.initSqliteProject(configApi.resolveConfig({ engine: 'sqlite', url: './app.sqlite', out: './generated', migrationsDir: './migrations', importExtension: 'js', ...overrides }, {}), args);
      } finally { process.chdir(previous); }
    };
    const cli = async (dir, flags, failure) => {
      let output, error;
      try { output = await command(report, dir, process.execPath, [join(pkg, manifest.bin.turbine), 'init', '--engine', 'sqlite', '--url', './app.sqlite', '--yes', ...flags], { ...process.env, DATABASE_URL: '', NO_COLOR: '1' }, { scope }); }
      catch (caught) { error = caught; }
      if (failure) { assert.ok(error); assert.match(String(error), failure); }
      else if (error) throw error;
      return output;
    };

    // Resolve through the actual published import/require conditions inside the consumer.
    const exportDir = fixture('exports');
    const exportFile = join(exportDir, format === 'esm' ? 'exports.mjs' : 'exports.cjs');
    writeFileSync(exportFile, format === 'esm'
      ? `import assert from 'node:assert/strict'; assert.equal(import.meta.resolve('turbine-orm/cli'), ${JSON.stringify(pathToFileURL(configEntry).href)}); assert.equal(import.meta.resolve('turbine-orm/sqlite'), ${JSON.stringify(pathToFileURL(sqliteEntry).href)});`
      : `const assert=require('node:assert/strict'); assert.equal(require.resolve('turbine-orm/cli'), ${JSON.stringify(configEntry)}); assert.equal(require.resolve('turbine-orm/sqlite'), ${JSON.stringify(sqliteEntry)});`);
    await command(report, exportDir, process.execPath, [exportFile], process.env, { scope });

    for (const name of ['sqliteArchive', 'sqlitex_records', 'SQLITEArchive', 'sqliteé_records', 'sqlite💡records', '_private_data', 'ordinary_records']) {
      for (const args of [{ skipGenerate: true }, { skipGenerate: true, skipSchema: true, noTimestamp: true, force: true }]) {
        const dir = fixture('count-' + report.cases.length), file = join(dir, 'app.sqlite');
        create(file, name);
        chmodSync(file, 0o444);
        const before = readFileSync(file), values = rows(file, name), ownership = statSync(file);
        const result = await init(dir, args);
        assert.equal(result.existingDatabase, true); assert.equal(result.generated, undefined);
        assert.deepEqual(readdirSync(join(dir, 'migrations')), [], name);
        assert.deepEqual(readFileSync(file), before); assert.deepEqual(rows(file, name), values);
        for (const field of ['uid', 'gid', 'mode', 'ino']) assert.equal(statSync(file)[field], ownership[field]);
        const files = tree(dir);
        assert.deepEqual((await init(dir, { ...args, force: true })).created, []);
        assert.deepEqual(tree(dir), files);
        chmodSync(file, 0o644);
        const db = new DatabaseSync(file); db.exec('BEGIN EXCLUSIVE; ROLLBACK'); db.close();
        report.cases.push({ format, name, args, result, files, values, databaseSha256: digest(before) });
      }
    }
    for (const kind of ['new', 'empty', 'internal-only', 'journal-only']) {
      const dir = fixture(kind), file = join(dir, 'app.sqlite');
      let before;
      if (kind !== 'new') {
        const db = new DatabaseSync(file); db.exec('PRAGMA user_version = 0');
        if (kind === 'internal-only') db.exec('CREATE TABLE retired(id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO retired DEFAULT VALUES; DROP TABLE retired;');
        if (kind === 'journal-only') db.exec('CREATE TABLE _turbine_migrations(id INTEGER PRIMARY KEY, checksum TEXT)');
        db.close(); before = readFileSync(file);
      }
      const result = await init(dir);
      assert.equal(result.existingDatabase, kind !== 'new'); assert.equal(result.generated, undefined);
      assert.equal(readdirSync(join(dir, 'migrations')).length, 1, kind);
      if (before) assert.deepEqual(readFileSync(file), before);
      const files = tree(dir); await init(dir, { force: true }); assert.deepEqual(tree(dir), files);
      report.cases.push({ format, kind, files, result });
    }
    for (const name of ['ordinary_records', ...(lane === 'combined' ? ['sqliteArchive', 'sqlitex_records', 'SQLITEArchive', 'sqliteé_records'] : [])]) {
      const dir = fixture('client-' + name), file = join(dir, 'app.sqlite'); create(file, name);
      const before = readFileSync(file), values = rows(file, name);
      const result = await init(dir, { noTimestamp: true });
      assert.ok(result.generated, name); assert.deepEqual(readdirSync(join(dir, 'migrations')), []);
      assert.deepEqual(readFileSync(file), before); assert.deepEqual(rows(file, name), values);
      const source = readFileSync(join(dir, 'generated/index.ts'), 'utf8'); assert.doesNotMatch(source, /Generated at:/);
      const generatedFiles = tree(dir); await init(dir, { force: true }); assert.deepEqual(tree(dir), generatedFiles);
      const accessor = /readonly ([^:]+): QueryInterface/.exec(source)[1];
      const api = `db[${JSON.stringify(accessor)}]`, txApi = `tx[${JSON.stringify(accessor)}]`;
      const usage = `import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { turbine } from './generated/index.js';
async function main() {
 const db = turbine(${JSON.stringify(file)}, { logger: {}, warnOnUnlimited: false });
 try {
  const rows = await ${api}.findMany({ orderBy: { id: 'asc' } });
  const typed: string = rows[0]!.value; assert.equal(typed, 'complete 雪');
  assert.deepEqual(rows.map(r => ({id:r.id,value:r.value,bytes:r.bytes===null?null:Array.from(r.bytes)})), [{id:1,value:'complete 雪',bytes:[0,255,16]},{id:2,value:'second',bytes:null}]);
  const inserted = await ${api}.create({ data: { value: 'written', bytes: new Uint8Array([1,0,255]) } });
  assert.equal(inserted.id,3); assert.equal(inserted.value,'written');
  const sentinel = new Error('rollback sentinel');
  await assert.rejects(() => db.$transaction(async tx => { await ${txApi}.create({data:{value:'rolled back'}}); throw sentinel; }), e => e === sentinel);
  assert.equal(await ${api}.count(),3);
  assert.deepEqual((await ${api}.findMany({orderBy:{id:'asc'}})).map(r=>({id:r.id,value:r.value,bytes:r.bytes===null?null:Array.from(r.bytes)})), [{id:1,value:'complete 雪',bytes:[0,255,16]},{id:2,value:'second',bytes:null},{id:3,value:'written',bytes:[1,0,255]}]);
 } finally { await db.disconnect(); }
 const caller = new DatabaseSync(${JSON.stringify(file)}); const borrowed = turbine(caller,{logger:{}}); await borrowed.disconnect();
 assert.equal(caller.prepare('SELECT count(*) AS n FROM ${quote(name)}').get()!.n,3); caller.exec('BEGIN EXCLUSIVE; ROLLBACK'); caller.close();
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
`;
      writeFileSync(join(dir, 'usage.ts'), usage);
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, skipLibCheck: false, module: 'NodeNext', moduleResolution: 'NodeNext', target: 'ES2023', outDir: './emitted', types: ['node'], typeRoots: [resolve('node_modules/@types')] }, include: ['usage.ts', 'generated/**/*.ts'] }));
      const tsc = resolve('node_modules/typescript/bin/tsc');
      await command(report, dir, process.execPath, [tsc, '-p', dir], process.env, { scope });
      await command(report, dir, process.execPath, [join(dir, 'emitted/usage.js')], process.env, { scope });
      writeFileSync(join(dir, 'usage.ts'), usage + `\nasync function invalid(){ const db=turbine(${JSON.stringify(file)}); const rows=await ${api}.findMany(); const invalidValue:number=rows[0]!.value; return invalidValue; }\n`);
      let negative;
      try { await command(report, dir, process.execPath, [tsc, '--noEmit', '-p', dir], process.env, { scope }); }
      catch (error) { negative = String(error); }
      assert.match(negative || '', /TS2322/); assert.match(negative, /string.*number/);
      writeFileSync(join(dir, 'usage.ts'), usage);
      report.clients.push({ format, name, accessor, strict: true, skipLibCheck: false, unmarkedNegative: negative, completeRowsAfter: rows(file, name) });
    }

    const cliDir = fixture('cli-lookalike'), cliFile = join(cliDir, 'app.sqlite'); create(cliFile, 'sqliteArchive');
    const cliBefore = readFileSync(cliFile);
    await cli(cliDir, ['--skip-generate']);
    assert.deepEqual(readdirSync(join(cliDir, 'turbine/migrations')), []);
    assert.deepEqual(readFileSync(cliFile), cliBefore);
    const preserved = tree(cliDir); await cli(cliDir, ['--skip-generate', '--force']); assert.deepEqual(tree(cliDir), preserved);
    await cli(cliDir, ['--no-timestamp'], /Unknown flag/); assert.deepEqual(tree(cliDir), preserved);
    const cliGenerate = fixture('cli-generation'), cliName = lane === 'combined' ? 'sqlitex_records' : 'ordinary_records';
    create(join(cliGenerate, 'app.sqlite'), cliName); const generateBefore = readFileSync(join(cliGenerate, 'app.sqlite'));
    await cli(cliGenerate, []); assert.ok(readFileSync(join(cliGenerate, 'generated/turbine/index.ts')).length);
    assert.deepEqual(readdirSync(join(cliGenerate, 'turbine/migrations')), []);
    assert.deepEqual(readFileSync(join(cliGenerate, 'app.sqlite')), generateBefore);
    const cliGenerated = tree(cliGenerate); await cli(cliGenerate, ['--force']); assert.deepEqual(tree(cliGenerate), cliGenerated);
    for (const occupied of ['index.ts', 'types.ts', 'metadata.ts', 'zod.ts']) {
      const collisions = fixture('collisions-' + occupied); create(join(collisions, 'app.sqlite'), 'sqliteArchive');
      mkdirSync(join(collisions, 'generated'), { recursive: true }); mkdirSync(join(collisions, 'migrations'));
      writeFileSync(join(collisions, 'turbine.config.mjs'), "export default {engine:'sqlite'};\n");
      writeFileSync(join(collisions, 'generated', occupied), '// caller generated file\n');
      writeFileSync(join(collisions, 'migrations/existing.sql'), '-- caller migration\n');
      const collisionFiles = tree(collisions); await init(collisions, { force: true }); assert.deepEqual(tree(collisions), collisionFiles);
    }
    const bad = fixture('bad-database'); writeFileSync(join(bad, 'app.sqlite'), 'caller invalid database');
    const badBefore = tree(bad); await assert.rejects(() => init(bad), /not a database/); assert.deepEqual(tree(bad), badBefore);
    const refused = fixture('refused'); const refusedBefore = tree(refused);
    for (const args of [{ includeViews: true }, { withSchema: true }]) await assert.rejects(() => init(refused, args), /include-views|SQL migrations/);
    assert.deepEqual(tree(refused), refusedBefore);
  }
  console.log(JSON.stringify({ lane, node: process.version, apiCases: report.cases.length, strictExecutedClients: report.clients.length, noPorts: true }));
});
