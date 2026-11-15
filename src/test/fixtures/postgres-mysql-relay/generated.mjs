import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { command } = await import(pathToFileURL(`${process.env.RELAY_REPO}/tooling/optional-pg-transports/harness.mjs`));
const { runWithShutdown } = await import(
  pathToFileURL(`${process.env.RELAY_REPO}/tooling/optional-pg-transports/run.mjs`)
);
const [format, output] = process.argv.slice(2),
  cwd = process.cwd();
const root = `${cwd}/generated-${process.env.PG_SCHEMA}-${format}`;
mkdirSync(root);
writeFileSync(`${root}/package.json`, JSON.stringify({ type: format === 'esm' ? 'module' : 'commonjs' }));
const report = { commands: [], format, strict: true, skipLibCheck: false };
await runWithShutdown(report, output, async (scope) => {
  const run = async (label, args) => {
    const out = await command(report, root, process.execPath, args, process.env, { scope, timeoutMs: 180000 });
    writeFileSync(`${root}/${label}.stdout`, out);
    writeFileSync(`${root}/${label}.stderr`, report.commands.at(-1).stderr);
    return out;
  };
  const cli = `${cwd}/node_modules/turbine-orm/dist/${format === 'cjs' ? 'cjs/' : ''}cli/index.js`;
  await run('pg-generate', [
    cli,
    'generate',
    '--url',
    process.env.DATABASE_URL,
    '--schema',
    process.env.PG_SCHEMA,
    '--out',
    './pg',
    '--no-timestamp',
  ]);
  const targetUrl = `mysql://root@127.0.0.1:${process.env.MYSQL_PORT}/${process.env.MYSQL_DATABASE}`;
  await run('mysql-generate', [cli, 'generate', '--engine', 'mysql', '--url', targetUrl, '--out', './mysql']);
  const source = `import assert from 'node:assert/strict';
import pg from 'pg';
import {turbine as source} from './pg/index.js';
import {turbine as target} from './mysql/index.js';
async function main(){
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,options:'-c search_path='+process.env.PG_SCHEMA,max:3,connectionTimeoutMillis:1000,query_timeout:3000,statement_timeout:2500});
const a=source({pool}), b=await target(${JSON.stringify(targetUrl)});
try{
 const rows=await a.outbox.findMany({where:{tenant:'exact'},select:{eventId:true,title:true,amount:true},orderBy:{position:'asc'},limit:2});
 const exact:{eventId:string;title:string|null;amount:string}[]=rows;
 const projection=await b.mailProjection.findMany({where:{tenant:'exact',consumer:process.env.SOURCE_HISTORY_ID+'_mail'},select:{delivered:true},limit:1});
 const count:number|undefined=projection[0]?.delivered;
 assert.equal(count,2); assert.equal(exact.length,2); assert.equal(exact[0]!.amount,'123456789012345678901234567890.123456789012');assert.equal(exact[1]!.title,null);
 if(false){
  // @ts-expect-error Decimal projection retains text.
  const rounded:{amount:number}[]=rows; void rounded;
  // @ts-expect-error Projected rows omit body.
  rows[0]!.body;
  // @ts-expect-error Projection count filters require numbers.
  await b.mailProjection.findMany({where:{delivered:'wrong'}});
  // @ts-expect-error Unknown generated column is refused.
  await a.outbox.findMany({select:{missing:true}});
 }
 console.log(JSON.stringify({generatedNative:true,count,exact}));
}finally{await a.disconnect();await b.disconnect();await pool.query('SELECT 1');await pool.end();}}
main().catch(error=>{console.error(error);process.exitCode=1});
`;
  writeFileSync(`${root}/use.ts`, source);
  const config = {
    compilerOptions: {
      strict: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: false,
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      esModuleInterop: true,
      types: ['node'],
      rootDir: '.',
      outDir: 'out',
    },
    include: ['use.ts', 'pg/**/*.ts', 'mysql/**/*.ts'],
  };
  writeFileSync(`${root}/tsconfig.json`, JSON.stringify(config));
  await run('strict', [`${cwd}/node_modules/typescript/bin/tsc`, '-p', 'tsconfig.json']);
  report.native = JSON.parse((await run('execute', ['out/use.js'])).trim());
  assert.equal(report.native.generatedNative, true);
  writeFileSync(`${root}/negative.ts`, source.replaceAll(/\s*\/\/ @ts-expect-error[^\n]*/g, ''));
  writeFileSync(
    `${root}/negative.json`,
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: { noEmit: true },
      include: ['negative.ts', 'pg/**/*.ts', 'mysql/**/*.ts'],
    }),
  );
  const rec = {
    label: 'negative',
    cwd: root,
    binary: process.execPath,
    args: [`${cwd}/node_modules/typescript/bin/tsc`, '-p', 'negative.json'],
  };
  report.commands.push(rec);
  const h = scope.spawn(rec.binary, rec.args, { cwd: root, env: process.env, deadlineMs: 180000 }, rec);
  let stdout = '',
    stderr = '';
  h.child.stdout.on('data', (b) => {
    stdout += b;
  });
  h.child.stderr.on('data', (b) => {
    stderr += b;
  });
  await h.closed;
  await h.stop();
  Object.assign(rec, { stdout, stderr });
  writeFileSync(`${root}/negative.stdout`, stdout);
  writeFileSync(`${root}/negative.stderr`, stderr);
  assert.equal(rec.code, 2, stdout + stderr);
  assert.equal((stdout.match(/error TS/g) ?? []).length, 4, stdout);
  report.negativeRefusals = 4;
});
