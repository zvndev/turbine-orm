# Native artifact upgrade and migration cycles

`tooling/lifecycle-upgrades/verify.mjs` runs a held-out application against two
**unreleased artifacts with the same package version**. It provides artifact
upgrade evidence, not registry or semver upgrade certification. The baseline
must precede the `turbine-orm/mysql/seed` export; the candidate must provide it.
Identical archives, incorrect SHA256 pins, unchanged payloads and the wrong
capability transition fail explicitly. Neither archive is repacked or modified.

## Run

Provide trusted built tarballs and their independently obtained SHA256 values.
No repository paths or particular local artifact locations are built into the
runner. Put the exact Node binary's directory first in `PATH`, so npm and its
children use the same runtime.

```sh
export PATH="$(dirname "$NODE24"):$PATH"

"$NODE24" tooling/lifecycle-upgrades/verify.mjs \
  --baseline "$BASELINE_TARBALL" --baseline-sha256 "$BASELINE_SHA256" \
  --candidate "$CANDIDATE_TARBALL" --candidate-sha256 "$CANDIDATE_SHA256" \
  --engine sqlite --exact-node 24.10.0 --report "$SQLITE_REPORT"

# Requires native MySQL 8.4 binaries and any required shared libraries.
export MYSQL_BASEDIR="$MYSQL_DISTRIBUTION"
export MYSQL_LIBRARY_PATH="$MYSQL_LIBRARIES"
"$NODE24" tooling/lifecycle-upgrades/verify.mjs \
  --baseline "$BASELINE_TARBALL" --baseline-sha256 "$BASELINE_SHA256" \
  --candidate "$CANDIDATE_TARBALL" --candidate-sha256 "$CANDIDATE_SHA256" \
  --engine mysql --exact-node 24.10.0 --report "$MYSQL_REPORT"
```

Missing prerequisites are failures. The runner uses npm, tar, exact Node24.10.0,
TypeScript6.0.3, @types/node22.20.4 and tsx4.23.15. MySQL consumers additionally
install mysql2 3.24.5. Consumer package installation uses `--ignore-scripts` and
records the resolved versions and lock hashes. It requires access to these npm
dependencies or a populated local npm cache. No checkout build or pack occurs.

## Matrix and assertions

| Engine | Native runtime | Consumers | SQL modes |
| --- | --- | --- | --- |
| SQLite | Exact Node24.10.0 with native authorization API; observed SQLite version recorded | Fresh/existing × ESM/CommonJS: four | Native SQLite |
| MySQL | Exact Node24.10.0 and owned MySQL8.4; exact server version recorded | Fresh/existing × ESM/CommonJS × two modes: eight | `STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION`; same plus `ANSI_QUOTES,NO_BACKSLASH_ESCAPES` |
| SQL Server | Unavailable | None | No native claim |

These are the runner's required combinations, not a claim about another platform,
runtime, server patch or unexecuted run. Fresh apps apply the initial migration
created by actual baseline CLI init; existing apps retain an independently
created table and sentinel row, and init creates no starter migration. Both apply
another baseline migration through the installed CLI.

Each ordinary app keeps the same directory, database, dependency tree and lockfile
through baseline and candidate installations. Every shipped file is hashed and
compared with the extracted tarball, including the package manifest. Unexpected
installed files also fail; npm's nested dependency directory is excluded. A
version string or successful npm exit cannot satisfy this check.

The baseline CLI generates a strict client. The workload compiles it using
`strict:true`, `skipLibCheck:false` and NodeNext, then executes typed upsert,
update and read operations. After installing the candidate into that same app,
it checks exact rows, original schema, generated source and migration SQL bytes,
and every stored history field, including IDs, application times and checksums.
It compiles and runs the unchanged baseline source against candidate bytes
**before regeneration**, verifies the new stored effects, and preserves the
baseline source text and hashes in its report. Each app owns and disconnects its
client; the independent observer remains usable. MySQL additionally verifies
that only the observer's database connection remains after app/CLI exit.

