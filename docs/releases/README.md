# Release notes

Turbine's release notes live in two places, and neither of them is this directory:

- **[GitHub Releases](https://github.com/zvndev/turbine-orm/releases)**: one published release per `vX.Y.Z` tag, its body taken from that version's [CHANGELOG](../../CHANGELOG.md) entry. The release workflow creates it when the tag is pushed, so the tag, the npm version and the GitHub Release always name the same commit.
- **[CHANGELOG.md](../../CHANGELOG.md)**: the full change log. A release that changes behaviour says so under a `### Breaking` or `### Behaviour changes` heading, and a release gate checks that the heading is there.

How a release is cut (branch, PR, the `ci-ok` check, the tag that publishes, the gates the tag runs) is documented in [docs/WORKFLOW.md](../WORKFLOW.md).

This directory keeps one hand-written notes file, [v0.17.0](./v0.17.0.md), from before the GitHub Release step was automated. It stays because [STABILITY.md](../../STABILITY.md) links to it for the 0.17.0 change to error-message contents. Later releases do not add a file here.
