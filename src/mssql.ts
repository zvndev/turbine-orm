/**
 * turbine-orm/mssql — Microsoft SQL Server engine (driver-injected, optional peer)
 *
 * Binds Turbine to SQL Server 2016+ via the `mssql` driver (which wraps
 * `tedious`). `mssql` is **not** a root dependency — it is an **optional peer**:
 * `npm i turbine-orm` pulls nothing extra, and only consumers who
 * `import 'turbine-orm/mssql'` install `mssql` themselves. The factory loads it
 * through a dynamic `import('mssql')` so importing this module never crashes when
 * `mssql` is absent for a consumer who does not use it. Turbine's root runtime
 * dependency stays exactly `pg`.
 *
 * ## The three hard SQL Server realities this engine solves
 *
 *  1. **No `RETURNING`.** `INSERT`/`UPDATE`/`DELETE` cannot trail a `RETURNING`
 *     clause; SQL Server returns affected rows via `OUTPUT INSERTED.*` /
 *     `OUTPUT DELETED.*` injected MID-statement (between the column list and
 *     `VALUES`, or between `SET …` and `WHERE …`). `mssqlDialect.resultStrategy =
 *     'output'`: the statement returns its own rows in ONE round-trip (executed
 *     exactly like the PostgreSQL `'returning'` path). Upsert becomes a
 *     `MERGE … WHEN MATCHED … WHEN NOT MATCHED … OUTPUT INSERTED.* ;` (a MERGE
 *     must end with `;`). This is the first shipped engine to exercise the
 *     Phase-0 `'output'` result strategy.
 *  2. **No `json_agg`.** SQL Server has no JSON aggregate function; the idiomatic
 *     single-query nested-relation path is `(SELECT child cols … FOR JSON PATH)`,
 *     whose object shape is expressed by the child SELECT's column ALIASES rather
 *     than an explicit `JSON_OBJECT(...)`. That does NOT map onto
 *     `buildJsonObject`/`buildJsonArrayAgg`, so `mssqlDialect` defines the
 *     additive `Dialect.buildRelationSubquery` override (the sanctioned Phase-3
 *     seam extension) and owns the whole correlated subquery. To-many wraps
 *     `ISNULL((… FOR JSON PATH), '[]')` (FOR JSON over zero rows is NULL, not
 *     `[]`); to-one adds `, WITHOUT_ARRAY_WRAPPER` and lets NULL be the no-row
 *     value. Nested relations are embedded with `JSON_QUERY(...)` so they stay
 *     real JSON instead of being escaped as a string. `INCLUDE_NULL_VALUES`
 *     keeps NULL columns present (matching PostgreSQL `json_build_object`).
 *  3. **No `LIMIT`.** Paging is `ORDER BY … OFFSET n ROWS FETCH NEXT m ROWS ONLY`,
 *     which requires an ORDER BY — a stable `ORDER BY (SELECT NULL)` is injected
 *     when the query has none (`Dialect.buildLimitOffset`).
 *
 * ## Named `@pN` placeholders (no positional `?`)
 *
 * `mssqlDialect.paramPlaceholder = (i) => '@p' + i`. The driver shim binds via
 * `request.input('p' + i, value)`, so binding is by NAME and independent of where
 * each placeholder lands in the SQL text — exactly the guarantee PostgreSQL's
 * numbered `$N` gives. (SQL Server is naturally named-param friendly, sidestepping
 * the positional-`?` mis-bind bug the SQLite/MySQL phases hit.)
 *
 * ## Capabilities & limits (vs PostgreSQL)
 *
 * - **Single query nested relations preserved** via `FOR JSON PATH` (SQL Server
 *   2016+). Ordered/limited to-many uses `ORDER BY … OFFSET/FETCH` inside the FOR
 *   JSON subquery (no inner-subquery rewrite needed — FOR JSON aggregates AFTER
 *   the row selection).
 * - **Result strategy `'output'`:** create/update/delete/upsert return their rows
 *   from the same statement. `createMany` returns the inserted rows via
 *   `OUTPUT INSERTED.*` on the multi-row VALUES insert (≤ 1000 rows / 2100 params
 *   per statement — exceeding either throws a clear `ValidationError`; chunk
 *   yourself or use single `create`s).
 * - **MERGE concurrency caveat:** `MERGE` is the upsert primitive; under high
 *   concurrency a `MERGE` can still race (it is NOT a substitute for a unique
 *   constraint). Keep the conflict target backed by a real `UNIQUE`/`PK` index,
 *   and rely on the typed `UniqueConstraintError` (2627/2601 → E008) for the
 *   loser of a race.
 * - **Unsupported (throw `UnsupportedFeatureError`):** pgvector distance ops,
 *   LISTEN/NOTIFY (`$listen`/`$notify`), RLS `sessionContext` (sp_set_session_context
 *   exists but is connection-scoped, not transaction-local, so it is not wired —
 *   throws rather than silently leaking context across pooled connections).
 * - **Advisory-lock migration locking** is available in principle via
 *   `sp_getapplock`/`sp_releaseapplock` (`supportsAdvisoryLock = true`); the
 *   migrate CLI is still PostgreSQL-only, so this flag documents intent for a
 *   future adapter.
 * - **Case-insensitive matching** uses `LOWER(col) LIKE LOWER(ref)` — deterministic
 *   regardless of the column's collation (note this can defeat an index unless a
 *   computed/persisted `LOWER()` index exists).
 * - **bignum:** the shim applies the same safe-int policy Turbine uses for Postgres
 *   `int8` (number when it fits in 2^53, decimal string otherwise) WITHOUT mutating
 *   any global driver state. `DECIMAL`/`NUMERIC`/`MONEY` come back as strings;
 *   `BIT` binds/returns booleans.
 * - **`DISTINCT ON`** is PostgreSQL-only and is not translated — avoid `distinct`
 *   on SQL Server.
 *
 * ## Example
 *
 * ```ts
 * import { turbineMssql } from 'turbine-orm/mssql';
 * import { SCHEMA } from './generated/turbine/metadata.js';
 *
 * const db = await turbineMssql('mssql://sa:Passw0rd!@localhost:1433/app', SCHEMA);
 * const users = await db.users.findMany({ with: { posts: true }, limit: 10 });
 * await db.disconnect();
 * ```
 */

