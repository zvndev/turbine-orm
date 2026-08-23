/**
 * turbine-orm: Shared WHERE-clause walk
 *
 * The SQL template cache requires three code paths over a table-scoped WHERE
 * object to stay in perfect lockstep:
 *   - `fingerprintWhere`   : the value-invariant cache KEY,
 *   - `buildWhereClause`   : the SQL text + `$N` params on a cache MISS,
 *   - `collectWhereParams` : the params ONLY on a cache HIT (no SQL rebuild).
 *
 * If any two of them enumerate the WHERE keys in a different order, or classify
 * a key's value into a different filter shape, the cached SQL's `$N`
 * placeholders bind the wrong values: a silent cross-value (and, with tenant
 * columns, cross-tenant) leak. That drift shipped twice historically (permuted
 * where-key order; an orderBy fingerprint collision).
 *
 * This module removes the drift BY CONSTRUCTION:
 *   - {@link walkWhere} is the ONE enumeration. It sorts keys canonically,
 *     skips `undefined`, dispatches the `OR`/`AND`/`NOT` combinators and
 *     relation filters, and yields a flat, ordered {@link WhereEvent} stream.
 *     All three consumers iterate this same stream, so their key order and
 *     combinator structure can never diverge again.
 *   - {@link classifyScalarForSql} is the ONE scalar-shape decision the SQL
 *     paths use. `buildWhereClause` and `collectWhereParams` BOTH call it with
 *     the same `(rawColumn, value)`, so they always take the same branch and
 *     therefore push params in the same order.
 *   - {@link fingerprintScalarToken} is the fingerprint's own (deliberately
 *     column-blind) scalar token. It over-distinguishes relative to the SQL
 *     classifier (which is always safe), so a fingerprint match still implies
 *     an identical SQL shape.
 *
 * The dev-mode / sampled-production cross-check in `builder.ts` stays as the
 * tripwire: with this shared walk it should never fire, but it remains the
 * last-line guard against a future leaf builder / collect mirror falling out of
 * step.
 */

import { ValidationError } from '../errors.js';
import type { RelationDef, TableMetadata } from '../schema.js';
import {
  findArrayUniqueKey,
  findJsonUniqueKey,
  fingerprintArrayFilterShape,
  fingerprintJsonFilterShape,
  fingerprintOperatorShape,
  isArrayFilter,
  isJsonFilter,
  isTextSearchFilter,
  isUnmatchedPlainObject,
  isVectorFilter,
  isWhereOperator,
  sortedKeys,
  VECTOR_DISTANCE_COMPARATORS,
} from './filters.js';
import type { ArrayFilter, JsonFilter, TextSearchFilter, VectorFilter } from './types.js';
import { resolveRelation } from './utils.js';

/** A table-scoped WHERE object (or an `OR`/`AND`/`NOT` branch of one). */
export type WhereRecord = Record<string, unknown>;

/**
 * Maximum nesting of `OR` / `AND` / `NOT` combinators and relation-filter
 * descents in one WHERE clause (and in one groupBy `HAVING`).
 *
 * Every walker over a where clause, the fingerprint, the SQL build and the
 * cache-hit param collect, and every one of them for the table-SCOPED sub-where
 * too, is directly recursive on these three keys. Nothing bounded that
 * recursion, so a request body could choose the JavaScript stack depth:
 * measured with wire-realistic JSON, a 4,000-deep `NOT` chain built fine and an
 * 8,000-deep one (a 64 KB body, comfortably under `express.json()`'s 100 KB
 * default) threw `RangeError: Maximum call stack size exceeded`. A `RangeError`
 * is not a {@link TurbineError}, so it walks straight past the typed-error
 * surface callers catch on and lands as an unhandled rejection.
 *
 * 32 matches the depth cap Studio's fail-closed PII guard already uses, and
 * sits an order of magnitude above anything a hand-written or
 * query-builder-generated predicate reaches (`with` is capped at 10 for the
 * same class of reason). Exceeding it is a {@link ValidationError} (E003), the
 * same typed refusal every other malformed where shape gets.
 */
export const MAX_WHERE_DEPTH = 32;

/**
 * Refuse a where/having walk that has nested past {@link MAX_WHERE_DEPTH}.
 *
 * Called at the TOP of every recursive walker rather than at the recursion
 * site, so a cap breach is caught on whichever walker runs first (on a cache
 * HIT the SQL build never runs, so a check placed only there would be skipped
 * exactly when the request is being served fastest).
 */
