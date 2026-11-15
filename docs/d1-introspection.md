# Native D1 catalog introspection

The optional `introspectD1(binding, options)` reads a caller-owned Cloudflare
`D1Database` binding into the existing `SchemaMetadata` shape. It is a native D1
catalog reader. It accepts no SQLite URL, Node database handle, credential or
remote transport configuration. There is no mandatory runtime dependency.

The `turbine-orm/d1/introspect` ESM/CJS export and shared catalog helper
were added in 0.94.0. The required installed-consumer gate
uses an explicit package archive and hash, with no export overlay.

```ts
import { introspectD1 } from 'turbine-orm/d1/introspect';
import { turbineD1 } from 'turbine-orm/d1';

const schema = await introspectD1(env.DB, {
  schema: 'main',
  include: ['users', 'profiles'],
  relationNames: { users: { profile: 'ownProfile' } },
});
const db = turbineD1(env.DB, schema);
// Use the ordinary D1 facade and its explicit native batch API.
await db.disconnect();
// env.DB remains the caller's usable binding on success and failure.
```

## Collection and consistency

Cloudflare documents [catalog PRAGMAs](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
and [native sequential atomic batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
D1 sessions provide sequential consistency/bookmarks; they are not interactive
SQL transactions. This reader uses no session, connection pinning, BEGIN,
COMMIT, ROLLBACK, migration or DDL operation.

Collection has three binding calls for a nonempty catalog: discover the main
schema manifest; discover native index names in a batch; collect every required
fact in one final native batch. WITHOUT ROWID primary-key indexes can appear in
`index_list` without a `sqlite_master` entry, so their names are discovered rather
than guessed. An empty catalog needs no index-discovery batch.

The final atomic batch starts and ends with the schema manifest and `table_list`.
Both manifests must match discovery, both flag lists must match, and final index
lists must match index discovery. Otherwise the reader refuses. Columns, keys,
indexes and flags used by metadata all belong to that batch. It does not assemble
a result from successive independent table reads or silently retry schema drift.
Native catalog failures propagate. D1 forbids `schema_version`; this reader does
not depend on it. No protection is claimed for bindings that violate the real D1
batch contract.

The number of prepared statements grows with tables and indexes. Native D1
batch/query/resource limits still apply; errors propagate without splitting the
final collection into weaker snapshots. Collection reads catalog facts for all
main user tables before applying filters, so drift in an excluded table can also
cause refusal. It does not read application row data.

## Supported metadata

| Fact | Behavior |
| --- | --- |
| Main ordinary tables | Main-qualified reads; views omitted, selected virtual/shadow tables refused. SQLite `sqlite_` and D1 `_cf_` system prefixes are excluded. |
| Filters | Exact include/exclude names, in that order; established Turbine/Prisma bookkeeping exclusions with explicit include escape. Unknown table names have the existing empty-filter behavior. |
| Keys and defaults | Ordered composite PK/FK columns, implicit target PK resolution and ASCII identifier case folding. Raw default SQL and effective nullability retained. A sole exact INTEGER rowid alias is generated/defaulted; inline PK DESC and WITHOUT ROWID keys retain their real behavior. |
| STRICT / WITHOUT ROWID | Native flags determine key nullability and rowid generation. Existing TableMetadata has no dedicated flags or table-DDL fields, so no extra properties or reconstructed DDL are invented. |
| Generated columns | VIRTUAL and STORED both use existing `isGeneratedStored` to mean non-writable. Generation expressions are omitted. Existing generated declarations/write guards prohibit both kinds. |
| Indexes | Real names and available SQL; partial flags retained. Expression indexes expose an empty complete-key column list. Unavailable auto-index SQL remains an empty definition. |
| Relations | Existing naming, collisions and conservative junction detection are reused through an exact portable helper extraction. Composite order retained. Filtered-out or absent FK targets have no relation. Unresolvable in-scope keys refuse. |
| Reverse unique FK | `hasOne`, named as PostgreSQL names it (`users.profile`), only for an exact, full, plain unique key with compatible comparison affinity. Partial/expression/superset keys, STRICT ANY mismatches and collation uncertainty retain `hasMany`, the same rule as the other SQLite introspectors. `legacyToManyUniques: true` keeps arrays under the plural names. Shapes that still differ from PostgreSQL: [Relation names across engines](relation-names.md#known-differences). |
| Names | Prototype-free catalog maps; quote escaping and existing identifier/field-collision guards. Quoted, Unicode and prototype-sensitive names remain data. `keepColumnNames` preserves raw fields. Existing generator restrictions on entity/accessor identifiers still apply. |
| D1 values | INTEGER/BIGINT declarations emit `number`, reflecting the actual binding contract. BLOB uses Uint8Array, BOOLEAN uses the existing facade decoder and date declarations use Date. NUMERIC/DECIMAL can retain TEXT and emit `number \| string`. |

The [D1 value contract](https://developers.cloudflare.com/d1/worker-api/#type-conversion)
returns INTEGER as JavaScript numbers and does not support BigInt in its API.
Values outside JavaScript's safe integer range have no exact-integer guarantee.
SQLite declarations do not validate every stored value in non-STRICT tables.
This reader neither samples data nor certifies numeric/engine parity. Exact large
values require an application TEXT storage/read design.

Options: `include`, `exclude`, `keepColumnNames`, `relationNames`,
`legacyToManyUniques`, `logger`, `schema: 'main'`, `includeViews: false`.
Unknown options (including session/transport/lifecycle settings), invalid option
shapes, non-main scopes and view inclusion refuse explicitly before prepare.
Explicitly including a view also refuses. Relation rename typos, collisions and
unsafe names refuse after catalog collection. Options affecting metadata are
copied before the first await.

CHECK expressions, FK constraint names/actions/deferrability, column collations,
generated expressions, attached/temp schemas and exact DDL reconstruction are
not supplied. Synthetic FK labels serve relation derivation only. Index SQL is
informational. No migration, rebuild, lifecycle or hosted-provider certification
is provided. Native SQL Server and hosted providers remain uncertified.

## Generated consumers and verification

The existing `generateTypes`, `generateMetadata` and type-only `generateIndex`
SQLite target preserve this catalog's `tsType` declarations. Do not enable
`exactNativeIntegers` for D1: that option describes the different native Node
SQLite/libSQL integer contract. Use the integrated [D1 generator](d1-generation.md)
to emit an actual `turbineD1` factory for a Worker. Its catalog-to-generation
consumer gate executes the generated code with a native local binding. No D1 CLI
or deployment workflow is supplied.

Required tests use Miniflare 4.20260730.0, workerd 1.20260730.1, official Worker
types 5.20261106.1, compatibility date 2026-01-01 and `nodejs_compat`. Native reads
and writes have no mocks or Node SQLite substitution. Strict ESM/CJS consumers
(`skipLibCheck: false`) use the exact staged tarball and execute in workerd.
Only the existing `node:async_hooks` error-context builtin remains in the optional
graph. No pg, native SQLite, TCP driver or Miniflare runtime peer enters it.
Miniflare is a test-only prerequisite, not a library dependency.

Tests are deliberately required and fail when prerequisites are absent:

```sh
# After building and packing the integrated source:
TURBINE_D1_MINIFLARE_MODULE=/path/to/pinned/miniflare \
TURBINE_D1_WORKERS_TYPES_DIR=/path/to/pinned/workers-types \
TURBINE_D1_INTROSPECTION_ARCHIVE=/path/to/staged.tgz \
TURBINE_D1_INTROSPECTION_SHA256=<exact-staged-sha256> \
TURBINE_D1_TARBALL=/path/to/retained-actual-root.tgz \
TURBINE_D1_TARBALL_SHA256=<exact-actual-root-sha256> \
node --import tsx --test --test-concurrency=1 \
  src/test/d1-introspection.test.ts \
  src/test/fixtures/d1-introspection/consumers.test.ts \
  src/test/fixtures/d1-introspection/graph.test.ts \
  src/test/fixtures/d1-introspection/provenance.test.ts
```

The last archive and hash variables are a provenance control pinned to the retained root
artifact in this development program. It intentionally proves that archive lacks
the D1 catalog export. It is not positive installed-catalog evidence.
The provenance test is separate from the catalog acceptance suite so a future
package gate can test its own catalog-enabled archive without an older archive.

The host-proxy native tests avoid serializing an own `__proto__` row across
Miniflare's devalue bridge, which rejects it. Full prototype-key row behavior is
asserted inside the actual Worker, including the existing root decoder fix.
Local native execution does not certify hosted Cloudflare D1, sessions,
bookmarks, read replicas, remote binding configuration, CI, release readiness or
any performance improvement.

The measured optional catalog graph has 12 inputs in each format. With esbuild
0.28.2, the source ESM bundle is 27,846 minified bytes / 8,892 Brotli-q11 bytes;
staged ESM is 27,846 / 8,895 bytes, and direct staged CommonJS is 84,676 / 25,170
bytes. All formats have only `node:async_hooks` external. Import guards run before
tree shaking and reject pg, #pg, node:sqlite, node:net, node:tls, mysql2 and
@libsql/client. CommonJS retains more helper exports; its measured bytes are
reported separately.

Following the existing size-limit convention (bundle dist/d1/introspect.js for
Node CJS), the measurement is 9,067 Brotli bytes. The separate 11 kB
budget is integrated and leaves 1,933 bytes of headroom at that measurement. No existing limit changed.
The current branch's no-.git staged package leaves all twenty existing limits
unchanged: seventeen pass; main is 150,153 / 150,000 bytes, edge is 117,248 /
117,000 and native SQLite is 127,099 / 127,000. These are branch-fixture results,
not current final-package measurements. Package exports, suite/CI wiring and
the additional budget are now integrated; remeasure the exact artifact used
for a release or comparison.