import { type PgCompatPool, type PgCompatPoolClient, TurbineClient, type TurbineConfig } from './client.js';
import {
  type BulkInsertStatementInput,
  type ColumnDefinitionInput,
  type ColumnTypeInput,
  type CreateIndexStatementInput,
  type CreateTableStatementInput,
  type DeleteStatementInput,
  type Dialect,
  type DialectIntrospector,
  type InsertStatementInput,
  type IntrospectOptions,
  type LimitOffsetInput,
  postgresDialect,
  type RelationSubqueryContext,
  type StreamableConnection,
  type UpdateStatementInput,
  type UpsertStatementInput,
} from './dialect.js';
import { ConnectionError, RelationError, UnsupportedFeatureError, ValidationError } from './errors.js';
import { deriveEngineRelations } from './introspect.js';
import importOptionalPeer from './optional-peer-import.cjs';
import {
  type ColumnMetadata,
  camelToSnake,
  type IndexMetadata,
  isDateType,
  normalizeKeyColumns,
  type RelationDef,
  type SchemaMetadata,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';

// ---------------------------------------------------------------------------
// SQL Server / connection limits
// ---------------------------------------------------------------------------

/** Max bound parameters per SQL Server statement. */
const MSSQL_MAX_PARAMS = 2100;
/** Max rows per multi-row INSERT … VALUES statement. */
const MSSQL_MAX_INSERT_ROWS = 1000;

/** Canonical key sort matching the query builder's `sortedEntries`/collect order. */
function sortedRelEntries<V>(obj: Record<string, V>): [string, V][] {
  return Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Minimal structural typing for the `mssql` surface we touch
// ---------------------------------------------------------------------------
//
// Typed structurally (not via `import type` from mssql) so this module stays
// compilable when mssql is absent and the shim logic stays decoupled from
// mssql's heavy generic types. The real pool is loaded via a dynamic import in
// the factory and cast to these shapes.

/** A value `mssql` accepts as a bound parameter (driver infers the SQL type). */
type MssqlParam = null | number | bigint | string | boolean | Date | Uint8Array;

interface MssqlRequest {
  input(name: string, value: unknown): MssqlRequest;
  query<R = Record<string, unknown>>(text: string): Promise<MssqlQueryResult<R>>;
  batch<R = Record<string, unknown>>(text: string): Promise<MssqlQueryResult<R>>;
}

/** Per-column metadata `mssql` attaches to a recordset (`recordset.columns`). */
interface MssqlColumnMeta {
  [name: string]: { type?: { name?: string; declaration?: string } } | undefined;
}

interface MssqlQueryResult<R = Record<string, unknown>> {
  // `mssql` attaches column metadata to the recordset array itself.
  recordset?: R[] & { columns?: MssqlColumnMeta };
  recordsets?: R[][];
  rowsAffected?: number[];
}

interface MssqlTransaction {
  begin(isolationLevel?: number): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
}

interface MssqlConnectionPool {
  connect(): Promise<MssqlConnectionPool>;
  request(): MssqlRequest;
  close(): Promise<unknown>;
  readonly connected?: boolean;
}

/** The subset of the `mssql` module namespace the shim constructs. */
interface MssqlModule {
  // biome-ignore lint/suspicious/noExplicitAny: mssql config is loosely typed at this seam.
  connect(config: any): Promise<MssqlConnectionPool>;
  ConnectionPool: new (
    // biome-ignore lint/suspicious/noExplicitAny: ConnectionPool ctor takes a config or connection string.
    config: any,
  ) => MssqlConnectionPool;
  Request: new (parent: MssqlConnectionPool | MssqlTransaction) => MssqlRequest;
  Transaction: new (pool: MssqlConnectionPool) => MssqlTransaction;
  ISOLATION_LEVEL: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Value coercion (params in)
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary JS value into something `mssql` can bind. `BIT` accepts JS
 * booleans directly; `undefined`/`null` → NULL; `bigint` follows the safe-int
 * policy (number when it fits in 2^53, else a decimal string — no precision
 * loss); `Date`/`Uint8Array` pass through; any remaining object/array → JSON text
 * (matches how Turbine already pre-serializes JSON filter / `IN`-list params).
 */
function toMssqlParam(value: unknown): MssqlParam {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'number':
    case 'string':
      return value;
    case 'bigint':
      return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
        ? Number(value)
        : value.toString();
  }
  if (value instanceof Date) return value;
  if (value instanceof Uint8Array) return value; // Buffer is a Uint8Array subclass
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Result shaping + error translation
// ---------------------------------------------------------------------------

/** Shape an `mssql` result into a `pg.QueryResult`-like object. */
function shapeResult(result: MssqlQueryResult): { rows: Record<string, unknown>[]; rowCount: number } {
  const rows = result.recordset ?? [];
  coerceBigIntColumns(rows, result.recordset?.columns);
  const affected = result.rowsAffected?.[0];
  return { rows, rowCount: typeof affected === 'number' ? affected : rows.length };
}

/**
 * Coerce top-level `BIGINT` columns from strings to numbers, mirroring the
 * Postgres `int8` policy (the TurbineClient registers a pg type parser that
 * returns bigint as number within the JS safe-integer range). The `mssql`/tedious
 * driver returns BIGINT as a string to avoid precision loss, so a BIGINT IDENTITY
 * `id` would otherwise surface as `'1'` instead of `1`. Values outside the safe
 * range are left as strings (same as the Postgres path). Nested relations are
 * unaffected — `FOR JSON PATH` already renders BIGINT as a JSON number.
 */
function coerceBigIntColumns(rows: Record<string, unknown>[], columns: MssqlColumnMeta | undefined): void {
  if (!columns || rows.length === 0) return;
  const bigIntCols: string[] = [];
  for (const [name, col] of Object.entries(columns)) {
    const t = col?.type;
    const decl = String(t?.declaration ?? t?.name ?? '').toLowerCase();
    if (decl === 'bigint') bigIntCols.push(name);
  }
  if (bigIntCols.length === 0) return;
  for (const row of rows) {
    for (const c of bigIntCols) {
      const v = row[c];
      if (typeof v === 'string' && /^-?\d+$/.test(v)) {
        const n = Number(v);
        if (Number.isSafeInteger(n)) row[c] = n;
      }
    }
  }
}

const EMPTY_RESULT = { rows: [] as Record<string, unknown>[], rowCount: 0 };

/**
 * Augment a `mssql` driver error with the Postgres-shaped `.code` (SQLSTATE) and
 * detail fields that `wrapPgError` understands, so SQL Server constraint failures
 * surface as the same typed Turbine errors as Postgres (E008/E009/E010/E011) and
 * deadlock / lock-timeout become retryable (E012/E013). The original error (with
 * its real message) is preserved as the wrapped error's `.cause` downstream.
 * Returns the value unchanged when it is not a recognizable mssql error.
 */
function augmentMssqlError(err: unknown): unknown {
  if (!err || typeof err !== 'object') return err;
  const e = err as { number?: number; message?: string };
  if (typeof e.number !== 'number') return err;

  const target = e as Record<string, unknown>;
  const msg = e.message ?? '';

  switch (e.number) {
    // 2627 = unique constraint / PK violation; 2601 = unique index violation.
    case 2627:
    case 2601: {
      target.code = '23505';
      // "...constraint 'UQ_users_email'..." or "...index 'IX_users_email'..."
      const m = /(?:constraint|index)\s+'([^']+)'/i.exec(msg) ?? /'([^']+)'/.exec(msg);
      if (m?.[1]) target.constraint = m[1];
      return err;
    }
    // 547 = FOREIGN KEY / CHECK constraint conflict (message distinguishes them).
    case 547:
      target.code = /CHECK constraint/i.test(msg) ? '23514' : '23503';
      return err;
    // 515 = cannot insert NULL into a non-nullable column.
    case 515: {
      target.code = '23502';
      const c = /column '([^']+)'/i.exec(msg);
      if (c?.[1]) target.column = c[1];
      return err;
    }
    // 1205 = transaction chosen as deadlock victim (retryable → pg 40P01).
    case 1205:
      target.code = '40P01';
      return err;
    // 1222 = lock request time out (retryable → pg 40001 serialization failure).
    case 1222:
      target.code = '40001';
      return err;
    default:
      return err;
  }
}

// ---------------------------------------------------------------------------
// Driver shim — wrap an `mssql` ConnectionPool as a PgCompatPool
// ---------------------------------------------------------------------------

/** pg-style query argument: a SQL string or a `{ text, values }` config object. */
type QueryArg = string | { name?: string; text: string; values?: unknown[] };

function normalizeQueryArgs(arg: QueryArg, values?: unknown[]): { text: string; params: unknown[] } {
  if (typeof arg === 'string') return { text: arg, params: values ?? [] };
  return { text: arg.text, params: arg.values ?? values ?? [] };
}

/** Bind positional `params[]` to `@p1`, `@p2`, … inputs and run the statement. */
async function runRequest(
  request: MssqlRequest,
  text: string,
  params: unknown[],
): Promise<ReturnType<typeof shapeResult>> {
  for (let i = 0; i < params.length; i++) {
    request.input(`p${i + 1}`, toMssqlParam(params[i]));
  }
  try {
    const result = await request.query(text);
    return shapeResult(result);
  } catch (err) {
    throw augmentMssqlError(err);
  }
}

/** Map a SQL-standard isolation-level name to the mssql `ISOLATION_LEVEL` constant. */
function mapIsolationLevel(sqlNS: MssqlModule, level: string | null): number | undefined {
  if (!level) return undefined;
  return sqlNS.ISOLATION_LEVEL[level.trim().toUpperCase().replace(/\s+/g, '_')];
}

/**
 * A transaction-scoped {@link PgCompatPoolClient}. SQL Server transactions are
 * driven through the `mssql` `Transaction` API, NOT raw `BEGIN`/`COMMIT` SQL (the
 * driver owns the connection a transaction is pinned to). This client intercepts
 * the dialect's transaction-control statements and routes them to that API, while
 * regular queries run on a `Request` bound to the active transaction (or the pool
 * before BEGIN). Mirrors the MySQL shim's `runOnConnection` intent.
 */
class MssqlTxClient implements PgCompatPoolClient {
  private tx: MssqlTransaction | null = null;
  private pendingIsolation: string | null = null;

  constructor(
    private readonly pool: MssqlConnectionPool,
    private readonly sqlNS: MssqlModule,
  ) {}

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: rawSql, params } = normalizeQueryArgs(text, values);
    const sql = rawSql.trim();

    // RELEASE SAVEPOINT has no SQL Server equivalent (savepoints auto-persist until
    // the outer commit/rollback) — releaseSavepointStatement() returns '' → no-op.
    if (sql === '') return EMPTY_RESULT;

    // The dialect composes `SET TRANSACTION ISOLATION LEVEL …; BEGIN TRANSACTION`
    // (SQL Server cannot take an inline isolation level on BEGIN). Split and run
    // the parts in order — same pattern as the MySQL shim. Gated on the exact
    // transaction-control prefix so no builder/user SQL is ever split.
    if (/^SET TRANSACTION ISOLATION LEVEL /i.test(sql) && sql.includes('; ')) {
      let last: ReturnType<typeof shapeResult> = EMPTY_RESULT;
      for (const part of sql.split('; ')) {
        const p = part.trim();
        if (p) last = await this.query(p, []);
      }
      return last;
    }

    if (/^SET TRANSACTION ISOLATION LEVEL /i.test(sql)) {
      this.pendingIsolation = sql.replace(/^SET TRANSACTION ISOLATION LEVEL /i, '').trim();
      return EMPTY_RESULT;
    }
    if (/^BEGIN TRAN(SACTION)?\b/i.test(sql)) {
      this.tx = new this.sqlNS.Transaction(this.pool);
      await this.tx.begin(mapIsolationLevel(this.sqlNS, this.pendingIsolation));
      this.pendingIsolation = null;
      return EMPTY_RESULT;
    }
    if (/^COMMIT\b/i.test(sql)) {
      if (this.tx) await this.tx.commit();
      this.tx = null;
      return EMPTY_RESULT;
    }
    // ROLLBACK TRANSACTION <name> = rollback to a savepoint; bare ROLLBACK = abort.
    const spRollback = /^ROLLBACK TRAN(?:SACTION)?\s+(\S+)/i.exec(sql);
    if (spRollback) {
      const req = new this.sqlNS.Request(this.tx ?? this.pool);
      await req.batch(`ROLLBACK TRANSACTION ${spRollback[1]}`);
      return EMPTY_RESULT;
    }
    if (/^ROLLBACK\b/i.test(sql)) {
      if (this.tx) await this.tx.rollback();
      this.tx = null;
      return EMPTY_RESULT;
    }
    if (/^SAVE TRAN(SACTION)?\b/i.test(sql)) {
      const req = new this.sqlNS.Request(this.tx ?? this.pool);
      await req.batch(sql);
      return EMPTY_RESULT;
    }

    const request = new this.sqlNS.Request(this.tx ?? this.pool);
    return runRequest(request, rawSql, params);
  }

  release(): void {
    // The transaction's connection is owned by the mssql Transaction object and is
    // returned to the pool on commit/rollback; nothing to release here.
  }
}

