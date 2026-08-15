/**
 * turbine-orm CLI: the PII predicate guard
 *
 * A pure leaf module, the same role `cli/rate-limit.ts` and `cli/destructive.ts`
 * play: no I/O, no state, and no import from a sibling CLI module. The two
 * local tools that compile CALLER-SUPPLIED `findMany` args, Studio's
 * `/api/builder` and the MCP server's `explain_query`, both walk their args
 * through this one walker before handing them to `QueryInterface`.
 *
 * It is one module because it was two. Studio and MCP each carried their own
 * `assertNoPiiPredicates` with the same name and the same job, plus their own
 * copy of `RELATION_FILTER_WRAPPERS` and `PII_GUARD_MAX_DEPTH`, and they drifted
 * exactly the way two hand-synced implementations do: a hole opened in one and
 * was present in the other, and closing it in one place would have left the
 * other open. Both tools now share the walk and differ only in the two things
 * that genuinely differ, WHY a column is hidden and HOW a refusal is thrown,
 * which arrive as callbacks on {@link PiiGuardHost}.
 *
 * WHAT IT IS FOR. Redacting the cells of a hidden column is not enough on its
 * own: `where: { email: { startsWith: 'a' } }` answers a question ABOUT the
 * hidden value, and so does an `isNull`, an `orderBy`, a `cursor` (which
 * compiles to a `"email" > $1` range comparison, i.e. a clean binary search over
 * the byte range), and, more weakly, a `distinct` (the cardinality of the hidden
 * values). `select` is deliberately NOT refused: it returns values, and the
 * values are redacted on the way out.
 *
 * WHY IT FAILS CLOSED. Every branch here answers one question, "can this shape
 * be shown not to name a hidden column", and the honest answer for a shape the
 * walker does not recognize is no. Waving unrecognized shapes through is what
 * produced the pick-row hole (`orderBy: { rel: { pick: {...}, by: 'phone' } }`):
 * `pick` is neither a combinator nor a relation nor a column of the target, so
 * the walker checked the literal string `pick` against the column list, found
 * nothing, and moved on, while `by` named the hidden column in its VALUE rather
 * than its key. The specific keys are handled below, but the FAIL-CLOSED rule is
 * the actual fix: an unrecognized key carrying a structure is refused, so the
 * next orderBy shape the query builder grows is refused here until someone
 * teaches this walker about it. Over-refusing is a usability bug; under-refusing
 * is a data leak.
 */

import { COLUMN_REF_OPERATORS } from '../query/filters.js';
import { ownLookup } from '../query/utils.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';

/**
 * Relation-filter wrappers whose body is a clause against the relation's target.
 *
 * THREE copies of this list exist in the tree, and they have to agree: a wrapper
 * the compiler understands and this guard does not is a wrapper that reaches the
 * builder unguarded.
 *
 *   1. this one, the only NAMED definition;
 *   2. `query/where-compile.ts`, inlined as `'some' in x || 'every' in x || …`;
 *   3. `prisma-compat.ts`, SPLIT across `RELATION_QUANTIFIERS`
 *      (`some`/`every`/`none`) and two inline `k === 'is' || k === 'isNot'`
 *      tests, which is the copy most likely to drift because half of it does
 *      not look like a list at all.
 *
 * Copy 2 belongs to the SQL compiler and cannot import this one (a query-path
 * module must not depend on `cli/`), so the deduplication has to go the other
 * way: the list wants to live in `query/filters.ts` and be imported here, the
 * way {@link COLUMN_REF_OPERATORS} above now is.
 *
 * That destination now EXISTS (`RELATION_FILTER_WRAPPERS` in `query/filters.ts`)
 * and nothing imports it, including this file, so it is a fourth copy rather
 * than a deduplication and this comment is still the only thing holding them in
 * step. Moving each walk onto it is a change per walk, each with its own tests.
 */
export const RELATION_FILTER_WRAPPERS = ['some', 'none', 'every', 'is', 'isNot'] as const;

