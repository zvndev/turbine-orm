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
import { isEmptyOrderBy } from './filters.js';
import type { WithClause, WithCount, WithOptions, WithOrderByObject } from './types.js';
import { resolveRelation, resolveRelationDef } from './utils.js';

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

/**
 * Fill in a deterministic `orderBy` for every to-many relation in a `with`
 * clause that did not ask for one, using the target table's primary key.
 *
 * THE single authority for `stableRelationOrder`, on every engine. It was a
 * private method on `QueryInterface` until 0.74.0, which meant PowDB accepted
 * the option and did nothing with it: relation rows came back in whatever order
 * the engine produced, from the option whose entire purpose is that they do
 * not. Restating the rule in `powql.ts` would have been the 0.64 projection
 * resolver again, so it moved here instead, into the same "normalize the whole
 * `with` tree once, before anything reads it" slot as
 * {@link normalizeWithClause}.
 *
 * Returns the input BY REFERENCE when nothing changed, so a query that already
 * orders every relation allocates nothing and its SQL/fingerprint stay
 * byte-identical.
 */
export function applyStableRelationOrderTo(
  schema: SchemaMetadata,
  withClause: WithClause,
  table: string,
  depth = 0,
): WithClause {
  if (depth >= 10) return withClause; // parity with the build depth cap
  const meta = schema.tables[table];
  if (!meta) return withClause;
  let out: WithClause | undefined;
  for (const [relName, spec] of Object.entries(withClause)) {
    if (relName === '_count' || !spec) continue; // `_count` is a count, not a row load
    const rel = resolveRelationDef(meta.relations, relName);
    if (!rel) continue; // unknown relation, let the build path surface E005
    const options: WithOptions = spec === true ? {} : (spec as WithOptions);

    // Recurse first so a nested change alone still clones this level.
    const nestedWith = options.with as WithClause | undefined;
    const newNested = nestedWith ? applyStableRelationOrderTo(schema, nestedWith, rel.to, depth + 1) : undefined;
    const nestedChanged = newNested !== undefined && newNested !== nestedWith;

    const isToMany = rel.type === 'hasMany' || rel.type === 'manyToMany';
    const hasOrder = options.orderBy !== undefined && !isEmptyOrderBy(options.orderBy);
    let synthOrder: WithOrderByObject | WithOrderByObject[] | undefined;
    if (isToMany && !hasOrder) {
      const targetMeta = schema.tables[rel.to];
      const pk = targetMeta?.primaryKey ?? [];
      if (targetMeta && pk.length > 0) {
        const pkFields = pk.map((c) => targetMeta.reverseColumnMap[c] ?? c);
        synthOrder = pkFields.length === 1 ? { [pkFields[0]!]: 'asc' } : pkFields.map((f) => ({ [f]: 'asc' as const }));
      }
    }

    if (!synthOrder && !nestedChanged) continue; // nothing to change, keep the ref
    out ??= { ...withClause };
    const clonedSpec: WithOptions = { ...options };
    if (synthOrder) clonedSpec.orderBy = synthOrder;
    if (nestedChanged) clonedSpec.with = newNested as WithOptions['with'];
    out[relName] = clonedSpec;
  }
  return out ?? withClause;
}
