/**
 * turbine-orm, the pg-compatible driver contract
 *
 * WHY THIS MODULE EXISTS, AND WHY IT IMPORTS NOTHING. The `pg` package ships
 * no type declarations of its own, so every `@types/pg` name that reaches an
 * EXPORTED declaration makes TypeScript emit an import of the pg module into
 * the published `.d.ts`, which turns `@types/pg` into a hard requirement for
 * any consumer compiling under `strict` - a runtime-free types package that
 * nonetheless has to sit in `dependencies` for consumer builds to typecheck.
 * That is the v0.28.1 regression: `@types/pg` was moved to `devDependencies`
 * while the declaration surface still named `pg.Pool` / `pg.PoolClient` /
 * `pg.QueryResult`, and consumer `tsc` broke. The order matters and it is
 * one-way: clear the declaration surface FIRST, then move the dependency.
 * The published declarations are checked for pg references on every release,
 * so the surface cannot silently grow one back.
 *
 * So these are the pg shapes, declared natively. They are not a new parallel
 * abstraction: `PgCompatPool` / `PgCompatPoolClient` / `PgCompatQueryResult`
 * are the SAME interfaces the external-pool seam has used since the serverless
 * binding shipped (`TurbineConfig.pool`, `turbineHttp`, and the `SqlitePool` /
 * `MysqlPool` / `MssqlPool` / `PowdbPool` engine shims), lifted out of
 * client.ts so that `query/` can name them without an import edge back to the
 * client (see `scripts/check-import-cycles.mjs`). client.ts re-exports all of
 * them, so every existing `from './client.js'` import path is unchanged.
 *
 * A genuine `pg.Pool`, `pg.PoolClient` and `pg.QueryResult` each satisfy the
 * matching interface here structurally, which is what keeps `pg` usable at
 * every position Turbine accepts one. The reverse is NOT true and never was:
 * an HTTP driver's pool is not a `pg.Pool`, which is why the fields pg alone
 * provides (`totalCount`, the `error` event) are optional.
 *
 * `pg` itself remains a real runtime dependency. This module is about the
 * TYPE surface only.
 *
 * @module
 */

/**
 * One column of a result's row description. `rows` is what Turbine reads; a
 * driver that describes its columns supplies these too.
 *
 * `name` and `dataTypeID` are required because a driver that reports fields at
 * all reports those two. The rest are pg's, optional so that a genuine
 * `pg.FieldDef` object LITERAL is accepted (excess-property checking makes
 * literal-level compatibility a real thing callers hit when they hand-write a
 * fake result), and so that a driver reporting only the two is accepted as
 * well.
 */
export interface PgCompatFieldDef {
  name: string;
  dataTypeID: number;
  tableID?: number;
  columnID?: number;
  dataTypeSize?: number;
  dataTypeModifier?: number;
  format?: string;
}

/**
 * Minimal pg-compatible query result.
 * `pg.Pool`, `@neondatabase/serverless` Pool, `@vercel/postgres` Pool and
 * any driver speaking the node-postgres API all satisfy this shape.
 *
 * `rows` and `rowCount` are the contract: they are the only two members
 * Turbine reads, and the two every supported driver produces. `command` /
 * `oid` / `fields` are pg's and therefore OPTIONAL, which is what makes this
 * interface a structural supertype of `pg.QueryResult` rather than a
 * lookalike. That direction is the one that matters, since this type appears
 * in PARAMETER position throughout the public surface
 * ({@link PgCompatPool.query}'s result, `DeferredQuery.transform`'s argument):
 * whatever pg hands back must be accepted, while the engine shims that return
 * only `{ rows, rowCount }` must be accepted too.
 */
export interface PgCompatQueryResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number | null;
  fields?: PgCompatFieldDef[];
  /** pg-family drivers: the completed command tag (`SELECT`, `INSERT`, ...). */
  command?: string;
  /** pg-family drivers: the legacy inserted-row OID, `0` for everything else. */
  oid?: number;
}

/**
 * The object form of a query, `{ name, text, values }`, which node-postgres
 * accepts in place of `(text, values)` in order to name a prepared statement.
 *
 * Deliberately NOT a second overload on {@link PgCompatPool.query}. The engine
 * pool shims implement that interface and speak only the two-argument form, so
 * requiring the object form of every implementer would be a contract they
 * cannot meet. Named prepared statements are a Postgres-path optimization, and
 * the one call site that uses them casts to this shape.
 */
export interface PgCompatQueryConfig {
  /** Prepared-statement name. Omit for an unnamed (re-parsed) statement. */
  name?: string;
  text: string;
  values?: unknown[];
}

/**
 * Minimal pg-compatible client used by TurbineClient for transactions.
 * `pg.PoolClient` satisfies this; so do Neon and Vercel's equivalents.
 */
export interface PgCompatPoolClient {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<PgCompatQueryResult<R>>;
  release(err?: Error | boolean): void;
  /**
   * Optional driver capability: `true` when `query()` may be called again on
   * this connection while earlier calls are still in flight, with replies
   * delivered to callers in FIFO submission order. Drivers that set this let
   * the batch `$transaction([...])` overload dispatch every statement in one
   * write burst (~1 network round trip plus server time) instead of awaiting
   * each reply before sending the next (N round trips). Leave unset for
   * drivers (node-postgres included) whose batch path must stay strictly
   * sequential.
   */
  readonly supportsPipelining?: boolean;
  /**
   * Optional engine seam: scope a transaction's user callback to its own
   * async subtree. When present, `TurbineClient.transaction` / `$transaction`
   * invoke the callback as `wrapTransactionCallback(() => fn(tx))` instead of
   * `fn(tx)` directly. Single-writer engines (PowDB) implement it with
   * `AsyncLocalStorage.run()` to plant their re-entrancy marker so that it
   * exists ONLY inside the callback's async subtree: a transaction opened
   * from inside the callback is detected as re-entrant (typed E017), while
   * the CALLER's context stays unmarked, so same-tick sibling transactions
   * queue FIFO instead of being falsely flagged. Absent on pg and every other
   * engine, in which case the callback runs unwrapped (zero behavior change).
   */
  wrapTransactionCallback?<R>(fn: () => Promise<R>): Promise<R>;
}

/**
 * Minimal pg-compatible pool. Pass any driver that satisfies this interface
 * via `TurbineConfig.pool`, lets Turbine run on Neon HTTP, Vercel Postgres,
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
  /** Optional, pools that expose stats (pg.Pool does; Neon HTTP does not) */
  readonly totalCount?: number;
  readonly idleCount?: number;
  readonly waitingCount?: number;
  /** Optional, pg.Pool supports 'error' event; HTTP drivers typically do not */
  on?(event: 'error', listener: (err: Error) => void): this;
}
