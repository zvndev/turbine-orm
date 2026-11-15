import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { owned, stop, deadline, audit } from './lifecycle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [destination, mode = 'guards'] = process.argv.slice(2);
assert.ok(destination && ['guards', 'native'].includes(mode), 'Usage: node controls.mjs NEW.json [guards|native]');
assert.ok(!existsSync(resolve(destination)), 'destination already exists; refusing to overwrite controls');
const root = mkdtempSync(join(tmpdir(), 'mysql-relations-controls-'));
const results = [];
function change(path, from, to) {
  const text = readFileSync(path, 'utf8');
  assert.equal(text.split(from).length, 2, 'control mutation anchor must occur exactly once');
  writeFileSync(path, text.replace(from, to));
}
async function run(script, args, signalAtReady = false) {
  const child = owned(process.execPath, [script, ...args]);
  if (signalAtReady) {
    let sent = false;
    child.child.stdout.on('data', () => {
      if (!sent && child.stdout.includes('prerequisites-passed')) { sent = true; child.child.kill('SIGTERM'); }
    });
  }
  try { await deadline(child.done, 240000, 'control campaign', () => child.child.kill('SIGTERM')); }
  finally { await stop(child); }
  return child;
}
try {
  // Establish that the same command succeeds before testing guard omissions or native faults.
  const baselinePath = join(root, 'baseline.json');
  const baseline = mode === 'guards'
    ? await run('--test', [join(here, 'guards.test.mjs')])
    : await run(join(here, 'run.mjs'), [baselinePath]);
  assert.equal(baseline.code, 0, baseline.stderr + baseline.stdout);
  results.push({ name: 'prerequisite-baseline', code: baseline.code, stdout: baseline.stdout, stderr: baseline.stderr });
  if (mode === 'native') {
    const report = JSON.parse(readFileSync(baselinePath));
    assert.ok(report.proof.cases.length === 64 && report.cleanup.complete, 'complete native prerequisite');
    results[0].report = report;
  }
  const cases = mode === 'guards' ? [
    ['value-guard-omission', 'proof.mjs', 'export function assertValues(actual, expected) {', 'export function assertValues(actual, expected) { return;', /Missing expected exception/],
    ['route-guard-omission', 'proof.mjs', 'export function assertRoute(route, strategy, legacy) {', 'export function assertRoute(route, strategy, legacy) { return;', /Missing expected exception/],
    ['cleanup-guard-omission', 'proof.mjs', "  assert.ok(report.cleanup?.complete, 'cleanup incomplete');", '', /Missing expected exception/],
  ] : [
    ['missing', 'worker.mjs', '              assertValues(actual, expected);', "              actual.find((p) => p.children.length).children.shift();\n              assertValues(actual, expected);", /exact nested values\/windows differ/],
    ['duplicate', 'worker.mjs', '              assertValues(actual, expected);', "              { const p = actual.find((p) => p.children.length); p.children.push(p.children[0]); }\n              assertValues(actual, expected);", /exact nested values\/windows differ/],
    ['tie-breaker', 'worker.mjs', '              assertOrder(args, names);', "              args.orderBy.pop();\n              assertOrder(args, names);", /parent tie-breaker omitted/],
    ['window', 'worker.mjs', '              assertOrder(args, names);', "              assertOrder(args, names);\n              if (arm !== 'raw') args.with[names.children].offset = 0;", /exact nested values\/windows differ/],
    ['route', 'worker.mjs', '              assertRoute(sample.route, arm, legacy);', "              sample.route.length = 0;\n              assertRoute(sample.route, arm, legacy);", /missing native command proof/],
    ['cleanup', 'run.mjs', '  if (!report.cleanup.complete)', '  report.cleanup.complete = false;\n  if (!report.cleanup.complete)', /independent cleanup audit incomplete/],
    ['interrupt', null, null, null, /interrupted by SIGTERM/],
  ];
  for (const [name, file, from, to, intended] of cases) {
    const copy = join(root, name); cpSync(here, copy, { recursive: true });
    if (file) change(join(copy, file), from, to);
    const output = join(root, `${name}.json`);
    const child = mode === 'guards' ? await run('--test', [join(copy, 'guards.test.mjs')]) : await run(join(copy, 'run.mjs'), [output], name === 'interrupt');
    assert.equal(child.code, 1, `${name}: control did not fail: ${child.stdout} ${child.stderr}`);
    let report;
    if (mode === 'native') {
      report = JSON.parse(readFileSync(output));
      assert.equal(report.status, 'failure', 'fault became timed success');
      if (name !== 'interrupt') assert.match(child.stdout, /prerequisites-passed/, 'native control missed prerequisites');
      const independent = await audit(report.identity);
      assert.equal(independent.complete, true, 'control leaked owned resources');
      assert.match(report.failures.join('\n'), intended, `${name}: wrong failure`);
      results.push({ name, code: child.code, intended: intended.source, independent, report });
    } else {
      assert.match(child.stdout + child.stderr, intended, `${name}: wrong omission failure`);
      results.push({ name, code: child.code, intended: intended.source, stdout: child.stdout, stderr: child.stderr });
    }
  }
  writeFileSync(resolve(destination), `${JSON.stringify({ mode, runtime: process.version, command: process.argv, results }, null, 2)}\n`, { flag: 'wx' });
} finally { rmSync(root, { recursive: true, force: true }); }
console.log(JSON.stringify({ destination, mode, controls: results.length - 1, passed: true }));
