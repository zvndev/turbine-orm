# Demo Ideas Backlog

Five remaining demo ideas from the v0.7.1 brainstorm. The first three
(Thread Machine, Streaming CSV, Clickstorm) already shipped as
examples. These are the runners-up — each lands on a different
differentiator, stays under ~150 LOC, and never pitches generated SQL
as the punchline.

---

## Demo 4: Pipeline Dashboard — 8 queries, 1 round-trip

**Hook:** An admin dashboard loads 8 independent widgets (counts, top
users, revenue, chart data, alerts, churn, signups, top plans) and the
network tab shows exactly **one** Postgres round-trip. Flip a "pipeline:
on/off" toggle and watch TTFB drop from ~240ms to ~40ms live.

**Features:** `db.pipeline(...)`, `buildFindMany` / `buildCount` /
`buildAggregate`, middleware for query timing, A/B toggle.

**Stack:** Hono on Bun, simple HTML dashboard.

**Centerpiece:**
```ts
const [users, orgs, revenue, signups, churn, topUsers, topPlans, alerts] =
  await db.pipeline(
    db.users.buildCount({}),
    db.orgs.buildCount({}),
    db.invoices.buildAggregate({ _sum: { amountCents: true } }),
    db.users.buildCount({ where: { createdAt: { gte: weekAgo } } }),
    db.users.buildCount({ where: { cancelledAt: { gte: weekAgo } } }),
    db.users.buildFindMany({ orderBy: { mrrCents: 'desc' }, limit: 5 }),
    db.plans.buildFindMany({ orderBy: { seats: 'desc' }, limit: 5 }),
    db.alerts.buildFindMany({ where: { resolvedAt: null }, limit: 10 }),
  );
```

**Why not Prisma/Drizzle:** Prisma's `$transaction([...])` does serial
queries in a BEGIN block — still N round-trips. Drizzle has no
equivalent. The only Postgres-native alternative today is raw SQL
concatenation with `UNION ALL` hacks.

---

## Demo 5: Edge Profile — sub-20ms user pages on Cloudflare Workers

**Hook:** Deploy a user profile page to Cloudflare Workers. First paint
from Tokyo, Sydney, and São Paulo all come in under 20ms. The code is
identical to the local Node version except **one import line**.

**Features:** `turbineHttp`, Neon serverless driver, nested `with` over
HTTP, typed errors across the wire.

**Stack:** Cloudflare Worker + Neon HTTP + Hono.

**Centerpiece:**
```ts
import { Pool } from '@neondatabase/serverless';
import { turbineHttp } from 'turbine-orm/serverless';
import { SCHEMA } from './generated/turbine/metadata';

const db = turbineHttp(new Pool({ connectionString: env.DATABASE_URL }), SCHEMA);

const user = await db.users.findUniqueOrThrow({
  where: { handle: c.req.param('handle') },
  with: {
    posts: { orderBy: { createdAt: 'desc' }, limit: 20, with: { tags: true } },
  },
});
```

**Why not Prisma/Drizzle:** Prisma on edge requires `@prisma/adapter-neon`
+ Driver Adapters beta, a separate generator, and a different client
import path. Drizzle works but you re-declare relations. Turbine is one
import swap from the same generated client.

---

## Demo 6: Double-Entry — a ledger that refuses to lose money

**Hook:** A tiny bank-account demo: transfer $50 from Alice to Bob. Kill
the process mid-transfer with `SIGKILL`. State is always balanced. The
code reads like pseudocode because savepoints + retry loops + check
constraints are handled by the ORM layer.

**Features:** `$transaction` with `isolationLevel: 'serializable'` +
`timeout`, nested savepoints, `SerializationFailureError.isRetryable`
retry loop, empty-where guard, `CheckConstraintError`.

**Stack:** Vanilla Node, local Postgres, a `chaos.ts` script that
SIGKILLs workers mid-transfer.

