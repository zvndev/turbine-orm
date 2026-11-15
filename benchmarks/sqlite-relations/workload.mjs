import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { bytes, digest, plain, windows } from './oracle.mjs';

export function setup(db, input) {
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;
    CREATE TABLE owners(id INTEGER PRIMARY KEY, label TEXT);
    CREATE TABLE parents(id INTEGER PRIMARY KEY, rank INTEGER NOT NULL, label TEXT NOT NULL, owner_id INTEGER REFERENCES owners(id));
    CREATE TABLE children(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id), rank INTEGER NOT NULL, note TEXT, payload TEXT NOT NULL);
    CREATE INDEX child_order ON children(parent_id, rank, id DESC);`);
  db.exec('BEGIN');
  for (const r of input.owners) db.prepare('INSERT INTO owners VALUES(?,?)').run(r.id, r.label);
  for (const r of input.parents) db.prepare('INSERT INTO parents VALUES(?,?,?,?)').run(r.id, r.rank, r.label, r.ownerId);
  for (const r of input.children) db.prepare('INSERT INTO children VALUES(?,?,?,?,?)').run(r.id, r.parentId, r.rank, r.note, r.payload);
  db.exec('COMMIT');
}
export function instrument(db) {
  const prepare = db.prepare.bind(db);
  const state = { events: [], enabled: false };
  const nativeParams = new WeakMap();
  const types = v => v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, types(x)])) : typeof v;
  db.prepare = sql => {
    const stmt = prepare(sql);
    stmt.setReadBigInts(true);
    for (const method of ['all', 'iterate', 'run', 'get']) {
      const call = stmt[method].bind(stmt);
      stmt[method] = (...params) => {
        if (!state.enabled) return call(...params);
        const e = { sql, method, readBigInts: true, params: plain(params), bindingTypes: params.map(types), rows: 0, bytes: 0 };
        state.events.push(e); nativeParams.set(e, params);
        const account = row => { e.rows++; e.bytes += bytes(row); };
        const result = call(...params);
        if (method === 'iterate') {
          const next = result.next.bind(result), close = result.return.bind(result);
          result.next = (...args) => { const r = next(...args); if (!r.done) account(r.value); else e.iteratorClosed = true; return r; };
          result.return = (...args) => { const r = close(...args); e.iteratorClosed = true; return r; };
        } else if (method === 'all') result.forEach(account);
        else if (method === 'get' && result) account(result);
        return result;
      };
    }
    return stmt;
  };
  state.plans = () => {
    state.enabled = false;
    for (const e of state.events) if (/^SELECT\b/i.test(e.sql)) e.plan = plain(prepare(`EXPLAIN QUERY PLAN ${e.sql}`).all(...nativeParams.get(e)));
    return state.events;
  };
  return state;
}
export function args(window) {
  const w = windows(window);
  return { select: { id: true, rank: true, label: true, ownerId: true },
    orderBy: [{ rank: 'asc' }, { id: 'asc' }], offset: w.parentOffset, limit: w.parentLimit,
    jsonEncoding: 'object', with: { owner: { select: { id: true, label: true } },
      children: { select: { id: true, rank: true, note: true, payload: true },
        orderBy: [{ rank: 'asc' }, { id: 'desc' }], offset: w.childOffset,
        ...(w.childLimit === null ? {} : { limit: w.childLimit }) } } };
}
function reference(db, window) {
  const w = windows(window);
  // Match the ORM's actual named binding and safe-integer bigint policy.
  const rows = (sql, ...values) => db.prepare(sql).all(Object.fromEntries(values.map((v, i) => [`p${i + 1}`, BigInt(v)])));
  return rows('SELECT id, rank, label, owner_id AS ownerId FROM parents ORDER BY rank ASC, id ASC LIMIT :p1 OFFSET :p2', w.parentLimit, w.parentOffset)
    .map(p => ({ ...p,
      owner: p.ownerId === null ? null : rows('SELECT id, label FROM owners WHERE id=:p1', p.ownerId)[0],
      children: rows('SELECT id, rank, note, payload FROM children WHERE parent_id=:p1 ORDER BY rank ASC, id DESC LIMIT :p2 OFFSET :p3', p.id, w.childLimit ?? -1, w.childOffset) }));
}
export async function execute(db, client, audit, arm, window, delayMs = 0, fault = 'none') {
  return client.$transaction(async scoped => {
  // Establish the same snapshot before every measured arm. Setup, introspection,
  // BEGIN, snapshot pin, EXPLAIN and rollback are outside the measured section.
  db.prepare('SELECT COUNT(*) FROM parents').get();
  audit.events = []; audit.enabled = true;
  const memoryBefore = process.memoryUsage(), resourceBefore = process.resourceUsage();
  const start = performance.now();
  let value = [], batches = [];
  try {
    const q = args(window);
    if (fault === 'missing-row' && arm === 'join') q.with.children.where = { id: { not: 20001 } };
    if (fault === 'tie-window' && arm === 'batched') q.with.children.orderBy = [{ rank: 'asc' }, { id: 'asc' }];
    if (fault === 'wrong-limit' && arm === 'join' && window === 'page') q.with.children.limit = 1;
    if (arm === 'raw') value = reference(db, window);
    else if (arm.startsWith('stream-') && fault !== 'materialize') {
      for await (const batch of scoped.table('parents').findManyStreamBatches({ ...q,
        relationLoadStrategy: arm.slice(7), batchSize: 2, signal: new AbortController().signal })) {
        batches.push(batch.length); value.push(...batch);
        if (delayMs) await delay(delayMs);
      }
    } else value = await scoped.table('parents').findMany({ ...q, relationLoadStrategy: arm.replace('stream-', '') });
    if (delayMs && !arm.startsWith('stream-')) for (let i = 0; i < value.length; i += 2) await delay(delayMs);
    const ms = performance.now() - start;
    const memoryAfter = process.memoryUsage(), resourceAfter = process.resourceUsage();
    const transactionRetained = db.isTransaction;
    const events = audit.plans();
    const reads = events.filter(e => /^SELECT\b/i.test(e.sql));
    value = plain(value);
    return { arm, window, value, valueHash: digest(value), deliveredBytes: bytes(value), batches,
      maxParentBytes: Math.max(...value.map(bytes)), queries: reads.length,
      nativeRows: reads.reduce((n, e) => n + e.rows, 0), nativeBytes: reads.reduce((n, e) => n + e.bytes, 0),
      audit: events, ms, memoryBefore, memoryAfter, resourceBefore, resourceAfter, transactionRetained };
  } finally {
    audit.enabled = false;
  }
  });
}
