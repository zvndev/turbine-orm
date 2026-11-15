import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { emittedClosure, facadeFiles, mysqlHelperEdges, mysqlPins, profileManifest } from './profiles/contract.mjs';
const original = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url)));
const root = { '.': { import: { types:'./dist/main.d.ts',default:'./dist/main.js' },require:{types:'./dist/main.d.ts',default:'./dist/main.js'} } };
const available = code => ({'dist/main.js':Buffer.from(code),'dist/main.d.ts':Buffer.from('export {};')});
test('MySQL manifest is exact and leaves prior profiles dependency-free',()=>{
  const mysql=profileManifest(original,'mysql');
  assert.deepEqual(mysql.dependencies,{mysql2:'3.24.6'}); assert.deepEqual(Object.keys(mysql.exports),['.','./mysql','./sql']); assert.equal(mysql.bin,undefined);
  assert.equal(mysql.peerDependenciesMeta.pg.optional,true);
  for(const profile of ['d1','sqlite']) assert.deepEqual(profileManifest(original,profile).dependencies,{});
  assert.match(facadeFiles('mysql')['dist/profile.d.ts'].toString(),/export type \* from '.\/index.js'/);
});
test('MySQL externals are finite and never admitted to D1 or SQLite',()=>{
  for(const name of ['mysql2','mysql2/promise','mysql2/package.json']){
    assert.ok(emittedClosure(available(`import '${name}';`),{name:'turbine-orm-mysql-runtime-stage',exports:root},ts).external.includes(name));
    for(const profile of ['d1','sqlite'])assert.throws(()=>emittedClosure(available(`import '${name}';`),{name:`turbine-orm-${profile}-runtime-stage`,exports:root},ts),/Unreviewed external/);
  }
  for(const name of ['mysql2/arbitrary','mssql','arbitrary'])assert.throws(()=>emittedClosure(available(`import '${name}';`),{name:'turbine-orm-mysql-runtime-stage',exports:root},ts),/Unreviewed external/);
});
test('new profile keeps opaque and renamed/transferred loader refusals',()=>{
  for(const code of ['import(opaque)',`const load=require; load('mysql2/promise');`,`import {createRequire as renamed} from 'node:module'; renamed(import.meta.url)('mysql2/promise');`])
    assert.throws(()=>emittedClosure(available(code),{name:'turbine-orm-mysql-runtime-stage',exports:root},ts),/Opaque|Unsupported .*loader/);
});
test('internal peer helper must match its exact qualified bytes',()=>{
  for(const name of Object.keys(mysqlPins.helpers))assert.throws(()=>mysqlHelperEdges(name,{[name]:Buffer.from('import(opaque)')},()=>{},[]),/internal peer helper changed/);
});
