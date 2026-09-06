/**
 * turbine-orm, Prisma-style compound-unique `where` selectors.
 *
 * Prisma lets a `findUnique`-family `where` address a multi-column unique
 * constraint through a single synthetic key holding the member columns:
 *
 * ```ts
 * db.members.findUnique({ where: { orgId_userId: { orgId: 1, userId: 7 } } })
 * // ≡ where: { orgId: 1, userId: 7 }  →  WHERE "org_id" = $1 AND "user_id" = $2
 * ```
 *
 * {@link expandCompoundUniqueWhere} rewrites such a selector into the equivalent
 * column conjunction BEFORE the where is fingerprinted / SQL-compiled, so the
 * template cache only ever sees the canonical expanded form (no new cache-key
 * segment, and the expanded shape shares its entry with the spelled-out form).
 *
 * Selector NAMES come from the table metadata, in priority order:
 *   1. a composite primary key (length ≥ 2);
 *   2. each composite `uniqueColumns` entry (introspected composite UNIQUE
 *      constraints);
 *   3. each composite UNIQUE index in `indexes` (`unique && !docPath &&
 *      !partial`, the ONLY composite-unique source a `defineSchema` code-first
 *      client has, since `defineSchema` records single-column uniques in
 *      `uniqueColumns` and composite uniques as declared unique indexes). A
 *      PARTIAL unique index is skipped: it only guarantees uniqueness over its
 *      predicate's rows, not table-wide, so it cannot address a single row.
 *
 * For every column set two lookup names are registered (both mapping to the same
 * ordered FIELD list): the underscore join of the camelCase FIELD names
 * (`orgId_userId`, Prisma's default) and, when different, the underscore join of
 * the raw snake_case column names (`org_id_user_id`).
 *
 * Collision rules (deterministic, documented):
 *   - a synthetic name equal to a real field / column / relation name is never
 *     registered (real members always win);
 *   - two DIFFERENT column sets producing the same name drop that name entirely.
 *
 * The map is pure metadata, so it is computed lazily and memoized per
 * {@link TableMetadata} in a module-level `WeakMap`.
 */

import { ValidationError } from '../errors.js';
import type { TableMetadata } from '../schema.js';
import { isArrayFilter, isJsonFilter, isVectorFilter, isWhereOperator } from './filters.js';
import { isInternalCombinator, ownLookup, resolveColumnName, resolveRelationDef } from './utils.js';

const syntheticKeyCache = new WeakMap<TableMetadata, Map<string, string[]>>();

/**
 * Build (once per table) the map from a synthetic selector name to the ordered
 * list of camelCase FIELD names it expands into. See the module doc for the
 * sources and collision rules.
 */
function syntheticKeyMap(meta: TableMetadata): Map<string, string[]> {
  const cached = syntheticKeyCache.get(meta);
  if (cached) return cached;

  const columnSets: string[][] = [];
  const push = (cols: string[]): void => {
    if (cols.length >= 2) columnSets.push(cols);
  };
  push(meta.primaryKey);
  for (const uc of meta.uniqueColumns) push(uc);
  for (const idx of meta.indexes) {
    // A PARTIAL unique index only guarantees uniqueness over its predicate's
    // rows, not table-wide, so it can never back a compound-unique selector.
    if (idx.unique && !idx.docPath && !idx.partial && idx.columns.length >= 2) push(idx.columns);
  }

  // Names that must never be shadowed by a synthetic selector.
  const reserved = new Set<string>();
  for (const f of Object.keys(meta.columnMap)) reserved.add(f);
  for (const c of meta.allColumns) reserved.add(c);
  for (const r of Object.keys(meta.relations)) reserved.add(r);

  const provisional = new Map<string, { fields: string[]; sig: string }>();
  const dropped = new Set<string>();
  const register = (name: string, fields: string[]): void => {
    if (reserved.has(name) || dropped.has(name)) return;
    const sig = fields.join('\u0000');
    const existing = provisional.get(name);
    if (existing) {
      // Same column set from two sources (e.g. PK also declared unique) is fine;
      // two DIFFERENT sets producing the same name is ambiguous → drop it.
      if (existing.sig !== sig) {
        provisional.delete(name);
        dropped.add(name);
      }
      return;
    }
    provisional.set(name, { fields, sig });
  };

  for (const cols of columnSets) {
    const fields = cols.map((c) => meta.reverseColumnMap[c] ?? c);
    const camelName = fields.join('_');
    const snakeName = cols.join('_');
    register(camelName, fields);
    if (snakeName !== camelName) register(snakeName, fields);
  }

  const map = new Map<string, string[]>();
  for (const [name, v] of provisional) map.set(name, v.fields);
  syntheticKeyCache.set(meta, map);
  return map;
}

