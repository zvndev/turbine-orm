/**
 * turbine-orm: SQL expressions in update data.
 *
 * `expr.greatest(col('viewCount'), 100)` and friends are branded node objects,
 * and `expr.excluded('events')` names the incoming row of an upsert. Both are
 * written into the SQL TEXT, so both carry a symbol brand: `JSON.parse` cannot
 * produce one, so request data can never become an expression (the same
 * reasoning as `col()` and `UNSAFE`). `Symbol.for` so the ESM and CJS copies of
 * the package recognize each other's nodes. A plain look-alike object
 * (`{ kind: 'greatest', args: [...] }`) is a VALUE, and on a non-JSON column
 * the write path refuses it.
 *
 * The public types live in `query/types.ts` (`SqlExpr`, `ExcludedRef`). This
 * module holds the node constructors, their validation, and
 * {@link compileSetExpr}: the ONE traversal that produces an expression's SQL,
 * its bound parameters and its cache fingerprint together, so the SET build,
 * the cache-hit param collector and the fingerprint cannot disagree (the
 * failure class behind the where-clause cache bugs).
 *
 * Where expressions are accepted: `update`, `updateMany`, `upsert`'s `update`,
 * `createMany`'s `onConflict.update`, and nested update data (which runs
 * through `update()`). Not in `create` / `createMany` data, where the write
 * bind seam refuses a node.
 */

import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import type { TableMetadata } from '../schema.js';
import { type ColumnRef, isColumnRef, isPlainColumnRefShape } from './column-ref.js';
import { isPlainRecord } from './filters.js';
import { pruneUndefinedArgs } from './normalize-args.js';
import type { ExcludedRef, SqlExpr, SqlExprKind } from './types.js';
import { resolveColumnName } from './utils.js';
import { type BuilderCtx, fingerprintWhere } from './where.js';
import { type WhereRecord, walkWhere } from './where-compile.js';

/** The brand every {@link SqlExpr} node carries. */
export const SQL_EXPR: unique symbol = Symbol.for('turbine-orm.sqlExpr');

/** The brand an {@link ExcludedRef} carries (the incoming row of an upsert). */
export const EXCLUDED_REF: unique symbol = Symbol.for('turbine-orm.excludedRef');

const EXPR_KINDS: ReadonlySet<string> = new Set<SqlExprKind>([
  'add',
  'sub',
  'mul',
  'div',
  'coalesce',
  'greatest',
  'least',
  'case',
  'now',
  'excluded',
]);

/** Operand count bounds for coalesce / greatest / least. */
const MIN_VARIADIC = 2;
const MAX_VARIADIC = 8;
/** Arm count bounds for case. */
const MAX_CASE_ARMS = 16;
/** Nesting bound, so a hostile tree cannot exhaust the stack. */
const MAX_EXPR_DEPTH = 32;

// ---------------------------------------------------------------------------
// Public node types
// ---------------------------------------------------------------------------

/**
 * An operand of an expression: a JS scalar (string, number, bigint, boolean,
 * Date, Buffer or null), `col('field')` for the current row's column, or
 * another expression.
 */
export type ExprOperand<V = unknown> = NotInferred<V> | null | ColumnRef | SqlExpr<V>;

/**
 * `V` as a type the compiler does not infer from (the pre-TypeScript-5.4
 * spelling of `NoInfer`, so the published declarations need no newer
 * compiler). Without it a `col('x')` operand is itself a candidate for `V`,
 * and `expr.greatest(col('a'), col('b'))` would be typed as producing a
 * column reference. `V` comes from the expression operands and from where the
 * result is assigned instead.
 */
type NotInferred<V> = [V][V extends unknown ? 0 : never];

/**
 * A numeric operand: a number or bigint, `col()` of a numeric column, or a
 * numeric expression (`string` covers a numeric/decimal column typed as text).
 * One union-typed `SqlExpr`, not a union of three, so a nested call such as
 * `expr.add(col('a'), expr.mul(col('b'), 2))` infers without a type argument.
 */
export type NumericOperand = number | bigint | null | ColumnRef | SqlExpr<number | bigint | string>;

/** One `expr.case` arm: when the current row matches `when`, the value is `then`. */
export interface CaseArm<V = unknown> {
  /** A predicate on the current row's columns, written like `where`. No relation filters. */
  readonly when: Record<string, unknown>;
  readonly then: ExprOperand<V>;
}

/** The node an `expr.case` call builds. */
export interface CaseExpr<V = unknown> extends SqlExpr<V> {
  readonly kind: 'case';
  readonly args: readonly CaseArm<V>[];
  /** The value when no arm matches; absent means NULL. */
  readonly else?: ExprOperand<V>;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

function makeNode<V>(kind: SqlExprKind, args: readonly unknown[], extra?: Record<string, unknown>): SqlExpr<V> {
  const node: Record<string, unknown> = { kind, args: Object.freeze([...args]), ...extra };
  // Non-enumerable, like `col()`'s brand: the node logs and compares as
  // `{ kind, args }`, and no `Object.keys` walker ever sees the symbol.
  Object.defineProperty(node, SQL_EXPR, { value: true, enumerable: false });
  return Object.freeze(node) as unknown as SqlExpr<V>;
}

function describeOperand(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object' && value !== null) {
    if (isPlainExprShape(value)) return 'a plain { kind, args } object (not built by expr)';
    return isPlainRecord(value) ? 'a plain object' : `a ${value.constructor?.name ?? 'object'} instance`;
  }
  if (typeof value === 'number') return String(value);
  return typeof value;
}

