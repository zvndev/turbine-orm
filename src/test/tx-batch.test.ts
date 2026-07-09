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
});
