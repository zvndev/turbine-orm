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
 * `docs/strategy/powdb-parity-matrix.md`, every row verified against a live
 * server):
 *   - `create`/`createMany`/`update`/`delete` use PowDB 0.7.0's trailing
 *     `returning` keyword (`RETURNING *`, all columns) to surface affected rows
 *     in one round-trip. `upsert` is the lone exception — its statement does not
 *     accept `returning`, so it reselects the row by PK.
 *   - The PK is generated client-side (UUID) when the column has a default.
 *   - `with` (nested relations) degrades to **batched N+1 loaders** — D
 *     round-trips for depth D, not one query. manyToMany is Phase B.
 *   - pgvector / JSON / array filters and cursor streaming throw
 *     {@link UnsupportedFeatureError} (E017) — they have no PowDB equivalent.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { NotFoundError, TimeoutError, UnsupportedFeatureError, ValidationError } from './errors.js';
import { PowdbFloatParam, type PowdbPool, powqlColumnType, rowToEntity } from './powdb.js';
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
  OrderByClause,
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
  type TableMetadata,
} from './schema.js';

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
  private currentAction = 'raw';
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
    this.warnOnUnlimited = options.warnOnUnlimited !== false;
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

  /** PowQL column reference (`.snake_name`) for a field. */
  private ref(field: string): string {
    return `.${this.column(field).name}`;
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
    const tagged = col && typeof value === 'number' && this.isFloatCol(col) ? new PowdbFloatParam(value) : value;
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
   */
  private buildWhere(where: WhereClause<T> | undefined, params: unknown[]): string {
    if (!where) return '';
    const parts: string[] = [];
    for (const [key, value] of Object.entries(where)) {
      if (value === undefined) continue;
      if (key === 'AND') {
        const sub = (value as WhereClause<T>[]).map((w) => this.buildWhere(w, params)).filter(Boolean);
        if (sub.length) parts.push(`(${sub.join(' and ')})`);
      } else if (key === 'OR') {
        const sub = (value as WhereClause<T>[]).map((w) => this.buildWhere(w, params)).filter(Boolean);
        if (sub.length) parts.push(`(${sub.join(' or ')})`);
      } else if (key === 'NOT') {
        const sub = this.buildWhere(value as WhereClause<T>, params);
        if (sub) parts.push(`not (${sub})`);
      } else if (this.meta.relations[key]) {
        parts.push(this.buildRelationFilter(this.meta.relations[key]!, value as Record<string, unknown>, params));
      } else {
        parts.push(this.buildFieldCondition(key, value, params));
      }
    }
    return parts.join(' and ');
  }

  /** Build a single `field: value | operator` condition. */
  private buildFieldCondition(field: string, value: unknown, params: unknown[]): string {
    const ref = this.ref(field);
    if (value === null) return `${ref} is null`;
    if (value instanceof Date || typeof value !== 'object') {
      return `${ref} = ${this.param(value, params)}`;
    }
    const op = value as Record<string, unknown>;
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
   * Relation filter (`some`/`none`/`every`) via the verified IN-subquery form
   * `Outer filter .localKey in (Target filter <e> { .targetKey })`. `exists`
   * correlation is unreliable on PowDB, so it is never used.
   */
  private buildRelationFilter(rel: RelationDef, filter: Record<string, unknown>, params: unknown[]): string {
    if (rel.type === 'manyToMany') {
      throw new UnsupportedFeatureError(
        'manyToMany relation filters',
        'PowDB',
        `relation "${rel.name}" — junction-table relation filters are Phase B`,
      );
    }
    const fk = normalizeKeyColumns(rel.foreignKey);
    const rk = normalizeKeyColumns(rel.referenceKey);
    if (fk.length > 1 || rk.length > 1) {
      throw new UnsupportedFeatureError(
        'composite-key relation filters',
        'PowDB',
        `relation "${rel.name}" uses a composite key`,
      );
    }
    // hasMany/hasOne: outer.referenceKey ∈ target.foreignKey.
    // belongsTo:      outer.foreignKey  ∈ target.referenceKey.
    const localKey = rel.type === 'belongsTo' ? fk[0]! : rk[0]!;
    const targetKey = rel.type === 'belongsTo' ? rk[0]! : fk[0]!;
    const targetMeta = this.schema.tables[rel.to];
    if (!targetMeta) throw new ValidationError(`[turbine] Relation "${rel.name}" targets unknown table "${rel.to}".`);
    const sub = (whereObj: Record<string, unknown> | undefined, negateInner: boolean) => {
      const innerQi = new PowqlInterface(this.pool, rel.to, this.schema, [], this.options);
      const inner = innerQi.buildWhere(whereObj as WhereClause<object> | undefined, params);
      const filterClause = inner ? ` filter ${negateInner ? `not (${inner})` : inner}` : '';
      return `${rel.to}${filterClause} { .${targetKey} }`;
    };
    if (filter.some) return `.${localKey} in (${sub(filter.some as Record<string, unknown>, false)})`;
    if (filter.none) return `.${localKey} not in (${sub(filter.none as Record<string, unknown>, false)})`;
    if (filter.every) {
      // Parents with no child failing the predicate.
      return `.${localKey} not in (${sub(filter.every as Record<string, unknown>, true)})`;
    }
    return this.alwaysFalse();
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

  /** `order .c1 asc, .c2 desc` clause (empty string when no orderBy). */
  private buildOrder(orderBy: OrderByClause | undefined): string {
    if (!orderBy) return '';
    const keys = Object.entries(orderBy).filter(([, dir]) => dir !== undefined);
    if (!keys.length) return '';
    const parts = keys.map(([field, dir]) => {
      if (dir && typeof dir === 'object') {
        throw new UnsupportedFeatureError('vector / distance ordering', 'PowDB', `field "${field}"`);
      }
      return `${this.ref(field)} ${dir === 'desc' ? 'desc' : 'asc'}`;
    });
    return ` order ${parts.join(', ')}`;
  }

  // -------------------------------------------------------------------------
  // Execution plumbing
  // -------------------------------------------------------------------------

  /** Run PowQL with optional timeout, emitting a query event either way. */
  private async exec(
    powql: string,
    params: unknown[],
    timeout?: number,
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const start = performance.now();
    const run = this.pool.query(powql, params) as Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
    try {
      const result = timeout
        ? await Promise.race([
            run,
            new Promise<never>((_, reject) => setTimeout(() => reject(new TimeoutError(timeout)), timeout)),
          ])
        : await run;
      this.emit(powql, params, performance.now() - start, result.rowCount ?? result.rows.length);
      return result;
    } catch (err) {
      this.emit(powql, params, performance.now() - start, 0, err as Error);
      throw err;
    }
  }

  private emit(sql: string, params: unknown[], duration: number, rows: number, error?: Error): void {
    if (!this.onQuery) return;
    try {
      this.onQuery({
        sql,
        params,
        duration,
        model: this.table,
        action: this.currentAction,
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
    this.currentAction = action;
    if (this.middlewares.length === 0) return executor();
    let index = 0;
    const next = async (p: { model: string; action: string; args: Record<string, unknown> }): Promise<unknown> => {
      if (index < this.middlewares.length) return this.middlewares[index++]!(p, next);
      return executor();
    };
    return next({ model: this.table, action, args: { ...args } }) as Promise<R>;
  }

  /** Map raw rows to typed entities. */
  private shape(rows: Record<string, unknown>[]): T[] {
    return rows.map((r) => rowToEntity(r, this.meta) as T);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async findMany(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T[]> {
    return this.withMiddleware('findMany', args as unknown as Record<string, unknown>, async () => {
      const rows = await this.runFind(args);
      const entities = this.shape(rows);
      if (args.with) await this.loadRelations(entities, args.with as Record<string, unknown>, args.timeout);
      return entities;
    });
  }

  /** Build + run the flat findMany select; returns raw rows. */
  private async runFind(args: FindManyArgs<T>): Promise<Record<string, unknown>[]> {
    if ((args as { cursor?: unknown }).cursor) {
      throw new UnsupportedFeatureError('cursor pagination', 'PowDB', 'use limit/offset instead');
    }
    const params: unknown[] = [];
    const where = this.buildWhere(args.where, params);
    const cols = this.projectedColumns(
      args.select as Record<string, boolean> | undefined,
      args.omit as Record<string, boolean> | undefined,
    );
    const distinct = args.distinct?.length ? ' distinct' : '';
    const filter = where ? ` filter ${where}` : '';
    const order = this.buildOrder(args.orderBy);
    const limit = args.limit ?? (args as { take?: number }).take ?? this.defaultLimit;
    if (limit === undefined && this.warnOnUnlimited && !this.warnedUnlimited) {
      this.warnedUnlimited = true;
      console.warn(`[turbine] findMany on "${this.table}" has no limit — this scans the whole table.`);
    }
    const limitClause = limit !== undefined ? ` limit ${this.param(limit, params)}` : '';
    const offsetClause = args.offset ? ` offset ${this.param(args.offset, params)}` : '';
    const powql = `${this.table}${distinct}${filter}${order}${limitClause}${offsetClause} ${this.projection(cols)}`;
    const { rows } = await this.exec(powql, params, args.timeout);
    return rows;
  }

  async findUnique(args: FindUniqueArgs<T>): Promise<T | null> {
    return this.withMiddleware('findUnique', args as unknown as Record<string, unknown>, async () => {
      const rows = await this.runFind({ ...args, limit: 1 } as FindManyArgs<T>);
      if (!rows.length) return null;
      const entities = this.shape(rows);
      if (args.with) await this.loadRelations(entities, args.with as Record<string, unknown>, args.timeout);
      return entities[0]!;
    });
  }

  async findFirst(args: FindManyArgs<T> = {} as FindManyArgs<T>): Promise<T | null> {
    return this.withMiddleware('findFirst', args as unknown as Record<string, unknown>, async () => {
      const rows = await this.runFind({ ...args, limit: 1 } as FindManyArgs<T>);
      if (!rows.length) return null;
      const entities = this.shape(rows);
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

  /** Load each requested relation for `parents` and attach it onto each row. */
  private async loadRelations(
    parents: T[],
    withClause: Record<string, unknown>,
    timeout?: number,
    depth = 0,
  ): Promise<void> {
    if (depth >= 10) {
      throw new ValidationError(`[turbine] Nested 'with' on PowDB exceeded depth 10 (relation cycle?).`);
    }
    if (!parents.length) return;
    for (const [relName, opt] of Object.entries(withClause)) {
      if (!opt) continue;
      const rel = this.meta.relations[relName];
      if (!rel) throw new ValidationError(`[turbine] Unknown relation "${relName}" on "${this.table}".`);
      if (rel.type === 'manyToMany') {
        throw new UnsupportedFeatureError(
          'manyToMany nested reads',
          'PowDB',
          `relation "${relName}" — junction loading is Phase B`,
        );
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
      if (keys.length) {
        const childWhere = {
          ...(options.where as Record<string, unknown> | undefined),
          [childKeyField]: { in: keys },
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

  // -------------------------------------------------------------------------
  // Writes (reselect — PowDB has no RETURNING)
  // -------------------------------------------------------------------------

  /** Split `data` into scalar assignments; reject relation (nested-write) keys. */
  private scalarData(data: Record<string, unknown>): { col: ColumnMetadata; value: unknown }[] {
    const out: { col: ColumnMetadata; value: unknown }[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (this.meta.relations[field]) {
        throw new UnsupportedFeatureError('nested writes', 'PowDB', `relation "${field}" in write data — Phase B`);
      }
      out.push({ col: this.column(field), value });
    }
    return out;
  }

  /** Fill in a client-generated UUID for a defaulted PK that wasn't supplied. */
  private applyPkDefault(data: Record<string, unknown>): Record<string, unknown> {
    const out = { ...data };
    for (const pk of this.meta.primaryKey) {
      const field = this.meta.reverseColumnMap[pk] ?? pk;
      const col = this.meta.columns.find((c) => c.name === pk);
      if (out[field] == null && col?.hasDefault && col.tsType.replace(/\s*\|\s*null$/, '').trim() === 'string') {
        out[field] = randomUUID();
      }
    }
    return out;
  }

  async create(args: CreateArgs<T>): Promise<T> {
    return this.withMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      const data = this.applyPkDefault(args.data as Record<string, unknown>);
      const assigns = this.scalarData(data);
      const params: unknown[] = [];
      const body = assigns.map((a) => `${a.col.name} := ${this.writeRef(a.value, a.col, params)}`).join(', ');
      // `returning` surfaces the inserted row (all columns, schema order) in one round-trip.
      const { rows } = await this.exec(`insert ${this.table} { ${body} } returning`, params, args.timeout);
      const row = rows.length ? this.shape(rows)[0]! : null;
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
        return `{ ${assigns.map((a) => `${a.col.name} := ${this.writeRef(a.value, a.col, params)}`).join(', ')} }`;
      });
      // Multi-row insert with `returning` hands back every inserted row in one round-trip.
      const { rows } = await this.exec(`insert ${this.table} ${tuples.join(', ')} returning`, params, args.timeout);
      return this.shape(rows);
    });
  }

  async update(args: UpdateArgs<T>): Promise<T> {
    return this.withMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      this.assertNonEmptyWhere(args.where, false, 'update');
      const params: unknown[] = [];
      const where = this.buildWhere(args.where, params);
      const setClause = this.buildUpdateAssignments(args.data as Record<string, unknown>, params);
      // `returning` hands back the post-update row(s); take the first (single-row contract).
      const { rows } = await this.exec(
        `${this.table} filter ${where} update { ${setClause} } returning`,
        params,
        args.timeout,
      );
      const row = rows.length ? this.shape(rows)[0]! : null;
      if (!row) throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
      return row;
    });
  }

  async updateMany(args: UpdateManyArgs<T>): Promise<{ count: number }> {
    return this.withMiddleware('updateMany', args as unknown as Record<string, unknown>, async () => {
      this.assertNonEmptyWhere(args.where, args.allowFullTableScan, 'updateMany');
      const params: unknown[] = [];
      const where = this.buildWhere(args.where, params);
      const setClause = this.buildUpdateAssignments(args.data as Record<string, unknown>, params);
      const filter = where ? ` filter ${where}` : '';
      const { rowCount } = await this.exec(`${this.table}${filter} update { ${setClause} }`, params, args.timeout);
      return { count: rowCount };
    });
  }

  /** Compile `data` into PowQL update assignments, including atomic operators. */
  private buildUpdateAssignments(data: Record<string, unknown>, params: unknown[]): string {
    const parts: string[] = [];
    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) continue;
      if (this.meta.relations[field]) {
        throw new UnsupportedFeatureError('nested writes', 'PowDB', `relation "${field}" — Phase B`);
      }
      const colMeta = this.column(field);
      const ref = this.ref(field);
      const col = colMeta.name;
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

  async delete(args: DeleteArgs<T>): Promise<T> {
    return this.withMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      this.assertNonEmptyWhere(args.where, false, 'delete');
      const params: unknown[] = [];
      const where = this.buildWhere(args.where, params);
      // `returning` hands back the deleted row(s) — no separate pre-image reselect needed.
      const { rows } = await this.exec(`${this.table} filter ${where} delete returning`, params, args.timeout);
      const row = rows.length ? this.shape(rows)[0]! : null;
      if (!row) throw new NotFoundError({ table: this.table, where: args.where as Record<string, unknown> });
      return row;
    });
  }

  async deleteMany(args: DeleteManyArgs<T>): Promise<{ count: number }> {
    return this.withMiddleware('deleteMany', args as unknown as Record<string, unknown>, async () => {
      this.assertNonEmptyWhere(args.where, args.allowFullTableScan, 'deleteMany');
      const params: unknown[] = [];
      const where = this.buildWhere(args.where, params);
      const filter = where ? ` filter ${where}` : '';
      const { rowCount } = await this.exec(`${this.table}${filter} delete`, params, args.timeout);
      return { count: rowCount };
    });
  }

  async upsert(args: UpsertArgs<T>): Promise<T> {
    return this.withMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      const createData = this.applyPkDefault(args.create as Record<string, unknown>);
      const pkCol = this.meta.primaryKey[0];
      if (!pkCol || this.meta.primaryKey.length !== 1) {
        throw new UnsupportedFeatureError('composite-key upsert', 'PowDB', `table "${this.table}"`);
      }
      const params: unknown[] = [];
      const createBody = this.scalarData(createData)
        .map((a) => `${a.col.name} := ${this.writeRef(a.value, a.col, params)}`)
        .join(', ');
      const updateBody = this.buildUpdateAssignments(args.update as Record<string, unknown>, params);
      // PowDB 0.7.0's `upsert` statement does NOT accept a trailing `returning`
      // (verified: "unexpected trailing token … 'returning'"), because it is one
      // atomic insert-or-update, not two branches. So upsert alone keeps the
      // reselect-by-PK fetch; create/update/delete all use `returning`.
      await this.exec(
        `upsert ${this.table} on .${pkCol} { ${createBody} } on conflict { ${updateBody} }`,
        params,
        args.timeout,
      );
      const pkField = this.meta.reverseColumnMap[pkCol] ?? pkCol;
      const row = await this.reselectByPk(createData[pkField], args.timeout);
      if (!row) throw new NotFoundError({ table: this.table, where: createData });
      return row;
    });
  }

  // -------------------------------------------------------------------------
  // Aggregates
  // -------------------------------------------------------------------------

  async count(args: CountArgs<T> = {}): Promise<number> {
    return this.withMiddleware('count', (args ?? {}) as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const where = this.buildWhere(args.where, params);
      const filter = where ? ` filter ${where}` : '';
      const { rows } = await this.exec(`count(${this.table}${filter})`, params, args.timeout);
      return Number((rows[0]?.value ?? rows[0]?.count ?? 0) as string | number);
    });
  }

  async aggregate(args: AggregateArgs<T>): Promise<AggregateResult<T>> {
    return this.withMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      // One scalar query per aggregate — PowDB's bare-projection aggregate is broken.
      const result: AggregateResult<T> = {};
      const filterParams: unknown[] = [];
      const where = this.buildWhere(args.where, filterParams);
      const filter = where ? ` filter ${where}` : '';
      const scalar = async (expr: string): Promise<number | null> => {
        const params = [...filterParams];
        const { rows } = await this.exec(expr, params, args.timeout);
        const v = rows[0]?.value;
        return v == null || v === 'null' ? null : Number(v);
      };
      if (args._count) {
        if (args._count === true) {
          result._count = (await scalar(`count(${this.table}${filter})`)) ?? 0;
        } else {
          const counts: Record<string, number> = {};
          for (const field of Object.keys(args._count).filter((f) => (args._count as Record<string, boolean>)[f])) {
            counts[field] = (await scalar(`count(${this.table}${filter} { ${this.ref(field)} })`)) ?? 0;
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
          acc[field] = await scalar(`${powfn}(${this.table}${filter} { ${this.ref(field)} })`);
        }
        (result as Record<string, unknown>)[fn] = acc;
      }
      return result;
    });
  }

  async groupBy(args: GroupByArgs<T>): Promise<Record<string, unknown>[]> {
    return this.withMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      const params: unknown[] = [];
      const where = this.buildWhere(args.where, params);
      const filter = where ? ` filter ${where}` : '';
      const groupKeys = args.by.map((f) => this.ref(f));
      // Safe aliases — PowQL rejects reserved-word aliases (e.g. `count:`).
      const aliasMap: { alias: string; fn: string; field: string | null; outKey: string }[] = [];
      let n = 0;
      const proj: string[] = args.by.map((f) => this.ref(f));
      if (args._count) {
        aliasMap.push({ alias: `agg_${n++}`, fn: 'count', field: null, outKey: '_count' });
      }
      for (const fn of ['_sum', '_avg', '_min', '_max'] as const) {
        const spec = args[fn];
        if (!spec) continue;
        for (const field of Object.keys(spec).filter((f) => (spec as Record<string, boolean>)[f])) {
          aliasMap.push({ alias: `agg_${n++}`, fn: fn.slice(1), field, outKey: `${fn}:${field}` });
        }
      }
      for (const a of aliasMap) {
        proj.push(`${a.alias}: ${a.fn}(${a.field ? this.ref(a.field) : `.${this.meta.primaryKey[0]}`})`);
      }
      const having = this.buildHaving(args.having, params);
      const order = this.buildOrder(args.orderBy as OrderByClause | undefined);
      const powql = `${this.table}${filter} group ${groupKeys.join(', ')}${having}${order} { ${proj.join(', ')} }`;
      const { rows } = await this.exec(powql, params, args.timeout);
      // Reshape: group keys → camel fields + coerced; aggregates → nested {_sum:{field}}.
      return rows.map((raw) => {
        const out: Record<string, unknown> = {};
        for (const f of args.by) {
          const col = this.column(f);
          out[f] =
            typeof raw[col.name] === 'string' ? coerceScalar(raw[col.name] as string, col.tsType) : raw[col.name];
        }
        for (const a of aliasMap) {
          const val = raw[a.alias];
          const num = val == null || val === 'null' ? null : Number(val);
          if (a.outKey === '_count') out._count = num ?? 0;
          else {
            const [bucket, field] = a.outKey.split(':') as [string, string];
            out[bucket] ??= {} as Record<string, unknown>;
            (out[bucket] as Record<string, unknown>)[field] = num;
          }
        }
        return out;
      });
    });
  }

  /** `having <expr>` over group aggregates (count/sum/avg/min/max). */
  private buildHaving(having: GroupByArgs<T>['having'], params: unknown[]): string {
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
        conds.push(cmp(`count(.${this.meta.primaryKey[0]})`, spec));
      } else {
        for (const [fn, filter] of Object.entries(spec as Record<string, unknown>)) {
          if (filter == null) continue;
          conds.push(cmp(`${fn.slice(1)}(${this.ref(key)})`, filter));
        }
      }
    }
    return conds.length ? ` having ${conds.join(' and ')}` : '';
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
    const rows = await this.runFind({
      where: { [pkField]: pkValue } as WhereClause<T>,
      limit: 1,
      timeout,
    } as FindManyArgs<T>);
    return rows.length ? this.shape(rows)[0]! : null;
  }

  /** Empty-where guard — blocks accidental whole-table writes. */
  private assertNonEmptyWhere(where: WhereClause<T> | undefined, allow: boolean | undefined, action: string): void {
    if (allow) return;
    const hasCondition =
      where &&
      Object.entries(where).some(([k, v]) => v !== undefined && (k === 'OR' || k === 'AND' || k === 'NOT' || true));
    if (!hasCondition) {
      throw new ValidationError(
        `[turbine] ${action} with an empty where would affect every row in "${this.table}". ` +
          `Pass allowFullTableScan: true if this is intentional.`,
      );
    }
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
