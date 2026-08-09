/**
 * turbine-orm - `doctor --fix` index migration convergence.
 *
 * The fix migration used to emit `CREATE INDEX CONCURRENTLY IF NOT EXISTS`.
 * `IF NOT EXISTS` matches on the index NAME, never on its validity, so over the
 * INVALID index a failed concurrent build leaves behind (exactly the failure the
 * migration's own recipe comment warns about) it silently no-ops:
 *
 *   index INVALID before the fix migration: true
 *   migration applied: [ '..._fix.sql' ] errors: 0
 *   index valid AFTER the "fix" migration: false
 *
 * The migration records as done, the index doctor reported is still missing,
 * and the documented remedy (DROP INDEX CONCURRENTLY, then rerun) is
 * unreachable through `migrate up` because the rerun no-ops too.
 *
 * The concurrent form now precedes each CREATE with
 * `DROP INDEX CONCURRENTLY IF EXISTS`, which is a no-op on the first run and
 * clears the corpse on a rerun. The live half proves convergence against a real
 * INVALID index; the pure half pins the emitted shape.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/doctor-fix-index-convergence.test.ts
 */

import assert from 'node:assert/strict';
import { it as always, describe } from 'node:test';
import pg from 'pg';
import { buildCreateIndexSql, buildCreateIndexStatements, buildDropIndexSql } from '../index-advisor.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

// ---------------------------------------------------------------------------
// Emitted shape (pure)
// ---------------------------------------------------------------------------

describe('buildCreateIndexStatements', () => {
  always('never combines CONCURRENTLY with IF NOT EXISTS', () => {
    const stmts = buildCreateIndexStatements('posts', ['user_id'], 'idx_posts_user_id', { concurrently: true });
    assert.equal(stmts.length, 2);
    assert.match(stmts[0]!, /^DROP INDEX CONCURRENTLY IF EXISTS "idx_posts_user_id";$/);
    assert.match(stmts[1]!, /^CREATE INDEX CONCURRENTLY "idx_posts_user_id" ON "posts" \("user_id"\);$/);
    assert.doesNotMatch(stmts[1]!, /IF NOT EXISTS/);
  });

  always('leaves the plain in-transaction form exactly as it was', () => {
    const stmts = buildCreateIndexStatements('posts', ['user_id'], 'idx_posts_user_id');
    assert.deepEqual(stmts, ['CREATE INDEX IF NOT EXISTS "idx_posts_user_id" ON "posts" ("user_id");']);
  });

  always('carries the partial-null suggestion through to the CREATE', () => {
    const stmts = buildCreateIndexStatements('posts', ['user_id'], 'idx_posts_user_id', {
      concurrently: true,
      partialNotNull: true,
    });
    assert.match(stmts[1]!, /WHERE "user_id" IS NOT NULL;$/);
  });

  always('buildCreateIndexSql still defaults IF NOT EXISTS on for the plain form', () => {
    assert.match(buildCreateIndexSql('t', ['c'], 'i'), /CREATE INDEX IF NOT EXISTS/);
    assert.doesNotMatch(buildCreateIndexSql('t', ['c'], 'i', { concurrently: true }), /IF NOT EXISTS/);
    // An explicit opt-in still wins (the doctor report line copies into psql).
    assert.match(buildCreateIndexSql('t', ['c'], 'i', { concurrently: true, ifNotExists: true }), /IF NOT EXISTS/);
  });
});

// ---------------------------------------------------------------------------
// Live: convergence over an INVALID index
// ---------------------------------------------------------------------------

const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;
const SCHEMA = `turbine_fix_${SUFFIX}`;
const INDEX_NAME = 'idx_probe_child_parent_id';

/** `indisvalid` for the fix index, or null when it does not exist. */
async function indexValidity(client: pg.Client): Promise<boolean | null> {
  const res = await client.query<{ indisvalid: boolean }>(
    `SELECT i.indisvalid
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = $1 AND c.relname = $2`,
    [SCHEMA, INDEX_NAME],
  );
  return res.rows[0]?.indisvalid ?? null;
}

/**
 * Point a connection at one schema via the `options` CONNECTION PARAMETER. A
 * bare `SET search_path` would attach to the shared server-side backend behind
 * a transaction-pooling proxy and outlive this test; a connection parameter
 * cannot leak.
 */
function withSearchPath(url: string, schemaName: string): string {
  const u = new URL(url);
  u.searchParams.set('options', `-csearch_path=${schemaName}`);
  return u.toString();
}

describe('doctor --fix migration converges on a VALID index (live)', () => {
  let client: pg.Client;
  let scoped: pg.Client;

  before(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL! });
    await client.connect();
    await client.query(`CREATE SCHEMA ${SCHEMA}`);
    await client.query(`CREATE TABLE ${SCHEMA}.probe_child (id serial PRIMARY KEY, parent_id integer)`);
    // Duplicate values, so a UNIQUE concurrent build fails and leaves an
    // INVALID index behind under the fix migration's own index name. This is
    // the same corpse a cancelled or timed-out CREATE INDEX CONCURRENTLY leaves.
    await client.query(`INSERT INTO ${SCHEMA}.probe_child (parent_id) VALUES (1), (1), (2)`);
    await assert.rejects(
      () => client.query(`CREATE UNIQUE INDEX CONCURRENTLY ${INDEX_NAME} ON ${SCHEMA}.probe_child (parent_id)`),
      /could not create unique index/i,
    );
    scoped = new pg.Client({ connectionString: withSearchPath(DATABASE_URL!, SCHEMA) });
    await scoped.connect();
  });

  after(async () => {
    if (scoped) await scoped.end();
    if (!client) return;
    await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await client.end();
  });

  it('starts from a real INVALID index', async () => {
    assert.equal(await indexValidity(client), false);
  });

  it('CREATE INDEX CONCURRENTLY IF NOT EXISTS silently no-ops over the corpse', async () => {
    // The behaviour the old emitted migration relied on. Asserted here so the
    // reason for the DROP line is a checked fact, not a claim in a comment.
    const legacy = buildCreateIndexSql('probe_child', ['parent_id'], INDEX_NAME, {
      concurrently: true,
      ifNotExists: true,
    });
    await scoped.query(legacy);
    assert.equal(await indexValidity(client), false, 'IF NOT EXISTS matched the name and skipped the rebuild');
  });

  it('the emitted statements rebuild the index to VALID', async () => {
    for (const sql of buildCreateIndexStatements('probe_child', ['parent_id'], INDEX_NAME, { concurrently: true })) {
      await scoped.query(sql);
    }
    assert.equal(await indexValidity(client), true);
  });

  it('rerunning the same statements stays VALID (idempotent, not just convergent)', async () => {
    for (const sql of buildCreateIndexStatements('probe_child', ['parent_id'], INDEX_NAME, { concurrently: true })) {
      await scoped.query(sql);
    }
    assert.equal(await indexValidity(client), true);
  });

  it('the DOWN statement removes it again', async () => {
    await scoped.query(buildDropIndexSql(INDEX_NAME, { concurrently: true }));
    assert.equal(await indexValidity(client), null);
  });
});
