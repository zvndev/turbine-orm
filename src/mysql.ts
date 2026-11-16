/**
 * turbine-orm/mysql, MySQL 8 engine (driver-injected, optional peer)
 *
 * Binds Turbine to MySQL 8 via the `mysql2` driver. `mysql2` is **not** a root
 * dependency, it is an **optional peer**: `npm i turbine-orm` pulls nothing
 * extra, and only consumers who `import 'turbine-orm/mysql'` install `mysql2`
 * themselves. The factory loads it through a dynamic `import('mysql2/promise')`
 * so importing this module never crashes when `mysql2` is absent for a consumer
 * who does not use it. Turbine's root runtime dependency stays exactly `pg`.
 *
 * ## The two hard MySQL realities this engine solves
 *
 *  1. **No `RETURNING`.** `INSERT`/`UPDATE`/`DELETE` cannot return the affected
 *     rows. `mysqlDialect.resultStrategy = 'reselect'`: the executor runs the
 *     write, then issues a follow-up `SELECT` by primary key (using mysql2's
 *     `insertId` for auto-increment PKs) / by the `where` predicate, so
 *     `create`/`update`/`upsert`/`delete` still return real rows.
 *  2. **Positional `?` is broken for this builder.** Turbine pushes params in
 *     1-indexed generation order but EMITS them in a different SQL-text position
 *     (e.g. a `with`-relation `LIMIT` lands in the SELECT list, ahead of the
 *     outer `WHERE`). Postgres reconciles this via numbered `$N`; positional `?`
 *     silently mis-binds. So `mysqlDialect` uses **mysql2 named placeholders**
 *     (`:p1`, `:p2`, …) and the driver shim binds via a `{ p1, p2, … }` object -
 *     exactly mirroring `$N` semantics regardless of text order. (See
 *     `turbine-orm/sqlite` for the same fix.)
 *
 * ## Capabilities & limits (vs PostgreSQL)
 *
 * - **Single query nested relations preserved** via MySQL 8 `JSON_OBJECT` /
 *   `JSON_ARRAYAGG` with `COALESCE(…, JSON_ARRAY())`. `JSON_ARRAYAGG` has no
 *   inline `ORDER BY` argument, so every ordered to-many relation is forced
 *   through the inner-subquery rewrite (`aggSupportsInlineOrderBy = false`).
 *   Nested subresults are `CAST(… AS JSON)`-wrapped so MySQL embeds them as real
 *   nested JSON instead of double-encoding a scalar subquery result as a string.
 * - **`createMany` returns an empty array** (count-not-rows). MySQL has no
 *   `RETURNING` and the bulk-insert `insertId` is only the first generated id, so
 *   re-selecting N rows reliably is unsafe. The rows ARE inserted; re-query if you
 *   need them back. (Plan §4 documented divergence.)
 * - **Unsupported (throw `UnsupportedFeatureError`):** pgvector distance ops,
 *   LISTEN/NOTIFY (`$listen`/`$notify`), RLS `sessionContext` (no GUCs).
 * - **Advisory-lock migration locking** is available in principle via
 *   `GET_LOCK`/`RELEASE_LOCK` (`supportsAdvisoryLock = true`); the migrate CLI is
 *   still PostgreSQL-only, so this flag documents intent for a future adapter.
 * - **Case-insensitive matching** uses `LOWER(col) LIKE LOWER(ref)`, note this
 *   can defeat indexes unless a functional/generated index exists.
 * - **bignum:** mysql2 is configured `supportBigNumbers:true, bigNumberStrings:false`
 *   - the same safe-int policy Turbine uses for Postgres `int8` (number when it
 *   fits, decimal string otherwise). `DECIMAL` comes back as a string; `TINYINT(1)`
 *   binds booleans as 1/0. No global parser state is mutated.
 * - **Version:** MySQL **8.0+** required (5.7 lacks `JSON_ARRAYAGG`); MariaDB is
 *   unsupported. The factory probes `SELECT VERSION()` and fails fast otherwise.
 *
 * ## Example
 *
 * ```ts
 * import { turbineMysql } from 'turbine-orm/mysql';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const db = await turbineMysql('mysql://user:pass@localhost:3306/app', SCHEMA);
 * const users = await db.users.findMany({ with: { posts: true }, limit: 10 });
 * await db.disconnect();
 * ```
 */

import type { EventEmitter } from 'node:events';
import {
  type DisconnectOptions,
  type DisconnectResult,
  type PgCompatPool,
  type PgCompatPoolClient,
  TurbineClient,
} from './client.js';
import {
  type BuiltStatement,
  type BulkInsertStatementInput,
  type BulkUpsertStatementInput,
  type ColumnDefinitionInput,
  type ColumnTypeInput,
  type CreateIndexStatementInput,
  type CreateTableStatementInput,
  type DefaultValuesInsertStatementInput,
  type Dialect,
  type DialectIntrospector,
  type EngineCapabilities,
  type InsertStatementInput,
  type IntrospectOptions,
  type JsonPathEqualsInput,
  type JsonWireRule,
  type LimitOffsetInput,
  type OpenStreamOptions,
  postgresDialect,
  type StreamableConnection,
  type UpsertStatementInput,
} from './dialect.js';
import type { EngineClientConfig } from './engine-config.js';
import {
  ConnectionError,
  malformedConnectionStringMessage,
  markValueBearingMessage,
  TimeoutError,
  TransactionOutcomeUnknownError,
  UnsupportedFeatureError,
  ValidationError,
} from './errors.js';
import {
  applyTableFilters,
  assertDistinctColumnFields,
  compareCatalogNames,
  deriveRelations,
  type ForeignKeyEntry,
  foreignKeyConstraintNames,
  nullRecord,
  type RelationCatalogFacts,
  referentialActionFromCatalog,
} from './introspect.js';
import { consoleLogger, logTo } from './logger.js';
import importOptionalPeer from './optional-peer-import.cjs';
import type { TransactionRecovery } from './pg-types.js';
import {
  type ColumnMetadata,
  type IndexMetadata,
  isDateType,
  type RelationDef,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';
import { rewritePositionalPlaceholders, scanPlaceholders } from './sql-placeholders.js';

// ---------------------------------------------------------------------------
// Minimal structural typing for the mysql2 surface used here
// ---------------------------------------------------------------------------
//
// Typed structurally (not via `import type` from mysql2) so this module stays
// compilable and the shim logic stays decoupled from mysql2's complex generic
// result types. The real mysql2 pool is loaded via a dynamic import in the
// factory and cast to these shapes.

/** A value mysql2 accepts as a bound parameter. */
type MysqlParam = null | number | bigint | string | boolean | Date | Uint8Array;

/** mysql2's `[result, fields]` tuple. `result` is rows (SELECT) or a header (write). */
type Mysql2Result = [unknown, unknown];

interface Mysql2Queryable {
  query(sql: string, values?: unknown): Promise<Mysql2Result>;
  execute(sql: string, values?: unknown): Promise<Mysql2Result>;
}

interface Mysql2Connection extends Mysql2Queryable {
  release(): void;
  /** mysql2/promise exposes its callback connection for incremental results. */
  connection?: unknown;
}

interface Mysql2RawConnection extends Partial<Mysql2Command> {
  query(sql: string, values?: unknown): Mysql2Command;
  execute(sql: string, values?: unknown): Mysql2Command;
  destroy(): void;
  pause(): void;
  resume(): void;
  /** The connection's socket. */
  stream?: { destroy?(): void };
}

type Mysql2Command = Pick<EventEmitter, 'on' | 'removeListener'>;

interface Mysql2Pool extends Mysql2Queryable {
  getConnection(): Promise<Mysql2Connection>;
  end(): Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: mysql2 pool exposes a Node EventEmitter `on`
  on?(event: string, listener: (...args: any[]) => void): unknown;
}

/** Shape of a mysql2 write result header (`ResultSetHeader`). */
interface Mysql2Header {
  affectedRows?: number;
  insertId?: number;
}

// ---------------------------------------------------------------------------
// Value coercion (params in)
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary JS value into something mysql2 can bind. Booleans →
 * 1/0 (MySQL has no boolean type; `TINYINT(1)` stores 1/0), `undefined`/`null`
 * → NULL, `Date`/`Uint8Array` pass through (mysql2 formats them), and any
 * remaining object/array → JSON text (matches how Turbine already pre-serializes
 * JSON filter params). An `in` list element binds through here too, one by one.
 */
function toMysqlParam(value: unknown): MysqlParam {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      // MySQL has no NaN or Infinity: the server stored NaN as 0 without a
      // word, and refused Infinity with a raw driver error.
      if (!Number.isFinite(value)) {
        throw new ValidationError(
          `MySQL cannot store or compare ${value}: a bound number must be finite. Pass a finite number, or null.`,
        );
      }
      return value;
    case 'bigint':
    case 'string':
      return value;
  }
  if (value instanceof Date) {
    // mysql2 renders an Invalid Date as '0000-00-00 00:00:00.000', which the
    // server then reports as that value instead of the caller's mistake.
    if (Number.isNaN(value.getTime())) {
      throw new ValidationError('MySQL cannot bind an Invalid Date. Pass a valid Date, or null.');
    }
    return value;
  }
  if (value instanceof Uint8Array) return value; // also covers Buffer
  return JSON.stringify(value);
}

/**
 * An `in` / `notIn` list, as the builder hands it to the shim: ONE param, so
 * the SQL text and its cache entry stay independent of the list's length (see
 * {@link mysqlDialect.buildInClause}). The shim expands it into one placeholder
 * per element, each bound exactly as an equality operand is, which is what
 * makes `{ in: [v] }` match the rows `{ equals: v }` matches on every column
 * type: a `JSON_TABLE` list compared JSON values, so a boolean, a date or time,
 * a binary value, a decimal or bigint written as a string, and every
 * case-folded string missed, and `notIn` then matched every row.
 */
class MysqlInList {
  constructor(readonly values: readonly unknown[]) {}
}

/** MySQL's limit on placeholders in one prepared statement. */
const MYSQL_MAX_PLACEHOLDERS = 65_535;

/** A list of `n` elements is sent padded to the next power of two (by repeating its last element). */
function paddedListLength(n: number): number {
  return n <= 1 ? n : 2 ** Math.ceil(Math.log2(n));
}

/** The refusal for a placeholder the shim cannot bind (see rewritePositionalPlaceholders). */
function refusePlaceholder(message: string): never {
  throw new ValidationError(message);
}

/** Bounded SQL-only templates. Neither bindings nor list contents are retained. */
const bindingTemplates = new Map<string, { count: number; sql: string; names: string[] }>();

function bindingTemplate(sql: string, count: number): { sql: string; names: string[] } {
  const cached = bindingTemplates.get(sql);
  if (cached?.count === count) return cached;
  // Arity is part of admission: a warmed $2 must still refuse one supplied value.
  const template = {
    count,
    sql: rewritePositionalPlaceholders(sql, 'mysql', count, (i) => `:p${i}`, refusePlaceholder),
    names: Array.from({ length: count }, (_, i) => `p${i + 1}`),
  };
  if (sql.length <= 8192 && count <= 128) {
    if (bindingTemplates.size >= 128) bindingTemplates.delete(bindingTemplates.keys().next().value!);
    bindingTemplates.set(sql, template);
  }
  return template;
}

/**
 * The statement text and named binding for one execution: `$n` placeholders
 * (the spelling `rawUnsafe` documents) rewritten to `:pN`, every
 * {@link MysqlInList} expanded, and every other value bound by name. Mapping by
 * NAME makes binding independent of where each placeholder lands in the SQL
 * text, the same guarantee Postgres' numbered `$N` gives. No wrapper is needed
 * for an empty parameter array. `binding` is
 * `undefined` when nothing is bound, so parameter-less statements (BEGIN,
 * COMMIT, DDL) run through `.query()`.
 */
function bindStatement(
  sql: string,
  values: unknown[],
): { sql: string; binding: Record<string, MysqlParam> | undefined } | undefined {
  if (values.length === 0) return undefined;
  const template = bindingTemplate(sql, values.length);
  const named: Record<string, MysqlParam> = {};
  let lists: Map<string, MysqlInList> | undefined;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const name = i < template.names.length ? template.names[i]! : `p${i + 1}`;
    if (value instanceof MysqlInList) {
      lists ??= new Map();
      lists.set(name, value);
    } else {
      named[name] = toMysqlParam(value);
    }
  }
  if (lists === undefined) return { sql: template.sql, binding: named };
  const expanded = expandInLists(template.sql, lists, named);
  return { sql: expanded, binding: Object.keys(named).length > 0 ? named : undefined };
}

/**
 * Replace each list placeholder (`:p3`) with one placeholder per element
 * (`:p3_0, :p3_1, ...`), binding each element into `named`. An empty list
 * becomes a subquery with no rows, so `IN` is false and `NOT IN` true, as
 * Postgres answers `= ANY('{}')` and `!= ALL('{}')`.
 *
 * Padding to a power of two bounds the statement texts a caller can produce
 * (mysql2 prepares and caches one server-side statement per distinct text and
 * connection, and the server caps the total across every client at
 * `max_prepared_stmt_count`): about seventeen lengths per list instead of one
 * per length. A repeated element changes neither `IN` nor `NOT IN`.
 */
