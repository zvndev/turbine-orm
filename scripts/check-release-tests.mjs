#!/usr/bin/env node
/**
 * Gate: a manual local `npm publish` runs the full DB-backed suite first, and
 * refuses to publish a commit whose CI is not green.
 *
 * ## Why this exists
 *
 * The normal release flow here is a manual local `npm publish`, and
 * prepublishOnly is the ONLY gate on that path: release.yml runs on a pushed
 * tag, which a local publish never triggers, and ci.yml runs on push, which
 * happens after the tarball is already on the registry. Every other check in
 * the prepublishOnly chain is deliberately database-free for speed, which
 * meant the one command that makes a version public was also the one path
 * that never executed a query against a real Postgres. This script closes
 * that: outside CI it runs the full `npm test` (the integration suite gates
 * itself on DATABASE_URL), and it refuses to publish silently untested SQL
 * when no database is reachable.
 *
 * That local suite answers "do the tests pass ON THIS MACHINE". It structurally
 * cannot answer "do they pass on the matrix legs this machine does not run", so
 * a second gate asks CI directly. See `checkCiGreen` below.
 *
 * ## Behavior
 *
 *   - On GitHub Actions (`GITHUB_ACTIONS=true`, which the runner sets and
 *     nothing else does): skip. The CI publish paths (release.yml,
 *     nightly.yml) run the full suite as their own jobs with a service
 *     container, and running it twice in the publish job would only slow the
 *     pipeline without checking anything new. The CI-status gate is skipped
 *     here too: on that path release.yml's own `needs:` chain is the gate.
 *     NOT the generic `CI` variable: any value of it satisfied the old test,
 *     so `CI=1 npm publish` from a laptop skipped every gate on this path with
 *     one informational line. The skip exists for the one environment whose
 *     own `needs:` chain is the gate, so it keys on that environment's marker
 *     and on its exact value (src/test/check-release-tests.test.ts pins both).
 *   - Outside CI, DATABASE_URL set: run `npm test` against it and fail the
 *     publish on any failure.
 *   - Outside CI, no DATABASE_URL: refuse with instructions. The escape hatch
 *     is TURBINE_PUBLISH_WITHOUT_DB=1, which is loud on purpose: it exists for
 *     a docs-only emergency patch, not as a habit.
 *   - Outside CI, after the suite passes: refuse unless the CI workflow
 *     concluded success on HEAD. The escape hatch is
 *     TURBINE_PUBLISH_WITHOUT_CI=1, equally loud and for the same reason.
 *
 * ## Structure
 *
 * Everything above runs from `main()`, called only when this file is the
 * process entry point. `checkCiGreen` is exported unconditionally so it can be
 * tested (src/test/check-release-tests.test.ts) without the import spawning
 * `npm test` as a side effect.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Second gate: is CI green on the commit being published?
 *
 * The local suite above proves the tests pass ON THIS MACHINE. It cannot prove
 * they pass on the matrix legs this machine does not run. v0.76.0 published
 * from a commit whose `unit-tests (20)` leg was red: the local gate passed
 * because a local machine is not Node 20. This asks the question the local
 * suite structurally cannot.
 *
 * Fails closed in every ambiguous case: no run, unfinished run, unusable `gh`.
 * A publish blocked by a missing run is a minor annoyance; a publish waved
 * through by one is the defect this exists to prevent.
 *
 * @param {string} sha FULL 40-character commit sha. `gh run list --commit` does
 *   not resolve an abbreviated sha, so a short one is rejected up front rather
 *   than spent on a round trip that comes back as "no run found", which reads
 *   like a red CI when the real problem is the argument.
 * @param {{ runCommand?: (cmd: string, args: string[]) => { status: number|null, stdout: string, error?: Error } }} [deps]
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkCiGreen(sha, deps = {}) {
  // Argument validation BEFORE the round trip, and before any branch that could
  // be mistaken for a CI verdict. `gh run list --commit e52c526` returns an
  // empty list, indistinguishable from a commit that genuinely has no run, so
  // without this the refusal names the wrong problem and sends the reader to
  // look at CI instead of at their own call.
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/i.test(sha)) {
    const measured = typeof sha === 'string' ? ` (${sha.length} chars)` : '';
    return {
      ok: false,
      reason:
        `expected a full 40-character sha, got ${JSON.stringify(sha)}${measured}; ` +
        '`gh run list --commit` does not match short shas',
    };
  }

  const runCommand =
    deps.runCommand ??
    ((cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8' });
      return { status: r.status, stdout: r.stdout ?? '', error: r.error };
    });

  const res = runCommand('gh', [
    'run',
    'list',
    '--commit',
    sha,
    '--workflow',
    'CI',
    '--limit',
    '1',
    '--json',
    'workflowName,conclusion,headSha',
  ]);

  if (res.error || res.status !== 0) {
    return { ok: false, reason: `could not query CI status via gh (${res.error?.message ?? `exit ${res.status}`})` };
  }

  let runs;
  try {
    runs = JSON.parse(res.stdout);
  } catch (err) {
    return { ok: false, reason: `could not parse gh output (${err.message})` };
  }
  if (!Array.isArray(runs) || runs.length === 0) {
    return { ok: false, reason: `no CI run found for ${sha}` };
  }

  const run = runs[0];
  if (run.conclusion === null || run.conclusion === undefined) {
    return { ok: false, reason: `the CI run for ${sha} is still running` };
  }
  if (run.conclusion !== 'success') {
    return { ok: false, reason: `the CI run for ${sha} concluded ${run.conclusion}` };
  }
  return { ok: true, reason: `CI is green on ${sha}` };
}

/** The gate itself. Exits the process; never returns on a refusal. */
function main() {
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(
      'check-release-tests: GitHub Actions detected, skipping (the CI publish path runs the full suite as its own job)',
    );
    process.exit(0);
  }

  if (!process.env.DATABASE_URL) {
    if (process.env.TURBINE_PUBLISH_WITHOUT_DB === '1') {
      console.warn('');
      console.warn('  ! check-release-tests: PUBLISHING WITHOUT THE DB-BACKED SUITE');
      console.warn('  ! TURBINE_PUBLISH_WITHOUT_DB=1 is set and no DATABASE_URL is present.');
      console.warn('  ! No integration test has run against this build. Postgres-rejected');
      console.warn('  ! SQL would ship silently. This flag is for emergencies only.');
      console.warn('');
      process.exit(0);
    }
    console.error('check-release-tests: refusing to publish, no DATABASE_URL is set.');
    console.error('');
    console.error('A local `npm publish` is the release path, and without a database the');
    console.error('integration suite self-skips, so nothing on this path has executed the');
    console.error("generated SQL against a real Postgres. Start the test database and set");
    console.error('DATABASE_URL, then publish again. Emergency escape (docs-only patches):');
    console.error('TURBINE_PUBLISH_WITHOUT_DB=1 npm publish');
    process.exit(1);
  }

  console.log(`check-release-tests: running the full suite against DATABASE_URL before publish...`);
  const result = spawnSync('npm', ['test'], { stdio: 'inherit', env: process.env });
  if (result.error) {
    // Distinguish "the suite failed" from "the suite never ran" (ENOENT and
    // friends): both block the publish, but the second must not be reported as
    // a test failure, that misdirects the fix.
    console.error(
      `check-release-tests: could not launch \`npm test\` (${result.error.message}); the publish is blocked.`,
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error('check-release-tests: the DB-backed suite failed; the publish is blocked.');
    process.exit(result.status ?? 1);
  }

  const headSha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  if (!headSha) {
    console.error('check-release-tests: could not resolve HEAD; the publish is blocked.');
    process.exit(1);
  }

  const ci = checkCiGreen(headSha);
  if (!ci.ok) {
    console.error('');
    console.error(`check-release-tests: refusing to publish, ${ci.reason}.`);
    console.error('');
    console.error('The local suite passing is not the same as CI passing: this machine does');
    console.error('not run every matrix leg. v0.76.0 shipped from a commit whose Node 20 leg');
    console.error('was red and whose local gate was green.');
    console.error('');
    console.error('Push the commit, wait for CI, then publish. Emergency escape:');
    console.error('TURBINE_PUBLISH_WITHOUT_CI=1 npm publish');
    if (process.env.TURBINE_PUBLISH_WITHOUT_CI !== '1') process.exit(1);
    console.warn('  ! TURBINE_PUBLISH_WITHOUT_CI=1 set; publishing over an unverified CI state.');
  }
  console.log(`check-release-tests: ${ci.reason}`);

  console.log('check-release-tests: full suite passed against a live database');
}

/**
 * True only when this file is the process entry point.
 *
 * The gate's side effects (spawning `npm test`, calling process.exit) used to
 * be top-level, which made the module impossible to import from a test without
 * running a release gate. This must fail CLOSED in the safe direction: a false
 * positive would spawn the whole suite from inside a unit test, so anything
 * unresolvable answers no.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  if (resolve(entry) === self) return true;
  try {
    return realpathSync(resolve(entry)) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
