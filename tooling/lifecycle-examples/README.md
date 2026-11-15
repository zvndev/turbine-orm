# Packed native lifecycle verification

Run from this repository after building and packing the artifact you want to
verify. `--tarball` is mandatory; the runner never substitutes repository imports
or a symlink. Node 24.10+ and npm are required. Consumer development tools are
installed into each temporary project with exact versions; network access or a
populated npm cache is required. No engine case silently skips prerequisites.

```sh
npm ci
npm run gen:studio
npm run build
npm pack --pack-destination /tmp
node --test tooling/lifecycle-examples/harness.test.mjs
node tooling/lifecycle-examples/verify.mjs \
  --tarball "${TARBALL:?absolute package archive path}" --engine sqlite \
  --exact-node 24.10.0 --report /tmp/sqlite-lifecycles.json
```

Use the exact Node 24.10.0 binary for the last command when selecting
`--exact-node 24.10.0`. Omit that flag to verify another supported runtime and
record its actual version. Use the filename printed by `npm pack` if the package
version changes.

For MySQL, set `MYSQL_BASEDIR` to an unpacked MySQL 8.4 distribution containing
`bin/mysqld`. Set `MYSQL_LIBRARY_PATH` if its shared libraries need a search path.
These files are used read-only. The runner initializes its own datadirs and
starts one loopback service for each mode; it accepts no external database URL.
The disposable service uses native insecure initialization inside a fresh private
temporary directory, with no real credentials. Do not change host permissions.

```sh
node tooling/lifecycle-examples/verify.mjs \
  --tarball "${TARBALL:?absolute package archive path}" --engine mysql \
  --report /tmp/mysql-lifecycles.json
```

The modes are `STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION` and that mode plus
`ANSI_QUOTES,NO_BACKSLASH_ESCAPES`. Both global and observed connection modes are
recorded; mysql2 negotiates `IGNORE_SPACE`. Each mode uses new data, socket and
port allocations. Administrative connections use only the exclusively owned
socket, and generated apps use the verified loopback endpoint. Shutdown targets
only the spawned process. Normal completion, caught failures, SIGINT and SIGTERM close owned
connections, stop the service and remove the fixture tree. SIGKILL or machine
failure cannot run JavaScript cleanup.

The report records the tarball path/hash/size, Node/npm/native SQLite/MySQL
versions, exact installed dependencies and lockfile hashes, verifier and public example file
hashes, every command/exit/output, observed row/schema/journal effects, expected
errors and cleanup. Database URLs are withheld. `passed: true` requires all four
SQLite consumer combinations or all eight MySQL combinations (fresh/existing ×
ESM/CommonJS × two modes). It is scoped evidence, not a claim about other server
versions or SQL Server.

Negative controls require absent artifact/config/driver/native prerequisites to
fail. Each live combination deletes an app row inside a rolled-back transaction
and proves the row-effect assertion fails even after an app process exited 0.
SQLite additionally proves seed and migration rollback, native SQL refusal,
dependency-safe rebuild refusal and refusal of MySQL recovery acknowledgment.
MySQL proves restricted seed DML rolls back on failure and repeated seeds converge;
it also proves partial DDL survives, normal retry refuses, missing acknowledgment
and wrong checksum refuse without changing the journal, and recovery only follows
explicit manual reconciliation. JSON schema/capabilities/compile tools are read
without changing app rows; write compilation is refused.

The optional native shutdown control requires the same MySQL prerequisites and
an artifact. It starts a real owned service, interrupts verification with SIGTERM,
then asserts its process is gone and fixtures were removed. Missing prerequisites
fail this test too:

```sh
LIFECYCLE_TARBALL="${TARBALL:?absolute package archive path}" \
  node --test tooling/lifecycle-examples/cleanup.test.mjs
```

Set `LIFECYCLE_CLEANUP_REPORT` to retain the interrupted run's JSON report at a
chosen path. A normal run reports `passed: true`; this intentional interruption
reports failure and exits 143, which the control requires.

The existing unit and SQLite native gates run the verifier failure controls
and packed SQLite consumers without adding a job or threshold. The SQLite gate downloads
the existing pack job's tested tarball. The older pack-smoke
Node 22 matrix cannot run Node 24.10 writer checks. MySQL verification remains
an explicit owned-service command until the existing gate supplies a MySQL 8.4
binary distribution; its container endpoint is deliberately not borrowed.
