# Parity Sprint (v0.28.0) Implementation Plan

> **For agentic workers:** Each workstream (WS) below is a self-contained spec dispatched to one implementation agent in an isolated worktree. Follow TDD: for every behavior, write the failing unit test first (`src/test/*.test.ts`, using `makeQuery()`/mock schemas from `src/test/helpers.ts` — no DB needed), watch it fail, implement, watch it pass, commit. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every BORROW gap from `docs/strategy/parity-audit-2026-07.md` (P0–P2 fully, P3 safe subset) for release as turbine-orm 0.28.0.

**Architecture:** Six parallel wave-1 workstreams in git worktrees (disjoint file ownership), two wave-2 workstreams that depend on wave-1 merges, then an integration review + docs wave. Integration branch: `sprint/v0.28.0-parity`.

**Tech Stack:** TypeScript ESM (NodeNext, `.js` import extensions), Node 22+, `pg` only at runtime, node:test via tsx, Biome lint.

## Global Constraints (every workstream)

- Runtime `dependencies` stays exactly `{ pg, @types/pg }`. No new runtime deps. Zod/tsx are user-side devDeps, referenced only in generated code / spawned processes.
- All identifiers through `quoteIdent()`; all values as `$N` params; no eval/new Function.
- `query/` never imports `client.ts`. CLI never imports `client.ts`.
- Don't break the existing public API (`findMany`, `with`, `where`, etc.) — additive only.
- Non-Postgres engines: any new Postgres-only SQL must gate on the relevant `Dialect` capability flag and throw `UnsupportedFeatureError` (E017) — never emit broken SQL. Add a flag if none fits.
- Error codes: reuse E001–E017; new error kinds need a new code appended (E018+) following the "Adding a new error type" recipe in CLAUDE.md.
- Verification gate per WS: `npm run typecheck` && `npm run test:unit` && `npm run lint` green. Integration tests (`skipGate`) will run in CI.
- Commit style: match repo history (`feat: ...`, `fix: ...`), frequent commits.
- Update `src/test/with-inference.test.ts`-style compile-time assertions when types change.

---

## WAVE 1 (parallel, isolated worktrees)

### WS-A: Query ergonomics — nulls ordering, relation `_count`, relation orderBy

**Files:** Modify `src/query/types.ts`, `src/query/builder.ts`, `src/query/batched-loader.ts`. Tests: `src/test/order-by-nulls.test.ts`, `src/test/relation-count.test.ts`, `src/test/relation-order-by.test.ts` (new).

**Interfaces (produces):**
```ts
// types.ts
export interface OrderBySpec { sort: OrderDirection; nulls?: 'first' | 'last' }
export type OrderByClause = Record<string, OrderDirection | OrderBySpec | VectorOrderBy | RelationOrderBy>;
export type RelationOrderBy = { _count: OrderDirection } | Record<string, OrderDirection | OrderBySpec>; // key = relation name
// WithClause gains reserved key:
_count?: true | Record<string, true>;   // true = all relations of the table
// Result rows gain: _count: Record<relationName, number>
```

- [ ] **A1 — NULLS FIRST/LAST**: `orderBy: { lastLoginAt: { sort: 'desc', nulls: 'last' } }` → `ORDER BY "last_login_at" DESC NULLS LAST`. Applies everywhere `OrderByClause` is compiled (findMany, `WithOptions.orderBy` inner subqueries, groupBy, streams). Plain `'asc' | 'desc'` unchanged. Unknown-field validation unchanged (E003).
- [ ] **A2 — relation `_count` in `with`**: `with: { _count: true }` or `with: { _count: { posts: true } }` adds one correlated `(SELECT COUNT(*) …)` scalar subquery per selected to-many relation (hasMany + manyToMany via junction), aliased `_count__<rel>`, assembled by `parseNestedRow` into a `_count` object. Errors: E005 on unknown relation, E003 if used on a to-one relation. Batched strategy (`batched-loader.ts`): one `SELECT fk, COUNT(*) … WHERE fk = ANY($1) GROUP BY fk` per counted relation, stitched client-side — output identical to join strategy (byte-equality test like the existing batched-loader tests).
- [ ] **A3 — relation orderBy**: to-many `orderBy: { posts: { _count: 'desc' } }` → correlated count subquery in ORDER BY; to-one `orderBy: { author: { name: 'asc' } }` → correlated scalar subquery on the target column (supports OrderBySpec nulls too). Validation: relation must exist (E005); to-many only allows `_count`; to-one only allows real columns (E003). Type-level: `RelationOrderBy` keyed off the table's relations.
- [ ] **A4 — type inference**: `WithResult` extended so `_count` appears in the result type as `{ [K in keyof selected]: number }`. Add compile-time assertions to `with-inference.test.ts`.

