/**
 * turbine-orm: write compilation (extracted from builder.ts)
 *
 * SQL builders for the mutating operations (create / createMany / update /
 * delete / upsert / updateMany / deleteMany) plus the write-projection helpers
 * (writeReturningColumns / writeReselectSelection / parseWriteRow, the PII
 * column set, optimistic-lock and atomic-operator SET clauses). All functions
 * take a {@link BuilderCtx} first argument; WHERE compilation is reused from
 * where.ts (via `whereMod`), and the cache / dialect / row-parse primitives
 * stay class-resident, reached through the ctx. See builder.ts for the thin
 * delegating methods and the async execute wrappers.
 */

import {
  type BulkInsertStatementInput,
  type BulkUpsertRefs,
  maxBindParameters,
  type ReturningSelection,
} from '../dialect.js';
import { NotFoundError, OptimisticLockError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { PgCompatQueryResult } from '../pg-types.js';
import type { TableMetadata } from '../schema.js';
import { camelToSnake } from '../schema.js';
import { isColumnRef } from './column-ref.js';
import {
  assertMutationWhereIdentifiesOneRow,
  expandCompoundUniqueWhere,
  otherCollidingUniqueKey,
  uniqueKeyNames,
  upsertCreateCollidingKey,
  upsertWhereMatchesCreate,
} from './compound-unique.js';
import type { DeferredQuery, ReselectExecutor } from './deferred.js';
import {
  compileSetExpr,
  type ExprCompileEnv,
  expr as exprBuilders,
  exprNotAllowedMessage,
  isPlainExprShape,
  isSqlExpr,
  plainExprShapeMessage,
  resolveExcludedFromCreate,
} from './expr.js';
import { isPlainRecord, isUnmatchedPlainObject, UPDATE_OPERATOR_KEYS } from './filters.js';
import { isJsonValue, serializeJsonValue } from './json-value.js';
import { pruneUndefinedArgs } from './normalize-args.js';
import type {
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
} from './types.js';
import { resolveSkipGlobalFilters, resolveUnsafeFlag } from './types.js';
import { canonicalWriteEntries, coerceTemporalValue, resolveColumnName, type SqlCacheEntry } from './utils.js';
import type { BuilderCtx } from './where.js';
import * as whereMod from './where.js';

/**
 * Normalize one `data` value before it is bound as a write param. This is THE
 * write bind seam: create, createMany, update, updateMany, both halves of
 * upsert, the cache-hit param collectors and (through those public methods)
 * the nested-write engine all bind through it.
 *
 * JSON columns (json / jsonb):
 *
 * - A JS array is serialized with `JSON.stringify`. The drivers' default
 *   array serialization is a Postgres ARRAY literal, so `[]` was stored as the
 *   object `{}`, `["a"]` failed with 22P02, and `createMany`'s UNNEST
 *   transpose flattened `[1, 2, 3]` into three rows.
 * - A {@link jsonValue} wrapper is serialized with `JSON.stringify`, which is
 *   how a JSON string or a JSON `null` is written.
 * - A JS string is RAW JSON TEXT and passes through untouched, so
 *   `JSON.stringify(value)` callers keep storing the parsed value. A plain
 *   object passes through too: every driver already serializes it as JSON.
 *
 * Temporal columns, a JS `Date`:
 *
 * 1. A time-of-day column (`time` / `timetz`), the driver serializes a `Date`
 *    as a full ISO timestamp with the process offset and Postgres answers
 *    `22007 invalid input syntax for type time`. Rewritten on every engine.
 * 2. A zone-less `date` / `timestamp` column on PostgreSQL, the driver's
 *    local-offset serialization stores the PROCESS's calendar fields, so in a
 *    non-UTC process the stored value is wrong and (because the read path
 *    interprets an offset-less value as UTC) does not round-trip. Rewritten to
 *    the UTC components, mirroring `parseDbDate`. See `toLocalDateTimeLiteral`
 *    in query/utils.ts. `timestamptz` is deliberately untouched: it stores a
 *    real instant and the driver's local-offset string is already correct.
 *
 * On PostgreSQL a plain object or an array bound to a known scalar column
 * (text, int, uuid, ...) is refused with E003; see {@link assertScalarBindable}.
 *
 * Expressions (`expr.*`, `col()`) never bind as a value: the update paths
 * compile them before reaching here, so one that arrives is in a position that
 * takes values only (create data, `{ set }`) and is refused. An unbranded
 * object shaped like one is refused on a non-JSON column on every engine.
 *
 * Every other value is returned by identity, so a primitive costs one check
 * and no lookup.
 */
export function coerceWriteValue(qi: BuilderCtx, key: string, value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (isSqlExpr(value) || isColumnRef(value)) {
    throw new ValidationError(exprNotAllowedMessage(qi.table, key, value));
  }
  // THE key-resolution rule, shared with `toColumn` (the SQL side of this very
  // statement) so the two can never disagree about which column a key names.
  // Non-throwing, because this also runs on the cache-HIT param-collect path,
  // where an unknown key must not turn into a different error than the build
  // path already raises.
  const column = resolveColumnName(qi.tableMeta, key);
  const dbType = column ? qi.columnPgTypeMap.get(column) : undefined;
  if (isJsonValue(value)) return jsonText(qi, key, value.value);
  if (dbType !== undefined && whereMod.isJsonColumnType(qi, dbType)) {
    return Array.isArray(value) ? jsonText(qi, key, value) : value;
  }
  if (isPlainExprShape(value)) {
    throw new ValidationError(plainExprShapeMessage(qi.table, key, String((value as { kind: unknown }).kind)));
  }
  assertScalarBindable(qi, key, dbType, value);
  if (!(value instanceof Date) && !Array.isArray(value)) return value;
  // A column missing from the type map resolves to undefined → no coercion.
  // The gate is where.ts's, so a written Date and a compared Date take the
  // same form: a `date` column the UTC date part on every SQL engine, a
  // zone-less `timestamp` the UTC literal on PostgreSQL only.
  return coerceTemporalValue(dbType, value, whereMod.utcDateTimeRewrite(qi, dbType));
}

/** `JSON.stringify(value)` for a JSON column, or E003 when it has no JSON form. */
function jsonText(qi: BuilderCtx, key: string, value: unknown): string {
  const text = serializeJsonValue(value);
  if (text === undefined) {
    throw new ValidationError(
      `Cannot write "${qi.table}.${key}": the value has no JSON form (${describeValue(value)}). ` +
        'Convert it first, e.g. a bigint to a string or a number.',
    );
  }
  return text;
}

function describeValue(value: unknown): string {
  return typeof value === 'bigint' ? 'it contains a bigint' : `got ${typeof value}`;
}

/**
 * PostgreSQL column types on which a plain object or an array can only be a
 * mistake. The driver serializes an object as JSON text and an array as an
 * ARRAY literal, so on a text column `{ first, last }` was stored as
 * `{"first":"A","last":"B"}` and `['a']` as `{"a"}`, silently. A type outside
 * this list (enums, domains, extension and user types) is never refused here,
 * because a domain over jsonb or an extension type may legitimately take one.
 */
const SCALAR_PG_TYPES: ReadonlySet<string> = new Set([
  'text',
  'varchar',
  'character varying',
  'char',
  'character',
  'bpchar',
  'citext',
  'name',
  'uuid',
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'bigint',
  'numeric',
  'decimal',
  'float4',
  'float8',
  'real',
  'double precision',
  'money',
  'bool',
  'boolean',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'time without time zone',
  'time with time zone',
  'timestamp without time zone',
  'timestamp with time zone',
  'interval',
  'bytea',
  'inet',
  'cidr',
  'macaddr',
  'xml',
]);

/**
 * Refuse a plain object, or an array, bound to a known scalar column on
 * PostgreSQL. Dates, Buffers, class instances (a Decimal wrapper, an interval)
 * and every primitive are untouched, and so is every array column (`_text`)
 * since its type is not in {@link SCALAR_PG_TYPES}.
 *
 * PostgreSQL only: SQL Server stores JSON in `nvarchar` and SQLite in TEXT, so
 * a "text" column is a legitimate JSON home there and the shims serialize an
 * object as JSON on purpose.
 */
function assertScalarBindable(qi: BuilderCtx, key: string, dbType: string | undefined, value: object): void {
  if (qi.dialect.name !== 'postgresql' || dbType === undefined) return;
  const isArray = Array.isArray(value);
  if (!isArray && !isUnmatchedPlainObject(value)) return;
  if (!SCALAR_PG_TYPES.has(dbType.toLowerCase())) return;
  throw new ValidationError(
    `Cannot write ${isArray ? 'an array' : 'an object'} to "${qi.table}.${key}" (column type ${dbType}). ` +
      'Only json/jsonb columns take objects, and only array columns take arrays. ' +
      'To store JSON text in this column, pass `JSON.stringify(value)` or `jsonValue(value)`.' +
      (isArray ? '' : ' Atomic operators (`{ set: v }`, `{ increment: n }`, ...) apply in update data only.'),
  );
}

/**
 * Build a `SELECT * ... WHERE <predicate>` that re-fetches the row(s) matched
 * by a write's `where` clause. Used by the `'reselect'` result strategy to
 * return rows from non-RETURNING engines. Reuses the same parameterized WHERE
 * builder as reads, so no user value is interpolated.
 */
export function buildReselectByWhere(
  qi: BuilderCtx,
  whereObj: Record<string, unknown>,
  projection?: WriteProjection,
  lockRows = false,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const clause = whereMod.buildWhereClause(qi, whereObj, params);
  const where = clause ? ` WHERE ${clause}` : '';
  return {
    sql: `SELECT ${writeReselectSelection(qi, projection)} FROM ${qi.q(qi.table)}${where}${lockRows ? forUpdate(qi) : ''}`,
    params,
  };
}

/**
 * Row-lock suffix for a read inside a reselect write's transaction, so a
 * concurrent write of the same row waits instead of interleaving. MySQL is the
 * one engine on the reselect strategy; elsewhere nothing is appended.
 */
function forUpdate(qi: BuilderCtx): string {
  return qi.dialect.name === 'mysql' ? ' FOR UPDATE' : '';
}

/**
 * Whether a write that sets `columns` may move a row out of `whereObj`, so the
 * row must be re-read by its key rather than by `where`: a soft delete under a
 * `deletedAt: null` global filter, `NOT: { status: 'done' }` with `status:
 * 'done'`, a key change.
 *
 * Read off the compiled predicate, where every column it reads is quoted at
 * any depth (`NOT`, `OR`, a relation filter's correlation, a column reference,
 * the global filter), so no where shape is missed. A column of another table
 * with the same name answers true, which costs one locking read and is never
 * wrong.
 */
function writeMayMoveRow(qi: BuilderCtx, whereObj: Record<string, unknown>, columns: ReadonlySet<string>): boolean {
  if (columns.size === 0) return false;
  const clause = whereMod.buildWhereClause(qi, whereObj, []);
  if (!clause) return false;
  for (const column of columns) if (clause.includes(qi.q(column))) return true;
  return false;
}

/**
 * The columns that identify a row after a write: the primary key, else the
 * first unique key, else none.
 */
function identityColumns(qi: BuilderCtx): readonly string[] {
  return qi.tableMeta.primaryKey.length > 0 ? qi.tableMeta.primaryKey : (uniqueKeyNames(qi.tableMeta)[0] ?? []);
}

/**
 * Lock the row(s) `whereObj` matches and return the first one's identity key as
 * a `where`, with every key column `data` assigns replaced by its new value, so
 * the row can be re-read after the write moves it. `null` when no row matched.
 *
 * Refused (E017) before anything is written: a table with no key to re-read by,
 * a key column assigned by something whose result is not known here (an
 * expression, `divide`, a non-integer operand), and, unless the call is a
 * full-table write, a `where` that matched more than one row, which only an
 * engine comparing a key loosely produces.
 */
async function lockMovedRowKey(
  qi: BuilderCtx,
  exec: ReselectExecutor,
  whereObj: Record<string, unknown>,
  data: Record<string, unknown>,
  operation: 'update' | 'upsert',
  manyRows: boolean,
): Promise<Record<string, unknown> | null> {
  const identity = identityColumns(qi);
  if (identity.length === 0) {
    throw new UnsupportedFeatureError(
      `${operation} on "${qi.table}" that changes a column its \`where\` reads`,
      qi.dialect.name,
      'The written row is read back by a key, and the table has no primary key or unique key. Give the table a ' +
        'primary key, or leave the columns `where` reads out of data.',
    );
  }
  const assigned = new Map<string, [string, unknown]>();
  for (const [key, value] of writeEntries(qi, data)) {
    const column = resolveColumnName(qi.tableMeta, key);
    if (column !== undefined && identity.includes(column)) assigned.set(column, [key, value]);
  }
  const params: unknown[] = [];
  const clause = whereMod.buildWhereClause(qi, whereObj, params);
  const sql = `SELECT ${identity.map((c) => qi.q(c)).join(', ')} FROM ${qi.q(qi.table)}${clause ? ` WHERE ${clause}` : ''}${forUpdate(qi)}`;
  const rows = (await exec(sql, params)).rows;
  const row = rows[0];
  if (!row) return null;
  if (!manyRows) assertOneRowByKey(qi, operation, identity, rows.length);
  const key: Record<string, unknown> = {};
  for (const column of identity) {
    const entry = assigned.get(column);
    const next = entry === undefined ? row[column] : movedKeyValue(qi, operation, entry[0], row[column], entry[1]);
    key[fieldOf(qi, column)] = reselectKeyValue(qi, column, next);
  }
  return key;
}

/**
 * The value a key column holds after `assigned` is written over `current`: a
 * plain value or `{ set }` as given, and `increment` / `decrement` / `multiply`
 * by an integer computed exactly on an integer key. Anything else is refused
 * (E017) because its result, and so the row, cannot be known before the write.
 */
function movedKeyValue(
  qi: BuilderCtx,
  operation: 'update' | 'upsert',
  key: string,
  current: unknown,
  assigned: unknown,
): unknown {
  const op = setOperatorOf(qi, key, assigned);
  if (op === null) return assigned;
  if (op === 'set') return (assigned as { set: unknown }).set;
  const operand = op === 'expr' ? undefined : (assigned as Record<string, unknown>)[op];
  const base = integerOf(current);
  if (base !== undefined && typeof operand === 'number' && Number.isSafeInteger(operand) && op !== 'divide') {
    const n = BigInt(operand);
    const next = op === 'increment' ? base + n : op === 'decrement' ? base - n : base * n;
    return typeof current === 'number' &&
      next >= BigInt(Number.MIN_SAFE_INTEGER) &&
      next <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(next)
      : typeof current === 'bigint'
        ? next
        : next.toString();
  }
  throw new UnsupportedFeatureError(
    `${operation} on "${qi.table}" that changes the key "${key}" with ${op === 'expr' ? 'an expression' : `\`${op}\``}`,
    qi.dialect.name,
    'The written row is read back by its key, and the new key is not known before the write. Read the row, then ' +
      `write the new key with \`{ set: value }\`${op === 'expr' ? '' : ', or use an integer `increment`, `decrement` or `multiply`'}.`,
  );
}

