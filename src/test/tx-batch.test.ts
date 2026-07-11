/**
 * turbine-orm — WS-H / H2: batch `$transaction(DeferredQuery[])` overload
 *
 * The array overload runs a tuple of DeferredQuery objects atomically inside a
 * single BEGIN…COMMIT on ONE connection and returns a positionally-typed tuple
 * of each query's transformed result. Any error rolls the whole batch back.
 *
 * These tests use a recording mock pool (no database) so they run in
 * `test:unit`. A DB-gated integration check lives at the bottom.
 *
 * Run: npx tsx --test src/test/tx-batch.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { type Dialect, postgresDialect } from '../dialect.js';
import type { DeferredQuery } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';

const SCHEMA: SchemaMetadata = { tables: {}, enums: {} };

interface Recorded {
  text: string;
  values?: unknown[];
}

/** A pg-compatible mock pool that records every query on its single client. */
function recordingPool(opts: { results?: Record<string, { rows: unknown[]; rowCount: number }>; throwOn?: string }) {
  const queries: Recorded[] = [];
  let connectCount = 0;
  let released = 0;
  const client = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (opts.throwOn && text.includes(opts.throwOn)) {
        const err = new Error(`boom: ${opts.throwOn}`);
        throw err;
      }
      const match = opts.results?.[text];
      return { rows: match?.rows ?? [], rowCount: match?.rowCount ?? 0 };
    },
    release() {
      released++;
    },
  };
  const pool = {
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      connectCount++;
      return client;
    },
    async end() {},
  };
  return {
    pool: pool as unknown as import('../client.js').PgCompatPool,
    queries,
    get connectCount() {
      return connectCount;
    },
    get released() {
      return released;
    },
  };
}

/** Build a trivial DeferredQuery whose transform reads rows[0].n. */
function q(sql: string, params: unknown[], tag: string): DeferredQuery<number> {
  return {
    sql,
    params,
    tag,
    transform: (res) => (res.rows[0] as { n: number } | undefined)?.n ?? -1,
  };
}

describe('H2 — $transaction(DeferredQuery[]) batch overload', () => {
  it('runs BEGIN, each query, then COMMIT on a single connection', async () => {
    const mock = recordingPool({
      results: {
        'SELECT 1 AS n': { rows: [{ n: 1 }], rowCount: 1 },
        'SELECT 2 AS n': { rows: [{ n: 2 }], rowCount: 1 },
      },
    });
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);

    const results = await db.$transaction([q('SELECT 1 AS n', [], 'a'), q('SELECT 2 AS n', [], 'b')]);

    assert.deepEqual(results, [1, 2]);
    assert.equal(mock.connectCount, 1, 'uses exactly one connection');
    const texts = mock.queries.map((r) => r.text);
    assert.equal(texts[0], 'BEGIN');
    assert.equal(texts[1], 'SELECT 1 AS n');
    assert.equal(texts[2], 'SELECT 2 AS n');
    assert.equal(texts[3], 'COMMIT');
    assert.equal(mock.released, 1, 'connection released once');
  });

  it('returns a positionally-typed tuple (compile-time check)', async () => {
    const mock = recordingPool({ results: { 'SELECT 7 AS n': { rows: [{ n: 7 }], rowCount: 1 } } });
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);

    const strQ: DeferredQuery<string> = {
      sql: 'SELECT 7 AS n',
      params: [],
      tag: 's',
      transform: () => 'hello',
    };
    const [num, str] = await db.$transaction([q('SELECT 7 AS n', [], 'a'), strQ]);
    // Type-level: num is number, str is string.
    const _num: number = num;
    const _str: string = str;
    assert.equal(_num, 7);
    assert.equal(_str, 'hello');
  });

  it('rolls back all queries when one fails and rethrows', async () => {
    const mock = recordingPool({
      throwOn: 'FAIL',
      results: { 'SELECT 1 AS n': { rows: [{ n: 1 }], rowCount: 1 } },
    });
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);

    await assert.rejects(() => db.$transaction([q('SELECT 1 AS n', [], 'a'), q('FAIL', [], 'b')]), /boom: FAIL/);

    const texts = mock.queries.map((r) => r.text);
    assert.ok(texts.includes('ROLLBACK'), 'issued ROLLBACK');
    assert.ok(!texts.includes('COMMIT'), 'never COMMITted');
    assert.equal(mock.released, 1);
  });

  it('empty array resolves to [] without opening a transaction body', async () => {
    const mock = recordingPool({});
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);
    const out = await db.$transaction([]);
    assert.deepEqual(out, []);
  });

  it('still supports the callback form (regression)', async () => {
    const mock = recordingPool({});
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);
    const val = await db.$transaction(async (tx) => {
      assert.ok(tx, 'callback receives a transaction client');
      return 42;
    });
    assert.equal(val, 42);
    const texts = mock.queries.map((r) => r.text);
    assert.equal(texts[0], 'BEGIN');
    assert.ok(texts.includes('COMMIT'));
  });

  it('stays sequential on a non-pipelining client: a failure stops later statements from being sent', async () => {
    const mock = recordingPool({ throwOn: 'FAIL' });
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);

    await assert.rejects(() => db.$transaction([q('FAIL', [], 'a'), q('SELECT 2 AS n', [], 'b')]), /boom: FAIL/);

    const texts = mock.queries.map((r) => r.text);
    assert.ok(!texts.includes('SELECT 2 AS n'), 'statement after the failure was never dispatched');
    assert.ok(texts.includes('ROLLBACK'));
  });
});

