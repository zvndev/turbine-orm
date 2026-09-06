/**
 * turbine-orm, a GitHub Release is only announced for a version that published
 *
 * release.yml's "Create GitHub Release from CHANGELOG" step runs late in the
 * publish job, after `npm publish` and after the post-publish smoke test. Its
 * condition was `!cancelled()`, chosen so a SMOKE TEST failure still leaves the
 * release notes behind: by that line the tarball is on the registry, and notes
 * for a version whose smoke test needs a look beat a published version with no
 * notes at all.
 *
 * That reasoning is sound for the smoke test and false for the step above it.
 * `!cancelled()` also survives `npm publish` itself failing, and on v0.78.0 it
 * did: the publish failed on an expired token and this step went on to create a
 * GitHub Release, marked Latest, for a version npm did not have. A release
 * announcement is the most public artifact this workflow produces, and the
 * condition let it be produced on the one outcome that makes it a lie.
 *
 * The condition now names the fact it depends on. Two questions, each of which
 * fails SILENTLY (a wrong release, or a missing one) when the answer is wrong:
 *   1. Does the condition require the publish step to have succeeded? Without
 *      it, a failed publish announces a release for a version nobody can
 *      install.
 *   2. Does it still admit the already-published path? release.yml supports a
 *      workflow_dispatch re-run that backfills a missing release WITHOUT
 *      republishing, which skips the publish step. A condition tightened to
 *      `success()` alone would break that backfill, which is the repair path
 *      for exactly the situation this test is about.
 *
 * The `id:` assertion is not decoration: `steps.publish.outcome` reads as the
 * empty string for a step with no id, so the whole clause would silently
 * evaluate false and NO release would ever be created. That failure is quiet in
 * the opposite direction, and the two conditions have to be checked together.
 *
 * Deliberately a line parser, matching src/test/ci-ok-needs-sync.test.ts: the
 * repo carries no runtime YAML dependency, and every extraction asserts it
 * found something, so a layout change the parser cannot follow fails this test
 * rather than passing it over an empty string.
 *
 * Run: npx tsx --test src/test/release-github-release-gate.test.ts
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const RELEASE_YML_URL = new URL('../../.github/workflows/release.yml', import.meta.url);

const PUBLISH_STEP = 'Publish to npm';
const RELEASE_STEP = 'Create GitHub Release from CHANGELOG';

/** One step's `id:` and `if:` values, as written in the workflow. */
interface StepShape {
  id: string | null;
  condition: string;
}

/**
 * Read a named step's `id:` and `if:` out of release.yml.
 *
 * Scoped to the lines between this step's `- name:` and the next `- name:` at
 * the same indent, so a neighbouring step's condition can never be mistaken for
 * this one's. Both keys are optional in YAML, so a missing one reads as
 * null/empty rather than throwing; the tests below are what decide whether that
 * is acceptable for the step in question.
 */
function readStep(yml: string, stepName: string): StepShape {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `release.yml has no step named "${stepName}"`);

  let id: string | null = null;
  let condition = '';
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim().startsWith('- name:')) break;
    const idMatch = /^\s+id:\s*(\S+)\s*$/.exec(line);
    if (idMatch?.[1]) id = idMatch[1];
    const ifMatch = /^\s+if:\s*(.+?)\s*$/.exec(line);
    if (ifMatch?.[1]) condition = ifMatch[1];
  }
  return { id, condition };
}

describe('release.yml: a GitHub Release is only announced for a version that published', () => {
  const yml = readFileSync(RELEASE_YML_URL, 'utf8');

  it('the publish step carries the id the release condition reads', () => {
    const publish = readStep(yml, PUBLISH_STEP);
    // An unnamed step makes `steps.publish.outcome` the empty string, which
    // turns the release condition permanently false instead of loudly wrong.
    assert.equal(
      publish.id,
      'publish',
      `"${PUBLISH_STEP}" must keep \`id: publish\`, because "${RELEASE_STEP}" reads steps.publish.outcome`,
    );
  });

  it('the release step requires the publish to have succeeded', () => {
    const release = readStep(yml, RELEASE_STEP);
    assert.notEqual(release.condition, '', `"${RELEASE_STEP}" has no \`if:\``);
    assert.ok(
      release.condition.includes("steps.publish.outcome == 'success'"),
      `"${RELEASE_STEP}" must require the publish to have succeeded, else a failed ` +
        `npm publish announces a GitHub Release for a version the registry does not have ` +
        `(v0.78.0 did exactly this). Condition is: ${release.condition}`,
    );
  });

  it('the release step still admits the already-published backfill', () => {
    const release = readStep(yml, RELEASE_STEP);
    assert.ok(
      release.condition.includes("steps.published.outputs.already == 'true'"),
      `"${RELEASE_STEP}" must still run when the publish was skipped as already-published, ` +
        `or a workflow_dispatch re-run can no longer backfill a missing release. ` +
        `Condition is: ${release.condition}`,
    );
  });

  it('the release step is not gated on the smoke test', () => {
    const release = readStep(yml, RELEASE_STEP);
    // The original intent, and the half of it that was right: once the tarball
    // is on the registry, a smoke failure must still leave the notes behind.
    assert.ok(
      !release.condition.includes('smoke'),
      `"${RELEASE_STEP}" must not depend on the post-publish smoke test: by then the ` +
        `version is public, and a published version with no release notes is worse than ` +
        `notes for one whose smoke test needs a look. Condition is: ${release.condition}`,
    );
    assert.ok(
      release.condition.includes('!cancelled()'),
      `"${RELEASE_STEP}" must keep \`!cancelled()\` so a smoke-test failure still reaches ` +
        `it. Condition is: ${release.condition}`,
    );
  });
});