/** The columns the top level of `where` names, for a message. */
function whereColumns(qi: BuilderCtx, where: Record<string, unknown>): string[] {
  return Object.keys(where).flatMap((key) => {
    const column = where[key] === undefined ? undefined : resolveColumnName(qi.tableMeta, key);
    return column === undefined ? [] : [column];
  });
}

/** An integer key value as a bigint, or `undefined` for anything else. */
function integerOf(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  return undefined;
}

/**
 * `where` with each top-level key value bound as a reselect binds keys (see
 * {@link TEXT_KEY_TYPES}), or `where` itself when nothing changes.
 */
function textSafeKeyWhere(qi: BuilderCtx, where: Record<string, unknown>): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(where)) {
    const column = resolveColumnName(qi.tableMeta, key);
    if (column === undefined) continue;
    const plain = isPlainRecord(value) && Object.keys(value).length === 1 && 'equals' in value;
    const raw = plain ? (value as { equals: unknown }).equals : value;
    const bound = reselectKeyValue(qi, column, raw);
    if (bound === raw) continue;
    out ??= { ...where };
    out[key] = plain ? { equals: bound } : bound;
  }
  return out ?? where;
}

/**
 * Build the all-defaults INSERT for a `data` that names no column, via the
 * dialect's `buildDefaultValuesInsertStatement` hook.
 *
 * `INSERT INTO t () VALUES ()` (what the column-driven builders render for an
 * empty `data`) is a syntax error everywhere but MySQL, and the correct
 * statement differs per engine, so the shape lives behind the dialect seam.
 * `{}` is easy to reach honestly, a handler that assembles its payload from
 * optional request fields produces it on a request that supplied none of them,
 * so the row of pure defaults is inserted and returned rather than crashing.
 * The empty-`update` no-op in {@link buildUpdate} has the same rationale.
 *
 * A table with no usable defaults still fails, correctly, with the database's
 * own NOT NULL violation (E010): nothing here pre-empts that.
 *
 * A dialect predating the hook raises E017 rather than emitting SQL its engine
 * will reject.
 */
function buildDefaultValuesInsert(
  qi: BuilderCtx,
  rowCount: number,
  skipDuplicates?: boolean,
  projection?: WriteProjection,
): string {
  const build = qi.dialect.buildDefaultValuesInsertStatement;
  if (!build) {
    throw new UnsupportedFeatureError(
      'create/createMany with an empty data object',
      qi.dialect.name,
      'This dialect has no all-defaults INSERT form; name at least one column in `data`.',
    );
  }
  return build.call(qi.dialect, {
    table: qi.q(qi.table),
    rowCount,
    skipDuplicates,
    returning: writeReturningColumns(qi, projection),
  });
}

export function buildCreate<T extends object>(
  qi: BuilderCtx,
  args: CreateArgs<T>,
  projection?: WriteProjection,
): DeferredQuery<T> {
  assertWritable(qi, 'create');
  assertNoGeneratedColumns(qi, args.data as Record<string, unknown>, 'create');
  const entries = writeEntries(qi, args.data as Record<string, unknown>);
  const columns = entries.map(([k]) => qi.toSqlColumn(k));
  const params = entries.map(([k, v]) => coerceWriteValue(qi, k, v));
  // Enum columns get an explicit `::"EnumName"` cast (see enumTypeForColumn).
  const placeholders = entries.map(([k], i) => `${qi.p(i + 1)}${whereMod.enumCastSuffix(qi, qi.toColumn(k))}`);

  // `data: {}` (or all-undefined) names no column: insert a row of defaults.
  const sql =
    entries.length === 0
      ? buildDefaultValuesInsert(qi, 1, undefined, projection)
      : qi.dialect.buildInsertStatement({
          table: qi.q(qi.table),
          columns,
          valuePlaceholders: placeholders,
          returning: writeReturningColumns(qi, projection),
        });

  return {
    sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError({
          table: qi.table,
          operation: 'create',
          message: `create on "${qi.table}" returned no row from RETURNING *; this should never happen.`,
        });
      }
      return parseWriteRow(qi, row, projection) as T;
    },
    tag: `${qi.table}.create`,
    // Non-RETURNING engines: INSERT, then re-fetch the new row by primary key
    // (provided value, else the driver's generated insert id).
    reselect: makeCreateReselect(qi, sql, params, args.data as Record<string, unknown>, projection),
  };
}

/**
 * Build the `'reselect'` plan for {@link buildCreate} (MySQL): run the INSERT,
 * then `SELECT ... WHERE <key> = ?` by a key whose value is known exactly
 * (see {@link createReselectKey}). Returns `undefined` unless the dialect's
 * result strategy is `'reselect'`, so the RETURNING engines pay nothing.
 */
export function makeCreateReselect<T extends object>(
  qi: BuilderCtx,
  insertSql: string,
  insertParams: unknown[],
  data: Record<string, unknown>,
  projection?: WriteProjection,
): DeferredQuery<T>['reselect'] {
  if (qi.dialect.resultStrategy !== 'reselect') return undefined;
  const key = createReselectKey(qi, data);
  return async (exec) => {
    const writeResult = await exec(insertSql, insertParams);
    const params = key.values.map((value) => (value === INSERT_ID ? generatedKey(qi, writeResult, key) : value));
    const where = key.columns.map((c, i) => `${qi.q(c)} = ${qi.p(i + 1)}`).join(' AND ');
    const result = await exec(
      `SELECT ${writeReselectSelection(qi, projection)} FROM ${qi.q(qi.table)} WHERE ${where}`,
      params,
    );
    assertOneRowByKey(qi, 'create', key.columns, result.rows.length);
    return result;
  };
}

/** Stands for the driver's generated insert id in a {@link ReselectKey}. */
const INSERT_ID: unique symbol = Symbol('turbine.insertId');

/** The key a `create` is re-read by: columns, and each one's value or {@link INSERT_ID}. */
interface ReselectKey {
  readonly columns: readonly string[];
  readonly values: readonly unknown[];
}

/**
 * The key that finds the row a `create` inserted, decided before the INSERT is
 * sent. Without RETURNING, MySQL reports only the AUTO_INCREMENT value it
 * assigned (`insertId`, 0 when there is none), so a key the server fills any
 * other way (`DEFAULT (UUID())`) cannot be read back: re-reading by 0 matched
 * every CHAR key MySQL converts to the number 0, other tenants' rows included.
 *
 * In order: the primary key, when `data` supplies every member or the one it
 * omits is server-numbered ({@link isServerNumberedKey}); else the first unique
 * key `data` supplies in full. Anything else is refused (E017) before the
 * INSERT, naming the fix. A NULL never identifies a row, so it counts as absent.
 */
function createReselectKey(qi: BuilderCtx, data: Record<string, unknown>): ReselectKey {
  const supplied = new Map<string, unknown>();
  for (const [key, value] of writeEntries(qi, data)) {
    const column = resolveColumnName(qi.tableMeta, key);
    // Same rewrite the INSERT's own params got, then the text-key rule.
    if (column !== undefined && value !== null) {
      supplied.set(column, reselectKeyValue(qi, column, coerceWriteValue(qi, key, value)));
    }
  }
  const pk = qi.tableMeta.primaryKey;
  const missing = pk.filter((c) => !supplied.has(c));
  if (pk.length > 0 && (missing.length === 0 || (missing.length === 1 && isServerNumberedKey(qi, missing[0]!)))) {
    return { columns: pk, values: pk.map((c) => (supplied.has(c) ? supplied.get(c) : INSERT_ID)) };
  }
  for (const key of uniqueKeyNames(qi.tableMeta)) {
    if (key.every((c) => supplied.has(c))) return { columns: key, values: key.map((c) => supplied.get(c)) };
  }
  const fields = (missing.length > 0 ? missing : pk).map((c) => `"${fieldOf(qi, c)}"`).join(', ');
  throw new UnsupportedFeatureError(
    pk.length > 0
      ? `create on "${qi.table}" without ${fields} in data`
      : `create on "${qi.table}", which has no primary key,`,
    qi.dialect.name,
    'The inserted row is read back by a key, and the engine reports a generated value only for an ' +
      'AUTO_INCREMENT column. ' +
      (pk.length > 0
        ? `Pass ${fields} in data (for a UUID key, generate it client-side, e.g. crypto.randomUUID()), or make the key AUTO_INCREMENT.`
        : 'Supply every column of a unique key in data, or give the table a primary key.'),
  );
}

/**
 * Whether the server numbers this key column itself, so the driver's insert id
 * is its new value. `isGenerated` decides when the metadata records it;
 * metadata that does not (hand-written, or an introspector that leaves it
 * unset) counts an integer column with a default.
 */
function isServerNumberedKey(qi: BuilderCtx, column: string): boolean {
  const col = qi.tableMeta.columns.find((c) => c.name === column);
  if (!col) return false;
  if (col.isGenerated !== undefined) return col.isGenerated;
  return col.hasDefault && isIntegerColumnType(col.dialectType ?? col.pgType);
}

/**
 * Whether a column's database type is an integer type, in the PostgreSQL,
 * MySQL and code-first spellings. A MySQL display width or sign modifier
 * (`int(11) unsigned`) is ignored, except that `tinyint(1)` is MySQL's
 * BOOLEAN and is not counted.
 */
function isIntegerColumnType(dbType: string | undefined): boolean {
  if (!dbType) return false;
  const t = dbType.trim().toLowerCase();
  if (t === 'tinyint(1)') return false;
  const base = t
    .replace(/\s+(unsigned|signed|zerofill)\b/g, '')
    .replace(/\s*\(\s*\d+\s*\)$/, '')
    .trim();
  return INTEGER_COLUMN_TYPES.has(base);
}

const INTEGER_COLUMN_TYPES: ReadonlySet<string> = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'integer',
  'bigint',
  'int2',
  'int4',
  'int8',
  'serial',
  'bigserial',
  'smallserial',
]);

/** The insert id of `result` as a key value, or E017 when the engine reported none. */
function generatedKey(qi: BuilderCtx, result: PgCompatQueryResult, key: ReselectKey): unknown {
  const id = qi.mutationInsertId(result);
  const positive =
    (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
    (typeof id === 'bigint' && id > 0n) ||
    (typeof id === 'string' && /^[1-9][0-9]*$/.test(id));
  if (positive) return id;
  const column = key.columns[key.values.indexOf(INSERT_ID)]!;
  throw new UnsupportedFeatureError(
    `create on "${qi.table}" without "${fieldOf(qi, column)}" in data`,
    qi.dialect.name,
    `The engine reported no generated value for "${fieldOf(qi, column)}", so the inserted row cannot be read back ` +
      `and the insert is rolled back. Pass "${fieldOf(qi, column)}" in data, or make it AUTO_INCREMENT.`,
  );
}

/**
 * Column types MySQL compares with a NUMBER numerically, converting each stored
 * text to a number: `'0zz' = 0` and `'abc' = 0` are both true. A number bound
 * as a key there is sent as the text the INSERT stored instead.
 */
const TEXT_KEY_TYPES: ReadonlySet<string> = new Set([
  'char',
  'varchar',
  'character',
  'character varying',
  'bpchar',
  'nchar',
  'nvarchar',
  'text',
  'tinytext',
  'mediumtext',
  'longtext',
  'binary',
  'varbinary',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
  'uuid',
  'citext',
]);

/** A key value as a reselect binds it (see {@link TEXT_KEY_TYPES}). */
function reselectKeyValue(qi: BuilderCtx, column: string, value: unknown): unknown {
  if (typeof value !== 'number' && typeof value !== 'bigint') return value;
  const type = qi.columnPgTypeMap.get(column);
  return type !== undefined && TEXT_KEY_TYPES.has(type.toLowerCase()) ? String(value) : value;
}

/**
 * A re-read by a unique key finds one row. A second one means the engine
 * matched the key loosely, so which row is the written one is unknown: refused
 * (E017), which rolls the write back.
 */
function assertOneRowByKey(qi: BuilderCtx, operation: string, columns: readonly string[], rows: number): void {
  if (rows <= 1) return;
  throw new UnsupportedFeatureError(
    `${operation} on "${qi.table}"`,
    qi.dialect.name,
    `Re-reading the written row by (${columns.map((c) => fieldOf(qi, c)).join(', ')}) matched ${rows} rows, so the ` +
      'written one cannot be told apart and the write is rolled back. Pass each key value with its column type.',
  );
}

/**
 * The `[key, value]` pairs a write's `data` object actually names, in the
 * table's own column order.
 *
 * A key whose value is `undefined` is NOT named: single-row {@link buildCreate}
 * filters those out of its column list, so the column takes its declared
 * default. `createMany` reads its rows through {@link definedKeys}, which is
 * this function's key half, so `{ n: undefined }` and `{}` mean the identical
 * thing on both paths.
 *
 * THE ORDERING IS A SECURITY BOUND, not tidiness, and it is the whole reason
 * this is one function rather than an `Object.entries` at each site. A write's
 * column list is SQL TEXT: `SET "a" = $1, "b" = $2` and `SET "b" = $1, "a" = $2`
 * are the same write and two different permanently-cached server-side prepared
 * statements. `JSON.parse` preserves insertion order, so
 * `update({ where, data: JSON.parse(reqBody) })` (an ordinary REST handler)
 * lets the request body pick that order, with no array, no arity, and nothing
 * the caller needs to know. Measured on PostgreSQL 16: 720 PATCH bodies
 * carrying the SAME six keys in different orders left 720 prepared statements
 * and 2.8 MB of CachedPlanSource on one connection. See
 * {@link canonicalWriteEntries} for the ordering rule and why duplicates are
 * deliberately preserved.
 *
 * Every consumer of this list must use THIS function: the SET-clause build, the
 * cache fingerprint ({@link fingerprintSet}) and the param collector
 * ({@link collectSetParams}) must enumerate one identical order or the cached
 * statement and its params describe different writes.
 */
function writeEntries(qi: BuilderCtx, data: Record<string, unknown>): [string, unknown][] {
  return canonicalWriteEntries(
    qi.tableMeta,
    Object.entries(data).filter(([, v]) => v !== undefined),
  );
}

/** The key half of {@link writeEntries}, for the paths that need names only. */
function definedKeys(qi: BuilderCtx, row: Record<string, unknown>): string[] {
  return writeEntries(qi, row).map(([k]) => k);
}

/**
 * Refuse a `createMany` whose rows do not all name the SAME fields.
 *
 * `createMany` compiles ONE statement, and its column list is taken from the
 * first row alone, so a row that disagrees with the first row loses data in
 * both directions and silently:
 *
 * - a field the first row names and a later row OMITS is bound as NULL,
 *   overwriting that column's declared default (and failing outright on a NOT
 *   NULL column that has one);
 * - a field only a LATER row names is not in the column list at all, so its
 *   value never reaches the database.
 *
 * Neither shape is expressible as a single statement on every engine. The
 * row-major `VALUES` form can carry a per-cell `DEFAULT` keyword on
 * PostgreSQL, MySQL and SQL Server, but SQLite has no such grammar (`VALUES
 * (1, DEFAULT)` is a parse error there), and adopting it would also drop
 * PostgreSQL off the column-major `UNNEST` form that binds one array per
 * column rather than one placeholder per cell. So the honest answer is a
 * refusal that names the offending row and its differing columns.
 *
 * A single row is trivially uniform, and rows that all name the same fields
 * (the overwhelmingly common shape) cost one `Object.keys` pass and emit
 * byte-identical SQL.
 */
function assertUniformCreateManyRows(qi: BuilderCtx, rows: Record<string, unknown>[], firstKeys: string[]): void {
  const expected = new Set(firstKeys);
  for (let i = 1; i < rows.length; i++) {
    const rowKeys = definedKeys(qi, rows[i]!);
    const unexpected = rowKeys.filter((k) => !expected.has(k));
    // No stranger and the same count means the same set (object keys are unique).
    if (unexpected.length === 0 && rowKeys.length === expected.size) continue;
    const present = new Set(rowKeys);
    const missing = firstKeys.filter((k) => !present.has(k));
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`does not supply ${quoteList(missing)}`);
    if (unexpected.length > 0) parts.push(`supplies ${quoteList(unexpected)}, which the first row does not`);
    throw new ValidationError(
      `createMany on "${qi.table}": row ${i} ${parts.join(' and ')}. ` +
        'Every row must supply the same fields: createMany builds ONE statement whose column list comes from the ' +
        "first row, so a field a later row omits would be written as NULL over that column's default, and a field " +
        'only a later row names would be dropped. Supply the field explicitly on every row (a field set to ' +
        '`undefined` counts as omitted, exactly as it does in `create`), or split the call into one createMany per ' +
        'row shape.',
    );
  }
}

