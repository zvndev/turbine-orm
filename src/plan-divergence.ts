/**
 * Plan-divergence advisor, the third question doctor asks about a probe column.
 *
 * `index-advisor.ts` answers "which relation probes have no index" from pure
 * topology. `index-stats.ts` answers "is adding that index worth it" from live
 * statistics. This module answers the third question on the SAME columns: "this
 * column's value distribution makes a NAMED prepared statement's generic plan
 * unsafe".
 *
 * TWO BRANCHES, one skeleton. They differ in what the CUSTOM plan does, which is
 * what decides both the boundary and the units of the damage:
 *
 *   - `sparse-value`: the filter column IS served by a btree, so the custom plan
 *     takes a bitmap scan over the rare value's own rows and the boundary is a
 *     page comparison. This is the original rule and is unchanged.
 *   - `unindexed-filter`: NO index can serve `col = $1`, so the custom plan's
 *     only alternative is a seq scan + top-N sort. Added after an earlier
 *     revision dropped every unindexed column BEFORE counting it as considered,
 *     which put a whole class of real divergence outside the scored population
 *     and outside the notices too. See the branch's own header below.
 *
 * "Served by an index" here means a VALID, non-partial, non-expression index
 * whose leading key column is the filter column and whose access method is btree
 * or HASH. Hash belongs in the first branch, not the second: a hash index gives
 * the planner the same bitmap-over-this-value's-rows path a btree does, which is
 * the plan the crossover is derived against. Measured on the fixture below with
 * a hash index on the filter column, the custom plan is a Bitmap Heap Scan
 * reading 7 buffers, not the 247-page seq scan the second branch would have
 * described. Any OTHER access method leading with the column (brin, gin, gist,
 * spgist) is not scored at all and is reported as a notice: those paths are
 * lossy or shaped differently, and neither branch's model describes them.
 *
 * THE MECHANISM. Postgres may promote a named prepared statement to a GENERIC
 * plan from its sixth execution onward, and ONLY when the generic plan's
 * estimated cost is not worse than the average custom cost. A generic plan
 * cannot see any parameter value, so it substitutes a default for each one:
 *
 *   - an unknown equality `col = $1` is estimated as reltuples / n_distinct;
 *   - an unknown `LIMIT $n` is estimated as 10% of the CHILD node's row estimate.
 *
 * THE SHAPE BOTH BRANCHES MODEL, stated narrowly on purpose. A read shaped
 * `WHERE col = $1 ORDER BY <other indexed column> LIMIT $n`, where the promoted
 * generic plan keeps the ordered index scan and filters, while for the table's
 * rarest values the custom planner picks something else entirely.
 *
 *   - `sparse-value` (the filter column is indexed): the generic estimate for
 *     `col = $1` sits ABOVE the plan boundary while some real values sit far
 *     BELOW it, so for those values the ordered scan walks a large fraction of
 *     the table before it accumulates one page of matches, where the custom plan
 *     takes a bitmap scan over the value's own rows and sorts them.
 *   - `unindexed-filter` (no equality path on the filter column): the custom plan
 *     takes a seq scan + top-N sort, which is bounded by the table's PAGES. The
 *     generic plan still takes the ordered index walk and, because it cannot see
 *     the value is rare, it walks nearly every TUPLE before it fills the LIMIT.
 *     Measured on the fixture below: 250 buffers against 20,074, and Postgres
 *     promoted it after five executions of the rare value.
 *
 * THE FIXTURE every `unindexed-filter` number in this file was measured on,
 * printed once here so each number is checkable rather than asserted. PostgreSQL
 * 16, warm cache, `synchronize_seqscans`, `max_parallel_workers_per_gather` and
 * `jit` all off:
 *
 *   CREATE TABLE t (id int PRIMARY KEY, organization_id int NOT NULL, payload text NOT NULL);
 *   INSERT INTO t SELECT g, <bucket(g)>, repeat('p', 60)
 *     FROM generate_series(1, N) g ORDER BY (g * 2654435761::bigint) % 1000003;
 *
 * which is 81 rows per page (20,000 rows in 247 pages) and, because of the
 * hash-ordered INSERT, a primary key UNCORRELATED with physical position. The
 * read is `WHERE organization_id = $1 ORDER BY id LIMIT $2` at limit 20, on the
 * rarest bucket. The same DDL is what `plan-divergence-unindexed.integration.test.ts`
 * builds, so the ladders below can be re-run from the repo.
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
 * A SECOND, STRUCTURAL blind spot bounds both branches: the candidate set is
 * relation probes plus leading index columns. A plain filter column that is
 * neither an FK nor indexed (a `status`, a `deleted_at`, a tenant column with no
 * FK constraint) is invisible to this check in EITHER branch. Feeding the index
 * advisor's recommendations in does not fix it, because the advisor derives from
 * the same relation topology; closing it would need a workload source
 * (pg_stat_statements or _turbine_metrics). The report says so where it prints
 * how many columns were scored, rather than letting that count imply coverage.
 *
 * A THIRD blind spot, specific to `unindexed-filter` and disclosed on the
 * finding rather than hidden: the branch cannot tell a heap that is in near-exact
 * {@link PlanDivergenceFinding.orderColumn} order from one that is not, and the
 * two read 1.2x and 80x on otherwise identical fixtures. The ordering column's
 * pg_stats.correlation separates them, but only at the fifth decimal place of a
 * sampled statistic, so it is reported and used to QUALIFY the finding
 * ({@link PlanDivergenceFinding.heapNearlyOrdered}), never to suppress one. Its
 * recall is bounded on the other side by a constant: gate 1 admits only a rarest
 * bucket below the assumed LIMIT, which declines a measured 81x flip at bucket
 * 60 (see the gate).
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
 * TWO UNITS, and mixing them up is what made the removed rule wrong. In the
 * `sparse-value` branch the PLANNER costs the boundary in PAGES (an ordered
 * index scan reads about limit / matching of the table's pages before it fills
 * the limit), which is why {@link crossoverRows} is derived from relpages and
 * why measured flip points track it. The DAMAGE is also read in pages there,
 * deliberately conservatively; when the ordering index is not correlated with
 * heap order, each row examined is a separate block access and the true buffer
 * count is larger, sometimes by an order of magnitude.
 *
 * The `unindexed-filter` branch reads damage in TUPLES on the generic side and
 * PAGES on the custom side, because that is what the two plans actually are: an
 * index-order heap fetch per row against one sequential pass. Carrying
 * {@link PlanDivergenceFinding.walkPages} into it would under-report the generic
 * side by exactly the rows-per-page factor, which is the entire finding. That is
 * why the page-shaped fields are left UNSET on that branch instead of being
 * filled with numbers from a model that does not apply.
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
   * the table is. Fixture, stated in full so the number is checkable:
   *
   *   CREATE TABLE t (id int PRIMARY KEY, organization_id int NOT NULL, payload text NOT NULL);
   *   -- 18,500 rows, repeat('p', 85) payload => 285 relpages, buckets
   *   -- 9,000 / 5,000 / 4,498 / 2, CREATE INDEX ON t (organization_id).
   *   -- read: WHERE organization_id = $1 ORDER BY id LIMIT $2, rarest value, limit 20.
   *
   * Inserted in `id` order the generic plan read 337 buffers against the custom
   * plan's 6 (56x); inserted in hash order, the same shape read 18,574 against 7.
   * The old floor dropped that column without even counting it as considered.
   */
  minWalkPages: 50,
  /**
   * ...and it must walk at least this FRACTION of the table. The two gates are
   * different questions (absolute cost, and how badly the plan is mismatched to
   * the value), and a finding needs both.
   *
   * `sparse-value` only. In the `unindexed-filter` branch the walk is the whole
   * table by construction (gate 1 there puts the rarest bucket below the LIMIT,
   * so the ordered scan can never fill it), which makes this gate vacuous.
   * Reusing it there would read as a gate that did work.
   */
  minWalkFraction: 0.1,
  /**
   * `unindexed-filter` only: how many TUPLES the promoted plan must walk before
   * this is worth a user's attention.
   *
   * Amplification in that branch is rows-per-page and nothing else, so it is
   * size independent and only an absolute floor separates a real finding from
   * noise. Measured on the fixture in the module header, warm cache, rarest
   * bucket 2, limit 20 (rows / relpages / custom buffers / custom ms / generic
   * buffers / generic ms):
   *
   *   1,500 /    19 /    22 / 0.14 /   1,506 /  0.28
   *   5,000 /    62 /    65 / 0.17 /   5,020 /  0.64
   *  10,000 /   124 /   127 / 0.29 /  10,038 /  2.20
   *  20,000 /   247 /   250 / 0.83 /  20,074 /  5.84
   * 200,000 / 2,470 / 2,473 / 6.06 / 200,587 / 63.07
   *
   * (An earlier revision of this table carried a page column about 8% high, from
   * a wider row than any fixture in this repo. The numbers above come from the
   * DDL printed in the module header and nothing else.)
   *
   * 10,000 tuples is where the warm-cache delta reaches the "a millisecond or
   * two" line {@link minWalkPages} is calibrated to, and where the cold-cache
   * exposure (10,000 candidate random page accesses) stops being trivial. Not
   * gated on pages instead: at 10,000 rows any realistic row width already
   * clears 50 pages, and a narrow table with 10,000 rows in 40 pages is still a
   * 250x flip.
   */
  minGenericTupleWalk: 10_000,
  /**
   * `unindexed-filter` only, and it QUALIFIES a finding rather than gating it:
   * at or above this correlation between the heap and {@link
   * PlanDivergenceFinding.orderColumn}, the flip is real but reads ~1x, so the
   * finding is printed with that stated instead of with a rows-per-page ratio
   * it would not reach.
   *
   * Fitted to the measured ladder on {@link
   * PlanDivergenceFinding.orderColumnCorrelation}: 0.99998 (one page of local
   * disorder) reads 3.1x and 0.99993 (two pages) reads 41x, so the boundary is
   * between them. That is the fifth decimal place of a SAMPLED statistic, which
   * is exactly why nothing is suppressed on it.
   */
  nearExactOrderCorrelation: 0.99995,
} as const;