function expandInLists(sql: string, lists: Map<string, MysqlInList>, named: Record<string, MysqlParam>): string {
  const tokens = scanPlaceholders(sql, 'mysql');
  const listTokens = tokens.filter((t) => t.kind === 'named' && lists.has(t.name));
  const others = tokens.length - listTokens.length;
  let padded = 0;
  let exact = 0;
  for (const t of listTokens) {
    const n = lists.get(t.name)!.values.length;
    padded += paddedListLength(n);
    exact += n;
  }
  if (others + exact > MYSQL_MAX_PLACEHOLDERS) {
    throw new ValidationError(
      `An \`in\` / \`notIn\` list on MySQL binds one placeholder per element, and this statement needs ` +
        `${others + exact} where MySQL allows ${MYSQL_MAX_PLACEHOLDERS}. Split the list across several queries.`,
    );
  }
  const pad = others + padded <= MYSQL_MAX_PLACEHOLDERS;
  for (const [name, list] of lists) {
    list.values.forEach((v, j) => {
      named[`${name}_${j}`] = toMysqlParam(v);
    });
  }
  let out = '';
  let last = 0;
  for (const t of listTokens) {
    const n = lists.get(t.name)!.values.length;
    let replacement: string;
    if (n === 0) {
      replacement = 'SELECT NULL FROM DUAL WHERE FALSE';
    } else {
      const parts: string[] = [];
      const length = pad ? paddedListLength(n) : n;
      for (let j = 0; j < length; j++) parts.push(`:${t.name}_${Math.min(j, n - 1)}`);
      replacement = parts.join(', ');
    }
    out += sql.slice(last, t.start) + replacement;
    last = t.end;
  }
  return out + sql.slice(last);
}

// ---------------------------------------------------------------------------
// Result shaping + error translation
// ---------------------------------------------------------------------------

/**
 * mysql2's `MYSQL_TYPE_TINY`. A result field with this type and a display width
 * of 1 IS the `BOOLEAN` / `TINYINT(1)` column; see {@link MYSQL_BOOLEAN_TYPE}.
 */
const MYSQL_FIELD_TYPE_TINY = 1;

/**
 * Turn `TINYINT(1)` cells back into real booleans, in place.
 *
 * MySQL stores a boolean as 1/0 and mysql2 returns the integer. Turbine still
 * generates `ok: boolean` for the column ({@link mysqlTypeToTs}), so
 * `row.ok === true` was false, `JSON.stringify(row)` emitted `1`, and a value
 * the ORM itself wrote as `true` came back as a number.
 *
 * Done from the RESULT FIELDS rather than from mysql2's `typeCast` option on
 * purpose. `typeCast` lives in {@link MYSQL_DRIVER_FLAGS}, which only applies
 * to pools TURBINE builds; an injected mysql2 pool (a supported, documented
 * entry point) would keep returning numbers at the top level while the join
 * strategy's `jsonWireRule` returned booleans, i.e. fixing it there would have
 * created exactly the strategy-dependent split this is meant to close. The
 * field metadata is on every result from every pool.
 *
 * An expression column is never touched: `ok + 0` comes back as
 * MYSQL_TYPE_LONGLONG with a different width, and only an exact
 * (TINY, width 1) field is coerced.
 */
function coerceBooleanColumns(rows: Record<string, unknown>[], fields: unknown): void {
  if (!Array.isArray(fields) || rows.length === 0) return;
  let names: string[] | undefined;
  for (const f of fields as { name?: unknown; columnType?: unknown; columnLength?: unknown }[]) {
    if (!f || f.columnType !== MYSQL_FIELD_TYPE_TINY || f.columnLength !== 1) continue;
    if (typeof f.name !== 'string') continue;
    names ??= [];
    names.push(f.name);
  }
  if (names === undefined || names.length === 0) return;
  for (const row of rows) {
    for (const name of names) {
      const v = row[name];
      if (v === 1 || v === 0) row[name] = v === 1;
    }
  }
}

/** Shape a mysql2 `[result]` into a `pg.QueryResult`-like object. */
function shapeResult(
  result: unknown,
  fields?: unknown,
): {
  rows: Record<string, unknown>[];
  rowCount: number;
  insertId?: number;
  lastID?: number;
} {
  if (Array.isArray(result)) {
    const rows = result as Record<string, unknown>[];
    coerceBooleanColumns(rows, fields);
    return { rows, rowCount: rows.length };
  }
  // Write statement → ResultSetHeader (no rows). Expose insertId/lastID for the
  // `reselect` strategy to re-fetch the auto-increment row.
  const header = (result ?? {}) as Mysql2Header;
  const insertId = header.insertId;
  return { rows: [], rowCount: header.affectedRows ?? 0, insertId, lastID: insertId };
}

/**
 * Augment a mysql2 driver error with the Postgres-shaped `.code` (SQLSTATE) and
 * detail fields that `wrapPgError` understands, so MySQL constraint failures
 * surface as the same typed Turbine errors as Postgres (E008/E009/E010/E011) and
 * deadlock / lock-wait-timeout become retryable (E012/E013). The original mysql2
 * error (with its real message) is preserved as the wrapped error's `.cause`
 * downstream. Returns the value unchanged when it is not a recognizable mysql2
 * error. This only annotates the error; `wrapPgError` (invoked downstream in the query
 * executor / transaction proxy) does the actual translation.
 */
function augmentMysqlError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as { errno?: number; sqlMessage?: string; message?: string };
  if (typeof e.errno !== 'number') return err;

  const target = e as Record<string, unknown>;
  const msg = e.sqlMessage ?? e.message ?? '';

  switch (e.errno) {
    // ER_DUP_ENTRY → unique violation
    case 1062: {
      // "Duplicate entry 'x' for key 'users.email'"
      const m = /for key '([^']+)'/i.exec(msg);
      target.code = '23505';
      if (m?.[1]) {
        const key = m[1];
        const parts = key.split('.');
        target.constraint = parts.length > 1 ? parts[parts.length - 1] : key;
      }
      // THE conflicting row value is in that message, between the quotes after
      // "Duplicate entry". MySQL has no `detail` field, so 'safe' mode had
      // nothing to redact and returned this error verbatim as `.cause`, putting
      // the value into every log line that renders the cause chain. Flag it so
      // the message is withheld in 'safe' mode (see markValueBearingMessage);
      // the constraint NAME survives on `target.constraint` and in the typed
      // UniqueConstraintError's own message, so nothing diagnostic is lost.
      //
      // Deliberately only 1062: the other MySQL codes handled here report
      // column/constraint NAMES only ("Column 'x' cannot be null", "Check
      // constraint 'c' is violated", the FK constraint definition), so flagging
      // them would withhold a message that never carried a value.
      markValueBearingMessage(err);
      return err;
    }
    // ER_ROW_IS_REFERENCED_2 / ER_NO_REFERENCED_ROW_2 → foreign key violation
    case 1451:
    case 1452:
      target.code = '23503';
      return err;
    // ER_BAD_NULL_ERROR / ER_NO_DEFAULT_FOR_FIELD → not-null violation
    case 1048:
    case 1364: {
      const m = /Column '([^']+)'/i.exec(msg);
      target.code = '23502';
      if (m?.[1]) target.column = m[1];
      return err;
    }
    // ER_CHECK_CONSTRAINT_VIOLATED (8.0.16+) / ER_CONSTRAINT_FAILED → check violation
    case 3819:
    case 3813:
      target.code = '23514';
      return err;
    // ER_LOCK_DEADLOCK → deadlock (retryable, maps to pg 40P01)
    case 1213:
      target.code = '40P01';
      return err;
    // ER_LOCK_WAIT_TIMEOUT → treat as a serialization failure (retryable, pg 40001)
    case 1205:
      target.code = '40001';
      return err;
    default: {
      // Data exceptions (a bound value that does not fit the column) take the
      // SQLSTATE class 22 path in `wrapPgError`, which builds a ValidationError
      // naming the column and redacts the value-bearing message in 'safe' mode.
      const sqlstate = mysqlDataExceptionState(e.errno, (e as { sqlState?: unknown }).sqlState, msg);
      if (sqlstate === undefined) return err;
      target.code = sqlstate;
      // "... for column 'name' at row 1", or "... in value for column 't.meta'."
      const column = /for column '([^']+)'/i.exec(msg)?.[1];
      if (column) target.column = column.slice(column.lastIndexOf('.') + 1);
      return err;
    }
  }
}

/**
 * The SQLSTATE a MySQL data exception maps to, or `undefined` when `errno` is
 * not one. MySQL reports several of these under the generic `HY000`, so the
 * common ones are mapped by errno to the code PostgreSQL uses for the same
 * failure; anything else MySQL itself files under class 22 keeps its own code.
 */
function mysqlDataExceptionState(errno: number, sqlState: unknown, message: string): string | undefined {
  switch (errno) {
    case 1406: // ER_DATA_TOO_LONG
      return '22001';
    case 1264: // ER_WARN_DATA_OUT_OF_RANGE
    case 1690: // ER_DATA_OUT_OF_RANGE
      return '22003';
    case 1366: // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: "Incorrect integer value: 'abc' for column ..."
    case 1265: // WARN_DATA_TRUNCATED: a value outside an ENUM, a malformed DECIMAL
      return '22P02';
    case 1292: // ER_TRUNCATED_WRONG_VALUE: an invalid datetime, or a non-numeric string compared as a number
    case 1411: // ER_WRONG_VALUE_FOR_TYPE
      return /\b(?:date|time|datetime|timestamp)\b/i.test(message) ? '22007' : '22P02';
    case 1365: // ER_DIVISION_BY_ZERO
      return '22012';
    case 3140: // ER_INVALID_JSON_TEXT
    case 3141: // ER_INVALID_JSON_TEXT_IN_PARAM
    case 3144: // ER_INVALID_JSON_CHARSET
      return '22032';
  }
  return typeof sqlState === 'string' && /^22[0-9A-Z]{3}$/.test(sqlState) ? sqlState : undefined;
}

// ---------------------------------------------------------------------------
// Driver shim, wrap a mysql2 pool as a PgCompatPool
// ---------------------------------------------------------------------------

/** pg-style query argument: a SQL string or a `{ text, values }` config object. */
type QueryArg = string | { name?: string; text: string; values?: unknown[] };

function normalizeQueryArgs(arg: QueryArg, values?: unknown[]): { text: string; params: unknown[] } {
  if (typeof arg === 'string') return { text: arg, params: values ?? [] };
  return { text: arg.text, params: arg.values ?? values ?? [] };
}

/**
 * Only the bulk INSERT builder knows that its placeholders occur exactly once,
 * in parameter order, with no value expressions or SQL literals between them.
 * Keep its positional driver statement private, keyed by the actual parameter
 * array. The public DeferredQuery still contains the same named SQL. A copied
 * array, edited SQL (including comments), or changed arity uses normal binding.
 * No values or statements outlive the parameter array.
 */
const bulkInsertBindings = new WeakMap<unknown[], { sql: string; positional: string; count: number }>();

/** Arity-only templates: eight entries of at most 8,192 cells, never caller values or identifiers. */
const bulkInsertTuples = new Map<string, { named: string; positional: string }>();

function mysqlParamPlaceholder(index: number): string {
  return `:p${index}`;
}

function bulkTuples(rows: unknown[][]): { named: string; positional: string } {
  const width = rows[0]?.length ?? 0;
  const uniform = rows.every((row) => row.length === width);
  const cacheable = uniform && width > 0 && rows.length * width <= 8192;
  const key = `${rows.length}:${width}`;
  const cached = cacheable ? bulkInsertTuples.get(key) : undefined;
  if (cached) return cached;
  let n = 0;
  const named = rows.map((row) => `(${row.map(() => `:p${++n}`).join(', ')})`).join(', ');
  const positional = uniform
    ? Array(rows.length)
        .fill(`(${Array(width).fill('?').join(', ')})`)
        .join(', ')
    : rows.map((row) => `(${row.map(() => '?').join(', ')})`).join(', ');
  const tuples = { named, positional };
  if (cacheable) {
    if (bulkInsertTuples.size >= 8) bulkInsertTuples.delete(bulkInsertTuples.keys().next().value!);
    bulkInsertTuples.set(key, tuples);
  }
  return tuples;
}

/**
 * Run one statement against a mysql2 queryable (pool or connection). Parameterized
 * statements use `.execute()` (mysql2 server-side prepared statements, cached per
 * connection); parameter-less statements (transaction control, DDL) use `.query()`,
 * since not every such statement can be prepared. Named placeholders are bound via
 * the `{ p1, p2, … }` object built from the positional params.
 */
async function execOne(
  runner: Mysql2Queryable,
  sql: string,
  params: unknown[],
): Promise<ReturnType<typeof shapeResult>> {
  const bulk = bulkInsertBindings.get(params);
  const bound =
    bulk && bulk.sql === sql && bulk.count === params.length && !params.some((v) => v instanceof MysqlInList)
      ? { sql: bulk.positional, binding: Array.from(params, toMysqlParam) }
      : bindStatement(sql, params);
  const binding = bound?.binding;
  try {
    const [result, fields] = binding
      ? await runner.execute(bound!.sql, binding)
      : await runner.query(bound?.sql ?? sql);
    return shapeResult(result, fields);
  } catch (err) {
    throw augmentMysqlError(err);
  }
}

