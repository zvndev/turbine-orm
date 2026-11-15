// Dependency-free structural controls; synthetic input is never native evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { rootDriver } from './driver.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import {
  admittedRuntime,
  canonical,
  cases,
  COLUMNS,
  expected,
  expectedDigest,
  finalize,
} from './oracle.mjs';
import { validateCampaign, validateSample } from './validate.mjs';
const counterNames = [
  'Sort_rows',
  'Sort_scan',
  'Sort_range',
  'Sort_merge_passes',
  'Created_tmp_tables',
  'Created_tmp_disk_tables',
  'Com_stmt_prepare',
  'Com_stmt_execute',
  'Com_stmt_close',
  'Bytes_sent',
];
function model(c = cases()[0]) {
  const abort = c.kind.endsWith('abort'),
    error = c.kind === 'driver-error',
    early = ['early', 'tx-success', 'tx-rollback'].includes(c.kind);
  const rows = abort || error ? 0 : early ? (c.arm === 'turbine-rows' ? 1 : c.batchSize) : c.count;
  const result = expectedDigest(rows, c.payloadSize),
    h = 'a'.repeat(64);
  const table = abort ? 'slow_items' : error ? 'missing_items' : 'items';
  const report = {
    config: c,
    status: 'passed',
    cleanupErrors: [],
    databaseRemoved: true,
    applicationSessionsClosed: true,
    ownershipVerified: true,
    route: {
      publicMethod:
        c.arm === 'turbine-rows'
          ? 'findManyStream'
          : c.arm === 'turbine-batches'
            ? 'findManyStreamBatches'
            : null,
      driver: 'mysql2',
      ownership: c.ownership,
      context: c.kind.startsWith('tx-') ? 'ambient-transaction' : 'standalone',
    },
    provenance: {
      driverVersion: '3.24.5',
      driverRoutes: {
        version: '3.24.5',
        raw: 'node_modules/mysql2/promise.js',
        orm: 'node_modules/mysql2/promise.js',
        entrySha256: h,
        packageSha256: h,
        indexSha256: h,
      },
      sourceHead: 'a'.repeat(40),
      node: 'v22.16.0',
      nodeSha256: h,
      driverSha256: h,
      sourceSha256: h,
      harnessSha256: h,
      lockSha256: h,
      serverSha256: h,
      executed: 'source',
      inheritedArtifact: { exercised: false, sha256: h },
    },
    service: { data: '/synthetic/data', port: 1234 },
    server: {
      version: '8.4.0',
      datadir: '/synthetic/data/',
      port: 1234,
      sqlMode: 'STRICT_TRANS_TABLES',
      mode: 'default',
    },
    effectiveSqlMode: 'STRICT_TRANS_TABLES',
    result,
    actualRows: rows,
    actualPayloadBytes: result.payloadBytes,
    batches: [],
    requestedBatchSize: c.batchSize,
    delayMs: c.cadence === 'slow' ? 2 : 0,
    delays: c.cadence === 'slow' ? 1 : 0,
    effect: c.kind === 'tx-success' ? 7 : 0,
    sessionIds: [1],
    commands: [
      {
        sql: `SELECT ${COLUMNS} FROM ${table} ORDER BY id ASC`,
        method: 'query',
        commandClass: 'Query',
        driverIdentityVerified: true,
        callback: c.arm === 'materialized-reference',
        rows: c.count,
        retainedRows: c.arm === 'materialized-reference' ? c.count : 0,
        ended: true,
        fields: 1,
      },
    ],
    pauseCalls: 1,
    resumeCalls: 1,
    destroyCalls: 1,
    cancellation: {
      requested: true,
      observedRunning: true,
      reasonMatched: true,
      serverKillAcknowledged: false,
      residualPolls: 1,
      remaining: 0,
    },
    expectedError: 'ER_NO_SUCH_TABLE',
    returnMs: 1,
    sameCallerConnection: true,
    transactionContext: { connectionId: 1, ownEffect: 7, observerBeforeCommit: 0 },
    readable: { observedPushes: 1, highWaterMarks: [1], maxLength: 1 },
    queryPlan: '{"table_name":"items"}',
    serverProcessRssKiB: 1,
    serverCountersBefore: Object.fromEntries(counterNames.map((key) => [key, 5])),
    serverCountersAfter: Object.fromEntries(counterNames.map((key) => [key, 8])),
    serverCounterDelta: Object.fromEntries(counterNames.map((key) => [key, 3])),
    termination: { wireRows: c.count, commandEnded: true },
    memory: {
      before: { rss: 1, heapUsed: 1, external: 1, arrayBuffers: 1 },
      after: { rss: 2, heapUsed: 2, external: 2, arrayBuffers: 2 },
      peakRss: 2,
      maxRSSKiB: 2,
    },
    driverLeadMax: 1,
    wireBytes: 1,
    elapsedMs: 1,
  };
  const batchSize = c.arm === 'turbine-rows' ? 1 : c.batchSize;
  for (let i = 0; i < rows; i += batchSize) {
    const n = Math.min(batchSize, rows - i);
    let payloadBytes = 0;
    for (let id = i + 1; id <= i + n; id++)
      payloadBytes += Buffer.byteLength(canonical(expected(id, c.payloadSize)));
    report.batches.push({
      rows: n,
      payloadBytes,
    });
  }
  return report;
}
const ordinary = () => model(cases()[0]);
const nativeCampaign = () =>
  JSON.parse(gunzipSync(readFileSync(new URL('./results/native.json.gz', import.meta.url))));
