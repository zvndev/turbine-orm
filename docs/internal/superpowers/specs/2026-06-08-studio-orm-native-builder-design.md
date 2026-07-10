# Turbine Studio — ORM-native query builder (remove raw SQL, deepen the Builder)

**Date:** 2026-06-08
**Status:** Design — awaiting approval
**Scope:** A + B ("Deepen findMany"). Query-type selector / vector KNN (C) explicitly deferred.

## Goal

Make Turbine Studio a **Turbine-ORM-only** query tool. Remove the raw-SQL surface
entirely, make the visual **Builder** the single primary surface, and deepen it so a
user can compose an arbitrarily-nested `findMany` by picking fields and relations from
a starting table — never writing SQL.

## Why

Studio today ships a raw-SQL console *and* a visual Builder. Showing raw SQL
undercuts the product's whole premise (the typed ORM). Per the product owner:
"I don't want the SQL version shown anywhere, just use Turbine ORM." The Builder
already exists and works for the top level, but relation/field picking is shallow —
it doesn't let you drill into a relation and pick *its* fields and *its* relations.

## Non-goals (this pass)

- Query types beyond `findMany` (`findUnique`/`count`/`aggregate`/`groupBy`+`having`) — deferred (scope C).
- Vector KNN ordering in the builder — deferred (scope C).
- Any write/mutation capability — Studio stays strictly read-only.
- Showing compiled SQL anywhere in the UI — removed, not relocated.

## Current state (verified)

- `src/cli/studio.ts` (~807 LOC) serves the UI shell + JSON API. Endpoints:
  `/api/schema`, `/api/tables/:name`, `/api/query` (raw SQL — **to remove**),
  `/api/builder` (Turbine `findMany` spec runner — **keep, it's the core**),
  `/api/saved-queries` GET/POST/DELETE (kinds `'sql' | 'builder'` — **keep, builder-only**).
- `/api/builder` already calls `QueryInterface.buildFindMany(args)` with the full
  `FindManyArgs`, runs it inside `BEGIN READ ONLY` + `set_config` timeout, and returns
  `{ sql, columns, rows, rowCount, elapsedMs }`. **It already supports arbitrarily
  nested `with`** — the backend needs no new query capability for B.
- `src/cli/studio-ui.html` (~3948 LOC, built into `studio-ui.generated.ts` by
  `scripts/build-studio-ui.mjs`) has tabs: Data, Schema, SQL (**to remove**), Builder.
  Builder today: table picker, where (AND/OR/NOT), top-level relation include-toggles,
  orderBy/limit, select/omit chips, live `findMany` TS preview, Run, Save, Copy TS.
- `/api/schema` returns every table's columns (name, tsType, pgType, attrs) and
  `relations` (type incl. `manyToMany`, target, foreignKey/referenceKey). Self-relations
  appear as ordinary hasMany/belongsTo with `from === to`. **All metadata the recursive
  picker needs is already served.**

## Design

### A. Make Studio ORM-only

**Server (`studio.ts`):**
1. Delete the `/api/query` route + its handler `apiQuery` and the `isReadOnlyStatement`
   raw-SQL guard usage tied to it. (Keep `BEGIN READ ONLY` + timeout on `/api/builder`.)
2. `SavedQuery.kind` becomes `'builder'` only. On load, **drop any persisted `'sql'`
   entries** (forward-compat for existing `studio-queries.json` files) rather than error.
   `apiCreateSavedQuery` rejects `kind !== 'builder'`.
3. No other endpoint changes.

**UI (`studio-ui.html`):**
4. Remove the SQL `<section class="pane sql-pane">` + its tab button + all `sql*` JS
   (editor, run, format, copy, save-SQL, results) and `sqlEditor`/`sqlResults` wiring.
5. Make **Builder the default active tab**, first in the tab order, label it **"Query"**
   (keep the grid icon). Tab order: Query, Data, Schema.
6. Remove the compiled-SQL display from the Builder preview — show **only** the generated
   Turbine TypeScript + the results grid. (`/api/builder` still returns `sql`; the UI
   simply ignores it.)
7. Saved-queries sidebar shows builder queries only (no `kind` badge needed anymore).

### B. Deepen the Builder — recursive relation/field picking

The core change. All client-side; `/api/builder` is unchanged.

**Query-spec model (client state).** Represent the in-progress query as a recursive node:

```
QueryNode = {
  table: string,                 // table this node queries
  fields: Set<string>,           // checked columns -> select (empty = all columns)
  where:  WhereGroup,            // existing AND/OR/NOT clause builder, per level
  orderBy: { field, dir }[],    // per level
  limit?: number,                // per level
  with: { [relationName]: QueryNode }  // expanded relations -> nested findMany args
}
```

**Picker UI (recursive, in `builderLeft`).** Render the root table node, then for each
node:
- **Fields** — a checkbox list of the table's columns (from `/api/schema`). None checked
  = select all (emit no `select`). Any checked = emit `select`.
- **Relations** — the table's relations (hasMany / belongsTo / hasOne / **manyToMany** /
  self-relations). Each relation is an expandable row (reuse existing `.with-rel` styles).
  Expanding a relation:
  - adds it to `with`,
  - renders a **nested QueryNode picker for the relation's target table** (same component,
    one level deeper) — this is the recursion that delivers "pick its fields and its
    relations."
  - shows cardinality + target in the header (`posts → many`, `mentor → one`).
  - Collapsing/unchecking removes it from `with`.
