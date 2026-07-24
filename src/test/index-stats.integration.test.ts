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
import { findMissingRelationIndexes } from '../index-advisor.js';
import { collectStatsSnapshot, findInvalidIndexes, isSnapshotUsable, type StatsSnapshot } from '../index-stats.js';
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