export type PlanDivergenceThresholds = typeof PLAN_DIVERGENCE_THRESHOLDS;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * Which scoring rule produced a finding. They are NOT interchangeable: the
 * boundary, the damage units, the remedy and the rendered text all differ, and
 * the branch-shaped fields below are populated per branch.
 */
export type PlanDivergenceBranch = 'sparse-value' | 'unindexed-filter';

export interface PlanDivergenceFinding {
  /** Which rule scored this column. See {@link PlanDivergenceBranch}. */
  branch: PlanDivergenceBranch;
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
  /**
   * pg_stats.correlation OF THE FILTER COLUMN, signed as reported. Reported,
   * never gated on.
   *
   * It is NOT the statistic that decides how much the `unindexed-filter` flip
   * costs. That one is {@link orderColumnCorrelation}, and an earlier revision
   * printed THIS number next to a sentence about the ORDER column's physical
   * order, which is a different column and, on the fixtures below, a different
   * number by three orders of magnitude.
   */
  correlation: number;
  /**
   * pg_stats.correlation OF {@link orderColumn}: how closely the heap's physical
   * order tracks the column the generic plan walks. Null when the column has no
   * pg_stats row (it is read opportunistically, and a missing one is an unknown,
   * never a zero).
   *
   * This is what decides the SIZE of an `unindexed-filter` flip, because the
   * generic plan's cost is one heap fetch per index entry: when consecutive
   * entries land on the same already-pinned page the fetch is free, and when
   * they do not it is a buffer access. Measured on six otherwise identical
   * 20,000-row / 247-page fixtures (the module-header DDL), varying ONLY the
   * INSERT ordering, custom plan 250 buffers in every one:
   *
   *   1.00000  exact id order                    generic     303 buffers,  1.2x
   *   0.99998  shuffled within ~1 page           generic     783 buffers,  3.1x
   *   0.99993  shuffled within ~2 pages          generic  10,303 buffers,   41x
   *   0.99974  shuffled within ~4 pages          generic  15,148 buffers,   61x
   *   0.99372  shuffled within ~20 pages         generic  19,046 buffers,   76x
   *  -0.00065  hash order                        generic  20,074 buffers,   80x
   *
   * (An earlier revision of this table claimed 25x for the one-page row. It does
   * not reproduce: the transition is between a one-page and a two-page window,
   * because an index scan holds its heap pin, so disorder WITHIN a page costs
   * nothing.)
   *
   * The plan flips in all six; only the magnitude differs. The boundary sits
   * between two adjacent sampled values, so this is used to QUALIFY a finding
   * ({@link heapNearlyOrdered}), never to suppress one: gating here would be
   * fitted to the fifth decimal place of a sampled statistic and would drop
   * genuine 41x to 80x findings.
   */
  orderColumnCorrelation?: number | null;
  /**
   * True when {@link orderColumnCorrelation} is at or above
   * {@link PLAN_DIVERGENCE_THRESHOLDS.nearExactOrderCorrelation}, i.e. the heap
   * is in near-exact {@link orderColumn} order and the measured amplification is
   * ~1x rather than the rows-per-page figure in
   * {@link worstCaseAmplification}.
   *
   * The known false positive of the `unindexed-filter` branch, disclosed as a
   * field so a `--json` consumer sees it without re-deriving the rule. It is a
   * hint to measure, not a verdict: it is one sampled statistic away from the
   * 41x row of the ladder above, in both directions.
   */
  heapNearlyOrdered?: boolean;
  /**
   * sqrt(assumedLimit x pages): below this many true rows, bitmap+sort wins.
   *
   * `sparse-value` ONLY, and absent on the other branch rather than zero. The
   * derivation compares an ordered index scan against a BITMAP scan; with no
   * index on the filter column there is no bitmap path, and the real boundary is
   * linear in the limit and independent of pages (see the branch-B header).
   * Emitting a sqrt number there would be a measurement-shaped lie.
   */
  crossoverRows?: number;
  /** The same crossover at {@link PLAN_DIVERGENCE_THRESHOLDS.wideLimit}. `sparse-value` only. */
  crossoverRowsWide?: number;
  assumedLimit: number;
  /** How many distinct values sit on the wrong side of the crossover. `sparse-value` only. */
  valuesBelowCrossover?: number;
  /** Pages the generic plan's ordered scan walks for the rarest value. `sparse-value` only. */
  walkPages?: number;
  /** {@link walkPages} as a fraction of the table. `sparse-value` only. */
  walkFraction?: number;
  /**
   * `unindexed-filter` ONLY: how many tuples the promoted ordered scan fetches
   * before it fills the LIMIT, `min(rows, rows x limit / rarestBucket)`.
   *
   * On this branch it is ALWAYS exactly `rows`, and that is arithmetic rather
   * than a coincidence: gate 1 puts `rarestBucket` below the limit, so
   * `rows x limit / rarestBucket > rows` and the `min` always takes `rows`. The
   * general formula is kept because gate 1 is the thing most likely to become
   * size-aware (see its comment), and it was checked against measurement on one
   * table at three bucket sizes: bucket 2 predicted 20,000 measured 19,992;
   * bucket 20 predicted 20,000 measured 19,854; bucket 60 predicted 6,667
   * measured 6,774. Two of those three bucket sizes are outside what gate 1
   * currently admits, and the formula also assumes the rare value is spread
   * uniformly in ORDER-column space: on a fixture with the rare rows contiguous
   * at the tail of `id` order it predicted 66,667 and measured 200,547.
   */
  tuplesWalked?: number;
  /**
   * `unindexed-filter` ONLY: {@link tuplesWalked} / pages, i.e. the generic
   * plan's buffer accesses against the seq scan's. Given the collapse above it
   * is exactly the table's rows-per-page, which is a table property: it says how
   * bad the flip is IF it happens, and nothing about how likely this column is
   * to be the one that flips.
   *
   * An ESTIMATE, not a bound, in both directions. It assumes each index-order
   * heap fetch is a separate buffer access, which is true when the heap is not
   * ordered by {@link orderColumn} and false when it is: see
   * {@link heapNearlyOrdered}, where the measured reading is ~1x instead.
   */
  worstCaseAmplification?: number;
  /**
   * walkPages / the pages the custom plan's bitmap scan reads, as a ROUGH scale
   * only. It is an estimate from statistics, not a bound in either direction:
   * it assumes the rare value's rows are spread uniformly (they usually are not,
   * which makes the real number larger) and that the bitmap scan touches a
   * separate page per row (which makes it smaller). On every fixture measured
   * while calibrating this, the true amplification came out LARGER than the
   * estimate, never smaller, but that is three fixtures and not a guarantee.
   * The EXPLAIN pair shipped with the finding is what settles it.
   *
   * `sparse-value` only.
   */
  approxAmplification?: number;
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
  /**
   * The same count split by whether the filter column has a plain btree. Reported
   * separately because "N columns were scored" used to be true only of indexed
   * ones, and the unindexed population was silently outside it.
   */
  consideredIndexed: number;
  consideredUnindexed: number;
  /**
   * True when every `unindexed-filter` finding was put to the planner via
   * `plan-flip-probe.ts` rather than reported on statistics alone.
   *
   * Absent or false means the findings below are UNVERIFIED: the probe was
   * skipped, the engine is not Postgres, or the connection refused it.
   */
  flipProbed?: boolean;
  /**
   * How many candidate findings the planner refuted, i.e. columns where the
   * generic plan keeps the same sequential scan the good plan uses so there is
   * no divergence to reach. Reported because a check that silently discards two
   * thirds of what it found should say so.
   */
  flipRefuted?: number;
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
 *
 * NOTE, because it is the obvious next idea and it is a no-op: feeding
 * `findMissingRelationIndexes`' recommended columns in here adds nothing. Both
 * derive from the same relation topology, this walker already enumerates every
 * single-column relation probe whether or not it is indexed, and the advisor's
 * only extra members are COMPOSITE probes, which this check deliberately does
 * not model. The unindexed population was never missing from the candidate set;
 * it was dropped later, by a shape gate. That gate is where it was fixed.
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

/**
 * The columns that could end up as a finding's {@link
 * PlanDivergenceFinding.orderColumn}, so the collector reads their correlation
 * too.
 *
 * A superset, deliberately: which one the generic plan would order by is decided
 * later against the live index list, and a pg_stats read is cheap next to
 * getting the wrong column's statistic. It is a SEPARATE list from the candidate
 * columns because the two are filtered differently: a primary key is excluded
 * from the candidates (a unique equality matches one row) and is the single most
 * likely ordering column.
 */
export function collectDivergenceOrderColumns(schema: SchemaMetadata): DivergenceCandidate[] {
  const seen = new Set<string>();
  const out: DivergenceCandidate[] = [];
  const add = (table: string, column: string): void => {
    const meta = schema.tables[table];
    if (!meta?.allColumns.includes(column)) return;
    const key = `${table}.${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ table, column });
  };
  const candidateTables = new Set(collectDivergenceCandidateColumns(schema).map((c) => c.table));
  for (const table of candidateTables) {
    const meta = schema.tables[table];
    if (!meta) continue;
    if (meta.primaryKey[0] !== undefined) add(table, meta.primaryKey[0]);
    for (const idx of meta.indexes) {
      if (idx.docPath) continue;
      const lead = idx.columns[0];
      if (lead !== undefined && lead !== EXPRESSION_COLUMN) add(table, lead);
    }
  }
  return out.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));
}

// ---------------------------------------------------------------------------
// Live index shape
// ---------------------------------------------------------------------------

/** Access methods that give the planner an exact bitmap over one value's rows. */
const EQUALITY_ACCESS_METHODS = new Set(['btree', 'hash']);

/** Valid, no expression column, no partial predicate: usable for the bare predicate. */
function isPlainIndex(idx: IndexStat): boolean {
  if (!idx.isValid) return false;
  if (idx.hasExpressions === true) return false;
  if (idx.columns.includes(EXPRESSION_COLUMN)) return false;
  return idx.predicate == null;
}

/** A plain, valid btree. The only shape that can also provide ORDERING. */
function isPlainBtree(idx: IndexStat): boolean {
  if (!isPlainIndex(idx)) return false;
  return idx.accessMethod === undefined || idx.accessMethod === 'btree';
}

/**
 * True when the index gives the planner a path for `column = $1` whose custom
 * plan is a bitmap over that value's own rows: a plain btree or a plain HASH
 * index leading with the column.
 *
 * Hash is included on measurement, not on principle. On the module-header
 * fixture with a hash index on the filter column, the custom plan is a Bitmap
 * Heap Scan reading 7 buffers; calling that column "unindexed" would print a
 * 247-page seq scan as the good plan, which is the thing being fixed.
 */
function servesEquality(idx: IndexStat, column: string): boolean {
  if (!isPlainIndex(idx)) return false;
  if (idx.columns[0] !== column) return false;
  return idx.accessMethod === undefined || EQUALITY_ACCESS_METHODS.has(idx.accessMethod);
}

/**
 * Whether an index serves `column = $1` (so the custom plan has a bitmap path),
 * whether the table also has a DIFFERENT ordering index the generic plan can run
 * away with (in practice the primary key), and whether the only thing leading
 * with the column is an access method neither branch models.
 *
 * All three matter. With NO path at all the custom plan's alternative is a seq
 * scan, which is the `unindexed-filter` branch. With no alternative ordering
 * index there is no other plan to flip to. And with only a brin/gin/gist path
 * the column is scored by neither rule: those scans are lossy or shaped
 * differently, so both models would misdescribe the custom plan.
 */
function indexShapeFor(
  snapshot: StatsSnapshot,
  meta: TableMetadata,
  column: string,
): { hasIdx: boolean; orderColumn: string | null; unmodelledAccessMethod: string | null } {
  let hasIdx = false;
  let orderColumn: string | null = null;
  let unmodelledAccessMethod: string | null = null;
  const pk = meta.primaryKey.length > 0 ? meta.primaryKey[0] : undefined;

  for (const idx of snapshot.indexes) {
    if (idx.table !== meta.name) continue;
    const lead = idx.columns[0];
    if (lead === undefined) continue;
    if (lead === column) {
      if (servesEquality(idx, column)) hasIdx = true;
      else if (idx.isValid && idx.predicate == null && idx.hasExpressions !== true && idx.accessMethod !== undefined) {
        unmodelledAccessMethod = idx.accessMethod;
      }
      continue;
    }
    if (!isPlainBtree(idx)) continue;
    // Prefer the primary key as the stated ordering column: it is the one a
    // paginated read almost always orders by, and it is the plan the generic
    // estimate actually chose in every measured case.
    if (orderColumn === null || lead === pk) orderColumn = lead;
  }
  return { hasIdx, orderColumn, unmodelledAccessMethod: hasIdx ? null : unmodelledAccessMethod };
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
function buildDiagnosticSql(
  table: string,
  column: string,
  orderColumn: string,
  columnType: string,
  branch: PlanDivergenceBranch,
): string {
  const t = quoteIdent(table);
  const c = quoteIdent(column);
  const o = quoteIdent(orderColumn);
  // The `unindexed-filter` branch needs no different SQL: this PREPARE / six
  // executions / generic_plans / force_custom / force_generic sequence is exactly
  // what settled it on every fixture. Only the closing advice differs, because
  // its remedy is the missing index, not a plan-cache setting.
  const remedy =
    branch === 'unindexed-filter'
      ? ['-- 3. the fix for THIS finding is the missing index above, not a plan-cache setting.']
      : [];
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
    ...remedy,
    '-- put the session back:',
    'RESET plan_cache_mode; RESET synchronize_seqscans; RESET max_parallel_workers_per_gather;',
    'DEALLOCATE turbine_divergence;',
  ].join('\n');
}

/**
 * The estimated EXTRA buffer accesses the wrong plan performs, and the ONE key
 * both branches are sorted on.
 *
 *   - `sparse-value`:      walkPages - min(rarestBucket, pages)
 *   - `unindexed-filter`:  tuplesWalked - pages
 *
 * Both are in buffer-access units, which `approxAmplification` (the previous
 * key) is not: branch B does not produce it, and a ratio ranks a 76x flip on a
 * 19-page table above a 81x flip on a 2,470-page one. This DOES reorder existing
 * `sparse-value` findings relative to 0.56.0.
 *
 * Shared units are NOT the same as equal conservatism, and the ordering should
 * be read as triage rather than as a ranking of true damage. Branch A's
 * `walkPages` is deliberately conservative (its own field doc says the true
 * buffer count can be an order of magnitude larger), while branch B counts
 * exactly that per-row access. Since `rows >> pages` on any table clearing
 * branch B's tuple floor, every branch-B finding outranks every branch-A one by
 * roughly the rows-per-page factor whether or not it is worse. In the human
 * report most branch-B findings are attached to a missing-index finding and
 * leave this list; in `--json` the ordering is visible, so it is stated here. That is a deliberate behavior change: the old key is documented as "a
 * ROUGH scale only", and ordering findings by a ratio put the cheapest ones on
 * top.
 */
function extraBufferAccesses(f: PlanDivergenceFinding): number {
  if (f.branch === 'unindexed-filter') return (f.tuplesWalked ?? 0) - f.pages;
  return (f.walkPages ?? 0) - Math.min(f.rarestBucket, f.pages);
}

/**
 * Score every candidate column against the snapshot and return the ones whose
 * distribution admits a damaging generic-plan flip.
 *
 * TWO rules, split on whether a plain btree serves the filter column, because
 * that is what decides what the CUSTOM plan does and therefore where the
 * boundary is and what units the damage is in.
 *
 * `sparse-value` (indexed): the generic estimate sits ABOVE the plan boundary
 * (so a promoted plan keeps the ordered index scan) while the table's rarest
 * values sit below it, and the pages that ordered scan must walk for such a
 * value are worth a user's attention both in absolute terms and as a fraction of
 * the table.
 *
 * `unindexed-filter` (no btree): see the block above its gates. Its boundary is
 * linear in the LIMIT rather than sqrt in the pages, and it carries NO
 * generic-side gate at all, for a measured reason recorded there.
 *
 * `correlation` is reported but gates nothing in EITHER branch. It used to route
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
  let consideredIndexed = 0;
  let consideredUnindexed = 0;

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

    const { hasIdx, orderColumn, unmodelledAccessMethod } = indexShapeFor(snapshot, meta, candidate.column);
    // A brin/gin/gist path serves the equality in a way neither branch's custom
    // plan describes. Scored by neither rule, but SAID so: silently dropping it
    // is how the unindexed population went missing in the first place.
    if (unmodelledAccessMethod !== null) {
      notices.push({
        table: candidate.table,
        column: candidate.column,
        reason: `served only by a ${unmodelledAccessMethod} index: this check models btree and hash equality paths, so neither rule describes the plan here`,
      });
      continue;
    }
    // No other ordering index: no alternative plan for the generic estimate to
    // run away with. The ONLY shape gate left, and it applies to both branches.
    //
    // `hasIdx` used to be a second one, dropped here BEFORE the considered
    // counter. That put every unindexed column outside the scored population and
    // outside the notices too, silently, and one of the mechanisms that produces
    // real divergence lives exactly there: with no btree on the filter column
    // the custom plan's alternative is a seq scan, which the generic plan will
    // not choose. It now selects the branch instead of ending the candidate.
    if (orderColumn === null) continue;
    const branch: PlanDivergenceBranch = hasIdx ? 'sparse-value' : 'unindexed-filter';

    // Counted HERE, before any scored gate. Everything above is a SHAPE
    // question (is there an index to flip between at all?); everything below is
    // a verdict on live statistics. A user must be able to tell "considered and
    // clean" from "never looked", and an earlier revision incremented this after
    // a silent table-size floor, so the two were indistinguishable.
    candidatesConsidered++;
    if (hasIdx) consideredIndexed++;
    else consideredUnindexed++;

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
    const correlation = dist.correlation ?? 0;
    // The ORDER column's correlation, which is the one that decides how much an
    // `unindexed-filter` flip costs. Read opportunistically: a caller that did
    // not ask the collector for it leaves the finding's field null rather than
    // asserting a heap shape from a statistic it does not have.
    const orderDist = snapshot.columnStats?.[`${candidate.table}.${orderColumn}`];
    const orderColumnCorrelation = orderDist?.correlation ?? null;

    // Everything common to both branches. The branch-shaped fields are filled in
    // below and are left UNSET, never zero-filled, on the branch they do not
    // describe.
    const columnType = meta.pgTypes[candidate.column] ?? 'text';
    const common = {
      branch,
      table: candidate.table,
      column: candidate.column,
      rows,
      pages,
      distinctValues,
      genericEstimate,
      rarestBucket,
      densestBucket,
      correlation,
      orderColumnCorrelation,
      assumedLimit: t.assumedLimit,
      orderColumn,
      columnField: meta.reverseColumnMap[candidate.column] ?? candidate.column,
      orderColumnField: meta.reverseColumnMap[orderColumn] ?? orderColumn,
      lastAnalyze: stats.lastAnalyze ?? null,
      diagnosticSql: buildDiagnosticSql(candidate.table, candidate.column, orderColumn, columnType, branch),
      thresholds: t,
    };

    if (branch === 'unindexed-filter') {
      // BRANCH B. Two gates, and deliberately no third.
      //
      // GATE 1, rarestBucket < assumedLimit. The measured boundary at which the
      // CUSTOM planner abandons the seq scan for the ordered walk is k x limit,
      // with k = cost(full ordered index scan) / cost(seq scan + sort), measured
      // 3.32 on a 267-page table and 3.245 on a 2,667-page one: the SAME
      // boundary at 10x the size, so it is size independent, and it is linear in
      // the limit. Gating at 1 x limit instead of the measured 3.3 x keeps this
      // strictly inside the boundary with better than 2x margin, and it is also
      // the regime of maximum damage: below the limit the ordered walk can never
      // fill the LIMIT, so it walks the entire table.
      //
      // The recall this gives up is real and it GROWS with the table, in the
      // same buffer-access units this module sorts on. Measured on the
      // module-header fixture at 200,000 rows / 2,470 pages with a rarest bucket
      // of 60: custom Seq Scan 2,473 buffers / 8.1 ms, generic PK Index Scan
      // 200,547 buffers / 99.0 ms. That is an 81x flip and 198,074 extra buffer
      // accesses, declined here because 60 >= 20, and it is an order of
      // magnitude more absolute damage than the largest finding this branch DOES
      // report on the 20,000-row fixture (19,824 extra accesses). The honest way
      // to take it back is to derive k from pages, rows and the cost constants,
      // not to widen the constant; until that lands it is a stated recall limit,
      // not a safe one.
      //
      // GATE 2, an absolute floor on tuples walked. See minGenericTupleWalk.
      //
      // NO GENERIC-SIDE GATE, and that is the measured part rather than an
      // omission. Turbine always parameterizes LIMIT on Postgres, and an unknown
      // `LIMIT $n` is estimated as 10% of the child node's row estimate, so the
      // generic plan's ordered index scan is discounted 10x WHATEVER the child
      // estimate is. It therefore takes the ordered walk whenever
      // cost(full ordered scan) < 10 x cost(seq scan + sort), i.e. whenever
      // k < 10, and k measured 3.2 to 3.3 on every fixture, independent of
      // n_distinct. Demonstrated directly: a 20,000-row / 267-page table with
      // n_distinct 5,001 (generic estimate 4 rows, far below any crossover)
      // still gave custom = Seq Scan 267 buffers and generic = PK Index Scan
      // 19,994 buffers, a real 74x divergence that a `genericEstimate >=
      // crossover` gate silently rejects. The generic plan's choice here is a
      // property of the SHAPE, not of the distribution.
      if (rarestBucket >= t.assumedLimit) continue;
      // Always exactly `rows` under gate 1; see the field's own note.
      const tuplesWalked = rarestBucket > 0 ? Math.min(rows, (rows * t.assumedLimit) / rarestBucket) : rows;
      if (tuplesWalked < t.minGenericTupleWalk) continue;
      findings.push({
        ...common,
        tuplesWalked,
        worstCaseAmplification: tuplesWalked / pages,
        heapNearlyOrdered: orderColumnCorrelation !== null && orderColumnCorrelation >= t.nearExactOrderCorrelation,
      });
      continue;
    }

    // BRANCH A, unchanged from 0.56.0.
    const crossover = crossoverRows(pages, t.assumedLimit);
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

    findings.push({
      ...common,
      crossoverRows: crossover,
      crossoverRowsWide: crossoverRows(pages, t.wideLimit),
      valuesBelowCrossover,
      walkPages,
      walkFraction,
      approxAmplification,
    });
  }

  findings.sort(
    (a, b) =>
      extraBufferAccesses(b) - extraBufferAccesses(a) ||
      a.table.localeCompare(b.table) ||
      a.column.localeCompare(b.column),
  );
  return { findings, notices, candidatesConsidered, consideredIndexed, consideredUnindexed };
}
