# Turbine ORM -- Comprehensive Test Matrix

Compiled from analysis of Prisma's functional test suite, Drizzle ORM's integration tests,
OWASP ORM injection testing guidelines, and PostgreSQL type-system edge cases.

**Legend:**
- [x] = Already covered in existing tests
- [ ] = Not yet covered (gap)

---

## 1. Query Operations

### 1.1 findUnique

- [x] Find by primary key (id)
- [x] Find by unique column (email)
- [x] Returns null for non-existent id
- [x] camelCase <-> snake_case field conversion
- [x] Plain equality still works
- [ ] Find by composite unique key (multi-column unique constraint)
- [ ] Find with select (return subset of fields)
- [ ] Find with omit (exclude specific fields)
- [ ] Find with nested include (with)
- [ ] Returns null when filtering by unique column with wrong type (string vs number)
- [ ] Handles numeric string that looks like an id ("1" vs 1)
- [ ] Works with UUID primary key
- [ ] Works with bigint primary key near MAX_SAFE_INTEGER

### 1.2 findFirst

- [x] Returns single object, not array
- [x] Returns null when no match
- [x] Filters with where clause
- [x] Respects orderBy
- [x] Supports nested relations (with)
- [x] Works with no args (returns first row)
- [ ] Returns null from empty table
- [ ] With select (subset of fields)
- [ ] With omit
- [ ] Combines where + orderBy + select
- [ ] With cursor (acts as lower bound)
- [ ] With distinct

### 1.3 findFirstOrThrow

- [x] Returns object when found
- [x] Throws NotFoundError when not found
- [ ] Error message includes table name / query context
- [ ] Works with all where operators

### 1.4 findUniqueOrThrow

- [x] Returns object when found
- [x] Throws NotFoundError when not found
- [ ] Error message includes table name / query context
- [ ] Works with composite unique key

### 1.5 findMany

- [x] Returns all rows when no filter
- [x] Filters with where clause (boolean equality)
- [x] Respects limit
- [x] Respects offset
- [x] Orders ascending
- [x] Orders descending
- [x] Pagination with offset (page1 vs page2 no overlap)
- [x] With nested relations (L2 nesting)
- [x] Select subset of fields
- [x] Omit specific fields
- [ ] Returns empty array from empty table (not null, not error)
- [ ] Multiple orderBy fields (e.g., role ASC, name DESC)
- [ ] orderBy on nullable column (nulls first / nulls last behavior)
- [ ] limit: 0 returns empty array
- [ ] limit: 1 returns single-element array
- [ ] Very large limit (> row count) returns all rows
- [ ] Negative limit throws validation error
- [ ] Negative offset throws validation error
- [ ] select + omit mutual exclusion (should error or one wins)
- [ ] select with no fields = error or returns all
- [ ] select: { id: false } semantics
- [ ] With nested select + nested omit in same query

### 1.6 create

- [x] Creates a row and returns it with all fields
- [x] Verifies default values are applied
- [ ] Returns generated serial/bigserial id
- [ ] Respects NOT NULL constraints (error when missing required field)
- [ ] Respects UNIQUE constraints (error on duplicate)
- [ ] Works with nullable fields (explicit null)
- [ ] Works with default values (omit field, get default)
- [ ] Creates with JSON/JSONB data
- [ ] Creates with array column data
- [ ] Creates with Date/timestamp values
- [ ] Creates with UUID value
- [ ] Creates with boolean value
- [ ] Creates with numeric precision values (decimal, real, double)
- [ ] Rejects unknown column names
- [ ] SQL injection in string values is parameterized
- [ ] Returns correct types for all column types
- [ ] With select (return only specified fields)
- [ ] Empty string for text columns
- [ ] Very long text values (> 10KB)

### 1.7 createMany

