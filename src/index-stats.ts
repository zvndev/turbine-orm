/**
 * Index statistics - cost-aware triage for the missing-index advisor.
 *
 * `index-advisor.ts` decides WHICH relation probes lack an index from pure
 * schema topology. This module decides whether adding each one is worth it,
 * reading live Postgres statistics (table size, write volume, existing indexes,
 * HOT-update ratio, column null fraction) and scoring every finding into a tier:
 *
 *   - take-freely       large table, low write rate, few existing indexes;
 *   - take-deliberately real write rate, many existing indexes, or HOT at risk;
 *   - scrutinize        tiny table, append-only log shape, or stats too young.
 *
 * DESIGN: the file splits into two halves.
 *   - The COLLECTOR half (`collectStatsSnapshot`) reads pg catalogs. It uses a
 *     single one-connection pool, sets a statement_timeout, and treats every
 *     catalog read as INDIVIDUALLY OPTIONAL: a read that fails (privileges,
 *     CockroachDB/YugabyteDB catalog gaps, missing view) degrades that one
 *     signal and records a notice rather than aborting the whole snapshot.
 *   - The PURE half (`scoreMissingIndex`, `findInvalidIndexes`, and the exported
 *     threshold constants) takes a typed {@link StatsSnapshot} and imports NO pg.
 *     It is fully unit-testable with hand-built snapshots and is what carries the
 *     thresholds the CLI prints alongside every verdict.
 *
 * All statistics features are Postgres-only. On a non-Postgres engine the
 * collector returns an unavailable snapshot and the caller falls back to the
 * topology-only report.
 */

import { buildDropIndexSql } from './index-advisor.js';

// ---------------------------------------------------------------------------
// Thresholds (exported + printed so a user can see exactly why a tier was chosen)
// ---------------------------------------------------------------------------

/**
 * Heuristic thresholds behind the tier decision. Exported and surfaced in the
 * doctor output so the reasoning is never a black box: if a threshold is wrong
 * for a workload, the user can see the exact number that drove the verdict.
 */
export const STATS_THRESHOLDS = {
  /** reltuples below this = tiny table; a missing index there is noise → scrutinize. */
  tinyTableRows: 1_000,
  /**
   * Writes/day (n_tup_ins+upd+del normalized by stats age) at or above this is a
   * "real" write rate: the per-index write tax is worth a second look → take deliberately.
   */
  highWritesPerDay: 50_000,
  /**
   * Existing index count at or above this: every extra index compounds the write
   * and storage tax, so a new one is no longer free → take deliberately.
   */
  manyIndexes: 4,
  /**
   * HOT ratio (n_tup_hot_upd / n_tup_upd) at or above this, WITH real update
   * volume, means the table currently relies on heap-only-tuple updates. A new
   * index can disqualify HOT and amplify write cost → warning + take deliberately.
   */
  hotRatioAtRisk: 0.3,
  /** Minimum n_tup_upd for the HOT signal to be statistically meaningful. */
  hotMinUpdates: 1_000,
  /**
   * null_frac at or above this on a probed FK column: the column is mostly NULL,
   * so a partial `WHERE col IS NOT NULL` index covers every relation probe at a
   * fraction of the size.
   */
  partialNullFrac: 0.9,
  /**
   * Stats younger than this (days since stats_reset) cannot normalize a write
   * rate; the whole report degrades to topology-only output.
   */
  minStatsAgeDays: 1,
  /** Append-heavy log shape: n_tup_ins at or above this ... */
  appendHeavyMinInserts: 100_000,
  /** ... with inserts making up at or above this fraction of all writes ... */
  appendHeavyInsertRatio: 0.95,
  /** ... and seq_scan at or below this ("near-zero probe reads") → scrutinize. */
  appendHeavyMaxSeqScan: 5,
} as const;

// ---------------------------------------------------------------------------
// Snapshot types (the pure/collector seam)
// ---------------------------------------------------------------------------

