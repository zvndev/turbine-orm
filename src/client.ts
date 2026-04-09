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
import { type ErrorMessageMode, setErrorMessageMode, TimeoutError, wrapPgError } from './errors.js';
import { executePipeline, type PipelineOptions, type PipelineResults, pipelineSupported } from './pipeline.js';
import { type DeferredQuery, QueryInterface, type QueryInterfaceOptions } from './query.js';
import type { SchemaMetadata } from './schema.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Minimal pg-compatible query result.
 * `pg.Pool`, `@neondatabase/serverless` Pool, `@vercel/postgres` Pool and
 * any driver speaking the node-postgres API all satisfy this shape.
 */
export interface PgCompatQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
  fields?: Array<{ name: string; dataTypeID: number }>;
}

/**
 * Minimal pg-compatible client used by TurbineClient for transactions.
 * `pg.PoolClient` satisfies this; so do Neon and Vercel's equivalents.
 */
export interface PgCompatPoolClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>>;
  release(err?: Error | boolean): void;
}

/**
 * Minimal pg-compatible pool. Pass any driver that satisfies this interface
 * via `TurbineConfig.pool` — lets Turbine run on Neon HTTP, Vercel Postgres,
 * Cloudflare Hyperdrive, or any other serverless Postgres driver.
 *
 * @example
 * ```ts
 * import { Pool } from '@neondatabase/serverless';
 * import { TurbineClient } from 'turbine-orm';
 *
 * const neonPool = new Pool({ connectionString: process.env.DATABASE_URL });
 * const db = new TurbineClient({ pool: neonPool }, schema);
 * ```
 */
export interface PgCompatPool {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>>;
  connect(): Promise<PgCompatPoolClient>;
  end(): Promise<void>;
  /** Optional — pools that expose stats (pg.Pool does; Neon HTTP does not) */
  readonly totalCount?: number;
  readonly idleCount?: number;
  readonly waitingCount?: number;
  /** Optional — pg.Pool supports 'error' event; HTTP drivers typically do not */
  on?(event: 'error', listener: (err: Error) => void): this;
}