/** Refuse an operand no engine can bind as one value. Validated at construction, so the error names the call. */
function assertOperand(kind: SqlExprKind, position: number, value: unknown): void {
  const at = `expr.${kind}(): operand ${position + 1}`;
  if (value === undefined) {
    throw new ValidationError(`${at} is undefined. Pass null for SQL NULL.`);
  }
  if (value === null || isColumnRef(value) || isSqlExpr(value)) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
    case 'bigint':
      return;
    case 'number':
      if (Number.isFinite(value)) return;
      throw new ValidationError(`${at} is ${value}; a bound number must be finite.`);
  }
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return;
    throw new ValidationError(`${at} is an Invalid Date.`);
  }
  if (value instanceof Uint8Array) return;
  if (isPlainColumnRefShape(value)) {
    const name = JSON.stringify((value as { col: string }).col);
    throw new ValidationError(
      `${at} is a plain { col: ${name} } object, not a column reference. Build one with col(${name}) ` +
        "(import { col } from 'turbine-orm').",
    );
  }
  throw new ValidationError(
    `${at} is ${describeOperand(value)}. An operand is a scalar (string, number, bigint, boolean, Date, ` +
      'Buffer or null), col(field), or a node built by expr; a plain object is never an expression.',
  );
}

/** Arithmetic takes numbers only: a string, boolean or Date is refused at construction. */
function assertNumericOperand(kind: SqlExprKind, position: number, value: unknown): void {
  assertOperand(kind, position, value);
  const t = typeof value;
  if (t === 'string' || t === 'boolean' || value instanceof Date || value instanceof Uint8Array) {
    throw new ValidationError(
      `expr.${kind}(): operand ${position + 1} is a ${value instanceof Date ? 'Date' : t}. Arithmetic takes ` +
        'numbers, bigints, col() of a numeric column, or numeric expressions. Date arithmetic is not supported.',
    );
  }
  if (isSqlExpr(value) && value.kind === 'now') {
    throw new ValidationError(
      `expr.${kind}(): operand ${position + 1} is expr.now(). Date arithmetic is not supported; ` +
        'compute the timestamp in JavaScript and pass it as a value.',
    );
  }
}

function arithmetic<V>(kind: 'add' | 'sub' | 'mul' | 'div', a: unknown, b: unknown): SqlExpr<V> {
  assertNumericOperand(kind, 0, a);
  assertNumericOperand(kind, 1, b);
  return makeNode<V>(kind, [a, b]);
}

function variadic<V>(kind: 'coalesce' | 'greatest' | 'least', operands: unknown[]): SqlExpr<V> {
  if (operands.length < MIN_VARIADIC || operands.length > MAX_VARIADIC) {
    throw new ValidationError(
      `expr.${kind}() takes ${MIN_VARIADIC} to ${MAX_VARIADIC} operands, got ${operands.length}.`,
    );
  }
  operands.forEach((v, i) => {
    assertOperand(kind, i, v);
  });
  return makeNode<V>(kind, operands);
}

function caseNode<V>(arms: unknown, otherwise: unknown): CaseExpr<V> {
  if (!Array.isArray(arms) || arms.length === 0 || arms.length > MAX_CASE_ARMS) {
    throw new ValidationError(
      `expr.case() takes an array of 1 to ${MAX_CASE_ARMS} arms ({ when, then }), got ` +
        `${Array.isArray(arms) ? `${arms.length} arms` : describeOperand(arms)}.`,
    );
  }
  const frozen = arms.map((arm, i) => {
    if (!isPlainRecord(arm)) {
      throw new ValidationError(`expr.case(): arm ${i + 1} is ${describeOperand(arm)}; write { when, then }.`);
    }
    const extra = Object.keys(arm).filter((k) => k !== 'when' && k !== 'then');
    if (extra.length > 0) {
      throw new ValidationError(`expr.case(): arm ${i + 1} has unknown key "${extra[0]}"; an arm is { when, then }.`);
    }
    if (!isPlainRecord(arm.when)) {
      throw new ValidationError(
        `expr.case(): arm ${i + 1}'s when is ${describeOperand(arm.when)}; write a predicate object like \`where\`.`,
      );
    }
    if (!('then' in arm)) {
      throw new ValidationError(`expr.case(): arm ${i + 1} has no then. Pass null for SQL NULL.`);
    }
    assertOperand('case', i, arm.then);
    // biome-ignore lint/suspicious/noThenProperty: SQL's CASE WHEN ... THEN; a value operand, never a function, so never thenable
    return Object.freeze({ when: arm.when, then: arm.then });
  });
  if (otherwise !== undefined) assertOperand('case', arms.length, otherwise);
  return makeNode<V>('case', frozen, otherwise === undefined ? undefined : { else: otherwise }) as CaseExpr<V>;
}

/**
 * Builders for SQL expressions in update data. Each returns a frozen, branded
 * node; the SQL is generated per engine when the update compiles.
 *
 * ```ts
 * import { col, expr } from 'turbine-orm';
 * await db.posts.update({
 *   where: { id },
 *   data: {
 *     viewCount: expr.greatest(col('viewCount'), 100),
 *     score: expr.add(col('score'), expr.mul(col('bonus'), 2)),
 *     editedAt: expr.now(),
 *   },
 * });
 * ```
 */
