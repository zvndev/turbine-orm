/**
 * PowqlInterface — Turbine's PowQL query generator (the PowDB analogue of
 * {@link QueryInterface}). It exposes the same public method surface as the SQL
 * `QueryInterface` (`findMany`, `create`, `update`, …) but emits **PowQL** — a
 * pipeline language, not SQL — executed through {@link PowdbPool}.
 *
 * It is a *parallel* implementation rather than a `Dialect` of the SQL builder:
 * PowQL's grammar (`T filter <e> order <k> { .col }`) shares no surface with
 * `SELECT … FROM … WHERE`, so the SQL `Dialect` seam cannot express it. Keeping
 * it separate also means the four SQL engines are untouched.
 *
 * Behavioural deltas from the SQL path, all driven by PowDB's wire reality (see
 * `docs/internal/strategy/powdb-parity-matrix.md`, every row verified against a live
 * server):
 *   - `create`/`createMany`/`update`/`delete` use PowDB 0.7.0's trailing
 *     `returning` keyword (`RETURNING *`, all columns) to surface affected rows
 *     in one round-trip. `upsert` is the lone exception — its statement does not
 *     accept `returning`, so it reselects the row by PK (a composite-PK upsert
 *     reselects-or-writes inside one flat transaction).
 *   - The PK is server-assigned when the column is `isGenerated` (PowDB's `auto`
 *     int — read back via `returning`); otherwise a defaulted **string** PK is
 *     generated client-side (UUID).
 *   - `with` (nested relations) uses **batched N+1 loaders** — D round-trips for
 *     depth D, not one query — including manyToMany (junction → targets).
 *   - **Relation filters** (`some`/`none`/`every`, all cardinalities incl. m2m)
 *     are resolved client-side to a literal `in (…)` list, never an IN-subquery:
 *     PowDB's executor caches a subquery's result by plan shape and would return
 *     a stale prior result for a later subquery of the same shape.
 *   - **Nested writes** (relation ops in `create`/`update` data) run through the
 *     shared nested-write engine as one flat top-level transaction (PowDB is
 *     single-writer, no savepoints).
 *   - pgvector / JSON / array filters and cursor streaming throw
 *     {@link UnsupportedFeatureError} (E017) — they have no PowDB equivalent.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { NotFoundError, ReadOnlyError, TimeoutError, UnsupportedFeatureError, ValidationError } from './errors.js';
import {
  executeNestedCreate,
  executeNestedUpdate,
  hasRelationFields,
  type NestedWriteContext,
} from './nested-write.js';
import {
  ALL_POWDB_CAPABILITIES,
  coerceNativeValue,
  isJsonColumn,
  isStaleFramePowdbError,
  type PowdbCapabilities,
  PowdbFloatParam,
  PowdbJsonParam,
  type PowdbPool,
  powqlColumnType,
  quotePowqlIdent,
  requireCapability,
  rowToEntity,
} from './powdb.js';
import { isJsonFilter, isRelationPickOrderBy } from './query/filters.js';
import type { MiddlewareFn, QueryEvent, QueryInterfaceOptions } from './query/index.js';
import type {
  AggregateArgs,
  AggregateResult,
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindManyArgs,
  FindUniqueArgs,
  GroupByArgs,
  GroupByOrderBy,
  JsonFilter,
  JsonPathAggregateTarget,
  JsonPathGroupKey,
  JsonPathOrderBy,
  OrderByClause,
  OrderBySpec,
  UpdateArgs,
  UpdateManyArgs,
  UpsertArgs,
  WhereClause,
} from './query/types.js';
import { escapeLike } from './query/utils.js';
import {
  type ColumnMetadata,
  normalizeKeyColumns,
  type RelationDef,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';

/**
 * Max parent keys per relation-loader `in (…)` query. A `with` over a large
 * parent set is split into batches of this size so a single query never exceeds
 * PowDB's per-statement param / row limits; the batches' children are merged
 * before grouping. Mirrors the chunking the parity matrix documents.
 */
const MAX_RELATION_KEYS = 1000;

/**
 * Read-shaped actions whose statement may be transparently replayed once on a
 * stale wire frame when `retryStaleReads` is enabled (see
 * {@link PowqlInterface.execOnce}). Writes are deliberately absent: replaying a
 * mutation after an ambiguous reply can double-execute, matching the client's
 * own native-path policy.
 */
const POWQL_READ_ACTIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findUnique',
  'findFirst',
  'count',
  'aggregate',
  'groupBy',
  'explain',
]);

/**
 * Mutating actions the {@link PowqlInterface} readonly guard refuses locally
 * (before the wire) on a read-only pool. A transaction-control `begin` is
 * guarded separately in {@link PowqlInterface.runInImplicitTx}. Kept keyed on
 * the per-call action string (never `this`-state) so a concurrent read can
 * never be mistaken for one of these.
 */
const POWQL_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

/**
 * Top-level query context threaded from {@link PowqlInterface.findMany} into
 * {@link PowqlInterface.loadRelations} so the F2 native-join path can re-emit
 * the parent predicate (alias-qualified) and gate eligibility on the parent's
 * paging / configured strategy. Present only for a top-level `with`.
 */
interface PowqlParentContext<T> {
  args: FindManyArgs<T>;
  resolvedWhere: WhereClause<T> | undefined;
}

/** Operator keys recognised inside a `WhereOperator` object. */
const OPERATOR_KEYS = new Set([
  'equals',
  'gt',
  'gte',
  'lt',
  'lte',
  'not',
  'in',
  'notIn',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
]);

/** Filters that have no PowDB representation and must throw E017. */
function rejectUnsupportedFilter(value: Record<string, unknown>, field: string): void {
  if ('distance' in value || 'metric' in value) {
    throw new UnsupportedFeatureError('pgvector distance filters', 'PowDB', `field "${field}"`);
  }
  if ('path' in value || 'hasKey' in value) {
    throw new UnsupportedFeatureError('JSON path/key filters', 'PowDB', `field "${field}"`);
  }
  if ('hasEvery' in value || 'hasSome' in value || 'isEmpty' in value) {
    throw new UnsupportedFeatureError('array filters', 'PowDB', `field "${field}"`);
  }
  if ('search' in value) {
    throw new UnsupportedFeatureError('full-text search filters', 'PowDB', `field "${field}"`);
  }
}

/**
 * The PowQL query interface. Constructed by `turbinePowDB` via the
 * `queryInterfaceFactory` seam and cast to `QueryInterface<object>` so
 * `TurbineClient.table()` can return it transparently.
 */
export class PowqlInterface<T extends object = Record<string, unknown>> {
  private readonly meta: TableMetadata;
  private readonly defaultLimit?: number;
  private readonly warnOnUnlimited: boolean;
  private readonly onQuery?: (event: QueryEvent) => void;
  private warnedUnlimited = false;

  constructor(
    private readonly pool: PowdbPool,
    private readonly table: string,
    private readonly schema: SchemaMetadata,
    private readonly middlewares: MiddlewareFn[] = [],
    private readonly options: QueryInterfaceOptions = {},
  ) {
    const meta = schema.tables[table];
    if (!meta) {
      throw new ValidationError(
        `[turbine] Unknown table "${table}". Available: ${Object.keys(schema.tables).join(', ')}`,
      );
    }
    this.meta = meta;
    this.defaultLimit = options.defaultLimit;
    // Same per-table resolution as QueryInterface: an object map accepts BOTH
    // the snake_case table name and the camelCase accessor as keys (snake_case
    // wins on conflict); unlisted tables keep the default (warn on).
    const warnOpt = options.warnOnUnlimited;
    this.warnOnUnlimited =
      typeof warnOpt === 'object' && warnOpt !== null
        ? (warnOpt[table] ?? warnOpt[snakeToCamel(table)]) !== false
        : warnOpt !== false;
    this.onQuery = options._onQuery;
  }

  // -------------------------------------------------------------------------
  // Column / value helpers
  // -------------------------------------------------------------------------

  /** Resolve a camelCase field name (or raw snake) to its column metadata. */
  private column(field: string) {
    const snake = this.meta.columnMap[field] ?? field;
    const col = this.meta.columns.find((c) => c.name === snake || c.field === field);
    if (!col) {
      throw new ValidationError(
        `[turbine] Unknown column "${field}" on table "${this.table}". Known: ${this.meta.columns
          .map((c) => c.field)
          .join(', ')}`,
      );
    }
    return col;
  }

  /**
   * PowQL column reference for a field. Unqualified it is a dotted field
   * reference (`.snake_name`), which bypasses keyword lookup. When an `alias`
   * is supplied (the F2 join path) it is qualified (`alias.snake_name`) and the
   * column name is backtick-quoted if it is a reserved word — a qualified
   * `p.order` does NOT bypass keyword lookup, unlike the dotted `.order`.
   */
  private ref(field: string, alias?: string): string {
    return this.colRefName(this.column(field).name, alias);
  }

  /** Render a raw column name as a PowQL reference, qualified with `alias` when given. */
  private colRefName(name: string, alias?: string): string {
    return alias ? `${alias}.${quotePowqlIdent(name)}` : `.${name}`;
  }

  /**
   * Push a value into the param array and return its `$N` placeholder. When the
   * value targets a `float` column it is wrapped in {@link PowdbFloatParam} so
   * the *embedded* literal encoder emits a float-form literal even for an
   * integer value (PowQL's `42` is an int literal, `42.0` a float). The
   * networked driver unwraps the marker back to the plain number in
   * {@link toPowdbParam}, so the wire param is unchanged.
   */
  private param(value: unknown, params: unknown[], col?: ColumnMetadata): string {
    let tagged: unknown = value;
    if (col && typeof value === 'number' && this.isFloatCol(col)) {
      // Float column: force a float-form literal even for an integer value.
      tagged = new PowdbFloatParam(value);
    } else if (col && value !== null && typeof value === 'object' && !(value instanceof Date) && isJsonColumn(col)) {
      // json document column: a JS object/array is serialized to canonical JSON
      // text and stored as a json document (a JS string passes through raw, same
      // contract as pg jsonb; `null` stays `null`).
      tagged = new PowdbJsonParam(value);
    }
    params.push(tagged);
    return `$${params.length}`;
  }

  /**
   * Render a value for a write *assignment* (`col := …`). Every value — float
   * columns included — is sent as a positional `$N` param. PowDB ≥ 0.7.0 fixed
   * the int→float UPDATE coercion bug (`score := $n` with an integer param now
   * reads back the integer value, not the raw i64 bits), so the float-literal
   * inlining workaround Turbine carried for ≤ 0.6.2 is gone. Marks the column as
   * float-typed for the *embedded* literal encoder (which materializes params
   * into PowQL text) so an integer-valued float still encodes as a float literal
   * and coercion stays unambiguous. Non-finite floats are still rejected.
   */
  private writeRef(value: unknown, col: ColumnMetadata, params: unknown[]): string {
    if (typeof value === 'number' && !Number.isFinite(value) && this.isFloatCol(col)) {
      throw new ValidationError(`[turbine] Non-finite value for float column "${col.name}" on "${this.table}".`);
    }
    return this.param(value, params, col);
  }

  private isFloatCol(col: ColumnMetadata): boolean {
    try {
      return powqlColumnType(col) === 'float';
    } catch {
      return false;
    }
  }

  /**
   * The bound pool's {@link PowdbCapabilities}. Falls back to the trusted-caller
   * default (all feature gates on, `nativeRaw` off) when a directly-constructed
   * pool did not carry them, matching {@link PowdbPool}'s own constructor
   * default so a hand-built test pool never crashes the version gates.
   */
  private get capabilities(): PowdbCapabilities {
    return this.pool.capabilities ?? ALL_POWDB_CAPABILITIES;
  }

  /** A predicate that is always false — the empty-`in` / contradiction sentinel. */
  private alwaysFalse(): string {
    const pk = this.meta.primaryKey[0] ?? this.meta.columns[0]?.name;
    return `(.${pk} is null and .${pk} is not null)`;
  }

  // -------------------------------------------------------------------------
  // WHERE builder
  // -------------------------------------------------------------------------

