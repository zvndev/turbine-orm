import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { audit } from './audit.mjs';
import { groupAlive, ownedProcess, stopOwned, withNative } from './native.mjs';
import { ARMS, CAPACITY, checkEffect, checkRows, comparisons, expected, finalize, shuffled } from './oracle.mjs';
import { reportModel } from './test-model.mjs';
import { validate } from './validate.mjs';

test('root-pinned driver resolution ignores a shadowing benchmark dependency installation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mysql-preparation-resolution-'));
  try {
    for (const [directory, origin] of [
      ['node_modules', 'root'],
      ['benchmarks/node_modules', 'shadow'],
    ]) {
      const pkg = join(root, directory, 'mysql2');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(
        join(pkg, 'package.json'),
        JSON.stringify({ name: 'mysql2', version: '0.0.0', exports: { './promise': './promise.cjs' } }),
      );
      writeFileSync(join(pkg, 'promise.cjs'), `module.exports = { origin: '${origin}' };`);
    }
    const directory = join(root, 'benchmarks/mysql-preparation');
    mkdirSync(directory, { recursive: true });
    const source = readFileSync(new URL('./provenance.mjs', import.meta.url), 'utf8').replace(
      "'./oracle.mjs'",
      JSON.stringify(new URL('./oracle.mjs', import.meta.url).href),
    );
    const file = join(directory, 'provenance.mjs');
    writeFileSync(file, source);
    const module = await import(pathToFileURL(file).href);
    assert.equal(module.require('mysql2/promise').origin, 'root');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('independent exact oracle rejects rounded integers, decimals, NULL/JSON/boolean/date/buffer and cardinality faults', () => {
  checkRows([expected(1)], 1);
  checkRows([expected(3, true)], 3, true);
  for (const field of ['huge', 'amount', 'payload', 'nullable', 'enabled', 'stamp', 'bytes', 'label']) {
    const row = expected(1, true);
    row[field] = field === 'enabled' ? 1 : 'wrong';
    assert.throws(() => checkRows([row], 1, true), /oracle/);
  }
  assert.throws(() => checkRows([], 1), /cardinality/);
  assert.throws(() => checkRows([expected(1), expected(1)], 1));
  assert.throws(() => checkEffect([{ n: 2 }], 1), /effect oracle/);
});
test('paired order reproducible, nonempty, changed across rounds and contains identical control', () => {
  assert.deepEqual(shuffled(ARMS, 1), shuffled(ARMS, 1));
  assert.notDeepEqual(shuffled(ARMS, 1), shuffled(ARMS, 44));
  assert.deepEqual(shuffled(ARMS, 5).sort(), [...ARMS].sort());
  assert.ok(ARMS.includes('text-control'));
  assert.ok(CAPACITY > 0);
  assert.throws(() => comparisons([]), /nonempty/);
});
test('finalization retains primary failure plus all cleanup errors and still writes report', async () => {
  const report = { failure: 'original SIGTERM' };
  let saved;
  const visited = [];
  assert.equal(
    await finalize(
      report,
      [
        async () => {
          visited.push(1);
          throw new Error('EACCES fixture');
        },
        async () => {
          visited.push(2);
          throw new Error('process cleanup failed');
        },
        async () => {
          visited.push(3);
        },
      ],
      (r) => {
        saved = structuredClone(r);
      },
    ),
    false,
  );
  assert.deepEqual(visited, [1, 2, 3]);
  assert.equal(saved.failure, 'original SIGTERM');
  assert.equal(saved.status, 'failed');
  assert.equal(saved.cleanupErrors.length, 2);
});
test('report write failure rejects after resource finalization', async () => {
  const report = {};
  let cleaned = false;
  const root = mkdtempSync(join(tmpdir(), 'mysql-preparation-write-'));
  const block = join(root, 'block');
  writeFileSync(block, 'file prevents parent directory');
  try {
    await assert.rejects(
      finalize(
        report,
        [
          async () => {
            cleaned = true;
          },
        ],
        () => writeFileSync(join(block, 'report.json'), 'report'),
      ),
      (e) => e.code === 'ENOTDIR',
    );
    assert.ok(cleaned);
    assert.equal(report.status, 'failed');
    assert.match(report.cleanupErrors[0], /report write/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});
test('required service absence fails with retained identity and actual cleanup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mysql-preparation-guard-'));
  const previous = process.env.MYSQL_PREP_MYSQLD;
  process.env.MYSQL_PREP_MYSQLD = join(root, 'missing');
  try {
    const identity = await withNative(join(root, 'owned'), 'default', async () => assert.fail('missing service ran'));
    assert.equal(identity.status, 'failed');
    assert.match(identity.failure, /required native MySQL executable absent/);
    assert.ok(identity.dataAbsent && identity.socketAbsent && identity.serverGroupAbsent && identity.childGroupAbsent);
    assert.equal(JSON.parse(readFileSync(join(root, 'owned/identity.json'))).status, 'failed');
  } finally {
    if (previous === undefined) delete process.env.MYSQL_PREP_MYSQLD;
    else process.env.MYSQL_PREP_MYSQLD = previous;
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});
test('owned child process is terminated and group absence independently checked', async () => {
  const child = ownedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)']);
  await new Promise((r) => child.process.once('spawn', r));
  assert.ok(groupAlive(child.process.pid));
  await stopOwned(child);
  assert.equal(groupAlive(child.process.pid), false);
  assert.ok(child.exited);
});
test('unresponsive owned process is force terminated and independently absent', async () => {
  const child = ownedProcess(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)",
  ]);
  await new Promise((r) => child.process.stdout.once('data', r));
  await stopOwned(child, 100);
  assert.equal(child.exit.signal, 'SIGKILL');
  assert.equal(groupAlive(child.process.pid), false);
});
test('already exited child and absent group finalize without errors', async () => {
  const child = ownedProcess(process.execPath, ['-e', 'process.exit(3)']);
  await child.done;
  assert.equal(child.exit.code, 3);
  await stopOwned(child);
  assert.equal(groupAlive(child.process.pid), false);
});
test('validator fails closed on empty/partial result and missing identities', () => {
  assert.throws(() => validate({}), /mysql-preparation/);
  assert.throws(
    () =>
      validate({
        format: 'mysql-preparation-v1',
        status: 'passed',
        cleanupErrors: [],
        databaseRemoved: true,
        applicationSessionsClosed: true,
      }),
    TypeError,
  );
});
// Run dependency-free guards on every supported Node major. Full report mutation controls
// are replayable against actual measured JSON; the default structural model is not native evidence.
test('validator rejects representative raw sample, identity, control and comparison faults', () => {
  const original = process.env.MYSQL_PREP_TEST_REPORT
    ? JSON.parse(readFileSync(process.env.MYSQL_PREP_TEST_REPORT, 'utf8'))
    : reportModel();
  assert.ok(validate(original).samples > 0);
  for (const mutate of [
    (r) => {
      r.samples = [];
    },
    (r) => {
      r.controls.pop();
    },
    (r) => {
      r.samples[0].protocol.Com_stmt_execute += 1;
    },
    (r) => {
      r.samples[0].occupancy.driver[0].size = CAPACITY + 1;
    },
    (r) => {
      r.comparisons[0].pairedMedianMs += 1;
    },
    (r) => {
      r.provenance.source.oracleSha256 = '0'.repeat(64);
    },
    (r) => {
      r.server.version = '8.4.13';
    },
    (r) => {
      r.provenance.runtime.node = 'v24.9.0';
    },
    (r) => {
      r.databaseRemoved = false;
    },
    (r) => {
      r.applicationSessionsClosed = false;
    },
    (r) => {
      r.samples[0].order = [];
    },
    (r) => {
      r.samples[0].checkedResults = 0;
    },
  ]) {
    const report = structuredClone(original);
    mutate(report);
    assert.throws(() => validate(report));
  }
});

// The model below is deliberately incomplete and must be refused, not certified.
test('cleanup audit refuses a report whose runtime is missing from child history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mysql-preparation-history-'));
  const owned = join(root, 'default');
  mkdirSync(owned);
  try {
    writeFileSync(
      join(owned, 'identity.json'),
      JSON.stringify({ root: owned, data: join(owned, 'data'), socket: join(owned, 'mysql.sock'), children: [] }),
    );
    writeFileSync(join(root, 'default-node22.json'), JSON.stringify(reportModel()));
    await assert.rejects(audit(root), /runtime PID is absent/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  }
});
