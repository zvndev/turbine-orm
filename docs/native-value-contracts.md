# Packed native value contracts

`tooling/native-consumer-contracts/verify.mjs` installs a SHA256-pinned archive in
an ordinary isolated application, introspects real native tables through its
installed CLI, and compiles and executes strict ESM and CommonJS applications.
It does not build or import the checkout's production sources.

The required inputs are a built `turbine-orm` 0.93.1 archive, Node 22 or newer,
and fresh-service binaries for each requested network engine. SQLite uses
`node:sqlite`. This corpus pins PostgreSQL **18.6** and MySQL **8.4.0**, including
both `STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION` and that mode plus
`ANSI_QUOTES,NO_BACKSLASH_ESCAPES`. It never borrows a database URL or an existing
data directory. Missing prerequisites fail the invocation. There are no native
SQL Server claims.

```bash
export PG_PREFIX=/absolute/path/to/portable-postgres/usr
export MYSQL_BASEDIR=/absolute/path/to/mysql
export MYSQL_LIBRARY_PATH=/absolute/path/to/mysql-libraries
node tooling/native-consumer-contracts/verify.mjs \
  --engine all --tarball /absolute/path/to/turbine-orm-0.93.1.tgz \
  --sha256 YOUR_ARCHIVE_SHA256 --exact-node 24.10.0 \
  --out /tmp/native-contract-evidence-unique
```

Choose `sqlite`, `postgresql`, or `mysql` for one engine. `--out` must be a new
directory. Omitting `--sha256` selects the archive pin embedded in the harness;
changing the package requires a deliberate new pin. Installation uses pinned
consumer tools (`typescript` 6.0.3, `@types/node` 22.20.4, `tsx` 4.23.15),
`pg` 8.22.0 and optional `mysql2` 3.24.5. This adds no repository dependency.
The generated application uses the actual engine-specific factory and relation
names. The PostgreSQL factory remains synchronous; awaiting its result in the
application does not change that API.

The small billing corpus contains two customers, one unique customer profile,
and six invoices split across both parents. Each invoice has a generated
`doubled` value. Two invoices per parent tie on `score`; ordering by descending score and descending ID,
then applying limit 2 and offset 1, must independently yield `[12, 11]` and
`[22, 21]`. The unique reverse foreign key produces an object or null, while
the ordinary reverse foreign key produces an array. A selected customer query
returns only ID and name, omitting the synthetic email field. Selection alone
is tested here; the native catalogs do not introduce PII tags.

| Value | Executed contract |
| --- | --- |
| BIGINT | `9007199254740993` survives writes, reads, and independent native casts without rounding. The application explicitly overrides its generated column type to `number \| string \| bigint`; the default read type is `number` even though unsafe integers return strings. |
| Exact decimal | PostgreSQL/MySQL `DECIMAL(30,10)` retains `12345678901234567890.0123456789`. SQLite deliberately uses `TEXT` for that exact representation. SQLite NUMERIC affinity is not an arbitrary precision decimal store. |
| JSON and null | An object containing nested arrays, booleans, Unicode, quotes, backslashes and JSON null is preserved. One complete SQL NULL JSON cell and nullable notes remain null. |
| Date | `2025-02-03T04:05:06.789Z` reads as a `Date` with exact millisecond UTC value. PostgreSQL uses TIMESTAMPTZ; MySQL uses DATETIME(3) with the adapter's UTC interpretation; SQLite uses DATETIME text. No submillisecond or server-local timezone equivalence is claimed. |
| Generated column | Typed create and update attempts are rejected by the real compiler. A forced runtime update is refused and the native value remains `score * 2`. |

The compiler runs with `strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `NodeNext` resolution and `skipLibCheck: false`.
Seven negative calls compile only with their individual `@ts-expect-error`
markers; after removing those markers, every source line must have its own
compiler diagnostic. The controls cover generated writes, invalid scalar and
column inputs, reverse relation cardinality, and selected-field narrowing.
Runtime controls also require a foreign-key violation to be refused.

Both direct invoice reads and invoices loaded through customer relations must
preserve all scalar values. A separate native connection or SQLite handle checks exact stored rows using
explicit SQL casts and date formatting. It independently calculates each
parent's relation window. The harness deliberately deletes a stored invoice
and then writes an incorrect note inside rollback-protected transactions. A
faulty application prints success and exits zero in both cases. The native
oracle must reject both effects, and the rollback must restore all expected
rows. `--fault dropped-effect` makes the injected failure escape into a failing
report; it cannot be reported as a green native run.

Evidence persists after disposable application files and service data are
removed. `report.json` records commands and exits, runtime and service settings,
archive and installed-payload hashes, dependency versions, source hashes,
passed/failed scopes, controls and cleanup. Each consumer directory retains
generated sources, strict configs, application source/build, expected rows,
query events with parameters, and independent native SQL with observed rows.
The npm lockfile and native service logs are retained too. All sample data is
synthetic. Repeated CLI introspection must produce identical generated bytes.

The verifier exits nonzero if any scope or cleanup fails, while continuing the
other independent scopes where possible. Read `report.json` rather than treating
one successful application exit as proof of the whole contract. This does not
replay migration/seed lifecycle coverage or certify every dialect value.

Run the dependency-free guards on Node 20/22/24/26:

```bash
node --test tooling/native-consumer-contracts/harness.test.mjs
```

With the required native inputs set, failure cleanup is executable too:

```bash
CONTRACT_TARBALL=/absolute/path/to/turbine-orm-0.93.1.tgz \
CONTRACT_SHA256=<explicit-sha256-of-that-archive> \
CONTRACT_CLEANUP_PREFIX=/tmp/native-cleanup-unique \
node --test tooling/native-consumer-contracts/cleanup.test.mjs
```

These checks inject post-start failures, native effect corruption and SIGTERM.
They independently verify exited owned PIDs, refused loopback ports, absent
sockets/datadirs and unchanged archive bytes. Success runs make the same owned
process/port checks before reporting green. Service helpers register shutdown
before readiness checks and use bounded termination escalation. The lightweight guards run in the existing Node20/22/24/26 unit matrix.
Native runs require explicitly provisioned binaries and are not added to CI
by this change.