export const expr = Object.freeze({
  /** `a + b`. Numbers, bigints, numeric columns and numeric expressions. */
  add<V extends number | bigint | string = number>(a: NumericOperand, b: NumericOperand): SqlExpr<V> {
    return arithmetic<V>('add', a, b);
  },
  /** `a - b`. */
  sub<V extends number | bigint | string = number>(a: NumericOperand, b: NumericOperand): SqlExpr<V> {
    return arithmetic<V>('sub', a, b);
  },
  /** `a * b`. */
  mul<V extends number | bigint | string = number>(a: NumericOperand, b: NumericOperand): SqlExpr<V> {
    return arithmetic<V>('mul', a, b);
  },
  /**
   * `a / b`. When both operands are integers (an integer column, an integer
   * number or bigint, or an integer expression) the division truncates toward
   * zero on every engine, as the `divide` update operator does on an integer
   * column. With a non-integer operand it is a decimal division.
   */
  div<V extends number | bigint | string = number>(a: NumericOperand, b: NumericOperand): SqlExpr<V> {
    return arithmetic<V>('div', a, b);
  },
  /** The first non-NULL operand (2 to 8). */
  coalesce<V>(a: ExprOperand<V>, b: ExprOperand<V>, ...rest: ExprOperand<V>[]): SqlExpr<V> {
    return variadic<V>('coalesce', [a, b, ...rest]);
  },
  /**
   * The largest operand (2 to 8), IGNORING NULLs on every engine (PostgreSQL's
   * meaning; MySQL and SQLite are rewritten to match). NULL only when every
   * operand is NULL.
   */
  greatest<V>(a: ExprOperand<V>, b: ExprOperand<V>, ...rest: ExprOperand<V>[]): SqlExpr<V> {
    return variadic<V>('greatest', [a, b, ...rest]);
  },
  /** The smallest operand (2 to 8), ignoring NULLs on every engine. */
  least<V>(a: ExprOperand<V>, b: ExprOperand<V>, ...rest: ExprOperand<V>[]): SqlExpr<V> {
    return variadic<V>('least', [a, b, ...rest]);
  },
  /**
   * `CASE WHEN ... THEN ... ELSE ... END`. Each arm's `when` is a predicate on
   * the current row's columns written like `where` (no relation filters); the
   * first matching arm wins. Without `otherwise` an unmatched row gets NULL.
   */
  case<V>(arms: readonly CaseArm<V>[], otherwise?: ExprOperand<V>): SqlExpr<V> {
    return caseNode<V>(arms, otherwise);
  },
  /**
   * The database server's current time, stored in the zone convention Turbine
   * reads with: a zone-less `timestamp` / `date` gets the UTC wall clock (unless
   * the client sets `utcTimestamps: false`). On PostgreSQL it is the
   * TRANSACTION's start time; on MySQL, the statement's. Temporal columns only.
   */
  now(): SqlExpr<Date> {
    return makeNode<Date>('now', []);
  },
  /**
   * The incoming row's value for `field`: inside `upsert`'s `update` (the value
   * `create` supplies) and `createMany`'s `onConflict.update` (each row's own
   * value). Refused anywhere else.
   */
  excluded<F extends string>(field: F): ExcludedRef<F> {
    if (typeof field !== 'string' || field.length === 0) {
      throw new ValidationError('expr.excluded() takes the name of a field on the table, as a non-empty string.');
    }
    const node: Record<string, unknown> = { kind: 'excluded', args: Object.freeze([]), field };
    Object.defineProperty(node, SQL_EXPR, { value: true, enumerable: false });
    Object.defineProperty(node, EXCLUDED_REF, { value: true, enumerable: false });
    return Object.freeze(node) as unknown as ExcludedRef<F>;
  },
});

/** True only for a node built by {@link expr} (any loaded copy of the package). */
export function isSqlExpr(value: unknown): value is SqlExpr {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { [SQL_EXPR]?: unknown })[SQL_EXPR] === true &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}

/** True only for `expr.excluded(...)`. */
export function isExcludedRef(value: unknown): value is ExcludedRef {
  return isSqlExpr(value) && (value as { [EXCLUDED_REF]?: unknown })[EXCLUDED_REF] === true;
}

/**
 * True for an UNBRANDED object shaped like a node (`{ kind: 'greatest', args }`),
 * which is what parsed request data produces. The write path refuses it on a
 * non-JSON column rather than storing it as JSON text.
 */
export function isPlainExprShape(value: unknown): boolean {
  if (!isPlainRecord(value) || isSqlExpr(value)) return false;
  const kind = value.kind;
  return (
    typeof kind === 'string' && EXPR_KINDS.has(kind) && (Array.isArray(value.args) || typeof value.field === 'string')
  );
}

/** The refusal for {@link isPlainExprShape}. */
export function plainExprShapeMessage(table: string, key: string, kind: string): string {
  return (
    `A plain { kind: ${JSON.stringify(kind)}, ... } object written to "${table}.${key}" is not an expression. ` +
    `Build one with expr.${EXPR_KINDS.has(kind) ? kind : 'add'}(...) (import { expr } from 'turbine-orm'): ` +
    'expressions carry a symbol brand so that parsed request data can never become SQL. ' +
    'To store JSON text in this column, pass `JSON.stringify(value)` or `jsonValue(value)`.'
  );
}

/** The refusal for a node at a position that takes values only (create data, `{ set }`). */
export function exprNotAllowedMessage(table: string, key: string, value: SqlExpr | ColumnRef): string {
  const what = isColumnRef(value) ? `col(${JSON.stringify(value.col)})` : `expr.${(value as SqlExpr).kind}()`;
  return (
    `${what} cannot be written to "${table}.${key}" here: expressions and column references are accepted as the ` +
    "direct value of a field in update, updateMany, upsert's update and createMany's onConflict.update, " +
    'not in create / createMany data and not inside an operator such as { set }.'
  );
}

// ---------------------------------------------------------------------------
// Column type classes
// ---------------------------------------------------------------------------

