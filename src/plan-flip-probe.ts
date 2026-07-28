/**
 * Plan-flip probe: does the generic plan actually differ from the good one?
 *
 * ## Why this exists
 *
 * `plan-divergence.ts` scores a column from statistics alone and answers "IF the
 * cached plan flips, how bad is it". Its `unindexed-filter` branch (0.57) shipped
 * without an answer to the prior question, "CAN it flip at all", and that turned
 * out to be the majority case: on a real 118-model schema the branch produced 39
 * findings of which a measured sample was right 6 times in 13.
 *
 * Every false positive had one signature: **the generic plan was not the ordered
 * index walk the finding claims.** There was no flip to be had, so the
 * amplification the finding printed described a plan the planner would never
 * pick. See {@link verdictFromPlanJson} for the two ways a plan fails to be that
 * walk; 0.58.0 shipped only one of them and 0.59.0 added the other.
 *
 * ## Why this is a probe and not another rule
 *
 * The obvious gate is arithmetic: require the generic row estimate
 * (`rows / n_distinct`) to exceed the assumed LIMIT, on the reasoning that
 * Postgres discounts an ordered index walk by `min(1, limit / estimate)` and an
 * estimate at or below the limit earns no discount at all.
 *
 * That rule is wrong, and it was measured wrong before it was written down here.
 * The real limit fraction for a BOUND limit is `ceil(0.1 x estimate) / estimate`,
 * which pins to 0.1 for estimates of 10 or more but RISES to `1/estimate` below
 * that, and the plan is then chosen by comparing that fraction of the full index
 * scan against a seq scan plus sort. On a 247-page fixture the flip boundary sits
 * between estimates 3 and 4, not at the limit of 20:
 *
 * ```txt
 * generic estimate   2    3       4        10       20       500
 * generic plan      seq  seq   index    index    index     index
 * buffers           250  250  20,074   20,074   19,071       765
 * ```
 *
 * Estimates 4 through 20 are full-table walks that an estimate-versus-limit gate
 * would discard. The boundary is also not a fixed number: it is a cost
 * comparison, so it moves with the table. Reproducing the same estimate on a
 * 1976-page table and on an 89-page narrow table put the flip in a different
 * place each time.
 *
 * So the honest gate is not a better formula, it is a measurement. `EXPLAIN`
 * WITHOUT `ANALYZE` executes nothing, returns in microseconds, and asks the
 * planner the exact question the rule was trying to predict. This module runs it.
 *
 * ## What it asks, and why only half the pair
 *
 * It plans ONE statement, under `force_generic_plan` only:
 *
 * ```sql
 * PREPARE p AS SELECT * FROM t WHERE col = $1 ORDER BY ord LIMIT $2;
 * EXPLAIN (FORMAT JSON) EXECUTE p(NULL, 20);
 * ```
 *
 * The custom plan is not needed. The finding's whole claim is that a promoted
 * generic plan performs an ordered index walk, so a generic plan that is NOT that
 * walk refutes it no matter what the custom plan does. Asking one question
 * instead of two halves the work and removes the need for a representative rare
 * value, which statistics do not carry.
 *
 * `NULL` is a safe argument precisely because the plan is generic: a generic plan
 * is built without looking at the value, which is the property the whole check is
 * about. The LIMIT is bound as `$2` rather than inlined because that is the shape
 * Turbine emits, and an inlined limit takes a different code path in the planner.
 *
 * ## Failure is never a silent drop
 *
 * A probe that errors, times out, or returns an unparseable plan yields
 * `'unknown'` and the finding SURVIVES with a note. A diagnostic that deletes
 * findings when the database is uncooperative would be worse than one that
 * over-reports, because the failure would be invisible in exactly the
 * environments (restricted roles, non-Postgres engines) where a human is least
 * able to check.
 *
 * @module
 */

import type { PlanDivergenceFinding, PlanDivergenceReport } from './plan-divergence.js';
import { quoteIdent } from './query/utils.js';

