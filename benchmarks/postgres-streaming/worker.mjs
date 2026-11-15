import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { rootDriver, sha } from './driver.mjs';
import { FORMAT, projection, columns, sink, expected, selectSQL } from './model.mjs';
import { save, within } from './process.mjs';
import { validateDeliveryDemand } from './validate.mjs';

const [output, identityPath, configText, fault = 'none'] = process.argv.slice(2);
assert.ok(output && !existsSync(output), 'New worker report path required');
const report = { format: FORMAT, status: 'running', signal: null, errors: [], cleanupErrors: [], trace: [], batches: [],
  sessionIds: [], cleanup: {}, delays: 0, runtime: { version: process.version, executable: process.execPath, sha256: sha(process.execPath) } };
const checkpoint = () => save(output, report);
checkpoint();
let admin, observer, pool, db, active, signalWake, liveIterator;
const clients = new Set(), cancellers = new Set();
const interrupt = name => {
  report.signal = name; report.status = 'failed'; checkpoint();
  active?.abort(new Error(name)); signalWake?.();
};
const term = () => interrupt('SIGTERM'), int = () => interrupt('SIGINT');
process.on('SIGTERM', term); process.on('SIGINT', int);
const memory = () => ({ ...process.memoryUsage(), at: performance.now() });
let sampler, nativeOwner;
try {
  assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'Exact native Node22.16.0/24.10.0 required');
  assert.ok(['none', 'fetch-all', 'materialize', 'omit-abort', 'primary', 'cleanup', 'finalize', 'double-failure', 'signal'].includes(fault), 'Known fault required');
  const identity = JSON.parse(readFileSync(identityPath));
  assert.equal(identity.status, 'ready'); assert.equal(identity.uid, process.getuid());
  assert.equal(identity.bundleSha256, sha(identity.bundle));
  report.provenance = JSON.parse(readFileSync(identity.bundle + '.json'));
  assert.equal(report.provenance.bundleSha256, identity.bundleSha256);
  report.config = JSON.parse(configText);
  const c = report.config;
  report.database = c.database;
  assert.match(c.database, /^pg_stream_[a-f\d]{12}_\d+$/);
  const { pg, identity: driverIdentity } = rootDriver();
  assert.deepEqual(driverIdentity, report.provenance.driver, 'Worker and bundled production driver must match root lock');
  const library = await import(pathToFileURL(identity.bundle));
  const connection = { host: '127.0.0.1', port: identity.port, user: 'stream_owner', database: 'postgres',
    connectionTimeoutMillis: 2000, query_timeout: 8000, application_name: 'stream-controller' };
  async function client(database = 'postgres') {
    const p = new pg.Client({ ...connection, database }); clients.add(p); p.on('error', () => {});
    await p.connect(); report.sessionIds.push(p.processID); checkpoint(); return p;
  }
  admin = await client(); observer = await client();
  await admin.query(`CREATE DATABASE "${c.database}"`);
  checkpoint();
  const setup = await client(c.database);
  await setup.query('CREATE TABLE items (id integer PRIMARY KEY, enabled boolean, huge bigint, amount numeric(24,4), prefs jsonb, stamp timestamptz, bytes bytea, label text, payload text)');
  await setup.query(`INSERT INTO items SELECT i, i % 2 = 0, 9007199254740993::bigint + i, i + 0.1250::numeric, jsonb_build_object('n', i, 'text', $3::text), $4::timestamptz + i * interval '1 second', decode(lpad(to_hex(i % 256), 2, '0') || '00ff', 'hex'), 'row-' || i || '-' || $3::text, repeat('x', $2) FROM generate_series(1, $1::integer) AS i`,
    [c.count, c.payload, 'λ', '2020-01-01T00:00:00Z']);
  await setup.query("CREATE FUNCTION pause_row(v integer) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN PERFORM pg_sleep(0.03); RETURN v > 0; END $$");
  await setup.query('CREATE VIEW slow_items AS SELECT id, enabled, huge, amount, prefs, stamp, bytes, label, payload FROM items WHERE pause_row(id)');
  await setup.query('ANALYZE items');
  report.fixture = { count: Number((await setup.query('SELECT count(*) FROM items')).rows[0].count), first: (await setup.query(`SELECT ${projection} FROM items ORDER BY id LIMIT 1`)).rows[0] };
  assert.equal(report.fixture.count, c.count);
  assert.deepEqual(report.fixture.first, expected(1, c.payload));
  await setup.end(); clients.delete(setup);
  pool = new pg.Pool({ ...connection, database: c.database, max: 1, application_name: 'stream-workload', idleTimeoutMillis: 1000 });
  report.poolSettings = { max: 1, connectionTimeoutMillis: 2000, queryTimeoutMillis: 8000, idleTimeoutMillis: 1000,
    preparedStatements: false, streamIdleTimeoutMs: 0, startupOptions: null, signalSupplied: true };
  pool.on('error', () => {});
  pool.on('connect', p => {
    assert.ok(p instanceof pg.Client, 'Actual locked pg Client required');
    report.sessionIds.push(p.processID); checkpoint();
    let current;
    p.connection.on('dataRow', msg => {
      if (!current) return;
      current.nativeRows++;
      current.fieldBytes += msg.fields.reduce((n, v) => n + (v === null ? 0 : Buffer.byteLength(v)), 0);
      current.retainedRowsMax = Math.max(current.retainedRowsMax, p.activeQuery?._result?.rows?.length ?? 0);
    });
    const original = p.query.bind(p);
    p.query = function(config, values, callback) {
      let sql = typeof config === 'string' ? config : config.text;
      if (fault === 'fetch-all' && /^FETCH /.test(sql)) {
        sql = sql.replace(/^FETCH \d+ /, 'FETCH ALL ');
        config = typeof config === 'string' ? sql : { ...config, text: sql };
      }
      const rec = { sql, params: (typeof config === 'string' ? values : config.values) ?? [], pid: p.processID,
        nativeRows: 0, fieldBytes: 0, retainedRowsMax: 0 };
      report.trace.push(rec); current = rec;
      const done = (error, result) => {
        if (current === rec) current = null;
        if (error) rec.error = { code: error.code ?? null, message: error.message };
        else { rec.rows = result.rows.length; rec.command = result.command; rec.rowCount = result.rowCount; }
      };
      // Preserve the real pg callback/Promise overload; no wrapper pool or fake cursor.
      const cb = typeof values === 'function' ? values : callback;
      if (cb) return original(config, typeof values === 'function' ? (e, r) => { done(e, r); cb(e, r); } : values,
        typeof values === 'function' ? undefined : (e, r) => { done(e, r); cb(e, r); });
      const result = original(config, values);
      if (p.activeQuery) assert.ok(p.activeQuery instanceof pg.Query, 'Actual locked pg Query required');
      return result.then(r => { done(null, r); return r; }, e => { done(e); throw e; });
    };
  });
  const definitions = { id: { type: 'integer', primaryKey: true }, enabled: { type: 'boolean' }, huge: { type: 'bigint' },
    amount: { type: 'numeric' }, prefs: { type: 'jsonb' }, stamp: { type: 'timestamptz' }, bytes: { type: 'bytea' }, label: { type: 'text' }, payload: { type: 'text' } };
  const schema = library.schemaDefToMetadata(library.defineSchema({ items: definitions, slow_items: definitions }));
  db = new library.TurbineClient({ pool, warnOnUnlimited: false, streamIdleTimeoutMs: 0, preparedStatements: false,
    logger: {}, diagnostics: { mode: 'production', advice: false, cacheCheck: 'off' } }, schema);
  const table = c.id === 'abort' ? 'slow_items' : 'items';
  report.select = selectSQL(c);
  active = new AbortController();
  async function* raw() {
    const p = await pool.connect(); nativeOwner = p; let failed = false;
    const abort = () => {
      if (!p.activeQuery || active.signal.aborted === false) return;
      const cancel = new pg.Client(connection); cancellers.add(cancel);
      cancel.on('error', () => {});
      cancel.connection.once('end', () => { cancel.connection.stream.destroy(); cancellers.delete(cancel); });
      cancel.cancel(p, p.activeQuery);
    };
    active.signal.addEventListener('abort', abort);
    try {
      await p.query('BEGIN');
      await p.query(`DECLARE "raw_stream_cursor" NO SCROLL CURSOR FOR ${report.select}`);
      while (true) {
        const batch = await p.query(`FETCH ${c.batch} FROM "raw_stream_cursor"`);
        if (!batch.rows.length) break;
        yield batch.rows;
        if (batch.rows.length < c.batch) break;
      }
    } catch (e) {
      failed = true; await p.query('ROLLBACK'); throw e;
    } finally {
      active.signal.removeEventListener('abort', abort);
      if (!failed) { await p.query('CLOSE "raw_stream_cursor"'); await p.query('COMMIT'); }
      p.release();
    }
  }
  async function* materialized() {
    const rows = await pool.query(report.select);
    for (let i = 0; i < rows.rows.length; i += c.batch) yield rows.rows.slice(i, i + c.batch);
  }
  const args = { orderBy: { id: 'asc' }, select: Object.fromEntries(columns.map(k => [k, true])), batchSize: c.batch,
    idleTimeoutMs: 0, signal: fault === 'omit-abort' ? new AbortController().signal : active.signal };
  const iterator = fault === 'materialize' ? materialized() : c.arm === 'raw' ? raw() :
    c.arm === 'rows' ? db.table(table).findManyStream(args) : db.table(table).findManyStreamBatches(args);
  liveIterator = iterator;
  const outputSink = sink(c.payload);
  report.memory = { start: memory(), rssPeak: 0 };
  const sampleMemory = () => { report.memory.rssPeak = Math.max(report.memory.rssPeak, process.memoryUsage().rss); };
  sampleMemory(); sampler = setInterval(sampleMemory, 2);
  const start = performance.now(); let delivered = 0;
  const consume = async step => {
    assert.equal(step.done, false);
    const batch = c.arm === 'rows' && fault !== 'materialize' ? [step.value] : step.value;
    if (!report.types) report.types = Object.fromEntries(columns.map(k => [k, Buffer.isBuffer(batch[0][k]) ? 'Buffer' : batch[0][k] instanceof Date ? 'Date' : typeof batch[0][k]]));
    let bytes = 0;
    for (const row of batch) bytes += outputSink.add(row);
    report.batches.push({ rows: batch.length, bytes }); delivered += batch.length;
    validateDeliveryDemand(report.trace, delivered, c.batch);
    if (c.delay && (delivered % c.batch === 0 || delivered === c.count)) { await delay(c.delay); report.delays++; }
  };
  const first = await iterator.next();
  await consume(first);
  // Find the actual checked-out physical owner from the root pg pool. pg_cursors
  // is session-local: an observer on another backend cannot see this portal.
  nativeOwner ??= pool._clients.find(p => !pool._idle.some(i => i.client === p));
  assert.ok(nativeOwner, 'Live native cursor owner required; materialization is not streaming');
  report.backendPid = nativeOwner.processID;
  const portal = await nativeOwner.query('SELECT pg_backend_pid() AS pid, name, statement, is_holdable, is_scrollable FROM pg_cursors');
  report.ownerSettings = (await nativeOwner.query("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, current_setting('idle_in_transaction_session_timeout') AS idle_timeout")).rows[0];
  report.portalCount = portal.rows.length; assert.equal(portal.rows.length, 1, 'Live owned portal required');
  report.portalProbePid = portal.rows[0].pid; report.portal = { ...portal.rows[0] }; delete report.portal.pid;
  report.observedBackend = (await observer.query('SELECT pid, datname, state, xact_start FROM pg_stat_activity WHERE pid = $1', [report.backendPid])).rows[0];
  checkpoint();
  if (fault === 'primary' || fault === 'double-failure') throw new Error('Injected primary workload failure');
  if (c.id === 'early') await iterator.return();
  else if (c.id === 'abort') {
    while (delivered < c.batch) await consume(await iterator.next());
    const pending = iterator.next();
    // Attach immediately, so a real cancellation cannot become unhandled while
    // the independent observer is still checking server ownership.
    const settled = pending.then(value => ({ value }), error => ({ error }));
    await delay(40);
    report.abortObservation = (await observer.query('SELECT pid, state, query, wait_event FROM pg_stat_activity WHERE pid = $1', [report.backendPid])).rows[0];
    assert.equal(report.abortObservation.state, 'active', 'Native FETCH must be in flight before AbortSignal');
    assert.equal(report.abortObservation.wait_event, 'PgSleep', 'Native wait prerequisite');
    if (fault === 'signal') {
      const incoming = new Promise(resolve => { signalWake = resolve; });
      process.stdout.write('signal-ready\n'); await within(incoming, 2000, 'Expected external SIGTERM missing');
    } else active.abort(new Error('stream-abort'));
    const outcome = await within(settled, 3000, 'Abort pull settlement deadline');
    report.abortRejected = Boolean(outcome.error);
    assert.equal(report.abortRejected, true, 'AbortSignal must reject the pending pull');
    await iterator.return().catch(() => {});
  } else {
    for (;;) { const step = await iterator.next(); if (step.done) break; await consume(step); }
  }
  report.elapsedMs = performance.now() - start;
  report.measureTraceEnd = report.trace.length;
  clearInterval(sampler); report.memory.end = memory(); sampleMemory();
  report.result = outputSink.finish();
  const fetchTrace = report.trace.filter(t => /^FETCH /.test(t.sql));
  report.observations = { driver: 'pg JavaScript protocol dataRow events; no pg-native addon',
    nativeRows: fetchTrace.reduce((n, t) => n + t.nativeRows, 0),
    pgFieldBytes: fetchTrace.reduce((n, t) => n + t.fieldBytes, 0),
    maxDriverRetainedRows: Math.max(...fetchTrace.map(t => t.retainedRowsMax)),
    deliveredRows: report.result.rows, canonicalPayloadBytes: report.result.bytes,
    note: 'Field bytes exclude protocol framing; canonical bytes are UTF-8 application representation. RSS covers this worker process only and is sampled.' };
  const reused = await pool.connect();
  try {
    report.reuse = { pid: reused.processID, portals: (await reused.query('SELECT name FROM pg_cursors')).rows.length,
      value: (await reused.query('SELECT 42::integer AS value')).rows[0].value };
  } finally { reused.release(); }
  report.reuse.publicValue = (await db.table('items').findUnique({ where: { id: 1 }, select: { label: true } })).label;
  const reusedState = (await observer.query('SELECT state, xact_start FROM pg_stat_activity WHERE pid = $1', [report.reuse.pid])).rows[0];
  report.reuse.idleState = reusedState.state; report.reuse.transactionStart = reusedState.xact_start;
  report.status = report.signal ? 'failed' : 'passed';
} catch (error) {
  report.status = 'failed'; report.errors.push({ message: error.message, stack: error.stack }); checkpoint();
} finally {
  clearInterval(sampler);
  const cleanup = async (name, fn) => { try { await fn(); } catch (error) { report.status = 'failed'; report.cleanupErrors.push({ name, message: error.message }); checkpoint(); } };
  active?.abort(new Error('worker-finalization'));
  await cleanup('iterator', async () => { if (liveIterator) await within(liveIterator.return(), 3000, 'Iterator closure deadline'); });
  for (const cancel of cancellers) cancel.connection.stream.destroy();
  await cleanup('pool', async () => {
    if (pool) {
      try { await within(pool.end(), 2500, 'Pool closure deadline'); }
      catch (e) { for (const p of pool._clients) p.connection.stream.destroy(); throw e; }
    }
    report.cleanup.handlesClosed = !pool || pool._clients.length === 0;
  });
  for (const p of clients) if (p !== admin && p !== observer) await cleanup('fixture-client', () => within(p.end(), 2000, 'Fixture client end deadline'));
  await cleanup('database', async () => {
    if (admin && report.database && fault !== 'cleanup') await admin.query(`DROP DATABASE IF EXISTS "${report.database}" WITH (FORCE)`);
    if (admin && report.database) report.cleanup.databaseAbsent = (await admin.query('SELECT datname FROM pg_database WHERE datname=$1', [report.database])).rows.length === 0;
  });
  for (const p of [observer, admin]) if (p) await cleanup('observer/admin', () => within(p.end(), 2000, 'Observer/admin end deadline'));
  if (fault === 'finalize' || fault === 'double-failure') { report.status = 'failed'; report.cleanupErrors.push({ name: 'finalize', message: 'Injected post-cleanup finalizer failure' }); }
  if (report.signal) report.status = 'failed';
  report.finishedAt = new Date().toISOString(); checkpoint();
  process.removeListener('SIGTERM', term); process.removeListener('SIGINT', int);
  if (report.signal) process.kill(process.pid, report.signal);
  else process.exitCode = report.status === 'passed' ? 0 : 1;
}
