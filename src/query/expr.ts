/**
 * turbine-orm: SQL expressions in update data.
 *
 * `expr.greatest(col('viewCount'), 100)` and friends are branded node objects,
 * and `expr.excluded('events')` names the incoming row of an upsert. Both are
 * written into the SQL TEXT, so both carry a symbol brand: `JSON.parse` cannot
 * produce one, so request data can never become an expression (the same
 * reasoning as `col()` and `UNSAFE`). `Symbol.for` so the ESM and CJS copies of
 * the package recognize each other's nodes.
 *
 * The public types live in `query/types.ts` (`SqlExpr`, `ExcludedRef`). The
 * node constructors and the single compile walker belong in this module.
 */

/** The brand every {@link SqlExpr} node carries. */
export const SQL_EXPR: unique symbol = Symbol.for('turbine-orm.sqlExpr');

/** The brand an {@link ExcludedRef} carries (the incoming row of an upsert). */
export const EXCLUDED_REF: unique symbol = Symbol.for('turbine-orm.excludedRef');