test('non-vacuous exact cardinality/payload profiles and all lifecycle scenarios', () => {
  assert.equal(cases().length, 44);
  assert.deepEqual(
    [
      ...new Set(
        cases()
          .filter((c) => c.kind === 'full')
          .map((c) => c.count),
      ),
    ],
    [129, 1025, 4097],
  );
  for (const kind of [
    'early',
    'abort',
    'driver-error',
    'tx-success',
    'tx-rollback',
    'tx-abort',
    'large-row',
  ])
    assert.equal(cases().filter((c) => c.kind === kind).length, 3);
});
test('positive independent model accepted', () => assert.equal(validateSample(ordinary()), true));
for (const [field, value, match] of [
  ['failure', 'query failed', /retains primary failure/],
  ['interrupted', 'SIGTERM', /retains interruption/],
  ['cleanupErrors', ['cleanup failed'], /retains cleanup errors/],
]) {
  for (const scope of ['sample', 'campaign', 'service'])
    test(`reject ${scope} retained ${field}`, () => {
      const sample = ordinary();
      const campaign = scope === 'sample' ? null : nativeCampaign();
      const target =
        scope === 'sample' ? sample : scope === 'campaign' ? campaign : campaign.services[0];
      target[field] = value;
      assert.throws(
        () => (scope === 'sample' ? validateSample(sample) : validateCampaign(campaign)),
        match,
      );
    });
}
test('historical complete native campaign remains admissible without rewriting observations', () => {
  assert.equal(validateCampaign(nativeCampaign()), true);
});
test('reject balanced batch payload byte transfer', () => {
  const s = model(cases().find((c) => c.kind === 'large-row' && c.arm === 'turbine-batches'));
  validateSample(s);
  const total = s.batches.reduce((sum, batch) => sum + batch.payloadBytes, 0);
  s.batches[0].payloadBytes += s.batches[1].payloadBytes;
  s.batches[1].payloadBytes = 0;
  assert.equal(
    s.batches.reduce((sum, batch) => sum + batch.payloadBytes, 0),
    total,
  );
  assert.throws(() => validateSample(s), /batch payload bytes/);
});
for (const endpoint of ['before', 'after'])
  test(`reject sampled peak RSS below ${endpoint} observation`, () => {
    const s = ordinary();
    s.memory[endpoint].rss = s.memory.peakRss + 1;
    assert.throws(() => validateSample(s), /peak RSS/);
  });