- **where / orderBy / limit** controls available at every level (top level already has
  them; nest the same controls inside each expanded relation node).
- A **depth guard** in the UI matching the engine's depth-10 cap (stop offering deeper
  expansion at depth 9, with a hint) so the UI can't build a query the engine rejects.
- **Self-relation safety:** expanding `author → mentor → mentor → …` is allowed (legit
  back-reference) but bounded by the same depth guard.

**Codegen + run.** A pure function `nodeToArgs(node) -> FindManyArgs` walks the tree to
build the nested `{ select, where, orderBy, limit, with: { rel: nodeToArgs(child) } }`
object. Two consumers:
- **TS preview:** `await client.<rootTable>.findMany(<pretty-printed args>)` in `builderPreview`.
- **Run:** POST `{ table: rootTable, args: nodeToArgs(root) }` to `/api/builder`, render
  rows. (Nested relation rows arrive as JSON arrays — render with the existing
  `.cell-json` expander.)

**Surface the v0.18 relation types.** No special-casing needed: the picker iterates
`table.relations` and renders by `rel.type`. `manyToMany` and self-relations already
appear; just ensure the cardinality label reads correctly (`manyToMany` → "many") and
that selecting a m2m relation emits a plain `with: { tags: true | {...} }` (the engine
resolves the junction). Verify against `_t2b_*` / dogfood schemas.

### Polish (from the E2E assessment, fold in)

- **Self-host the fonts.** The HTML links `fonts.googleapis.com` but CSP is `font-src
  'self'` / `style-src 'self' 'unsafe-inline'`, so the webfont is blocked and throws a
  console error every load. Inline/self-host Inter + Geist Mono (keeps the offline,
  zero-external-resource promise) or drop the link for a system stack. Do **not** loosen CSP.
- **Clamp `reltuples = -1`.** PG14+ returns `-1` from `pg_class.reltuples` before ANALYZE;
  the sidebar shows "-1". In `apiSchema`, clamp negatives to 0 and render `~N` for estimates.
- **Inline favicon.** Serve a data-URI favicon (or a 204 `/favicon.ico` route) to kill the
  404/401 on first load.

## Components & boundaries

- `studio.ts` — server; loses one endpoint + the sql saved-kind; otherwise stable.
- `studio-ui.html` — UI; loses the SQL pane, gains the recursive picker + `nodeToArgs`
  codegen. The recursive picker is one self-contained render function keyed on a QueryNode;
  `nodeToArgs` is a pure function (unit-testable in isolation by extracting it, optional).
- `build-studio-ui.mjs` — unchanged (still inlines HTML → generated.ts).

## Error handling

- Invalid args (e.g. a where value that doesn't typecheck) → `/api/builder` already
  returns `400 { error }`; surface it in the results panel (existing error UX).
- Depth cap: UI prevents exceeding depth 10; if somehow exceeded, the engine throws
  `CircularRelationError` and the UI shows it.
- Empty/legacy saved-queries with `kind:'sql'` are silently dropped on load.

## Testing

- `src/test/studio.test.ts` — remove assertions for `/api/query`; assert the route now
  404s. Add: `/api/builder` with a **nested** `with` (2–3 levels incl. a m2m and a
  self-relation) returns correctly-nested rows. Assert `apiCreateSavedQuery` rejects
  `kind:'sql'` and that loading a file containing a legacy `sql` entry drops it.
- If `nodeToArgs` is extracted to a testable module, add a unit test: a built QueryNode
  tree → expected `FindManyArgs` (pure, no DB).
- Manual/E2E (rerun the studio assessment agent): SQL tab gone, Query is default, drill
  into a relation → pick nested fields → Run → nested results; fonts load with no console
  error; no `-1` row counts.

## Release

Own change, **separate from the v0.18 publish** (which is merged to main but blocked on
the npm token). Ship as **v0.19.0** (a Studio feature release) on its own branch off
`main` once v0.18 is published — or fold into v0.18 only if v0.18 hasn't shipped by the
time this lands. Per AGENTS.md: update `site/` (the Studio docs/screenshots), CHANGELOG,
version bump, publish + deploy + verify.

## Risks

- `studio-ui.html` is a large single file; the recursive picker adds real frontend
  complexity. Mitigate by keeping the picker one render function + one pure `nodeToArgs`,
  and leaning on the existing `.with-rel` styles.
- Removing raw SQL removes an escape hatch some power users like. Accepted per explicit
  product decision; the typed Builder + (future scope C) cover the real needs, and the
  CLI still allows raw access for true one-offs.
