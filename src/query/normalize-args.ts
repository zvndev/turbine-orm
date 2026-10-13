/**
 * `undefined` means absent, decided ONCE at the args seam.
 *
 * Every public operation (and its `build*` twin) runs its caller args through
 * {@link pruneUndefinedArgs} before anything else reads them: the empty-`where`
 * guards, the SQL-cache fingerprint, the SQL build and the param collect. A key
 * whose value is `undefined` is removed, and an object that BECOMES empty
 * because every key in it was `undefined` is removed too, recursively, so
 * `{ user: { email: undefined } }` is exactly `{}`.
 *
 * Why one pass up front rather than a rule in each walker: the fingerprint, the
 * build and the collect each decided for themselves what an `undefined` operand
 * meant, and they disagreed. A fingerprint that counted `{ gte: undefined }` as
 * a `gte` and a builder that skipped it let a cached `<=` template serve a `>=`
 * call. A relation filter whose every value was `undefined` compiled to a bare
 * correlation `EXISTS`, which is non-empty, so the mutation guard let it through
 * as a predicate. After this pass none of those consumers ever sees an
 * `undefined` in a pruned position, so they cannot disagree about it.
 *
 * ## Positions pruned
 *
 * `where` (top level, `AND` / `OR` / `NOT`, relation filters `some` / `every` /
 * `none` / `is` / `isNot` and bare to-one relation objects, column operator
 * objects including a nested `not`), `having`, `cursor`, `orderBy` entries, and
 * every `with` relation's `where` / `orderBy` at any depth. Nothing else: `data`,
 * `create` and `update` keep their own "an undefined column is skipped" rule and
 * are never touched, because a json column may legitimately receive `{}`.
 *
 * ## What is NOT pruned
 *
 * An object that was ALREADY empty as written (`{}`, `{ user: {} }`,
 * `{ OR: [] }`) is left exactly as written, so the existing rules for those
 * shapes keep applying. Operand VALUES are never walked: `in: [...]`, an
 * `equals` JSON document, a vector, a path.
 *
 * A column operator object whose remaining keys are only modifiers (`mode`,
 * `path`, `config`) after stripping is removed as well: `{ contains: q, mode:
 * 'insensitive' }` with `q` undefined is an absent filter, not a modifier with
 * nothing to modify.
 *
 * ## Shape
 *
 * Returns the input BY REFERENCE when nothing was `undefined`, so the common
 * path allocates nothing. A top-level `where` / `having` that is emptied becomes
 * `{}` (every consumer reads that as "no predicate"); an emptied top-level
 * `cursor` or `orderBy` is removed.
 *
 * The PowDB engine runs the same function from `PowqlInterface.normalizeArgs`,
 * so the two engines cannot disagree about what `undefined` means.
 *
 * @module
 */

import { ValidationError } from '../errors.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { resolveColumnName, resolveRelation } from './utils.js';
import { MAX_WHERE_DEPTH } from './where-compile.js';

/** Sentinel for "remove this key / element". Never escapes this module. */
const REMOVE: unique symbol = Symbol('turbine.prune.remove');
type Pruned<V> = V | typeof REMOVE;

/** Relation filter keys whose value is a where clause on the relation's target. */
const RELATION_FILTER_KEYS = new Set(['some', 'every', 'none', 'is', 'isNot']);

/** Keys that qualify an operator rather than state one. */
const MODIFIER_KEYS = new Set(['mode', 'path', 'config']);

/**
 * Past this depth the pass stops descending and returns the node as written.
 * The where walkers refuse anything deeper than {@link MAX_WHERE_DEPTH} with a
 * typed error, so stopping here only hands that refusal the original shape;
 * it never lets an unbounded walk through.
 */
const PRUNE_DEPTH_LIMIT = MAX_WHERE_DEPTH + 2;

/** A plain object literal: not an array, Date, Buffer, typed array or class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasNoKeys(obj: Record<string, unknown>): boolean {
  for (const _ in obj) return false;
  return true;
}

/**
 * Copy-on-write key replacement. Spread rather than a fresh literal so any
 * symbol-keyed brand on the object survives the copy.
 */
