/**
 * `undefined` means absent, decided ONCE at the args seam.
 *
 * Every public operation (and its `build*` twin) runs its args through
 * {@link pruneUndefinedArgs} before anything else reads them: the empty-`where`
 * guards, the SQL-cache fingerprint, the SQL build and the param collect. A key
 * whose value is `undefined` is removed, and so is an object (or combinator
 * array) that BECOMES empty because of it, recursively, so
 * `{ user: { email: undefined } }` is exactly `{}`. One pass up front, because
 * consumers that each decide what `undefined` means end up disagreeing: a cache
 * key that counted `{ gte: undefined }` while the builder skipped it served a
 * `<=` template to a `>=` call.
 *
 * Pruned positions: `where` (combinators, relation filters, column operator
 * objects including a nested `not`), `having`, `cursor`, `orderBy`, and every
 * `with` relation's `where` / `orderBy`. Never `data` / `create` / `update`
 * (a json column may legitimately receive `{}`), never an operand value (an
 * `in` list, a JSON document, a vector), and never an object written empty
 * (`{}`, `{ OR: [] }`), which keeps its own meaning. A column operator object
 * left holding only modifiers (`mode`, `path`, `config`) is removed too:
 * `{ contains: q, mode: 'insensitive' }` with `q` undefined is no filter.
 *
 * PowDB runs the same function from `PowqlInterface.normalizeArgs`, so the
 * two engines cannot disagree about what `undefined` means.
 *
 * @module
 */

import { ValidationError } from '../errors.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { isPlainRecord, RELATION_FILTER_WRAPPER_SET } from './filters.js';
import { resolveColumnName, resolveRelation } from './utils.js';
import { MAX_WHERE_DEPTH } from './where-compile.js';

/** Sentinel for "remove this key / element". Never escapes this module. */
const REMOVE: unique symbol = Symbol('turbine.prune.remove');
type Pruned<V> = V | typeof REMOVE;

/** Keys that qualify an operator rather than state one. */
const MODIFIER_KEYS = new Set(['mode', 'path', 'config']);

/**
 * Past this depth the pass stops descending and returns the node as written.
 * The where walkers refuse anything deeper than {@link MAX_WHERE_DEPTH} with a
 * typed error, so stopping here only hands that refusal the original shape;
 * it never lets an unbounded walk through.
 */
const PRUNE_DEPTH_LIMIT = MAX_WHERE_DEPTH + 2;

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
    } else if (isPlainRecord(value)) {
      next = pruneField(schema, meta, key, value, depth + 1);
    }
    if (next !== value) out = withKey(out, where, key, next);
  }
  return out ?? where;
}

/**
 * `AND` / `OR` / `NOT`: an object, or an array of objects. An `undefined`
 * member is removed like an emptied one; any other non-object member is left
 * for the where walk, which refuses it by name (`combinatorBranches`).
 */
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
      let next: unknown = element;
      if (element === undefined) {
        next = REMOVE;
      } else if (isPlainRecord(element)) {
        const pruned = pruneWhere(schema, meta, element, depth);
        next = pruned !== element && hasNoKeys(pruned) ? REMOVE : pruned;
      }
      if (next !== element && !out) out = value.slice(0, i);
      if (out && next !== REMOVE) out.push(next);
    }
    if (!out) return value;
    // Every element was removed: the combinator itself said nothing.
    return out.length === 0 ? REMOVE : out;
  }
  if (isPlainRecord(value)) {
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
    if (RELATION_FILTER_WRAPPER_SET.has(k)) {
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
    } else if (RELATION_FILTER_WRAPPER_SET.has(k) && isPlainRecord(v)) {
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
      if (isPlainRecord(v)) next = pruneOperatorObject(v, walkNot);
    }
    if (next !== v) out = withKey(out, value, k, next);
  }
  if (!out) return value;
  // Nothing but modifiers (or nothing at all) survived.
  return onlyModifiers(out) ? REMOVE : out;
}

// ---------------------------------------------------------------------------
// having, orderBy, cursor, with
// ---------------------------------------------------------------------------