- [x] Batch inserts multiple rows
- [x] Returns empty array for empty input
- [x] skipDuplicates (no duplicates)
- [x] skipDuplicates silently skips existing rows
- [ ] Large batch (1000+ rows)
- [ ] All rows have same columns
- [ ] Mixed column presence across rows (some rows omit optional fields)
- [ ] Returns all created rows with correct ids
- [ ] Atomic: all-or-nothing on constraint violation (without skipDuplicates)
- [ ] Performance: UNNEST batch vs individual INSERTs

### 1.8 update

- [x] Updates a row and returns updated data
- [x] Preserves unmodified fields
- [ ] Updates nullable field to null
- [ ] Updates nullable field from null to value
- [ ] Throws/returns null for non-existent row
- [ ] Increments numeric field (if supported: { viewCount: { increment: 1 } })
- [ ] Updates JSON/JSONB field
- [ ] Updates array field
- [ ] Updates timestamp field
- [ ] Partial update (only one field changed)
- [ ] SQL injection in update values is parameterized
- [ ] Rejects unknown column names in data
- [ ] With select (return only specified fields after update)
- [ ] Concurrent update doesn't lose data (optimistic concurrency)

### 1.9 updateMany

- [x] Updates multiple rows and returns count
- [ ] Returns count: 0 when no rows match
- [ ] Updates with operator-based where (gt, lt, in)
- [ ] Does not update rows outside the where clause
- [ ] Verify affected count matches expected

### 1.10 delete

- [x] Deletes a row and returns deleted data
- [x] Verifies row is gone after delete
- [ ] Throws/returns null for non-existent row
- [ ] FK constraint prevents delete when children exist (without CASCADE)
- [ ] Returns the complete deleted row (all fields)
- [ ] SQL injection in where values is parameterized

### 1.11 deleteMany

- [x] Deletes multiple rows and returns count
- [ ] Returns count: 0 when no rows match
- [ ] Deletes with operator-based where (gt, lt, in)
- [ ] Does not delete rows outside the where clause
- [ ] Without where clause: deletes ALL rows (or errors for safety)

### 1.12 upsert

- [x] Creates when row does not exist
- [x] Updates when row already exists
- [ ] Handles race condition (concurrent upsert on same unique key)
- [ ] Works with composite unique key in where
- [ ] Create data and update data have different fields
- [ ] Returns correct data in both create and update paths
- [ ] SQL injection in create/update data is parameterized
- [ ] With select (return only specified fields)

### 1.13 count

- [x] Counts all rows in table
- [x] Counts with where filter
- [x] Count with operator where (gt)
- [x] Filtered count <= total count
- [ ] Count returns 0 for empty table
- [ ] Count returns 0 for where that matches nothing
- [ ] Count returns exact number (not approximate)
- [ ] Count with relation filter (some/none/every)

### 1.14 aggregate

- [x] _count: counts all rows
- [x] _sum: computes sum of numeric column
- [x] _avg: computes average
- [x] _min and _max
- [x] Combined: _count + _sum + _avg + _min + _max
- [x] Where filter in aggregate
- [ ] _sum of NULL column returns null (not 0)
- [ ] _avg precision for integer vs float columns
- [ ] _min/_max on string columns (lexicographic)
- [ ] _min/_max on date/timestamp columns
- [ ] _count with distinct field
- [ ] Aggregate on empty table (all nulls except _count = 0)
- [ ] Aggregate with relation filter in where

### 1.15 groupBy

- [x] Groups by single field with _count
- [x] Groups with _sum
- [x] Groups with _avg, _min, _max
- [ ] Groups by multiple fields
- [ ] Groups with having clause (filter groups)
- [ ] Groups by nullable field (NULL group)
- [ ] Groups with orderBy on aggregate
- [ ] Groups returning empty result
- [ ] Groups by boolean field
- [ ] Groups by date field (date truncation)

---

## 2. Where Clause Operators

### 2.1 Comparison Operators

- [x] gt (greater than)
- [x] gte (greater than or equal)
- [x] lt (less than)
- [x] lte (less than or equal)
- [x] Combined gt + lt (range query)
- [ ] Boundary: gt with value = column max (returns empty)
- [ ] Boundary: lt with value = column min (returns empty)
- [ ] Comparison on date/timestamp columns
- [ ] Comparison on string columns (lexicographic)