export function assertWhereDepth(depth: number, clause: 'where' | 'having' = 'where'): void {
  if (depth <= MAX_WHERE_DEPTH) return;
  throw new ValidationError(
    `\`${clause}\` clause nests more than ${MAX_WHERE_DEPTH} levels of AND / OR / NOT ` +
      `(or relation filters) deep. That is far past anything a real predicate needs, and an unbounded ` +
      `walk over caller-supplied nesting is a stack-overflow surface, so it is refused. If this is a ` +
      `generated predicate, flatten it: a single \`AND\` / \`OR\` array of N conditions is one level, ` +
      `not N.`,
  );
}

/**
 * Everything the shared walk needs from the owning {@link QueryInterface}. Bound
 * once per instance (see `QueryInterface`'s `whereHost` field) so the walk stays
 * a pure function of the instance's schema state without widening the class's
 * public surface.
 */
export interface WhereHost {
  readonly tableMeta: TableMetadata;
  /** Wrap a bare belongsTo/hasOne relation filter in `{ is: … }`. */
  normalizeRelationFilter(relDef: RelationDef, filterObj: WhereRecord): WhereRecord;
  /** Resolve a column's Postgres type token (defaults to `text`). */
  getColumnPgType(column: string): string;
  /** True for `json` / `jsonb` column types. */
  isJsonColumnType(colType: string): boolean;
}

/**
 * The SQL-relevant classification of a scalar WHERE value, decided column-aware
 * in the SAME linear fall-through order the SQL builder has always used
 * (null → vector → json → array → text-search → operator → equality). Shared by
 * the build and collect paths so their branch choice (and thus param order)
 * is identical by construction. The `*Throw` variants preserve the build path's
 * strict-validation errors for a JSON/array operator on a non-JSON/array column.
 */
export type ScalarSqlClass =
  | { kind: 'null' }
  | { kind: 'vector' }
  | { kind: 'json' }
  | { kind: 'jsonThrow'; jsonKey: string }
  | { kind: 'array'; colType: string }
  | { kind: 'arrayThrow'; arrayKey: string }
  | { kind: 'textsearch' }
  | { kind: 'operator' }
  | { kind: 'equality' };

/**
 * One node of the canonical WHERE walk. `scalar` carries only `key` + `value`;
 * each consumer resolves the column/shape itself (the SQL paths via
 * {@link classifyScalarForSql}, the fingerprint via
 * {@link fingerprintScalarToken}) so the fingerprint stays column-blind exactly
 * as before.
 */
export type WhereEvent =
  | { kind: 'or'; conditions: WhereRecord[] }
  | { kind: 'and'; conditions: WhereRecord[] }
  | { kind: 'not'; condition: WhereRecord }
  | { kind: 'relation'; key: string; relDef: RelationDef; filterObj: WhereRecord }
  | { kind: 'scalar'; key: string; value: unknown };

/** True when a normalized relation filter carries at least one cardinality key. */
function isRelationFilterObj(filterObj: WhereRecord): boolean {
  return (
    'some' in filterObj || 'every' in filterObj || 'none' in filterObj || 'is' in filterObj || 'isNot' in filterObj
  );
}

/**
 * THE canonical WHERE enumeration. Yields events in sorted-key order (skipping
 * `undefined`), dispatching combinators and relation filters, so every consumer
 * (fingerprint, SQL build, param collect) walks identically.
 *
 * Combinator SKIP rules match the historical code exactly: an `OR`/`AND` whose
 * value is a non-array or an empty array is skipped entirely (it contributes
 * neither SQL, params, nor a fingerprint token); `NOT` is always emitted.
 * A key that names a relation but whose value is not a `{ some/every/none/is/
 * isNot }` filter falls through to the scalar path, exactly as before.
 */
export function walkWhere(host: WhereHost, where: WhereRecord): WhereEvent[] {
  const events: WhereEvent[] = [];
  for (const key of sortedKeys(where)) {
    const value = where[key];
    if (value === undefined) continue;

    if (key === 'OR') {
      const arr = value as WhereRecord[];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      events.push({ kind: 'or', conditions: arr });
      continue;
    }
    if (key === 'AND') {
      const arr = value as WhereRecord[];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      events.push({ kind: 'and', conditions: arr });
      continue;
    }
    if (key === 'NOT') {
      events.push({ kind: 'not', condition: value as WhereRecord });
      continue;
    }

    // Resolved rather than looked up, so a relation filter accepts the
    // snake_case spelling of the relation exactly as `with` does. This is the
    // ONE branch authority (build, fingerprint and param-collect all consume
    // these events), so resolving here cannot drift between them; the emitted
    // event carries the DECLARED name, which is what reaches the fingerprint.
    const resolvedRel = resolveRelation(host.tableMeta.relations, key);
    if (resolvedRel && typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const filterObj = host.normalizeRelationFilter(resolvedRel.def, value as WhereRecord);
      if (isRelationFilterObj(filterObj)) {
        events.push({ kind: 'relation', key: resolvedRel.name, relDef: resolvedRel.def, filterObj });
        continue;
      }
    }

    events.push({ kind: 'scalar', key, value });
  }
  return events;
}

