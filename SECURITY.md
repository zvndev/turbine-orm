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

| Version | Supported |
|---------|-----------|
| 0.6.x   | Yes       |
| 0.5.x   | Yes       |
| < 0.5   | No        |

## Security Measures

Turbine ORM takes SQL injection prevention seriously:
- All identifiers are quoted via `quoteIdent()` (double-quote escaping)
- All user values are parameterized (`$1`, `$2`, ...)
- LIKE patterns are escaped via `escapeLike()`
- DDL DEFAULT values are validated against a strict allowlist
- CLI seed command uses `execFileSync` with array args (no shell parsing)
- Migration tracking table name quoted via `quoteIdent()`
- Connection strings redacted in all CLI error output
- Generated output paths are validated against traversal
