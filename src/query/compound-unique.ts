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
import { ownLookup, resolveColumnName, resolveRelationDef } from './utils.js';

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
        `[turbine] Compound unique selector "${key}" on table "${meta.name}" must supply exactly ` +
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
