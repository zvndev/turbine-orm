/** Real repacked payload mutants plus refreshed-descriptor stale-source control. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHashes, files, hashBytes, hashFile, sourceHashes, verifyPayload } from './artifact-contract.mjs';
const source=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const [identityPath,normalArchive,pin,destination]=process.argv.slice(2);
assert.ok(identityPath&&normalArchive&&pin&&destination&&!existsSync(destination));assert.equal(hashFile(normalArchive),pin);
const identity=JSON.parse(readFileSync(identityPath));assert.equal(identity.profile,'mysql');assert.equal(hashFile(identity.archive),identity.sha256);
const root=resolve(destination);mkdirSync(root);const results=[];
const npm=process.env.npm_execpath;
assert.ok(npm, 'Set npm_execpath to the npm CLI JavaScript file, or run through npm exec.');
const options={encoding:'utf8',timeout:120000,maxBuffer:16e6};
for(const fault of ['missing-helper','changed-helper','missing-loader','missing-declaration','missing-runtime','missing-condition','changed-code','extra-export','missing-driver','wrong-driver','cjs-scope']){
 const dir=join(root,fault),staged=join(dir,'package');mkdirSync(dir);cpSync(join(dirname(identityPath),'package'),staged,{recursive:true});
 if(fault==='missing-helper')rmSync(join(staged,'dist/optional-peer-import.cjs'));
 if(fault==='changed-helper')writeFileSync(join(staged,'dist/optional-peer-import.cjs'),'module.exports=()=>({});');
 if(fault==='missing-loader')rmSync(join(staged,'dist/optional-pg.cjs'));
 if(fault==='missing-declaration')rmSync(join(staged,'dist/client.d.ts'));
 if(fault==='missing-runtime')rmSync(join(staged,'dist/query/builder.js'));
 if(fault==='missing-condition')rmSync(join(staged,'dist/unavailable-pg.js'));
 if(fault==='changed-code')writeFileSync(join(staged,'dist/mysql.js'),readFileSync(join(staged,'dist/mysql.js'))+'\nexport const unknown=42;');
 if(fault==='cjs-scope')writeFileSync(join(staged,'dist/cjs/package.json'),'{"type":"module"}');
 if(['extra-export','missing-driver','wrong-driver'].includes(fault)){
  const path=join(staged,'package.json'),manifest=JSON.parse(readFileSync(path));
  if(fault==='extra-export')manifest.exports['./cli']=manifest.exports['.'];
  if(fault==='missing-driver')manifest.dependencies={};
  if(fault==='wrong-driver')manifest.dependencies.mysql2='3.0.0';
  writeFileSync(path,JSON.stringify(manifest,null,2)+'\n');
 }
 const packed=JSON.parse(execFileSync(process.execPath,[npm,'pack','--json','--pack-destination',dir],{...options,cwd:staged}))[0];
 const archive=join(dir,packed.filename),edited={...identity,archive,sha256:hashFile(archive),stagedHashes:fileHashes(staged)};
 edited.exports=JSON.parse(readFileSync(join(staged,'package.json'))).exports;
 const descriptor=join(dir,'identity.json');writeFileSync(descriptor,JSON.stringify(edited,null,2));let rejected;
 try{execFileSync(process.execPath,[join(source,'tooling/optional-package/verify-artifacts.mjs'),descriptor,normalArchive,pin,join(dir,'verify')],options);}catch(error){rejected={status:error.status,stdout:error.stdout,stderr:error.stderr};}
 assert.ok(rejected?.status>0,fault);assert.match(rejected.stderr,/Optional payload inventory mismatch|Undeclared optional payload transformation/);
 results.push({fault,archive,sha256:edited.sha256,...rejected});
}
const scratch=join(root,'source');mkdirSync(scratch);
for(const name of Object.keys(identity.inputHashes)){mkdirSync(dirname(join(scratch,name)),{recursive:true});cpSync(join(source,name),join(scratch,name));}
cpSync(join(source,'dist'),join(scratch,'dist'),{recursive:true});symlinkSync(join(source,'node_modules'),join(scratch,'node_modules'));
const original=join(root,'original');mkdirSync(original);execFileSync('tar',['-xzf',normalArchive,'-C',original],options);
const path=join(scratch,'src/mysql.ts');writeFileSync(path,readFileSync(path)+'\n// Deliberate fresh-source / old emitted artifact attack.\n');
const inputs=sourceHashes(scratch),edited={...identity,source:scratch,inputHashes:inputs,build:{...identity.build,inputSha256:hashBytes(JSON.stringify(inputs)),distHashes:fileHashes(join(scratch,'dist'))}};
assert.throws(()=>verifyPayload(join(original,'package'),join(dirname(identityPath),'package'),scratch,edited),/MySQL pinned source\/build inputs changed/);
results.push({fault:'fresh-source-old-emission-refreshed-descriptors',rejected:true,changedSource:path});
writeFileSync(join(root,'report.json'),JSON.stringify({success:true,profile:'mysql',results},null,2));console.log(JSON.stringify({success:true,controls:results.length}));