### 2.2 Equality and Not

- [x] not: excludes specific value
- [x] not null (IS NOT NULL)
- [x] Plain equality
- [ ] not with operator: { not: { gt: 5 } }
- [ ] Equality with boolean
- [ ] Equality with null (IS NULL)

### 2.3 NULL Handling

- [x] null equality (IS NULL)
- [x] not null (IS NOT NULL)
- [ ] NULL in comparison operators (gt, lt with null)
- [ ] Filtering on nullable FK (org where user IS NULL)

### 2.4 Set Operators

- [x] in: matches value in list
- [x] notIn: excludes values in list
- [ ] in with empty array (returns nothing or all?)
- [ ] notIn with empty array (returns everything?)
- [ ] in with single value
- [ ] in with very large list (1000+ values)
- [ ] in with NULL in the list
- [ ] in on non-indexed column (performance)

### 2.5 String Operators

- [x] contains (substring match)
- [x] startsWith
- [x] endsWith
- [ ] contains: case sensitivity (default vs insensitive mode)
- [ ] contains with empty string
- [ ] contains with special regex characters (%, _, \)
- [ ] contains with Unicode characters
- [ ] startsWith with empty string
- [ ] endsWith with empty string
- [ ] like / ilike operator (if supported)

### 2.6 Logical Operators

- [x] OR: array of conditions
- [x] OR combined with AND (top-level fields)
- [x] AND: array of conditions
- [x] NOT: excludes matching rows
- [x] NOT combined with other conditions
- [ ] Nested OR inside OR
- [ ] Nested AND inside OR
- [ ] NOT with complex operator expression
- [ ] Empty OR array (returns nothing or error?)
- [ ] Empty AND array (returns everything or error?)
- [ ] Deeply nested logical combinations (OR -> AND -> NOT -> OR)

### 2.7 JSONB Operators

- [x] contains: JSONB containment (@>)
- [x] equals: exact JSONB match
- [x] path + equals: access nested value
- [x] hasKey: check for key existence
- [ ] path with array index
- [ ] path with deeply nested key (3+ levels)
- [ ] contains with array values
- [ ] contains with nested objects
- [ ] not contains
- [ ] hasKey on non-existent key (returns empty)
- [ ] JSONB column with null value vs missing key

### 2.8 Array Operators

- [x] has: array contains element
- [x] hasEvery: array contains all elements
- [x] hasSome: array contains any of elements
- [x] isEmpty: true (empty array)
- [x] isEmpty: false (non-empty array)
- [ ] has with NULL element
- [ ] hasEvery with empty array (returns all?)
- [ ] hasSome with empty array (returns none?)
- [ ] Array of integers, booleans, UUIDs
- [ ] Array column that is NULL vs empty array

---

## 3. Relation Operations

### 3.1 Nested Include (with)

- [x] L2: parent with children (user with posts)
- [x] L3: grandchild nesting (user -> posts -> comments)
- [x] L4: great-grandchild nesting (org -> users -> posts -> comments)
- [x] belongsTo: child with parent (post with user)
- [x] Nested with limit
- [x] Nested with orderBy
- [x] Nested with where filter
- [x] Empty relations return empty array, not null
- [x] Throws for unknown relation name
- [x] Wide with clause (multiple sibling relations)
- [x] Wide + nested combined
- [ ] belongsTo returns null when FK is NULL
- [ ] belongsTo returns null when referenced row is deleted
- [ ] hasOne relation (1:1)
- [ ] Many-to-many through join table
- [ ] Self-referencing relation (categories -> parentCategory)
- [ ] Nested with on findMany (each row gets its relations)
- [ ] Large dataset: nested with on 1000+ parent rows
- [ ] Nested count: { _count: { posts: true } }
- [ ] with: false or with: {} (no relations loaded)

### 3.2 Nested Select/Omit

