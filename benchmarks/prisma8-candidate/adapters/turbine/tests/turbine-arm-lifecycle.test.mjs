import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// Execute the actual CLI module, replacing only external service/DB/arm seams.
// Keep the real drain, execution guard, lifecycle cleanup and report owner.
const probe = String.raw`
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SourceTextModule, SyntheticModule } from 'node:vm';
import { runWithShutdown } from '../../../../../tooling/optional-pg-transports/run.mjs';
import { drain } from '../../../scripts/native.mjs';
import { execute } from '../../../scripts/execution.mjs';

const mode = process.env.P8_CONTROL_PROBE_MODE;
const root = mkdtempSync(join(tmpdir(), 'p8-arm-lifecycle-'));
const filename = fileURLToPath(new URL('./turbine-arm-native.mjs', import.meta.url));
const originalArgv = process.argv, originalExit = process.exitCode;
process.argv = [process.execPath, filename, '--bundle', join(root,'bundle'), '--service-plan', join(root,'plan.json')];
let start, release, scope, poolClosed = false, serviceStopped = false, armClosed = false;
const started = new Promise(resolve => { start = resolve; });
const stalled = new Promise(resolve => { release = resolve; });
class Client { async connect() {} async end() {} }
class Pool { on() {} async end() { poolClosed = true; } }
const createArm = async ({pool,driver}) => {
  if(driver !== 'pg@8.22.0') throw new Error('requires pg');
  if(!(pool instanceof Pool)) throw new Error('actual loaded native pg.Pool');
  return {pool,close:async()=>{armClosed = true;},stream:()=>({
    [Symbol.asyncIterator](){return this;},next(){ start(); return stalled; }
  })};
};
const synthetic = async exports => {
  const mod = new SyntheticModule(Object.keys(exports), function(){for(const [name,value] of Object.entries(exports)) this.setExport(name,value);});
  await mod.link(()=>{}); await mod.evaluate(); return mod;
};
const armModule = await synthetic({createArm});
const overrides = new Map([
  ['pg',{default:{Client,Pool}}],
  ['../../../../../tooling/optional-pg-transports/harness.mjs',{command:async()=>{}}],
  ['../../../../../tooling/optional-pg-transports/run.mjs',{runWithShutdown:(report,path,body)=>runWithShutdown(report,path,owner=>{scope=owner;return body(owner);})}],
  ['../../../dist/canonical/equivalence.js',{readFixture:async()=>({comments:[{id:1}]})}],
  ['../../../dist/canonical/extended-equivalence.js',{expectedWrite(){},prepareWrite(){},scratchQuery:'',verifyWrite(){}}],
  ['../../../scripts/catalog.mjs',{catalog:()=>[]}],
  ['../../../scripts/comparators.mjs',{comparators:async()=>{throw new Error('Comparator module changed');}}],
  ['../../../scripts/native.mjs',{drain,observe:()=>Object.assign([],{detach(){}})}],
  ['../../../scripts/service.mjs',{startService:async(_plan,_report,owner)=>{owner.registerStop(()=>{serviceStopped=true;});return {url:'synthetic'};}}],
  ['../../../scripts/execution.mjs',{execute:(owner,operation,label,ms)=>execute(owner,operation,label,mode==='deadline'?50:ms)}],
  ['../archive.mjs',{readJson:path=>path.endsWith('plan.json')?{out:root}:{arms:[{module:{sha256:'x'}}]},saveJson(){},sha256(){}}],
  ['../verify.mjs',{verifyBundle:()=>({label:'synthetic-lifecycle-control',artifact:{},module:{sha256:'x'}})}],
]);
try {
  const mod = new SourceTextModule(readFileSync(filename,'utf8'), {
    identifier:filename,
    initializeImportMeta(meta){meta.dirname=dirname(filename);meta.url=new URL(filename,'file:').href;},
    importModuleDynamically:async()=>armModule,
  });
  await mod.link(async name=>synthetic(overrides.get(name) ?? await import(name)));
  let settled = false, failure;
  const evaluated = mod.evaluate().catch(error=>{failure=error;}).finally(()=>{settled=true;});
  await started;
  if(mode==='signal') process.emit('SIGTERM');
  await Promise.race([evaluated,delay(500)]);
  const beforeRelease = {settled,poolClosed,serviceStopped,armClosed,persisted:existsSync(join(root,'report.json')),aborted:scope.signal.aborted};
  // Always release the counterexample, so a failing pre-fix test also cleans up.
  release({done:true});
  await evaluated;
  assert.equal(beforeRelease.settled,true,'runner must settle before releasing stalled iterator.next');
  for(const key of ['poolClosed','serviceStopped','armClosed','persisted']) assert.equal(beforeRelease[key],true,key);
  if(mode==='signal') assert.equal(beforeRelease.aborted,true);
  assert.match(failure?.message??'',mode==='signal'?/Interrupted by SIGTERM/:/Turbine native controls/);
  const report = JSON.parse(readFileSync(join(root,'report.json'),'utf8'));
  assert.equal(report.success,false);
  assert.deepEqual(report.cleanupErrors,[]);
} finally { process.argv=originalArgv; process.exitCode=originalExit; rmSync(root,{recursive:true,force:true}); }
`;

for (const mode of ['signal', 'deadline'])
  test(`actual turbine-arm native runner cleans up stalled drain on ${mode}`, () => {
    const result = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module'], {
      input: probe,
      cwd: import.meta.dirname,
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, P8_CONTROL_PROBE_MODE: mode, NODE_OPTIONS: '', NODE_PATH: '' },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  });
