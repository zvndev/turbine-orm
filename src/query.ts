/**
 * turbine-orm — Query builder
 *
 * Each table accessor (db.users, db.posts, etc.) returns a QueryInterface<T>
 * that builds parameterized SQL and executes it through the connection pool.
 *
 * Nested relations use json_build_object + json_agg subqueries for single-query
 * resolution — the technique that benchmarks proved 2-3x faster than Prisma.
 *
 * Schema-driven: all column names, types, and relations come from introspected
 * metadata — nothing is hardcoded.
 */

import type pg from 'pg';
import type {
  SchemaMetadata,
  TableMetadata,
  RelationDef,
} from './schema.js';
import { snakeToCamel, camelToSnake } from './schema.js';

// ---------------------------------------------------------------------------
// Identifier quoting — prevents SQL injection via table/column names
// ---------------------------------------------------------------------------

/**
 * Quote a SQL identifier (table name, column name) using Postgres double-quote
 * rules: wrap in double quotes, escape internal double quotes by doubling them.
 *
 * @example
 *   quoteIdent('users')       → '"users"'
 *   quoteIdent('my"table')    → '"my""table"'
 *   quoteIdent('user name')   → '"user name"'
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Escape LIKE pattern metacharacters: %, _, and \.
 * Must be used with `ESCAPE '\'` in the LIKE clause.
 */
function escapeLike(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ---------------------------------------------------------------------------
// Public query argument types
// ---------------------------------------------------------------------------

export type OrderDirection = 'asc' | 'desc';

/** Operator object for advanced where filtering */
export interface WhereOperator<V = unknown> {
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  not?: V | null;
  in?: V[];
  notIn?: V[];
  contains?: string;
  startsWith?: string;
  endsWith?: string;
}

/** Known operator keys — used to detect operator objects vs plain values */
const OPERATOR_KEYS = new Set<string>([
  'gt', 'gte', 'lt', 'lte', 'not', 'in', 'notIn',
  'contains', 'startsWith', 'endsWith',
]);

/** Check if a value is a where operator object (has at least one known operator key) */
function isWhereOperator(value: unknown): value is WhereOperator {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => OPERATOR_KEYS.has(k));
}

/**
 * A where value can be:
 * - A plain value (equality: column = $N)
 * - null (column IS NULL)
 * - An operator object ({ gt: 5, lte: 10 })
 * - A JSONB filter object ({ contains, equals, path, hasKey })
 * - An array filter object ({ has, hasEvery, hasSome, isEmpty })
 */
export type WhereValue<V = unknown> = V | WhereOperator<V> | JsonFilter | ArrayFilter | null;

/**
 * Where clause type: each field can be a plain value, null, or operator object.
 * Special keys: OR for disjunctive conditions.
 * Relation names can be used with some/every/none sub-filters.
 */
export type WhereClause<T> = {
  [K in keyof T]?: WhereValue<T[K]>;
} & {
  OR?: WhereClause<T>[];
  AND?: WhereClause<T>[];
  NOT?: WhereClause<T>;
  /** Relation filters — keyed by relation name, value is { some, every, none } */
  [relationName: string]: unknown;
};

export interface WithClause {
  [relation: string]: true | WithOptions;
}

export interface WithOptions {
  with?: WithClause;
  where?: Record<string, unknown>;
  orderBy?: Record<string, OrderDirection>;
  limit?: number;
  /** Only include these fields from the relation */
  select?: Record<string, boolean>;
  /** Exclude these fields from the relation */
  omit?: Record<string, boolean>;
}

export interface FindUniqueArgs<T> {
  where: WhereClause<T>;
  select?: Record<string, boolean>;
  omit?: Record<string, boolean>;
  with?: WithClause;
}

export interface FindManyArgs<T> {
  where?: WhereClause<T>;
  select?: Record<string, boolean>;
  omit?: Record<string, boolean>;
  orderBy?: Record<string, OrderDirection>;
  limit?: number;
  offset?: number;
  with?: WithClause;
  /** Cursor-based pagination: start after this row */
  cursor?: Partial<T>;
  /** Number of records to take (used with cursor) */
  take?: number;
  /** De-duplicate results by specified fields */
  distinct?: (keyof T & string)[];
}

export interface CreateArgs<T> {
  data: Partial<T>;
}

export interface CreateManyArgs<T> {
  data: Partial<T>[];
  /** When true, adds ON CONFLICT DO NOTHING to skip duplicate rows */
  skipDuplicates?: boolean;
}

export interface UpdateArgs<T> {
  where: WhereClause<T>;
  data: Partial<T>;
}

export interface UpdateManyArgs<T> {
  where: WhereClause<T>;
  data: Partial<T>;
}

export interface DeleteArgs<T> {
  where: WhereClause<T>;
}

export interface DeleteManyArgs<T> {
  where: WhereClause<T>;
}

export interface UpsertArgs<T> {
  where: WhereClause<T>;
  create: Partial<T>;
  update: Partial<T>;
}

export interface CountArgs<T> {
  where?: WhereClause<T>;
}

export interface GroupByArgs<T> {
  by: (keyof T & string)[];
  where?: WhereClause<T>;
  /** Include count of each group */
  _count?: true;
  /** Sum of numeric fields in each group */
  _sum?: Partial<Record<keyof T & string, boolean>>;
  /** Average of numeric fields in each group */
  _avg?: Partial<Record<keyof T & string, boolean>>;
  /** Minimum value of fields in each group */
  _min?: Partial<Record<keyof T & string, boolean>>;
  /** Maximum value of fields in each group */
  _max?: Partial<Record<keyof T & string, boolean>>;
  /** Having clause for filtering groups */
  having?: Record<string, unknown>;
  /** Order groups */
  orderBy?: Record<string, OrderDirection>;
}

/** Arguments for the standalone aggregate method */
export interface AggregateArgs<T> {
  where?: WhereClause<T>;
  /** Count all rows matching the filter */
  _count?: true | Partial<Record<keyof T & string, boolean>>;
  /** Sum of numeric fields */
  _sum?: Partial<Record<keyof T & string, boolean>>;
  /** Average of numeric fields */
  _avg?: Partial<Record<keyof T & string, boolean>>;
  /** Minimum value of fields */
  _min?: Partial<Record<keyof T & string, boolean>>;
  /** Maximum value of fields */
  _max?: Partial<Record<keyof T & string, boolean>>;
}

/** Result type for aggregate queries */
export interface AggregateResult<T> {
  _count?: number | Record<string, number>;
  _sum?: Partial<Record<keyof T & string, number | null>>;
  _avg?: Partial<Record<keyof T & string, number | null>>;
  _min?: Partial<Record<keyof T & string, unknown>>;
  _max?: Partial<Record<keyof T & string, unknown>>;
}

/** Relation filter operators for where clauses */
export interface RelationFilter {
  some?: Record<string, unknown>;
  every?: Record<string, unknown>;
  none?: Record<string, unknown>;
}

/** JSONB query operators for where clauses */
export interface JsonFilter {
  /** Access nested path via #>> operator */
  path?: string[];
  /** Exact match: column @> value::jsonb (containment) */
  equals?: unknown;
  /** Containment check: column @> value::jsonb */
  contains?: unknown;
  /** Key existence check: column ? key */
  hasKey?: string;
}

/** Known JSONB operator keys */
const JSONB_OPERATOR_KEYS = new Set<string>(['path', 'equals', 'contains', 'hasKey']);

/** Check if a value is a JSONB filter object */
function isJsonFilter(value: unknown): value is JsonFilter {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.some((k) => JSONB_OPERATOR_KEYS.has(k));
}

/** Array query operators for where clauses */
export interface ArrayFilter {
  /** Check if array contains a single value: value = ANY(column) */
  has?: unknown;
  /** Check if array contains ALL values: column @> ARRAY[...] */
  hasEvery?: unknown[];
  /** Check if array has ANY of the values: column && ARRAY[...] */
  hasSome?: unknown[];
  /** Check if array is empty: array_length(column, 1) IS NULL */
  isEmpty?: boolean;
}

