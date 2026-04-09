# Streaming CSV — constant memory over 100K+ rows

Export 100,000 shipped orders (with their customer and line items) to CSV
while the Node.js heap stays flat. The demo prints a live progress meter
showing row count, throughput, and peak heap — you should see the heap
settle in the ~60–90MB range and stay there regardless of dataset size.

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

- **Prisma:** No cursor streaming primitive. You have to hand-roll keyset
  pagination loops (`take: 1000, cursor: { id: lastId }`), and every page
  re-runs the nested-relation fetch from scratch.
- **Drizzle:** No streaming. Same keyset-pagination story.
- **Kysely:** You can use the underlying pg driver's cursor, but nested
  relations have to be assembled by hand from `jsonArrayFrom` helpers.

## Files

| File | What it is |
|---|---|
| `schema.ts` | `defineSchema(...)` — customers, orders, line_items |
| `seed.ts` | Bulk-inserts 100K orders via `UNNEST` (configurable via `ORDERS` env) |
| `index.ts` | The demo — streams to CSV with a live progress meter |