test('reject additional unrecognized counter', () => {
  const s = ordinary();
  s.serverCountersBefore.Unknown = 1;
  assert.throws(() => validateSample(s), /exact named server counters/);
});
for (const group of ['serverCountersBefore', 'serverCountersAfter', 'serverCounterDelta']) {
  test(`reject substituted counter key in ${group}`, () => {
    const s = ordinary();
    s[group].unknown = s[group].Bytes_sent;
    delete s[group].Bytes_sent;
    assert.equal(Object.keys(s[group]).length, 10);
    assert.throws(() => validateSample(s), /exact named server counters/);
  });
  test(`reject inconsistent counter value in ${group}`, () => {
    const s = ordinary();
    s[group].Bytes_sent++;
    assert.throws(() => validateSample(s), /counter delta agrees with endpoints/);
  });
}
for (const [name, mutate, match] of [
  ['empty/missing selected query', (s) => (s.commands = []), /native selected-value query/],
  [
    'materialization masquerading as stream',
    (s) => (s.commands[0].callback = true),
    /materializing callback/,
  ],
  ['driver retained rows', (s) => (s.commands[0].retainedRows = 1), /retained materialized/],
  ['wrong independent values digest', (s) => (s.result.sha256 = 'b'.repeat(64)), /result digest/],
  ['truncated row payload', (s) => s.result.payloadBytes--, /result digest/],
  ['wrong transaction effects', (s) => (s.effect = 7), /transaction effect/],
  ['false database cleanup', (s) => (s.databaseRemoved = false), /database independently/],
  ['false session cleanup', (s) => (s.applicationSessionsClosed = false), /sessions independently/],
  ['missing ownership', (s) => (s.ownershipVerified = false), /ownership probe/],
  [
    'wrong selected columns',
    (s) => (s.commands[0].sql = s.commands[0].sql.replace('prefs, ', '')),
    /SQL oracle/,
  ],
  [
    'wrong row ordering',
    (s) => (s.commands[0].sql = s.commands[0].sql.replace('ASC', 'DESC')),
    /SQL oracle/,
  ],
  ['no backpressure', (s) => (s.pauseCalls = 0), /backpressure/],
  ['missing batch', (s) => s.batches.pop(), /strictly equal/],
  ['wrong requested batch', (s) => s.requestedBatchSize++, /strictly equal/],
  [
    'packed artifact claim',
    (s) => (s.provenance.inheritedArtifact.exercised = true),
    /strictly equal/,
  ],
  ['missing source fingerprint', (s) => (s.provenance.sourceSha256 = ''), /regular expression/],
  ['unsafe driver counter', (s) => (s.driverLeadMax = NaN), /safe counter/],
  ['server endpoint mismatch', (s) => s.server.port++, /strictly equal/],
])
  test(`reject ${name}`, () => {
    const s = ordinary();
    mutate(s);
    assert.throws(() => validateSample(s), match);
  });
for (const [name, mutate, match] of [
  ['omitted signal', (s) => (s.cancellation.requested = false), /AbortSignal was omitted/],
  ['abort before actual query', (s) => (s.cancellation.observedRunning = false), /mid-flight/],
  ['lost abort reason', (s) => (s.cancellation.reasonMatched = false), /AbortSignal reason/],
  ['no socket discard', (s) => (s.destroyCalls = 0), /socket cancellation/],
  ['unsettled residual server work', (s) => (s.cancellation.remaining = 1), /residual server work/],
  [
    'unacknowledged KILL claim',
    (s) => (s.cancellation.serverKillAcknowledged = true),
    /strictly equal/,
  ],
])
  test(`reject ${name}`, () => {
    const s = model(cases().find((c) => c.kind === 'abort'));
    mutate(s);
    assert.throws(() => validateSample(s), match);
  });
