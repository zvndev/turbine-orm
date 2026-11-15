# Native HTTP runner interruption acceptance

`native-run.mjs` owns its unique PostgreSQL root and the children it launches.
`gate-run.mjs` owns its child tree, while its configured PostgreSQL service stays
caller-owned. Neither runner signals a process group. Recorded Linux PID start
times and live ancestry constrain every asynchronous child termination and
escalation. A child that ignores SIGTERM receives SIGKILL after bounded grace;
parents remain available to reap their children. The shared PostgreSQL helper
is reused without changes. Its synchronous initdb callback has a 30-second
SIGKILL timeout; queued runner signals are handled when that callback returns.

SIGINT/SIGTERM seal launches and retain conventional exit status 130/143 for
the first signal. Failed JSON is written atomically during interruption and at
finalization. The first failure survives later cleanup errors. Child cleanup,
helper shutdown, verified postmaster fallback, process/port audits and root
removal each run even if an earlier cleanup step fails. A hung helper callback
has a deadline; the runner closes its owned admin connection and requests
PostgreSQL fast shutdown only from the recorded postmaster with the exact
binary, datadir and start time. Service roots are removed only after process
and port audits allow removal. The installed archive remains unchanged.

The native positive contract remains 14 cases per source/ESM/CJS scope. The
intercepted protocol suite, default root import/read/transaction/LISTEN checks,
required omissions and isolated native-effect negative controls retain their
separate scopes. These are local HTTP-to-PG bridge checks. Hosted Neon, official
proxies and broader provider certification are outside this fixture.

## Run required focused checks

Use a fresh evidence root, actual archive and explicit pin. No prerequisite is
self-skipped. Repeat both commands with each required exact Node binary:

```sh
PG_PREFIX=/absolute/native-pg-prefix \
NEON_HTTP_ARCHIVE=/absolute/actual-package.tgz \
NEON_HTTP_ARCHIVE_SHA256=<exact-sha256> \
NEON_HTTP_INTERRUPTION_EVIDENCE=/tmp/unique-http-interruption-root \
node --test --test-concurrency=1 \
  src/test/fixtures/neon-http/native-interruption.test.mjs \
  src/test/fixtures/neon-http/gate-interruption.test.mjs
```

Create the evidence root before running. Scenarios refuse to reuse their own
subdirectories. Tests run sequentially, including the two files. The supervisor
clears Node's inherited internal test context before launching independent
native test processes; otherwise Node refuses recursive `--test` execution.

The 22 disposable-runner checks cover both SIGINT and SIGTERM at six barriers:
postmaster launch before readiness, runner initialization after PG readiness,
a live HTTP request with its native PG connection, cleanup, report finalization
and after a successful report has been written. Ten further signal/failure
controls are included in that total: absent PG prefix/binary, wrong archive
pin, thrown/hung cleanup, signal after cleanup failure, removal failure and
SIGTERM-ignoring parent/child controls under interruption and timeout, including
a parent that respects SIGTERM while its child ignores it. Four
additional gate checks prove an interrupted gate leaves its caller's native PG
service queryable; that service is then stopped by its own test owner. Mixed repeated signals
during gate finalization retain the first signal status and primary failure.

`supervise-native-interruption.py` checks SIGINT/SIGTERM cleanup with
independent `/proc` and socket audits. It records live identities before sending
a signal, waits for explicit ready files and audits all recorded PIDs, groups,
PG paths/sockets and HTTP/PG ports after runner exit. It has no pg_ctl rescue,
service-root deletion or process-group kill path. The live caller-owned witness
socket must remain open. Faults are applied only in copied source fixtures,
with before/after hashes; actual archives and repository source stay intact.
Failed runs retain reports and logs. The supervisor can ask only the runner
itself to handle SIGTERM if a harness assertion fails.

The same supervisor supports a `positive` scenario with the exact pinned
archive. This preserves all original positive scopes while recording live
process identities and independently auditing runner-owned cleanup.

Test barriers are opt-in fixture instrumentation via
`NEON_HTTP_TEST_BARRIER` and `NEON_HTTP_TEST_CONTROL`. They have a 30-second
deadline. They are absent from the production adapter and packaged dist graph.
Source-candidate acceptance does not certify a later integrated head or build.
