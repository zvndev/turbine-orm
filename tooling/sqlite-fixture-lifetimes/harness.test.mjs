import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runtimeFlags = process.execArgv.filter((arg) => arg === '--experimental-sqlite');
const observer = fileURLToPath(new URL('./observe.mjs', import.meta.url));
let native;
try { native = createRequire(import.meta.url)('node:sqlite'); } catch {}
const skip = native ? false : 'requires node:sqlite (Node >= 22.5)';
function run(t, program, extra = []) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-lifetime-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reports = join(root, 'reports');
  mkdirSync(reports);
  const fixture = join(root, 'fixture.mjs');
  writeFileSync(fixture, program);
  const env = { ...process.env, TURBINE_SQLITE_LIFETIME_REPORT: reports };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [...runtimeFlags, ...extra, '--import', observer, fixture], {
    env, encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  const files = readdirSync(reports);
  assert.equal(files.length, 1, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(reports, files[0]), 'utf8'));
  assert.equal(report.complete, true);
  assert.equal(report.ppid, extra.includes('--test') ? result.pid : process.pid);
  assert.equal(report.node, process.version);
  assert.equal(report.argv[1], fixture);
  return { result, report };
}
const preamble = "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(':memory:');\n";

test('explicit caller close passes; a copied omission fails before emergency cleanup', { skip }, (t) => {
  const original = `${preamble}db.prepare('SELECT 1').get(); db.close();\n`;
  const good = run(t, original);
  assert.equal(good.result.status, 0, good.result.stderr);
  assert.equal(good.report.opened, 1);
  assert.equal(good.report.observedClosed, 1);
  assert.equal(good.report.leaked, 0);
  const bad = run(t, original.replace('db.close();', ''));
  assert.equal(bad.result.status, 1);
  assert.equal(bad.report.leaked, 1);
  assert.equal(bad.report.cleanupClosed, 1);
  assert.equal(bad.report.remaining, 0);
  assert.match(bad.report.survivors[0].stack, /fixture.mjs/);
  assert.match(bad.result.stderr, /SQLite fixture lifetime violation/);
});

test('a primary failure retains its output and status during emergency cleanup', { skip }, (t) => {
  const { result, report } = run(t, `${preamble}console.error('primary fixture failure'); process.exitCode = 7;`);
  assert.equal(result.status, 7);
  assert.equal(report.primaryExitCode, 7);
  assert.equal(report.leaked, 1);
  assert.equal(report.cleanupClosed, 1);
  assert.match(result.stderr, /primary fixture failure/);
});

test('native callback cleanup matches independent native behavior and preserves the primary failure', {
  skip: skip || (typeof native.DatabaseSync.prototype.function === 'function' ? false : 'requires node:sqlite custom functions'),
}, (t) => {
  // Exit inside the callback: returning after a successful close is unsafe on some native runtimes.
  const oracle = spawnSync(process.execPath, [...runtimeFlags, '--input-type=module', '-e', `${preamble}
    db.function('stop', () => {
      try { db.close(); console.error('NATIVE_CLOSE_SUCCEEDED'); }
      catch (error) { console.error('NATIVE_CLOSE_ERROR:' + error.code + ':' + error.message); }
      process.exit(7);
    }); db.prepare('SELECT stop()').get();`], { encoding: 'utf8', timeout: 20_000 });
  assert.ifError(oracle.error);
  assert.equal(oracle.status, 7, oracle.stderr);
  const refused = oracle.stderr.includes('NATIVE_CLOSE_ERROR:');
  assert.match(oracle.stderr, /NATIVE_CLOSE_(?:SUCCEEDED|ERROR:)/);
  const { result, report } = run(t, `${preamble}
    db.function('stop', () => { console.error('primary callback failure'); process.exit(7); });
    db.prepare('SELECT stop()').get();`);
  assert.equal(result.status, 7);
  assert.equal(report.primaryExitCode, 7);
  assert.equal(report.opened, 1);
  assert.equal(report.leaked, 1);
  assert.equal(report.cleanupClosed, refused ? 0 : 1);
  assert.equal(report.remaining, refused ? 1 : 0);
  assert.equal(report.cleanupFailures.length, refused ? 1 : 0);
  if (refused) {
    const error = report.cleanupFailures[0];
    assert.ok(oracle.stderr.includes('NATIVE_CLOSE_ERROR:' + error.code + ':' + error.message));
    assert.match(error.message, /callback|in use/i);
  }
  assert.match(result.stderr, /primary callback failure/);
  t.diagnostic(`independent native callback close refused: ${refused}; observed cleanup errors: ${report.cleanupFailures.length}`);
});

test('reopened handles and delayed opens count lifetimes rather than close calls', { skip }, (t) => {
  const { result, report } = run(t, `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(':memory:', { open: false }); db.open(); db.close(); db.open(); db.close();`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.constructed, 1);
  assert.equal(report.opened, 2);
  assert.equal(report.observedClosed, 2);
  assert.equal(report.leaked, 0);
});

test('an open malformed database is observable without changing constructor semantics', { skip }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-malformed-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = resolve(root, 'malformed.sqlite');
  writeFileSync(path, 'this is not a database'.repeat(100));
  const { result, report } = run(t, `import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(${JSON.stringify(path)}, { readOnly: true }); db.close();`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.opened, 1);
  assert.equal(report.observedClosed, 1);
});

