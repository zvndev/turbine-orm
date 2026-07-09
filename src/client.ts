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
import { type Dialect, postgresDialect } from './dialect.js';
import {
  type ErrorMessageMode,
  setErrorMessageMode,
  TimeoutError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from './errors.js';
import { type ObserveConfig, ObserveEngine, type ObserveHandle } from './observe.js';
import { executePipeline, type PipelineOptions, type PipelineResults, pipelineSupported } from './pipeline.js';
import {
  type DeferredQuery,
  type GlobalFilters,
  type QueryEvent,
  type QueryEventListener,
  QueryInterface,
  type QueryInterfaceOptions,
  type RelationLoadStrategy,
} from './query/index.js';
import { quoteIdent } from './query/utils.js';
import {
  type ActiveSubscription,
  createSubscription,
  type NotificationHandler,
  type Subscription,
  validateChannel,
} from './realtime.js';
import type { SchemaMetadata } from './schema.js';
import { buildTypedSql, TypedSqlQuery } from './typed-sql.js';

// ---------------------------------------------------------------------------
// Retry utility
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxAttempts?: number;
  baseDelay?: number;
  maxDelay?: number;
  onRetry?: (error: unknown, attempt: number) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelay = options?.baseDelay ?? 50;
  const maxDelay = options?.maxDelay ?? 5000;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isRetryable =
        err &&
        typeof err === 'object' &&
        'isRetryable' in err &&
        (err as { isRetryable: unknown }).isRetryable === true;
      if (!isRetryable || attempt === maxAttempts - 1) throw err;
      options?.onRetry?.(err, attempt + 1);
      const delay = Math.min(baseDelay * 2 ** attempt + Math.random() * baseDelay, maxDelay);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

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

/**
 * Driver-neutral seam. Bundles a pg-compatible connection pool with the SQL
 * {@link Dialect} that owns every piece of SQL text varying across engines —
 * parameter placeholders, transaction-control keywords (BEGIN/COMMIT/ROLLBACK/
 * SAVEPOINT/isolation/set_config), streaming, and capability flags.
 *
 * This is the structural boundary that keeps hard-coded Postgres SQL out of
 * `client.ts`: the pool provides connect/query/transaction/close, the dialect
 * provides every literal keyword and the placeholder syntax. A future MySQL /
 * SQLite engine ships a `{ pool, dialect }` pair instead of a raw `pg.Pool`,
 * exactly as `turbineHttp` ships a serverless pool today.
 */
export interface TurbineDriver {
  /** The underlying pg-compatible connection pool (connect/query/transaction/close). */
  readonly pool: PgCompatPool;
  /** SQL dialect: placeholders, transaction keywords, session-config, capability flags. */
  readonly dialect: Dialect;
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
   * Interpret Postgres `timestamp` (without time zone) values as UTC — both
   * at the driver level (OID 1114 type parser, registered only when Turbine
   * owns the pool) and when coercing nested-relation JSON dates. This is the
   * Prisma/Rails/Django convention and makes results independent of the
   * server's local time zone. Default: `true`. Set `false` for the legacy
   * local-time interpretation.
   */
  utcTimestamps?: boolean;
  /**
   * Default strategy for resolving `with`-clause relations, applied to every
   * `findMany`/`findUnique`/`findFirst` unless overridden per query.
   *
   *   - `'join'` (default) — one SQL statement using correlated
   *     `json_agg(json_build_object(...))` subqueries.
   *   - `'batched'` — run the base query, then one flat follow-up query per
   *     relation (`WHERE fk = ANY($1)`), stitching children client-side. Wins
   *     when child FK columns are unindexed or result sets are large.
   *
   * Precedence: per-query `relationLoadStrategy` arg > this config > `'join'`.
   */
  relationLoadStrategy?: RelationLoadStrategy;
  /**
   * How nested-relation subqueries encode each row's JSON.
   *
   *   - `'object'` (default) — `json_agg(json_build_object('key', v, …))`. Every
   *     key name is repeated in every nested object of every row.
   *   - `'positional'` — `json_agg(json_build_array(v, …))`. Turbine knows the
   *     column order at build time, so it emits a key-less array and maps
   *     positions back to keys client-side. Same information, a fraction of the
   *     bytes on wide/deeply-nested `with` trees. Parsed output is byte-identical
   *     to `'object'`.
   *
   * Postgres-only in v1: setting `'positional'` on a non-Postgres engine throws
   * `UnsupportedFeatureError` (E017) when a `with` clause is present. Default:
   * `'object'` (today's behavior, byte-unchanged).
   */
  jsonEncoding?: 'object' | 'positional';
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
  /**
   * Enable prepared statements. Queries are submitted with `{ name, text, values }`
   * to the pg driver, which caches the parse+plan on the server per connection.
   *
   * Default: `true` for Turbine-owned pools, `false` for external pools (serverless
   * drivers may not support named statements).
   *
   * Override with `TURBINE_DISABLE_PREPARED=1` env var.
   */
  preparedStatements?: boolean;
  /**
   * Enable the SQL template cache. Repeated queries with the same shape reuse
   * cached SQL text instead of rebuilding from scratch.
   *
   * Default: `true`. Set to `false` as a nuclear kill switch.
   */
  sqlCache?: boolean;
  /** SQL dialect implementation. Defaults to PostgreSQL. Internal Phase-1 seam for dialect packages. */
  dialect?: Dialect;
  /**
   * Read replicas. When set, read-only operations issued outside a transaction
   * (`findMany`, `findFirst`, `findUnique`, `*OrThrow`, `count`, `aggregate`,
   * `groupBy`, `findManyStream`) are round-robin load-balanced across these
   * pools; the primary handles them along with every write. ALL writes,
   * `$transaction` bodies, `pipeline`, `raw`/`sql`, `$listen`/`$notify`, and
   * observability flushes always use the primary.
   *
   *   - `string` entries are connection strings — Turbine constructs an owned
   *     `pg.Pool` for each (same pool-tuning knobs as the primary, and the same
   *     one-time, constructor-gated type-parser registration). `disconnect()`
   *     closes them.
   *   - `PgCompatPool` entries are external pools (Neon, Vercel, a shared
   *     `pg.Pool`) — Turbine registers no type parsers on them and never ends
   *     them; the caller owns their lifecycle.
   *
   * Use `client.$primary()` to get a view of the client that pins every
   * operation (reads included) to the primary — e.g. to read your own write
   * without replication lag. Omitting `replicas` (or passing `[]`) leaves the
   * default single-pool path completely unchanged.
   */
  replicas?: readonly (string | PgCompatPool)[];
  /**
   * Automatic WHERE filters applied to every query, keyed by table accessor
   * (`db[name]`). Each value is AND-merged into the compiled WHERE of every
   * read and mutation on that table — and into every relation subquery that
   * targets it — implementing soft-delete and multi-tenancy without repeating
   * the predicate at each call site.
   *
   *   - A `WhereClause` value is a static filter (e.g. `{ deletedAt: null }`).
   *   - A `() => WhereClause` value is evaluated at query-build time, so a
   *     closure over per-request state (the current tenant id) yields a
   *     request-scoped filter.
   *
   * `create`/`createMany` are never filtered. A per-query
   * `skipGlobalFilters: true | string[]` opts out. The empty-`where` guard on
   * `update`/`delete` still checks the USER-supplied `where`, so a global
   * filter never turns an unguarded mass mutation into an allowed one.
   *
   * @example
   * ```ts
   * const db = turbine({ url, schema, globalFilters: {
   *   posts: { deletedAt: null },              // soft-delete
   *   orders: () => ({ tenantId: currentTenant() }), // per-request tenancy
   * }});
   * ```
   */
  globalFilters?: GlobalFilters;
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
  /**
   * Transaction-local session GUCs to set after BEGIN. The canonical use case
   * is multi-tenant Postgres row-level security (RLS): your policies filter on
   * `current_setting('app.current_tenant')`, and you set that value here so
   * every query inside the transaction sees it.
   *
   * Each entry is applied via `SELECT set_config($1, $2, true)` — `is_local=true`
   * scopes the value to this transaction, so it auto-resets on COMMIT/ROLLBACK
   * and never leaks onto the pooled connection. Both the name and value are
   * bound parameters (never interpolated); the GUC name is additionally
   * validated against a strict identifier regex.
   *
   * @example
   * ```ts
   * await db.$transaction(
   *   async (tx) => {
   *     // every query here sees current_setting('app.current_tenant') = '42'
   *     return tx.invoices.findMany();
   *   },
   *   { sessionContext: { 'app.current_tenant': '42', 'app.current_user': userId } },
   * );
   * ```
   */
  sessionContext?: Record<string, string | number | boolean>;
}

/** Maps isolation level names to SQL */
const ISOLATION_LEVELS: Record<string, string> = {
  ReadUncommitted: 'READ UNCOMMITTED',
  ReadCommitted: 'READ COMMITTED',
  RepeatableRead: 'REPEATABLE READ',
  Serializable: 'SERIALIZABLE',
};

/**
 * Strict GUC (session variable) name: an optionally namespaced identifier such
 * as `app.current_tenant` or `search_path`. Even though the name is passed as a
 * bound parameter to `set_config`, a malformed name is a programmer error worth
 * rejecting loudly before it reaches the database.
 */
const GUC_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * The read-only `QueryInterface` operations that a read-replica setup may route
 * to a replica pool. Every other method (all writes, plus internals) stays on
 * the primary. Kept as a Set so the routing proxy's `get` trap is O(1).
 */
const READ_OPERATIONS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findUnique',
  'findFirstOrThrow',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
  'findManyStream',
]);