### WS-B: Schema completeness — referential actions, enum/array/vector types, check constraints

**Files:** Modify `src/schema-builder.ts`, `src/schema-sql.ts` (DDL + `schemaDiff`), `src/introspect.ts`, `src/schema.ts` (type mapping), `src/generate.ts` (codegen types). Tests: extend `src/test/schema-builder.test.ts`, `src/test/schema-sql.test.ts`, `src/test/schema-diff.test.ts`; new `src/test/referential-actions.test.ts`, `src/test/column-types-extended.test.ts`.

**Interfaces (produces):**
```ts
export type ReferentialAction = 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';
// column def: references accepts either the existing 'table.column' string or:
references?: string | { target: string; onDelete?: ReferentialAction; onUpdate?: ReferentialAction };
// fluent: .references(target: string, opts?: { onDelete?: ReferentialAction; onUpdate?: ReferentialAction })
// new column types:
{ type: 'enum'; enumName: string }              // → "enum_name" in DDL
{ type: <any scalar>; array: true }             // → e.g. text[]
{ type: 'vector'; dimensions: number }          // → vector(1536)
check?: string;                                  // column-level raw SQL expression
// table-level:
checks?: readonly { name?: string; expression: string }[];
// schema-level enums (single declaration point):
defineSchema(tables, { enums?: Record<string, readonly string[]> })  // adapt to the actual defineSchema signature — if it takes only tables, add an options second param
```

- [ ] **B1 — referential actions**: DDL emits `REFERENCES "t"("c") ON DELETE CASCADE ON UPDATE …` (omit clauses when unset = NO ACTION). `introspect.ts` reads `pg_constraint.confdeltype/confupdtype` (map a/r/c/n/d) into `TableMetadata` relations/columns. `schemaDiff` detects action changes → `ALTER TABLE … DROP CONSTRAINT + ADD CONSTRAINT` (non-destructive). Round-trip test: defineSchema → DDL → (mock) introspected metadata → diff = empty.
- [ ] **B2 — enums code-first**: `CREATE TYPE "post_status" AS ENUM ('draft','published')` emitted before tables; diff supports `ALTER TYPE … ADD VALUE` (append-only; value removal/reorder flagged destructive via `cli/destructive.ts` patterns). Codegen: enum columns → string-literal union types. Introspection already reads enums — wire the two together so pull→generate and defineSchema→push agree.
- [ ] **B3 — array types**: `array: true` → `type[]` DDL; introspect detects `_`-prefixed/ARRAY data types; codegen maps to `T[]`; existing `ArrayFilter` query ops now documented as fully supported end-to-end.
- [ ] **B4 — vector type**: `{ type: 'vector', dimensions: n }` → `vector(n)`; DDL for a schema containing vector columns prepends `CREATE EXTENSION IF NOT EXISTS vector;` (behind an option `extensions: 'auto' | 'manual'`, default auto in push, comment-only in migration files); codegen maps to `number[]`. Gate DDL on Postgres dialect (E017 elsewhere).
- [ ] **B5 — check constraints**: column `check` → inline `CHECK (expr)`; table `checks` → named `CONSTRAINT "name" CHECK (expr)`. Introspect reads `pg_constraint contype='c'` (exclude NOT NULL artifacts). Diff: add/drop; expression change = drop+add. Removal is not destructive; flag expression *tightening* is undetectable — document.

### WS-C: CLI — `migrate deploy` + seed-as-code  *(Codex 5.5 high)*

**Files:** Modify `src/cli/index.ts` (command wiring + help), `src/cli/migrate.ts`, `src/cli/config.ts` (seed path), `src/index.ts` (export `defineSeed`). New `src/seed.ts`. Tests: `src/test/migrate-deploy.test.ts`, `src/test/seed-code.test.ts` (unit-level: argument parsing, file resolution, non-TTY behavior; DB parts behind `skipGate`).

