/**
 * turbine-orm, streams honour `limit` / `take` / `offset`.
 *
 * `findManyStream` / `findManyStreamBatches` first try to satisfy the whole
 * drain with one speculative `SELECT`. That fetch used to set its own
 * `LIMIT batchSize + 1` over the caller's `limit`, so `limit: 3` streamed every
 * matching row whenever the result fit in one batch.
 *
 * Two halves:
 *   - build-only, through a pool that serves an in-memory table and honours the
 *     LIMIT / OFFSET params it is sent;
 *   - live, a findMany-vs-stream differential over limit / take / offset below
 *     and above `batchSize`, so both the speculative path and the cursor path
 *     are exercised (needs DATABASE_URL and the shared fixture).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: the suites drive untyped accessors
type Any = any;

const ROWS = Array.from({ length: 20 }, (_, i) => ({ id: i + 1 }));

function schema(): SchemaMetadata {
  return { tables: { items: mockTable('items', [{ name: 'id', field: 'id' }]) }, enums: {} };
}

/**
 * A pool that answers the ONE statement shape these tests emit
 * (`SELECT ... ORDER BY "id" ASC LIMIT $n [OFFSET $m]`) from `ROWS`, reading
 * the bound LIMIT / OFFSET, and records every statement.
 */
function tablePool(log: { sql: string; params: unknown[] }[]): pg.Pool {
  return {
    query: async (sqlOrConfig: string | { text: string; values: unknown[] }, values?: unknown[]) => {
      const sql = typeof sqlOrConfig === 'string' ? sqlOrConfig : sqlOrConfig.text;
      const params = (typeof sqlOrConfig === 'string' ? values : sqlOrConfig.values) ?? [];
      log.push({ sql, params });
      const limit = /LIMIT \$(\d+)/.exec(sql);
      const offset = /OFFSET \$(\d+)/.exec(sql);
      const off = offset ? Number(params[Number(offset[1]) - 1]) : 0;
      const lim = limit ? Number(params[Number(limit[1]) - 1]) : ROWS.length;
      const rows = ROWS.slice(off, off + lim);
      return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
    },
  } as unknown as pg.Pool;
}

async function drain(q: Any, args: Any): Promise<number[]> {
  const out: number[] = [];
  for await (const row of q.findManyStream(args)) out.push(row.id);
  return out;
}

async function drainBatches(q: Any, args: Any): Promise<number[]> {
  const out: number[] = [];
  for await (const batch of q.findManyStreamBatches(args)) for (const row of batch) out.push(row.id);
  return out;
}

describe('stream limit: the speculative fetch keeps the caller bound (build-only)', () => {
  for (const [label, args, expected] of [
    ['limit 3', { limit: 3 }, [1, 2, 3]],
    ['take 3', { take: 3 }, [1, 2, 3]],
    ['limit 3 offset 5', { limit: 3, offset: 5 }, [6, 7, 8]],
    ['take 2 skip 4', { take: 2, skip: 4 }, [5, 6]],
    ['limit 0', { limit: 0 }, []],
  ] as const) {
    it(`${label}: both stream methods return what findMany returns, in one statement`, async () => {
      const log: { sql: string; params: unknown[] }[] = [];
      const q = new QueryInterface(tablePool(log), 'items', schema(), [], { warnOnUnlimited: false });
      const base = { ...args, orderBy: { id: 'asc' as const } };
      assert.deepEqual(await drain(q, base), expected);
      assert.equal(log.length, 1, 'the speculative fetch is the whole answer');
      assert.deepEqual(await drainBatches(q, base), expected);
      const findMany = (await q.findMany(base as never)).map((r: Any) => r.id);
      assert.deepEqual(findMany, expected);
    });
  }

  it('a client defaultLimit bounds a stream exactly as it bounds findMany', async () => {
    const log: { sql: string; params: unknown[] }[] = [];
    const q = new QueryInterface(tablePool(log), 'items', schema(), [], { defaultLimit: 4, warnOnUnlimited: false });
    const args = { orderBy: { id: 'asc' as const } };
    const findMany = (await q.findMany(args)).map((r: Any) => r.id);
    assert.deepEqual(findMany, [1, 2, 3, 4]);
    assert.deepEqual(await drain(q, args), findMany);
  });

  it('an invalid limit is refused before anything runs', async () => {
    const log: { sql: string; params: unknown[] }[] = [];
    const q = new QueryInterface(tablePool(log), 'items', schema(), []);
    await assert.rejects(() => drain(q, { limit: -1 }), /limit on "items" must be a non-negative integer/);
    assert.equal(log.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Live differential
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
const live = skipGate(SKIP, 'DATABASE_URL not set');

describe('stream vs findMany over limit / take / offset (live)', () => {
  let db: TurbineClient;
  let total = 0;

  live.before(async () => {
    const s = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, warnOnUnlimited: false }, s);
    await db.connect();
    total = await (db as Any).comments.count();
  });
  live.after(async () => {
    if (db) await db.disconnect();
  });

  live.it('every bound shape streams exactly the findMany rows, across the speculative and cursor paths', async () => {
    assert.ok(total >= 10, 'the fixture must hold enough comments for the grid to mean anything');
    const comments = (db as Any).comments;
    const bounds: Record<string, unknown>[] = [
      {},
      { limit: 0 },
      { limit: 1 },
      { limit: 3 },
      { take: 3 },
      { limit: total - 1 },
      { limit: total + 5 },
      { offset: 2 },
      { skip: 2 },
      { limit: 3, offset: 2 },
      { take: 4, skip: total - 2 },
    ];
    let checked = 0;
    for (const bound of bounds) {
      for (const batchSize of [1, 2, 3, 7, 1000, 1001]) {
        const args = { ...bound, orderBy: [{ postId: 'asc' }, { id: 'desc' }] };
        const expected = (await comments.findMany(args)).map((r: Any) => r.id);
        const label = `${JSON.stringify(bound)} batchSize ${batchSize}`;
        assert.deepEqual(await drain(comments, { ...args, batchSize }), expected, `findManyStream ${label}`);
        assert.deepEqual(
          await drainBatches(comments, { ...args, batchSize }),
          expected,
          `findManyStreamBatches ${label}`,
        );
        checked++;
      }
    }
    assert.equal(checked, bounds.length * 6);
  });

  live.it('a streamed limit applies inside a where, the reported shape', async () => {
    const comments = (db as Any).comments;
    const args = { where: { id: { gt: 2 } }, orderBy: { id: 'asc' }, limit: 3 };
    const expected = (await comments.findMany(args)).map((r: Any) => r.id);
    assert.equal(expected.length, 3);
    assert.deepEqual(await drain(comments, args), expected);
  });
});
