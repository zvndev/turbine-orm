# Turbine ORM — Competitive Parity Audit

_Landscape as of 2026-07-08 — competitive surfaces move fast; re-run quarterly._
_Method: repo-grounded inventory (v0.27.1) + web-researched current surfaces of Prisma 7.x, Drizzle 0.45/1.0-beta, TypeORM 1.0, with Kysely + MikroORM v7 as an idea-mining cohort. Every asserted Turbine gap was verified by direct grep of the source._

## What this is & the wedge

Turbine is a **Postgres-first TypeScript ORM** whose defensible wedge is the combination of:
1. **Single-statement nested relations via `json_agg`** — shipped GA, with a `batched` fallback strategy, uniform across depth.
2. **End-to-end type inference for `with` at arbitrary depth** — no codegen engine, no WASM binary, no schema DSL.
3. **Zero runtime dependencies beyond `pg`** — no driver adapters to keep in lockstep, no engine download.
4. **Postgres power features GA that Prisma keeps in preview**: typed raw SQL, full-text search, pgvector query ops, RLS session context, LISTEN/NOTIFY.

Stated non-goals (CLAUDE.md): no deps beyond `pg`, no engine binary, no eval, Prisma-like API stays stable, Studio stays physically read-only, non-Postgres engines fail loud (E017) rather than emit broken SQL.

## Comparison cohorts

- **Direct**: Prisma 7 (Nov 2025, Rust-free compiler default), Drizzle 0.45 stable / 1.0-beta (RQBv2, still pre-stable as of July 2026), TypeORM 1.0 (May 2026 — **now actively maintained**, new governance since late 2024). The user-named cohort is the correct category.
- **Adjacent (idea-mining)**: Kysely (typed SQL builder — validates the json_agg-subquery demand, breaks down exactly where Turbine is strong) and MikroORM v7 (Unit of Work ORM — source of the global-filters idea).

## Where we already win — lean in, don't rebuild