- [x] Select limits fields from nested hasMany relation
- [x] Omit excludes fields from nested hasMany relation
- [x] Select with nested limit + orderBy
- [x] Select with further nested with
- [x] belongsTo relation with select
- [ ] Omit on belongsTo relation
- [ ] Select on deeply nested relations (L3+)
- [ ] Select only the FK field from nested relation
- [ ] Omit all fields except id from nested relation

### 3.3 Relation Filters in Where

- [x] some: at least one related row matches
- [x] none: no related rows match
- [x] every: all related rows match
- [x] some with operator filters (gt, lt)
- [x] Combined with regular where fields
- [ ] some/none/every on belongsTo (single relation)
- [ ] Nested relation filter (posts -> { some: { comments: { some: { ... } } } })
- [ ] some with empty filter (at least one exists)
- [ ] none with empty filter (no relations exist)
- [ ] every on empty relation set (vacuously true)
- [ ] Relation filter + nested include in same query
- [ ] Performance: relation filter on large dataset

---

## 4. Cursor-Based Pagination

- [x] Cursor with ascending order
- [x] Cursor with descending order
- [x] Cursor with where filter
- [x] No overlap between cursor pages
- [ ] Cursor on non-primary-key column (e.g., createdAt)
- [ ] Cursor on composite key
- [ ] Cursor with take (Prisma-style) vs limit
- [ ] Cursor at start of dataset (first page)
- [ ] Cursor at end of dataset (returns empty)
- [ ] Cursor with non-existent value
- [ ] Cursor + distinct combination
- [ ] Cursor stability when rows are inserted between pages
- [ ] Cursor with nested relations

---

## 5. Distinct

- [x] Returns distinct values for a field
- [x] Distinct with where filter
- [x] Distinct with orderBy
- [ ] Distinct on multiple fields
- [ ] Distinct with limit
- [ ] Distinct on nullable field (includes one NULL group)
- [ ] Distinct + cursor pagination
- [ ] Distinct preserves orderBy sorting
- [ ] Distinct returns correct count of unique values

---

## 6. Transactions

### 6.1 Basic Transactions

- [x] Commits on success (old-style db.transaction)
- [x] Rolls back on error (old-style)
- [x] Commits on success ($transaction typed API)
- [x] Rolls back on error ($transaction typed API)
- [x] Cross-table operations in transaction
- [ ] Transaction with read-then-write pattern
- [ ] Transaction with concurrent reads
- [ ] Multiple sequential transactions on same client

### 6.2 Nested Transactions (Savepoints)

- [x] Supports nested transactions via SAVEPOINTs
- [x] Inner rollback does not affect outer
- [ ] Multiple nested savepoints (3+ levels)
- [ ] Inner commit + outer rollback (everything rolls back)
- [ ] Savepoint names don't collide across concurrent transactions
- [ ] Nested transaction timeout

### 6.3 Isolation Levels

- [x] Supports isolation level option (Serializable)
- [ ] ReadCommitted isolation
- [ ] RepeatableRead isolation
- [ ] Serializable: detects serialization failure and throws
- [ ] Default isolation level when not specified

### 6.4 Transaction Options

- [x] Timeout option (completes before timeout)
- [ ] Timeout: transaction exceeds timeout and is rolled back
- [ ] maxWait option (if supported)
- [ ] Transaction with raw SQL inside
- [x] Raw SQL works inside typed transaction

### 6.5 Transaction Edge Cases

- [ ] Transaction on disconnected client (should error immediately)
- [ ] Long-running transaction holding locks
- [ ] Transaction retry on serialization failure
- [ ] Read-only transaction

---

## 7. Raw SQL

- [x] Executes parameterized raw queries
- [ ] Raw query with zero parameters
- [ ] Raw query with multiple parameters
- [ ] Raw query returning multiple rows
- [ ] Raw query returning no rows (empty result)
- [ ] Raw query INSERT/UPDATE/DELETE (mutating)
- [ ] SQL injection in raw query parameters is prevented
- [ ] Raw query with JSONB result
- [ ] Raw query with array result
- [ ] Raw query with date/timestamp result
- [ ] Raw query type coercion (string to number, etc.)