type ColumnClass = 'numeric' | 'temporal' | 'json' | 'array' | 'other' | 'unknown';
/**
 * The arithmetic class of an expression or operand, which decides what every
 * engine computes and stores (see {@link compileSetExpr}): `int` for integer
 * columns, integer numbers and bigints; `dec` for any other numeric column or
 * number; `null` for SQL NULL, which takes the class of what it meets;
 * `unknown` for a column with no known type; `other` for everything else.
 */
type NumClass = 'int' | 'dec' | 'null' | 'unknown' | 'other';
type TemporalKind = 'tz' | 'timestamp' | 'date' | 'time';

const NUMERIC_TYPES: ReadonlySet<string> = new Set([
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'int',
  'bigint',
  'tinyint',
  'mediumint',
  'serial',
  'bigserial',
  'smallserial',
  'numeric',
  'decimal',
  'dec',
  'fixed',
  'float4',
  'float8',
  'real',
  'double precision',
  'double',
  'float',
  'money',
  'smallmoney',
  'number',
]);

/** The integer subset of {@link NUMERIC_TYPES}. */
const INTEGER_TYPES: ReadonlySet<string> = new Set([
  'int2',
  'int4',
  'int8',
  'smallint',
  'integer',
  'int',
  'bigint',
  'tinyint',
  'mediumint',
  'serial',
  'bigserial',
  'smallserial',
]);

const TEMPORAL_TYPES: Readonly<Record<string, TemporalKind>> = {
  timestamptz: 'tz',
  'timestamp with time zone': 'tz',
  datetimeoffset: 'tz',
  timestamp: 'timestamp',
  'timestamp without time zone': 'timestamp',
  datetime: 'timestamp',
  datetime2: 'timestamp',
  smalldatetime: 'timestamp',
  date: 'date',
  time: 'time',
  timetz: 'time',
  'time with time zone': 'time',
  'time without time zone': 'time',
};