/**
 * A {@link PgCompatPool} backed by an `mssql` ConnectionPool. Non-transaction
 * queries run on a fresh pooled `Request`; `connect()` returns a
 * {@link MssqlTxClient} that drives a single transaction through the mssql
 * `Transaction` API so `BEGIN`/`COMMIT`/`ROLLBACK`/savepoints all run on the same
 * physical connection.
 */
export class MssqlPool implements PgCompatPool {
  /** The underlying `mssql` ConnectionPool — exposed as an escape hatch (seed / DDL / advanced ops). */
  readonly pool: MssqlConnectionPool;
  private readonly sqlNS: MssqlModule;
  private closed = false;

  constructor(pool: MssqlConnectionPool, sqlNS: MssqlModule) {
    this.pool = pool;
    this.sqlNS = sqlNS;
  }

  // biome-ignore lint/suspicious/noExplicitAny: pg-compat query is generic over the row shape.
  async query(text: QueryArg, values?: unknown[]): Promise<any> {
    const { text: sql, params } = normalizeQueryArgs(text, values);
    return runRequest(this.pool.request(), sql, params);
  }

  async connect(): Promise<PgCompatPoolClient> {
    return new MssqlTxClient(this.pool, this.sqlNS);
  }

  async end(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.close();
  }
}

// ---------------------------------------------------------------------------
// Type mapping (SQL Server data type → TypeScript)
// ---------------------------------------------------------------------------

/**
 * Map a SQL Server column type to a TypeScript type. `dialectType` is the
 * `INFORMATION_SCHEMA.COLUMNS.DATA_TYPE` (lowercase, e.g. `bigint`, `nvarchar`,
 * `datetime2`, `bit`, `uniqueidentifier`).
 */
export function mssqlTypeToTs(dialectType: string, nullable: boolean): string {
  const t = dialectType.toLowerCase();
  let base: string;
  if (t === 'bit') base = 'boolean';
  else if (/^(tinyint|smallint|int|bigint)$/.test(t)) base = 'number';
  else if (/^(decimal|numeric|money|smallmoney)$/.test(t)) base = 'string';
  else if (/^(float|real)$/.test(t)) base = 'number';
  else if (/^(datetime|datetime2|smalldatetime|date|datetimeoffset)$/.test(t)) base = 'Date';
  else if (t === 'uniqueidentifier') base = 'string';
  else if (/(varbinary|binary|image|rowversion|timestamp)$/.test(t)) base = 'Uint8Array';
  else if (/(char|text|xml|time)/.test(t)) base = 'string';
  else base = 'unknown';
  return nullable ? `${base} | null` : base;
}

/** Is a SQL Server declared type a date/time type (so values coerce back to `Date`)? */
function isMssqlDateType(dialectType: string): boolean {
  const t = dialectType.toLowerCase();
  return isDateType(t) || /^(datetime|datetime2|smalldatetime|date|datetimeoffset)$/.test(t);
}

/** Map a schema-builder (Postgres-flavored) column type to SQL Server DDL. */
function mssqlColumnType(type: string, maxLength?: number | null): string {
  const t = type.toUpperCase();
  if (/BIGSERIAL/.test(t)) return 'BIGINT IDENTITY(1,1)';
  if (/SERIAL/.test(t)) return 'INT IDENTITY(1,1)';
  if (/BIGINT|INT8/.test(t)) return 'BIGINT';
  if (/SMALLINT|INT2/.test(t)) return 'SMALLINT';
  if (/INTEGER|INT4|\bINT\b/.test(t)) return 'INT';
  if (/BOOL/.test(t)) return 'BIT';
  if (/DOUBLE|FLOAT8/.test(t)) return 'FLOAT';
  if (/REAL|FLOAT4|FLOAT/.test(t)) return 'REAL';
  if (/NUMERIC|DECIMAL|MONEY/.test(t)) return 'DECIMAL(38,18)';
  if (/JSONB|JSON/.test(t)) return 'NVARCHAR(MAX)';
  if (/UUID/.test(t)) return 'UNIQUEIDENTIFIER';
  if (/TIMESTAMPTZ/.test(t)) return 'DATETIMEOFFSET';
  if (/TIMESTAMP|DATETIME/.test(t)) return 'DATETIME2';
  if (/\bDATE\b/.test(t)) return 'DATE';
  if (/\bTIME\b/.test(t)) return 'TIME';
  if (/BYTEA|BLOB/.test(t)) return 'VARBINARY(MAX)';
  if (/VARCHAR/.test(t)) return maxLength != null ? `NVARCHAR(${maxLength})` : 'NVARCHAR(255)';
  if (/CHAR/.test(t)) return maxLength != null ? `NCHAR(${maxLength})` : 'NCHAR(255)';
  if (/TEXT|CLOB/.test(t)) return 'NVARCHAR(MAX)';
  if (/ENUM/.test(t)) return 'NVARCHAR(255)';
  return type;
}

// ---------------------------------------------------------------------------
// mssqlDialect — the full Dialect contract for SQL Server 2016+
// ---------------------------------------------------------------------------

/**
 * SQL Server 2016+ implementation of the {@link Dialect} contract. Bracket
 * identifier quoting (`[…]`), named `@pN` placeholders, the `FOR JSON PATH`
 * nested-relation override (no `json_agg`), no `RETURNING`
 * (`resultStrategy = 'output'` via `OUTPUT INSERTED.*` / `MERGE`), `OFFSET/FETCH`
 * paging, and the Postgres-only capabilities disabled (vector / LISTEN-NOTIFY /
 * RLS).
 */