/**
 * Structural prune for positions whose values carry no JSON operands (`having`
 * filters, orderBy entries): strip `undefined` at every plain-object level,
 * drop emptied objects and emptied (or `undefined`) array elements. Arrays of
 * scalars (a vector, a JSON path) are values and are left alone.
 *
 * `having` also drops an object stripped down to modifiers alone, the same
 * rule `where` applies to a column operator object. orderBy does not: a
 * JSON-path ordering is `{ path }` plus an optional direction.
 */
function pruneStructural(value: unknown, depth: number, dropModifierOnly: boolean): Pruned<unknown> {
  if (depth > PRUNE_DEPTH_LIMIT) return value;
  if (Array.isArray(value)) {
    let out: unknown[] | undefined;
    for (let i = 0; i < value.length; i++) {
      const element = value[i];
      const next =
        element === undefined
          ? REMOVE
          : isPlainRecord(element)
            ? pruneStructural(element, depth + 1, dropModifierOnly)
            : element;
      if (next !== element && !out) out = value.slice(0, i);
      if (out && next !== REMOVE) out.push(next);
    }
    if (!out) return value;
    return out.length === 0 ? REMOVE : out;
  }
  if (!isPlainRecord(value)) return value;
  let out: Record<string, unknown> | undefined;
  for (const k of Object.keys(value)) {
    const v = value[k];
    const next = v === undefined ? REMOVE : pruneStructural(v, depth + 1, dropModifierOnly);
    if (next !== v) out = withKey(out, value, k, next);
  }
  if (!out) return value;
  if (hasNoKeys(out) || (dropModifierOnly && onlyModifiers(out))) return REMOVE;
  return out;
}

/** True when every key left is a modifier. */
function onlyModifiers(obj: Record<string, unknown>): boolean {
  for (const k of Object.keys(obj)) {
    if (!MODIFIER_KEYS.has(k)) return false;
  }
  return true;
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
    } else if (key !== '_count' && isPlainRecord(spec)) {
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
    } else if (k === 'where' && isPlainRecord(v)) {
      const pruned = pruneWhere(schema, target, v, depth);
      next = pruned !== v && hasNoKeys(pruned) ? REMOVE : pruned;
    } else if (k === 'orderBy') {
      next = pruneStructural(v, depth, false);
    } else if (k === 'with' && isPlainRecord(v)) {
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
// Pre-scan
// ---------------------------------------------------------------------------

/**
 * Operand keys whose ARRAY value is a list of values (an `in` list, a JSON
 * path, a vector). The prune never edits one, and they can be long, so the
 * pre-scan does not read them. An object under one of these names is still
 * scanned: it is a column called `to` or `path`, not an operand.
 */
const OPERAND_LIST_KEYS: ReadonlySet<string> = new Set(['in', 'notIn', 'has', 'hasSome', 'hasEvery', 'path', 'to']);

/** Past this the pre-scan answers yes and lets the prune, which has its own bound, decide. */
const SCAN_DEPTH_LIMIT = 4 * MAX_WHERE_DEPTH;

/**
 * Whether `value` holds an `undefined` the prune might remove. Read-only and
 * schema-blind, so a call with nothing undefined (nearly every call) costs one
 * pass and no allocation before {@link pruneUndefinedArgs} returns its input.
 * It may answer yes for an `undefined` the prune leaves in place (inside a JSON
 * document); that only costs the prune's own walk.
 */
function holdsUndefined(value: object, depth: number): boolean {
  if (depth > SCAN_DEPTH_LIMIT) return true;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const element: unknown = value[i];
      if (element === undefined) return true;
      if (typeof element === 'object' && element !== null && holdsUndefined(element, depth + 1)) return true;
    }
    return false;
  }
  // A class instance is a bound value, never walked (the isPlainRecord rule).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  const record = value as Record<string, unknown>;
  for (const key in record) {
    const v = record[key];
    if (v === undefined) return true;
    if (typeof v !== 'object' || v === null) continue;
    if (Array.isArray(v) && OPERAND_LIST_KEYS.has(key)) continue;
    if (holdsUndefined(v, depth + 1)) return true;
  }
  return false;
}

