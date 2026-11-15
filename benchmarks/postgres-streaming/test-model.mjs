// Synthetic guard prerequisites, never native measurements or certification.
import { cases, columns, expected, canonical, sink, FORMAT, selectSQL } from './model.mjs';

export function sample(c = cases()[0]) {
  const pid = 1234, name = 'guard_cursor';
  const count = c.id === 'early' ? (c.arm === 'rows' ? 1 : c.batch) : c.id === 'abort' ? c.batch : c.count;
  const s = { format: FORMAT, status: 'passed', signal: null, errors: [], cleanupErrors: [], config: c, database: 'guard_database',
    backendPid: pid, select: selectSQL(c), trace: [], batches: [], delays: c.delay ? Math.ceil(count / c.batch) : 0,
    portal: { name, is_holdable: false, is_scrollable: false }, portalProbePid: pid, portalCount: 1,
    observedBackend: { pid, datname: 'guard_database', state: 'idle in transaction', xact_start: 'synthetic-tx' },
    memory: { start: { rss: 1 }, end: { rss: 2 }, rssPeak: 2 }, elapsedMs: 1,
    reuse: { pid, portals: 0, value: 42, publicValue: 'row-1-λ', idleState: 'idle', transactionStart: null },
    cleanup: { databaseAbsent: true, handlesClosed: true }, runtime: { version: 'v22.16.0' } };
  s.ownerSettings = { isolation: 'read committed', read_only: 'off', idle_timeout: '0' };
  s.poolSettings = { max: 1, connectionTimeoutMillis: 2000, queryTimeoutMillis: 8000, idleTimeoutMillis: 1000,
    preparedStatements: false, streamIdleTimeoutMs: 0, startupOptions: null, signalSupplied: true };
  const entry = (sql, rows = 0) => ({ sql, pid, nativeRows: rows, rows, retainedRowsMax: rows });
  s.portal.statement = `DECLARE "${name}" NO SCROLL CURSOR FOR ${s.select}`;
  s.trace.push(entry('BEGIN'), entry(s.portal.statement));
  const n = c.id === 'early' ? 1 : c.id === 'abort' ? 2 : Math.ceil(c.count / c.batch);
  for (let i = 0; i < n; i++) {
    const t = entry(`FETCH ${c.batch} FROM "${name}"`, c.id === 'abort' && i === 1 ? 0 : Math.min(c.batch, c.count - i * c.batch));
    if (c.id === 'abort' && i === 1) { t.error = { code: '57014' }; s.abortRejected = true;
      s.abortObservation = { pid, state: 'active', query: t.sql, wait_event: 'PgSleep' }; }
    s.trace.push(t);
  }
  if (c.id !== 'abort') s.trace.push(entry(`CLOSE "${name}"`));
  s.trace.push(entry(c.id === 'abort' ? 'ROLLBACK' : 'COMMIT'));
  s.measureTraceEnd = s.trace.length;
  const output = sink(c.payload);
  for (let id = 1; id <= count;) {
    const rows = Math.min(c.arm === 'rows' ? 1 : c.batch, count - id + 1);
    let bytes = 0;
    for (let j = 0; j < rows; j++) bytes += output.add(expected(id++, c.payload));
    s.batches.push({ rows, bytes });
  }
  s.result = output.finish();
  const first = expected(1, c.payload);
  s.types = Object.fromEntries(columns.map(k => [k, Buffer.isBuffer(first[k]) ? 'Buffer' : first[k] instanceof Date ? 'Date' : typeof first[k]]));
  return s;
}
export function log(s) {
  return s.trace.map(t => `2026-01-01 00:00:00.000 UTC [${s.backendPid}] LOG:  statement: ${t.sql}`).join('\n');
}
export function campaign() {
  const provenance = { execution: 'branch-source-bundle', installedArtifactExecuted: false, bundleSha256: 'a'.repeat(64),
    driver: { entrySha256: 'b'.repeat(64) }, inputs: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`source-${i}`, 'c'.repeat(64)])) };
  provenance.metafile = { inputs: Object.fromEntries(Object.keys(provenance.inputs).map(k => [k, {}])) };
  const samples = cases().map((c, i) => { const s = sample(c); s.backendPid += i; s.portalProbePid += i; s.observedBackend.pid += i;
    if (s.abortObservation) s.abortObservation.pid += i; s.reuse.pid += i; s.provenance = provenance; s.sessionIds = [s.backendPid]; return s; });
  const processes = Array.from({ length: samples.length + 3 }, (_, i) => ({ pid: 20000 + i }));
  const backends = [9000, ...samples.map(s => s.backendPid)];
  const paths = ['/synthetic', '/synthetic/data', '/synthetic/socket'];
  return { processes, observerPid: 9000, serviceRoot: paths[0], data: paths[1], socket: paths[2], port: 5432,
    format: FORMAT, status: 'passed', completeMatrix: true, signal: null, errors: [], cleanupErrors: [], provenance, runtime: { version: 'v22.16.0' },
    server: { version: '18.6', settings: { fsync: 'on', synchronous_commit: 'on', full_page_writes: 'on' } }, samples,
    observers: samples.map(s => ({ database: s.database, sessions: [], databases: 0 })), serverLog: samples.map(log).join('\n'),
    cleanup: { audit: { groups: processes.map(p => ({ pid: p.pid, processAbsent: true, groupAbsent: true })),
      paths: paths.map(path => ({ path, absent: true })), backends: backends.map(pid => ({ pid, absent: true })), portClosed: true } } };
}