/** `a, b` → `"a", "b"`, for the field lists in {@link assertUniformCreateManyRows}. */
function quoteList(fields: string[]): string {
  return fields.map((f) => `"${f}"`).join(', ');
}

/**
 * Refuse a statement that carries more bind parameters than the engine takes.
 * Only the row-major `VALUES` form can get there (PostgreSQL's UNNEST form
 * binds one array per column), and past the limit the failure is a raw driver
 * or protocol error. Executing in chunks would change what one `createMany`
 * is (one statement, one RETURNING set), so the caller chooses the chunking.
 */
function assertWithinBindLimit(qi: BuilderCtx, paramCount: number, rowCount: number, columnCount: number): void {
  const limit = maxBindParameters(qi.dialect);
  if (limit === undefined || paramCount <= limit) return;
  const perChunk = Math.max(1, Math.floor(limit / Math.max(1, columnCount)));
  throw new ValidationError(
    `createMany on "${qi.table}": ${rowCount} rows of ${columnCount} columns need ${paramCount} bind parameters, ` +
      `over the ${qi.dialect.name} limit of ${limit} per statement. ` +
      `Split the rows into chunks of at most ${perChunk} and call createMany once per chunk ` +
      '(inside one `$transaction` if they must succeed or fail together).',
  );
}

export function buildCreateMany<T extends object>(
  qi: BuilderCtx,
  args: CreateManyArgs<T>,
  overBindLimit: 'refuse' | 'allow' = 'refuse',
  projection?: WriteProjection,
): DeferredQuery<T[]> {
  const prepared = prepareCreateMany<T>(qi, args, projection);
  if ('deferred' in prepared) return prepared.deferred;
  return emitCreateMany<T>(qi, prepared, prepared.rowValues, overBindLimit);
}

/**
 * `createMany()` as the statements it runs: one when the rows fit one
 * statement, else consecutive chunks that each do. The whole call is validated
 * once, before any chunk is built, so a refusal (a duplicate conflict key in
 * the last chunk included) sends nothing, and the chunks are sized before any
 * statement is built, so no engine's own per-statement check refuses one.
 *
 * Built eagerly and synchronously: the chunks read state the call set on the
 * builder (`skipGlobalFilters`), which a concurrent call could change across
 * an await.
 */
export function planCreateMany<T extends object>(
  qi: BuilderCtx,
  args: CreateManyArgs<T>,
  projection?: WriteProjection,
): { chunks: DeferredQuery<T[]>[]; rowsPerChunk: number } {
  const prepared = prepareCreateMany<T>(qi, args, projection);
  if ('deferred' in prepared) return { chunks: [prepared.deferred], rowsPerChunk: args.data.length };
  const rows = prepared.rowValues;
  const size = rowsPerStatement(qi, prepared);
  if (rows.length <= size) return { chunks: [emitCreateMany<T>(qi, prepared, rows, 'allow')], rowsPerChunk: size };
  const chunks: DeferredQuery<T[]>[] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(emitCreateMany<T>(qi, prepared, rows.slice(i, i + size), 'refuse'));
  }
  return { chunks, rowsPerChunk: size };
}

/** A `createMany` validated against every row, ready to emit in one statement or several. */
interface PreparedCreateMany {
  readonly conflict: ConflictPlan | null;
  /** The inserted columns (unquoted). */
  readonly columns: string[];
  readonly insert: Omit<BulkInsertStatementInput, 'rowValues'>;
  /** Every row's coerced values, in `columns` order. */
  readonly rowValues: unknown[][];
  readonly projection: WriteProjection | undefined;
}

/**
 * Everything `createMany` checks about the call, over every row, or the whole
 * answer when no row-values statement is needed (no rows, or rows of pure
 * defaults).
 */
function prepareCreateMany<T extends object>(
  qi: BuilderCtx,
  args: CreateManyArgs<T>,
  projection: WriteProjection | undefined,
): PreparedCreateMany | { deferred: DeferredQuery<T[]> } {
  const qt = qi.q(qi.table);
  // Validated on every call (UNSAFE only); it acts on onConflict's update.
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  // The data-independent half of onConflict is checked before the empty-data
  // shortcut, so a call is never valid with no rows and invalid with some.
  const conflict = args.onConflict === undefined ? null : resolveConflictPlan(qi, args);
  if (args.data.length === 0) {
    return {
      deferred: {
        sql: `SELECT * FROM ${qt} WHERE false`,
        params: [],
        transform: () => [],
        tag: `${qi.table}.createMany`,
      },
    };
  }

  assertWritable(qi, 'createMany');
  for (const row of args.data) {
    assertNoGeneratedColumns(qi, row as Record<string, unknown>, 'createMany');
  }

  const keys = definedKeys(qi, args.data[0] as Record<string, unknown>);
  assertUniformCreateManyRows(qi, args.data as Record<string, unknown>[], keys);
  const columns = keys.map((k) => qi.toColumn(k));
  if (conflict) assertConflictTargetSupplied(qi, conflict, columns);

  // No column named by the first row: every row is pure defaults (the bulk
  // counterpart of `create({ data: {} })`, see buildDefaultValuesInsert). The
  // uniformity check above has already established that EVERY row is empty.
  if (keys.length === 0) {
    return {
      deferred: {
        sql: buildDefaultValuesInsert(qi, args.data.length, args.skipDuplicates, projection),
        params: [],
        transform: (result) => result.rows.map((row) => parseWriteRow(qi, row, projection) as T),
        tag: `${qi.table}.createMany`,
      },
    };
  }

  const rowValues = args.data.map((row) => {
    const record = row as Record<string, unknown>;
    return keys.map((key) => coerceWriteValue(qi, key, record[key]));
  });
  if (conflict) {
    // Over every row, so a chunked call refuses before its first chunk is sent.
    assertNoDuplicateKeys(qi, conflict, columns, rowValues);
    if (qi.dialect.name === 'mysql') assertMysqlBulkUpsert(qi, conflict, columns, rowValues);
  }

  // Use actual Postgres types for array casts in the default PostgreSQL dialect.
  // Enum columns cast to `"EnumName"[]`, the generic text[] fallback would
  // type the UNNEST output as text, which Postgres refuses to coerce to the
  // enum ("column X is of type Y but expression is of type text").
  const typeCasts = columns.map((col) => {
    const enumType = whereMod.enumTypeForColumn(qi, col);
    return enumType ? `${qi.q(enumType)}[]` : whereMod.getColumnArrayType(qi, col);
  });
  const quotedColumns = columns.map((c) => qi.q(c));

  // ARRAY-TYPED COLUMNS force the row-at-a-time VALUES form.
  //
  // The default PostgreSQL shape is `SELECT * FROM UNNEST($1::text[], …)`,
  // one bound array per COLUMN. That is a column-major transpose, and it
  // cannot express an array-valued column: `unnest` flattens, so N rows each
  // holding a `text[]` arrive as one flat `text[]` and PostgreSQL rejects the
  // insert with 42804 ("column is of type text[] but expression is of type
  // text"). Single-row `create` never hit it because it binds each value
  // directly. Detected from the column's own declared type rather than from
  // the shape of the first row's value, so a row whose array column happens to
  // be null or absent still takes the correct form.
  //
  // json/jsonb columns stay on UNNEST. coerceWriteValue has already turned
  // every JS array bound to one into JSON TEXT, so the transpose has no
  // nested array to flatten (a raw `[1, 2, 3]` there used to become three
  // rows), and every other cell is a string, object or null that the driver
  // serializes as one array element.
  const hasArrayColumn = columns.some((col) => (qi.columnPgTypeMap.get(col) ?? '').startsWith('_'));

  return {
    conflict,
    columns,
    insert: {
      table: qt,
      columns: quotedColumns,
      columnArrayTypes: typeCasts,
      skipDuplicates: args.skipDuplicates,
      returning: writeReturningColumns(qi, projection),
      requireRowValues: hasArrayColumn,
    },
    rowValues,
    projection,
  };
}

/** One `createMany` statement over `rowValues` (all of a prepared call's rows, or a chunk of them). */
function emitCreateMany<T extends object>(
  qi: BuilderCtx,
  prepared: PreparedCreateMany,
  rowValues: unknown[][],
  overBindLimit: 'refuse' | 'allow',
): DeferredQuery<T[]> {
  const { conflict, columns, projection } = prepared;
  const insert = { ...prepared.insert, rowValues };
  if (conflict) {
    return buildBulkUpsert(qi, conflict, insert, columns, overBindLimit, projection) as DeferredQuery<T[]>;
  }
  const built = qi.dialect.buildBulkInsertStatement(insert);
  if (overBindLimit === 'refuse') assertWithinBindLimit(qi, built.params.length, rowValues.length, columns.length);

  return {
    sql: built.sql,
    params: built.params,
    transform: (result) => result.rows.map((row) => parseWriteRow(qi, row, projection) as T),
    tag: `${qi.table}.createMany`,
  };
}

/**
 * Rows one `createMany` statement may carry: the most that keep its bind
 * parameters within the engine's limit and, on SQL Server, its rows within
 * the 1000 a plain `INSERT ... VALUES` accepts. The parameter cost is measured
 * from one-row and two-row builds, which separates the per-row parameters from
 * the ones bound once per statement (an onConflict update's values); the
 * PostgreSQL UNNEST form binds one array per column, so its rows never run out.
 */
function rowsPerStatement(qi: BuilderCtx, prepared: PreparedCreateMany): number {
  // An onConflict statement (SQL Server's MERGE) reads its rows as a derived
  // table, which the plain INSERT ... VALUES row cap does not bind.
  const cap = qi.dialect.maxInsertRows !== undefined && !prepared.conflict ? qi.dialect.maxInsertRows : Infinity;
  const limit = maxBindParameters(qi.dialect);
  const rows = prepared.rowValues;
  if (limit === undefined || rows.length < 2) return cap;
  const one = emitCreateMany(qi, prepared, rows.slice(0, 1), 'allow').params.length;
  const perRow = emitCreateMany(qi, prepared, rows.slice(0, 2), 'allow').params.length - one;
  if (perRow <= 0) return cap;
  const fixed = Math.max(0, one - perRow);
  return Math.max(1, Math.min(cap, Math.floor((limit - fixed) / perRow)));
}

// ---------------------------------------------------------------------------
// createMany({ onConflict }): the multi-row upsert
// ---------------------------------------------------------------------------

/** A `createMany` `onConflict`, validated against the table. */
interface ConflictPlan {
  /** The target's columns (unquoted): the primary key or one non-partial unique key. */
  readonly target: readonly string[];
  /** The conflict-UPDATE's data, or `null` to skip conflicting rows. */
  readonly update: Record<string, unknown> | null;
  /** A predicate on the EXISTING row limiting the update, or `null`. */
  readonly where: Record<string, unknown> | null;
}

const ON_CONFLICT_KEYS: ReadonlySet<string> = new Set(['target', 'update', 'where', 'ignore']);

/**
 * Validate the data-independent half of `onConflict`: the engine supports it,
 * its shape, its target names exactly one unique key, and its update and
 * where are usable. Every refusal is E003 except an engine gap (E017).
 */
function resolveConflictPlan<T extends object>(qi: BuilderCtx, args: CreateManyArgs<T>): ConflictPlan {
  const table = qi.table;
  if (!qi.dialect.supportsBulkUpsert || typeof qi.dialect.buildBulkUpsertStatement !== 'function') {
    throw new UnsupportedFeatureError(
      'createMany onConflict',
      qi.dialect.name,
      'This engine has no multi-row upsert statement. Call upsert() per row inside $transaction.',
    );
  }
  if (args.skipDuplicates) {
    throw new ValidationError(
      `createMany on "${table}": onConflict and skipDuplicates cannot be combined. skipDuplicates skips a ` +
        'conflict on ANY unique key, onConflict names one; to skip conflicts on that key, use ' +
        'onConflict: { target, ignore: true }.',
    );
  }
  const oc = args.onConflict as unknown;
  if (!isPlainRecord(oc)) {
    throw new ValidationError(
      `createMany on "${table}": onConflict must be { target, update } or { target, ignore: true }.`,
    );
  }
  const unknownKey = Object.keys(oc).find((k) => !ON_CONFLICT_KEYS.has(k) && oc[k] !== undefined);
  if (unknownKey !== undefined) {
    throw new ValidationError(
      `createMany on "${table}": onConflict has no option "${unknownKey}". It takes target, update, where and ignore.`,
    );
  }
  const target = resolveConflictTarget(qi, oc.target);
  if (oc.ignore !== undefined && oc.ignore !== true) {
    throw new ValidationError(`createMany on "${table}": onConflict.ignore takes \`true\` only.`);
  }
  if (oc.ignore === true) {
    if (oc.update !== undefined || oc.where !== undefined) {
      throw new ValidationError(
        `createMany on "${table}": onConflict takes either ignore: true or update (with an optional where), not both.`,
      );
    }
    return { target, update: null, where: null };
  }
  return { target, update: resolveConflictUpdate(qi, oc.update), where: resolveConflictWhere(qi, oc.where) };
}

