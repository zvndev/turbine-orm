# Multi-Database Support — Architecture Plan

**Status:** Design (not started)
**Author:** ZVN DEV
**Date:** 2026-05-09
**Turbine version at time of writing:** 0.9.2

---

## Executive Summary

Turbine ORM is deeply PostgreSQL-native. Its core differentiator — single-query nested relations via `json_agg` — relies on Postgres-specific JSON aggregation, `$N` parameterization, `pg_catalog` introspection, and advisory locks. Adding MySQL/SQLite support is not a matter of swapping SQL strings; each dialect requires a separate implementation of the query builder, introspection, migration locking, and code generation output.

This document defines the architecture for multi-database support without degrading the PostgreSQL path that existing users depend on.

---

## 1. Package Architecture

### Option A: Separate npm Packages (Monorepo)

```
packages/
  turbine-core/          → shared types, error system, schema-builder
  turbine-orm/           → PostgreSQL dialect (current package, re-exports core)
  turbine-orm-mysql/     → MySQL dialect
  turbine-orm-sqlite/    → SQLite dialect
```

**Trade-offs:**
- (+) Independent versioning — MySQL bugs don't block Postgres releases
- (+) Users only install what they need — no dead code for unused dialects
- (+) Clear ownership boundaries per package
- (-) Monorepo tooling overhead (turborepo/nx, cross-package linking)
- (-) Shared types require an extra `turbine-core` dependency
- (-) Breaking changes to core types require coordinated releases

### Option B: Single Package with Subpath Exports

```
turbine-orm            → PostgreSQL (default, unchanged)
turbine-orm/mysql      → MySQL dialect
turbine-orm/sqlite     → SQLite dialect
turbine-orm/core       → shared types (already partially exposed)
```

**Trade-offs:**
- (+) Single package to manage, single version number
- (+) Subpath exports already proven (we ship `turbine-orm/serverless` today)
- (+) Tree-shaking eliminates unused dialect code — bundle size impact is zero for most users
- (+) Shared types are internal, no extra install
- (-) Larger tarball on npm (includes all dialect code)
- (-) A MySQL-only bug fix bumps the version for everyone
- (-) `pg` would remain as a dependency even for MySQL-only users (fixable via peerDeps)

### Option C: Hybrid — Core + Dialect Packages

```
turbine-orm            → PostgreSQL (unchanged, depends on @turbine-orm/core)
@turbine-orm/core      → shared types, errors, schema-builder, dialect interface
@turbine-orm/mysql     → MySQL dialect (depends on @turbine-orm/core)
@turbine-orm/sqlite    → SQLite dialect (depends on @turbine-orm/core)
```

**Trade-offs:**
- (+) Clean separation without forcing users to change imports
- (+) `turbine-orm` stays exactly as-is for existing users
- (+) Each dialect declares its own driver dependency (`mysql2`, `better-sqlite3`)
- (-) Scoped packages (`@turbine-orm/`) require npm org setup
- (-) Core must be published first on every release

### Recommendation: Option C (Hybrid)

Reason: `turbine-orm` remains untouched for the 99% of current users who are Postgres-only. New dialects get clean packages with their own driver dependencies. The shared `@turbine-orm/core` houses types and the dialect contract without bloating the main package.

---

## 2. Shared vs. Forked Code

### SHARED (same code, imported from `@turbine-orm/core`)

| Module | LOC (current) | Rationale |
|--------|--------------|-----------|
| `query/types.ts` | ~430 | Users learn ONE API across all dialects. `WhereClause`, `FindManyArgs`, `WithClause`, `WithOptions` are dialect-agnostic. |
| `errors.ts` | ~250 | Error hierarchy, codes E001-E014, `TurbineError` base class. Constraint errors (E008-E011) map to equivalent dialect violations. |
| `schema.ts` (interfaces only) | ~85 | `SchemaMetadata`, `TableMetadata`, `ColumnMetadata`, `RelationDef`, `IndexMetadata` — the universal metadata shape. |
| `schema-builder.ts` (API surface) | ~482 | `defineSchema()` stays identical. Column type names get a dialect-aware mapping layer. |
| `pipeline.ts` (interface) | ~50 | `DeferredQuery<T>` interface. Execution strategy differs per dialect but the batching contract is shared. |
| Client interface | ~100 | `TurbineClient` shape, middleware system, `$transaction`, `$use`. |
| LRUCache, escapeLike | ~80 | Pure utility code with no dialect assumptions. |

### FORKED (separate implementation per dialect)

| Module | LOC to rewrite | What changes |
|--------|---------------|--------------|
| `query/builder.ts` | ~3,100 | SQL generation: json functions, parameter syntax, quoting, RETURNING, UNNEST, type casts, ILIKE vs COLLATE |
| `query/utils.ts` (quoteIdent) | ~30 | `"x"` (pg) vs `` `x` `` (mysql) vs `"x"` (sqlite) |
| `introspect.ts` | ~340 | Entirely different system catalogs per database |
| `cli/migrate.ts` (locking + DDL) | ~300 | Advisory locks, DDL differences, tracking table syntax |
| `schema-sql.ts` | ~480 | DDL generation, type mapping, ALTER TABLE constraints |
| `generate.ts` (type mapping) | ~100 | `pgTypeToTs` becomes `mysqlTypeToTs`, `sqliteTypeToTs` |
| `client.ts` (pool management) | ~400 | Different driver APIs, connection semantics, type parsers |