/**
 * Column-aware SQL classification of a scalar WHERE value. Reproduces the SQL
 * builder's linear fall-through: a JSON/array-shaped value on a non-JSON/array
 * column falls THROUGH to the next shape (and ultimately equality) unless it
 * carries a shape-unique key, in which case the build path reports a typed
 * error (`*Throw`). Both the build and collect paths call this, so they can
 * never classify the same value differently.
 */
export function classifyScalarForSql(host: WhereHost, rawColumn: string, value: unknown): ScalarSqlClass {
  if (value === null) return { kind: 'null' };

  if (typeof value === 'object' && !Array.isArray(value) && isVectorFilter(value)) {
    return { kind: 'vector' };
  }

  if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value)) {
    const colType = host.getColumnPgType(rawColumn);
    if (host.isJsonColumnType(colType)) return { kind: 'json' };
    const jsonKey = findJsonUniqueKey(value);
    if (jsonKey) return { kind: 'jsonThrow', jsonKey };
    // else: fall through, `equals`/`contains` on a non-JSON column keep their
    // WhereOperator meaning (matches builder.ts: no `continue`).
  }

  if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value)) {
    const colType = host.getColumnPgType(rawColumn);
    if (colType.startsWith('_')) return { kind: 'array', colType };
    const arrayKey = findArrayUniqueKey(value);
    if (arrayKey) return { kind: 'arrayThrow', arrayKey };
    // else: fall through.
  }

  if (typeof value === 'object' && !Array.isArray(value) && isTextSearchFilter(value)) {
    return { kind: 'textsearch' };
  }

  if (isWhereOperator(value)) return { kind: 'operator' };

  return { kind: 'equality' };
}

/**
 * The fingerprint's scalar token: deliberately COLUMN-BLIND and in the
 * historical fingerprint precedence (operator before vector/json/array), so a
 * value that both looks like an operator and a JSON filter (`equals`/`contains`
 * overlap) tokenizes as an operator exactly as it did before. Column-blindness
 * only ever over-distinguishes versus {@link classifyScalarForSql}, which is
 * safe: it can cause an extra cache MISS, never a wrong-value HIT.
 */
export function fingerprintScalarToken(value: unknown): string {
  // null → distinct from any value token.
  if (value === null) return 'null';

  // Operator objects, checked first (column-blind precedence).
  if (isWhereOperator(value)) return fingerprintOperatorShape(value);

  // Vector distance filter: metric (operator) and present comparators change
  // the SQL shape, so both go in the token.
  if (typeof value === 'object' && !Array.isArray(value) && isVectorFilter(value)) {
    const dist = (value as VectorFilter).distance;
    const cmps = Object.keys(VECTOR_DISTANCE_COMPARATORS)
      .filter((c) => (dist as unknown as Record<string, unknown>)[c] !== undefined)
      .sort()
      .join('|');
    return `vec(${dist.metric},${cmps})`;
  }

  // JSON filter: range ops carry a numeric/string annotation (different cast).
  if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value as JsonFilter)) {
    return fingerprintJsonFilterShape(value as JsonFilter);
  }

  // Array filter.
  if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value as ArrayFilter)) {
    return `arr(${fingerprintArrayFilterShape(value as ArrayFilter)})`;
  }

  // Text search filter.
  if (typeof value === 'object' && !Array.isArray(value) && isTextSearchFilter(value as TextSearchFilter)) {
    const cfg = (value as TextSearchFilter).config ?? 'english';
    return `fts(${cfg})`;
  }

  // Plain object literal that matched no filter shape: a token distinct from
  // real equality so a cache entry warmed by genuine equality can't serve it.
  if (isUnmatchedPlainObject(value)) {
    return `obj(${Object.keys(value as object)
      .sort()
      .join(',')})`;
  }

  // Plain equality.
  return 'eq';
}