/** A column type token, lowercased, without precision or `unsigned`. */
function normalizeType(dbType: string): string {
  return dbType
    .toLowerCase()
    .replace(/\(\s*\d+(\s*,\s*\d+)?\s*\)/g, '')
    .replace(/\bunsigned\b|\bzerofill\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function columnClass(dbType: string | undefined): ColumnClass {
  if (dbType === undefined) return 'unknown';
  const t = normalizeType(dbType);
  if (t === 'json' || t === 'jsonb') return 'json';
  if (t.startsWith('_') || t.endsWith('[]')) return 'array';
  if (NUMERIC_TYPES.has(t)) return 'numeric';
  if (Object.hasOwn(TEMPORAL_TYPES, t)) return 'temporal';
  return 'other';
}

/** The {@link NumClass} of a column of this type. */
function numClassOfType(dbType: string | undefined): NumClass {
  if (dbType === undefined) return 'unknown';
  const t = normalizeType(dbType);
  if (INTEGER_TYPES.has(t)) return 'int';
  return NUMERIC_TYPES.has(t) ? 'dec' : 'other';
}

/** The {@link NumClass} of a bound value. */
function numClassOfValue(value: unknown): NumClass {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'dec';
  return 'other';
}

/**
 * The class of a result computed from these operands: anything non-numeric
 * wins, then a non-integer, then an untyped column; NULL is neutral.
 */
function combineClasses(classes: readonly NumClass[]): NumClass {
  let out: NumClass = 'null';
  for (const c of classes) {
    if (c === 'other') return 'other';
    if (c === 'dec' || (c === 'unknown' && out !== 'dec') || (c === 'int' && out === 'null')) out = c;
  }
  return out;
}

function temporalKind(dbType: string | undefined): TemporalKind | undefined {
  if (dbType === undefined) return undefined;
  const t = normalizeType(dbType);
  return Object.hasOwn(TEMPORAL_TYPES, t) ? TEMPORAL_TYPES[t] : undefined;
}

function columnType(qi: BuilderCtx, column: string): string | undefined {
  return qi.columnPgTypeMap.get(column);
}

/**
 * Refuse an expression assigned to a column it cannot target in this release
 * (json/jsonb and array columns). Shared by the walker and the single-row
 * upsert's `excluded` resolution, so both paths refuse the same columns.
 */
export function assertExprTarget(qi: BuilderCtx, key: string, value: SqlExpr | ColumnRef, operation: string): string {
  const column = resolveColumnName(qi.tableMeta, key);
  if (column === undefined) {
    // The SET builder's own unknown-column error names the key; reach it.
    return qi.toColumn(key);
  }
  const cls = columnClass(columnType(qi, column));
  if (cls === 'json' || cls === 'array') {
    // A bare copy of the incoming row's same-typed column (the onConflict
    // field list, `update: ['payload']`) applies no operator, so it is a plain
    // assignment on any column type.
    if (isBareStructuredCopy(qi, column, value)) return column;
    const what = isColumnRef(value) ? `col(${JSON.stringify(value.col)})` : `expr.${(value as SqlExpr).kind}()`;
    throw new ValidationError(
      `${what} in ${operation} data cannot target "${qi.table}.${key}": it is ${cls === 'json' ? 'a json/jsonb' : 'an array'} ` +
        'column, and expressions on json and array columns are not supported. Write a plain value instead.',
    );
  }
  return column;
}

/** `expr.excluded(f)` assigned whole to a column of exactly f's declared type. */
function isBareStructuredCopy(qi: BuilderCtx, column: string, value: unknown): boolean {
  if (!isExcludedRef(value)) return false;
  const source = resolveColumnName(qi.tableMeta, value.field);
  const type = columnType(qi, column);
  return source !== undefined && type !== undefined && columnType(qi, source) === type;
}

// ---------------------------------------------------------------------------
// The walker
// ---------------------------------------------------------------------------

/** What {@link compileSetExpr} needs from its caller (the write module). */
export interface ExprCompileEnv {
  readonly qi: BuilderCtx;
  /** The `data` key being assigned. */
  readonly targetKey: string;
  /** The operation, for messages: `update`, `updateMany`, `upsert`, `createMany`. */
  readonly operation: string;
  /**
   * Bind one value leaf (coerced for the target column) and return its
   * placeholder, cast included. `arithmetic` is the leaf's class when it is an
   * arithmetic operand, where PostgreSQL types it from its own value rather than
   * from the target column.
   */
  bind(value: unknown, arithmetic?: 'int' | 'dec'): string;
  /** Render a column of the target row. */
  column(column: string): string;
  /** Render the incoming row's column, or absent where `expr.excluded` has no meaning. */
  readonly excluded?: ((column: string) => string) | undefined;
  /** The columns the incoming rows supply; `expr.excluded` must name one. */
  readonly insertColumns?: ReadonlySet<string> | undefined;
  /** Compile a `case` arm's predicate (already pruned and validated) against the target row. */
  predicate(when: Record<string, unknown>): string;
}

/** One compiled expression. */
export interface CompiledSetExpr {
  /** The right-hand side of the assignment. */
  readonly sql: string;
  /**
   * Value-free shape: node kinds, resolved column names, value-leaf positions,
   * each arm's predicate fingerprint and the `now()` rendering. Never a value.
   */
  readonly fingerprint: string;
  /** Columns of the target row the expression reads (MySQL assignment order). */
  readonly reads: ReadonlySet<string>;
}

interface Part {
  sql: string;
  fp: string;
  cls: NumClass;
}

interface WalkState {
  readonly env: ExprCompileEnv;
  readonly targetType: string | undefined;
  readonly reads: Set<string>;
}

/**
 * Compile one expression (or `col()` reference) assigned to `env.targetKey`.
 * The single traversal: SQL, params (through `env.bind`, in emission order)
 * and fingerprint come out of one walk.
 *
 * What an expression stores is the same on every engine, by one rule:
 * arithmetic is integer arithmetic when both operands are integers (integer
 * columns, integer numbers, bigints, integer expressions), and integer
 * division truncates toward zero, as `{ divide }` does on an integer column.
 * Any other numeric operand makes it decimal. A non-integer result is refused
 * on an integer column, because the engines disagree on converting one (round
 * half away from zero, round half to even, truncate, or store it unconverted).
 * The class is decided from the operands' types and the bound values' kinds,
 * both part of the fingerprint, so the SQL text never depends on anything the
 * cache key does not capture.
 */
export function compileSetExpr(env: ExprCompileEnv, value: SqlExpr | ColumnRef): CompiledSetExpr {
  const { qi } = env;
  assertEngine(qi);
  const column = assertExprTarget(qi, env.targetKey, value, env.operation);
  const state: WalkState = { env, targetType: columnType(qi, column), reads: new Set() };
  const part = walkOperand(state, value, false, 0);
  if (part.cls === 'dec' && numClassOfType(state.targetType) === 'int') {
    const what = isColumnRef(value) ? `col(${JSON.stringify(value.col)})` : `expr.${(value as SqlExpr).kind}()`;
    throw new ValidationError(
      `${what} in ${env.operation} data on "${qi.table}.${env.targetKey}" computes a non-integer value (an operand ` +
        `is a non-integer number or a non-integer column), and "${env.targetKey}" is an integer column ` +
        `(${state.targetType}). Engines convert such a value differently, so it is refused. Use integer operands ` +
        "(expr.div truncates: expr.div(expr.mul(col('n'), 3), 2) is n * 1.5 truncated), or compute the value in " +
        'JavaScript.',
    );
  }
  return { sql: part.sql, fingerprint: part.fp, reads: state.reads };
}

function assertEngine(qi: BuilderCtx): void {
  if (qi.dialect.capabilities.updateExpressions) return;
  throw new UnsupportedFeatureError(
    'update expressions (expr / col() in update data)',
    qi.dialect.name,
    'Compute the value in JavaScript and write it as a plain value.',
  );
}

function walkOperand(state: WalkState, value: unknown, inArithmetic: boolean, depth: number): Part {
  if (depth > MAX_EXPR_DEPTH) {
    throw new ValidationError(`An update expression is nested more than ${MAX_EXPR_DEPTH} levels deep.`);
  }
  if (isColumnRef(value)) {
    const column = resolveOperandColumn(state, value.col, 'col', inArithmetic);
    state.reads.add(column);
    return { sql: state.env.column(column), fp: `c:${column}`, cls: numClassOfType(columnType(state.env.qi, column)) };
  }
  if (isSqlExpr(value)) return walkNode(state, value, inArithmetic, depth);
  // A value leaf. Its shape was validated when the node was built; the bind
  // seam coerces it for the TARGET column, exactly as a plain value would be.
  // The constructors check their own operands, so this catches the one shape
  // they cannot see: a non-number reaching arithmetic through coalesce,
  // greatest, least or a case arm (`expr.add(expr.coalesce('x', 1), 2)`).
  if (
    inArithmetic &&
    (typeof value === 'string' || typeof value === 'boolean' || value instanceof Date || value instanceof Uint8Array)
  ) {
    throw new ValidationError(
      `An arithmetic operand in ${state.env.operation} data on "${state.env.qi.table}.${state.env.targetKey}" is a ` +
        `${value instanceof Date ? 'Date' : value instanceof Uint8Array ? 'Uint8Array' : typeof value}. ` +
        'Arithmetic takes numbers, bigints, col() of a numeric column, or numeric expressions.',
    );
  }
  // The class is part of the fingerprint: it decides PostgreSQL's cast on an
  // arithmetic operand and MySQL's DIV, so two calls differing only in it must
  // not share a cached statement.
  const cls = numClassOfValue(value);
  const arithmetic = inArithmetic ? (cls === 'dec' ? 'dec' : 'int') : undefined;
  return { sql: state.env.bind(value, arithmetic), fp: `?${cls}`, cls };
}

/** Resolve a field an operand names, refusing columns no expression may read. */
function resolveOperandColumn(state: WalkState, field: string, how: 'col' | 'excluded', inArithmetic: boolean): string {
  const { qi } = state.env;
  const call = how === 'col' ? `col(${JSON.stringify(field)})` : `expr.excluded(${JSON.stringify(field)})`;
  const column = resolveColumnName(qi.tableMeta, field);
  if (column === undefined) {
    throw new ValidationError(
      `${call} in ${state.env.operation} data on "${qi.table}" names no column. ` +
        `Known fields: ${Object.keys(qi.tableMeta.columnMap).join(', ') || '(none)'}.`,
    );
  }
  const cls = columnClass(columnType(qi, column));
  if (cls === 'json' || cls === 'array') {
    throw new ValidationError(
      `${call} on "${qi.table}" reads ${cls === 'json' ? 'a json/jsonb' : 'an array'} column; expressions over json and ` +
        'array columns are not supported.',
    );
  }
  if (inArithmetic && cls !== 'numeric' && cls !== 'unknown') {
    throw new ValidationError(
      `${call} on "${qi.table}" is used in arithmetic, but "${field}" is not a numeric column ` +
        `(${columnType(qi, column)}). Arithmetic takes numeric columns only.`,
    );
  }
  return column;
}

const ARITHMETIC_SQL: Readonly<Record<string, string>> = { add: '+', sub: '-', mul: '*', div: '/' };

function walkNode(state: WalkState, node: SqlExpr, inArithmetic: boolean, depth: number): Part {
  const { env } = state;
  const { qi } = env;
  switch (node.kind) {
    case 'add':
    case 'sub':
    case 'mul':
    case 'div': {
      const cls = columnClass(state.targetType);
      if (!inArithmetic && cls !== 'numeric' && cls !== 'unknown') {
        throw new ValidationError(
          `expr.${node.kind}() in ${env.operation} data on "${qi.table}.${env.targetKey}": arithmetic needs a numeric ` +
            `column, and this one is ${state.targetType}.`,
        );
      }
      const [a, b] = node.args.map((arg) => walkOperand(state, arg, true, depth + 1)) as [Part, Part];
      const result = combineClasses([a.cls, b.cls]);
      // Integer division is the engine's truncating operator: DIV on MySQL,
      // whose `/` is decimal division even between integers (truncating
      // toward zero, like PostgreSQL's, SQLite's and SQL Server's `/`).
      const op =
        node.kind === 'div' && result === 'int' ? qi.dialect.capabilities.integerDivision : ARITHMETIC_SQL[node.kind];
      return { sql: `(${a.sql} ${op} ${b.sql})`, fp: `${node.kind}(${a.fp},${b.fp})`, cls: result };
    }
    case 'coalesce': {
      if (node.args.length > MIN_VARIADIC) qi.markVariableArity();
      const parts = node.args.map((arg) => walkOperand(state, arg, inArithmetic, depth + 1));
      return {
        sql: `COALESCE(${parts.map((p) => p.sql).join(', ')})`,
        fp: `coalesce(${parts.map((p) => p.fp).join(',')})`,
        cls: combineClasses(parts.map((p) => p.cls)),
      };
    }
    case 'greatest':
    case 'least': {
      if (node.args.length > MIN_VARIADIC) qi.markVariableArity();
      const parts = node.args.map((arg) => walkOperand(state, arg, inArithmetic, depth + 1));
      return {
        sql: renderExtreme(
          qi,
          node.kind,
          parts.map((p) => p.sql),
        ),
        fp: `${node.kind}(${parts.map((p) => p.fp).join(',')})`,
        cls: combineClasses(parts.map((p) => p.cls)),
      };
    }
    case 'case':
      return walkCase(state, node as CaseExpr, inArithmetic, depth);
    case 'now': {
      if (inArithmetic) {
        throw new ValidationError('expr.now() cannot be an arithmetic operand: date arithmetic is not supported.');
      }
      const rendered = renderNow(state);
      return { sql: rendered, fp: `now:${rendered}`, cls: 'other' };
    }
    case 'excluded': {
      const field = (node as ExcludedRef).field;
      if (!env.excluded) {
        throw new ValidationError(
          `expr.excluded(${JSON.stringify(field)}) names the incoming row of an upsert (upsert's update, or ` +
            `createMany's onConflict.update); it has no meaning in ${env.operation} data.`,
        );
      }
      // Depth 0 is the whole assigned value: a bare copy, which assertExprTarget
      // has already allowed on a same-typed json or array column.
      const column =
        depth === 0 && isBareStructuredCopy(qi, assertExprTarget(qi, env.targetKey, node, env.operation), node)
          ? (resolveColumnName(qi.tableMeta, field) as string)
          : resolveOperandColumn(state, field, 'excluded', inArithmetic);
      if (env.insertColumns && !env.insertColumns.has(column)) {
        throw new ValidationError(
          `expr.excluded(${JSON.stringify(field)}) on "${qi.table}" names a field the incoming rows do not supply. ` +
            'Add it to every row of data, or read the existing value with col() instead.',
        );
      }
      return { sql: env.excluded(column), fp: `x:${column}`, cls: numClassOfType(columnType(qi, column)) };
    }
    default:
      throw new ValidationError(`Unknown expression kind "${String(node.kind)}".`);
  }
}

function walkCase(state: WalkState, node: CaseExpr, inArithmetic: boolean, depth: number): Part {
  const { env } = state;
  const { qi } = env;
  // The arm count is the caller's array length, written into the SQL text, so
  // the statement is not a fixed shape (see BuilderCtx.markVariableArity).
  qi.markVariableArity();
  const sqlParts: string[] = [];
  const fpParts: string[] = [];
  const classes: NumClass[] = [];
  node.args.forEach((arm, i) => {
    const when = caseWhen(state, arm.when, i);
    const predicate = env.predicate(when);
    const then = walkOperand(state, arm.then, inArithmetic, depth + 1);
    sqlParts.push(`WHEN ${predicate} THEN ${then.sql}`);
    classes.push(then.cls);
    fpParts.push(`w:${fingerprintWhere(qi, when)}=>${then.fp}`);
  });
  const hasElse = node.else !== undefined;
  const otherwise = hasElse ? walkOperand(state, node.else, inArithmetic, depth + 1) : undefined;
  if (otherwise) classes.push(otherwise.cls);
  return {
    sql: `CASE ${sqlParts.join(' ')}${otherwise ? ` ELSE ${otherwise.sql}` : ''} END`,
    fp: `case(${fpParts.join(';')}|e:${otherwise ? otherwise.fp : '-'})`,
    cls: combineClasses(classes),
  };
}

/**
 * Prune and validate one arm's `when`: `undefined` keys drop out (the C1 rule
 * for every `where` position), an arm left with no predicate is refused, and
 * relation filters are refused. The columns it reads are recorded.
 */
function caseWhen(state: WalkState, when: Record<string, unknown>, index: number): Record<string, unknown> {
  const { qi } = state.env;
  const pruned = pruneUndefinedArgs(qi.schema, qi.table, { where: when }).where as Record<string, unknown>;
  if (!isPlainRecord(pruned) || Object.keys(pruned).length === 0) {
    throw new ValidationError(
      `expr.case(): arm ${index + 1}'s when on "${qi.table}" has no predicate${
        pruned === when ? '' : ' (every key was undefined)'
      }. Every arm needs a condition; use the second argument of expr.case() for the fallback value.`,
    );
  }
  collectPredicateReads(state, pruned, 0);
  return pruned;
}

function collectPredicateReads(state: WalkState, where: WhereRecord, depth: number): void {
  const { qi } = state.env;
  if (depth > MAX_EXPR_DEPTH) {
    throw new ValidationError(`An expr.case() predicate is nested more than ${MAX_EXPR_DEPTH} levels deep.`);
  }
  for (const event of walkWhere(qi.whereHost, where)) {
    switch (event.kind) {
      case 'or':
      case 'and':
        for (const c of event.conditions) collectPredicateReads(state, c, depth + 1);
        break;
      case 'not':
        collectPredicateReads(state, event.condition, depth + 1);
        break;
      case 'relation':
        throw new ValidationError(
          `expr.case() on "${qi.table}": "${event.key}" is a relation filter. A case arm's when takes predicates ` +
            "on the row's own columns only.",
        );
      case 'scalar': {
        const column = resolveColumnName(qi.tableMeta, event.key);
        if (column !== undefined) state.reads.add(column);
        collectRefReads(state, event.value, 0);
        break;
      }
    }
  }
}

/** Record the columns `col()` references inside an operator object read. */
function collectRefReads(state: WalkState, value: unknown, depth: number): void {
  if (depth > 4) return;
  if (isColumnRef(value)) {
    const column = resolveColumnName(state.env.qi.tableMeta, value.col);
    if (column !== undefined) state.reads.add(column);
    return;
  }
  if (isPlainRecord(value)) for (const v of Object.values(value)) collectRefReads(state, v, depth + 1);
}

// ---------------------------------------------------------------------------
// Per-engine rendering
// ---------------------------------------------------------------------------

/**
 * GREATEST / LEAST that ignore NULLs on every engine. PostgreSQL's ignore NULL
 * arguments natively. MySQL's and SQLite's return NULL when ANY argument is
 * NULL, so each position i becomes COALESCE(arg_i, <the others>): when any
 * argument is non-NULL every position is non-NULL and each non-NULL argument
 * still appears as itself in its own position, so the extreme is the extreme of
 * the non-NULL arguments; when all are NULL the result is NULL. SQL Server
 * before 2022 has no GREATEST, and MAX over a VALUES list ignores NULLs.
 *
 * Each argument was compiled once, so a bound value repeated across positions
 * reuses ONE placeholder (every engine here binds by number or by name).
 */
function renderExtreme(qi: BuilderCtx, kind: 'greatest' | 'least', args: string[]): string {
  switch (qi.dialect.name) {
    case 'postgresql':
      return `${kind === 'greatest' ? 'GREATEST' : 'LEAST'}(${args.join(', ')})`;
    case 'mssql':
      return (
        `(SELECT ${kind === 'greatest' ? 'MAX' : 'MIN'}(turbine_v) FROM ` +
        `(VALUES ${args.map((a) => `(${a})`).join(', ')}) AS turbine_ext(turbine_v))`
      );
    default: {
      const fn = qi.dialect.name === 'sqlite' ? (kind === 'greatest' ? 'max' : 'min') : kind.toUpperCase();
      const positions = args.map((a, i) => `COALESCE(${[a, ...args.filter((_, j) => j !== i)].join(', ')})`);
      return `${fn}(${positions.join(', ')})`;
    }
  }
}

/**
 * The server's current time for the target column, in the convention the read
 * path uses. Zone-less `timestamp` / `date` columns take the UTC wall clock
 * (PostgreSQL with `utcTimestamps: false` takes the session's local time, which
 * is what that setting reads back), `timestamptz` takes the instant, and on
 * SQLite, where Turbine binds a Date as ISO-8601 UTC text, the same text (the
 * `YYYY-MM-DD` UTC day on a date column).
 */
function renderNow(state: WalkState): string {
  const { qi, targetKey, operation } = state.env;
  const kind = temporalKind(state.targetType);
  if (kind === undefined || kind === 'time') {
    throw new ValidationError(
      `expr.now() in ${operation} data cannot target "${qi.table}.${targetKey}"` +
        (state.targetType === undefined ? ': the column has no known type. ' : ` (${state.targetType}): `) +
        'it fits timestamp, timestamptz, datetime and date columns only.',
    );
  }
  const utc = qi.utcTimestamps !== false;
  switch (qi.dialect.name) {
    case 'postgresql':
      if (kind === 'tz') return 'now()';
      if (kind === 'date') return utc ? "(now() AT TIME ZONE 'UTC')::date" : 'CURRENT_DATE';
      return utc ? "(now() AT TIME ZONE 'UTC')" : 'LOCALTIMESTAMP';
    case 'mysql':
      return kind === 'date' ? 'UTC_DATE()' : 'UTC_TIMESTAMP(3)';
    case 'sqlite':
      // The text a bound Date takes on SQLite: the UTC day on a date column.
      return kind === 'date' ? "strftime('%Y-%m-%d', 'now')" : "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    default:
      if (kind === 'tz') return 'SYSDATETIMEOFFSET()';
      if (kind === 'date') return 'CAST(SYSUTCDATETIME() AS date)';
      return 'SYSUTCDATETIME()';
  }
}

// ---------------------------------------------------------------------------
// Single-row upsert: `excluded` is `create`'s value
// ---------------------------------------------------------------------------

/**
 * Rewrite every `expr.excluded(f)` in a single-row upsert's `update` to the
 * value `create` supplies for `f`. The incoming row of a one-row upsert IS
 * `create`, so the statement path, the lookup-first path (a plain update) and
 * a nested upsert store the same row. A top-level reference becomes
 * `{ set: value }`, which writes the value exactly as a plain value would be
 * written, on every column type (json and array columns take `set` too). A
 * reference inside an expression becomes a value operand, checked as the
 * node's constructor checks one; the expression is then compiled by the
 * update, with the column-type rules every expression gets. Needs only the
 * table's name and metadata, so the nested-write engine shares it. Returns
 * `update` by reference when it holds no reference.
 */
export function resolveExcludedFromCreate(
  target: { readonly table: string; readonly tableMeta: TableMetadata },
  update: Record<string, unknown> | undefined,
  create: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!update || !Object.values(update).some(holdsExcluded)) return update;
  const createByColumn = new Map<string, unknown>();
  for (const [key, value] of Object.entries(create ?? {})) {
    if (value === undefined) continue;
    const column = resolveColumnName(target.tableMeta, key);
    if (column !== undefined) createByColumn.set(column, value);
  }
  const incomingValue = (ref: ExcludedRef): unknown => {
    const column = resolveColumnName(target.tableMeta, ref.field);
    if (column === undefined || !createByColumn.has(column)) {
      throw new ValidationError(
        `expr.excluded(${JSON.stringify(ref.field)}) in upsert's update on "${target.table}" names a field ` +
          '`create` does not supply. It reads the incoming row, which is `create`.',
      );
    }
    return createByColumn.get(column);
  };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    if (!holdsExcluded(value)) {
      out[key] = value;
      continue;
    }
    out[key] = isExcludedRef(value)
      ? { set: incomingValue(value) }
      : replaceExcluded(value as SqlExpr, incomingValue, 0);
  }
  return out;
}

