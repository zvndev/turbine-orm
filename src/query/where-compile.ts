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
 *     skips `undefined` values, applies the one combinator-shape rule
 *     ({@link combinatorBranches}), dispatches relation filters, and yields a
 *     flat, ordered {@link WhereEvent} stream. All three consumers iterate this
 *     same stream, so their key order, combinator structure and view of
 *     `undefined` can never diverge.
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
import { normalizeKeyColumns } from '../schema.js';
import { isColumnRef } from './column-ref.js';
import {
  describeOperand,
  dropUndefinedKeys,
  findArrayUniqueKey,
  findJsonUniqueKey,
  fingerprintArrayFilterShape,
  fingerprintJsonFilterShape,
  fingerprintOperatorShape,
  isArrayFilter,
  isJsonFilter,
  isPlainRecord,
  isTextSearchFilter,
  isUnmatchedPlainObject,
  isVectorFilter,
  isWhereOperator,
  operandColumnKind,
  RELATION_FILTER_WRAPPER_SET,
  RELATION_FILTER_WRAPPERS,
  sortedKeys,
  VECTOR_DISTANCE_COMPARATORS,
} from './filters.js';
import type { ArrayFilter, JsonFilter, TextSearchFilter, VectorFilter } from './types.js';
import { resolveColumnName, resolveRelation } from './utils.js';

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
  | { kind: 'or'; conditions: readonly WhereRecord[] }
  /**
   * `fixedArity` marks an `AND` written as one object (`AND: { ... }`): its
   * SQL has one branch whatever the caller sends, so it need not give up the
   * prepared-statement name a caller-sized array does.
   */
  | { kind: 'and'; conditions: readonly WhereRecord[]; fixedArity?: true }
  | { kind: 'not'; condition: WhereRecord }
  | { kind: 'relation'; key: string; relDef: RelationDef; filterObj: WhereRecord }
  | { kind: 'scalar'; key: string; value: unknown };

/** True when a normalized relation filter carries at least one cardinality key. */
function isRelationFilterObj(filterObj: WhereRecord): boolean {
  return RELATION_FILTER_WRAPPERS.some((wrapper) => wrapper in filterObj);
}

/**
 * The refusal for a relation filter not made of the relation-filter keys. The
 * SQL is built from those keys alone, so anything else beside them (a typo such
 * as `sum` for `some`, or `iz` for `is`) would be dropped and the filter would
 * match more rows than written; inside a global filter that is a tenancy
 * condition silently not applied. Same rule and wording as the PowDB engine.
 */
function relationFilterShapeError(table: string, key: string, rel: RelationDef, detail: string): ValidationError {
  return new ValidationError(
    `Invalid relation filter "${key}" on "${table}": ${detail}. ` +
      (rel.type === 'belongsTo' || rel.type === 'hasOne'
        ? 'A to-one relation takes `{ is: {...} }`, `{ isNot: {...} }`, a bare where object, or `is: null`.'
        : 'A to-many relation takes `{ some: {...} }`, `{ none: {...} }` or `{ every: {...} }`.'),
  );
}

function unrecognizedKeys(keys: string[]): string {
  return `unrecognized key ${keys.map((k) => `"${k}"`).join(', ')}`;
}

/** Throws unless every key of a relation filter is a relation-filter key. */
function assertRelationFilterKeys(table: string, key: string, rel: RelationDef, filterObj: WhereRecord): void {
  for (const k in filterObj) {
    if (RELATION_FILTER_WRAPPER_SET.has(k)) continue;
    const unknown = Object.keys(filterObj).filter((name) => !RELATION_FILTER_WRAPPER_SET.has(name));
    throw relationFilterShapeError(table, key, rel, unrecognizedKeys(unknown));
  }
}

/**
 * Why a relation-filter key's value cannot be read, or `null` when it can.
 * `some` / `none` / `every` take a where object; `is` / `isNot` take a where
 * object or `null`. Any other value (`null` on a quantifier, a scalar, an
 * array) used to compile to no condition at all, so a filter, or a tenant
 * global filter, built from a missing value matched every row. Shared with the
 * PowDB engine so both refuse the same values in the same words.
 */
