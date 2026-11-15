const assert=require('node:assert/strict');
const fs=require('node:fs');
const {QueryInterface}=require('turbine-orm');
function run(QueryInterface){
const cols=[{name:'id',field:'id',pgType:'int4',nullable:false,hasDefault:false,tsType:'number',isArray:false,pgArrayType:'int4[]'},{name:'sort_key',field:'sortKey',pgType:'int4',nullable:false,hasDefault:false,tsType:'number',isArray:false,pgArrayType:'int4[]'}];
const schema={tables:{items:{name:'items',columns:cols,columnMap:{id:'id',sortKey:'sort_key'},reverseColumnMap:{id:'id',sort_key:'sortKey'},allColumns:['id','sort_key'],pgTypes:{id:'int4',sort_key:'int4'},dialectTypes:{id:'int4',sort_key:'int4'},dateColumns:new Set(),primaryKey:['id'],uniqueColumns:[['id']],indexes:[],relations:{}}},enums:{}};
let accesses=0;const pool={query(){accesses++;throw Error('checkout')},connect(){accesses++;throw Error('checkout')}};
const q=new QueryInterface(pool,'items',schema,undefined,{preparedStatements:true});
const args={cursor:{sortKey:2,id:1},orderBy:{sortKey:'asc'},limit:4};
const a=q.buildFindMany(args),b=q.buildFindMany({...args,cursorPredicate:'lexicographic'}),c=q.buildFindMany({...args,cursorPredicate:'tuple'}),d=q.buildFindMany({...args,cursorPredicate:'tuple',cursor:{sortKey:3,id:8}});
assert.equal(a.sql,b.sql);assert.equal(a.preparedName,b.preparedName);assert.notEqual(c.preparedName,a.preparedName);assert.equal(d.sql,c.sql);assert.deepEqual(d.params,[3,8,4]);assert.match(c.sql,/\("items"\."sort_key", "items"\."id"\) > \(\$1, \$2\)/);assert.throws(()=>q.buildFindMany({...args,cursorPredicate:'tuple',cursor:{id:1}}),{code:'TURBINE_E003'});assert.equal(accesses,0);
assert.ok(!fs.existsSync(__dirname+'/node_modules/@types/pg'));
return {node:process.version,checks:9,fail:0,skip:0,cache:q.cacheStats()};
}
if(require.main===module) console.log(JSON.stringify(run(QueryInterface)));
module.exports={run};