/**
 * Run a statement on a dedicated transaction connection. MySQL cannot take an
 * inline isolation level on `START TRANSACTION`, so {@link mysqlDialect.beginStatement}
 * emits `SET TRANSACTION ISOLATION LEVEL <level>; START TRANSACTION`. mysql2 runs
 * one statement per call (multi-statements stay OFF by design), so split exactly
 * that dialect-generated compound and run the parts in order. Gated on the precise
 * transaction-control prefix, the query builder never emits `SET TRANSACTION
 * ISOLATION LEVEL`, so no builder/user SQL is ever split.
 */
async function runOnConnection(
  conn: Mysql2Connection,
  sql: string,
  params: unknown[],
): Promise<ReturnType<typeof shapeResult>> {
  if (params.length === 0 && /^SET TRANSACTION ISOLATION LEVEL /i.test(sql) && sql.includes('; ')) {
    let last: ReturnType<typeof shapeResult> | undefined;
    for (const part of sql.split('; ')) {
      const trimmed = part.trim();
      if (trimmed) last = await execOne(conn, trimmed, []);
    }
    // The first real statement supplies the result; only an empty split needs
    // a fallback. Do not allocate a discarded row array and result per BEGIN.
    return last ?? shapeResult([]);
  }
  return execOne(conn, sql, params);
}

/**
 * Whether the server answered with `err`: an error packet on a live connection
 * (a numeric `errno`, not fatal), as the error or its cause. A lost or
 * timed-out connection is no answer. So are a shutdown (1053), an interrupted
 * statement (1317) and a killed connection (1927), which can arrive while a
 * COMMIT is being written.
 */
function answeredByServer(err: unknown): boolean {
  for (let e = err, depth = 0; depth < 4 && e !== null && typeof e === 'object'; depth++) {
    const { errno, fatal } = e as { errno?: unknown; fatal?: unknown };
    if (typeof errno === 'number') return errno > 0 && fatal !== true && ![1053, 1317, 1927].includes(errno);
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Close a connection Turbine is discarding, in both directions, so the server
 * ends its session now.
 *
 * mysql2's own `destroy()` is `stream.end()`, a half-close, and it drops the
 * connection from the pool at once. A server still writing a result to a
 * client that stopped reading (a stream returned early) never reads that close,
 * so its session stayed in "Sending to client", holding its metadata lock,
 * until `net_write_timeout`, outside the pool limit. The half-closed client
 * also kept reading: the execute mysql2 queues behind a prepare was sent on the
 * closed socket, and the server's parting error packet arrived as its answer,
 * which mysql2 prints as "got packets out of order".
 *
 * Destroying the socket closes both directions (a reset while unread rows are
 * buffered), which the server sees on its next read or write. mysql2 handles it
 * as any lost connection: queued commands fail, and the pool drops the
 * connection when the socket closes. Nothing waits on this connection any
 * more, so the error mysql2 reports for it is absorbed.
 */
function destroyConnection(raw: Partial<Mysql2RawConnection>): void {
  raw.on?.('error', () => {});
  if (typeof raw.stream?.destroy === 'function') raw.stream.destroy();
  else raw.destroy?.();
}

/** A checked-out connection never queues another statement behind a paused result. */
class MysqlStreamClient implements PgCompatPoolClient {
  private released = false;
  private discarded = false;
  private inTransaction = false;
  private pending = 0;
  private committing = false;
  private deadlineError?: TimeoutError;
  private active?: { close(): Promise<void>; cancel(error: unknown): void };

  constructor(private readonly conn: Mysql2Connection) {}

  private timeoutError(timeout: number, confirmed = false): TimeoutError {
    return new TimeoutError(timeout, 'Transaction', {
      outcome: confirmed ? 'not-executed' : 'unknown',
      message: `Transaction timed out after ${timeout}ms. ${
        confirmed ? 'Rollback was confirmed.' : 'Cancellation and rollback are not confirmed; its outcome is unknown.'
      }`,
    });
  }

  readonly transactionRecovery: TransactionRecovery = {
    assertTimeout: () => {},
    pendingMessage: 'transaction cannot commit; rollback is not yet confirmed. ',
    sessionMessage: 'Your callback did not run; rollback is not yet confirmed.',
    timeoutError: (timeout) => (this.deadlineError = this.timeoutError(timeout)),
    rollback: async (running, send, graceMs) => {
      // mysql2 cannot cancel a running statement. A failed COMMIT response is
      // uncertain even if a later ROLLBACK answers successfully.
      if (running || this.pending || this.committing) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          send().then(
            () => true,
            () => false,
          ),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), graceMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    },
    finish: (state, clean, error, logger) => {
      state.end(clean ? 'was rolled back' : 'ended with an unknown outcome');
      if (!clean && logger)
        logTo(logger, 'debug', 'Transaction ended with an unknown outcome', {
          code: 'transaction-outcome-unknown',
          operation: '$transaction',
        });
      if (clean && this.deadlineError === error && this.deadlineError)
        return this.timeoutError(this.deadlineError.timeoutMs, true);
      // A COMMIT the server did not answer (a lost or timed-out connection)
      // may have committed. An error the server answered with keeps its class.
      return this.committing && !answeredByServer(error) ? new TransactionOutcomeUnknownError(error) : error;
    },
  };

  private assertOpen(): void {
    if (this.released || this.discarded)
      throw new ConnectionError('This MySQL checkout has been released or discarded.');
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    this.pending++;
    try {
      return await this.runQuery(text, values);
    } finally {
      this.pending--;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: see query().
  private async runQuery(text: QueryArg, values?: unknown[]): Promise<any> {
    this.assertOpen();
    const { text: sql, params } = normalizeQueryArgs(text, values);
    if (this.active) {
      if (params.length === 0 && /^\s*(?:COMMIT|ROLLBACK|SAVEPOINT|RELEASE SAVEPOINT)\b/i.test(sql)) {
        await this.active.close();
        this.assertOpen();
      } else
        throw new ValidationError(
          'A MySQL native stream is active on this connection. Close it before another statement.',
        );
    }
    if (sql === 'COMMIT' && params.length === 0) this.committing = true;
    const result = await runOnConnection(this.conn, sql, params);
    if (
      /^\s*(?:(?:SET TRANSACTION ISOLATION LEVEL [A-Z ]+; )?START TRANSACTION|BEGIN)\b/i.test(sql) &&
      params.length === 0
    )
      this.inTransaction = true;
    else if (/^\s*(?:COMMIT|ROLLBACK(?!\s+TO))\b/i.test(sql) && params.length === 0) this.inTransaction = false;
    return result;
  }

  async *streamBatches(
    text: string,
    values: unknown[],
    batchSize: number,
    signal?: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    this.assertOpen();
    if (this.active) throw new ValidationError('A MySQL native stream is already active on this connection.');
    if (this.pending) throw new ValidationError('A MySQL statement is still running on this connection.');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
      throw new ValidationError('Native stream batchSize must be a positive safe integer.');
    signal?.throwIfAborted();
    const raw = this.conn.connection as Mysql2RawConnection | undefined;
    if (
      !raw ||
      typeof raw.destroy !== 'function' ||
      typeof raw.pause !== 'function' ||
      typeof raw.resume !== 'function' ||
      typeof raw.execute !== 'function' ||
      typeof raw.query !== 'function'
    ) {
      throw new UnsupportedFeatureError(
        'native streaming',
        'mysql',
        'The mysql2 callback connection with pause(), resume() and destroy() is required.',
      );
    }
    const bound = bindStatement(text, values);
    let command: Mysql2Command | undefined;
    let fields: unknown;
    let rows: Record<string, unknown>[] = [];
    let wake: (() => void) | undefined;
    const notify = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    let resultSets = 0;
    let complete = false;
    let closed = false;
    let failure: unknown;
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const discard = () => {
      if (this.discarded) return;
      this.discarded = true;
      destroyConnection(raw);
    };
    const onEnd = () => {
      complete = true;
      notify();
      settle();
    };
    const onError = (error: unknown) => {
      if (failure === undefined) failure = augmentMysqlError(error);
      notify();
      settle();
    };
    const onFields = (next: unknown) => {
      if (++resultSets > 1)
        cancel(
          new UnsupportedFeatureError(
            'multiple native stream result sets',
            'mysql',
            'Stream a single row result set per statement.',
          ),
        );
      else fields = next;
    };
    const onRow = (row: unknown) => {
      // Callbackless mysql2 commands never collect rows. Keep exactly one
      // batch here and pause packet decoding until the consumer asks again.
      // ResultSetHeader has no fields and must not become a streamed row.
      if (closed || failure !== undefined || !Array.isArray(fields)) return;
      if (rows.length === batchSize) {
        cancel(new ConnectionError('The MySQL driver exceeded native stream backpressure.'));
        return;
      }
      rows.push(row as Record<string, unknown>);
      if (rows.length === batchSize) {
        raw.pause();
        notify();
      }
    };
    const cancel = (error: unknown) => {
      if (failure === undefined) failure = error;
      closed = true;
      command?.removeListener('result', onRow);
      discard();
      rows = [];
      notify();
      settle();
      signal?.removeEventListener('abort', onAbort);
      if (this.active === state) this.active = undefined;
    };
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        const priorFailure = failure;
        closed = true;
        command?.removeListener('result', onRow);
        rows = [];
        notify();
        if (!complete && failure === undefined) {
          // Callbackless commands do not collect result arrays. Detach delivery
          // and resume the wire to discard a transaction's remainder. Standalone
          // streams can discard their checkout instead of draining.
          if (this.inTransaction) {
            raw.resume();
            await settled;
          } else discard();
        }
        if (failure !== undefined && !complete) discard();
        if (this.active === state) this.active = undefined;
        signal?.removeEventListener('abort', onAbort);
        command?.removeListener('end', onEnd);
        command?.removeListener('fields', onFields);
        if (!this.discarded) raw.removeListener?.('error', onError);
        if (priorFailure === undefined && failure !== undefined) throw failure;
      })());
    const state = { close, cancel };
    this.active = state;
    const onAbort = () => cancel(signal!.reason);
    try {
      // Fatal parser/socket failures can bypass a callbackless command and
      // reach only the connection's error event.
      raw.on?.('error', onError);
      command = bound?.binding ? raw.execute(bound.sql, bound.binding) : raw.query(bound?.sql ?? text);
      command.on('end', onEnd);
      command.on('error', onError);
      command.on('fields', onFields);
      command.on('result', onRow);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      while (true) {
        if (failure !== undefined) throw failure;
        if (closed) throw new ValidationError('This MySQL native stream has been closed.');
        if (rows.length === batchSize || (complete && rows.length > 0)) {
          const batch = rows;
          rows = [];
          coerceBooleanColumns(batch, fields);
          yield batch;
          if (!closed && failure === undefined && !complete) raw.resume();
        } else if (complete) return;
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    } catch (error) {
      if (failure === undefined)
        failure = closed ? new ValidationError('This MySQL native stream has been closed.') : augmentMysqlError(error);
      throw failure;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      await close();
      // A destroyed mysql2 command may still report a late connection error.
      // Keep its harmless error listener until the command is collected.
    }
  }

  release(error?: Error | boolean): void {
    if (this.released) return;
    this.released = true;
    if (this.active) this.active.cancel(new ConnectionError('The MySQL checkout was released during a native stream.'));
    if (!this.discarded) {
      const raw = this.conn.connection as Partial<Mysql2RawConnection> | undefined;
      if ((error || this.pending) && typeof raw?.destroy === 'function') {
        this.discarded = true;
        destroyConnection(raw);
      } else this.conn.release();
    }
  }
}

/**
 * A {@link PgCompatPool} backed by a `mysql2` pool. Non-transaction queries run
 * on the pool directly (any connection); `connect()` checks out a dedicated
 * connection so a transaction's `START TRANSACTION` / `COMMIT` / `ROLLBACK` /
 * `SAVEPOINT` nesting all run on the same physical connection.
 */
export class MysqlPool implements PgCompatPool {
  /** The underlying mysql2 pool, exposed as an escape hatch (seed / DDL / advanced ops). */
  readonly pool: Mysql2Pool;
  private closed = false;

  constructor(pool: Mysql2Pool) {
    this.pool = pool;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape; execOne returns plain objects.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: sql, params } = normalizeQueryArgs(text, values);
    return execOne(this.pool, sql, params);
  }

  async connect(): Promise<PgCompatPoolClient> {
    const conn = await this.pool.getConnection();
    return new MysqlStreamClient(conn);
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// Type mapping (MySQL data type → TypeScript)
// ---------------------------------------------------------------------------

/**
 * Map a MySQL column type to a TypeScript type. `dialectType` is the
 * `information_schema.COLUMNS.DATA_TYPE` (e.g. `bigint`, `varchar`, `datetime`);
 * `columnType` is the full `COLUMN_TYPE` (e.g. `tinyint(1)`, `enum('a','b')`)
 * used to detect `TINYINT(1)` booleans.
 */
export function mysqlTypeToTs(dialectType: string, nullable: boolean, columnType?: string): string {
  const t = dialectType.toLowerCase();
  const full = (columnType ?? '').toLowerCase();
  let base: string;
  // `tinyint(1)` can arrive either way: as (DATA_TYPE, COLUMN_TYPE) from the
  // introspector's first pass, or as a single dialect type, because that is the
  // spelling the introspector RECORDS for a boolean column (see the note there)
  // and the `typeToTypeScript` dialect hook passes only the one string.
  if (t === MYSQL_BOOLEAN_TYPE || (t === 'tinyint' && full === MYSQL_BOOLEAN_TYPE)) base = 'boolean';
  else if (/^(tinyint|smallint|mediumint|int|integer|bigint)$/.test(t)) base = 'number';
  else if (/^(decimal|numeric)$/.test(t)) base = 'string';
  else if (/^(float|double|real)$/.test(t)) base = 'number';
  else if (/^(datetime|timestamp|date)$/.test(t)) base = 'Date';
  else if (t === 'json') base = 'unknown';
  else if (/(blob|binary|varbinary)/.test(t)) base = 'Uint8Array';
  else if (/(char|text|enum|set|time|year|bit)/.test(t)) base = 'string';
  else base = 'unknown';
  return nullable ? `${base} | null` : base;
}

/**
 * The dialect-type spelling Turbine records for a MySQL boolean column.
 *
 * MySQL has no boolean type: `BOOLEAN` is an alias for `TINYINT(1)`, and
 * `information_schema` reports DATA_TYPE `tinyint` for it, which is the same
 * DATA_TYPE a genuine one-byte integer column has. The display width in
 * COLUMN_TYPE is the ONLY thing that separates them, so the introspector keeps
 * the full spelling for this one type rather than the bare DATA_TYPE. Anything
 * reading a dialect type has to accept both spellings; the two places that
 * matter are {@link mysqlTypeToTs} and {@link mysqlDialect.jsonWireRule}.
 */
const MYSQL_BOOLEAN_TYPE = 'tinyint(1)';

/** Integer column types narrower than 64 bits, in MySQL and code-first (PostgreSQL) spellings. */
const SMALL_INTEGER_TYPES: ReadonlySet<string> = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'int2',
  'int4',
  'serial',
  'smallserial',
]);