/** {@link holdsUndefined} for one top-level argument, which may be absent or a scalar. */
function argHoldsUndefined(value: unknown): boolean {
  return typeof value === 'object' && value !== null && holdsUndefined(value, 0);
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
  if (!isPlainRecord(args)) return args;
  const src = args as Record<string, unknown>;
  if (
    !argHoldsUndefined(src.where) &&
    !argHoldsUndefined(src.having) &&
    !argHoldsUndefined(src.cursor) &&
    !argHoldsUndefined(src.orderBy) &&
    !argHoldsUndefined(src.with)
  ) {
    return args;
  }
  const meta = schema.tables[table];
  let out: Record<string, unknown> | undefined;

  const where = src.where;
  if (isPlainRecord(where)) {
    const next = pruneWhere(schema, meta, where, 0);
    if (next !== where) out = withKey(out, src, 'where', next);
  }
  const having = src.having;
  if (isPlainRecord(having)) {
    const next = pruneStructural(having, 0, true);
    if (next !== having) out = withKey(out, src, 'having', next === REMOVE ? {} : next);
  }
  const cursor = src.cursor;
  if (isPlainRecord(cursor)) {
    const next = pruneCursor(cursor);
    if (next !== cursor) out = withKey(out, src, 'cursor', next);
  }
  const orderBy = src.orderBy;
  if (orderBy !== undefined && (isPlainRecord(orderBy) || Array.isArray(orderBy))) {
    const next = pruneStructural(orderBy, 0, false);
    if (next !== orderBy) out = withKey(out, src, 'orderBy', next);
  }
  const withClause = src.with;
  if (isPlainRecord(withClause)) {
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
  const before = isPlainRecord(original) ? original.where : undefined;
  const after = isPlainRecord(pruned) ? pruned.where : undefined;
  if (!isPlainRecord(before) || hasNoKeys(before)) return false;
  return before !== after && (!isPlainRecord(after) || hasNoKeys(after));
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
 * THE "has a cursor" test: a plain object holding at least one defined value.
 * The page-order completion and the cursor planner both ask it (on PowDB too),
 * so a page cannot be a cursor page to one and not to the other. A `cursor`
 * written in a shape that names no row never reaches it as "no cursor": see
 * {@link assertCursorWritten} and {@link assertCursorNotEmptied}.
 */
export function hasCursor(cursor: unknown): boolean {
  if (!isPlainRecord(cursor)) return false;
  for (const key of Object.keys(cursor)) {
    if (cursor[key] !== undefined) return true;
  }
  return false;
}

/**
 * Refuse a `cursor` that is written but names no row: `null`, a value that is
 * not an object, or `{}`. Read as "no cursor", such a page skipped both the
 * cursor and the page tiebreaker, so a pager written as
 * `cursor: last ? { id: last.id } : {}` cut its first page from a different
 * order than every later page and skipped rows.
 */
export function assertCursorWritten(table: string, operation: string, cursor: unknown): void {
  if (cursor === undefined) return;
  if (!isPlainRecord(cursor)) {
    throw new ValidationError(
      `${operation} on "${table}" refused: \`cursor\` takes an object naming the row to page after ` +
        `(for example \`cursor: { id: lastRow.id }\`), received ${cursor === null ? 'null' : Array.isArray(cursor) ? 'an array' : `a ${typeof cursor}`}. ` +
        'Leave `cursor` out for the first page.',
    );
  }
  if (hasNoKeys(cursor)) {
    throw new ValidationError(
      `${operation} on "${table}" refused: \`cursor: {}\` names no row. Leave \`cursor\` out for the first page, ` +
        "or pass the last row's values (for example `cursor: { id: lastRow.id }`).",
    );
  }
}

/**
 * Refuse a `cursor` whose every field was `undefined`. Read as absent it would
 * restart the walk at the first page, so a pager whose last-row value went
 * missing would re-read page one forever. Same rule and message on every engine.
 * `operation` names the call in the message when the caller knows it; without
 * it the message names no operation rather than a wrong one.
 */
export function assertCursorNotEmptied(table: string, original: unknown, pruned: unknown, operation?: string): void {
  const before = isPlainRecord(original) ? original.cursor : undefined;
  if (!isPlainRecord(before) || hasNoKeys(before)) return;
  if (hasCursor(isPlainRecord(pruned) ? pruned.cursor : undefined)) return;
  throw new ValidationError(
    `${operation ? `${operation} on` : 'Query on'} "${table}" refused: every field of \`cursor\` was undefined, so ` +
      "the page would restart at the first row. Pass the last row's values, or leave `cursor` out for the first page.",
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
