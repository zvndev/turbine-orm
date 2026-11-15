# SQLite result decoding after schema changes

Ordinary queries and native iterators read result types from the statement that
actually executes. Reusing SQL text after native DDL therefore observes the new
column type, including when a second connection replaces a table:

```ts
import { SqlitePool } from 'turbine-orm/sqlite';

const pool = new SqlitePool(nativeHandle);
nativeHandle.exec('CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1)');
await pool.query('SELECT v FROM changing'); // [{ v: true }] in .rows
nativeHandle.exec('DROP TABLE changing; CREATE TABLE changing(v INTEGER); INSERT INTO changing VALUES(1)');
await pool.query('SELECT v FROM changing'); // [{ v: 1 }] in .rows
```

Decoding follows SQLite's resolved result columns across transaction/savepoint
rollback, temp table shadowing and attached database changes. It does not use
schema-version equality as proof that two executions have the same types.
Ordinary reads describe after execution. Native iterators describe after the
first step, so automatic reprepare before that step is also observed, and use
that description for the iterator's lifetime. Finish a stream before issuing
DDL on its handle. Existing transaction and stream ownership rules still apply;
direct handle access requires caller coordination. An active statement sees
SQLite's snapshot and locking behavior, not a promise of live schema changes
between rows.

There is no persistent SQL-to-decoder cache. Every nonempty result execution pays for a fresh native metadata
description, even when SQL text repeats. A single most recent result-shape record
keeps a snapshot of column names, declared types and origins, plus its decoder
map. An exact metadata match reuses that map; any changed field rebuilds it.
Different SQL shapes can share the record only after that fresh comparison.
Empty results need no decoding. Pool teardown clears the record.

The record count is bounded at one, regardless of SQL-shape churn. An active
iterator also retains the decoder map for its snapshot until it closes. The
record contains metadata, not row values or bindings, and its size depends on
projection width. This is a correctness fix with a measured per-query metadata
cost, not a speed guarantee or a native memory reclamation claim. It imposes no
byte limit on wide rows.

Ordinary results with multiple rows reuse their own native projection keys and
decoder lookups while constructing those rows. These temporary arrays live only
for that result; empty and single-row results keep their existing builder. The
[result-construction workload](../benchmarks/sqlite-query-cost/result-cost.md)
measures fixed-size multirow reads and writes alongside cold SQL text and native
DDL. Multirow gains do not remove the per-query metadata cost: single-row and
cold-query slowdowns remain in the measurements. No extra decoder shape is retained between executions.

Ordinary execution separately memoizes placeholder rewriting and whether SQL
returns rows. This pool-owned admission memo holds at most 128 entries and
128 KiB of accounted UTF-16 SQL payload, counting both input and rewritten text.
Statements longer than 32,768 UTF-16 code units skip lookup and retention.
New shapes execute without retention once the memo is full; existing hot
entries remain available. Parameter count participates in reuse:
`$2` with two parameters cannot authorize the same text with only one. Each
SQL text keeps only its latest parameter-count variant. This admission memo contains no bound values, rows, native statements or
decoder metadata. Its SQL-text decisions need no schema invalidation.

On a builtin handle opened by the factory, a separate weak memo can retain one idle native
SELECT, DML or transaction-control statement per admitted plan, at most 128 plans under the same SQL-text
budget. Every call binds its own values and describes its own executed result;
SQLite automatically reprepares retained statements after schema changes.
Rollback, temp shadowing and attached/external schema changes therefore still
use fresh post-step types and projection keys. Arity changes replace the plan,
failed executions discard their statement, results above 128 rows do not retain their statement, and an executing statement is never
available to another call. PRAGMAs, DDL, native streams, compatible bindings
and wrapped preparation keep preparing fresh statements. Caller-supplied handles
also keep fresh preparation. Reading `SqlitePool.db` clears and permanently
disables native reuse, before returning the original native handle. This keeps
caller-installed authorizers and other prepare callbacks live on every query,
including an authorizer whose closed-over policy changes without reinstalling
it. A statement containing `*` is kept only where the runtime's reader
follows a reprepare, which Turbine checks once per process. Node 22.5 to 22.15
read a wildcard's width before stepping, in `all()` and in `iterate()`, so
there every wildcard is prepared fresh. Even fresh, a `SELECT *` that SQLite
reprepares inside its own call (the first read after another connection or
process changed the table) can miss the change on those versions, as in
0.93.1. Node 22.16 or later is not affected.

Retained statements can hold their last native bindings. Only non-BLOB native bindings with at most 8 KiB of accounted payload per
execution are retained (strings count two bytes per UTF-16 unit, other values
eight bytes). Dates and JSON objects participate through their converted native
strings, with the cap applied after conversion. BLOBs and larger bindings do not
retain a statement. The weak memo retains neither caller objects nor returned
rows. Pool teardown clears both memos. These limits do not bound the native
compiled statement or JavaScript heap footprint.
These reference and string-payload limits do not bound JavaScript/native heap
usage. See the [query-cost harness](../benchmarks/sqlite-query-cost/README.md)
for paired measurements against the correct decoder path.

