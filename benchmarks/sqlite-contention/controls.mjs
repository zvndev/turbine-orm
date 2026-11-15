import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { faults, alive, validateReport } from './model.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({ options: { bundle: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.bundle && values.out, '--bundle and --out directory required');
mkdirSync(values.out, { recursive: true });
const patterns = {
  'no-barrier': /snapshot coordination lost/, 'omit-rollback': /rollback was omitted/,
  'premature-cleanup': /premature cleanup/, 'child-death': /child unavailable/,
  'stubborn-child': /stubborn child/, 'teardown-signal': /received SIGTERM/,
  'cleanup-error': /injected cleanup error/, 'command-timeout': /command deadline: ready/,
};
const summary = { node: process.version, cases: [], status: 'running' };
const save = () => writeFileSync(resolve(values.out, 'controls.json'), `${JSON.stringify(summary, null, 2)}\n`);
try {
  for (const fault of faults) {
    const out = resolve(values.out, `${fault}.json`);
    const result = spawnSync(process.execPath, [joinRun(), '--bundle', resolve(values.bundle), '--out', out, '--rounds', '2', '--fault', fault],
      { encoding: 'utf8', timeout: 45000, maxBuffer: 1024 * 1024 });
    writeFileSync(resolve(values.out, `${fault}.log`), `${result.stdout ?? ''}${result.stderr ?? ''}`);
    assert.ifError(result.error);
    assert.ok(existsSync(out), `failure report was not retained: ${fault}`);
    const report = JSON.parse(readFileSync(out));
    if (fault === 'none') { assert.equal(result.status, 0); validateReport(report); }
    else {
      assert.equal(result.status, 1, `fault passed: ${fault}`);
      assert.equal(report.status, 'failed');
      assert.match(report.errors.map(x => x.message).join('\n'), patterns[fault]);
      assert.throws(() => validateReport(report));
    }
    assert.ok(report.cleanup.length > 0, `no cleanup evidence: ${fault}`);
    for (const c of report.cleanup) {
      assert.equal(c.filesRemoved, true);
      for (const child of c.children) {
        assert.equal(alive(child.pid), false); assert.equal(alive(-child.pgid), false);
      }
      for (const path of c.paths) assert.equal(existsSync(path), false);
    }
    if (fault === 'stubborn-child') assert.ok(report.events.some(e => e.kind === 'escalate' && e.signal === 'SIGKILL'));
    if (fault === 'command-timeout') assert.ok(report.events.some(e => e.kind === 'timeout'));
    if (fault === 'teardown-signal') assert.equal(report.signal, 'SIGTERM');
    summary.cases.push({ fault, expected: fault === 'none' ? 'passed' : 'failed', status: 'passed', report: out,
      samples: report.samples.length, ownedChildren: report.cleanup.reduce((n, x) => n + x.children.length, 0) });
    save();
  }
  summary.status = 'passed';
} catch (error) { summary.status = 'failed'; summary.error = { message: error.message, stack: error.stack }; process.exitCode = 1; }
finally { save(); }
console.log(JSON.stringify(summary));
function joinRun() { return resolve(here, 'run.mjs'); }
