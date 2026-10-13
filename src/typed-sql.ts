/**
 * turbine-orm, Typed raw SQL (Turbine's answer to Prisma's TypedSQL)
 *
 * `client.raw()` returns untyped rows. This module adds a *typed* escape hatch:
 * a generic tagged template where the caller supplies the row shape, and the
 * builder yields a typed result that can be awaited as an array of rows, or
 * narrowed to a single row (`.one()`) or a single scalar value (`.scalar()`).
 *
 * Design goals & guarantees:
 *
 *  1. **Compile-time only types.** `T` is supplied by the caller and never
 *     validated at runtime, exactly like Prisma's TypedSQL and the existing
 *     `raw<T>()`. Postgres still returns whatever the SQL selects; the generic
 *     is a convenience for autocomplete and downstream type-checking.
 *
 *  2. **Mandatory parameterization.** Only the *static* string segments of the
 *     template literal ever reach the SQL text. Every interpolated `${value}`
 *     becomes a `$N` placeholder and is passed in the params array, it is
 *     impossible to string-concatenate a value into the query through this API.
 *     This is the whole point of the tagged-template shape: the literal segments
 *     are frozen by the compiler (`TemplateStringsArray`), and the only way to
 *     get a runtime value into the query is via `${...}`, which we bind. A
 *     plain array passed where the template belongs is refused at runtime
 *     ({@link assertTemplateStrings}).
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
import { consoleLogger, logTo, type TurbineLogger } from './logger.js';
import type { QueryEvent } from './query/deferred.js';
import { rawIdentity, runReportedStatement } from './query-events.js';

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
  api = 'sql',
): { sql: string; params: unknown[] } {
  assertTemplateStrings(strings, api);
  // A tagged template always has `strings.length === values.length + 1`; a
  // hand-built frozen one may not, and would desync placeholders from params.
  if (strings.length !== values.length + 1) {
    throw new ValidationError(
      `sql template segment/value count mismatch: ${strings.length} segments, ${values.length} values.`,
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
 * Refuse a "template" that did not come from a tagged-template call.
 *
 * Only the static segments of a template reach the SQL text, and that is safe
 * because the compiler wrote them. A plain array passed in their place (a
 * JSON-parsed request field, a string split by hand) puts its text into the
 * SQL with nothing escaped. A real `TemplateStringsArray` is frozen and carries
 * a frozen `raw` array of the same length; `JSON.parse` and array literals
 * produce neither.
 *
 * `unsafeApi` names the method that takes statement text instead, for the
 * error message.
 */
export function assertTemplateStrings(
  strings: unknown,
  api: string,
  unsafeApi = 'rawUnsafe',
): asserts strings is TemplateStringsArray {
  if (Array.isArray(strings) && Object.isFrozen(strings)) {
    const raw = (strings as { raw?: unknown }).raw;
    if (Array.isArray(raw) && Object.isFrozen(raw) && raw.length === strings.length) {
      if (strings.every((s) => typeof s === 'string')) return;
      throw new ValidationError(
        `${api}: a segment of the template contains an invalid escape sequence, so it has no text. ` +
          'Fix the escape (write a literal backslash as `\\\\`).',
      );
    }
  }
  const received = Array.isArray(strings) ? 'a plain array' : strings === null ? 'null' : typeof strings;
  throw new ValidationError(
    `${api} must be called as a tagged template, for example ${api}\`SELECT * FROM users WHERE id = \${id}\`, ` +
      `so that every interpolated value is sent as a bound parameter. It received ${received} instead, whose ` +
      'text would reach the SQL unescaped. To run statement text built at runtime (DDL, a migration file), use ' +
      `\`${unsafeApi}(text, ...values)\` and keep untrusted input out of the text.`,
  );
}

/**
 * A `Date` in the form node-postgres sends under `parseInputDatesAsUTC`:
 * `YYYY-MM-DDTHH:MM:SS.mmm+00:00`, with ` BC` for years before 1.
 */