export function relationFilterValueProblem(wrapper: string, value: unknown): string | null {
  if (value === undefined || isPlainRecord(value)) return null;
  const toOne = wrapper === 'is' || wrapper === 'isNot';
  if (toOne && value === null) return null;
  return (
    `\`${wrapper}\` takes a where object${toOne ? ' or null' : ''}, got ${describeOperand(value)}` +
    (value === null ? '; `some: {}` matches rows with a related row, `none: {}` rows with none' : '')
  );
}

/** Throws unless every relation-filter key holds a value the compiler reads (see {@link relationFilterValueProblem}). */
function assertRelationFilterValues(table: string, key: string, rel: RelationDef, filterObj: WhereRecord): void {
  for (const wrapper of RELATION_FILTER_WRAPPERS) {
    const problem = relationFilterValueProblem(wrapper, filterObj[wrapper]);
    if (problem !== null) throw relationFilterShapeError(table, key, rel, problem);
  }
}

/**
 * Why a relation filter reads a to-one key on a to-many relation, or `null`
 * when it does not. `posts: { is: {...} }` compiled to "at least one post
 * matches" and `isNot` to "no post matches", which is not what either word says
 * about a list of rows, and the typed API never offers them there. The
 * quantifiers on a to-one relation are left alone: with at most one related
 * row, `some` / `none` / `every` each have one reading. Shared with the PowDB
 * engine so both refuse the same filters in the same words.
 */
export function relationCardinalityProblem(relDef: RelationDef, filterObj: WhereRecord): string | null {
  if (relDef.type !== 'hasMany' && relDef.type !== 'manyToMany') return null;
  for (const wrapper of ['is', 'isNot'] as const) {
    const value = filterObj[wrapper];
    if (value === undefined) continue;
    const instead =
      value === null
        ? wrapper === 'is'
          ? '`none: {}` for rows with no related row'
          : '`some: {}` for rows with at least one'
        : wrapper === 'is'
          ? '`some` (at least one related row matches) or `every` (all of them do)'
          : '`none` (no related row matches)';
    return `\`${wrapper}\` applies to a to-one relation and this one is to-many; write ${instead}`;
  }
  return null;
}

/**
 * A bare where object on a to-one relation is an implicit `is`
 * (`{ author: { name: 'x' } }` is `{ author: { is: { name: 'x' } } }`). To-many
 * relations still require a quantifier. The one rule, used by the SQL engines'
 * hosts and by PowDB.
 */
export function normalizeToOneRelationFilter(relDef: RelationDef, filterObj: WhereRecord): WhereRecord {
  if (
    (relDef.type === 'belongsTo' || relDef.type === 'hasOne') &&
    !RELATION_FILTER_WRAPPERS.some((wrapper) => wrapper in filterObj)
  ) {
    return { is: filterObj };
  }
  return filterObj;
}

/** The where combinators. */
export type CombinatorKey = 'AND' | 'OR' | 'NOT';

/**
 * THE combinator-shape rule, shared by every walker over a where (or having)
 * clause: the SQL walk below, `having`, and the `globalFilters` check at
 * construction. Returns the branches `value` stands for, or throws
 * {@link ValidationError} (E003).
 *
 *   - `AND` and `NOT` take one where object (a single branch) or an array of
 *     them; `OR` takes an array. This is Prisma's shape.
 *   - Anything else is refused by name: `OR: { ... }`, a string, a number,
 *     `null`, and an array holding one of those. A combinator the compiler
 *     cannot read would compile to nothing, so a mistyped filter, or a
 *     tenant filter built as `{ OR: { orgId } }`, would match every row.
 *   - An `undefined` member is absent and is dropped. When every member was
 *     `undefined` the combinator itself is absent and this returns `null`, the
 *     same reading the args seam gives it.
 *
 * An array written empty is returned empty; what that means is the caller's
 * rule (in a where clause: `OR: []` matches nothing, `AND: []` and `NOT: []`
 * apply no condition). Returns the input array by reference when it holds no
 * `undefined`, so the common path allocates nothing.
 */