**Centerpiece:**
```ts
async function transfer(from: number, to: number, cents: number) {
  return retryOnSerialization(() =>
    db.$transaction(
      async (tx) => {
        await tx.accounts.update({
          where: { id: from },
          data: { balanceCents: { decrement: cents } },
        });
        await tx.accounts.update({
          where: { id: to },
          data: { balanceCents: { increment: cents } },
        });
        await tx.ledger.create({ data: { fromId: from, toId: to, cents } });
      },
      { isolationLevel: 'serializable', timeout: 2000 },
    ),
  );
}
// retryOnSerialization = 8 lines — it only catches `err.isRetryable`.
```

**Why not Prisma/Drizzle:** Prisma throws a generic
`PrismaClientKnownRequestError` with stringly-typed `code: 'P2034'` — no
`isRetryable`. Drizzle surfaces raw pg errors and you grep SQL states
by hand. Neither has a typed `SerializationFailureError` class.

---

## Demo 7: Bulk Loader — CSV to 500K rows in 6 seconds

**Hook:** Drop a 500K-row CSV on the CLI. It streams in, batches via
`createMany` UNNEST inserts, and finishes in ~6 seconds with a live
progress bar. Hit Ctrl+C mid-import — the whole thing rolls back
cleanly thanks to the surrounding transaction.

**Features:** `createMany` (UNNEST batch insert), `$transaction` with
timeout, `NotNullViolationError` / `UniqueConstraintError` for clean
per-row error reporting, optional `findManyStream` for dedupe pre-check.

**Stack:** Vanilla Node CLI with `node:stream` + `csv-parse`.

**Centerpiece:**
```ts
await db.$transaction(async (tx) => {
  for await (const batch of batched(csvStream, 5000)) {
    try {
      await tx.contacts.createMany({ data: batch });
    } catch (err) {
      if (err instanceof UniqueConstraintError) {
        skipped.push({ constraint: err.constraint, detail: err.detail });
      } else {
        throw err;
      }
    }
    bar.tick(batch.length);
  }
}, { timeout: 120_000 });
```

**Why not Prisma/Drizzle:** Prisma's `createMany` does multi-values
INSERT but caps at ~1K rows per call and has no `skipDuplicates` with
constraint-name reporting. Drizzle's `insert().values([...])` works but
errors come back as raw pg objects — no typed `UniqueConstraintError`
with `.constraint` to route on.

---

## Demo 8: ShipIt — zero-downtime migration playground

**Hook:** Edit `schema.ts`, run `turbine migrate create --auto`, and the
UP/DOWN SQL is already written. Apply it while a worker process keeps
inserting — zero errors, zero manual SQL.

**Features:** `defineSchema()`, `schemaDiff()` auto-migration, checksum
validation, `pg_try_advisory_lock` migration safety, `MigrationError`
typed error.

**Stack:** Vanilla Node CLI demo, maybe a tiny TUI that shows
"live writer: 1,247 rows" alongside "migration: applying...".

**Centerpiece:**
```ts
// turbine/schema.ts — before
users: { id: { type: 'serial', primaryKey: true }, email: { type: 'text' } },
// after: add `plan` column
users: {
  id: { type: 'serial', primaryKey: true },
  email: { type: 'text' },
  plan: { type: 'text', default: "'free'" },
},
```
```bash
$ npx turbine migrate create add_plan --auto
# Writes 20251108_add_plan.sql with both UP and DOWN populated.
```

**Why not Prisma/Drizzle:** Prisma's `migrate dev` resets your DB if it
detects drift — terrifying in practice. Drizzle Kit's auto-diff is good
but requires a separate `drizzle-kit` package and config file;
Turbine's is a single CLI command from the same binary.

---

## Priority order (if building more)

1. **Pipeline Dashboard** — most visually dramatic ("1 round-trip"),
   showcases a differentiator no other ORM has.
2. **Edge Profile** — hammers the edge/serverless story which is half
   the v1 pitch. Doubles as real-world integration test for `turbineHttp`.
3. **Double-Entry Ledger** — fintech audience is high-value and this
   shows off the full transaction story in one screen.
4. **Bulk Loader** — solid but less unique (every ORM has *something* here).
5. **Migration Playground** — most useful as documentation but hardest
   to demo live without a screen recording.
