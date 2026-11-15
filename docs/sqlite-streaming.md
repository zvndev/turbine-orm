# SQLite incremental reads

`findManyStream` and `findManyStreamBatches` now use `node:sqlite`'s native
statement iterator when a result exceeds the existing bounded first fetch.
They step through rows as the consumer requests batches instead of loading the
entire result into a JavaScript array. Column decoding and nested results retain
the same values as ordinary reads.

Native iteration requires `StatementSync.iterate()` and
[`DatabaseSync.isTransaction`](https://nodejs.org/download/release/v22.16.0/docs/api/sqlite.html#databaseistransaction),
available together in Node 22.x from 22.16.0 onward, or Node 24.0.0 and later.
Node 23 does not provide the transaction-state capability.
When transaction-state reporting is absent, native streaming throws
`UnsupportedFeatureError` before opening an iterator: the pool cannot safely
identify a caller-owned transaction. Ordinary queries retain the existing
Node 22.5 floor. A result satisfied entirely by the bounded first fetch also
does not need a native iterator. On older drivers, coordinate external
transactions directly on the supplied handle; the fallback tracks only
transaction statements issued through the pool.

```ts
for await (const batch of db.events.findManyStreamBatches({
  orderBy: { id: 'asc' },
  batchSize: 1024,
})) {
  await sendBatch(batch);
}
```

An active native iterator owns this client's single SQLite handle. Other
callers wait in FIFO order until it closes, up to `busyTimeoutMs`; expiry is a
retryable `SerializationFailureError`. Finish or return the iterator before
awaiting another operation on the same client. This changes the previous eager
stream's ability to interleave writes on that handle. A separate file-backed
database handle can be used for concurrent work, subject to SQLite locking.
Inside a transaction, close its iterator before issuing another statement.

Breaking out of `for await` closes the iterator. When managing an iterator
manually, call `await iterator.return()` in `finally`. The stream also cleans up
after a native error, idle expiry, transaction/savepoint completion or timeout,
and connection release. It never commits or rolls back a caller's transaction.
A supplied `DatabaseSync` remains the caller's responsibility to close. Direct
access to that handle, or multiple wrappers around it, requires caller coordination.

`batchSize` bounds parent row count, not payload bytes. One BLOB, nested JSON
result, or SQLite sort/aggregate workspace may still be large. Nested results
are preserved without truncation. SQLite stepping remains synchronous: timers
and consumer cancellation act between pulls and cannot interrupt a running
SQLite operation. Query-only connection shims cannot provide this native stream
and receive `UnsupportedFeatureError` when native iteration is required.
