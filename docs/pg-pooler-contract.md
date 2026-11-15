# Optional PostgreSQL APIs through PgBouncer

Choose the endpoint by its actual deployment mode. A successful query, a logical
`Pool.connect()` checkout, a WebSocket, or a caller-supplied string does not detect
backend session affinity. This document describes local contract evidence for the
optional WebSocket binding and notification hub. It does not promote support or
certify a hosted provider.

| API / operation | Actual session pooling | Actual transaction pooling |
| --- | --- | --- |
| Notification hub | `endpoint: 'session-pool'`; one dedicated checkout while subscribers exist | Unsupported. A transaction/statement endpoint value is refused before checkout. |
| WebSocket callback transaction | Pins a backend inside the transaction | `sessionMode: 'transaction'`; pins a backend from BEGIN through COMMIT/ROLLBACK, with no affinity between transactions |
| WebSocket `$listen` | Requires `sessionMode: 'persistent'`, `lifetime: 'persistent'`, and a Pool with a dedicated slot | Refused when declared as transaction mode, before checkout |
| WebSocket invocation helper | Creates/uses/closes within its callback; LISTEN refused | Same invocation boundary; ordinary queries and transactions are allowed |
| `$notify` / SQL NOTIFY | Supported; sender commit determines delivery | Supported; a separate direct/session listener receives it after sender commit |
| Session advisory locks and session state | Require the same actual backend for the whole operation | Unsupported; a logical checkout does not establish ownership across transactions |
| Transaction advisory locks | End at transaction completion | End at transaction completion; distinct from session advisory locks |
| Optional WebSocket named prepared statements | Disabled by default; explicit enablement requires a compatible endpoint | Explicit enablement is refused by the optional binding, including on a pooler configured to track statements |