test('unsupported native import is reported without breaking ordinary imports', { skip: native ? 'requires Node without node:sqlite' : false }, (t) => {
  const { result, report } = run(t, "import assert from 'node:assert/strict'; assert.equal(1 + 1, 2);");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(report.supported, false);
  assert.match(report.unsupportedReason, /node:sqlite/);
  assert.equal(report.opened, 0);
});

const helper = new URL('../../src/test/sqlite-fixture-lifetime.ts', import.meta.url).href;
test('fixture hooks close on assertion and setup failure, with both errors visible', { skip }, (t) => {
  const { result, report } = run(t, `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { test, beforeEach } from 'node:test';
    import { closeSqliteAfter } from ${JSON.stringify(helper)};
    beforeEach((t) => {
      closeSqliteAfter(new DatabaseSync(':memory:'), t.after.bind(t));
      if (t.name === 'setup failure') throw new Error('primary setup failure');
    });
    test('assertion failure', () => {
      const db = closeSqliteAfter(new DatabaseSync(':memory:'));
      db.close = () => { throw new Error('fixture close hook must not replace captured cleanup'); };
      assert.fail('primary assertion failure');
    });
    test('setup failure', () => assert.fail('body must not run'));
  `, ['--import', 'tsx', '--test', '--test-reporter=tap']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(report.opened, 3);
  assert.equal(report.observedClosed, 3);
  assert.equal(report.leaked, 0);
  assert.match(result.stdout, /primary assertion failure/);
  assert.match(result.stdout, /primary setup failure/);
  assert.doesNotMatch(result.stdout, /fixture close hook must not replace/);
});

test('suite fixtures survive setup, and cleanup continues after an earlier hook fails', { skip }, (t) => {
  const { result, summary } = audit(t, `
    import assert from 'node:assert/strict';
    import { DatabaseSync } from 'node:sqlite';
    import { describe, test, before, after } from 'node:test';
    import { closeSqliteAfter, sqliteFixtureScope } from ${JSON.stringify(helper)};
    describe('suite fixture', () => {
      let db;
      before(() => { db = closeSqliteAfter(new DatabaseSync(':memory:'), cleanup); });

      test('native reader remains open', () => assert.equal(db.prepare('SELECT 2 AS n').get().n, 2));
      const cleanup = sqliteFixtureScope(() => { assert.equal(db.prepare('SELECT 1 AS n').get().n, 1); throw new Error('primary teardown failure'); });
      cleanup(() => { throw new Error('secondary cleanup failure'); });
    });
  `);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(summary.counts.opened, 1);
  assert.equal(summary.counts.observedClosed, 1);
  assert.equal(summary.counts.leaked, 0);
  const output = readFileSync(summary.logPath, 'utf8');
  assert.match(output, /primary teardown failure/);
  assert.match(output, /secondary cleanup failure/);
  assert.ok(summary.failedTap.length > 0);
  t.diagnostic(`underlying test-runner exit: ${summary.status}; controller exit: ${result.status}`);
});

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
function audit(t, program, flags = []) {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-lifetime-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = join(root, 'fixture.test.mjs');
  const out = join(root, 'audit');
  writeFileSync(fixture, program);
  const result = spawnSync(process.execPath, [...runtimeFlags, runner, '--out', out, ...flags, '--', fixture], {
    encoding: 'utf8', timeout: 20_000,
  });
  assert.ifError(result.error);
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  return { result, summary };
}

test('the gate refuses omitted reports even when the test process exits successfully', { skip }, (t) => {
  const { result, summary } = audit(t, `${preamble}db.close(); process.removeAllListeners('exit');`);
  assert.equal(summary.status, 0);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(summary.outcome, 'fail');
  assert.equal(summary.missing.length, 1);
  assert.equal(summary.incomplete.length, 1);
  assert.match(result.stdout, /fixture.test.mjs/);
});

test('no native exercise cannot pass the gate, including with the unsupported option', { skip }, (t) => {
  const { result, summary } = audit(t, "import { test } from 'node:test'; test('no native fixture', () => {});", ['--allow-unsupported']);
  assert.equal(summary.status, 0);
  assert.equal(summary.counts.opened, 0);
  assert.equal(summary.unsupported.length, 0);
  assert.equal(summary.outcome, 'fail');
  assert.equal(result.status, 1, result.stdout + result.stderr);
});

test('the gate reports unsupported separately and refuses it by default', { skip: native ? 'requires Node without node:sqlite' : false }, (t) => {
  const program = "import { test } from 'node:test'; test('ordinary import', () => {});";
  const required = audit(t, program);
  assert.equal(required.result.status, 1);
  assert.equal(required.summary.outcome, 'fail');
  const optional = audit(t, program, ['--allow-unsupported']);
  assert.equal(optional.result.status, 0, optional.result.stderr);
  assert.equal(optional.summary.outcome, 'unsupported');
  assert.equal(optional.summary.counts.opened, 0);
});


test('the gate records failed suite TAP independently of the runner exit code', { skip }, (t) => {
  const { result, summary } = audit(t, `${preamble}db.close();
    import { describe, test, after } from 'node:test';
    describe('failed teardown', () => {
      after(() => { throw new Error('independent hook failure'); });
      test('ordinary assertion', () => {});
    });`);
  assert.ok(summary.failedTap.length > 0);
  assert.equal(summary.counts.leaked, 0);
  assert.equal(summary.outcome, 'fail');
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(readFileSync(summary.logPath, 'utf8'), /independent hook failure/);
  t.diagnostic(`underlying test-runner exit: ${summary.status}; controller exit: ${result.status}`);
});