/** Per-table live statistics. Any field may be absent when its catalog read degraded. */
export interface TableStats {
  table: string;
  /** pg_class.reltuples. 0 or -1 means never-analyzed → treated as UNKNOWN (null rows). */
  reltuples: number;
  /** pg_stat_user_tables.n_live_tup, a cross-check for reltuples. */
  nLiveTup?: number;
  nTupIns?: number;
  nTupUpd?: number;
  nTupDel?: number;
  nTupHotUpd?: number;
  seqScan?: number;
  seqTupRead?: number;
  /** pg_total_relation_size (table + indexes + toast), bytes. */
  totalSizeBytes?: number;
  /** pg_relation_size (heap only), bytes. */
  tableSizeBytes?: number;
  /** Count of indexes already on the table (pg_index). */
  existingIndexCount?: number;
}

/** A single index's identity + validity, from pg_index / pg_stat_user_indexes. */
export interface IndexStat {
  table: string;
  indexName: string;
  columns: string[];
  idxScan?: number;
  isValid: boolean;
  isUnique: boolean;
  isPrimary: boolean;
  isReplicaIdent: boolean;
}

/**
 * A point-in-time read of the statistics the triage needs. Every part is
 * optional at the field level so the pure scorer degrades honestly.
 */
export interface StatsSnapshot {
  /** True when at least the core table statistics were readable. */
  available: boolean;
  /** pg_stat_database.stats_reset for the current DB. NULL when never reset. */
  statsReset: Date | null;
  /** Days since stats_reset, or null when stats_reset is NULL / in the future. */
  statsAgeDays: number | null;
  /** Per-table stats, keyed by table name. */
  tables: Record<string, TableStats>;
  /** All indexes read (used for invalid-index detection). */
  indexes: IndexStat[];
  /** null_frac per probed column, keyed `table.column`. */
  nullFrac: Record<string, number>;
  /** Per-signal degradation notices (privileges, catalog gaps, timeouts). */
  notices: string[];
}

/** Build an empty (fully unavailable) snapshot - the honest "no stats" baseline. */
export function emptyStatsSnapshot(notices: string[] = []): StatsSnapshot {
  return {
    available: false,
    statsReset: null,
    statsAgeDays: null,
    tables: {},
    indexes: [],
    nullFrac: {},
    notices,
  };
}

// ---------------------------------------------------------------------------
// Scoring (pure - no pg, fully unit-testable)
// ---------------------------------------------------------------------------

export type IndexTier = 'take-freely' | 'take-deliberately' | 'scrutinize';

/** The numbers behind a verdict, all nullable so unknowns never masquerade as zero. */
export interface FindingMetrics {
  /** reltuples, or null when never-analyzed (0/-1). */
  rows: number | null;
  /** pg_total_relation_size in bytes. */
  sizeBytes: number | null;
  /** Writes/day since stats reset, or null when the rate cannot be normalized. */
  writesPerDay: number | null;
  existingIndexCount: number | null;
  probingRelations: number;
  /** n_tup_hot_upd / n_tup_upd, or null. */
  hotRatio: number | null;
  /** Highest null_frac across the probed columns, or null when unknown. */
  nullFrac: number | null;
  statsAgeDays: number | null;
}

export interface ScoredMissingIndex {
  table: string;
  columns: string[];
  tier: IndexTier;
  /** Human-readable reasons, each carrying the number that drove it. */
  reasons: string[];
  metrics: FindingMetrics;
  /** The HOT-update caveat when the table is at risk of losing HOT, else null. */
  hotWarning: string | null;
  /** When true, the emitted index should be a partial `WHERE col IS NOT NULL`. */
  partialNotNull: boolean;
  /** Sort key within a tier: bigger, more-probed tables first. */
  benefitScore: number;
}

/** The subset of a topology finding the scorer needs. */
export interface ScorableMissingIndex {
  table: string;
  columns: string[];
  probes: unknown[];
}

/** Format a byte count as a short human string (KB/MB/GB). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'size unknown';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Score a single missing-index finding against a snapshot. Pure and total:
 * every unknown degrades to a caveat rather than a fabricated number.
 */
