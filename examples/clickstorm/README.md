# Clickstorm — atomic updates vs the race

A minimal "like button" demo that proves why atomic update operators
matter. Two routes, same database, same pool — the atomic path survives
10,000 concurrent clicks intact, the read-modify-write path loses 20–60%
of them to the classic lost-update race.

```ts
// The atomic path. Compiles to `likes_count = likes_count + $1`.
await db.posts.update({
  where: { id: 1 },
  data: { likesCount: { increment: 1 } },
});

// The naive path. Two requests read the same value, bump locally, race.
const post = await db.posts.findUniqueOrThrow({ where: { id: 1 } });
await db.posts.update({
  where: { id: 1 },
  data: { likesCount: post.likesCount + 1 },
});
```

Plus: a clean retry loop that uses Turbine's typed `DeadlockError` /
`SerializationFailureError` with `isRetryable` as a const discriminator —
no stringly-typed pg error code matching.

## Setup

```bash
# 1. Install
npm install

# 2. Point at a Postgres database
export DATABASE_URL="postgres://localhost/clickstorm"
createdb clickstorm

# 3. Push schema, seed a single post with likes=0, generate client
npm run setup

# 4. Start the server
npm start

# 5. In another terminal, fire 10,000 clicks at each route
npm run storm
```

## Expected output

```
/like/safe
  fired:    10,000 (concurrency 64)
  counter:  10,000
  lost:     0 (0.0%)
  time:     3.2s

/like/unsafe
  fired:    10,000 (concurrency 64)
  counter:  4,812
  lost:     5,188 (51.9%)
  time:     3.4s
```

The exact "lost" number varies by pool size, hardware, and Postgres
isolation level — but the atomic path is always exact and the naive path
always loses a large chunk.

## What it shows off

| Feature | Where |
|---|---|
| **Atomic update operators** | `{ likesCount: { increment: 1 } }` in `likeSafe()` |
| **Typed Postgres errors** | `DeadlockError`, `SerializationFailureError` with `readonly isRetryable = true` |
| **Clean retry loop** | `withRetry()` — 10 lines, no pg error-code parsing |
| **Race-free concurrency** | The proof is in the counter — side-by-side the atomic path always wins |

## Why this is hard elsewhere

- **Prisma:** Supports `{ increment }` but surfaces retryable errors as
  `PrismaClientKnownRequestError` with stringly-typed `code: 'P2034'`.
  No `isRetryable` const — you end up with a switch on error codes.
- **Drizzle:** You have to drop to raw SQL fragments (`sql\`likes_count + 1\``)
  to get the race-free path, which defeats type inference on that column.
- **Kysely:** Same story as Drizzle — raw SQL fragments for the increment.

## Files

| File | What it is |
|---|---|
| `schema.ts` | One table, one counter column |
| `seed.ts` | Creates the single post that gets hammered |
| `server.ts` | HTTP server — `/like/safe`, `/like/unsafe`, `/count`, `/reset` |
| `storm.ts` | Load generator — fires N concurrent clicks at each route |
