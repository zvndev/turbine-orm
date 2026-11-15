import assert from 'node:assert/strict';
import { canonical, cases, expected, expectedDigest, COLUMNS } from './oracle.mjs';
const integer = (n) => assert.ok(Number.isSafeInteger(n) && n >= 0, 'nonnegative safe counter');
const hash = (s) => assert.match(s, /^[a-f0-9]{64}$/);
const counters = [
  'Bytes_sent',
  'Com_stmt_close',
  'Com_stmt_execute',
  'Com_stmt_prepare',
  'Created_tmp_disk_tables',
  'Created_tmp_tables',
  'Sort_merge_passes',
  'Sort_range',
  'Sort_rows',
  'Sort_scan',
];
function successful(report, scope) {
  assert.equal(report.status, 'passed', `${scope} passed status`);
  assert.equal(report.failure, undefined, `${scope} retains primary failure`);
  assert.equal(report.interrupted, undefined, `${scope} retains interruption`);
  assert.deepEqual(report.cleanupErrors, [], `${scope} retains cleanup errors`);
}
export function validateSample(s) {
  const c = s.config;
  assert.deepEqual(
    c,
    cases().find((x) => x.id === c.id),
    'exact workload configuration',
  );
  successful(s, 'sample');
  assert.equal(s.databaseRemoved, true, 'database independently removed');
  assert.equal(s.applicationSessionsClosed, true, 'sessions independently closed');
  assert.equal(s.ownershipVerified, true, 'connection ownership probe');
  assert.ok(['v22.16.0', 'v24.10.0'].includes(s.provenance.node));
  for (const key of [
    'nodeSha256',
    'driverSha256',
    'sourceSha256',
    'harnessSha256',
    'lockSha256',
    'serverSha256',
  ])
    hash(s.provenance[key]);
  assert.equal(s.provenance.executed, 'source');
  assert.equal(s.provenance.driverVersion, '3.24.5');
  const d = s.provenance.driverRoutes;
  assert.equal(d.version, '3.24.5');
  assert.equal(d.raw, 'node_modules/mysql2/promise.js');
  assert.equal(d.orm, d.raw);
  for (const k of ['entrySha256', 'packageSha256', 'indexSha256']) hash(d[k]);
  assert.match(s.provenance.sourceHead, /^[a-f0-9]{40}$/);
  assert.deepEqual(s.route, {
    publicMethod:
      c.arm === 'turbine-rows'
        ? 'findManyStream'
        : c.arm === 'turbine-batches'
          ? 'findManyStreamBatches'
          : null,
    driver: 'mysql2',
    ownership: c.ownership,
    context: c.kind.startsWith('tx-') ? 'ambient-transaction' : 'standalone',
  });
  assert.equal(s.provenance.inheritedArtifact.exercised, false);
  hash(s.provenance.inheritedArtifact.sha256);
  assert.equal(s.server.version, '8.4.0');
  assert.equal(s.server.datadir, s.service.data + '/');
  assert.equal(s.server.port, s.service.port);
  assert.ok(['default', 'ansi-no-backslash'].includes(s.server.mode));
  for (const mode of ['ANSI_QUOTES', 'NO_BACKSLASH_ESCAPES'])
    assert.equal(s.server.sqlMode.split(',').includes(mode), s.server.mode === 'ansi-no-backslash');
  assert.ok(s.effectiveSqlMode.length);
  assert.deepEqual(
    new Set(s.effectiveSqlMode.split(',')),
    new Set([
      ...s.server.sqlMode.split(','),
      ...(c.ownership === 'factory' ? ['NO_BACKSLASH_ESCAPES'] : []),
    ]),
  );
  const isAbort = c.kind.endsWith('abort'),
    isError = c.kind === 'driver-error';
  const early = ['early', 'tx-success', 'tx-rollback'].includes(c.kind);
  const rows =
    isAbort || isError ? 0 : early ? (c.arm === 'turbine-rows' ? 1 : c.batchSize) : c.count;
  assert.deepEqual(
    s.result,
    expectedDigest(rows, c.payloadSize),
    'independent complete result digest',
  );
  assert.equal(s.actualRows, rows);
  assert.equal(s.actualPayloadBytes, s.result.payloadBytes);
  assert.equal(
    s.batches.reduce((a, b) => a + b.rows, 0),
    rows,
  );
  assert.equal(
    s.batches.reduce((a, b) => a + b.payloadBytes, 0),
    s.actualPayloadBytes,
  );
  let rowId = 1;
  for (const b of s.batches) {
    integer(b.rows);
    assert.ok(b.rows > 0 && b.rows <= (c.arm === 'turbine-rows' ? 1 : c.batchSize));
    integer(b.payloadBytes);
    let bytes = 0;
    for (let i = 0; i < b.rows; i++)
      bytes += Buffer.byteLength(canonical(expected(rowId++, c.payloadSize)));
    assert.equal(b.payloadBytes, bytes, 'batch payload bytes match its complete ordered rows');
  }
  assert.equal(s.requestedBatchSize, c.batchSize);
  assert.equal(s.delayMs, c.cadence === 'slow' ? 2 : 0);
  if (c.cadence === 'slow') assert.ok(s.delays > 0, 'slow cadence executed');
  assert.equal(s.effect, c.kind === 'tx-success' ? 7 : 0, 'independent transaction effect');
  assert.ok(s.commands.length > 0, 'missing native selected-value query');
  assert.ok(s.sessionIds.length > 0);
  const selects = s.commands.filter((q) =>
    /\bFROM\s+`?(items|slow_items|missing_items)`?\b/i.test(q.sql),
  );
  assert.equal(selects.length, 1, 'one actual native selected-value query');
  const q = selects[0];
  assert.equal(q.method, 'query');
  const table = isAbort ? 'slow_items' : isError ? 'missing_items' : 'items';
  const normalized = q.sql
    .replaceAll('`', '')
    .replaceAll(table + '.', '')
    .replace(/\s+/g, ' ')
    .trim();
  assert.equal(
    normalized,
    `SELECT ${COLUMNS} FROM ${table} ORDER BY id ASC`,
    'independent exact selected-column SQL oracle',
  );
  assert.equal(q.commandClass, 'Query');
  assert.equal(q.driverIdentityVerified, true, 'actual driver command identity');
  if (!isAbort && !isError) {
    if (!(c.kind === 'early' && c.arm !== 'raw-stream')) assert.equal(q.ended, true);
    assert.equal(q.fields, 1);
  }
  if (c.arm !== 'materialized-reference') {
    assert.equal(q.callback, false, 'stream claim used materializing callback');
    assert.equal(q.retainedRows, 0, 'stream driver retained materialized result');
    if (!isError && !isAbort)
      assert.ok(s.pauseCalls > 0 && s.resumeCalls > 0, 'native driver backpressure observed');
  } else {
    assert.equal(q.callback, true);
    assert.equal(q.retainedRows, c.count);
  }
  if (!isError && !isAbort && c.arm !== 'materialized-reference') {
    if (c.kind === 'early' && c.arm !== 'raw-stream')
      assert.ok(q.rows >= rows && q.rows <= c.count, 'observed early discard wire rows');
    else assert.equal(q.rows, c.count, 'all wire rows delivered or drained');
  }
  if (isAbort) {
    assert.equal(s.cancellation.requested, true, 'AbortSignal was omitted');
    assert.equal(s.cancellation.observedRunning, true, 'abort must be mid-flight on server');
    assert.equal(s.cancellation.reasonMatched, true, 'exact AbortSignal reason');
    assert.ok(s.destroyCalls > 0, 'socket cancellation');
    assert.equal(s.cancellation.serverKillAcknowledged, false);
    integer(s.cancellation.residualPolls);
    assert.equal(s.cancellation.remaining, 0, 'residual server work eventually settles');
  }
  if (isError) assert.match(s.expectedError, /ER_NO_SUCH_TABLE|doesn't exist/);
  if (early) assert.ok(s.returnMs >= 0);
  if (c.kind.startsWith('tx-')) {
    assert.equal(s.transactionContext.ownEffect, 7);
    assert.equal(s.transactionContext.observerBeforeCommit, 0);
    assert.ok(s.sessionIds.includes(s.transactionContext.connectionId));
  }
  if (c.kind.startsWith('tx-') && !isAbort)
    assert.equal(s.sameCallerConnection, true, 'transaction retains caller checkout');
  for (const key of ['rss', 'heapUsed', 'external', 'arrayBuffers']) {
    integer(s.memory.before[key]);
    integer(s.memory.after[key]);
  }
  integer(s.memory.peakRss);
  assert.ok(
    s.memory.peakRss >= Math.max(s.memory.before.rss, s.memory.after.rss),
    'sampled peak RSS covers both observed endpoints',
  );
  integer(s.memory.maxRSSKiB);
  integer(s.driverLeadMax);
  integer(s.wireBytes);
  for (const group of ['serverCountersBefore', 'serverCountersAfter', 'serverCounterDelta']) {
    assert.deepEqual(Object.keys(s[group]).sort(), counters, 'exact named server counters');
    for (const value of Object.values(s[group])) integer(value);
  }
  for (const key of counters)
    assert.equal(
      s.serverCounterDelta[key],
      s.serverCountersAfter[key] - s.serverCountersBefore[key],
      `server counter delta agrees with endpoints: ${key}`,
    );
  integer(s.serverProcessRssKiB);
  assert.equal(s.termination.wireRows, q.rows);
  assert.equal(s.termination.commandEnded, q.ended);
  if (c.arm !== 'materialized-reference' && !isAbort && !isError) {
    assert.ok(s.readable.observedPushes > 0);
    assert.deepEqual(s.readable.highWaterMarks, [1]);
    integer(s.readable.maxLength);
  }
  assert.ok(s.queryPlan.length > 0);
  assert.ok(JSON.stringify(JSON.parse(s.queryPlan)).includes('items'));
  assert.ok(s.elapsedMs >= 0);
  return true;
}
export function validateCampaign(r) {
  successful(r, 'campaign');
  const expected = cases();
  assert.equal(r.samples.length, expected.length * 4, 'non-vacuous exact native matrix');
  assert.equal(r.services.length, 2);
  for (const s of r.services) {
    successful(s, 'service');
    assert.ok(
      s.dataAbsent &&
        s.socketAbsent &&
        s.portClosed &&
        s.serverGroupAbsent &&
        s.childGroupAbsent &&
        s.initializationGroupAbsent,
      'service cleanup',
    );
  }
  const keys = new Set();
  for (const key of ['sourceSha256', 'harnessSha256', 'sourceHead', 'lockSha256', 'driverSha256'])
    assert.equal(
      new Set(r.samples.map((s) => s.provenance[key])).size,
      1,
      'one fixed source/driver corpus',
    );
  for (const s of r.samples) {
    validateSample(s);
    const key = `${s.server.mode}/${s.provenance.node}/${s.config.id}`;
    assert.ok(!keys.has(key), 'duplicate sample');
    keys.add(key);
  }
  for (const mode of ['default', 'ansi-no-backslash'])
    for (const node of ['v22.16.0', 'v24.10.0'])
      for (const c of expected)
        assert.ok(keys.has(`${mode}/${node}/${c.id}`), 'missing native matrix cell');
  assert.equal(r.independentCleanup.length, r.samples.length);
  for (let i = 0; i < r.samples.length; i++) {
    const s = r.samples[i],
      c = r.independentCleanup[i];
    assert.equal(c.workerPid, s.provenance.pid);
    assert.equal(c.database, s.database);
    assert.deepEqual(c.sessionIds, s.sessionIds);
    assert.deepEqual(c.remainingSessions, []);
    assert.equal(c.remainingDatabases, 0);
  }
  return true;
}