function withKey(
  current: Record<string, unknown> | undefined,
  original: Record<string, unknown>,
  key: string,
  next: unknown,
): Record<string, unknown> {
  const out = current ?? { ...original };
  if (next === REMOVE) delete out[key];
  else out[key] = next;
  return out;
}

function isJsonColumn(meta: TableMetadata | undefined, column: string | undefined): boolean {
  if (!meta || !column) return false;
  const type = (meta.pgTypes?.[column] ?? '').toLowerCase();
  return type === 'json' || type === 'jsonb';
}

// ---------------------------------------------------------------------------
// where
// ---------------------------------------------------------------------------

/**
 * Prune one where object scoped to `meta`'s table. Returns the input when
 * nothing changed. The result may be `{}`; the CALLER decides whether an
 * emptied object is removed (nested positions) or kept (the top level).
 */
function pruneWhere(
  schema: SchemaMetadata,
  meta: TableMetadata | undefined,
  where: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  if (depth > PRUNE_DEPTH_LIMIT) return where;
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(where)) {
    const value = where[key];
    let next: unknown = value;
    if (value === undefined) {
      next = REMOVE;
    } else if (key === 'AND' || key === 'OR' || key === 'NOT') {
      next = pruneCombinator(schema, meta, value, depth + 1);
    } else if (isPlainObject(value)) {
      next = pruneField(schema, meta, key, value, depth + 1);
    }
    if (next !== value) out = withKey(out, where, key, next);
  }
  return out ?? where;
}

/** `AND` / `OR` / `NOT`: an object, or an array of objects. */
function pruneCombinator(
  schema: SchemaMetadata,
  meta: TableMetadata | undefined,
  value: unknown,
  depth: number,
): Pruned<unknown> {
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const element = value[i];
      if (!isPlainObject(element)) {
        out?.push(element);
        continue;
      }
      const next = pruneWhere(schema, meta, element, depth);
      const emptied = next !== element && hasNoKeys(next);
      if (next !== element && !out) out = value.slice(0, i);
      if (out && !emptied) out.push(next);
    }
    if (!out) return value;
    // Every element was emptied: the combinator itself said nothing.
    return out.length === 0 && value.length > 0 ? REMOVE : out;
  }
  if (isPlainObject(value)) {
    const next = pruneWhere(schema, meta, value, depth);
    return next !== value && hasNoKeys(next) ? REMOVE : next;
  }
  return value;
}

/** One where key whose value is a plain object: a relation filter or a column filter. */
function pruneField(
  schema: SchemaMetadata,
  meta: TableMetadata | undefined,
  key: string,
  value: Record<string, unknown>,
  depth: number,
): Pruned<Record<string, unknown>> {
  // Relation first, matching the where walker's branch order.
  const relation = meta ? resolveRelation(meta.relations, key) : undefined;
  if (relation) return pruneRelationFilter(schema, relation.def, value, depth);
  const column = meta ? resolveColumnName(meta, key) : undefined;
  // An unknown key is left for the builder, which names it in its error.
  if (meta && column === undefined) return value;
  return pruneOperatorObject(value, !isJsonColumn(meta, column));
}

function pruneRelationFilter(
  schema: SchemaMetadata,
  def: RelationDef,
  value: Record<string, unknown>,
  depth: number,
): Pruned<Record<string, unknown>> {
  const target = schema.tables[def.to];
  let hasCardinalityKey = false;
  for (const k of Object.keys(value)) {
    if (RELATION_FILTER_KEYS.has(k)) {
      hasCardinalityKey = true;
      break;
    }
  }
  if (!hasCardinalityKey) {
    // A bare object on a to-one relation is an implicit `is`.
    const next = pruneWhere(schema, target, value, depth);
    return next !== value && hasNoKeys(next) ? REMOVE : next;
  }
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(value)) {
    const v = value[k];
    let next: unknown = v;
    if (v === undefined) {
      next = REMOVE;
    } else if (RELATION_FILTER_KEYS.has(k) && isPlainObject(v)) {
      const pruned = pruneWhere(schema, target, v, depth);
      next = pruned !== v && hasNoKeys(pruned) ? REMOVE : pruned;
    }
    if (next !== v) out = withKey(out, value, k, next);
  }
  if (!out) return value;
  return hasNoKeys(out) ? REMOVE : out;
}

