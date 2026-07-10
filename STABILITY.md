# Stability and Versioning Policy

This document tells you which parts of Turbine ORM you can depend on today, how breaking changes are handled, and what has to be true before we ship 1.0. It is written to be honest, not reassuring — if you are deciding whether to put Turbine under a production database, this is the page that should answer your "will the API move under me?" question.

Turbine is currently **0.x (pre-1.0)**. That is a real signal, and we treat it as one. See [The road to 1.0](#the-road-to-10) for exactly what it means and what would change at 1.0.

## What SemVer means for Turbine

Turbine follows [Semantic Versioning](https://semver.org/). Pre-1.0, the practical rules we hold ourselves to are:

- **Patch (`0.x.Y`)** — bug fixes and internal changes only. No documented behavior changes.
- **Minor (`0.X.0`)** — new features and, where unavoidable, breaking changes to the surfaces marked **Experimental** below. Breaking changes to a **Stable** surface are avoided; when one is truly necessary before 1.0, it ships in a minor with a migration note in the [CHANGELOG](./CHANGELOG.md) and the release notes.

After 1.0, breaking changes to any Stable surface will require a **major** version bump. The tiers below define what "Stable" buys you.

### Stable surfaces

These are the surfaces we intend to carry to 1.0 and beyond. We will not break them in a patch, and we work hard not to break them in a minor.

| Surface | What's covered |
|---|---|
| **Query API** | `findMany`, `findUnique`, `findFirst`, `findUniqueOrThrow`, `findFirstOrThrow`, `create`, `createMany`, `update`, `updateMany`, `delete`, `deleteMany`, `upsert`, `count`, `aggregate`, `groupBy` — including their `where`, `with`, `orderBy`, `select`, `omit`, and `limit`/cursor arguments and the types they return. |
| **`with`-clause type inference** | The compile-time return types produced by `with`, `select`, and `omit`. We treat a regression in inference as a bug, not a free minor change. |
| **Typed errors** | The `TurbineError` hierarchy and the **error codes** (`TURBINE_E001`–`TURBINE_E017`). A code, once assigned, keeps its meaning. Structured fields on errors (`.code`, `.columns`, `.constraint`, `.where`, `.cause`) are stable; human-readable `.message` *text* is not (see below). |
| **CLI commands** | `init`, `generate` / `pull`, `push`, `migrate create\|up\|down\|deploy\|status`, `seed`, `status`, `doctor`, `studio`, `mcp`. The migration file format (`-- UP` / `-- DOWN`, timestamp-prefixed `.sql`, SHA-256 checksums in `_turbine_migrations`) is stable. |
| **Client configuration** | `TurbineConfig` fields and the `$transaction`, `$use`, `$on`/`$off`, `pipeline`, and raw-SQL tagged-template APIs on `TurbineClient`. |

### Experimental surfaces

These work and are tested, but they are still moving. We may change their API or behavior in a **minor** release. Pin a version and read the CHANGELOG before upgrading if you depend on them.

| Surface | Why it's experimental |
|---|---|
| **Non-Postgres dialect adapters** (`src/adapters/` — CockroachDB, YugabyteDB) | These ride on PostgreSQL wire compatibility and are not yet covered by a full parity suite. Behavior may change as we expand coverage. |
| **Observability** (`db.$observe`, the `_turbine_metrics` table, `turbine observe`) | The metric schema, aggregation windows, and dashboard are subject to change. |
| **Serverless / edge binding** (`turbine-orm/serverless`, `turbineHttp`) | The query API it exposes is Stable; the *driver-binding contract* (which external pools we accept and how) may evolve as serverless Postgres drivers change. |

> **Note**
> The `_turbine_metrics` and `_turbine_migrations` tables and the `_turbine_*` naming prefix are reserved. Don't create your own tables with that prefix.

## Error message text is not part of the contract

Turbine errors are designed to be **safe to log**. By default (`errorMessages: 'safe'`), human-readable error messages include WHERE-clause *keys* and constraint/column *names*, but never the actual row values — so a `UniqueConstraintError` won't leak `alice@example.com` into Sentry.

Two consequences for stability:

- The **wording** of `.message` may change between any two releases. Do not parse it. Branch on `err.code` and read structured fields instead. Messages are prefixed with the stable code tag (e.g. `[TURBINE_E008] …`) for log greppability; that tag mirrors `.code` and is the only substring that is intentionally stable.
- The **values** in `.message` may change. As of [0.17.0](./docs/releases/v0.17.0.md), constraint errors no longer append Postgres's raw `detail` (which could contain row data) in the default `safe` mode. If you relied on the old behavior, opt in with `errorMessages: 'verbose'` when constructing the client. Full detail is always available programmatically via `.columns`, `.constraint`, `.where`, and `.cause`, regardless of mode.

## Deprecation policy

When we need to remove or change a **Stable** surface:

1. **Announce it in a minor release.** The CHANGELOG and release notes call out the deprecation explicitly, with the replacement and a migration example.
2. **Keep the old behavior working** for at least **two minor releases** (pre-1.0) before removal. Where a runtime deprecation warning is feasible without breaking output, we add one.
3. **Remove it only in a minor (pre-1.0) or major (post-1.0)** — never in a patch.

If a "breaking" change is actually a **security or correctness fix** (e.g. the 0.17.0 PII-safe error change, or a query that produced wrong results), we may ship it without the full deprecation window. When we do, the release notes say so plainly and tell you how to restore the old behavior if a safe opt-in exists.

## Supported versions and security fixes

Turbine is pre-1.0. **Security and correctness fixes land on the latest minor release.** This matches [SECURITY.md](./SECURITY.md).

| Version | Supported |
|---|---|
| 0.28.x | Yes |
| 0.27.x | Yes (security fixes prefer 0.28.x) |
| < 0.27 | No |

The practical guidance: stay on the latest minor. We do not backport fixes to older minors. To report a vulnerability privately, email **dev@zvndev.com** — see [SECURITY.md](./SECURITY.md) for the process.

## The road to 1.0

1.0 is not a marketing milestone. For a database library, it is a promise: *the Stable surfaces above will not break without a major version bump.* We will not make that promise until we can keep it. Here is what has to be true first.

- **Stable-surface API freeze, sustained.** No breaking change to a Stable surface for **three consecutive minor releases**. If we have to break one, the clock resets.
- **A real parity suite, green.** The non-Postgres adapters move from Experimental to a defined support tier only once a cross-dialect parity suite passes against real engines — not mocks. (The 0.17.0 Studio bug shipped green precisely because a test mocked the pool instead of hitting a server; we are not repeating that.)
- **Real-engine CI.** Integration tests run against live PostgreSQL in CI on every change, not only locally. The full suite (1127 tests as of 0.17.0) stays green.
- **Coverage gate held.** The configured thresholds in `.c8rc.json` (lines 80%, functions 82%, branches 82% as of 0.28.x) stay green on the unit set, with no silently-narrowed subset. Floors are ratcheted up only after measured actuals leave headroom.
- **Published releases, in sync.** Every release has a matching `vX.Y.Z` git tag **and** a published GitHub Release with notes. npm, git tags, and GitHub Releases agree. (See [docs/releases/](./docs/releases/).)
- **Migration durability.** The migration format and `_turbine_migrations` schema are committed to as-is — a 1.0 upgrade must not require re-checksumming or re-applying existing migrations.

### Honest status today (0.28.0)

We are **not at 1.0 yet**, and the gaps are specific:

- Real-engine CI runs Postgres 14–17 on every PR, plus MySQL / SQL Server / CockroachDB / PowDB integration jobs as hard gates. Non-Postgres engines remain **Experimental** for the public API contract.
- Multi-dialect engines (SQLite / MySQL / MSSQL / PowDB) ship as subpath exports but are not yet on the Stable tier — see Experimental surfaces.
- Git tags track npm for current minors; GitHub Releases may lag slightly behind npm — notes live in [CHANGELOG.md](./CHANGELOG.md) and [docs/releases/](./docs/releases/).
- The Stable query API has been shape-stable since the `with`-inference work landed in 0.7.1; we have not yet held a formal multi-release freeze on top of real-engine CI.

When those are addressed, we'll cut 1.0 — and not before. Until then, the safe way to adopt Turbine is to **pin a version** and read the CHANGELOG before upgrading. Stable surfaces should carry you across minors without code changes; Experimental surfaces may not.

## Questions

- Stability or upgrade questions: open a GitHub issue.
- Security: **dev@zvndev.com** (see [SECURITY.md](./SECURITY.md)).
- Full change history: [CHANGELOG.md](./CHANGELOG.md).
