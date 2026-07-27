/**
 * Plan-divergence advisor, the third question doctor asks about a probe column.
 *
 * `index-advisor.ts` answers "which relation probes have no index" from pure
 * topology. `index-stats.ts` answers "is adding that index worth it" from live
 * statistics. This module answers the third question on the SAME columns: "this
 * column IS indexed, and its value distribution makes a NAMED prepared
 * statement's generic plan unsafe".
 *
 * THE MECHANISM. Postgres may promote a named prepared statement to a GENERIC
 * plan from its sixth execution onward, and ONLY when the generic plan's
 * estimated cost is not worse than the average custom cost. A generic plan
 * cannot see any parameter value, so it substitutes a default for each one:
 *
 *   - an unknown equality `col = $1` is estimated as reltuples / n_distinct;
 *   - an unknown `LIMIT $n` is estimated as 10% of the CHILD node's row estimate.
 *
 * THE ONE SHAPE THIS MODELS, stated narrowly on purpose. A read shaped
 * `WHERE col = $1 ORDER BY <other indexed column> LIMIT $n`, where the generic
 * estimate for `col = $1` sits ABOVE the plan boundary (so the generic plan
 * keeps the ordered index scan and filters) while some real values sit far
 * BELOW it (so for those values the ordered scan has to walk a large fraction
 * of the table before it accumulates one page of matches, where the custom
 * plan takes a bitmap scan over the value's own rows and sorts them).
 *
 * WHAT THIS DELIBERATELY DOES NOT MODEL, because it was tried and it did not
 * work. An earlier revision carried a second rule for the opposite direction (a
 * physically clustered column whose densest value is far ABOVE the generic
 * estimate). Measured against live fixtures it was wrong more often than right,
 * and twice it was wrong with the SIGN INVERTED: it predicted "at least 16,032x"
 * and "at least 2,675x" on columns where the generic plan was in fact 10x and
 * 105x BETTER than the custom one, so acting on the finding would have made
 * those reads dramatically slower. The reason is structural, not a bad constant:
 * whether that flip helps or hurts turns on WHERE in the heap the value's rows
 * physically sit, and no pg_stats input carries that. `correlation` is a
 * whole-column property and is identical whether the dominant band is at the
 * head of the heap or its tail. The rule was removed rather than retuned.
 *
 * The same blind spot bounds what remains: this check can see how MANY rows a
 * value has, not WHERE they are, so it under-reports (a rare value packed at the
 * end of the heap is worse than modelled) and it cannot see the third-party
 * shapes where a generic plan is the better one. A clean report is not evidence
 * of immunity.
 *
 * EXPOSURE IS NOT AN INCIDENT. A finding says the DISTRIBUTION admits a
 * damaging flip. It does NOT say the backend is choosing the bad plan today:
 * `auto` promotes only when the generic plan's ESTIMATED cost is not worse than
 * the average custom cost, and on a shape whose generic plan is estimated
 * expensive it never promotes at all. That is why every finding ships a
 * diagnostic that checks `pg_prepared_statements.generic_plans` BEFORE it
 * compares the two plans: the counter is the only thing that establishes real
 * exposure.
 *
 * TWO UNITS, and mixing them up is what made the removed rule wrong. The
 * PLANNER costs the boundary in PAGES (an ordered index scan reads about
 * limit / matching of the table's pages before it fills the limit), which is why
 * {@link crossoverRows} is derived from relpages and why measured flip points
 * track it. The DAMAGE a user feels is also read in pages here, deliberately
 * conservatively; when the ordering index is not correlated with heap order,
 * each row examined is a separate block access and the true buffer count is
 * larger, sometimes by an order of magnitude.
 *
 * FRESHNESS GATE. The cost-tier half of doctor gates on `stats_reset` age,
 * because it normalizes WRITE COUNTERS by it. Nothing here reads a counter: every
 * input comes from pg_stats, which is refreshed by ANALYZE. This check therefore
 * gates on ANALYZE freshness instead (a column with no pg_stats row, or an
 * n_distinct of 0, is suppressed with a notice, and every finding carries the
 * table's last_analyze). Reusing the counter gate would have silenced the check
 * on every cluster whose `pg_stat_database.stats_reset` is NULL, which is the
 * default state and has nothing to do with whether ANALYZE has ever run.
 *
 * Postgres-only (pg_stats + plan_cache_mode). Pure: no pg import, no EXPLAIN.
 */