export function combinatorBranches(
  key: CombinatorKey,
  value: unknown,
  table: string,
  clause: 'where' | 'having' = 'where',
): readonly WhereRecord[] | null {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    let holes = 0;
    for (let i = 0; i < value.length; i++) {
      const branch = value[i];
      if (branch === undefined) holes++;
      else if (!isPlainRecord(branch)) throw combinatorShapeError(key, table, clause, branch, i);
    }
    if (holes === 0) return value as WhereRecord[];
    if (holes === value.length) return null;
    return (value as unknown[]).filter((branch) => branch !== undefined) as WhereRecord[];
  }
  if (key !== 'OR' && isPlainRecord(value)) return [value];
  throw combinatorShapeError(key, table, clause, value);
}

function combinatorShapeError(
  key: CombinatorKey,
  table: string,
  clause: 'where' | 'having',
  received: unknown,
  index?: number,
): ValidationError {
  const takes = key === 'OR' ? `an array of ${clause} objects` : `a ${clause} object or an array of them`;
  const got =
    index === undefined ? `received ${describeOperand(received)}` : `element ${index} is ${describeOperand(received)}`;
  const hint =
    key === 'OR' && index === undefined && isPlainRecord(received)
      ? ' Wrap the object in an array: `OR: [{ ... }]`.'
      : ' A combinator the query cannot read would otherwise apply no condition at all.';
  return new ValidationError(`\`${key}\` in the ${clause} clause on table "${table}" takes ${takes}; ${got}.${hint}`);
}

/**
 * The event `OR: []` compiles to: a predicate on the table's own key that no
 * row satisfies (`<pk> IN ()`, bound as an empty list), so an `OR` built from
 * an empty list matches nothing, as in Prisma, instead of everything. It
 * reuses the `in` operator every engine already binds as one length-independent
 * placeholder, so the statement keeps one fixed shape and the three consumers
 * stay in step with no special case.
 */
function matchNothingEvent(host: WhereHost): WhereEvent {
  const meta = host.tableMeta;
  for (const column of [...(meta.primaryKey ?? []), ...(meta.allColumns ?? [])]) {
    if (operandColumnKind(host.getColumnPgType(column)) !== 'scalar') continue;
    return { kind: 'scalar', key: meta.reverseColumnMap?.[column] ?? column, value: { in: [] } };
  }
  throw new ValidationError(
    `\`OR: []\` on table "${meta.name}" matches no row, and expressing that needs one plain column of the ` +
      'table, but its schema metadata lists none. Regenerate the client (`npx turbine generate`), or leave ' +
      'the empty `OR` out of the query.',
  );
}

/**
 * The members of an `OR` that are not absent (see {@link isAbsentBranch}),
 * by reference when none is.
 */
function presentOrBranches(host: WhereHost, branches: readonly WhereRecord[]): readonly WhereRecord[] {
  for (let i = 0; i < branches.length; i++) {
    if (isAbsentBranch(host, branches[i]!, 0)) return branches.filter((branch) => !isAbsentBranch(host, branch, 0));
  }
  return branches;
}

/**
 * Whether an `OR` member is absent below the args seam: it names keys, and
 * every one holds `undefined`, a combinator made only of such members, or a
 * relation filter whose keys all hold `undefined`. The seam removes such a
 * member, so the walk drops it too and an internal caller that skips the seam
 * gets the same `OR`. A member written empty (`{}`) is not absent: it applies
 * no condition, which makes its `OR` TRUE.
 */
function isAbsentBranch(host: WhereHost, branch: WhereRecord, depth: number): boolean {
  if (depth > MAX_WHERE_DEPTH) return false;
  let named = false;
  for (const key of Object.keys(branch)) {
    named = true;
    const value = branch[key];
    if (value === undefined) continue;
    if (key === 'OR' || key === 'AND' || key === 'NOT') {
      if (Array.isArray(value)) {
        if (
          value.length > 0 &&
          value.every((m) => m === undefined || (isPlainRecord(m) && isAbsentBranch(host, m, depth + 1)))
        ) {
          continue;
        }
      } else if (isPlainRecord(value) && isAbsentBranch(host, value, depth + 1)) {
        continue;
      }
      return false;
    }
    if (isPlainRecord(value) && resolveRelation(host.tableMeta.relations, key) && holdsOnlyUndefined(value)) continue;
    return false;
  }
  return named;
}