function utcDateText(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  let year = date.getUTCFullYear();
  const bc = year < 1;
  if (bc) year = 1 - year;
  return (
    `${pad(year, 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}` +
    `.${pad(date.getUTCMilliseconds(), 3)}+00:00${bc ? ' BC' : ''}`
  );
}

function utcDateValue(value: unknown, api: string, position: number, nested: boolean): unknown {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError(
        `${api}: parameter $${position} ${nested ? 'contains' : 'is'} an Invalid Date, which has no SQL value. ` +
          'Pass a valid Date, or null for SQL NULL.',
      );
    }
    return utcDateText(value);
  }
  if (!Array.isArray(value)) return value;
  let out: unknown[] | undefined;
  for (let i = 0; i < value.length; i++) {
    const converted = utcDateValue(value[i], api, position, true);
    if (converted !== value[i]) {
      out ??= value.slice();
      out[i] = converted;
    }
  }
  return out ?? value;
}

/**
 * Raw-statement params with every `Date` (in arrays too) bound as UTC text,
 * for a client reading zone-less temporal types as UTC (`utcTimestamps`).
 *
 * node-postgres renders a Date in the process's zone with its offset. A
 * `timestamptz` keeps the instant either way, but a `timestamp` or `date`
 * drops the offset and stores the local wall time, which then reads back
 * shifted by the process offset. UTC text stores the instant's UTC fields,
 * which is what a UTC read returns. Returns `params` itself when it holds no
 * Date. An Invalid Date is refused (E003) instead of reaching the server as
 * unparseable text.
 */
export function utcDateParams(params: unknown[], api: string): unknown[] {
  let out: unknown[] | undefined;
  for (let i = 0; i < params.length; i++) {
    const converted = utcDateValue(params[i], api, i + 1, false);
    if (converted !== params[i]) {
      out ??= params.slice();
      out[i] = converted;
    }
  }
  return out ?? params;
}

/**
 * A pending typed raw SQL query. Implements the thenable contract, so it can be
 * `await`ed directly to get `T[]`, or refined via `.one()` / `.scalar()` first.
 *
 * The query is executed lazily and exactly once per terminal call (`then`,
 * `one`, `scalar`). Each terminal method runs the query independently, this is
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
    /**
     * Runs the execution under the owning client's `errorMessages` mode. Passed
     * in rather than read here because this module must not import the client.
     *
     * It has to reach the EXECUTION, not the construction, and that is the whole
     * reason it is a constructor parameter instead of a wrapper around
     * `client.sql\`...\``: this builder is lazy, so a scope established around
     * the tagged-template call is torn down before a single row is fetched.
     * Wrapping the template call compiled, ran, and protected nothing.
     *
     * Defaults to calling through, so a `TypedSqlQuery` built outside a client
     * behaves exactly as before.
     */
    private readonly runScoped: <R>(fn: () => R) => R = (fn) => fn(),
    /**
     * The owning client's `$on('query')` sink. Each execution emits one event
     * with model `'$raw'` and action `'sql'`. Absent for a `TypedSqlQuery`
     * built outside a client, which then emits nothing, as before.
     */
    private readonly onQuery?: (event: QueryEvent) => void,
    /** Where the `logging` preview line goes. Defaults to the console logger. */
    private readonly logger: TurbineLogger = consoleLogger,
  ) {}

  /** Execute and return all rows. Internal; powers `then`, `one`, and `scalar`. */
  private run(): Promise<T[]> {
    return this.runScoped(async () => {
      if (this.logging) {
        logTo(this.logger, 'debug', `Typed SQL: ${this.sql.trim().substring(0, 120)}...`, { code: 'typed-sql' });
      }
      const result = await runReportedStatement(
        this.onQuery,
        rawIdentity('sql'),
        this.sql,
        this.params,
        () => this.pool.query(this.sql, this.params),
        wrapPgError,
      );
      return result.rows as T[];
    });
  }

  /**
   * PromiseLike implementation: `await db.sql<T>\`...\`` resolves to `T[]`.
   */
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable, this IS the PromiseLike contract that makes `await db.sql\`...\`` resolve to rows
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