import { EXPRESSION_COLUMN, type IndexStat, type StatsSnapshot } from './index-stats.js';
import { quoteIdent } from './query/utils.js';
import type { SchemaMetadata, TableMetadata } from './schema.js';

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Gates behind a plan-divergence finding. Exported and printed with every
 * finding so the reasoning is never a black box.
 *
 * Each one is either derived from the cost model and then checked against
 * measurement, or fitted to a measured flip boundary; the comments record which.
 */
export const PLAN_DIVERGENCE_THRESHOLDS = {
  /**
   * The LIMIT the advisor assumes, because it cannot see the application's.
   *
   * It is NOT a conservative bound in either direction, and an earlier comment
   * here claimed it was. The crossover grows as sqrt(limit), so raising the
   * limit moves BOTH gates: `rarestBucket < crossover` gets easier to satisfy
   * and `genericEstimate >= crossover` gets harder, and the second one can turn
   * a finding off. 20 is simply a common first page. Every finding also reports
   * the crossover at {@link wideLimit} so a caller paginating in thousands can
   * see where their own limit lands.
   */
  assumedLimit: 20,
  /** A second crossover reported alongside, for callers paginating in thousands. */
  wideLimit: 1_000,
  /**
   * How many of the table's pages the WRONG plan must walk before this is worth
   * a user's attention: ~400 KB of heap. Below it the flip cannot cost more than
   * a millisecond or two however bad the ratio looks.
   *
   * This replaced a `relpages >= 1000` table-size floor, which was wrong and
   * measurably so: a wrong plan on a SMALL table is not cheap, because an ordered
   * index scan's cost is driven by how much of the table it walks, not by how big
   * the table is. On a 285-page / 18,500-row fixture the generic plan read 336
   * buffers against the custom plan's 7 (48x), and the old floor dropped that
   * column without even counting it as considered.
   */
  minWalkPages: 50,
  /**
   * ...and it must walk at least this FRACTION of the table. The two gates are
   * different questions (absolute cost, and how badly the plan is mismatched to
   * the value), and a finding needs both.
   */
  minWalkFraction: 0.1,
} as const;

export type PlanDivergenceThresholds = typeof PLAN_DIVERGENCE_THRESHOLDS;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export interface PlanDivergenceFinding {
  table: string;
  column: string;
  /** pg_class.reltuples. */
  rows: number;
  /** pg_class.relpages, the size input the crossover is computed from. */
  pages: number;
  /** n_distinct, decoded the way Postgres decodes it (negative = fraction of rows). */
  distinctValues: number;
  /** rows / distinctValues: what a generic plan assumes `col = $1` matches. */
  genericEstimate: number;
  /** Estimated rowcount of the rarest value (MCV minimum, or the residual bucket). */
  rarestBucket: number;
  /** Estimated rowcount of the densest value (MCV maximum). Reported, not gated on. */
  densestBucket: number;
  /** pg_stats.correlation, signed as reported. Reported, not gated on. */
  correlation: number;
  /** sqrt(assumedLimit x pages): below this many true rows, bitmap+sort wins. */
  crossoverRows: number;
  /** The same crossover at {@link PLAN_DIVERGENCE_THRESHOLDS.wideLimit}. */
  crossoverRowsWide: number;
  assumedLimit: number;
  /** How many distinct values sit on the wrong side of the crossover. */
  valuesBelowCrossover: number;
  /** Pages the generic plan's ordered scan walks for the rarest value. */
  walkPages: number;
  /** {@link walkPages} as a fraction of the table. */
  walkFraction: number;
  /**
   * walkPages / the pages the custom plan's bitmap scan reads, as a ROUGH scale
   * only. It is an estimate from statistics, not a bound in either direction:
   * it assumes the rare value's rows are spread uniformly (they usually are not,
   * which makes the real number larger) and that the bitmap scan touches a
   * separate page per row (which makes it smaller). On every fixture measured
   * while calibrating this, the true amplification came out LARGER than the
   * estimate, never smaller, but that is three fixtures and not a guarantee.
   * The EXPLAIN pair shipped with the finding is what settles it.
   */
  approxAmplification: number;
  /** The other indexed column the generic plan can order by (usually the PK). */
  orderColumn: string;
  /**
   * `column` / `orderColumn` as the TypeScript FIELD names the Turbine API takes.
   * The SQL in a finding names database columns; the code suggestion next to it
   * must name fields, or a user pastes a snake_case key into a camelCase `where`.
   */
  columnField: string;
  orderColumnField: string;
  /**
   * When the table's column statistics were last refreshed (the later of
   * last_analyze / last_autoanalyze). Null when never analyzed or unreadable.
   * Everything above describes the distribution AS OF this moment; a table that
   * has since changed shape can make the finding wrong in either direction.
   */
  lastAnalyze: Date | null;
  /** A copy-pasteable check that CONFIRMS or refutes the finding. */
  diagnosticSql: string;
  thresholds: PlanDivergenceThresholds;
}

