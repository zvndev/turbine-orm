/**
 * turbine-orm - plan-flip probe, pure half (no database).
 *
 * The probe's job is to REMOVE findings, which makes its failure modes
 * asymmetric: dropping a real one is invisible in the report, so the tests that
 * matter most here are the ones asserting a finding SURVIVES.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PlanDivergenceFinding, PlanDivergenceReport } from '../plan-divergence.js';
import {
  applyFlipVerdicts,
  buildFlipProbeSql,
  emptyFlipProbeResult,
  type FlipProbeResult,
  flipProbeKey,
  needsFlipProbe,
  verdictFromPlanJson,
} from '../plan-flip-probe.js';

function finding(over: Partial<PlanDivergenceFinding> = {}): PlanDivergenceFinding {
  return {
    branch: 'unindexed-filter',
    table: 'inventory_location',
    column: 'organization_id',
    rows: 20000,
    pages: 247,
    distinctValues: 40,
    genericEstimate: 500,
    rarestBucket: 2,
    densestBucket: 10000,
    correlation: 0.01,
    assumedLimit: 20,
    orderColumn: 'id',
    columnField: 'organizationId',
    orderColumnField: 'id',
    ...over,
  } as PlanDivergenceFinding;
}

function report(findings: PlanDivergenceFinding[]): PlanDivergenceReport {
  return {
    findings,
    notices: [],
    candidatesConsidered: findings.length,
    consideredIndexed: 0,
    consideredUnindexed: findings.length,
  };
}

function probe(verdicts: FlipProbeResult['verdicts'], notices: string[] = []): FlipProbeResult {
  return { available: true, verdicts, notices };
}

describe('needsFlipProbe', () => {
  it('targets the unindexed-filter branch only', () => {
    assert.equal(needsFlipProbe(finding({ branch: 'unindexed-filter' })), true);
    assert.equal(needsFlipProbe(finding({ branch: 'sparse-value' })), false);
  });
});

describe('buildFlipProbeSql', () => {
  it('quotes every identifier and parameterizes both values', () => {
    const sql = buildFlipProbeSql(finding(), 'tpf_0');
    assert.equal(
      sql.prepare,
      'PREPARE tpf_0 AS SELECT * FROM "inventory_location" WHERE "organization_id" = $1 ORDER BY "id" LIMIT $2',
    );
    assert.equal(sql.explain, 'EXPLAIN (FORMAT JSON) EXECUTE tpf_0(NULL, 20)');
    assert.equal(sql.deallocate, 'DEALLOCATE tpf_0');
  });

  it('qualifies with the search schema when one is configured', () => {
    const sql = buildFlipProbeSql(finding(), 'tpf_1', 'reporting');
    assert.match(sql.prepare, /FROM "reporting"\."inventory_location"/);
  });

  it('cannot be broken out of by a hostile identifier', () => {
    // Identifiers come from introspected catalogs rather than user input, but a
    // quoting regression here would put catalog text into executable SQL.
    const sql = buildFlipProbeSql(finding({ table: 'ev"il', column: 'c"ol', orderColumn: 'o"rd' }), 'tpf_2');
    assert.match(sql.prepare, /FROM "ev""il"/);
    assert.match(sql.prepare, /WHERE "c""ol" = \$1/);
    assert.match(sql.prepare, /ORDER BY "o""rd"/);
  });

  it('never inlines the limit, because a constant limit takes a different planner path', () => {
    const sql = buildFlipProbeSql(finding(), 'tpf_3');
    assert.match(sql.prepare, /LIMIT \$2$/);
  });
});

describe('verdictFromPlanJson', () => {
  const plan = (nodes: unknown) => [{ Plan: nodes }];

  it('refutes only a sequential scan of the target table', () => {
    const p = plan({ 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 't' }] });
    assert.equal(verdictFromPlanJson(p, 't'), 'no-flip');
  });

  it('keeps the finding when the generic plan uses an index scan', () => {
    const p = plan({ 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Index Scan', 'Relation Name': 't' }] });
    assert.equal(verdictFromPlanJson(p, 't'), 'flip-reachable');
  });

  it('keeps the finding for a bitmap heap scan, which is not a plain seq scan', () => {
    const p = plan({ 'Node Type': 'Limit', Plans: [{ 'Node Type': 'Bitmap Heap Scan', 'Relation Name': 't' }] });
    assert.equal(verdictFromPlanJson(p, 't'), 'flip-reachable');
  });

  it('ignores a sequential scan of some OTHER relation', () => {
    // A seq scan of a joined table says nothing about this column, and reading it
    // as a refutation would silently drop findings on any table that joins.
    const p = plan({
      'Node Type': 'Nested Loop',
      Plans: [
        { 'Node Type': 'Seq Scan', 'Relation Name': 'other' },
        { 'Node Type': 'Index Scan', 'Relation Name': 't' },
      ],
    });
    assert.equal(verdictFromPlanJson(p, 't'), 'flip-reachable');
  });

  it('returns unknown rather than refuting on an unparseable payload', () => {
    assert.equal(verdictFromPlanJson(undefined, 't'), 'unknown');
    assert.equal(verdictFromPlanJson([], 't'), 'unknown');
    assert.equal(verdictFromPlanJson([{}], 't'), 'unknown');
    assert.equal(verdictFromPlanJson(plan({ 'Node Type': 'Result' }), 't'), 'unknown');
  });
});

describe('applyFlipVerdicts', () => {
  it('drops a refuted finding and counts it', () => {
    const out = applyFlipVerdicts(
      report([finding()]),
      probe({ [flipProbeKey('inventory_location', 'organization_id')]: 'no-flip' }),
    );
    assert.equal(out.findings.length, 0);
    assert.equal(out.flipRefuted, 1);
    assert.equal(out.flipProbed, true);
  });

  it('keeps a confirmed finding', () => {
    const out = applyFlipVerdicts(
      report([finding()]),
      probe({ [flipProbeKey('inventory_location', 'organization_id')]: 'flip-reachable' }),
    );
    assert.equal(out.findings.length, 1);
    assert.equal(out.flipRefuted, 0);
  });

  it('KEEPS a finding whose probe was inconclusive', () => {
    // The failure contract: a diagnostic must not delete findings because the
    // database was uncooperative, since that is invisible in the output.
    const out = applyFlipVerdicts(
      report([finding()]),
      probe({ [flipProbeKey('inventory_location', 'organization_id')]: 'unknown' }),
    );
    assert.equal(out.findings.length, 1);
    assert.equal(out.flipRefuted, 0);
  });

  it('KEEPS a finding that has no verdict at all', () => {
    const out = applyFlipVerdicts(report([finding()]), probe({}));
    assert.equal(out.findings.length, 1);
  });

  it('never touches a sparse-value finding, even with a refuting verdict present', () => {
    const sparse = finding({ branch: 'sparse-value' });
    const out = applyFlipVerdicts(report([sparse]), probe({ [flipProbeKey(sparse.table, sparse.column)]: 'no-flip' }));
    assert.equal(out.findings.length, 1);
  });

  it('is a no-op when the probe never ran, leaving flipProbed falsy', () => {
    const out = applyFlipVerdicts(report([finding()]), emptyFlipProbeResult());
    assert.equal(out.findings.length, 1);
    assert.notEqual(out.flipProbed, true);
  });

  it('carries probe notices into the report so an inconclusive pass is visible', () => {
    const out = applyFlipVerdicts(report([finding()]), probe({}, ['probe on x.y was inconclusive']));
    assert.equal(out.notices.length, 1);
    assert.match(out.notices[0]!.reason, /inconclusive/);
  });
});