/**
 * The planner's answer for one finding.
 *
 * - `'flip-reachable'`, the generic plan IS an ordered index walk on the target
 *   table, so the divergence the finding describes is one the planner can
 *   actually choose.
 * - `'no-flip'`, the generic plan is not that walk (a `Sort` bounds it, or the
 *   access is a plain seq scan). Nothing to diverge to.
 * - `'unknown'`, the probe did not produce an answer. The finding is kept.
 */
export type FlipVerdict = 'flip-reachable' | 'no-flip' | 'unknown';

/** Outcome of a probe pass, keyed by {@link flipProbeKey}. */
export interface FlipProbeResult {
  /** True when the probe pass ran at all (Postgres, connection succeeded). */
  available: boolean;
  verdicts: Record<string, FlipVerdict>;
  notices: string[];
}

/** An empty result, which keeps every finding. Used when probing is off. */
export function emptyFlipProbeResult(): FlipProbeResult {
  return { available: false, verdicts: {}, notices: [] };
}

/**
 * Map key for a (table, column) pair.
 *
 * `\u0000` as the separator, written as the ESCAPE and never as a raw byte: a
 * literal NUL in a source file makes `grep` treat the whole file as binary, which
 * is how four of them survived a release in `cli/index.ts`.
 */
export function flipProbeKey(table: string, column: string): string {
  return `${table}\u0000${column}`;
}

/**
 * Which findings are worth probing.
 *
 * `unindexed-filter` only. The `sparse-value` branch already requires an index
 * that serves the equality, and its 0.56 calibration was 6 of 6 on the schema
 * that later produced 6 of 13 here, so there is no measured precision problem to
 * spend a round trip on.
 */
export function needsFlipProbe(finding: PlanDivergenceFinding): boolean {
  return finding.branch === 'unindexed-filter';
}

/**
 * The SQL for one probe. Pure, so the exact text is unit-testable without a
 * database.
 *
 * Every identifier goes through {@link quoteIdent}; the only values in the
 * statement are `$1` and `$2`, bound at EXECUTE. `name` is generated by the
 * caller as `tpf_<index>` and is never caller-controlled text.
 */
export function buildFlipProbeSql(
  finding: PlanDivergenceFinding,
  name: string,
  searchSchema?: string,
): { prepare: string; explain: string; deallocate: string } {
  const rel = searchSchema ? `${quoteIdent(searchSchema)}.${quoteIdent(finding.table)}` : quoteIdent(finding.table);
  // No declared parameter types: Postgres infers both from context, which avoids
  // maintaining a second pg-type mapping that could disagree with the column's
  // real type and turn a diagnostic into an error.
  const prepare =
    `PREPARE ${name} AS SELECT * FROM ${rel} ` +
    `WHERE ${quoteIdent(finding.column)} = $1 ` +
    `ORDER BY ${quoteIdent(finding.orderColumn)} LIMIT $2`;
  return {
    prepare,
    explain: `EXPLAIN (FORMAT JSON) EXECUTE ${name}(NULL, ${Number(finding.assumedLimit)})`,
    deallocate: `DEALLOCATE ${name}`,
  };
}

/** One node of the JSON plan tree, narrowed to the fields the verdict reads. */
interface PlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  Plans?: PlanNode[];
}

