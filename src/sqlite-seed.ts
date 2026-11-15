/** Explicit SQLite seed callbacks, independent of the PostgreSQL seed runner. */
import type { DatabaseSync } from 'node:sqlite';
import type { TransactionClient } from './client.js';
import { ValidationError } from './errors.js';
import type { SchemaMetadata } from './schema.js';
import { type TurbineSqliteOptions, turbineSqlite } from './sqlite.js';

/** Await all database work through this transaction-scoped client. */
export type SqliteSeedFunction = (tx: TransactionClient) => Promise<void> | void;

/** Declare a seed callback. Importing or directly executing its module does not run it. */
export function defineSqliteSeed(fn: SqliteSeedFunction): SqliteSeedFunction {
  if (typeof fn !== 'function') throw new ValidationError('A SQLite seed must be a callable callback.');
  return fn;
}

/**
 * Run a callback in one owned transaction, committing on success and rolling back
 * on failure. A filename is opened and closed here; a supplied DatabaseSync stays
 * owned by its caller, including after failure. The callback cannot disconnect
 * the client. Module imports, separate connections and other user side effects
 * are outside this transaction. This executes trusted code, not a sandbox.
 */
export async function runSqliteSeed(
  target: string | DatabaseSync,
  schema: SchemaMetadata,
  fn: SqliteSeedFunction,
  options: TurbineSqliteOptions = {},
): Promise<void> {
  defineSqliteSeed(fn);
  const db = turbineSqlite(target, schema, options);
  try {
    await db.$transaction(async (tx) => {
      await fn(tx);
    });
  } finally {
    await db.disconnect();
  }
}
