# Release notes

Turbine's release notes live in two places, and neither of them is this directory. If a link sent you here looking for a specific release, follow the first of these:

- **[GitHub Releases](https://github.com/zvndev/turbine-orm/releases)**: one published release per `vX.Y.Z` tag, its body taken from that version's [CHANGELOG](../../CHANGELOG.md) entry. The release workflow creates it when the tag is pushed, so the tag, the npm version and the GitHub Release always name the same commit.
- **[CHANGELOG.md](../../CHANGELOG.md)**: the full change log. A release that changes behaviour says so under a `### Breaking` or `### Behaviour changes` heading. Which changes count as breaking is a judgement, and no gate makes it; what `npm run check:changelog` does enforce is that every `###` heading in the entry being released is one of the sanctioned names, so the heading cannot be misspelled or invented and both renderers, the site and the GitHub Release body, group the entry the way it was written. Adding a name to that set is a deliberate edit to `scripts/check-changelog-headings.mjs`.

How a release is cut (branch, PR, the `ci-ok` check, the tag that publishes, the gates the tag runs) is documented in [docs/WORKFLOW.md](../WORKFLOW.md).

This directory keeps one hand-written notes file, [v0.17.0](./v0.17.0.md), from before the GitHub Release step was automated. It stays because [STABILITY.md](../../STABILITY.md) links to it for the 0.17.0 change to error-message contents. Later releases do not add a file here.