/**
 * Rewrite every boolean column's recorded dialect type to
 * {@link MYSQL_BOOLEAN_TYPE}, returning a schema that is safe to key
 * {@link mysqlDialect.jsonWireRule} on.
 *
 * WHY. Only the join strategy consults the recorded type, so a column whose
 * type is spelled some other way reads as a boolean at the top level (the shim
 * decides that from the RESULT FIELDS, which every pool has) and as 1/0 through
 * a `with` join, which is the strategy-dependent split the boolean rule exists
 * to close. Two schemas spell it differently and neither is wrong:
 *
 *  - a metadata file generated before Turbine started keeping the display width
 *    records the bare DATA_TYPE `tinyint` (with `tsType: 'boolean'`, which is
 *    what identifies it), so `turbine generate` is NOT required to get the fix;
 *  - a code-first `defineSchema` column records the Postgres spelling
 *    `boolean` / `bool`, which the DDL generator already emits as `TINYINT(1)`.
 *
 * A genuine one-byte integer column is never touched: it carries
 * `tsType: 'number'`, and the `tsType` is the gate. Copy-on-write, because the
 * argument is usually a shared exported constant and may also be handed to
 * another engine's factory; an already-correct schema is returned unchanged and
 * pays nothing.
 */
function normalizeBooleanDialectTypes(schema: SchemaMetadata): SchemaMetadata {
  const needsFix = (col: ColumnMetadata): boolean => {
    if (!/^boolean\b/.test(col.tsType)) return false;
    const recorded = (col.dialectType ?? col.pgType ?? '').toLowerCase();
    return recorded === 'tinyint' || recorded === 'bool' || recorded === 'boolean';
  };
  let tables: Record<string, TableMetadata> | undefined;
  for (const [name, table] of Object.entries(schema.tables)) {
    if (!table.columns.some(needsFix)) continue;
    const columns = table.columns.map((col) =>
      needsFix(col) ? { ...col, dialectType: MYSQL_BOOLEAN_TYPE, pgType: MYSQL_BOOLEAN_TYPE } : col,
    );
    if (!tables) tables = { ...schema.tables };
    tables[name] = {
      ...table,
      columns,
      pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    };
  }
  return tables ? { ...schema, tables } : schema;
}

/** Is a MySQL declared type a date/time type (so values coerce back to `Date`)? */
function isMysqlDateType(dialectType: string): boolean {
  const t = dialectType.toLowerCase();
  return isDateType(t) || /^(datetime|timestamp|date)$/.test(t);
}

