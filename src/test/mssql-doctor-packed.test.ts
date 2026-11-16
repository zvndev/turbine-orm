/** Held-out transport fixtures exercise real packed code, never native certification. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const driver = String.raw`
const events = []; const waiters = new Map(); const holds = new Map();
const emit = (event) => { events.push(event); waiters.get(event)?.(); waiters.delete(event); };
const until = (event) => events.includes(event) ? Promise.resolve() : new Promise((resolve) => waiters.set(event, resolve));
const hold = (event) => new Promise((resolve) => holds.set(event, resolve));
const mode = () => process.env.DOCTOR_FIXTURE_MODE || '';
const namespace = "MiX]ed. Namespace";
const names = { child: "Order] Child", parent: "Parent.Key", a: "Tenant] Key", b: "Id.Key" };
const flags = { IS_COMPUTED: false, IS_IDENTITY: false, HAS_FILTER: false, IS_DISABLED: false,
  IS_HYPOTHETICAL: false, INDEX_TYPE: 'NONCLUSTERED', TYPE_DESC: 'NONCLUSTERED', IS_INCLUDED: false, IS_UNIQUE: false };
const indexRows = () => {
  const cols = mode() === 'reversed' ? [names.b, names.a] : [names.a, names.b];
  const rows = cols.map((name, i) => ({ ...flags, TABLE_NAME: names.child, INDEX_NAME: "Cover] Both", COLUMN_NAME: name, KEY_ORDINAL: i+1, SEQ: i+1, INDEX_COLUMN_ID: i+1 }));
  rows.push({ ...flags, TABLE_NAME: names.child, INDEX_NAME: "Cover] Both", COLUMN_NAME: 'payload', IS_INCLUDED: true, KEY_ORDINAL: 0, SEQ: 0, INDEX_COLUMN_ID: 3 });
  if (['unique','disabled-unique'].includes(mode())) for (const r of rows) r.IS_UNIQUE = true;
  if (mode() === 'filtered') for (const r of rows) r.HAS_FILTER = true;
  if (mode() === 'disabled' || mode() === 'disabled-unique') for (const r of rows) r.IS_DISABLED = true;
  if (mode() === 'hypothetical') for (const r of rows) r.IS_HYPOTHETICAL = true;
  if (mode() === 'columnstore') for (const r of rows) r.INDEX_TYPE = r.TYPE_DESC = 'NONCLUSTERED COLUMNSTORE';
  if (mode() === 'computed') rows[0].IS_COMPUTED = true;
  if (mode() === 'uncertain') for (const r of rows) delete r.HAS_FILTER;
  if (mode() === 'included-only') { rows[1].IS_INCLUDED = true; rows[1].KEY_ORDINAL = rows[1].SEQ = 0; }
  if (mode() === 'prefix-only') return rows.filter((r) => r.COLUMN_NAME !== names.b);
  if (mode() === 'ordinal-gap') rows[1].KEY_ORDINAL = rows[1].SEQ = 3;
  return ['no-index', 'pk-cover', 'disabled-pk', 'hash-pk', 'pk-gap'].includes(mode()) ? [] : rows;
};
class ConnectionPool {
  constructor() { emit('construct'); }
  on() { return this; }
  async connect() { if (mode() === 'connect-pending') { const pending = hold('connect'); emit('connect-pending'); await pending; } emit('connect'); if (mode() === 'connect-fail') throw Error('endpoint-secret'); }
  async close() { emit('close'); if (mode() === 'close-fail' || mode() === 'read-close-fail') throw Error('cleanup-secret'); }
  request() { const params = {}; return { input(name, value) { params[name] = value; return this; }, async query(sql) {
    emit('query');
    if (mode() === 'query-pending') { const pending = hold('query'); emit('query-pending'); await pending; }
    if (mode() === 'query-fail' || (mode() === 'late-query-fail' && events.filter((e)=>e==='query').length===5) || mode() === 'read-close-fail') throw Error('literal-secret');
    if (!sql.trim().startsWith('SELECT') || /(?:^|;)\s*(?:SET|BEGIN|COMMIT|ROLLBACK|INSERT|UPDATE|DELETE|CREATE|DROP)\b/i.test(sql)) throw Error('noncatalog SQL');
    if (/COLUMN_DEFAULT|GENERATION_EXPRESSION|FILTER_DEFINITION/i.test(sql)) throw Error('sensitive SQL projection');
    if (!/INFORMATION_SCHEMA|sys\./.test(sql)) throw Error('noncatalog read');
    if (!sql.includes('@p1') || params.p1 !== namespace.toLowerCase()) throw Error('scope not bound');
    if (mode() === 'empty') return { recordset: [] };
    let rows;
    if (sql.includes('c.is_computed AS IS_COMPUTED') && !sql.includes('sys.indexes') && !sql.includes('INFORMATION_SCHEMA.COLUMNS')) {
      rows = [names.child, names.parent].flatMap((TABLE_NAME) => [names.a, names.b, 'payload', 'derived', 'rv'].map((COLUMN_NAME) => ({ TABLE_SCHEMA: namespace, TABLE_NAME, COLUMN_NAME, IS_COMPUTED: COLUMN_NAME === 'derived', IS_IDENTITY: COLUMN_NAME === names.b && TABLE_NAME === names.parent })));
      if (mode() === 'unknown-namespace') for (const row of rows) delete row.TABLE_SCHEMA;
    } else if (sql.includes('i.has_filter AS HAS_FILTER') && !sql.includes('i.is_unique AS IS_UNIQUE')) rows = indexRows();
    else if (sql.includes('INFORMATION_SCHEMA.TABLES')) rows = [names.parent, names.child].map((TABLE_NAME) => ({ TABLE_NAME }));
    else if (sql.includes('sys.identity_columns')) rows = [{ TABLE_NAME: names.parent, COLUMN_NAME: names.b }];
    else if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) rows = [names.child, names.parent].flatMap((TABLE_NAME) => [names.a, names.b, 'payload', 'derived', 'rv'].map((COLUMN_NAME) => ({ TABLE_NAME, COLUMN_NAME, DATA_TYPE: COLUMN_NAME === 'rv' ? 'rowversion' : COLUMN_NAME === 'derived' ? 'nvarchar' : 'int', IS_NULLABLE: 'NO', IS_COMPUTED: COLUMN_NAME === 'derived' || (mode() === 'computed' && TABLE_NAME === names.child && COLUMN_NAME === names.a), GENERATED_ALWAYS_TYPE: 0, IS_HIDDEN: false, HAS_DEFAULT: false, COLUMN_DEFAULT: 'default-secret', GENERATION_EXPRESSION: 'computed-secret' })));
    else if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) rows = [names.parent, ...(['pk-cover','disabled-pk','hash-pk','pk-gap'].includes(mode()) ? [names.child] : [])].flatMap((TABLE_NAME) => [names.a,names.b].map((COLUMN_NAME,i) => ({ TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION: i+1, IS_DISABLED: mode() === 'disabled-pk', IS_HYPOTHETICAL: false })));
    else if (sql.includes('sys.check_constraints')) rows = [];
    else if (sql.includes('sys.foreign_keys')) rows = [names.a,names.b].map((COLUMN_NAME,i) => ({ CONSTRAINT_NAME: 'FK child', TABLE_NAME: names.child, COLUMN_NAME, REFERENCED_TABLE_NAME: names.parent, REFERENCED_COLUMN_NAME: COLUMN_NAME, ORDINAL_POSITION: i+1, TABLE_SCHEMA: namespace, REFERENCED_TABLE_SCHEMA: mode() === 'cross-schema' ? 'elsewhere' : namespace }));
    else if (sql.includes('sys.indexes')) {
      rows = indexRows();
      if (sql.includes('i.is_primary_key AS IS_PRIMARY_KEY')) {
        rows = [...rows, ...[names.parent, ...(['pk-cover','disabled-pk','hash-pk','pk-gap'].includes(mode()) ? [names.child] : [])].flatMap((TABLE_NAME) => [names.a,names.b].map((COLUMN_NAME,i) => ({...flags,TABLE_NAME,INDEX_NAME:'PK',IS_PRIMARY_KEY:true,IS_UNIQUE:true,COLUMN_NAME,KEY_ORDINAL:mode()==='pk-gap' && i===1 ? 3 : i+1,IS_DISABLED:mode()==='disabled-pk',INDEX_TYPE:mode()==='hash-pk'?'NONCLUSTERED HASH':'CLUSTERED'})))];
      }
    }
    else throw Error('unexpected fixed catalog read');
    if (mode() === 'permuted') rows.reverse();
    return { recordset: rows };
  } }; }
}
module.exports = { ConnectionPool, events, until, release: (name) => holds.get(name)?.(), namespace, names };
`;

const probe = String.raw`
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [root, format, action] = process.argv.slice(2);
const path = join(root, format === 'esm' ? 'dist' : 'dist/cjs', 'cli');
const tools = await import(pathToFileURL(join(path, 'mssql-tools.js')));
const doctor = await import(pathToFileURL(join(path, 'mssql-doctor.js')));
const fixture = createRequire(import.meta.url)(join(root, '../mssql/index.cjs'));
const { events, names, namespace } = fixture;
const integrated = true;
const options = { engine: 'mssql', url: 'mssql://host/catalog', schema: namespace.toLowerCase(), include: [], exclude: [], migrationsDir: '.' };
const fk = (report) => report.checks.filter((c) => c.code === 'MSSQL_FK_CHILD_INDEX');
let observation;
const closes = () => events.filter((e) => e === 'close').length;
if (action === 'ownership') {
  const pool = tools.createMssqlToolPool(options.url, options.schema);
  const client = await pool.connect();
  const report = await doctor.collectMssqlDoctorReport(client);
  assert.equal(closes(), 0, 'collector released caller-owned connection');
  const again = await doctor.collectMssqlDoctorReport(client);
  assert.deepEqual(report, again);
  assert.throws(() => pool.query('SELECT caller_value'), /fixed catalog reads only/);
  assert.throws(() => client.query('DELETE caller_value'), /fixed catalog reads only/);
  await tools.releaseMssqlToolClient(client); await pool.end();
  assert.equal(closes(), 1);
  await assert.rejects(doctor.collectMssqlDoctorReport(client), /active owned catalog/);
  await assert.rejects(doctor.collectMssqlDoctorReport({ query() { throw Error('forged'); }, release() { throw Error('forged'); } }), /active owned catalog/);
} else if (action === 'flags') {
  for (const key of ['fix','unused','audit','metricsUrl','minScans','noConcurrently','noPlanDivergence','allowPooler']) {
    await assert.rejects(doctor.cmdMssqlDoctor({ command:'doctor', positional:[], [key]:true }, options), /does not support option/);
  }
  assert.equal(events.length, 0, 'flag refusal reached checkout');
} else if (action === 'pending-query') {
  process.env.DOCTOR_FIXTURE_MODE = 'query-pending';
  const pool = tools.createMssqlToolPool(options.url, options.schema); const client = await pool.connect();
  const read = doctor.collectMssqlDoctorReport(client); const rejected = assert.rejects(read, /catalog read failed/);
  await fixture.until('query-pending');
  await assert.rejects(doctor.collectMssqlDoctorReport(client), /already active/);
  const closing = tools.releaseMssqlToolClient(client);
  assert.equal(closes(), 0, 'release failed to await pending request');
  fixture.release('query'); await rejected; await closing; await pool.end(); assert.equal(closes(), 1);
} else if (action === 'pending-connect') {
  process.env.DOCTOR_FIXTURE_MODE = 'connect-pending';
  const pool = tools.createMssqlToolPool(options.url, options.schema); const opening = pool.connect();
  const rejected = assert.rejects(opening, /closed/);
  await fixture.until('connect-pending'); const ending = pool.end(); assert.equal(closes(), 0);
  fixture.release('connect'); await rejected; await ending; assert.equal(closes(), 1);
} else if (action === 'pending-pool') {
  process.env.DOCTOR_FIXTURE_MODE = 'query-pending';
  const pool = tools.createMssqlToolPool(options.url, options.schema); const client = await pool.connect();
  const read = assert.rejects(doctor.collectMssqlDoctorReport(client), /catalog read failed/);
  await fixture.until('query-pending'); const ending = pool.end(); assert.equal(closes(),0);
  fixture.release('query'); await read; await ending; assert.equal(closes(),1);
} else if (action === 'fault') {
  await assert.rejects(doctor.runMssqlDoctor(options), (e) => {
    assert.doesNotMatch(e.message, /endpoint-secret|literal-secret|cleanup-secret|mssql:\/\//);
    return /SQL Server catalog (?:connection|read)/.test(e.message);
  }); assert.equal(closes(), 1);
} else if (action === 'mcp') {
  const { runReadOnlyTool, startMcpServer } = await import(pathToFileURL(join(path,'mcp.js')));
  const caps = await runReadOnlyTool(options,'engine_capabilities');
  assert.equal(caps.tools.find((t) => t.name === 'doctor_report').implemented, true);
  assert.equal(caps.transport.transactions,false); assert.equal(events.length,0);
  for (const name of ['sample_rows','explain_query','table_stats','migrate_status']) await assert.rejects(runReadOnlyTool(options,name), /not implemented/);
  for(const args of [{sql:'DELETE secret'},{fix:true},'SELECT secret',[],null]) await assert.rejects(runReadOnlyTool(options,'doctor_report',args), /takes no arguments/);
  assert.equal(events.length,0,'refusal reached checkout');
  const report = await runReadOnlyTool(options,'doctor_report'); assert.equal(report.formatVersion,1); assert.equal(fk(report)[0].status,'pass'); assert.equal(closes(),1);
  const { PassThrough } = await import('node:stream'); const input = new PassThrough(); const output = new PassThrough();
  const replies=[]; output.on('data',(chunk)=>{ for(const line of chunk.toString().trim().split('\n')) replies.push(JSON.parse(line)); });
  const handle = startMcpServer(options,{input,output});
  input.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'doctor_report',arguments:{}}})+'\n');
  // Receipt, rather than a timer, controls shutdown during the real protocol request.
  await new Promise((resolve,reject)=>{ output.on('data',()=>{ if(replies.some((r)=>r.id===1)) resolve(); }); output.on('error',reject); });
  assert.equal(JSON.parse(replies.find((r)=>r.id===1).result.content[0].text).engine,'mssql');
  input.end(); await handle.dispose(); await handle.closed; assert.equal(closes(),2);
} else {
  const report = await doctor.runMssqlDoctor(options); observation = report;
  assert.equal(report.formatVersion,1); assert.equal(report.engine,'mssql'); assert.equal(report.ok,false);
  assert.equal(closes(),1); assert.equal(events.filter((e)=>e==='construct').length,1);
  for(const code of ['MSSQL_CATALOG_SCOPE','MSSQL_CATALOG_CONSISTENCY','MSSQL_RUNTIME_VERSION','MSSQL_MIGRATION_STATE']) assert.equal(report.checks.find((c)=>c.code===code).status,'unknown');
  assert.doesNotMatch(JSON.stringify(report), /default-secret|computed-secret|literal-secret|endpoint-secret|mssql:\/\//);
  const mode = process.env.DOCTOR_FIXTURE_MODE || '';
  if(mode==='empty') { assert.equal(report.checks.length,4); assert.equal(report.checks[0].observed.visibleTables,0); }
  else if(mode==='cross-schema') assert.equal(fk(report).length,0);
  else {
    assert.equal(fk(report).length,1); assert.deepEqual(fk(report)[0].observed.columns,['[Tenant]] Key]','[Id.Key]']);
    const eligible = ['', 'permuted', 'pk-cover','unique'].includes(mode) && integrated;
    assert.equal(fk(report)[0].status, eligible ? 'pass':'unknown', 'full ordered FK coverage differs');
    if(integrated && mode !== 'unknown-namespace') assert.equal(fk(report)[0].observed.namespace, '[MiX]]ed. Namespace]');
    if(['unique','disabled-unique'].includes(mode)) {
      const indexes=report.checks.find((c)=>c.code==='MSSQL_VISIBLE_KEYS' && c.observed.table==='[Order]] Child]').observed.indexes;
      assert.equal(indexes.length,1); assert.equal(indexes[0].unique,integrated?true:null);
    }
    const restrictions=report.checks.filter((c)=>c.code==='MSSQL_WRITE_RESTRICTIONS');
    assert.equal(restrictions.length,2); assert.ok(JSON.stringify(restrictions).includes('generatedReadOnly'));
    assert.ok(restrictions.some((c)=>c.observed.columns.some((x)=>x.identity===true)));
    assert.ok(restrictions.every((c)=>c.observed.columns.some((x)=>x.column==='[rv]' && x.generatedReadOnly===true)));
  }
}
console.log(JSON.stringify({action, mode:process.env.DOCTOR_FIXTURE_MODE || '',events,integrated,observation}));
`;

it('executes packed SQL Server doctor fixtures, lifecycle and integrated CLI/MCP', {
  timeout: 240_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-doctor-'));
  const integrated = true;
  const run = (command: string, args: string[], cwd = dir, extra: Record<string, string> = {}, expected = 0) => {
    const result = spawnSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, DATABASE_URL: '', MSSQL_URL: '', MSSQL_TEST_URL: '', ...extra },
    });
    assert.equal(result.status, expected, result.stdout + result.stderr + String(result.error ?? ''));
    return result;
  };
  try {
    const staging = join(dir, 'staging');
    mkdirSync(staging);
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    delete manifest.scripts;
    writeFileSync(join(staging, 'package.json'), JSON.stringify(manifest));
    for (const format of ['esm', 'cjs'])
      run(
        process.execPath,
        [
          join(repo, 'node_modules/typescript/bin/tsc'),
          '-p',
          join(repo, format === 'esm' ? 'tsconfig.json' : 'tsconfig.cjs.json'),
          '--outDir',
          join(staging, format === 'esm' ? 'dist' : 'dist/cjs'),
        ],
        repo,
      );
    mkdirSync(join(staging, 'scripts'));
    copyFileSync(join(repo, 'scripts/finish-cjs-build.mjs'), join(staging, 'scripts/finish-cjs-build.mjs'));
    run(process.execPath, [join(staging, 'scripts/finish-cjs-build.mjs')], staging);
    run('npm', ['pack', '--ignore-scripts', '--pack-destination', dir], staging);
    const archive = join(dir, `turbine-orm-${manifest.version}.tgz`);
    const modules = join(dir, 'node_modules');
    const installed = join(modules, 'turbine-orm');
    mkdirSync(installed, { recursive: true });
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', installed]);
    symlinkSync(join(repo, 'node_modules/pg'), join(modules, 'pg'), 'dir');
    mkdirSync(join(modules, 'mssql'));
    writeFileSync(join(modules, 'mssql/package.json'), '{"name":"mssql","version":"0.0.0","main":"index.cjs"}');
    writeFileSync(join(modules, 'mssql/index.cjs'), driver);
    const script = join(dir, 'probe.mjs');
    writeFileSync(script, probe);
    if (process.env.MSSQL_DOCTOR_ARTIFACT_DIR) {
      const dest = process.env.MSSQL_DOCTOR_ARTIFACT_DIR;
      mkdirSync(dest, { recursive: true });
      copyFileSync(archive, join(dest, 'package.tgz'));
      writeFileSync(
        join(dest, 'identity.json'),
        JSON.stringify(
          {
            sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
            node: process.version,
            integrated,
            source: repo,
          },
          null,
          2,
        ),
      );
    }
    for (const format of ['esm', 'cjs']) {
      await t.test(`${format} strict packed declarations`, () => {
        const consumer = join(dir, `consumer-${format}`);
        mkdirSync(consumer);
        const ext = format === 'esm' ? 'mts' : 'cts';
        const relative = format === 'esm' ? 'dist' : 'dist/cjs';
        writeFileSync(
          join(consumer, `usage.${ext}`),
          `
import { collectMssqlDoctorReport, runMssqlDoctor, type MssqlDoctorReport } from '../node_modules/turbine-orm/${relative}/cli/mssql-doctor.js';
const result: Promise<MssqlDoctorReport> = runMssqlDoctor({url:'mssql://host/catalog'});
if (false) {
  // @ts-expect-error report collection is asynchronous
  const wrong: MssqlDoctorReport = collectMssqlDoctorReport({} as never);
  // @ts-expect-error caller SQL is not an adapter option
  void runMssqlDoctor({url:'mssql://host/catalog',sql:'SELECT 1'});
  void wrong;
}
void result;
`,
        );
        writeFileSync(
          join(consumer, 'tsconfig.json'),
          JSON.stringify({
            compilerOptions: {
              module: 'NodeNext',
              moduleResolution: 'NodeNext',
              target: 'ES2023',
              strict: true,
              exactOptionalPropertyTypes: true,
              skipLibCheck: false,
              noEmit: true,
              types: ['node'],
              typeRoots: [join(repo, 'node_modules/@types')],
            },
            include: [`usage.${ext}`],
          }),
        );
        run(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')]);
      });
      let baseline: unknown;
      for (const mode of [
        '',
        'permuted',
        'filtered',
        'unique',
        'disabled-unique',
        'disabled',
        'hypothetical',
        'computed',
        'uncertain',
        'reversed',
        'prefix-only',
        'included-only',
        'ordinal-gap',
        'columnstore',
        'no-index',
        'pk-cover',
        'disabled-pk',
        'hash-pk',
        'pk-gap',
        'unknown-namespace',
        'empty',
        'cross-schema',
      ]) {
        await t.test(`${format} structural catalog ${mode || 'ordinary'}`, () => {
          const result = run(process.execPath, [script, installed, format, 'report'], dir, {
            DOCTOR_FIXTURE_MODE: mode,
          });
          const observed = JSON.parse(result.stdout).observation;
          if (mode === '') baseline = observed;
          if (mode === 'permuted') assert.deepEqual(observed, baseline, 'catalog row order changed report');
        });
      }
      for (const action of ['ownership', 'flags', 'pending-query', 'pending-connect', 'pending-pool'])
        await t.test(`${format} ${action}`, () => {
          run(process.execPath, [script, installed, format, action]);
        });
      for (const mode of ['connect-fail', 'query-fail', 'late-query-fail', 'close-fail', 'read-close-fail'])
        await t.test(`${format} ${mode}`, () => {
          run(process.execPath, [script, installed, format, 'fault'], dir, { DOCTOR_FIXTURE_MODE: mode });
        });
      if (integrated) {
        await t.test(`${format} actual MCP`, () => {
          run(process.execPath, [script, installed, format, 'mcp']);
        });
        const cli = join(installed, format === 'esm' ? 'dist/cli/index.js' : 'dist/cjs/cli/index.js');
        const common = ['--engine', 'mssql', '--url', 'mssql://host/catalog', '--schema', 'mix]ed. namespace'];
        await t.test(`${format} CLI MCP stdio process`, async () => {
          const child = spawn(process.execPath, [cli, 'mcp', ...common], {
            cwd: dir,
            env: { ...process.env, DATABASE_URL: '', DOCTOR_FIXTURE_MODE: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
          const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
          try {
            const answered = new Promise<void>((resolveAnswer, rejectAnswer) => {
              child.once('error', rejectAnswer);
              child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
                if (stdout.includes('\n')) resolveAnswer();
              });
              child.once('exit', () => {
                if (!stdout.includes('\n')) rejectAnswer(new Error(stderr || 'MCP exited before reply'));
              });
            });
            child.stderr.on('data', (chunk) => {
              stderr += chunk.toString();
            });
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: { name: 'doctor_report', arguments: {} },
              })}\n`,
            );
            await answered;
            const reply = JSON.parse(stdout.trim());
            assert.equal(reply.id, 7);
            assert.equal(JSON.parse(reply.result.content[0].text).engine, 'mssql');
            child.stdin.end();
            assert.equal(await exited, 0, stderr);
          } finally {
            clearTimeout(timer);
            if (child.exitCode === null) {
              child.kill('SIGKILL');
              await exited;
            }
          }
        });
        await t.test(`${format} actual CLI JSON and text`, () => {
          const json = JSON.parse(run(process.execPath, [cli, 'doctor', ...common, '--json']).stdout);
          assert.equal(json.engine, 'mssql');
          assert.equal(json.formatVersion, 1);
          assert.equal(json.checks.find((c: { code: string }) => c.code === 'MSSQL_FK_CHILD_INDEX').status, 'pass');
          assert.match(run(process.execPath, [cli, 'doctor', ...common]).stdout, /assessment incomplete/);
        });
        await t.test(`${format} actual CLI flags before driver`, () => {
          for (const flag of [
            '--fix',
            '--unused',
            '--audit',
            '--no-concurrently',
            '--no-plan-divergence',
            '--metrics-url',
            '--min-scans',
            '--allow-pooler',
          ]) {
            const result = run(
              process.execPath,
              [cli, 'doctor', ...common, flag, ...(['--metrics-url', '--min-scans'].includes(flag) ? ['1'] : [])],
              dir,
              { DOCTOR_FIXTURE_MODE: 'connect-fail' },
              1,
            );
            assert.match(result.stdout + result.stderr, /SQL Server doctor.*(?:does not support|accepts only)/);
            assert.doesNotMatch(result.stdout + result.stderr, /catalog connection failed/);
          }
        });
        await t.test(`${format} config conflict withholds endpoints on CLI and MCP`, async () => {
          const configDir = join(dir, `conflict-${format}`);
          mkdirSync(configDir);
          writeFileSync(
            join(configDir, 'turbine.config.mjs'),
            `export default ${JSON.stringify({
              ...optionsForConfig(),
              url: 'mssql://config_user:config_password@config.catalog.invalid/config_db',
            })};`,
          );
          writeFileSync(
            join(configDir, '.env'),
            'DATABASE_URL=mssql://env_user:env_password@env.catalog.invalid/env_db\n',
          );
          const withheld = /(?:env|config)(?:\.catalog\.invalid|_user|_password|_db)/;
          const result = run(process.execPath, [cli, 'doctor', '--json'], configDir);
          assert.equal(JSON.parse(result.stdout).engine, 'mssql');
          assert.match(result.stderr, /DATABASE_URL from \.env.*overriding/);
          assert.doesNotMatch(result.stdout + result.stderr, withheld, 'catalog CLI disclosed configured endpoints');
          const child = spawn(process.execPath, [cli, 'mcp'], {
            cwd: configDir,
            env: { ...process.env, DATABASE_URL: '', MSSQL_URL: '', MSSQL_TEST_URL: '', DOCTOR_FIXTURE_MODE: '' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
          const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
          try {
            const answered = new Promise<void>((resolveAnswer, rejectAnswer) => {
              child.once('error', rejectAnswer);
              child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
                if (
                  stdout
                    .split('\n')
                    .slice(0, -1)
                    .some((line) => line.trim())
                )
                  resolveAnswer();
              });
              child.once('exit', () => {
                if (
                  !stdout
                    .split('\n')
                    .slice(0, -1)
                    .some((line) => line.trim())
                )
                  rejectAnswer(new Error(stderr || 'MCP exited before reply'));
              });
            });
            child.stderr.on('data', (chunk) => {
              stderr += chunk.toString();
            });
            child.stdin.write(
              `${JSON.stringify({
                jsonrpc: '2.0',
                id: 9,
                method: 'tools/call',
                params: { name: 'doctor_report', arguments: {} },
              })}\n`,
            );
            await answered;
            const reply = JSON.parse(stdout.trim());
            assert.equal(reply.id, 9);
            assert.equal(JSON.parse(reply.result.content[0].text).engine, 'mssql');
            child.stdin.end();
            assert.equal(await exited, 0, stderr);
            assert.match(stderr, /DATABASE_URL from \.env.*overriding/);
            assert.doesNotMatch(stdout + stderr, withheld, 'catalog MCP disclosed configured endpoints');
          } finally {
            clearTimeout(timer);
            if (child.exitCode === null) {
              child.kill('SIGKILL');
              await exited;
            }
          }
        });
        await t.test(`${format} config-selected CLI`, () => {
          const configDir = join(dir, `config-${format}`);
          mkdirSync(configDir);
          writeFileSync(join(configDir, 'turbine.config.mjs'), `export default ${JSON.stringify(optionsForConfig())};`);
          const result = run(process.execPath, [cli, 'doctor', '--json'], configDir);
          assert.equal(JSON.parse(result.stdout).engine, 'mssql');
        });
      }
    }
    if (process.env.MSSQL_DOCTOR_CONTROL_DIR) {
      const dest = process.env.MSSQL_DOCTOR_CONTROL_DIR;
      mkdirSync(dest, { recursive: true });
      cpSync(installed, join(dest, 'package'), { recursive: true });
      cpSync(join(modules, 'mssql'), join(dest, 'mssql'), { recursive: true });
      if (!existsSync(join(dest, 'pg'))) symlinkSync(join(repo, 'node_modules/pg'), join(dest, 'pg'), 'dir');
      mkdirSync(join(dest, 'node_modules'), { recursive: true });
      for (const name of ['pg', 'mssql'])
        if (!existsSync(join(dest, 'node_modules', name)))
          symlinkSync(join(dest, name), join(dest, 'node_modules', name), 'dir');
      writeFileSync(join(dest, 'probe.mjs'), probe);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(existsSync(dir), false, 'packed fixture directory remains');
  }
});
function optionsForConfig() {
  return { engine: 'mssql', url: 'mssql://host/catalog', schema: 'mix]ed. namespace' };
}