/**
 * Read a verdict out of one `EXPLAIN (FORMAT JSON)` payload.
 *
 * Exported for unit tests: the plan shapes this has to classify are exactly the
 * ones that are tedious to produce live.
 *
 * ## The question, stated exactly
 *
 * The finding claims the generic plan performs an ORDERED INDEX WALK along the
 * `ORDER BY` column and fetches nearly every tuple before the `LIMIT` fills. So
 * the refutation is not "the plan is a seq scan", it is **"the plan is not that
 * ordered walk"**, and there are two ways for it not to be:
 *
 * 1. A `Sort` lies above the target table's scan. A sort materializes the whole
 *    matched set and orders it, so the cost is bounded by how many rows match,
 *    not by how far into the heap the ordered walk has to travel. Whatever feeds
 *    it (seq scan, bitmap heap scan) the catastrophic shape is absent.
 * 2. The target's own scan node is a `Seq Scan`. Kept as an independent ground
 *    rather than folded into the first, so a hypothetical ordered seq scan with
 *    no sort still refutes.
 *
 * 0.58.0 shipped only the second ground and therefore missed every LOW-estimate
 * column that has ANY usable index, because those plan as `Limit > Sort > Bitmap
 * Heap Scan`. The case that surfaced it was a column carrying
 * `btree (col) WHERE col IS NOT NULL`: an equality predicate implies not-null, so
 * that partial index is fully usable and the plan never reaches a seq scan.
 * Reproduced, and the fixture is the pair below at the same estimate:
 *
 * ```txt
 * partial index, est 1.9   Limit > Sort > Bitmap Heap Scan   <- 0.58 kept this
 * no index,      est 1.9   Limit > Sort > Seq Scan           <- 0.58 refuted this
 * either,        est 500   Limit > Index Scan (no Sort)      <- both keep, correctly
 * ```
 *
 * ## Why this is not "exclude partial-index columns"
 *
 * Because a partial index whose predicate is NOT implied by the equality does not
 * serve the query at all, and such a column produces a genuine finding: one was
 * measured at 19,961x. The property that matters is whether the planner COULD
 * use it, which is a proof obligation over predicates, and the plan already
 * carries the answer. Reading the plan is cheaper and cannot drift from the
 * planner's own implication rules.
 *
 * ## The safe direction is KEEP
 *
 * Over-refuting deletes real findings, which is invisible in the report;
 * over-keeping only costs noise. So `Incremental Sort` does NOT refute: it means
 * the index supplies a PREFIX of the ordering and the walk is still partly
 * ordered, which is closer to the catastrophic shape than to the bounded one.
 */
export function verdictFromPlanJson(payload: unknown, table: string): FlipVerdict {
  const root = Array.isArray(payload) ? (payload[0] as { Plan?: PlanNode } | undefined) : undefined;
  const plan = root?.Plan;
  if (!plan) return 'unknown';

  // Walk root-downward, tracking whether a full Sort sits ABOVE the target's
  // scan. Depth matters: a Sort somewhere else in a larger plan says nothing
  // about how this table is reached.
  const search = (node: PlanNode, sortedAbove: boolean): FlipVerdict | null => {
    const type = node['Node Type'];
    if (node['Relation Name'] === table && type !== undefined) {
      if (sortedAbove) return 'no-flip';
      return type === 'Seq Scan' ? 'no-flip' : 'flip-reachable';
    }
    // 'Incremental Sort' is deliberately excluded, see the header.
    const nowSorted = sortedAbove || type === 'Sort';
    for (const child of node.Plans ?? []) {
      const found = search(child, nowSorted);
      if (found !== null) return found;
    }
    return null;
  };

  // The target table not appearing at all should not happen for a statement that
  // selects from it. Treated as unknown rather than as a refutation.
  return search(plan, false) ?? 'unknown';
}

/**
 * Minimal client surface.
 *
 * A CLIENT, not a pool, and that distinction is load-bearing rather than
 * stylistic. `index-stats.ts` uses a one-connection pool because each of its
 * reads is independent, but this pass is one transaction spanning many
 * statements, and node-postgres DISCARDS a connection whose query errored and
 * hands out a fresh one. Through a pool the first failing probe therefore
 * silently ends the transaction, and every probe after it fails with "SAVEPOINT
 * can only be used in transaction blocks", which is exactly how the savepoint
 * recovery test caught this.
 */
interface MinimalClient {
  connect(): Promise<void>;
  query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
  end(): Promise<void>;
}

export interface ProbePlanFlipsOptions {
  connectionString: string;
  schema?: string;
  findings: PlanDivergenceFinding[];
  statementTimeoutMs?: number;
}