/**
 * Internal marker on the config object that tells the `TurbineClient`
 * constructor to build a lightweight "primary-only" view sharing an existing
 * client's primary pool, dialect, query options, and middleware — instead of
 * creating a fresh pool. Produced solely by `$primary()`; never public.
 */
const PRIMARY_VIEW = Symbol('turbine.primaryView');

interface PrimaryViewSeed {
  parent: TurbineClient;
}

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
  /** Active SQL dialect — owns savepoint keywords and raw-SQL placeholders. */
  private readonly dialect: Dialect;

  constructor(
    private readonly client: pg.PoolClient,
    readonly schema: SchemaMetadata,
    private readonly middlewares: Middleware[],
    private readonly queryOptions?: QueryInterfaceOptions,
  ) {
    this.dialect = queryOptions?.dialect ?? postgresDialect;
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
      const txOpts = { ...this.queryOptions, _txScoped: true };
      qi = txOpts.queryInterfaceFactory
        ? txOpts.queryInterfaceFactory(txPool, name, this.schema, this.middlewares, txOpts)
        : new QueryInterface<object>(txPool, name, this.schema, this.middlewares, txOpts);
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
    await this.client.query(this.dialect.savepointStatement(savepointName));
    try {
      const result = await fn(this);
      await this.client.query(this.dialect.releaseSavepointStatement(savepointName));
      return result;
    } catch (err) {
      await this.client.query(this.dialect.rollbackToSavepointStatement(savepointName));
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
        sql += this.dialect.paramPlaceholder(i + 1);
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
      query: async (textOrConfig: string | { name?: string; text: string; values?: unknown[] }, values?: unknown[]) => {
        try {
          if (typeof textOrConfig === 'string') {
            return await client.query(textOrConfig, values);
          }
          // Object form for prepared statements: { name, text, values }
          // pg.PoolClient.query accepts QueryConfig but the overloads make TS
          // unhappy with the union, so we cast through unknown.
          return await (client as unknown as { query(config: unknown): Promise<pg.QueryResult> }).query(textOrConfig);
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
  private static utcTimestampParserRegistered = false;
  private readonly logging: boolean;
  /** Active SQL dialect — owns transaction keywords, set_config, raw-SQL placeholders, capability flags. */
  private readonly dialect: Dialect;
  private readonly tableCache = new Map<string, QueryInterface<object>>();
  private readonly middlewares: Middleware[] = [];
  private readonly queryListeners = new Set<QueryEventListener>();
  private queryOptions: QueryInterfaceOptions;
  private readonly errorMessagesSafe: boolean;
  /** True when Turbine created the pool and is responsible for tearing it down */
  private readonly ownsPool: boolean = true;
  /** Active LISTEN subscriptions — torn down on disconnect() so it never hangs */
  private readonly activeSubscriptions = new Set<ActiveSubscription>();

  /**
   * Read-replica pools in round-robin order. Empty when no replicas are
   * configured, in which case `table()` takes the original single-pool path.
   */
  private readonly replicaPools: PgCompatPool[];
  /**
   * The subset of {@link replicaPools} that Turbine created from connection
   * strings and must close on `disconnect()`. External replica pools are not
   * listed here (caller owns their lifecycle).
   */
  private readonly ownedReplicaPools: PgCompatPool[];
  /** Rotating index for round-robin replica selection (advances per read op). */
  private replicaCursor = 0;
  /** Per-replica `table → QueryInterface` caches, indexed like {@link replicaPools}. */
  private readonly replicaTableCaches: Array<Map<string, QueryInterface<object>>>;
  /** Cache of per-table routing proxies (only used when replicas are present). */
  private readonly routingProxyCache = new Map<string, QueryInterface<object>>();
  /** Lazily-built, cached primary-only view returned by {@link $primary}. */
  private primaryView?: TurbineClient;

  constructor(config: TurbineConfig = {}, schema: SchemaMetadata) {
    // Primary-only view: $primary() constructs this to share the parent's
    // primary pool + derived state instead of creating a fresh pool. It owns
    // no pool and no replicas, so every operation (reads included) runs on the
    // primary and disconnect() is a no-op on the shared pool.
    const seed = (config as Record<PropertyKey, unknown>)[PRIMARY_VIEW] as PrimaryViewSeed | undefined;
    if (seed) {
      const parent = seed.parent;
      this.schema = schema;
      this.logging = parent.logging;
      this.dialect = parent.dialect;
      this.errorMessagesSafe = parent.errorMessagesSafe;
      this.queryOptions = parent.queryOptions;
      this.middlewares = parent.middlewares; // shared reference: $use on parent flows through
      this.pool = parent.pool;
      this.ownsPool = false;
      this.replicaPools = [];
      this.ownedReplicaPools = [];
      this.replicaTableCaches = [];
      for (const tableName of Object.keys(schema.tables)) {
        const camelName = tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
        if (!(camelName in this)) {
          Object.defineProperty(this, camelName, {
            get: () => this.table(tableName),
            enumerable: true,
          });
        }
      }
      return;
    }
    // Constructing without schema metadata previously crashed deep in the
    // constructor with an opaque "Cannot read properties of undefined
    // (reading 'tables')". Fail fast with an actionable message instead.
    if (!schema || typeof schema !== 'object' || !schema.tables) {
      throw new ValidationError(
        '[turbine] TurbineClient requires schema metadata as its second argument. ' +
          'Run `npx turbine generate` and use the generated client (`turbine()` from your output dir), ' +
          'or pass the generated `schemaMetadata` object: new TurbineClient(config, schemaMetadata).',
      );
    }
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
    // Only register the int8 parser when the PRIMARY pool is Turbine-owned.
    // External pools (Neon HTTP, Vercel Postgres) may ship their own pg-types
    // fork and rely on their own parser configuration — registration is
    // process-global, so flipping it because a string replica exists alongside
    // an external primary would silently change the external primary's parsing
    // too. String replicas configured next to an external primary therefore
    // inherit the caller's parser configuration (documented). Registration is
    // constructor-gated by the static flags, so it happens at most once.
    const ownsAnyPool = !config.pool;
    if (ownsAnyPool && !TurbineClient.int8ParserRegistered) {
      pg.types.setTypeParser(20, (val: string) => {
        const n = Number(val);
        return Number.isSafeInteger(n) ? n : val;
      });
      TurbineClient.int8ParserRegistered = true;
    }
    // Parse `timestamp` (OID 1114) as UTC instead of server-local time. The
    // pg driver's default hands back a Date built in the process's local zone,
    // so the same row yields a different instant per deployment region. The
    // ORM convention (Prisma, Rails, Django) — and the only interpretation
    // that round-trips what Postgres stores — is UTC. Same ownership rule as
    // the int8 parser: never mutate parser state on external pools.
    if (ownsAnyPool && config.utcTimestamps !== false && !TurbineClient.utcTimestampParserRegistered) {
      pg.types.setTypeParser(1114, (val: string) => new Date(`${val.replace(' ', 'T')}Z`));
      TurbineClient.utcTimestampParserRegistered = true;
    }

    this.logging = config.logging ?? false;
    this.dialect = config.dialect ?? postgresDialect;
    this.schema = schema;
    // Respect env var kill switch
    const envDisablePrepared = typeof process !== 'undefined' && process.env?.TURBINE_DISABLE_PREPARED === '1';

    this.errorMessagesSafe = (config.errorMessages ?? 'safe') === 'safe';

    this.queryOptions = {
      defaultLimit: config.defaultLimit,
      warnOnUnlimited: config.warnOnUnlimited,
      utcTimestamps: config.utcTimestamps,
      relationLoadStrategy: config.relationLoadStrategy,
      jsonEncoding: config.jsonEncoding,
      globalFilters: config.globalFilters,
      preparedStatements: envDisablePrepared ? false : (config.preparedStatements ?? !config.pool),
      sqlCache: config.sqlCache ?? true,
      dialect: config.dialect,
      // Non-SQL backends (PowDB) inject a factory that builds their own query
      // interface (PowqlInterface) instead of the SQL QueryInterface. SQL engines
      // never set this, so `table()` keeps constructing `new QueryInterface`.
      queryInterfaceFactory: (config as { queryInterfaceFactory?: QueryInterfaceOptions['queryInterfaceFactory'] })
        .queryInterfaceFactory,
      _onQuery: (event: QueryEvent) => {
        if (this.queryListeners.size === 0) return;
        const emitted = this.errorMessagesSafe ? { ...event, params: event.params.map(() => '[REDACTED]') } : event;
        for (const listener of this.queryListeners) {
          try {
            listener(emitted);
          } catch (e) {
            if (this.logging) console.error('[turbine] Query listener error:', e);
          }
        }
      },
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

    // Build read-replica pools (if any). String entries become owned pg.Pools
    // sharing the primary's tuning knobs; PgCompatPool entries are external and
    // used as-is. Replica selection is round-robin in this array order.
    this.replicaPools = [];
    this.ownedReplicaPools = [];
    for (const replica of config.replicas ?? []) {
      if (typeof replica === 'string') {
        const replicaPool = new pg.Pool({
          connectionString: replica,
          max: config.poolSize ?? 10,
          idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
          connectionTimeoutMillis: config.connectionTimeoutMs ?? 5_000,
          ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
        });
        replicaPool.on('error', (err) => {
          console.error('[turbine] Unexpected replica pool error:', err.message);
        });
        this.replicaPools.push(replicaPool as unknown as PgCompatPool);
        this.ownedReplicaPools.push(replicaPool as unknown as PgCompatPool);
      } else {
        this.replicaPools.push(replica);
      }
    }
    this.replicaTableCaches = this.replicaPools.map(() => new Map<string, QueryInterface<object>>());
    if (this.logging && this.replicaPools.length > 0) {
      console.log(
        `[turbine] ${this.replicaPools.length} read replica(s) configured (${this.ownedReplicaPools.length} owned)`,
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

    // Auto-start observability from env var
    const observeUrl = typeof process !== 'undefined' ? process.env?.TURBINE_OBSERVE_URL : undefined;
    if (observeUrl) {
      this.$observe({ connectionString: observeUrl }).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Middleware — intercept all queries
  // -------------------------------------------------------------------------

  /**
   * Register a middleware function that runs around every query.
   *
   * Middleware can inspect and log query parameters, measure timing, and
   * transform the result returned by `next()`. Note: query SQL is generated
   * BEFORE middleware runs — `params.args` is a read-only snapshot, and
   * mutating it does NOT change the executed SQL. Cross-cutting filters
   * (e.g. soft deletes) belong in the query itself: pass an explicit
   * `where: { deletedAt: null }` or wrap the table accessor in a small helper.
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
   * // Result transformation middleware — redact a field on the way out
   * db.$use(async (params, next) => {
   *   const result = await next(params);
   *   if (params.model === 'users' && Array.isArray(result)) {
   *     for (const row of result as { email?: string }[]) row.email = '[redacted]';
   *   }
   *   return result;
   * });
   * ```
   */
  $use(middleware: Middleware): void {
    this.middlewares.push(middleware);
    // Clear table caches so new QueryInterfaces pick up the middleware. Covers
    // the primary cache plus, when replicas are configured, the routing proxies
    // and per-replica caches. The primary-view (if built) shares the middleware
    // array by reference, so its QueryInterfaces observe the new middleware too.
    this.tableCache.clear();
    this.routingProxyCache.clear();
    for (const cache of this.replicaTableCaches) cache.clear();
  }

  // -------------------------------------------------------------------------
  // Event emitter — subscribe to query lifecycle events
  // -------------------------------------------------------------------------

  $on(_event: 'query', listener: QueryEventListener): void {
    this.queryListeners.add(listener);
  }

  $off(_event: 'query', listener: QueryEventListener): void {
    this.queryListeners.delete(listener);
  }

  // -------------------------------------------------------------------------
  // Observability — automatic metrics collection
  // -------------------------------------------------------------------------

  private observeEngine?: ObserveEngine;

  async $observe(config: ObserveConfig): Promise<ObserveHandle> {
    if (this.observeEngine) {
      await this.observeEngine.stop();
      this.$off('query', this.observeEngine.getListener());
    }
    const engine = new ObserveEngine(config);
    this.observeEngine = engine;
    await engine.init();
    this.$on('query', engine.getListener());
    return {
      stop: async () => {
        this.$off('query', engine.getListener());
        await engine.stop();
        if (this.observeEngine === engine) this.observeEngine = undefined;
      },
    };
  }

  // -------------------------------------------------------------------------
  // Table accessor — creates QueryInterface for any table
  // -------------------------------------------------------------------------

  /**
   * Get a QueryInterface for a table.
   * Results are cached — calling `table('users')` twice returns the same instance.
   *
   * When read replicas are configured, this returns a thin routing proxy: the
   * read-only operations in {@link READ_OPERATIONS} are dispatched to a
   * round-robin replica-bound QueryInterface (so an entire read — base rows and
   * any batched sub-queries — runs against a single consistent replica), while
   * writes and every other member fall through to the primary-bound instance.
   * With no replicas the original single-pool instance is returned directly.
   */
  table<T extends object = Record<string, unknown>>(name: string): QueryInterface<T> {
    if (this.replicaPools.length === 0) {
      return this.primaryTableQI(name) as QueryInterface<T>;
    }
    let proxy = this.routingProxyCache.get(name);
    if (!proxy) {
      proxy = this.createRoutingAccessor(name);
      this.routingProxyCache.set(name, proxy);
    }
    return proxy as QueryInterface<T>;
  }

  /** Get (and cache) the primary-pool-bound QueryInterface for a table. */
  private primaryTableQI(name: string): QueryInterface<object> {
    let qi = this.tableCache.get(name);
    if (!qi) {
      qi = this.buildTableQI(this.pool, name);
      this.tableCache.set(name, qi);
    }
    return qi;
  }

  /**
   * Advance the round-robin cursor and return the QueryInterface bound to the
   * selected replica pool for `name` (cached per replica).
   */
  private nextReplicaTableQI(name: string): QueryInterface<object> {
    const index = this.replicaCursor % this.replicaPools.length;
    // Reset before overflow so the cursor never grows unbounded.
    this.replicaCursor = this.replicaCursor + 1 >= Number.MAX_SAFE_INTEGER ? 0 : this.replicaCursor + 1;
    // index is always in-bounds (`% length`); the pools/cache entries exist.
    const cache = this.replicaTableCaches[index] as Map<string, QueryInterface<object>>;
    const pool = this.replicaPools[index] as PgCompatPool;
    let qi = cache.get(name);
    if (!qi) {
      qi = this.buildTableQI(pool, name);
      cache.set(name, qi);
    }
    return qi;
  }

  /** Construct a QueryInterface bound to `pool` (honoring any injected factory). */
  private buildTableQI(pool: PgCompatPool, name: string): QueryInterface<object> {
    const asPgPool = pool as unknown as pg.Pool;
    return this.queryOptions?.queryInterfaceFactory
      ? this.queryOptions.queryInterfaceFactory(asPgPool, name, this.schema, this.middlewares, this.queryOptions)
      : new QueryInterface<object>(asPgPool, name, this.schema, this.middlewares, this.queryOptions);
  }

  /**
   * Build the read/write routing proxy for a table. The proxy targets the
   * primary QueryInterface (so writes, `build*`, and every non-read member work
   * unchanged); read operations are intercepted and dispatched to a replica.
   */
  private createRoutingAccessor(name: string): QueryInterface<object> {
    const primaryQI = this.primaryTableQI(name);
    const client = this;
    return new Proxy(primaryQI, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && READ_OPERATIONS.has(prop)) {
          // Pick the replica at CALL time so round-robin advances per operation.
          return (...args: unknown[]) => {
            const replicaQI = client.nextReplicaTableQI(name) as unknown as Record<
              string,
              ((...a: unknown[]) => unknown) | undefined
            >;
            const method = replicaQI[prop];
            if (typeof method !== 'function') {
              return Reflect.get(target, prop, receiver);
            }
            return method.apply(replicaQI, args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as QueryInterface<object>;
  }

  /**
   * Return a view of this client that pins EVERY operation — reads included —
   * to the primary pool, bypassing replica routing. Use it to read your own
   * write without replication lag, or for any read that must see the latest
   * committed data.
   *
   * The view shares the primary pool, schema, dialect, query options, and
   * middleware; it owns nothing, so its `disconnect()` is a no-op. When no
   * replicas are configured this simply returns the client itself (already
   * primary-only). The view is cached — repeated calls return the same instance.
   *
   * @example
   * ```ts
   * await db.users.create({ data: { email: 'a@b.com' } });
   * // Read-after-write: guaranteed to see the row just inserted.
   * const user = await db.$primary().users.findFirst({ where: { email: 'a@b.com' } });
   * ```
   */
  $primary(): TurbineClient {
    if (this.replicaPools.length === 0) return this;
    if (!this.primaryView) {
      this.primaryView = new TurbineClient(
        { [PRIMARY_VIEW]: { parent: this } } as unknown as TurbineConfig,
        this.schema,
      );
    }
    return this.primaryView;
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
        sql += this.dialect.paramPlaceholder(i + 1);
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

  /**
   * Execute a **typed** raw SQL query — Turbine's answer to Prisma's TypedSQL.
   *
   * Like {@link raw}, every interpolated `${value}` becomes a `$N` parameter
   * (never string-concatenated), so it is injection-safe by construction. The
   * difference is the caller-supplied row type and the chainable result: the
   * returned {@link TypedSqlQuery} can be `await`ed directly for `T[]`, or
   * refined with `.one()` (→ `T | null`) or `.scalar<V>()` (→ `V | null`).
   *
   * Rows are returned as-is — no snake→camel mapping (matching `raw()`). Alias
   * columns in SQL if you want camelCase keys.
   *
   * @example
   * ```ts
   * // rows
   * const rows = await db.sql<{ id: number; name: string }>`
   *   SELECT id, name FROM users WHERE org_id = ${orgId}
   * `;
   *
   * // single row or null
   * const user = await db.sql<{ id: number; name: string }>`
   *   SELECT id, name FROM users WHERE id = ${userId}
   * `.one();
   *
   * // scalar
   * const total = await db.sql<{ count: number }>`
   *   SELECT COUNT(*)::int AS count FROM users
   * `.scalar();
   * ```
   */
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): TypedSqlQuery<T> {
    const { sql, params } = buildTypedSql(strings, values, this.dialect);
    return new TypedSqlQuery<T>(this.pool, sql, params, this.logging);
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
      await client.query(this.dialect.beginStatement());
      const result = await fn(client);
      await client.query(this.dialect.commitStatement());
      return result;
    } catch (err) {
      await client.query(this.dialect.rollbackStatement());
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
  $transaction<R>(fn: (tx: TransactionClient) => Promise<R>, options?: TransactionOptions): Promise<R>;
  /**
   * Batch form — run a tuple of {@link DeferredQuery} objects (produced by the
   * `build*()` methods, e.g. `db.users.buildFindMany(...)`) atomically inside a
   * single `BEGIN…COMMIT` on one connection. Returns a positionally-typed tuple
   * of each query's transformed result; any failure rolls the whole batch back.
   *
   * Unlike {@link pipeline}, this never uses the extended-query pipeline
   * protocol — it executes sequentially on the transaction connection, so it is
   * safe on every driver (including HTTP/serverless pools).
   *
   * @example
   * ```ts
   * const [user, count] = await db.$transaction([
   *   db.users.buildFindUnique({ where: { id: 1 } }),
   *   db.posts.buildCount({ where: { userId: 1 } }),
   * ]);
   * ```
   */
  $transaction<T extends readonly DeferredQuery<unknown>[]>(queries: readonly [...T]): Promise<PipelineResults<T>>;
  async $transaction(
    fnOrQueries: ((tx: TransactionClient) => Promise<unknown>) | readonly DeferredQuery<unknown>[],
    options?: TransactionOptions,
  ): Promise<unknown> {
    // Batch overload: an array of DeferredQuery objects runs atomically inside
    // one BEGIN…COMMIT, reusing the raw transaction machinery below.
    if (Array.isArray(fnOrQueries)) {
      return this.transactionBatch(fnOrQueries);
    }
    const fn = fnOrQueries as (tx: TransactionClient) => Promise<unknown>;
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
      // BEGIN with optional isolation level — the dialect owns the keyword and
      // BEGIN+isolation composition (Postgres appends ` ISOLATION LEVEL …`).
      const isolationSql = options?.isolationLevel ? ISOLATION_LEVELS[options.isolationLevel] : undefined;
      await client.query(this.dialect.beginStatement(isolationSql));

      // Apply transaction-local session context (RLS / multi-tenant GUCs).
      // Order matters: BEGIN -> isolation level (above) -> set_config loop ->
      // user fn. Any error here propagates to the catch below and rolls back
      // like any other transaction failure. We use set_config(name, value,
      // is_local=true) — the parameterizable, transaction-scoped equivalent of
      // SET LOCAL — so both name and value are BOUND params, never interpolated.
      if (options?.sessionContext) {
        if (!this.dialect.supportsRLS) {
          throw new UnsupportedFeatureError(
            'sessionContext (RLS session GUCs)',
            this.dialect.name,
            'set_config-based row-level-security context requires PostgreSQL.',
          );
        }
        for (const [name, value] of Object.entries(options.sessionContext)) {
          if (!GUC_NAME_REGEX.test(name)) {
            throw new ValidationError(
              `[turbine] Invalid session-context GUC name "${name}" — must match ` +
                '/^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)?$/ (optionally namespaced, e.g. "app.current_tenant")',
            );
          }
          const cfg = this.dialect.buildSetSessionConfig(name, String(value));
          await client.query(cfg.sql, cfg.params);
        }
      }

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

      let result: unknown;

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

      await client.query(this.dialect.commitStatement());

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
          await client.query(this.dialect.rollbackStatement());
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

  /**
   * Execute a batch of {@link DeferredQuery} objects atomically inside one
   * transaction. Backs the `$transaction([...])` array overload. Reuses the raw
   * {@link transaction} machinery (BEGIN/COMMIT/ROLLBACK + connection release);
   * queries run sequentially on the single transaction connection and each
   * result is passed through its query's `transform`.
   */
  private async transactionBatch<T extends readonly DeferredQuery<unknown>[]>(queries: T): Promise<PipelineResults<T>> {
    if (queries.length === 0) {
      return [] as unknown as PipelineResults<T>;
    }
    return this.transaction(async (client) => {
      const results: unknown[] = [];
      for (const dq of queries) {
        let raw: pg.QueryResult;
        try {
          // Non-RETURNING engines (resultStrategy 'reselect', e.g. MySQL)
          // attach a reselect plan that runs the write plus a follow-up SELECT;
          // running dq.sql alone would transform a row-less write result.
          raw =
            this.dialect.resultStrategy === 'reselect' && dq.reselect
              ? await dq.reselect((sql, params) => client.query(sql, params))
              : await client.query(dq.sql, dq.params);
        } catch (err) {
          throw wrapPgError(err);
        }
        results.push(dq.transform(raw));
      }
      return results as PipelineResults<T>;
    });
  }

  /**
   * Convenience wrapper around `$transaction` for the multi-tenant / RLS case:
   * runs `fn` inside a transaction with the given session GUCs applied via
   * `set_config(..., is_local=true)`. Equivalent to
   * `$transaction(fn, { sessionContext: context })`.
   *
   * @example
   * ```ts
   * const invoices = await db.$withSession(
   *   { 'app.current_tenant': tenantId },
   *   (tx) => tx.invoices.findMany(),
   * );
   * ```
   */
  async $withSession<R>(
    context: Record<string, string | number | boolean>,
    fn: (tx: TransactionClient) => Promise<R>,
  ): Promise<R> {
    return this.$transaction(fn, { sessionContext: context });
  }

  // -------------------------------------------------------------------------
  // LISTEN / NOTIFY — Postgres realtime pub/sub
  // -------------------------------------------------------------------------

  /**
   * Subscribe to a Postgres NOTIFY channel. The handler fires with each
   * notification's payload string (the empty string when a payload-less
   * NOTIFY is sent) for as long as the subscription is active.
   *
   * Each `$listen` checks out its OWN dedicated long-lived connection from the
   * pool and runs `LISTEN "channel"` on it; `subscription.unsubscribe()`
   * UNLISTENs, detaches the handler, and releases that connection. Active
   * subscriptions are tracked and force-released on `disconnect()` so shutdown
   * never hangs.
   *
   * The channel name CANNOT be a bound parameter (`LISTEN $1` is a syntax
   * error), so it is validated against a strict identifier regex AND quoted via
   * `quoteIdent` before interpolation — it is the only identifier this method
   * places into SQL text.
   *
   * **Serverless caveat:** LISTEN needs a persistent connection that can push
   * async notifications. Stateless HTTP drivers (Neon HTTP, Vercel Postgres)
   * cannot do this — `$listen` throws a `ConnectionError` rather than hang.
   * `$notify` works on every driver.
   *
   * @example
   * ```ts
   * const sub = await db.$listen('order_created', (payload) => {
   *   const order = JSON.parse(payload);
   *   console.log('new order', order.id);
   * });
   * // ...later
   * await sub.unsubscribe();
   * ```
   */
  async $listen(channel: string, handler: NotificationHandler): Promise<Subscription> {
    if (!this.dialect.supportsListenNotify) {
      throw new UnsupportedFeatureError(
        '$listen (LISTEN/NOTIFY realtime)',
        this.dialect.name,
        'Realtime pub/sub requires PostgreSQL.',
      );
    }
    validateChannel(channel);
    const quoted = quoteIdent(channel);

    if (this.logging) {
      console.log(`[turbine] LISTEN ${quoted}`);
    }

    const sub = await createSubscription(this.pool as unknown as PgCompatPool, channel, quoted, handler, (closed) => {
      this.activeSubscriptions.delete(closed);
    });
    this.activeSubscriptions.add(sub);
    return sub;
  }

  /**
   * Send a Postgres NOTIFY on `channel` with an optional payload string.
   *
   * Issued as `SELECT pg_notify($1, $2)` — both the channel and payload are
   * BOUND parameters (no quoting/injection concern). The channel is still
   * validated against the identifier regex for parity with `$listen` and to
   * catch typos loudly. Works on every driver, including serverless HTTP pools.
   *
   * @example
   * ```ts
   * await db.$notify('order_created', JSON.stringify({ id: 7 }));
   * ```
   */
  async $notify(channel: string, payload?: string): Promise<void> {
    if (!this.dialect.supportsListenNotify) {
      throw new UnsupportedFeatureError(
        '$notify (LISTEN/NOTIFY realtime)',
        this.dialect.name,
        'Realtime pub/sub requires PostgreSQL.',
      );
    }
    validateChannel(channel);
    if (this.logging) {
      console.log(`[turbine] NOTIFY ${channel}`);
    }
    try {
      await this.pool.query('SELECT pg_notify($1, $2)', [channel, payload ?? '']);
    } catch (err) {
      throw wrapPgError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Retry — automatic retry for retryable errors (deadlock, serialization)
  // -------------------------------------------------------------------------

  /**
   * Execute an async function with automatic retry on retryable errors.
   *
   * Only errors with `isRetryable === true` (DeadlockError, SerializationFailureError)
   * are retried. Uses exponential backoff with jitter.
   *
   * @example
   * ```ts
   * const result = await db.$retry(() =>
   *   db.$transaction(async (tx) => {
   *     // ... serializable transaction logic
   *   }, { isolationLevel: 'Serializable' })
   * );
   * ```
   */
  async $retry<T>(fn: () => Promise<T>, options?: RetryOptions): Promise<T> {
    return withRetry(fn, options);
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
    // Tear down any live LISTEN subscriptions first. Each holds a dedicated
    // pooled connection checked out; if we ended the pool (or returned for an
    // external pool) without releasing them, pool.end() would wait forever for
    // those connections to return. _forceRelease() detaches the handler and
    // releases the client WITHOUT issuing UNLISTEN (pointless if we're ending
    // the pool / the connection is going away anyway). This runs for both
    // owned and external pools so subscriptions never leak.
    if (this.activeSubscriptions.size > 0) {
      // _forceRelease mutates activeSubscriptions via the onClosed callback,
      // so iterate a snapshot.
      for (const sub of [...this.activeSubscriptions]) {
        sub._forceRelease();
      }
      this.activeSubscriptions.clear();
    }

    // Close owned (string-configured) replica pools regardless of whether the
    // primary is owned — external replica pools are left untouched (caller owns
    // their lifecycle), same contract as an external primary.
    for (const replicaPool of this.ownedReplicaPools) {
      try {
        await replicaPool.end();
      } catch (err) {
        if (this.logging) {
          console.error('[turbine] Error closing replica pool:', (err as Error).message);
        }
      }
    }

    if (!this.ownsPool) {
      if (this.logging) {
        console.log('[turbine] disconnect() skipped — external primary pool is not owned by Turbine');
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
