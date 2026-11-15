# Typed SQLite generation

Generate a schema-specific SQLite factory from code-first metadata or an existing
SQLite database. The factory preserves nested read/write types, projections,
typed transaction callbacks and SQLite options. Construction is synchronous;
the query API returns promises over Node's synchronous SQLite driver.

From the repository root, using a Node version with `node:sqlite`:

```sh
npm run build
npx tsx examples/sqlite-generated/generate.ts
npx tsx examples/sqlite-generated/app.ts
```

The example creates a fresh in-memory database and checks nested reads/writes,
updates, transactions, savepoints, rollback and external-handle ownership.
Generated files are ignored by git. Passing a database filename to `generate.ts`
opens it read-only and generates its schema; adapt `app.ts` to those tables.

The programmatic API is `generate({ schema, target: 'sqlite', outDir })`, with
`schema` supplied by `schemaDefToMetadata` or `introspectSqliteDatabase`.
The generated module exports `turbine(pathOrDatabase, options?)` and a
schema-specific `TurbineClient` type. Omitted targets keep the existing
PostgreSQL class and factory output.

For a persistent project using CLI init, pull, SQL migrations, and status, see
[the SQLite lifecycle example](../sqlite-lifecycle/README.md). SQLite schema
diff/push remains unsupported. SQLite still uses the shared client graph and
the package still installs `pg`.

Introspection distinguishes rowid-generating `INTEGER PRIMARY KEY` columns
(including `AUTOINCREMENT`) from `INT`/text/composite keys and `WITHOUT ROWID`
keys. Create inputs require non-null keys without a default. Ordinary rowid
tables can have nullable text/composite primary keys, so those inputs remain
optional; `NOT NULL`, `STRICT` and `WITHOUT ROWID` constraints are respected.
The inline `INTEGER PRIMARY KEY DESC` exception does not generate values.
These rules follow [SQLite's key semantics](https://sqlite.org/lang_createtable.html).

A foreign key covered by an exact full plain unique key yields a to-one reverse
relation, preserving its existing accessor name (for example `profiles`).
Partial/expression indexes and unique supersets do not imply that cardinality.
Foreign/reference columns with different [SQLite type affinities](https://sqlite.org/datatype3.html)
also retain arrays: comparison coercion can match multiple distinct unique values.
Tables/indexes mentioning `COLLATE` conservatively retain to-many relations,
since index uniqueness and the relation's comparison can use different collations.
`introspectSqliteDatabase` and `introspect` support `legacyToManyUniques: true`
to retain array results; the SQLite CLI does not yet forward that option.
Virtual/stored computed columns are readable and excluded from generated write
inputs using the existing computed-column metadata flag. Views remain omitted;
computed expressions and expression-index column lists are not reconstructed
for schema diff/rebuild. Native index SQL is retained in metadata.
