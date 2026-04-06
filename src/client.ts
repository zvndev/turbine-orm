/**
 * turbine-orm — TurbineClient
 *
 * The main entry point for the Turbine TypeScript SDK.
 * Manages connection pooling and provides typed table accessors.
 *
 * Schema-driven: call `table<T>(name)` to get a QueryInterface for any
 * table in the introspected schema. Generated clients extend this with
 * typed properties (e.g. `db.users`, `db.posts`).
 *
 * @example
 * ```ts
 * // With generated client (recommended):
 * import { turbine } from './generated/turbine';
 * const db = turbine({ connectionString: process.env.DATABASE_URL });
 * const user = await db.users.findUnique({ where: { id: 1 } });
 *
 * // With base client (dynamic):
 * import { TurbineClient } from 'turbine-orm';
 * const db = new TurbineClient({ connectionString: '...' }, schema);
 * const users = db.table<User>('users');
 * ```
 */

import pg from 'pg';
import { TimeoutError, wrapPgError } from './errors.js';
import { executePipeline, type PipelineResults } from './pipeline.js';
import { type DeferredQuery, QueryInterface, type QueryInterfaceOptions } from './query.js';
import type { SchemaMetadata } from './schema.js';

/**
 * Parse int8 (bigint, OID 20) as JavaScript number instead of string.
 * Safe for values up to Number.MAX_SAFE_INTEGER (9,007,199,254,740,991).
 *
 * NOTE: For values exceeding Number.MAX_SAFE_INTEGER, the parser falls back
 * to returning the raw string to avoid precision loss. The generated TypeScript
 * type maps int8/bigint to `number`, which is correct for the vast majority of
 * use cases (IDs, counts, timestamps). If you store values > 2^53 - 1 in a
 * bigint column, the runtime return type will be `string` for those rows.
 */
pg.types.setTypeParser(20, (val: string) => {
  const n = Number(val);
  return Number.isSafeInteger(n) ? n : val; // fall back to string for huge values
});

// NOTE: We intentionally do NOT register a parser for numeric (OID 1700).
// Postgres numeric is arbitrary-precision, so the default pg driver behavior
// of returning a string is correct and matches the generated TypeScript type
// (numeric → string). Users who want number can cast explicitly in SQL.

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface TurbineConfig {
  /** Postgres connection string (e.g. postgres://user:pass@host:5432/db) */
  connectionString?: string;
  /** Host (used if connectionString is not set) */
  host?: string;
  /** Port (default: 5432) */
  port?: number;
  /** Database name */
  database?: string;
  /** Username */
  user?: string;
  /** Password */
  password?: string;
  /** Maximum number of connections in the pool (default: 10) */
  poolSize?: number;
  /** Idle timeout in ms before a connection is closed (default: 30000) */
  idleTimeoutMs?: number;
  /** Connection timeout in ms (default: 5000) */
  connectionTimeoutMs?: number;
  /** Enable query logging to console (default: false) */
  logging?: boolean;
  /** Default LIMIT applied to findMany() when no limit is specified (opt-in, default: undefined) */
  defaultLimit?: number;
  /** Log a warning when findMany() is called without a limit (default: false) */
  warnOnUnlimited?: boolean;
}

// ---------------------------------------------------------------------------
// Middleware types
// ---------------------------------------------------------------------------

/** Parameters passed to middleware functions */
export interface MiddlewareParams {
  /** The table/model being queried (e.g. 'users') */
  model: string;
  /** The operation being performed (e.g. 'findUnique', 'create', 'update') */
  action: string;
  /** The arguments passed to the query method */
  args: Record<string, unknown>;
}

/** The next function in the middleware chain */
export type MiddlewareNext = (params: MiddlewareParams) => Promise<unknown>;

/** A middleware function that intercepts queries */
export type Middleware = (params: MiddlewareParams, next: MiddlewareNext) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Transaction types
// ---------------------------------------------------------------------------

