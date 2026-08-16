/**
 * Execute an answer against the live eval database and classify what happened.
 *
 * The failure CLASS is the diagnostic the spec cares about most: it is what
 * tells us what a skill would have to contain. Turbine's typed error codes make
 * most of it mechanical (E003 unknown column, E005 unknown relation), so the
 * classification is read off the error rather than guessed from a message.
 */
import { TurbineClient, type SchemaMetadata, TurbineError } from 'turbine-orm';
import { assertEvalDatabase, EVAL_DATABASE_URL } from './config.js';
import type { Answer } from './protocol.js';

export type FailureClass =
  /** Output held no answer we could read as {table, method, args}. */
  | 'no-parse'
  /**
   * The model never produced a final answer: it kept calling tools until its
   * budget ran out. This is a FAILURE, not an unscored attempt. The unscored
   * bucket is for harness faults (a crashed CLI, a transport error), and
   * putting a model's own failure to converge in there would quietly shrink
   * the denominator of exactly the arm whose value we are trying to measure.
   */
  | 'no-answer'
  /** Named a table that does not exist. */
  | 'unknown-table'
  /** E003: unknown column, bad operator, bad projection shape. */
  | 'E003-validation'
  /** E005: unknown relation name in `with`. */
  | 'E005-relation'
  /** E007: relation nesting blew the depth cap. */
  | 'E007-depth'
  /** Any other typed Turbine error. */
  | 'turbine-other'
  /** The driver threw: malformed SQL, type mismatch, and so on. */
  | 'driver-error'
  /** Ran cleanly and returned the wrong rows. */
  | 'wrong-rows'
  /** Ran cleanly and returned the right rows. */
  | 'pass';

export interface ExecOutcome {
  ok: boolean;
  rows?: unknown;
  failure?: FailureClass;
  errorCode?: string;
  errorName?: string;
  message?: string;
}

let client: TurbineClient | null = null;

export function evalClient(schema: SchemaMetadata): TurbineClient {
  if (!client) {
    assertEvalDatabase(EVAL_DATABASE_URL);
    client = new TurbineClient({ connectionString: EVAL_DATABASE_URL, poolSize: 4 }, schema);
  }
  return client;
}

export async function closeClient(): Promise<void> {
  if (client) {
    await client.disconnect();
    client = null;
  }
}

export async function executeAnswer(schema: SchemaMetadata, answer: Answer): Promise<ExecOutcome> {
  if (!Object.hasOwn(schema.tables, answer.table)) {
    return {
      ok: false,
      failure: 'unknown-table',
      message: `table "${answer.table}" is not in the schema`,
    };
  }

  const db = evalClient(schema);
  const qi = db.table(answer.table) as unknown as Record<string, (args?: unknown) => Promise<unknown>>;
  const fn = qi[answer.method];
  if (typeof fn !== 'function') {
    return { ok: false, failure: 'E003-validation', message: `method ${answer.method} unavailable` };
  }

  try {
    const rows = await fn.call(qi, answer.args);
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, ...classify(err) };
  }
}

function classify(err: unknown): Omit<ExecOutcome, 'ok' | 'rows'> {
  if (err instanceof TurbineError) {
    const code = err.code;
    const base = { errorCode: code, errorName: err.constructor.name, message: err.message };
    switch (code) {
      case 'TURBINE_E003':
        return { failure: 'E003-validation', ...base };
      case 'TURBINE_E005':
        return { failure: 'E005-relation', ...base };
      case 'TURBINE_E007':
        return { failure: 'E007-depth', ...base };
      default:
        return { failure: 'turbine-other', ...base };
    }
  }
  const e = err as { message?: string; code?: string; name?: string };
  return {
    failure: 'driver-error',
    errorCode: e?.code,
    errorName: e?.name,
    message: e?.message ?? String(err),
  };
}