const RELATION_FILTER_WRAPPER_SET: ReadonlySet<string> = new Set<string>(RELATION_FILTER_WRAPPERS);

/**
 * Recursion bound for the guard walk.
 *
 * This number is NOT the security boundary: reaching it REFUSES the request
 * (`refuseDepth`). It only bounds the walk on a pathological payload. Returning
 * quietly at the cap, which both copies of this walker once did, meant padding a
 * payload with enough nested `NOT` wrappers walked the guard off the end of its
 * own recursion and then handed the untouched predicate to the builder. It sits
 * well above the query builder's own depth-10 relation cap
 * (`CircularRelationError`) and far above any hand-composed boolean nesting, so
 * nothing the builder would accept is refused here for depth alone.
 */
export const PII_GUARD_MAX_DEPTH = 32;

/**
 * Query-level arg keys whose value is legitimately an object or an array.
 *
 * Everything else on `FindManyArgs` / `WithOptions` is a scalar (`limit`,
 * `offset`, `take`, `timeout`, `relationLoadStrategy`, `stableRelationOrder`,
 * `warnOnUnlimited`, `forceCustomPlan`, `includePii`), so an object-valued key
 * outside this set is a structure the walker has never seen and is refused.
 * `includePii` / `skipGlobalFilters` are gated by the `UNSAFE` symbol, which
 * `JSON.parse` cannot produce, so neither can be forged over the wire.
 */
const LEVEL_OBJECT_KEYS: ReadonlySet<string> = new Set([
  'where',
  'orderBy',
  'cursor',
  'distinct',
  'with',
  'select',
  'omit',
  'skipGlobalFilters',
]);

/**
 * Every key a pick-row ordering (`RelationPickOrderBy`) may carry. Used only to
 * recognize the shape, mirroring `isRelationPickOrderBy` in `query/filters.ts`,
 * which is what the builder itself branches on.
 */
const RELATION_PICK_KEYS: ReadonlySet<string> = new Set(['pick', 'by', 'direction', 'nulls', 'plan']);

/**
 * The two things Studio and the MCP server genuinely do differently, plus the
 * schema the walk resolves relation targets against.
 *
 * `hiddenReason` is the whole policy: Studio hides code-first `pii` tags unless
 * `--show-pii`, the MCP server hides those AND secret-looking column names. The
 * `refuse*` callbacks throw, they never return, because the two tools raise
 * different error types (`ValidationError` vs a JSON-RPC error).
 */
export interface PiiGuardHost {
  /** Schema the walk resolves relation targets against. */
  metadata: SchemaMetadata;
  /**
   * Why `column` on `table` may not appear in a predicate, or `null` when it
   * may. The string is interpolated into the refusal message, so it reads as a
   * predicate: `"is PII-tagged and redacted"`.
   */
  hiddenReason(table: TableMetadata, column: string): string | null;
  /** Refuse: the query names a hidden column. Must throw. */
  refuseColumn(table: TableMetadata, column: string, reason: string): never;
  /** Refuse: the query is nested past {@link PII_GUARD_MAX_DEPTH}. Must throw. */
  refuseDepth(maxDepth: number): never;
  /**
   * Refuse: `key` on `table` is a query shape this walker does not recognize, so
   * it cannot be shown not to name a hidden column. Must throw.
   */
  refuseShape(table: TableMetadata, key: string): never;
}

