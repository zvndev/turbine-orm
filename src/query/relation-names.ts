/**
 * Caller-supplied RELATION names, normalized to their declared spelling once,
 * before anything reads them.
 *
 * ## The rule
 *
 * A relation has one declared name (`ripeningChecks`), while the DDL anyone
 * reads has only the table name (`ripening_checks`). Writing back what the
 * schema shows therefore failed: E005 in `with`, E003 in a relation filter,
 * E005 in `orderBy`, on names the error text was already computing correctly
 * ("Did you mean ...?"). This accepts the snake_case spelling wherever the
 * declared name is accepted, by the same resolve-then-validate rule
 * {@link resolveRelation} states, which is the relation-level twin of
 * `resolveColumnName`. It is not a guess: `snakeToCamel(key)` is accepted ONLY
 * when it names a real declared relation, so a typo is still a typo, and an
 * exact declared name always wins first.
 *
 * ## Why this is ONE pass up front and not a fix at each lookup
 *
 * The `with` tree is walked by SIX independent functions, each of which decides
 * for itself which keys name relations: `withFingerprint`, `collectWithParams`,
 * `buildRelationShapes`, `planFlattenWith`, `buildSelectWithRelations` and the
 * batched loader, plus the positional row parser. Teaching each of them that a
 * key has two spellings would make seven places that must agree about it, and
 * disagreement is not a clean failure: the fingerprint is the SQL-cache key, so
 * a walker that resolved differently from the builder would serve one query's
 * template to another, silently. That is the drift class this repo has paid for
 * repeatedly (the where-clause walkers, the two projection resolvers).
 *
 * Normalizing before any walker runs makes all seven correct with no knowledge
 * of the second spelling, and keeps ONE authority for the rule.
 *
 * ## Shape
 *
 * Returns the SAME object when nothing needed rewriting, which is every query
 * that already spells its relations the declared way, so the common path
 * allocates nothing and is reference-identical to its input.
 *
 * An UNRESOLVABLE key is left exactly as written, deliberately. Reporting it is
 * the builder's job, and it already names the offending key and lists the
 * available relations; rejecting it here would move that error away from its
 * context and change which error type callers see.
 */

import type { SchemaMetadata, TableMetadata } from '../schema.js';
import type { WithClause, WithCount, WithOptions } from './types.js';
import { resolveRelation } from './utils.js';

/** Depth cap mirroring the builder's own, so a cyclic `with` cannot spin here. */
const MAX_DEPTH = 12;

/**
 * `withClause` with every relation key replaced by its declared spelling,
 * recursively, including the relation names inside a `_count`.
 *
 * Returns the input by reference when no key changed.
 */
export function normalizeWithClause(
  schema: SchemaMetadata,
  table: string,
  withClause: WithClause | undefined,
  depth = 0,
): WithClause | undefined {
  if (!withClause || typeof withClause !== 'object' || depth > MAX_DEPTH) return withClause;
  const meta = schema.tables[table];
  if (!meta) return withClause;

  let changed = false;
  const out: Record<string, unknown> = {};

  for (const [key, spec] of Object.entries(withClause)) {
    if (key === '_count') {
      const nextCount = normalizeCount(meta, spec as WithCount);
      if (nextCount !== spec) changed = true;
      out[key] = nextCount;
      continue;
    }
    const resolved = resolveRelation(meta.relations, key);
    // Unknown key: keep it verbatim and let the builder raise E005 by name.
    const name = resolved?.name ?? key;
    if (name !== key) changed = true;

    const nextSpec = resolved ? normalizeSpec(schema, resolved.def.to, spec, depth) : spec;
    if (nextSpec !== spec) changed = true;
    out[name] = nextSpec;
  }

  return changed ? (out as WithClause) : withClause;
}

/** A relation's `with` options, normalizing its nested `with` against the TARGET table. */
function normalizeSpec(schema: SchemaMetadata, target: string, spec: unknown, depth: number): unknown {
  if (spec === true || spec === false || spec === null || typeof spec !== 'object') return spec;
  const opts = spec as WithOptions;
  if (!opts.with) return spec;
  const nested = normalizeWithClause(schema, target, opts.with as WithClause, depth + 1);
  return nested === opts.with ? spec : { ...opts, with: nested };
}

/**
 * `_count` names relations too. `true` means every relation and has nothing to
 * rename; the record form has one key per counted relation.
 */
function normalizeCount(meta: TableMetadata, count: WithCount | undefined): WithCount | undefined {
  if (!count || typeof count !== 'object') return count;
  let changed = false;
  const out: Record<string, true> = {};
  for (const [key, value] of Object.entries(count)) {
    const name = resolveRelation(meta.relations, key)?.name ?? key;
    if (name !== key) changed = true;
    out[name] = value;
  }
  return changed ? out : count;
}

/*
 * NOTE for the next person: there are deliberately no `declaredRelationName` /
 * `namesRelation` wrappers here. The argument positions where a relation key
 * sits INTERLEAVED with column keys (`where`'s some/every/none, `orderBy`'s
 * relation targets, the simple-where fast path) cannot be normalized up front
 * the way `with` can, so they call `resolveRelation` / `resolveRelationDef`
 * from query/utils.ts directly at their branch point. Each of those branches is
 * already a documented single authority; wrapping them here would add a second
 * name for the same rule without removing a caller.
 */