`SqlitePoolOptions.schema` remains the caller's logical type declaration. For
example, a boolean stored in an INTEGER column or JSON stored in TEXT still
decodes using that declaration. Changing the physical table does not rewrite
the supplied schema. Its unqualified table/column mapping does not distinguish
same-named tables across attached/temp namespaces. Namespace tests without a
supplied logical schema use native declared types; do not infer namespace-aware
logical schema support. Use a matching schema and avoid conflicting mappings.

Node 22.5 ordinary reads keep their existing floor. On runtimes without
`StatementSync.columns()`, or when the driver cannot describe a statement,
values keep their stored representation. Types are not guessed from SQL text.
A native result's `__proto__` column is retained as an ordinary own data property,
including streamed rows and JSON values; it never changes the returned object's
prototype. Node 22.5's native object-row driver itself omits this column before
Turbine receives it. That driver limitation remains unsupported; use a runtime
whose native rows retain the key, verified here on Node 22.16 and 24.10.
A later describable execution retries metadata lookup. Native iteration retains
its explicit capability refusal on older runtimes, as documented in
[SQLite streaming](sqlite-streaming.md).

The [preparation workload](../benchmarks/sqlite-preparation/README.md) checks the
external-DDL result on both pool routes. Its validator preserves the meaning of
historical reports that observed stale boolean decoding. Timing and memory
measurements must identify source hashes, runtime, exact results and shared-host
noise; removing a JavaScript cache alone establishes no native memory claim.

Public SQLite query and native stream paths admit one native statement. They
check SQLite's actual parsed statement boundary before stepping and refuse a
second statement or non-comment trailing input. Trigger bodies, quoted
semicolons and trailing comments remain valid. Use separate calls for multiple
statements; raw SQL no longer silently executes only the first statement.

## Wildcards and duplicate output names

On Node 22.16.0 (SQLite 3.49.1) and Node 24.10.0 (SQLite 3.50.4),
`StatementSync.all()` snapshots the result width before SQLite automatically
reprepares a statement. If the schema changes a `SELECT *` projection between
prepare and the first step, adding a column silently omits cells; removing a
column can throw `ERR_INVALID_STATE`. That includes the first star query on a
handle after another connection or process altered the table, because the
handle prepares against its cached schema and reprepares on the first step.
Repeated output names can hide the width change and return an earlier cell
instead of the final cell. A post-execution `columns()` call reports the new
projection, so refreshing decoders alone cannot recover the lost values. A
direct native probe on Node 26.12.0 (SQLite 3.54.0) returns the complete
projection in all three cases.

Turbine asks the runtime once per process, on its first builtin read whose SQL
contains `*`: it prepares a star query on a private in-memory database, adds a
column, and checks what `all()` returns. Where `all()` returns the reprepared
projection (Node 26.12.0), every read uses `all()`. Where it does not (Node
22.16.0 and 24.10.0), builtin statements whose SQL contains `*` are read with
the native iterator instead, which observes the executed width; the ordinary
result is still collected once and its post-step metadata resolved. That route
measured about 50 to 110 percent slower than `all()` for 100 to 10,000 rows on those
runtimes, and about the same for a single row. This is still an eager ordinary
query; it does not retry SQL, retain a prepared statement or promise
bounded-memory streaming. Star-free projections and compatible bindings keep
their existing result path. The iterator is the `StatementSync.prototype`
method captured at that first check, never a statement's own iterate property.
Caller-wrapped `all()` methods, on a statement or on the prototype, retain
responsibility for their own row contract.

Node 22.5 to 22.12 have no `StatementSync.iterate()`, so Turbine reads every
builtin statement there with `all()`, as before. Node 22.13 to 22.15 have it,
but their `iterate()` also reads the width before the first step, so it does
not help there. Turbine's own default
`findMany`, `findUnique`, `count`, `aggregate` and `RETURNING *` writes contain a
star, so refusing star SQL would stop the engine on those runtimes. The defect
above therefore remains on them: when the schema changes between prepare and
the first step, a star projection can omit added columns or return an earlier
cell for a repeated name. In a direct native reproduction without Turbine,
removing a column crashed Node 22.5 with a segmentation fault. Use Node 22.16
or later when schema changes can happen while the application runs. Native
streaming still needs the stronger transaction-state contract described above.

Repeated output names use the final projected column's type and value,
including when a boolean or JSON column is followed by an untyped expression.
An earlier boolean decoder never converts a later numeric expression's `1`
into `true`. These cases run on both bindings in
[`sqlite-result-metadata.test.ts`](../src/test/sqlite-result-metadata.test.ts).
