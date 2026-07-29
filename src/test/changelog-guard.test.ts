/**
 * The CHANGELOG-heading guard must accept a PRERELEASE version.
 *
 * The guard runs inside `prepublishOnly`, so it gates every publish including
 * the per-commit `@next` prerelease the nightly workflow pushes. That workflow
 * sets the version to `<current>-next.<sha>` and then runs `npm publish`, and
 * the guard demanded a `## <version>` heading for exactly that string, which by
 * construction can never exist: a prerelease of 0.64.0 is described by the
 * `## 0.64.0` entry.
 *
 * So every nightly publish failed, for nine releases, and the only symptom was
 * a red workflow nobody was watching. The `next` dist-tag sat on a version from
 * months earlier while `latest` moved on, which is worse than having no
 * prerelease channel at all: anyone who installed `turbine-orm@next` got
 * something far older than they had any reason to expect.
 *
 * These cases drive the real script as a subprocess, on the real CHANGELOG.md,
 * and assert on its EXIT CODE, because the exit code is the entire contract
 * with `prepublishOnly`.
 *
 * They pass the version as an ARGUMENT rather than through package.json, which
 * a test cannot rewrite safely. Both paths meet immediately (`process.argv[2] ??
 * pkg.version`) and share all the logic below that, so the argument covers it.
 * The package.json path was verified by hand once against the exact nightly
 * sequence: `npm version 0.64.0-next.<sha> --no-git-tag-version`, run the
 * guard, restore.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = resolve(repoRoot, 'scripts/check-changelog-headings.mjs');

/** Run the guard for one version and return its exit code plus output. */
function check(version?: string): { code: number; output: string } {
  const result = spawnSync('node', version ? [script, version] : [script], {
    cwd: repoRoot,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, `the guard did not run: ${result.error}`);
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

describe('check-changelog-headings', () => {
  it('passes for the version in package.json', () => {
    // Also the precondition for everything below: if the repo's own state fails
    // the guard, the prerelease cases below would prove nothing.
    const { code, output } = check();
    assert.equal(code, 0, output);
  });

  it('accepts a prerelease as belonging to its base version', () => {
    // The exact shape the nightly workflow produces.
    const pkgVersion = JSON.parse(
      spawnSync('node', ['-p', 'JSON.stringify(require("./package.json").version)'], {
        cwd: repoRoot,
        encoding: 'utf-8',
      }).stdout,
    ) as string;
    const { code, output } = check(`${pkgVersion}-next.c4c43d6`);
    assert.equal(code, 0, `a prerelease of the current version must pass:\n${output}`);
  });

  it('still fails for a version with no heading', () => {
    // The guard's actual job. Twice, a new entry was written over the previous
    // version's heading; without this case the fix above would have been
    // indistinguishable from deleting the check.
    const { code, output } = check('9.9.9');
    assert.equal(code, 1, 'a version with no CHANGELOG entry must fail');
    assert.match(output, /no `## 9\.9\.9` heading/);
  });

  it('fails for a prerelease whose BASE version has no heading', () => {
    // The fix strips the suffix; it must not stop checking. `9.9.9-next.abc123`
    // is a prerelease of a version that was never released.
    const { code, output } = check('9.9.9-next.abc1234');
    assert.equal(code, 1, 'stripping the suffix must not turn the check off');
    assert.match(output, /a prerelease of 9\.9\.9/);
  });

  it('rejects a version string it cannot read, rather than passing it', () => {
    const { code, output } = check('not-a-version');
    assert.equal(code, 1);
    assert.match(output, /not a version this guard can read/);
  });
});
