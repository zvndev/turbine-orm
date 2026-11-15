/** Explicit trusted callbacks for the optional native local libSQL adapter. */
import type { TransactionClient } from './client.js';
import { ValidationError } from './errors.js';
import { withSeedCleanup } from './libsql/seed-cleanup.js';
import { type LibsqlLocalSource, type TurbineLibsqlOptions, turbineLibsql } from './libsql.js';
import type { SchemaMetadata } from './schema.js';

/** The adapter's exact callback handle, including nested savepoint scope. */
export type LibsqlSeedClient = TransactionClient;
export type LibsqlSeedFunction = (tx: LibsqlSeedClient) => Promise<void> | void;

/** Declare trusted seed code without running it. */
export function defineLibsqlSeed(fn: LibsqlSeedFunction): LibsqlSeedFunction {
  if (typeof fn !== 'function') throw new ValidationError('A libSQL seed must be a callable callback.');
  return fn;
}

/**
 * Run one native local callback transaction. Await every query and nested block.
 * Callback failure rolls back its database transaction. Escaped handles close
 * and outstanding work is refused by the adapter's existing transaction lifecycle.
 * Strings open owned clients, which close before settlement. Supplied clients
 * remain caller-owned; do not use them concurrently or inside a native transaction.
 * Imports, other connections and external side effects are outside this boundary.
 * This is trusted SQLite-like local code, not a DML-only sandbox or SQL-file runner.
 */
export async function runLibsqlSeed(
  target: string | LibsqlLocalSource,
  schema: SchemaMetadata,
  fn: LibsqlSeedFunction,
  options: TurbineLibsqlOptions = {},
): Promise<void> {
  defineLibsqlSeed(fn);
  const db = await turbineLibsql(target, schema, options);
  await withSeedCleanup(db.pool, async () => {
    let failed = false;
    let failure: unknown;
    try {
      await db.$transaction(async (tx) => {
        await fn(tx);
      });
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await db.disconnect();
    } catch (error) {
      if (failed) {
        throw new AggregateError([failure, error], 'libSQL seed failed and client cleanup also failed.');
      }
      throw error;
    }
    if (failed) throw failure;
  });
}
