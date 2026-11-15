import assert from 'node:assert/strict';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, owned, stop, within, save, alive } from './process.mjs';
import { sha } from './driver.mjs';
import { validateCampaign } from './validate.mjs';

const [destination, prerequisite] = process.argv.slice(2);
assert.ok(destination && prerequisite, 'New controls directory and completed positive native campaign required');
const positive = JSON.parse(readFileSync(join(prerequisite, 'campaign.json')));
assert.equal(positive.runtime.version, process.version, 'Positive prerequisite on the exact same runtime');
assert.equal(validateCampaign(positive), true);
assert.equal(sha(join(prerequisite, 'source.mjs')), positive.provenance.bundleSha256);
await audit(positive);
const output = resolve(destination); mkdirSync(output);
const report = { status: 'running', runtime: process.version, prerequisite, controls: [], signal: null };
const path = join(output, 'controls.json'); save(path, report);
let active;
const interrupted = name => { report.status = 'failed'; report.signal = name; save(path, report);
  if (active?.record.pid) process.kill(active.record.pid, name); };
const term = () => interrupted('SIGTERM'), int = () => interrupted('SIGINT');
process.on('SIGTERM', term); process.on('SIGINT', int);
const faults = [
  ['fetch-all', /Bounded server FETCH quantity/],
  ['materialize', /Live native cursor owner required/],
  ['omit-abort', /AbortSignal must reject/],
  ['primary', /Injected primary workload failure/],
  ['cleanup', /Independent cleanup audit/],
  ['finalize', /Worker exit must succeed/],
  ['double-failure', /Injected primary workload failure/],
  ['signal', /Worker exit must succeed/],
  ['service-finalize', /Injected service finalizer failure/],
  ['service-signal', /SIGTERM/],
];
try {
  for (const [fault, message] of faults) {
    assert.equal(report.signal, null);
    const directory = join(output, fault);
    active = owned(process.execPath, [fileURLToPath(new URL('./native.mjs', import.meta.url)), directory, fault]);
    let stdout = '', stderr = '';
    active.child.stdout.on('data', b => { stdout += b; }); active.child.stderr.on('data', b => { stderr += b; });
    try { await within(active.done, 60000, 'Native control controller deadline'); }
    finally { await stop(active); }
    const result = JSON.parse(readFileSync(join(directory, 'campaign.json')));
    assert.equal(result.status, 'failed', 'Actual native fault must refuse success');
    assert.match(JSON.stringify(result), message, 'Fault must fail its intended assertion');
    assert.doesNotMatch(JSON.stringify(result.errors) + stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/);
    if (fault === 'service-signal') assert.deepEqual(active.record.exit, { code: null, signal: 'SIGTERM' });
    else assert.deepEqual(active.record.exit, { code: 1, signal: null });
    if (fault === 'signal') {
      assert.equal(result.samples[0].signal, 'SIGTERM');
      assert.deepEqual(result.processes.at(-1).exit, { code: null, signal: 'SIGTERM' });
    }
    if (fault === 'double-failure') {
      assert.match(JSON.stringify(result.samples[0].errors), /Injected primary workload failure/);
      assert.match(JSON.stringify(result.samples[0].cleanupErrors), /Injected post-cleanup finalizer failure/);
    }
    if (fault === 'cleanup') assert.equal(result.observers[0].databases, 1, 'Independent database observer must detect the actual omission');
    const cleanup = await audit(result);
    const controller = { ...active.record, processAbsent: !alive(active.record.pid), groupAbsent: !alive(active.record.pid, true) };
    assert.ok(controller.processAbsent && controller.groupAbsent, 'Independent control controller audit');
    report.controls.push({ fault, controller, exit: active.record.exit, stdout, stderr, intended: message.source, cleanup, campaign: join(directory, 'campaign.json') });
    save(path, report); active = null;
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = { message: error.message, stack: error.stack }; }
finally {
  try { await stop(active); } catch (e) { report.status = 'failed'; report.cleanupError = e.message; }
  if (report.signal) report.status = 'failed'; save(path, report);
  process.removeListener('SIGTERM', term); process.removeListener('SIGINT', int);
  console.log(JSON.stringify({ status: report.status, runtime: report.runtime, controls: report.controls.length, error: report.error }));
  if (report.signal) process.kill(process.pid, report.signal); else process.exitCode = report.status === 'passed' ? 0 : 1;
}
