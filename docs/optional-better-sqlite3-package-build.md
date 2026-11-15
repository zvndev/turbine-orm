# Optional better-sqlite3 runtime package build

Build with `node scripts/build-optional-package.mjs --out /absolute/new/root
--profile better-sqlite3` (one command). The existing builder performs the
complete normal clean build. The optional package build is named
`turbine-orm-better-sqlite3-runtime-stage`. Install its actual
archive under the alias `turbine-orm`. The default API and mandatory pg remain
unchanged.

The export map is exactly `.`, `./better-sqlite3`, `./sql`. Root values are
`turbineBetterSqlite3`, `betterSqlite3Dialect`,
`introspectBetterSqlite3Database`, schema helpers and public errors. Type-only
root forwarding retains the declarations used by generated factories. There
is no CLI, generator, seed, PG factory or builtin SQLite value export. A
separate full tooling installation generates clients with `target: 'sqlite'`
and `sqliteBinding: 'better-sqlite3'`.

The mandatory exact driver is `better-sqlite3@12.11.1`. Its native binary and
installed dependency closure are additional to the Turbine tarball. The
existing helper resolves relative to the installed profile, including a
nested exact dependency when an incompatible application dependency exists.
An explicitly synthetic conflicting app fixture tests this resolution; it
does not establish compatibility with a historical native driver version.

The original adapter is unchanged. Supplied handles survive disconnect and
retain their own settings. Factory-owned handles keep FULL synchronous
durability, the existing named omitted-NULL behavior, complete values and
ordering, wrapped/Proxy fallback, incremental iteration, transactions,
rollback and complete RETURNING results. Native migration/session features
remain unavailable through this adapter. Qualification is bounded to exact
Node22.16.0/24.10.0 ESM/CJS with real ABI127/137 binaries; it grants no builtin
SQLite parity or broader runtime support.

The retained shared internal PG loader still needs an optional pg peer
declaration. That is no PG capability, and fresh production installs contain
no PG-family, compiler, Miniflare or workerd packages.

Closure is derived from every selected ESM/CJS runtime, declaration, literal
lazy import, type edge, conditional PG loader, URL asset and CJS scope. The
generic peer importer is opaque: only its two exact helper emissions and two
exact literal better-sqlite3 caller emissions are qualified. Complete normal
library/build inputs and the entire normal emitted inventory are pinned,
including files outside this profile's closure. The complete original
schemaVersion3 source/tool/template/build/payload checks remain mandatory.
The caught absent sibling at the ESM location is recorded narrowly; the CJS
sibling is retained. There is no general dynamic-loader or missing-target
exception. Changed source with refreshed descriptors and stale emission
refuses until explicitly requalified.

Verify with `node tooling/optional-package/verify-artifacts.mjs IDENTITY
NORMAL_ARCHIVE NORMAL_SHA256 NEW_OUTPUT` (one command). The verifier derives
the graph from the pinned normal archive and fixed facade; the descriptor
cannot choose its inventory. The qualified normal archive SHA256 is
`3e46c6f83a7fd8f1cbb7decc8343131abe282c2f4f6b419d75cbb7e9c11f19ac`.

Run the scoped contract tests with `node --test
tooling/optional-package/better-sqlite3-profile-contract.test.mjs`. The repack
controls are in `tooling/optional-package/better-sqlite3-profile-controls.mjs`;
the native binding consumer and generation fixture remain available separately. All existing 25 budgets, coverage floors and original profile bytes
remain fixed. Installed native footprint is descriptive, with no timing,
ranking, release or support promotion.

The runtime package version is read from the root package.json and suffixed with `-runtime.0`.