function holdsExcluded(value: unknown, depth = 0): boolean {
  if (depth > MAX_EXPR_DEPTH || !isSqlExpr(value)) return false;
  if (isExcludedRef(value)) return true;
  if (value.kind === 'case') {
    const node = value as CaseExpr;
    return node.args.some((arm) => holdsExcluded(arm.then, depth + 1)) || holdsExcluded(node.else, depth + 1);
  }
  return value.args.some((arg) => holdsExcluded(arg, depth + 1));
}

function replaceExcluded(node: SqlExpr, incomingValue: (ref: ExcludedRef) => unknown, depth: number): SqlExpr {
  if (depth > MAX_EXPR_DEPTH) {
    throw new ValidationError(`An update expression is nested more than ${MAX_EXPR_DEPTH} levels deep.`);
  }
  // The value `create` supplies takes the reference's place, so it must pass
  // the check the node's constructor applies to an operand in that position.
  const arithmeticNode = node.kind === 'add' || node.kind === 'sub' || node.kind === 'mul' || node.kind === 'div';
  const swap = (operand: unknown, position: number): unknown => {
    if (isExcludedRef(operand)) {
      const value = incomingValue(operand);
      if (arithmeticNode) assertNumericOperand(node.kind, position, value);
      else assertOperand(node.kind, position, value);
      return value;
    }
    return isSqlExpr(operand) ? replaceExcluded(operand, incomingValue, depth + 1) : operand;
  };
  if (node.kind === 'case') {
    const c = node as CaseExpr;
    // biome-ignore lint/suspicious/noThenProperty: SQL's CASE WHEN ... THEN; a value operand, never a function
    const arms = c.args.map((arm, i) => Object.freeze({ when: arm.when, then: swap(arm.then, i) }));
    return makeNode('case', arms, c.else === undefined ? undefined : { else: swap(c.else, arms.length) });
  }
  return makeNode(node.kind, node.args.map(swap));
}