/** Whether a where key is a real field / column / relation on the table. */
function isRealKey(meta: TableMetadata, key: string): boolean {
  return (
    ownLookup(meta.columnMap, key) !== undefined ||
    ownLookup(meta.reverseColumnMap, key) !== undefined ||
    meta.allColumns.includes(key) ||
    // Resolved, so a relation named the snake_case way still reads as a real
    // key here and is not mistaken for a compound-unique selector.
    resolveRelationDef(meta.relations, key) !== undefined
  );
}

/**
 * A candidate compound-unique selector value: a plain object that is not a
 * where-operator / JSON / array / vector filter (those are legitimate column
 * filters, never selectors).
 */
function isSelectorValue(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) &&
    !isWhereOperator(value) &&
    !isJsonFilter(value) &&
    !isArrayFilter(value) &&
    !isVectorFilter(value)
  );
}

/**
 * Expand any Prisma compound-unique selector keys in `where` into their column
 * conjunction. Returns the SAME object reference when nothing expands (the
 * byte-identical fast path), else a shallow clone with the selector keys
 * replaced. A selector key whose members do not exactly match the constraint's
 * fields throws a {@link ValidationError} (E003) naming the required members; a
 * non-selector unknown key is left untouched to fall through to the existing
 * unknown-column error at SQL-build time.
 */
export function expandCompoundUniqueWhere(
  meta: TableMetadata,
  where: Record<string, unknown>,
): Record<string, unknown> {
  let map: Map<string, string[]> | undefined;
  let result: Record<string, unknown> | undefined;

  for (const key of Object.keys(where)) {
    const value = where[key];
    // Only a plain-object value on a key that is NOT a real member can be a
    // compound selector.
    if (!isSelectorValue(value) || isRealKey(meta, key)) continue;
    map ??= syntheticKeyMap(meta);
    const fields = map.get(key);
    if (!fields) continue; // unknown key, falls through to the standard E003

    const selector = value;
    const provided = Object.keys(selector).filter((k) => selector[k] !== undefined);
    // Matched by the COLUMN each member name resolves to, not by the literal
    // key. The selector's own NAME is registered under both spellings (see
    // `register` above), so `{ org_id_user_id: { org_id, user_id } }` found the
    // selector and was then refused for its members. Insertion order is
    // `fields` order, keeping the expansion (and the SQL) stable.
    const expected = new Map<string, string>();
    for (const f of fields) expected.set(resolveColumnName(meta, f) ?? f, f);
    /** column → the key the caller actually wrote for it. */
    const providedByColumn = new Map<string, string>();
    let ambiguous = false;
    for (const k of provided) {
      const column = resolveColumnName(meta, k);
      // Unresolvable, or two spellings of one column: fall through to the
      // same refusal an incomplete member set gets.
      if (column === undefined || providedByColumn.has(column)) {
        ambiguous = true;
        break;
      }
      providedByColumn.set(column, k);
    }
    const exact =
      !ambiguous &&
      providedByColumn.size === expected.size &&
      [...providedByColumn.keys()].every((c) => expected.has(c));
    if (!exact) {
      throw new ValidationError(
        `Compound unique selector "${key}" on table "${meta.name}" must supply exactly ` +
          `{ ${fields.join(', ')} }, received { ${provided.join(', ') || '(none)'} }.`,
      );
    }

    result ??= { ...where };
    delete result[key];
    for (const [column, field] of expected) {
      const v = selector[providedByColumn.get(column) as string];
      if (Object.hasOwn(result, field)) {
        // A member field is ALSO given directly in the outer where: wrap the
        // expansion in AND so neither value is clobbered.
        const existingAnd = result.AND;
        const andList = Array.isArray(existingAnd) ? existingAnd : existingAnd !== undefined ? [existingAnd] : [];
        result.AND = [...andList, { [field]: v }];
      } else {
        result[field] = v;
      }
    }
  }

  return result ?? where;
}