- [ ] **C1 — `turbine migrate deploy`**: non-interactive production apply. Behavior: never prompts (works with no TTY); applies all pending UP migrations inside the existing advisory-lock + per-migration-transaction machinery; refuses to run (exit 1, clear message) on checksum mismatch or missing migration files; exit 0 with "N applied" summary; `--dry-run` lists pending without applying. It must NOT auto-generate, seed, or push. Destructive-guard: deploy applies files as-written (guards run at `create`/`up` authoring time) — but keep the E-code error surfaces intact.
- [ ] **C2 — seed-as-code**: `turbine seed` resolves `seed` path from config (`turbine.config.*` new `seed` field) or default candidates `seed.ts`/`seed.js`/`seed.sql` (first found; explicit config wins). `.sql` behaves as today. `.ts` → spawn `npx tsx <file>` (inherit env incl. DATABASE_URL; clear error if tsx missing: "install tsx or use seed.js/seed.sql"). `.js` → dynamic `import()` and if the default export is a function, call it. New `src/seed.ts` exports `defineSeed(fn: (db: TurbineClient) => Promise<void>)` which returns a function that, when the module is executed directly, constructs a client from DATABASE_URL, runs fn, disconnects; exported from package root. Docs snippet in help text.

### WS-D: `turbine mcp` — zero-dep MCP server  *(Codex 5.5 high)*

**Files:** New `src/cli/mcp.ts`. Modify `src/cli/index.ts` (command + help). Tests: `src/test/mcp.test.ts` (protocol handshake + tool dispatch over in-memory streams; DB-touching tools behind `skipGate`).

- [ ] **D1 — JSON-RPC 2.0 stdio transport**, hand-rolled (zero-dep): newline-delimited JSON on stdin/stdout; handle `initialize` (respond protocolVersion `2025-06-18`, serverInfo `{name:'turbine-orm', version}`, capabilities `{tools:{}}`), `notifications/initialized`, `tools/list`, `tools/call`, graceful `shutdown`. Malformed input → JSON-RPC error, never crash.
- [ ] **D2 — read-only tools** (all DB access inside `BEGIN READ ONLY` with statement_timeout via `set_config`, mirroring `cli/studio.ts` patterns — copy its approach, not ad-hoc): `schema_overview` (tables + row estimates), `table_detail(table)` (columns/indexes/relations from introspection), `migrate_status`, `doctor_report` (index-advisor findings), `explain_query(sql)` — SELECT-only (reject anything else by first keyword + no semicolons), `EXPLAIN (FORMAT JSON)`, `sample_rows(table, limit<=50)` — identifier validated against introspected schema. NO write tools in v1. `turbine mcp --url <db>` uses `requireUrl()` like other commands.

### WS-E: Read replicas

**Files:** Modify `src/client.ts` (config + routing), `src/index.ts` (types export). Tests: `src/test/read-replicas.test.ts` (mock pools implementing `PgCompatPool`; assert routing: reads round-robin replicas, writes/tx/raw/pipeline hit primary; `$primary()` escape hatch).

**Interfaces (produces):**
```ts
TurbineConfig.replicas?: readonly (string | PgCompatPool)[];
client.$primary(): TurbineClient   // same schema/config, bound to primary only (cached instance)
```

