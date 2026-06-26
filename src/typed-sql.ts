/**
 * turbine-orm — Typed raw SQL (Turbine's answer to Prisma's TypedSQL)
 *
 * `client.raw()` returns untyped rows. This module adds a *typed* escape hatch:
 * a generic tagged template where the caller supplies the row shape, and the
 * builder yields a typed result that can be awaited as an array of rows, or
 * narrowed to a single row (`.one()`) or a single scalar value (`.scalar()`).
 *
 * Design goals & guarantees:
 *
 *  1. **Compile-time only types.** `T` is supplied by the caller and never
 *     validated at runtime — exactly like Prisma's TypedSQL and the existing
 *     `raw<T>()`. Postgres still returns whatever the SQL selects; the generic
 *     is a convenience for autocomplete and downstream type-checking.
 *
 *  2. **Mandatory parameterization.** Only the *static* string segments of the
 *     template literal ever reach the SQL text. Every interpolated `${value}`
 *     becomes a `$N` placeholder and is passed in the params array — it is
 *     impossible to string-concatenate a value into the query through this API.
 *     This is the whole point of the tagged-template shape: the literal segments
 *     are frozen by the compiler (`TemplateStringsArray`), and the only way to
 *     get a runtime value into the query is via `${...}`, which we bind.
 *
 *  3. **Rows are returned as-is (no snake→camel mapping).** This matches the
 *     existing `client.raw()` behavior: a typed raw query is a literal escape
 *     hatch, so the result columns are whatever your `SELECT` names them. Alias
 *     columns in SQL (`SELECT created_at AS "createdAt"`) if you want camelCase.
 *
 * @example
 * ```ts
 * // Awaited directly -> rows
 * const rows = await db.sql<{ id: number; name: string }>`
 *   SELECT id, name FROM users WHERE org_id = ${orgId}
 * `;
 * //    ^? { id: number; name: string }[]
 *
 * // .one() -> single row or null
 * const user = await db.sql<{ id: number; name: string }>`
 *   SELECT id, name FROM users WHERE id = ${userId}
 * `.one();
 * //    ^? { id: number; name: string } | null
 *
 * // .scalar() -> first column of first row, or null
 * const total = await db.sql<{ count: number }>`
 *   SELECT COUNT(*)::int AS count FROM users WHERE org_id = ${orgId}
 * `.scalar();
 * //    ^? number | null
 * ```
 */

import type { PgCompatPool } from './client.js';
import { type Dialect, postgresDialect } from './dialect.js';
import { ValidationError, wrapPgError } from './errors.js';

/**
 * Build a `(sql, params)` pair from a tagged-template invocation.
 *
 * Each interpolated value is replaced by a positional placeholder (the active
 * dialect's `paramPlaceholder`, `$N` for PostgreSQL) and pushed to the params
 * array in order. The static string segments are the only thing concatenated
 * into the SQL text. This is the single point that guarantees parameterization
 * for the entire typed-SQL surface.
 *
 * Exported for unit testing the parameterization invariant without a database.
 */
export function buildTypedSql(
  strings: TemplateStringsArray,
  values: readonly unknown[],
  dialect: Pick<Dialect, 'paramPlaceholder'> = postgresDialect,
): { sql: string; params: unknown[] } {
  // The tagged-template API guarantees `strings.length === values.length + 1`.
  // Guard the directly-callable (exported) surface so a mismatched call can't
  // silently desync placeholders from params (pg would reject it, but fail
  // loudly here instead).
  if (strings.length !== values.length + 1) {
    throw new ValidationError(
      `[turbine] sql template segment/value count mismatch: ${strings.length} segments, ${values.length} values.`,
    );
  }
  let sql = '';
  for (let i = 0; i < strings.length; i++) {
    sql += strings[i];
    if (i < values.length) {
      sql += dialect.paramPlaceholder(i + 1);
    }
  }
  return { sql, params: values.slice() };
}

/**
 * A pending typed raw SQL query. Implements the thenable contract, so it can be
 * `await`ed directly to get `T[]`, or refined via `.one()` / `.scalar()` first.
 *
 * The query is executed lazily and exactly once per terminal call (`then`,
 * `one`, `scalar`). Each terminal method runs the query independently — this is
 * an escape hatch, not a cached query object, so don't call two terminals on
 * the same builder expecting a single round-trip; build a fresh template each
 * time (the common pattern is `await db.sql\`...\`` inline).
 */
export class TypedSqlQuery<T extends Record<string, unknown>> implements PromiseLike<T[]> {
  constructor(
    private readonly pool: PgCompatPool,
    private readonly sql: string,
    private readonly params: unknown[],
    private readonly logging: boolean,
  ) {}

  /** Execute and return all rows. Internal; powers `then`, `one`, and `scalar`. */
  private async run(): Promise<T[]> {
    if (this.logging) {
      console.log(`[turbine] Typed SQL: ${this.sql.trim().substring(0, 120)}...`);
    }
    try {
      const result = await this.pool.query(this.sql, this.params);
      return result.rows as T[];
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  /**
   * PromiseLike implementation: `await db.sql<T>\`...\`` resolves to `T[]`.
   */
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable — this IS the PromiseLike contract that makes `await db.sql\`...\`` resolve to rows
  then<TResult1 = T[], TResult2 = never>(
    onfulfilled?: ((value: T[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.run().then(onfulfilled, onrejected);
  }

  /**
   * Execute and return the first row, or `null` if the query returns no rows.
   * Use for queries you expect to match at most one row.
   */
  async one(): Promise<T | null> {
    const rows = await this.run();
    return rows.length > 0 ? (rows[0] as T) : null;
  }

  /**
   * Execute and return the first column of the first row, or `null` if there
   * are no rows. Useful for `SELECT COUNT(*)`, `SELECT EXISTS(...)`, etc.
   *
   * The generic `V` defaults to the value type of `T`'s first property, but you
   * can override it: `db.sql<{ count: number }>\`...\`.scalar<number>()`.
   */
  async scalar<V = T[keyof T]>(): Promise<V | null> {
    const rows = await this.run();
    if (rows.length === 0) return null;
    const first = rows[0] as Record<string, unknown>;
    const keys = Object.keys(first);
    if (keys.length === 0) return null;
    return first[keys[0]!] as V;
  }
}