function resolveConflictTarget(qi: BuilderCtx, raw: unknown): string[] {
  const table = qi.table;
  if (!Array.isArray(raw) || raw.length === 0 || raw.some((f) => typeof f !== 'string')) {
    throw new ValidationError(
      `createMany on "${table}": onConflict.target must be a non-empty array of field names (the primary key or ` +
        `one unique key), e.g. target: ['email']. Valid targets: ${describeConflictTargets(qi)}.`,
    );
  }
  const columns: string[] = [];
  for (const field of raw as string[]) {
    const column = resolveColumnName(qi.tableMeta, field);
    if (column === undefined) {
      throw new ValidationError(
        `createMany on "${table}": onConflict.target names "${field}", which is not a column. ` +
          `Valid targets: ${describeConflictTargets(qi)}.`,
      );
    }
    if (columns.includes(column)) {
      throw new ValidationError(`createMany on "${table}": onConflict.target names "${field}" twice.`);
    }
    columns.push(column);
  }
  const wanted = new Set(columns);
  const sameSet = (set: readonly string[]) => set.length === wanted.size && set.every((c) => wanted.has(c));
  if (uniqueKeyNames(qi.tableMeta).some(sameSet)) return columns;
  const partial = qi.tableMeta.indexes.some((idx) => idx.unique && idx.partial && sameSet(idx.columns));
  throw new ValidationError(
    `createMany on "${table}": onConflict.target (${columns.map((c) => fieldOf(qi, c)).join(', ')}) ` +
      (partial
        ? 'is a PARTIAL unique index, which a conflict clause can only use by restating its predicate. '
        : 'is not the primary key or a unique key of the table, as the schema metadata knows it. ') +
      `Valid targets: ${describeConflictTargets(qi)}.`,
  );
}

function fieldOf(qi: BuilderCtx, column: string): string {
  return qi.tableMeta.reverseColumnMap[column] ?? column;
}

function describeConflictTargets(qi: BuilderCtx): string {
  const keys = uniqueKeyNames(qi.tableMeta);
  if (keys.length === 0) return '(none: the table has no primary key or unique key in its metadata)';
  return keys.map((cols) => `[${cols.map((c) => `'${fieldOf(qi, c)}'`).join(', ')}]`).join(', ');
}

/** The conflict-UPDATE's data: the field-list shorthand becomes `{ f: expr.excluded(f) }`. */
function resolveConflictUpdate(qi: BuilderCtx, raw: unknown): Record<string, unknown> {
  const empty = new ValidationError(
    `createMany on "${qi.table}": onConflict.update is empty; use onConflict: { target, ignore: true } to skip ` +
      'conflicting rows.',
  );
  if (Array.isArray(raw)) {
    if (raw.length === 0) throw empty;
    const update: Record<string, unknown> = {};
    for (const field of raw) {
      if (typeof field !== 'string') {
        throw new ValidationError(
          `createMany on "${qi.table}": onConflict.update as a list takes field names, got ${typeof field}.`,
        );
      }
      if (Object.hasOwn(update, field)) {
        throw new ValidationError(`createMany on "${qi.table}": onConflict.update names "${field}" twice.`);
      }
      update[field] = exprBuilders.excluded(field);
    }
    return update;
  }
  if (!isPlainRecord(raw)) {
    throw new ValidationError(
      `createMany on "${qi.table}": onConflict.update takes a list of field names or a { field: value } object.`,
    );
  }
  if (!Object.values(raw).some((v) => v !== undefined)) throw empty;
  assertNoGeneratedColumns(qi, raw, 'createMany');
  return raw;
}

/**
 * `onConflict.where`, with `undefined` keys pruned as in every `where`. One
 * whose every key was `undefined` is refused: dropping it would update the
 * rows it was written to protect.
 */
function resolveConflictWhere(qi: BuilderCtx, raw: unknown): Record<string, unknown> | null {
  if (raw === undefined) return null;
  if (!isPlainRecord(raw)) {
    throw new ValidationError(`createMany on "${qi.table}": onConflict.where must be a where object.`);
  }
  const pruned = pruneUndefinedArgs(qi.schema, qi.table, { where: raw }).where as Record<string, unknown>;
  if (Object.keys(pruned).length === 0) {
    if (Object.keys(raw).length > 0) {
      throw new ValidationError(
        `createMany on "${qi.table}": every key in onConflict.where was undefined, so it would restrict nothing. ` +
          'Check the values you meant to filter on, or leave where out to update every conflicting row.',
      );
    }
    return null;
  }
  return pruned;
}

/** Every row must supply every target column: a row without its key cannot conflict on it. */
function assertConflictTargetSupplied(qi: BuilderCtx, conflict: ConflictPlan, columns: string[]): void {
  const missing = conflict.target.filter((c) => !columns.includes(c));
  if (missing.length === 0) return;
  throw new ValidationError(
    `createMany onConflict on "${qi.table}": the target field ${missing.map((c) => `"${fieldOf(qi, c)}"`).join(', ')} ` +
      'is missing from the rows. Every row must supply every target field; a key the database generates ' +
      '(an identity or serial id it has not assigned yet) cannot be a conflict target.',
  );
}

/** A byte-equality token for one coerced key value. */
function keyToken(value: unknown): string {
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (value instanceof Uint8Array) s = Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
  else s = String(value);
  return `${s.length}:${s}`;
}

/**
 * Refuse two rows of one call that share a conflict key, before any SQL. The
 * engines disagree on it (PostgreSQL raises 21000, SQL Server's MERGE 8672,
 * SQLite and MySQL apply the rows in sequence), and chunking at the bind
 * limit would turn the error into "the second chunk updates the first chunk's
 * row". Byte-equal on the coerced values, so a case-insensitive collation can
 * still let two rows through. A row with NULL in the key never conflicts.
 */
function assertNoDuplicateKeys(
  qi: BuilderCtx,
  conflict: ConflictPlan,
  columns: string[],
  rowValues: unknown[][],
): void {
  const at = conflict.target.map((c) => columns.indexOf(c));
  const seen = new Map<string, number>();
  for (let i = 0; i < rowValues.length; i++) {
    const row = rowValues[i]!;
    const parts = at.map((j) => row[j]);
    if (parts.some((v) => v === null || v === undefined)) continue;
    const key = parts.map(keyToken).join('|');
    const first = seen.get(key);
    if (first !== undefined) {
      throw new ValidationError(
        `createMany onConflict on "${qi.table}": rows ${first} and ${i} share the conflict key ` +
          `(${conflict.target.map((c) => fieldOf(qi, c)).join(', ')}). One statement cannot insert or update one ` +
          'key twice; merge those rows first.',
      );
    }
    seen.set(key, i);
  }
}

/**
 * The E003 for two rows of one `createMany({ onConflict })` that share a key
 * only under the column's comparison rules (a case-insensitive collation, a
 * `citext` column), which the byte-equality check above cannot see.
 */
function conflictKeySharedError(qi: BuilderCtx, target: readonly string[], cause?: unknown): ValidationError {
  return new ValidationError(
    `createMany onConflict on "${qi.table}": two rows in this call share the conflict key ` +
      `(${target.map((c) => fieldOf(qi, c)).join(', ')}) under the column's comparison rules (a case-insensitive ` +
      'collation, for example), so one statement would insert or update one row twice. Merge those rows first.',
    cause === undefined ? undefined : { cause },
  );
}

/**
 * `err` from running a `createMany({ onConflict })`, with the engine's
 * "one statement touched one row twice" errors (PostgreSQL 21000, SQL Server
 * 8672) turned into the E003 that names the cause. Anything else is returned
 * as it was.
 */
export function explainConflictKeyCollision(
  qi: BuilderCtx,
  args: { readonly onConflict?: unknown },
  err: unknown,
): unknown {
  if (args.onConflict === undefined || !touchedRowTwice(err)) return err;
  const raw = (args.onConflict as { target?: unknown }).target;
  const target = Array.isArray(raw)
    ? raw.map((f) => (typeof f === 'string' ? (resolveColumnName(qi.tableMeta, f) ?? f) : String(f)))
    : [];
  return conflictKeySharedError(qi, target, err);
}

