# Notification-driven live queries

An executable PostgreSQL application that shares one session listener across
request-owned live queries. `application.ts` composes the existing optional
`createNotificationHub` and `liveQuery` entries. `demo.ts` creates a uniquely
named table, runs two scoped subscriptions, commits a notified write, checks
exact snapshots, cancels one sibling, and removes its table on exit.

Use a disposable local database. In a repository checkout with its integrated
package already built, run:

```sh
DATABASE_URL=postgresql://... NOTIFICATION_ENDPOINT=direct \
  node --import tsx examples/notification-live-query/demo.ts
```

From a consumer project with the integrated
`turbine-orm` package, `pg`, `typescript`, `@types/node`, `@types/pg` and `tsx`
installed, copy these two TypeScript files and run:

```sh
DATABASE_URL=postgresql://... NOTIFICATION_ENDPOINT=direct \
  node --import tsx demo.ts
```

The endpoint assertion is required. Use `session-pool` only when the real pooler
preserves a backend session for the entire listener checkout. Transaction
pooling and stateless HTTP are refused. The assertion cannot detect an endpoint
that was mislabeled by the caller. This example's native evidence is local
PostgreSQL 18.6 over TCP, with node-postgres.

## Request integration

Create one application per process with a caller-owned pool. Authenticate the
request first, capture the authorized tenant in its ordinary typed query, and
pass the request's abort signal to `watch`:

```ts
const snapshots = application.watch(
  () => scopedDb.orders.findMany({
    select: { id: true, title: true }, orderBy: { id: 'asc' }, limit: 100,
  }),
  request.signal,
);
try {
  for await (const rows of snapshots) {
    await sendSnapshot(rows); // A slow sender gets the newest undelivered state.
  }
} finally {
  await snapshots.dispose();
}
```

The application owns explicit handles, caps hub subscriptions at 64, and admits
one channel. It also caps query handles at 64, retaining a cancelled handle's
admission slot until its in-flight read settles. `hub.subscribe` must acknowledge LISTEN before the first read.
Notifications and `onResync` invalidate the snapshot; reconnect and overflow
recover by rereading current state. Recoverable hub errors are diagnostics,
never blindly forwarded to terminal `LiveQuery.onError`. Query and setup
failures remain terminal for the affected handle. Notifications carry no
authorization; global filters, projections, middleware and PII checks remain
inside the ordinary read callback. Re-enter request-local policy context inside
that callback if your policy uses async-local storage.

Each query retains one running read, one dirty bit and at most one newest clean
snapshot. There is no payload or snapshot backlog. This bounds retained state,
not read frequency or result bytes. Bound the query result, configure finite
connection/query/statement timeouts, and avoid a write in the read callback.

Cancellation stops delivery and unsubscribes only that request, including a
request aborted while native listener checkout is pending. It does not
cancel SQL which ignores its signal. For application shutdown, stop request
admission and call `await application.close()`. It aborts requests, disposes
handles, drains their reads, then closes the external-ownership hub. Only then
call `await db.disconnect()` and `await pool.end()`. Keep sends cancellable and
bounded too; application shutdown cannot force an arbitrary send promise to
settle. SIGINT/SIGTERM in the finite demo abort its request and run this cleanup.

Notify in the same transaction as the write, or arrange an appropriate database
trigger. Rolled-back writes do not notify. A listener outage loses notifications;
resync recovers current state. There is no durable replay, CDC, outbox, browser
gateway, hosted-provider certification or WebSocket transport claim.

## Native and installed proof

The repository fixture below runs this actual application with source primitives
and then strictly compiles and executes unchanged copies against an immutable
installed archive in ESM and CommonJS. Its source config maps only the optional
hub/live-query imports to `src/`; the installed runs use the real package export
conditions, with all installed package bytes verified before and after.

```sh
PG_PREFIX=/absolute/postgresql-18.6/usr \
  /absolute/node-v22.16.0/bin/node \
  src/test/fixtures/live-query-hub-pg/native-run.mjs \
  /absolute/turbine-orm-0.93.1.tgz <archive-sha256> /absolute/evidence-node22
# Repeat with exact Node 24.10.0 and another evidence directory.
```

Put the chosen Node binary first on `PATH` so npm runs under that same runtime.
A short writable `TMPDIR` can be supplied for native socket paths. The runner
reuses the existing native service and bounded child lifecycle infrastructure,
creates a fresh database and service, and records PID/starttime/group identity,
cleanup and command output in `report.json`. No external database is borrowed.

To use an existing disposable local PostgreSQL instance for just the source
suite:

```sh
TSX_TSCONFIG_PATH=src/test/fixtures/live-query-hub-pg/source-tsconfig.json \
  TURBINE_REQUIRE_ENGINE=postgres DATABASE_URL=postgresql://... \
  node --import tsx --test src/test/live-query-hub-pg.test.ts
```

The six tests cover 32 subscriptions sharing one listener, commit/rollback,
subscribe-before-read races, actual backend termination and missed-state resync,
256-event overload and slow readers, scope and PII policy, sibling survival,
cancellation and disposal order. Missing `DATABASE_URL` fails when the required
PostgreSQL engine token is set. Ordinary unit runs without it can skip native
work. CI integration belongs in an existing PostgreSQL job, with a local
PostgreSQL 18.6 prerequisite for the owned-service runner.