export function scoreMissingIndex(missing: ScorableMissingIndex, snapshot: StatsSnapshot): ScoredMissingIndex {
  const t = STATS_THRESHOLDS;
  const stats = snapshot.tables[missing.table];
  const probingRelations = missing.probes.length;

  // reltuples 0/-1 = never analyzed → unknown, NOT tiny.
  const rows = stats && stats.reltuples > 0 ? stats.reltuples : null;
  const sizeBytes = stats?.totalSizeBytes ?? null;
  const existingIndexCount = stats?.existingIndexCount ?? null;
  const statsAgeDays = snapshot.statsAgeDays;

  // Highest null_frac across the probed columns (single-column probes are the
  // partial-index candidates; a composite FK is never rewritten to partial).
  let nullFrac: number | null = null;
  for (const col of missing.columns) {
    const nf = snapshot.nullFrac[`${missing.table}.${col}`];
    if (nf !== undefined) nullFrac = nullFrac === null ? nf : Math.max(nullFrac, nf);
  }
  const partialNotNull = missing.columns.length === 1 && nullFrac !== null && nullFrac >= t.partialNullFrac;

  // Write volume, normalized by stats age.
  let writesPerDay: number | null = null;
  if (
    stats &&
    stats.nTupIns !== undefined &&
    stats.nTupUpd !== undefined &&
    stats.nTupDel !== undefined &&
    statsAgeDays !== null &&
    statsAgeDays > 0
  ) {
    writesPerDay = (stats.nTupIns + stats.nTupUpd + stats.nTupDel) / statsAgeDays;
  }

  // HOT ratio.
  const hotRatio =
    stats && stats.nTupUpd !== undefined && stats.nTupUpd > 0 && stats.nTupHotUpd !== undefined
      ? stats.nTupHotUpd / stats.nTupUpd
      : null;
  const hotAtRisk =
    hotRatio !== null &&
    stats?.nTupUpd !== undefined &&
    hotRatio >= t.hotRatioAtRisk &&
    stats.nTupUpd >= t.hotMinUpdates;
  const hotWarning = hotAtRisk
    ? `${Math.round((hotRatio ?? 0) * 100)}% of updates are HOT (${formatInt(stats?.nTupUpd ?? 0)} updates since stats reset): a new index on this table can disable heap-only-tuple updates and amplify write cost`
    : null;

  const metrics: FindingMetrics = {
    rows,
    sizeBytes,
    writesPerDay,
    existingIndexCount,
    probingRelations,
    hotRatio,
    nullFrac,
    statsAgeDays,
  };

  const reasons: string[] = [];

  // --- Scrutinize conditions (they win over everything) --------------------
  const noStats = !stats;
  const rowsUnknown = rows === null;
  const tiny = rows !== null && rows < t.tinyTableRows;
  const appendHeavy =
    stats?.nTupIns !== undefined &&
    stats.nTupIns >= t.appendHeavyMinInserts &&
    writesPerDay !== null &&
    stats.nTupIns / Math.max(1, (stats.nTupIns ?? 0) + (stats.nTupUpd ?? 0) + (stats.nTupDel ?? 0)) >=
      t.appendHeavyInsertRatio &&
    (stats.seqScan ?? Number.POSITIVE_INFINITY) <= t.appendHeavyMaxSeqScan;
  const rateUntrustable = writesPerDay === null;

  let tier: IndexTier;
  if (noStats) {
    tier = 'scrutinize';
    reasons.push('no statistics available for this table: cannot assess cost');
  } else if (rowsUnknown) {
    tier = 'scrutinize';
    reasons.push('row count unknown (table never analyzed): run ANALYZE, then re-check');
  } else if (tiny) {
    tier = 'scrutinize';
    reasons.push(
      `only ${formatInt(rows ?? 0)} rows (< ${formatInt(t.tinyTableRows)}): a sequential scan here is already cheap`,
    );
  } else if (appendHeavy) {
    tier = 'scrutinize';
    reasons.push(
      `append-heavy: ${formatInt(stats?.nTupIns ?? 0)} inserts, near-zero reads (seq_scan ${formatInt(stats?.seqScan ?? 0)}): log-shaped table rarely benefits from a read index`,
    );
  } else if (rateUntrustable) {
    // Large table but the write rate cannot be normalized (young/NULL stats).
    // Cannot claim take-freely without confirming a low write rate.
    tier = 'scrutinize';
    reasons.push(
      statsAgeDays === null
        ? 'stats reset time unknown: cannot normalize the write rate to confirm this is safe'
        : 'write counters unavailable: cannot confirm a low write rate',
    );
    if (rows !== null) reasons.push(`${formatInt(rows)} rows, ${formatBytes(sizeBytes)}`);
  } else {
    // --- Deliberate vs free ------------------------------------------------
    const realWriteRate = writesPerDay !== null && writesPerDay >= t.highWritesPerDay;
    const manyIndexes = existingIndexCount !== null && existingIndexCount >= t.manyIndexes;

    if (realWriteRate || manyIndexes || hotAtRisk) {
      tier = 'take-deliberately';
    } else {
      tier = 'take-freely';
    }

    reasons.push(`${formatInt(rows ?? 0)} rows, ${formatBytes(sizeBytes)}`);
    if (writesPerDay !== null) {
      reasons.push(
        `~${formatInt(writesPerDay)} writes/day since stats reset${statsAgeDays !== null ? ` (${formatStatsAge(statsAgeDays)} ago)` : ''}${realWriteRate ? ` - at/above the ${formatInt(t.highWritesPerDay)}/day threshold` : ''}`,
      );
    }
    if (existingIndexCount !== null) {
      reasons.push(
        `${existingIndexCount} existing index(es)${manyIndexes ? ` - at/above the ${t.manyIndexes}-index threshold, each new index compounds write cost` : ''}`,
      );
    }
    reasons.push(`probed by ${probingRelations} relation(s)`);
  }

  if (hotWarning) reasons.push(hotWarning);
  if (partialNotNull) {
    reasons.push(
      `column is ${Math.round((nullFrac ?? 0) * 100)}% NULL: suggesting a partial "WHERE ${missing.columns[0]} IS NOT NULL" index (caveat: a user-written where: { ${missing.columns[0]}: null } filter will NOT use it)`,
    );
  }

  // Benefit sort key: bigger, more-probed tables first. Unknown rows sort last.
  const benefitScore = (rows ?? 0) * Math.max(1, probingRelations);

  return {
    table: missing.table,
    columns: missing.columns,
    tier,
    reasons,
    metrics,
    hotWarning,
    partialNotNull,
    benefitScore,
  };
}