---

## 3. Dialect Interface

This is the contract each database must implement. The PostgreSQL dialect would be extracted into this shape as Phase 1.

```typescript
// @turbine-orm/core/src/dialect.ts

import type { SchemaMetadata, TableMetadata, ColumnMetadata, RelationDef } from './schema.js';
import type { DeferredQuery } from './query/types.js';
import type { WithClause, WithOptions, WhereClause } from './query/types.js';

// ---------------------------------------------------------------------------
// Core dialect contract
// ---------------------------------------------------------------------------

export interface Dialect {
  /** Dialect identifier: 'postgresql' | 'mysql' | 'sqlite' */
  readonly name: string;

  /** Parameter placeholder for the Nth value (0-indexed internally, 1-indexed for pg) */
  paramPlaceholder(index: number): string;

  /** Quote a SQL identifier (table/column name) */
  quoteIdentifier(name: string): string;

  /**
   * Build a JSON aggregation expression that collects rows into an array.
   * Must handle NULL → empty array fallback.
   *
   * @param jsonObjectExpr - The json_build_object / JSON_OBJECT expression for one row
   * @param orderBy - Optional ORDER BY clause to apply before aggregation
   * @returns SQL expression that evaluates to a JSON array string
   */
  buildJsonArrayAgg(jsonObjectExpr: string, orderBy?: string): string;

  /**
   * Build a JSON object expression from key-value pairs.
   *
   * @param pairs - Array of [camelCaseKey, sqlExpression] tuples
   * @returns SQL expression that evaluates to a JSON object string
   */
  buildJsonObject(pairs: [key: string, expr: string][]): string;

  /**
   * Whether the dialect supports RETURNING on INSERT/UPDATE/DELETE.
   * PostgreSQL: true, MySQL: false, SQLite: true (3.35+)
   */
  readonly supportsReturning: boolean;

  /**
   * Generate the SQL to retrieve the last inserted row when RETURNING
   * is not available. MySQL needs `SELECT * FROM t WHERE id = LAST_INSERT_ID()`.
   */
  buildLastInsertFetch?(table: string, primaryKey: string): string;

  /**
   * Whether the dialect supports ILIKE (case-insensitive LIKE).
   * PostgreSQL: true (native ILIKE)
   * MySQL: false (use COLLATE or LOWER())
   * SQLite: false (use LIKE with NOCASE collation)
   */
  readonly supportsILike: boolean;

  /**
   * Generate case-insensitive LIKE equivalent when ILIKE is not supported.
   * @param column - Quoted column expression
   * @param paramRef - Parameter placeholder (e.g. $1 or ?)
   * @returns SQL expression for case-insensitive pattern match
   */
  buildInsensitiveLike(column: string, paramRef: string): string;

  /**
   * Whether this dialect supports JSON path operators (@>, #>>).
   * PostgreSQL: full JSONB operators
   * MySQL: JSON_CONTAINS, JSON_EXTRACT
   * SQLite: json_extract
   */
  readonly jsonPathSupport: 'native' | 'function' | 'limited';

  /**
   * Build a JSON containment check (Postgres @>, MySQL JSON_CONTAINS).
   */
  buildJsonContains(column: string, paramRef: string): string;

  /**
   * Build a JSON path extraction (Postgres #>> $N::text[], MySQL JSON_EXTRACT).
   */
  buildJsonPathExtract(column: string, pathParamRef: string): string;

  /**
   * UNNEST equivalent for bulk insert. Postgres uses UNNEST($1::type[]).
   * MySQL uses multi-row VALUES. SQLite uses repeated INSERT or CTE.
   */
  buildBulkInsert(
    table: string,
    columns: string[],
    rowCount: number,
    paramStartIndex: number,
  ): string;

  /**
   * Build an upsert statement (INSERT ... ON CONFLICT for PG,
   * INSERT ... ON DUPLICATE KEY for MySQL, INSERT OR REPLACE for SQLite).
   */
  buildUpsert(
    table: string,
    columns: string[],
    conflictColumns: string[],
    updateColumns: string[],
    paramCount: number,
  ): string;

  /**
   * Escape a single-quote character for embedding in SQL string literals.
   * Used inside json_build_object key names.
   */
  escapeStringLiteral(value: string): string;

  /**
   * Type mapping: dialect-native type → TypeScript type string.
   * Used by the code generator.
   */
  typeToTypeScript(dialectType: string, nullable: boolean): string;

  /**
   * Array type mapping for UNNEST casts (PG-specific, noop for others).
   */
  arrayType?(baseType: string): string;
}

// ---------------------------------------------------------------------------
// Introspection contract
// ---------------------------------------------------------------------------

export interface DialectIntrospector {
  /**
   * Connect to the database and produce a SchemaMetadata object.
   * Each dialect uses different system tables/pragmas.
   */
  introspect(options: IntrospectOptions): Promise<SchemaMetadata>;
}

export interface IntrospectOptions {
  /** Connection string or path (SQLite uses file path) */
  connectionString: string;
  /** Schema/database to introspect (PG: 'public', MySQL: database name) */
  schema?: string;
  /** Tables to include */
  include?: string[];
  /** Tables to exclude */
  exclude?: string[];
}

// ---------------------------------------------------------------------------
// Migration locking contract
// ---------------------------------------------------------------------------

export interface MigrationLockStrategy {
  /** Acquire an exclusive migration lock. Returns true if acquired. */
  acquire(connection: unknown): Promise<boolean>;
  /** Release the migration lock. */
  release(connection: unknown): Promise<void>;
}

// ---------------------------------------------------------------------------
// Connection contract
// ---------------------------------------------------------------------------

export interface DialectConnection {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  release?(err?: Error | boolean): void;
}

export interface DialectPool {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
  connect(): Promise<DialectConnection>;
  end(): Promise<void>;
}
```