/** Map a schema-builder (Postgres-flavored) column type to MySQL DDL. */
function mysqlColumnType(type: string, maxLength?: number | null): string {
  // An enum column's type from `buildEnumColumn`, already spelled for MySQL. It
  // returns first: its labels are free text, and one named `int` or `date`
  // would otherwise match a pattern below.
  if (/^ENUM\(/.test(type)) return type;
  const t = type.toUpperCase();
  if (/BIGSERIAL/.test(t)) return 'BIGINT AUTO_INCREMENT';
  if (/SERIAL/.test(t)) return 'INT AUTO_INCREMENT';
  if (/BIGINT|INT8/.test(t)) return 'BIGINT';
  if (/SMALLINT|INT2/.test(t)) return 'SMALLINT';
  if (/INTEGER|INT4|\bINT\b/.test(t)) return 'INT';
  if (/BOOL/.test(t)) return 'TINYINT(1)';
  if (/DOUBLE|FLOAT8/.test(t)) return 'DOUBLE';
  if (/REAL|FLOAT4|FLOAT/.test(t)) return 'FLOAT';
  if (/NUMERIC|DECIMAL|MONEY/.test(t)) return 'DECIMAL(65,30)';
  if (/JSONB|JSON/.test(t)) return 'JSON';
  if (/UUID/.test(t)) return 'CHAR(36)';
  // DATETIME(3), not bare DATETIME: the bare type has zero fractional digits and
  // rounds a JS Date's milliseconds away on write.
  if (/TIMESTAMPTZ|TIMESTAMP|DATETIME/.test(t)) return 'DATETIME(3)';
  if (/\bDATE\b/.test(t)) return 'DATE';
  if (/\bTIME\b/.test(t)) return 'TIME';
  // A bounded binary column is VARBINARY(n): a BLOB cannot be a key.
  if (/VARBINARY/.test(t)) return `VARBINARY(${maxLength ?? 255})`;
  if (/BYTEA|BLOB/.test(t)) return maxLength != null ? `VARBINARY(${maxLength})` : 'BLOB';
  if (/VARCHAR/.test(t)) return maxLength != null ? `VARCHAR(${maxLength})` : 'VARCHAR(255)';
  if (/CHAR/.test(t)) return maxLength != null ? `CHAR(${maxLength})` : 'CHAR(255)';
  if (/TEXT|CLOB/.test(t)) return 'TEXT';
  if (/ENUM/.test(t)) return 'TEXT';
  return type;
}

// ---------------------------------------------------------------------------
// mysqlDialect, the full Dialect contract for MySQL 8
// ---------------------------------------------------------------------------

/** The row alias a multi-row upsert gives its incoming rows (`AS ... ON DUPLICATE KEY UPDATE`). */
const MYSQL_INCOMING_ALIAS = '`turbine_excluded`';

/**
 * The LIKE escape character on MySQL (see `mysqlDialect.likeEscapeCharacter`).
 * One character, nothing special inside a single-quoted literal in either
 * `sql_mode`, and not a LIKE metacharacter.
 */
const MYSQL_LIKE_ESCAPE = '!';
/** The LIKE metacharacters under {@link MYSQL_LIKE_ESCAPE}: itself, `%` and `_`. */
const MYSQL_LIKE_META_G = /[!%_]/g;

/**
 * A `JSON_OBJECT` key as SQL text that reads the same in every `sql_mode`.
 * A key without a backslash is a plain quoted literal. A backslash has no
 * literal spelling that both modes agree on (`'a\\b'` is one backslash by
 * default and two under `NO_BACKSLASH_ESCAPES`, which Turbine's own
 * connections set and a caller-supplied pool may not), so such a key is
 * written as its UTF-8 bytes in hex, which no mode re-reads.
 */
function mysqlKeyLiteral(key: string, dialect: Pick<Dialect, 'escapeStringLiteral'>): string {
  if (!key.includes('\\')) return `'${dialect.escapeStringLiteral(key)}'`;
  let hex = '';
  for (const byte of new TextEncoder().encode(key)) hex += byte.toString(16).padStart(2, '0');
  return `CONVERT(X'${hex}' USING utf8mb4)`;
}

/**
 * MySQL 8 implementation of the {@link Dialect} contract. Backtick identifier
 * quoting, named `:pN` placeholders (NOT positional `?`, see the module
 * docstring), `JSON_OBJECT` / `JSON_ARRAYAGG` for the single-query nested
 * relation engine (`CAST(… AS JSON)`-wrapped nested subresults), no `RETURNING`
 * (`resultStrategy = 'reselect'`), `INSERT … ON DUPLICATE KEY UPDATE` upserts,
 * and the Postgres-only capabilities disabled (vector / LISTEN-NOTIFY / RLS).
 */
export const mysqlDialect: Dialect = {
  ...postgresDialect,
  name: 'mysql',
  capabilities: Object.freeze({
    distinctOn: false,
    tupleCursorPredicate: false,
    positionalJson: false,
    jsonObjectKeysAsWritten: false,
    nullsOrderingClause: false,
    nullsSortHigh: false,
    insensitiveInList: false,
    jsonDocumentEquality: 'exact',
    jsonExtractTyped: false,
    jsonExactNumericCast: false,
    numericTextComparison: true,
    enforcesForeignKeys: true,
    partitionLimitPushdown: false,
    // A zone-less literal reads in the session time zone; only `date` columns rewrite.
    utcTimestampRewrite: false,
    paramTypeCasts: false,
    namedEnumTypes: false,
    structuredValueColumns: 'scalars-and-text',
    // Counted in a 16-bit field.
    maxBindParameters: 65535,
    maxInsertRows: Number.POSITIVE_INFINITY,
    chunkBindParameters: 65535,
    upsertConflictTarget: 'any-unique-key',
    setClauseOrder: 'left-to-right',
    reselectLocksRows: true,
    integerDivision: 'DIV',
    updateExpressions: true,
    // Caught by the onConflict re-read, which runs in the reselect transaction.
    bulkUpsertAppliesRepeatedKeys: true,
    // A skipped row is a no-op ON DUPLICATE KEY UPDATE, counted under FOUND_ROWS.
    skipDuplicatesCountsSkipped: true,
    readOnlyTransactions: true,
    connectionParameters: false,
    backendCancel: false,
    idleTransactionTimeout: false,
    abortsTransactionOnError: false,
    classifiesCommitAnswer: false,
    connectionDriver: 'engine-driver',
    // mysql2 execute() prepares each statement text; max_prepared_stmt_count caps them server-wide.
    preparesEveryStatement: true,
    statementSyntax: 'mysql',
    // An inline REFERENCES is parsed and ignored.
    inlineForeignKeys: false,
    // TEXT / BLOB need a prefix length in a key (ER_BLOB_KEY_WITHOUT_LENGTH).
    unboundedTextKeys: false,
  } satisfies EngineCapabilities),
  // No RETURNING → run the write, then re-SELECT by PK/where.
  resultStrategy: 'reselect',
  supportsReturning: false,
  // `ON DUPLICATE KEY UPDATE` has no predicate slot, so `buildUpsertStatement`
  // below cannot emit `input.updateWhere`. Reporting false keeps the builder
  // from compiling one (and from binding its now-orphaned parameters).
  supportsUpsertUpdateWhere: false,
  supportsILike: false,
  supportsVector: false,
  // MySQL full-text is `MATCH(col) AGAINST(...)` over a FULLTEXT index: a
  // different surface with different semantics, not the emitted tsvector form.
  supportsFullTextSearch: false,
  // No array column type (a JSON column is not an array column).
  supportsArrayColumns: false,
  supportsListenNotify: false,
  supportsRLS: false,
  // MySQL 8.0.14+ supports LATERAL, but the opt-in lateral pick plan stays
  // Postgres-only in this release (flipping it on is a one-line change + tests).
  supportsLateralJoin: false,
  supportsPlanCacheMode: false,
  // FOR UPDATE / FOR SHARE (8.0); there is no NO KEY UPDATE or KEY SHARE.
  rowLockModes: ['update', 'share'],
  // No percentile_cont / percentile_disc.
  supportsPercentileAggregates: false,
  // INSERT ... AS alias ON DUPLICATE KEY UPDATE, with the refusals that
  // keyless conflict resolution needs.
  supportsBulkUpsert: true,
  // GET_LOCK / RELEASE_LOCK exist (used by a future migrate adapter).
  supportsAdvisoryLock: true,
  // Plain `EXPLAIN` (one row of tabular plan columns) works on every supported
  // MySQL 8.0.x; the readable `FORMAT=TREE` variant only exists from 8.0.16 and
  // the engine floor here is 8.0.0. Plan text is a diagnostic, not a contract.
  explainQuery: { prefix: 'EXPLAIN' },
  // JSON_ARRAYAGG has no inline ORDER BY argument → force the inner-subquery
  // rewrite for every ordered to-many relation.
  aggSupportsInlineOrderBy: false,
  // mysql2's binary (prepared) protocol sends JS numbers as DOUBLE, which MySQL's
  // LIMIT/OFFSET reject ("Incorrect arguments to mysqld_stmt_execute"). Render
  // pagination as inline integer literals (Turbine-validated, injection-safe).
  inlineLimitOffset: true,
  jsonPathSupport: 'function',
  emptyJsonArrayLiteral: 'JSON_ARRAY()',
  nullJsonLiteral: 'NULL',

  // Named placeholders (`:p1`, `:p2`, …), NOT positional `?`. Turbine pushes
  // params in 1-indexed generation order but may EMIT them in a different SQL
  // text position; positional `?` mis-binds. mysql2 named parameters bind by
  // name, so `:pN` ↔ `params[N-1]` mirrors Postgres' `$N` regardless of text
  // order. The driver shim binds via a `{ p1, p2, … }` object.
  paramPlaceholder: mysqlParamPlaceholder,

  quoteIdentifier(name: string): string {
    return `\`${name.replace(/`/g, '``')}\``;
  },

  /**
   * MySQL is NOT Postgres here: unless the server runs with
   * `NO_BACKSLASH_ESCAPES`, `\` is an escape character inside a string literal,
   * so doubling only `'` (the inherited Postgres rule) leaves a value ending in
   * a backslash able to escape its own closing quote. Escape the backslash
   * first, then the quote; every other byte is safe raw.
   *
   * That is right for the server's default `sql_mode` only: under
   * `NO_BACKSLASH_ESCAPES` (which Turbine sets on the connections it opens) the
   * doubled backslash reads as two. So `buildJsonObject`, the one caller, never
   * hands it a key holding a backslash (see {@link mysqlKeyLiteral}).
   */
  escapeStringLiteral(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
  },

  buildJsonObject(pairs: [key: string, expr: string][]): string {
    const args = pairs.map(([key, expr]) => `${mysqlKeyLiteral(key, this)}, ${expr}`);
    return `JSON_OBJECT(${args.join(', ')})`;
  },

  // JSON_ARRAYAGG over an empty group returns NULL → COALESCE to JSON_ARRAY().
  // The orderBy argument is ignored (MySQL's JSON_ARRAYAGG has no ORDER BY arg);
  // aggSupportsInlineOrderBy=false guarantees the builder never passes one.
  buildJsonArrayAgg(jsonObjectExpr: string): string {
    return `COALESCE(JSON_ARRAYAGG(${jsonObjectExpr}), JSON_ARRAY())`;
  },

  /**
   * Wrap a nested correlated subquery for embedding inside a parent `JSON_OBJECT`.
   * MySQL double-encodes a scalar subquery result as a JSON *string* unless it is
   * explicitly typed JSON, so `CAST((subquery) AS JSON)` forces the nested value
   * to be embedded as real JSON (objects/arrays), not a quoted string, the same
   * intent as SQLite's `json(...)` wrap. The fallback (`JSON_ARRAY()` / `NULL`) is
   * already JSON-typed.
   */
  wrapJsonSubresult(subquery: string, fallback: string): string {
    return `COALESCE(CAST((${subquery}) AS JSON), ${fallback})`;
  },

  // MySQL aggregate casts: COUNT → SIGNED (BIGINT, comes back as a JS number when
  // safe), AVG/float → DECIMAL (string, the aggregate transform Number()-coerces).
  jsonWireRule(columnType: string): JsonWireRule | undefined {
    const t = columnType.toLowerCase();

    // JSON_OBJECT renders these as JSON numbers, which are IEEE doubles, so a
    // relation read through the join strategy disagreed with a top-level read
    // and with the batched loader, LOSSILY. Measured: BIGINT 9007199254740993
    // came back 9007199254740992, and DECIMAL '1000.50' came back 1000.5.
    // mysql2 hands both back as STRINGS at top level (supportBigNumbers, and
    // DECIMAL is always a string), so carry the text and keep it.
    // `int8` is the spelling a code-first (`defineSchema`) schema records for
    // the same BIGINT column, so it needs the same rule.
    if (t === 'bigint' || t === 'int8') {
      return {
        sql: (ref) => `CAST(${ref} AS CHAR)`,
        decode: (value) => {
          // Same policy as the driver's supportBigNumbers/bigNumberStrings:false.
          if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return value;
          const asNumber = Number(value);
          return Number.isSafeInteger(asNumber) ? asNumber : value;
        },
      };
    }
    if (t === 'decimal' || t === 'numeric') {
      return { sql: (ref) => `CAST(${ref} AS CHAR)`, decode: (value) => value };
    }

    // A boolean is 1/0 on the wire, and the driver shim turns that back into
    // true/false on every direct read (see coerceBooleanColumns). JSON_OBJECT
    // renders the same column as a JSON number and has no column metadata to
    // consult, so without this the join strategy alone would keep returning
    // 1/0: the same strategy-dependent type flip the json rule below exists to
    // prevent. Carried as text because the decode half only runs on a string
    // cell, and a plain CAST is enough here (unlike SQLite, MySQL enforces the
    // column type, so the value is always an integer and `Number` reproduces
    // the driver's own reading of anything that is not 0 or 1).
    if (t === MYSQL_BOOLEAN_TYPE) {
      return {
        sql: (ref) => `CAST(${ref} AS CHAR)`,
        decode: (value) => {
          if (value === '1') return true;
          if (value === '0') return false;
          if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return value;
          return Number(value);
        },
      };
    }

    // A `json` column gets NO rule, and that is the fix rather than the absence
    // of one. It used to read differently depending on the relation strategy:
    // the driver handed back text while JSON_OBJECT, which knows the column is
    // JSON, embedded it as a real nested value, so parsing the row yielded an
    // object. Under the default `'auto'` the strategy is decided per query by
    // row counts and index coverage, so adding a `limit` to
    // `findMany({ with: { org: true } })` flipped `org.meta` from a string to
    // an object with no other change.
    //
    // A `CAST(… AS CHAR)` carrier closes that, but only for a pool Turbine
    // built: the text half of it came from a `typeCast` override in
    // MYSQL_DRIVER_FLAGS, and an injected mysql2 pool (a documented entry
    // point) never sees those flags, so it read the column as an object at the
    // top level and as a string through the join. That trades one split for
    // another. So the agreement is built on what BOTH pool shapes already do:
    // mysql2 parses a `json` column by default, JSON_OBJECT embeds it parsed,
    // and with the `typeCast` override gone every read path lands on the same
    // parsed value. It is also what `pg` returns for json/jsonb, so this is
    // Postgres parity rather than a MySQL convention.
    //
    // Contrast SQLite, which has no JSON column type and stores the document as
    // text: its driver shim parses the text back for a column the schema
    // declares json/jsonb, and its own rule does the same through a join.

    // Binary columns are worse than lossy: JSON_OBJECT emits MySQL's internal
    // `base64:type15:…` marker string, so the caller got that text instead of
    // bytes. Carry hex and rebuild the buffer.
    if (t === 'binary' || t === 'varbinary' || t.endsWith('blob')) {
      return {
        sql: (ref) => `HEX(${ref})`,
        decode: (value) => (typeof value === 'string' ? Uint8Array.from(Buffer.from(value, 'hex')) : value),
      };
    }

    return undefined;
  },

  castAggregate(expr: string, target: 'int' | 'float'): string {
    return `CAST(${expr} AS ${target === 'int' ? 'SIGNED' : 'DECIMAL(65,30)'})`;
  },

  // AVG over an integer column is a DECIMAL with only four more digits of
  // scale (div_precision_increment), so 4/3 came back 1.3333 where PostgreSQL
  // returns 1.3333333333333333. Adding a DOUBLE zero averages in DOUBLE (the
  // `CAST(... AS DOUBLE)` spelling needs 8.0.17; the engine floor is 8.0.0).
  // BIGINT keeps its exact DECIMAL average, like PostgreSQL's numeric one.
  averageArgument(columnRef: string, columnType: string): string | undefined {
    return SMALL_INTEGER_TYPES.has(columnType.toLowerCase()) ? `(${columnRef} + 0E0)` : undefined;
  },

  // MySQL has no bare OFFSET: the grammar requires a LIMIT for OFFSET to
  // attach to, so `offset` without `limit` (valid on Postgres, which the
  // default path is written for) is a syntax error here. The MySQL manual's
  // own idiom for "from this offset to the end" is a LIMIT of
  // 18446744073709551615 (2^64-1). The other shapes emit byte-identically to
  // the default path. Values arrive as inlined validated-integer literals
  // (inlineLimitOffset), so this only concatenates text the builder already
  // vetted.
  buildLimitOffset(input: LimitOffsetInput): string {
    const { limitPlaceholder, offsetPlaceholder } = input;
    if (limitPlaceholder === undefined && offsetPlaceholder === undefined) return '';
    if (limitPlaceholder === undefined) return ` LIMIT 18446744073709551615 OFFSET ${offsetPlaceholder}`;
    let s = ` LIMIT ${limitPlaceholder}`;
    if (offsetPlaceholder !== undefined) s += ` OFFSET ${offsetPlaceholder}`;
    return s;
  },

  // No array params in MySQL. The list is ONE builder param (a MysqlInList),
  // so the SQL text and its cache entry do not depend on the list's length; the
  // shim expands the placeholder into one per element when the statement runs
  // (see expandInLists). Each element binds as an equality operand does, so the
  // list compares under the column's own type and collation rules.
  buildInClause(expr: string, paramRef: string, negated: boolean): string {
    return `${expr} ${negated ? 'NOT IN' : 'IN'} (${paramRef})`;
  },

  inClauseParam(values: unknown[]): unknown {
    return new MysqlInList(Array.isArray(values) ? values : []);
  },

  // No RETURNING, resultStrategy 'reselect' re-fetches the row.
  buildReturningClause(): string {
    return '';
  },

  buildInsertStatement(input: InsertStatementInput): string {
    return `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})`;
  },

  buildBulkInsertStatement(input: BulkInsertStatementInput): BuiltStatement {
    const standard = this.paramPlaceholder === mysqlParamPlaceholder;
    let next = 0;
    const tuples = standard
      ? bulkTuples(input.rowValues)
      : {
          named: input.rowValues
            .map((row) => `(${row.map(() => this.paramPlaceholder(++next)).join(', ')})`)
            .join(', '),
          positional: '',
        };
    // skipDuplicates → no-op ON DUPLICATE KEY UPDATE (keeps the existing row).
    const firstCol = input.columns[0] ?? '`id`';
    const conflict = input.skipDuplicates ? ` ON DUPLICATE KEY UPDATE ${firstCol} = ${firstCol}` : '';
    const prefix = `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES `;
    const sql = `${prefix}${tuples.named}${conflict}`;
    const params: unknown[] = [];
    for (const row of input.rowValues) for (const value of row) params.push(value);
    if (standard && params.length > 0)
      bulkInsertBindings.set(params, {
        sql,
        positional: `${prefix}${tuples.positional}${conflict}`,
        count: params.length,
      });
    return { sql, params };
  },

  buildBulkUpsertStatement(input: BulkUpsertStatementInput): BuiltStatement {
    // 8.0.19's row alias (`VALUES(col)` is deprecated since 8.0.20). There is
    // no conflict target: ON DUPLICATE KEY UPDATE fires on whichever unique key
    // a row violates, which is why the builder refuses a table where another
    // key's columns are in the data, and why it refuses `ignore` and a
    // conflict predicate (this grammar has no slot for one).
    if (!input.update) {
      throw new UnsupportedFeatureError(
        'createMany onConflict { ignore: true }',
        'mysql',
        'MySQL cannot tell the inserted rows from the skipped ones afterwards; use onConflict: { target, update }.',
      );
    }
    let n = 0;
    const tuples = input.rowValues.map((row) => `(${row.map(() => this.paramPlaceholder(++n)).join(', ')})`).join(', ');
    const params = input.rowValues.flat();
    const update = input.update(params, { target: input.table, incoming: MYSQL_INCOMING_ALIAS });
    if (update.where) {
      throw new UnsupportedFeatureError(
        'A predicate on createMany onConflict',
        'mysql',
        'ON DUPLICATE KEY UPDATE has no WHERE slot.',
      );
    }
    return {
      sql:
        `INSERT INTO ${input.table} (${input.columns.join(', ')}) VALUES ${tuples} AS ${MYSQL_INCOMING_ALIAS} ` +
        `ON DUPLICATE KEY UPDATE ${update.setClauses.join(', ')}`,
      params,
    };
  },

  buildDefaultValuesInsertStatement(input: DefaultValuesInsertStatementInput): string {
    // MySQL is the one engine whose empty `VALUES ()` tuple is legal, and it
    // repeats for any row count, so this is the same statement the column-driven
    // builders already emitted for an empty `data`.
    if (input.skipDuplicates) {
      // `ON DUPLICATE KEY UPDATE` needs a column to assign, and there is no
      // column here. `INSERT IGNORE` would swallow unrelated errors too, so
      // refuse rather than quietly change what the flag means.
      throw new UnsupportedFeatureError(
        'createMany({ data: [{}, …], skipDuplicates: true })',
        'mysql',
        'MySQL ON DUPLICATE KEY UPDATE needs a column assignment, and rows of pure defaults name none; ' +
          'supply the conflict column in each row.',
      );
    }
    const tuples = Array.from({ length: input.rowCount }, () => '()').join(', ');
    return `INSERT INTO ${input.table} () VALUES ${tuples}`;
  },

  buildUpsertStatement(input: UpsertStatementInput): string {
    // MySQL ignores the explicit conflict target, ON DUPLICATE KEY UPDATE keys
    // off the table's PK/unique indexes. The `where`-derived conflictColumns
    // (input.conflictColumns) must therefore correspond to a real unique/PK index
    // for the upsert to target the intended row.
    return (
      `INSERT INTO ${input.table} (${input.insertColumns.join(', ')}) VALUES (${input.valuePlaceholders.join(', ')})` +
      ` ON DUPLICATE KEY UPDATE ${input.updateSetClauses.join(', ')}`
    );
  },

  buildInsensitiveLike(column: string, paramRef: string): string {
    // Deterministic case-insensitive match. NOTE: LOWER(col) can defeat an index
    // unless a functional/generated index exists.
    return `LOWER(${column}) LIKE LOWER(${paramRef})`;
  },

  /**
   * `!`, not `\`: with the server's default `sql_mode` a backslash escapes
   * inside a string literal, so the `ESCAPE '\'` every other engine emits is an
   * unterminated string here, and only a session running with
   * `NO_BACKSLASH_ESCAPES` reads it as one backslash. Turbine sets that mode on
   * the connections it opens, never on a pool the caller supplies (it would
   * change how the caller's own SQL parses), so the clause has to mean the same
   * thing in both modes, and `'!'` does. The operand is bound, so a backslash in
   * the VALUE is a plain character under this escape.
   */
  likeEscapeCharacter: MYSQL_LIKE_ESCAPE,

  /** Prefix `%`, `_` and the escape character itself with {@link MYSQL_LIKE_ESCAPE}. */
  escapeLikePattern(value: string): string {
    return value.replace(MYSQL_LIKE_META_G, `${MYSQL_LIKE_ESCAPE}$&`);
  },

  buildJsonContains(column: string, paramRef: string): string {
    return `JSON_CONTAINS(${column}, ${paramRef})`;
  },

  buildJsonPathExtract(column: string, pathParamRef: string): string {
    return `JSON_UNQUOTE(JSON_EXTRACT(${column}, ${pathParamRef}))`;
  },

  // MySQL compares two JSON values by JSON type and value, so binding the
  // operand as JSON text makes `{ path, equals }` exact for every shape:
  // 5 vs "5" and true vs 1 differ, 5 equals 5.0, null matches JSON null, and
  // arrays and objects compare structurally (object key order does not matter).
  // A missing path extracts SQL NULL, which matches nothing. With no path the
  // whole document is compared.
  buildJsonPathEquals(input: JsonPathEqualsInput): string {
    const { value } = input;
    const text = typeof value === 'bigint' ? value.toString() : JSON.stringify(value);
    const lhs = input.pathRef === undefined ? input.column : `JSON_EXTRACT(${input.column}, ${input.pathRef})`;
    return `${lhs} = CAST(${input.bind(text)} AS JSON)`;
  },

  // ---- Type mapping -------------------------------------------------------

  typeToTypeScript(dialectType: string, nullable: boolean): string {
    return mysqlTypeToTs(dialectType, nullable);
  },

  // MySQL has no true array columns; bulk insert uses multi-row VALUES, so no
  // array cast is ever needed. Disables the UNNEST path.
  arrayType: undefined,

  // ---- DDL ----------------------------------------------------------------

  buildColumnType(input: ColumnTypeInput): string {
    return mysqlColumnType(input.type, input.maxLength);
  },

  /**
   * MySQL declares an enum's labels on the column, `ENUM('a', 'b')`, which
   * refuses any other value in strict mode. A label's quotes are doubled. A
   * label holding a backslash is refused: whether `\` escapes in a string
   * literal depends on the session's NO_BACKSLASH_ESCAPES (Turbine's own
   * connections set it, other clients do not), so the same DDL would declare
   * a different label depending on what runs it.
   */
  buildEnumColumn(column: string, labels: readonly string[]): { type: string } {
    const literals = labels.map((label) => {
      if (label.includes('\\')) {
        throw new ValidationError(
          `The enum label ${JSON.stringify(label)} on column ${column} holds a backslash, which MySQL reads ` +
            'differently with and without NO_BACKSLASH_ESCAPES. Use a label without one.',
        );
      }
      return `'${label.replace(/'/g, "''")}'`;
    });
    return { type: `ENUM(${literals.join(', ')})` };
  },

  buildColumnDefinition(input: ColumnDefinitionInput): string {
    const isSerial = /serial/i.test(input.type);
    const parts: string[] = [input.name, this.buildColumnType(input)];
    // AUTO_INCREMENT columns must be a key; emit PRIMARY KEY inline for a serial PK.
    if (input.primaryKey) parts.push('PRIMARY KEY');
    else if (input.unique) parts.push('UNIQUE');
    if (input.notNull && !isSerial && !input.primaryKey) parts.push('NOT NULL');
    if (input.defaultValue != null) parts.push(`DEFAULT ${input.defaultValue}`);
    if (input.references) parts.push(`REFERENCES ${input.references.table}(${input.references.column})`);
    return parts.join(' ');
  },

  buildCreateIndexStatement(input: CreateIndexStatementInput): string {
    return `CREATE INDEX ${input.name} ON ${input.table}(${input.columns.join(', ')});`;
  },

  buildCreateTableStatement(input: CreateTableStatementInput): string {
    const body = input.definitions.map((d) => `    ${d}`).join(',\n');
    return `CREATE TABLE ${input.table} (\n${body}\n);`;
  },

  // ---- Migration tracking -------------------------------------------------
  // SelectApplied / UpdateChecksum / DeleteApplied inherit from postgresDialect:
  // they call `this.paramPlaceholder(n)` (→ `:pN`) and standard SQL, all valid
  // MySQL. The tracking-table DDL and the upsert INSERT need MySQL forms.

  buildMigrationTrackingTable(table: string): string {
    return `
  CREATE TABLE IF NOT EXISTS ${table} (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    checksum VARCHAR(255) NOT NULL,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`;
  },

  buildMigrationInsertApplied(table: string): string {
    return `INSERT INTO ${table} (name, checksum) VALUES (${this.paramPlaceholder(1)}, ${this.paramPlaceholder(2)}) ON DUPLICATE KEY UPDATE name = name`;
  },

  // ---- Transaction control ------------------------------------------------

  beginStatement(isolationLevel?: string): string {
    // MySQL cannot take an inline isolation level on START TRANSACTION. The
    // driver shim (runOnConnection) splits this exact compound and runs the
    // parts in order on the same connection.
    return isolationLevel
      ? `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}; START TRANSACTION`
      : 'START TRANSACTION';
  },

  buildSetSessionConfig(): BuiltStatement {
    // Never reached: supportsRLS=false makes $transaction throw before calling
    // this. Guarded here too so a misuse fails loudly rather than emitting GUC SQL.
    throw new UnsupportedFeatureError(
      'sessionContext (RLS session GUCs)',
      'mysql',
      'MySQL has no transaction-local GUCs / set_config equivalent.',
    );
  },

  // ---- Streaming ----------------------------------------------------------

  /** Incremental mysql2 consumption; query-only connections cannot stream. */
  async *openStream(
    connection: StreamableConnection,
    sql: string,
    params: unknown[],
    batchSize: number,
    options?: OpenStreamOptions,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    if (!connection.streamBatches)
      throw new UnsupportedFeatureError('native streaming', 'mysql', 'An acquired MysqlPool connection is required.');
    yield* connection.streamBatches(sql, params, batchSize, options?.signal);
  },

  // ---- Introspection ------------------------------------------------------

  introspector: {
    async introspect(options) {
      return introspectMysql(options);
    },
  } satisfies DialectIntrospector,
};