| Advantage | Evidence | Competitor state |
|---|---|---|
| Single-query `json_agg` nested relations, GA + `batched` strategy | `query/builder.ts` `buildRelationSubquery`, `query/batched-loader.ts` | Prisma `relationJoins` **still preview since 5.7.0**; Drizzle's strategy is per-dialect and shifting mid-v1-beta; TypeORM relation SQL widely criticized |
| Typed error hierarchy E001–E017 with pg SQLSTATE mapping | `errors.ts`, `wrapPgError()` | **Drizzle has none** (raw driver errors — its most-cited DX gap); TypeORM errors "often unhelpful" |
| Typed raw SQL GA, no live DB needed | `typed-sql.ts`, `client.sql<T>` | Prisma TypedSQL is **preview** and requires a live DB at generate time |
| Full-text search GA | `buildTextSearchClause`, `text-search.test.ts` | Prisma FTS **preview**, being re-evaluated; Drizzle raw-sql only |
| pgvector query + KNN orderBy first-party | `VectorFilter`/`VectorOrderBy`, `pgvector.test.ts` | Prisma: extension-only, not native |
| RLS `sessionContext` + `$withSession` | `client.ts`, `rls-session.test.ts` | Prisma RLS is a tagged stopgap (issue #12735) |
| LISTEN/NOTIFY realtime | `realtime.ts` | **Nobody** has this first-party |
| 1-RTT wire-protocol pipeline | `pipeline-submittable.ts` | Unique |
| Down migrations + checksums + advisory lock + destructive triple-confirm | `cli/migrate.ts`, `cli/destructive.ts` | Prisma: down is a manual recipe; Drizzle: **no down at all** (removed `drop` in v1 beta) |
| `turbine doctor` missing-FK-index advisor + dev-mode warning | `index-advisor.ts` | Unique (Prisma's Optimize was sunset) |
| Optimistic locking first-class | `optimisticLock`, E015 | Extensions-only elsewhere |
| `$observe` metrics | `observe.ts` | Prisma **removed** its metrics preview in v7 |
| Read-only, token-authed Studio | `cli/studio.ts` | Prisma Studio does CRUD; Drizzle monetizes Gateway |
| Zero deps, no engine, ESM+CJS | `package.json` | Prisma v7 forced a mandatory driver-adapter + ESM migration on users |

**Marketing note (P0 copy fix):** any comparison copy calling TypeORM abandoned is now false — it's 1.0 with a steering committee, 575 PRs merged in 2025. Attack its durable weaknesses instead (type inference, relation SQL quality). Also market head-to-head vs Kysely: its `jsonArrayFrom` proves demand for exactly Turbine's algorithm but is untyped at depth (open issue #712) and returns string dates — Turbine's `WithResult` + `parseNestedRow` are the direct answer.

## Gap scorecard

Legend: ✅ first-party · ⚠️ partial/preview/plugin · ❌ none. Wedge rows in bold.

| Capability | Prisma 7 | Drizzle | TypeORM 1.0 | **Turbine 0.27** | Verdict |
|---|---|---|---|---|---|
| **Single-query nested relations (GA)** | ⚠️ preview | ⚠️ per-dialect | ⚠️ | ✅ | **Wedge — press it** |
| **Typed nested inference, no codegen engine** | ✅ (codegen) | ✅ | ⚠️ weak | ✅ | **Wedge** |
| Referential actions (onDelete/onUpdate) in schema | ✅ | ✅ | ✅ | ❌ | **BORROW (P1, top item)** |
| Enum type in code-first DDL | ✅ | ✅ (`pgEnum`) | ✅ | ❌ (read-only via introspect) | BORROW (P1) |
| `vector` column type in DDL | ⚠️ | ✅ | ❌ | ❌ (query-only) | BORROW (P1 — completes the pgvector story) |
| Array column types in DDL | ✅ | ✅ | ✅ | ❌ (filters only) | BORROW (P1) |
| Check constraints in DDL | ❌ | ✅ | ✅ | ❌ | BORROW (P2) |
| orderBy nulls first/last | ✅ | ✅ | ✅ | ❌ | BORROW (P0 — trivial) |
| Relation `_count` inside `with`/include | ✅ | ⚠️ | ⚠️ | ❌ | BORROW (P1) |
| orderBy relation / by relation count | ✅ | ⚠️ | ⚠️ | ❌ | BORROW (P2) |
| Global filters (soft-delete / tenancy) | ⚠️ ext | ❌ | ⚠️ | ❌ | BORROW (P1 — differentiator, from MikroORM) |
| Validator gen (Zod etc.) | ⚠️ community | ✅ first-party | ❌ | ❌ | BORROW (P2) |
| MCP server / agent skills | ✅ | ✅ | ❌ | ❌ | BORROW (P1 — both leaders shipped in the last year) |
| Read replicas | ✅ ext | ✅ `withReplicas` | ⚠️ | ❌ | BORROW (P2) |
| Seed-as-code / factories | ✅ | ✅ `drizzle-seed` | ⚠️ | ❌ (.sql only) | BORROW (P2) |
| `migrate deploy` (CI-safe alias) | ✅ | ✅ | ✅ | ⚠️ (`up` is the path) | BORROW (P0 — naming/ergonomics) |
| Views / materialized views | ⚠️ preview | ✅ | ✅ | ❌ | P3 watch |
| Multi-schema | ✅ GA | ✅ | ✅ | ❌ (single-schema) | P3 watch |
| Generated columns | ❌ | ✅ | ✅ | ❌ | P3 watch |
| Client extensions (`$extends`) | ✅ GA | ❌ | ❌ | ❌ (`$use` only) | P3 watch |
| Result caching layer | ✅ paid | ✅ | ✅ | ❌ | P3 watch |
| Set ops / CTE / window builder | ❌ | ✅ | ✅ QB | ❌ (sql`` covers) | OUT-OF-SCOPE |
| Implicit m2m (managed join table) | ✅ | ❌ | ✅ | ❌ explicit-only | OUT-OF-SCOPE |
| Schema DSL / VS Code language ext | ✅ | n/a | n/a | n/a (TS-native) | OUT-OF-SCOPE |
| Unit of Work / identity map | ❌ | ❌ | ❌ | ❌ | OUT-OF-SCOPE (MikroORM's turf) |
| MongoDB / Oracle / SAP / Spanner | ❌ (dropped) / n/a | ❌ | ✅ | ❌ | OUT-OF-SCOPE |
| Hosted proxy / commercial cache (Accelerate) | ✅ paid | ⚠️ Gateway | ❌ | ❌ | OUT-OF-SCOPE (for now) |
| Polymorphic relations | ❌ | ❌ | ⚠️ | ❌ | OUT-OF-SCOPE / revisit on demand |

## Design decisions that need fixing (not just parity)

1. **The schema story is asymmetric.** Introspection *reads* enums, and query filters *use* arrays/vectors — but code-first `defineSchema` can't *define* an enum, array, or vector column, and can't express `ON DELETE CASCADE` or CHECK. Anyone starting code-first (the flow the docs push) hits a wall on their first real schema and must hand-write SQL migrations for it. This is the single biggest adoption blocker found.
2. **Two schema flows, no single source of truth.** Code-first (`defineSchema` → DDL) and DB-first (`introspect` → codegen) are parallel, disconnected pipelines. Competitors converged: Drizzle's schema objects are the one truth; Prisma's PSL is. Turbine should pick one canonical loop (code-first with `pull` reconciling into it) and document it as such.
3. **Seed is a `.sql` file.** Everyone else does seed-as-code with faker/factories. Cheap to fix, disproportionately visible in tutorials.
4. **`$use` middleware can't modify queries.** Fine as a constraint, but Prisma killed `$use` for `$extends` precisely because users want computed fields and query interception. Don't clone `$extends`; do add a small result-extension hook (computed fields on parse) when demand appears.
5. **Stale-comparison risk in marketing.** TypeORM-is-dead framing is now wrong; Prisma 7 is Rust-free (the "1.6 MB WASM engine" jab needs updating to whatever's currently true).

## Roadmap — what to build next

**P0 — this week**
- `orderBy: { col: { sort: 'asc', nulls: 'last' } }` → `NULLS FIRST/LAST`. Pure `builder.ts` + types change; all three competitors have it.
- `turbine migrate deploy` as a non-interactive, CI-safe alias of `up` (no prompts, exit codes, `--dry-run`). Naming matters — every CI recipe on the internet says "deploy".
- Marketing/docs currency pass: TypeORM 1.0, Prisma 7 Rust-free, Drizzle v1-beta framing (attack "still beta", not "no features").

**P1 — this month**
- **Referential actions**: `references: { table, onDelete: 'cascade' | 'restrict' | 'setNull' | ..., onUpdate }` in `schema-builder.ts`, DDL in `schema-sql.ts`, round-trip through introspect + diff. Top adoption blocker.
- **Enum + array + `vector(n)` column types in code-first DDL** (enum needs `CREATE TYPE` + diff support; vector completes an existing wedge feature).
- **Relation `_count` in `with`** — `with: { posts: { _count: true } }` compiles to a correlated `COUNT(*)` subquery; fits the json_agg architecture naturally.
- **Global filters** (from MikroORM): client-level auto-applied where-predicates per table with per-query opt-out — soft-delete and multi-tenancy in one feature, injected at build time in `QueryInterface`. Nobody in the direct cohort has this first-party; it compounds the RLS/sessionContext story.
- **`turbine mcp`**: MCP server exposing schema, migrate status/up (guarded), doctor, and read-only query explain. Prisma and Drizzle both made AI-agent tooling a headline in the last 12 months; Turbine is well-positioned (zero-dep CLI already exists).

**P2 — this quarter**
- Zod schema generation from `SchemaMetadata` (a `generate --zod` flag; devDep-only, keeps the zero-dep rule).
- Seed-as-code: `turbine seed` runs `seed.ts` (tsx) in addition to `.sql`; optional tiny factory helper.
- Check constraints in `defineSchema` + diff.
- `withReplicas`-style read-replica routing (reads → replica pool, writes + tx → primary; the `PgCompatPool` seam makes this cheap).
- Relation orderBy / order-by-relation-count.

**P3 — watch, don't build yet**
- Views/materialized views in introspect + codegen; multi-schema clients; generated columns; result caching (dangerous to get wrong — Drizzle shipped cache bugs in beta); `$extends`-style extensions; ESLint plugin (runtime empty-where guard already covers the main hazard); batch `$transaction([...])` array form (pipeline already covers the use case — consider an alias only if migrating-from-Prisma feedback demands it).

## What to deliberately NOT build

- **A schema DSL / new file format** — would make Turbine a worse Prisma. TS-native schema is why no VS Code extension, no generate-on-every-change loop, and no PSL learning curve are needed.
- **Unit of Work / identity map / change tracking** — worse MikroORM. Conflicts directly with the stateless, explicit, SQL-visible model that makes Turbine predictable in serverless.
- **Implicit (managed) m2m join tables** — worse Prisma; magic join tables are one of Prisma's most-regretted features (naming, migration surprises). Explicit `through` is the better call — document it as a stance.
- **MongoDB / Oracle / SAP / Spanner breadth** — worse TypeORM. Prisma just *dropped* Mongo in v7; enterprise-DB breadth is TypeORM's moat and its maintenance tax. The Dialect seam + E017 fail-loud posture is the right scope.
- **A full SQL builder surface (set ops, window functions, CTE builders)** — worse Kysely/Drizzle. `client.sql<T>` is the escape hatch; keep the query API Prisma-shaped and small.
- **A hosted proxy/cache (Accelerate clone)** — a product business, not a library feature; revisit only if a commercial layer is deliberately chosen.
- **A generic plugin/extension platform** — Drizzle survives without one; a sprawling extension API is a maintenance sink that would dilute the small-core wedge.

## Proportional-investment note

Turbine's position is unusually good: the wedge features are things the market leader has kept in preview for 2+ years. The risk isn't missing features — it's dilution. Close the **schema-completeness hole** (referential actions, enums, arrays, vector, nulls ordering) because it blocks people from *starting*; ship **global filters + MCP** because they extend the wedge; and explicitly refuse the breadth games (DB matrix, SQL-builder surface, UoW). Re-run this audit quarterly — Drizzle v1.0 stable and Prisma Next will both land within that window.
