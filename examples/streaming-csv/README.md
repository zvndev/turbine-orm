# Streaming CSV — server-side cursors through nested `with`

Export 100,000 shipped orders (with their customer and line items) to CSV
while the Node.js heap stays flat. The demo prints a live progress meter
showing row count, throughput, and peak heap — you should see the heap
settle in the ~60–90MB range and stay there regardless of dataset size.

> **Heads up on performance.** For a straight drain-all-rows workload
> over a cloud database, keyset pagination (`take: N, cursor, orderBy`)
> is actually a bit *faster* than server-side cursors because cursors
> pay `BEGIN + DECLARE + CLOSE + COMMIT` overhead on top of the same
> `FETCH` round-trips. Turbine's cursor isn't the right tool because
> it's faster; it's the right tool when you want **correct semantics
> on any `orderBy`** (not just unique columns), **deterministic
> cleanup on early `break` / throw**, and **nested `with` inside the
> stream** without re-fetching relations per page. See
> `benchmarks/RESULTS.md` for the measured numbers.

```ts
for await (const order of db.orders.findManyStream({
  where: { status: 'shipped' },
  batchSize: 1000,
  with: { customer: true, lineItems: true },
})) {
  out.write(toCsvRow(order)); // order.customer.email — typed through
}
```

Under the hood this uses a PostgreSQL `DECLARE CURSOR` / `FETCH` loop on a
dedicated pooled connection. The cursor is closed and the connection
released automatically — even if you `break` early or throw.

## Setup

```bash
# 1. Install
npm install

# 2. Point at a Postgres database
export DATABASE_URL="postgres://localhost/streaming_csv"
createdb streaming_csv

# 3. Push schema, seed 100K orders, generate typed client
#    (takes ~20 seconds — set ORDERS=10000 for a quicker loop)
npm run setup

# 4. Run the export
npm start > orders.csv
```

Progress meter is on **stderr** so you can redirect **stdout** to a file.

## What it shows off

| Feature | Where |
|---|---|
| **`findManyStream` with nested `with`** | The main loop — customer + lineItems stream with the parent rows |
| **Cursor batching** | `batchSize: 1000` — one `FETCH 1000` per round-trip, not per row |
| **Constant memory** | Heap tracked in the progress meter — stays flat for any dataset size |
| **Typed projection** | `order.customer.email` / `order.lineItems[0].productName` both autocomplete |
| **Automatic cleanup** | Cursor + transaction close on early `break`, error, or normal completion |

## Why this is hard elsewhere

- **Prisma:** No native cursor streaming primitive. Keyset pagination
  (`take: 1000, cursor: { id: lastId }, orderBy: { id: 'asc' }`) works
  and is actually *faster* for drain-all workloads — but it only works
  correctly when `orderBy` is on a unique, monotonic column, and
  `break`ing out mid-stream just stops the loop (no deterministic
  cleanup). You also write the paging state machine yourself.
- **Drizzle:** No native streaming. Same keyset-pagination story as
  Prisma, with the same trade-offs.
- **Kysely:** You can reach into the underlying `pg` driver's cursor,
  but nested relations have to be assembled by hand from `jsonArrayFrom`
  helpers per page.

## Files

| File | What it is |
|---|---|
| `schema.ts` | `defineSchema(...)` — customers, orders, line_items |
| `seed.ts` | Bulk-inserts 100K orders via `UNNEST` (configurable via `ORDERS` env) |
| `index.ts` | The demo — streams to CSV with a live progress meter |