/** PostgreSQL 21000 or SQL Server 8672 on `err` or a cause under it (Turbine wraps or scrubs driver errors). */
function touchedRowTwice(err: unknown): boolean {
  let e = err as { code?: unknown; sqlstate?: unknown; number?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; depth < 4 && e && typeof e === 'object'; depth++) {
    if (e.code === '21000' || e.sqlstate === '21000' || e.number === 8672) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/**
 * MySQL's ON DUPLICATE KEY UPDATE has no conflict target: it fires on
 * WHATEVER unique key a row violates, and with several matching keys it
 * updates one row. So the target must be the only key a row can violate, and
 * the shapes that need a predicate slot or a per-row outcome are refused.
 */
function assertMysqlBulkUpsert(
  qi: BuilderCtx,
  conflict: ConflictPlan,
  columns: string[],
  rowValues: unknown[][],
): void {
  const fix = (why: string, hint: string) =>
    new UnsupportedFeatureError(`createMany onConflict on "${qi.table}" ${why}`, 'mysql', hint);
  if (conflict.update === null) {
    throw fix(
      'with ignore: true',
      'MySQL cannot tell the inserted rows from the skipped ones afterwards. Use onConflict: { target, update }.',
    );
  }
  if (conflict.where !== null) {
    throw fix('with a where', 'ON DUPLICATE KEY UPDATE has no predicate slot.');
  }
  const gf = whereMod.resolveGlobalFilter(qi, qi.table);
  if (gf && whereMod.buildRenderedRefWhere(qi, qi.table, qi.tableMeta, qi.q(qi.table), gf, [])) {
    throw fix(
      'on a table with a global filter',
      "ON DUPLICATE KEY UPDATE cannot carry the filter, so another tenant's row could be updated. Call upsert() " +
        'per row, or pass skipGlobalFilters: UNSAFE.',
    );
  }
  // The single-row upsert's rule (otherCollidingUniqueKey), on column presence
  // so the verdict does not depend on the rows' values.
  const present = new Set(columns);
  const other = otherCollidingUniqueKey(qi.tableMeta, [conflict.target], (c) => (present.has(c) ? 'value' : 'absent'));
  if (other) {
    throw fix(
      `with target (${conflict.target.map((c) => fieldOf(qi, c)).join(', ')})`,
      `"${qi.table}" has another unique key (${other.map((c) => fieldOf(qi, c)).join(', ')}) that a row in data can ` +
        "collide on, and MySQL's ON DUPLICATE KEY UPDATE cannot be limited to one key, so it could update a row the " +
        'target does not name. Call upsert() per row (it looks each row up first), or leave that key out of data.',
    );
  }
  const at = conflict.target.map((c) => columns.indexOf(c));
  if (rowValues.some((row) => at.some((j) => row[j] === null || row[j] === undefined))) {
    throw fix(
      'with a NULL in a target field',
      'MySQL returns the written rows by re-reading them by key, and a NULL key reads back nothing. Supply every ' +
        'target value.',
    );
  }
}

/** The SELECT that re-reads a MySQL multi-row upsert's rows by their conflict keys. */
function buildKeyReselect(
  qi: BuilderCtx,
  conflict: ConflictPlan,
  columns: string[],
  rowValues: unknown[][],
  projection: WriteProjection | undefined,
): { sql: string; params: unknown[] } {
  const at = conflict.target.map((c) => columns.indexOf(c));
  const params: unknown[] = [];
  const tuples = rowValues.map((row) => {
    const refs = at.map((j, k) => {
      params.push(reselectKeyValue(qi, conflict.target[k]!, row[j]));
      return qi.p(params.length);
    });
    return refs.length === 1 ? refs[0] : `(${refs.join(', ')})`;
  });
  const keyCols = conflict.target.map((c) => qi.q(c));
  const lhs = keyCols.length === 1 ? keyCols[0] : `(${keyCols.join(', ')})`;
  return {
    sql: `SELECT ${writeReselectSelection(qi, projection)} FROM ${qi.q(qi.table)} WHERE ${lhs} IN (${tuples.join(', ')})`,
    params,
  };
}

function buildBulkUpsert(
  qi: BuilderCtx,
  conflict: ConflictPlan,
  insert: Omit<Parameters<NonNullable<typeof qi.dialect.buildBulkUpsertStatement>>[0], 'conflictColumns' | 'update'>,
  columns: string[],
  overBindLimit: 'refuse' | 'allow',
  projection: WriteProjection | undefined,
): DeferredQuery<Record<string, unknown>[]> {
  // The duplicate-key and MySQL checks ran over every row in prepareCreateMany.
  const rowValues = insert.rowValues;
  // `updatedAt` columns are stamped on the conflict-UPDATE as update() stamps
  // them, unless the update names the column.
  const updateData = conflict.update ? applyUpdatedAtColumns(qi, conflict.update) : null;
  const insertColumns: ReadonlySet<string> = new Set(columns);
  const gf = whereMod.resolveGlobalFilter(qi, qi.table);
  const built = qi.dialect.buildBulkUpsertStatement!({
    ...insert,
    skipDuplicates: false,
    conflictColumns: conflict.target.map((c) => qi.q(c)),
    update: updateData
      ? (params, refs: BulkUpsertRefs) => {
          const setClauses = buildSetClauses(qi, writeEntries(qi, updateData), params, {
            operation: 'createMany',
            target: refs.target,
            incoming: refs.incoming,
            insertColumns,
          });
          // The caller's predicate and the global filter both read the EXISTING
          // row, so a row they exclude is neither updated nor returned (and,
          // its key being taken, not inserted either). Inserts are not filtered,
          // as create() is not.
          const predicates: string[] = [];
          for (const where of [conflict.where, gf]) {
            if (!where) continue;
            const sql = whereMod.buildRenderedRefWhere(qi, qi.table, qi.tableMeta, refs.target, where, params);
            if (sql) predicates.push(sql);
          }
          return {
            setClauses,
            where: predicates.length <= 1 ? (predicates[0] ?? null) : predicates.map((p) => `(${p})`).join(' AND '),
          };
        }
      : null,
  });
  if (overBindLimit === 'refuse') {
    assertWithinBindLimit(qi, built.params.length, rowValues.length, columns.length);
  }
  return {
    sql: built.sql,
    params: built.params,
    // The rows written: inserted or updated. A row `ignore` skipped, or one the
    // predicate or a global filter excluded, is not in the result, and the
    // order is the engine's, not the input's.
    transform: (result) => result.rows.map((row) => parseWriteRow(qi, row, projection)),
    tag: `${qi.table}.createMany`,
    reselect:
      qi.dialect.resultStrategy === 'reselect'
        ? async (exec) => {
            await exec(built.sql, built.params);
            const sel = buildKeyReselect(qi, conflict, columns, rowValues, projection);
            const result = await exec(sel.sql, sel.params);
            // Every row was inserted or updated and byte-equal keys were
            // refused up front, so fewer rows back means two rows' keys are
            // equal under the column's collation and MySQL applied the second
            // as an update of the first. Refused, which rolls the call back.
            if (result.rows.length < rowValues.length) throw conflictKeySharedError(qi, conflict.target);
            return result;
          }
        : undefined,
  };
}

export function buildUpdate<T extends object>(
  qi: BuilderCtx,
  args: UpdateArgs<T>,
  projection?: WriteProjection,
): DeferredQuery<T> {
  assertWritable(qi, 'update');
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  // `updatedAt`-tagged columns are filled in before anything reads `data`, so
  // the SET list, the fingerprint and the param collector all see one object.
  const dataObj = applyUpdatedAtColumns(qi, args.data as Record<string, unknown>);
  assertNoGeneratedColumns(qi, dataObj, 'update');
  // Prisma compound-unique selector (e.g. `{ orgId_userId: { orgId, userId } }`)
  // → the column conjunction, before the empty-`where` guard so the expanded
  // members count as a real predicate.
  const userWhere = expandCompoundUniqueWhere(qi.tableMeta, args.where as Record<string, unknown>);
  const lock = args.optimisticLock;
  // The empty-`where` guard checks the USER predicate only, a global filter
  // must never turn an unguarded mass update into an allowed one.
  const userHasPredicate = !whereMod.userPredicateIsEmpty(qi, userWhere) || !!lock;
  const allowFullTableScan = resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan');
  whereMod.assertMutationHasPredicate(qi, 'update', userHasPredicate ? ' WHERE x' : '', allowFullTableScan);
  // `update` returns ONE row, so its where must identify one: the 0.73
  // `findUnique` rule (query/compound-unique.ts) applied to the write that has
  // the same shape. On the USER's where, before the global filter is merged
  // (a filter narrows, it never identifies), and skipped only under the
  // explicit full-table opt-in, which already means "every row".
  if (!allowFullTableScan) assertMutationWhereIdentifiesOneRow(qi.tableMeta, qi.table, userWhere, 'update');
  // The SQL is built from the global-filter-merged where (soft-delete keeps an
  // update from touching already-deleted rows).
  const whereObj = (whereMod.mergeGlobalFilter(qi, userWhere) ?? {}) as Record<string, unknown>;

  // An update with nothing to set is a NO-OP that returns the current row.
  //
  // It used to render `UPDATE t SET WHERE …` and fail with a raw PostgreSQL
  // 42601 syntax error. That is easy to hit honestly: any handler that builds
  // its payload from optional request fields produces `{}` on a request that
  // supplied none of them, so a legitimate request turned into a 500. Prisma
  // treats the same call as a no-op and returns the row, so a ported handler
  // inherited a crash where the original returned 200.
  //
  // The row is re-selected through the same projection a real update would
  // return (PII columns excluded on tagged tables), and a where matching no
  // row still raises NotFoundError, so only the SQL differs, not the contract.
  // `optimisticLock` is excluded: it always has a version column to SET and a
  // version check that must still run.
  const hasSetData = Object.values(dataObj).some((v) => v !== undefined);
  if (!hasSetData && !lock) {
    const sel = buildReselectByWhere(qi, whereObj, projection);
    return {
      sql: sel.sql,
      params: sel.params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) throw new NotFoundError({ table: qi.table, where: args.where, operation: 'update' });
        return parseWriteRow(qi, row, projection) as T;
      },
      tag: `${qi.table}.update`,
    };
  }

  const setFp = fingerprintSet(qi, dataObj);
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = lock
    ? null
    : `u:${setFp}|${whereFp}${whereMod.globalFilterCacheSegment(qi)}${writeProjectionCacheSegment(projection)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const setClauses = buildSetClauses(qi, writeEntries(qi, dataObj), freshParams);

    if (lock) {
      const versionCol = qi.toSqlColumn(lock.field);
      setClauses.push(`${versionCol} = ${versionCol} + 1`);
    }

    const whereClause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    let whereSql = whereClause ? ` WHERE ${whereClause}` : '';

    if (lock) {
      const versionCol = qi.toSqlColumn(lock.field);
      freshParams.push(lock.expected);
      const versionCheck = `${versionCol} = ${qi.p(freshParams.length)}`;
      whereSql = whereSql ? `${whereSql} AND ${versionCheck}` : ` WHERE ${versionCheck}`;
    }

    // Engines that inject their returning shape MID-statement (SQL Server
    // `OUTPUT INSERTED.*` between SET and WHERE) override buildUpdateStatement;
    // absent → the trailing-clause PG/SQLite/MySQL form (byte-identical).
    // `returning` excludes PII columns on tagged tables (else '*').
    const returning = writeReturningColumns(qi, projection);
    return qi.dialect.buildUpdateStatement
      ? qi.dialect.buildUpdateStatement({ table: qi.q(qi.table), setClauses, whereSql, returning })
      : `UPDATE ${qi.q(qi.table)} SET ${setClauses.join(', ')}${whereSql}${qi.dialect.buildReturningClause(returning)}`;
  };

  let sql: string;
  let preparedName: string | undefined;
  let cacheEntry: SqlCacheEntry | undefined;

  if (ck) {
    cacheEntry = qi.acquireSql(ck, buildSql);
    sql = cacheEntry.sql;
    preparedName = cacheEntry.name;
  } else {
    // optimisticLock path: value-variant version check → uncacheable, no cross-check.
    sql = buildSql([]);
  }

  // Collect params: SET first, then WHERE, then version check (same order as fresh build)
  collectSetParams(qi, dataObj, params);
  whereMod.collectWhereParams(qi, whereObj, params);
  if (lock) {
    params.push(lock.expected);
  }
  if (ck && cacheEntry) {
    qi.crossCheckCache('update', ck, cacheEntry, buildSql, params);
  }

  return {
    sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        if (lock) {
          throw new OptimisticLockError({
            table: qi.table,
            versionField: lock.field,
            expectedVersion: lock.expected,
          });
        }
        throw new NotFoundError({
          table: qi.table,
          where: args.where,
          operation: 'update',
        });
      }
      return parseWriteRow(qi, row, projection) as T;
    },
    tag: `${qi.table}.update`,
    preparedName,
    // Non-RETURNING engines: UPDATE, then re-fetch the row by the same where.
    reselect:
      qi.dialect.resultStrategy === 'reselect'
        ? async (exec) => {
            // Runs in one transaction (executeMutation), savepointed inside a
            // caller's. When the write may move the row out of `where` (it sets
            // a column `where` reads, the version column included), the row is
            // locked and re-read by its key, since `where` no longer finds it.
            const written = namedColumns(qi.tableMeta, dataObj);
            if (lock) written.add(qi.toColumn(lock.field));
            const key = writeMayMoveRow(qi, whereObj, written)
              ? await lockMovedRowKey(qi, exec, whereObj, dataObj, 'update', allowFullTableScan)
              : undefined;
            if (key === null) return { rows: [], rowCount: 0 };
            const writeResult = await exec(sql, params, preparedName);
            // Optimistic-lock conflict: the version-checked UPDATE matched no
            // row. The re-fetch below uses `where` WITHOUT the version
            // predicate, so it would return the stale row and silently mask
            // the conflict, detect it from affected-rows here instead, to
            // match the OptimisticLockError thrown on RETURNING/OUTPUT engines.
            if (lock && (writeResult.rowCount ?? 0) === 0) {
              throw new OptimisticLockError({
                table: qi.table,
                versionField: lock.field,
                expectedVersion: lock.expected,
              });
            }
            const sel = buildReselectByWhere(qi, key ?? whereObj, projection);
            const result = await exec(sel.sql, sel.params);
            // `update` writes one row; more than one here means the engine
            // matched the where loosely, and the write is rolled back.
            if (key || !allowFullTableScan) {
              assertOneRowByKey(
                qi,
                'update',
                key ? identityColumns(qi) : whereColumns(qi, userWhere),
                result.rows.length,
              );
            }
            return result;
          }
        : undefined,
  };
}

export function buildDelete<T extends object>(
  qi: BuilderCtx,
  args: DeleteArgs<T>,
  projection?: WriteProjection,
): DeferredQuery<T> {
  assertWritable(qi, 'delete');
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  // Prisma compound-unique selector → the column conjunction (before the guard).
  const userWhere = expandCompoundUniqueWhere(qi.tableMeta, args.where as Record<string, unknown>);
  // Guard the USER predicate (a global filter must not satisfy the guard).
  const allowFullTableScan = resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan');
  whereMod.assertMutationHasPredicate(
    qi,
    'delete',
    whereMod.userPredicateIsEmpty(qi, userWhere) ? '' : ' WHERE x',
    allowFullTableScan,
  );
  // Same identity rule as `update` (see buildUpdate): one returned row means
  // one addressed row. `deleteMany` is the many-row path.
  if (!allowFullTableScan) assertMutationWhereIdentifiesOneRow(qi.tableMeta, qi.table, userWhere, 'delete');
  const whereObj = (whereMod.mergeGlobalFilter(qi, userWhere) ?? {}) as Record<string, unknown>;
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = `d:${whereFp}${whereMod.globalFilterCacheSegment(qi)}${writeProjectionCacheSegment(projection)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const clause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    const whereSql = clause ? ` WHERE ${clause}` : '';
    // SQL Server injects `OUTPUT DELETED.*` between `DELETE FROM <t>` and WHERE;
    // absent override → the trailing-clause PG/SQLite/MySQL form (byte-identical).
    // `returning` excludes PII columns on tagged tables (else '*').
    const returning = writeReturningColumns(qi, projection);
    return qi.dialect.buildDeleteStatement
      ? qi.dialect.buildDeleteStatement({ table: qi.q(qi.table), whereSql, returning })
      : `DELETE FROM ${qi.q(qi.table)}${whereSql}${qi.dialect.buildReturningClause(returning)}`;
  };
  const entry = qi.acquireSql(ck, buildSql);

  whereMod.collectWhereParams(qi, whereObj, params);
  qi.crossCheckCache('delete', ck, entry, buildSql, params);

  return {
    sql: entry.sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        throw new NotFoundError({
          table: qi.table,
          where: args.where,
          operation: 'delete',
        });
      }
      return parseWriteRow(qi, row, projection) as T;
    },
    tag: `${qi.table}.delete`,
    preparedName: entry.name,
    // Non-RETURNING engines: the row is gone after DELETE, so pre-SELECT it
    // by the same where, then run the DELETE, returning the captured row.
    reselect:
      qi.dialect.resultStrategy === 'reselect'
        ? async (exec) => {
            // In one transaction (executeMutation): the row is locked while it
            // is read, and returned only if THIS delete removed it, so of two
            // concurrent deletes of one row exactly one reports it.
            const sel = buildReselectByWhere(qi, whereObj, projection, true);
            const pre = await exec(sel.sql, sel.params);
            // `delete` removes one row; refused before the DELETE when the
            // engine matched the where loosely.
            if (!allowFullTableScan) assertOneRowByKey(qi, 'delete', whereColumns(qi, userWhere), pre.rows.length);
            const deleted = await exec(entry.sql, params, entry.name);
            return (deleted.rowCount ?? 0) === 0 ? { rows: [], rowCount: 0 } : pre;
          }
        : undefined,
  };
}

/**
 * Refuse `limit` / `take` / `offset` / `skip` on `updateMany` / `deleteMany`.
 * No engine applies them to a bulk write here, so `deleteMany({ where, limit:
 * 1000 })` used to touch every matching row. Shared with the PowDB engine.
 */
export function assertNoBulkWritePaging(table: string, operation: 'updateMany' | 'deleteMany', args: object): void {
  const a = args as Record<string, unknown>;
  const key = (['limit', 'take', 'offset', 'skip'] as const).find((k) => a[k] !== undefined);
  if (key === undefined) return;
  throw new ValidationError(
    `\`${key}\` is not supported on ${operation} for "${table}": it would apply to every row the \`where\` ` +
      `matches, not ${key === 'limit' || key === 'take' ? 'only the first ones' : 'skip any'}. To ${operation === 'deleteMany' ? 'delete' : 'update'} a bounded batch, ` +
      'select the ids first (`findMany({ where, select: { id: true }, orderBy, limit })`), then pass ' +
      '`where: { id: { in: ids } }`.',
  );
}

/**
 * Refuse `optimisticLock` on a write that does not implement it. It is an
 * `update` option; on a sibling method it used to be ignored, so a stale
 * write went through with no error, which is the one outcome the option
 * exists to prevent. The message names the equivalent for each method.
 */
export function assertNoOptimisticLock(qi: BuilderCtx, args: object, operation: 'upsert' | 'updateMany'): void {
  const lock = (args as { optimisticLock?: { field?: unknown } }).optimisticLock;
  if (lock === undefined) return;
  const field = typeof lock?.field === 'string' ? lock.field : 'version';
  throw new ValidationError(
    `\`optimisticLock\` is an \`update\` option and ${operation} on "${qi.table}" does not apply it. ` +
      (operation === 'updateMany'
        ? `Put the expected version in \`where\` (\`${field}: expected\`) and bump it in \`data\` ` +
          `(\`${field}: { increment: 1 }\`); the returned count is the number of rows that were still at that version.`
        : 'Inside one `$transaction`, read the row by `where`, then call `update({ where, data, optimisticLock })` ' +
          'when it exists or `create` when it does not.'),
  );
}