These boundaries follow the [PgBouncer feature matrix](https://www.pgbouncer.org/features.html)
and [PostgreSQL NOTIFY semantics](https://www.postgresql.org/docs/18/sql-notify.html).
PgBouncer can support protocol-level prepared plans with nonzero
`max_prepared_statements`; that does not make LISTEN or session advisory locks
compatible with transaction pooling. The existing native client's prepared-plan
policy and `client-v090` / `fix-txerr` pooler tests are unchanged.

## What the declarations actually check

The notification hub accepts only `'direct'` and `'session-pool'`. They are caller
assertions about the deployment, not probes of the server's configuration. It
validates the accepted value and the returned client's event interface. Its
`subscribe()` readiness means LISTEN was acknowledged by the borrowed connection.
It cannot establish that a transaction pooler will keep the same backend after
that statement.

The WebSocket binding similarly validates the explicit `sessionMode` and
`lifetime`, refuses declared transaction listeners and invocation listeners, and
refuses transaction-mode named statements. It does not discover pooler mode.
Declaring a transaction endpoint as persistent can pass construction. A checked-out
WebSocket logical client can then move to another physical backend after COMMIT.

The real diagnostic test deliberately misdeclares a transaction pooler as a session
pool for the hub. LISTEN resolves and `stats.connected` becomes true. Another
logical borrower acquires the backend with that LISTEN registration, while a
query through the hub's still-held client uses a different backend. Even successful
hub `close()` cannot remove the original registration when UNLISTEN reaches the
other backend. This is an example of unsupported use, not transaction-mode LISTEN
support. No new detection heuristic or bypass flag is provided.

Existing generic pg-compatible clients and raw SQL remain escape hatches. These
optional guards do not parse arbitrary SQL, retrofit a refusal into existing
`$listen`, or prove migration-lock safety. Use a verified direct/session endpoint
for session-based notification or locking workflows. A hub must receive an
exclusive, clean, out-of-transaction checkout; await unsubscribe/close before
reborrowing it. Session pooling preserves affinity while the client is connected,
not after the client disconnects.

## Native evidence and limits

`src/test/optional-pg-pooler.test.ts` and the identical installed ESM/CJS consumer
contract use PostgreSQL 18.6, real PgBouncer 1.26.1, actual
`@neondatabase/serverless` 1.2.0 and `ws` 8.18.3. Session capacity is one backend;
transaction capacity is two, with no reserve. Admin `SHOW DATABASES` / `SHOW CONFIG`
validate the fixture's mode/capacity. These test-only admin queries are not adapter
mode detection. Explicitly occupied backends force each reassignment; no random
query burst or timing threshold is used as proof.

The checks cover session pinning and queueing, session advisory lock ownership
across COMMIT, hub LISTEN acknowledgement/readiness, fanout, per-channel/final
UNLISTEN and a clean same-backend reborrow. They distinguish transaction pinning
and transaction advisory-lock release, committed/rolled-back NOTIFY, declared
refusals, and misdeclaration limits. The actual local WebSocket byte relay routes
to PgBouncer, which routes to PostgreSQL; it does not simulate query results.
It checks callback commit/rollback, backend changes between transactions, NOTIFY,
success/failure invocation scopes, and an explicitly unsubscribed session listener.

Passing these bounded cases alone does not certify abort,
active-listener disconnect, connection-loss/reconnect, interrupted COMMIT outcome,
provider routing, hosted TLS/authentication or edge execution. No SQL Server,
remote-provider, durable delivery/replay or performance claim follows from this
suite. Listeners still need resynchronization after a gap.

## Run the required local workflow

Ordinary unit runs without the four endpoints register one explicit prerequisite
skip. `TURBINE_REQUIRE_ENGINE=pgbouncer` turns a missing endpoint into a failure.
The runner independently requires the actual binaries, exact Node versions and an
actual archive; it has no mock/service fallback. Wrong-mode controls fail admission
before any behavior check.

Each positive source or installed run must complete all ten named substantive
contracts exactly once. Structured Node test events must also report zero failed,
skipped, todo or cancelled tests; exit code zero alone is insufficient. A surviving
command group fails admission and remains owned until bounded TERM/KILL cleanup
has run and group disappearance has been checked.

```sh
# Only if PgBouncer is unavailable. This creates a NEW directory, without sudo.
bash src/test/fixtures/pg-pooler/acquire.sh /tmp/my-pooler-build
npm run build
mkdir -p /tmp/my-pooler-package
npm pack --pack-destination /tmp/my-pooler-package

PG_PREFIX=/path/to/postgresql18.6/usr \
PG_POOLER_BINARY=/tmp/my-pooler-build/pgbouncer-1.26.1/pgbouncer \
PG_POOLER_ARCHIVE=/tmp/my-pooler-package/turbine-orm-0.93.1.tgz \
PG_POOLER_SHA256="$(sha256sum /tmp/my-pooler-package/turbine-orm-0.93.1.tgz | cut -d' ' -f1)" \
PG_POOLER_NODE22=/path/to/node22.16.0/bin/node \
PG_POOLER_NODE24=/path/to/node24.10.0/bin/node \
PG_POOLER_NPM_CLI=/path/to/npm/bin/npm-cli.js \
PG_POOLER_EVIDENCE=/tmp/my-pooler-evidence \
/path/to/node22.16.0/bin/node src/test/fixtures/pg-pooler/native-run.mjs
```

The PostgreSQL prefix needs `bin`, `share/postgresql`, and `lib/postgresql`.
`acquire-postgres.sh NEW_DIRECTORY` can build a pinned PostgreSQL 18.6 prefix for
CI where none exists. Both acquisition scripts verify pinned official source
SHA-256 values. The native report records binary versions/hashes, exact archive
hash, installed payload hashes matching the current build, commands and exit codes,
owned PIDs/groups/ports/datadir, routing, and post-cleanup audits. Installed consumers
keep mandatory `pg` from the archive's normal dependencies. No staged exports,
archive edits, dependency changes or size/coverage threshold changes are needed.

The runner owns its disposable database cluster, pooler configuration, loopback
ports and relay. It closes clients, stops only recorded services and audits PID,
owned group, port, socket and datadir absence on success, failure and caught signals.
Logs and the archive remain evidence; service data and consumer installation are
removed. The existing PgBouncer CI job runs these exact-runtime checks against
the shared package artifact with its expected SHA256, and retains the reports.