---

## 8. Pipeline (Batch Queries)

- [x] Batches multiple queries into one round-trip
- [ ] Pipeline with different operation types (findUnique + count + findMany)
- [ ] Pipeline with zero queries (returns empty)
- [ ] Pipeline with single query (still works)
- [ ] Pipeline with 10+ queries
- [ ] Pipeline error handling: one query fails, others still return
- [ ] Pipeline with transactions
- [ ] Pipeline performance: fewer round-trips than individual queries

---

## 9. Middleware / Query Hooks

### 9.1 Basic Middleware

- [x] Intercepts queries with model + action
- [x] Can modify query results (add computed fields)
- [x] Supports multiple middleware in chain
- [x] Works with create/update/delete operations
- [x] Query timing middleware pattern
- [x] Logs model, action, args
- [x] Chain order: first registered = outermost
- [x] Error propagation through middleware chain
- [x] Middleware can modify args
- [x] Middleware can transform results
- [x] Receives correct model name for different tables
- [x] Works with pipeline operations

### 9.2 Advanced Middleware

- [ ] Middleware that short-circuits (returns cached result, skips DB)
- [ ] Middleware on $transaction operations
- [ ] Removing middleware at runtime
- [ ] Middleware that retries on specific errors
- [ ] Middleware ordering with async operations
- [ ] Middleware memory leak (1000+ registered)

---

## 10. SQL Injection Prevention

- [x] Parameterizes where values (DROP TABLE attack)
- [x] Parameterizes nested where values
- [x] Operator values are parameterized
- [x] OrderBy SQL injection rejected (ValidationError)
- [x] Default value injection rejected in schema builder
- [ ] Table name injection (dynamic table name)
- [ ] Column name injection in select
- [ ] Column name injection in orderBy
- [ ] JSONB path injection
- [ ] Array value injection
- [ ] Unicode homoglyph attacks in identifiers
- [ ] Null byte injection in strings
- [ ] Very long string values (buffer overflow attempts)
- [ ] SQL comments in values (-- and /* */)
- [ ] Multi-statement injection (;DROP TABLE)
- [ ] COPY command injection
- [ ] Backslash escape sequences

---

## 11. Type Handling (Postgres -> JavaScript)

### 11.1 Integer Types

- [ ] SMALLINT -> number (range: -32768 to 32767)
- [ ] INTEGER -> number (range: -2^31 to 2^31-1)
- [ ] BIGINT -> number or bigint (range: -2^63 to 2^63-1)
- [ ] BIGSERIAL -> number (auto-increment)
- [ ] BIGINT near Number.MAX_SAFE_INTEGER (2^53-1)
- [ ] BIGINT exceeding MAX_SAFE_INTEGER (precision loss detection)
- [ ] Integer overflow: INSERT 2^31 into INTEGER column
- [ ] Zero, negative zero
- [ ] NULL integer column -> null (not 0)

### 11.2 Floating Point Types

- [ ] REAL (float4) -> number
- [ ] DOUBLE PRECISION (float8) -> number
- [ ] NUMERIC/DECIMAL -> string or number (precision)
- [ ] NUMERIC with specified precision and scale
- [ ] NaN value handling
- [ ] Infinity / -Infinity value handling
- [ ] Very small numbers (underflow)
- [ ] Very large numbers (overflow)
- [ ] Floating point comparison (0.1 + 0.2)

### 11.3 String Types