/**
 * Why an `upsert` cannot run as this engine's single conflict statement, or
 * `null` when it can. The one authority for that decision: `upsert()` asks it
 * to choose between the statement and a lookup by `where` inside a
 * transaction, and `buildUpsert` asks it to refuse the shapes its one
 * statement cannot express, since a `DeferredQuery` (a pipeline, an array
 * `$transaction`) has no second round trip to look anything up with.
 *
 * - `where-differs`: `where` is not pinned to `create`'s values, so the
 *   conflict statement would compare the wrong row (upsertWhereMatchesCreate).
 * - `empty-update`: an `update` with no fields has no `DO UPDATE SET` to emit;
 *   every engine rejected the statement as a syntax error. Prisma reads it as
 *   "create it if it is missing", which the lookup answers.
 * - `other-unique-key` (MySQL): `ON DUPLICATE KEY UPDATE` has no conflict
 *   target and updates whichever row a unique key collides on first, so when
 *   `create` could also collide on a unique key `where` does not pin (the
 *   primary key included), it could update a row `where` does not name
 *   (otherCollidingUniqueKey).
 * - `global-filter`: MySQL's `ON DUPLICATE KEY UPDATE` has no predicate slot
 *   and SQL Server's MERGE cannot take the builder's column references there,
 *   so the table's global filter cannot guard the conflict update. The lookup
 *   and the update both carry the filter, so another tenant's row is invisible
 *   to them.
 *
 * Reads `currentSkip`, so it resolves `skipGlobalFilters` itself first.
 */
export type UpsertLookupReason = 'where-differs' | 'empty-update' | 'other-unique-key' | 'global-filter';

export function upsertLookupReason<T extends object>(qi: BuilderCtx, args: UpsertArgs<T>): UpsertLookupReason | null {
  assertNoOptimisticLock(qi, args, 'upsert');
  const where = (args.where ?? {}) as Record<string, unknown>;
  const create = (args.create ?? {}) as Record<string, unknown>;
  if (!upsertWhereMatchesCreate(qi.tableMeta, where, create)) return 'where-differs';
  if (writeEntries(qi, (args.update ?? {}) as Record<string, unknown>).length === 0) return 'empty-update';
  // By name, not by a hook: every engine dialect spreads postgresDialect.
  if (qi.dialect.name === 'mysql' && upsertCreateCollidingKey(qi.tableMeta, where, create)) return 'other-unique-key';
  if (!qi.dialect.supportsUpsertUpdateWhere) {
    qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
    const filter = whereMod.resolveGlobalFilter(qi, qi.table);
    if (filter && whereMod.buildRenderedRefWhere(qi, qi.table, qi.tableMeta, qi.q(qi.table), filter, [])) {
      return 'global-filter';
    }
  }
  return null;
}

/** The refusal `buildUpsert` raises for each reason, naming the way forward. */
function upsertStatementRefusal(
  qi: BuilderCtx,
  reason: UpsertLookupReason,
  where: Record<string, unknown>,
  create: Record<string, unknown>,
): Error {
  const call = 'Call `upsert()` unbatched: it looks the row up by `where` first.';
  if (reason === 'other-unique-key') {
    const key = upsertCreateCollidingKey(qi.tableMeta, where, create) ?? [];
    return new UnsupportedFeatureError(
      `a batched upsert on "${qi.table}" whose \`create\` also sets another unique key${key.length > 0 ? ` (${key.map((c) => fieldOf(qi, c)).join(', ')})` : ''},`,
      qi.dialect.name,
      'ON DUPLICATE KEY UPDATE updates whichever row a unique key collides on first, which may not be the row `where` names. ' +
        call,
    );
  }
  if (reason === 'global-filter') {
    return new UnsupportedFeatureError(
      `a batched upsert on "${qi.table}", which has a global filter,`,
      qi.dialect.name,
      `Its upsert statement cannot carry the filter. ${call} Or pass \`skipGlobalFilters: UNSAFE\`.`,
    );
  }
  const keys = Object.keys(where).filter((k) => where[k] !== undefined);
  return new ValidationError(
    `A batched upsert on "${qi.table}" cannot be one statement: ` +
      (reason === 'empty-update'
        ? 'its `update` is empty. '
        : `\`where\` (${keys.join(', ')}) does not carry \`create\`'s values, which are what one statement matches on. `) +
      call,
  );
}

export function buildUpsert<T extends object>(
  qi: BuilderCtx,
  args: UpsertArgs<T>,
  projection?: WriteProjection,
): DeferredQuery<T> {
  assertWritable(qi, 'upsert');
  assertNoOptimisticLock(qi, args, 'upsert');
  assertNoGeneratedColumns(qi, args.create as Record<string, unknown>, 'upsert');
  assertNoGeneratedColumns(qi, args.update as Record<string, unknown>, 'upsert');
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  // Prisma compound-unique selector on the conflict target → its member columns.
  const upsertWhere = expandCompoundUniqueWhere(qi.tableMeta, args.where as Record<string, unknown>);
  // An upsert's `where` becomes the CONFLICT TARGET, so it carries the same
  // one-row contract `update` / `delete` do and is refused by the same rule
  // (query/compound-unique.ts), with its own sentence because the consequence
  // differs. Without it a non-unique `where` reached the server as
  // `ON CONFLICT ("role")` and came back as a bare SQLSTATE 42P10 on
  // PostgreSQL, and WORSE than an error on the engines that do not read the
  // conflict target back: MySQL's `ON DUPLICATE KEY UPDATE` ignores it and
  // keys off whichever unique index the row happens to violate, and SQL
  // Server's `MERGE ... ON` matches every row the predicate matches and
  // updates all of them.
  //
  // Before any SQL is assembled, and this is the only where-guard `upsert`
  // runs: `{}` and `{ email: undefined }` are refused here too, and by the
  // right sentence. The empty-`where` guard's own message points at
  // `allowFullTableScan: UNSAFE`, which is not an option on `UpsertArgs` at
  // all, so borrowing it here would name a way out that does not exist.
  assertMutationWhereIdentifiesOneRow(qi.tableMeta, qi.table, upsertWhere, 'upsert');
  // `upsert()` never reaches here with a reason (it looks the row up instead),
  // so this refuses only a batched upsert, which has no round trip to spare.
  const lookupReason = upsertLookupReason(qi, args);
  if (lookupReason) {
    throw upsertStatementRefusal(qi, lookupReason, upsertWhere, args.create as Record<string, unknown>);
  }
  // Build the INSERT part from create data
  const createEntries = writeEntries(qi, args.create as Record<string, unknown>);
  const columns = createEntries.map(([k]) => qi.toSqlColumn(k));
  const createParams = createEntries.map(([k, v]) => coerceWriteValue(qi, k, v));
  // Enum columns get an explicit `::"EnumName"` cast (see enumTypeForColumn).
  const placeholders = createEntries.map(([k], i) => `${qi.p(i + 1)}${whereMod.enumCastSuffix(qi, qi.toColumn(k))}`);

  // The conflict target comes from `where` keys, must be unique/PK columns
  const conflictKeys = Object.keys(upsertWhere).filter((k) => upsertWhere[k] !== undefined);
  const conflictColumns = conflictKeys.map((k) => qi.toSqlColumn(k));

  // The conflict-UPDATE SET goes through the SAME operator-aware compiler as
  // `update()` (buildSetClauses), so `set` / `increment` / `decrement` /
  // `multiply` / `divide` mean here what they mean there and a misspelled
  // operator gets the same E003. This branch used to bind each value directly,
  // which stored an operator OBJECT as the JSON text `{"set":"x"}` in a text
  // column with no error at all. buildSetClauses pushes onto `params` as it
  // goes, so the numbering continues after the create params exactly as the
  // hand-rolled `paramIdx` did. No SQL cache here (the statement is rebuilt per
  // call), so the fingerprint / collect mirrors update() keeps are not needed.
  // `updatedAt` columns are stamped on the conflict-UPDATE exactly as the
  // lookup path's `update()` stamps them, so the column does not depend on
  // which path an upsert takes. (An empty `update` never reaches here: it is
  // a lookup that leaves the found row untouched, stamp included.)
  //
  // `expr.excluded(f)` is `create`'s value for `f` (the incoming row of a
  // one-row upsert IS `create`), resolved before compiling so this path and the
  // lookup path's plain `update()` write the same row.
  const update = resolveExcludedFromCreate(
    qi,
    args.update as Record<string, unknown>,
    args.create as Record<string, unknown>,
  ) as Record<string, unknown>;
  const stampedUpdate = applyUpdatedAtColumns(qi, update);
  const updateEntries = writeEntries(qi, stampedUpdate);
  const params: unknown[] = [...createParams];
  const setClauses = buildSetClauses(qi, updateEntries, params, {
    operation: 'upsert',
    target: upsertTargetRef(qi),
  });

  // Global filter → restrict the conflict-UPDATE (soft-delete / tenancy) so an
  // upsert never resurrects a soft-deleted row or writes across tenants. Only
  // on engines whose upsert can carry a predicate (Postgres, SQLite); the gf
  // params continue the placeholder numbering after create+update params.
  //
  // Compiled against the TABLE QUALIFIER, not bare: in `ON CONFLICT ... DO
  // UPDATE ... WHERE` both the target table and `excluded` are in scope, so an
  // unqualified column is ambiguous and PostgreSQL rejected EVERY upsert on a
  // globally filtered table at parse time (42702), insert path included.
  let updateWhere: string | undefined;
  const upsertFilter = whereMod.resolveGlobalFilter(qi, qi.table);
  if (qi.dialect.supportsUpsertUpdateWhere) {
    const gf = upsertFilter;
    if (gf) {
      // Compiled through a scope whose FROM-item reference is ALREADY RENDERED
      // (`"users"`), which is what the target table is inside `ON CONFLICT ...
      // DO UPDATE`. `aliasWhereScope` is the wrong seam for that: it takes a
      // BARE alias and quotes it itself for the nested-relation correlation
      // parent, so handing it `q(table)` produced a triple-quoted reference
      // inside an EXISTS body and the whole statement failed with 42P01
      // whenever the configured global filter was a relation filter rather
      // than a plain column. A bare table name is not the answer either: it
      // would leave the qualifier unquoted and break every table whose name
      // needs quoting. `buildRenderedRefWhere` is the rendered-reference seam,
      // one parameter with one meaning, used for the qualifier and the
      // correlation parent alike, and shared with the batched `_count`
      // follow-up, which had the identical bug.
      updateWhere = whereMod.buildRenderedRefWhere(qi, qi.table, qi.tableMeta, qi.q(qi.table), gf, params) ?? undefined;
    }
  }

  const sql = qi.dialect.buildUpsertStatement({
    table: qi.q(qi.table),
    insertColumns: columns,
    valuePlaceholders: placeholders,
    conflictColumns,
    updateSetClauses: setClauses,
    updateWhere,
    returning: writeReturningColumns(qi, projection),
  });

  return {
    sql,
    params,
    transform: (result) => {
      const row = result.rows[0];
      if (!row) {
        // With a conflict-UPDATE predicate in play there IS a way to get no
        // row: the key conflicts with a row the global filter hides, the
        // predicate is false for it, the engine skips the update, and the
        // insert cannot happen either because the key is taken. Nothing was
        // written and the hidden row is untouched; say so, rather than "this
        // should never happen".
        throw new NotFoundError({
          table: qi.table,
          where: args.where,
          operation: 'upsert',
          message: updateWhere
            ? `upsert on "${qi.table}" wrote nothing: the row that conflicts on the given key is excluded by the ` +
              `configured global filter for "${qi.table}", so it was neither updated (the filter hides it) nor ` +
              'inserted (the key is taken). Pass `skipGlobalFilters: UNSAFE` to address it anyway.'
            : `upsert on "${qi.table}" returned no row from RETURNING *; this should never happen.`,
        });
      }
      return parseWriteRow(qi, row, projection) as T;
    },
    tag: `${qi.table}.upsert`,
    // Non-RETURNING engines: run the upsert, then re-fetch by the where keys.
    reselect:
      qi.dialect.resultStrategy === 'reselect'
        ? async (exec) => {
            const lookup = (whereMod.mergeGlobalFilter(qi, textSafeKeyWhere(qi, upsertWhere)) ?? {}) as Record<
              string,
              unknown
            >;
            // An update that sets a column `where` reads moves the row out of
            // `where`'s reach: lock it and re-read it by its key. An insert
            // matches `where` (this path requires `where` pinned to `create`),
            // so a row that is not there yet is re-read by `where`.
            const key = writeMayMoveRow(qi, lookup, namedColumns(qi.tableMeta, stampedUpdate))
              ? await lockMovedRowKey(qi, exec, lookup, stampedUpdate, 'upsert', false)
              : undefined;
            await exec(sql, params);
            const sel = buildReselectByWhere(qi, key ?? lookup, projection);
            const result = await exec(sel.sql, sel.params);
            assertOneRowByKey(
              qi,
              'upsert',
              key ? identityColumns(qi) : whereColumns(qi, upsertWhere),
              result.rows.length,
            );
            return result;
          }
        : undefined,
  };
}

/**
 * The rendered reference to an upsert's TARGET row, which every column the
 * conflict-UPDATE reads goes through (an arithmetic operator's column, an
 * expression's `col()`, a case predicate).
 *
 * `INSERT ... ON CONFLICT DO UPDATE SET n = n + 1` is 42702 on PostgreSQL
 * because `n` could be the target row's or `excluded`'s, so the reference is
 * qualified with the table name on every engine whose upsert statement names
 * the table directly (PostgreSQL, SQLite, MySQL all accept `"t"."n"` there).
 * SQL Server's `MERGE` aliases its target, so the table name does not resolve
 * there and the dialect publishes the alias ({@link Dialect.upsertTargetAlias}).
 * `set` and literal values reference no column and are unaffected everywhere.
 *
 * Read from a property only SQL Server sets, never inferred from a hook's
 * presence: every engine dialect spreads `postgresDialect`.
 */
function upsertTargetRef(qi: BuilderCtx): string {
  return qi.dialect.upsertTargetAlias ?? qi.q(qi.table);
}

