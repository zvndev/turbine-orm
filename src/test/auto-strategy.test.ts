/**
 * turbine-orm — relationLoadStrategy: 'auto' per-relation fallback (finding 13)
 *
 * 'auto' is the implicit default: a relation stays on the single-statement join
 * unless the introspected metadata PROVES its probe is unindexed, in which case
 * that relation alone falls back to the batched loader. These tests drive the
 * runtime through a capturing stub pool and assert which statements are emitted.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type pg from 'pg';
import type { QueryEvent } from '../query/deferred.js';
import { QueryInterface } from '../query/index.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { IndexMetadata, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

afterEach(() => resetWarnOnce(WARN_NS.autoStrategy));

/** A pool that records every query and answers by target table. */
function capturePool(): { pool: pg.Pool; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const respond = (sql: string): pg.QueryResult => {
    // Base row must carry `id` so the batched loader can stitch.
    if (/FROM "users"/.test(sql)) return { rows: [{ id: 1 }], rowCount: 1 } as unknown as pg.QueryResult;
    return { rows: [], rowCount: 0 } as unknown as pg.QueryResult;
  };
  const pool = {
    query: (arg: unknown, params?: unknown[]) => {
      const sql = typeof arg === 'string' ? arg : (arg as { text: string }).text;
      const p = (typeof arg === 'string' ? params : (arg as { values?: unknown[] }).values) ?? [];
      calls.push({ sql, params: p });
      return Promise.resolve(respond(sql));
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

const idx = (name: string, columns: string[]): IndexMetadata => ({ name, columns, unique: false, definition: '' });

/**
 * users → posts (child FK `user_id` UNINDEXED → auto falls back), users → notes
 * (child FK `user_id` INDEXED → stays join), users → events (composite FK →
 * ineligible, stays join). `notes` carries a real index so `schemaHasIndexInfo`
 * is true and the fallback machinery can engage.
 */
function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
      notes: { type: 'hasMany', name: 'notes', from: 'users', to: 'notes', foreignKey: 'user_id', referenceKey: 'id' },
      events: {
        type: 'hasMany',
        name: 'events',
        from: 'users',
        to: 'events',
        foreignKey: ['a_id', 'b_id'],
        referenceKey: ['a', 'b'],
      },
    },
  );
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  posts.uniqueColumns = [['id']]; // user_id UNINDEXED
  const notes = mockTable('notes', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
  ]);
  notes.indexes = [idx('idx_notes_user_id', ['user_id'])]; // user_id INDEXED
  const events = mockTable('events', [
    { name: 'a_id', field: 'aId' },
    { name: 'b_id', field: 'bId' },
  ]);
  events.uniqueColumns = [];
  return { enums: {}, tables: { users, posts, notes, events } };
}

/** A schema with NO index metadata anywhere (code-first) — 'auto' == 'join'. */
function schemaNoIndexInfo(): SchemaMetadata {
  const s = schema();
  for (const t of Object.values(s.tables)) t.indexes = [];
  return s;
}

function qi(s: SchemaMetadata, opts?: Record<string, unknown>): QueryInterface<Record<string, unknown>> {
  const { pool } = capturePool();
  return new QueryInterface(pool, 'users', s, [], opts);
}

async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn;
  const out: string[] = [];
  console.warn = (...a: unknown[]) => out.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return out;
}