/**
 * Ask the planner, once per candidate finding, whether the flip is reachable.
 *
 * Runs inside a single `BEGIN READ ONLY` that is always rolled back. Nothing is
 * executed: `EXPLAIN` without `ANALYZE` plans and discards. Each probe is
 * INDIVIDUALLY optional, the same contract `collectStatsSnapshot` uses, so one
 * unprobeable column degrades that column's verdict to `'unknown'` and never the
 * pass.
 */
export async function probePlanFlips(options: ProbePlanFlipsOptions): Promise<FlipProbeResult> {
  const targets = options.findings.filter(needsFlipProbe);
  const result: FlipProbeResult = { available: false, verdicts: {}, notices: [] };
  if (targets.length === 0) {
    result.available = true;
    return result;
  }

  const { Client } = (await import('pg')).default;
  const client = new Client({ connectionString: options.connectionString }) as unknown as MinimalClient;

  try {
    await client.connect();
    await client.query(`SET statement_timeout = ${Number(options.statementTimeoutMs ?? 5000)}`);
    // READ ONLY is belt-and-braces: EXPLAIN without ANALYZE cannot write, and the
    // transaction is rolled back regardless. It costs nothing and makes the
    // read-only intent checkable from a server-side log.
    await client.query('BEGIN READ ONLY');
    result.available = true;

    for (let i = 0; i < targets.length; i++) {
      const finding = targets[i]!;
      const key = flipProbeKey(finding.table, finding.column);
      const name = `tpf_${i}`;
      const sql = buildFlipProbeSql(finding, name, options.schema);
      try {
        // A failed probe must not poison the surrounding transaction for the
        // probes after it, so each one gets its own savepoint.
        await client.query(`SAVEPOINT ${name}`);
        await client.query(sql.prepare);
        await client.query('SET LOCAL plan_cache_mode = force_generic_plan');
        const res = await client.query<{ [k: string]: unknown }>(sql.explain);
        const row = res.rows[0];
        const payload = row ? (Object.values(row)[0] as unknown) : undefined;
        result.verdicts[key] =
          typeof payload === 'string'
            ? verdictFromPlanJson(JSON.parse(payload), finding.table)
            : verdictFromPlanJson(payload, finding.table);
        await client.query(sql.deallocate);
        await client.query(`RELEASE SAVEPOINT ${name}`);
      } catch (err) {
        result.verdicts[key] = 'unknown';
        result.notices.push(
          `flip probe on ${finding.table}.${finding.column} was inconclusive (${
            err instanceof Error ? err.message.split('\n')[0] : String(err)
          }); the finding is kept`,
        );
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        } catch {
          // The transaction itself is gone; the remaining probes will each record
          // their own notice and the pass still returns what it has.
        }
      }
    }
  } catch (err) {
    result.notices.push(
      `plan-flip probing unavailable (${err instanceof Error ? err.message.split('\n')[0] : String(err)}); findings are reported unverified`,
    );
  } finally {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Nothing to roll back.
    }
    await client.end().catch(() => {});
  }

  return result;
}

/**
 * Drop the findings the planner refuted, and record how many.
 *
 * Pure. `'unknown'` and a missing verdict both KEEP the finding: see the failure
 * contract in the module header.
 */
export function applyFlipVerdicts(report: PlanDivergenceReport, probe: FlipProbeResult): PlanDivergenceReport {
  if (!probe.available) return report;
  let refuted = 0;
  const findings = report.findings.filter((f) => {
    if (!needsFlipProbe(f)) return true;
    const verdict = probe.verdicts[flipProbeKey(f.table, f.column)];
    if (verdict === 'no-flip') {
      refuted++;
      return false;
    }
    return true;
  });
  return {
    ...report,
    findings,
    flipProbed: true,
    flipRefuted: refuted,
    notices: [...report.notices, ...probe.notices.map((n) => ({ table: '', column: '', reason: n }))],
  };
}