export function buildUpdateMany<T extends object>(
  qi: BuilderCtx,
  args: UpdateManyArgs<T>,
): DeferredQuery<{ count: number }> {
  assertWritable(qi, 'updateMany');
  assertNoBulkWritePaging(qi.table, 'updateMany', args);
  assertNoOptimisticLock(qi, args, 'updateMany');
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  const dataObj = applyUpdatedAtColumns(qi, args.data as Record<string, unknown>);
  assertNoGeneratedColumns(qi, dataObj, 'updateMany');
  whereMod.assertMutationHasPredicate(
    qi,
    'updateMany',
    whereMod.userPredicateIsEmpty(qi, args.where as Record<string, unknown>) ? '' : ' WHERE x',
    resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan'),
  );
  const whereObj = (whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  // Nothing to SET: a no-op, for the same reason as `update` above (that path
  // has the full rationale). Reports `count: 0` because zero rows were
  // modified, no statement is issued at all, so this is not the count of rows
  // the predicate MATCHED.
  if (!Object.values(dataObj).some((v) => v !== undefined)) {
    return {
      sql: `SELECT ${qi.p(1)} AS count`,
      params: [0],
      transform: () => ({ count: 0 }),
      tag: `${qi.table}.updateMany`,
    };
  }

  const setFp = fingerprintSet(qi, dataObj);
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = `um:${setFp}|${whereFp}${whereMod.globalFilterCacheSegment(qi)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const setClauses = buildSetClauses(qi, writeEntries(qi, dataObj), freshParams, { operation: 'updateMany' });
    const whereClause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
    return `UPDATE ${qi.q(qi.table)} SET ${setClauses.join(', ')}${whereSql}`;
  };
  const entry = qi.acquireSql(ck, buildSql);

  collectSetParams(qi, dataObj, params);
  whereMod.collectWhereParams(qi, whereObj, params);
  qi.crossCheckCache('updateMany', ck, entry, buildSql, params);

  return {
    sql: entry.sql,
    params,
    transform: (result) => ({ count: result.rowCount ?? 0 }),
    tag: `${qi.table}.updateMany`,
    preparedName: entry.name,
  };
}

export function buildDeleteMany<T extends object>(
  qi: BuilderCtx,
  args: DeleteManyArgs<T>,
): DeferredQuery<{ count: number }> {
  assertWritable(qi, 'deleteMany');
  assertNoBulkWritePaging(qi.table, 'deleteMany', args);
  qi.currentSkip = resolveSkipGlobalFilters(args.skipGlobalFilters);
  whereMod.assertMutationHasPredicate(
    qi,
    'deleteMany',
    whereMod.userPredicateIsEmpty(qi, args.where as Record<string, unknown>) ? '' : ' WHERE x',
    resolveUnsafeFlag(args.allowFullTableScan, 'allowFullTableScan'),
  );
  const whereObj = (whereMod.mergeGlobalFilter(qi, args.where as Record<string, unknown>) ?? {}) as Record<
    string,
    unknown
  >;
  const whereFp = whereMod.fingerprintWhere(qi, whereObj);
  const ck = `dm:${whereFp}${whereMod.globalFilterCacheSegment(qi)}`;

  const params: unknown[] = [];

  const buildSql = (freshParams: unknown[]): string => {
    const clause = whereMod.buildWhereClause(qi, whereObj, freshParams);
    const whereSql = clause ? ` WHERE ${clause}` : '';
    return `DELETE FROM ${qi.q(qi.table)}${whereSql}`;
  };
  const entry = qi.acquireSql(ck, buildSql);

  whereMod.collectWhereParams(qi, whereObj, params);
  qi.crossCheckCache('deleteMany', ck, entry, buildSql, params);

  return {
    sql: entry.sql,
    params,
    transform: (result) => ({ count: result.rowCount ?? 0 }),
    tag: `${qi.table}.deleteMany`,
    preparedName: entry.name,
  };
}

/**
 * The snake_case names of a table's PII-tagged (`defineSchema` `pii: true`)
 * columns. PII columns are excluded from default projections (findMany /
 * findUnique / relation subqueries / batched loads) unless a read passes
 * `includePii: UNSAFE`; naming one in `select` without it is E003. Returns an
 * empty set for any table with no PII column, so untagged schemas keep their
 * byte-identical SQL.
 */
export function piiColumns(_qi: BuilderCtx, meta: TableMetadata): Set<string> {
  const out = new Set<string>();
  const pk = new Set(meta.primaryKey);
  for (const col of meta.columns) {
    // A PII-tagged PRIMARY KEY column is NEVER stripped. The exemption lives
    // here, in the helper every projection reads, rather than at the call
    // sites: it was written once at the write site (`|| pk.has(col)`) and no
    // read path had it, so a table whose PK member is tagged returned rows
    // that could not address themselves. Round-tripping such a row into an
    // update produced a PARTIAL predicate (the missing PK member is
    // `undefined`, which the where compiler drops, and the empty-where guard
    // does not fire because the OTHER member is present), so `update` silently
    // rewrote every row sharing the remaining key instead of one. Measured on
    // a composite `(org_id, email)` PK: three rows changed where one was
    // asked for, no error.
    //
    // The policy this implements is the one already stated on
    // {@link writeReturningColumns}: tag sensitive data, not keys; a PII PK is
    // out of scope for stripping because the returned row must stay
    // addressable. Only the enforcement was missing.
    if (col.pii && !pk.has(col.name)) out.add(col.name);
  }
  return out;
}

/**
 * The camelCase field names of a table's PII-tagged columns: the read-side
 * counterpart of {@link piiColumns} applied to already-parsed entities.
 * Used to strip PII from a write's RETURNING/reselect row (writes accept no
 * `includePii`, and a PII column named in a write's `select` is E003, so their
 * returned row never carries one; you may still write PII fields freely).
 */
export function piiFields(_qi: BuilderCtx, meta: TableMetadata): string[] {
  const out: string[] = [];
  const pk = new Set(meta.primaryKey);
  // Same PK exemption as {@link piiColumns}, and it MATTERS here rather than
  // being belt-and-braces: this strip runs on an already-fetched row, so
  // without it the SQL kept the PK addressable and this deleted it again,
  // which is the exact contradiction between this function's own "no-op"
  // docstring and writeReturningColumns' "must stay addressable".
  for (const col of meta.columns) {
    if (col.pii && !pk.has(col.name)) out.push(col.field);
  }
  return out;
}

/**
 * A single-row write's caller-chosen return shape, from its `select` / `omit`.
 *
 * Resolved ONCE per call by builder.ts through `resolveProjection`, the same
 * authority reads use, so a write and a read agree on every rule: a name must
 * resolve to a column or the call throws E003, a relation name gets its own
 * message, `select` must name something, `select` and `omit` are exclusive, the
 * list is in TABLE order (a caller's key order must not mint distinct
 * statements), and PII is never returned: a write takes no `includePii`, so a
 * PII column named in `select` is E003 and `omit` leaves PII excluded.
 * (builder.ts rather than this module because relations.ts already imports
 * this one.)
 *
 * The point is bytes: `RETURNING *` sends back every column, a large JSON
 * payload included, on every insert. Measured with a 3.1 KB jsonb column at
 * concurrency 50, the same INSERT ran at 60,900/s with no RETURNING and at
 * 34,500/s with `RETURNING *`.
 */
export interface WriteProjection {
  /** Unquoted column names, in table order. Never empty. */
  readonly columns: readonly string[];
}

/**
 * The write-SQL cache segment for a projection. EMPTY for the default shape, so
 * every existing key is byte-identical; a projected statement differs only in
 * its RETURNING/OUTPUT text, and without this segment two calls with the same
 * SET and WHERE but different `select`s would share one cached statement, i.e.
 * the second caller would get the first caller's columns. NUL is the delimiter
 * because it is the one byte a PostgreSQL identifier cannot contain.
 */
export function writeProjectionCacheSegment(projection: WriteProjection | undefined): string {
  return projection ? `|rt=${projection.columns.join('\u0000')}` : '';
}

/**
 * The `RETURNING` / `OUTPUT` selection for a write on this table. A table with
 * no PII column returns `'*'` (every column, byte-identical SQL to before);
 * a table WITH PII columns returns an explicit quoted list of every non-PII
 * column so the PII values never leave the database on a write. A PII-tagged
 * PRIMARY KEY column is kept in the projection regardless (the returned row
 * must stay addressable): tag sensitive data, not keys, a PII PK is
 * documented out of scope for stripping. Writes accept no `includePii` and
 * their `select` cannot name a PII column, so this is the whole write-return
 * policy at the SQL level;
 * {@link parseWriteRow} remains as a defense-in-depth strip (a no-op once the
 * SQL already excludes the columns). Derived purely from static per-table
 * schema metadata, so the write SQL cache needs no extra key segment.
 */
/**
 * Return `data` with every `updatedAt`-tagged column the caller did not name
 * set to `now`, or the original object when the table has none.
 *
 * Prisma's `@updatedAt` has no turbine equivalent, so a migrated application
 * had to remember the field on every single update, and the value is usually
 * load-bearing in the response body, so forgetting it is a silent staleness
 * bug rather than a crash. The tag is opt-in per column and never inferred
 * from a column's name, so a schema that does not use it emits byte-identical
 * SQL and an application already managing its own timestamp is untouched.
 *
 * The timestamp is generated CLIENT-side (like Prisma) rather than as a SQL
 * `now()`, so it flows through the same temporal coercion as any other bound
 * `Date` and lands in UTC on every engine.
 *
 * An explicit value always wins, including an explicit `null`: naming the
 * column is a statement of intent. "Named" is decided by resolving each data
 * key to its COLUMN, not by matching the field spelling: the SET list resolves
 * the caller's key the same way, so a key spelled as the snake_case column used
 * to be missed here and the injected field assigned the same column a second
 * time (`SET "updated_at" = $1, "updated_at" = $2`, PostgreSQL 42701).
 */
export function applyUpdatedAtColumns(qi: BuilderCtx, data: Record<string, unknown>): Record<string, unknown> {
  const tagged = qi.tableMeta.columns.filter((c) => c.updatedAt);
  if (tagged.length === 0) return data;
  const named = namedColumns(qi.tableMeta, data);
  let out: Record<string, unknown> | null = null;
  const now = new Date();
  for (const col of tagged) {
    if (named.has(col.name)) continue;
    out ??= { ...data };
    out[col.field] = now;
  }
  return out ?? data;
}

/**
 * The set of COLUMNS a `data` object names, under any accepted spelling of each
 * key. A key set to `undefined` names nothing (see {@link definedKeys}), and a
 * key that resolves to no column is left to the SQL builder's own E003.
 */
function namedColumns(meta: TableMetadata, data: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) continue;
    const column = resolveColumnName(meta, key);
    if (column) out.add(column);
  }
  return out;
}

export function writeReturningColumns(qi: BuilderCtx, projection?: WriteProjection): ReturningSelection {
  if (projection) return projection.columns.map((col) => qi.q(col));
  // The PK exemption used to be re-stated here as `|| pk.has(col)`. It now
  // lives in `piiColumns` so every projection inherits it and none can drift.
  const piiCols = piiColumns(qi, qi.tableMeta);
  if (piiCols.size === 0) return '*';
  return qi.tableMeta.allColumns.filter((col) => !piiCols.has(col)).map((col) => qi.q(col));
}

/**
 * String form of {@link writeReturningColumns} for a `SELECT` list (the
 * `'reselect'` result strategy re-fetches via a SELECT, not RETURNING).
 * `'*'` when there is no PII column; otherwise the comma-joined quoted list.
 */
export function writeReselectSelection(qi: BuilderCtx, projection?: WriteProjection): string {
  const cols = writeReturningColumns(qi, projection);
  return cols === '*' ? '*' : cols.join(', ');
}

/**
 * Parse a write's returned row (create/update/upsert/delete), then strip the
 * table's PII fields: the write-side read policy. On PII-tagged tables the
 * statement's RETURNING/OUTPUT already omits these columns (see
 * {@link writeReturningColumns}), so this strip is defense-in-depth and a
 * no-op. Untagged tables incur only one `for` over a zero-length field list,
 * so behavior is unchanged.
 */
export function parseWriteRow(
  qi: BuilderCtx,
  row: Record<string, unknown>,
  projection?: WriteProjection,
): Record<string, unknown> {
  const parsed = qi.parseRow(row, qi.table);
  // A write's projection never names a PII column (E003, see WriteProjection),
  // so for PII this strip spares nothing; it stays as defense in depth.
  const pii = piiColumns(qi, qi.tableMeta);
  if (pii.size === 0) return parsed;
  const requested = projection ? new Set(projection.columns) : undefined;
  for (const col of qi.tableMeta.columns) {
    if (pii.has(col.name) && !requested?.has(col.name)) delete parsed[col.field];
  }
  return parsed;
}

/**
 * Reject any write against a view (H4). Views are introspected with
 * `isView: true` and are read-only in every engine; a write raises a
 * {@link ValidationError} (E003) rather than emitting SQL Postgres would
 * reject (or, worse, silently applying to an updatable view).
 */
export function assertWritable(qi: BuilderCtx, operation: string): void {
  if (qi.tableMeta.isView) {
    throw new ValidationError(
      `Cannot ${operation} "${qi.table}": it is a view (read-only). ` +
        'Views support reads (findMany/findFirst/…) but not writes.',
    );
  }
}

/**
 * Reject a write whose `data` names a `GENERATED ALWAYS AS (...) STORED`
 * column (H3). Postgres computes these from other columns and errors if you
 * try to write them; we fail early with a clear {@link ValidationError} (E003)
 * instead of surfacing a cryptic driver error. Undefined values are ignored
 * (they're stripped from the statement anyway).
 */
export function assertNoGeneratedColumns(qi: BuilderCtx, data: Record<string, unknown>, operation: string): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const col = qi.tableMeta.columns.find((c) => c.field === key || c.name === key || c.name === camelToSnake(key));
    if (col?.isGeneratedStored) {
      throw new ValidationError(
        `Cannot ${operation} "${qi.table}": column "${key}" is a GENERATED ALWAYS AS (…) STORED ` +
          'column whose value the database computes, remove it from your data.',
      );
    }
  }
}

/** The SQL operator each arithmetic update operator compiles to. */
const ARITHMETIC_SQL: Readonly<Record<string, string>> = { increment: '+', decrement: '-', multiply: '*', divide: '/' };

/**
 * The SQL operator for one arithmetic update operator on one column.
 *
 * `divide` on a MySQL INTEGER column is `DIV`. MySQL's `/` is decimal
 * division, so `75 / 2` is 37.5 and the assignment back to an INT rounds it
 * to 38, where PostgreSQL's integer division truncates to 37. `DIV` truncates
 * toward zero, as PostgreSQL does. Decided by the COLUMN TYPE alone, never by
 * the bound divisor: the SQL text must not depend on a value, or the template
 * cache would serve one shape to the other.
 */
function arithmeticSql(qi: BuilderCtx, op: string, column: string): string {
  if (op === 'divide' && qi.dialect.name === 'mysql' && isIntegerColumnType(qi.columnPgTypeMap.get(column))) {
    return 'DIV';
  }
  return ARITHMETIC_SQL[op]!;
}

/**
 * The atomic operator a SET value names, or `null` when it is a plain value.
 * THE one rule, read by the SET build, its fingerprint and its cache-hit param
 * collector, so the three cannot disagree about whether a value is an
 * operator.
 *
 * A branded expression or `col()` reference is checked FIRST and answers
 * `'expr'`: it is a frozen plain object too, and must never reach the
 * operator test below. An operator is a plain object with EXACTLY one key from
 * {@link UPDATE_OPERATOR_KEYS}. On a json/jsonb column only `set` is an
 * operator: an object there IS the JSON value, so `{ increment: 1 }` is the
 * document `{"increment":1}`, and `{ set: doc }` is the way to write a
 * document that is itself shaped like `{ set: ... }`.
 */
export function setOperatorOf(qi: BuilderCtx, key: string, value: unknown): string | null {
  if (isSqlExpr(value) || isColumnRef(value)) return 'expr';
  if (!isUnmatchedPlainObject(value)) return null;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || !UPDATE_OPERATOR_KEYS.has(keys[0]!)) return null;
  const op = keys[0]!;
  if (op !== 'set' && isJsonWriteColumn(qi, key)) return null;
  return op;
}

/** Whether `key` names a json/jsonb column (non-throwing; unknown keys are not). */
function isJsonWriteColumn(qi: BuilderCtx, key: string): boolean {
  const column = resolveColumnName(qi.tableMeta, key);
  const dbType = column ? qi.columnPgTypeMap.get(column) : undefined;
  return dbType !== undefined && whereMod.isJsonColumnType(qi, dbType);
}

/**
 * Where a SET list is compiled, which decides how its column references and
 * its `expr.case` predicates are rendered.
 */
interface SetContext {
  /** The operation, for messages. */
  readonly operation: 'update' | 'updateMany' | 'upsert' | 'createMany';
  /**
   * The rendered reference to the target row (`"users"`, SQL Server's MERGE
   * alias `T`), or `undefined` for a plain UPDATE, where a bare column has one
   * table in scope. Inside an upsert the proposed row is in scope too, so a
   * bare reference is ambiguous (42702 on PostgreSQL).
   */
  readonly target?: string | undefined;
  /** The incoming row's reference (`EXCLUDED`, `S`), only where `expr.excluded` means something. */
  readonly incoming?: string | undefined;
  /** The columns the incoming rows carry. */
  readonly insertColumns?: ReadonlySet<string> | undefined;
}

const UPDATE_SET: SetContext = { operation: 'update' };

/** One compiled assignment, before MySQL reorders the list. */
interface SetEntry {
  readonly sql: string;
  /** The column assigned. */
  readonly column: string;
  /** Other columns of the target row the right-hand side reads. */
  readonly reads: ReadonlySet<string>;
}

const NO_READS: ReadonlySet<string> = new Set();

/**
 * Compile a SET list: one clause per entry, in the order given (the canonical
 * column order of {@link writeEntries}), pushing params as it goes so later
 * clauses (WHERE, version check) continue the numbering.
 *
 * On MySQL the clause STRINGS are then reordered (see
 * {@link orderForLeftToRightSet}). Params are not: MySQL binds by name
 * (`:pN`), so a clause keeps its placeholders wherever it lands, and the
 * cache-hit collector ({@link collectSetParams}) keeps pushing in canonical
 * order.
 */
function buildSetClauses(
  qi: BuilderCtx,
  entries: [string, unknown][],
  params: unknown[],
  ctx: SetContext = UPDATE_SET,
): string[] {
  const compiled = entries.map(([k, v]) => compileSetEntry(qi, k, v, params, ctx));
  return qi.dialect.name === 'mysql' ? orderForLeftToRightSet(qi, compiled) : compiled.map((c) => c.sql);
}

/**
 * Build a single SET clause entry.
 *
 * Supports plain values, atomic operator objects ({ set, increment,
 * decrement, multiply, divide }) and expressions (`expr.*`, `col()`), as
 * decided by {@link setOperatorOf}.
 *
 * Returns the SQL fragment (e.g., `"view_count" = "view_count" + $3`) and
 * pushes any required params onto the shared params array so that WHERE
 * clause numbering continues correctly afterward.
 *
 * `ctx.target` qualifies the column REFERENCES the right-hand side reads
 * (`"view_count" = "users"."view_count" + $n`): absent for a plain `UPDATE`,
 * the table name in an upsert, because inside `ON CONFLICT ... DO UPDATE SET`
 * the target table and `excluded` are BOTH in scope and a bare reference is
 * 42702 on PostgreSQL. The assignment target on the left stays bare on every
 * engine (it can only ever be the target table's column), and `set` / literal
 * values reference no column at all, so their SQL is byte-identical with or
 * without a qualifier.
 */
function compileSetEntry(qi: BuilderCtx, key: string, value: unknown, params: unknown[], ctx: SetContext): SetEntry {
  const col = qi.toSqlColumn(key);
  const column = qi.toColumn(key);
  const op = setOperatorOf(qi, key, value);
  if (op === 'expr') {
    const compiled = compileSetExpr(exprEnv(qi, key, params, ctx), value as Parameters<typeof compileSetExpr>[1]);
    return { sql: `${col} = ${compiled.sql}`, column, reads: compiled.reads };
  }
  // Enum columns get an explicit `::"EnumName"` cast on their value bind
  // (see enumTypeForColumn); `''` everywhere else. Value-invariant, so the
  // SQL cache and collectSetParams are unaffected.
  const cast = whereMod.enumCastSuffix(qi, column);
  if (op === 'set') {
    params.push(coerceWriteValue(qi, key, (value as Record<string, unknown>).set));
    return { sql: `${col} = ${qi.p(params.length)}${cast}`, column, reads: NO_READS };
  }
  if (op !== null) {
    const opValue = (value as Record<string, unknown>)[op];
    // Arithmetic operators: must be finite numbers
    if (typeof opValue !== 'number' || !Number.isFinite(opValue)) {
      throw new ValidationError(
        `update operator "${op}" on "${qi.table}.${key}" requires a finite number, got ${typeof opValue}`,
      );
    }
    params.push(opValue);
    const ref = ctx.target ? `${ctx.target}.${col}` : col;
    // Reads only its own column, which no ordering needs to respect.
    return { sql: `${col} = ${ref} ${arithmeticSql(qi, op, column)} ${qi.p(params.length)}`, column, reads: NO_READS };
  }
  // A misspelled operator gets its own E003 before the bind seam's general
  // shape check.
  assertBindableSetValue(qi, key, value);

  // Plain value (including null, Date, Buffer, arrays, JSON objects)
  params.push(coerceWriteValue(qi, key, value));
  return { sql: `${col} = ${qi.p(params.length)}${cast}`, column, reads: NO_READS };
}

/**
 * The environment one expression compiles in: how a value leaf binds, how a
 * column of the target row and of the incoming row render, and how a case
 * predicate compiles.
 */
function exprEnv(qi: BuilderCtx, key: string, params: unknown[], ctx: SetContext): ExprCompileEnv {
  const cast = exprValueCast(qi, key);
  const target = ctx.target;
  const incoming = ctx.incoming;
  return {
    qi,
    targetKey: key,
    operation: ctx.operation,
    bind: (value) => {
      params.push(coerceWriteValue(qi, key, value));
      return `${qi.p(params.length)}${cast}`;
    },
    column: (column) => (target ? `${target}.${qi.q(column)}` : qi.q(column)),
    excluded: incoming ? (column) => `${incoming}.${qi.q(column)}` : undefined,
    insertColumns: ctx.insertColumns,
    predicate: (when) => {
      const sql = target
        ? whereMod.buildRenderedRefWhere(qi, qi.table, qi.tableMeta, target, when, params)
        : whereMod.buildWhereClause(qi, when, params);
      if (sql === null) {
        throw new ValidationError(`expr.case() on "${qi.table}": an arm's when compiles to no predicate.`);
      }
      return sql;
    },
  };
}