/** True for an object that names keys and holds `undefined` under every one. */
function holdsOnlyUndefined(value: WhereRecord): boolean {
  let named = false;
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) return false;
    named = true;
  }
  return named;
}

/**
 * THE canonical WHERE enumeration. Yields events in sorted-key order,
 * dispatching combinators and relation filters, so every consumer
 * (fingerprint, SQL build, param collect) walks identically.
 *
 * `undefined`: the args seam is the authority and removes it, with every
 * object it emptied, before any of this runs. This walk is the backstop for
 * callers below the seam and reads only `undefined` itself: a key holding it
 * is skipped, a combinator member holding it is dropped, and a relation filter
 * whose wrapper keys all hold it is absent. Values are never looked inside, so
 * a JSON operand is data whatever its shape.
 *
 * Combinators follow {@link combinatorBranches}. `AND` and `NOT` with no
 * branches apply no condition; `OR` with none matches no row
 * ({@link matchNothingEvent}), and an `OR` member made only of `undefined` is
 * dropped ({@link isAbsentBranch}). A `NOT` array negates each branch (`NOT a AND
 * NOT b`), as Prisma does; a `NOT` object negates the object as a whole. A key
 * that names a relation takes only the relation-filter keys (a to-one relation
 * also takes a bare where object, read as `is`), each holding a value the
 * compiler reads ({@link relationFilterValueProblem}), and anything else is
 * refused (E003). Only when the key also names a column, and its object names
 * no relation-filter key, is it that column's filter.
 */
export function walkWhere(host: WhereHost, where: WhereRecord): WhereEvent[] {
  const events: WhereEvent[] = [];
  for (const key of sortedKeys(where)) {
    const value = where[key];
    if (value === undefined) continue;

    if (key === 'OR' || key === 'AND' || key === 'NOT') {
      const branches = combinatorBranches(key, value, host.tableMeta.name);
      if (branches === null) continue;
      if (key === 'OR') {
        if (branches.length === 0) {
          events.push(matchNothingEvent(host));
        } else {
          const present = presentOrBranches(host, branches);
          // Every member held only `undefined`: the `OR` itself is absent.
          if (present.length > 0) events.push({ kind: 'or', conditions: present });
        }
      } else if (branches.length === 0) {
        // `AND: []` and `NOT: []` apply no condition.
      } else if (key === 'AND') {
        events.push(
          Array.isArray(value)
            ? { kind: 'and', conditions: branches }
            : { kind: 'and', conditions: branches, fixedArity: true },
        );
      } else if (!Array.isArray(value)) {
        events.push({ kind: 'not', condition: branches[0]! });
      } else {
        events.push({ kind: 'and', conditions: branches.map((branch) => ({ NOT: branch })) });
      }
      continue;
    }

    // Resolved rather than looked up, so a relation filter accepts the
    // snake_case spelling of the relation exactly as `with` does. This is the
    // ONE branch authority (build, fingerprint and param-collect all consume
    // these events), so resolving here cannot drift between them; the emitted
    // event carries the DECLARED name, which is what reaches the fingerprint.
    const resolvedRel = resolveRelation(host.tableMeta.relations, key);
    if (resolvedRel && isPlainRecord(value)) {
      const present = dropUndefinedKeys(value);
      if (present !== value && Object.keys(present).length === 0) continue;
      const filterObj = host.normalizeRelationFilter(resolvedRel.def, present);
      if (isRelationFilterObj(filterObj)) {
        assertRelationFilterKeys(host.tableMeta.name, key, resolvedRel.def, filterObj);
        assertRelationFilterValues(host.tableMeta.name, key, resolvedRel.def, filterObj);
        const cardinality = relationCardinalityProblem(resolvedRel.def, filterObj);
        if (cardinality !== null)
          throw relationFilterShapeError(host.tableMeta.name, key, resolvedRel.def, cardinality);
        events.push({ kind: 'relation', key: resolvedRel.name, relDef: resolvedRel.def, filterObj });
        continue;
      }
      // A to-many relation's object names none of its quantifiers. It is a
      // column filter only when the key also names a column.
      if (resolveColumnName(host.tableMeta, key) === undefined) {
        const keys = Object.keys(filterObj);
        const detail = keys.length === 0 ? 'the filter object is empty' : unrecognizedKeys(keys);
        throw relationFilterShapeError(host.tableMeta.name, key, resolvedRel.def, detail);
      }
    }

    events.push({ kind: 'scalar', key, value });
  }
  return events;
}