/**
 * Every column set that identifies AT MOST ONE ROW of this table.
 *
 * Same sources and the same partial-index rule as {@link syntheticKeyMap}, and
 * in this module for that reason: "what identifies one row" is one question,
 * and answering it in two places is how a compound selector comes to be
 * accepted by the name and refused by its members (0.72.0 fixed exactly that).
 * The difference is only the arity: a synthetic SELECTOR needs two or more
 * columns to have a joined name, while a single-column unique identifies a row
 * perfectly well.
 */
/**
 * Throw unless `where` identifies a single row. The refusal for `findUnique` on
 * EVERY engine, message included.
 *
 * Shared rather than written twice because `PowqlInterface` is a parallel
 * implementation: two copies of a rule this specific (which sources count as
 * unique, whether a null identifies, which keys the message lists) is how two
 * engines come to disagree about whether a query is valid, which is the exact
 * divergence 0.64.0 and 0.72.0 were both spent on.
 *
 * The message lists the keys that WOULD work, because the fix is almost always
 * one of them and a caller cannot be expected to know which columns the
 * database considers unique. A table with no unique key at all gets its own
 * sentence: no `where` satisfies this, and "name a unique key" is advice that
 * person cannot take.
 */
export function assertWhereIdentifiesOneRow(
  meta: TableMetadata,
  table: string,
  where: Record<string, unknown> | undefined,
): void {
  if (whereIdentifiesOneRow(meta, where ?? {})) return;
  const field = (c: string): string => meta.reverseColumnMap[c] ?? c;
  const keys = uniqueKeyNames(meta).map((cols) =>
    cols.length === 1 ? `\`${field(cols[0] as string)}\`` : `\`{ ${cols.map(field).join(', ')} }\``,
  );
  const advice =
    keys.length > 0
      ? `Name a unique key (${keys.join(', ')}), or use \`findFirst\` if you meant "any row matching a filter".`
      : `Table "${table}" declares no primary key and no unique constraint, so no \`where\` can identify one row ` +
        'here. Use `findFirst` (add an `orderBy` to make which row it is deterministic).';
  throw new ValidationError(
    `findUnique on "${table}" refused: the \`where\` clause does not identify a single row, ` +
      `so this would return an arbitrary one of the rows that match. ${advice}`,
  );
}

/**
 * The escape hatch sentence, on `update` / `delete` only.
 *
 * Stated with its cost rather than as an option to reach for: the same flag
 * turns off the empty-`where` guard, so a predicate that is merely NARROW today
 * and becomes EMPTY tomorrow (every value `undefined` on a request that omitted
 * them) writes the whole table instead of being refused.
 */
const UNSAFE_ESCAPE =
  'If this predicate really does identify one row through a constraint this schema does not describe, ' +
  '`allowFullTableScan: UNSAFE` writes it anyway, at the cost of the empty-`where` guard as well: an ' +
  'all-`undefined` `where` then matches every row instead of being refused.';

/**
 * The same refusal for the single-row WRITE methods, `update` and `delete`, and
 * for `upsert`, whose `where` carries the same one-row contract by a different
 * mechanism.
 *
 * `update` / `delete` emit `... WHERE <predicate> RETURNING *` and hand back
 * `rows[0]`, so a `where` that matches many rows mutates EVERY one of them and
 * reports one: the `findUnique` hazard (an arbitrary one of many) with a write
 * attached. `upsert`'s `where` is not a predicate at all, it IS the conflict
 * target, so a non-unique one has no single row to update on conflict and the
 * emitted `ON CONFLICT (...)` names columns no unique index backs. Same rule,
 * same sources of uniqueness, same null policy as
 * {@link assertWhereIdentifiesOneRow}; only the sentence differs, because the
 * consequence and the fix differ per operation. A reader who meant one row
 * names a key; a reader who meant every matching row has `updateMany` /
 * `deleteMany`, which report `{ count }` and never pretend to have touched one
 * row.
 *
 * Called on the CALLER's where, before any global filter is merged in (a
 * tenancy filter narrows, it does not identify). `update` / `delete` skip it
 * under `allowFullTableScan: UNSAFE`, which already says "every row" in so many
 * words, and their message names that hatch: a predicate CAN identify one row
 * through a constraint this schema's metadata does not carry (a stale generated
 * `metadata.ts`, a `defineSchema` that declares fewer uniques than the database
 * has), and a rule with no way past it turns that into an unreachable method.
 * `upsert` has no such option and its message therefore offers none.
 */