export const mssqlDialect: Dialect = {
  ...postgresDialect,
  name: 'mssql',
  // No RETURNING → the statement emits its rows via OUTPUT INSERTED.* in ONE
  // round-trip (Phase-0 'output' strategy, executed like 'returning').
  resultStrategy: 'output',
  supportsReturning: false,
  supportsILike: false,
  supportsVector: false,
  supportsListenNotify: false,
  supportsRLS: false,
  // SQL Server has OUTER APPLY, not FROM-clause LATERAL: the lateral pick plan
  // is Postgres-only (out of scope here).
  supportsLateralJoin: false,
  // sp_getapplock / sp_releaseapplock exist (used by a future migrate adapter).
  supportsAdvisoryLock: true,
  // No in-band EXPLAIN: SQL Server's SHOWPLAN is a session toggle
  // (SET SHOWPLAN_ALL ON), not a statement prefix, so a compiled query cannot
  // be explained in one round-trip. Override the inherited Postgres `EXPLAIN`
  // to absent → QueryInterface.explain() throws E017.
  explainQuery: undefined,
  // FOR JSON over zero rows is NULL → coalesced in the relation override.
  aggSupportsInlineOrderBy: false,
  jsonPathSupport: 'limited',
  emptyJsonArrayLiteral: "'[]'",
  nullJsonLiteral: 'NULL',

  // Named `@pN` placeholders bound by name via request.input('p'+i, value).
  paramPlaceholder(index: number): string {
    return `@p${index}`;
  },

  // Bracket-quote identifiers; escape a literal ']' as ']]' per T-SQL rules.
  quoteIdentifier(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  },

  // SQL Server aggregate casts: COUNT → INT, AVG/float → FLOAT.
  castAggregate(expr: string, target: 'int' | 'float'): string {
    return `CAST(${expr} AS ${target === 'int' ? 'INT' : 'FLOAT'})`;
  },

  // No array params. OPENJSON expands a single JSON-array param into a row set,
  // keeping ONE placeholder (so the SQL cache stays valid regardless of list
  // length) and handling the empty list (OPENJSON('[]') → zero rows). SQL Server
  // implicitly converts the nvarchar `value` to the column's type, so this works
  // for numbers AND strings. OPENJSON requires SQL Server 2016+.
  buildInClause(expr: string, paramRef: string, negated: boolean): string {
    return `${expr} ${negated ? 'NOT IN' : 'IN'} (SELECT [value] FROM OPENJSON(${paramRef}))`;
  },

  inClauseParam(values: unknown[]): unknown {
    return JSON.stringify(values ?? []);
  },

  // OUTPUT replaces RETURNING — injected mid-statement by the statement builders,
  // never as a trailing clause.
  buildReturningClause(): string {
    return '';
  },

  buildInsertStatement(input: InsertStatementInput): string {
    const out = input.returning ? ` OUTPUT INSERTED.${input.returning}` : '';
    return `INSERT INTO ${input.table} (${input.columns.join(', ')})${out} VALUES (${input.valuePlaceholders.join(', ')})`;
  },

  buildBulkInsertStatement(input: BulkInsertStatementInput): { sql: string; params: unknown[] } {
    // No UNNEST in SQL Server — emit multi-row VALUES with flattened, named `@pN`
    // placeholders. Enforce the engine's 1000-row / 2100-param statement limits.
    const rowCount = input.rowValues.length;
    const paramCount = input.rowValues.reduce((n, row) => n + row.length, 0);
    if (rowCount > MSSQL_MAX_INSERT_ROWS) {
      throw new ValidationError(
        `[turbine] SQL Server INSERT … VALUES is limited to ${MSSQL_MAX_INSERT_ROWS} rows per statement (got ${rowCount}). ` +
          'Chunk the data or use individual create() calls.',
      );
    }
    if (paramCount > MSSQL_MAX_PARAMS) {
      throw new ValidationError(
        `[turbine] SQL Server is limited to ${MSSQL_MAX_PARAMS} bound parameters per statement (got ${paramCount}). ` +
          'Reduce the batch size.',
      );
    }
    let n = 0;
    const placeholders = input.rowValues
      .map((row) => `(${row.map(() => this.paramPlaceholder(++n)).join(', ')})`)
      .join(', ');
    const out = input.returning ? ` OUTPUT INSERTED.${input.returning}` : '';
    // skipDuplicates has no single-statement equivalent here; ignored (documented).
    return {
      sql: `INSERT INTO ${input.table} (${input.columns.join(', ')})${out} VALUES ${placeholders}`,
      params: input.rowValues.flat(),
    };
  },

  buildUpsertStatement(input: UpsertStatementInput): string {
    // MERGE is the SQL Server upsert. The MERGE statement MUST end with `;`.
    // CONCURRENCY CAVEAT: MERGE is not a substitute for a UNIQUE/PK constraint —
    // keep the conflict columns backed by one and rely on UniqueConstraintError
    // (2627/2601 → E008) for a concurrent loser.
    const on = input.conflictColumns.map((c) => `T.${c} = S.${c}`).join(' AND ');
    const insertCols = input.insertColumns.join(', ');
    const sourceVals = input.insertColumns.map((c) => `S.${c}`).join(', ');
    const out = input.returning ? ` OUTPUT INSERTED.${input.returning}` : '';
    return (
      `MERGE INTO ${input.table} AS T ` +
      `USING (VALUES (${input.valuePlaceholders.join(', ')})) AS S (${insertCols}) ` +
      `ON (${on}) ` +
      `WHEN MATCHED THEN UPDATE SET ${input.updateSetClauses.join(', ')} ` +
      `WHEN NOT MATCHED THEN INSERT (${insertCols}) VALUES (${sourceVals})` +
      `${out};`
    );
  },

  // UPDATE/DELETE inject OUTPUT mid-statement (between SET and WHERE / FROM and
  // WHERE) — a trailing clause would be invalid T-SQL.
  buildUpdateStatement(input: UpdateStatementInput): string {
    const out = input.returning ? ` OUTPUT INSERTED.${input.returning}` : '';
    return `UPDATE ${input.table} SET ${input.setClauses.join(', ')}${out}${input.whereSql}`;
  },

  buildDeleteStatement(input: DeleteStatementInput): string {
    const out = input.returning ? ` OUTPUT DELETED.${input.returning}` : '';
    return `DELETE FROM ${input.table}${out}${input.whereSql}`;
  },

  // SQL Server has no LIMIT — emit OFFSET/FETCH, injecting a stable ORDER BY when
  // the outer query has none (OFFSET/FETCH requires an ORDER BY).
  buildLimitOffset(input: LimitOffsetInput): string {
    const { limitPlaceholder, offsetPlaceholder, hasOrderBy } = input;
    if (limitPlaceholder === undefined && offsetPlaceholder === undefined) return '';
    const order = hasOrderBy ? '' : ' ORDER BY (SELECT NULL)';
    const offset = offsetPlaceholder ?? '0';
    let clause = `${order} OFFSET ${offset} ROWS`;
    if (limitPlaceholder !== undefined) clause += ` FETCH NEXT ${limitPlaceholder} ROWS ONLY`;
    return clause;
  },

  // The crown jewel: nested relations via FOR JSON PATH (no json_agg). See the
  // module docstring + RelationSubqueryContext for the param-push ordering
  // contract (mirrors collectRelationSubqueryParams so the SQL cache stays valid).
  buildRelationSubquery(ctx: RelationSubqueryContext): string {
    return buildForJsonSubquery(this, ctx);
  },

  buildInsensitiveLike(column: string, paramRef: string): string {
    // Deterministic regardless of collation. NOTE: LOWER(col) can defeat an index
    // unless a computed/persisted LOWER() index exists.
    return `LOWER(${column}) LIKE LOWER(${paramRef})`;
  },

  // SQL Server has no JSON_CONTAINS. Emulate "the JSON array column contains the
  // scalar value" via OPENJSON (documented `limited`: object-containment and deep
  // paths are not supported — use a generated column + index for those).
  buildJsonContains(column: string, paramRef: string): string {
    return `EXISTS (SELECT 1 FROM OPENJSON(${column}) WHERE [value] = ${paramRef})`;
  },

  buildJsonPathExtract(column: string, pathParamRef: string): string {
    return `JSON_VALUE(${column}, ${pathParamRef})`;
  },

  // ---- Type mapping -------------------------------------------------------

  typeToTypeScript(dialectType: string, nullable: boolean): string {
    return mssqlTypeToTs(dialectType, nullable);
  },

  // No native array columns; bulk insert uses multi-row VALUES.
  arrayType: undefined,

  // ---- DDL ----------------------------------------------------------------

  buildColumnType(input: ColumnTypeInput): string {
    return mssqlColumnType(input.type, input.maxLength);
  },

  buildColumnDefinition(input: ColumnDefinitionInput): string {
    const isSerial = /serial/i.test(input.type);
    const parts: string[] = [input.name, this.buildColumnType(input)];
    if (input.primaryKey) parts.push('PRIMARY KEY');
    else if (input.unique) parts.push('UNIQUE');
    // IDENTITY columns are implicitly NOT NULL; PK is implicitly NOT NULL too.
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
  // they call `this.paramPlaceholder(n)` (→ `@pN`) and emit standard SQL valid on
  // SQL Server. The tracking-table DDL and the conflict-free INSERT need T-SQL forms.

  buildMigrationTrackingTable(table: string): string {
    return `
  IF OBJECT_ID(N'${table}', N'U') IS NULL
  CREATE TABLE ${table} (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    name NVARCHAR(255) NOT NULL UNIQUE,
    checksum NVARCHAR(255) NOT NULL,
    applied_at DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
  );
`;
  },

  buildMigrationInsertApplied(table: string): string {
    // INSERT-if-absent (SQL Server has no ON CONFLICT DO NOTHING).
    return (
      `IF NOT EXISTS (SELECT 1 FROM ${table} WHERE name = ${this.paramPlaceholder(1)}) ` +
      `INSERT INTO ${table} (name, checksum) VALUES (${this.paramPlaceholder(1)}, ${this.paramPlaceholder(2)})`
    );
  },

  // ---- Transaction control ------------------------------------------------

  beginStatement(isolationLevel?: string): string {
    // SQL Server cannot take an inline isolation level on BEGIN TRANSACTION. The
    // driver shim (MssqlTxClient) splits this exact compound and runs the parts in
    // order on the same transaction.
    return isolationLevel
      ? `SET TRANSACTION ISOLATION LEVEL ${isolationLevel}; BEGIN TRANSACTION`
      : 'BEGIN TRANSACTION';
  },

  commitStatement(): string {
    return 'COMMIT TRANSACTION';
  },

  rollbackStatement(): string {
    return 'ROLLBACK TRANSACTION';
  },

  savepointStatement(name: string): string {
    return `SAVE TRANSACTION ${name}`;
  },

  releaseSavepointStatement(): string {
    // SQL Server has no RELEASE SAVEPOINT — savepoints persist until the outer
    // commit/rollback. The shim treats the empty statement as a no-op.
    return '';
  },

  rollbackToSavepointStatement(name: string): string {
    return `ROLLBACK TRANSACTION ${name}`;
  },

  buildSetSessionConfig(): { sql: string; params: unknown[] } {
    // Never reached: supportsRLS=false makes $transaction throw before calling
    // this. Guarded here too so a misuse fails loudly. SQL Server's
    // sp_set_session_context is CONNECTION-scoped (not transaction-local like
    // Postgres set_config), so wiring it safely behind pooling is future work.
    throw new UnsupportedFeatureError(
      'sessionContext (RLS session GUCs)',
      'mssql',
      'SQL Server sp_set_session_context is connection-scoped, not transaction-local; not wired.',
    );
  },

  // ---- Streaming ----------------------------------------------------------

  /**
   * The {@link StreamableConnection} seam only exposes `query()`, not the `mssql`
   * `request.stream` event API, so this fetches once and yields the rows in
   * `batchSize` chunks. True server-side streaming would require direct `mssql`
   * access (documented limitation).
   */
  async *openStream(
    connection: StreamableConnection,
    sql: string,
    params: unknown[],
    batchSize: number,
  ): AsyncGenerator<Record<string, unknown>[], void, undefined> {
    const result = await connection.query(sql, params);
    for (let i = 0; i < result.rows.length; i += batchSize) {
      yield result.rows.slice(i, i + batchSize);
    }
  },

  // ---- Introspection ------------------------------------------------------

  introspector: {
    async introspect(options) {
      return introspectMssql(options);
    },
  } satisfies DialectIntrospector,
};

// ---------------------------------------------------------------------------
// FOR JSON PATH relation-subquery generator (the buildRelationSubquery override)
// ---------------------------------------------------------------------------

/**
 * Generate a correlated `FOR JSON PATH` subquery for one relation. SQL Server has
 * no `json_agg`, so the object shape is expressed by the child SELECT's column
 * ALIASES; to-many wraps `ISNULL((… FOR JSON PATH), '[]')` and to-one adds
 * `, WITHOUT_ARRAY_WRAPPER`. `INCLUDE_NULL_VALUES` keeps NULL columns present so
 * the parsed tree matches PostgreSQL's `json_build_object`. Nested relations are
 * embedded with `JSON_QUERY(...)` so they stay real JSON instead of being escaped
 * as a string.
 *
 * **Param-push order** strictly mirrors `collectRelationSubqueryParams`:
 *   - manyToMany / to-many with limit|orderBy: `where` → `limit` → nested;
 *   - to-one / unordered-unlimited to-many: nested → `where` (no limit).
 */
function buildForJsonSubquery(dialect: Dialect, ctx: RelationSubqueryContext): string {
  const { relDef, spec, params, parentRef, alias, targetTable, targetMeta, targetColumns, depth, path } = ctx;
  const q = (name: string): string => dialect.quoteIdentifier(name);
  const qTarget = q(targetTable);
  const qParent = q(parentRef);

  const orderEntries =
    spec !== true && spec.orderBy ? Object.entries(spec.orderBy).filter(([, dir]) => dir !== undefined) : [];
  const hasOrder = orderEntries.length > 0;
  const hasLimit = spec !== true && spec.limit !== undefined;

  /** `<alias>.<col> AS [<field>]` selection for the FOR JSON object keys. */
  const colSelect = (a: string): string[] =>
    targetColumns.map((col) => {
      const field = targetMeta.reverseColumnMap[col] ?? snakeToCamel(col);
      return `${a}.${q(col)} AS ${q(field)}`;
    });

  /** Build nested relations as `JSON_QUERY((<subquery>)) AS [<name>]` columns (pushes their params). */
  const buildNested = (parentAlias: string): string[] => {
    if (spec === true || !spec.with) return [];
    const cols: string[] = [];
    for (const [nestedRelName, nestedSpec] of sortedRelEntries(spec.with)) {
      const nestedRelDef = targetMeta.relations[nestedRelName];
      if (!nestedRelDef) {
        throw new RelationError(
          `[turbine] Unknown relation "${nestedRelName}" on table "${targetTable}". ` +
            `Available: ${Object.keys(targetMeta.relations).join(', ')}`,
        );
      }
      const sub = ctx.recurse(nestedRelDef, nestedSpec, parentAlias, depth + 1, [...path, relDef.name]);
      cols.push(`JSON_QUERY((${sub})) AS ${q(nestedRelName)}`);
    }
    return cols;
  };

  /** ORDER BY + OFFSET/FETCH paging clause for a to-many FOR JSON subquery. */
  const buildPaging = (a: string, limitPlaceholder: string | undefined): string => {
    if (hasOrder) {
      const orderBy = orderEntries
        .map(([k, dir]) => {
          // FOR JSON nested ordering supports plain directions and { sort }
          // specs only. Object shapes the core builder compiles with params
          // (JSON-path / vector / relation ordering) must throw here: the
          // shared param-collect mirror is gated on the native path, so a
          // silently-ignored object would desync SQL text from params.
          let rawDir: unknown = dir;
          if (typeof dir === 'object' && dir !== null) {
            const sortValue = (dir as { sort?: unknown }).sort;
            if (typeof sortValue !== 'string') {
              throw new ValidationError(
                `[turbine] Nested orderBy on "${k}" (table "${targetTable}"): only plain directions and ` +
                  `{ sort } specs are supported inside a relation orderBy on SQL Server.`,
              );
            }
            if ((dir as { nulls?: unknown }).nulls !== undefined) {
              throw new UnsupportedFeatureError(
                'NULLS FIRST/LAST ordering',
                'sqlserver',
                'Explicit nulls placement in orderBy is only available on PostgreSQL and SQLite.',
              );
            }
            rawDir = sortValue;
          }
          // columnMap-first resolution (camelToSnake fallback): matches the
          // core builder's nested orderBy path so camelCase-named DB columns
          // resolve on SQL Server too.
          const col = targetMeta.columnMap[k] ?? camelToSnake(k);
          if (!targetMeta.allColumns.includes(col)) {
            throw new ValidationError(
              `[turbine] Unknown field "${k}" in orderBy on table "${targetTable}". ` +
                `Known fields: ${Object.keys(targetMeta.columnMap).join(', ') || '(none)'}.`,
            );
          }
          const safeDir = String(rawDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
          return `${a}.${q(col)} ${safeDir}`;
        })
        .join(', ');
      // FOR JSON permits ORDER BY; OFFSET/FETCH is only needed to apply a LIMIT.
      return limitPlaceholder !== undefined
        ? ` ORDER BY ${orderBy} OFFSET 0 ROWS FETCH NEXT ${limitPlaceholder} ROWS ONLY`
        : ` ORDER BY ${orderBy}`;
    }
    if (limitPlaceholder !== undefined) {
      return ` ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT ${limitPlaceholder} ROWS ONLY`;
    }
    return '';
  };

  // ----- manyToMany: JOIN target through the junction table -----------------
  if (relDef.type === 'manyToMany') {
    return buildForJsonManyToMany(dialect, ctx, { colSelect, buildNested, buildPaging, hasLimit });
  }

  const isToOne = relDef.type === 'belongsTo' || relDef.type === 'hasOne';
  // Correlation direction is about WHERE THE FK LIVES, not cardinality:
  // belongsTo has it on the source; hasMany AND hasOne have it on the target.
  const correlation =
    relDef.type === 'belongsTo'
      ? dialect.buildCorrelation(alias, relDef.referenceKey, qParent, relDef.foreignKey)
      : dialect.buildCorrelation(alias, relDef.foreignKey, qParent, relDef.referenceKey);

  // ----- to-one (belongsTo / hasOne): single object, no paging --------------
  if (isToOne) {
    // Non-wrap order: nested → where (matches collectRelationSubqueryParams).
    const nestedCols = buildNested(alias);
    const extra = ctx.buildWhere(alias);
    const where = extra ? `${correlation} AND ${extra}` : correlation;
    const cols = [...colSelect(alias), ...nestedCols].join(', ');
    // TOP 1 guarantees a single object for WITHOUT_ARRAY_WRAPPER; NULL when no row.
    return `SELECT TOP 1 ${cols} FROM ${qTarget} ${alias} WHERE ${where} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES`;
  }

  // ----- hasMany ------------------------------------------------------------
  const willWrap = hasLimit || hasOrder;
  let nestedCols: string[];
  let extra: string;
  let limitPlaceholder: string | undefined;

  if (willWrap) {
    // Wrap order: where → limit → nested.
    extra = ctx.buildWhere(alias);
    if (hasLimit) {
      params.push(Number((spec as { limit?: unknown }).limit));
      limitPlaceholder = dialect.paramPlaceholder(params.length);
    }
    nestedCols = buildNested(alias);
  } else {
    // Non-wrap order: nested → where (no limit param).
    nestedCols = buildNested(alias);
    extra = ctx.buildWhere(alias);
  }

  const where = extra ? `${correlation} AND ${extra}` : correlation;
  const cols = [...colSelect(alias), ...nestedCols].join(', ');
  const paging = buildPaging(alias, limitPlaceholder);
  return `SELECT ISNULL((SELECT ${cols} FROM ${qTarget} ${alias} WHERE ${where}${paging} FOR JSON PATH, INCLUDE_NULL_VALUES), '[]')`;
}

interface ForJsonHelpers {
  colSelect(alias: string): string[];
  buildNested(parentAlias: string): string[];
  buildPaging(alias: string, limitPlaceholder: string | undefined): string;
  hasLimit: boolean;
}

/** `FOR JSON PATH` subquery for a manyToMany relation (JOIN target through junction). */
function buildForJsonManyToMany(dialect: Dialect, ctx: RelationSubqueryContext, h: ForJsonHelpers): string {
  const { relDef, spec, params, parentRef, alias, targetTable, targetMeta } = ctx;
  const q = (name: string): string => dialect.quoteIdentifier(name);
  if (!relDef.through) {
    throw new ValidationError(
      `[turbine] manyToMany relation "${relDef.name}" is missing a \`through\` junction descriptor.`,
    );
  }

  const qTarget = q(targetTable);
  const qJunction = q(relDef.through.table);
  const qParent = q(parentRef);
  const jalias = `${alias}j`;

  // JOIN: junction.targetKey = target.<PK>.
  const targetKeys = normalizeKeyColumns(relDef.through.targetKey);
  if (targetMeta.primaryKey.length === 0) {
    throw new ValidationError(
      `[turbine] manyToMany relation "${relDef.name}" targets table "${targetTable}" which has no primary key; ` +
        'cannot determine the join column.',
    );
  }
  const targetPk = targetMeta.primaryKey;
  if (targetKeys.length !== targetPk.length) {
    throw new ValidationError(
      `[turbine] manyToMany relation "${relDef.name}": through.targetKey has ${targetKeys.length} column(s) ` +
        `but target "${targetTable}" primary key has ${targetPk.length}.`,
    );
  }
  const joinOn = targetKeys.map((jcol, i) => `${jalias}.${q(jcol)} = ${alias}.${q(targetPk[i]!)}`).join(' AND ');

  // Correlation: junction.sourceKey = parent.<referenceKey>.
  const sourceKeys = normalizeKeyColumns(relDef.through.sourceKey);
  const refKeys = normalizeKeyColumns(relDef.referenceKey);
  if (sourceKeys.length !== refKeys.length) {
    throw new ValidationError(
      `[turbine] manyToMany relation "${relDef.name}": through.sourceKey has ${sourceKeys.length} column(s) ` +
        `but referenceKey has ${refKeys.length}.`,
    );
  }
  const correlation = sourceKeys.map((jcol, i) => `${jalias}.${q(jcol)} = ${qParent}.${q(refKeys[i]!)}`).join(' AND ');

  // Param order mirrors collectRelationSubqueryParams: where → limit → nested.
  const extra = ctx.buildWhere(alias);
  let limitPlaceholder: string | undefined;
  if (h.hasLimit) {
    params.push(Number((spec as { limit?: unknown }).limit));
    limitPlaceholder = dialect.paramPlaceholder(params.length);
  }
  const nestedCols = h.buildNested(alias);

  const where = extra ? `${correlation} AND ${extra}` : correlation;
  const cols = [...h.colSelect(alias), ...nestedCols].join(', ');
  const paging = h.buildPaging(alias, limitPlaceholder);
  return (
    `SELECT ISNULL((SELECT ${cols} FROM ${qTarget} ${alias} ` +
    `JOIN ${qJunction} ${jalias} ON ${joinOn} WHERE ${where}${paging} ` +
    `FOR JSON PATH, INCLUDE_NULL_VALUES), '[]')`
  );
}

// ---------------------------------------------------------------------------
// Introspection — INFORMATION_SCHEMA + sys.* driven SchemaMetadata
// ---------------------------------------------------------------------------

/** Async executor that returns plain row objects for a parameterized (`@pN`) query. */
export type MssqlRowExecutor = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

interface FKEntry {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  constraintName: string;
}

const num = (v: number | string | null | undefined): number => (typeof v === 'string' ? Number(v) : (v ?? 0));

/**
 * Derive relations from the FK list via the SHARED introspection pipeline
 * (`deriveEngineRelations` → `buildRelationsFromForeignKeys` +
 * `addAutoManyToManyRelations` in introspect.ts), so this engine derives
 * IDENTICAL relation names to `turbine generate` against Postgres for the
 * same logical schema — legacy-first naming, per-column disambiguation, and
 * collision resolution against scalar column fields included.
 */
function buildRelationsFromForeignKeys(
  tableNames: string[],
  foreignKeys: FKEntry[],
  pkByTable: Map<string, string[]>,
  columnsByTable: Map<string, ColumnMetadata[]>,
): Map<string, Record<string, RelationDef>> {
  return deriveEngineRelations(tableNames, foreignKeys, pkByTable, columnsByTable);
}

/**
 * Introspect a SQL Server database into the same {@link SchemaMetadata} shape the
 * Postgres catalog introspector produces, using a caller-supplied query executor
 * (so tests can dogfood an already-open `mssql` pool/connection). Reads
 * `INFORMATION_SCHEMA.*` plus `sys.identity_columns` / `sys.foreign_keys` /
 * `sys.indexes`.
 *
 * @param exec   Runs a parameterized (`@p1`, `@p2`, …) query and returns rows.
 * @param schema The SQL Server schema to introspect (default `dbo`).
 */
export async function introspectMssqlWith(
  exec: MssqlRowExecutor,
  schema = 'dbo',
  options: { include?: string[]; exclude?: string[] } = {},
): Promise<SchemaMetadata> {
  // ----- Tables -----
  let tableNames = (
    await exec(
      "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = @p1 AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
      [schema],
    )
  ).map((r) => String(r.TABLE_NAME));
  if (options.include?.length) {
    const inc = new Set(options.include);
    tableNames = tableNames.filter((t) => inc.has(t));
  }
  if (options.exclude?.length) {
    const exc = new Set(options.exclude);
    tableNames = tableNames.filter((t) => !exc.has(t));
  }
  const tableSet = new Set(tableNames);

  // ----- Identity columns (mark hasDefault) -----
  const identityRows = await exec(
    `SELECT t.name AS TABLE_NAME, c.name AS COLUMN_NAME
     FROM sys.identity_columns c
     JOIN sys.tables t ON t.object_id = c.object_id
     JOIN sys.schemas s ON s.schema_id = t.schema_id
     WHERE s.name = @p1`,
    [schema],
  );
  const identityCols = new Set(identityRows.map((r) => `${r.TABLE_NAME}.${r.COLUMN_NAME}`));

  // ----- Columns -----
  const columnRows = await exec(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_MAXIMUM_LENGTH
     FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = @p1 ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [schema],
  );

  // ----- Primary keys (ordered) -----
  const pkRows = await exec(
    `SELECT kcu.TABLE_NAME, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION
     FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
     JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
       ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
     WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY' AND tc.TABLE_SCHEMA = @p1
     ORDER BY kcu.TABLE_NAME, kcu.ORDINAL_POSITION`,
    [schema],
  );
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows) {
    const t = String(r.TABLE_NAME);
    if (!tableSet.has(t)) continue;
    if (!pkByTable.has(t)) pkByTable.set(t, []);
    pkByTable.get(t)!.push(String(r.COLUMN_NAME));
  }
  const pkColSet = new Set<string>();
  for (const [t, cols] of pkByTable) for (const c of cols) pkColSet.add(`${t}.${c}`);

  // ----- Assemble columns -----
  const columnsByTable = new Map<string, ColumnMetadata[]>();
  for (const c of columnRows) {
    const tableName = String(c.TABLE_NAME);
    if (!tableSet.has(tableName)) continue;
    const colName = String(c.COLUMN_NAME);
    const dataType = String(c.DATA_TYPE).toLowerCase();
    const isPk = pkColSet.has(`${tableName}.${colName}`);
    const nullable = String(c.IS_NULLABLE).toUpperCase() === 'YES' && !isPk;
    const maxLen = c.CHARACTER_MAXIMUM_LENGTH != null ? num(c.CHARACTER_MAXIMUM_LENGTH as number) : undefined;
    const col: ColumnMetadata = {
      name: colName,
      field: snakeToCamel(colName),
      dialectType: dataType,
      pgType: dataType,
      tsType: mssqlTypeToTs(dataType, nullable),
      nullable,
      hasDefault: c.COLUMN_DEFAULT !== null || identityCols.has(`${tableName}.${colName}`),
      isArray: false,
      arrayType: undefined,
      pgArrayType: 'text[]',
    };
    if (maxLen !== undefined && maxLen >= 0) col.maxLength = maxLen;
    if (!columnsByTable.has(tableName)) columnsByTable.set(tableName, []);
    columnsByTable.get(tableName)!.push(col);
  }

  // ----- Foreign keys (grouped by constraint for composite FKs) -----
  const fkRows = await exec(
    `SELECT fk.name AS CONSTRAINT_NAME,
            OBJECT_NAME(fkc.parent_object_id) AS TABLE_NAME,
            cps.name AS COLUMN_NAME,
            OBJECT_NAME(fkc.referenced_object_id) AS REFERENCED_TABLE_NAME,
            cpt.name AS REFERENCED_COLUMN_NAME,
            fkc.constraint_column_id AS ORDINAL_POSITION
     FROM sys.foreign_keys fk
     JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
     JOIN sys.columns cps ON cps.object_id = fkc.parent_object_id AND cps.column_id = fkc.parent_column_id
     JOIN sys.columns cpt ON cpt.object_id = fkc.referenced_object_id AND cpt.column_id = fkc.referenced_column_id
     JOIN sys.schemas s ON s.schema_id = fk.schema_id
     WHERE s.name = @p1
     ORDER BY fk.name, fkc.constraint_column_id`,
    [schema],
  );
  const fkByConstraint = new Map<string, FKEntry>();
  for (const r of fkRows) {
    const sourceTable = String(r.TABLE_NAME);
    const targetTable = String(r.REFERENCED_TABLE_NAME);
    if (!tableSet.has(sourceTable)) continue;
    const key = String(r.CONSTRAINT_NAME);
    let entry = fkByConstraint.get(key);
    if (!entry) {
      entry = { sourceTable, sourceColumns: [], targetTable, targetColumns: [], constraintName: key };
      fkByConstraint.set(key, entry);
    }
    entry.sourceColumns.push(String(r.COLUMN_NAME));
    entry.targetColumns.push(String(r.REFERENCED_COLUMN_NAME));
  }
  const foreignKeys = [...fkByConstraint.values()].filter((fk) => tableSet.has(fk.targetTable));

  // ----- Indexes + unique constraints -----
  const idxRows = await exec(
    `SELECT t.name AS TABLE_NAME, i.name AS INDEX_NAME, i.is_unique AS IS_UNIQUE,
            c.name AS COLUMN_NAME, ic.key_ordinal AS SEQ
     FROM sys.indexes i
     JOIN sys.tables t ON t.object_id = i.object_id
     JOIN sys.schemas s ON s.schema_id = t.schema_id
     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE s.name = @p1 AND i.is_primary_key = 0 AND ic.is_included_column = 0 AND i.name IS NOT NULL
     ORDER BY t.name, i.name, ic.key_ordinal`,
    [schema],
  );
  const indexGroups = new Map<string, { table: string; name: string; unique: boolean; columns: string[] }>();
  for (const r of idxRows) {
    const t = String(r.TABLE_NAME);
    if (!tableSet.has(t)) continue;
    const name = String(r.INDEX_NAME);
    const key = `${t}.${name}`;
    let g = indexGroups.get(key);
    if (!g) {
      g = { table: t, name, unique: num(r.IS_UNIQUE as number) === 1, columns: [] };
      indexGroups.set(key, g);
    }
    g.columns.push(String(r.COLUMN_NAME));
  }
  const indexesByTable = new Map<string, IndexMetadata[]>();
  const uniqueByTable = new Map<string, string[][]>();
  for (const g of indexGroups.values()) {
    if (!indexesByTable.has(g.table)) indexesByTable.set(g.table, []);
    indexesByTable.get(g.table)!.push({
      name: g.name,
      columns: g.columns,
      unique: g.unique,
      definition: `${g.unique ? 'UNIQUE ' : ''}INDEX ${g.name} ON ${g.table}(${g.columns.join(', ')})`,
    });
    if (g.unique && g.columns.length > 0) {
      if (!uniqueByTable.has(g.table)) uniqueByTable.set(g.table, []);
      uniqueByTable.get(g.table)!.push(g.columns);
    }
  }

  // ----- Relations -----
  const relationsByTable = buildRelationsFromForeignKeys(tableNames, foreignKeys, pkByTable, columnsByTable);

  // ----- Assemble TableMetadata -----
  const tables: Record<string, TableMetadata> = {};
  for (const tableName of tableNames) {
    const columns = columnsByTable.get(tableName) ?? [];
    const columnMap: Record<string, string> = {};
    const reverseColumnMap: Record<string, string> = {};
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = {};
    const pgTypes: Record<string, string> = {};
    const allColumns: string[] = [];

    for (const col of columns) {
      columnMap[col.field] = col.name;
      reverseColumnMap[col.name] = col.field;
      allColumns.push(col.name);
      dialectTypes[col.name] = col.dialectType ?? col.pgType;
      pgTypes[col.name] = col.pgType;
      if (isMssqlDateType(col.dialectType ?? col.pgType)) dateColumns.add(col.name);
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
      relations: relationsByTable.get(tableName) ?? {},
      indexes: indexesByTable.get(tableName) ?? [],
    };
  }

  // SQL Server has no first-class enum type — enums are CHECK constraints; left empty.
  return { tables, enums: {} } satisfies SchemaMetadata;
}

/**
 * Open a short-lived `mssql` connection from `options.connectionString`, introspect
 * the database (schema = `options.schema` or `dbo`), and close it. Wraps
 * {@link introspectMssqlWith} for the {@link DialectIntrospector} seam used by
 * `introspect()` / `npx turbine generate`.
 */
export async function introspectMssql(options: IntrospectOptions): Promise<SchemaMetadata> {
  const sqlNS = await loadMssql();
  const config = parseMssqlConfig(options.connectionString);
  const pool = await new sqlNS.ConnectionPool(config).connect();
  try {
    const mp = new MssqlPool(pool, sqlNS);
    const exec: MssqlRowExecutor = async (sql, params) => (await mp.query(sql, params)).rows;
    return introspectMssqlWith(exec, options.schema ?? 'dbo', {
      include: options.include,
      exclude: options.exclude,
    });
  } finally {
    await pool.close();
  }
}

// ---------------------------------------------------------------------------
// mssql loading + config
// ---------------------------------------------------------------------------

interface MssqlConnectionConfig {
  server?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  options?: { encrypt?: boolean; trustServerCertificate?: boolean };
}

/** Parse a `mssql://user:pass@host:port/db` connection string into mssql config. */
function parseMssqlConfig(connectionString: string): MssqlConnectionConfig {
  try {
    const u = new URL(connectionString);
    const config: MssqlConnectionConfig = {
      server: u.hostname || 'localhost',
      port: u.port ? Number(u.port) : 1433,
      // Sensible local/dev defaults; pass an explicit config object to override.
      options: { encrypt: false, trustServerCertificate: true },
    };
    if (u.username) config.user = decodeURIComponent(u.username);
    if (u.password) config.password = decodeURIComponent(u.password);
    const db = u.pathname.replace(/^\//, '');
    if (db) config.database = decodeURIComponent(db);
    return config;
  } catch {
    throw new ConnectionError(`[turbine] Invalid MSSQL connection string: "${connectionString}"`);
  }
}

/**
 * Dynamically load the `mssql` module. Kept out of the static import graph so
 * `import 'turbine-orm/mssql'` never throws when `mssql` is absent for a consumer
 * that does not use the factory.
 */
async function loadMssql(): Promise<MssqlModule> {
  let mod: { default?: MssqlModule } & Partial<MssqlModule>;
  try {
    // `mssql` ships no bundled type declarations (it needs @types/mssql, which
    // Turbine deliberately does not depend on) — the structural MssqlModule
    // above is our typed surface; the helper returns `unknown` so no TS7016.
    // Via the .cts helper so the CJS build keeps a path to a REAL dynamic
    // import() even if a future mssql major goes ESM-only (the CommonJS pass
    // transpiles a plain `import()` here into `require()`).
    mod = (await importOptionalPeer('mssql')) as typeof mod;
  } catch (err) {
    throw new ConnectionError(
      "[turbine] turbine-orm/mssql requires the optional peer dependency 'mssql'. Install it: npm i mssql. " +
        `(${(err as Error).message})`,
    );
  }
  // `mssql` is a CommonJS module; the namespace may be on `default` under ESM interop.
  const ns = (mod.default ?? mod) as MssqlModule;
  if (typeof ns.ConnectionPool !== 'function' || typeof ns.Request !== 'function') {
    throw new ConnectionError("[turbine] Loaded 'mssql' but it is missing ConnectionPool/Request exports.");
  }
  return ns;
}

/**
 * Fail fast on unsupported servers: SQL Server 2016+ is required (`FOR JSON PATH`,
 * `OPENJSON`, and the relation engine need it). ProductMajorVersion 13 = 2016.
 */
function assertSupportedVersion(majorVersion: number): void {
  if (majorVersion > 0 && majorVersion < 13) {
    throw new ConnectionError(
      `[turbine] turbine-orm/mssql requires SQL Server 2016+ (FOR JSON / OPENJSON); got major version ${majorVersion}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// turbineMssql — the public factory
// ---------------------------------------------------------------------------

/** Options for {@link turbineMssql}. Mirrors the relevant {@link TurbineConfig} fields. */
export interface TurbineMssqlOptions extends Pick<TurbineConfig, 'logging' | 'defaultLimit' | 'warnOnUnlimited'> {
  /** SQL Server schema for introspection / DDL (default `dbo`). */
  schema?: string;
}

function isMssqlPool(x: unknown): x is MssqlConnectionPool {
  return (
    !!x &&
    typeof (x as MssqlConnectionPool).request === 'function' &&
    typeof (x as MssqlConnectionPool).close === 'function'
  );
}

/**
 * Create a {@link TurbineClient} bound to SQL Server 2016+ via `mssql`.
 *
 * Pass one of:
 *  - a connection string (`'mssql://sa:pass@host:1433/db'`),
 *  - an `mssql` config object (`{ server, user, password, database, options }`),
 *  - an existing `MssqlPool` (injection — you own its lifecycle, `disconnect()` is
 *    a no-op).
 *
 * When Turbine builds the pool (string/config), it probes
 * `SERVERPROPERTY('ProductMajorVersion')` to reject SQL Server < 2016, and
 * `disconnect()` closes the pool it created.
 *
 * @example
 * ```ts
 * import { turbineMssql } from 'turbine-orm/mssql';
 * const db = await turbineMssql('mssql://sa:Passw0rd!@localhost:1433/app', SCHEMA);
 * ```
 */
export async function turbineMssql(
  target: string | MssqlConnectionConfig | MssqlPool,
  schema: SchemaMetadata,
  options: TurbineMssqlOptions = {},
): Promise<TurbineClient> {
  let pool: MssqlPool;
  let owns = false;

  if (target instanceof MssqlPool) {
    pool = target;
  } else {
    const sqlNS = await loadMssql();
    if (isMssqlPool(target)) {
      pool = new MssqlPool(target, sqlNS);
    } else {
      const config = typeof target === 'string' ? parseMssqlConfig(target) : (target as MssqlConnectionConfig);
      const rawPool = await new sqlNS.ConnectionPool(config).connect();
      pool = new MssqlPool(rawPool, sqlNS);
      owns = true;
    }
  }

  // Probe the server version (fail fast on SQL Server < 2016).
  try {
    const rows = (await pool.query("SELECT CAST(SERVERPROPERTY('ProductMajorVersion') AS INT) AS v")).rows as {
      v?: number;
    }[];
    assertSupportedVersion(Number(rows[0]?.v ?? 0));
  } catch (err) {
    if (err instanceof ConnectionError) throw err;
    // A non-version probe failure (permissions, etc.) should not block startup.
  }

  const client = new TurbineClient(
    {
      pool,
      dialect: mssqlDialect,
      preparedStatements: false,
      logging: options.logging,
      defaultLimit: options.defaultLimit,
      warnOnUnlimited: options.warnOnUnlimited,
    },
    schema,
  );

  if (owns) {
    // Turbine built this pool, so disconnect()/end() must close it. External pools
    // (injection) stay the caller's responsibility (disconnect() no-op), consistent
    // with turbineHttp / turbineMysql / turbineSqlite.
    const baseDisconnect = client.disconnect.bind(client);
    const close = async (): Promise<void> => {
      await baseDisconnect();
      await pool.end();
    };
    const patch = client as unknown as { disconnect: () => Promise<void>; end: () => Promise<void> };
    patch.disconnect = close;
    patch.end = close;
  }

  return client;
}
