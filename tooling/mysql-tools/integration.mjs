/** Built ESM/CommonJS native tool integration; run with a disposable MYSQL_URL after npm run build. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { before, after, describe, it } from 'node:test';
const repo = process.env.MYSQL_TOOLS_REPO ?? process.cwd();
const require = createRequire(join(repo, 'package.json'));
const format = process.env.MYSQL_TOOLS_FORMAT === 'cjs' ? 'cjs/' : '';
const load = (file) => format ? Promise.resolve(require(join(repo, 'dist', format, file))) : import(pathToFileURL(join(repo, 'dist', file)));
const { runReadOnlyTool, startMcpServer } = await load('cli/mcp.js');
const { discoverToolCapabilities, toolSupported, toolEngine } = await load('cli/tool-capabilities.js');
const { runToolCommand } = await load('cli/tool-command.js');
const { generateMetadata } = await load('generate.js');
const { compileQueryPlan } = await load('cli/compile-query.js');
const { mysqlDialect, MysqlPool } = await load('mysql.js');
const { createMysqlToolPool, introspectMysqlToolClient } = await load('cli/mysql-tools.js');
const peer = require('mysql2/promise');
const original = peer.createConnection;
const db = `turbine_tools_${randomBytes(6).toString('hex')}`;
const root = mkdtempSync('/tmp/turbine-mysql-tools-integration-');
const endpoint = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL;
if (!endpoint && /(?:^|,)mysql(?:,|$)/.test(process.env.TURBINE_REQUIRE_ENGINE ?? '')) throw Error('MYSQL_URL is required for native MySQL tool integration tests');
const noDatabase = { engine: 'mysql', url: '', schema: '', migrationsDir: '' };
let admin, options;

function harness(options) {
 const input = new PassThrough(); const output = new PassThrough();
 const server = startMcpServer(options, { input, output }); let id=0;
 const rpc = (method, params) => new Promise(resolve => {
  output.once('data', chunk => resolve(JSON.parse(chunk.toString())));
  input.write(JSON.stringify({jsonrpc:'2.0', id:++id, method, params})+'\n');
 });
 return { rpc, call: (name, args={}) => rpc('tools/call',{name,arguments:args}), dispose: server.dispose };
}
const payload = reply => { assert.equal(reply.error,undefined,JSON.stringify(reply.error)); return JSON.parse(reply.result.content[0].text); };

before(async () => {
 if (!endpoint) return;
 const parsed = new URL(endpoint);
 admin = await original({ host:parsed.hostname, port:Number(parsed.port||3306),user:decodeURIComponent(parsed.username),password:decodeURIComponent(parsed.password) });
 await admin.query(`CREATE DATABASE \`${db}\``); await admin.query(`USE \`${db}\``);
 await admin.query('CREATE TABLE users(id INT PRIMARY KEY, display_name VARCHAR(100), email VARCHAR(100), api_key VARCHAR(100)) ENGINE=InnoDB');
 await admin.query('CREATE TABLE posts(id INT PRIMARY KEY, user_id INT REFERENCES users(id), title VARCHAR(100), FOREIGN KEY(user_id) REFERENCES users(id)) ENGINE=InnoDB');
 await admin.query("CREATE INDEX names_expression ON users((CONCAT(display_name,'private-index-literal')))");
 await admin.query("INSERT INTO users VALUES(1,'First','hidden@example.test','private-api-key'),(2,'Second','second@example.test','private-key-two')");
 await admin.query("INSERT INTO posts VALUES(1,1,'Actual post')");
 parsed.pathname='/'+db;
 options = { engine:'mysql',url:parsed.toString(),schema:db,migrationsDir:join(root,'migrations'),metadataDir:root };
 const pool = createMysqlToolPool(options.url,db); const client=await pool.connect();
 try {
  const metadata=await introspectMysqlToolClient(client);
  metadata.tables.users.columns.find(c=>c.name==='email').pii=true;
  writeFileSync(join(root,'metadata.ts'),generateMetadata(metadata,{noTimestamp:true}));
 } finally { client.release(); await pool.end(); }
});
after(async () => {
 try { if(admin) await admin.query(`DROP DATABASE \`${db}\``); } finally { await admin?.end(); rmSync(root,{recursive:true,force:true}); }
});

describe('integrated native MySQL CLI/MCP tools', () => {
 it('discovers only implemented operations without connecting or inventing transport facts', async t => {
  const spy=t.mock.method(peer,'createConnection',async()=>{throw Error('must not connect');});
  const facts=await runReadOnlyTool(noDatabase,'engine_capabilities');
  assert.equal(facts.engine,'mysql'); assert.equal(toolEngine('mysql'),'mysql');
  assert.equal(facts.databaseVersion,null); assert.equal(facts.connectivity,'not-probed');
  assert.equal(facts.transport.readOnlyEnforcement,'transaction-read-only-consistent-snapshot');
  assert.equal(facts.transport.pipeline,false); assert.equal(facts.transport.cursors,false);
  assert.equal(facts.transport.statementTimeout,false); assert.equal(facts.runtime.available,true);
  assert.deepEqual(facts.tools.filter(t=>t.implemented).map(t=>t.name).sort(),['schema_overview','table_detail','compile_query','sample_rows','relation_graph','find_join_path','explain_error','engine_capabilities','doctor_report'].sort());
  for(const name of ['migrate_status','explain_query','table_stats']) assert.equal(toolSupported('mysql',name),false);
  assert.equal((await runReadOnlyTool(noDatabase,'explain_error',{code:'E003'})).code,'TURBINE_E003');
  assert.equal(spy.mock.callCount(),0);
 });
 it('refuses unsupported commands, writes, locks, raw SQL and malformed config before connection', async t => {
  const spy=t.mock.method(peer,'createConnection',async()=>{throw Error('must not connect');});
  const target={...noDatabase,url:'mysql://reader@127.0.0.1:1/app',schema:'app'};
  for(const name of ['migrate_status','explain_query','table_stats']) await assert.rejects(runReadOnlyTool(target,name),/not implemented/);
  for(const args of [{table:'users',operation:'create'},{table:'users',args:{lock:'update'}},{table:'users',sql:'SELECT 1'}]) await assert.rejects(runReadOnlyTool(target,'compile_query',args));
  await assert.rejects(runReadOnlyTool({...target,include:'users'},'schema_overview'),/include/);
  await assert.rejects(runReadOnlyTool({...target,url:'postgres://host/app'},'schema_overview'),/mysql/);
  await assert.rejects(runToolCommand({command:'compile',subcommand:'[]',positional:[]},target),/JSON object/);
  assert.throws(()=>startMcpServer(target,{pool:{}}),/injected pool/);
  assert.equal(spy.mock.callCount(),0);
 });
 it('preserves the existing PostgreSQL and SQLite effective discovery facts', () => {
  const pg=discoverToolCapabilities('postgresql'), sqlite=discoverToolCapabilities('sqlite');
  assert.equal(pg.transport.kind,'pg-pool'); assert.equal(pg.transport.readOnlyEnforcement,'transaction-read-only');
  assert.equal(sqlite.transport.kind,'node:sqlite'); assert.equal(sqlite.transport.readOnlyEnforcement,'database-open-read-only');
  assert.equal(pg.tools.filter(t=>t.implemented).length,12); assert.equal(sqlite.tools.filter(t=>t.implemented).length,9);
 });
 it('serves schema and PII-safe samples through actual shared handlers', {skip:!endpoint && 'MYSQL_URL unavailable'}, async () => {
  const overview=await runToolCommand({command:'schema',positional:[]},options);
  assert.equal(overview.tables.length,2); assert.ok(overview.tables.every(t=>t.estimatedRows===null));
  const detail=await runReadOnlyTool(options,'table_detail',{table:'users'});
  assert.equal(detail.indexes.length,1); assert.equal(detail.indexes[0].columnsWithheld,true);
  assert.doesNotMatch(JSON.stringify(detail),/private-index-literal|hidden@example|private-api/);
  const sample=await runReadOnlyTool(options,'sample_rows',{table:'users',limit:2});
  assert.equal(sample.rowCount,2); assert.equal(sample.piiTagSource.state,'ok');
  assert.deepEqual(sample.redactedColumns.sort(),['api_key','email']);
  assert.deepEqual(sample.rows.map(r=>r.display_name).sort(),['First','Second']);
  assert.doesNotMatch(JSON.stringify(sample),/hidden@example|private-api|second@example|private-key-two/);
  assert.ok(sample.rows.every(r=>r.email.includes('redacted') && r.api_key.includes('redacted')));
 });
 it('compiles native SQL without executing it, using shared PII and read-operation guards', {skip:!endpoint && 'MYSQL_URL unavailable'}, async t => {
  const statements=[];
  t.mock.method(peer,'createConnection',async config=>{
   const conn=await original(config); const execute=conn.execute.bind(conn),query=conn.query.bind(conn);
   conn.execute=async(sql,...args)=>{statements.push(sql);return execute(sql,...args);};
   conn.query=async(sql,...args)=>{statements.push(sql);return query(sql,...args);}; return conn;
  });
  const report=await runReadOnlyTool(options,'compile_query',{table:'users',args:{select:{id:true,displayName:true},where:{id:1},limit:1}});
  assert.equal(report.ok,true); assert.equal(report.executed,false); assert.match(report.sql,/`users`/); assert.match(report.sql,/:p1/);
  assert.doesNotMatch(report.sql,/\$\d|::/); assert.equal(report.preparedStatement.named,false);
  assert.ok(statements.length>3); assert.ok(!statements.some(sql=>/FROM\s+`users`/i.test(sql)));
  assert.ok(statements.some(sql=>/START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/.test(sql)));
  assert.ok(!statements.some(sql=>/set_config|BEGIN READ ONLY/.test(sql)));
  await assert.rejects(runReadOnlyTool(options,'compile_query',{table:'users',args:{where:{apiKey:'guess'}}}),/hidden|secret/i);
  await assert.rejects(runReadOnlyTool(options,'compile_query',{table:'users',args:{where:{email:'guess'}}}),/PII|hidden/i);
  const invalid=await runReadOnlyTool(options,'compile_query',{table:'users',args:{where:{notAColumn:1}}});
  assert.equal(invalid.ok,false); assert.equal(invalid.error.code,'TURBINE_E003');
 });
 it('uses native dialect SQL for relation compilation and index advice', {skip:!endpoint && 'MYSQL_URL unavailable'}, async () => {
  const pool=createMysqlToolPool(options.url,db);const client=await pool.connect();let metadata;
  try { metadata=await introspectMysqlToolClient(client); } finally { client.release();await pool.end(); }
  const relation=Object.values(metadata.tables.users.relations).find(r=>r.to==='posts');assert.ok(relation);
  metadata.tables.posts.indexes=[];
  const report=compileQueryPlan({metadata,table:metadata.tables.users,operation:'findMany',args:{where:{id:1},with:{[relation.name]:true},relationLoadStrategy:'join'},dialect:mysqlDialect});
  assert.equal(report.ok,true);assert.equal(report.plan.relations.length,1);
  assert.match(report.plan.relations[0].unindexedProbe.createSql,/CREATE INDEX `idx_posts_user_id` ON `posts` \(`user_id`\)/);
  const raw=peer.createPool({uri:options.url,namedPlaceholders:true});const executor=new MysqlPool(raw);
  try {
   const result=await executor.query(report.sql,report.params);assert.equal(result.rows.length,1);
   const nested=result.rows[0][relation.name];const children=typeof nested==='string'?JSON.parse(nested):nested;
   assert.equal(children.length,1);assert.equal(children[0].title,'Actual post');
  } finally { await executor.end(); }
 });
 it('fails closed on unreadable PII metadata without exposing stored values', {skip:!endpoint && 'MYSQL_URL unavailable'}, async () => {
  const dir=mkdtempSync('/tmp/turbine-mysql-tools-tags-');
  try {
   writeFileSync(join(dir,'metadata.ts'),'export const metadata = unknownFunction();');
   const target={...options,metadataDir:dir};
   const sample=await runReadOnlyTool(target,'sample_rows',{table:'users',limit:1});
   assert.equal(sample.piiTagSource.state,'tags-unreadable'); assert.equal(sample.redactedColumns.length,4);
   assert.doesNotMatch(JSON.stringify(sample.rows),/First|hidden@example|private-api/);
   await assert.rejects(runReadOnlyTool(target,'compile_query',{table:'users',args:{where:{id:1}}}),/unreadable|PII/i);
  } finally { rmSync(dir,{recursive:true,force:true}); }
 });
 it('uses actual stdio MCP discovery, async introspection, refusal and disposal', {skip:!endpoint && 'MYSQL_URL unavailable'}, async () => {
  const h=harness(options);
  try {
   const list=await h.rpc('tools/list'); assert.equal(list.result.tools.length,9);
   assert.ok(!list.result.tools.some(t=>t.name==='explain_query'));
   const overview=payload(await h.call('schema_overview')); assert.equal(overview.tables.length,2);
   assert.equal((await h.call('explain_query',{sql:'DROP TABLE users'})).error.code,-32602);
   const graph=payload(await h.call('relation_graph')); assert.ok(JSON.stringify(graph).includes('posts'));
  } finally { await h.dispose(); }
  const [rows]=await admin.query('SELECT COUNT(*) AS n FROM users'); assert.equal(rows[0].n,2);
 });
 it('runs actual JSON CLI commands with no PostgreSQL fallback', {skip:!endpoint && 'MYSQL_URL unavailable'}, () => {
  for(const args of [ ['capabilities'], ['schema'], ['compile','{"table":"users","args":{"where":{"id":1},"limit":1}}'] ]) {
   const child=spawnSync(process.execPath,[join(repo,'dist',format,'cli/index.js'),...args,'--engine','mysql','--url',options.url,'--out',root],{cwd:root,encoding:'utf8',env:{...process.env,DATABASE_URL:'',NO_COLOR:'1'}});
   assert.equal(child.status,0,child.stderr); const answer=JSON.parse(child.stdout);
   if(args[0]==='schema') assert.equal(answer.tables.length,2);
   if(args[0]==='compile') { assert.equal(answer.ok,true); assert.equal(answer.executed,false); assert.match(answer.sql,/`users`/); }
   if(args[0]==='capabilities') assert.equal(answer.engine,'mysql');
  }
 });
});