export interface TransactionOptions {
  /** Timeout in ms — transaction will be rolled back if exceeded */
  timeout?: number;
  /** Isolation level for the transaction */
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
}

/** Maps isolation level names to SQL */
const ISOLATION_LEVELS: Record<string, string> = {
  ReadUncommitted: 'READ UNCOMMITTED',
  ReadCommitted: 'READ COMMITTED',
  RepeatableRead: 'REPEATABLE READ',
  Serializable: 'SERIALIZABLE',
};

// ---------------------------------------------------------------------------
// TransactionClient — provides typed table accessors within a transaction
// ---------------------------------------------------------------------------

/**
 * A transaction-scoped client that provides the same table accessor API as TurbineClient.
 * All queries run on a dedicated connection within a BEGIN/COMMIT block.
 * Supports nested transactions via SAVEPOINTs.
 */
export class TransactionClient {
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  private savepointCounter = 0;

  constructor(
    private readonly client: pg.PoolClient,
    readonly schema: SchemaMetadata,
    private readonly middlewares: Middleware[],
    private readonly queryOptions?: QueryInterfaceOptions,
  ) {
    // Auto-create typed table accessors for all tables in the schema
    for (const tableName of Object.keys(schema.tables)) {
      const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!(camelName in this)) {
        Object.defineProperty(this, camelName, {
          get: () => this.table(tableName),
          enumerable: true,
        });
      }
    }
  }

  /**
   * Get a QueryInterface for a table within this transaction.
   * Uses the dedicated transaction connection instead of the pool.
   */
  table<T extends object = Record<string, unknown>>(name: string): QueryInterface<T> {
    let qi = this.tableCache.get(name);
    if (!qi) {
      // Create a QueryInterface that uses the transaction client as its "pool"
      // We use a proxy pool that routes queries through the transaction client
      const txPool = this.createTxPool();
      qi = new QueryInterface<object>(txPool, name, this.schema, this.middlewares, this.queryOptions);
      this.tableCache.set(name, qi);
    }
    return qi as QueryInterface<T>;
  }

  /**
   * Execute a nested transaction via SAVEPOINT.
   * If the inner function throws, only the savepoint is rolled back.
   */
  async $transaction<R>(fn: (tx: TransactionClient) => Promise<R>): Promise<R> {
    const savepointName = `sp_${++this.savepointCounter}`;
    await this.client.query(`SAVEPOINT ${savepointName}`);
    try {
      const result = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (err) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw err;
    }
  }

  /**
   * Execute a raw SQL query within this transaction.
   */
  async raw<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    let sql = '';
    strings.forEach((str, i) => {
      sql += str;
      if (i < values.length) {
        sql += `$${i + 1}`;
      }
    });
    try {
      const result = await this.client.query(sql, values);
      return result.rows as T[];
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  /**
   * Create a pool-like wrapper around the transaction client.
   * This allows QueryInterface to work with the transaction connection
   * without knowing it's in a transaction.
   *
   * pg driver errors thrown by queries are translated into typed Turbine
   * errors via wrapPgError so transaction-scoped queries surface the same
   * typed errors as pool-scoped queries.
   */
  private createTxPool(): pg.Pool {
    const client = this.client;
    // Return a minimal pool-compatible object that routes queries
    // through the transaction client
    return {
      query: async (text: string, values?: unknown[]) => {
        try {
          return await client.query(text, values);
        } catch (err) {
          throw wrapPgError(err);
        }
      },
      connect: () => Promise.resolve(client),
    } as unknown as pg.Pool;
  }
}

// ---------------------------------------------------------------------------
// TurbineClient
// ---------------------------------------------------------------------------

export class TurbineClient {
  /** The underlying pg.Pool — exposed for escape hatches */
  readonly pool: pg.Pool;

  /** The schema metadata this client was built from */
  readonly schema: SchemaMetadata;

  private readonly logging: boolean;
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  private readonly middlewares: Middleware[] = [];
  private readonly queryOptions: QueryInterfaceOptions;

