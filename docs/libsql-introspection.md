# Local libSQL catalog introspection

`turbine-orm/libsql/introspect` supplies `introspectLibsql(target, options)` for the
actual optional `@libsql/client/node` local native engine. It returns the existing
`SchemaMetadata` shape accepted by `generateLibsqlFiles` and `turbineLibsql`.
There is no new mandatory runtime dependency. The export was added in 0.94.0.
`turbine pull --engine libsql` uses it for [local libSQL projects](libsql-cli.md).

The application can read an existing catalog and write generated files with its
own file writer:

```ts
import { introspectLibsql } from 'turbine-orm/libsql/introspect';
import { generateLibsqlFiles } from 'turbine-orm/libsql/generate';

const metadata = await introspectLibsql('file:app.db', {
  schema: 'main',
  include: ['users', 'profiles'],
  legacyToManyUniques: false,
});
const files = generateLibsqlFiles(metadata, { noTimestamp: true });
// files contains index.ts, types.ts and metadata.ts as strings.
```

A string target opens an owned native client with exact `intMode: 'bigint'` and
closes it on success or any catalog/validation error. For an existing `:memory:`
database, supply `{ client, url: ':memory:' }`. Supplied clients remain open on
success and every failure; the caller closes them. They must report the native
`file` protocol and exact bigint results. As with the local adapter, supplying a
client attests to the given local URL without sync or replicas. Private native
configuration cannot be inspected. Do not share the supplied handle concurrently
with transactions, introspection, adapter operations or schema changes.

The reader issues only SELECTs and catalog PRAGMAs. It does not acquire, commit or
roll back caller transactions. A main `schema_version` change during the read
causes a refusal. This detects ordinary concurrent DDL; it is not an atomic
catalog snapshot or protection against deliberate version resets. Retry with
schema changes stopped.

| Catalog fact | Metadata behavior |
| --- | --- |
| Composite primary and foreign keys | Preserve native key order, including implicit references to the target PK. In-scope unresolved references refuse rather than invent an `id` target. ASCII case variants resolve to actual catalog spelling. Relations to filtered-out or absent targets are omitted. |
| Rowid alias | A sole exact INTEGER PK with no separate PK index on a rowid table is generated and defaulted. Inline `PRIMARY KEY DESC`, INT, WITHOUT ROWID and STRICT keys retain their actual catalog semantics. |
| Nullability and defaults | Preserve explicit NOT NULL, effective PK nullability on STRICT/WITHOUT ROWID tables, and raw `dflt_value` SQL, including `DEFAULT NULL`. Defaults are metadata, never executed by this reader. |
| VIRTUAL and STORED generated columns | Both use the existing `isGeneratedStored` non-writable flag. Generation expressions are unavailable and omitted. The existing generator and write guards prohibit supplying either kind. |
| Indexes | Preserve native index names and available SQL. Partial indexes retain `partial: true`. An expression index has an empty complete-key column list, so partial information cannot become a compound selector. Auto-index SQL is unavailable and represented by an empty definition, never synthesized DDL. |
| Unique-FK inverse relations | `hasOne`, named as PostgreSQL names it (`users.profile`), only for a full plain unique key exactly covering the FK with matching comparison affinity. Partial/expression keys, supersets, STRICT ANY mismatches, and collation uncertainty stay `hasMany`. A COLLATE token in the child table or the relevant index, or in the parent table unless the referenced key is the rowid alias, conservatively prevents the inference, including tokens in comments/identifiers. `legacyToManyUniques: true` retains arrays under the plural names. Shapes that still differ from PostgreSQL: [Relation names across engines](relation-names.md#known-differences). |
| Types and names | Reuse the portable SQLite declared-type mapping, shared field-collision/name guards and relation derivation. Existing libSQL generation emits exact integer, BLOB and numeric declarations. Quoted and Unicode catalog names remain data; generation still refuses names that cannot form valid entity identifiers. |

Options support `include`, `exclude`, `logger`, `relationNames`,
`keepColumnNames`, `legacyToManyUniques`, `schema: 'main'`, and
`includeViews: false`. Filtering reuses the established bookkeeping exclusions.
Views are omitted by default; explicitly including a view refuses. Temp objects
are ignored through main-qualified reads, so temp shadows cannot change metadata.
Non-main scopes, attached databases, selected virtual/shadow tables, view
inclusion and unknown options explicitly refuse. A filter can exclude unsupported
tables. Remote URLs, remote file hosts, query/fragment options, auth, sync,
replicas, encryption and new Turso engines remain outside this API.

CHECK expressions, FK constraint names/actions/deferrability, column collations,
generated expressions and exact DDL round trips are not supplied. Synthetic FK
identities serve relation naming only. Index source is informational, not approved
migration SQL. No schema diff, push, migrations, lifecycle runner, sync or remote
schema certification is offered.

Focused verification uses required native imports with no skip fallback. Exact
Node 22.16 and 24.10 source runs exercise libSQL SQLite fork 3.45.1 with
`@libsql/client` 0.18.0 and native `libsql` 0.5.29 on Linux x64 glibc. Installed
ESM/CJS consumers use strict TypeScript with `skipLibCheck: false` and no
`@types/pg`, with `node:sqlite` loading forbidden. Isolated peer/engine omissions
must fail the required source suite; real-native owned-handle fault wrappers
check close-on-error without mutating shared dependencies. These are local
engine and installed-package checks, not hosted/provider, remote CI, support-tier or
release certification. The full PostgreSQL graph and mandatory pg installation
contract remain unchanged.
