import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url);
const manifest=JSON.parse(readFileSync('node_modules/turbine-orm/package.json'));
const result={};
for(const entry of Object.keys(manifest.exports)) {
  const name=entry==='.'?'turbine-orm':`turbine-orm/${entry.slice(2)}`;
  const esm=await import(name);
  const cjs=require(name);
  result[name]={esm:Object.keys(esm).sort(),cjs:Object.keys(cjs).sort(),import:import.meta.resolve(name),require:require.resolve(name)};
  assert.equal(result[name].import,pathToFileURL(join(process.cwd(),'node_modules/turbine-orm',manifest.exports[entry].import.default)).href);
  assert.equal(result[name].require,join(process.cwd(),'node_modules/turbine-orm',manifest.exports[entry].require.default));
}
console.log(JSON.stringify(result));
