import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'sqlite-relations-omissions-'));
const results = [];
function run(directory, pattern) {
  const r = spawnSync(process.execPath, ['--test', ...(pattern ? ['--test-name-pattern', pattern] : []), join(directory, 'harness.test.mjs')], { encoding: 'utf8', timeout: 10000 });
  return { code: r.status, signal: r.signal, output: r.stdout + r.stderr };
}
try {
  cpSync(here, stage, { recursive: true });
  const prerequisite = run(stage);
  assert.equal(prerequisite.code, 0, prerequisite.output);
  results.push({ kind: 'prerequisite', ...prerequisite });
  for (const [name, file, line, test, replacement = '', expectedFailure = /Missing expected exception/] of [
    ['values', 'oracle.mjs', "  assert.deepEqual(sample.value, value, 'exact independent nested values/order/window');", 'guard rejects missing relation'],
    ['materialization', 'oracle.mjs', "    assert.ok(reads.every(e => e.method === 'iterate'), 'stream used materializing route');", 'guard rejects hidden materialization'],
    ['handle', 'oracle.mjs', "  assert.equal(r.cleanup.handleClosed, true, 'native handle closure proof');", 'report guard rejects lost handle'],
    ['finalization', 'run.mjs', '  try { if (directory) rmSync(directory, { recursive: true, force: true }); }\n  catch (error) { fail(error); }', 'runner retains primary failure and JSON when owned directory removal fails', '  if (directory) rmSync(directory, { recursive: true, force: true });', /Final failed report must be retained/],
  ]) {
    const original = readFileSync(join(stage, file), 'utf8');
    assert.equal(original.split(line).length, 2, `unique omission marker ${name}`);
    writeFileSync(join(stage, file), original.replace(line, replacement));
    const result = run(stage, `^${test}$`);
    assert.notEqual(result.code, 0, `omission ${name} escaped`);
    assert.match(result.output, expectedFailure, `intended assertion ${name}`);
    assert.equal(result.signal, null);
    results.push({ kind: name, ...result });
    writeFileSync(join(stage, file), original);
  }
} finally { rmSync(stage, { recursive: true, force: true }); }
process.stdout.write(`${JSON.stringify({ runtime: process.version, command: process.argv, results, disposableStageRemoved: true }, null, 2)}\n`);
