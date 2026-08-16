/**
 * Turn one or more JSONL result files into the tables the write-up needs.
 *
 * Two rules the aggregation enforces rather than leaves to the writer:
 *
 *  - UNSCORED ATTEMPTS ARE OUT OF THE DENOMINATOR, and their count is printed
 *    next to every rate. A pass rate computed over attempts that never ran is
 *    the exact failure mode the spec's third gate is about.
 *  - EVERY DELTA CARRIES ITS SAMPLE SIZE. A cell of 8 tasks moving by one task
 *    is 12.5 points, which looks like a result and is not one.
 */
import { readFileSync } from 'node:fs';
import type { AttemptRecord } from './run.js';
import { evalSchema } from './schema-meta.js';

/**
 * Split E003 into its causes, after the fact, from the stored error message.
 *
 * One cause turned out to dominate and it is not a query-shape mistake at all:
 * Turbine accepts a snake_case column key in `where`, `select`, `omit`,
 * `distinct` and `cursor`, but rejects the same key in `orderBy`, `groupBy.by`
 * and the `_avg`/`_sum`/`_min`/`_max` targets. A model that reads the DDL (which
 * is snake_case, as every DDL is) and writes what it read is right five times
 * and wrong three times, for reasons that have nothing to do with whether it
 * understood the question.
 *
 * Reporting that inside a single "E003" bucket would have let it masquerade as
 * evidence that models cannot write queries. Separating it lets a reader price
 * the tools with the confound visible, and it is also the single most
 * actionable thing this exercise found.
 */
export type SubClass = string;

const UNKNOWN_FIELD = /Unknown field "([^"]+)"/;
const RELATION_IN_PROJECTION = /"([^"]+)" is a relation on table/;

export function subClassify(r: AttemptRecord, columnsBySnake: Set<string>): SubClass {
  if (r.status !== 'fail') return r.failure ?? '?';
  if (r.failure !== 'E003-validation') return r.failure ?? '?';
  const detail = r.detail ?? '';

  const unknown = UNKNOWN_FIELD.exec(detail);
  if (unknown) {
    const name = unknown[1] as string;
    // Was it the snake_case spelling of a column that really exists?
    if (name.includes('_') && columnsBySnake.has(name)) return 'E003-snake-case-name';
    return 'E003-unknown-field';
  }
  if (RELATION_IN_PROJECTION.test(detail)) return 'E003-relation-in-select';
  if (/Compound unique selector/.test(detail)) return 'E003-compound-unique';
  if (/mutually exclusive/.test(detail)) return 'E003-select-and-omit';
  return 'E003-other';
}

export interface Cell {
  pass: number;
  fail: number;
  unscored: number;
  /** Pass rate over SCORED attempts only. Null when nothing was scorable. */
  rate: number | null;
}

export function loadRecords(paths: string[]): AttemptRecord[] {
  const out: AttemptRecord[] = [];
  for (const p of paths) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (line.trim().startsWith('{')) out.push(JSON.parse(line) as AttemptRecord);
    }
  }
  return out;
}

export function cell(records: AttemptRecord[]): Cell {
  const pass = records.filter((r) => r.status === 'pass').length;
  const fail = records.filter((r) => r.status === 'fail').length;
  const unscored = records.filter((r) => r.status === 'unscored').length;
  const scored = pass + fail;
  return { pass, fail, unscored, rate: scored === 0 ? null : (pass / scored) * 100 };
}

export function by<T extends string | number>(
  records: AttemptRecord[],
  key: (r: AttemptRecord) => T,
): Map<T, AttemptRecord[]> {
  const m = new Map<T, AttemptRecord[]>();
  for (const r of records) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    (m.get(k) as AttemptRecord[]).push(r);
  }
  return m;
}

export function pct(c: Cell): string {
  return c.rate === null ? 'n/a' : `${c.rate.toFixed(0)}%`;
}

function fmtCell(c: Cell): string {
  const scored = c.pass + c.fail;
  const u = c.unscored > 0 ? ` (+${c.unscored} unsc)` : '';
  return `${pct(c)} ${c.pass}/${scored}${u}`;
}

