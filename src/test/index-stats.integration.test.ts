/**
 * turbine-orm - index-stats collector integration test (DATABASE_URL-gated).
 *
 * Runs the live Postgres snapshot collection against a real database and checks
 * that the catalog reads populate a well-formed StatsSnapshot. Gated via
 * skipGate: with no DATABASE_URL every test registers as skipped.
 *
 * Run: DATABASE_URL=postgres://... tsx --test src/test/index-stats.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { findMissingRelationIndexes } from '../index-advisor.js';
import {
  collectStatsSnapshot,
  findInvalidIndexes,
  findRedundantIndexes,
  findUnusedIndexes,
  isSnapshotUsable,
  type StatsSnapshot,
} from '../index-stats.js';
import { introspect } from '../introspect.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before } = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

describe('collectStatsSnapshot (live Postgres)', () => {
  let snapshot: StatsSnapshot;
  let tables: string[] = [];

  before(async () => {
    const schema = await introspect({ connectionString: DATABASE_URL!, schema: 'public' });
    tables = Object.keys(schema.tables);
    const missing = findMissingRelationIndexes(schema);
    const columns = missing
      .filter((m) => m.columns.length === 1)
      .map((m) => ({ table: m.table, column: m.columns[0]! }));

    snapshot = await collectStatsSnapshot({
      connectionString: DATABASE_URL!,
      schema: 'public',
      // Read stats for every table so the assertions do not depend on which FKs
      // happen to be unindexed in the seeded fixture.
      tables,
      columns,
    });
  });

  it('reports available with per-table statistics', () => {
    assert.equal(snapshot.available, true);
    assert.ok(Object.keys(snapshot.tables).length > 0);
    for (const name of Object.keys(snapshot.tables)) {
      const s = snapshot.tables[name]!;
      assert.equal(typeof s.reltuples, 'number');
      assert.equal(typeof s.existingIndexCount, 'number');
      assert.ok((s.totalSizeBytes ?? 0) >= 0);
    }
  });

  it('reads write counters for a seeded table', () => {
    // The fixture seeds users/posts/comments/organizations; at least one must be present.
    const known = ['users', 'posts', 'comments', 'organizations'].find((t) => snapshot.tables[t]);
    assert.ok(known, 'expected a seeded table in the snapshot');
    const s = snapshot.tables[known!]!;
    assert.equal(typeof s.nTupIns, 'number');
    assert.equal(typeof s.seqScan, 'number');
  });

  it('reads stats_reset (a Date or null) and derives an age', () => {
    assert.ok(snapshot.statsReset === null || snapshot.statsReset instanceof Date);
    if (snapshot.statsReset !== null) {
      assert.ok(snapshot.statsAgeDays === null || typeof snapshot.statsAgeDays === 'number');
    }
  });

  it('populates the index list (PK indexes exist) and finds no invalid indexes', () => {
    assert.ok(snapshot.indexes.length > 0);
    // A freshly seeded fixture has no INVALID (failed-CONCURRENTLY) indexes.
    assert.deepEqual(findInvalidIndexes(snapshot), []);
  });

  it('exposes isSnapshotUsable as a boolean for the collected snapshot', () => {
    assert.equal(typeof isSnapshotUsable(snapshot), 'boolean');
  });

  it('records no fatal notices that would signal a broken collector', () => {
    // Per-signal notices are allowed, but the core reads must have succeeded.
    assert.ok(snapshot.available, `collector degraded: ${snapshot.notices.join('; ')}`);
  });
});

// ---------------------------------------------------------------------------
// findUnusedIndexes / findRedundantIndexes against a live scratch database.
//
// Creates an isolated `turbine_v47_test` database, plants a never-scanned index
// and a redundant leading-prefix index, snapshots it, and asserts the detectors
// find them while the primary-key index is correctly excluded. The scratch DB is
// created and dropped by this suite; it never touches any pre-existing database.
// ---------------------------------------------------------------------------

const SCRATCH_DB = 'turbine_v47_test';

/** Swap the database name in a Postgres URL, preserving credentials/host/params. */
function withDatabase(url: string, dbName: string): string {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

describe('findUnusedIndexes / findRedundantIndexes (live scratch DB)', () => {
  let scratchUrl = '';
  let adminUrl = '';
  let snapshot: StatsSnapshot;

  before(async () => {
    adminUrl = withDatabase(DATABASE_URL!, 'postgres');
    scratchUrl = withDatabase(DATABASE_URL!, SCRATCH_DB);

    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
    } finally {
      await admin.end();
    }

    const db = new pg.Client({ connectionString: scratchUrl });
    await db.connect();
    try {
      await db.query(`
        CREATE TABLE parent (id serial PRIMARY KEY);
        CREATE TABLE child (
          id serial PRIMARY KEY,
          parent_id int,
          a int,
          b int
        );
        -- Never-scanned single-column index.
        CREATE INDEX idx_child_unused ON child (parent_id);
        -- Redundant leading-prefix pair: (a) is a prefix of (a, b).
        CREATE INDEX idx_child_wide ON child (a, b);
        CREATE INDEX idx_child_prefix ON child (a);
      `);
      await db.query('ANALYZE child; ANALYZE parent;');
    } finally {
      await db.end();
    }

    snapshot = await collectStatsSnapshot({
      connectionString: scratchUrl,
      schema: 'public',
      tables: ['child', 'parent'],
      columns: [],
    });
  });

  it('finds the never-scanned indexes and excludes the primary key', () => {
    const unused = findUnusedIndexes(snapshot);
    const names = unused.map((u) => u.indexName);
    assert.ok(names.includes('idx_child_unused'), `expected idx_child_unused in ${names.join(', ')}`);
    // The primary-key backing indexes must NEVER be reported.
    assert.ok(!names.includes('child_pkey'), 'child_pkey must be excluded');
    assert.ok(!names.includes('parent_pkey'), 'parent_pkey must be excluded');
    // Each reported index carries a reclaimable size and a CONCURRENTLY drop.
    for (const u of unused) {
      assert.match(u.dropSql, /DROP INDEX CONCURRENTLY IF EXISTS/);
    }
  });

  it('finds the redundant leading-prefix index covered by the wider one', () => {
    const redundant = findRedundantIndexes(snapshot);
    const prefix = redundant.find((r) => r.indexName === 'idx_child_prefix');
    assert.ok(prefix, `expected idx_child_prefix; got ${redundant.map((r) => r.indexName).join(', ')}`);
    assert.equal(prefix!.coveredBy, 'idx_child_wide');
    assert.deepEqual(prefix!.coveredByColumns, ['a', 'b']);
  });

  const dropScratch = async () => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  };

  it('drops the scratch database (cleanup)', async () => {
    await dropScratch();
  });
});
