/**
 * Central knobs. Everything that affects reproducibility lives here and is
 * echoed into the results file, so a reader can re-run the exact same matrix.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export const EVALS_DIR = resolve(HERE, '..');
export const REPO_ROOT = resolve(EVALS_DIR, '..');

/**
 * The eval database. Local PostgreSQL 17.9, direct (never a pooler), owned by
 * this harness alone. The harness refuses to run against any other database
 * name, so a stray DATABASE_URL in the environment cannot point it at a real
 * one. See assertEvalDatabase().
 */
export const EVAL_DB_NAME = 'turbine_eval';
export const EVAL_DATABASE_URL = process.env.TURBINE_EVAL_URL ?? `postgres://localhost:5432/${EVAL_DB_NAME}`;

/** Fixed PRNG seed for the data set. Changing this invalidates every result. */
export const SEED = 20260816;

/** Per-attempt wall-clock budget. There is no `timeout` binary on macOS, so
 *  every runner enforces this itself with a Node timer plus a process kill. */
export const ATTEMPT_TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 240_000);

/** Hard per-attempt spend cap handed to the Claude CLI. */
export const MAX_BUDGET_USD = Number(process.env.EVAL_MAX_BUDGET_USD ?? 1.5);

export function assertEvalDatabase(url: string): void {
  let name: string;
  try {
    name = new URL(url).pathname.replace(/^\//, '');
  } catch {
    throw new Error(`eval database URL is not parseable: ${url}`);
  }
  if (name !== EVAL_DB_NAME) {
    throw new Error(
      `refusing to run against database "${name}". This harness only ever touches "${EVAL_DB_NAME}".`,
    );
  }
  if (/pooler|pgbouncer/i.test(url) || /:6543/.test(url)) {
    throw new Error('refusing to run through a connection pooler.');
  }
}