export function assertMutationWhereIdentifiesOneRow(
  meta: TableMetadata,
  table: string,
  where: Record<string, unknown> | undefined,
  operation: 'update' | 'delete' | 'upsert',
): void {
  if (whereIdentifiesOneRow(meta, where ?? {})) return;
  const keys = describeUniqueKeys(meta);
  if (operation === 'upsert') {
    const advice =
      keys.length > 0
        ? `Name a unique key (${keys.join(', ')}).`
        : `Table "${table}" declares no primary key and no unique constraint, so no \`where\` can identify one row ` +
          'here and no upsert is possible on it: insert with `create`, or change matching rows with `updateMany`.';
    throw new ValidationError(
      `upsert on "${table}" refused: the \`where\` clause does not identify a single row. An upsert's \`where\` IS ` +
        'its conflict target, so there is no one row to update on conflict, and the `ON CONFLICT` this would emit ' +
        `names columns no unique constraint backs. ${advice}`,
    );
  }
  const many = operation === 'update' ? 'updateMany' : 'deleteMany';
  const advice =
    keys.length > 0
      ? `Name a unique key (${keys.join(', ')}), or use \`${many}\` if you meant "every row matching a filter".`
      : `Table "${table}" declares no primary key and no unique constraint, so no \`where\` can identify one row ` +
        `here. Use \`${many}\`, which reports how many rows it touched.`;
  throw new ValidationError(
    `${operation} on "${table}" refused: the \`where\` clause does not identify a single row, ` +
      `so this would ${operation} every row that matches and return only one of them. ${advice} ${UNSAFE_ESCAPE}`,
  );
}

/** Each unique key of `meta` rendered in field spelling, for an error message. */
function describeUniqueKeys(meta: TableMetadata): string[] {
  const field = (c: string): string => meta.reverseColumnMap[c] ?? c;
  return uniqueKeyNames(meta).map((cols) =>
    cols.length === 1 ? `\`${field(cols[0] as string)}\`` : `\`{ ${cols.map(field).join(', ')} }\``,
  );
}

export function uniqueKeyNames(meta: TableMetadata): string[][] {
  return dedupeColumnSets(uniqueColumnSets(meta));
}

/** Distinct column sets, preserving first-seen order (a PK is often also a declared unique). */
function dedupeColumnSets(sets: string[][]): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const cols of sets) {
    const sig = cols.join('\u0000');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(cols);
  }
  return out;
}

function uniqueColumnSets(meta: TableMetadata): string[][] {
  const sets: string[][] = [];
  if (meta.primaryKey.length > 0) sets.push(meta.primaryKey);
  for (const uc of meta.uniqueColumns) if (uc.length > 0) sets.push(uc);
  for (const idx of meta.indexes) {
    if (idx.unique && !idx.docPath && !idx.partial && idx.columns.length > 0) sets.push(idx.columns);
  }
  return sets;
}

// ---------------------------------------------------------------------------
// Engine-addressed row selectors
// ---------------------------------------------------------------------------

/**
 * Brands a predicate Turbine wrote ENTIRELY itself to address the one row a
 * DECLARED to-one relation points at, so the single-row write rule accepts it.
 *
 * A nested `disconnect: true` / `delete: true` on a `hasOne`, and a nested
 * `update` on a `belongsTo` (whose argument is `{ data }`, with no `where` at
 * all), give the caller no selector to write. The engine builds the predicate
 * from the relation's own correlation key, and the thing that makes it one row
 * is the relation's declared CARDINALITY, which is not in `primaryKey` /
 * `uniqueColumns` / `indexes` and so is invisible to
 * {@link whereIdentifiesOneRow}. Without this the rule refused those writes
 * with "Name a unique key", advice the caller cannot take because they never
 * wrote a `where`, on every schema whose `hasOne` FK is not ALSO declared
 * unique: the `defineSchema` code-first path, the PowDB path, and any FK backed
 * only by a partial unique index.
 *
 * Turbine believes a declared `hasOne` everywhere else (it reads the relation
 * as an object rather than an array, and emits `LIMIT 1` for it), so believing
 * it here is consistency, not a hole. The brand is applied at the one place the
 * predicate is synthesized (`scopeWhereToParent` / the belongsTo correlation in
 * nested-write.ts) and never to anything a caller supplied.
 *
 * A distinct Symbol rather than a second meaning for `markInternalCombinator`:
 * that brand exists to keep a fixed-arity wrapper on a NAMED prepared
 * statement, and folding "identifies one row" into it would mean any future
 * fixed-arity wrapper silently switched this rule off. `Symbol.for` for the
 * ESM/CJS cross-copy identity reason `INTERNAL_COMBINATOR` documents, and a
 * SYMBOL so the `Object.keys` every where walker enumerates never sees it and
 * no emitted SQL can change.
 */