describe("relationLoadStrategy: 'auto' — engagement", () => {
  it('an UNINDEXED-probe relation falls back to a batched follow-up', async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), []);
    await db.findMany({ with: { posts: true } } as never);
    // Base query must NOT contain the posts json_agg subquery...
    assert.ok(calls.some((c) => /FROM "users"/.test(c.sql) && !/json_agg/.test(c.sql)));
    // ...and a separate flat posts follow-up must run.
    assert.ok(calls.some((c) => /FROM "posts"/.test(c.sql)));
  });

  it('an INDEXED-probe relation stays in the single-statement join', async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), []);
    await db.findMany({ with: { notes: true } } as never);
    assert.ok(calls.some((c) => /FROM "users"/.test(c.sql) && /json_agg/.test(c.sql)));
    // Single statement: the `notes` json_agg subquery is embedded in the base
    // query, so there is no separate flat follow-up.
    assert.equal(calls.length, 1, 'indexed relation needs no follow-up');
  });

  it('a composite-key relation stays join even when unindexed', async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), []);
    await db.findMany({ with: { events: true } } as never);
    assert.ok(
      calls.some((c) => /json_agg/.test(c.sql)),
      'composite-key relation stays in the join statement',
    );
    assert.equal(calls.length, 1, 'no batched follow-up for a composite-key relation');
  });

  it('mixes: unindexed → batched, indexed → join, in ONE query', async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), []);
    await db.findMany({ with: { posts: true, notes: true } } as never);
    const base = calls.find((c) => /FROM "users"/.test(c.sql))!;
    assert.match(base.sql, /json_agg/); // notes stays in the join
    assert.doesNotMatch(base.sql, /FROM "posts"/); // posts left the statement
    assert.ok(calls.some((c) => /FROM "posts"/.test(c.sql))); // posts batched
  });
});

describe("relationLoadStrategy: 'auto' — explicit override wins", () => {
  it("explicit 'join' keeps the unindexed relation in one statement", async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), []);
    await db.findMany({ with: { posts: true }, relationLoadStrategy: 'join' } as never);
    assert.ok(calls.some((c) => /json_agg/.test(c.sql)));
    assert.equal(calls.length, 1);
  });

  it('no DB-backed index info → auto behaves exactly like join', async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schemaNoIndexInfo(), []);
    await db.findMany({ with: { posts: true } } as never);
    assert.ok(
      calls.some((c) => /json_agg/.test(c.sql)),
      'no proof of unindexed → single-statement join',
    );
    assert.equal(calls.length, 1);
  });
});

describe("relationLoadStrategy: 'auto' — observability", () => {
  it('warns once per relation, dev only', async () => {
    const db = qi(schema());
    const warnings = await captureWarnings(async () => {
      await db.findMany({ with: { posts: true } } as never);
      await db.findMany({ with: { posts: true } } as never);
    });
    const autoNotes = warnings.filter((w) => /auto strategy/.test(w));
    assert.equal(autoNotes.length, 1, 'once-per-relation');
    assert.match(autoNotes[0]!, /relation "posts" on "users" loads batched/);
    assert.match(autoNotes[0]!, /relationLoadStrategy: 'join'/);
  });

  it('is silent under NODE_ENV=production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const db = qi(schema());
      const warnings = await captureWarnings(() => db.findMany({ with: { posts: true } } as never));
      assert.equal(warnings.filter((w) => /auto strategy/.test(w)).length, 0);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it("tags the query event with strategy: 'auto-batched' when the fallback engages", async () => {
    const events: QueryEvent[] = [];
    const { pool } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), [], {
      _onQuery: (e: QueryEvent) => events.push(e),
    } as never);
    await db.findMany({ with: { posts: true } } as never);
    assert.ok(
      events.some((e) => e.strategy === 'auto-batched'),
      'auto engagement tags the query event',
    );
  });

  it('does NOT tag events for a pure-join auto query', async () => {
    const events: QueryEvent[] = [];
    const { pool } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), [], {
      _onQuery: (e: QueryEvent) => events.push(e),
    } as never);
    await db.findMany({ with: { notes: true } } as never); // indexed → stays join
    assert.ok(!events.some((e) => e.strategy === 'auto-batched'));
  });
});

describe("relationLoadStrategy: 'auto' — findUnique / findFirst", () => {
  it('findUnique falls back for an unindexed relation', async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), []);
    await db.findUnique({ where: { id: 1 }, with: { posts: true } } as never);
    assert.ok(calls.some((c) => /FROM "users"/.test(c.sql) && !/json_agg/.test(c.sql)));
    assert.ok(calls.some((c) => /FROM "posts"/.test(c.sql)));
  });

  it('findFirst falls back for an unindexed relation', async () => {
    const { pool, calls } = capturePool();
    const db = new QueryInterface(pool, 'users', schema(), []);
    await db.findFirst({ with: { posts: true } } as never);
    assert.ok(calls.some((c) => /FROM "users"/.test(c.sql) && !/json_agg/.test(c.sql)));
    assert.ok(calls.some((c) => /FROM "posts"/.test(c.sql)));
  });
});
