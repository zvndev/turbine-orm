import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createConnection} from 'node:net';
import {createHash} from 'node:crypto';
const root=process.cwd(), require=createRequire(join(root,'package.json'));
const pg=require('pg');
const driver=require.resolve('pg/package.json'), lock=JSON.parse(readFileSync(join(root,'package-lock.json')));
assert.equal(require('pg/package.json').version,lock.packages['node_modules/pg'].version);
const api=await import(pathToFileURL(process.env.TUPLE_API??join(root,'src/index.ts')).href);
const {ownedPostgres}=await import(pathToFileURL(join(root,'tooling/native-consumer-contracts/postgres-service.mjs')).href);
const out=process.env.TUPLE_REPORT;assert.ok(out);
const report={status:'running',producerPid:process.pid,execPath:process.execPath,node:process.version,api:process.env.TUPLE_API??'source',driver,driverVersion:require('pg/package.json').version,services:[],commands:[],checks:[],pages:[],plans:[],prepared:[],failures:[]};
const serviceRoot=mkdtempSync('/tmp/turbine-pg-tuple-owned-'),pids=new Set();report.serviceRoot=serviceRoot;
let stop,service,pool,signal;
for(const name of ['SIGTERM','SIGINT'])process.on(name,()=>{signal??=name;});
const checkpoint=()=>{if(signal)throw Error('Received '+signal);};
const check=(name,fn)=>{checkpoint();fn();report.checks.push(name);};
const hash=s=>createHash('sha256').update(typeof s==='string'?s:JSON.stringify(s)).digest('hex');
const take=(...args)=>{const r=spawnSync(...args);report.commands.push({command:args[0],args:args[1],status:r.status,stdout:r.stdout,stderr:r.stderr});assert.equal(r.status,0,r.stderr);};
try{
 service=await ownedPostgres({root:serviceRoot,env:{...process.env,PG_PREFIX:process.env.PG_PREFIX},run:(cwd,cmd,args)=>take(cmd,args,{cwd,env:process.env,encoding:'utf8'}),driver:pg,report,registerStop:fn=>{stop=fn;}});
 pids.add(report.services[0].pid);pids.add(service.client.processID);
 report.processGroup=Number(spawnSync('ps',['-o','pgid=','-p',String(report.services[0].pid)],{encoding:'utf8'}).stdout.trim());
 const proc=spawnSync('ps',['-eo','pid=,ppid='],{encoding:'utf8'}).stdout.split('\n').map(s=>s.trim().split(/\s+/).map(Number));
 for(const [pid,parent] of proc) if(parent===report.services[0].pid)pids.add(pid);
 const client=service.client;
 report.durability=(await client.query("SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes') ORDER BY name")).rows;
 assert.equal(report.durability.length,3);for(const setting of report.durability)assert.equal(setting.setting,'on');
 await new Promise((resolve,reject)=>{
 const args=['--import','tsx','--test','--test-reporter=tap','src/test/cursor-tuple.integration.test.ts'];
 const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,DATABASE_URL:service.url,TURBINE_REQUIRE_ENGINE:'postgres'},stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
 child.on('error',reject);child.on('close',(status)=>{report.commands.push({command:process.execPath,args,status,stdout,stderr});status===0 && /# tests 3\b/.test(stdout) && /# pass 3\b/.test(stdout) && /# fail 0\b/.test(stdout) && /# skipped 0\b/.test(stdout) ? resolve() : reject(Error('dedicated native integration failed: '+stdout+stderr));});
 });
 report.checks.push('dedicated native integration suite: 3 pass, 0 fail, 0 skip');
 if (process.env.TUPLE_EXTRA_NATIVE === '1') {
   const args=['--import','tsx','--test','--test-reporter=tap','src/test/option-behavior.integration.test.ts','src/test/aggregate-bigint-precision.integration.test.ts'];
   await new Promise((resolve,reject)=>{
     const child=spawn(process.execPath,args,{cwd:root,env:{...process.env,DATABASE_URL:service.url,TURBINE_REQUIRE_ENGINE:'postgres'},stdio:['ignore','pipe','pipe']});
     let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
     child.on('error',reject);child.on('close',status=>{
       const result={command:process.execPath,args,status,stdout,stderr};report.additionalSuites=result;
       if(status===0 && /# pass [1-9][0-9]*/.test(stdout) && /# fail 0/.test(stdout) && /# skipped 0/.test(stdout))resolve();
       else reject(Error('additional native behavior suites failed: '+stdout+stderr));
     });
   });
 }

 await client.query('CREATE TABLE items (id int PRIMARY KEY, sort_key int NOT NULL, tenant_id int NOT NULL); CREATE INDEX items_order ON items(sort_key,id); CREATE INDEX items_bucket_order ON items(tenant_id,sort_key,id); CREATE TABLE children (id int PRIMARY KEY,item_id int NOT NULL REFERENCES items(id));');
 if (process.env.TUPLE_TOOLS_PACKAGE) {
   const {tupleTools}=await import(pathToFileURL(join(root,'tooling/cursor-tuple/tools.mjs')).href);
   await client.query("SELECT 'tuple_tools_begin'");
   report.tools=await tupleTools(process.env.TUPLE_TOOLS_PACKAGE,service.url);
   await client.query("SELECT 'tuple_tools_end'");
   assert.equal(report.tools.status,'passed',JSON.stringify(report.tools.failure));
 }
 const n=24000;
 await client.query('INSERT INTO items SELECT g,(g*37)%500,g%7 FROM generate_series(1,$1) g',[n]);
 await client.query('INSERT INTO children SELECT g,g FROM generate_series(1,100) g');
 await client.query('VACUUM ANALYZE items');
 const {mockTable}=await import(pathToFileURL(join(root,'src/test/helpers.ts')).href);
 const meta={tables:{items:mockTable('items',[{name:'id',field:'id',pgType:'int4'},{name:'sort_key',field:'sortKey',pgType:'int4'},{name:'tenant_id',field:'tenantId',pgType:'int4'}],{children:{name:'children',type:'hasMany',from:'items',to:'children',foreignKey:'item_id',referenceKey:'id'}}),children:mockTable('children',[{name:'id',field:'id',pgType:'int4'},{name:'item_id',field:'itemId',pgType:'int4'}])},enums:{}};
 const rows=Array.from({length:n},(_,i)=>({id:i+1,sortKey:((i+1)*37)%500,tenantId:(i+1)%7}));
 pool=new pg.Pool({connectionString:service.url,max:1});
 const db=new api.TurbineClient({pool,preparedStatements:true,relationLoadStrategy:'join'},meta), q=db.table('items');
 for(const spec of [{name:'deep-asc',desc:false,multi:false,pos:18003},{name:'deep-desc',desc:true,multi:false,pos:18003},{name:'three-key',desc:false,multi:true,pos:15003},{name:'tail',desc:false,multi:false,pos:n-3},{name:'empty',desc:false,multi:false,pos:n-1}]){
   const fields=spec.multi?['tenantId','sortKey','id']:['sortKey','id'];const dir=spec.desc?-1:1;
   const sorted=[...rows].sort((a,b)=>{for(const f of fields){if(a[f]!==b[f])return dir*(a[f]-b[f]);}return 0;});
   const cursor=Object.fromEntries(fields.map(f=>[f,sorted[spec.pos][f]])), expected=sorted.slice(spec.pos+1,spec.pos+12);
   const args={cursor,orderBy:fields.slice(0,-1).map(f=>({[f]:spec.desc?'desc':'asc'})),limit:11};
   const arms={};for(const mode of ['lexicographic','tuple']){
     const d=q.buildFindMany({...args,cursorPredicate:mode});
     const actual=await q.findMany({...args,cursorPredicate:mode});
     check(spec.name+' '+mode+' exact',()=>assert.deepEqual(actual,expected));
     arms[mode]={sql:d.sql,params:d.params,rows:actual,hash:hash(actual),preparedName:d.preparedName};
     const plan=(await client.query('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) '+d.sql,d.params)).rows[0]['QUERY PLAN'];
     report.plans.push({case:spec.name,mode,sql:d.sql,params:d.params,plan});
   }
   check(spec.name+' parity',()=>assert.equal(arms.tuple.hash,arms.lexicographic.hash));
   const lookupOrder=fields.map(f=>`"${meta.tables.items.columnMap[f]}" ${spec.desc?'DESC':'ASC'}`).join(', ');
   const lookupSql=`SELECT id,sort_key,tenant_id FROM items ORDER BY ${lookupOrder} LIMIT 1 OFFSET $1`;
   const t0=performance.now(), located=(await client.query(lookupSql,[spec.pos])).rows[0],t1=performance.now();
   const locatedCursor=Object.fromEntries(fields.map(f=>[f,located[meta.tables.items.columnMap[f]]]));
   check(spec.name+' located cursor',()=>assert.deepEqual(locatedCursor,cursor));
   const locatedPage=await q.findMany({...args,cursor:locatedCursor,cursorPredicate:'tuple'}),t2=performance.now();
   check(spec.name+' located page',()=>assert.deepEqual(locatedPage,expected));
   report.pages.push({case:spec.name,cursor,expected,arms,charges:{suppliedQueries:1,locatedQueries:2,suppliedRows:expected.length,locatedRows:expected.length+1,lookupSql,lookupParams:[spec.pos],lookupMs:t1-t0,lookupInclusiveMs:t2-t0,diagnosticOnly:true}});
 }
 const walk=(p)=>[p,...(p.Plans??[]).flatMap(walk)];
 const tupleDeep=report.plans.find(p=>p.case==='deep-asc'&&p.mode==='tuple'),lexDeep=report.plans.find(p=>p.case==='deep-asc'&&p.mode==='lexicographic');
 check('native tuple index start',()=>assert.ok(walk(tupleDeep.plan[0].Plan).some(p=>(p['Index Cond']??'').includes('ROW('))));
 check('expanded OR remains filter',()=>assert.ok(walk(lexDeep.plan[0].Plan).some(p=>(p.Filter??'').includes('OR'))));
 const args={cursor:{sortKey:10,id:20},orderBy:{sortKey:'asc'},cursorPredicate:'tuple',limit:7};
 const relArgs={...args,with:{children:true},jsonEncoding:'object'};
 const relationTuple=await q.findMany(relArgs),relationLex=await q.findMany({...relArgs,cursorPredicate:'lexicographic'});check('relations output',()=>assert.deepEqual(relationTuple,relationLex));
 const gdb=new api.TurbineClient({pool,globalFilters:{items:{tenantId:3},children:{id:{gt:10}}},relationLoadStrategy:'join'},meta);
 const gfArgs={...args,with:{children:true},where:{id:{gt:100}}};
 const gfExpected=[...rows].sort((a,b)=>a.sortKey-b.sortKey||a.id-b.id).filter(r=>r.tenantId===3&&r.id>100&&(r.sortKey>10||r.sortKey===10&&r.id>20)).slice(0,7).map(r=>({...r,children:[]}));
 const gfActual=await gdb.table('items').findMany(gfArgs);check('global filter exact values',()=>assert.deepEqual(gfActual,gfExpected));
 await client.query('CREATE TABLE pairs (tenant_id int NOT NULL, seq int NOT NULL, sort_key int NOT NULL, PRIMARY KEY(tenant_id,seq)); INSERT INTO pairs SELECT g%3,g,(g*7)%11 FROM generate_series(1,100) g');
 const pairMeta={tables:{pairs:mockTable('pairs',[{name:'tenant_id',field:'tenantId',pgType:'int4'},{name:'seq',field:'seq',pgType:'int4'},{name:'sort_key',field:'sortKey',pgType:'int4'}],{},['tenant_id','seq'])},enums:{}};
 const pairs=Array.from({length:100},(_,i)=>({tenantId:(i+1)%3,seq:i+1,sortKey:((i+1)*7)%11})).sort((a,b)=>a.sortKey-b.sortKey||a.tenantId-b.tenantId||a.seq-b.seq);
 const pairQ=new api.QueryInterface(pool,'pairs',pairMeta,undefined,{preparedStatements:true});
 const pairArgs={cursorPredicate:'tuple',cursor:pairs[70],orderBy:{sortKey:'asc'},limit:9};
 const pairBuilt=pairQ.buildFindMany(pairArgs);report.composite={sql:pairBuilt.sql,params:pairBuilt.params,expected:pairs.slice(71,80)};
 const pairActual=await pairQ.findMany(pairArgs);check('composite exact values',()=>assert.deepEqual(pairActual,report.composite.expected));
 const stream=[];for await(const row of q.findManyStream({...args,batchSize:2}))stream.push(row);
 const plain=await q.findMany(args);
 const anchor=rows[19],rowArgs={cursor:{id:20},orderBy:{sortKey:'asc'},limit:7};
 const rowExpected=[...rows].sort((a,b)=>a.sortKey-b.sortKey||a.id-b.id).filter(r=>r.sortKey>anchor.sortKey||r.sortKey===anchor.sortKey&&r.id>anchor.id).slice(0,7);
 const rowBuilt=q.buildFindMany(rowArgs),rowLexBuilt=q.buildFindMany({...rowArgs,cursorPredicate:'lexicographic'});
 const rowPage=await q.findMany(rowArgs),rowLex=await q.findMany({...rowArgs,cursorPredicate:'lexicographic'});
 const rowMissing=await q.findMany({...rowArgs,cursor:{id:n+1}});
 report.defaultRowCursor={sql:rowBuilt.sql,params:rowBuilt.params,name:rowBuilt.preparedName,expected:rowExpected,actual:rowPage,missing:rowMissing};
 check('stream canonical page',()=>{
   assert.deepEqual(stream,plain);assert.deepEqual(rowPage,rowExpected);assert.deepEqual(rowLex,rowExpected);assert.deepEqual(rowMissing,[]);
   assert.equal(rowBuilt.sql,rowLexBuilt.sql);assert.deepEqual(rowBuilt.params,rowLexBuilt.params);assert.equal(rowBuilt.preparedName,rowLexBuilt.preparedName);
 });
 const batches=[];for await(const batch of q.findManyStreamBatches({...args,batchSize:2}))batches.push(...batch);
 check('batch stream canonical page',()=>assert.deepEqual(batches,plain));
 const tx=await db.$transaction(async tx=>tx.table('items').findMany(args));check('transaction',()=>assert.deepEqual(tx,plain));
 const piped=await db.pipeline([q.buildFindMany(args)]);check('pipeline',()=>assert.deepEqual(piped,[plain]));
 const backendRows=await client.query("SELECT pid FROM pg_stat_activity WHERE datname='postgres'");backendRows.rows.forEach(r=>pids.add(r.pid));
 await pool.end();pool=undefined;
 for(const planMode of ['force_custom_plan','force_generic_plan']){
   pool=new pg.Pool({connectionString:service.url,max:1,options:'-c plan_cache_mode='+planMode});
   const pq=new api.QueryInterface(pool,'items',meta,undefined,{preparedStatements:true});
   const backend=(await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;pids.add(backend);
   const names=[];
   for(const mode of ['lexicographic','tuple']){
     const pargs={...args,cursorPredicate:mode};const d=pq.buildFindMany(pargs);
     assert.ok(d.preparedName);names.push(d.preparedName);
     for(let i=0;i<8;i++)assert.deepEqual(await pq.findMany(pargs),plain);
     const observed=(await pool.query('SELECT name,statement,generic_plans::int,custom_plans::int FROM pg_prepared_statements WHERE name=$1',[d.preparedName])).rows;
     check(planMode+' '+mode+' observed prepared statement',()=>{assert.equal(observed.length,1);assert.equal(observed[0].statement,d.sql);assert.equal(observed[0].generic_plans,planMode==='force_generic_plan'?8:0);assert.equal(observed[0].custom_plans,planMode==='force_custom_plan'?8:0);});
     report.prepared.push({backend,mode,planMode,expectedExecutions:8,...observed[0]});
   }
   assert.notEqual(names[0],names[1]);await pool.end();pool=undefined;
 }
 report.processObservations=spawnSync('ps',['-eo','pid=,ppid=,pgid=,sid=,args='],{encoding:'utf8'}).stdout.split('\n').map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);return m?{pid:+m[1],ppid:+m[2],pgid:+m[3],sid:+m[4],args:m[5]}:null;}).filter(p=>p&&(pids.has(p.pid)||p.ppid===report.services[0].pid||p.pid===process.pid));
 checkpoint();report.status='passed';
}catch(error){report.status='failed';report.failures.push({message:error.message,stack:error.stack});}
finally{
 try{await pool?.end();}catch(e){report.failures.push({message:'pool cleanup: '+e.message});}
 try{await stop?.();}catch(e){report.failures.push({message:'service cleanup: '+e.message});}
 if(report.services[0]?.log){
   report.serverLogPath=out+'.server.log';writeFileSync(report.serverLogPath,report.services[0].log);
   const log=report.services[0].log;
   if(report.tools){
     const begin=log.indexOf("statement: SELECT 'tuple_tools_begin'"),end=log.indexOf("statement: SELECT 'tuple_tools_end'");
     const wire=log.slice(begin,end);
     report.tools.wire=wire;
     report.tools.wireCompilationOnly=begin>=0 && end>begin && !/\b(?:FROM|JOIN)\s+(?:"?public"?\.)?"?items"?\b/i.test(wire);
     if(!report.tools.wireCompilationOnly)report.failures.push({message:'CLI/MCP compilation sent page SQL or lacks wire markers'});
   }

   for(const p of report.prepared){p.serverExecutions=log.split('\n').filter(l=>l.includes(`[${p.backend}]`)&&l.includes(`execute ${p.name}: ${p.statement}`)).length;if(p.serverExecutions!==p.expectedExecutions)report.failures.push({message:'server prepared execution mismatch',observation:p});}
   delete report.services[0].log;
 }
 for(const pid of pids){try{process.kill(pid,0);report.failures.push({message:'Owned pid remains '+pid});}catch(e){if(e.code!=='ESRCH')report.failures.push({message:'PID observation '+e.message});}}
 const port=report.services[0]?.port;
 const portClosed=await new Promise(resolve=>{if(!port)return resolve(true);const c=createConnection({host:'127.0.0.1',port});c.once('connect',()=>{c.destroy();resolve(false)});c.once('error',()=>resolve(true));});
 if(!portClosed)report.failures.push({message:'Owned port remains open'});
 try{rmSync(serviceRoot,{recursive:true,force:true});}catch(e){report.failures.push({message:'filesystem cleanup '+e.message});}
 report.cleanup={pids:[...pids],processesAbsent:!report.failures.some(f=>f.message.startsWith('Owned pid')),portClosed,rootAbsent:!existsSync(serviceRoot),datadirAbsent:!existsSync(join(serviceRoot,'data')),socketAbsent:!existsSync(join(serviceRoot,'socket'))};
 if(signal)report.failures.push({message:'Late interruption '+signal});
 if(report.failures.length)report.status='failed';
 report.totals={pass:report.checks.length,fail:report.failures.length,skip:0};
 writeFileSync(out,JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({status:report.status,totals:report.totals,out,cleanup:report.cleanup}));
 process.exitCode=report.status==='passed'?0:1;
}
