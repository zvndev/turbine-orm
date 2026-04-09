# Thread Machine — deep typed `with` inference

A Hacker News-style dataset (users → stories → comments → replies → author)
rendered to the terminal from **a single `findMany` call**, where every
property of the 4-level object graph autocompletes with no casts.

```ts
const stories = await db.stories.findMany({
  with: {
    author: true,
    comments: {
      with: {
        author: true,
        replies: { with: { author: true } },
      },
    },
  },
});

// All inferred. No `as Story & { ... }` cast anywhere:
stories[0].comments[0].replies[0].author.handle
//      ^Story ^Comment    ^Reply    ^User   ^string
```

## Setup

```bash
# 1. Install
npm install

# 2. Point at a Postgres database
export DATABASE_URL="postgres://localhost/thread_machine"
createdb thread_machine

# 3. Push the schema, seed, and generate the typed client
npm run setup

# 4. Run the demo
npm start
```

## What it shows off

| Feature | Where |
|---|---|
| **Deep typed `with` inference** | The main `findMany` call. Put your cursor anywhere in `stories[0].comments[0].replies[0].author` — it types through |
| **Nested `orderBy` + `limit`** | Each level independently orders by `score` and caps results |
| **Relation filters (`some`)** | The final `count` uses `comments: { some: { replies: { some: { ... } } } }` — 3-level-deep `where` across relations |
| **One round-trip** | The entire tree loads in a single SQL statement regardless of nesting depth |
| **Code generation** | `npm run db:generate` emits the typed client from introspected Postgres, including the recursive `Relations` types |

## Why this is hard elsewhere

- **Prisma 7:** `include` works at shallow depth but autocomplete drops out
  past 2-3 levels — you end up reaching for `Prisma.StoryGetPayload<...>`
  helpers or manual generics.
- **Drizzle v2:** The relational query builder works, but you have to
  re-declare every relation in a separate `relations()` call next to the
  table definition. Turbine infers from the generated metadata.
- **Kysely:** No automatic nested resolution — you hand-write
  `jsonArrayFrom` / `jsonObjectFrom` at every level.

## Files

| File | What it is |
|---|---|
| `schema.ts` | `defineSchema(...)` — users, stories, comments, replies |
| `seed.ts` | Populates ~20 users, 15 stories, ~75 comments, ~150 replies |
| `index.ts` | The demo — one `findMany`, one `count`, a terminal render |