/** A candidate suppressed because its statistics could not support a verdict. */
export interface PlanDivergenceNotice {
  table: string;
  column: string;
  reason: string;
}

export interface PlanDivergenceReport {
  findings: PlanDivergenceFinding[];
  notices: PlanDivergenceNotice[];
  /** How many (table, column) candidates were examined against live statistics. */
  candidatesConsidered: number;
}

/** A (table, column) pair whose distribution statistics the collector should read. */
export interface DivergenceCandidate {
  table: string;
  column: string;
}

// ---------------------------------------------------------------------------
// Candidate enumeration (schema-only)
// ---------------------------------------------------------------------------

/** True when `column` is unique on its own, so `col = $1` always matches one row. */
function isUniqueOnColumn(meta: TableMetadata, column: string): boolean {
  if (meta.primaryKey.length === 1 && meta.primaryKey[0] === column) return true;
  return meta.uniqueColumns.some((cols) => cols.length === 1 && cols[0] === column);
}

/**
 * Every column whose value distribution is worth reading: a column Turbine
 * probes by equality (a relation FK) or that the schema already indexes as a
 * leading key, minus the columns that are unique on their own (a unique
 * equality matches one row, so both plans agree).
 *
 * Purely schema-derived, so the collector knows what to read BEFORE any stats
 * exist. Whether the column is really served by a btree is decided later,
 * against the live index list.
 */
