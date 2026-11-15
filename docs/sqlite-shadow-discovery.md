# SQLite shadow-table discovery

SQLite introspection excludes native engine-owned shadow tables by default.
For example, an FTS5 virtual table can own several storage tables. The virtual
user table remains in the discovered schema, while its native shadow tables
are omitted from default metadata and generated accessors.

Ownership comes exclusively from the existing `PRAGMA main.table_list` result:
only rows whose native `type` equals `shadow` add default exclusions. Ordinary
tables with names ending in `_data`, `_idx`, `_content`, `_docsize` or `_config`
remain discoverable. Missing or unknown classification does not exclude a
table. The existing literal `sqlite_` reserved-prefix and bookkeeping rules
continue to apply.

The builtin `introspectSqliteDatabase` options retain their precedence:

```ts
// Explicit include restores the selected internal table's previous metadata.
introspectSqliteDatabase(db, { include: ['search_docs', 'search_docs_data'] });

// Explicit exclude takes precedence over include.
introspectSqliteDatabase(db, {
  include: ['search_docs', 'search_docs_data'],
  exclude: ['search_docs_data'],
});
```

The optional `introspectBetterSqlite3Database` helper shares default discovery
and accepts include/exclude options. Main discovery does not expose
temp or attached catalogs. The metadata read adds no native roundtrip and
preserves include/exclude option access before the existing table-list query.

Keeping a virtual table preserves its current metadata. This change adds no
FTS query, seed, migration or provider guarantee and does not change SQLite's
Experimental API tier in STABILITY.md; its evidence tier is Supported.

The focused source controls are
`src/test/sqlite-shadow-policy.test.ts` and
`src/test/sqlite-shadow-filters.test.ts`. The physical installed fixture
`tooling/sqlite-shadow-installed.mjs` accepts format, binding, evidence
root and an explicit TypeScript compiler path. It exercises native FTS5,
complete metadata/value preservation, strict generated consumers, negative
type diagnostics and caller-owned handles. Its databases remain available
after closure for independent inspection.