test('large row oracle keeps every byte', () => {
  const s = model(cases().find((c) => c.kind === 'large-row'));
  assert.ok(s.result.maxRowBytes > 131072);
  validateSample(s);
  s.result.maxRowBytes = 1024;
  assert.throws(() => validateSample(s), /result digest/);
});
test('ambient transaction owns success and rollback', () => {
  for (const kind of ['tx-success', 'tx-rollback']) {
    const s = model(cases().find((c) => c.kind === kind));
    validateSample(s);
    s.sameCallerConnection = false;
    assert.throws(() => validateSample(s), /caller checkout/);
  }
});
test('slow cadence is required when declared', () => {
  const s = model(cases().find((c) => c.cadence === 'slow'));
  validateSample(s);
  s.delays = 0;
  assert.throws(() => validateSample(s), /slow cadence/);
});
test('materialized arm is explicitly a reference', () => {
  const s = model(cases().find((c) => c.arm === 'materialized-reference'));
  validateSample(s);
  s.commands[0].retainedRows = 0;
  assert.throws(() => validateSample(s));
});
test('empty native campaign refuses', () =>
  assert.throws(
    () => validateCampaign({ status: 'passed', cleanupErrors: [], samples: [] }),
    /native matrix/,
  ));
test('required native prerequisite never skips or loads optional peer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-stream-prereq-'));
  try {
    const path = join(dir, 'report.json');
    const env = { ...process.env };
    delete env.MYSQL_STREAM_IDENTITY;
    const result = spawnSync(
      process.execPath,
      [new URL('./worker.mjs', import.meta.url).pathname, path, '00'],
      {
        env,
        encoding: 'utf8',
      },
    );
    assert.equal(result.status, 1);
    const report = JSON.parse(readFileSync(path));
    assert.equal(report.status, 'failed');
    assert.match(report.failure, /exact Node22|owned-service identity/);
    assert.deepEqual(report.cleanupErrors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('native exact runtime admission refuses near versions', () => {
  for (const v of ['v20.19.0', 'v22.17.0', 'v24.11.0', 'v26.12.0'])
    assert.throws(() => admittedRuntime(v));
  admittedRuntime('v22.16.0');
  admittedRuntime('v24.10.0');
});
test('finalizer retains primary failure and executes every later cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-stream-finalize-'));
  try {
    const r = { failure: 'primary', cleanupErrors: [] };
    let ran = false;
    const p = join(dir, 'r.json');
    assert.equal(
      await finalize(
        r,
        [
          async () => {
            throw new Error('secondary');
          },
          async () => {
            ran = true;
          },
        ],
        p,
      ),
      false,
    );
    assert.equal(ran, true);
    const disk = JSON.parse(readFileSync(p));
    assert.equal(disk.failure, 'primary');
    assert.match(disk.cleanupErrors[0], /secondary/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('root driver resolution resists a nested benchmark shadow installation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-stream-shadow-'));
  try {
    writeFileSync(join(dir, 'package.json'), '{}');
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({
        packages: { 'node_modules/mysql2': { version: '3.24.5', integrity: 'synthetic' } },
      }),
    );
    for (const [parent, version, origin] of [
      [dir, '3.24.5', 'root'],
      [join(dir, 'benchmarks'), '3.15.3', 'shadow'],
    ]) {
      const d = join(parent, 'node_modules/mysql2');
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, 'package.json'),
        JSON.stringify({
          version,
          name: 'mysql2',
          exports: {
            '.': './index.js',
            './promise': './promise.js',
            './package.json': './package.json',
          },
        }),
      );
      writeFileSync(join(d, 'index.js'), `module.exports = { origin: '${origin}' };`);
      writeFileSync(join(d, 'promise.js'), `module.exports = { origin: '${origin}' };`);
    }
    const shadow = createRequire(join(dir, 'benchmarks/workload.mjs'));
    assert.equal(shadow('mysql2/promise').origin, 'shadow');
    const pinned = rootDriver(join(dir, 'package.json'));
    assert.equal(pinned.mysql.origin, 'root');
    assert.equal(pinned.identity.version, '3.24.5');
    assert.equal(pinned.identity.raw, pinned.identity.orm);
    writeFileSync(
      join(dir, 'package-lock.json'),
      JSON.stringify({ packages: { 'node_modules/mysql2': { version: '3.15.3' } } }),
    );
    assert.throws(() => rootDriver(join(dir, 'package.json')), /root lock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