  constructor(config: TurbineConfig = {}, schema: SchemaMetadata) {
    this.logging = config.logging ?? false;
    this.schema = schema;
    this.queryOptions = {
      defaultLimit: config.defaultLimit,
      warnOnUnlimited: config.warnOnUnlimited,
    };

    const poolConfig: pg.PoolConfig = {
      max: config.poolSize ?? 10,
      idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
      connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
    };

    if (config.connectionString) {
      poolConfig.connectionString = config.connectionString;
    } else {
      poolConfig.host = config.host ?? 'localhost';
      poolConfig.port = config.port ?? 5432;
      poolConfig.database = config.database ?? 'postgres';
      poolConfig.user = config.user ?? 'postgres';
      poolConfig.password = config.password;
    }

    this.pool = new pg.Pool(poolConfig);

    this.pool.on('error', (err) => {
      console.error('[turbine] Unexpected pool error:', err.message);
    });

    if (this.logging) {
      console.log(
        `[turbine] Pool created — max ${poolConfig.max} connections, ${Object.keys(schema.tables).length} tables`,
      );
    }

    // Auto-create typed table accessors for all tables in the schema
    for (const tableName of Object.keys(schema.tables)) {
      const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (!(camelName in this)) {
        Object.defineProperty(this, camelName, {
          get: () => this.table(tableName),
          enumerable: true,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Middleware — intercept all queries
  // -------------------------------------------------------------------------

  /**
   * Register a middleware function that runs before/after every query.
   *
   * Middleware can inspect and log query parameters, modify results after execution,
   * and measure timing. Note: query SQL is generated before middleware runs, so
   * modifying params.args in middleware will NOT affect the executed SQL.
   * To intercept queries before SQL generation, use the raw() method instead.
   *
   * @example
   * ```ts
   * // Query timing middleware
   * db.$use(async (params, next) => {
   *   const before = Date.now();
   *   const result = await next(params);
   *   console.log(`${params.model}.${params.action} took ${Date.now() - before}ms`);
   *   return result;
   * });
   *
   * // Soft-delete middleware
   * db.$use(async (params, next) => {
   *   if (params.action === 'findMany' || params.action === 'findUnique') {
   *     params.args.where = { ...params.args.where, deletedAt: null };
   *   }
   *   if (params.action === 'delete') {
   *     params.action = 'update';
   *     params.args = { where: params.args.where, data: { deletedAt: new Date() } };
   *   }
   *   return next(params);
   * });
   * ```
   */
  $use(middleware: Middleware): void {
    this.middlewares.push(middleware);
    // Clear table cache so new QueryInterfaces pick up the middleware
    this.tableCache.clear();
  }

  // -------------------------------------------------------------------------
  // Table accessor — creates QueryInterface for any table
  // -------------------------------------------------------------------------

  /**
   * Get a QueryInterface for a table.
   * Results are cached — calling `table('users')` twice returns the same instance.
   */
  table<T extends object = Record<string, unknown>>(name: string): QueryInterface<T> {
    let qi = this.tableCache.get(name);
    if (!qi) {
      qi = new QueryInterface<object>(this.pool, name, this.schema, this.middlewares, this.queryOptions);
      this.tableCache.set(name, qi);
    }
    return qi as QueryInterface<T>;
  }

  // -------------------------------------------------------------------------
  // Pipeline — batch multiple queries into one round-trip
  // -------------------------------------------------------------------------

  /**
   * Execute multiple queries in a single database round-trip.
   *
   * Pass the result of any `.build*()` method on a table accessor.
   */
  async pipeline<T extends readonly DeferredQuery<unknown>[]>(...queries: T): Promise<PipelineResults<T>> {
    if (this.logging) {
      console.log(`[turbine] Pipeline: ${queries.length} queries — ${queries.map((q) => q.tag).join(', ')}`);
    }
    return executePipeline(this.pool, queries);
  }

  // -------------------------------------------------------------------------
  // Raw SQL — tagged template literal escape hatch
  // -------------------------------------------------------------------------

  /**
   * Execute a raw SQL query with parameter interpolation via tagged templates.
   *
   * @example
   * ```ts
   * const result = await db.raw<{ day: Date; count: number }>`
   *   SELECT DATE_TRUNC('day', created_at) as day, COUNT(*)::int as count
   *   FROM posts WHERE org_id = ${orgId}
   *   GROUP BY day ORDER BY day
   * `;
   * ```
   */
  async raw<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    let sql = '';
    strings.forEach((str, i) => {
      sql += str;
      if (i < values.length) {
        sql += `$${i + 1}`;
      }
    });

    if (this.logging) {
      console.log(`[turbine] Raw SQL: ${sql.trim().substring(0, 120)}...`);
    }

    try {
      const result = await this.pool.query(sql, values);
      return result.rows as T[];
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Transaction support (raw — legacy)
  // -------------------------------------------------------------------------

  /**
   * Execute a function within a database transaction (raw pg.PoolClient).
   * For the typed API, use `$transaction()` instead.
   *
   * @example
   * ```ts
   * await db.transaction(async (client) => {
   *   await client.query('INSERT INTO users (name) VALUES ($1)', ['Alice']);
   * });
   * ```
   */
  async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // $transaction — Prisma-style typed transaction API
  // -------------------------------------------------------------------------

  /**
   * Execute a function within a database transaction with full typed table accessors.
   *
   * The `tx` object provides the same table accessor API as the main client.
   * Supports nested transactions via SAVEPOINTs, timeouts, and isolation levels.
   *
   * @example
   * ```ts
   * await db.$transaction(async (tx) => {
   *   const user = await tx.users.create({ data: { email: 'a@b.com' } });
   *   await tx.posts.create({ data: { userId: user.id, title: 'Hello' } });
   * });
   *
   * // With options:
   * await db.$transaction(async (tx) => {
   *   // ...
   * }, { timeout: 5000, isolationLevel: 'Serializable' });
   * ```
   */
  async $transaction<R>(fn: (tx: TransactionClient) => Promise<R>, options?: TransactionOptions): Promise<R> {
    const client = await this.pool.connect();
    const timeout = options?.timeout;

    try {
      // BEGIN with optional isolation level
      let beginSQL = 'BEGIN';
      if (options?.isolationLevel) {
        const level = ISOLATION_LEVELS[options.isolationLevel];
        if (level) beginSQL += ` ISOLATION LEVEL ${level}`;
      }
      await client.query(beginSQL);

      // Create the transaction client with typed table accessors
      const tx = new TransactionClient(client, this.schema, this.middlewares, this.queryOptions);

      // Dynamically attach table accessors to tx
      for (const tableName of Object.keys(this.schema.tables)) {
        const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if (!(camelName in tx)) {
          Object.defineProperty(tx, camelName, {
            get: () => tx.table(tableName),
            enumerable: true,
          });
        }
      }

      let result: R;

      if (timeout) {
        // Race between the function and a timeout
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new TimeoutError(timeout, 'Transaction'));
          }, timeout);
        });
        try {
          result = await Promise.race([fn(tx), timeoutPromise]);
        } finally {
          clearTimeout(timer);
        }
      } else {
        result = await fn(tx);
      }

      await client.query('COMMIT');

      if (this.logging) {
        console.log('[turbine] Transaction committed');
      }

      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      if (this.logging) {
        console.log('[turbine] Transaction rolled back');
      }
      throw err;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  /**
   * Test the database connection.
   * Throws if the connection fails.
   */
  async connect(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
      if (this.logging) {
        console.log('[turbine] Connection verified');
      }
    } finally {
      client.release();
    }
  }

  /**
   * Gracefully shut down the connection pool.
   */
  async disconnect(): Promise<void> {
    await this.pool.end();
    if (this.logging) {
      console.log('[turbine] Pool disconnected');
    }
  }

  /** Alias for disconnect() */
  async end(): Promise<void> {
    return this.disconnect();
  }

  /** Pool statistics for monitoring. */
  get stats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }
}