- [ ] **E1 — routing**: read-only ops outside transactions (`findMany`, `findFirst`, `findUnique`, `*OrThrow`, `count`, `aggregate`, `groupBy`, `findManyStream`) execute on a round-robin replica pool; ALL writes, `$transaction` bodies, `pipeline`, `sql`\`\`/raw, `$listen`/`$notify`, and observe flushes stay on primary. String replicas construct owned `pg.Pool`s (type parsers registered once, same rules as primary); external pool replicas follow the external-pool contract (no parser registration, caller lifecycle). `disconnect()` closes owned replica pools. Zero replicas configured = exactly today's behavior (no code path change).

### WS-F: Docs currency pass

**Files:** `README.md`, `site/` comparison + migration pages (`migrate-from-prisma`, `migrate-from-drizzle`, compatibility page), any "vs" copy.

- [ ] **F1**: TypeORM references → 1.0 (May 2026), actively maintained (attack type-inference + relation SQL instead of "abandoned"). Prisma references → Prisma 7 Rust-free query compiler, driver adapters now mandatory, relationJoins/typedSql/FTS/views still preview (verify each claim against prisma.io docs before writing). Drizzle references → v1.0 still beta (RQBv2), no typed errors, no down migrations. Add a short Kysely paragraph on the relations recipe (`jsonArrayFrom`) vs Turbine typed depth + date coercion. No benchmark numbers added or changed. Keep the existing tone; factual, no FUD.

---

## WAVE 2 (after wave-1 merge; sequential dispatch, worktrees)

### WS-G: Global filters (soft-delete / multi-tenancy)

**Files:** Modify `src/client.ts` (config plumb-through), `src/query/types.ts`, `src/query/builder.ts` (where-merge at all entry points), `src/query/batched-loader.ts` (relation loads). Tests: `src/test/global-filters.test.ts`.

**Interfaces (produces):**
```ts
TurbineConfig.globalFilters?: { [tableAccessor: string]: WhereClause<any> | (() => WhereClause<any>) };
// per-query opt-out on all read/mutate arg types:
skipGlobalFilters?: true | readonly string[];   // true = all, array = named tables
```

- [ ] **G1**: filter is AND-merged into the compiled WHERE of every read (findMany/findFirst/findUnique/count/aggregate/groupBy/stream), every mutation (update/updateMany/delete/deleteMany, upsert's conflict UPDATE), and — critically — every relation subquery targeting a filtered table (join strategy AND batched strategy AND relation filters some/every/none AND `_count` from WS-A). `create`/`createMany` unaffected. Function filters evaluated per query build (enables per-request tenancy via closure). Interaction with the empty-where guard: a global filter does NOT satisfy the guard for update/delete (guard checks USER where) — test this explicitly. Interaction with sqlCache: filters participate in the cache key (function filters ⇒ compile the where and hash it, or bypass cache for that table — pick and document).

### WS-H: Zod generation + P3 safe subset

**Files:** Modify `src/generate.ts`, `src/cli/index.ts` (`--zod` flag), `src/introspect.ts` (generated columns + views), `src/client.ts` ($transaction overload), `src/query/builder.ts` (view write refusal). Tests: `src/test/generate-zod.test.ts`, `src/test/tx-batch.test.ts`, `src/test/views-generated.test.ts`.

- [ ] **H1 — `turbine generate --zod`**: emits `zod.ts` alongside types.ts importing `zod` (user devDep): per table `XSchema`, `XCreateSchema`, `XUpdateSchema` derived from column metadata (string/number/boolean/date/bigint/json/uuid/email-less; enums → `z.enum([...])`, arrays → `.array()`, nullable → `.nullable()`, defaults/PK optional in Create). Generated file only — no runtime zod import in the library.
- [ ] **H2 — batch `$transaction(DeferredQuery[])` overload**: executes the queries atomically in one BEGIN…COMMIT (reuse pipeline execution inside the tx connection), returns positionally-typed results tuple. Errors roll back all.
- [ ] **H3 — generated columns**: introspect `is_generated`/`generation_expression` → `isGenerated` on column metadata; codegen omits them from Create/Update input types; create/update paths reject them with E003 (clear message) before hitting pg.
- [ ] **H4 — views**: `generate`/`pull` gains `--include-views`: `information_schema.views` (+ matviews from pg_class relkind 'm'/'v') become tables with `isView: true`; codegen emits entity + findMany-family accessors; all write builders throw E003 "cannot write to view". No PK ⇒ findUnique-family excluded from generated types.

**Parked P3 items (do NOT implement — recorded for the next audit):** multi-schema clients (one client per schema works today; real demand unproven), result caching (correctness risk; Drizzle shipped cache bugs in beta), `$extends`-style computed fields (`$use` result transform already covers it), ESLint plugin (runtime empty-where guard covers the hazard).

---

## WAVE 3 — Integration, review, docs, release prep

- [ ] **I1**: Merge order into `sprint/v0.28.0-parity`: F → C → D → E → A → B → G → H (docs first = trivial; builder-heavy last-but-grouped). After each merge: `npm run typecheck && npm run test:unit && npm run lint`.
- [ ] **I2**: Two-model review of the full integration diff: `/code-review` + codex-pr-review; triage, fix confirmed findings.
- [ ] **I3**: Docs site pages/updates for every shipped feature (orderBy nulls, relation _count, relation orderBy, referential actions, enums/arrays/vector, checks, migrate deploy, seed-as-code, mcp, replicas, global filters, zod, tx batch, views) + CHANGELOG 0.28.0 + version bump + regenerate site version.ts.
- [ ] **I4**: Open PR to main; CI (real-DB engine matrix) is the integration-test gate. Release (npm publish + push) after PR green — per standing deploy convention.