- [ ] TEXT -> string
- [ ] VARCHAR(n) -> string (truncation behavior)
- [ ] CHAR(n) -> string (padding behavior)
- [ ] Empty string vs NULL
- [ ] Unicode characters (emoji, CJK, RTL)
- [ ] Very long strings (> 1MB)
- [ ] Strings with null bytes (\0)
- [ ] Strings with newlines, tabs, special characters
- [ ] SQL-significant characters in strings (', ", \, ;)

### 11.4 Boolean Type

- [ ] BOOLEAN true -> true
- [ ] BOOLEAN false -> false
- [ ] BOOLEAN NULL -> null
- [ ] Truthy/falsy coercion (1, 0, "true", "false")

### 11.5 Date/Time Types

- [x] TIMESTAMPTZ -> Date (basic, via createdAt assertions)
- [ ] TIMESTAMPTZ with timezone handling
- [ ] TIMESTAMPTZ precision (microseconds)
- [ ] TIMESTAMP WITHOUT TIME ZONE -> Date
- [ ] DATE -> string or Date
- [ ] TIME -> string
- [ ] INTERVAL -> string or object
- [ ] Epoch timestamp (1970-01-01)
- [ ] Far future timestamp (9999-12-31)
- [ ] Far past timestamp (0001-01-01)
- [ ] Infinity timestamp (PostgreSQL special value)

### 11.6 JSON/JSONB Types

- [ ] JSONB object -> parsed JS object
- [ ] JSONB array -> parsed JS array
- [ ] JSONB null -> null (vs SQL NULL)
- [ ] JSONB string -> string
- [ ] JSONB number -> number
- [ ] JSONB boolean -> boolean
- [ ] JSONB nested objects (deep)
- [ ] JSONB with special characters in keys
- [ ] JSONB with very large values
- [ ] JSON vs JSONB round-trip (key ordering, whitespace)

### 11.7 UUID Type

- [ ] UUID -> string
- [ ] UUID gen_random_uuid() default
- [ ] Invalid UUID format rejected
- [ ] Case insensitivity of UUID

### 11.8 Array Types

- [ ] INTEGER[] -> number[]
- [ ] TEXT[] -> string[]
- [ ] BOOLEAN[] -> boolean[]
- [ ] Empty array -> []
- [ ] NULL array -> null (not [])
- [ ] Array with NULL elements
- [ ] Nested arrays (multi-dimensional)
- [ ] Array with 10,000+ elements

### 11.9 Binary Type

- [ ] BYTEA -> Buffer
- [ ] BYTEA empty -> Buffer.alloc(0)
- [ ] BYTEA with binary data (non-UTF8)
- [ ] BYTEA round-trip (write + read)

### 11.10 Enum Types

- [ ] Enum -> string
- [ ] Invalid enum value rejected
- [ ] Enum in where clause
- [ ] Enum in orderBy

---

## 12. Error Handling

### 12.1 Error Types (Unit Tests Exist)

- [x] NotFoundError: default message, custom message, error code
- [x] TimeoutError: stores timeoutMs, includes context
- [x] ValidationError: message passthrough, error code
- [x] ConnectionError: message passthrough, error code
- [x] RelationError: message passthrough, error code
- [x] MigrationError: message passthrough, error code
- [x] CircularRelationError: stores path, arrow-joined message
- [x] All errors: instanceof Error and instanceof TurbineError

### 12.2 Operational Errors (Integration)

- [x] findFirstOrThrow / findUniqueOrThrow throw on not found
- [x] Unknown relation throws RelationError
- [x] Unknown orderBy column throws ValidationError
- [x] Unknown groupBy column throws ValidationError
- [ ] Unique constraint violation on create -> specific error
- [ ] FK constraint violation on create -> specific error
- [ ] FK constraint violation on delete -> specific error
- [ ] NOT NULL violation on create -> specific error
- [ ] CHECK constraint violation -> specific error
- [ ] Column does not exist -> specific error
- [ ] Table does not exist -> specific error
- [ ] Syntax error in raw SQL -> wraps PG error

### 12.3 Connection Errors

- [ ] Connection refused (wrong host/port)
- [ ] Authentication failed (wrong password)
- [ ] Database does not exist
- [ ] Connection timeout
- [ ] Pool exhaustion (all connections busy)
- [ ] Pool recovery after error
- [ ] Reconnection after disconnect
- [ ] SSL/TLS connection errors

---

## 13. Schema Builder (Unit Tests Exist)

- [x] Column types: serial, bigint, integer, smallint, text, varchar, boolean, timestamp, date, json, uuid, real, double, numeric, bytea
- [x] Column modifiers: primaryKey, notNull, unique, nullable, default, references
- [x] Method chaining in any order
- [x] defineSchema with object format
- [x] Object format produces identical DDL to fluent format
- [x] camelCase -> snake_case conversion
- [x] FK dependency ordering
- [x] FK index generation
- [x] Runtime type validation (invalid type, empty type, uppercase type)
- [x] Default value validation (SQL injection, keywords, semicolons)
- [x] Special defaults: gen_random_uuid(), NULL, negative numbers, decimals
- [x] Edge cases: self-referencing table, uuid primary key, varchar with maxLength, empty schema

### 13.1 Schema Builder Gaps

- [ ] Composite primary key
- [ ] Composite unique constraint
- [ ] CHECK constraints
- [ ] Custom index definitions
- [ ] ON DELETE CASCADE / SET NULL
- [ ] Enum type columns
- [ ] Array type column definition
- [ ] Schema with 50+ tables (performance)

---

## 14. Migration System (Unit Tests Exist)

- [x] parseMigrationContent: UP/DOWN sections, multi-line, comments, case-insensitive
- [x] sanitizeName: lowercase, special chars, collapse underscores
- [x] formatTimestamp: YYYYMMDDHHMMSS format
- [x] parseMigrationFilename: valid format, rejects invalid
- [x] listMigrationFiles: sorted, ignores non-migrations, empty dir
- [x] getPendingMigrations: filters applied, returns in order
- [x] createMigration: naming, sanitization, headers, directory creation

### 14.1 Migration Gaps

- [ ] Apply migration (UP execution)
- [ ] Rollback migration (DOWN execution)
- [ ] Migration locking (concurrent migrations)
- [ ] Dry-run mode
- [ ] Failed migration: partial rollback
- [ ] Migration with multiple SQL statements
- [ ] Migration status reporting

---

## 15. Query Builder (Stress Tests Exist)

- [x] Deep nesting up to depth 9
- [x] Circular relation detection
- [x] Depth limit (10)
- [x] Large WHERE clause (100+ conditions)
- [x] Repeated query builds (LRU cache determinism)
- [x] Wide with clause (12 sibling relations)
- [x] OrderBy column validation
- [x] GroupBy column validation
- [x] SQL injection in orderBy rejected

### 15.1 Query Builder Gaps

- [ ] SQL template cache eviction (exceed 1000 entries)
- [ ] Cache key collision detection
- [ ] Query with all operators combined
- [ ] Very long table/column names
- [ ] Reserved SQL keywords as column names (e.g., "order", "group", "select")
- [ ] Column names with special characters (if quoted correctly)

---

## 16. Connection Pool

- [ ] Pool creates correct number of connections (poolSize)
- [ ] Pool reuses idle connections
- [ ] Pool waits when all connections busy
- [ ] Pool timeout when waiting too long
- [ ] Pool stats (totalCount, idleCount, waitingCount)
- [x] Stats are accessible (basic assertion in connection tests)
- [ ] Pool handles connection drops gracefully
- [ ] Pool recovery after database restart
- [ ] Pool with poolSize: 1 (serialized queries)
- [ ] Pool with poolSize: 0 (error)
- [ ] Concurrent queries share pool correctly

---

## 17. Introspection

- [x] Detects expected tables (users, posts, comments, organizations)
- [x] Detects correct column counts
- [x] Detects relations (hasMany, belongsTo)
- [ ] Detects enum types
- [ ] Detects array column types
- [ ] Detects composite primary keys
- [ ] Detects composite unique constraints
- [ ] Detects indexes
- [ ] Handles tables with no relations
- [ ] Handles views (skip or include)
- [ ] Handles schemas other than public

---

## 18. Performance

- [ ] Query latency benchmark (findUnique, findMany, count)
- [ ] Nested relation query latency (L2, L3, L4 vs N+1)
- [ ] Pipeline vs individual queries (round-trip savings)
- [ ] createMany vs individual creates (batch performance)
- [ ] LRU cache hit rate under load
- [ ] Connection pool throughput under concurrent load
- [ ] Memory usage with large result sets
- [ ] Memory usage with deep nesting
- [ ] JSON serialization overhead for json_agg

---

## 19. Concurrency

- [ ] Concurrent findMany queries (no interference)
- [ ] Concurrent create queries (unique constraint races)
- [ ] Concurrent update on same row (last write wins or conflict)
- [ ] Concurrent upsert on same unique key (only one creates)
- [ ] Concurrent transactions with Serializable isolation
- [ ] Deadlock detection and recovery
- [ ] Connection pool under concurrent load (50+ simultaneous queries)

---

## Summary: Coverage by Category

| Category                  | Existing | Gaps | Total |
|---------------------------|----------|------|-------|
| findUnique                | 5        | 8    | 13    |
| findFirst                 | 6        | 6    | 12    |
| findFirstOrThrow          | 2        | 2    | 4     |
| findUniqueOrThrow         | 2        | 2    | 4     |
| findMany                  | 9        | 11   | 20    |
| create                    | 2        | 16   | 18    |
| createMany                | 4        | 5    | 9     |
| update                    | 2        | 12   | 14    |
| updateMany                | 1        | 4    | 5     |
| delete                    | 2        | 4    | 6     |
| deleteMany                | 1        | 4    | 5     |
| upsert                    | 2        | 6    | 8     |
| count                     | 4        | 4    | 8     |
| aggregate                 | 6        | 7    | 13    |
| groupBy                   | 3        | 6    | 9     |
| Where operators           | 18       | 27   | 45    |
| Relations                 | 16       | 15   | 31    |
| Cursor pagination         | 4        | 9    | 13    |
| Distinct                  | 3        | 6    | 9     |
| Transactions              | 9        | 14   | 23    |
| Raw SQL                   | 1        | 10   | 11    |
| Pipeline                  | 1        | 7    | 8     |
| Middleware                | 12       | 6    | 18    |
| SQL injection             | 5        | 11   | 16    |
| Type handling             | 1        | 57   | 58    |
| Error handling            | 18       | 12   | 30    |
| Schema builder            | 30+      | 8    | 38+   |
| Migration                 | 20+      | 7    | 27+   |
| Query builder (stress)    | 12       | 6    | 18    |
| Connection pool           | 1        | 10   | 11    |
| Introspection             | 3        | 7    | 10    |
| Performance               | 0        | 9    | 9     |
| Concurrency               | 0        | 7    | 7     |
| **TOTAL**                 | **~200** | **~320** | **~520** |

---

## Priority Tiers

### Tier 1: Critical (ship-blocking)
1. Type handling for all Postgres types (Section 11) -- most likely source of production bugs
2. Error handling for constraint violations (12.2) -- users need actionable errors
3. create/update edge cases (empty, null, type coercion) (1.6, 1.8)
4. SQL injection additional vectors (10) -- security critical
5. Empty table / empty result handling across all operations

### Tier 2: High (production quality)
1. Relation edge cases (3.1 gaps: belongsTo null, hasOne, many-to-many, self-ref)
2. Transaction edge cases (6.5: timeout rollback, retry)
3. Where operator edge cases (empty arrays, nested logic, null in lists)
4. Connection pool behavior (16)
5. Concurrent operations (19)

### Tier 3: Medium (completeness)
1. Cursor pagination edge cases (4)
2. GroupBy/aggregate advanced features (1.14, 1.15)
3. Raw SQL comprehensive coverage (7)
4. Pipeline edge cases (8)
5. Introspection edge cases (17)

### Tier 4: Nice-to-have (polish)
1. Performance benchmarks (18)
2. Schema builder advanced features (13.1)
3. Migration execution tests (14.1)
4. Middleware advanced patterns (9.2)
