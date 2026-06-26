# Should Turbine ORM fully support PowDB?

**Date:** 2026-06-25
**Author:** Product strategy review (read-only analysis — no code changed)
**Turbine version reviewed:** v0.19.2 · **PowDB version reviewed:** v0.6.1

---

## Verdict (one line)

**Don't build PowDB support into Turbine. If it ever happens, it's a separate `turbine-powdb` sibling on an extracted core — gated hard on PowDB 1.0 + Turbine 1.0 + a real external pull. Today it is the single most focus-diluting thing Turbine could do.**

---

## 1. What PowDB actually is (from its repo)

Read against its own `README.md` and `AGENTS.md`, PowDB is unambiguous about itself:

- **A pure-Rust embedded database with its own query language, PowQL — not SQL.** AGENTS.md states it directly: *"It speaks its own query language (PowQL), not SQL… there is no SQL compatibility layer, and that is a deliberate design decision (the translation tier is the thing we're removing)."*
- **It does not speak the Postgres wire protocol.** *"PowDB has no Postgres wire protocol, no ODBC, no legacy compatibility. The client is a TCP binary protocol or an in-process Engine."*
- **Client surface:** (a) in-process Rust `Engine`, or (b) a length-prefixed **binary TCP** wire protocol with a TypeScript client `@zvndev/powdb-client` (`client.query("User filter .age > 25 { .name, .age }")`).
- **Maturity:** v0.6.1, pre-1.0, explicitly warns *"minor bumps may change on-disk formats."* Single-node only — no replication, sharding, or consensus. Coarse auth (admin/readwrite/readonly), nothing per-row.
- **Performance shape:** honest 3–10× SQLite on scan/aggregate; durable single-row autocommit capped at **~290 writes/sec** (one fsync/row), ~15,600/sec when batched in a transaction. By its own AGENTS.md it positions against **SQLite**, not Postgres.
- **What's genuinely shipped:** joins, GROUP BY/HAVING, subqueries (IN/EXISTS/correlated), window functions, upsert, materialized views, explicit `begin/commit/rollback`, **parameter binding `$1..$N`** (since 0.4.7 — note: this closes the "no wire params" gap from earlier planning), TLS, WAL/crash recovery, offline backup/restore + PITR.
- **What is NOT there and matters for an ORM:** no `json_build_object`/`json_agg`, no link navigation (`User.posts` is explicitly "not yet implemented"), no `RETURNING`, no auto-generated/serial IDs (every insert example sets `id := 1` by hand), no SQL surface at all.

## What "Turbine fully supporting PowDB" would concretely require

Turbine is a code generator + SQL string builder + `pg` wire driver. Its two extension seams do **not** reach PowDB:

| Seam | What it's for | Does PowDB fit? |
|---|---|---|
| `src/adapters/` (CockroachDB, YugabyteDB) | *"databases that speak the PostgreSQL wire protocol but differ in implementation"* | **No.** PowDB doesn't speak the Postgres wire protocol at all. |
| `src/dialect.ts` (future MySQL/SQLite) | SQL-shaped primitives that vary across SQL dialects. Every method emits SQL: `buildInsertStatement` → `INSERT INTO …`, `buildJsonObject` → `json_build_object(…)`, `buildReturningClause` → `RETURNING …` | **No.** The seam assumes SQL output. PowQL is a different *language shape* (left-to-right pipeline, `type` not `CREATE TABLE`, `:=` not `=`, trailing-brace projection, no `RETURNING`). |

So full support is **not an adapter and not a dialect.** It requires, at minimum, all four of:

1. **A new transport.** Drop `pg`; bind the `@zvndev/powdb-client` binary TCP protocol (or a new driver). This is a whole new connection/pool/transaction lifecycle.
2. **A new query-generation backend.** Emit **PowQL**, not SQL. This is a second code-gen target — conceptually a second ORM backend, not a dialect tweak. The SQL-shaped `Dialect` interface cannot express PowQL.
3. **Abandoning Turbine's headline feature on this backend.** Turbine's identity is single-query nested relations via `json_agg` + correlated subqueries. PowDB has **neither JSON aggregation nor link navigation**, so `with: { posts: { comments: true } }` regresses to **N+1 batched IN-loaders**. The one thing Turbine is known for cannot run here.
4. **Waiting on PowDB engine features** Turbine's API assumes: `RETURNING` + generated/default IDs (so `create()` can return the row), per-connection transaction isolation (the server holds one global `Arc<RwLock<Engine>>`; Turbine's `$transaction` does SAVEPOINTs, isolation levels, timeouts), typed/`describe` wire for result coercion, unique-index introspection. Several don't exist yet.

**Bottom line on surface:** this is not "add a backend to Turbine." It's "build a second product that happens to share a type system." Which is exactly why prior planning landed on an extracted `@zvndev/turbine-core` + a sibling `turbine-powdb` — not a fork, not an in-repo adapter.

---

## 2. Is it worth doing now? (Against the central finding)

The fresh product review's central finding is the whole game: Turbine is entering a **converged two-giant market (Prisma 7, Drizzle)** where its old moat (json_agg) is now commodity, and its **only scarce advantage is FOCUS on the Postgres safety bundle** — read-only Studio, PII-safe errors, one dependency, checksummed migrations. Measured against that, PowDB support fails on every axis:

- **It does not advance the moat — it dilutes it.** The safety bundle is a *Postgres* story. PowDB is a different DB, a different language, a different protocol. Nothing about supporting it makes Turbine's Postgres pitch sharper. It makes the product two half-told stories instead of one sharp one.
- **It can't even deliver Turbine's signature feature.** No json_agg means the nested-read magic — the thing demos sell on — degrades to N+1. You'd be shipping a worse Turbine on a database almost no one is asking an ORM for.
- **Nobody can use it end-to-end today.** The PowQL backend and the transport don't exist. There is zero Turbine+PowDB happy path right now — this is greenfield product work, not "support."
- **The opportunity cost is brutal.** Every week on PowDB is a week not spent (a) proving the Postgres positioning with real adoption, or (b) on the MySQL/SQLite/MSSQL roadmap — which at least **reuses the SQL-shaped dialect seam** and expands the addressable market into databases people actually pair with an ORM. PowDB reuses neither the seam nor the moat.
- **PowDB isn't ready to be leaned on.** Pre-1.0, on-disk format may change, single-node, ~290 durable writes/sec autocommit, and its *own* go-to-market wedge (in-process structured-state store for Rust AI-agent runtimes, with small models generating PowQL) is still an unproven hypothesis. Stacking an unproven ORM-on-DB bet on top of an unproven DB-wedge bet is two products propping each other up — the classic trap where neither proves its own value.

There's also a craft point: **Turbine's ergonomics are a relational/Postgres fit; PowDB's wedge is agent state.** Forcing a Prisma-like `findMany`/`with` ORM onto a pipeline language built for compiled scans isn't a natural pairing — it's a marriage of convenience between two ZVN projects, not a user-driven need.

---

## 3. Recommendation: Don't do it now → spin out as a gated `turbine-powdb` sibling, later

This is a blend of **"Don't do it (now)"** and **"Spin it out as a separate bet (when triggered)."** Decisively:

- **Now:** Do nothing in the Turbine repo. No adapter, no dialect entry, no PowQL backend, no marketing claim. Protect focus. Keep the dialect seam pointed at its intended targets (MySQL/SQLite), which actually expand the market.
- **Later, only as a sibling:** If the triggers below all fire, build `turbine-powdb` as a **separate package on an extracted `@zvndev/turbine-core`** (types / inference / errors / `defineSchema` / codegen skeleton — ~85% backend-agnostic per prior planning). Never a fork, never an in-repo branch. `builder.ts` is ~25–30% conceptually reusable, near-zero line-reusable — the PowQL emitter is new code.

**Trigger conditions (all must hold — this is a pull, not a push):**

1. **PowDB ships 1.0 / GA** with a stable on-disk format and the ORM-blocking engine features: `RETURNING` + generated/default IDs, per-connection transaction isolation, typed/`describe` wire, unique-index introspection, protocol batching. (Param binding is already done — one box ticked.)
2. **Turbine ships 1.0** and the **Postgres safety-bundle positioning is proven** with real, non-vanity adoption. You earn the right to a second backend by winning the first market.
3. **At least one real external user asks for Turbine-on-PowDB.** If the demand is internal-only, it's a roadmap distraction wearing a customer costume.

**Rough engineering size (when triggered):** core extraction + PowQL emitter + powdb-client transport ≈ **8–12 weeks for an experimental MVP**, engine-permitting; **5–7 months to anything like parity**, gated on PowDB's engine work — and even then, **relations ride N+1 batched loaders, not json_agg.** Marketing discipline: **no "faster than Postgres" claims, ever** (the PowDB repo has zero Postgres benchmarks; ORM traffic rides PowDB's weakest path).

**The sharper alternative for the underlying desire.** If the real goal is "give PowDB a great typed TypeScript DX," the higher-leverage move is **not** bending Turbine onto it — it's investing in PowDB's **own** `@zvndev/powdb-client` typed layer / a thin PowQL query builder that serves PowDB's actual wedge (small models generating correct PowQL for agent state). That advances PowDB's thesis directly, costs a fraction, and keeps Turbine's focus intact.

---

## 4. What to cut / defer / simplify

- **Cut now:** any PowDB adapter or dialect entry in the Turbine repo. It doesn't belong in either seam and would imply a support promise Turbine can't keep.
- **Cut the framing:** "Turbine on PowDB = massive gains vs Postgres." It's indefensible (no Postgres numbers, wrong workload path) and violates PowDB's own honesty discipline.
- **Defer:** the entire `turbine-powdb` sibling until the three triggers fire. Park the idea in this doc, not the roadmap.
- **Reinvest the freed focus into the two things that actually compound:** proving the Postgres safety-bundle positioning, and the MySQL/SQLite dialect work that reuses the existing seam.

## 5. Risks & open questions

- **Risk — sunk-cost momentum:** prior planning already sketched `turbine-core` + `turbine-powdb`. The risk is treating that sketch as a commitment. It was contingent; the contingencies (PowDB GA, Turbine 1.0, real pull) are not yet met.
- **Risk — two unproven bets propping each other up:** if Turbine's Postgres wedge and PowDB's agent-state wedge are *both* unproven, a joint launch obscures which one (if either) actually has product-market fit.
- **Open question for Kirby:** Is there a *named external user* who wants Turbine-on-PowDB, or is this an internal "wouldn't it be cool" pairing of two ZVN projects? The answer flips this from "defer" to "park indefinitely."
- **Open question:** Does PowDB even want to be an ORM target, or does its agent-state wedge argue for a *purpose-built* PowQL DX instead? (I believe the latter.)

## 6. The next move

**Write this decision down as the answer (this doc), keep PowDB off the Turbine roadmap, and put the next sprint into proving the Postgres safety-bundle positioning + the SQL-dialect (MySQL/SQLite) seam.** Revisit `turbine-powdb` only when PowDB hits 1.0, Turbine hits 1.0, and a real user pulls for it.