/** Known Array operator keys */
const ARRAY_OPERATOR_KEYS = new Set<string>(['has', 'hasEvery', 'hasSome', 'isEmpty']);

/** Check if a value is an Array filter object */
function isArrayFilter(value: unknown): value is ArrayFilter {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value) || value instanceof Date) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length > 0 && keys.some((k) => ARRAY_OPERATOR_KEYS.has(k));
}

// ---------------------------------------------------------------------------
// Deferred query descriptor (for pipeline batching)
// ---------------------------------------------------------------------------

export interface DeferredQuery<T> {
  /** SQL text with $1, $2 placeholders */
  sql: string;
  /** Bound parameter values */
  params: unknown[];
  /** How to transform the raw pg.QueryResult into the final value */
  transform: (result: pg.QueryResult) => T;
  /** Tag for debugging / logging */
  tag: string;
}

// ---------------------------------------------------------------------------
// QueryInterface — the object returned by db.users, db.posts, etc.
// ---------------------------------------------------------------------------

/** Middleware function type — imported from client to avoid circular deps */
type MiddlewareFn = (
  params: { model: string; action: string; args: Record<string, unknown> },
  next: (params: { model: string; action: string; args: Record<string, unknown> }) => Promise<unknown>,
) => Promise<unknown>;

export class QueryInterface<T extends object> {
  private readonly tableMeta: TableMetadata;
  /** SQL template cache: cacheKey → sql string (params are always positional $1,$2,...) */
  private readonly sqlCache = new Map<string, string>();
  private readonly middlewares: MiddlewareFn[];

  // Fast path: pre-computed flag — true when this table has zero date/timestamp columns.
  // When true, parseRow can skip the per-field dateCols.has() check entirely.
  private readonly hasNoDateColumns: boolean;

  constructor(
    private readonly pool: pg.Pool,
    private readonly table: string,
    private readonly schema: SchemaMetadata,
    middlewares?: MiddlewareFn[],
  ) {
    const meta = schema.tables[table];
    if (!meta) {
      throw new Error(
        `[turbine] Unknown table "${table}". Available: ${Object.keys(schema.tables).join(', ')}`,
      );
    }
    this.tableMeta = meta;
    this.middlewares = middlewares ?? [];
    this.hasNoDateColumns = meta.dateColumns.size === 0;
  }

  /**
   * Execute a query through the middleware chain.
   * If no middlewares are registered, executes directly.
   */
  private async executeWithMiddleware<R>(
    action: string,
    args: Record<string, unknown>,
    executor: () => Promise<R>,
  ): Promise<R> {
    if (this.middlewares.length === 0) {
      return executor();
    }

    const params = { model: this.table, action, args: { ...args } };

    // Build middleware chain
    let index = 0;
    const next = async (p: { model: string; action: string; args: Record<string, unknown> }): Promise<unknown> => {
      if (index < this.middlewares.length) {
        const mw = this.middlewares[index++]!;
        return mw(p, next);
      }
      // End of chain — execute the actual query
      return executor();
    };

    return next(params) as Promise<R>;
  }

  /**
   * Generate a cache key for a query shape.
   * Same where-keys + same with-clause = same SQL template.
   */
  private cacheKey(op: string, whereKeys: string[], withClause?: WithClause, extra?: string): string {
    let key = `${op}:${whereKeys.sort().join(',')}`;
    if (withClause) key += `:w=${JSON.stringify(Object.keys(withClause).sort())}`;
    if (extra) key += `:${extra}`;
    return key;
  }

  // -------------------------------------------------------------------------
  // findUnique
  // -------------------------------------------------------------------------

