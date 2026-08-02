#!/usr/bin/env node
/**
 * Gate: a manual local `npm publish` runs the full DB-backed suite first.
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
 * ## Behavior
 *
 *   - In CI (`CI` env var set): skip. The CI publish paths (release.yml,
 *     nightly.yml) run the full suite as their own jobs with a service
 *     container, and running it twice in the publish job would only slow the
 *     pipeline without checking anything new.
 *   - Outside CI, DATABASE_URL set: run `npm test` against it and fail the
 *     publish on any failure.
 *   - Outside CI, no DATABASE_URL: refuse with instructions. The escape hatch
 *     is TURBINE_PUBLISH_WITHOUT_DB=1, which is loud on purpose: it exists for
 *     a docs-only emergency patch, not as a habit.
 */

import { spawnSync } from 'node:child_process';

if (process.env.CI) {
  console.log('check-release-tests: CI detected, skipping (the CI publish path runs the full suite as its own job)');
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
  console.error(`check-release-tests: could not launch \`npm test\` (${result.error.message}); the publish is blocked.`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error('check-release-tests: the DB-backed suite failed; the publish is blocked.');
  process.exit(result.status ?? 1);
}
console.log('check-release-tests: full suite passed against a live database');