/** An object or array value, i.e. something that can carry a nested name. */
function isObjectLike(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

/** A non-array object: the shape every clause / spec node in the arg tree uses. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isObjectLike(value) && !Array.isArray(value);
}

/**
 * The depth one element of an array is visited at: unchanged for an ordinary
 * element, one level deeper for an element that is ITSELF an array.
 *
 * The distinction is the whole fix, and it is not the same as "arrays cost a
 * level". Both array branches below deliberately did not increment, and the
 * reason was right: an `OR: [a, b, c]` (or a Prisma-style `orderBy: [{…}, {…}]`)
 * is ONE logical level however long the list is, and its elements are SIBLINGS,
 * each visited from the same stack frame, so width costs no recursion. Charging
 * a level per element would have refused a legal 40-condition `OR`.
 *
 * What that missed is that the array branch also recurses into an element that
 * is another ARRAY, and there the frames DO stack. `{"orderBy":[[[…]]]}` walks
 * one frame per bracket with the logical depth pinned at its starting value, so
 * the cap never fires: measured, 1,000 levels (a 2 KB body) was allowed outright
 * and 10,000 (20 KB) raised `RangeError: Maximum call stack size exceeded`
 * inside the guard. That is the exact class the module header says was fixed by
 * making the cap REFUSE instead of returning quietly, reintroduced through the
 * one branch that never reaches the cap.
 *
 * So: nesting counts, iteration does not. No legal arg shape puts an array
 * directly inside an array (`orderBy` is `X | X[]`, the combinators take `X[]`),
 * so nothing the builder would accept is refused for depth by this rule, and it
 * needs no second budget to reason about, the existing cap now simply sees the
 * nesting it was already meant to be counting.
 */
function arrayItemDepth(item: unknown, depth: number): number {
  return Array.isArray(item) ? depth + 1 : depth;
}

/**
 * Is this relation-keyed value a pick-row ordering rather than a relation filter
 * or a to-one column ordering?
 *
 * Deliberately a MIRROR of `isRelationPickOrderBy` (`query/filters.ts`), down to
 * requiring `pick` to be an object carrying `orderBy`: the builder branches on
 * that predicate, so a guard that answered it differently would guard a
 * different query than the one that runs. It matters in both directions. A
 * target table with columns literally named `pick` and `by` produces
 * `{ rel: { pick: 'asc', by: 'desc' } }`, which is an ordinary two-column to-one
 * ordering to the builder and must be walked as two COLUMN names here. And a
 * value with an object-valued `pick` that is not a full pick spec is not
 * special-cased at all: it falls through to the fail-closed branch.
 */
function isPickShape(node: Record<string, unknown>): boolean {
  if (!Object.hasOwn(node, 'pick') || !Object.hasOwn(node, 'by')) return false;
  const pick = node.pick;
  if (!isPlainObject(pick) || !Object.hasOwn(pick, 'orderBy')) return false;
  return Object.keys(node).every((key) => RELATION_PICK_KEYS.has(key));
}

/**
 * Walk one query level (`findMany` args, or one `with` entry's options) and
 * refuse it if it filters, sorts, pages, or de-duplicates on a hidden column, or
 * if it carries a shape that cannot be proven not to.
 *
 * `rootTable` may be `undefined` (the caller's table name did not resolve); the
 * walk then does nothing, because the builder rejects the query a moment later
 * by name and there is no metadata here to judge it against.
 */
export function assertNoPiiPredicates(
  args: Record<string, unknown>,
  rootTable: TableMetadata | undefined,
  host: PiiGuardHost,
): void {
  const assertWithinDepth = (depth: number): void => {
    if (depth <= PII_GUARD_MAX_DEPTH) return;
    host.refuseDepth(PII_GUARD_MAX_DEPTH);
  };

  /**
   * Check one caller-supplied name against `table`. A predicate may name a
   * column by its camelCase field OR by its real column name; both compile to
   * the same SQL, so both have to resolve to the same check.
   */
  const checkColumnName = (table: TableMetadata, name: string): void => {
    const column = ownLookup(table.columnMap, name) ?? name;
    const reason = host.hiddenReason(table, column);
    if (reason) host.refuseColumn(table, column, reason);
  };

  /**
   * A column-keyed operator object (`{ gt: 5 }`, `{ sort, nulls }`, a JSON path,
   * a vector distance) holds values, not names, with ONE exception: the
   * comparison operators also accept `{ col: 'otherField' }`, which compiles to
   * a column-to-column comparison in the same table. Scan for that.
   *
   * The operator list is IMPORTED from `query/filters.ts` rather than copied:
   * that is the set the SQL compiler itself branches on, and a guard that
   * disagreed with it would be guarding a different query than the one that
   * runs. A copy that drifted short by one operator reopens the operand-position
   * channel this scan exists to close, silently.
   */
  const checkColumnRefs = (table: TableMetadata, operatorNode: Record<string, unknown>): void => {
    for (const opKey of COLUMN_REF_OPERATORS) {
      const operand = ownLookup(operatorNode, opKey);
      if (!isPlainObject(operand)) continue;
      const ref = operand.col;
      if (typeof ref === 'string') checkColumnName(table, ref);
    }
  };

  /**
   * One `[key, value]` entry of a clause node.
   *
   * `scope` says which key vocabulary applies. `'clause'` is a where / orderBy /
   * cursor object resolved against a table: combinators, relation names, column
   * names. `'relation'` is the value SITTING UNDER a relation name, which also
   * accepts the cardinality wrappers, and is where the fail-closed rule bites:
   * an unrecognized key carrying a structure is refused rather than checked as
   * if it were a column name and waved through when it is not one.
   *
   * `_count` needs no case of its own. It is walked as a column name, which
   * clears it on every real schema, refuses it on the pathological one that has
   * a hidden column with that name, and, since its value is a bare direction
   * token, never reaches the fail-closed branch.
   */
  const visitEntry = (
    table: TableMetadata,
    key: string,
    value: unknown,
    depth: number,
    scope: 'clause' | 'relation',
  ): void => {
    if (key === 'AND' || key === 'OR' || key === 'NOT') {
      visitClause(value, table, depth + 1);
      return;
    }

    // `{ user: { is: {...} } }` / `{ posts: { some: {...} } }`: the wrapper's
    // body is a clause against the SAME target. Handing the wrapper to the
    // column walker instead walked `is` as if it were a column of the target,
    // so the inner clause was never visited at all.
    if (scope === 'relation' && RELATION_FILTER_WRAPPER_SET.has(key)) {
      visitClause(value, table, depth + 1);
      return;
    }

    const relation = ownLookup(table.relations, key);
    if (relation) {
      const target = ownLookup(host.metadata.tables, relation.to);
      // A relation whose target is not in the metadata cannot be walked, and a
      // walk that cannot see the target cannot clear it.
      if (!target) host.refuseShape(table, key);
      visitRelationValue(value, target, depth + 1);
      return;
    }

    checkColumnName(table, key);

    if (!isObjectLike(value)) return;
    const column = ownLookup(table.columnMap, key) ?? key;
    // FAIL CLOSED. Under a relation, a key that is neither a known relation-value
    // keyword nor a real column of the target, yet carries an object or array, is
    // a shape this walker has never been taught. At clause scope the same key is
    // rejected by the builder by name (E003, "unknown column"), which keeps a
    // plain typo reading like a typo.
    if (scope === 'relation' && !table.allColumns.includes(column)) host.refuseShape(table, key);
    if (isPlainObject(value)) checkColumnRefs(table, value);
  };

  /** A where / orderBy / cursor object (or a Prisma-style array of them). */
  const visitClause = (node: unknown, table: TableMetadata | undefined, depth: number): void => {
    assertWithinDepth(depth);
    if (!table || !isObjectLike(node)) return;
    // `orderBy` accepts a Prisma-style array of single-key objects, and so does
    // a `NOT` list. ITERATING that list carries no nesting, so a list of any
    // WIDTH stays at one depth. NESTING it does: see arrayItemDepth.
    if (Array.isArray(node)) {
      for (const item of node) visitClause(item, table, arrayItemDepth(item, depth));
      return;
    }
    for (const [key, value] of Object.entries(node)) visitEntry(table, key, value, depth, 'clause');
  };

  /** The value sitting under a relation name, in a where OR an orderBy. */
  const visitRelationValue = (value: unknown, target: TableMetadata | undefined, depth: number): void => {
    assertWithinDepth(depth);
    if (!target || !isObjectLike(value)) return;
    if (Array.isArray(value)) {
      for (const item of value) visitRelationValue(item, target, arrayItemDepth(item, depth));
      return;
    }
    const node = value as Record<string, unknown>;
    // Pick-row ordering: `{ rel: { pick: { orderBy, where }, by, … } }`. THREE
    // column-naming positions, none of them a key of the relation value, which
    // is why key-only walking never saw any of them: `pick.orderBy` and
    // `pick.where` are clauses two levels down, and `by` names the target column
    // whose value the parents are sorted by, in its VALUE.
    if (isPickShape(node)) {
      visitPick(node.pick, target, depth + 1);
      visitPickBy(node.by, target);
      // `direction` / `nulls` / `plan` are single tokens. A token position
      // holding a structure is not a token, and is refused rather than assumed
      // inert.
      for (const key of ['direction', 'nulls', 'plan']) {
        if (isObjectLike(ownLookup(node, key))) host.refuseShape(target, key);
      }
      return;
    }
    for (const [key, member] of Object.entries(node)) visitEntry(target, key, member, depth, 'relation');
  };

  /** `pick: { orderBy, where }`: both are clauses against the relation target. */
  const visitPick = (value: unknown, target: TableMetadata, depth: number): void => {
    assertWithinDepth(depth);
    if (!isPlainObject(value)) return;
    for (const [key, member] of Object.entries(value)) {
      if (key === 'orderBy' || key === 'where') {
        visitClause(member, target, depth);
        continue;
      }
      if (isObjectLike(member)) host.refuseShape(target, `pick.${key}`);
    }
  };

  /**
   * `by`: the value read off the picked row. Either a bare target column name,
   * or `{ field, path }` extracting a JSON path out of a json/jsonb target
   * column. Both name a column in the VALUE position, which is why key-only
   * checking never saw them.
   */
  const visitPickBy = (value: unknown, target: TableMetadata): void => {
    if (typeof value === 'string') {
      checkColumnName(target, value);
      return;
    }
    if (isPlainObject(value)) {
      const field = value.field;
      if (typeof field === 'string') {
        checkColumnName(target, field);
        return;
      }
      host.refuseShape(target, 'by');
    }
    // Any other `by` (number, null, array) names no column and the builder
    // rejects the shape.
  };

  /** Field-name lists (`distinct`) name columns directly rather than in a clause. */
  const visitFieldList = (value: unknown, table: TableMetadata): void => {
    if (!Array.isArray(value)) return;
    for (const field of value) {
      if (typeof field === 'string') checkColumnName(table, field);
    }
  };

  const visitLevel = (level: Record<string, unknown>, table: TableMetadata | undefined, depth: number): void => {
    assertWithinDepth(depth);
    if (!table) return;
    visitClause(level.where, table, depth);
    visitClause(level.orderBy, table, depth);
    // `cursor` is a flat `{ field: value }` seek key that the builder turns into
    // a WHERE range comparison against the sort key, so it reads exactly like a
    // where on the same column.
    visitClause(level.cursor, table, depth);
    visitFieldList(level.distinct, table);

    // FAIL CLOSED one level up: a query-level arg this walker does not know,
    // carrying a structure, could name columns the same way `orderBy` does.
    for (const [key, value] of Object.entries(level)) {
      if (LEVEL_OBJECT_KEYS.has(key)) continue;
      if (isObjectLike(value)) host.refuseShape(table, key);
    }

    const withClause = level.with;
    if (!isPlainObject(withClause)) return;
    for (const [relName, spec] of Object.entries(withClause)) {
      const relation = ownLookup(table.relations, relName);
      // `_count` and an unknown relation name are not levels; the builder
      // decides whether they are valid, and neither carries a column name.
      if (!relation || spec === true || !isPlainObject(spec)) continue;
      visitLevel(spec, ownLookup(host.metadata.tables, relation.to), depth + 1);
    }
  };

  visitLevel(args, rootTable, 0);
}