  async findUnique(args: FindUniqueArgs<T>): Promise<T | null> {
    return this.executeWithMiddleware('findUnique', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUnique(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildFindUnique(args: FindUniqueArgs<T>): DeferredQuery<T | null> {
    const columnsList = this.resolveColumns(args.select, args.omit);
    const whereObj = args.where as Record<string, unknown>;

    // Check if all where values are simple (plain equality, no operators/null/OR)
    const whereKeys = Object.keys(whereObj).filter((k) => whereObj[k] !== undefined);
    const isSimpleWhere = !whereObj['OR'] && !whereObj['AND'] && !whereObj['NOT'] && whereKeys.every((k) => {
      const v = whereObj[k];
      return v !== null && !isWhereOperator(v) && !isJsonFilter(v) && !isArrayFilter(v);
    });

    // -----------------------------------------------------------------------
    // Fast path: no relations, simple equality where — cache SQL template.
    // Generates: SELECT col1, col2 FROM "table" WHERE "id" = $1 LIMIT 1
    // No json_build_object, no subqueries, no COALESCE wrappers.
    // -----------------------------------------------------------------------
    if (!args.with && isSimpleWhere) {
      const colKey = columnsList ? columnsList.join(',') : '*';
      const ck = `fu:${whereKeys.sort().join(',')}:c=${colKey}`;
      let sql = this.sqlCache.get(ck);
      const params: unknown[] = whereKeys.map((k) => whereObj[k]);

      if (!sql) {
        const qt = quoteIdent(this.table);
        const whereClauses = whereKeys.map((k, i) => `${this.toSqlColumn(k)} = $${i + 1}`);
        const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';
        const selectExpr = columnsList
          ? columnsList.map((c) => `${qt}.${quoteIdent(c)}`).join(', ')
          : `${qt}.*`;
        sql = `SELECT ${selectExpr} FROM ${qt}${whereSql} LIMIT 1`;
        this.sqlCache.set(ck, sql);
      }

      // Fast path: skip date coercion when table has no date columns
      const transformRow = this.hasNoDateColumns
        ? (row: Record<string, unknown>) => this.parseRowFast(row) as T
        : (row: Record<string, unknown>) => this.parseRow(row, this.table) as T;

      return {
        sql,
        params,
        transform: (result) => {
          const row = result.rows[0];
          return row ? transformRow(row) : null;
        },
        tag: `${this.table}.findUnique`,
      };
    }

    // General path: supports operators, null, OR, nested with
    const { sql: whereSql, params } = this.buildWhere(args.where);

    // Fast path: no relations, skip json_agg (but where has operators/null/OR)
    if (!args.with) {
      const qt = quoteIdent(this.table);
      const selectExpr = columnsList
        ? columnsList.map((c) => `${qt}.${quoteIdent(c)}`).join(', ')
        : `${qt}.*`;
      const sql = `SELECT ${selectExpr} FROM ${qt}${whereSql} LIMIT 1`;
      return {
        sql,
        params,
        transform: (result) => {
          const row = result.rows[0];
          return row ? (this.parseRow(row, this.table) as T) : null;
        },
        tag: `${this.table}.findUnique`,
      };
    }

    // Nested queries: build fresh each time (with clause affects params)
    const selectClause = this.buildSelectWithRelations(this.table, args.with, params, columnsList);
    const sql = `SELECT ${selectClause} FROM ${quoteIdent(this.table)}${whereSql} LIMIT 1`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        return row ? (this.parseNestedRow(row, this.table) as T) : null;
      },
      tag: `${this.table}.findUnique`,
    };
  }

  // -------------------------------------------------------------------------
  // findMany
  // -------------------------------------------------------------------------

  async findMany(args?: FindManyArgs<T>): Promise<T[]> {
    return this.executeWithMiddleware('findMany', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindMany(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildFindMany(args?: FindManyArgs<T>): DeferredQuery<T[]> {
    const columnsList = this.resolveColumns(args?.select, args?.omit);
    const qt = quoteIdent(this.table);
    const hasWith = !!(args?.with);

    // -----------------------------------------------------------------------
    // Fast path: no relations, no cursor, no distinct — cache SQL template
    // Skip json_agg subquery machinery entirely for simple table scans.
    // -----------------------------------------------------------------------
    if (!hasWith && !args?.cursor && !args?.distinct) {
      const whereObj = args?.where as Record<string, unknown> | undefined;
      const whereKeys = whereObj
        ? Object.keys(whereObj).filter((k) => whereObj[k] !== undefined)
        : [];

      // Check if all where values are simple equality (no operators, null, OR/AND/NOT)
      const isSimpleWhere = !whereObj || (
        !whereObj['OR'] && !whereObj['AND'] && !whereObj['NOT'] && whereKeys.every((k) => {
          const v = whereObj[k];
          return v !== null && !isWhereOperator(v) && !isJsonFilter(v) && !isArrayFilter(v);
        })
      );

      if (isSimpleWhere) {
        // Build cache key: operation + where keys + columns + orderBy + hasLimit + hasOffset
        const colKey = columnsList ? columnsList.join(',') : '*';
        const orderKey = args?.orderBy ? Object.entries(args.orderBy).map(([k, d]) => `${k}:${d}`).join(',') : '';
        const hasLimit = args?.limit !== undefined || args?.take !== undefined;
        const hasOffset = args?.offset !== undefined;
        const ck = `fm:${whereKeys.sort().join(',')}:c=${colKey}:o=${orderKey}:l=${hasLimit ? '1' : '0'}:off=${hasOffset ? '1' : '0'}`;

        let sql = this.sqlCache.get(ck);
        const params: unknown[] = whereKeys.map((k) => whereObj![k]);

        if (!sql) {
          // Build SQL template once and cache it
          const selectExpr = columnsList
            ? columnsList.map((c) => `${qt}.${quoteIdent(c)}`).join(', ')
            : `${qt}.*`;
          const whereClauses = whereKeys.map((k, i) => `${this.toSqlColumn(k)} = $${i + 1}`);
          const whereSql = whereClauses.length > 0 ? ` WHERE ${whereClauses.join(' AND ')}` : '';

          sql = `SELECT ${selectExpr} FROM ${qt}${whereSql}`;

          if (args?.orderBy) {
            sql += ` ORDER BY ${this.buildOrderBy(args.orderBy)}`;
          }

          // Placeholders for LIMIT/OFFSET — positions are stable since where params come first
          if (hasLimit) {
            sql += ` LIMIT $${params.length + 1}`;
          }
          if (hasOffset) {
            sql += ` OFFSET $${params.length + (hasLimit ? 2 : 1)}`;
          }

          this.sqlCache.set(ck, sql);
        }

        // Append runtime param values for LIMIT and OFFSET
        const effectiveLimit = args?.take ?? args?.limit;
        if (effectiveLimit !== undefined) {
          params.push(Number(effectiveLimit));
        }
        if (args?.offset !== undefined) {
          params.push(Number(args.offset));
        }

        // Fast path: no relations, use parseRow (or parseRowFast when no date columns)
        const parseRow = this.hasNoDateColumns
          ? (row: Record<string, unknown>) => this.parseRowFast(row) as T
          : (row: Record<string, unknown>) => this.parseRow(row, this.table) as T;

        return {
          sql,
          params,
          transform: (result) => result.rows.map(parseRow),
          tag: `${this.table}.findMany`,
        };
      }
    }

    // -----------------------------------------------------------------------
    // General path: supports operators, null, OR, cursor, distinct, nested with
    // -----------------------------------------------------------------------
    const { sql: whereSql, params } = args?.where
      ? this.buildWhere(args.where)
      : { sql: '', params: [] as unknown[] };

    // Distinct support
    let distinctPrefix = '';
    if (args?.distinct && args.distinct.length > 0) {
      const distinctCols = args.distinct.map((k) => this.toSqlColumn(k as string));
      distinctPrefix = `DISTINCT ON (${distinctCols.join(', ')}) `;
    }

    let selectClause: string;
    if (hasWith) {
      selectClause = this.buildSelectWithRelations(this.table, args!.with!, params, columnsList);
    } else if (columnsList) {
      selectClause = columnsList.map((c) => `${qt}.${quoteIdent(c)}`).join(', ');
    } else {
      selectClause = `${qt}.*`;
    }

    let sql = `SELECT ${distinctPrefix}${selectClause} FROM ${qt}${whereSql}`;

    // Cursor-based pagination: add WHERE condition for cursor
    if (args?.cursor) {
      const cursorEntries = Object.entries(args.cursor as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      if (cursorEntries.length > 0) {
        // Determine direction from orderBy (default 'asc')
        const cursorConditions = cursorEntries.map(([k, v]) => {
          const col = this.toSqlColumn(k);
          const dir = args.orderBy?.[k] ?? 'asc';
          const op = dir === 'desc' ? '<' : '>';
          params.push(v);
          return `${qt}.${col} ${op} $${params.length}`;
        });
        // Append to existing WHERE or create new one
        if (whereSql) {
          sql += ` AND ${cursorConditions.join(' AND ')}`;
        } else {
          sql += ` WHERE ${cursorConditions.join(' AND ')}`;
        }
      }
    }

    if (args?.orderBy) {
      sql += ` ORDER BY ${this.buildOrderBy(args.orderBy)}`;
    }

    // take overrides limit when cursor pagination is used
    const effectiveLimit = args?.take ?? args?.limit;
    if (effectiveLimit !== undefined) {
      params.push(Number(effectiveLimit));
      sql += ` LIMIT $${params.length}`;
    }
    if (args?.offset !== undefined) {
      params.push(Number(args.offset));
      sql += ` OFFSET $${params.length}`;
    }

    return {
      sql,
      params,
      transform: (result) =>
        result.rows.map((row) =>
          hasWith
            ? (this.parseNestedRow(row, this.table) as T)
            : (this.parseRow(row, this.table) as T),
        ),
      tag: `${this.table}.findMany`,
    };
  }

  // -------------------------------------------------------------------------
  // findFirst — like findMany but returns a single row or null
  // -------------------------------------------------------------------------

  async findFirst(args?: FindManyArgs<T>): Promise<T | null> {
    return this.executeWithMiddleware('findFirst', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirst(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildFindFirst(args?: FindManyArgs<T>): DeferredQuery<T | null> {
    // Reuse findMany's SQL builder but force LIMIT 1
    const findManyArgs: FindManyArgs<T> = { ...args, limit: 1 };
    const deferred = this.buildFindMany(findManyArgs);

    return {
      sql: deferred.sql,
      params: deferred.params,
      transform: (result) => {
        const rows = deferred.transform(result);
        return rows.length > 0 ? rows[0]! : null;
      },
      tag: `${this.table}.findFirst`,
    };
  }

  // -------------------------------------------------------------------------
  // findFirstOrThrow — like findFirst but throws if no record found
  // -------------------------------------------------------------------------

  async findFirstOrThrow(args?: FindManyArgs<T>): Promise<T> {
    return this.executeWithMiddleware('findFirstOrThrow', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildFindFirstOrThrow(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildFindFirstOrThrow(args?: FindManyArgs<T>): DeferredQuery<T> {
    const inner = this.buildFindFirst(args);

    return {
      sql: inner.sql,
      params: inner.params,
      transform: (result) => {
        const row = inner.transform(result);
        if (row === null) {
          throw new Error('Record not found');
        }
        return row;
      },
      tag: `${this.table}.findFirstOrThrow`,
    };
  }

  // -------------------------------------------------------------------------
  // findUniqueOrThrow — like findUnique but throws if no record found
  // -------------------------------------------------------------------------

  async findUniqueOrThrow(args: FindUniqueArgs<T>): Promise<T> {
    return this.executeWithMiddleware('findUniqueOrThrow', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildFindUniqueOrThrow(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildFindUniqueOrThrow(args: FindUniqueArgs<T>): DeferredQuery<T> {
    const inner = this.buildFindUnique(args);

    return {
      sql: inner.sql,
      params: inner.params,
      transform: (result) => {
        const row = inner.transform(result);
        if (row === null) {
          throw new Error('Record not found');
        }
        return row;
      },
      tag: `${this.table}.findUniqueOrThrow`,
    };
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(args: CreateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('create', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildCreate(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildCreate(args: CreateArgs<T>): DeferredQuery<T> {
    const entries = Object.entries(args.data as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    const columns = entries.map(([k]) => this.toSqlColumn(k));
    const params = entries.map(([, v]) => v);
    const placeholders = entries.map((_, i) => `$${i + 1}`);

    const sql = `INSERT INTO ${quoteIdent(this.table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) throw new Error('[turbine] Expected a row but query returned none');
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.create`,
    };
  }

  // -------------------------------------------------------------------------
  // createMany — uses UNNEST for performance
  // -------------------------------------------------------------------------

  async createMany(args: CreateManyArgs<T>): Promise<T[]> {
    return this.executeWithMiddleware('createMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildCreateMany(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildCreateMany(args: CreateManyArgs<T>): DeferredQuery<T[]> {
    const qt = quoteIdent(this.table);
    if (args.data.length === 0) {
      return {
        sql: `SELECT * FROM ${qt} WHERE false`,
        params: [],
        transform: () => [],
        tag: `${this.table}.createMany`,
      };
    }

    const keys = Object.keys(args.data[0]!).filter(
      (k) => (args.data[0] as Record<string, unknown>)[k] !== undefined,
    );
    const columns = keys.map((k) => this.toColumn(k));

    // Build column arrays for UNNEST
    const columnArrays: unknown[][] = keys.map(() => []);
    for (const row of args.data) {
      const record = row as Record<string, unknown>;
      keys.forEach((key, i) => {
        columnArrays[i]!.push(record[key]);
      });
    }

    // Use actual Postgres types for array casts
    const typeCasts = columns.map((col) => this.getColumnArrayType(col));
    const unnestArgs = columnArrays.map((_, i) => `$${i + 1}::${typeCasts[i]}`);
    const quotedColumns = columns.map((c) => quoteIdent(c));

    let sql = `INSERT INTO ${qt} (${quotedColumns.join(', ')}) SELECT * FROM UNNEST(${unnestArgs.join(', ')})`;

    // skipDuplicates: add ON CONFLICT DO NOTHING
    if (args.skipDuplicates) {
      sql += ` ON CONFLICT DO NOTHING`;
    }

    sql += ` RETURNING *`;

    return {
      sql,
      params: columnArrays,
      transform: (result) =>
        result.rows.map((row) => this.parseRow(row, this.table) as T),
      tag: `${this.table}.createMany`,
    };
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(args: UpdateArgs<T>): Promise<T> {
    return this.executeWithMiddleware('update', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpdate(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildUpdate(args: UpdateArgs<T>): DeferredQuery<T> {
    const setEntries = Object.entries(args.data as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );

    // Build SET params first
    const params: unknown[] = [];
    const setClauses = setEntries.map(([k, v]) => {
      params.push(v);
      return `${this.toSqlColumn(k)} = $${params.length}`;
    });

    // Build WHERE using the shared params array (continues numbering after SET params)
    const whereClause = this.buildWhereClause(
      args.where as Record<string, unknown>,
      params,
    );

    const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
    const sql = `UPDATE ${quoteIdent(this.table)} SET ${setClauses.join(', ')}${whereSql} RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) throw new Error('[turbine] Expected a row but query returned none');
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.update`,
    };
  }

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  async delete(args: DeleteArgs<T>): Promise<T> {
    return this.executeWithMiddleware('delete', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDelete(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildDelete(args: DeleteArgs<T>): DeferredQuery<T> {
    const { sql: whereSql, params } = this.buildWhere(args.where);
    const sql = `DELETE FROM ${quoteIdent(this.table)}${whereSql} RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) throw new Error('[turbine] Expected a row but query returned none');
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.delete`,
    };
  }

  // -------------------------------------------------------------------------
  // upsert — INSERT ... ON CONFLICT ... DO UPDATE
  // -------------------------------------------------------------------------

  async upsert(args: UpsertArgs<T>): Promise<T> {
    return this.executeWithMiddleware('upsert', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpsert(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildUpsert(args: UpsertArgs<T>): DeferredQuery<T> {
    // Build the INSERT part from create data
    const createEntries = Object.entries(args.create as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    const columns = createEntries.map(([k]) => this.toSqlColumn(k));
    const createParams = createEntries.map(([, v]) => v);
    const placeholders = createEntries.map((_, i) => `$${i + 1}`);

    // The conflict target comes from `where` keys — must be unique/PK columns
    const conflictKeys = Object.keys(args.where as Record<string, unknown>).filter(
      (k) => (args.where as Record<string, unknown>)[k] !== undefined,
    );
    const conflictColumns = conflictKeys.map((k) => this.toSqlColumn(k));

    // Build the UPDATE SET part
    const updateEntries = Object.entries(args.update as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );
    let paramIdx = createParams.length + 1;
    const setClauses = updateEntries.map(([k]) => {
      const clause = `${this.toSqlColumn(k)} = $${paramIdx}`;
      paramIdx++;
      return clause;
    });
    const updateParams = updateEntries.map(([, v]) => v);

    const params = [...createParams, ...updateParams];

    const sql =
      `INSERT INTO ${quoteIdent(this.table)} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})` +
      ` ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${setClauses.join(', ')}` +
      ` RETURNING *`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0];
        if (!row) throw new Error('[turbine] Expected a row but query returned none');
        return this.parseRow(row, this.table) as T;
      },
      tag: `${this.table}.upsert`,
    };
  }

  // -------------------------------------------------------------------------
  // updateMany — UPDATE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async updateMany(args: UpdateManyArgs<T>): Promise<{ count: number }> {
    return this.executeWithMiddleware('updateMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildUpdateMany(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildUpdateMany(args: UpdateManyArgs<T>): DeferredQuery<{ count: number }> {
    const setEntries = Object.entries(args.data as Record<string, unknown>).filter(
      ([, v]) => v !== undefined,
    );

    // Build SET params first
    const params: unknown[] = [];
    const setClauses = setEntries.map(([k, v]) => {
      params.push(v);
      return `${this.toSqlColumn(k)} = $${params.length}`;
    });

    // Build WHERE using the shared params array (continues numbering after SET params)
    const whereClause = this.buildWhereClause(
      args.where as Record<string, unknown>,
      params,
    );

    const whereSql = whereClause ? ` WHERE ${whereClause}` : '';
    const sql = `UPDATE ${quoteIdent(this.table)} SET ${setClauses.join(', ')}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => ({ count: result.rowCount ?? 0 }),
      tag: `${this.table}.updateMany`,
    };
  }

  // -------------------------------------------------------------------------
  // deleteMany — DELETE ... WHERE ... returning count
  // -------------------------------------------------------------------------

  async deleteMany(args: DeleteManyArgs<T>): Promise<{ count: number }> {
    return this.executeWithMiddleware('deleteMany', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildDeleteMany(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildDeleteMany(args: DeleteManyArgs<T>): DeferredQuery<{ count: number }> {
    const { sql: whereSql, params } = this.buildWhere(args.where);
    const sql = `DELETE FROM ${quoteIdent(this.table)}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => ({ count: result.rowCount ?? 0 }),
      tag: `${this.table}.deleteMany`,
    };
  }

  // -------------------------------------------------------------------------
  // count
  // -------------------------------------------------------------------------

  async count(args?: CountArgs<T>): Promise<number> {
    return this.executeWithMiddleware('count', (args ?? {}) as Record<string, unknown>, async () => {
      const deferred = this.buildCount(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildCount(args?: CountArgs<T>): DeferredQuery<number> {
    const { sql: whereSql, params } = args?.where
      ? this.buildWhere(args.where)
      : { sql: '', params: [] as unknown[] };

    const sql = `SELECT COUNT(*)::int AS count FROM ${quoteIdent(this.table)}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => (result.rows[0] as { count: number }).count,
      tag: `${this.table}.count`,
    };
  }

  // -------------------------------------------------------------------------
  // groupBy (with aggregate functions)
  // -------------------------------------------------------------------------

  async groupBy(args: GroupByArgs<T>): Promise<Record<string, unknown>[]> {
    return this.executeWithMiddleware('groupBy', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildGroupBy(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildGroupBy(args: GroupByArgs<T>): DeferredQuery<Record<string, unknown>[]> {
    const groupColsRaw = args.by.map((k) => this.toColumn(k as string));
    const groupCols = groupColsRaw.map((c) => quoteIdent(c));
    const { sql: whereSql, params } = args.where
      ? this.buildWhere(args.where)
      : { sql: '', params: [] as unknown[] };

    // Build SELECT expressions: group-by columns + aggregate functions
    const selectExprs = [...groupCols];

    // _count
    if (args._count === true || args._count === undefined) {
      // default: always include count
      selectExprs.push('COUNT(*)::int AS _count');
    }

    // _sum
    if (args._sum) {
      for (const [field, enabled] of Object.entries(args._sum)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`SUM(${quoteIdent(col)}) AS _sum_${col}`);
        }
      }
    }

    // _avg
    if (args._avg) {
      for (const [field, enabled] of Object.entries(args._avg)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`AVG(${quoteIdent(col)})::float AS _avg_${col}`);
        }
      }
    }

    // _min
    if (args._min) {
      for (const [field, enabled] of Object.entries(args._min)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MIN(${quoteIdent(col)}) AS _min_${col}`);
        }
      }
    }

    // _max
    if (args._max) {
      for (const [field, enabled] of Object.entries(args._max)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MAX(${quoteIdent(col)}) AS _max_${col}`);
        }
      }
    }

    let sql = `SELECT ${selectExprs.join(', ')} FROM ${quoteIdent(this.table)}${whereSql} GROUP BY ${groupCols.join(', ')}`;

    // ORDER BY
    if (args.orderBy) {
      sql += ` ORDER BY ${this.buildOrderBy(args.orderBy)}`;
    }

    return {
      sql,
      params,
      transform: (result) =>
        result.rows.map((row) => {
          const parsed = this.parseRow(row, this.table);
          // Restructure aggregate results into nested objects (Prisma-style)
          const restructured: Record<string, unknown> = {};

          // Copy group-by fields
          for (const field of args.by) {
            restructured[field] = parsed[field];
          }

          // _count
          if ('_count' in row) {
            restructured._count = row._count;
          } else if ('count' in row) {
            restructured._count = row.count;
          }

          // Collect aggregates into nested objects
          const sumObj: Record<string, unknown> = {};
          const avgObj: Record<string, unknown> = {};
          const minObj: Record<string, unknown> = {};
          const maxObj: Record<string, unknown> = {};
          let hasSums = false, hasAvgs = false, hasMins = false, hasMaxs = false;

          for (const [rawKey, rawValue] of Object.entries(row)) {
            if (rawKey.startsWith('_sum_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              sumObj[field] = rawValue !== null ? Number(rawValue) : null;
              hasSums = true;
            } else if (rawKey.startsWith('_avg_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              avgObj[field] = rawValue !== null ? Number(rawValue) : null;
              hasAvgs = true;
            } else if (rawKey.startsWith('_min_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              minObj[field] = rawValue;
              hasMins = true;
            } else if (rawKey.startsWith('_max_')) {
              const col = rawKey.slice(5);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              maxObj[field] = rawValue;
              hasMaxs = true;
            }
          }

          if (hasSums) restructured._sum = sumObj;
          if (hasAvgs) restructured._avg = avgObj;
          if (hasMins) restructured._min = minObj;
          if (hasMaxs) restructured._max = maxObj;

          return restructured;
        }),
      tag: `${this.table}.groupBy`,
    };
  }

  // -------------------------------------------------------------------------
  // aggregate — standalone aggregation without groupBy
  // -------------------------------------------------------------------------

  async aggregate(args: AggregateArgs<T>): Promise<AggregateResult<T>> {
    return this.executeWithMiddleware('aggregate', args as unknown as Record<string, unknown>, async () => {
      const deferred = this.buildAggregate(args);
      const result = await this.pool.query(deferred.sql, deferred.params);
      return deferred.transform(result);
    });
  }

  buildAggregate(args: AggregateArgs<T>): DeferredQuery<AggregateResult<T>> {
    const { sql: whereSql, params } = args.where
      ? this.buildWhere(args.where)
      : { sql: '', params: [] as unknown[] };

    const selectExprs: string[] = [];

    // _count
    if (args._count === true) {
      selectExprs.push('COUNT(*)::int AS _count');
    } else if (args._count && typeof args._count === 'object') {
      for (const [field, enabled] of Object.entries(args._count)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`COUNT(${quoteIdent(col)})::int AS _count_${col}`);
        }
      }
    }

    // _sum
    if (args._sum) {
      for (const [field, enabled] of Object.entries(args._sum)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`SUM(${quoteIdent(col)}) AS _sum_${col}`);
        }
      }
    }

    // _avg
    if (args._avg) {
      for (const [field, enabled] of Object.entries(args._avg)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`AVG(${quoteIdent(col)})::float AS _avg_${col}`);
        }
      }
    }

    // _min
    if (args._min) {
      for (const [field, enabled] of Object.entries(args._min)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MIN(${quoteIdent(col)}) AS _min_${col}`);
        }
      }
    }

    // _max
    if (args._max) {
      for (const [field, enabled] of Object.entries(args._max)) {
        if (enabled) {
          const col = this.toColumn(field);
          selectExprs.push(`MAX(${quoteIdent(col)}) AS _max_${col}`);
        }
      }
    }

    if (selectExprs.length === 0) {
      selectExprs.push('COUNT(*)::int AS _count');
    }

    const sql = `SELECT ${selectExprs.join(', ')} FROM ${quoteIdent(this.table)}${whereSql}`;

    return {
      sql,
      params,
      transform: (result) => {
        const row = result.rows[0] as Record<string, unknown>;
        const aggResult: AggregateResult<T> = {};

        // _count
        if (row._count !== undefined) {
          aggResult._count = row._count as number;
        } else {
          // Check for per-column counts
          const countObj: Record<string, number> = {};
          let hasCountFields = false;
          for (const [key, val] of Object.entries(row)) {
            if (key.startsWith('_count_')) {
              const col = key.slice(7);
              const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
              countObj[field] = val as number;
              hasCountFields = true;
            }
          }
          if (hasCountFields) aggResult._count = countObj;
        }

        // Build nested aggregate objects
        const sumObj: Record<string, number | null> = {};
        const avgObj: Record<string, number | null> = {};
        const minObj: Record<string, unknown> = {};
        const maxObj: Record<string, unknown> = {};
        let hasSums = false, hasAvgs = false, hasMins = false, hasMaxs = false;

        for (const [key, val] of Object.entries(row)) {
          if (key.startsWith('_sum_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            sumObj[field] = val !== null ? Number(val) : null;
            hasSums = true;
          } else if (key.startsWith('_avg_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            avgObj[field] = val !== null ? Number(val) : null;
            hasAvgs = true;
          } else if (key.startsWith('_min_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            minObj[field] = val;
            hasMins = true;
          } else if (key.startsWith('_max_')) {
            const col = key.slice(5);
            const field = this.tableMeta.reverseColumnMap[col] ?? snakeToCamel(col);
            maxObj[field] = val;
            hasMaxs = true;
          }
        }

        if (hasSums) aggResult._sum = sumObj as Partial<Record<keyof T & string, number | null>>;
        if (hasAvgs) aggResult._avg = avgObj as Partial<Record<keyof T & string, number | null>>;
        if (hasMins) aggResult._min = minObj as Partial<Record<keyof T & string, unknown>>;
        if (hasMaxs) aggResult._max = maxObj as Partial<Record<keyof T & string, unknown>>;

        return aggResult;
      },
      tag: `${this.table}.aggregate`,
    };
  }

  // =========================================================================
  // Internal helpers
  // =========================================================================

  /**
   * Resolve select/omit options into a list of snake_case column names.
   * Returns null if neither is provided (meaning all columns).
   */
  private resolveColumns(
    select?: Record<string, boolean>,
    omit?: Record<string, boolean>,
  ): string[] | null {
    if (select) {
      // Only include columns where value is true
      return Object.entries(select)
        .filter(([, v]) => v)
        .map(([k]) => this.toColumn(k));
    }
    if (omit) {
      // Include all columns except those where value is true
      const omitCols = new Set(
        Object.entries(omit)
          .filter(([, v]) => v)
          .map(([k]) => this.toColumn(k)),
      );
      return this.tableMeta.allColumns.filter((col) => !omitCols.has(col));
    }
    return null;
  }

  /** Convert camelCase field name to snake_case column name (unquoted, for non-SQL uses) */
  private toColumn(field: string): string {
    const mapped = this.tableMeta.columnMap[field];
    if (mapped) return mapped;
    return camelToSnake(field);
  }

  /** Convert camelCase field name to a double-quoted SQL identifier */
  private toSqlColumn(field: string): string {
    return quoteIdent(this.toColumn(field));
  }

  /** Build WHERE clause from a where object (supports operators, NULL, OR) */
  private buildWhere(where: WhereClause<T>): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const clause = this.buildWhereClause(where as Record<string, unknown>, params);
    if (!clause) return { sql: '', params: [] };
    return { sql: ` WHERE ${clause}`, params };
  }

  /**
   * Build the inner WHERE expression (without the WHERE keyword).
   * Returns null if no conditions exist.
   * Supports: equality, operators, NULL, OR, AND, NOT, relation filters (some/every/none).
   */
  private buildWhereClause(
    where: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    const keys = Object.keys(where);
    if (keys.length === 0) return null;

    const andClauses: string[] = [];

    for (const key of keys) {
      const value = where[key];
      if (value === undefined) continue;

      // Handle OR special key
      if (key === 'OR') {
        const orConditions = value as Record<string, unknown>[];
        if (!Array.isArray(orConditions) || orConditions.length === 0) continue;
        const orClauses: string[] = [];
        for (const orCond of orConditions) {
          const sub = this.buildWhereClause(orCond, params);
          if (sub) orClauses.push(sub);
        }
        if (orClauses.length > 0) {
          andClauses.push(`(${orClauses.join(' OR ')})`);
        }
        continue;
      }

      // Handle AND special key
      if (key === 'AND') {
        const andConditions = value as Record<string, unknown>[];
        if (!Array.isArray(andConditions) || andConditions.length === 0) continue;
        for (const andCond of andConditions) {
          const sub = this.buildWhereClause(andCond, params);
          if (sub) andClauses.push(sub);
        }
        continue;
      }

      // Handle NOT special key
      if (key === 'NOT') {
        const notCond = value as Record<string, unknown>;
        const sub = this.buildWhereClause(notCond, params);
        if (sub) andClauses.push(`NOT (${sub})`);
        continue;
      }

      // Handle relation filters: { posts: { some: { published: true } } }
      const relationDef = this.tableMeta.relations[key];
      if (relationDef && typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const filterObj = value as Record<string, unknown>;
        // Check if this is a relation filter (has some/every/none keys)
        if ('some' in filterObj || 'every' in filterObj || 'none' in filterObj) {
          const relClause = this.buildRelationFilter(key, relationDef, filterObj, params);
          if (relClause) andClauses.push(relClause);
          continue;
        }
      }

      const rawColumn = this.toColumn(key);
      const column = quoteIdent(rawColumn);

      // Handle null → IS NULL
      if (value === null) {
        andClauses.push(`${column} IS NULL`);
        continue;
      }

      // Handle JSONB filter operators (for json/jsonb columns)
      if (typeof value === 'object' && !Array.isArray(value) && isJsonFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType === 'json' || colType === 'jsonb') {
          const jsonClauses = this.buildJsonFilterClauses(column, value, params);
          andClauses.push(...jsonClauses);
          continue;
        }
      }

      // Handle Array filter operators (for array columns)
      if (typeof value === 'object' && !Array.isArray(value) && isArrayFilter(value)) {
        const colType = this.getColumnPgType(rawColumn);
        if (colType.startsWith('_')) {
          const arrayClauses = this.buildArrayFilterClauses(column, value, params, colType);
          andClauses.push(...arrayClauses);
          continue;
        }
      }

      // Handle operator objects
      if (isWhereOperator(value)) {
        const opClauses = this.buildOperatorClauses(column, value, params);
        andClauses.push(...opClauses);
        continue;
      }

      // Plain equality
      params.push(value);
      andClauses.push(`${column} = $${params.length}`);
    }

    if (andClauses.length === 0) return null;
    return andClauses.join(' AND ');
  }

  /**
   * Build relation filter SQL: WHERE EXISTS / NOT EXISTS subquery
   * Supports: some (EXISTS), every (NOT EXISTS ... NOT), none (NOT EXISTS)
   */
  private buildRelationFilter(
    _relName: string,
    relDef: RelationDef,
    filterObj: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    const targetTable = relDef.to;
    const targetMeta = this.schema.tables[targetTable];
    if (!targetMeta) return null;

    const qt = quoteIdent(targetTable);
    const qSelf = quoteIdent(this.table);
    const clauses: string[] = [];

    // Correlation: link child table to parent table
    let correlation: string;
    if (relDef.type === 'hasMany' || relDef.type === 'hasOne') {
      // parent.pk = child.fk
      correlation = `${qt}.${quoteIdent(relDef.foreignKey)} = ${qSelf}.${quoteIdent(relDef.referenceKey)}`;
    } else {
      // belongsTo: parent.fk = child.pk
      correlation = `${qt}.${quoteIdent(relDef.referenceKey)} = ${qSelf}.${quoteIdent(relDef.foreignKey)}`;
    }

    // "some": EXISTS (SELECT 1 FROM target WHERE correlation AND filter)
    if (filterObj.some !== undefined) {
      const subWhere = filterObj.some as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    // "none": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND filter)
    if (filterObj.none !== undefined) {
      const subWhere = filterObj.none as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      const fullWhere = filterClause ? `${correlation} AND ${filterClause}` : correlation;
      clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${fullWhere})`);
    }

    // "every": NOT EXISTS (SELECT 1 FROM target WHERE correlation AND NOT (filter))
    if (filterObj.every !== undefined) {
      const subWhere = filterObj.every as Record<string, unknown>;
      const filterClause = this.buildSubWhereForRelation(targetTable, subWhere, params);
      if (filterClause) {
        clauses.push(`NOT EXISTS (SELECT 1 FROM ${qt} WHERE ${correlation} AND NOT (${filterClause}))`);
      } else {
        // "every" with empty filter = true (all match trivially)
      }
    }

    return clauses.length > 0 ? clauses.join(' AND ') : null;
  }

  /**
   * Build WHERE clause conditions for a relation filter subquery.
   * Uses the target table's column mapping to resolve field names.
   */
  private buildSubWhereForRelation(
    targetTable: string,
    subWhere: Record<string, unknown>,
    params: unknown[],
  ): string | null {
    const meta = this.schema.tables[targetTable];
    if (!meta) return null;

    const qt = quoteIdent(targetTable);
    const conditions: string[] = [];

    for (const [field, value] of Object.entries(subWhere)) {
      if (value === undefined) continue;

      const col = meta.columnMap[field] ?? camelToSnake(field);
      const qCol = `${qt}.${quoteIdent(col)}`;

      if (value === null) {
        conditions.push(`${qCol} IS NULL`);
        continue;
      }

      if (isWhereOperator(value)) {
        const opClauses = this.buildOperatorClauses(qCol, value, params);
        conditions.push(...opClauses);
        continue;
      }

      params.push(value);
      conditions.push(`${qCol} = $${params.length}`);
    }

    return conditions.length > 0 ? conditions.join(' AND ') : null;
  }

  /**
   * Build SQL clauses for a single operator object on a column.
   * Each operator key becomes its own clause, all ANDed together.
   */
  private buildOperatorClauses(
    column: string,
    op: WhereOperator,
    params: unknown[],
  ): string[] {
    const clauses: string[] = [];

    if (op.gt !== undefined) {
      params.push(op.gt);
      clauses.push(`${column} > $${params.length}`);
    }
    if (op.gte !== undefined) {
      params.push(op.gte);
      clauses.push(`${column} >= $${params.length}`);
    }
    if (op.lt !== undefined) {
      params.push(op.lt);
      clauses.push(`${column} < $${params.length}`);
    }
    if (op.lte !== undefined) {
      params.push(op.lte);
      clauses.push(`${column} <= $${params.length}`);
    }
    if (op.not !== undefined) {
      if (op.not === null) {
        clauses.push(`${column} IS NOT NULL`);
      } else {
        params.push(op.not);
        clauses.push(`${column} != $${params.length}`);
      }
    }
    if (op.in !== undefined) {
      params.push(op.in);
      clauses.push(`${column} = ANY($${params.length})`);
    }
    if (op.notIn !== undefined) {
      params.push(op.notIn);
      clauses.push(`${column} != ALL($${params.length})`);
    }
    if (op.contains !== undefined) {
      params.push(`%${escapeLike(op.contains)}%`);
      clauses.push(`${column} LIKE $${params.length} ESCAPE '\\'`);
    }
    if (op.startsWith !== undefined) {
      params.push(`${escapeLike(op.startsWith)}%`);
      clauses.push(`${column} LIKE $${params.length} ESCAPE '\\'`);
    }
    if (op.endsWith !== undefined) {
      params.push(`%${escapeLike(op.endsWith)}`);
      clauses.push(`${column} LIKE $${params.length} ESCAPE '\\'`);
    }

    return clauses;
  }

  /** Build ORDER BY clause from an object */
  private buildOrderBy(orderBy: Record<string, OrderDirection>): string {
    return Object.entries(orderBy)
      .map(([key, dir]) => {
        const safeDir = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        return `${this.toSqlColumn(key)} ${safeDir}`;
      })
      .join(', ');
  }

  /** Parse a flat row: convert snake_case to camelCase + Date coercion */
  private parseRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    const meta = this.schema.tables[table];

    if (meta) {
      // Fast path: use pre-computed maps (avoids regex per column per row)
      const reverseMap = meta.reverseColumnMap;
      const dateCols = meta.dateColumns;

      const keys = Object.keys(row);
      for (let i = 0; i < keys.length; i++) {
        const col = keys[i]!;
        const value = row[col];
        const field = reverseMap[col] ?? col; // fall back to raw col name, not regex
        if (dateCols.has(col) && value !== null && !(value instanceof Date)) {
          parsed[field] = new Date(value as string);
        } else {
          parsed[field] = value;
        }
      }
    } else {
      // Fallback: no metadata, use regex conversion
      for (const [col, value] of Object.entries(row)) {
        parsed[snakeToCamel(col)] = value;
      }
    }
    return parsed;
  }

  /**
   * Fast path: parse a flat row when the table has NO date columns.
   * Only renames snake_case -> camelCase via the pre-computed reverseMap.
   * Skips all date coercion checks — avoids Set.has() per field per row.
   * Used by findUnique/findMany fast paths when hasNoDateColumns is true.
   */
  private parseRowFast(row: Record<string, unknown>): Record<string, unknown> {
    const parsed: Record<string, unknown> = {};
    const reverseMap = this.tableMeta.reverseColumnMap;
    const keys = Object.keys(row);
    for (let i = 0; i < keys.length; i++) {
      const col = keys[i]!;
      parsed[reverseMap[col] ?? col] = row[col];
    }
    return parsed;
  }

  /** Parse a row that may contain JSON nested relation columns */
  private parseNestedRow(row: Record<string, unknown>, table: string): Record<string, unknown> {
    const parsed = this.parseRow(row, table);
    const meta = this.schema.tables[table];
    if (!meta) return parsed;

    for (const [relName, relDef] of Object.entries(meta.relations)) {
      const rawValue = row[relName];
      if (rawValue !== undefined) {
        if (typeof rawValue === 'string') {
          try {
            parsed[relName] = JSON.parse(rawValue);
          } catch {
            parsed[relName] = rawValue;
          }
        } else if (Array.isArray(rawValue)) {
          parsed[relName] = rawValue.map((item) =>
            typeof item === 'object' && item !== null
              ? this.parseRow(item as Record<string, unknown>, relDef.to)
              : item,
          );
        } else if (typeof rawValue === 'object' && rawValue !== null) {
          parsed[relName] = this.parseRow(rawValue as Record<string, unknown>, relDef.to);
        } else {
          parsed[relName] = rawValue;
        }
      }
    }

    return parsed;
  }

  /**
   * Build a SELECT clause with nested relation subqueries.
   *
   * Uses json_build_object + json_agg — the same approach as the raw-pg benchmark
   * queries. Generates a single SQL statement that resolves the full object tree.
   *
   * Nested where values are parameterized via the shared params array to prevent
   * SQL injection.
   */
  private buildSelectWithRelations(
    table: string,
    withClause: WithClause,
    params: unknown[],
    columnsList?: string[] | null,
  ): string {
    const meta = this.schema.tables[table];
    if (!meta) throw new Error(`[turbine] Unknown table "${table}"`);

    const cols = columnsList ?? meta.allColumns;
    const qtbl = quoteIdent(table);
    const baseCols = cols
      .map((col) => `${qtbl}.${quoteIdent(col)}`)
      .join(', ');

    const relationSelects: string[] = [];
    const aliasCounter = { n: 0 };

    for (const [relName, relSpec] of Object.entries(withClause)) {
      const relDef = meta.relations[relName];
      if (!relDef) {
        throw new Error(
          `[turbine] Unknown relation "${relName}" on table "${table}". ` +
            `Available: ${Object.keys(meta.relations).join(', ')}`,
        );
      }

      // The main table is not aliased, so pass table name as parentRef
      const subquery = this.buildRelationSubquery(relDef, relSpec, params, table, aliasCounter);
      relationSelects.push(`(${subquery}) AS ${quoteIdent(relName)}`);
    }

    return [baseCols, ...relationSelects].join(', ');
  }

  /**
   * Build a json_agg subquery for a relation.
   *
   * All user-supplied values in nested where clauses are parameterized
   * through the shared params array — no string interpolation.
   *
   * @param parentRef - The alias (or table name) of the parent in the outer query.
   *                    Used for the correlated WHERE clause: `child.fk = parentRef.pk`.
   * @param aliasCounter - Shared counter for generating unique aliases across nested levels.
   */
  private buildRelationSubquery(
    relDef: RelationDef,
    spec: true | WithOptions,
    params: unknown[],
    parentRef: string,
    aliasCounter: { n: number },
  ): string {
    const targetTable = relDef.to;
    const targetMeta = this.schema.tables[targetTable];
    if (!targetMeta) throw new Error(`[turbine] Unknown relation target "${targetTable}"`);

    // Generate a unique alias: t0, t1, t2, ...
    const alias = `t${aliasCounter.n++}`;

    // Resolve which columns to include based on select/omit
    let targetColumns = targetMeta.allColumns;
    if (spec !== true && spec.select) {
      const selectedFields = Object.entries(spec.select)
        .filter(([, v]) => v)
        .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k));
      targetColumns = selectedFields.filter((col) => targetMeta.allColumns.includes(col));
    } else if (spec !== true && spec.omit) {
      const omittedFields = new Set(
        Object.entries(spec.omit)
          .filter(([, v]) => v)
          .map(([k]) => targetMeta.columnMap[k] ?? camelToSnake(k)),
      );
      targetColumns = targetMeta.allColumns.filter((col) => !omittedFields.has(col));
    }

    // Build json_build_object pairs for resolved columns
    const jsonPairs = targetColumns.map(
      (col) => `'${targetMeta.reverseColumnMap[col] ?? snakeToCamel(col)}', ${alias}.${quoteIdent(col)}`,
    );

    // Nested relations?
    if (spec !== true && spec.with) {
      for (const [nestedRelName, nestedSpec] of Object.entries(spec.with)) {
        const nestedRelDef = targetMeta.relations[nestedRelName];
        if (!nestedRelDef) {
          throw new Error(
            `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
              `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
          );
        }
        // Recursively build nested subquery, passing THIS alias as the parent reference
        const nestedSubquery = this.buildRelationSubquery(
          nestedRelDef, nestedSpec, params, alias, aliasCounter,
        );
        jsonPairs.push(`'${nestedRelName}', COALESCE((${nestedSubquery}), '[]'::json)`);
      }
    }

    const jsonObj = `json_build_object(${jsonPairs.join(', ')})`;

    // Quote parent ref — can be a table name or auto-generated alias
    const qParent = quoteIdent(parentRef);
    const qTarget = quoteIdent(targetTable);

    // Build ORDER BY for json_agg
    let orderClause = '';
    if (spec !== true && spec.orderBy) {
      const orders = Object.entries(spec.orderBy)
        .map(([k, dir]) => {
          const col = camelToSnake(k);
          if (!targetMeta.allColumns.includes(col)) {
            throw new Error(`[turbine] Unknown column "${k}" in orderBy for table "${targetTable}"`);
          }
          const safeDir = dir.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
          return `${alias}.${quoteIdent(col)} ${safeDir}`;
        })
        .join(', ');
      orderClause = ` ORDER BY ${orders}`;
    }

    // Build WHERE — correlate to parent via parentRef (alias or table name).
    // For hasMany: target has FK, so alias.fk = parentRef.pk
    // For belongsTo: source has FK, so alias.pk = parentRef.fk (reversed)
    let whereClause: string;
    if (relDef.type === 'belongsTo' || relDef.type === 'hasOne') {
      whereClause = `${alias}.${quoteIdent(relDef.referenceKey)} = ${qParent}.${quoteIdent(relDef.foreignKey)}`;
    } else {
      whereClause = `${alias}.${quoteIdent(relDef.foreignKey)} = ${qParent}.${quoteIdent(relDef.referenceKey)}`;
    }

    // Additional filters — properly parameterized
    if (spec !== true && spec.where) {
      for (const [k, v] of Object.entries(spec.where)) {
        const col = camelToSnake(k);
        if (!targetMeta.allColumns.includes(col)) {
          throw new Error(`[turbine] Unknown column "${k}" in where for table "${targetTable}"`);
        }
        params.push(v);
        whereClause += ` AND ${alias}.${quoteIdent(col)} = $${params.length}`;
      }
    }

    // LIMIT
    let limitClause = '';
    if (spec !== true && spec.limit) {
      params.push(Number(spec.limit));
      limitClause = ` LIMIT $${params.length}`;
    }

    if (relDef.type === 'hasMany') {
      // When LIMIT or ORDER BY is used, wrap in a subquery so LIMIT applies to rows
      // BEFORE json_agg aggregation (otherwise LIMIT on aggregated result is meaningless)
      if (limitClause || orderClause) {
        const innerAlias = `${alias}i`;
        // Rewrite: SELECT json_agg(json_build_object(...)) FROM (SELECT * FROM table WHERE ... ORDER BY ... LIMIT N) AS alias
        // Inner SELECT always needs all columns for WHERE/ORDER to work; json_build_object filters later
        const innerSql = `SELECT ${targetMeta.allColumns.map((c) => `${alias}.${quoteIdent(c)}`).join(', ')} FROM ${qTarget} ${alias} WHERE ${whereClause}${orderClause}${limitClause}`;
        // For the json_build_object, reference the inner alias — only include resolved columns
        const innerJsonPairs = targetColumns.map(
          (col) => `'${targetMeta.reverseColumnMap[col] ?? snakeToCamel(col)}', ${innerAlias}.${quoteIdent(col)}`,
        );
        // Re-add nested relation subqueries referencing innerAlias
        if (spec !== true && spec.with) {
          for (const [nestedRelName] of Object.entries(spec.with)) {
            const nestedRelDef = targetMeta.relations[nestedRelName];
            if (nestedRelDef) {
              const nestedSub = this.buildRelationSubquery(
                nestedRelDef, spec.with[nestedRelName]!, params, innerAlias, aliasCounter,
              );
              innerJsonPairs.push(`'${nestedRelName}', COALESCE((${nestedSub}), '[]'::json)`);
            }
          }
        }
        const innerJsonObj = `json_build_object(${innerJsonPairs.join(', ')})`;
        return `SELECT COALESCE(json_agg(${innerJsonObj}), '[]'::json) FROM (${innerSql}) ${innerAlias}`;
      }
      return `SELECT COALESCE(json_agg(${jsonObj}${orderClause}), '[]'::json) FROM ${qTarget} ${alias} WHERE ${whereClause}`;
    }

    // belongsTo / hasOne — return single object
    return `SELECT ${jsonObj} FROM ${qTarget} ${alias} WHERE ${whereClause} LIMIT 1`;
  }

  /**
   * Get the Postgres type for a column (e.g. 'jsonb', 'text', '_int4').
   * Used to detect JSONB/array columns for specialized operators.
   */
  private getColumnPgType(column: string): string {
    const col = this.tableMeta.columns.find((c) => c.name === column);
    return col?.pgType ?? 'text';
  }

  /**
   * Get the Postgres base element type for an array column.
   * E.g. '_text' → 'text', '_int4' → 'integer'
   */
  private getArrayElementType(pgType: string): string {
    const baseType = pgType.startsWith('_') ? pgType.slice(1) : pgType;
    const typeMap: Record<string, string> = {
      int2: 'smallint',
      int4: 'integer',
      int8: 'bigint',
      float4: 'real',
      float8: 'double precision',
      bool: 'boolean',
      text: 'text',
      varchar: 'text',
      uuid: 'uuid',
      timestamptz: 'timestamptz',
      timestamp: 'timestamp',
      jsonb: 'jsonb',
      json: 'json',
    };
    return typeMap[baseType] ?? 'text';
  }

  /**
   * Build SQL clauses for JSONB filter operators on a column.
   * Supports: path, equals, contains, hasKey.
   */
  private buildJsonFilterClauses(
    column: string,
    filter: JsonFilter,
    params: unknown[],
  ): string[] {
    const clauses: string[] = [];

    if (filter.path !== undefined && filter.equals !== undefined) {
      // Path access + equals: column #>> $N::text[] = $M
      params.push(filter.path);
      const pathParam = params.length;
      params.push(String(filter.equals));
      clauses.push(`${column} #>> $${pathParam}::text[] = $${params.length}`);
    } else if (filter.equals !== undefined) {
      // Containment equality: column @> $N::jsonb
      params.push(JSON.stringify(filter.equals));
      clauses.push(`${column} @> $${params.length}::jsonb`);
    }

    if (filter.contains !== undefined) {
      // Containment: column @> $N::jsonb
      params.push(JSON.stringify(filter.contains));
      clauses.push(`${column} @> $${params.length}::jsonb`);
    }

    if (filter.hasKey !== undefined) {
      // Key existence: column ? $N
      params.push(filter.hasKey);
      clauses.push(`${column} ? $${params.length}`);
    }

    return clauses;
  }

  /**
   * Build SQL clauses for Array filter operators on a column.
   * Supports: has, hasEvery, hasSome, isEmpty.
   */
  private buildArrayFilterClauses(
    column: string,
    filter: ArrayFilter,
    params: unknown[],
    pgType: string,
  ): string[] {
    const clauses: string[] = [];
    const elementType = this.getArrayElementType(pgType);

    if (filter.has !== undefined) {
      // value = ANY(column)
      params.push(filter.has);
      clauses.push(`$${params.length} = ANY(${column})`);
    }

    if (filter.hasEvery !== undefined) {
      // column @> ARRAY[...]::type[]
      params.push(filter.hasEvery);
      clauses.push(`${column} @> $${params.length}::${elementType}[]`);
    }

    if (filter.hasSome !== undefined) {
      // column && ARRAY[...]::type[]
      params.push(filter.hasSome);
      clauses.push(`${column} && $${params.length}::${elementType}[]`);
    }

    if (filter.isEmpty === true) {
      // array_length(column, 1) IS NULL
      clauses.push(`array_length(${column}, 1) IS NULL`);
    } else if (filter.isEmpty === false) {
      // array_length(column, 1) IS NOT NULL
      clauses.push(`array_length(${column}, 1) IS NOT NULL`);
    }

    return clauses;
  }

  /** Get the Postgres array type for a column (used by UNNEST in createMany) */
  private getColumnArrayType(column: string): string {
    // Find the column metadata
    const col = this.tableMeta.columns.find((c) => c.name === column);
    if (col) return col.pgArrayType;

    // Fallback heuristic
    if (column === 'id' || column.endsWith('_id')) return 'bigint[]';
    if (column.endsWith('_at')) return 'timestamptz[]';
    return 'text[]';
  }
}
