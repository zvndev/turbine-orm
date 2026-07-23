/**
 * turbine-orm — integration: 'auto' fallback parity + compound-unique lookups
 *
 * Runs against a scratch Postgres seeded by src/test/fixtures/seed.sql. The
 * suite MUTATES its database (drops an FK index, adds a `memberships` table), so
 * point DATABASE_URL at a throwaway DB:
 *
 *   DATABASE_URL=postgres://.../scratch npx tsx --test src/test/auto-compound-integration.test.ts
 *
 * Gated by DATABASE_URL — absent, every test reports as skipped.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { QueryEvent } from '../query/deferred.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping auto/compound integration tests: DATABASE_URL not set');
}

let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe("relationLoadStrategy: 'auto' fallback + compound-unique (integration)", () => {
  before(async () => {
    // Raw DDL bootstrap (no schema metadata needed) via a plain pg pool.
    const bootstrap = new pg.Pool({ connectionString: DATABASE_URL! });
    // Make users.posts probe an UNINDEXED column so 'auto' engages its fallback.
    await bootstrap.query('DROP INDEX IF EXISTS idx_posts_user_id');
    // A table with a COMPOSITE UNIQUE for the compound-unique selector tests.
    await bootstrap.query(
      `CREATE TABLE IF NOT EXISTS memberships (
        id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        org_id  BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        role    TEXT NOT NULL DEFAULT 'member',
        UNIQUE (org_id, user_id)
      )`,
    );
    await bootstrap.query('TRUNCATE memberships');
    await bootstrap.query(
      `INSERT INTO memberships (org_id, user_id, role)
       SELECT u.org_id, u.id, 'member' FROM users u ORDER BY u.id LIMIT 5`,
    );
    await bootstrap.end();

    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 5, warnOnUnlimited: false }, schema);
    await db.connect();
    resetWarnOnce(WARN_NS.autoStrategy);
  });

  after(async () => {
    await db?.disconnect();
  });

  it('auto output equals join AND batched, byte-for-byte, for an unindexed hasMany', async () => {
    const args = { orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } }, limit: 8 };
    const join = await db.table('users').findMany({ ...args, relationLoadStrategy: 'join' } as never);
    const batched = await db.table('users').findMany({ ...args, relationLoadStrategy: 'batched' } as never);
    const auto = await db.table('users').findMany({ ...args, relationLoadStrategy: 'auto' } as never);
    assert.deepEqual(auto, join, 'auto must equal join');
    assert.deepEqual(auto, batched, 'auto must equal batched');
    // Non-trivial: at least one user actually has posts.
    assert.ok(
      (auto as { posts: unknown[] }[]).some((u) => u.posts.length > 0),
      'expected at least one user with posts',
    );
  });

  it('auto ENGAGES the batched plan (a separate posts follow-up runs, tagged)', async () => {
    const events: QueryEvent[] = [];
    const listener = (e: QueryEvent): void => {
      events.push(e);
    };
    db.$on('query', listener);
    try {
      await db
        .table('users')
        .findMany({ orderBy: { id: 'asc' }, with: { posts: { orderBy: { id: 'asc' } } } } as never);
    } finally {
      db.$off('query', listener);
    }
    // A flat posts follow-up must have run (the batched loader), and the base
    // statement must be tagged auto-batched.
    assert.ok(
      events.some((e) => /FROM "posts"/.test(e.sql) && !/json_agg/.test(e.sql)),
      'a flat posts follow-up must run under auto',
    );
    assert.ok(
      events.some((e) => e.strategy === 'auto-batched'),
      'the auto base statement is tagged',
    );
  });

  it('explicit join stays a single statement (no follow-up)', async () => {
    const events: QueryEvent[] = [];
    const listener = (e: QueryEvent): void => {
      events.push(e);
    };
    db.$on('query', listener);
    try {
      await db.table('users').findMany({ with: { posts: true }, relationLoadStrategy: 'join' } as never);
    } finally {
      db.$off('query', listener);
    }
    assert.ok(
      events.some((e) => /json_agg/.test(e.sql)),
      'join uses a single json_agg statement',
    );
    assert.ok(!events.some((e) => e.strategy === 'auto-batched'), 'explicit join is never auto-tagged');
  });

  it('compound-unique findUnique returns the same row as the spelled-out conjunction', async () => {
    const row = (await db.table('memberships').findFirst({ orderBy: { id: 'asc' } } as never)) as {
      orgId: number;
      userId: number;
      id: number;
    } | null;
    assert.ok(row, 'expected a seeded membership');
    const viaCompound = await db
      .table('memberships')
      .findUnique({ where: { orgId_userId: { orgId: row.orgId, userId: row.userId } } } as never);
    const viaConjunction = await db
      .table('memberships')
      .findUnique({ where: { orgId: row.orgId, userId: row.userId } } as never);
    assert.deepEqual(viaCompound, viaConjunction);
    assert.equal((viaCompound as { id: number }).id, row.id);
  });

  it('compound-unique update targets the right row', async () => {
    const row = (await db.table('memberships').findFirst({ orderBy: { id: 'asc' } } as never)) as {
      orgId: number;
      userId: number;
      id: number;
    };
    const updated = (await db.table('memberships').update({
      where: { orgId_userId: { orgId: row.orgId, userId: row.userId } },
      data: { role: 'admin' },
    } as never)) as {
      id: number;
      role: string;
    };
    assert.equal(updated.id, row.id);
    assert.equal(updated.role, 'admin');
  });
});
