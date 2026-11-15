import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ARMS,
  ARTIFACT_SHA,
  CAPACITY,
  CASES,
  comparisons,
  DRIVER_VERSION,
  FLAGS,
  SHAPES,
  shuffled,
} from './oracle.mjs';

const sha = (value) => assert.match(value, /^[a-f\d]{64}$/);
const count = (value) => assert.ok(Number.isSafeInteger(value) && value >= 0, 'nonnegative integer counter');
const finite = (value) => assert.ok(Number.isFinite(value) && value >= 0, 'finite nonnegative measurement');
export function validate(report) {
  assert.equal(report.format, 'mysql-preparation-v1');
  assert.equal(report.status, 'passed');
  assert.equal(report.failure, undefined);
  assert.deepEqual(report.cleanupErrors, []);
  assert.equal(report.databaseRemoved, true);
  assert.equal(report.applicationSessionsClosed, true);
  const p = report.provenance;
  assert.ok(['v22.16.0', 'v24.10.0'].includes(p.runtime.node));
  sha(p.runtime.binarySha256);
  count(p.runtime.pid);
  assert.ok(p.runtime.pid > 0);
  assert.equal(`v${p.runtime.versions.node}`, p.runtime.node);
  assert.ok(p.runtime.executable.startsWith('/'));
  assert.ok(p.source.worktree.startsWith('/'));
  assert.match(p.source.head, /^[a-f\d]{40}$/);
  assert.ok(p.source.branch.length);
  assert.equal(typeof p.source.status, 'string');
  for (const name of [
    'src/mysql.ts',
    'src/client.ts',
    'src/query/builder.ts',
    ...[
      'oracle',
      'routes',
      'controls',
      'run',
      'native',
      'provenance',
      'validate',
      'harness.test',
      'audit',
      'faults',
      'test-model',
    ].map((n) => `benchmarks/mysql-preparation/${n}.mjs`),
  ])
    sha(p.source.files[name]);
  for (const value of Object.values(p.source.files)) sha(value);
  assert.equal(p.source.oracleSha256, p.source.files['benchmarks/mysql-preparation/oracle.mjs']);
  assert.equal(p.source.executableSha256, p.source.files['benchmarks/mysql-preparation/run.mjs']);
  sha(p.dependencies.lockSha256);
  assert.equal(p.dependencies.driver.version, DRIVER_VERSION);
  assert.match(p.dependencies.driver.integrity, /^sha512-/);
  for (const name of [
    'package.json',
    'lib/base/connection.js',
    'lib/commands/prepare.js',
    'lib/commands/execute.js',
    'lib/parsers/parser_cache.js',
  ])
    sha(p.dependencies.driver.files[name]);
  assert.equal(p.artifact.sha256, ARTIFACT_SHA);
  assert.equal(p.artifact.exercised, false);
  assert.equal(report.server.version, '8.4.0');
  sha(report.server.binarySha256);
  assert.match(report.server.binaryVersion, /Ver 8\.4\.0\b/);
  assert.ok(report.server.root.startsWith('/'));
  count(report.server.pid);
  assert.ok(report.server.pid > 0);
  assert.ok(['default', 'ansi-no-backslash'].includes(report.config.mode));
  const modes = new Set(report.server.sqlMode.split(','));
  assert.equal(modes.has('ANSI_QUOTES'), report.config.mode === 'ansi-no-backslash');
  assert.equal(modes.has('NO_BACKSLASH_ESCAPES'), report.config.mode === 'ansi-no-backslash');
  assert.equal(report.server.mode, report.config.mode);
  assert.equal(report.server.performanceSchema, 1);
  assert.deepEqual(report.config.flags, FLAGS);
  assert.equal(report.config.capacity, CAPACITY);
  const { rounds, iterations, seed } = report.config;
  assert.ok(Number.isSafeInteger(rounds) && rounds >= 4 && rounds <= 100);
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 16 && iterations <= 100000);
  assert.equal(seed, 1297696);
  finite(report.driverImportMs);
  finite(report.sourceImportMs);
  finite(report.fixtureInitMs);
  assert.equal(report.network.length, 16);
  for (const s of report.network) finite(s.ms);
  assert.match(report.sql.read, /:p1/);
  assert.equal(report.sql.rollback.length, 4);
  assert.equal(report.samples.length, rounds * SHAPES.length * CASES.length * ARMS.length * 2);
  const seen = new Set();
  for (const s of report.samples) {
    assert.ok(ARMS.includes(s.arm) && SHAPES.includes(s.shape) && CASES.includes(s.name));
    assert.ok(['cold', 'warm'].includes(s.phase));
    count(s.round);
    assert.ok(s.round < rounds);
    const key = JSON.stringify([s.round, s.shape, s.name, s.arm, s.phase]);
    assert.ok(!seen.has(key), 'duplicate sample');
    seen.add(key);
    assert.deepEqual(
      s.order,
      shuffled(ARMS, seed + s.round * 43 + SHAPES.indexOf(s.shape) * 7 + CASES.indexOf(s.name)),
    );
    const n = s.phase === 'cold' ? 1 : iterations;
    assert.equal(s.operations, n);
    assert.equal(s.checkedResults, n);
    assert.equal(s.independentlyCheckedEffects, s.name === 'rollback' ? n : 0);
    finite(s.ms);
    assert.ok(s.ms > 0);
    finite(s.cpuMicros);
    finite(s.initMs);
    finite(s.wallIncludingChecksMs);
    assert.ok(s.wallIncludingChecksMs >= s.ms);
    for (const m of [s.memoryBefore, s.memoryAfter]) {
      assert.ok(m.rss > 0 && m.heapUsed > 0);
    }
    for (const [key, value] of Object.entries(s.protocol)) {
      assert.ok(['Com_stmt_prepare', 'Com_stmt_execute', 'Com_stmt_close', 'Com_stmt_reprepare'].includes(key));
      count(value);
    }
    assert.equal(Object.keys(s.protocol).length, 4);
    const binary = s.arm.startsWith('text') ? 0 : n * (s.name === 'read' ? 1 : 2);
    assert.equal(s.protocol.Com_stmt_execute, binary);
    assert.equal(s.protocol.Com_stmt_prepare, s.phase === 'warm' || !binary ? 0 : s.name === 'read' ? 1 : 2);
    assert.equal(s.protocol.Com_stmt_reprepare, 0);
    assert.equal(s.protocol.Com_stmt_close, 0);
    occupancy(s.occupancy, s.shape);
    assert.equal(
      s.serverPrepared,
      s.occupancy.driver.reduce((n, d) => n + d.size, 0),
    );
    assert.ok(s.recentWire.length > 0 && s.recentWire.length <= 64);
    for (const w of s.recentWire) {
      assert.ok(['query', 'execute'].includes(w.method));
      assert.ok(typeof w.sql === 'string' && w.sql.length);
    }
    for (const c of s.checkout) {
      finite(c.ms);
      assert.equal(c.failed, false);
      assert.ok(c.id > 0);
    }
    if (s.shape === 'connection') assert.equal(s.checkout.length, 0);
    else assert.ok(s.checkout.length >= n, 'actual pool checkouts required');
  }
  const names = [
    'precision-json-null-booleans-dates-unicode-buffer-parameter-changes',
    'rollback-independent-observer',
    'failed-prepare-and-failed-execute-reuse',
    'schema-change-drop-recreate-and-reuse',
    'binding-effects-independent-observer',
    'bounded-churn-driver-js-server',
    'closed-route-and-native-handle',
  ];
  const keys = SHAPES.flatMap((shape) => ARMS.flatMap((arm) => names.map((control) => `${shape}/${arm}/${control}`)));
  keys.push(
    ...[
      'closed-statement-rejects-and-fresh-reuse',
      'pool-checkout-released-handle-and-borrowed-ownership',
      'owned-factory-close',
      'physical-session-prepared-ownership',
    ].map((n) => `undefined/undefined/${n}`),
  );
  if (report.config.mode === 'ansi-no-backslash')
    keys.push(
      ...SHAPES.flatMap((shape) => ['text', 'text-control'].map((arm) => `${shape}/${arm}/text-escaping-no-backslash`)),
    );
  assert.deepEqual(
    report.controls.map((c) => `${c.shape}/${c.arm}/${c.control}`).sort(),
    keys.sort(),
    'complete distinct native controls',
  );
  for (const c of report.controls) {
    if (c.control === 'text-escaping-no-backslash') {
      assert.equal(c.status, 'unsupported');
      assert.notEqual(c.passed, true);
      assert.ok(c.error || c.input !== c.observed);
    } else assert.equal(c.passed, true);
    if (c.control === 'bounded-churn-driver-js-server') {
      assert.equal(c.memory.length, CAPACITY * 8);
      occupancy(c.occupancy, c.shape);
      assert.equal(c.delta.Com_stmt_prepare - c.delta.Com_stmt_reprepare, c.arm.startsWith('text') ? 0 : CAPACITY * 8);
      assert.equal(c.delta.Com_stmt_execute, c.arm.startsWith('text') ? 0 : CAPACITY * 8);
      for (let i = 0; i < c.memory.length; i++) {
        const m = c.memory[i];
        assert.equal(m.i, i);
        assert.ok(m.rss > 0 && m.heapUsed > 0);
        occupancy(m.occupancy, c.shape);
        assert.equal(
          m.server,
          m.occupancy.driver.reduce((n, d) => n + d.size, 0),
        );
        count(m.serverBeforeDrain);
        assert.ok(m.serverBeforeDrain >= m.server && m.serverBeforeDrain <= m.server + m.occupancy.connections);
      }
    }
  }
  assert.deepEqual(report.comparisons, comparisons(report.samples), 'all comparisons derive from raw paired samples');
  assert.ok(report.limits.length >= 7);
  return {
    samples: report.samples.length,
    checkedTimedResults: report.samples.reduce((n, s) => n + s.checkedResults, 0),
    independentlyCheckedEffects: report.samples.reduce((n, s) => n + s.independentlyCheckedEffects, 0),
    controls: report.controls.length,
  };
}
function occupancy(value, shape) {
  count(value.js);
  count(value.connections);
  assert.equal(value.driver.length, value.connections);
  assert.equal(value.connections, shape === 'pool' ? FLAGS.connectionLimit : 1);
  const ids = new Set();
  for (const d of value.driver) {
    count(d.size);
    assert.ok(d.size <= CAPACITY);
    assert.ok(d.id > 0 && !ids.has(d.id));
    ids.add(d.id);
  }
  assert.ok(value.js <= CAPACITY * value.connections);
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(validate(JSON.parse(readFileSync(process.argv[2], 'utf8')))));