  /**
   * Compile a {@link WhereClause} into a PowQL filter expression, pushing every
   * value as a positional `$N` param. Returns `''` when there are no conditions.
   *
   * When `alias` is supplied (the F2 native-join path) every field reference is
   * qualified with it (`.col` → `alias.col`, JSON path bases too); params bind
   * exactly as in the unqualified path. The caller only ever passes an alias for
   * an already-RESOLVED where (relation filters pre-resolved to literal in-lists
   * by {@link resolveRelationFilters}) — the relation-key branch below still
   * throws, so an unresolved relation filter can never leak into a join.
   */
  private buildWhere(where: WhereClause<T> | undefined, params: unknown[], alias?: string): string {
    if (!where) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'AND') {
        const sub = (value as WhereClause<T>[]).map((w) => this.buildWhere(w, params, alias)).filter(Boolean);
        if (sub.length) parts.push(`(${sub.join(' and ')})`);
      } else if (key === 'OR') {
        const sub = (value as WhereClause<T>[]).map((w) => this.buildWhere(w, params, alias)).filter(Boolean);
        if (sub.length) parts.push(`(${sub.join(' or ')})`);
      } else if (key === 'NOT') {
        const sub = this.buildWhere(value as WhereClause<T>, params, alias);
        if (sub) parts.push(`not (${sub})`);
      } else if (this.meta.relations[key]) {
        // Relation filters are pre-resolved to scalar in/notIn by
        // resolveRelationFilters() before buildWhere runs — reaching here means
        // a caller skipped that step (an internal bug, not user error).
        throw new ValidationError(
          `[turbine] internal: relation filter "${key}" reached buildWhere unresolved (missing resolveRelationFilters()).`,
        );
      } else {
        // A JsonFilter (or a bare `{ path }`) can compile to zero clauses; skip
        // empty results so buildWhere never emits a dangling ` and `.
        const cond = this.buildFieldCondition(key, value, params, alias);
        if (cond) parts.push(cond);
      }
    }
    return parts.join(' and ');
  }

  /** Build a single `field: value | operator` condition. */
  private buildFieldCondition(field: string, value: unknown, params: unknown[], alias?: string): string {
    const colMeta = this.column(field);
    const ref = this.ref(field, alias);
    if (value === null) return `${ref} is null`;
    if (value instanceof Date || typeof value !== 'object') {
      return `${ref} = ${this.param(value, params, colMeta)}`;
    }
    const op = value as Record<string, unknown>;
    // JSON path / key filters on a json document column compile to PowQL `->`
    // path filters (≥ 0.12). `isJsonFilter` matches `path`/`equals`/`contains`/
    // `hasKey`; on a NON-json column those fall through to the scalar operator
    // path below (e.g. `equals` stays a plain equality), exactly like SQL.
    if (isJsonColumn(colMeta) && isJsonFilter(value)) {
      requireCapability(this.capabilities, 'jsonDocs', 'JSON path filters');
      return this.buildJsonPathCondition(colMeta, value, params, alias);
    }
    rejectUnsupportedFilter(op, field);
    if (!Object.keys(op).some((k) => OPERATOR_KEYS.has(k))) {
      // A bare object that is not an operator set — equality by value.
      return `${ref} = ${this.param(value, params)}`;
    }
    const insensitive = op.mode === 'insensitive';
    const lhs = insensitive ? `lower(${ref})` : ref;
    const conds: string[] = [];
    for (const [opName, opVal] of Object.entries(op)) {
      if (opVal === undefined || opName === 'mode') continue;
      switch (opName) {
        case 'equals':
          conds.push(opVal === null ? `${ref} is null` : `${lhs} = ${this.bind(opVal, params, insensitive)}`);
          break;
        case 'not':
          conds.push(opVal === null ? `${ref} is not null` : `not (${lhs} = ${this.bind(opVal, params, insensitive)})`);
          break;
        case 'gt':
          conds.push(`${lhs} > ${this.bind(opVal, params, insensitive)}`);
          break;
        case 'gte':
          conds.push(`${lhs} >= ${this.bind(opVal, params, insensitive)}`);
          break;
        case 'lt':
          conds.push(`${lhs} < ${this.bind(opVal, params, insensitive)}`);
          break;
        case 'lte':
          conds.push(`${lhs} <= ${this.bind(opVal, params, insensitive)}`);
          break;
        case 'in':
          conds.push(this.buildInList(lhs, opVal as unknown[], params, insensitive, false));
          break;
        case 'notIn':
          conds.push(this.buildInList(lhs, opVal as unknown[], params, insensitive, true));
          break;
        case 'contains':
          conds.push(`${lhs} like ${this.bindLike(`%${escapeLike(String(opVal))}%`, params, insensitive)}`);
          break;
        case 'startsWith':
          conds.push(`${lhs} like ${this.bindLike(`${escapeLike(String(opVal))}%`, params, insensitive)}`);
          break;
        case 'endsWith':
          conds.push(`${lhs} like ${this.bindLike(`%${escapeLike(String(opVal))}`, params, insensitive)}`);
          break;
        default:
          throw new ValidationError(`[turbine] Unsupported operator "${opName}" on PowDB.`);
      }
    }
    return conds.length > 1 ? `(${conds.join(' and ')})` : (conds[0] ?? this.alwaysFalse());
  }

  /**
   * PowQL JSON path expression `.col->$a->$b…`, binding EVERY path segment as a
   * positional param (a string segment as a `str` token, an integer index as an
   * `int` token). `->` binds tighter than every operator, so no parens are
   * needed around the path in a comparison. Segments are bound (never inlined)
   * to keep {@link materializePowql}'s `$N`-scan invariant intact: a segment
   * that literally contained `$1` would otherwise be rewritten. Shared by the
   * F1 where-filter path and the F2 orderBy / groupBy path emitters.
   *
   * A digit-only STRING segment (`'0'`) binds as an `int` array index, matching
   * the SQL engines: `JsonFilter.path` is typed `string[]`, so an array index
   * can only be expressed as a digit string, and the SQL builder converts it the
   * same way (`/^\d+$/ → [n]`, query/builder.ts). Without this, PowDB's typed
   * `->` treats `'0'` as a string KEY and silently matches nothing on an array
   * (a wrong result, not an error). Same object-key-`'0'` caveat SQL accepts: a
   * json object whose key is literally `"0"` is addressed as an array index.
   */
  private jsonPathExpr(col: ColumnMetadata, path: (string | number)[], params: unknown[], alias?: string): string {
    let expr = this.colRefName(col.name, alias);
    for (const seg of path) {
      const bound = typeof seg === 'string' && /^\d+$/.test(seg) ? Number(seg) : seg;
      expr += `->${this.param(bound, params)}`;
    }
    return expr;
  }

  /**
   * Compile a {@link JsonFilter} on a json document column into a PowQL filter
   * (≥ 0.12). Operators PowQL cannot express EXACTLY throw a per-operator E017
   * (never a wrong result): containment (`contains`, and `equals` without a
   * `path`) has no PowQL operator. The mapped shapes:
   *   - `{ path, equals: v }`  → `P = $n` (typed: string→str, bool→bool,
   *      integral number→int, fractional→float; NOT stringified)
   *   - `{ path, equals: null }` → `P is null` (matches JSON null AND a missing
   *      key, a deliberate divergence from the PG driver, documented on
   *      {@link JsonFilter})
   *   - `{ path, gt|gte|lt|lte: v }` → `P > $n` … (range ops require `path`; the
   *      engine coerces int/float numerically)
   *   - `{ hasKey: k }` → `json_type(.col->$n) is not null` (top-level key test,
   *      ignoring `path`, mirroring PG `col ? key`; includes keys holding JSON
   *      null)
   * A bare `{ path }` with no operators compiles to zero clauses (byte-parity
   * with SQL), so a mutation whose only `where` is a bare `{ path }` is refused
   * by the empty-where guard.
   */
  private buildJsonPathCondition(col: ColumnMetadata, filter: JsonFilter, params: unknown[], alias?: string): string {
    const conds: string[] = [];
    // Bind the path segments at most once and reuse the expression string across
    // equals + range comparisons (they share the same `path`).
    let pathExpr: string | null = null;
    const pathP = (): string => {
      pathExpr ??= this.jsonPathExpr(col, filter.path!, params, alias);
      return pathExpr;
    };

    if (filter.contains !== undefined) {
      throw new UnsupportedFeatureError(
        'JSON containment filters (contains)',
        'PowDB',
        `column "${col.name}": PowQL has no JSON containment operator`,
      );
    }
    if (filter.equals !== undefined) {
      if (filter.path === undefined || filter.path.length === 0) {
        throw new UnsupportedFeatureError(
          'JSON containment (equals without path)',
          'PowDB',
          `column "${col.name}": pass a \`path\` to compare a specific json value; PowQL has no whole-document containment`,
        );
      }
      conds.push(filter.equals === null ? `${pathP()} is null` : `${pathP()} = ${this.param(filter.equals, params)}`);
    }
    if (filter.hasKey !== undefined) {
      // Top-level key existence, independent of `path` (mirrors PG `col ? key`).
      conds.push(`json_type(${this.colRefName(col.name, alias)}->${this.param(filter.hasKey, params)}) is not null`);
    }
    // Range comparisons on the extracted path, in the fixed gt/gte/lt/lte order.
    // Same validation as SQL `jsonRangeEntries`: `path` required, value a finite
    // number or a string.
    for (const [op, powOp] of [
      ['gt', '>'],
      ['gte', '>='],
      ['lt', '<'],
      ['lte', '<='],
    ] as const) {
      const v = (filter as Record<string, unknown>)[op];
      if (v === undefined) continue;
      if (filter.path === undefined) {
        throw new ValidationError(
          `[turbine] JSON range operator '${op}' on ${col.name} requires a \`path\` ` +
            `(e.g. { path: ['meta', 'score'], ${op}: ${JSON.stringify(v)} }).`,
        );
      }
      if (typeof v !== 'number' && typeof v !== 'string') {
        throw new ValidationError(
          `[turbine] JSON range operator '${op}' on ${col.name} requires a number or string, got ${JSON.stringify(v)}.`,
        );
      }
      if (typeof v === 'number' && !Number.isFinite(v)) {
        throw new ValidationError(`[turbine] JSON range operator '${op}' on ${col.name} requires a finite number.`);
      }
      conds.push(`${pathP()} ${powOp} ${this.param(v, params)}`);
    }

    if (!conds.length) return '';
    return conds.length > 1 ? `(${conds.join(' and ')})` : conds[0]!;
  }

  /** Bind a value, lowercasing for case-insensitive comparisons. */
  private bind(value: unknown, params: unknown[], insensitive: boolean): string {
    const ph = this.param(value, params);
    return insensitive ? `lower(${ph})` : ph;
  }

  /** Bind a LIKE pattern (already escaped), lowercasing for insensitive mode. */
  private bindLike(pattern: string, params: unknown[], insensitive: boolean): string {
    const ph = this.param(pattern, params);
    return insensitive ? `lower(${ph})` : ph;
  }

  /** `lhs [not] in ($1, $2, …)` — empty list collapses to a constant. */
  private buildInList(
    lhs: string,
    values: unknown[],
    params: unknown[],
    insensitive: boolean,
    negate: boolean,
  ): string {
    if (!Array.isArray(values) || values.length === 0) {
      // `in []` matches nothing; `not in []` matches everything.
      return negate ? '(1 = 1)' : this.alwaysFalse();
    }
    const items = values.map((v) => this.bind(v, params, insensitive)).join(', ');
    return `${lhs} ${negate ? 'not in' : 'in'} (${items})`;
  }

  /**
   * Pre-resolve every relation filter (`some`/`none`/`every`) in a where clause
   * into a plain scalar `in`/`notIn` condition on the **local key**, by running
   * the inner predicate as its own query and materializing the matching keys as
   * a literal list. The compiled where is then relation-free and `buildWhere`
   * emits only `in (<literal list>)`.
   *
   * Why not an IN-subquery (`.k in (Target filter <e> { .fk })`)? PowDB's
   * executor caches a subquery's result by **plan shape, ignoring the literal**,
   * so a second subquery of the same shape with a different value returns the
   * first one's stale rows (reproduced live on the embedded engine; the
   * single-statement literal `in (list)` form is always correct). Resolving
   * client-side trades extra round-trips for correctness, and recurses — nested
   * relation filters in the inner predicate resolve when the target query runs.
   */
  private async resolveRelationFilters(
    where: WhereClause<T> | undefined,
    timeout?: number,
  ): Promise<WhereClause<T> | undefined> {
    if (!where) return where;
    const scalar: Record<string, unknown> = {};
    const relConds: Record<string, unknown>[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'AND' || key === 'OR') {
        scalar[key] = await Promise.all(
          (value as WhereClause<T>[]).map((w) => this.resolveRelationFilters(w, timeout)),
        );
      } else if (key === 'NOT') {
        scalar[key] = await this.resolveRelationFilters(value as WhereClause<T>, timeout);
      } else if (this.meta.relations[key]) {
        relConds.push(
          await this.resolveRelationCondition(this.meta.relations[key]!, value as Record<string, unknown>, timeout),
        );
      } else {
        scalar[key] = value;
      }
    }
    if (!relConds.length) return scalar as WhereClause<T>;
    const hasScalar = Object.keys(scalar).length > 0;
    return { AND: [...(hasScalar ? [scalar] : []), ...relConds] } as WhereClause<T>;
  }

  /** Resolve one hasMany/hasOne/belongsTo filter to `{ localField: { in|notIn: [...] } }`. */
  private async resolveRelationCondition(
    rel: RelationDef,
    filter: Record<string, unknown>,
    timeout?: number,
  ): Promise<Record<string, unknown>> {
    const mode = filter.some ? 'some' : filter.none ? 'none' : filter.every ? 'every' : null;
    if (!mode) return {};
    const innerWhere = filter[mode] as Record<string, unknown> | undefined;
    const innerEmpty = !innerWhere || Object.keys(innerWhere).length === 0;
    if (rel.type === 'manyToMany') {
      return this.resolveManyToManyCondition(rel, mode, innerWhere, innerEmpty, timeout);
    }
    const fk = normalizeKeyColumns(rel.foreignKey);
    const rk = normalizeKeyColumns(rel.referenceKey);
    if (fk.length > 1 || rk.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key relation filters',
        'PowDB',
        `relation "${rel.name}" uses a composite key — PowQL has no tuple-\`in\` to express it`,
      );
    }
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`[turbine] Relation "${rel.name}" targets unknown table "${rel.to}".`);
    // hasMany/hasOne: localKey = our referenceKey, collect the child's foreignKey.
    // belongsTo:      localKey = our foreignKey,   collect the target's referenceKey.
    const localCol = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
    const childCol = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
    const localField = this.meta.reverseColumnMap[localCol] ?? localCol;
    const childField = targetMeta.reverseColumnMap[childCol] ?? childCol;
    const targetQi = new PowqlInterface(this.pool, rel.to, this.schema, [], this.options);
    const collect = async (w: Record<string, unknown> | undefined): Promise<unknown[]> => {
      const rows = await targetQi.findMany({
        where: w as WhereClause<object> | undefined,
        select: { [childField]: true },
        timeout,
      } as unknown as FindManyArgs<object>);
      return [...new Set(rows.map((r) => (r as Record<string, unknown>)[childField]).filter((v) => v != null))];
    };
    if (mode === 'some') return { [localField]: { in: await collect(innerWhere) } };
    if (mode === 'none') return { [localField]: { notIn: await collect(innerWhere) } };
    // every: a parent qualifies unless it has a child FAILING the predicate.
    if (innerEmpty) return {}; // every:{} ⇒ trivially true for all parents
    return { [localField]: { notIn: await collect({ NOT: innerWhere }) } };
  }

  /** Resolve a manyToMany filter through the junction to `{ sourceRefField: { in|notIn: [...] } }`. */
  private async resolveManyToManyCondition(
    rel: RelationDef,
    mode: 'some' | 'none' | 'every',
    innerWhere: Record<string, unknown> | undefined,
    innerEmpty: boolean,
    timeout?: number,
  ): Promise<Record<string, unknown>> {
    const through = rel.through;
    if (!through)
      throw new ValidationError(`[turbine] manyToMany relation "${rel.name}" is missing its junction (\`through\`).`);
    const sourceJ = normalizeKeyColumns(through.sourceKey);
    const targetJ = normalizeKeyColumns(through.targetKey);
    const sourceRef = normalizeKeyColumns(rel.referenceKey);
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`[turbine] Relation "${rel.name}" targets unknown table "${rel.to}".`);
    if (sourceJ.length > 1 || targetJ.length > 1 || sourceRef.length > 1 || targetMeta.primaryKey.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key manyToMany filters',
        'PowDB',
        `relation "${rel.name}" — PowQL has no tuple-\`in\` for composite junction/target keys`,
      );
    }
    const sourceJCol = sourceJ[0]!;
    const targetJCol = targetJ[0]!;
    const sourceRefCol = sourceRef[0]!;
    const targetPkCol = targetMeta.primaryKey[0]!;
    const sourceRefField = this.meta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;
    const sourceRefColMeta = this.meta.columns.find((c) => c.name === sourceRefCol);
    const targetPkField = targetMeta.reverseColumnMap[targetPkCol] ?? targetPkCol;
    const targetQi = new PowqlInterface(this.pool, rel.to, this.schema, [], this.options);
    const collectTargetPks = async (w: Record<string, unknown> | undefined): Promise<unknown[]> => {
      const rows = await targetQi.findMany({
        where: w as WhereClause<object> | undefined,
        select: { [targetPkField]: true },
        timeout,
      } as unknown as FindManyArgs<object>);
      return [...new Set(rows.map((r) => (r as Record<string, unknown>)[targetPkField]).filter((v) => v != null))];
    };
    // Junction source keys linking any of `targetPks` (literal IN-list — never a subquery).
    const sourcesForTargets = async (targetPks: unknown[]): Promise<unknown[]> => {
      if (!targetPks.length) return [];
      const out = new Set<unknown>();
      for (let i = 0; i < targetPks.length; i += MAX_RELATION_KEYS) {
        const chunk = targetPks.slice(i, i + MAX_RELATION_KEYS);
        const params: unknown[] = [];
        const ph = chunk.map((v) => this.param(v, params)).join(', ');
        const { rows } = await this.exec(
          `${quotePowqlIdent(through.table)} filter .${targetJCol} in (${ph}) { .${sourceJCol} }`,
          params,
          timeout,
          'findMany',
        );
        for (const r of rows) {
          const v = r[sourceJCol];
          if (v != null) out.add(sourceRefColMeta ? coerceScalar(String(v), sourceRefColMeta.tsType) : v);
        }
      }
      return [...out];
    };
    if (mode === 'some') {
      return { [sourceRefField]: { in: await sourcesForTargets(await collectTargetPks(innerWhere)) } };
    }
    if (mode === 'none') {
      return { [sourceRefField]: { notIn: await sourcesForTargets(await collectTargetPks(innerWhere)) } };
    }
    // every: exclude parents that link a target FAILING the predicate.
    if (innerEmpty) return {}; // every:{} ⇒ trivially true
    const failing = await sourcesForTargets(await collectTargetPks({ NOT: innerWhere }));
    return { [sourceRefField]: { notIn: failing } };
  }

  // -------------------------------------------------------------------------
  // Projection / order
  // -------------------------------------------------------------------------

  /** Resolve the set of columns to project, honouring `select` / `omit`. */
  private projectedColumns(select?: Record<string, boolean>, omit?: Record<string, boolean>): string[] {
    let cols = this.meta.columns.map((c) => c.name);
    if (select && Object.keys(select).length) {
      const picked = new Set(
        Object.entries(select)
          .filter(([, v]) => v)
          .map(([k]) => this.column(k).name),
      );
      // Always keep the PK so reselect / relation stitching has a key to work with.
      for (const pk of this.meta.primaryKey) picked.add(pk);
      cols = cols.filter((c) => picked.has(c));
    }
    if (omit && Object.keys(omit).length) {
      const dropped = new Set(
        Object.entries(omit)
          .filter(([, v]) => v)
          .map(([k]) => this.column(k).name),
      );
      cols = cols.filter((c) => !dropped.has(c));
    }
    return cols;
  }

  /** `{ .c1, .c2, … }` projection clause. */
  private projection(cols: string[]): string {
    return `{ ${cols.map((c) => `.${c}`).join(', ')} }`;
  }

  /**
   * `order .c1 asc, .c2 desc` clause (empty string when no orderBy). Supports,
   * besides a plain direction:
   *   - {@link JsonPathOrderBy} on a json column (≥ 0.12): `{ data: { path: […],
   *     type?, direction? } }` → `order .data->$n asc` (or
   *     `cast(.data->$n, "float")` for `type: 'numeric'`);
   *   - {@link OrderBySpec} `{ sort, nulls }`: `nulls: 'last'` is accepted as a
   *     no-op (PowDB is always nulls-last), `nulls: 'first'` throws E017.
   *
   * PowDB orders missing / JSON-null keys LAST in BOTH directions (an engine
   * contract): for identical cross-engine results pass `nulls: 'last'`
   * explicitly on Postgres, which defaults nulls-first for `desc`.
   */
  private buildOrder(orderBy: OrderByClause | undefined, params: unknown[], alias?: string): string {
    if (!orderBy) return '';
    const keys = Object.entries(orderBy).filter(([, dir]) => dir !== undefined);
    if (!keys.length) return '';
    const parts = keys.map(([field, dir]) => {
      if (dir && typeof dir === 'object') {
        const o = dir as Record<string, unknown>;
        // JSON-path ordering on a json column.
        if (Array.isArray(o.path)) {
          return this.buildJsonPathOrder(field, dir as JsonPathOrderBy, params, alias);
        }
        // OrderBySpec { sort, nulls }: accept nulls-last (PowDB default), refuse
        // nulls-first (no placement grammar). Distinct from vector/pick/_count.
        if ('sort' in o && !('distance' in o) && !('_count' in o) && !isRelationPickOrderBy(dir)) {
          const spec = dir as OrderBySpec;
          if (spec.nulls === 'first') {
            throw new UnsupportedFeatureError(
              'NULLS FIRST placement',
              'PowDB',
              `field "${field}": PowDB orders NULLs / missing keys LAST in both directions`,
            );
          }
          return `${this.ref(field, alias)} ${spec.sort === 'desc' ? 'desc' : 'asc'}`;
        }
        // Name the actual feature in the refusal — a pick-row ordering
        // reported as "vector / distance ordering" sends users hunting for
        // pgvector docs. Everything else stays E017 on PowDB.
        const feature = isRelationPickOrderBy(dir)
          ? 'relation pick-row ordering'
          : 'distance' in o
            ? 'vector / distance ordering'
            : '_count' in o
              ? 'relation _count ordering'
              : 'nulls' in o
                ? 'NULLS placement / sort-spec ordering'
                : 'object-valued ordering';
        throw new UnsupportedFeatureError(feature, 'PowDB', `field "${field}"`);
      }
      return `${this.ref(field, alias)} ${dir === 'desc' ? 'desc' : 'asc'}`;
    });
    return ` order ${parts.join(', ')}`;
  }

  /** Compile one {@link JsonPathOrderBy} entry to `order .col->$n asc` (+ optional numeric cast). */
  private buildJsonPathOrder(field: string, spec: JsonPathOrderBy, params: unknown[], alias?: string): string {
    const col = this.column(field);
    if (!isJsonColumn(col)) {
      throw new UnsupportedFeatureError('JSON-path ordering', 'PowDB', `field "${field}" is not a json column`);
    }
    requireCapability(this.capabilities, 'jsonDocs', 'JSON path ordering');
    if (spec.nulls === 'first') {
      throw new UnsupportedFeatureError(
        'NULLS FIRST placement',
        'PowDB',
        `field "${field}": PowDB orders missing / JSON-null keys LAST in both directions`,
      );
    }
    const pathExpr = this.jsonPathExpr(col, spec.path, params, alias);
    // `type: 'numeric'` casts a JSON STRING number for numeric ordering; native
    // JSON numbers already order numerically without a cast.
    const expr = spec.type === 'numeric' ? `cast(${pathExpr}, "float")` : pathExpr;
    return `${expr} ${spec.direction === 'desc' ? 'desc' : 'asc'}`;
  }

  // -------------------------------------------------------------------------
  // Execution plumbing
  // -------------------------------------------------------------------------

  /**
   * Run PowQL with optional timeout, emitting a query event either way. The
   * `action` is passed PER CALL (never read from shared instance state) so the
   * retry-eligibility and the emitted event action stay correct even when a
   * concurrent operation runs on the same cached interface: a WRITE statement
   * carries a write action and can therefore never be mistaken for a replayable
   * read. Read statements pass a read-shaped action from {@link POWQL_READ_ACTIONS}.
   */
  private async exec(
    powql: string,
    params: unknown[],
    timeout?: number,
    action = 'raw',
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number; native: boolean }> {
    return this.execOnce(powql, params, timeout, action, false);
  }

  /** Build the E018 refusal for a write / `begin` on a read-only pool. */
  private readOnlyError(operation: string): ReadOnlyError {
    return new ReadOnlyError(
      `[turbine] ${operation} on "${this.table}" refused: this PowDB connection is read-only. ` +
        `Route writes to a writable primary (a pool opened without \`readonly: true\`).`,
    );
  }

  /**
   * Execute one statement, with the opt-in single stale-frame READ replay. When
   * `retryStaleReads` is on and a first-statement READ fails with the stale-wire
   * {@link isStaleFramePowdbError} ConnectionError (a socket idle-gap "received
   * unexpected frame" that the client cannot recover), the statement is retried
   * exactly once on a fresh pooled connection (the broken one was destroyed).
   * The replay is refused for writes (an ambiguous mutation reply is unsafe to
   * replay) and inside a transaction (a mid-tx statement cannot move connection),
   * so only the read-shaped actions in {@link POWQL_READ_ACTIONS}, outside a
   * `_txScoped` interface, are eligible. `action` is a per-call argument (never
   * `this`-state), so a concurrent op flipping instance fields cannot turn a
   * write into a retryable read.
   */
  private async execOnce(
    powql: string,
    params: unknown[],
    timeout: number | undefined,
    action: string,
    isRetry: boolean,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number; native: boolean }> {
    // Read-only pool guard: refuse a write action locally, before the wire, so a
    // read-only target never even attempts the mutation (the engine refusal, if
    // any, is only the backstop for raw/injected paths). `action` is per-call,
    // so a concurrent read is never mistaken for a write. Reads (incl. explain)
    // and non-classified `raw` fall through unchanged.
    if (this.pool.readonly === true && POWQL_WRITE_ACTIONS.has(action)) {
      throw this.readOnlyError(action);
    }
    const start = performance.now();
    const run = this.pool.query(powql, params) as Promise<{
      rows: Record<string, unknown>[];
      rowCount: number;
      native?: boolean;
    }>;
    try {
      const result = timeout
        ? await Promise.race([
            run,
            new Promise<never>((_, reject) => setTimeout(() => reject(new TimeoutError(timeout)), timeout)),
          ])
        : await run;
      this.emit(action, powql, params, performance.now() - start, result.rowCount ?? result.rows.length);
      // The pool tags each result with the wire that actually served it
      // (adaptResult → false, adaptNativeResult → true). A heterogeneous
      // injected pool can fall back to the legacy wire per call, so read the
      // per-result flag and only fall back to the pool-level capability when a
      // hand-built pool (tests) omits the tag; never coerce legacy rows with
      // the native policy just because the pool reports nativeRaw.
      const native = result.native ?? Boolean(this.capabilities.nativeRaw);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length, native };
    } catch (err) {
      if (!isRetry && this.shouldRetryStaleRead(err, action)) {
        // Transparent single replay on a fresh connection; the first (swallowed)
        // failure is not emitted, only the retried outcome is observed.
        return this.execOnce(powql, params, timeout, action, true);
      }
      this.emit(action, powql, params, performance.now() - start, 0, err as Error);
      throw err;
    }
  }

  /** Is `err` a replayable stale-frame failure for THIS (per-call) read-shaped, non-tx action? */
  private shouldRetryStaleRead(err: unknown, action: string): boolean {
    if (!this.pool.retryStaleReads) return false;
    if (this.isTxScoped()) return false;
    if (!POWQL_READ_ACTIONS.has(action)) return false;
    return isStaleFramePowdbError(err);
  }

  private emit(action: string, sql: string, params: unknown[], duration: number, rows: number, error?: Error): void {
    if (!this.onQuery) return;
    try {
      this.onQuery({
        sql,
        params,
        duration,
        model: this.table,
        action,
        rows,
        timestamp: new Date(),
        error,
      });
    } catch {
      /* listener errors never crash a query */
    }
  }

  /** Run a method body through the middleware chain (mirrors QueryInterface). */
  private async withMiddleware<R>(
    action: string,
    args: Record<string, unknown>,
    executor: () => Promise<R>,
  ): Promise<R> {
    if (this.middlewares.length === 0) return executor();
    let index = 0;
    const next = async (p: { model: string; action: string; args: Record<string, unknown> }): Promise<unknown> => {
      if (index < this.middlewares.length) return this.middlewares[index++]!(p, next);
      return executor();
    };
    return next({ model: this.table, action, args: { ...args } }) as Promise<R>;
  }

  /** Map raw rows to typed entities. `native` is the wire that ACTUALLY served
   * this result (threaded from {@link execOnce}, not the pool-level capability),
   * so cells that arrived pre-typed over `queryNativeRaw` (F3) skip the legacy
   * string coercion (a genuine str `"null"` stays `"null"` instead of collapsing
   * to null) while a per-call legacy fallback on a native-capable pool still
   * coerces its string cells correctly. Defaults to the pool capability for the
   * rare caller with no per-result flag (hand-built test pools). */
  private shape(rows: Record<string, unknown>[], native = Boolean(this.capabilities.nativeRaw)): T[] {
    return rows.map((r) => rowToEntity(r, this.meta, native) as T);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findMany(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T[]> {
    return this.withMiddleware('findMany', args as unknown as Record<string, unknown>, async () => {
      const { rows, native, resolvedWhere } = await this.runFind(args, 'findMany');
      const entities = this.shape(rows, native);
      if (args.with) {
        await this.loadRelations(entities, args.with as Record<string, unknown>, args.timeout, 0, {
          args,
          resolvedWhere,
        });
      }
      return entities;
    });
  }

  /**
   * Compile the flat findMany select into PowQL (no execution), pushing values
   * into `params`. Returns the query plus the RESOLVED where (relation filters
   * already collapsed to literal in-lists) so the F2 join path can re-emit the
   * exact parent predicate alias-qualified, and so {@link explain} can wrap it.
   */
  private async buildFind(
    args: FindManyArgs<T>,
    params: unknown[],
  ): Promise<{ powql: string; resolvedWhere: WhereClause<T> | undefined }> {
    if ((args as { cursor?: unknown }).cursor) {
      throw new UnsupportedFeatureError('cursor pagination', 'PowDB', 'use limit/offset instead');
    }
    const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
    const where = this.buildWhere(resolvedWhere, params);
    const cols = this.projectedColumns(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
    );
    const distinct = args.distinct?.length ? ' distinct' : '';
    const filter = where ? ` filter ${where}` : '';
    const order = this.buildOrder(args.orderBy, params);
    const limit = args.limit ?? (args as { take?: number }).take ?? this.defaultLimit;
    if (limit === undefined && this.warnOnUnlimited && !this.warnedUnlimited) {
      this.warnedUnlimited = true;
      console.warn(`[turbine] findMany on "${this.table}" has no limit: this scans the whole table.`);
    }
    const limitClause = limit !== undefined ? ` limit ${this.param(limit, params)}` : '';
    const offsetClause = args.offset ? ` offset ${this.param(args.offset, params)}` : '';
    const powql = `${this.qt}${distinct}${filter}${order}${limitClause}${offsetClause} ${this.projection(cols)}`;
    return { powql, resolvedWhere };
  }

  /** Build + run the flat findMany select; returns raw rows, the serving wire, and the resolved where. */
  private async runFind(
    args: FindManyArgs<T>,
    action = 'findMany',
  ): Promise<{ rows: Record<string, unknown>[]; native: boolean; resolvedWhere: WhereClause<T> | undefined }> {
    const params: unknown[] = [];
    const { powql, resolvedWhere } = await this.buildFind(args, params);
    const { rows, native } = await this.exec(powql, params, args.timeout, action);
    return { rows, native, resolvedWhere };
  }

  /**
   * Diagnostic surface: compile the same PowQL {@link findMany} would run for
   * `args` (no cache) and return the engine's plan as one string per line.
   *
   * Runs as a READ (`explain <query>`), so it is safe on a read-only pool and
   * eligible for the stale-read replay. The line content is engine-owned and is
   * NOT covered by semver — match plan node names / tree shape, never exact
   * bytes (mirrors PowDB's own `explain` contract).
   */
  async explain(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<string[]> {
    return this.withMiddleware('explain', args as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const { powql } = await this.buildFind(args, params);
      const { rows } = await this.exec(`explain ${powql}`, params, args.timeout, 'explain');
      return rows
        .map((r) => {
          const line = r.plan ?? Object.values(r)[0];
          return line == null ? '' : String(line);
        })
        .filter((line) => line.length > 0);
    });
  }

  async findUnique(args: FindUniqueArgs<T>): Promise<T | null> {
    return this.withMiddleware('findUnique', args as unknown as Record<string, unknown>, async () => {
      const { rows, native } = await this.runFind({ ...args, limit: 1 } as FindManyArgs<T>, 'findUnique');
      if (!rows.length) return null;
      const entities = this.shape(rows, native);
      if (args.with) await this.loadRelations(entities, args.with as Record<string, unknown>, args.timeout);
      return entities[0]!;
    });
  }

  async findFirst(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T | null> {
    return this.withMiddleware('findFirst', args as unknown as Record<string, unknown>, async () => {
      const { rows, native } = await this.runFind({ ...args, limit: 1 } as FindManyArgs<T>, 'findFirst');
      if (!rows.length) return null;
      const entities = this.shape(rows, native);
      if (args.with) await this.loadRelations(entities, args.with as Record<string, unknown>, args.timeout);
      return entities[0]!;
    });
  }

  async findUniqueOrThrow(args: FindUniqueArgs<T>): Promise<T> {
    const row = await this.findUnique(args);
    if (!row) throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
    return row;
  }

  async findFirstOrThrow(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T> {
    const row = await this.findFirst(args);
    if (!row) throw new NotFoundError({ table: this.table, where: (args.where ?? {}) as Record<string, unknown> });
    return row;
  }

  // -------------------------------------------------------------------------
  // Nested relations — batched N+1 loaders (hasMany / hasOne / belongsTo)
  // -------------------------------------------------------------------------

  /**
   * Load each requested relation for `parents` and attach it onto each row.
   *
   * `parent` is supplied ONLY by the top-level {@link findMany} (its args +
   * resolved where). When the effective `relationLoadStrategy` resolves to an
   * explicit `'join'` and the pool advertises `serverJoins`, an eligible
   * top-level relation is loaded with a native PowQL join instead of the keyed
   * loaders (F2); everything else — nested `with` levels, ineligible shapes, and
   * the default `'batched'` strategy — keeps the loaders. Output is byte-equal
   * either way (the join reuses the same stitch / shape helpers).
   */
  private async loadRelations(
    parents: T[],
    withClause: Record<string, unknown>,
    timeout?: number,
    depth = 0,
    parent?: PowqlParentContext<T>,
  ): Promise<void> {
    if (depth >= 10) {
      throw new ValidationError(`[turbine] Nested 'with' on PowDB exceeded depth 10 (relation cycle?).`);
    }
    if (!parents.length) return;
    const useJoins = this.joinsEnabled(parent);
    for (const [relName, opt] of Object.entries(withClause)) {
      if (!opt) continue;
      const rel = this.meta.relations[relName];
      if (!rel) throw new ValidationError(`[turbine] Unknown relation "${relName}" on "${this.table}".`);
      if (useJoins && parent && this.joinEligible(rel, opt, parent.args, parents.length)) {
        await this.loadRelationViaJoin(parents, rel, relName, opt, parent, timeout);
        continue;
      }
      if (rel.type === 'manyToMany') {
        await this.loadManyToMany(parents, rel, relName, opt, timeout);
        continue;
      }
      const fk = normalizeKeyColumns(rel.foreignKey);
      const rk = normalizeKeyColumns(rel.referenceKey);
      if (fk.length > 1 || rk.length > 1) {
        throw new UnsupportedFeatureError('composite-key nested reads', 'PowDB', `relation "${relName}"`);
      }
      const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: Record<string, unknown> };
      const targetQi = new PowqlInterface(this.pool, rel.to, this.schema, [], this.options);
      const targetMeta = this.schema.tables[rel.to]!;

      // Local key on the parent, remote key on the target child.
      const parentKeyCol = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
      const childKeyCol = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
      const parentKeyField = this.meta.reverseColumnMap[parentKeyCol] ?? parentKeyCol;
      const childKeyField = targetMeta.reverseColumnMap[childKeyCol] ?? childKeyCol;

      const keys = [
        ...new Set(parents.map((p) => (p as Record<string, unknown>)[parentKeyField]).filter((k) => k != null)),
      ];
      const childByKey = new Map<unknown, T[]>();
      // Chunk the key set so a single `in (…)` never exceeds PowDB's
      // per-statement param / row limits; merge each chunk's children.
      for (let i = 0; i < keys.length; i += MAX_RELATION_KEYS) {
        const chunk = keys.slice(i, i + MAX_RELATION_KEYS);
        const childWhere = {
          ...(options.where as Record<string, unknown> | undefined),
          [childKeyField]: { in: chunk },
        } as WhereClause<object>;
        const children = (await targetQi.findMany({
          ...options,
          where: childWhere,
          with: options.with,
          timeout: options.timeout ?? timeout,
        } as FindManyArgs<object>)) as T[];
        for (const child of children) {
          const k = (child as Record<string, unknown>)[childKeyField];
          const bucket = childByKey.get(k);
          if (bucket) bucket.push(child);
          else childByKey.set(k, [child]);
        }
      }
      const single = rel.type === 'belongsTo' || rel.type === 'hasOne';
      for (const parent of parents) {
        const k = (parent as Record<string, unknown>)[parentKeyField];
        const matches = childByKey.get(k) ?? [];
        (parent as Record<string, unknown>)[relName] = single ? (matches[0] ?? null) : matches;
      }
    }
  }

  /**
   * manyToMany nested read — a three-hop batched loader (no `json_agg`/join
   * pushdown): (1) read the junction rows for all parents in `sourceKey in (…)`
   * chunks, (2) read the target rows for the collected `targetKey`s, (3) stitch
   * each parent → its junction rows → its targets in memory. Mirrors the
   * single-key N+1 loaders; the junction's source/target columns must be single
   * (composite junction keys would need PowQL tuple-`in`, which it lacks).
   */
  private async loadManyToMany(
    parents: T[],
    rel: RelationDef,
    relName: string,
    opt: unknown,
    timeout?: number,
  ): Promise<void> {
    const through = rel.through;
    if (!through)
      throw new ValidationError(`[turbine] manyToMany relation "${relName}" is missing its junction (\`through\`).`);
    const sourceJ = normalizeKeyColumns(through.sourceKey);
    const targetJ = normalizeKeyColumns(through.targetKey);
    const sourceRef = normalizeKeyColumns(rel.referenceKey);
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`[turbine] Relation "${relName}" targets unknown table "${rel.to}".`);
    if (sourceJ.length > 1 || targetJ.length > 1 || sourceRef.length > 1 || targetMeta.primaryKey.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key manyToMany',
        'PowDB',
        `relation "${relName}" — PowQL has no tuple-\`in\`, so composite junction/target keys can't be loaded`,
      );
    }
    const sourceJCol = sourceJ[0]!;
    const targetJCol = targetJ[0]!;
    const sourceRefCol = sourceRef[0]!;
    const targetPkCol = targetMeta.primaryKey[0]!;
    const parentRefField = this.meta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;
    const targetPkField = targetMeta.reverseColumnMap[targetPkCol] ?? targetPkCol;
    const targetPkColMeta = targetMeta.columns.find((c) => c.name === targetPkCol);

    const parentKeys = [
      ...new Set(parents.map((p) => (p as Record<string, unknown>)[parentRefField]).filter((k) => k != null)),
    ];
    if (!parentKeys.length) {
      for (const parent of parents) (parent as Record<string, unknown>)[relName] = [];
      return;
    }

    // (1) Junction rows: sourceKeyVal(String) → [targetKeyVal(String)].
    const targetsBySource = new Map<string, string[]>();
    const allTargetVals = new Set<string>();
    for (let i = 0; i < parentKeys.length; i += MAX_RELATION_KEYS) {
      const chunk = parentKeys.slice(i, i + MAX_RELATION_KEYS);
      const params: unknown[] = [];
      const placeholders = chunk.map((v) => this.param(v, params)).join(', ');
      const powql = `${quotePowqlIdent(through.table)} filter .${sourceJCol} in (${placeholders}) { .${sourceJCol}, .${targetJCol} }`;
      const { rows } = await this.exec(powql, params, timeout, 'findMany');
      for (const row of rows) {
        const sv = String(row[sourceJCol]);
        const tv = String(row[targetJCol]);
        const bucket = targetsBySource.get(sv);
        if (bucket) bucket.push(tv);
        else targetsBySource.set(sv, [tv]);
        allTargetVals.add(tv);
      }
    }

    // (2) Target rows by PK, honouring the relation's own where/with/select/…
    const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: Record<string, unknown> };
    const targetQi = new PowqlInterface(this.pool, rel.to, this.schema, [], this.options);
    const targetByPk = new Map<string, T>();
    const targetValList = [...allTargetVals].map((v) =>
      targetPkColMeta ? coerceScalar(v, targetPkColMeta.tsType) : v,
    );
    for (let i = 0; i < targetValList.length; i += MAX_RELATION_KEYS) {
      const chunk = targetValList.slice(i, i + MAX_RELATION_KEYS);
      const where = {
        ...(options.where as Record<string, unknown> | undefined),
        [targetPkField]: { in: chunk },
      } as WhereClause<object>;
      const targets = (await targetQi.findMany({
        ...options,
        where,
        with: options.with,
        timeout: options.timeout ?? timeout,
      } as FindManyArgs<object>)) as T[];
      for (const t of targets) targetByPk.set(String((t as Record<string, unknown>)[targetPkField]), t);
    }

    // (3) Stitch: each parent → its junction targets (m2m is always a list).
    for (const parent of parents) {
      const sv = String((parent as Record<string, unknown>)[parentRefField]);
      const tvs = targetsBySource.get(sv) ?? [];
      const children: T[] = [];
      for (const tv of tvs) {
        const child = targetByPk.get(tv);
        if (child) children.push(child);
      }
      (parent as Record<string, unknown>)[relName] = children;
    }
  }

  // -------------------------------------------------------------------------
  // Nested relations — native PowQL joins (F2, opt-in via relationLoadStrategy)
  // -------------------------------------------------------------------------

  /**
   * Resolve the effective relation-load strategy: the per-query arg wins, then
   * the client config, then the PowDB default of `'batched'` (the keyed
   * loaders). PowDB deliberately does NOT inherit the SQL-side implicit `'join'`
   * default — that would silently flip every existing PowDB user onto brand-new
   * join generation. Only a value the user actually set to `'join'` activates it.
   */
  private resolveStrategy(args: FindManyArgs<T>): 'join' | 'batched' {
    const s = args.relationLoadStrategy ?? this.options.relationLoadStrategy ?? 'batched';
    return s === 'join' ? 'join' : 'batched';
  }

  /**
   * Decide whether the top-level relations of THIS query use native joins:
   * `true` only when the resolved strategy is an explicit `'join'` AND the pool
   * advertises `serverJoins`. When the strategy is `'join'` but `serverJoins` is
   * false the behavior splits by WHERE the `'join'` came from — a PER-QUERY
   * `relationLoadStrategy: 'join'` is an explicit request, so it throws a typed
   * E017 (via {@link requireCapability}); a CLIENT-LEVEL default silently falls
   * back to the keyed loaders (so pointing an existing app at an older engine
   * keeps working). Absent parent context (nested levels) never joins.
   */
  private joinsEnabled(parent?: PowqlParentContext<T>): boolean {
    if (!parent) return false;
    if (this.resolveStrategy(parent.args) !== 'join') return false;
    if (this.capabilities.serverJoins) return true;
    if (parent.args.relationLoadStrategy === 'join') {
      requireCapability(this.capabilities, 'serverJoins', 'native PowQL relation joins');
    }
    return false; // client-level default only → silent loader fallback
  }

  /**
   * Per-relation eligibility for the join path (checked after {@link joinsEnabled}).
   * Any `false` here is a SILENT fallback to the keyed loaders — never an error —
   * so an off-page or nested-`with` shape still returns correct rows:
   *   - the parent query must not be paged (`limit`/`offset`/`take`, including the
   *     configured `defaultLimit`): a parent-filter join under a page would scan
   *     children of off-page parents, where the loaders are strictly better;
   *   - the relation must not request a nested `with` (its subtree stays on the
   *     loaders this round) or a `distinct`;
   *   - single-column relation keys only (a composite key falls to the loader,
   *     which throws the same E017 as today);
   *   - m2m keeps any `orderBy`/`limit`/`offset` on the loader (the junction-order
   *     stitch can't be reproduced by the 3-table join deterministically);
   *   - a to-one relation `limit`/`offset` (meaningless) stays on the loader, as
   *     does a to-many relation `limit`/`offset` when the parent set spills past
   *     one loader chunk (the loader limits per chunk, the join once globally).
   */
  private joinEligible(rel: RelationDef, opt: unknown, args: FindManyArgs<T>, parentCount: number): boolean {
    const effLimit = args.limit ?? (args as { take?: number }).take ?? this.defaultLimit;
    if (effLimit !== undefined || args.offset) return false;
    const options = (opt === true ? {} : opt) as FindManyArgs<object> & { with?: unknown };
    if (options.with) return false;
    if (options.distinct?.length) return false;
    if (rel.type === 'manyToMany') {
      const through = rel.through;
      if (!through) return false;
      if (
        normalizeKeyColumns(through.sourceKey).length > 1 ||
        normalizeKeyColumns(through.targetKey).length > 1 ||
        normalizeKeyColumns(rel.referenceKey).length > 1 ||
        (this.schema.tables[rel.to]?.primaryKey.length ?? 2) > 1
      ) {
        return false;
      }
      if (options.orderBy || options.limit !== undefined || options.offset) return false;
      return true;
    }
    if (normalizeKeyColumns(rel.foreignKey).length > 1 || normalizeKeyColumns(rel.referenceKey).length > 1) {
      return false;
    }
    const single = rel.type === 'belongsTo' || rel.type === 'hasOne';
    if ((options.limit !== undefined || options.offset) && (single || parentCount > MAX_RELATION_KEYS)) {
      return false;
    }
    return true;
  }

  /** Dispatch one eligible relation to the correct native-join loader. */
  private async loadRelationViaJoin(
    parents: T[],
    rel: RelationDef,
    relName: string,
    opt: unknown,
    parent: PowqlParentContext<T>,
    timeout?: number,
  ): Promise<void> {
    if (rel.type === 'manyToMany') {
      await this.loadManyToManyViaJoin(parents, rel, relName, opt, parent, timeout);
      return;
    }
    const options = (opt === true ? {} : opt) as FindManyArgs<object>;
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`[turbine] Relation "${relName}" targets unknown table "${rel.to}".`);
    const targetQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.options);
    const fk = normalizeKeyColumns(rel.foreignKey);
    const rk = normalizeKeyColumns(rel.referenceKey);
    // Correlation math is identical to the keyed loaders — only the transport
    // (join vs in-list) changes. Always join the RELATION TARGET (alias `c`) to
    // the already-fetched side (alias `p`), correlating on the fetched side's key
    // and projecting `__tpk` from the fetched side's correlation column.
    const parentKeyCol = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
    const childKeyCol = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
    const parentKeyField = this.meta.reverseColumnMap[parentKeyCol] ?? parentKeyCol;

    const params: unknown[] = [];
    const childCols = this.joinChildCols(targetQi, options);
    const filter = await this.joinFilter(
      targetQi,
      parent.resolvedWhere,
      options.where,
      'c',
      params,
      options.timeout ?? timeout,
    );
    const order = targetQi.buildOrder(options.orderBy, params, 'c');
    const limitClause = options.limit !== undefined ? ` limit ${this.param(options.limit, params)}` : '';
    const offsetClause = options.offset ? ` offset ${this.param(options.offset, params)}` : '';
    const proj = this.joinProjection(childCols, `p.${quotePowqlIdent(parentKeyCol)}`, 'c');
    const powql =
      `${targetQi.qt} as c join ${this.qt} as p ` +
      `on c.${quotePowqlIdent(childKeyCol)} = p.${quotePowqlIdent(parentKeyCol)}` +
      `${filter}${order}${limitClause}${offsetClause} ${proj}`;
    // A READ — thread a read-shaped action through the exec seam.
    const { rows, native } = await targetQi.exec(powql, params, timeout, 'findMany');

    const single = rel.type === 'belongsTo' || rel.type === 'hasOne';
    const byKey = this.bucketByTpk(targetQi, rows, native);
    for (const p of parents) {
      const key = this.joinKey((p as Record<string, unknown>)[parentKeyField]);
      const matches = (key == null ? undefined : byKey.get(key)) ?? [];
      (p as Record<string, unknown>)[relName] = single ? (matches[0] ?? null) : matches;
    }
  }

  /**
   * manyToMany via chained joins: the target (alias `t`) → junction (alias `j`)
   * → the already-fetched side (alias `p`), correlating `__tpk` from the
   * junction's source key. Always a list, stitched exactly like the loader.
   */
  private async loadManyToManyViaJoin(
    parents: T[],
    rel: RelationDef,
    relName: string,
    opt: unknown,
    parent: PowqlParentContext<T>,
    timeout?: number,
  ): Promise<void> {
    const through = rel.through;
    if (!through)
      throw new ValidationError(`[turbine] manyToMany relation "${relName}" is missing its junction (\`through\`).`);
    const options = (opt === true ? {} : opt) as FindManyArgs<object>;
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`[turbine] Relation "${relName}" targets unknown table "${rel.to}".`);
    const targetQi = new PowqlInterface<object>(this.pool, rel.to, this.schema, [], this.options);
    const sourceJCol = normalizeKeyColumns(through.sourceKey)[0]!;
    const targetJCol = normalizeKeyColumns(through.targetKey)[0]!;
    const sourceRefCol = normalizeKeyColumns(rel.referenceKey)[0]!;
    const targetPkCol = targetMeta.primaryKey[0]!;
    const parentRefField = this.meta.reverseColumnMap[sourceRefCol] ?? sourceRefCol;

    const params: unknown[] = [];
    const childCols = this.joinChildCols(targetQi, options);
    const filter = await this.joinFilter(
      targetQi,
      parent.resolvedWhere,
      options.where,
      't',
      params,
      options.timeout ?? timeout,
    );
    const proj = this.joinProjection(childCols, `j.${quotePowqlIdent(sourceJCol)}`, 't');
    const powql =
      `${targetQi.qt} as t ` +
      `join ${quotePowqlIdent(through.table)} as j on t.${quotePowqlIdent(targetPkCol)} = j.${quotePowqlIdent(targetJCol)} ` +
      `join ${this.qt} as p on j.${quotePowqlIdent(sourceJCol)} = p.${quotePowqlIdent(sourceRefCol)}` +
      `${filter} ${proj}`;
    const { rows, native } = await targetQi.exec(powql, params, timeout, 'findMany');

    const byKey = this.bucketByTpk(targetQi, rows, native);
    for (const p of parents) {
      const key = this.joinKey((p as Record<string, unknown>)[parentRefField]);
      (p as Record<string, unknown>)[relName] = (key == null ? undefined : byKey.get(key)) ?? [];
    }
  }

  /**
   * The target column list to project through the join (honouring select/omit),
   * with a loud guard: a real column named `__tpk` would collide with the
   * reserved correlation alias, so refuse rather than silently mis-stitch.
   */
  private joinChildCols(targetQi: PowqlInterface<object>, options: FindManyArgs<object>): string[] {
    const cols = targetQi.projectedColumns(
      options.select as Record<string, boolean> | undefined,
      options.omit as Record<string, boolean> | undefined,
    );
    if (cols.includes('__tpk')) {
      throw new ValidationError(
        `[turbine] relation target "${targetQi.table}" has a column named "__tpk", which collides with the reserved ` +
          `join correlation alias. Rename the column or load this relation with relationLoadStrategy: 'batched'.`,
      );
    }
    return cols;
  }

  /**
   * `{ __tpk: <tpkExpr>, <col>: <childAlias>.<col>, … }`. Each child column is
   * ALIASED to its bare name (a bare qualified ref `c.col` would come back named
   * `c.col`, not `col`) so the stitched rows shape identically to a flat select.
   */
  private joinProjection(childCols: string[], tpkExpr: string, childAlias: string): string {
    const parts = [
      `__tpk: ${tpkExpr}`,
      ...childCols.map((c) => `${quotePowqlIdent(c)}: ${childAlias}.${quotePowqlIdent(c)}`),
    ];
    return `{ ${parts.join(', ')} }`;
  }

  /**
   * `filter <parentWhere qualified p> [and <relationWhere qualified childAlias>]`.
   * The parent where is the ALREADY-RESOLVED predicate (relation filters collapsed
   * to literal in-lists before the base query ran); the relation where is resolved
   * on the target the same way before qualifying, so a nested relation filter in
   * the relation `where` never reaches the join unresolved. Params bind in order.
   */
  private async joinFilter(
    targetQi: PowqlInterface<object>,
    parentResolvedWhere: WhereClause<T> | undefined,
    relWhere: WhereClause<object> | undefined,
    childAlias: string,
    params: unknown[],
    timeout?: number,
  ): Promise<string> {
    const parts: string[] = [];
    const pw = this.buildWhere(parentResolvedWhere, params, 'p');
    if (pw) parts.push(pw);
    const relResolved = await targetQi.resolveRelationFilters(relWhere, timeout);
    const rw = targetQi.buildWhere(relResolved, params, childAlias);
    if (rw) parts.push(rw);
    return parts.length ? ` filter ${parts.join(' and ')}` : '';
  }

  /** Group join rows by their (normalized) `__tpk`, stripping it and shaping each child. */
  private bucketByTpk(
    targetQi: PowqlInterface<object>,
    rows: Record<string, unknown>[],
    native: boolean,
  ): Map<string, object[]> {
    const byKey = new Map<string, object[]>();
    for (const raw of rows) {
      const tpk = this.joinKey(raw.__tpk);
      delete raw.__tpk;
      const child = targetQi.shape([raw], native)[0]!;
      if (tpk == null) continue;
      const bucket = byKey.get(tpk);
      if (bucket) bucket.push(child);
      else byKey.set(tpk, [child]);
    }
    return byKey;
  }

  /**
   * Normalize a correlation key to a stable string map key so a parent's key
   * value (a shaped entity field) and a child row's `__tpk` cell match across
   * wires (native int → bigint, legacy → string): both stringify identically.
   */
  private joinKey(v: unknown): string | null {
    if (v == null) return null;
    if (v instanceof Date) return String(v.getTime());
    return String(v);
  }

  // -------------------------------------------------------------------------
  // Writes (reselect — PowDB has no RETURNING)
  // -------------------------------------------------------------------------

  /** Split `data` into scalar assignments; reject relation (nested-write) keys. */
  private scalarData(data: Record<string, unknown>): { col: ColumnMetadata; value: unknown }[] {
    const out: { col: ColumnMetadata; value: unknown }[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (this.meta.relations[field]) {
        throw new UnsupportedFeatureError(
          'nested writes',
          'PowDB',
          `relation "${field}" — nested writes need create()/update(), not createMany()/upsert()`,
        );
      }
      out.push({ col: this.column(field), value });
    }
    return out;
  }

  /**
   * Fill in a client-generated UUID for a defaulted **string** PK that wasn't
   * supplied. A server-generated PK ({@link ColumnMetadata.isGenerated}, e.g. an
   * `int` column with PowDB's `auto` modifier) is left untouched — PowDB assigns
   * it and the trailing `returning` reads it back — as is any non-string PK.
   */
  private applyPkDefault(data: Record<string, unknown>): Record<string, unknown> {
    const out = { ...data };
    for (const pk of this.meta.primaryKey) {
      const field = this.meta.reverseColumnMap[pk] ?? pk;
      const col = this.meta.columns.find((c) => c.name === pk);
      if (
        out[field] == null &&
        col?.hasDefault &&
        !col.isGenerated &&
        col.tsType.replace(/\s*\|\s*null$/, '').trim() === 'string'
      ) {
        out[field] = randomUUID();
      }
    }
    return out;
  }

  /**
   * The table name as a PowQL type reference — backtick-quoted when it is a
   * reserved word (e.g. a table named `order`). Used in every emitted
   * statement; plain `this.table` stays in error messages.
   */
  private get qt(): string {
    return quotePowqlIdent(this.table);
  }

  async create(args: CreateArgs<T>): Promise<T> {
    return this.withMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.meta)) {
        return this.nestedCreate(args);
      }
      const data = this.applyPkDefault(args.data as Record<string, unknown>);
      const assigns = this.scalarData(data);
      const params: unknown[] = [];
      const body = assigns
        .map((a) => `${quotePowqlIdent(a.col.name)} := ${this.writeRef(a.value, a.col, params)}`)
        .join(', ');
      // `returning` surfaces the inserted row (all columns, schema order) in one round-trip.
      const { rows, native } = await this.exec(
        `insert ${this.qt} { ${body} } returning`,
        params,
        args.timeout,
        'create',
      );
      const row = rows.length ? this.shape(rows, native)[0]! : null;
      if (!row) throw new NotFoundError({ table: this.table, where: data });
      return row;
    });
  }

  async createMany(args: CreateManyArgs<T>): Promise<T[]> {
    return this.withMiddleware('createMany', args as unknown as Record<string, unknown>, async () => {
      const inputs = (args.data as Record<string, unknown>[]).map((d) => this.applyPkDefault(d));
      if (!inputs.length) return [];
      const params: unknown[] = [];
      const tuples = inputs.map((d) => {
        const assigns = this.scalarData(d);
        return `{ ${assigns.map((a) => `${quotePowqlIdent(a.col.name)} := ${this.writeRef(a.value, a.col, params)}`).join(', ')} }`;
      });
      // Multi-row insert with `returning` hands back every inserted row in one round-trip.
      const { rows, native } = await this.exec(
        `insert ${this.qt} ${tuples.join(', ')} returning`,
        params,
        args.timeout,
        'createMany',
      );
      return this.shape(rows, native);
    });
  }

  async update(args: UpdateArgs<T>): Promise<T> {
    return this.withMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      if (hasRelationFields(args.data as Record<string, unknown>, this.meta)) {
        return this.nestedUpdate(args);
      }
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
      const where = this.buildWhere(resolvedWhere, params);
      this.assertCompiledWhere(where, false, 'update');
      const setClause = this.buildUpdateAssignments(args.data as Record<string, unknown>, params);
      // `returning` hands back the post-update row(s); take the first (single-row contract).
      const { rows, native } = await this.exec(
        `${this.qt} filter ${where} update { ${setClause} } returning`,
        params,
        args.timeout,
        'update',
      );
      const row = rows.length ? this.shape(rows, native)[0]! : null;
      if (!row) throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
      return row;
    });
  }

  async updateMany(args: UpdateManyArgs<T>): Promise<{ count: number }> {
    return this.withMiddleware('updateMany', args as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
      const where = this.buildWhere(resolvedWhere, params);
      this.assertCompiledWhere(where, args.allowFullTableScan, 'updateMany');
      const setClause = this.buildUpdateAssignments(args.data as Record<string, unknown>, params);
      const filter = where ? ` filter ${where}` : '';
      const { rowCount } = await this.exec(
        `${this.qt}${filter} update { ${setClause} }`,
        params,
        args.timeout,
        'updateMany',
      );
      return { count: rowCount };
    });
  }

  /** Compile `data` into PowQL update assignments, including atomic operators. */
  private buildUpdateAssignments(data: Record<string, unknown>, params: unknown[]): string {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (this.meta.relations[field]) {
        throw new UnsupportedFeatureError(
          'nested writes',
          'PowDB',
          `relation "${field}" — nested writes need create()/update(), not updateMany()/upsert()`,
        );
      }
      const colMeta = this.column(field);
      const ref = this.ref(field);
      const col = quotePowqlIdent(colMeta.name);
      if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
        const opObj = value as Record<string, unknown>;
        if ('set' in opObj) parts.push(`${col} := ${this.writeRef(opObj.set, colMeta, params)}`);
        else if ('increment' in opObj)
          parts.push(`${col} := ${ref} + ${this.writeRef(opObj.increment, colMeta, params)}`);
        else if ('decrement' in opObj)
          parts.push(`${col} := ${ref} - ${this.writeRef(opObj.decrement, colMeta, params)}`);
        else if ('multiply' in opObj)
          parts.push(`${col} := ${ref} * ${this.writeRef(opObj.multiply, colMeta, params)}`);
        else if ('divide' in opObj) parts.push(`${col} := ${ref} / ${this.writeRef(opObj.divide, colMeta, params)}`);
        else throw new ValidationError(`[turbine] Unsupported update operator on "${field}".`);
      } else {
        parts.push(`${col} := ${this.writeRef(value, colMeta, params)}`);
      }
    }
    if (!parts.length) throw new ValidationError(`[turbine] update on "${this.table}" has no fields to set.`);
    return parts.join(', ');
  }

  // -------------------------------------------------------------------------
  // Nested writes — create/update whose `data` carries relation ops (create,
  // connect, connectOrCreate, disconnect, set, delete, update, upsert). Reuses
  // the engine-agnostic nested-write engine (it only needs ctx.schema + the
  // table accessors PowqlInterface already provides). Runs as ONE flat top-level
  // PowDB transaction — single global write lock, no savepoints, so the whole
  // tree commits or rolls back together (mirrors the SQL path's coverage:
  // hasMany / hasOne / belongsTo; manyToMany nested writes are not handled by
  // the shared engine on any backend).
  // -------------------------------------------------------------------------

  private isTxScoped(): boolean {
    return (this.options as { _txScoped?: boolean })._txScoped === true;
  }

  private async nestedCreate(args: CreateArgs<T>): Promise<T> {
    const data = args.data as Record<string, unknown>;
    if (this.isTxScoped()) {
      return executeNestedCreate(this.buildNestedCtx(), this.table, data) as Promise<T>;
    }
    return this.runInImplicitTx((ctx) => executeNestedCreate(ctx, this.table, data)) as Promise<T>;
  }

  private async nestedUpdate(args: UpdateArgs<T>): Promise<T> {
    const data = args.data as Record<string, unknown>;
    const where = args.where as Record<string, unknown>;
    if (this.isTxScoped()) {
      return executeNestedUpdate(this.buildNestedCtx(), this.table, where, data) as Promise<T>;
    }
    return this.runInImplicitTx((ctx) => executeNestedUpdate(ctx, this.table, where, data)) as Promise<T>;
  }

  /** Open a flat PowDB transaction on a pinned connection and run `fn` inside it. */
  private async runInImplicitTx<R>(fn: (ctx: NestedWriteContext) => Promise<R>): Promise<R> {
    // A transaction-control `begin` is a write on a read-only pool: refuse it
    // locally before checking out a connection (zero wire / pool activity), the
    // same guard the exec seam applies to plain writes.
    if (this.pool.readonly === true) throw this.readOnlyError('transaction (begin)');
    // Route tx keywords through the dialect (like the SQL path) so this never
    // drifts from `powdbDialect`; falls back to the literal lowercase keywords.
    const d = this.options.dialect;
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query(d?.beginStatement?.() ?? 'begin');
      began = true;
      const { TransactionClient } = await import('./client.js');
      const tx = new TransactionClient(
        client as unknown as never,
        this.schema,
        this.middlewares as unknown as never,
        this.options,
      );
      const ctx: NestedWriteContext = { schema: this.schema, tx: tx as unknown as NestedWriteContext['tx'] };
      // Plant the single-writer re-entrancy marker for the implicit tx's
      // subtree (same seam TurbineClient.$transaction uses) — user code that
      // fires db.$transaction from inside (e.g. $use middleware around a
      // nested-write child op) must fast-fail E017, not queue into deadlock.
      const wrap = (client as { wrapTransactionCallback?: <T>(f: () => Promise<T>) => Promise<T> })
        .wrapTransactionCallback;
      const result = await (wrap ? wrap(() => fn(ctx)) : fn(ctx));
      await client.query(d?.commitStatement?.() ?? 'commit');
      return result;
    } catch (err) {
      // Only roll back a transaction we actually opened — a failed BEGIN
      // (queue timeout, re-entrancy E017) must not emit a stray ROLLBACK that
      // could land inside another transaction on a shared engine handle.
      if (began) {
        try {
          await client.query(d?.rollbackStatement?.() ?? 'rollback');
        } catch {
          /* best-effort — the connection may be gone */
        }
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /** Already inside a transaction: build a context whose table accessors reuse the pinned pool. */
  private buildNestedCtx(): NestedWriteContext {
    const opts = { ...this.options, _txScoped: true } as QueryInterfaceOptions;
    const tx = {
      table: <U extends object>(name: string) =>
        new PowqlInterface<U>(this.pool, name, this.schema, this.middlewares, opts),
    };
    return { schema: this.schema, tx: tx as unknown as NestedWriteContext['tx'] };
  }

  async delete(args: DeleteArgs<T>): Promise<T> {
    return this.withMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
      const where = this.buildWhere(resolvedWhere, params);
      this.assertCompiledWhere(where, false, 'delete');
      // `returning` hands back the deleted row(s) — no separate pre-image reselect needed.
      const { rows, native } = await this.exec(
        `${this.qt} filter ${where} delete returning`,
        params,
        args.timeout,
        'delete',
      );
      const row = rows.length ? this.shape(rows, native)[0]! : null;
      if (!row) throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
      return row;
    });
  }

  async deleteMany(args: DeleteManyArgs<T>): Promise<{ count: number }> {
    return this.withMiddleware('deleteMany', args as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
      const where = this.buildWhere(resolvedWhere, params);
      this.assertCompiledWhere(where, args.allowFullTableScan, 'deleteMany');
      const filter = where ? ` filter ${where}` : '';
      const { rowCount } = await this.exec(`${this.qt}${filter} delete`, params, args.timeout, 'deleteMany');
      return { count: rowCount };
    });
  }

  async upsert(args: UpsertArgs<T>): Promise<T> {
    return this.withMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      const createData = this.applyPkDefault(args.create as Record<string, unknown>);
      const pkCol = this.meta.primaryKey[0];
      if (this.meta.primaryKey.length !== 1 || !pkCol) {
        // PowQL's native `upsert … on .col` takes a single conflict column, so a
        // composite PK falls back to an atomic reselect-or-write transaction.
        return this.upsertComposite(createData, args.update as Record<string, unknown>);
      }
      const params: unknown[] = [];
      const createBody = this.scalarData(createData)
        .map((a) => `${quotePowqlIdent(a.col.name)} := ${this.writeRef(a.value, a.col, params)}`)
        .join(', ');
      const updateBody = this.buildUpdateAssignments(args.update as Record<string, unknown>, params);
      // PowDB 0.7.0's `upsert` statement does NOT accept a trailing `returning`
      // (verified: "unexpected trailing token … 'returning'"), because it is one
      // atomic insert-or-update, not two branches. So upsert alone keeps the
      // reselect-by-PK fetch; create/update/delete all use `returning`.
      await this.exec(
        `upsert ${this.qt} on .${pkCol} { ${createBody} } on conflict { ${updateBody} }`,
        params,
        args.timeout,
        'upsert',
      );
      const pkField = this.meta.reverseColumnMap[pkCol] ?? pkCol;
      const row = await this.reselectByPk(createData[pkField], args.timeout);
      if (!row) throw new NotFoundError({ table: this.table, where: createData });
      return row;
    });
  }

  /**
   * Composite-key upsert: PowQL's `upsert … on .col` only takes one conflict
   * column, so reselect by the full composite PK and update-or-create inside one
   * flat transaction (PowDB single-writer makes the read-then-write safe from
   * concurrent writers; the transaction makes it atomic with the write).
   */
  private async upsertComposite(createData: Record<string, unknown>, updateData: Record<string, unknown>): Promise<T> {
    // Accept either the camelCase field or the snake_case column in `create`
    // (create() resolves both), and key the where by field name.
    const pkPairs = this.meta.primaryKey.map((pk) => {
      const field = this.meta.reverseColumnMap[pk] ?? pk;
      return { field, value: createData[field] ?? createData[pk] };
    });
    if (pkPairs.some((p) => p.value == null)) {
      throw new ValidationError(
        `[turbine] upsert on "${this.table}" needs every composite-PK field in \`create\` (${pkPairs
          .map((p) => p.field)
          .join(', ')}).`,
      );
    }
    const pkWhere = Object.fromEntries(pkPairs.map((p) => [p.field, p.value]));
    const run = async (ctx: NestedWriteContext): Promise<T> => {
      const tbl = ctx.tx.table<T>(this.table);
      const existing = await tbl.findUnique({ where: pkWhere });
      return existing
        ? ((await tbl.update({ where: pkWhere, data: updateData })) as T)
        : ((await tbl.create({ data: createData as Partial<T> })) as T);
    };
    return this.isTxScoped() ? run(this.buildNestedCtx()) : this.runInImplicitTx(run);
  }

  // -------------------------------------------------------------------------
  // Aggregates
  // -------------------------------------------------------------------------

  async count(args: CountArgs<T> = {}): Promise<number> {
    return this.withMiddleware('count', (args ?? {}) as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
      const where = this.buildWhere(resolvedWhere, params);
      const filter = where ? ` filter ${where}` : '';
      const { rows } = await this.exec(`count(${this.qt}${filter})`, params, args.timeout, 'count');
      return Number((rows[0]?.value ?? rows[0]?.count ?? 0) as string | number);
    });
  }

  async aggregate(args: AggregateArgs<T>): Promise<AggregateResult<T>> {
    return this.withMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      // One scalar query per aggregate — PowDB's bare-projection aggregate is broken.
      const result: AggregateResult<T> = {};
      const filterParams: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
      const where = this.buildWhere(resolvedWhere, filterParams);
      const filter = where ? ` filter ${where}` : '';
      const scalar = async (expr: string): Promise<number | null> => {
        const params = [...filterParams];
        const { rows } = await this.exec(expr, params, args.timeout, 'aggregate');
        const v = rows[0]?.value;
        return v == null || v === 'null' ? null : Number(v);
      };
      if (args._count) {
        if (args._count === true) {
          result._count = (await scalar(`count(${this.qt}${filter})`)) ?? 0;
        } else {
          const counts: Record<string, number> = {};
          for (const field of Object.keys(args._count).filter((f) => (args._count as Record<string, boolean>)[f])) {
            counts[field] = (await scalar(`count(${this.qt}${filter} { ${this.ref(field)} })`)) ?? 0;
          }
          result._count = counts;
        }
      }
      for (const fn of ['_sum', '_avg', '_min', '_max'] as const) {
        const spec = args[fn];
        if (!spec) continue;
        const acc: Record<string, number | null> = {};
        for (const field of Object.keys(spec).filter((f) => (spec as Record<string, boolean>)[f])) {
          const powfn = fn.slice(1); // sum/avg/min/max
          acc[field] = await scalar(`${powfn}(${this.qt}${filter} { ${this.ref(field)} })`);
        }
        (result as Record<string, unknown>)[fn] = acc;
      }
      return result;
    });
  }

  async groupBy(args: GroupByArgs<T>): Promise<Record<string, unknown>[]> {
    return this.withMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      // DISTINCT ON has no PowQL equivalent (no DISTINCT ON row source).
      if (args.distinctOn) {
        throw new UnsupportedFeatureError('groupBy distinctOn row source', 'PowDB');
      }
      // JSON-path group keys / aggregate targets (≥ 0.12) are gated once here.
      const usesJson =
        args.by.some((e) => typeof e !== 'string') ||
        (['_sum', '_avg', '_min', '_max'] as const).some((fn) => {
          const spec = args[fn];
          return spec !== undefined && Object.values(spec).some((v) => v != null && typeof v === 'object');
        });
      if (usesJson) {
        requireCapability(this.capabilities, 'jsonDocs', 'JSON-path groupBy keys / aggregate targets');
      }

      // `emitNative` decides whether the query GENERATION needs the legacy-wire
      // `json_type` discriminator (pool-level capability). The DECODE side reads
      // the wire that ACTUALLY served the result (`resultNative`, from exec), so
      // a per-call legacy fallback on a native-capable pool still decodes right.
      const emitNative = Boolean(this.capabilities.nativeRaw);
      const params: unknown[] = [];
      const resolvedWhere = await this.resolveRelationFilters(args.where, args.timeout);
      const where = this.buildWhere(resolvedWhere, params);
      const filter = where ? ` filter ${where}` : '';

      // Result-key namespace, mirroring the SQL builder's `claimResultKey`
      // (query/builder.ts): a group-key / aggregate output-name collision (with
      // `_count`, another key, or an aggregate output) throws E003.
      const usedKeys = new Set<string>();
      const claim = (key: string, what: string): void => {
        if (key === '_count' || usedKeys.has(key)) {
          throw new ValidationError(
            `[turbine] groupBy output name "${key}" (${what}) collides with another output column on table ` +
              `"${this.table}": set an explicit \`alias\` (or rename the aggregate key) to disambiguate.`,
          );
        }
        usedKeys.add(key);
      };

      // Group keys + projection. `byReaders` drives the transform: a plain column
      // coerces by tsType; a JSON key reads its `gk_N` alias, disambiguating the
      // legacy-wire `null` / string-`"null"` group via its `gt_N` discriminator.
      type ByReader =
        | { kind: 'plain'; resultKey: string; rowKey: string; col: ColumnMetadata }
        | { kind: 'json'; resultKey: string; rowKey: string; discrim?: string };
      const groupExprs: string[] = [];
      const proj: string[] = [];
      const byOrderExprs = new Map<string, string>();
      const byReaders: ByReader[] = [];
      let gkN = 0;
      let gtN = 0;
      for (const entry of args.by as ((keyof T & string) | JsonPathGroupKey)[]) {
        if (typeof entry === 'string') {
          const col = this.column(entry);
          claim(entry, `column "${col.name}"`);
          if (col.name !== entry) claim(col.name, `column "${col.name}"`);
          groupExprs.push(`.${col.name}`);
          proj.push(`.${col.name}`);
          byOrderExprs.set(entry, `.${col.name}`);
          byReaders.push({ kind: 'plain', resultKey: entry, rowKey: col.name, col });
        } else {
          const col = this.column(entry.field);
          if (!isJsonColumn(col)) {
            throw new ValidationError(
              `[turbine] groupBy JSON group key on "${entry.field}" (table "${this.table}") requires a json column.`,
            );
          }
          this.assertJsonPath('group key', entry.field, entry.path);
          const pathExpr = this.jsonPathExpr(col, entry.path, params);
          const alias = entry.alias ?? String(entry.path[entry.path.length - 1]);
          claim(alias, `JSON path on "${entry.field}"`);
          const gkAlias = `gk_${gkN++}`;
          groupExprs.push(pathExpr);
          proj.push(`${gkAlias}: ${pathExpr}`);
          byOrderExprs.set(alias, `.${gkAlias}`);
          let discrim: string | undefined;
          if (!emitNative) {
            // Legacy wire renders a missing value, JSON null, AND the string
            // "null" all as the cell "null". `min(json_type(path))` over the
            // group is "string" ONLY for the string-"null" group and "null"
            // otherwise (a bare `json_type` projection is not group-correlated).
            discrim = `gt_${gtN++}`;
            proj.push(`${discrim}: min(json_type(${pathExpr}))`);
          }
          byReaders.push({ kind: 'json', resultKey: alias, rowKey: gkAlias, discrim });
        }
      }

      // Aggregates: `agg_N` internal aliases (PowQL rejects reserved-word
      // aliases like `count:`). `aggInner` lets HAVING re-emit the exact inner
      // expression by user key; `aggOrderExprs` lets orderBy reference the alias.
      const aggReaders: { alias: string; outKey: string; numeric: boolean }[] = [];
      const aggOrderExprs = new Map<string, string>();
      const aggInner = new Map<string, string>();
      let aggN = 0;
      // Parity with the SQL builder (query/builder.ts): `_count` is selected by
      // DEFAULT unless the caller explicitly opts out with `_count: false`, so
      // every groupBy row carries `_count` and `orderBy: { _count }` works
      // without requesting it (the alias is seeded into `aggOrderExprs`).
      const countSelected = args._count === true || args._count === undefined;
      if (countSelected) {
        const alias = `agg_${aggN++}`;
        proj.push(`${alias}: count(*)`);
        aggReaders.push({ alias, outKey: '_count', numeric: true });
        aggOrderExprs.set('_count', `.${alias}`);
      }
      for (const fn of ['_sum', '_avg', '_min', '_max'] as const) {
        const spec = args[fn] as Record<string, boolean | JsonPathAggregateTarget | undefined> | undefined;
        if (!spec) continue;
        const powfn = fn.slice(1); // sum/avg/min/max
        for (const [key, target] of Object.entries(spec)) {
          if (!target) continue;
          const alias = `agg_${aggN++}`;
          if (target === true) {
            const col = this.column(key);
            claim(`${fn}_${col.name}`, `${fn} of column "${col.name}"`);
            const inner = `.${col.name}`;
            proj.push(`${alias}: ${powfn}(${inner})`);
            aggReaders.push({ alias, outKey: `${fn}:${key}`, numeric: true });
            aggOrderExprs.set(`${fn}:${key}`, `.${alias}`);
            aggInner.set(key, inner);
          } else {
            const col = this.column(target.field);
            if (!isJsonColumn(col)) {
              throw new ValidationError(
                `[turbine] groupBy ${fn} target "${key}" on "${target.field}" (table "${this.table}") requires a json column.`,
              );
            }
            this.assertJsonPath(`${fn} target "${key}"`, target.field, target.path);
            const alwaysNumeric = fn === '_sum' || fn === '_avg';
            if (alwaysNumeric && target.type === 'text') {
              throw new ValidationError(
                `[turbine] groupBy ${fn} target "${key}" on table "${this.table}": ` +
                  `${fn} over a JSON path is always numeric: remove \`type: 'text'\`.`,
              );
            }
            const numeric = alwaysNumeric || target.type === 'numeric';
            claim(`${fn}_${key}`, `${fn} JSON target "${key}"`);
            const pathExpr = this.jsonPathExpr(col, target.path, params);
            const inner = numeric ? `cast(${pathExpr}, "float")` : pathExpr;
            proj.push(`${alias}: ${powfn}(${inner})`);
            aggReaders.push({ alias, outKey: `${fn}:${key}`, numeric });
            aggOrderExprs.set(`${fn}:${key}`, `.${alias}`);
            aggInner.set(key, inner);
          }
        }
      }

      const having = this.buildHaving(args.having, params, aggInner);
      const order = this.buildGroupOrder(args.orderBy, byOrderExprs, aggOrderExprs);
      const powql = `${this.qt}${filter} group ${groupExprs.join(', ')}${having}${order} { ${proj.join(', ')} }`;
      const { rows, native: resultNative } = await this.exec(powql, params, args.timeout, 'groupBy');

      // Reshape: group keys → user fields (coerced / null-disambiguated),
      // aggregates → nested `{ _sum: { field } }`; discriminators are stripped.
      // Group-key cells go through the SAME coercion policy `rowToEntity` uses,
      // by the wire that actually served this result, so a native-wire int cell
      // (bigint) or datetime cell (micros) never leaks into the result: it
      // becomes the same number / Date / PG-text-parity string an embedded /
      // legacy / SQL groupBy returns for the identical query.
      return rows.map((raw) => {
        const out: Record<string, unknown> = {};
        for (const r of byReaders) {
          if (r.kind === 'plain') {
            const cell = raw[r.rowKey];
            out[r.resultKey] = resultNative
              ? coerceNativeValue(cell, r.col)
              : typeof cell === 'string'
                ? coerceScalar(cell, r.col.tsType)
                : cell;
          } else {
            out[r.resultKey] = decodeGroupKeyCell(raw[r.rowKey], r.discrim ? raw[r.discrim] : undefined, resultNative);
          }
        }
        for (const a of aggReaders) {
          const cell = raw[a.alias];
          const v = cell == null || cell === 'null' ? null : a.numeric ? Number(cell) : cell;
          if (a.outKey === '_count') out._count = (v as number) ?? 0;
          else {
            const [bucket, field] = a.outKey.split(':') as [string, string];
            out[bucket] ??= {} as Record<string, unknown>;
            (out[bucket] as Record<string, unknown>)[field] = v;
          }
        }
        return out;
      });
    });
  }

  /** Validate a JSON-path target (group key / aggregate target): non-empty array of keys/indexes. */
  private assertJsonPath(context: string, field: string, path: (string | number)[]): void {
    if (
      !Array.isArray(path) ||
      path.length === 0 ||
      path.some((el) => typeof el !== 'string' && !(typeof el === 'number' && Number.isFinite(el)))
    ) {
      throw new ValidationError(
        `[turbine] groupBy ${context} on "${field}" (table "${this.table}") requires a non-empty \`path\` ` +
          `array of keys/indexes (e.g. { field: '${field}', path: ['category'] }).`,
      );
    }
  }

  /**
   * `having <expr>` over group aggregates. `_count` compares `count(*)` (parity
   * with the projection); a per-field aggregate re-emits its inner expression
   * (from `aggInner` when the field is a requested aggregate, so a JSON-path
   * aggregate reuses its bound placeholders, else `.field` for a plain column).
   */
  private buildHaving(having: GroupByArgs<T>['having'], params: unknown[], aggInner: Map<string, string>): string {
    if (!having) return '';
    const conds: string[] = [];
    const cmp = (expr: string, filter: unknown) => {
      if (typeof filter === 'number') return `${expr} = ${this.param(filter, params)}`;
      const f = filter as Record<string, number>;
      const ops: Record<string, string> = { equals: '=', gt: '>', gte: '>=', lt: '<', lte: '<=', not: '!=' };
      return Object.entries(f)
        .filter(([k]) => ops[k])
        .map(([k, v]) => `${expr} ${ops[k]} ${this.param(v, params)}`)
        .join(' and ');
    };
    for (const [key, spec] of Object.entries(having)) {
      if (spec == null) continue;
      if (key === '_count') {
        conds.push(cmp('count(*)', spec));
      } else {
        for (const [fn, filter] of Object.entries(spec as Record<string, unknown>)) {
          if (filter == null) continue;
          const inner = aggInner.get(key) ?? this.ref(key);
          conds.push(cmp(`${fn.slice(1)}(${inner})`, filter));
        }
      }
    }
    return conds.length ? ` having ${conds.join(' and ')}` : '';
  }

  /**
   * Compile a groupBy `orderBy` into a PowQL `order` body over the group RESULT
   * columns (by-fields, JSON group-key aliases, and requested aggregates). PowQL
   * cannot re-emit an aggregate EXPRESSION in `order` (engine error), but CAN
   * order by a projection alias on a grouped query (probed), so each key maps to
   * its projected alias (`.agg_N` / `.gk_N` / `.col`). Semantics and error
   * surface mirror the SQL `buildGroupByOrderBy` (0.32.2 R3-1): an aggregate not
   * requested in this call, or an unknown by-key, throws E003 listing the valid
   * keys. `nulls: 'first'` stays E017 (PowDB has no NULLS placement grammar).
   */
  private buildGroupOrder(
    orderBy: GroupByOrderBy | undefined,
    byOrderExprs: Map<string, string>,
    aggOrderExprs: Map<string, string>,
  ): string {
    if (!orderBy) return '';
    const aggBlocks = new Set(['_count', '_sum', '_avg', '_min', '_max']);
    const validKeys = (): string => {
      const keys = [...byOrderExprs.keys()];
      for (const k of aggOrderExprs.keys()) keys.push(k.includes(':') ? k.replace(':', '.') : k);
      return keys.join(', ') || '(none)';
    };
    const parts: string[] = [];
    for (const [key, value] of Object.entries(orderBy)) {
      if (value === undefined) continue;
      if (aggBlocks.has(key)) {
        if (key === '_count') {
          const expr = aggOrderExprs.get('_count');
          if (!expr) {
            throw new ValidationError(
              `[turbine] Cannot order groupBy by "_count" on table "${this.table}": _count is not selected. ` +
                `Orderable keys: ${validKeys()}.`,
            );
          }
          parts.push(`${expr} ${this.groupOrderDir(value, '_count')}`);
          continue;
        }
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          throw new ValidationError(
            `[turbine] Invalid groupBy orderBy for "${key}" on table "${this.table}": ` +
              `expected a field map like { ${key}: { amount: 'desc' } }.`,
          );
        }
        for (const [field, dirSpec] of Object.entries(value as Record<string, unknown>)) {
          if (dirSpec === undefined) continue;
          const expr = aggOrderExprs.get(`${key}:${field}`);
          if (!expr) {
            throw new ValidationError(
              `[turbine] Cannot order groupBy by "${key}.${field}" on table "${this.table}": ` +
                `that aggregate is not requested in this call. Orderable keys: ${validKeys()}.`,
            );
          }
          parts.push(`${expr} ${this.groupOrderDir(dirSpec, `${key}.${field}`)}`);
        }
        continue;
      }
      const expr = byOrderExprs.get(key);
      if (!expr) {
        throw new ValidationError(
          `[turbine] Unknown field "${key}" in groupBy orderBy on table "${this.table}". Orderable keys: ${validKeys()}.`,
        );
      }
      parts.push(`${expr} ${this.groupOrderDir(value, key)}`);
    }
    return parts.length ? ` order ${parts.join(', ')}` : '';
  }

  /** Resolve a groupBy order direction, refusing `nulls: 'first'` (E017); `nulls: 'last'` is a no-op. */
  private groupOrderDir(value: unknown, keyForMsg: string): string {
    if (value !== null && typeof value === 'object') {
      const spec = value as OrderBySpec;
      if (spec.nulls === 'first') {
        throw new UnsupportedFeatureError(
          'NULLS FIRST placement',
          'PowDB',
          `groupBy orderBy "${keyForMsg}": PowDB orders NULLs / missing keys LAST in both directions`,
        );
      }
      return spec.sort === 'desc' ? 'desc' : 'asc';
    }
    return value === 'desc' ? 'desc' : 'asc';
  }

  // -------------------------------------------------------------------------
  // Streaming / unsupported
  // -------------------------------------------------------------------------

  // biome-ignore lint/correctness/useYield: intentionally throws before yielding — PowDB has no server cursor.
  async *findManyStream(): AsyncGenerator<T> {
    throw new UnsupportedFeatureError(
      'cursor streaming (findManyStream)',
      'PowDB',
      'PowDB has no server-side cursor; page with findMany({ limit, offset }) instead',
    );
  }

  // -------------------------------------------------------------------------
  // Reselect helper (upsert only — PowDB's upsert has no `returning`)
  // -------------------------------------------------------------------------

  /** Reselect a single row by its single-column primary key value. */
  private async reselectByPk(pkValue: unknown, timeout?: number): Promise<T | null> {
    const pkField = this.meta.reverseColumnMap[this.meta.primaryKey[0]!] ?? this.meta.primaryKey[0]!;
    const { rows, native } = await this.runFind({
      where: { [pkField]: pkValue } as WhereClause<T>,
      limit: 1,
      timeout,
    } as FindManyArgs<T>);
    return rows.length ? this.shape(rows, native)[0]! : null;
  }

  /**
   * Empty-where guard — blocks accidental whole-table writes. Mirrors the SQL
   * path's `assertMutationHasPredicate` (query/builder.ts): it gates on the
   * *compiled* PowQL filter fragment, NOT the shape of the `where` object. A
   * `where` whose conditions all evaporate during compilation — `{}`,
   * `{ id: undefined }`, `{ OR: [] }`, `{ AND: [] }`, `{ NOT: {} }`,
   * `{ OR: [{ f: undefined }] }` — compiles to the empty string and is refused,
   * because emitting a filter-less write would hit every row.
   */
  private assertCompiledWhere(compiledWhere: string, allow: boolean | undefined, action: string): void {
    if (allow === true) return;
    if (compiledWhere.length > 0) return;
    throw new ValidationError(
      `[turbine] ${action} on "${this.table}" refused: the \`where\` clause is empty. ` +
        `Pass \`allowFullTableScan: true\` to opt in, or check that your filter values are defined.`,
    );
  }
}

