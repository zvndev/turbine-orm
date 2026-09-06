#!/usr/bin/env node
/**
 * Guard: every released version has a CHANGELOG heading, in descending order.
 *
 * ## Why this exists
 *
 * Twice in consecutive releases, a new entry was written by replacing the
 * previous version's heading and not putting it back. The result is silent and
 * looks fine locally: the old entries are still there, they just render as part
 * of the new version on the site and in the GitHub release body, so the release
 * notes claim work that shipped a release earlier. Nothing in lint, typecheck,
 * the test suite or the site build notices, because the file is still valid
 * Markdown.
 *
 * Checks, in order of how they have actually failed:
 *   1. every git tag `vX.Y.Z` has a matching `## X.Y.Z` heading (the real bug);
 *   2. the version in package.json has one;
 *   3. headings are unique and in descending semver order;
 *   4. every `###` section heading IN THE ENTRY BEING RELEASED is one of the
 *      sanctioned names.
 *
 * ## Why (4)
 *
 * `docs/releases/README.md` told readers that "a release that changes behaviour
 * says so under a `### Breaking` or `### Behaviour changes` heading, and a
 * release gate checks that the heading is there". No such gate existed. A
 * document that invents a mechanism is worse than one that states a convention,
 * because the next reader stops looking.
 *
 * What a gate can actually decide is the VOCABULARY. Whether a given change is
 * breaking is a judgement no regex makes, but a misspelled or invented heading
 * is mechanical, and the closed set is what makes "under the Breaking heading"
 * a thing a reader can rely on and a writer cannot fat-finger. Both surfaces
 * that render this file, the site and the GitHub Release body, group by these
 * headings, so an unrecognized one is also a rendering bug.
 *
 * Adding a heading to the set is a deliberate act: put it in SECTION_HEADINGS
 * with the release that introduced it, so the list stays a decision rather than
 * a transcript of whatever anyone typed.
 *
 * It checks the CURRENT version's entry only, and deliberately not the file.
 * Ninety-odd published entries use a wider vocabulary (`### Improved`,
 * `### Added, client`, `### Benchmarks`), and those are what shipped: rewriting
 * them to satisfy a rule invented afterwards would make the log disagree with
 * the releases it records. The rule starts at the entry being written, which is
 * also the only moment at which a typo is still cheap to fix.
 *
 * Tags are the source of truth for (1) because a published release is the thing
 * that cannot be quietly rewritten. When git is unavailable (a tarball, a fresh
 * clone with no tags) that check is skipped rather than failed.
 *
 * ## Prereleases
 *
 * A version may carry a prerelease suffix (`0.64.0-next.c4c43d6`, which the
 * nightly workflow writes into package.json just before `npm publish --tag
 * next`). That is a prerelease OF 0.64.0 and belongs to the `## 0.64.0` entry,
 * so the suffix is stripped before anything is looked up. Treating it as a
 * distinct version instead is what silently broke the @next publish for nine
 * releases: this guard runs inside `prepublishOnly`, it demanded a heading
 * named after a version that by construction can never have one, and the only
 * symptom was a red nightly job nobody was watching.
 *
 * An explicit version may be passed as argv[2] instead of reading package.json,
 * which is how the regression test drives it and is also useful for checking a
 * version before bumping to it.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));

const headings = [...changelog.matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);

/**
 * The sanctioned `###` section names. Kept in the order a release entry reads
 * best in, which is also the order the site renders them.
 */
const SECTION_HEADINGS = new Set([
  'Breaking',
  'Behaviour changes',
  'Security',
  'Added',
  'Fixed',
  'Changed',
  'Corrected',
  'Performance',
  'Measured',
  'Upgrading',
  'Docs',
  'Documentation',
  'Tests',
  'Testing',
  'CI',
  'Tooling / CI',
  'Internal',
  'Notes',
  'Known limits',
]);
const problems = [];

/** `0.64.0-next.c4c43d6` -> `0.64.0`. A prerelease belongs to its base entry. */
const releaseVersion = (v) => /^\d+\.\d+\.\d+/.exec(v)?.[0] ?? null;

const rawVersion = process.argv[2] ?? pkg.version;
const version = releaseVersion(rawVersion);
if (version === null) {
  problems.push(`"${rawVersion}" is not a version this guard can read (expected X.Y.Z, optionally with a suffix).`);
}

if (headings.length === 0) problems.push('CHANGELOG.md has no `## X.Y.Z` headings at all.');

const seen = new Set();
for (const v of headings) {
  if (seen.has(v)) problems.push(`CHANGELOG.md has two \`## ${v}\` headings.`);
  seen.add(v);
}

if (version !== null && !seen.has(version)) {
  const source = process.argv[2] ? 'the requested version is' : 'package.json is';
  const via = rawVersion === version ? '' : ` (${rawVersion}, a prerelease of ${version})`;
  problems.push(
    `${source} ${rawVersion}${via} but CHANGELOG.md has no \`## ${version}\` heading. ` +
      "A new entry was probably written over the previous version's heading.",
  );
}

const cmp = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
};
for (let i = 1; i < headings.length; i++) {
  if (cmp(headings[i - 1], headings[i]) > 0) {
    problems.push(`CHANGELOG.md headings are out of order: ${headings[i - 1]} appears above ${headings[i]}.`);
  }
}

let tags = [];
try {
  tags = execFileSync('git', ['tag', '--list', 'v*.*.*'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .map((t) => t.trim().replace(/^v/, ''))
    .filter((t) => /^\d+\.\d+\.\d+$/.test(t));
} catch {
  // No git, or no tags. The package.json and ordering checks still ran.
}

for (const tag of tags) {
  // Only versions at or below the current one: a tag from a branch ahead of this
  // checkout is not this checkout's problem.
  if (version === null || cmp(tag, version) < 0) continue;
  if (!seen.has(tag)) {
    problems.push(`v${tag} is tagged and published but CHANGELOG.md has no \`## ${tag}\` heading.`);
  }
}

// (4) Every `###` section heading in the entry being released is sanctioned.
if (version !== null) {
  const at = changelog.indexOf(`\n## ${version}`);
  if (at !== -1) {
    const rest = changelog.slice(at + 1);
    const nextVersion = rest.search(/\n## \d+\.\d+\.\d+/);
    const entry = nextVersion === -1 ? rest : rest.slice(0, nextVersion);
    const sections = [...entry.matchAll(/^### (.+?)\s*$/gm)].map((m) => m[1]);
    if (sections.length === 0) {
      problems.push(
        `The ## ${version} entry has no \`###\` section headings, so a reader and both renderers ` +
          `(the site and the GitHub Release body) get one undifferentiated block.`,
      );
    }
    for (const h of [...new Set(sections.filter((x) => !SECTION_HEADINGS.has(x)))]) {
      problems.push(
        `The ## ${version} entry uses the section heading "### ${h}", which is not one of the ` +
          `sanctioned names (${[...SECTION_HEADINGS].join(', ')}). Use one of those, or add this one ` +
          `to SECTION_HEADINGS in scripts/check-changelog-headings.mjs with the release that ` +
          `introduced it.`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error('check-changelog-headings: FAILED\n');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('');
  process.exit(1);
}

console.log(`check-changelog-headings: ok (${headings.length} versions, newest ${headings[0]})`);