Invalid field selection and string integer keys must produce specific TypeScript
diagnostics. MySQL also requires rejection of an unawaited asynchronous factory.
The normal expected-error controls must compile successfully; an invalid source
copy with those comments removed must fail. Candidate seed callbacks demonstrate
rollback after DML, two convergent reruns and exact stored rows. MySQL exercises
the newly added restricted typed seed export; SQLite repeats its existing seed
contract. Candidate generation is compiled and executed separately afterward.

A new SQL migration creates a table and inserts a row. Pending status, deploy,
repeated deploy, down, pending status and up all check real catalog/data effects
and stored history. Original history rows and SQL files remain byte-for-byte
unchanged. A reverted fixture-only SQL edit proves status and deploy reject
checksum drift. The rolled-back cycle's new journal ID/time may legitimately
change when reapplied; both snapshots are recorded, while its checksum and all
original history fields remain exact. MySQL catalog comparison excludes only the
history table's changing AUTO_INCREMENT allocation counter; full history rows
are compared independently.

## Applied-outcome recovery

Only exclusively owned disposable MySQL data is used. A migration creates a
table, inserts a row, then fails because a later target table is intentionally
absent. The test requires the earlier native DDL and row to survive, two confirmed
statements in the dirty journal and unchanged applied history. Status reports
dirty state; deploy/up/down must refuse retries. Missing or malformed
acknowledgement, wrong identity/checksum, invalid outcome and a changed migration
file must refuse without clearing evidence or changing the stored partial data.

The test explicitly creates the missing prerequisite, performs the intended
remaining insert and creates the remaining index. It checks the completed schema,
index and both tables before acknowledging the **applied** outcome. Recovery must
clear the dirty journal and append exactly the original migration name/checksum,
while preserving every earlier history row. Exact schema and data comparisons
prove it does not replay SQL. Deploy afterward is a no-op, and recovery against
an already clean journal refuses. This fixture is an explicit manual completion
example; it offers no automatic production repair or rollback guarantee.

## Controls, records and cleanup

```sh
# Lightweight guards: supported on the existing Node20/22/24/26 unit matrix.
node --test tooling/lifecycle-upgrades/harness.test.mjs

# Required native signal suite. Uses the same artifact paths/pins as above.
export UPGRADE_BASELINE="$BASELINE_TARBALL" UPGRADE_BASELINE_SHA256="$BASELINE_SHA256"
export UPGRADE_CANDIDATE="$CANDIDATE_TARBALL" UPGRADE_CANDIDATE_SHA256="$CANDIDATE_SHA256"
# Optional prefix retains the three reports outside their disposable test roots.
export UPGRADE_CLEANUP_REPORT_PREFIX="$CLEANUP_REPORT_PREFIX"
"$NODE24" --test tooling/lifecycle-upgrades/cleanup.test.mjs
```

The lightweight suite rejects missing/identical/wrong artifacts, incorrect
installed bytes, missing native prerequisites, lost rows/history, skipped
recovery and failed commands. Native cleanup tests interrupt a ready service
with SIGINT/SIGTERM and interrupt the transition between modes with SIGTERM.
They independently require that the process is gone and the fixture root absent.

JSON reports retain archive/payload/source hashes, runtime/dependency/server
versions, modes, commands and expected/actual exits, compiler diagnostics,
original generated and SQL sources, stored rows/history/catalog effects, owned
service identities and cleanup. Database URLs are withheld. Timing fields are
command records, with no performance threshold or speed claim.

The existing reviewed lifecycle command and native service helpers are reused
read-only. Each MySQL mode gets a fresh owned datadir, socket and allocated
loopback port; version/datadir/port/modes are checked before use. No external
endpoint is accepted. Normal completion, caught failures and SIGINT/SIGTERM
stop registered services and remove fixtures. If safe service shutdown fails,
the runner retains its datadir and reports failure. SIGKILL or machine failure
cannot execute JavaScript cleanup. No PostgreSQL or native SQL Server workload,
full source regression, release publication or CI run is implied by these checks.