export interface TurbineConfig {
  /**
   * An external pg-compatible pool. Use this to plug in serverless drivers
   * like `@neondatabase/serverless`, `@vercel/postgres`, or any other pg-API
   * compatible pool. When provided, all connection-string fields are ignored
   * and Turbine will NOT create its own pg.Pool.
   */
  pool?: PgCompatPool;
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
  /** SSL/TLS options for the connection (required for most cloud providers) */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string; key?: string; cert?: string };
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
  /**
   * Controls how `NotFoundError` (and other where-aware errors) format their
   * messages.
   *
   *   - `'safe'`    (default): the message includes only the keys of the where
   *     clause (e.g. `where: { id, email }`). Values are redacted to avoid
   *     leaking PII into error logs (Sentry, Datadog, etc.).
   *   - `'verbose'`: the message includes the full JSON-serialized where
   *     clause (e.g. `where: {"id":1,"email":"alice@x.com"}`).
   *
   * The full `where` object is always available as `err.where` for
   * programmatic access regardless of mode.
   */
  errorMessages?: ErrorMessageMode;
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

  private static int8ParserRegistered = false;
  private readonly logging: boolean;
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  private readonly middlewares: Middleware[] = [];
  private readonly queryOptions: QueryInterfaceOptions;
  /** True when Turbine created the pool and is responsible for tearing it down */
  private readonly ownsPool: boolean = true;

  constructor(config: TurbineConfig = {}, schema: SchemaMetadata) {
    /**
     * Parse int8 (bigint, OID 20) as JavaScript number instead of string.
     * Safe for values up to Number.MAX_SAFE_INTEGER (9,007,199,254,740,991).
     *
     * NOTE: For values exceeding Number.MAX_SAFE_INTEGER, the parser falls back
     * to returning the raw string to avoid precision loss. The generated TypeScript
     * type maps int8/bigint to `number`, which is correct for the vast majority of
     * use cases (IDs, counts, timestamps). If you store values > 2^53 - 1 in a
     * bigint column, the runtime return type will be `string` for those rows.
     *
     * NOTE: We intentionally do NOT register a parser for numeric (OID 1700).
     * Postgres numeric is arbitrary-precision, so the default pg driver behavior
     * of returning a string is correct and matches the generated TypeScript type
     * (numeric → string). Users who want number can cast explicitly in SQL.
     */
    // Only register the int8 parser when we own the pg driver. External
    // pools (Neon HTTP, Vercel Postgres) may ship their own pg-types fork
    // and rely on their own parser configuration — don't mutate global state
    // we don't own.
    if (!config.pool && !TurbineClient.int8ParserRegistered) {
      pg.types.setTypeParser(20, (val: string) => {
        const n = Number(val);
        return Number.isSafeInteger(n) ? n : val;
      });
      TurbineClient.int8ParserRegistered = true;
    }

    this.logging = config.logging ?? false;
    this.schema = schema;
    this.queryOptions = {
      defaultLimit: config.defaultLimit,
      warnOnUnlimited: config.warnOnUnlimited,
    };

    // Apply NotFoundError message redaction mode (default: safe — values are
    // stripped from messages to avoid leaking PII into error logs).
    if (config.errorMessages) {
      setErrorMessageMode(config.errorMessages);
    }

    if (config.pool) {
      // External pool — use directly. Turbine doesn't manage its lifecycle.
      this.pool = config.pool as unknown as pg.Pool;
      this.ownsPool = false;
      if (this.logging) {
        console.log(`[turbine] Using external pool — ${Object.keys(schema.tables).length} tables`);
      }
    } else {
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

      if (config.ssl !== undefined) {
        poolConfig.ssl = config.ssl;
      }

      this.pool = new pg.Pool(poolConfig);
      this.ownsPool = true;

      this.pool.on('error', (err) => {
        console.error('[turbine] Unexpected pool error:', err.message);
      });

      if (this.logging) {
        console.log(
          `[turbine] Pool created — max ${poolConfig.max} connections, ${Object.keys(schema.tables).length} tables`,
        );
      }
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
   * Two call styles:
   *   - `db.pipeline(q1, q2, q3)` — rest params (backward-compatible)
   *   - `db.pipeline([q1, q2, q3], { transactional: false })` — array + options
   *
   * On pg.Pool-backed connections with TCP, this uses the real Postgres
   * extended-query pipeline protocol (one TCP flush, one round-trip).
   * On HTTP-based drivers it falls back to sequential execution.
   */
  async pipeline<T extends readonly DeferredQuery<unknown>[]>(
    ...args: T | [T, PipelineOptions?]
  ): Promise<PipelineResults<T>> {
    let queries: T;
    let options: PipelineOptions | undefined;

    // Detect which overload was used
    if (
      args.length > 0 &&
      Array.isArray(args[0]) &&
      (args[0] as unknown[]).every(
        (item) => item && typeof item === 'object' && 'sql' in (item as Record<string, unknown>),
      )
    ) {
      // Array form: pipeline([q1, q2], opts?)
      queries = args[0] as unknown as T;
      options = args[1] as PipelineOptions | undefined;
    } else {
      // Rest-param form: pipeline(q1, q2, q3)
      queries = args as unknown as T;
    }

    if (this.logging) {
      console.log(`[turbine] Pipeline: ${queries.length} queries — ${queries.map((q) => q.tag).join(', ')}`);
    }
    return executePipeline(this.pool, queries, options);
  }

  /**
   * Check whether the underlying pool supports the real pipeline protocol.
   * Returns `true` for standard pg.Pool TCP connections, `false` for HTTP
   * drivers (Neon HTTP, Vercel Postgres, etc.) and mock pools.
   */
  async pipelineSupported(): Promise<boolean> {
    return pipelineSupported(this.pool);
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

    /**
     * Track whether the connection has already been released so the finally
     * block doesn't double-release. When a timeout fires we destroy the
     * connection eagerly to abort the in-flight backend query.
     */
    let released = false;
    const releaseOnce = (err?: Error | boolean): void => {
      if (released) return;
      released = true;
      try {
        client.release(err);
      } catch {
        // pg may throw if the client is already released — swallow.
      }
    };

    let timedOut = false;

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
        // Race between the function and a timeout. If the timeout fires we
        // need to actually abort the in-flight query — otherwise the backend
        // keeps running until pg's own timeout, holding a pool slot the whole
        // time. The simplest reliable cancellation is to destroy the
        // connection: passing a truthy argument to client.release() tells the
        // pg pool to discard the client (its socket is closed, which causes
        // Postgres to abort the active query and roll back the transaction).
        // The pool will spin up a fresh connection on the next checkout.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            // Destroy the connection to abort the in-flight backend query.
            // We do this BEFORE rejecting so the socket is gone by the time
            // the caller's catch block runs.
            releaseOnce(new Error('[turbine] Transaction timeout — connection destroyed'));
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
      // If the timeout fired we already destroyed the connection — issuing a
      // ROLLBACK on a released client would throw "Client has already been
      // released". Skip the rollback in that case (the backend rolled back
      // when its socket was closed).
      if (!timedOut && !released) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Best-effort rollback — the connection may have died mid-query.
        }
      }
      if (this.logging) {
        console.log('[turbine] Transaction rolled back');
      }
      throw err;
    } finally {
      releaseOnce();
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
   *
   * If Turbine was given an external pool via `TurbineConfig.pool`, this
   * method is a no-op — the caller is responsible for the pool's lifecycle.
   */
  async disconnect(): Promise<void> {
    if (!this.ownsPool) {
      if (this.logging) {
        console.log('[turbine] disconnect() skipped — external pool is not owned by Turbine');
      }
      return;
    }
    await this.pool.end();
    if (this.logging) {
      console.log('[turbine] Pool disconnected');
    }
  }

  /** Alias for disconnect() */
  async end(): Promise<void> {
    return this.disconnect();
  }

  /**
   * Pool statistics for monitoring. Returns zeros for pools that don't
   * expose connection counts (e.g., stateless HTTP drivers like Neon).
   */
  get stats() {
    return {
      totalCount: this.pool.totalCount ?? 0,
      idleCount: this.pool.idleCount ?? 0,
      waitingCount: this.pool.waitingCount ?? 0,
    };
  }
}
