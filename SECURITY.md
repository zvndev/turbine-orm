# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Turbine ORM, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, email: **dev@zvndev.com**

Include:
- Description of the vulnerability
- Steps to reproduce
- Impact assessment
- Suggested fix (if any)

You will receive a response within 48 hours. We will work with you to understand and address the issue before any public disclosure.

## Supported Versions

Turbine is pre-1.0; security fixes land on the **latest minor release** only (no backports to older minors). Whatever minor is current on npm's `latest` tag is the supported one; upgrade to it to receive fixes. See [STABILITY.md](./STABILITY.md) for what counts as a breaking change on the way there.

## Security Measures

### SQL injection

This is the invariant the codebase is built around, enforced in layers and regression-tested (`src/test/sql-injection.test.ts`, plus a seeded fuzz suite):

- Field, relation, and table names resolve through schema metadata first; an unknown identifier throws before it ever reaches a quoter.
- All identifiers are quoted via `quoteIdent()` (double-quote escaping).
- All user values are parameterized (`$1`, `$2`, ...); the one deliberate exception (MySQL LIMIT/OFFSET, whose binary protocol rejects bound doubles there) inlines only Turbine-validated non-negative integers and documents why.
- LIKE patterns are escaped via `escapeLike()`.
- DDL DEFAULT values are validated against a strict allowlist.

### Tooling

- CLI seed command uses `execFileSync` with array args (no shell parsing).
- Migration tracking table name quoted via `quoteIdent()`.
- Connection strings redacted in all CLI error output.
- Generated output paths are validated against traversal.
- The published package runs no install scripts (`prepare` is stripped at pack time, and CI fails the release if any install hook leaks into the tarball).

### Studio

Studio is **read-only by default** and write-capable only when explicitly launched with `--write`. Its perimeter, in both modes:

- Binds `127.0.0.1` by default; serving on any other host requires `--allow-remote` and warns loudly.
- Every `/api/*` request is authenticated with a random per-process 24-byte token, compared in constant time.
- Nonce-based CSP with no `unsafe-inline` scripts, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, per-session rate limiting, and cross-origin requests refused.
- Reads run inside `BEGIN READ ONLY` with a parameterized statement timeout and a pinned `search_path`.
- PII-tagged columns are redacted server-side before serialization (reveal requires the explicit `--show-pii` flag, which banners persistently).

With `--write`:

- Write routes exist only in write mode (404 otherwise) and require a matching `Origin` header.
- Every mutation is addressed by the row's **full primary key alone**, reconstructed server-side; predicate-based mutations do not exist, extra where keys are dropped, and operator objects are refused.
- Views and tables without a primary key are refused; bulk operations are capped and run all-or-nothing in one transaction.
- Write mode announces itself with a startup warning and a persistent banner.

### Error messages

Error messages are PII-safe by default: where-clause values are rendered as key names only, and wrapped driver errors have the value-carrying `detail` field stripped before they are attached as `.cause`. The verbose mode is an explicit opt-in (`errorMessages: 'verbose'`).