function formatStatsAge(days: number): string {
  if (days < 1) {
    const hours = Math.round(days * 24);
    return `${hours}h`;
  }
  return `${Math.round(days)}d`;
}

// ---------------------------------------------------------------------------
// Invalid-index detection (pure)
// ---------------------------------------------------------------------------

export interface InvalidIndex {
  table: string;
  indexName: string;
  columns: string[];
  /** `DROP INDEX CONCURRENTLY IF EXISTS` - the repair for an INVALID corpse. */
  dropSql: string;
}

/**
 * Indexes left INVALID (indisvalid = false) - the failure artifact of a
 * `CREATE INDEX CONCURRENTLY` that errored. `IF NOT EXISTS` on a retry silently
 * skips the corpse, so the fix is DROP INDEX CONCURRENTLY then rerun.
 */
export function findInvalidIndexes(snapshot: StatsSnapshot): InvalidIndex[] {
  return snapshot.indexes
    .filter((idx) => !idx.isValid)
    .map((idx) => ({
      table: idx.table,
      indexName: idx.indexName,
      columns: idx.columns,
      dropSql: buildDropIndexSql(idx.indexName, { concurrently: true }),
    }))
    .sort((a, b) => a.indexName.localeCompare(b.indexName));
}

/**
 * Whether the snapshot is trustworthy enough to render tier verdicts. Empty,
 * unavailable, or too-young stats degrade to the topology-only report.
 */