export function collectDivergenceCandidateColumns(schema: SchemaMetadata): DivergenceCandidate[] {
  const seen = new Set<string>();
  const out: DivergenceCandidate[] = [];

  const add = (table: string, column: string): void => {
    const meta = schema.tables[table];
    if (!meta) return;
    if (!meta.allColumns.includes(column)) return;
    if (isUniqueOnColumn(meta, column)) return;
    const key = `${table}.${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ table, column });
  };

  for (const meta of Object.values(schema.tables)) {
    // Relation probe columns: the equality predicates Turbine itself emits.
    for (const relDef of Object.values(meta.relations)) {
      const target = schema.tables[relDef.to];
      if (!target) continue;
      const keys = relDef.type === 'belongsTo' ? relDef.referenceKey : relDef.foreignKey;
      const cols = Array.isArray(keys) ? keys : [keys];
      // Only a SINGLE-column probe has a meaningful single-column distribution;
      // a composite predicate multiplies selectivities and is not modelled here.
      if (cols.length === 1 && cols[0] !== undefined) add(relDef.to, cols[0]);
      if (relDef.type === 'manyToMany' && relDef.through) {
        const src = Array.isArray(relDef.through.sourceKey) ? relDef.through.sourceKey : [relDef.through.sourceKey];
        if (src.length === 1 && src[0] !== undefined) add(relDef.through.table, src[0]);
      }
    }
    // Leading index columns: whatever the application already filters on.
    for (const idx of meta.indexes) {
      if (idx.docPath) continue;
      const lead = idx.columns[0];
      if (lead !== undefined && lead !== EXPRESSION_COLUMN) add(meta.name, lead);
    }
  }

  return out.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}

// ---------------------------------------------------------------------------
// Live index shape
// ---------------------------------------------------------------------------

/** A plain, valid btree with no expression column and no partial predicate. */
function isPlainBtree(idx: IndexStat): boolean {
  if (!idx.isValid) return false;
  if (idx.accessMethod !== undefined && idx.accessMethod !== 'btree') return false;
  if (idx.hasExpressions === true) return false;
  if (idx.columns.includes(EXPRESSION_COLUMN)) return false;
  return idx.predicate == null;
}

/**
 * Whether a plain btree LEADS with `column` (so the planner has an index path
 * for `column = $1`), and whether the table also has a DIFFERENT ordering index
 * the generic plan can run away with (in practice the primary key).
 *
 * Both halves matter. With NO index on the filter column the two plans are
 * identical and equally bad, which is the EXISTING missing-index finding, not
 * this one. With no alternative ordering index there is no other plan to flip to.
 */
function indexShapeFor(
  snapshot: StatsSnapshot,
  meta: TableMetadata,
  column: string,
): { hasIdx: boolean; orderColumn: string | null } {
  let hasIdx = false;
  let orderColumn: string | null = null;
  const pk = meta.primaryKey.length > 0 ? meta.primaryKey[0] : undefined;

  for (const idx of snapshot.indexes) {
    if (idx.table !== meta.name) continue;
    if (!isPlainBtree(idx)) continue;
    const lead = idx.columns[0];
    if (lead === undefined) continue;
    if (lead === column) {
      hasIdx = true;
      continue;
    }
    // Prefer the primary key as the stated ordering column: it is the one a
    // paginated read almost always orders by, and it is the plan the generic
    // estimate actually chose in every measured case.
    if (orderColumn === null || lead === pk) orderColumn = lead;
  }
  return { hasIdx, orderColumn };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * The plan-boundary crossover: below this many truly matching rows, running
 * `ORDER BY <other column> LIMIT n` as bitmap-scan + sort is cheaper than
 * walking the ordering index and filtering.
 *
 * Derivation: an ordered index scan expects to read about (limit / matching) x
 * pages before it accumulates `limit` matches; a bitmap scan reads about
 * min(matching, pages). Those are equal at matching = sqrt(limit x pages).
 * Measured flip points tracked this within 13 to 26% across two orders of
 * magnitude of limit, which is why the size input is relpages rather than a
 * row count.
 *
 * PREMISE, and it is the same blind spot the whole check has: both halves
 * assume the matching rows are SCATTERED through the heap. On a clustered
 * column a bitmap scan reads far fewer than min(matching, pages), so there is
 * no flip at any limit and this crossover does not describe the table at all.
 * pg_stats.correlation hints at it but does not settle it (a column can be
 * uncorrelated overall and still have one value packed in the tail, which is
 * exactly the counterexample fixture). Treat a crossover as a reason to run
 * the diagnostic block, never as a measurement.
 */
export function crossoverRows(pages: number, limit: number): number {
  return Math.sqrt(Math.max(0, limit) * Math.max(0, pages));
}

/** Decode pg_stats.n_distinct: negative values are a fraction of the row count. */
function decodeDistinct(nDistinct: number, rows: number): number {
  return nDistinct > 0 ? nDistinct : -nDistinct * rows;
}

/**
 * The check that settles a finding. Three steps, in the order that makes them
 * mean something:
 *
 *   1. Does `auto` actually promote this shape? `pg_prepared_statements`
 *      reports `generic_plans` per cached statement, and until that counter
 *      leaves 0 the backend is planning with the real values and there is
 *      nothing to fix. This step comes FIRST because a finding describes
 *      exposure, not an incident, and on many shapes the generic plan is
 *      estimated expensive enough that `auto` never promotes at all.
 *   2. What would the promoted plan cost? The two `plan_cache_mode` settings
 *      make both plans reachable on demand.
 *   3. Put the session back, so the paste does not leave `plan_cache_mode`
 *      pinned for everything the user does next.
 */
function buildDiagnosticSql(table: string, column: string, orderColumn: string, columnType: string): string {
  const t = quoteIdent(table);
  const c = quoteIdent(column);
  const o = quoteIdent(orderColumn);
  return [
    'SET synchronize_seqscans = off;',
    'SET max_parallel_workers_per_gather = 0;',
    `PREPARE turbine_divergence(${columnType}, int) AS`,
    `  SELECT * FROM ${t} WHERE ${c} = $1 ORDER BY ${o} LIMIT $2;`,
    '-- 1. does this shape get promoted at all? run it six times, then look:',
    'EXECUTE turbine_divergence(<your value>, 20);  -- x6',
    "SELECT generic_plans, custom_plans FROM pg_prepared_statements WHERE name = 'turbine_divergence';",
    '-- generic_plans still 0 means the planner is refusing the generic plan: no exposure.',
    '-- 2. what the promoted plan would cost:',
    'SET plan_cache_mode = force_custom_plan;',
    'EXPLAIN (ANALYZE, BUFFERS) EXECUTE turbine_divergence(<your value>, 20);',
    'SET plan_cache_mode = force_generic_plan;',
    'EXPLAIN (ANALYZE, BUFFERS) EXECUTE turbine_divergence(<your value>, 20);',
    '-- 3. put the session back:',
    'RESET plan_cache_mode; RESET synchronize_seqscans; RESET max_parallel_workers_per_gather;',
    'DEALLOCATE turbine_divergence;',
  ].join('\n');
}

/**
 * Score every candidate column against the snapshot and return the ones whose
 * distribution admits a damaging generic-plan flip.
 *
 * ONE rule, for the direction that could be calibrated: the generic estimate
 * sits ABOVE the plan boundary (so a promoted plan keeps the ordered index
 * scan) while the table's rarest values sit below it, and the pages that
 * ordered scan must walk for such a value are worth a user's attention both in
 * absolute terms and as a fraction of the table.
 *
 * `correlation` is reported but no longer gates anything. It used to route
 * clustered columns to a second rule; that rule is gone (see the module header),
 * and routing on it also made the advisor STRUCTURALLY unable to report a real
 * sparse-direction flip on any column that happened to be clustered, which was
 * measured at 1,165x on one fixture.
 */
export function findPlanDivergence(schema: SchemaMetadata, snapshot: StatsSnapshot): PlanDivergenceReport {
  const t = PLAN_DIVERGENCE_THRESHOLDS;
  const findings: PlanDivergenceFinding[] = [];
  const notices: PlanDivergenceNotice[] = [];
  let candidatesConsidered = 0;

  for (const candidate of collectDivergenceCandidateColumns(schema)) {
    const meta = schema.tables[candidate.table];
    if (!meta) continue;
    const stats = snapshot.tables[candidate.table];
    if (!stats) continue;

    const rows = stats.reltuples;
    const pages = stats.relpages;
    // reltuples 0/-1 means never analyzed, and relpages is only read from
    // pg_class: either being absent is an unknown, never a zero.
    if (rows <= 0 || pages === undefined || pages <= 0) continue;

    const { hasIdx, orderColumn } = indexShapeFor(snapshot, meta, candidate.column);
    // No btree leading with the column: both plans are equally bad and the
    // existing missing-index finding already owns this case.
    if (!hasIdx) continue;
    // No other ordering index: no alternative plan for the generic estimate to
    // run away with.
    if (orderColumn === null) continue;

    // Counted HERE, before any scored gate. Everything above is a SHAPE
    // question (is there an index to flip between at all?); everything below is
    // a verdict on live statistics. A user must be able to tell "considered and
    // clean" from "never looked", and an earlier revision incremented this after
    // a silent table-size floor, so the two were indistinguishable.
    candidatesConsidered++;

    const dist = snapshot.columnStats?.[`${candidate.table}.${candidate.column}`];
    if (!dist) {
      notices.push({
        table: candidate.table,
        column: candidate.column,
        reason: 'no pg_stats row for this column (never analyzed, or the statistics read degraded): run ANALYZE',
      });
      continue;
    }
    if (dist.nDistinct === 0) {
      notices.push({
        table: candidate.table,
        column: candidate.column,
        reason: 'n_distinct is 0 (column never analyzed): run ANALYZE, then re-check',
      });
      continue;
    }
    if (dist.mostCommonFreqs === null || dist.mostCommonFreqs.length === 0) {
      notices.push({
        table: candidate.table,
        column: candidate.column,
        reason: 'pg_stats has no most_common_freqs for this column: the value distribution cannot be scored',
      });
      continue;
    }

    const distinctValues = decodeDistinct(dist.nDistinct, rows);
    if (distinctValues < 2) continue;

    const freqs = dist.mostCommonFreqs;
    const nmcv = dist.mcvCount > 0 ? dist.mcvCount : freqs.length;
    const freqSum = freqs.reduce((a, b) => a + b, 0);
    const densestBucket = Math.max(...freqs) * rows;
    // The residual (non-MCV) bucket when the MCV list does not cover every value;
    // when it does (the normal case for a tenant column, whose distinct count is
    // below the default statistics target), the rarest MCV IS the rarest value.
    const rarestBucket =
      nmcv < distinctValues ? (rows * Math.max(0, 1 - freqSum)) / (distinctValues - nmcv) : Math.min(...freqs) * rows;

    const genericEstimate = rows / distinctValues;
    const crossover = crossoverRows(pages, t.assumedLimit);
    const correlation = dist.correlation ?? 0;

    // Pages the ordered index scan the generic plan keeps must walk before it
    // accumulates `assumedLimit` matches of the rarest value: limit / matching
    // of the table, and the whole table once the value has fewer rows than the
    // limit. The bitmap plan the custom planner takes instead reads about
    // min(matching, pages).
    const walkPages = rarestBucket > 0 ? Math.min(pages, (t.assumedLimit * pages) / rarestBucket) : pages;
    const walkFraction = walkPages / pages;
    const approxAmplification = walkPages / Math.max(1, Math.min(rarestBucket, pages));

    const flips = genericEstimate >= crossover && rarestBucket < crossover;
    if (!flips) continue;
    if (walkPages < t.minWalkPages || walkFraction < t.minWalkFraction) continue;

    let valuesBelowCrossover = freqs.filter((f) => f * rows < crossover).length;
    if (nmcv < distinctValues && rarestBucket < crossover) {
      valuesBelowCrossover += Math.round(distinctValues - nmcv);
    }

    const columnType = meta.pgTypes[candidate.column] ?? 'text';
    findings.push({
      table: candidate.table,
      column: candidate.column,
      rows,
      pages,
      distinctValues,
      genericEstimate,
      rarestBucket,
      densestBucket,
      correlation,
      crossoverRows: crossover,
      crossoverRowsWide: crossoverRows(pages, t.wideLimit),
      assumedLimit: t.assumedLimit,
      valuesBelowCrossover,
      walkPages,
      walkFraction,
      approxAmplification,
      orderColumn,
      columnField: meta.reverseColumnMap[candidate.column] ?? candidate.column,
      orderColumnField: meta.reverseColumnMap[orderColumn] ?? orderColumn,
      lastAnalyze: stats.lastAnalyze ?? null,
      diagnosticSql: buildDiagnosticSql(candidate.table, candidate.column, orderColumn, columnType),
      thresholds: t,
    });
  }

  findings.sort(
    (a, b) =>
      b.approxAmplification - a.approxAmplification ||
      a.table.localeCompare(b.table) ||
      a.column.localeCompare(b.column),
  );
  return { findings, notices, candidatesConsidered };
}
