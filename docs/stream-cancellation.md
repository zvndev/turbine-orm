# Cancelling a streamed read

`findManyStream` (rows) and `findManyStreamBatches` (arrays) accept an optional
`signal: AbortSignal`. The option belongs to `FindManyStreamArgs`; ordinary
`findMany`, deferred queries and pipelines do not accept it.

```ts
const controller = new AbortController();
const stream = db.users.findManyStream({
  signal: controller.signal,
  batchSize: 500,
});
try {
  for await (const row of stream) {
    await send(row);
  }
} finally {
  await stream.return(undefined);
}
// A response/request lifecycle can call controller.abort(reason).
```

A pre-aborted signal rejects the first pull with `signal.reason` before any
checkout or SQL. Aborting a pending checkout rejects promptly and returns its
eventual connection without issuing SQL. Opting in uses the cursor/native
iterator directly, including for small results, so an initial materialized
query cannot bypass cancellation. Omitting `signal` retains the existing
speculative small-result optimization and SQL.

An accepted abort preserves the original reason, including a non-Error value.
It wakes a supported pending transport read, closes the underlying iterator,
and returns only a stream-owned checkout after cleanup. A consumer suspended
at a row or batch need not pull again for cleanup to start. Its next pull
rejects with the reason and discards buffered rows. A rejected pull closes the
async generator; subsequent pulls are done. Synchronous row parsing and SQLite
execution cannot be interrupted by a timer.

`return()` or breaking a `for await` loop awaits the existing iterator cleanup.
Return, abort, idle expiry and completion share one cleanup operation. The
first terminal close wins; an idle timeout already in progress remains
`TimeoutError`. Cleanup failure rejects an awaiting pull/return and discards
an owned checkout. A completed or returned iterator remains done after a later
abort. A pending `next()` must settle before a queued `return()` can finish;
return alone is not an interrupt for pending network work. Use the signal to
interrupt that work.

| Engine / transport | Cancellation boundary |
| --- | --- |
| Native PostgreSQL `pg.Pool` | Uses the existing protocol CancelRequest and waits for delivery and statement settlement, up to the existing two-second grace. An in-flight abort discards this stream's physical checkout; the supplied pool remains caller-owned and usable. Unconfirmed cancellation throws `ConnectionError` with the abort reason as cause and never pools the uncertain connection. |
| PostgreSQL caller transaction | Requires Turbine's transaction/savepoint scope and a native protocol-cancel target. Admission requires an otherwise idle transaction connection. While the cancellable statement owns the connection, later statements and savepoint commands refuse with `E003` until its cancellation listener and any delivery settle, including the interval after the driver reports completion. Pending statement cancellation marks that block for rollback, even if the stream error is swallowed. Let the error leave the callback, or use a nested `$transaction` to recover only that savepoint. Aborting between pulls closes the cursor without ending or releasing the caller's transaction. |
| Query-only PostgreSQL / HTTP transport | Opt-in cancellation refuses with `UnsupportedFeatureError` before SQL. It does not race a query and leave it running on a reusable connection. |
| Native MySQL | Closes the stream's socket in both directions and discards its physical checkout; the borrowed pool can open a fresh socket. A `return()` or `break` outside a transaction does the same. **This is transport cancellation, not an acknowledged server `KILL QUERY`.** A server that is sending rows sees the close on its next write and ends the session at once. A statement that has not sent its first row runs until it does, and keeps its locks meanwhile. Use appropriate server execution limits for costly reads. Inside a caller's transaction the connection belongs to the transaction, so `return()` reads and discards the rest of the result instead. An abort there discards the connection, and the transaction cannot subsequently commit its earlier writes. |
| Native SQL Server | Passes the same signal into the native request, calls `Request.cancel()`, and waits for request settlement before reuse. Settlement depends on the driver/server acknowledgement; no additional deadline is introduced. Native service validation remains pending. Observable driver fixtures establish request cancellation, not server certification. |
| SQLite | Checks between public rows/batches and finalizes `StatementSync.iterate()` on abort. A synchronous SQLite step, user function, sort or batch already executing runs to its boundary. No `sqlite3_interrupt` claim. A supplied `DatabaseSync` remains the caller's to close. |
| PowDB | Keeps the existing unsupported-stream refusal. |

Cancellation does not add a pool-close operation, change SQL parsers, bound a
row's bytes or nested relation fanout, or transfer transaction ownership. The
existing stream idle timeout continues to close abandoned streams. PostgreSQL
keepalives settle before a cursor statement starts, so cancelling that statement
cannot target a keepalive queued ahead of it. Concurrent work through the same
caller transaction is refused at cursor statement admission; use a separate
connection for independent work.