/**
 * What a where clause is for every row, read from the SQL it compiles to:
 *
 *   - `'empty'`: it compiles to no SQL (`{}`, `AND: []`, `NOT: {}`);
 *   - `'true'` / `'false'`: a constant whatever the row holds, NULLs included
 *     (`NOT: { OR: [] }` and `OR: [{}, ...]` are TRUE, `OR: []` is FALSE);
 *   - `'row'`: it depends on the row.
 *
 * The mass-mutation guard reads it: a where that is `'true'` writes every row
 * exactly as an empty one does. It mirrors the compiler rather than ideal
 * logic, branch for branch: a branch that compiles to nothing makes its `OR`
 * TRUE (the compiler writes the constant), and `NOT` of something that
 * compiles to nothing applies no condition, as in the SQL. Only shapes whose
 * SQL is a constant fold; anything else is `'row'`, so folding never refuses a
 * filter that narrows. Constants come from an empty `in` list (FALSE), an
 * empty `notIn` list (TRUE), an `OR` with a branch that applies no condition
 * (TRUE), and an `EXISTS` / `NOT EXISTS` over a sub-where that is itself
 * constant.
 *
 * `hostFor` gives the host of a relation's target table, or `undefined` when
 * the schema has no such table (the compiler emits nothing for it).
 *
 * With `options.notNull` the fold also reads what the schema says about the
 * rows: on a NOT NULL column `{ not: null }`, `contains: ''` (and
 * `startsWith` / `endsWith`), a comparison of the column with itself, and
 * `hasEvery: []` are TRUE for every row, and `null` / `equals: null` FALSE; on
 * a belongsTo relation whose foreign key is NOT NULL and enforced, and whose
 * target has no global filter, `is: {}` (or a bare `{}`) is TRUE. Only the
 * mass-mutation guard asks for it: a where that is TRUE because of a NOT NULL
 * column writes every row just as an empty one does.
 */
export type WhereFold = 'empty' | 'true' | 'false' | 'row';

/** What {@link foldWhere} may read beyond the SQL. */
export interface WhereFoldOptions {
  notNull?: {
    /** Whether the engine enforces declared foreign keys (an orphan row has no related row). */
    foreignKeys: boolean;
    /** Whether `table` has a global filter, which applies inside a relation filter's EXISTS. */
    hasGlobalFilter(table: string): boolean;
  };
}

export function foldWhere(
  host: WhereHost,
  where: WhereRecord,
  hostFor: (table: string) => WhereHost | undefined,
  depth = 0,
  options?: WhereFoldOptions,
): WhereFold {
  assertWhereDepth(depth);
  const parts: WhereFold[] = [];
  for (const event of walkWhere(host, where)) {
    switch (event.kind) {
      case 'or':
        parts.push(foldAny(event.conditions.map((cond) => foldWhere(host, cond, hostFor, depth + 1, options))));
        break;
      case 'and':
        for (const cond of event.conditions) parts.push(foldWhere(host, cond, hostFor, depth + 1, options));
        break;
      case 'not':
        parts.push(negateFold(foldWhere(host, event.condition, hostFor, depth + 1, options)));
        break;
      case 'relation':
        parts.push(foldRelationFilter(host, event.relDef, event.filterObj, hostFor, depth + 1, options));
        break;
      case 'scalar':
        parts.push(foldScalar(host, event.key, event.value, options));
        break;
    }
  }
  return foldAll(parts);
}

/** AND of folded parts; an `'empty'` part contributes no SQL and is skipped. */
function foldAll(parts: readonly WhereFold[]): WhereFold {
  let out: WhereFold = 'empty';
  for (const part of parts) {
    if (part === 'false') return 'false';
    if (part === 'row') out = 'row';
    else if (part === 'true' && out === 'empty') out = 'true';
  }
  return out;
}

/**
 * OR of folded branches. A branch that compiles to nothing applies no
 * condition, so it is TRUE for every row and so is the `OR` (the compiler
 * writes it as a constant TRUE).
 */
