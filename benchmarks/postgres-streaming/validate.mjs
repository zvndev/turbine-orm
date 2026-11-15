import assert from 'node:assert/strict';
import { ownership } from './process.mjs';
import { ARMS, cases, columns, expected, canonical, successful, FORMAT, selectSQL } from './model.mjs';

export function validateDeliveryDemand(trace, delivered, batch) {
  assert.ok(trace.filter(t => /^FETCH /.test(t.sql)).length <= Math.ceil(delivered / batch), 'FETCH must follow consumer demand; prefetched materialization refused');
}

export function serverCommands(log, pid) {
  assert.ok(typeof log === 'string' && log.length, 'Nonempty native server log required');
  const result = [];
  for (const line of log.split('\n')) {
    const match = /^\s*\d{4}-.*?\[(\d+)\].*?LOG:\s+(?:statement:|execute [^:]+:) (.*)$/.exec(line);
    if (match && Number(match[1]) === pid) result.push(match[2]);
  }
  assert.ok(result.length, 'Server-observed backend commands required');
  return result;
}
export function route(sample, log) {
  const { config: c, backendPid } = sample;
  assert.ok(Number.isInteger(sample.measureTraceEnd) && sample.measureTraceEnd > 0 && sample.measureTraceEnd <= sample.trace.length, 'Measured driver trace boundary required');
  const trace = sample.trace.slice(0, sample.measureTraceEnd);
  assert.ok(ARMS.includes(c.arm));
  assert.ok(trace.length > 0, 'Nonempty native driver trace required');
  assert.ok(Number.isInteger(backendPid) && backendPid > 1);
  const stream = trace.filter(t => /^(?:DECLARE |FETCH |CLOSE |BEGIN$|COMMIT$|ROLLBACK$)/.test(t.sql));
  const declarations = stream.filter(t => t.sql.startsWith('DECLARE '));
  assert.equal(declarations.length, 1, 'Exactly one native cursor DECLARE required');
  assert.equal(sample.select, selectSQL(c), 'Independent exact SELECT identity');
  assert.equal(declarations[0].sql, `DECLARE "${sample.portal.name}" NO SCROLL CURSOR FOR ${sample.select}`, 'Independent projection/order cursor SQL');
  const fetches = stream.filter(t => t.sql.startsWith('FETCH '));
  assert.ok(fetches.length > 0, 'Bounded server FETCH required');
  for (const t of fetches) {
    assert.equal(t.sql, `FETCH ${c.batch} FROM "${sample.portal.name}"`, 'Bounded server FETCH quantity required; FETCH ALL refused');
    assert.ok(t.nativeRows <= c.batch && t.retainedRowsMax <= c.batch, 'Driver full-result retention substitution refused');
    if (!t.error) assert.equal(t.rows, t.nativeRows, 'Actual driver dataRow count must match returned rows');
  }
  const expectedFetches = c.id === 'early' ? 1 : c.id === 'abort' ? 2 : Math.ceil(c.count / c.batch);
  assert.equal(fetches.length, expectedFetches, 'Exact FETCH count');
  assert.deepEqual(fetches.map(t => t.nativeRows), c.id === 'early' ? [c.batch] : c.id === 'abort' ? [c.batch, 0] :
    Array.from({ length: expectedFetches }, (_, i) => Math.min(c.batch, c.count - i * c.batch)), 'Exact native FETCH row observations');
  assert.equal(stream[0].sql, 'BEGIN', 'Matched transaction BEGIN');
  assert.equal(stream.at(-1).sql, c.id === 'abort' ? 'ROLLBACK' : 'COMMIT', 'Expected transaction settlement');
  assert.equal(stream.filter(t => t.sql === 'BEGIN').length, 1, 'Exactly one BEGIN');
  assert.equal(stream.filter(t => t.sql === 'COMMIT' || t.sql === 'ROLLBACK').length, 1, 'Exactly one transaction settlement');
  assert.equal(stream.filter(t => t.sql.startsWith('CLOSE ')).length, c.id === 'abort' ? 0 : 1, 'Cursor CLOSE ownership');
  const native = serverCommands(log, backendPid).filter(t => /^(?:DECLARE |FETCH |CLOSE |BEGIN$|COMMIT$|ROLLBACK$)/.test(t));
  assert.deepEqual(native, stream.map(t => t.sql), 'Independent server/driver cursor command reconciliation');
  assert.ok(!trace.some(t => /^SELECT .*FROM "(?:slow_)?items"/.test(t.sql)), 'Buffered SELECT or speculative route substitution refused');
  assert.equal(sample.portal.is_holdable, false, 'Transaction-owned portal');
  assert.equal(sample.portal.is_scrollable, false, 'Non-scroll portal');
  assert.equal(sample.portal.statement, declarations[0].sql, 'Server portal statement identity');
  assert.equal(sample.observedBackend.pid, backendPid, 'Independent backend ownership');
  assert.equal(sample.observedBackend.datname, sample.database, 'Independent database ownership');
  assert.equal(sample.observedBackend.state, 'idle in transaction', 'Suspended cursor owns transaction');
  assert.ok(sample.observedBackend.xact_start, 'Transaction start independently visible');
  assert.equal(sample.portalProbePid, backendPid, 'pg_cursors must be read on the actual owner');
  assert.equal(sample.portalCount, 1, 'Exactly one live owned portal');
  assert.deepEqual(sample.ownerSettings, { isolation: 'read committed', read_only: 'off', idle_timeout: '0' }, 'Matched actual owner transaction settings');
  assert.deepEqual(sample.poolSettings, { max: 1, connectionTimeoutMillis: 2000, queryTimeoutMillis: 8000, idleTimeoutMillis: 1000,
    preparedStatements: false, streamIdleTimeoutMs: 0, startupOptions: null, signalSupplied: true }, 'Matched native pool and stream settings');
  if (c.id === 'abort') {
    assert.equal(sample.abortObservation.pid, backendPid, 'Abort targets observed owner');
    assert.equal(sample.abortObservation.state, 'active', 'Abort while server FETCH actually active');
    assert.equal(sample.abortObservation.query, fetches[1].sql, 'Observed active native FETCH');
    assert.equal(sample.abortObservation.wait_event, 'PgSleep', 'Finite server workload in flight');
    assert.equal(sample.abortRejected, true, 'Pending public pull must reject AbortSignal');
    assert.equal(fetches[1].error?.code, '57014', 'Server confirmed query cancellation');
  }
  return true;
}
export function validateSample(sample, log) {
  successful(sample);
  route(sample, log);
  const c = sample.config;
  const count = c.id === 'early' ? (c.arm === 'rows' ? 1 : c.batch) : c.id === 'abort' ? c.batch : c.count;
  assert.equal(sample.result.rows, count, 'Exact delivered row count');
  assert.equal(sample.result.sha256, sample.result.expectedSha256, 'Independent full-value digest');
  assert.ok(sample.result.bytes > 0 && sample.result.maxRowBytes > c.payload, 'Complete canonical payload accounting');
  const batchSizes = c.arm === 'rows' ? Array(count).fill(1) : Array.from({ length: Math.ceil(count / c.batch) }, (_, i) => Math.min(c.batch, count - i * c.batch));
  assert.deepEqual(sample.batches.map(b => b.rows), batchSizes, 'Exact JS delivery batches');
  let position = 0;
  for (const b of sample.batches) {
    let bytes = 0;
    for (let i = 0; i < b.rows; i++) bytes += Buffer.byteLength(canonical(expected(++position, c.payload)));
    assert.equal(b.bytes, bytes, 'Exact complete batch payload bytes');
  }
  assert.equal(sample.batches.reduce((n, b) => n + b.bytes, 0), sample.result.bytes);
  assert.equal(sample.delays, c.delay ? Math.ceil(count / c.batch) : 0, 'Matched row cadence');
  assert.deepEqual(Object.keys(sample.types), columns, 'Nonempty observed runtime type profile');
  assert.equal(sample.types.huge, 'string'); assert.equal(sample.types.amount, 'string');
  assert.equal(sample.types.stamp, 'Date'); assert.equal(sample.types.bytes, 'Buffer');
  assert.equal(sample.reuse.portals, 0, 'No portal survives connection reuse');
  assert.equal(sample.reuse.value, 42, 'Subsequent native query reuse');
  assert.equal(sample.reuse.publicValue, 'row-1-λ', 'Subsequent public query reuse');
  assert.equal(sample.reuse.idleState, 'idle', 'Reused backend has no open transaction');
  assert.equal(sample.reuse.transactionStart, null);
  if (c.id !== 'abort') assert.equal(sample.reuse.pid, sample.backendPid, 'Normal/early return must reuse same physical backend');
  assert.ok(sample.memory.rssPeak >= sample.memory.start.rss && sample.memory.rssPeak >= sample.memory.end.rss, 'RSS endpoints covered');
  assert.ok(sample.elapsedMs > 0);
  assert.equal(sample.cleanup.databaseAbsent, true);
  assert.equal(sample.cleanup.handlesClosed, true);
  return true;
}
export function validateCampaign(report) {
  successful(report);
  assert.equal(report.format, FORMAT);
  assert.equal(report.completeMatrix, true, 'Complete campaign admission required');
  assert.equal(report.provenance.execution, 'branch-source-bundle');
  assert.equal(report.provenance.installedArtifactExecuted, false);
  const closure = Object.keys(report.provenance.metafile.inputs).filter(f => f !== '<stdin>').sort();
  assert.ok(closure.length > 10, 'Nonempty executed source closure');
  assert.deepEqual(Object.keys(report.provenance.inputs).sort(), closure, 'Complete executed source manifest required');
  for (const hash of Object.values(report.provenance.inputs)) assert.match(hash, /^[a-f\d]{64}$/);
  assert.match(report.provenance.bundleSha256, /^[a-f\d]{64}$/);
  assert.match(report.provenance.driver.entrySha256, /^[a-f\d]{64}$/);
  assert.equal(report.server.version, '18.6');
  for (const setting of ['fsync', 'synchronous_commit', 'full_page_writes']) assert.equal(report.server.settings[setting], 'on');
  assert.deepEqual(report.samples.map(s => { const { database, ...c } = s.config; return c; }), cases(), 'Complete ordered campaign matrix required');
  assert.equal(report.observers.length, cases().length);
  for (let i = 0; i < report.samples.length; i++) {
    validateSample(report.samples[i], report.serverLog);
    assert.deepEqual(report.samples[i].provenance, report.provenance, 'Executed source identity must remain fixed');
    assert.equal(report.samples[i].runtime.version, report.runtime.version, 'Exact child runtime');
    const o = report.observers[i];
    assert.equal(o.database, report.samples[i].database);
    assert.deepEqual(o.sessions, [], 'Independent observer: backend sessions absent');
    assert.equal(o.databases, 0, 'Independent observer: database absent');
  }
  const identities = ownership(report);
  assert.equal(report.cleanup.audit.groups.length, report.samples.length + 3, 'Every worker, bundler, initializer and service group must be audited');
  assert.ok(report.cleanup.audit.groups.every(p => p.processAbsent && p.groupAbsent));
  assert.equal(report.cleanup.audit.paths.length, 3, 'All service root/data/socket paths must be audited');
  assert.ok(report.cleanup.audit.paths.every(p => p.absent));
  assert.ok(report.cleanup.audit.backends.length > report.samples.length, 'Nonempty independent backend process audit required');
  assert.ok(report.cleanup.audit.backends.every(p => p.absent), 'Every owned backend process must be absent');
  assert.deepEqual(report.cleanup.audit.groups.map(p => p.pid), report.processes.map(p => p.pid), 'Cleanup process registry must match');
  assert.deepEqual(report.cleanup.audit.paths.map(p => p.path), [report.serviceRoot, report.data, report.socket], 'Cleanup path registry must match');
  assert.deepEqual(report.cleanup.audit.backends.map(p => p.pid), identities, 'Cleanup backend registry must match');
  assert.equal(report.cleanup.audit.portClosed, true);
  return true;
}