/**
 * A type token that is safe to write after `::` as is: a plain name, a
 * multi-word built-in (`double precision`), optionally with a precision.
 */
const SAFE_CAST_TYPE = /^[A-Za-z_][A-Za-z0-9_]*( [A-Za-z_][A-Za-z0-9_]*)*(\(\d+( ?, ?\d+)?\))?$/;

/**
 * The cast every bound value inside an expression carries on PostgreSQL: the
 * TARGET column's type. node-postgres sends parameters untyped, so in an
 * expression whose operands are all bound values PostgreSQL infers `text` and
 * fails (`CASE WHEN ... THEN $1 ELSE $2 END` into an int column is 42804, and
 * `$1 + $2` is 42725). Enums use the quoted enum cast; a type the metadata
 * does not name plainly, or one from another schema, gets none. Other engines
 * bind typed values and get none.
 */
function exprValueCast(qi: BuilderCtx, key: string): string {
  if (qi.dialect.name !== 'postgresql') return '';
  const column = resolveColumnName(qi.tableMeta, key);
  if (column === undefined) return '';
  const enumCast = whereMod.enumCastSuffix(qi, column);
  if (enumCast) return enumCast;
  if (qi.crossSchemaTypeColumns.has(column)) return '';
  const type = qi.columnPgTypeMap.get(column);
  if (type === undefined || type.startsWith('_') || !SAFE_CAST_TYPE.test(type)) return '';
  return `::${type}`;
}

/**
 * MySQL evaluates a single-table UPDATE's SET list LEFT TO RIGHT, and a later
 * assignment sees the NEW value of an earlier column; PostgreSQL, SQLite and
 * SQL Server read old values. So `{ a: col('b'), b: col('a') }` swaps there
 * and duplicates on MySQL. `ON DUPLICATE KEY UPDATE` behaves the same way.
 *
 * Order the list so every assignment that READS a column comes before the
 * assignment that WRITES it: a stable topological sort that keeps the
 * canonical order wherever the reads allow, so the order is a pure function of
 * the data's shape and the SQL-cache key (which already captures that shape)
 * stays sufficient. A cycle (a swap) has no such order and is refused.
 */
function orderForLeftToRightSet(qi: BuilderCtx, entries: SetEntry[]): string[] {
  if (entries.every((e) => e.reads.size === 0)) return entries.map((e) => e.sql);
  const writer = new Map<string, number>();
  entries.forEach((e, i) => {
    writer.set(e.column, i);
  });
  const before: number[][] = entries.map(() => []);
  const pending = entries.map(() => 0);
  entries.forEach((e, i) => {
    for (const column of e.reads) {
      const j = writer.get(column);
      if (j === undefined || j === i) continue;
      before[i]!.push(j);
      pending[j]!++;
    }
  });
  const ready = pending.flatMap((n, i) => (n === 0 ? [i] : []));
  const order: number[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a - b);
    const i = ready.shift()!;
    order.push(i);
    for (const j of before[i]!) if (--pending[j]! === 0) ready.push(j);
  }
  if (order.length < entries.length) {
    const stuck = entries
      .filter((_, i) => pending[i]! > 0)
      .map((e) => qi.tableMeta.reverseColumnMap[e.column] ?? e.column);
    throw new UnsupportedFeatureError(
      `An update on "${qi.table}" that reads ${stuck.map((f) => `"${f}"`).join(' and ')} while assigning them`,
      qi.dialect.name,
      "MySQL evaluates SET left to right, so a later assignment sees the earlier one's new value and this " +
        'cannot be expressed. Split it into two updates.',
    );
  }
  return order.map((i) => entries[i]!.sql);
}

/**
 * Reject a `data` value that reached {@link buildSetClauses}'s plain-value
 * fallthrough as a plain object with exactly ONE key that is not a known
 * atomic operator. On a scalar column that shape can only be a misspelled
 * operator (`{ incremnt: 1 }`, `{ bogus: 'x' }`); binding it plainly writes the
 * JSON text `{"bogus":"x"}` into the column and silently corrupts it.
 *
 * Deliberately narrow. Skipped for:
 *  - json / jsonb columns, which legitimately take arbitrary objects;
 *  - class instances (Buffer for bytea, Decimal wrappers, …), arrays and Dates,
 *    which {@link isUnmatchedPlainObject} already excludes;
 *  - multi-key objects, which are never operator-shaped (a real operator object
 *    has exactly one key) and are far more likely a deliberate payload.
 *
 * Shared by the SQL-build path and the cache-hit param-collect path, so a
 * warmed template can never skip the check.
 */
export function assertBindableSetValue(qi: BuilderCtx, key: string, value: unknown): void {
  if (!isUnmatchedPlainObject(value)) return;
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || UPDATE_OPERATOR_KEYS.has(keys[0]!)) return;
  const column = qi.toColumn(key);
  if (whereMod.isJsonColumnType(qi, whereMod.getColumnPgType(qi, column))) return;
  throw new ValidationError(
    `Unknown update operator "${keys[0]}" on "${qi.table}.${key}". ` +
      `Supported: ${[...UPDATE_OPERATOR_KEYS].join(', ')}. ` +
      'A plain object is only written as a value on a json/jsonb column.',
  );
}

/**
 * Fingerprint SET clauses for update/updateMany.
 * Captures key names + operator types (set/increment/etc) but not values. An
 * expression contributes `k:expr(<shape>)` from the same walk that compiles
 * it, so a statement without one keeps its key byte-identical.
 */
export function fingerprintSet(qi: BuilderCtx, data: Record<string, unknown>): string {
  const entries = writeEntries(qi, data);
  const parts: string[] = [];
  for (const [k, v] of entries) {
    const op = setOperatorOf(qi, k, v);
    if (op === 'expr') {
      const env = exprEnv(qi, k, [], UPDATE_SET);
      parts.push(`${k}:expr(${compileSetExpr(env, v as Parameters<typeof compileSetExpr>[1]).fingerprint})`);
      continue;
    }
    parts.push(`${k}:${op ?? 'eq'}`);
  }
  return parts.join(',');
}

/**
 * Collect SET params for update/updateMany. Mirrors buildSetClauses param order.
 */
export function collectSetParams(qi: BuilderCtx, data: Record<string, unknown>, params: unknown[]): void {
  const entries = writeEntries(qi, data);
  for (const [k, v] of entries) {
    const op = setOperatorOf(qi, k, v);
    if (op === 'expr') {
      // The build's own walk: it binds the same leaves in the same order.
      compileSetExpr(exprEnv(qi, k, params, UPDATE_SET), v as Parameters<typeof compileSetExpr>[1]);
      continue;
    }
    if (op !== null) {
      // `set` is the only operator that binds a user value of arbitrary type;
      // the arithmetic operators are finite numbers, which coerceWriteValue
      // returns untouched. Mirrors buildSetClauses.
      params.push(coerceWriteValue(qi, k, (v as Record<string, unknown>)[op]));
      continue;
    }
    // Mirror the build path's misspelled-operator guard: the SET fingerprint
    // is `key:eq` for both a plain value and a bogus operator object, so a
    // cache HIT would otherwise bind the object and skip the check.
    assertBindableSetValue(qi, k, v);
    params.push(coerceWriteValue(qi, k, v));
  }
}