/** Coerce a group-key scalar string by the column's TS type (numbers/bools). */
function coerceScalar(raw: string, tsType: string): unknown {
  const ts = tsType.replace(/\s*\|\s*null$/i, '').trim();
  if (raw === 'null') return null;
  if (ts === 'number' || ts === 'bigint') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (ts === 'boolean') return raw === 'true';
  if (ts === 'Date') return new Date(Number(raw) / 1000);
  return raw;
}

/**
 * Decode a JSON group-key cell, resolving the legacy-wire `null` ambiguity AND
 * normalizing the native typed wire to the SAME PG-`#>>`-text-parity shape.
 *
 * On the native typed wire (`native`) a cell arrives pre-typed (a JSON int as a
 * `bigint`, a bool as `boolean`, an unset value as `null`). Returned as-is that
 * would diverge from every other transport: the embedded / legacy / SQL wire
 * all yield the extracted TEXT (`'7'`, `'true'`), and a raw `bigint` even throws
 * on `JSON.stringify`. So a native scalar cell is rendered to its text form
 * ({@link nativeJsonKeyText}); `null`/`empty` stays `null`, and a genuine string
 * `"null"` stays the string (the wart the native wire was adopted to fix).
 *
 * On the legacy string wire a missing value, JSON null, AND the string `"null"`
 * all render the cell `"null"`; the group's `min(json_type(…))` discriminator is
 * `"string"` ONLY for the string-`"null"` group, so the cell is the string
 * `"null"` iff the discriminator is `"string"`, else `null`. Other cell values
 * pass through as the extracted string.
 */
function decodeGroupKeyCell(cell: unknown, discrim: unknown, native: boolean): unknown {
  if (native) return nativeJsonKeyText(cell);
  if (cell == null) return null;
  if (cell === 'null') return discrim === 'string' ? 'null' : null;
  return cell;
}

/**
 * Render a native-wire JSON group-key cell to the extracted-text shape the other
 * transports return (PG `#>>` / embedded legacy / SQL all give text keys). Keeps
 * `null` as `null`; a scalar (`bigint`/`number`/`boolean`/`string`) becomes its
 * string form; an object/array json sub-document is stringified (best-effort
 * parity: canonical byte-for-byte matching is not guaranteed for nested docs).
 */
function nativeJsonKeyText(cell: unknown): unknown {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === 'bigint') return cell.toString();
  if (typeof cell === 'number' || typeof cell === 'boolean') return String(cell);
  if (typeof cell === 'string') return cell;
  try {
    return JSON.stringify(cell);
  } catch {
    return String(cell);
  }
}