export function isSnapshotUsable(snapshot: StatsSnapshot): boolean {
  if (!snapshot.available) return false;
  if (snapshot.statsAgeDays === null || snapshot.statsAgeDays < STATS_THRESHOLDS.minStatsAgeDays) return false;
  // At least one table must have a known row count for the size sort to mean anything.
  return Object.values(snapshot.tables).some((s) => s.reltuples > 0);
}

// ---------------------------------------------------------------------------
// Collector (impure - Postgres only, per-signal degradation)
// ---------------------------------------------------------------------------

/** A tuple identifying a probed column whose null_frac the collector should read. */
export interface ProbedColumn {
  table: string;
  column: string;
}

export interface CollectSnapshotOptions {
  connectionString: string;
  schema: string;
  /** Tables to read table-level stats + sizes for (the probed tables). */
  tables: string[];
  /** Columns to read null_frac for (single-column probes). */
  columns: ProbedColumn[];
  /** statement_timeout for each catalog read. Default 5000ms. */
  statementTimeoutMs?: number;
}

/** A minimal pg pool shape (avoids a type dependency on pg for the pure half). */
interface MinimalPool {
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

/**
 * Read a live statistics snapshot from Postgres. Each catalog read is wrapped
 * individually: a failure records a notice and leaves that signal absent, so a
 * privilege gap or a CockroachDB/YugabyteDB catalog difference degrades one
 * signal rather than the whole snapshot.
 */
export async function collectStatsSnapshot(options: CollectSnapshotOptions): Promise<StatsSnapshot> {
  const timeout = options.statementTimeoutMs ?? 5000;
  const notices: string[] = [];
  const snapshot = emptyStatsSnapshot(notices);

  const { Pool } = (await import('pg')).default;
  const pool = new Pool({ connectionString: options.connectionString, max: 1 }) as unknown as MinimalPool;

  const run = async <R>(label: string, text: string, values?: unknown[]): Promise<R[] | null> => {
    try {
      const res = await pool.query<R>(text, values);
      return res.rows;
    } catch (err) {
      notices.push(`${label} unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
      return null;
    }
  };

  try {
    // statement_timeout is best-effort; if it fails the reads still run.
    await run('statement_timeout', `SET statement_timeout = ${Number(timeout)}`);

    // --- stats_reset / age --------------------------------------------------
    const resetRows = await run<{ stats_reset: Date | null }>(
      'pg_stat_database.stats_reset',
      `SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()`,
    );
    if (resetRows && resetRows.length > 0) {
      const reset = resetRows[0]!.stats_reset;
      snapshot.statsReset = reset ? new Date(reset) : null;
      if (snapshot.statsReset) {
        const ageMs = Date.now() - snapshot.statsReset.getTime();
        snapshot.statsAgeDays = ageMs > 0 ? ageMs / 86_400_000 : null;
      } else {
        notices.push('pg_stat_database.stats_reset is NULL (statistics never reset): write rates cannot be normalized');
      }
    }

    // --- table stats (pg_stat_user_tables) ---------------------------------
    const statRows = await run<{
      relname: string;
      n_tup_ins: string;
      n_tup_upd: string;
      n_tup_del: string;
      n_tup_hot_upd: string;
      seq_scan: string;
      seq_tup_read: string;
      n_live_tup: string;
    }>(
      'pg_stat_user_tables',
      `SELECT relname, n_tup_ins, n_tup_upd, n_tup_del, n_tup_hot_upd, seq_scan, seq_tup_read, n_live_tup
         FROM pg_stat_user_tables
        WHERE schemaname = $1 AND relname = ANY($2)`,
      [options.schema, options.tables],
    );

    // --- class size + existing index count (pg_class) ----------------------
    const classRows = await run<{
      relname: string;
      reltuples: string;
      total_size: string;
      table_size: string;
      index_count: string;
    }>(
      'pg_class size',
      `SELECT c.relname,
              c.reltuples::bigint::text AS reltuples,
              pg_total_relation_size(c.oid)::text AS total_size,
              pg_relation_size(c.oid)::text AS table_size,
              (SELECT count(*) FROM pg_index i WHERE i.indrelid = c.oid)::text AS index_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = ANY($2)`,
      [options.schema, options.tables],
    );

    // Merge table-level signals. A table appears in the snapshot if EITHER read
    // returned it, so a missing pg_stat row still yields size info and vice versa.
    const tableMap = snapshot.tables;
    const ensure = (name: string): TableStats => {
      let s = tableMap[name];
      if (!s) {
        s = { table: name, reltuples: 0 };
        tableMap[name] = s;
      }
      return s;
    };
    if (classRows) {
      snapshot.available = true;
      for (const row of classRows) {
        const s = ensure(row.relname);
        s.reltuples = Number(row.reltuples);
        s.totalSizeBytes = Number(row.total_size);
        s.tableSizeBytes = Number(row.table_size);
        s.existingIndexCount = Number(row.index_count);
      }
    }
    if (statRows) {
      snapshot.available = true;
      for (const row of statRows) {
        const s = ensure(row.relname);
        s.nTupIns = Number(row.n_tup_ins);
        s.nTupUpd = Number(row.n_tup_upd);
        s.nTupDel = Number(row.n_tup_del);
        s.nTupHotUpd = Number(row.n_tup_hot_upd);
        s.seqScan = Number(row.seq_scan);
        s.seqTupRead = Number(row.seq_tup_read);
        s.nLiveTup = Number(row.n_live_tup);
      }
    }

    // --- invalid + all indexes (whole schema, for invalid detection) -------
    const indexRows = await run<{
      table_name: string;
      index_name: string;
      indisvalid: boolean;
      indisunique: boolean;
      indisprimary: boolean;
      indisreplident: boolean;
      idx_scan: string | null;
      columns: string[] | null;
    }>(
      'pg_index',
      `SELECT c.relname AS table_name,
              ic.relname AS index_name,
              i.indisvalid, i.indisunique, i.indisprimary, i.indisreplident,
              s.idx_scan::text AS idx_scan,
              (SELECT array_agg(a.attname ORDER BY k.ord)
                 FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_class ic ON ic.oid = i.indexrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = i.indexrelid
        WHERE n.nspname = $1`,
      [options.schema],
    );
    if (indexRows) {
      for (const row of indexRows) {
        snapshot.indexes.push({
          table: row.table_name,
          indexName: row.index_name,
          columns: row.columns ?? [],
          idxScan: row.idx_scan == null ? undefined : Number(row.idx_scan),
          isValid: row.indisvalid,
          isUnique: row.indisunique,
          isPrimary: row.indisprimary,
          isReplicaIdent: row.indisreplident,
        });
      }
    }

    // --- null_frac for probed columns (pg_stats) ---------------------------
    if (options.columns.length > 0) {
      const tablesArg = options.columns.map((c) => c.table);
      const colsArg = options.columns.map((c) => c.column);
      const nullRows = await run<{ tablename: string; attname: string; null_frac: number }>(
        'pg_stats.null_frac',
        `SELECT s.tablename, s.attname, s.null_frac
           FROM pg_stats s
           JOIN unnest($2::text[], $3::text[]) AS probe(t, c)
             ON probe.t = s.tablename AND probe.c = s.attname
          WHERE s.schemaname = $1`,
        [options.schema, tablesArg, colsArg],
      );
      if (nullRows) {
        for (const row of nullRows) {
          snapshot.nullFrac[`${row.tablename}.${row.attname}`] = Number(row.null_frac);
        }
      }
    }
  } finally {
    try {
      await pool.end();
    } catch {
      /* pool teardown is best-effort */
    }
  }

  return snapshot;
}
