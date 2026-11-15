import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { mockTable } from './helpers.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const required = process.env.TURBINE_DRIVER_NEUTRAL_PACKED === '1';
const schema = {
  tables: {
    items: mockTable('items', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'label', field: 'label', pgType: 'text' },
      { name: 'tenant_id', field: 'tenantId', pgType: 'int4' },
    ]),
  },
  enums: {},
};

it('executes the actual packed subpath in ESM/CJS, strict consumers and an actual Worker runtime', {
  skip: required
    ? false
    : 'Set TURBINE_DRIVER_NEUTRAL_PACKED=1 after building; package/Worker prerequisites are required then.',
  timeout: 180000,
}, async () => {
  const runtimePath = process.env.DRIVER_NEUTRAL_MINIFLARE_MODULE;
  assert.ok(
    runtimePath && existsSync(runtimePath),
    'DRIVER_NEUTRAL_MINIFLARE_MODULE must name an actual installed Miniflare module.',
  );
  const temp = mkdtempSync(join(tmpdir(), 'core-packed-'));
  const commands: Array<{ command: string; args: string[]; output: string }> = [];
  const run = (command: string, args: string[], cwd: string) => {
    const output = execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 90000,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    commands.push({ command, args, output });
    return output;
  };
  let worker: { dispose(): Promise<void>; dispatchFetch(url: string): Promise<Response> } | undefined;
  try {
    const archive = process.env.TURBINE_CORE_D1_TARBALL;
    assert.ok(archive && existsSync(archive), 'A real packed archive is required. Use npm run test:core:packed.');
    const manifest = JSON.parse(run('tar', ['-xzOf', archive, 'package/package.json'], ROOT));
    const coreExport = {
      import: { types: './dist/core.d.ts', default: './dist/core.js' },
      require: { types: './dist/cjs/core.d.ts', default: './dist/cjs/core.js' },
    };
    assert.deepEqual(manifest.exports['./core'], coreExport, 'The tested archive must declare both export conditions.');
    assert.deepEqual(manifest.dependencies, { pg: '^8.15.0' }, 'Mandatory pg remains unchanged.');
    const consumer = join(temp, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(
      'npm',
      ['install', '--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund', archive, '@types/node@22.20.4'],
      consumer,
    );
    const library = join(consumer, 'node_modules/turbine-orm');
    assert.ok(existsSync(join(consumer, 'node_modules/pg/package.json')), 'Actual install retains mandatory pg.');
    writeFileSync(
      join(consumer, 'root-present.mjs'),
      "import {TurbineClient} from 'turbine-orm'; if(typeof TurbineClient!=='function')throw Error('missing default client');",
    );
    const runtimes = (process.env.DRIVER_NEUTRAL_NODE_BINARIES ?? process.execPath).split(',');
    for (const runtime of runtimes) run(runtime, ['root-present.mjs'], consumer);
    for (const name of ['pg', 'pg-pool', 'pg-protocol', 'pg-types', 'pg-connection-string', 'pgpass']) {
      rmSync(join(consumer, 'node_modules', name), { recursive: true, force: true });
    }
    assert.ok(!existsSync(join(consumer, 'node_modules/@types/pg')));
    writeFileSync(
      join(consumer, 'probe.mjs'),
      `
import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
for(const name of ['pg','pg-pool','pg-protocol','pg-types','pg-connection-string','pgpass','mysql2','mssql','@neondatabase/serverless','@libsql/client']){
 assert.throws(()=>require(name),{code:'MODULE_NOT_FOUND'});await assert.rejects(import(name),{code:'ERR_MODULE_NOT_FOUND'});
}
await assert.rejects(import('turbine-orm'),/Cannot find package 'pg'/);
assert.throws(()=>require('turbine-orm'),/Cannot find module 'pg'/);
const schema=${JSON.stringify(schema)};for(const table of Object.values(schema.tables))table.dateColumns=new Set();
for(const load of [()=>import('turbine-orm/core'),()=>Promise.resolve(require('turbine-orm/core'))]){
 const core=await load(),native=new DatabaseSync(':memory:');let closed=0;
 native.exec("CREATE TABLE items (id integer PRIMARY KEY,label text,tenant_id integer); INSERT INTO items VALUES (2,'two',7),(1,'one',7),(3,'hidden',8)");
 const statements=[];
 const pool={query:async(text,values=[])=>{statements.push([text,values]);const named={};values.forEach((v,i)=>{named[String(i+1)]=v});const rows=native.prepare(text).all(named).map(row=>({...row}));return{rows,rowCount:rows.length}},connect:async()=>{throw Error('unexpected checkout')},end:async()=>{closed++;native.close()}};
 const db=core.turbineCore(pool,schema,{ownership:'client',globalFilters:{items:{tenantId:7}},warnOnUnlimited:false});
 assert.deepEqual(await db.table('items').findMany({select:{id:true,label:true},orderBy:{id:'asc'},limit:2}),[{id:1,label:'one'},{id:2,label:'two'}]);
 assert.deepEqual(await db.rawUnsafe('UPDATE items SET label=$1 WHERE id=$2 RETURNING id,label','updated',2),[{id:2,label:'updated'}]);
 assert.deepEqual(await db.rawUnsafe('SELECT id,label FROM items ORDER BY id'),[{id:1,label:'one'},{id:2,label:'updated'},{id:3,label:'hidden'}]);
 let called=false;assert.throws(()=>db.$transaction(()=>{called=true}),{code:'TURBINE_E017'});assert.equal(called,false);
 await assert.rejects(db.table('items').findManyStream().next(),{code:'TURBINE_E017'});
 await db.end();await db.end();assert.equal(closed,1);assert.equal(statements.length,3);
}
process.stdout.write('packed ESM/CJS native SQLite supplied-pool probe passed; five unrelated drivers absent');
`,
    );
    for (const runtime of runtimes) {
      const output = run(runtime, ['probe.mjs'], consumer);
      assert.match(output, /packed ESM\/CJS native SQLite supplied-pool probe passed/);
    }
    const types = `import {turbineCore,type PgCompatPool,type SchemaMetadata,type CoreOptions} from 'turbine-orm/core';
declare const pool:PgCompatPool;declare const schema:SchemaMetadata;
const options:CoreOptions={ownership:'caller',warnOnUnlimited:false};const db=turbineCore(pool,schema,options);
const rows:Promise<{id:number}[]>=db.table<{id:number}>('items').findMany({limit:1});
const raw:Promise<{answer:number}[]>=db.raw<{answer:number}>\`SELECT \${42} AS answer\`;
void rows;void raw;void db.disconnect();
// @ts-expect-error a connection string is not a supplied pool.
turbineCore('postgres://example.invalid/test',schema);
// @ts-expect-error lifecycle ownership is explicit.
turbineCore(pool,schema,{ownership:'automatic'});
`;
    writeFileSync(join(consumer, 'consumer.mts'), types);
    writeFileSync(join(consumer, 'consumer.cts'), types);
    writeFileSync(
      join(consumer, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
        },
        include: ['consumer.mts', 'consumer.cts'],
      }),
    );
    run(join(ROOT, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], consumer);
    // A real omission control on the installed conditional export, isolated here.
    const installedMeta = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8'));
    delete installedMeta.exports['./core'];
    writeFileSync(join(library, 'package.json'), JSON.stringify(installedMeta));
    writeFileSync(
      join(consumer, 'omission.mjs'),
      "import assert from 'node:assert/strict';await assert.rejects(import('turbine-orm/core'),{code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});",
    );
    run(process.execPath, ['omission.mjs'], consumer);
    installedMeta.exports['./core'] = coreExport;
    writeFileSync(join(library, 'package.json'), JSON.stringify(installedMeta));
    // Worker runtime fixture, not a database/provider certification.
    const script = `import {turbineCore} from ${JSON.stringify(join(library, 'dist/core.js'))};
const schema=${JSON.stringify(schema)};for(const table of Object.values(schema.tables))table.dateColumns=new Set();
export default {async fetch(){let closed=0;const calls=[];const pool={query:async(text,values)=>{calls.push([text,values]);return{rows:[{id:2,label:'worker',tenant_id:7}],rowCount:1}},connect:async()=>{throw Error('unexpected checkout')},end:async()=>{closed++}};
const db=turbineCore(pool,schema,{warnOnUnlimited:false});const rows=await db.table('items').findMany({where:{id:2},limit:1});let refused=false;try{db.$transaction(()=>{throw Error('callback entered')})}catch(error){refused=error.code==='TURBINE_E017'}await db.disconnect();return Response.json({rows,calls,closed,refused});}};`;
    const bundle = await build({
      stdin: { contents: script, resolveDir: consumer },
      bundle: true,
      write: false,
      metafile: true,
      platform: 'neutral',
      format: 'esm',
      conditions: ['workerd', 'worker', 'browser'],
      external: ['node:async_hooks'],
    });
    const inputs = Object.keys(bundle.metafile.inputs);
    assert.ok(inputs.some((path) => path.endsWith('dist/core.js')));
    assert.ok(
      inputs.every(
        (path) =>
          !/(?:^|\/)pg(?:\/|-)/.test(path) &&
          !path.includes('node:sqlite') &&
          !path.includes('sqlite.js') &&
          !path.endsWith('client.js'),
      ),
    );
    const { Miniflare } = await import(pathToFileURL(runtimePath).href);
    worker = new Miniflare({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: '2026-07-30',
      compatibilityFlags: ['nodejs_als'],
    });
    const response = await worker!.dispatchFetch('http://localhost/');
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      rows: unknown;
      calls: Array<[string, unknown[]]>;
      closed: number;
      refused: boolean;
    };
    assert.deepEqual(body.rows, [{ id: 2, label: 'worker', tenantId: 7 }]);
    assert.deepEqual(body.calls[0]?.[1], [2, 1]);
    assert.equal(body.calls.length, 1);
    assert.equal(body.closed, 0);
    assert.equal(body.refused, true);
    const evidence = process.env.DRIVER_NEUTRAL_EVIDENCE_DIR;
    if (evidence) {
      writeFileSync(
        join(evidence, 'packed-evidence.json'),
        JSON.stringify(
          {
            archive,
            sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
            installedArchive: true,
            runtimeBinaries: runtimes,
            commands,
            worker: body,
            workerInputs: inputs,
            mandatoryDependencyUnchanged: manifest.dependencies,
            absenceControls: ['pg', 'mysql2', 'mssql', '@neondatabase/serverless', '@libsql/client'],
            fixture: temp,
          },
          null,
          2,
        ),
      );
    }
  } finally {
    try {
      await worker?.dispose();
    } finally {
      rmSync(temp, { recursive: true, force: true });
      assert.ok(!existsSync(temp));
    }
  }
});
