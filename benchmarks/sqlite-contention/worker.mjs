import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { BUSY_MS, STREAM_SQL, READ_SQL, TYPE_SQL } from './model.mjs';

const [route, path, bundle, fault] = process.argv.slice(2);
let raw, client, stream, aborter, pending;
let audit = [];
const sha = b => createHash('sha256').update(b).digest('hex');
const plain = x => JSON.parse(JSON.stringify(x));
const errorInfo = e => ({ name: e.name, code: e.code, message: e.message, errcode: e.errcode });
let runtime;
function wrapHandle(db) {
  const prepare = db.prepare.bind(db);
  db.prepare = sql => {
    audit.push({ sql, method: 'prepare' });
    const stmt = prepare(sql);
    for (const key of ['all', 'run', 'iterate']) {
      const fn = stmt[key].bind(stmt);
      stmt[key] = (...args) => {
        audit.push({ sql, method: key, bindings: plain(args) });
        const result = fn(...args);
        if (key === 'iterate') {
          const next = result.next.bind(result);
          const close = result.return.bind(result);
          result.next = (...a) => { audit.push({ sql, method: 'next' }); return next(...a); };
          result.return = (...a) => { audit.push({ sql, method: 'return' }); return close(...a); };
        }
        return result;
      };
    }
    const describe = stmt.columns.bind(stmt);
    stmt.columns = () => { const columns = describe(); audit.push({ sql, method: 'columns', columns: plain(columns) }); return columns; };
    return stmt;
  };
}
async function query(sql) {
  if (route === 'turbine') {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return (await client.pool.query(sql)).rows;
    return client.rawUnsafe(sql);
  }
  const stmt = raw.prepare(sql);
  if (/^(SELECT|PRAGMA)/.test(sql)) {
    const rows = stmt.all();
    // Independent baseline policy: describe AFTER stepping; only declared BOOL decodes.
    const columns = stmt.columns();
    return rows.map(row => Object.fromEntries(Object.entries(row).map(([k, v]) =>
      [k, /BOOL/i.test(columns.find(c => c.name === k)?.type ?? '') && v !== null ? Boolean(v) : v])));
  }
  stmt.run();
  return [];
}
async function openStream() {
  aborter = new AbortController();
  if (route === 'turbine') stream = client.table('items').findManyStream({ orderBy: { id: 'asc' }, batchSize: 1, signal: aborter.signal });
  else {
    const iterator = raw.prepare(STREAM_SQL).iterate();
    stream = {
      async next() {
        try { aborter.signal.throwIfAborted(); return iterator.next(); }
        catch (e) { iterator.return(); throw e; }
      },
      async return() { iterator.return(); return { done: true }; },
    };
  }
  const first = await stream.next();
  assert.equal(first.done, false);
  return first.value;
}
async function operation(action) {
  switch (action) {
    case 'init': {
      const { DatabaseSync } = await import('node:sqlite'); // Required, never skipped.
      raw = new DatabaseSync(path);
      assert.equal(typeof raw.isTransaction, 'boolean', 'isTransaction required');
      const probe = raw.prepare('SELECT 1');
      assert.equal(typeof probe.columns, 'function', 'columns() required');
      const iterator = probe.iterate();
      assert.equal(typeof iterator.return, 'function', 'iterator.return required');
      iterator.return();
      raw.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${BUSY_MS}; PRAGMA wal_autocheckpoint=0`);
      runtime = { node: process.version, execPath: process.execPath, binarySha256: sha(readFileSync(process.execPath)),
        sqlite: plain(raw.prepare('SELECT sqlite_version() AS version, sqlite_source_id() AS sourceId').get()) };
      if (route === 'turbine') {
        const api = await import(pathToFileURL(bundle).href);
        client = api.turbineSqlite(raw, api.schemaDefToMetadata(api.defineSchema({ items: {
          id: { type: 'integer', primaryKey: true }, n: { type: 'integer' },
        } })), { busyTimeoutMs: BUSY_MS, logger: {}, warnOnUnlimited: false, streamIdleTimeoutMs: 0 });
      }
      if (route === 'turbine') {
        const manifest = JSON.parse(readFileSync(`${bundle}.json`));
        const req = createRequire(import.meta.url);
        const loaded = req.cache[manifest.dependencies.pg.entry];
        assert.ok(loaded?.loaded, 'root-lock pg entry must actually be loaded by the bundle');
        runtime.loadedPg = { entry: loaded.filename, entrySha256: sha(readFileSync(loaded.filename)),
          version: JSON.parse(readFileSync(new URL('../../node_modules/pg/package.json', import.meta.url))).version };
        assert.equal(runtime.loadedPg.entrySha256, manifest.dependencies.pg.entrySha256);
        assert.equal(runtime.loadedPg.version, manifest.dependencies.pg.version);
      }
      const pragmas = Object.fromEntries(['journal_mode', 'synchronous', 'foreign_keys', 'busy_timeout', 'wal_autocheckpoint'].map(k =>
        [k, Object.values(raw.prepare(`PRAGMA ${k}`).get())[0]]));
      wrapHandle(raw);
      return { pid: process.pid, ppid: process.ppid, runtime, pragmas, suppliedHandle: true };
    }
    case 'setup':
      for (const sql of ['CREATE TABLE items(id INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
        'CREATE TABLE typed(value TEXT)', "INSERT INTO typed VALUES('1')", 'INSERT INTO items VALUES(1,10),(2,20),(3,30)']) await query(sql);
      return true;
    case 'ready': if (fault === 'command-timeout') return new Promise(() => {}); return true;
    case 'snapshot':
      await query('BEGIN');
      return query(READ_SQL);
    case 'commit':
      await query('BEGIN IMMEDIATE');
      await query('UPDATE items SET n=11 WHERE id=1');
      await query('INSERT INTO items VALUES(4,40)');
      await query('COMMIT');
      return true;
    case 'snapshot-read': return query(READ_SQL);
    case 'snapshot-end': await query('ROLLBACK'); return query(READ_SQL);
    case 'hold-writer':
      await query('BEGIN IMMEDIATE');
      await query('UPDATE items SET n=99 WHERE id=1');
      await query('INSERT INTO items VALUES(5,50)');
      return true;
    case 'contend':
      try { await query('BEGIN IMMEDIATE'); throw new Error('contention unexpectedly succeeded'); }
      catch (e) {
        assert.ok(e.errcode === 5 || e.code === 'TURBINE_E013', `unexpected busy failure: ${e.message}`);
        return { busy: true, error: errorInfo(e) };
      }
    case 'failed-statement': {
      let failure;
      try { await query('INSERT INTO items_missing VALUES(1)'); } catch (e) { failure = errorInfo(e); }
      assert.ok(failure && /no such table/.test(failure.message), 'expected failed statement');
      return { failed: true, error: failure, rows: await query(READ_SQL) };
    }
    case 'rollback': if (fault !== 'omit-rollback') await query('ROLLBACK'); return true;
    case 'rollback-read': return query(READ_SQL);
    case 'type-before': return query(TYPE_SQL);
    case 'schema-change':
      await query('BEGIN IMMEDIATE');
      for (const sql of ['DROP TABLE typed', 'CREATE TABLE typed(value BOOLEAN)', 'INSERT INTO typed VALUES(1)']) await query(sql);
      await query('COMMIT'); return true;
    case 'type-after': return query(TYPE_SQL);
    case 'stream-open': return openStream();
    case 'stream-write':
      await query('BEGIN IMMEDIATE'); await query('INSERT INTO items VALUES(6,60)'); await query('COMMIT'); return true;
    case 'checkpoint-held': case 'checkpoint-free': return query('PRAGMA wal_checkpoint(TRUNCATE)');
    case 'ownership':
      if (route === 'native') return { policy: 'native permits another statement on the same handle; only iterator lease is compared' };
      pending = query(READ_SQL);
      { let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(settled, false, 'suspended iterator must own handle');
        return { pending: true }; }
    case 'stream-return': {
      await stream.return(); stream = null;
      // Native executes the matching read after return; Turbine releases its queued read here.
      const rows = route === 'turbine' ? await pending : await query(READ_SQL);
      return { done: true, rows };
    }
    case 'stream-abort': {
      await openStream(); aborter.abort();
      let failure;
      try { await stream.next(); } catch (e) { failure = errorInfo(e); }
      await stream.return(); stream = null;
      assert.equal(failure?.name, 'AbortError', 'abort must be observed between pulls');
      return { ...failure, rows: await query(READ_SQL) };
    }
    case 'final': {
      const rows = await query(READ_SQL);
      const [counters] = await query('SELECT count(*) AS count, sum(n) AS sum FROM items');
      assert.equal(raw.isTransaction, false);
      const nativeVerification = { rows: plain(raw.prepare(READ_SQL).all()),
        ...plain(raw.prepare('SELECT count(*) AS count, sum(n) AS sum FROM items').get()), inTransaction: raw.isTransaction };
      return { rows, ...counters, nativeVerification };
    }
    case 'stubborn':
      process.on('SIGTERM', () => {});
      return true;
    case 'close':
      if (!raw) return { closed: true, notOpened: true };
      if (stream) { await stream.return(); stream = null; }
      if (client) await client.disconnect();
      // Public supplied-handle ownership: disconnect must leave the caller's handle usable.
      assert.equal(raw.prepare('SELECT 1 AS usable').get().usable, 1);
      if (raw.isTransaction) raw.exec('ROLLBACK');
      raw.close(); raw = null;
      return { suppliedHandleUsableAfterDisconnect: true, closed: true };
    default: throw new Error(`unknown action ${action}`);
  }
}
let chain = Promise.resolve();
process.on('message', message => {
  chain = chain.then(async () => {
    audit = [];
    const start = process.hrtime.bigint(), cpu = process.cpuUsage();
    try {
      const value = await operation(message.action);
      const ended = process.hrtime.bigint(), used = process.cpuUsage(cpu), memory = process.memoryUsage();
      process.send({ id: message.id, ok: true, value: plain(value), audit, inTransaction: raw?.isTransaction ?? false,
        metrics: { startedNs: start.toString(), endedNs: ended.toString(), wallMs: Number(ended - start) / 1e6, userCpuUs: used.user, systemCpuUs: used.system,
          rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, maxRssKiB: process.resourceUsage().maxRSS } }, () => {
        if (message.action === 'close') process.disconnect();
      });
    } catch (e) {
      process.send({ id: message.id, ok: false, error: errorInfo(e), audit });
    }
  });
});
