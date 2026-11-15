# Neon WebSocket binding

The optional `turbine-orm/neon-ws` package entry point was added in 0.94.0 and is Experimental in the [engine support matrix](engine-support.md). It does not change any support tier or certify a hosted provider deployment.

`@neondatabase/serverless` **Pool and Client use WebSockets**. Its `neon()` function uses HTTP and has a different transaction/session contract. `turbineHttp` remains the existing generic pg-compatible binding; its name does not turn a Neon Pool into an HTTP transport. See the [Neon driver documentation](https://neon.com/docs/serverless/serverless-driver) and [driver source and usage guide](https://github.com/neondatabase/serverless).

```ts
import { turbineNeonWs } from 'turbine-orm/neon-ws';
import type { TurbineClient } from './generated/turbine/index.js';
import { SCHEMA } from './generated/turbine/metadata.js';

const db = await turbineNeonWs<TurbineClient>(
  { connection: { connectionString: process.env.DATABASE_URL! } },
  SCHEMA,
  { sessionMode: 'persistent', lifetime: 'persistent' },
);
try {
  const rows = await db.users.findMany({ orderBy: { id: 'asc' }, limit: 10 });
  const first = rows[0];
  if (first) {
    await db.$transaction(async (tx) => {
      await tx.table('users').update({ where: { id: first.id }, data: { active: true } });
    });
  }
} finally {
  await db.disconnect();
}
```

Install the optional `@neondatabase/serverless` peer separately. This binding targets its dual ESM/CJS 1.2.x interface. The generated client type supplies declarative table accessor typings; the runtime is the existing Turbine client. All SQL generation, parameterization, transactions and row transforms continue through that client. No native PostgreSQL construction or global parser registration is replaced.

## Endpoint and lifetime contracts

Both declarations are required. `sessionMode: 'persistent'` asserts that the actual backend remains assigned to each checked-out connection for its lifetime, as with a direct endpoint or session pooler. A logical Client returned by a transaction pooler does not prove this property. Declare `sessionMode: 'transaction'` for a transaction pooler. Interactive transactions pin a logical connection and rely on the endpoint maintaining its backend throughout that transaction; they do not establish a session between transactions.

`lifetime: 'persistent'` is for a process/runtime that can retain connections. `lifetime: 'invocation'` means every connection is used and closed within one invocation. Warm edge isolates do not authorize cross-invocation connection reuse. A persistent declaration does not override platform restrictions.

| Operation | Contract |
| --- | --- |
| Reads, writes, raw statements | Actual Neon WebSocket connection, acquired through `Pool.connect()`. Never calls the optional Pool fetch path. |
| Callback and deferred-array transactions | Existing pinned transaction implementation; SQL error/callback failure rolls back. Endpoint must preserve the backend inside a transaction. |
| Prepared statements | Default disabled. Explicit enablement refused for transaction mode. |
| `$listen` and reconnect | Requires persistent session, persistent lifetime and a Pool with available listener capacity. Each subscription uses its own connection. |
| `$notify` | Ordinary parameterized statement; delivery follows the sending transaction's commit. |
| Supplied Client | Already connected, queryable and exclusively assigned to this binding while used. One lease at a time; overlapping operations fail. LISTEN is refused because this binding cannot replace that caller's Client. |
| Cursor streaming | Existing transaction cursor path; WebSocket-specific native CancelRequest delivery is not exposed. Stream signals that require native cancellation are refused by the existing capability checks. |
| Migration locks / arbitrary session SQL | No migration API or automatic session guarantee is added. Raw SQL remains an escape hatch; callers must respect their declared endpoint mode. |

Listener reconnection reissues LISTEN after connection loss; it cannot replay notifications missed during the gap. Use `onReconnect` to reread authoritative data. Invocation-local listeners and transaction-pooler listeners fail before checking out a connection. The caller must choose sufficient Pool capacity for a dedicated listener plus concurrent queries. See [Neon configuration](https://github.com/neondatabase/serverless/blob/main/CONFIG.md) for transport options and [PgBouncer's feature matrix](https://www.pgbouncer.org/features.html) for actual pooler session restrictions.

## Configuration and ownership

The source is exactly one of `{ connection, driver? }`, `{ pool }`, or `{ client }`. The factory snapshots the selected source, options and owned configuration before its first asynchronous step. Own fields and prototype accessors are read once into that snapshot, including `connectionString` and invocation-helper options. Later mutations to those configuration objects do not change admission or construction; supplied resources and the signal retain their identities.

An owned source constructs an actual Neon Pool. Its private Client subclass assigns the selected `driver` settings to **each Client instance before connect**. The binding never mutates global `neonConfig`, prototypes, defaults, or the settings of a supplied Pool/Client. An explicit WebSocket constructor can be passed as `driver.webSocketConstructor` when the runtime has none. Per-client `wsProxy`, TLS and pipelining settings belong under `driver`; HTTP fetch/global settings are not accepted there. PostgreSQL authentication and WebSocket/TLS security must match the endpoint. The local test relay disables WebSocket TLS only on loopback.

For a supplied actual Neon Pool, configure its Clients before use. For a supplied actual Neon Client, call and await `client.connect()` first. A Pool/Client from the same selected driver module format is required; arbitrary pg-compatible objects and separately loaded driver copies are not accepted as Neon objects. Use `turbineHttp` for the existing generic compatibility contract.

`db.disconnect()` and `db.end()` stop new work and release subscriptions. This binding immediately destroys its outstanding Pool checkouts and owned connecting Clients, including stalled startup with `connectionTimeoutMillis: 0`; it does not drain active application callbacks. No timeout escalation is needed because this is an immediate shutdown. The options overload reports the number of forced leases and owned connecting Clients. Owned Pools are ended once; supplied Pools remain open and other callers' checkouts are untouched. Disconnect is idempotent. Disconnecting a busy supplied Client fails: await its operation first so transaction cleanup can complete. The binding never calls `end()` on a supplied Client. The caller retains responsibility for the supplied resources' lifecycle and independent error handling. Owned Pool idle failures use the inherited `$on('poolError')` contract (or the default error log when no handler is registered); checked-out failures emit `$on('connectionLost')` once per failed connection. Disconnect removes the binding's observers.

A binding-level `signal` stops acquisition and destroys this binding's pooled connections. It rejects pending operations promptly with the identical `signal.reason` value, including structured reasons, and releases any late checkout. It is refused for a supplied Client because that would require destroying the caller's connection. Socket closure does not prove PostgreSQL CancelRequest delivery, immediate backend termination, rollback completion or the outcome of an in-flight commit. Treat interrupted writes as having an unknown outcome and reconcile before retrying. A caller-owned Pool may retain a pending acquisition until the pool serves it; this binding destroys the eventual checkout without running SQL.

A transaction deadline on a pooled WS connection can abandon that connection without delivering a PostgreSQL CancelRequest. Its timeout reports an unknown outcome until rollback is confirmed. An interrupted COMMIT retains an unknown outcome even if closing the socket succeeds: a later ROLLBACK cannot establish whether COMMIT already took effect. Escaped transaction handles and transaction logs retain this distinction. This applies to both typed `$transaction` query configs (including their per-query parsers) and legacy `transaction()` string queries. Ordinary SQL/callback failures with an acknowledged ROLLBACK report confirmed rollback.

A supplied Client cannot safely support transaction deadlines, so a nonzero `$transaction` timeout is refused before BEGIN. On callback failure or unawaited work, cleanup waits for the driver's queued ROLLBACK before returning the surviving Client to its caller. Await that transaction promise before reusing the Client; a blocked server statement can also block its cleanup.

## Edge invocations

Use the helper to ensure cleanup in `finally`, including callback failure:

```ts
import { withNeonWs } from 'turbine-orm/neon-ws';
import { SCHEMA } from './generated/turbine/metadata.js';

export async function handle(env: { DATABASE_URL: string }) {
  return withNeonWs(
    { connection: { connectionString: env.DATABASE_URL } },
    SCHEMA,
    { sessionMode: 'transaction' }, // choose the actual endpoint mode
    async (db) => {
      const users = await db.table('users').findMany({ limit: 10 });
      return Response.json(users);
    },
  );
}
```

The helper requires an owned connection configuration and sets invocation lifetime. Await all database work within the callback. The full existing client still requires the runtime's `node:async_hooks`/AsyncLocalStorage compatibility and the existing edge `#pg` condition. The new driver import is literal so bundlers can include its WebSocket implementation. The existing client on an edge build delegates supplied-driver type parsing to that driver; it does not install native pg's Node-only parser table. No cross-runtime temporal parser equivalence is claimed.

## Evidence and reproducible checks

The focused native suites use actual `@neondatabase/serverless` 1.2.0, native PostgreSQL 18.6, and a loopback WebSocket-to-TCP byte relay. The relay has no query/result simulation. This proves local transport behavior, including exact rows/effects/order, typed accessors, pinned commit/rollback, notifications/reconnect, abort/disconnect and ownership. It does not prove authentication, TLS, transaction-pooler behavior, Neon-hosted infrastructure or provider production certification. The transaction-mode tests prove local refusal/pinned execution contracts; they do not run a transaction pooler.

The edge check bundles the actual driver with `edge-light`/`worker`/`browser` conditions and executes it in `@edge-runtime/vm` 5.0.0 with its WebSocket implementation, plus a bridge for the runtime-required AsyncLocalStorage primitive. It exercises native queries/transactions and success/failure invocation cleanup through the loopback relay. This is a local VM run, not a Cloudflare/Vercel hosted run.

```sh
npm run build
npm run typecheck
# Install the optional development prerequisites first.
TURBINE_REQUIRE_NEON_WS=1 TURBINE_NEON_WS_PG_ROOT=/path/to/postgresql18.6/usr \
  npx tsx --test --test-concurrency=1 src/test/neon-ws*.test.ts
```

The PostgreSQL root needs `bin/`, `share/postgresql/` and `lib/postgresql/`. The fixture creates and removes a private disposable cluster, audits its PID and ports, and preserves only logs/audit output. The required flag makes missing prerequisites fail; ordinary runs without the native root register explicit prerequisite skips. The earlier installed-consumer fixture staged a proposed export; that historical evidence is distinct from subsequent actual package archives. The dedicated `neon-ws-lifecycle` regressions exercise pre-await mutation, held startup, held COMMIT acknowledgement, caller-owned cleanup and inherited error events against real PostgreSQL bytes. Source runs with the shared recovery patch staged in an isolated copy and actual packed ESM/CJS runs are recorded separately in the local corrective handoff. No export overlay is used for actual-archive claims. Existing public entries do not import this optional module.