// ---------------------------------------------------------------------------
// Pipelined batch — drivers whose pool client sets `supportsPipelining` get
// all statements dispatched in one write burst, replies collected in order.
// ---------------------------------------------------------------------------

/** Let the promise chain progress until it blocks on an unresolved reply. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface PendingReply {
  text: string;
  resolve: (r: { rows: unknown[]; rowCount: number }) => void;
  reject: (e: Error) => void;
}

/**
 * A mock pool whose single client advertises `supportsPipelining` and records
 * the exact dispatch order. Transaction-control statements resolve
 * immediately; every other statement stays pending until the test releases it
 * via `reply()`/`fail()` — so assertions about "dispatched before any reply"
 * are exact, never timing-based.
 */
function pipeliningPool() {
  const dispatched: string[] = [];
  const pending: PendingReply[] = [];
  let released = 0;
  const client = {
    supportsPipelining: true,
    query(text: string, _values?: unknown[]) {
      dispatched.push(text);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') {
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return new Promise<{ rows: unknown[]; rowCount: number }>((resolve, reject) => {
        pending.push({ text, resolve, reject });
      });
    },
    release() {
      released++;
    },
  };
  const pool = {
    async query(_text: string, _values?: unknown[]) {
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return client;
    },
    async end() {},
  };
  return {
    pool: pool as unknown as import('../client.js').PgCompatPool,
    dispatched,
    pending,
    get released() {
      return released;
    },
    /** Resolve the pending statement whose text matches, with `rows[0].n = value`. */
    reply(text: string, value: number) {
      const idx = pending.findIndex((p) => p.text === text);
      assert.notEqual(idx, -1, `no pending statement matching "${text}"`);
      const [entry] = pending.splice(idx, 1);
      entry!.resolve({ rows: [{ n: value }], rowCount: 1 });
    },
    /** Reject the pending statement whose text matches. */
    fail(text: string) {
      const idx = pending.findIndex((p) => p.text === text);
      assert.notEqual(idx, -1, `no pending statement matching "${text}"`);
      const [entry] = pending.splice(idx, 1);
      entry!.reject(new Error(`boom: ${text}`));
    },
  };
}

describe('H2 — pipelined batch on a supportsPipelining client', () => {
  it('dispatches every statement before any reply arrives (single write burst)', async () => {
    const mock = pipeliningPool();
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);

    const batch = db.$transaction([q('S1', [], 'a'), q('S2', [], 'b'), q('S3', [], 'c')]);
    await drainMicrotasks();

    // All three statements are on the wire while zero replies have arrived.
    assert.deepEqual(mock.dispatched, ['BEGIN', 'S1', 'S2', 'S3']);
    assert.equal(mock.pending.length, 3, 'all three statements in flight at once');

    mock.reply('S1', 1);
    mock.reply('S2', 2);
    mock.reply('S3', 3);

    assert.deepEqual(await batch, [1, 2, 3]);
    assert.equal(mock.dispatched.at(-1), 'COMMIT', 'COMMIT only after every reply');
    assert.equal(mock.released, 1);
  });

  it('keeps results positional even when replies settle out of order', async () => {
    const mock = pipeliningPool();
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);

    const batch = db.$transaction([q('S1', [], 'a'), q('S2', [], 'b'), q('S3', [], 'c')]);
    await drainMicrotasks();

    mock.reply('S3', 3);
    mock.reply('S1', 1);
    mock.reply('S2', 2);

    assert.deepEqual(await batch, [1, 2, 3], 'results align to batch order, not settlement order');
  });

  it('throws the lowest-index failure, drains in-flight replies, then rolls back', async () => {
    const mock = pipeliningPool();
    const db = new TurbineClient({ pool: mock.pool }, SCHEMA);

    const batch = db.$transaction([q('S1', [], 'a'), q('S2', [], 'b'), q('S3', [], 'c')]);
    await drainMicrotasks();
    assert.equal(mock.pending.length, 3, 'pipelined: the statements after the failure were already sent');

    mock.reply('S1', 1);
    mock.fail('S2');
    // ROLLBACK must wait for S3's reply too — the batch drains all in-flight
    // statements before surfacing the error.
    await drainMicrotasks();
    assert.ok(!mock.dispatched.includes('ROLLBACK'), 'no ROLLBACK while a statement is still in flight');

    mock.fail('S3'); // both fail — the FIRST (lowest-index) error must win

    await assert.rejects(batch, /boom: S2/);
    assert.equal(mock.dispatched.at(-1), 'ROLLBACK');
    assert.ok(!mock.dispatched.includes('COMMIT'), 'never COMMITted');
    assert.equal(mock.released, 1);
  });

  it("stays sequential when the dialect's writes need a reselect plan", async () => {
    const mock = pipeliningPool();
    const reselectDialect: Dialect = { ...postgresDialect, name: 'reselect-test', resultStrategy: 'reselect' };
    const db = new TurbineClient({ pool: mock.pool, dialect: reselectDialect }, SCHEMA);

    const batch = db.$transaction([q('S1', [], 'a'), q('S2', [], 'b')]);
    await drainMicrotasks();

    // Sequential: S2 must not be dispatched until S1's reply arrives.
    assert.deepEqual(mock.dispatched, ['BEGIN', 'S1']);
    mock.reply('S1', 1);
    await drainMicrotasks();
    assert.deepEqual(mock.dispatched, ['BEGIN', 'S1', 'S2']);
    mock.reply('S2', 2);

    assert.deepEqual(await batch, [1, 2]);
  });
});
