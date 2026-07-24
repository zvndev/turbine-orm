/**
 * turbine-orm - index-stats pure scoring unit tests (no database).
 *
 * Exercises scoreMissingIndex across all three tiers, the HOT-update bump, the
 * partial-index (null_frac) switch, and every honest-degradation path (NULL
 * stats_reset, reltuples -1, table absent from the snapshot), plus
 * findInvalidIndexes and isSnapshotUsable.
 *
 * Run: tsx --test src/test/index-stats.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  findInvalidIndexes,
  formatBytes,
  type IndexStat,
  isSnapshotUsable,
  type ScorableMissingIndex,
  STATS_THRESHOLDS,
  type StatsSnapshot,
  scoreMissingIndex,
  type TableStats,
} from '../index-stats.js';

// ---------------------------------------------------------------------------
// Snapshot builders
// ---------------------------------------------------------------------------

function makeSnapshot(overrides: Partial<StatsSnapshot> = {}): StatsSnapshot {
  return {
    available: true,
    statsReset: new Date(Date.now() - 30 * 86_400_000),
    statsAgeDays: 30,
    tables: {},
    indexes: [],
    nullFrac: {},
    notices: [],
    ...overrides,
  };
}

function tableStats(table: string, overrides: Partial<TableStats> = {}): TableStats {
  return {
    table,
    reltuples: 500_000,
    nTupIns: 100,
    nTupUpd: 100,
    nTupDel: 100,
    nTupHotUpd: 0,
    seqScan: 1000,
    seqTupRead: 1000,
    nLiveTup: 500_000,
    totalSizeBytes: 200 * 1024 * 1024,
    tableSizeBytes: 180 * 1024 * 1024,
    existingIndexCount: 2,
    ...overrides,
  };
}

function missing(table: string, columns: string[], probeCount = 2): ScorableMissingIndex {
  return { table, columns, probes: Array.from({ length: probeCount }, (_, i) => ({ i })) };
}

// ---------------------------------------------------------------------------
// Tiers
// ---------------------------------------------------------------------------

describe('scoreMissingIndex - tiers', () => {
  it('take-freely: large table, low write rate, few indexes', () => {
    const snap = makeSnapshot({ tables: { posts: tableStats('posts') } });
    const s = scoreMissingIndex(missing('posts', ['user_id']), snap);
    assert.equal(s.tier, 'take-freely');
    assert.equal(s.metrics.rows, 500_000);
    assert.equal(s.metrics.probingRelations, 2);
    assert.ok(s.reasons.some((r) => r.includes('500,000 rows')));
    assert.ok(s.reasons.some((r) => r.includes('probed by 2 relation')));
  });

  it('take-deliberately: real write rate (>= threshold/day)', () => {
    const snap = makeSnapshot({
      tables: { events: tableStats('events', { nTupIns: 60_000 * 30, nTupUpd: 0, nTupDel: 0, seqScan: 2_000_000 }) },
    });
    // insert ratio is 1 but seq_scan is high, so this is NOT append-heavy: it is
    // a genuinely hot, well-read table -> deliberate on write rate.
    const s = scoreMissingIndex(missing('events', ['user_id']), snap);
    assert.equal(s.tier, 'take-deliberately');
    assert.ok(s.metrics.writesPerDay !== null && s.metrics.writesPerDay >= STATS_THRESHOLDS.highWritesPerDay);
    assert.ok(s.reasons.some((r) => r.includes('writes/day')));
  });

  it('take-deliberately: many existing indexes', () => {
    const snap = makeSnapshot({ tables: { orders: tableStats('orders', { existingIndexCount: 6 }) } });
    const s = scoreMissingIndex(missing('orders', ['customer_id']), snap);
    assert.equal(s.tier, 'take-deliberately');
    assert.ok(s.reasons.some((r) => r.includes('6 existing index')));
  });

  it('scrutinize: tiny table (< threshold rows)', () => {
    const snap = makeSnapshot({ tables: { tags: tableStats('tags', { reltuples: 400 }) } });
    const s = scoreMissingIndex(missing('tags', ['owner_id']), snap);
    assert.equal(s.tier, 'scrutinize');
    assert.ok(s.reasons.some((r) => r.includes('400 rows')));
  });

  it('scrutinize: append-heavy log shape (high inserts, near-zero reads)', () => {
    const snap = makeSnapshot({
      tables: {
        audit_log: tableStats('audit_log', {
          reltuples: 5_000_000,
          nTupIns: 4_000_000,
          nTupUpd: 0,
          nTupDel: 0,
          seqScan: 0,
        }),
      },
    });
    const s = scoreMissingIndex(missing('audit_log', ['actor_id']), snap);
    assert.equal(s.tier, 'scrutinize');
    assert.ok(s.reasons.some((r) => r.includes('append-heavy')));
  });
});

// ---------------------------------------------------------------------------
// HOT-update bump
// ---------------------------------------------------------------------------

describe('scoreMissingIndex - HOT-update awareness', () => {
  it('bumps a would-be take-freely to take-deliberately and adds a warning', () => {
    const snap = makeSnapshot({
      tables: {
        // Low write RATE (small counts / long age) but a high HOT ratio with real
        // update volume: adding an index risks disabling HOT.
        profiles: tableStats('profiles', { nTupIns: 0, nTupUpd: 5_000, nTupDel: 0, nTupHotUpd: 4_500 }),
      },
    });
    const s = scoreMissingIndex(missing('profiles', ['org_id']), snap);
    assert.equal(s.tier, 'take-deliberately');
    assert.ok(s.hotWarning !== null);
    assert.ok(s.hotWarning?.includes('HOT'));
    assert.ok(s.metrics.hotRatio !== null && s.metrics.hotRatio >= STATS_THRESHOLDS.hotRatioAtRisk);
  });

  it('does not fire below the minimum update volume', () => {
    const snap = makeSnapshot({
      tables: { profiles: tableStats('profiles', { nTupUpd: 100, nTupHotUpd: 90 }) },
    });
    const s = scoreMissingIndex(missing('profiles', ['org_id']), snap);
    assert.equal(s.hotWarning, null);
    assert.equal(s.tier, 'take-freely');
  });
});

// ---------------------------------------------------------------------------
// Partial-index (null_frac) switch
// ---------------------------------------------------------------------------

describe('scoreMissingIndex - partial-index intelligence', () => {
  it('flags partialNotNull when the probed column is mostly NULL', () => {
    const snap = makeSnapshot({
      tables: { posts: tableStats('posts') },
      nullFrac: { 'posts.editor_id': 0.97 },
    });
    const s = scoreMissingIndex(missing('posts', ['editor_id']), snap);
    assert.equal(s.partialNotNull, true);
    assert.ok(s.reasons.some((r) => r.includes('% NULL') && r.includes('IS NOT NULL')));
    assert.ok(s.reasons.some((r) => r.includes('will NOT use it')));
  });

  it('does not flag partial for a composite index even when a column is NULL-heavy', () => {
    const snap = makeSnapshot({
      tables: { memberships: tableStats('memberships') },
      nullFrac: { 'memberships.org_id': 0.99 },
    });
    const s = scoreMissingIndex(missing('memberships', ['org_id', 'user_id']), snap);
    assert.equal(s.partialNotNull, false);
  });

  it('does not flag partial below the null_frac threshold', () => {
    const snap = makeSnapshot({
      tables: { posts: tableStats('posts') },
      nullFrac: { 'posts.editor_id': 0.5 },
    });
    const s = scoreMissingIndex(missing('posts', ['editor_id']), snap);
    assert.equal(s.partialNotNull, false);
  });
});

// ---------------------------------------------------------------------------
// Honest degradation
// ---------------------------------------------------------------------------

describe('scoreMissingIndex - degradation', () => {
  it('scrutinize + honest reason when stats_reset is NULL (age unknowable)', () => {
    const snap = makeSnapshot({
      statsReset: null,
      statsAgeDays: null,
      tables: { posts: tableStats('posts') },
    });
    const s = scoreMissingIndex(missing('posts', ['user_id']), snap);
    assert.equal(s.tier, 'scrutinize');
    assert.equal(s.metrics.writesPerDay, null);
    assert.ok(s.reasons.some((r) => r.includes('stats reset time unknown')));
  });

  it('scrutinize + "never analyzed" when reltuples is -1', () => {
    const snap = makeSnapshot({ tables: { posts: tableStats('posts', { reltuples: -1 }) } });
    const s = scoreMissingIndex(missing('posts', ['user_id']), snap);
    assert.equal(s.tier, 'scrutinize');
    assert.equal(s.metrics.rows, null);
    assert.ok(s.reasons.some((r) => r.includes('never analyzed')));
  });

  it('scrutinize + "never analyzed" when reltuples is 0', () => {
    const snap = makeSnapshot({ tables: { posts: tableStats('posts', { reltuples: 0 }) } });
    const s = scoreMissingIndex(missing('posts', ['user_id']), snap);
    assert.equal(s.tier, 'scrutinize');
    assert.equal(s.metrics.rows, null);
  });

  it('scrutinize + "no statistics" when the table is absent from the snapshot', () => {
    const snap = makeSnapshot({ tables: {} });
    const s = scoreMissingIndex(missing('ghost', ['x_id']), snap);
    assert.equal(s.tier, 'scrutinize');
    assert.ok(s.reasons.some((r) => r.includes('no statistics available')));
  });
});

// ---------------------------------------------------------------------------
// Invalid indexes
// ---------------------------------------------------------------------------

describe('findInvalidIndexes', () => {
  const idx = (name: string, isValid: boolean, columns: string[] = ['x']): IndexStat => ({
    table: 't',
    indexName: name,
    columns,
    isValid,
    isUnique: false,
    isPrimary: false,
    isReplicaIdent: false,
  });

  it('returns only invalid indexes with a CONCURRENTLY drop statement', () => {
    const snap = makeSnapshot({
      indexes: [idx('idx_good', true), idx('idx_bad', false, ['user_id'])],
    });
    const invalid = findInvalidIndexes(snap);
    assert.equal(invalid.length, 1);
    assert.equal(invalid[0]!.indexName, 'idx_bad');
    assert.match(invalid[0]!.dropSql, /DROP INDEX CONCURRENTLY IF EXISTS "idx_bad";/);
  });

  it('returns empty when every index is valid', () => {
    const snap = makeSnapshot({ indexes: [idx('a', true), idx('b', true)] });
    assert.deepEqual(findInvalidIndexes(snap), []);
  });
});

// ---------------------------------------------------------------------------
// Snapshot usability + helpers
// ---------------------------------------------------------------------------

describe('isSnapshotUsable', () => {
  it('true for available, aged, analyzed stats', () => {
    assert.equal(isSnapshotUsable(makeSnapshot({ tables: { t: tableStats('t') } })), true);
  });
  it('false when unavailable', () => {
    assert.equal(isSnapshotUsable(makeSnapshot({ available: false, tables: { t: tableStats('t') } })), false);
  });
  it('false when stats are too young', () => {
    assert.equal(isSnapshotUsable(makeSnapshot({ statsAgeDays: 0.2, tables: { t: tableStats('t') } })), false);
  });
  it('false when stats_reset age is unknown', () => {
    assert.equal(isSnapshotUsable(makeSnapshot({ statsAgeDays: null, tables: { t: tableStats('t') } })), false);
  });
  it('false when no table has a known row count', () => {
    assert.equal(isSnapshotUsable(makeSnapshot({ tables: { t: tableStats('t', { reltuples: -1 }) } })), false);
  });
});

describe('formatBytes', () => {
  it('formats byte scales', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2 * 1024), '2.0 KB');
    assert.equal(formatBytes(200 * 1024 * 1024), '200 MB');
    assert.equal(formatBytes(null), 'size unknown');
  });
});

describe('STATS_THRESHOLDS', () => {
  it('exposes the tuning constants so they can be printed', () => {
    assert.equal(STATS_THRESHOLDS.tinyTableRows, 1_000);
    assert.equal(STATS_THRESHOLDS.partialNullFrac, 0.9);
    assert.ok(STATS_THRESHOLDS.highWritesPerDay > 0);
  });
});