function foldAny(parts: readonly WhereFold[]): WhereFold {
  let out: WhereFold = 'false';
  for (const part of parts) {
    if (part === 'true' || part === 'empty') return 'true';
    if (part === 'row') out = 'row';
  }
  return out;
}

function negateFold(fold: WhereFold): WhereFold {
  return fold === 'true' ? 'false' : fold === 'false' ? 'true' : fold;
}

/**
 * A relation filter's branches, as the compiler emits them: `some` / `is` is
 * EXISTS over the sub-where, `none` / `isNot` NOT EXISTS, and `every` NOT
 * EXISTS over its negation (nothing at all when its sub-where is empty).
 */
function foldRelationFilter(
  host: WhereHost,
  relDef: RelationDef,
  filterObj: WhereRecord,
  hostFor: (table: string) => WhereHost | undefined,
  depth: number,
  options: WhereFoldOptions | undefined,
): WhereFold {
  const target = hostFor(relDef.to);
  if (!target) return 'empty';
  const sub = (wrapper: string): WhereFold =>
    foldWhere(target, filterObj[wrapper] as WhereRecord, hostFor, depth, options);
  // Every row has exactly one related row: a NOT NULL foreign key the engine
  // enforces, to a target whose global filter cannot hide that row.
  const notNull = options?.notNull;
  const alwaysRelated =
    notNull?.foreignKeys === true &&
    relDef.type === 'belongsTo' &&
    !notNull.hasGlobalFilter(relDef.to) &&
    normalizeKeyColumns(relDef.foreignKey).every((column) => columnIsNotNull(host.tableMeta, column));
  const parts: WhereFold[] = [];
  for (const wrapper of RELATION_FILTER_WRAPPERS) {
    const value = filterObj[wrapper];
    if (value === undefined) continue;
    const exists = wrapper === 'some' || wrapper === 'is';
    const notExists = wrapper === 'none' || wrapper === 'isNot';
    if (value === null) {
      // `is: null` is NOT EXISTS and `isNot: null` EXISTS.
      parts.push(alwaysRelated ? (wrapper === 'is' ? 'false' : 'true') : 'row');
      continue;
    }
    const inner = sub(wrapper);
    const matchesAll = inner === 'empty' || inner === 'true';
    if (exists) parts.push(inner === 'false' ? 'false' : alwaysRelated && matchesAll ? 'true' : 'row');
    else if (notExists) parts.push(inner === 'false' ? 'true' : alwaysRelated && matchesAll ? 'false' : 'row');
    else parts.push(matchesAll ? inner : 'row');
  }
  return foldAll(parts);
}

/** Whether the schema says `column` of `meta` never holds NULL. Unknown nullability is not NOT NULL. */
function columnIsNotNull(meta: TableMetadata, column: string): boolean {
  for (const col of meta.columns) {
    if (col.name === column) return col.nullable === false;
  }
  return false;
}

/**
 * A column's filter folds as an operator object holding an empty `in` /
 * `notIn` list, and, with {@link WhereFoldOptions.notNull} on a NOT NULL
 * column, as the shapes listed on {@link foldWhere}.
 */
function foldScalar(host: WhereHost, key: string, value: unknown, options?: WhereFoldOptions): WhereFold {
  if (value !== null && !isPlainRecord(value)) return 'row';
  const column = resolveColumnName(host.tableMeta, key);
  if (column === undefined) return 'row';
  const notNull = options?.notNull !== undefined && columnIsNotNull(host.tableMeta, column);
  if (value === null) return notNull ? 'false' : 'row';
  const kind = classifyScalarForSql(host, column, value).kind;
  if (kind === 'array') return notNull ? foldArrayFilter(value as Record<string, unknown>) : 'row';
  if (kind !== 'operator') return 'row';
  const json = operandColumnKind(host.getColumnPgType(column)) === 'json';
  return foldOperator(value as Record<string, unknown>, json, 0, notNull && !json ? { host, column } : undefined);
}

