/**
 * Validate the task set BEFORE any model is asked anything.
 *
 * Three questions per task, and a failure on any of them is fatal rather than a
 * warning. The spec's third gate is that the harness must fail loudly on a
 * scoring error, and the most likely scoring error by far is that my own
 * reference query is wrong. Checking it against raw SQL, written from the DDL
 * and not sharing a line of code with the ORM, is the only check that does not
 * beg the question.
 *
 *   1. Does the reference run at all?
 *   2. Does it agree with independently written SQL (row count, and row order
 *      where the task is ordered)?
 *   3. Is the answer non-degenerate? An empty result, or a result that is the
 *      whole table, can be produced by a query that understood nothing.
 */
import pg from 'pg';
import { assertEvalDatabase, EVAL_DATABASE_URL } from './config.js';
import { canonical } from './canonical.js';
import { closeClient, executeAnswer } from './execute.js';
import { evalSchema } from './schema-meta.js';
import { TASKS, type Task } from './tasks.js';

interface Problem {
  task: string;
  problem: string;
}

const TABLE_TOTALS: Record<string, number> = {};

async function tableTotal(pool: pg.Pool, table: string): Promise<number> {
  if (TABLE_TOTALS[table] === undefined) {
    const r = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${table}"`);
    TABLE_TOTALS[table] = Number(r.rows[0].n);
  }
  return TABLE_TOTALS[table] as number;
}

async function verifyTask(pool: pg.Pool, schema: Awaited<ReturnType<typeof evalSchema>>, task: Task): Promise<Problem[]> {
  const problems: Problem[] = [];
  const out = await executeAnswer(schema, {
    table: task.reference.table,
    method: task.reference.method,
    args: task.reference.args,
  });

  if (!out.ok) {
    problems.push({ task: task.id, problem: `reference does not run: ${out.failure} ${out.message ?? ''}` });
    return problems;
  }

  const rows = out.rows;
  const isList = Array.isArray(rows);
  const n = isList ? (rows as unknown[]).length : rows === null ? 0 : 1;

  // -- non-degenerate ------------------------------------------------------
  if (n === 0) {
    problems.push({ task: task.id, problem: 'reference returns zero rows: a broken query could pass by accident' });
  }
  if (isList && task.reference.method === 'findMany') {
    const total = await tableTotal(pool, task.reference.table);
    const filtered = Boolean((task.reference.args as { where?: unknown }).where);
    if (filtered && n === total) {
      problems.push({ task: task.id, problem: `filter matches every one of the ${total} rows: the filter is not tested` });
    }
  }

  // -- independent SQL agreement -------------------------------------------
  if (task.sanityCount) {
    const r = await pool.query<{ n: string }>(`SELECT (${task.sanityCount}) AS n`);
    const expected = Number(r.rows[0].n);
    if (task.sanityScalarPath) {
      // count / aggregate return a scalar or an object, not a list. Comparing
      // "rows returned" there is 1 vs the answer, which passes any reference.
      let cursor: unknown = rows;
      for (const key of task.sanityScalarPath) {
        cursor = (cursor as Record<string, unknown> | null)?.[key];
      }
      const actual = Number(cursor);
      if (!Number.isFinite(actual)) {
        problems.push({
          task: task.id,
          problem: `sanityScalarPath [${task.sanityScalarPath.join('.')}] did not resolve to a number in ${JSON.stringify(rows)}`,
        });
      } else if (actual !== expected) {
        problems.push({ task: task.id, problem: `reference value ${actual}, independent SQL says ${expected}` });
      }
    } else if (expected !== n) {
      problems.push({ task: task.id, problem: `reference returned ${n} rows, independent SQL says ${expected}` });
    }
  }

  if (task.sanityIds) {
    const r = await pool.query<{ id: number }>(task.sanityIds);
    const sqlIds = r.rows.map((x) => Number(x.id));
    const refIds = (rows as Array<Record<string, unknown>>).map((x) => Number(x.id));
    if (canonical(sqlIds, 'deep') !== canonical(refIds, 'deep')) {
      problems.push({
        task: task.id,
        problem: `reference id order differs from independent SQL (ref ${refIds.slice(0, 6).join(',')}… vs sql ${sqlIds.slice(0, 6).join(',')}…)`,
      });
    }
  }

  return problems;
}

async function main(): Promise<void> {
  assertEvalDatabase(EVAL_DATABASE_URL);
  const pool = new pg.Pool({ connectionString: EVAL_DATABASE_URL, max: 2 });
  const schema = await evalSchema();
  const all: Problem[] = [];

  const seen = new Set<string>();
  for (const t of TASKS) {
    if (seen.has(t.id)) all.push({ task: t.id, problem: 'duplicate task id' });
    seen.add(t.id);
  }

  for (const task of TASKS) {
    const problems = await verifyTask(pool, schema, task);
    const mark = problems.length === 0 ? 'ok  ' : 'FAIL';
    console.log(`${mark} ${task.id} ${task.shape}`);
    for (const p of problems) console.log(`       ${p.problem}`);
    all.push(...problems);
  }

  await pool.end();
  await closeClient();

  console.log(`\n${TASKS.length} tasks, ${all.length} problems`);
  const shapes = new Map<string, number>();
  for (const t of TASKS) shapes.set(t.shape, (shapes.get(t.shape) ?? 0) + 1);
  console.log('shapes: ' + [...shapes].map(([s, c]) => `${s}=${c}`).join(' '));
  console.log('traps:  ' + TASKS.filter((t) => t.trap).map((t) => t.id).join(', '));

  if (all.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
