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
import { collectDoctorProbeIndexNames, doctorIndexName } from '../index-advisor.js';
import {
  auditDoctorIndexes,
  findInvalidIndexes,
  findRedundantIndexes,
  findUnusedIndexes,
  formatBytes,
  type IndexStat,
  isSnapshotUsable,
  type ScorableMissingIndex,
  STATS_THRESHOLDS,
  type StatsSnapshot,
  scoreMissingIndex,
  type TableStats,
} from '../index-stats.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';

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

// ---------------------------------------------------------------------------
// Table-heat boost
// ---------------------------------------------------------------------------

describe('scoreMissingIndex - table-heat boost', () => {
  it('annotates and re-prioritizes a hot table without downgrading its cost tier', () => {
    const snap = makeSnapshot({ tables: { posts: tableStats('posts') } });
    const cold = scoreMissingIndex(missing('posts', ['user_id']), snap);
    const hot = scoreMissingIndex(missing('posts', ['user_id']), snap, { queriesPerMin: 240, p95Ms: 18.4 });
    assert.equal(hot.tier, cold.tier); // heat never changes the cost tier
    assert.equal(hot.heatBoosted, true);
    assert.equal(cold.heatBoosted, false);
    assert.ok(hot.reasons.some((r) => r.includes('hot in your workload') && r.includes('240 queries/min')));
    assert.ok(hot.benefitScore > cold.benefitScore); // hot findings sort first
  });

  it('does not boost below the queries/min threshold', () => {
    const snap = makeSnapshot({ tables: { posts: tableStats('posts') } });
    const s = scoreMissingIndex(missing('posts', ['user_id']), snap, { queriesPerMin: 0, p95Ms: 5 });
    assert.equal(s.heatBoosted, false);
    assert.ok(!s.reasons.some((r) => r.includes('hot in your workload')));
  });
});

// ---------------------------------------------------------------------------
// Unused-index detection
// ---------------------------------------------------------------------------

function indexStat(overrides: Partial<IndexStat> & { indexName: string }): IndexStat {
  return {
    table: 'posts',
    columns: ['x'],
    isValid: true,
    isUnique: false,
    isPrimary: false,
    isReplicaIdent: false,
    isExclusion: false,
    idxScan: 0,
    sizeBytes: 1024,
    ...overrides,
  };
}

describe('findUnusedIndexes', () => {
  it('flags a zero-scan non-constraint index with a CONCURRENTLY drop', () => {
    const snap = makeSnapshot({ indexes: [indexStat({ indexName: 'idx_posts_slug', idxScan: 0 })] });
    const unused = findUnusedIndexes(snap);
    assert.equal(unused.length, 1);
    assert.equal(unused[0]!.indexName, 'idx_posts_slug');
    assert.match(unused[0]!.dropSql, /DROP INDEX CONCURRENTLY IF EXISTS "idx_posts_slug";/);
  });

  it('respects the --min-scans threshold (below counts, at/above does not)', () => {
    const snap = makeSnapshot({
      indexes: [indexStat({ indexName: 'idx_cold', idxScan: 3 }), indexStat({ indexName: 'idx_warm', idxScan: 10 })],
    });
    const unused = findUnusedIndexes(snap, { minScans: 5 });
    assert.deepEqual(
      unused.map((u) => u.indexName),
      ['idx_cold'],
    );
  });

  it('excludes PK, unique, exclusion, and replica-identity indexes', () => {
    const snap = makeSnapshot({
      indexes: [
        indexStat({ indexName: 'pk', isPrimary: true, idxScan: 0 }),
        indexStat({ indexName: 'uq', isUnique: true, idxScan: 0 }),
        indexStat({ indexName: 'excl', isExclusion: true, idxScan: 0 }),
        indexStat({ indexName: 'ident', isReplicaIdent: true, idxScan: 0 }),
        indexStat({ indexName: 'plain', idxScan: 0 }),
      ],
    });
    assert.deepEqual(
      findUnusedIndexes(snap).map((u) => u.indexName),
      ['plain'],
    );
  });

  it('skips an index whose idx_scan could not be read (no guessing)', () => {
    const snap = makeSnapshot({ indexes: [indexStat({ indexName: 'idx_unknown', idxScan: undefined })] });
    assert.deepEqual(findUnusedIndexes(snap), []);
  });

  it('sorts by reclaimable size descending', () => {
    const snap = makeSnapshot({
      indexes: [indexStat({ indexName: 'small', sizeBytes: 100 }), indexStat({ indexName: 'big', sizeBytes: 10_000 })],
    });
    assert.deepEqual(
      findUnusedIndexes(snap).map((u) => u.indexName),
      ['big', 'small'],
    );
  });
});

// ---------------------------------------------------------------------------
// Redundant leading-prefix detection
// ---------------------------------------------------------------------------

