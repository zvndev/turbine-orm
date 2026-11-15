# Neon HTTP binding

This is an optional API, added in 0.94.0, for the function returned by
`@neondatabase/serverless` **`neon()`**, available at `turbine-orm/neon-http`.
It does not change the published support tiers.

Neon's `neon()` uses HTTP. Its `Pool` and `Client` use WebSockets and have a
different session contract. See the [official driver documentation](https://neon.com/docs/serverless/serverless-driver)
and [driver configuration reference](https://github.com/neondatabase/serverless/blob/main/CONFIG.md).
The binding accepts the real caller-created query function directly. It never
changes `neonConfig`, installs global parsers, or closes the caller's function.

```ts
import { neon } from '@neondatabase/serverless';
import { turbineNeonHttp } from 'turbine-orm/neon-http';
import { schemaMetadata } from './generated/metadata.js';

const sql = neon(connectionString);
const invocation = new AbortController();
const db = turbineNeonHttp(sql, schemaMetadata, {
  signal: invocation.signal,
  globalFilters: { accounts: { tenantId: currentTenantId } },
});

const accounts = await db.table<Account>('accounts').findMany({
  where: { displayName: { startsWith: 'A' } },
  with: { posts: { orderBy: { id: 'desc' } } },
  limit: 20,
});

await db.disconnect();
// sql remains caller-owned and usable.
```

The existing root and `serverless` entries do not import this optional entry.
Install the optional Neon driver separately; no mandatory runtime dependency
is added by this source slice. Neon driver 1.2.0 is the tested prerequisite.
The native runner below tests the actual installed archive without a manifest
or export overlay.

## Ordinary queries

`table<T, Relations, Inputs>(name)` exposes the existing typed table signatures.
Each execution compiles its existing `build*` query and sends **one** parameterized
SQL statement with `sql.query(text, values, { fullResults: true, arrayMode: false })`.
Field aliases, projections, relation aliases, global filters, SQL caching and
nested row decoding use the existing query builder. The default PostgreSQL
positional JSON encoding is retained. `jsonEncoding: 'object'` remains available.

The binding supports single-statement reads and scalar writes, including
`count`, aggregates and bulk writes that fit one statement. Nested writes,
lookup-dependent upserts and bulk writes requiring several statements refuse
before execution. Relations use the single-statement join/JSON strategy;
explicit `flatten` is available where the existing builder supports it.
`batched` and `auto` relation loading refuse because they require several requests.

Native top-level type decoding belongs to Neon. This facade does not impose
Turbine's owned `pg` pool parsers on it: native `int8` and `numeric` strings,
JSON, arrays and binary values retain their native driver readings. Nested JSON
rows still pass through Turbine's schema-aware decoder. `utcTimestamps` governs
that decoder, not Neon's independently configured scalar parser table.

The options are deliberately limited to global filters, default limits,
temporal and JSON decoding, stable relation/primary-key ordering, SQL caching,
diagnostics/logger and an invocation-wide signal. Unknown options refuse.
Middleware, replicas and session/pool configuration are outside this API.

## Noninteractive atomic batches

```ts
const table = db.table<Account>('accounts');
const [changed, visible] = await db.batch([
  table.buildUpdateMany({ where: { id: 7 }, data: { displayName: 'Updated' } }),
  table.buildFindMany({ orderBy: { id: 'asc' }, limit: 20 }),
], { isolationLevel: 'Serializable', signal: requestSignal });
```

`batch` and its `$transaction` array alias validate every query before making
native lazy query handles. They call `sql.transaction(handles, options)` exactly
once and transform results in input order. An empty batch makes no request.
Only sealed deferred queries built by this facade are accepted. Foreign
queries, eager promises and interactive callbacks refuse before native query
construction or callback invocation. Deferred SQL, transform and the parameter
array are sealed; nested parameter objects retain ordinary reference semantics.

`isolationLevel`, `readOnly` and `deferrable` are forwarded to the native batch.
The driver/database decide valid combinations. A query cannot depend on a
previous result to construct a later statement. No array is emulated by
independent HTTP requests. A transform can fail after the native batch commits;
that failure does not roll back committed SQL.

## Transport boundaries

| Operation | Contract |
| --- | --- |
| Ordinary typed query | One stateless native HTTP query |
| Native batch | One noninteractive native transaction request |
| Interactive `transaction(fn)` / `$transaction(fn)` | Refuses before invoking `fn` |
| `connect`, `LISTEN`, notifications, pipelines | Refuse locally |
| Row locks and cursor streams | Refuse locally, including stream fast paths |
| Nested writes and multi-statement upserts | Refuse before sending SQL |

`db.capabilities` exposes these concrete immutable transport facts. PostgreSQL
SQL syntax does not imply a reusable backend session. Use a session-capable
transport for callback transactions, migration session locks or notifications.

`rawUnsafe(text, params?, { signal?, timeoutMs? })` returns native object rows.
It bypasses model/global filters. Only one ordinary statement is accepted.
Transaction control, DDL/administrative statement starts, row-lock clauses and
known session functions refuse. The conservative scanner respects comments,
quoted identifiers, string literals and dollar quotes. It cannot prove the
behavior of arbitrary database functions, triggers or obfuscated SQL. Raw SQL
must itself honor the stateless contract; it is not a SQL sandbox.

## Cancellation, errors and lifecycle

Use an invocation-wide `signal` for ordinary table calls, or pass a signal to
`execute(ownedDeferred, options)`, `batch` or `rawUnsafe`. Pre-aborted work makes
no native query. Active cancellation forwards a signal into Neon's native
`fetchOptions` and rejects with the caller's exact reason. Table `timeout` and
explicit `timeoutMs` abort delivery; zero disables the timeout. Timeout errors
report an **unknown database outcome**. Cancellation and disconnect cannot prove
that a write did not commit. There are no automatic retries.

Native database errors propagate unchanged. The adapter adds no SQL, parameter,
connection-string or driver-error logging. Driver error details remain native;
applications control how they disclose them.

`disconnect` / `$disconnect` seals this facade, aborts its in-flight requests
and waits for facade delivery to settle. Captured table handles and deferred
execution refuse afterward. The caller's Neon function is not changed or closed.
A transport that ignores abort may finish its underlying request later; settling
the facade does not certify server cancellation.

## Evidence and required admission

Three suites have separate scopes: structural adapter fixtures
(`neon-http.test.ts`), real Neon with intercepted protocol responses
(`neon-http-driver.test.ts`), and real network execution
(`neon-http-native.test.ts`). Only the last executes SQL against PostgreSQL.

The native fixture opens an ephemeral loopback HTTP server and redirects the
real driver's fetch calls to it in an isolated test process. It restores fetch
in cleanup and never changes `neonConfig`. This is **test-only local bridge
evidence**, not a Neon-hosted run or official proxy certification. The
[official Neon Local service](https://github.com/neondatabase/neon_local)
routes to Neon cloud databases; this fixture instead uses the explicitly
supplied local PostgreSQL service. No production HTTP server is added.

Each HTTP request opens a PostgreSQL connection with per-client identity text
parsers and array rows. Query text and every serialized bound value go to
PostgreSQL unchanged. Field metadata, OIDs, text values, command and row counts
come from the native results. Native errors retain their PostgreSQL fields.
A batch uses one pinned connection, `BEGIN` with the received isolation,
read-only and deferrable options, ordered native queries and `COMMIT` or
`ROLLBACK`. No successful native response is fabricated.

The same 14 acceptance cases run against source and installed ESM/CJS exports:
independent native effects and bindings; filtered join/positional/object/flatten
rows; bigint, numeric, date, timestamp, JSON, array and binary readings; pinned
batch order and settings; rollback after a middle failure; read-only refusal;
empty/invalid batches; early callback/session/listener/stream/lock/nested-write
refusals; cancellation before and during native execution; timeout after an
observed commit; and caller ownership after disconnect. A held HTTP response
proves that delivery can time out after a real write commits. These checks
make no latency, backend-cancellation or retry guarantee.

```sh
# Separate intercepted protocol fixtures:
TURBINE_REQUIRE_NEON_HTTP_DRIVER=1 node --import tsx --test src/test/neon-http-driver.test.ts

# Required network acceptance using an explicitly configured loopback PG service:
NEON_HTTP_NATIVE_URL=postgresql://local_user@127.0.0.1:5432/local_test \
NEON_HTTP_EVIDENCE=/tmp/http-native-gate \
node src/test/fixtures/neon-http/gate-run.mjs
```

The gate runner requires the configured service and driver, runs every native
case, checks the evidence count and checks that the bridge and owned SQL
objects were removed. Without the native-required flag or configured URL, the
ordinary test battery reports a prerequisite skip. That skip is excluded from
passing native evidence. With `TURBINE_REQUIRE_NEON_HTTP_NATIVE=1`, absent
service or driver is a failure.

For a disposable, **owned PostgreSQL 18.6** instance, use the existing native
service helper through the runner below. `PG_PREFIX` must contain the native
binaries and catalog. `NEON_HTTP_EVIDENCE` must be a fresh output directory for
each run. Use each desired exact Node binary in place of `node`:

```sh
PG_PREFIX=/path/to/native-postgresql-18.6 \
NEON_HTTP_EVIDENCE=/tmp/http-native-node22 \
NEON_HTTP_ARCHIVE=/absolute/path/to/actual-turbine-orm.tgz \
NEON_HTTP_ARCHIVE_SHA256=<sha256-of-that-exact-archive> \
node src/test/fixtures/neon-http/native-run.mjs
```

The runner starts a unique datadir/socket/port, verifies PostgreSQL 18.6,
requires service/driver omission controls to fail, and separates source native
execution from intercepted fixtures. When supplied an archive and its pin, it
installs that actual tarball alongside exact pg 8.15.0 and Neon 1.2.0. It checks
every installed package file against the extracted archive before and after
execution, runs the same native cases through the package's ESM and CJS
exports, imports all published JS entries in both formats, and exercises the
default root's native read, transaction and LISTEN behavior. It never adds an
export or manifest overlay. No absent-pg claim follows: the current Node query
graph still imports pg and the default entry retains its mandatory dependency.

Two isolated copied fixtures intentionally omit a native write or corrupt its
actual database effect. Both must fail the independent native-effect oracle;
these controls are not passing native cases. The archive and installed package
stay unchanged. `native-report.json`, per-process logs and native result
reports retain commands, outcomes, PIDs/groups, query metadata and cleanup.
The runner checks client closure, object removal, postmaster/backend exit,
closed ports, removed socket/postmaster files and removed datadir root. It
never stops an unrelated process. These local results do not certify hosted Neon.


The disposable runner handles SIGINT and SIGTERM, seals new launches, reaps its
owned child tree and awaits bounded PostgreSQL teardown. Its atomic report stays
failed after interruption or any cleanup failure, retains the first error and
uses exit status 130 or 143 for the first termination signal. PID start times
verify service escalation; no process group is signalled. Each fixture command
runs under a detached, Linux-only Python standard-library subreaper. Kernel
adoption retains ownership across parent exit and new descendant sessions;
pidfd signals pin process generations, and waitpid ECHILD proves all children
were reaped. Command deadlines and control-pipe EOF work independently of Node
callbacks and inherited output pipes. Linux subreaper and pidfd support are
required before command launch. Direct SIGKILL of the supervisor, privileged
escape/reparenting outside its tree, and uninterruptible kernel tasks are outside
this fixture boundary; missing proof or incomplete cleanup fails the run. The
configured service used by `gate-run.mjs` remains caller-owned. Interrupted gate runs do not
certify SQL-object cleanup in that caller service.

See the [focused interruption acceptance](../src/test/fixtures/neon-http/INTERRUPTION.md)
for deterministic phase barriers, signal/failure controls and independent audits.