---

## 4. MySQL Dialect Specifics

### 4.1 JSON Aggregation

MySQL 5.7.22+ provides `JSON_ARRAYAGG()` and `JSON_OBJECT()`:

```sql
-- PostgreSQL (current Turbine output):
SELECT COALESCE(json_agg(json_build_object(
  'id', t0."id",
  'title', t0."title",
  'createdAt', t0."created_at"
)), '[]'::json)
FROM "posts" t0
WHERE t0."user_id" = "users"."id"

-- MySQL equivalent:
SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
  'id', t0.`id`,
  'title', t0.`title`,
  'createdAt', t0.`created_at`
)), JSON_ARRAY())
FROM `posts` t0
WHERE t0.`user_id` = `users`.`id`
```

**Key differences:**
- `JSON_ARRAYAGG` instead of `json_agg`
- `JSON_OBJECT` instead of `json_build_object`
- `JSON_ARRAY()` instead of `'[]'::json` for empty fallback
- `COALESCE` works the same in both dialects
- `JSON_ARRAYAGG` does NOT support `ORDER BY` inside (MySQL 8.0.14+ does via window function workaround) — requires inner subquery wrapping for all ordered relations, not just those with LIMIT

**Dialect implementation:**

```typescript
const mysqlDialect: Dialect = {
  name: 'mysql',

  paramPlaceholder(_index: number): string {
    return '?';
  },

  quoteIdentifier(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  },

  buildJsonArrayAgg(jsonObjectExpr: string, orderBy?: string): string {
    // MySQL 8.0.14+ supports ORDER BY in JSON_ARRAYAGG, but for broader
    // compatibility we always use subquery wrapping for ordered results.
    if (orderBy) {
      // Caller must wrap in subquery — signal that ordering is external
      return `COALESCE(JSON_ARRAYAGG(${jsonObjectExpr}), JSON_ARRAY())`;
    }
    return `COALESCE(JSON_ARRAYAGG(${jsonObjectExpr}), JSON_ARRAY())`;
  },

  buildJsonObject(pairs: [string, string][]): string {
    const args = pairs.map(([key, expr]) => `'${key}', ${expr}`).join(', ');
    return `JSON_OBJECT(${args})`;
  },

  supportsReturning: false,

  buildLastInsertFetch(table: string, primaryKey: string): string {
    return `SELECT * FROM \`${table}\` WHERE \`${primaryKey}\` = LAST_INSERT_ID()`;
  },

  supportsILike: false,

  buildInsensitiveLike(column: string, paramRef: string): string {
    // MySQL is case-insensitive by default with utf8mb4_general_ci collation.
    // For explicit case-insensitive matching regardless of collation:
    return `LOWER(${column}) LIKE LOWER(${paramRef})`;
  },

  jsonPathSupport: 'function',

  buildJsonContains(column: string, paramRef: string): string {
    return `JSON_CONTAINS(${column}, ${paramRef})`;
  },

  buildJsonPathExtract(column: string, pathParamRef: string): string {
    return `JSON_EXTRACT(${column}, ${pathParamRef})`;
  },

  // ... additional methods
};
```

### 4.2 INSERT Without RETURNING

MySQL does not support `RETURNING *`. The workaround:

```sql
-- PostgreSQL:
INSERT INTO "users" ("email", "name") VALUES ($1, $2) RETURNING *

-- MySQL (two queries in a transaction):
INSERT INTO `users` (`email`, `name`) VALUES (?, ?);
SELECT * FROM `users` WHERE `id` = LAST_INSERT_ID();
```

For composite primary keys or non-auto-increment PKs, the approach changes:

```sql
-- Use the input values to SELECT back:
INSERT INTO `users` (`id`, `email`, `name`) VALUES (?, ?, ?);
SELECT * FROM `users` WHERE `id` = ?;
```

This is a significant behavioral difference — `create()` becomes a 2-query operation on MySQL.

### 4.3 Introspection

MySQL uses `information_schema` exclusively (no `pg_catalog` equivalent):

```sql
-- Tables
SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE';

-- Columns
SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
       IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION,
       CHARACTER_MAXIMUM_LENGTH, COLUMN_KEY, EXTRA
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ?;