// ---------------------------------------------------------------------------
// Introspection, information_schema-driven SchemaMetadata
// ---------------------------------------------------------------------------

/** Async executor that returns plain row objects for a parameterized query. */
export type MysqlRowExecutor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

interface InfoColumn {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_KEY: string;
  COLUMN_DEFAULT: string | null;
  EXTRA: string;
  CHARACTER_MAXIMUM_LENGTH: number | string | null;
  CHARACTER_SET_NAME: string | null;
  COLLATION_NAME: string | null;
  GENERATION_EXPRESSION: string;
}
interface InfoKey {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  ORDINAL_POSITION: number | string;
}
interface InfoFk extends InfoKey {
  REFERENCED_TABLE_SCHEMA: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
  CONSTRAINT_NAME: string;
  UPDATE_RULE?: string | null;
  DELETE_RULE?: string | null;
}
interface InfoIndex {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number | string;
  COLUMN_NAME: string | null;
  SEQ_IN_INDEX: number | string;
  SUB_PART: number | string | null;
  EXPRESSION: string | null;
  COLLATION: string | null;
  INDEX_TYPE: string;
  IS_VISIBLE: string;
  INDEX_COMMENT: string;
}

const num = (v: number | string | null | undefined): number => (typeof v === 'string' ? Number(v) : (v ?? 0));

/**
 * Derive relations through the ONE relation derivation every engine calls
 * (`deriveRelations` in catalog-metadata.ts), so this engine derives the
 * relations `turbine generate` derives against PostgreSQL for the same schema.
 * MySQL contributes its own facts: its unique keys, the column domains under
 * which a key also enforces the join (`mysqlSameKeyEquality`), and its
 * referential actions.
 */
function buildRelationsFromForeignKeys(facts: RelationCatalogFacts): Map<string, Record<string, RelationDef>> {
  return deriveRelations(facts);
}

/** Only comparison domains whose native equality also enforces the unique key. */
function mysqlSameKeyEquality(child: InfoColumn | undefined, parent: InfoColumn | undefined): boolean {
  if (!child || !parent) return false;
  const type = child.COLUMN_TYPE.toLowerCase();
  if (type !== parent.COLUMN_TYPE.toLowerCase()) return false;
  if (/^(?:char|varchar)\(\d+\)$/.test(type)) {
    return (
      typeof child.CHARACTER_SET_NAME === 'string' &&
      child.CHARACTER_SET_NAME === parent.CHARACTER_SET_NAME &&
      typeof child.COLLATION_NAME === 'string' &&
      child.COLLATION_NAME === parent.COLLATION_NAME
    );
  }
  // ENUM/SET, approximate numbers and unrecognized domains stay conservative.
  return /^(?:(?:tinyint|smallint|mediumint|int|bigint)(?:\(\d+\))?(?: unsigned)?|decimal\(\d+,\d+\)(?: unsigned)?|(?:var)?binary\(\d+\)|date|(?:datetime|timestamp|time)(?:\(\d+\))?|year)$/.test(
    type,
  );
}

/** Decode COLUMN_TYPE's catalog serialization, independently of DDL sql_mode. */
function parseMysqlEnum(source: string): string[] {
  const labels: string[] = [];
  const token = /'((?:[^'\\]|''|\\[\\0nr])*)'([,)])/gy;
  token.lastIndex = 5;
  if (/^enum\(/i.test(source)) {
    for (let match = token.exec(source); match; match = token.exec(source)) {
      labels.push(
        match[1]!.replace(/''|\\[\\0nr]/g, (escaped) =>
          escaped === "''"
            ? "'"
            : escaped === '\\0'
              ? '\u0000'
              : escaped === '\\n'
                ? '\n'
                : escaped === '\\r'
                  ? '\r'
                  : '\\',
        ),
      );
      if (match[2] === ')') {
        if (token.lastIndex === source.length) return labels;
        break;
      }
    }
  }
  throw new ValidationError('Invalid MySQL ENUM catalog definition.');
}

/**
 * Character sets that can encode a code point the catalog text cannot.
 * `information_schema` reports `COLUMN_TYPE` in utf8mb3 (verified on MySQL
 * 8.4.0: `SELECT CHARSET(COLUMN_TYPE)` is `utf8mb3`, and the bytes are `?`
 * where a supplementary character was), so only a column in one of these
 * sets can hold a label the catalog rendering loses. Every other MySQL
 * charset has a BMP-only repertoire, which utf8mb3 renders exactly (a
 * literal `?` in such a label really is a question mark).
 */
const SUPPLEMENTARY_CHARSETS = new Set(['utf8mb4', 'utf16', 'utf16le', 'utf32', 'gb18030']);

/**
 * Whether catalog-decoded `labels` may have lost a supplementary character:
 * some label holds a `?` and the column's charset can encode what utf8mb3
 * cannot. The loss always surfaces as `?` (the conversion has no other
 * substitute), so its absence proves the labels exact; its presence is
 * ambiguous with a literal question mark, which catalog text cannot settle,
 * so a suspect list is withheld whatever it holds. A missing charset is
 * suspect too: the catalog always reports one for an ENUM, so a custom
 * executor that omits it has not proven the column BMP-only.
 */
function enumLabelsSuspect(labels: string[], charset: string | null | undefined): boolean {
  if (!labels.some((label) => label.includes('?'))) return false;
  // Loose null on purpose: a custom executor's row can omit the field the
  // catalog query selected, and absent is not proof of a BMP-only column.
  return charset == null || SUPPLEMENTARY_CHARSETS.has(charset.toLowerCase());
}

