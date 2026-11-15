# Atomic declarative seeds for local D1

`seed --engine d1` inserts a complete, bounded JSON seed plan into an initialized
local D1 project in one native atomic batch. This is local Miniflare/workerd
qualification. Hosted Cloudflare D1 and interactive callback transactions are
separate capabilities.

Initialize the project, put the complete migration history in
`migrationsDir/plan.json`, and run `migrate deploy`. Then write
`migrationsDir/seed.json` and run `seed` (alias `s`). No seed file is scaffolded or
executed by `init`. Existing commands retain their behavior.

```json
{
  "version": 1,
  "operations": [
    {
      "table": "users",
      "columns": ["id", "name", "active", "avatar"],
      "rows": [[1, "Ada", true, { "bytes": [0, 127, 255] }]]
    }
  ]
}
```

The separately supplied CLI type export enables `import type { D1SeedPlan } from
 'turbine-orm/cli'` and `satisfies D1SeedPlan` in trusted TypeScript authoring
code. The CLI reads JSON only. It does not import executable seed files.

## Plan and value contract

Every operation is an insert with explicit table, columns and complete row
arrays. Operation and row order are preserved. The plan permits 1 through 100
operations, 1 through 100 distinct columns per operation, and at most 1,000 total
rows. Each operation needs at least one row. Names use ASCII letters, digits and
underscores, start with a letter or underscore, and contain at most 128
characters. Case-insensitive duplicate columns and reserved engine/journal name
fragments (`_turbine_`, `sqlite_`, `d1_`, `_cf_`) refuse.

Values are null, well-formed Unicode strings, booleans, finite numbers with safe integers, or
`{"bytes":[0,255]}` with integers from 0 through 255. Booleans bind as 0/1. Use
strings for dates, decimal precision and integers outside JavaScript's safe
range. SQLite may normalize numeric representations such as negative zero.
Unpaired UTF-16 surrogates refuse during capture before runtime loading; valid
surrogate pairs, embedded NULs and replacement characters are preserved.
Objects, arrays as cells, undefined, BigInt and arbitrary SQL refuse. No expression,
DDL, callback, replacement, ignore, upsert or RETURNING capability is admitted.

The file and total captured bound payload each have a 10 MB limit. Individual
bound values have a 1 MB limit. Limits use decimal bytes; the file includes JSON
encoding overhead. Complete arrays, strings, values and byte copies are captured
before optional runtime loading or dispatch. Later edits to the file cannot
change the captured invocation. Each row becomes one generated `INSERT OR ABORT` using
quoted admitted identifiers and numbered placeholders; values are bound, never
interpolated into SQL. The explicit abort policy overrides schema-level conflict
policies, including `REPLACE` and `IGNORE`: conflicting inserts abort the atomic
batch instead of deleting existing rows, replacing values or skipping seed rows.

The 1,000-row plan and 100-parameter row were exercised against local
Miniflare 4.20260730.0 and workerd package 1.20260730.1, executable 2026-07-30.
Those are Turbine admission limits and local observations. They do not establish
hosted D1 service limits or a universal capacity guarantee. Native resource
failures remain possible below these bounds.

## Admission and atomicity

The existing project path, initialized marker, private database and sidecar,
exclusive lock, runtime startup and disposal checks apply. The seed file must
be a regular unaliased project file with no symlink ancestry, disjoint from
persistence, generated output, config and the migration plan. Missing optional
Miniflare or malformed plans refuse before database startup or seed effects.

The complete migration history must be valid and fully deployed. Existing
triggers, views, virtual tables and schema SQL outside the conservative migration
admission policy refuse. Target tables must be ordinary existing tables. Columns
must exist and be writable, excluding generated and hidden columns. Defaults and
native primary key, uniqueness, foreign key, not-null and check constraints
remain active. Omitted columns use native defaults; this does not provide ORM
hooks, tenant filtering or PII policy enforcement.

After admission reads, the first statement in the same write batch asserts the
exact SQLite schema snapshot. Added triggers, views or other schema changes fail
the assertion before seed writes. Cooperating CLI commands retain the existing
exclusive project lock. This is a trusted local project workflow, not a sandbox
for hostile JavaScript, malicious bindings, filesystem races or administrators
bypassing project ownership. It admits no application callbacks or external
effects. No reviewed migration/runtime helper is expanded.

A native constraint error rolls back the entire batch. There is no partial
commit, chunking or automatic retry. No new journal or schema object is created
for seeding. Seeds do not have migration idempotency: running the same plan again
can insert duplicates or fail constraints.

## Results and recovery

An acknowledged result is `{"insertedRows":1,"statements":1}`. Both numbers count
acknowledged insert operations, one per supplied row. `statements` excludes the
schema assertion and admission SELECTs. Every insert result must have no returned
rows and `meta.changes === 1`; the schema assertion must acknowledge exactly one
successful row. Entities, generated keys, callback completion and external
effects are not reported.

`D1SeedError` retains its cause and records `phase` and `outcome`. Admission/read
failures are `not-dispatched` with respect to seed writes. After native batch
invocation, exceptions, constraint errors and lost, short or malformed responses
are conservatively `dispatch` / `unknown`. A real SQL failure can roll back while
a lost response can hide a committed batch. Interruption is also no evidence of
rollback. Inspect durable rows before a manual retry. The CLI never retries an
unknown seed automatically and has no seed journal that can reconcile it for you.
Existing disposal failures retain the original outcome and ownership policy.

The implementation and installed-archive controls live in
`src/test/d1-seed.test.ts` and
`src/test/fixtures/d1-seed-installed.mjs`. Shared type/checker integration
is supplied separately as an exact UNAPPLIED patch. No package
export, dependency, size budget or coverage floor changes are required.