-- Primary keys
SELECT TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = ? AND CONSTRAINT_NAME = 'PRIMARY';

-- Foreign keys
SELECT
  TABLE_NAME AS source_table,
  COLUMN_NAME AS source_column,
  REFERENCED_TABLE_NAME AS target_table,
  REFERENCED_COLUMN_NAME AS target_column,
  CONSTRAINT_NAME
FROM information_schema.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = ?
  AND REFERENCED_TABLE_NAME IS NOT NULL;

-- Indexes
SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ?;
```

### 4.4 Migration Locking

MySQL has `GET_LOCK()` / `RELEASE_LOCK()` which are session-scoped named locks (analogous to PG advisory locks):

```sql
SELECT GET_LOCK('turbine_migrations', 10);  -- 10 second timeout
-- ... run migrations ...
SELECT RELEASE_LOCK('turbine_migrations');
```

### 4.5 Type Mapping

```typescript
const MYSQL_TO_TS: Record<string, string> = {
  // Integers
  tinyint: 'number',
  smallint: 'number',
  mediumint: 'number',
  int: 'number',
  bigint: 'number',  // Same caveat as PG int8
  // Floating point
  float: 'number',
  double: 'number',
  decimal: 'string',  // Precision loss if converted to number
  // Strings
  char: 'string',
  varchar: 'string',
  tinytext: 'string',
  text: 'string',
  mediumtext: 'string',
  longtext: 'string',
  // Binary
  binary: 'Buffer',
  varbinary: 'Buffer',
  blob: 'Buffer',
  // Date/Time
  date: 'Date',
  datetime: 'Date',
  timestamp: 'Date',
  time: 'string',
  year: 'number',
  // JSON
  json: 'unknown',
  // Boolean (MySQL uses TINYINT(1))
  boolean: 'boolean',
  // Enum
  enum: 'string',
  // UUID (stored as CHAR(36) or BINARY(16))
  uuid: 'string',
};
```

### 4.6 Transactions

MySQL defaults to `REPEATABLE READ` isolation (vs PG's `READ COMMITTED`). Transaction support maps directly but the nested SAVEPOINT syntax is compatible:

```sql
-- Same syntax works:
BEGIN;
SAVEPOINT sp_1;
-- ... queries ...
RELEASE SAVEPOINT sp_1;  -- or ROLLBACK TO SAVEPOINT sp_1;
COMMIT;
```

**Driver:** `mysql2` (MIT, promise-based, prepared statements, streaming).

---

## 5. SQLite Dialect Specifics

### 5.1 JSON Aggregation

SQLite 3.38+ (2022-02-22) provides `json_group_array()` and `json_object()`:

```sql
-- PostgreSQL (current Turbine output):
SELECT COALESCE(json_agg(json_build_object(
  'id', t0."id",
  'title', t0."title"
)), '[]'::json)
FROM "posts" t0
WHERE t0."user_id" = "users"."id"