/** On a NOT NULL array column: `hasEvery: []` holds for every row and `hasSome: []` for none. */
function foldArrayFilter(filter: Record<string, unknown>): WhereFold {
  const parts: WhereFold[] = [];
  for (const key of Object.keys(filter)) {
    const value = filter[key];
    if (value === undefined) continue;
    if ((key === 'hasEvery' || key === 'hasSome') && Array.isArray(value) && value.length === 0) {
      parts.push(key === 'hasEvery' ? 'true' : 'false');
    } else {
      parts.push('row');
    }
  }
  return foldAll(parts);
}

/** The NOT NULL column an operator object is on, when the fold may read that. */
interface NotNullColumn {
  host: WhereHost;
  column: string;
}

/**
 * The operator object's clauses, ANDed: `in: []` is FALSE and `notIn: []` TRUE
 * on every engine (an empty `= ANY` / `IN (subquery)` is false even for a NULL
 * column), and a `not` operator object (non-JSON columns) negates its fold.
 * With `notNull` (a NOT NULL, non-JSON column): `not: null` is TRUE and
 * `equals: null` FALSE, an empty `contains` / `startsWith` / `endsWith` is
 * TRUE (`LIKE '%%'`), and a comparison with the column itself is TRUE for
 * `equals` / `gte` / `lte` and FALSE for `not` / `gt` / `lt`.
 */
function foldOperator(op: Record<string, unknown>, json: boolean, depth: number, notNull?: NotNullColumn): WhereFold {
  const parts: WhereFold[] = [];
  for (const key of Object.keys(op)) {
    const value = op[key];
    if (value === undefined || key === 'mode') continue;
    if ((key === 'in' || key === 'notIn') && Array.isArray(value) && value.length === 0) {
      parts.push(key === 'in' ? 'false' : 'true');
    } else if (key === 'not' && !json && depth < MAX_WHERE_DEPTH && isWhereOperator(value)) {
      parts.push(negateFold(foldOperator(value as Record<string, unknown>, json, depth + 1, notNull)));
    } else if (notNull) {
      parts.push(foldNotNullComparison(key, value, notNull));
    } else {
      parts.push('row');
    }
  }
  return foldAll(parts);
}

const SELF_COMPARISON_TRUE: ReadonlySet<string> = new Set(['equals', 'gte', 'lte']);
const SELF_COMPARISON_FALSE: ReadonlySet<string> = new Set(['not', 'gt', 'lt']);

function foldNotNullComparison(key: string, value: unknown, at: NotNullColumn): WhereFold {
  if (value === null) {
    if (key === 'not') return 'true';
    if (key === 'equals') return 'false';
    return 'row';
  }
  if ((key === 'contains' || key === 'startsWith' || key === 'endsWith') && value === '') return 'true';
  if (isColumnRef(value) && resolveColumnName(at.host.tableMeta, value.col) === at.column) {
    if (SELF_COMPARISON_TRUE.has(key)) return 'true';
    if (SELF_COMPARISON_FALSE.has(key)) return 'false';
  }
  return 'row';
}

/**
 * A {@link WhereHost} over plain table metadata, for callers with no SQL
 * builder (PowDB, construction-time checks). Same column-type and to-one rules
 * as the SQL engines' scoped hosts.
 */
export function metadataWhereHost(meta: TableMetadata): WhereHost {
  return {
    tableMeta: meta,
    normalizeRelationFilter: normalizeToOneRelationFilter,
    getColumnPgType: (column) => meta.dialectTypes?.[column] ?? meta.pgTypes?.[column] ?? 'text',
    isJsonColumnType: (colType) => operandColumnKind(colType) === 'json',
  };
}

/**
 * {@link foldWhere} for `table` in `tables`, with plain metadata hosts. Also
 * validates the whole clause shape at every depth (combinators, relation-filter
 * keys and values), so a construction-time check can run it on a static filter.
 */
export function foldWhereFor(
  tables: Readonly<Record<string, TableMetadata>>,
  table: string,
  where: WhereRecord,
  options?: WhereFoldOptions,
): WhereFold {
  const hostFor = (name: string): WhereHost | undefined => {
    const meta = Object.hasOwn(tables, name) ? tables[name] : undefined;
    return meta ? metadataWhereHost(meta) : undefined;
  };
  const host = hostFor(table);
  return host ? foldWhere(host, where, hostFor, 0, options) : 'row';
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