describe('findRedundantIndexes', () => {
  it('flags a non-unique index that is a leading prefix of a wider one', () => {
    const snap = makeSnapshot({
      indexes: [
        indexStat({ indexName: 'idx_a', columns: ['org_id'] }),
        indexStat({ indexName: 'idx_ab', columns: ['org_id', 'user_id'] }),
      ],
    });
    const redundant = findRedundantIndexes(snap);
    assert.equal(redundant.length, 1);
    assert.equal(redundant[0]!.indexName, 'idx_a');
    assert.equal(redundant[0]!.coveredBy, 'idx_ab');
  });

  it('does not flag a non-prefix (different leading column)', () => {
    const snap = makeSnapshot({
      indexes: [
        indexStat({ indexName: 'idx_a', columns: ['user_id'] }),
        indexStat({ indexName: 'idx_ab', columns: ['org_id', 'user_id'] }),
      ],
    });
    assert.deepEqual(findRedundantIndexes(snap), []);
  });

  it('does not flag a same-length pair (neither is wider)', () => {
    const snap = makeSnapshot({
      indexes: [
        indexStat({ indexName: 'idx_a', columns: ['org_id'] }),
        indexStat({ indexName: 'idx_a2', columns: ['org_id'] }),
      ],
    });
    assert.deepEqual(findRedundantIndexes(snap), []);
  });

  it('uniqueness incompatibility: a UNIQUE prefix is never called redundant', () => {
    const snap = makeSnapshot({
      indexes: [
        indexStat({ indexName: 'uq_org', columns: ['org_id'], isUnique: true }),
        indexStat({ indexName: 'idx_org_user', columns: ['org_id', 'user_id'] }),
      ],
    });
    assert.deepEqual(findRedundantIndexes(snap), []);
  });
});

// ---------------------------------------------------------------------------
// doctorIndexName + collectDoctorProbeIndexNames + audit
// ---------------------------------------------------------------------------

function rel(overrides: Partial<RelationDef> & { name: string; to: string }): RelationDef {
  return {
    type: 'hasMany',
    from: 'x',
    foreignKey: 'x_id',
    referenceKey: 'id',
    ...overrides,
  };
}

function schemaWithRelations(tables: Record<string, RelationDef[]>): SchemaMetadata {
  const meta: SchemaMetadata = { tables: {}, enums: {} };
  const names = new Set([...Object.keys(tables), ...Object.values(tables).flatMap((rs) => rs.map((r) => r.to))]);
  for (const name of names) {
    meta.tables[name] = {
      name,
      columns: [],
      columnMap: {},
      reverseColumnMap: {},
      dateColumns: new Set(),
      pgTypes: {},
      allColumns: [],
      primaryKey: ['id'],
      uniqueColumns: [],
      relations: Object.fromEntries((tables[name] ?? []).map((r) => [r.name, r])),
      indexes: [],
    };
  }
  return meta;
}

describe('doctorIndexName', () => {
  it('builds idx_<table>_<cols> truncated to 63 bytes', () => {
    assert.equal(doctorIndexName('posts', ['user_id']), 'idx_posts_user_id');
    const long = doctorIndexName('t', ['a'.repeat(80)]);
    assert.equal(long.length, 63);
  });
});

describe('collectDoctorProbeIndexNames', () => {
  it('maps deterministic names to their probe column sets', () => {
    const schema = schemaWithRelations({
      users: [rel({ name: 'posts', type: 'hasMany', to: 'posts', foreignKey: 'user_id' })],
    });
    const names = collectDoctorProbeIndexNames(schema);
    const entry = names.get('idx_posts_user_id');
    assert.ok(entry);
    assert.equal(entry!.length, 1);
    assert.deepEqual(entry![0]!.columns, ['user_id']);
  });

  it('records a post-truncation collision as two distinct column sets under one name', () => {
    const colA = `${'z'.repeat(60)}a`;
    const colB = `${'z'.repeat(60)}b`;
    // idx_posts_<60 z's + a/b> both truncate to the same 63 bytes.
    assert.equal(doctorIndexName('posts', [colA]), doctorIndexName('posts', [colB]));
    const schema = schemaWithRelations({
      users: [rel({ name: 'ra', type: 'hasMany', to: 'posts', foreignKey: colA })],
      orgs: [rel({ name: 'rb', type: 'hasMany', to: 'posts', foreignKey: colB })],
    });
    const names = collectDoctorProbeIndexNames(schema);
    const entry = names.get(doctorIndexName('posts', [colA]));
    assert.ok(entry);
    assert.equal(entry!.length, 2); // two distinct column sets collide
  });
});

describe('auditDoctorIndexes', () => {
  it('reports a never-scanned index matching a doctor-suggested name', () => {
    const snap = makeSnapshot({
      indexes: [
        indexStat({ table: 'posts', indexName: 'idx_posts_user_id', columns: ['user_id'], idxScan: 0 }),
        indexStat({ table: 'posts', indexName: 'random_hand_named_idx', columns: ['slug'], idxScan: 0 }),
      ],
    });
    const names = new Map([['idx_posts_user_id', [{ table: 'posts', columns: ['user_id'] }]]]);
    const audit = auditDoctorIndexes(snap, names);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.indexName, 'idx_posts_user_id');
    assert.equal(audit[0]!.ambiguous, false);
  });

  it('marks a collision (name maps to >1 column set) as ambiguous', () => {
    const snap = makeSnapshot({
      indexes: [indexStat({ table: 'posts', indexName: 'idx_collide', columns: ['a'], idxScan: 0 })],
    });
    const names = new Map([
      [
        'idx_collide',
        [
          { table: 'posts', columns: ['a'] },
          { table: 'posts', columns: ['b'] },
        ],
      ],
    ]);
    const audit = auditDoctorIndexes(snap, names);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.ambiguous, true);
  });

  it('ignores scanned indexes and non-doctor names', () => {
    const snap = makeSnapshot({
      indexes: [
        indexStat({ indexName: 'idx_posts_user_id', columns: ['user_id'], idxScan: 42 }),
        indexStat({ indexName: 'not_doctor', columns: ['x'], idxScan: 0 }),
      ],
    });
    const names = new Map([['idx_posts_user_id', [{ table: 'posts', columns: ['user_id'] }]]]);
    assert.deepEqual(auditDoctorIndexes(snap, names), []);
  });
});