/**
 * A column's operator / JSON / array / text-search / vector filter object. Only
 * its own keys are stripped; operands are values and are never walked, except
 * a nested operator object under `not` (on a non-JSON column) and a vector
 * filter's `distance` block, whose keys are operators too.
 */
function pruneOperatorObject(value: Record<string, unknown>, walkNot: boolean): Pruned<Record<string, unknown>> {
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(value)) {
    const v = value[k];
    let next: unknown = v;
    if (v === undefined) {
      next = REMOVE;
    } else if ((k === 'not' && walkNot) || k === 'distance') {
      if (isPlainObject(v)) next = pruneOperatorObject(v, walkNot);
    }
    if (next !== v) out = withKey(out, value, k, next);
  }
  if (!out) return value;
  for (const k of Object.keys(out)) {
    if (!MODIFIER_KEYS.has(k)) return out;
  }
  // Nothing but modifiers (or nothing at all) survived.
  return REMOVE;
}

// ---------------------------------------------------------------------------
// having, orderBy, cursor, with
// ---------------------------------------------------------------------------

/**
 * Structural prune for positions whose values carry no JSON operands (`having`
 * aggregate filters, orderBy entries): strip `undefined` at every plain-object
 * level, drop emptied objects and emptied plain-object array elements. Arrays of
 * scalars (a vector, a JSON path) are values and are left alone.
 */
function pruneStructural(value: unknown, depth: number): Pruned<unknown> {
  if (depth > PRUNE_DEPTH_LIMIT) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const element = value[i];
      const next = isPlainObject(element) ? pruneStructural(element, depth + 1) : element;
      if (next !== element && !out) out = value.slice(0, i);
      if (out && next !== REMOVE) out.push(next);
    }
    if (!out) return value;
    return out.length === 0 && value.length > 0 ? REMOVE : out;
  }
  if (!isPlainObject(value)) return value;
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(value)) {
    const v = value[k];
    const next = v === undefined ? REMOVE : pruneStructural(v, depth + 1);
    if (next !== v) out = withKey(out, value, k, next);
  }
  if (!out) return value;
  return hasNoKeys(out) ? REMOVE : out;
}

/** A cursor's values are scalars: only its own keys are stripped. */
function pruneCursor(cursor: Record<string, unknown>): Pruned<Record<string, unknown>> {
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(cursor)) {
    if (cursor[k] === undefined) out = withKey(out, cursor, k, REMOVE);
  }
  if (!out) return cursor;
  return hasNoKeys(out) ? REMOVE : out;
}

function pruneWith(
  schema: SchemaMetadata,
  meta: TableMetadata | undefined,
  withClause: Record<string, unknown>,
  depth: number,
): Pruned<Record<string, unknown>> {
  if (depth > PRUNE_DEPTH_LIMIT) return withClause;
  let out: Record<string, unknown> | undefined;
  for (const key of Object.keys(withClause)) {
    const spec = withClause[key];
    let next: unknown = spec;
    if (spec === undefined) {
      next = REMOVE;
    } else if (key !== '_count' && isPlainObject(spec)) {
      const relation = meta ? resolveRelation(meta.relations, key) : undefined;
      next = pruneWithOptions(schema, relation ? schema.tables[relation.def.to] : undefined, spec, depth + 1);
    }
    if (next !== spec) out = withKey(out, withClause, key, next);
  }
  if (!out) return withClause;
  return hasNoKeys(out) ? REMOVE : out;
}

function pruneWithOptions(
  schema: SchemaMetadata,
  target: TableMetadata | undefined,
  spec: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(spec)) {
    const v = spec[k];
    let next: unknown = v;
    if (v === undefined) {
      next = REMOVE;
    } else if (k === 'where' && isPlainObject(v)) {
      const pruned = pruneWhere(schema, target, v, depth);
      next = pruned !== v && hasNoKeys(pruned) ? REMOVE : pruned;
    } else if (k === 'orderBy') {
      next = pruneStructural(v, depth);
    } else if (k === 'with' && isPlainObject(v)) {
      next = pruneWith(schema, target, v, depth);
    }
    if (next !== v) out = withKey(out, spec, k, next);
  }
  // An emptied relation spec stays an (empty) options object: `{ posts: {} }`
  // still loads the relation, which is what `{ posts: { where: undefined } }`
  // asked for.
  return out ?? spec;
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Remove every `undefined` from the pruned positions of one operation's args
 * (see the module comment). Returns `args` by reference when nothing changed.
 *
 * `table` is the operation's table; relation filters and `with` levels are
 * resolved against `schema` so each sub-where is pruned against its own target.
 */