-- SQLite equivalent:
SELECT COALESCE(json_group_array(json_object(
  'id', t0."id",
  'title', t0."title"
)), '[]')
FROM "posts" t0
WHERE t0."user_id" = "users"."id"
```

**Key differences:**
- `json_group_array` instead of `json_agg`
- `json_object` instead of `json_build_object`
- `'[]'` instead of `'[]'::json` (no type casts in SQLite)
- SQLite returns text, not a JSON type — parsing is the same (JSON.parse)
- `json_group_array` does NOT accept ORDER BY — always requires subquery wrapping for ordered results

**Dialect implementation:**

```typescript
const sqliteDialect: Dialect = {
  name: 'sqlite',

  paramPlaceholder(_index: number): string {
    return '?';
  },

  quoteIdentifier(name: string): string {
    // SQLite accepts both "x" and `x`. Use double-quotes for consistency with PG.
    return '"' + name.replace(/"/g, '""') + '"';
  },

  buildJsonArrayAgg(jsonObjectExpr: string, _orderBy?: string): string {
    // json_group_array never supports ORDER BY — always wrap externally
    return `COALESCE(json_group_array(${jsonObjectExpr}), '[]')`;
  },

  buildJsonObject(pairs: [string, string][]): string {
    const args = pairs.map(([key, expr]) => `'${key}', ${expr}`).join(', ');
    return `json_object(${args})`;
  },

  supportsReturning: true,  // SQLite 3.35+ (2021-03-12)

  supportsILike: false,

  buildInsensitiveLike(column: string, paramRef: string): string {
    // SQLite LIKE is case-insensitive for ASCII by default.
    // For Unicode-aware: use LOWER() wrapper
    return `${column} LIKE ${paramRef}`;  // Already case-insensitive in SQLite
  },

  jsonPathSupport: 'limited',

  buildJsonContains(column: string, paramRef: string): string {
    // SQLite has no @> operator. Use json_each to check containment.
    // This is a simplification — full containment requires more complex SQL.
    return `json_extract(${column}, '$') = ${paramRef}`;
  },

  buildJsonPathExtract(column: string, pathParamRef: string): string {
    return `json_extract(${column}, ${pathParamRef})`;
  },

  // ... additional methods
};
```

### 5.2 Introspection

SQLite uses PRAGMA statements:

```sql
-- Tables
SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%';

-- Columns
PRAGMA table_info('users');
-- Returns: cid, name, type, notnull, dflt_value, pk

-- Foreign keys
PRAGMA foreign_key_list('posts');
-- Returns: id, seq, table, from, to, on_update, on_delete, match

-- Indexes
PRAGMA index_list('users');
PRAGMA index_info('index_name');
```

### 5.3 Migration Locking

SQLite is single-writer by design. WAL mode allows concurrent reads but only one writer at a time. No advisory locks needed — SQLite's built-in file locking handles it:

```typescript
const sqliteMigrationLock: MigrationLockStrategy = {
  async acquire(_connection: unknown): Promise<boolean> {
    // SQLite handles locking at the file level via WAL mode.
    // BEGIN IMMEDIATE ensures we get the write lock or fail fast.
    // The migration transaction itself is the lock.
    return true;
  },
  async release(_connection: unknown): Promise<void> {
    // No-op — lock released when transaction commits/rollbacks.
  },
};
```

Migrations should use `BEGIN IMMEDIATE` to acquire the write lock at transaction start rather than waiting for the first write statement.

### 5.4 Type Affinity

SQLite has type affinity, not strict types. The mapping is lossy:

```typescript
const SQLITE_TO_TS: Record<string, string> = {
  integer: 'number',
  real: 'number',
  text: 'string',
  blob: 'Buffer',
  numeric: 'number | string',  // Could be either
};
```

For the code generator, we'd use the declared column type (from CREATE TABLE) rather than the affinity. If the user declares `created_at TIMESTAMP`, we map to `Date` even though SQLite stores it as text/real/integer internally.

### 5.5 ALTER TABLE Limitations

SQLite has limited `ALTER TABLE`:
- Can ADD COLUMN
- Can RENAME COLUMN (3.25+)
- Can DROP COLUMN (3.35+)
- CANNOT modify column type, add/remove constraints, change defaults

Complex schema changes require the "12-step" table rebuild:
1. Create new table with desired schema
2. Copy data from old table
3. Drop old table
4. Rename new table

The migration system for SQLite would need to handle this — either by generating the 12-step sequence automatically, or by documenting the manual approach.

### 5.6 Driver

**`better-sqlite3`** — synchronous API (fastest Node.js SQLite driver), widely used:

```typescript
import Database from 'better-sqlite3';

const db = new Database('app.db', { wal: true });
const rows = db.prepare('SELECT * FROM users WHERE id = ?').all(1);
```

Turbine's async API would wrap `better-sqlite3`'s synchronous calls. For serverless/edge, `@libsql/client` (Turso) provides an HTTP-based SQLite-compatible driver.

---

## 6. Implementation Phases

### Phase 1: Extract Dialect Interface (Refactor Only)

**Goal:** Refactor the existing PostgreSQL code to implement the `Dialect` interface without changing behavior.

**Work:**
1. Create `@turbine-orm/core` package with shared types:
   - Move `query/types.ts` → `core/src/query-types.ts`
   - Move `errors.ts` → `core/src/errors.ts`
   - Move `schema.ts` (interfaces only) → `core/src/schema-types.ts`
   - Move `schema-builder.ts` → `core/src/schema-builder.ts`
   - Define `Dialect`, `DialectIntrospector`, `MigrationLockStrategy` interfaces
   - Define `DialectPool`, `DialectConnection` interfaces

2. Implement `PostgresDialect` class in `turbine-orm`:
   - Extract `quoteIdent()` → `PostgresDialect.quoteIdentifier()`
   - Extract json_agg/json_build_object patterns → `buildJsonArrayAgg()` / `buildJsonObject()`
   - Extract `$N` placeholder logic → `paramPlaceholder()`
   - Keep `builder.ts` functionally identical but calling dialect methods

3. Verify zero behavioral change:
   - All existing tests pass unchanged
   - Generated SQL is byte-for-byte identical
   - No performance regression (benchmark before/after)

**Estimated effort:** ~2 weeks, ~800 LOC changed, 0 LOC net new functionality
**Risk:** Low — pure refactor. All existing tests are the safety net.

**File changes:**
```
NEW:  packages/core/src/dialect.ts          (~200 LOC)
NEW:  packages/core/src/query-types.ts      (moved from src/query/types.ts)
NEW:  packages/core/src/errors.ts           (moved from src/errors.ts)
NEW:  packages/core/src/schema-types.ts     (extracted interfaces from src/schema.ts)
EDIT: src/query/builder.ts                  (call dialect methods instead of inline SQL)
EDIT: src/query/utils.ts                    (quoteIdent delegates to dialect)
EDIT: src/client.ts                         (accept Dialect in config)
EDIT: package.json                          (add @turbine-orm/core dependency)
```

### Phase 2: MySQL Dialect

**Goal:** Ship `@turbine-orm/mysql` with full parity for the Prisma-like query API.

**Work:**
1. **Query builder** (~2,500 LOC):
   - `MysqlQueryInterface` implementing all methods (findMany, findUnique, create, update, delete, upsert, aggregate, count, groupBy)
   - `?` parameter placeholders (sequential, not indexed)
   - Backtick quoting
   - `JSON_ARRAYAGG` + `JSON_OBJECT` for nested relations
   - `LAST_INSERT_ID()` for create/upsert (no RETURNING)
   - `ON DUPLICATE KEY UPDATE` for upsert
   - `LOWER()` for insensitive string matching
   - `JSON_CONTAINS()` / `JSON_EXTRACT()` for JSON filters

2. **Introspection** (~300 LOC):
   - `information_schema` queries for tables, columns, PKs, FKs, indexes
   - MySQL-specific type parsing (`TINYINT(1)` → boolean, `ENUM(...)`, etc.)
   - Schema name = database name

3. **Migration system** (~250 LOC):
   - `GET_LOCK()` / `RELEASE_LOCK()` for concurrent safety
   - MySQL DDL in tracking table (AUTO_INCREMENT vs SERIAL, DATETIME vs TIMESTAMPTZ)
   - Handle `ENGINE=InnoDB` default

4. **Code generator** (~150 LOC):
   - `mysqlTypeToTs()` mapping
   - Same output shape (types.ts, metadata.ts, index.ts)

5. **Client** (~300 LOC):
   - `mysql2` pool management
   - Transaction support with isolation levels
   - Prepared statements via `mysql2`'s `execute()` method

6. **Tests** (~1,000 LOC):
   - SQL generation tests (mock-based, no DB needed)
   - Integration tests with Docker MySQL

**Estimated effort:** ~4 weeks, ~4,500 LOC
**Risk:** Medium
- `JSON_ARRAYAGG` ordering limitations may require subquery wrapping for ALL ordered relations
- `LAST_INSERT_ID()` fails for multi-row INSERT — `createMany` returns without full row data unless we SELECT back by all PKs
- Connection pool semantics differ (mysql2 auto-reconnect vs pg pool errors)

### Phase 3: SQLite Dialect

**Goal:** Ship `@turbine-orm/sqlite` — ideal for testing, local dev, and embedded apps.

**Work:**
1. **Query builder** (~2,200 LOC):
   - Similar to MySQL but with SQLite-specific JSON functions
   - `RETURNING` support (3.35+) simplifies create/update/delete
   - No UNNEST — use multi-row VALUES for createMany
   - Type affinity handling

2. **Introspection** (~200 LOC):
   - PRAGMA-based schema reading
   - Parse CREATE TABLE statements for constraints (PRAGMAs don't expose CHECK constraints)

3. **Migration system** (~150 LOC):
   - `BEGIN IMMEDIATE` for locking
   - 12-step table rebuild for complex ALTER TABLE operations
   - No concurrent access concerns

4. **Code generator** (~100 LOC):
   - Simple type affinity mapping

5. **Client** (~200 LOC):
   - Wrap `better-sqlite3` synchronous API in async interface
   - Support `@libsql/client` for Turso/serverless

6. **Tests** (~800 LOC):
   - SQL generation tests (no DB needed)
   - Integration tests (in-memory SQLite, no Docker required)

**Estimated effort:** ~3 weeks, ~3,650 LOC
**Risk:** Low-Medium
- SQLite's limited ALTER TABLE makes migration diffing harder
- Type affinity means runtime types can surprise users
- `json_group_array` requires SQLite 3.38+ — need to document minimum version

### Phase 4: SQL Server Dialect (Future, Assess Demand)

**Goal:** Assess demand before committing. Only build if significant user request.

SQL Server specifics that make it complex:
- `FOR JSON PATH` instead of json_agg (different paradigm — result set → JSON, not per-row aggregation)
- `@P1` parameter placeholders (named, not positional)
- `[brackets]` for quoting
- `SCOPE_IDENTITY()` instead of RETURNING (though SQL Server 2005+ has `OUTPUT` clause)
- `sp_getapplock` for migration locking
- `sys.columns` / `sys.tables` for introspection
- Significantly different transaction isolation semantics (SNAPSHOT isolation)

**Estimated effort:** ~5 weeks if pursued
**Recommendation:** Do not start until Phases 1-3 are complete and demand is validated.

---

## 7. Testing Strategy

### 7.1 Unit Tests (No Database Required)

Each dialect's query builder has SQL-generation-only tests that verify output without executing:

```typescript
// packages/mysql/src/test/builder.test.ts
import { describe, it, assert } from 'node:test';
import { makeQuery } from './helpers.js';

describe('MySQL findMany', () => {
  it('generates correct JSON_ARRAYAGG for nested relations', () => {
    const q = makeQuery('users');
    const deferred = q.buildFindMany({ with: { posts: true }, limit: 10 });

    assert.strictEqual(
      deferred.sql,
      'SELECT `users`.*, ' +
      '(SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT(' +
      "'id', t0.`id`, 'title', t0.`title`, 'createdAt', t0.`created_at`" +
      ')), JSON_ARRAY()) FROM `posts` t0 WHERE t0.`user_id` = `users`.`id`) AS `posts` ' +
      'FROM `users` LIMIT ?'
    );
    assert.deepStrictEqual(deferred.params, [10]);
  });

  it('uses LAST_INSERT_ID for create', () => {
    const q = makeQuery('users');
    const deferred = q.buildCreate({ data: { email: 'x@y.com', name: 'X' } });

    assert.ok(deferred.sql.includes('INSERT INTO `users`'));
    assert.ok(deferred.sql.includes('LAST_INSERT_ID()'));
  });
});
```

### 7.2 Shared Conformance Suite

A dialect-agnostic test suite that runs against ALL dialects to verify API behavior:

```typescript
// packages/core/src/test/conformance.ts
export function dialectConformanceSuite(
  dialectName: string,
  getClient: () => Promise<TurbineClient>,
  cleanup: () => Promise<void>,
) {
  describe(`${dialectName} conformance`, () => {
    let db: TurbineClient;

    before(async () => { db = await getClient(); });
    after(async () => { await cleanup(); });

    it('findMany returns array', async () => {
      const users = await db.table('users').findMany({ limit: 5 });
      assert(Array.isArray(users));
    });

    it('findUnique returns single row or null', async () => {
      const user = await db.table('users').findUnique({ where: { id: 1 } });
      assert(user === null || typeof user === 'object');
    });

    it('create returns the created row', async () => {
      const user = await db.table('users').create({
        data: { email: 'test@test.com', name: 'Test' },
      });
      assert.strictEqual(user.email, 'test@test.com');
    });

    it('nested with returns related data', async () => {
      const users = await db.table('users').findMany({
        with: { posts: true },
        limit: 1,
      });
      assert(Array.isArray(users[0]?.posts));
    });

    // ... 50+ conformance tests covering the full API
  });
}
```

### 7.3 Integration Tests (Docker Compose)

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: turbine_test
      POSTGRES_USER: turbine
      POSTGRES_PASSWORD: turbine
    ports: ["5432:5432"]

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_DATABASE: turbine_test
      MYSQL_ROOT_PASSWORD: turbine
    ports: ["3306:3306"]

  # SQLite needs no container — uses in-memory or temp file
```

CI matrix:

```yaml
# .github/workflows/test.yml
jobs:
  test:
    strategy:
      matrix:
        dialect: [postgresql, mysql, sqlite]
    services:
      # Conditional service spin-up per dialect
    steps:
      - run: npm run test:${{ matrix.dialect }}
```

### 7.4 Test Data Seeding

Each dialect gets its own seed script that creates the same logical data:
- 100 users, 500 posts, 2000 comments (smaller than prod seeds for speed)
- Same table structure, adapted to dialect DDL
- Shared seed definitions in `core/test/fixtures/seed.json`, dialect-specific DDL in `packages/<dialect>/test/fixtures/seed.sql`

---

## 8. Migration Path for Existing Users

### 8.1 Zero Breaking Changes

The primary `turbine-orm` package continues to work exactly as today:

```typescript
// BEFORE (v0.9.x): works
import { TurbineClient } from 'turbine-orm';

// AFTER (v1.x with multi-DB): still works, unchanged
import { TurbineClient } from 'turbine-orm';
```

The `@turbine-orm/core` dependency is internal — users never import it directly unless they're building a custom dialect.

### 8.2 New Dialect Installation

```bash
# MySQL users:
npm install @turbine-orm/mysql mysql2

# SQLite users:
npm install @turbine-orm/sqlite better-sqlite3
```

### 8.3 API Compatibility

The query API is identical across dialects. Code written for one dialect works on another (assuming the schema exists):

```typescript
// Same code, different import:
import { turbine } from '@turbine-orm/mysql';
// vs
import { turbine } from 'turbine-orm';

// API is identical:
const users = await db.users.findMany({
  where: { email: { contains: '@company.com' } },
  with: { posts: { where: { published: true } } },
  orderBy: { createdAt: 'desc' },
  limit: 10,
});
```

### 8.4 CLI Per Dialect

The CLI auto-detects dialect from `turbine.config.ts`:

```typescript
// turbine.config.ts
export default {
  dialect: 'mysql',  // or 'postgresql' (default), 'sqlite'
  url: process.env.DATABASE_URL,
  out: './generated/turbine',
};
```

The CLI commands (`generate`, `migrate`, `push`, `studio`) adapt their behavior based on dialect.

---

## 9. Open Questions and Risks

### 9.1 Open Questions

1. **Should `@turbine-orm/core` be published as a separate package or kept internal?**
   If internal (bundled into each dialect), we avoid the multi-package coordination problem but duplicate code. If published, we need careful versioning.

2. **What minimum MySQL version?**
   MySQL 5.7.22 has `JSON_ARRAYAGG` but lacks ORDER BY in aggregation (added in 8.0.14). Do we target 5.7 (larger market) or 8.0 (better DX)?

3. **What minimum SQLite version?**
   `json_group_array` requires 3.38 (2022-02). `RETURNING` requires 3.35 (2021-03). Most systems ship 3.39+ now. Targeting 3.38+ seems safe.

4. **Should the schema-builder type names be dialect-aware?**
   Currently `{ type: 'serial' }` maps to `BIGSERIAL` (Postgres). For MySQL it should map to `BIGINT AUTO_INCREMENT`. Should we add MySQL-specific type names or keep the abstraction?
   **Proposed:** Keep the same names, map per-dialect in `schema-sql.ts`. Add dialect-specific names as optional alternatives (e.g. `{ type: 'mysql:mediumint' }`).

5. **How to handle features that exist in one dialect but not others?**
   Examples: PG has `ILIKE`, `@>` (jsonb containment), array columns, `LISTEN/NOTIFY`. These would throw a clear `UnsupportedError` on dialects that lack them.

### 9.2 Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| MySQL JSON_ARRAYAGG ordering | Every ordered `with` needs subquery wrapping → more complex SQL, possible perf impact | Benchmark against N+1 alternative; document that MySQL nested queries are slightly less efficient than PG |
| MySQL no RETURNING | `create()` and `update()` become 2-query operations | Wrap in transaction; document the limitation |
| SQLite concurrency | Only one writer at a time; high-throughput apps hit write contention | Document that SQLite is for dev/embedded, not production multi-tenant |
| Core extraction breaks something | Refactoring 6K+ LOC query builder could introduce subtle bugs | Phase 1 is pure refactor with full test coverage; run benchmarks before/after |
| Market demand unclear | Building MySQL/SQLite support for 3 users would be wasteful | Validate demand via GitHub issues, Discord polls, npm download demographics before Phase 2 |
| Driver maintenance burden | 3 dialect packages = 3x maintenance surface | Each dialect should be independently testable; consider community maintainers for lower-priority dialects |

---

## 10. Success Criteria

Phase 1 is complete when:
- [x] `@turbine-orm/core` is extractable (types compile independently)
- [x] PostgresDialect implements the Dialect interface
- [x] All existing tests pass with zero SQL output changes
- [x] No measurable performance regression (< 5% on benchmarks)

Phase 2 (MySQL) is complete when:
- [x] All conformance suite tests pass on MySQL 8.0
- [x] `npx turbine generate` works against a MySQL database
- [x] `npx turbine migrate up/down` works with MySQL
- [x] Nested `with` queries return correct data (verified against equivalent PG output)
- [x] Published to npm, docs on turbineorm.dev

Phase 3 (SQLite) is complete when:
- [x] All conformance suite tests pass on SQLite 3.38+
- [x] In-memory SQLite works for test environments
- [x] `@libsql/client` (Turso) verified as compatible
- [x] Published to npm, docs on turbineorm.dev

---

## Appendix A: SQL Comparison Table

| Operation | PostgreSQL | MySQL | SQLite |
|-----------|-----------|-------|--------|
| JSON array agg | `json_agg(expr)` | `JSON_ARRAYAGG(expr)` | `json_group_array(expr)` |
| JSON object | `json_build_object(k1,v1,...)` | `JSON_OBJECT(k1,v1,...)` | `json_object(k1,v1,...)` |
| Empty array fallback | `COALESCE(..., '[]'::json)` | `COALESCE(..., JSON_ARRAY())` | `COALESCE(..., '[]')` |
| Parameter | `$1, $2, $3` | `?, ?, ?` | `?, ?, ?` |
| Quote identifier | `"name"` | `` `name` `` | `"name"` |
| Insert + return | `INSERT ... RETURNING *` | `INSERT ...; SELECT ... LAST_INSERT_ID()` | `INSERT ... RETURNING *` |
| Upsert | `ON CONFLICT ... DO UPDATE` | `ON DUPLICATE KEY UPDATE` | `ON CONFLICT ... DO UPDATE` |
| Case-insensitive LIKE | `ILIKE` | `LIKE` (default CI) or `LOWER()` | `LIKE` (default CI for ASCII) |
| Advisory lock | `pg_try_advisory_lock($1)` | `GET_LOCK('name', timeout)` | N/A (file-level WAL lock) |
| Bulk insert | `UNNEST($1::type[], ...)` | `VALUES (?,?), (?,?), ...` | `VALUES (?,?), (?,?), ...` |
| JSON containment | `col @> $1::jsonb` | `JSON_CONTAINS(col, ?)` | `json_extract(col, path)` (limited) |
| Array column | Native `text[]`, `int[]` | JSON array or junction table | JSON array (no native arrays) |
| Streaming cursor | `DECLARE ... CURSOR` | `connection.query().stream()` | N/A (sync driver) |

---

## Appendix B: Estimated Total Effort

| Phase | Calendar time | LOC (approx) | Dependencies |
|-------|---------------|--------------|--------------|
| Phase 1: Extract dialect interface | 2 weeks | ~800 changed | None (refactor only) |
| Phase 2: MySQL dialect | 4 weeks | ~4,500 new | mysql2 |
| Phase 3: SQLite dialect | 3 weeks | ~3,650 new | better-sqlite3 |
| Phase 4: SQL Server (if pursued) | 5 weeks | ~5,000 new | tedious/mssql |
| **Total (Phases 1-3)** | **~9 weeks** | **~9,000 LOC** | |

These estimates assume one developer working full-time. Phases 2 and 3 can run in parallel if two developers are available (they share no code after Phase 1 completes).