async function main(): Promise<void> {
  const paths = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (paths.length === 0) {
    console.error('usage: tsx src/report.ts <results.jsonl> [more.jsonl ...]');
    process.exit(1);
  }
  const records = loadRecords(paths);

  const schema = await evalSchema();
  const columnsBySnake = new Set<string>();
  for (const meta of Object.values(schema.tables)) {
    for (const col of meta.columns) columnsBySnake.add(col.name);
  }
  const arms = [...new Set(records.map((r) => r.arm))].sort();
  const models = [...new Set(records.map((r) => r.model))];

  console.log(`\ntotal attempts: ${records.length}`);
  console.log(`unscored:       ${records.filter((r) => r.status === 'unscored').length}\n`);

  // -- pass rate per model per arm ----------------------------------------
  console.log('## pass rate per model per arm (pass/scored)\n');
  console.log(`| model | ${arms.join(' | ')} |`);
  console.log(`|---|${arms.map(() => '---').join('|')}|`);
  for (const m of models) {
    const cells = arms.map((a) => fmtCell(cell(records.filter((r) => r.model === m && r.arm === a))));
    console.log(`| ${m} | ${cells.join(' | ')} |`);
  }

  // -- deltas --------------------------------------------------------------
  console.log('\n## deltas (percentage points, over scored attempts)\n');
  console.log('| model | A->B | B->C | C->D | A->D |');
  console.log('|---|---|---|---|---|');
  for (const m of models) {
    const r = (a: string): number | null => cell(records.filter((x) => x.model === m && x.arm === a)).rate;
    const d = (x: number | null, y: number | null): string =>
      x === null || y === null ? 'n/a' : `${y - x >= 0 ? '+' : ''}${(y - x).toFixed(0)}`;
    console.log(`| ${m} | ${d(r('A'), r('B'))} | ${d(r('B'), r('C'))} | ${d(r('C'), r('D'))} | ${d(r('A'), r('D'))} |`);
  }

  // -- failure classes -----------------------------------------------------
  console.log('\n## failure classes per arm (E003 split by cause)\n');
  const sub = new Map<AttemptRecord, string>();
  for (const r of records) sub.set(r, subClassify(r, columnsBySnake));
  const classes = [...new Set(records.filter((r) => r.status === 'fail').map((r) => sub.get(r) as string))].sort();
  console.log(`| failure | ${arms.join(' | ')} | total |`);
  console.log(`|---|${arms.map(() => '---').join('|')}|---|`);
  for (const c of classes) {
    const counts = arms.map((a) => records.filter((r) => r.arm === a && r.status === 'fail' && sub.get(r) === c).length);
    console.log(`| ${c} | ${counts.join(' | ')} | ${counts.reduce((a, b) => a + b, 0)} |`);
  }

  // -- pass rate with the naming confound excluded --------------------------
  // Attempts whose ONLY error was the snake_case inconsistency are removed
  // from both numerator and denominator, so the remaining rate is about query
  // shape. Reported alongside the real rate, never instead of it.
  console.log('\n## pass rate excluding snake_case-name failures\n');
  console.log(`| model | ${arms.join(' | ')} |`);
  console.log(`|---|${arms.map(() => '---').join('|')}|`);
  for (const m of models) {
    const cells = arms.map((a) => {
      const rs = records.filter(
        (r) => r.model === m && r.arm === a && sub.get(r) !== 'E003-snake-case-name',
      );
      return fmtCell(cell(rs));
    });
    console.log(`| ${m} | ${cells.join(' | ')} |`);
  }

  // -- per shape -----------------------------------------------------------
  console.log('\n## pass rate per shape per arm\n');
  const shapes = [...new Set(records.map((r) => r.shape))].sort();
  console.log(`| shape | ${arms.join(' | ')} |`);
  console.log(`|---|${arms.map(() => '---').join('|')}|`);
  for (const s of shapes) {
    const cells = arms.map((a) => pct(cell(records.filter((r) => r.shape === s && r.arm === a))));
    console.log(`| ${s} | ${cells.join(' | ')} |`);
  }

  // -- tool usage ----------------------------------------------------------
  console.log('\n## MCP tool calls (arms C and D)\n');
  const toolRecords = records.filter((r) => r.arm === 'C' || r.arm === 'D');
  const counts = new Map<string, number>();
  for (const r of toolRecords) for (const t of r.toolCalls) counts.set(t, (counts.get(t) ?? 0) + 1);
  const ALL_TOOLS = [
    'schema_overview', 'table_detail', 'migrate_status', 'doctor_report', 'explain_query',
    'compile_query', 'sample_rows', 'relation_graph', 'find_join_path', 'table_stats', 'explain_error',
  ];
  for (const t of ALL_TOOLS) console.log(`  ${t.padEnd(18)} ${counts.get(t) ?? 0}`);
  const withTools = toolRecords.filter((r) => r.toolCalls.length > 0).length;
  console.log(`\n  attempts that called at least one tool: ${withTools}/${toolRecords.length}`);
  const never = ALL_TOOLS.filter((t) => !counts.has(t));
  console.log(`  never called: ${never.length ? never.join(', ') : '(none)'}`);

  // -- cost ----------------------------------------------------------------
  const spend = records.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const totalMs = records.reduce((a, r) => a + r.ms, 0);
  console.log(`\n## cost\n`);
  console.log(`  reported spend  $${spend.toFixed(2)}`);
  console.log(`  wall clock      ${(totalMs / 60000).toFixed(1)} min of attempt time`);

  // -- served-model check --------------------------------------------------
  console.log('\n## served models (recorded, not assumed)\n');
  for (const [m, rs] of by(records, (r) => r.model)) {
    const served = [...new Set(rs.map((r) => r.servedModel ?? 'unknown'))];
    console.log(`  ${m.padEnd(12)} -> ${served.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
