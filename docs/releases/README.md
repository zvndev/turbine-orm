# Release notes

User-facing release notes for Turbine ORM, one file per release.

Each release has a `vX.Y.Z.md` file here. These are the human-readable notes — the "what changed and how to upgrade" view — distinct from [CHANGELOG.md](../../CHANGELOG.md), which is the full, terse change log.

## Releases

- [v0.17.0](./v0.17.0.md) — Studio on plain Postgres, PII-safe constraint errors, belongsTo nested writes, honest footprint.

## Process

We are closing a gap: Turbine had npm publishes and some git tags, but **no published GitHub Releases**, and the tags had fallen out of sync with npm. Starting with 0.17.0, every release does all of the following:

1. **Add a notes file here** — `docs/releases/vX.Y.Z.md`, derived from that version's [CHANGELOG](../../CHANGELOG.md) entry, written for a reader deciding whether and how to upgrade. Lead with correctness fixes, then features, then smaller items. Always include an **Upgrade notes** section.
2. **Tag the commit** — `git tag vX.Y.Z` on the release commit, pushed to GitHub. The tag, the npm version, and this notes file must all agree.
3. **Publish a GitHub Release** — using the notes file as the body, e.g. `gh release create vX.Y.Z --notes-file docs/releases/vX.Y.Z.md --title "vX.Y.Z"`.

> **Note**
> Release *mechanics* (npm publish auth, site deploy, the full verification checklist) live in [AGENTS.md](../../AGENTS.md) at the repo root — that is the source of truth. This page only covers the notes + tag + GitHub Release steps that close the published-releases gap.

## Style

Match the rest of the docs: concise, accurate, scannable. Verify every technical claim against the code and CHANGELOG before writing it — no invented APIs, no marketing. If a release contains a breaking or behavior change, say so plainly and tell the reader exactly how to adapt.