export function pruneUndefinedArgs<A>(schema: SchemaMetadata, table: string, args: A): A {
  if (!isPlainObject(args)) return args;
  const meta = schema.tables[table];
  const src = args as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;

  const where = src.where;
  if (isPlainObject(where)) {
    const next = pruneWhere(schema, meta, where, 0);
    if (next !== where) out = withKey(out, src, 'where', next);
  }
  const having = src.having;
  if (isPlainObject(having)) {
    const next = pruneStructural(having, 0);
    if (next !== having) out = withKey(out, src, 'having', next === REMOVE ? {} : next);
  }
  const cursor = src.cursor;
  if (isPlainObject(cursor)) {
    const next = pruneCursor(cursor);
    if (next !== cursor) out = withKey(out, src, 'cursor', next);
  }
  const orderBy = src.orderBy;
  if (orderBy !== undefined && (isPlainObject(orderBy) || Array.isArray(orderBy))) {
    const next = pruneStructural(orderBy, 0);
    if (next !== orderBy) out = withKey(out, src, 'orderBy', next);
  }
  const withClause = src.with;
  if (isPlainObject(withClause)) {
    const next = pruneWith(schema, meta, withClause, 0);
    if (next !== withClause) out = withKey(out, src, 'with', next);
  }
  return (out ?? args) as A;
}

/**
 * Whether pruning turned a `where` that HAD keys into one with none: every key
 * the caller wrote was `undefined`. A `where: {}` written as `{}` is not
 * emptied; it was empty already.
 */
export function whereEmptiedByPruning(original: unknown, pruned: unknown): boolean {
  if (original === pruned) return false;
  const before = isPlainObject(original) ? original.where : undefined;
  const after = isPlainObject(pruned) ? pruned.where : undefined;
  if (!isPlainObject(before) || hasNoKeys(before)) return false;
  return before !== after && (!isPlainObject(after) || hasNoKeys(after));
}

/**
 * Refuse a single-row read whose `where` was emptied by pruning. `findFirst`
 * with every filter value `undefined` would otherwise return an arbitrary row,
 * which on a lookup by a secret (a reset token, an invite code) is another
 * user's row. `findMany` and `count` keep "undefined means absent".
 */
export function assertWhereNotEmptiedByPruning(
  table: string,
  operation: string,
  original: unknown,
  pruned: unknown,
): void {
  if (!whereEmptiedByPruning(original, pruned)) return;
  throw new ValidationError(
    `${operation} on "${table}" refused: every key in \`where\` was undefined, so this would return an ` +
      'arbitrary row rather than one matching your filter. Check that the values you filter on are defined. ' +
      'To ask for any row on purpose, omit `where` or pass `where: {}`.',
  );
}

/**
 * Internal findMany flag: the page STARTS AT the cursor row instead of after
 * it. Prisma's cursor is inclusive (its `skip: 1` idiom drops the cursor row),
 * so `turbine-orm/prisma-compat` sets this; core's own `cursor` stays
 * exclusive. A symbol key, so a request body spread into findMany args cannot
 * set it (JSON.parse never produces a symbol) and the unknown-option check,
 * which reads `Object.keys`, never sees it. `Symbol.for` so ESM and CJS copies
 * of the package agree on it.
 *
 * @internal
 */
export const CURSOR_INCLUSIVE: unique symbol = Symbol.for('turbine-orm.cursorInclusive');

/** Whether `args` carries {@link CURSOR_INCLUSIVE}. @internal */
export function isCursorInclusive(args: unknown): boolean {
  return typeof args === 'object' && args !== null && (args as Record<symbol, unknown>)[CURSOR_INCLUSIVE] === true;
}