export const INTERNAL_ROW_SELECTOR = Symbol.for('turbine.internalRowSelector');

/** Tag `where` as an engine-written single-row selector, and return it. */
export function markInternalRowSelector<T extends object>(where: T): T {
  Object.defineProperty(where, INTERNAL_ROW_SELECTOR, { value: true, enumerable: false, configurable: true });
  return where;
}

/** Did Turbine itself write this predicate to address one declared related row? */
export function isInternalRowSelector(where: unknown): boolean {
  return (
    typeof where === 'object' && where !== null && (where as Record<symbol, unknown>)[INTERNAL_ROW_SELECTOR] === true
  );
}

/**
 * True when `where` pins every column of at least one unique key to a single
 * value, so the row it names is the row it gets.
 *
 * Deliberately reads only the TOP LEVEL of the user's where. A unique key
 * buried inside an `OR` does not identify a row (the other branch matches
 * whatever it matches), and one inside an `AND` array is a shape nobody writes
 * for a lookup by identity. Extra predicates alongside the key are fine: they
 * can only narrow a set that already holds at most one row.
 *
 * A NULL is not an identity. `WHERE email IS NULL` matches every row whose
 * email is null, which a UNIQUE constraint permits any number of, so a null
 * value satisfies no key here even on a unique column.
 *
 * The one combinator it does read through is Turbine's OWN: a nested write
 * scopes a child selector to its parent by merging the parent correlation in,
 * and when the two name the same column the merge is `{ AND: [selector,
 * correlation] }` BRANDED via `markInternalCombinator` (query/utils.ts). That
 * brand is a Symbol no request body can produce, the arity is fixed at two,
 * and each branch only narrows the other, so the wrapper identifies a row
 * exactly when one of its branches does. A caller-written `AND` is not read.
 *
 * The other thing it reads is {@link markInternalRowSelector}: a predicate the
 * ENGINE wrote in full, for which there is no caller `where` this rule could be
 * about. See that function for why the declaration, not the metadata, is the
 * uniqueness source there.
 */
export function whereIdentifiesOneRow(meta: TableMetadata, where: Record<string, unknown>): boolean {
  if (isInternalRowSelector(where)) return true;
  if (isInternalCombinator(where) && Array.isArray(where.AND)) {
    return (where.AND as unknown[]).some(
      (branch) =>
        typeof branch === 'object' && branch !== null && whereIdentifiesOneRow(meta, branch as Record<string, unknown>),
    );
  }
  const pinned = new Set<string>();
  for (const [key, value] of Object.entries(where)) {
    if (!isPinnedToOneValue(value)) continue;
    const column = resolveColumnName(meta, key);
    if (column !== undefined) pinned.add(column);
  }
  if (pinned.size === 0) return false;
  return uniqueColumnSets(meta).some((cols) => cols.every((c) => pinned.has(c)));
}

/** A bare value, or an operator object whose `equals` is a value. */
function isPinnedToOneValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (isWhereOperator(value)) {
    const eq = (value as { equals?: unknown }).equals;
    return eq !== undefined && eq !== null;
  }
  // A JSON / array / vector filter narrows, it does not identify.
  if (isJsonFilter(value) || isArrayFilter(value) || isVectorFilter(value)) return false;
  // Anything else that is a plain object is a relation filter or a sub-where,
  // neither of which pins a column. Dates, Buffers and primitives are values.
  return !isPlainObject(value);
}

function isPlainObject(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