/**
 * Introspect a MySQL database into the same {@link SchemaMetadata} shape the
 * Postgres catalog introspector produces, using a caller-supplied query
 * executor (so tests can dogfood an already-open mysql2 pool/connection).
 *
 * Every statement is a `SELECT`. An ENUM column whose catalog labels may have
 * lost a supplementary character (the utf8mb3 `COLUMN_TYPE` text holds `?` on
 * a charset that can encode past the BMP) is marked
 * `enumLabelsUnrecoverable`, warned about by name, and typed `string` instead
 * of a union guessed from the damaged text; labels declared explicitly (an
 * `enums` entry, or a `columnTypes` override at generation) outrank it.
 *
 * @param exec    Runs a parameterized (`:p1`, `:p2`, …) query and returns rows.
 * @param schema  The MySQL database (schema) name to introspect.
 * @param options Table-name filters, relation-naming logger, and the legacy
 *                opt-out from proven unique-FK reverse to-one cardinality.
 */
export async function introspectMysqlWith(
  exec: MysqlRowExecutor,
  schema: string,
  options: Pick<IntrospectOptions, 'include' | 'exclude' | 'logger'> & { legacyToManyUniques?: boolean } = {},
): Promise<SchemaMetadata> {
  // ----- Tables -----
  const candidateTables = (
    await exec(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = :p1 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      [schema],
    )
  ).map((r) => String(r.TABLE_NAME));
  // include / exclude + default bookkeeping-table exclusions.
  const tableNames = applyTableFilters(candidateTables, options);
  const tableSet = new Set(tableNames);

  // ----- Columns -----
  const columnRows = (await exec(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY,
            COLUMN_DEFAULT, EXTRA, CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, COLLATION_NAME,
            GENERATION_EXPRESSION
     FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  )) as unknown as InfoColumn[];

  const columnsByTable = new Map<string, ColumnMetadata[]>();
  const nativeColumns = new Map<string, InfoColumn>();
  const enums: Record<string, string[]> = nullRecord<string[]>();
  const logger = options.logger ?? consoleLogger;
  for (const c of columnRows) {
    if (!tableSet.has(c.TABLE_NAME)) continue;
    nativeColumns.set(JSON.stringify([c.TABLE_NAME, c.COLUMN_NAME]), c);
    const nullable = c.IS_NULLABLE === 'YES' && c.COLUMN_KEY !== 'PRI';
    const computed = /\b(?:VIRTUAL|STORED) GENERATED\b/i.test(c.EXTRA) || !!c.GENERATION_EXPRESSION;
    const dataType = c.DATA_TYPE.toLowerCase();
    const enumLabels = dataType === 'enum' ? parseMysqlEnum(c.COLUMN_TYPE) : undefined;
    const maxLen = c.CHARACTER_MAXIMUM_LENGTH != null ? num(c.CHARACTER_MAXIMUM_LENGTH) : undefined;
    // `tinyint(1)` is the one type whose DATA_TYPE is not enough to identify it
    // (see MYSQL_BOOLEAN_TYPE); everything else keeps the bare DATA_TYPE.
    const recordedType = c.COLUMN_TYPE.toLowerCase() === MYSQL_BOOLEAN_TYPE ? MYSQL_BOOLEAN_TYPE : dataType;
    const col: ColumnMetadata = {
      name: c.COLUMN_NAME,
      field: snakeToCamel(c.COLUMN_NAME),
      dialectType: recordedType,
      pgType: recordedType,
      tsType: mysqlTypeToTs(dataType, nullable, c.COLUMN_TYPE),
      nullable,
      // Nullable MySQL columns have an effective DEFAULT NULL even when the
      // catalog cannot distinguish an explicit NULL from an implicit default.
      hasDefault: nullable || c.COLUMN_DEFAULT !== null || /auto_increment/i.test(c.EXTRA) || computed,
      // The server numbers it, so a create's re-read can use the insert id.
      isGenerated: /auto_increment/i.test(c.EXTRA),
      // The existing flag protects BOTH virtual and stored computed values.
      ...(computed ? { isGeneratedStored: true } : {}),
      ...(computed && c.GENERATION_EXPRESSION ? { generationExpression: c.GENERATION_EXPRESSION } : {}),
      isArray: false,
      arrayType: undefined,
      pgArrayType: 'text[]',
    };
    if (maxLen !== undefined) col.maxLength = maxLen;
    if (enumLabels !== undefined) {
      // Exact unless suspect (see enumLabelsSuspect). A suspect list is
      // withheld, never recorded from the damaged text, so no consumer can type
      // or validate against a label the column does not have.
      const key = `${c.TABLE_NAME}.${c.COLUMN_NAME}`;
      if (!enumLabelsSuspect(enumLabels, c.CHARACTER_SET_NAME)) {
        enums[key] = enumLabels;
      } else {
        col.enumLabelsUnrecoverable = true;
        logTo(
          logger,
          'warn',
          `MySQL introspection: the ENUM labels of "${key}" may hold characters outside the BMP, which the MySQL ` +
            'catalog reports as "?" (a label that really contains "?" reads the same), so the column is typed as ' +
            'string instead of a literal union. For exact literal types, declare its labels explicitly: with the ' +
            `CLI, a \`columnTypes\` entry in turbine.config.ts (\`columnTypes: { "${key}": "'a' | 'b'" }\`); in code, ` +
            `an \`enums\` entry on the introspected metadata before calling generate() (\`schema.enums["${key}"] = ` +
            "['a', 'b']`). The stored labels and row data are unaffected.",
          { code: 'introspect-enum-labels-unrecoverable', table: c.TABLE_NAME },
        );
      }
    }
    if (!columnsByTable.has(c.TABLE_NAME)) columnsByTable.set(c.TABLE_NAME, []);
    columnsByTable.get(c.TABLE_NAME)!.push(col);
  }

  // ----- Primary keys (ordered) -----
  const pkRows = (await exec(
    `SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = :p1 AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  )) as unknown as InfoKey[];
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    if (!tableSet.has(r.TABLE_NAME)) continue;
    if (!pkByTable.has(r.TABLE_NAME)) pkByTable.set(r.TABLE_NAME, []);
    pkByTable.get(r.TABLE_NAME)!.push(r.COLUMN_NAME);
  }

  // ----- Foreign keys (grouped by constraint for composite FKs) -----
  const fkRows = (await exec(
    `SELECT k.TABLE_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
            k.CONSTRAINT_NAME, k.ORDINAL_POSITION, r.UPDATE_RULE, r.DELETE_RULE
     FROM information_schema.KEY_COLUMN_USAGE k
     LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
       ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
     WHERE k.TABLE_SCHEMA = :p1 AND k.REFERENCED_TABLE_NAME IS NOT NULL
       AND k.REFERENCED_TABLE_SCHEMA = :p1
     ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    [schema],
  )) as unknown as InfoFk[];
  const fkByTable = new Map<string, Map<string, ForeignKeyEntry>>();
  for (const r of fkRows) {
    if (!tableSet.has(r.TABLE_NAME)) continue;
    if (r.REFERENCED_TABLE_SCHEMA !== undefined && r.REFERENCED_TABLE_SCHEMA !== schema) continue;
    if (!fkByTable.has(r.TABLE_NAME)) fkByTable.set(r.TABLE_NAME, new Map());
    const table = fkByTable.get(r.TABLE_NAME)!;
    let entry = table.get(r.CONSTRAINT_NAME);
    if (!entry) {
      entry = {
        sourceTable: r.TABLE_NAME,
        sourceColumns: [],
        targetTable: r.REFERENCED_TABLE_NAME,
        targetColumns: [],
        constraintName: r.CONSTRAINT_NAME,
        actions: {
          onDelete: referentialActionFromCatalog(r.DELETE_RULE),
          onUpdate: referentialActionFromCatalog(r.UPDATE_RULE),
        },
      };
      table.set(r.CONSTRAINT_NAME, entry);
    }
    entry.sourceColumns.push(r.COLUMN_NAME);
    entry.targetColumns.push(r.REFERENCED_COLUMN_NAME);
  }
  // Relation naming reads a composite FK's constraint name, so each key takes
  // the name PostgreSQL gives the same declarations. A name InnoDB generated,
  // `<table>_ibfk_<n>`, numbers the unnamed keys in declaration order (the
  // catalog lists `_ibfk_10` before `_ibfk_2`), and each takes PostgreSQL's
  // default in that order. The catalog cannot tell an explicit name in that
  // form from a generated one, so it reads as generated.
  const constraintNames = new Set<string>();
  const foreignKeys: ForeignKeyEntry[] = [];
  for (const [table, entries] of [...fkByTable].sort(([a], [b]) => compareCatalogNames(a, b))) {
    const keys = [...entries.values()].map((fk) => {
      const n = fk.constraintName.slice(table.length + 6);
      return { fk, n: fk.constraintName.startsWith(`${table}_ibfk_`) && /^\d+$/.test(n) ? Number(n) : -1 };
    });
    keys.sort((a, b) => a.n - b.n);
    const names = foreignKeyConstraintNames(
      table,
      keys.map(({ fk, n }) => ({ columns: fk.sourceColumns, name: n < 0 ? fk.constraintName : undefined })),
      constraintNames,
    );
    keys.forEach(({ fk }, i) => {
      fk.constraintName = names[i]!;
      if (tableSet.has(fk.targetTable)) foreignKeys.push(fk);
    });
  }

  // ----- Indexes + unique constraints -----
  const idxRows = (await exec(
    `SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX,
            SUB_PART, EXPRESSION, COLLATION, INDEX_TYPE, IS_VISIBLE, INDEX_COMMENT
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    [schema],
  )) as unknown as InfoIndex[];
  const indexGroups = new Map<string, InfoIndex[]>();
  for (const r of idxRows) {
    if (!tableSet.has(r.TABLE_NAME)) continue;
    const key = JSON.stringify([r.TABLE_NAME, r.INDEX_NAME]);
    if (!indexGroups.has(key)) indexGroups.set(key, []);
    indexGroups.get(key)!.push(r);
  }
  const indexesByTable = new Map<string, IndexMetadata[]>();
  const uniqueByTable = new Map<string, string[][]>();
  for (const rows of indexGroups.values()) {
    rows.sort((a, b) => num(a.SEQ_IN_INDEX) - num(b.SEQ_IN_INDEX));
    const first = rows[0]!;
    if (first.INDEX_NAME === 'PRIMARY') continue; // PK is tracked separately
    const plain = rows.every((r) => typeof r.COLUMN_NAME === 'string' && r.EXPRESSION == null && r.SUB_PART == null);
    // Never publish a subset of a functional/prefix key as a complete key.
    const columns = plain ? rows.map((r) => r.COLUMN_NAME!) : [];
    const unique = num(first.NON_UNIQUE) === 0;
    if (!indexesByTable.has(first.TABLE_NAME)) indexesByTable.set(first.TABLE_NAME, []);
    indexesByTable.get(first.TABLE_NAME)!.push({
      name: first.INDEX_NAME,
      columns,
      unique,
      // Opaque, non-executable catalog facts. In particular, expressions must
      // never be converted into guessed migration DDL. MySQL has no partial
      // indexes; SUB_PART is a key prefix length, not a WHERE predicate.
      definition: `MySQL index metadata: ${JSON.stringify({
        type: first.INDEX_TYPE ?? null,
        visible: first.IS_VISIBLE ?? null,
        comment: first.INDEX_COMMENT ?? null,
        keys: rows.map((r) => ({
          column: r.COLUMN_NAME,
          expression: r.EXPRESSION ?? null,
          prefixLength: r.SUB_PART == null ? null : num(r.SUB_PART),
          order: r.COLLATION ?? null,
        })),
      })}`,
    });
    if (unique && columns.length > 0) {
      if (!uniqueByTable.has(first.TABLE_NAME)) uniqueByTable.set(first.TABLE_NAME, []);
      uniqueByTable.get(first.TABLE_NAME)!.push(columns);
    }
  }

  // ----- Relations -----
  // One field per column, as the PostgreSQL introspector requires.
  for (const [tableName, cols] of columnsByTable) assertDistinctColumnFields(tableName, cols);
  // A to-one is decided per foreign key BEFORE naming, so it is named as
  // PostgreSQL names it (`users.profile`): the child's columns are exactly its
  // primary key or a unique key, and each column pair compares the way the
  // enforced key does.
  const relationsByTable = buildRelationsFromForeignKeys({
    tableNames,
    foreignKeys,
    pkByTable,
    columnsByTable,
    uniqueKeysByTable: new Map(
      tableNames.map((table) => [table, [pkByTable.get(table) ?? [], ...(uniqueByTable.get(table) ?? [])]]),
    ),
    // A unique key proves a to-one only when the join compares like the key.
    sameKeyComparison: (fk) =>
      fk.sourceColumns.length === fk.targetColumns.length &&
      fk.sourceColumns.every((name, i) =>
        mysqlSameKeyEquality(
          nativeColumns.get(JSON.stringify([fk.sourceTable, name])),
          nativeColumns.get(JSON.stringify([fk.targetTable, fk.targetColumns[i]])),
        ),
      ),
    junctionKeysByTable: new Map(
      Array.from(uniqueByTable, ([table, keys]) => [table, keys.filter((key) => key.length === 2)]),
    ),
    ...(options.legacyToManyUniques ? { legacyToManyUniques: true } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });

  // ----- Assemble TableMetadata -----
  const tables: Record<string, TableMetadata> = nullRecord<TableMetadata>();
  for (const tableName of tableNames) {
    const columns = columnsByTable.get(tableName) ?? [];
    const columnMap: Record<string, string> = nullRecord<string>();
    const reverseColumnMap: Record<string, string> = nullRecord<string>();
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = nullRecord<string>();
    const pgTypes: Record<string, string> = nullRecord<string>();
    const allColumns: string[] = [];

    for (const col of columns) {
      columnMap[col.field] = col.name;
      reverseColumnMap[col.name] = col.field;
      allColumns.push(col.name);
      dialectTypes[col.name] = col.dialectType ?? col.pgType;
      pgTypes[col.name] = col.pgType;
      if (isMysqlDateType(col.dialectType ?? col.pgType)) dateColumns.add(col.name);
    }

    tables[tableName] = {
      name: tableName,
      columns,
      columnMap,
      reverseColumnMap,
      dateColumns,
      dialectTypes,
      pgTypes,
      allColumns,
      primaryKey: pkByTable.get(tableName) ?? [],
      uniqueColumns: uniqueByTable.get(tableName) ?? [],
      relations: relationsByTable.get(tableName) ?? nullRecord<RelationDef>(),
      indexes: indexesByTable.get(tableName) ?? [],
    };
  }

  return { tables, enums } satisfies SchemaMetadata;
}

/**
 * Open a short-lived mysql2 connection from `options.connectionString`,
 * introspect the database (schema = `options.schema` or the connection's current
 * database), and close it. Wraps {@link introspectMysqlWith} for the
 * {@link DialectIntrospector} seam used by `introspect()` / `npx turbine generate`.
 */
export async function introspectMysql(
  options: IntrospectOptions & { legacyToManyUniques?: boolean },
): Promise<SchemaMetadata> {
  const createPool = await loadCreatePool();
  const config = parseMysqlConfig(options.connectionString);
  const pool = createPool({ ...config, ...MYSQL_DRIVER_FLAGS }) as Mysql2Pool;
  try {
    const exec: MysqlRowExecutor = async (sql, params) => (await execOne(pool, sql, params)).rows;
    let schemaName = options.schema ?? config.database;
    if (!schemaName) {
      const rows = await exec('SELECT DATABASE() AS db', []);
      schemaName = (rows[0]?.db as string) ?? '';
    }
    if (!schemaName) {
      throw new ConnectionError(
        'Could not determine the MySQL database to introspect, pass a database in the connection string or a `schema` option.',
      );
    }
    // `await` is LOAD-BEARING, not stylistic: `return somePromise` inside a
    // try/finally runs the finally BEFORE the promise settles, so `pool.end()`
    // closed the pool out from under every introspection query and the whole
    // call failed with mysql2's "Pool is closed".
    return await introspectMysqlWith(exec, schemaName, {
      include: options.include,
      exclude: options.exclude,
      logger: options.logger,
      legacyToManyUniques: options.legacyToManyUniques,
    });
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// mysql2 loading + config
// ---------------------------------------------------------------------------

/** mysql2 connection flags Turbine pins for correct behavior. */
const MYSQL_DRIVER_FLAGS = {
  // Named placeholders (`:pN`), see paramPlaceholder + bindStatement.
  namedPlaceholders: true,
  // Safe-int policy matching Postgres int8: number when it fits, decimal string
  // otherwise. DECIMAL always comes back as a string. No global state mutated.
  supportBigNumbers: true,
  bigNumberStrings: false,
  // DATETIME/TIMESTAMP → JS Date interpreted as UTC (matches Postgres).
  dateStrings: false,
  timezone: 'Z',
  //
  // NOTE: deliberately NO `typeCast` JSON override here. There used to be one,
  // pinning a `json` column to raw text so the nested-relation parser always
  // took its JSON.parse path. It could only ever apply to pools TURBINE builds,
  // and pool injection is a documented entry point, so it did not decide how a
  // `json` column reads; it decided that the two pool shapes read it
  // DIFFERENTLY (owned: string, injected: object). Every flag above is
  // idempotent in that sense (a placeholder style, an integer policy, a time
  // zone) and none of them changes a value's TYPE. Letting mysql2 parse a
  // `json` column is what both pool shapes do by default, and it is also what
  // `pg` does with json/jsonb, so the parsed value is the one answer that is
  // reachable from every entry point. See `jsonWireRule` for the other half.
} as const;

interface MysqlConnectionConfig {
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
}

/** Parse a `mysql://user:pass@host:port/db` connection string into mysql2 config. */
function parseMysqlConfig(connectionString: string): MysqlConnectionConfig {
  try {
    const u = new URL(connectionString);
    const config: MysqlConnectionConfig = {
      host: u.hostname || 'localhost',
      port: u.port ? Number(u.port) : 3306,
    };
    if (u.username) config.user = decodeURIComponent(u.username);
    if (u.password) config.password = decodeURIComponent(u.password);
    const db = u.pathname.replace(/^\//, '');
    if (db) config.database = decodeURIComponent(db);
    return config;
  } catch {
    // Never echo the value, see malformedConnectionStringMessage.
    throw new ConnectionError(malformedConnectionStringMessage('MySQL', 'mysql://user:password@localhost:3306/app'));
  }
}

/** A mysql2 `createPool`-like function. */
// biome-ignore lint/suspicious/noExplicitAny: mysql2 pool options are loosely typed at this seam.
type CreatePool = (config: any) => Mysql2Pool;

/**
 * Dynamically load `mysql2/promise`'s `createPool`. Kept out of the module's
 * static import graph so `import 'turbine-orm/mysql'` never throws when `mysql2`
 * is absent for a consumer that does not use the factory.
 */
async function loadCreatePool(): Promise<CreatePool> {
  let mod: { createPool?: CreatePool; default?: { createPool?: CreatePool } };
  try {
    // Via the .cts helper so the CJS build keeps a path to a REAL dynamic
    // import() even if a future mysql2 major goes ESM-only (the CommonJS pass
    // transpiles a plain `import()` here into `require()`).
    mod = (await importOptionalPeer('mysql2/promise')) as typeof mod;
  } catch (err) {
    throw new ConnectionError(
      "turbine-orm/mysql requires the optional peer dependency 'mysql2'. Install it: npm i mysql2. " +
        `(${(err as Error).message})`,
    );
  }
  const createPool = mod.createPool ?? mod.default?.createPool;
  if (typeof createPool !== 'function') {
    throw new ConnectionError("Loaded 'mysql2/promise' but it has no createPool export.");
  }
  return createPool;
}

/**
 * Fail fast on unsupported servers: MySQL 8.0+ is required (5.7 lacks
 * JSON_ARRAYAGG) and MariaDB is unsupported (its JSON_ARRAYAGG semantics differ).
 */
function assertSupportedVersion(version: string): void {
  if (/mariadb/i.test(version)) {
    throw new ConnectionError(`MariaDB is not supported by turbine-orm/mysql (got "${version}"). Use MySQL 8.0+.`);
  }
  const m = /^(\d+)\.(\d+)/.exec(version);
  const major = m ? Number(m[1]) : 0;
  if (major < 8) {
    throw new ConnectionError(`turbine-orm/mysql requires MySQL 8.0+ (5.7 lacks JSON_ARRAYAGG); got "${version}".`);
  }
}

// ---------------------------------------------------------------------------
// turbineMysql, the public factory
// ---------------------------------------------------------------------------

/**
 * Options for {@link turbineMysql}: every client-level `TurbineConfig` field the
 * engine can honour (see {@link EngineClientConfig}) plus the pool size below.
 */
export interface TurbineMysqlOptions extends EngineClientConfig {
  /** Maximum number of pooled connections (when Turbine builds the pool). Default: 10. */
  connectionLimit?: number;
}

function isMysql2Pool(x: unknown): x is Mysql2Pool {
  return (
    !!x &&
    typeof (x as Mysql2Pool).getConnection === 'function' &&
    typeof (x as Mysql2Pool).query === 'function' &&
    typeof (x as Mysql2Pool).end === 'function'
  );
}

/**
 * Create a {@link TurbineClient} bound to MySQL 8 via `mysql2`.
 *
 * Pass one of:
 *  - a connection string (`'mysql://user:pass@host:3306/db'`),
 *  - a mysql2 connection config object (`{ host, user, password, database }`), or
 *  - an existing mysql2 pool / {@link MysqlPool} (injection, you own its lifecycle,
 *    `disconnect()` is a no-op, advanced config like SSL lives here).
 *
 * When Turbine builds the pool (string/config), it pins the correct mysql2 flags
 * (named placeholders, bignum, UTC dates), probes `SELECT VERSION()` to reject
 * MySQL < 8.0 / MariaDB, and `disconnect()` closes the pool it created. None of
 * those flags changes a column's TYPE, so an injected pool reads every value
 * the same way (see {@link MYSQL_DRIVER_FLAGS}); `namedPlaceholders: true` is
 * the one an injected pool must set for itself.
 *
 * @example
 * ```ts
 * import { turbineMysql } from 'turbine-orm/mysql';
 * const db = await turbineMysql('mysql://root:root@localhost:3306/app', SCHEMA);
 * ```
 */
export async function turbineMysql(
  target: string | MysqlConnectionConfig | Mysql2Pool | MysqlPool,
  schema: SchemaMetadata,
  options: TurbineMysqlOptions = {},
): Promise<TurbineClient> {
  let pool: MysqlPool;
  let owns = false;

  if (target instanceof MysqlPool) {
    pool = target;
  } else if (isMysql2Pool(target)) {
    pool = new MysqlPool(target);
  } else {
    const createPool = await loadCreatePool();
    const baseConfig = typeof target === 'string' ? parseMysqlConfig(target) : (target as MysqlConnectionConfig);
    const mysql2Pool = createPool({
      ...baseConfig,
      connectionLimit: options.connectionLimit ?? 10,
      ...MYSQL_DRIVER_FLAGS,
    });
    // Every NEW physical connection: disable backslash string escaping, so a
    // string literal in raw SQL on a Turbine-owned pool reads the way it does
    // on PostgreSQL. Nothing Turbine GENERATES depends on it any more: the LIKE
    // clause names `!` (see mysqlDialect.likeEscapeCharacter), a JSON_OBJECT
    // key holding a backslash is written in hex (mysqlKeyLiteral), and every
    // value is a bound parameter, so the SQL means the same thing on a pool
    // the caller supplies, which keeps the caller's own mode. This stays
    // because removing it would change how raw SQL already written against an
    // owned pool parses.
    //
    // NOTE: even on a `mysql2/promise` pool, the 'connection' event yields the
    // *raw* (callback-style) connection, its `.query()` returns a non-thenable
    // `Query`, so `.catch()`/`await` on it throws "result of query that is not a
    // promise". Use the callback form here (fire-and-forget): if the SET fails,
    // MySQL keeps its default escaping, harmless since every value is a param.
    mysql2Pool.on?.('connection', (rawConn: { query: (sql: string, cb: () => void) => void }) => {
      rawConn.query("SET SESSION sql_mode = CONCAT(@@sql_mode, ',NO_BACKSLASH_ESCAPES')", () => {});
    });
    pool = new MysqlPool(mysql2Pool);
    owns = true;
  }

  let client: TurbineClient;
  try {
    // Probe the server version (fail fast on MySQL < 8.0 / MariaDB).
    const versionRows = (await pool.query('SELECT VERSION() AS v')).rows as { v?: string }[];
    assertSupportedVersion(String(versionRows[0]?.v ?? ''));

    // Everything that is not a pool-construction option is client config and
    // rides through untouched, so a new TurbineConfig option works here the day
    // it lands. The engine-owned keys come last, so no caller can unbind the
    // dialect.
    const { connectionLimit: _connectionLimit, ...clientConfig } = options;
    client = new TurbineClient(
      {
        ...clientConfig,
        pool,
        dialect: mysqlDialect,
        preparedStatements: false,
      },
      // The join strategy is the only read path that consults a recorded dialect
      // type, so a schema that spells a boolean any other way would read 1/0
      // there and `true`/`false` everywhere else.
      normalizeBooleanDialectTypes(schema),
    );
  } catch (err) {
    // A failed factory hands the caller nothing to close, so a pool it BUILT
    // is closed here: the version probe's connection would otherwise keep the
    // process alive (the client constructor refuses a bad config, a static
    // global filter naming no table or column for one). A pool the caller
    // supplied is the caller's and stays open.
    if (owns) await pool.end().catch(() => {});
    throw err;
  }

  if (owns) {
    // Turbine built this pool, so disconnect()/end() must close it. External
    // pools (injection) stay the caller's responsibility (disconnect() no-op),
    // consistent with turbineHttp / turbineSqlite.
    const baseDisconnect = client.disconnect.bind(client);
    const close = async (options?: DisconnectOptions): Promise<DisconnectResult | undefined> => {
      const result = options === undefined ? await baseDisconnect() : await baseDisconnect(options);
      await pool.end();
      return result ?? undefined;
    };
    const patch = client as unknown as { disconnect: typeof close; end: typeof close };
    patch.disconnect = close;
    patch.end = close;
  }

  return client;
}
