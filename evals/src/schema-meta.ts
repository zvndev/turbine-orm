/**
 * One introspection, shared by everything.
 *
 * The harness executes model answers through the SAME SchemaMetadata that
 * `turbine mcp` derives from the same live database, so the relation names a
 * model reads out of `relation_graph` in arm C are exactly the names that work
 * when its answer is executed. If these two diverged, arm C would be scored
 * against a different schema than it was shown.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { introspect, type SchemaMetadata } from 'turbine-orm';
import { assertEvalDatabase, EVAL_DATABASE_URL, EVALS_DIR } from './config.js';

let cached: SchemaMetadata | null = null;

export async function evalSchema(): Promise<SchemaMetadata> {
  if (cached) return cached;
  assertEvalDatabase(EVAL_DATABASE_URL);
  cached = await introspect({ connectionString: EVAL_DATABASE_URL, schema: 'public' });
  return cached;
}

/**
 * The DDL text handed to the model in every arm. Read from schema.sql so the
 * prompt cannot drift from the database, with the design-notes header stripped:
 * that block names which query shapes the tasks cover and which naming traps
 * were avoided, both of which are hints no real user would ever have.
 */
export function ddlText(): string {
  const raw = readFileSync(resolve(EVALS_DIR, 'schema.sql'), 'utf8');
  const start = raw.indexOf('DROP TABLE');
  return raw
    .slice(start === -1 ? 0 : start)
    .replace(/^DROP TABLE[^\n]*\n/gm, '')
    .trim();
}
