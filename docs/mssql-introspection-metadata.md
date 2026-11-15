# SQL Server introspection metadata

`introspectMssqlWith(exec, schema, options)` reads SQL Server 2016+ catalog facts through the existing parameterized executor. `introspectMssql(options)` owns and closes a short-lived connection. The metadata shape remains `SchemaMetadata`; PostgreSQL and SQLite introspection are unaffected.

Primary and foreign key columns retain catalog order, including composite keys. Catalog joins include the table and constraint namespace. Cross-schema foreign keys are omitted because generated relations address tables by bare name in one schema. Include/exclude filters run before relation derivation.

Identity columns report `isGenerated: true` and `hasDefault: true`. Defaults report presence without returning their SQL or literal values. Required columns without defaults stay required in generated create inputs; nullable columns remain nullable. Identity overrides retain the existing generated-input contract and remain subject to SQL Server's native identity rules.

Computed columns, including nonpersisted columns, report `isGeneratedStored: true` and `hasDefault: true`. The existing generated-column flag means the column is excluded from generated create/update inputs and explicit writes are refused before execution. The same protection applies to rowversion and visible generated-always temporal/ledger columns. Hidden columns are excluded from default projections. Neither default expressions nor computed expressions are copied into metadata or converted into portable DDL.

Indexes retain names, ordered plain key columns, effective uniqueness and the existing `partial` flag for filtered indexes. Included columns do not become key columns. Safely quoted descriptive definitions retain index kind, descending keys, included columns and filtered/disabled/hypothetical notes. These summaries are not executable migration DDL. Filter predicates and their literals are withheld, including when catalog visibility would hide the predicate text.

Disabled and hypothetical indexes report `unique: false` and empty key arrays, because they cannot establish an enforced key or active FK index coverage. Their descriptive definitions retain the declared uniqueness and inactive state. Indexes with computed keys also have empty key arrays, so dropping expression keys can never invent a smaller unique key. Non-key columnstore/XML/spatial index columns do not become plain keys. There are no additional structured fields for included columns, expressions, index kind or inactive state in the shared metadata interface.

Reverse FK relations become `hasOne` only when the exact child FK set has a full, active, plain unique index or active primary key, and paired columns have matching database types, type dimensions and known matching character collations. Filtered uniqueness, computed expression keys, extra unique key columns, missing/different collations and uncertain comparison conversions keep `hasMany`. Nullable SQL Server unique keys remain eligible: matching non-null FK values cannot repeat. The to-one is decided per foreign key before naming, so it is named as PostgreSQL names it: `users.profile`, not `users.profiles`. Pass `legacyToManyUniques: true` to either introspection function to keep the 0.93.1 output, an array under the plural name. Neither function reads `relationNames`; generic `introspect` with `mssqlDialect` and `turbine.config.ts` do. The shapes that still differ from PostgreSQL (a junction keyed by a unique index, referential actions, composite FKs sharing a target, contested names) are listed in [Relation names across engines](relation-names.md#known-differences). Shared CLI option forwarding is owned by the CLI integration.

Catalog visibility remains permission dependent. Introspection does not grant permissions, reconstruct hidden definitions, parse arbitrary native SQL or certify a database schema as portable.

## Validation

The focused suites are:

```sh
npm ci --ignore-scripts
npm run gen:studio
npx tsx --test src/test/mssql-introspection-metadata.test.ts \
  src/test/mssql-introspection-metadata-consumers.test.ts
```

Catalog fixtures expose the actual boolean BIT shape returned by the driver, ordered composite keys, generated/default facts, index state and collation boundaries. They also assert the queries' namespace predicates and bound schema parameters. Generated consumers compile and execute both ESM and CommonJS outputs under strict NodeNext settings with `skipLibCheck: false`. Removing each expected-error directive must produce a diagnostic for its specific invalid input.

Native validation needs a separately authorized direct endpoint to a **disposable SQL Server 2016+ database**, with the optional `mssql` driver installed. Supply `MSSQL_TEST_URL` or `MSSQL_URL` securely in the process environment; do not put credentials in tracked files or logs. The database user needs permission to create/drop schemas, tables and indexes and to see its own catalog metadata. The tests create two random owned schemas, quote their names, and remove only their own objects in dependency order before closing the pool. They never reset dbo or another service's data directory.

```sh
TURBINE_REQUIRE_ENGINE=mssql npx tsx --test \
  src/test/mssql-introspection-metadata-native.test.ts
```

These native cases check actual inserts, defaults, nullability, computed values, rowversion, hidden temporal columns, duplicate-key refusal, filtered-index duplicates, scoped composite keys, disabled indexes and reverse cardinality. A missing endpoint fails when the engine is required; ordinary prerequisite skips are not passing native evidence. Hypothetical indexes, missing/different collation facts and ledger generated-always variants currently have catalog-fixture coverage only. The `mssql-integration` gate runs these native cases against SQL Server 2022. Other server versions and fixture-only cases remain outside that evidence.

Catalog semantics: [sys.columns](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-columns-transact-sql), [sys.indexes](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-indexes-transact-sql), [sys.index_columns](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-index-columns-transact-sql), [computed-column indexes](https://learn.microsoft.com/en-us/sql/relational-databases/indexes/indexes-on-computed-columns), and [rowversion](https://learn.microsoft.com/en-us/sql/t-sql/data-types/rowversion-transact-sql).
