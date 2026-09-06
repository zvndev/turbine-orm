/**
 * turbine-orm, unit tests for the release gate's CI-status check.
 *
 * `checkCiGreen` is the half of `scripts/check-release-tests.mjs` that the
 * local suite structurally cannot stand in for: it asks GitHub whether CI
 * concluded success on the commit being published. v0.76.0 shipped from a
 * commit whose `unit-tests (20)` leg was red, because the only gate on the
 * local publish path ran the suite on a machine that is not Node 20.
 *
 * Every test below is a REFUSAL test except the first. That ratio is the
 * point: the gate's whole value is failing closed on an ambiguous answer, so
 * "no run", "unfinished run", "gh is unusable" and "that is not a full sha"
 * each get their own case rather than being folded into one.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

type GhResult = { status: number | null; stdout: string; error?: Error };
type GhRunner = (cmd: string, args: string[]) => GhResult;
type CheckCiGreen = (sha: string, deps?: { runCommand?: GhRunner }) => { ok: boolean; reason: string };

/** URL of the gate script, used both for the import below and for the child-process test. */
const GATE_URL = new URL('../../scripts/check-release-tests.mjs', import.meta.url);

/**
 * The gate is a plain `.mjs` script that ships no type declarations, so a
 * literal specifier (static OR dynamic) fails `npm run typecheck` with TS7016
 * under this repo's `strict`. A URL-built specifier is not statically
 * resolvable, so TypeScript leaves the module untyped and the cast below
 * supplies the shape. The runtime import is unaffected.
 *
 * Importing the script at all is only safe because its side effects (spawning
 * `npm test`, calling `process.exit`) run from `main()` behind an entry-point
 * check. The last test in this file is what keeps that guard honest.
 */
const gateModule = (await import(GATE_URL.href)) as { checkCiGreen: CheckCiGreen };
const { checkCiGreen } = gateModule;

/**
 * A full 40-character sha. `gh run list --commit` does not resolve an
 * abbreviated sha, so `checkCiGreen` refuses a short one before it ever calls
 * `gh` and the fixtures below must be full length.
 */
const SHA = 'abc1230000000000000000000000000000000000';

/** Build a fake `gh` runner that returns one canned payload. */
function fakeGh(payload: unknown, status = 0): GhRunner {
  return () => ({ status, stdout: JSON.stringify(payload), error: undefined });
}

describe('checkCiGreen', () => {
  it('passes when the CI run for the sha concluded success', () => {
    const run = fakeGh([{ workflowName: 'CI', conclusion: 'success', headSha: SHA }]);
    const result = checkCiGreen(SHA, { runCommand: run });
    assert.equal(result.ok, true);
  });

  it('REFUSES when the CI run for the sha concluded failure', () => {
    const run = fakeGh([{ workflowName: 'CI', conclusion: 'failure', headSha: SHA }]);
    const result = checkCiGreen(SHA, { runCommand: run });
    assert.equal(result.ok, false);
    assert.match(result.reason, /failure/, 'the reason must name the conclusion');
  });

  it('REFUSES when no CI run exists for the sha, rather than passing vacuously', () => {
    const run = fakeGh([]);
    const result = checkCiGreen(SHA, { runCommand: run });
    assert.equal(result.ok, false, 'no run is not the same as a green run');
    assert.match(result.reason, /no CI run/i);
  });

  it('REFUSES when the CI run is still in progress', () => {
    const run = fakeGh([{ workflowName: 'CI', conclusion: null, headSha: SHA }]);
    const result = checkCiGreen(SHA, { runCommand: run });
    assert.equal(result.ok, false);
    assert.match(result.reason, /still running|in progress/i);
  });

  it('REFUSES when gh itself fails, rather than treating the error as green', () => {
    const run: GhRunner = () => ({ status: 1, stdout: '', error: new Error('gh not found') });
    const result = checkCiGreen(SHA, { runCommand: run });
    assert.equal(result.ok, false, 'an unusable gh must block, not pass');
  });

  it('REFUSES a short sha by naming the argument, not by blaming CI', () => {
    // `gh run list --commit e52c526` returns an empty list, which is
    // indistinguishable from a commit that genuinely has no run. Reported as
    // "no CI run found" it sends the reader to look at a CI failure that does
    // not exist, so the refusal has to name the real problem instead.
    let called = false;
    const run: GhRunner = () => {
      called = true;
      return { status: 0, stdout: '[]', error: undefined };
    };
    const result = checkCiGreen('e52c526', { runCommand: run });
    assert.equal(result.ok, false, 'a short sha must still fail closed');
    assert.match(result.reason, /40-character sha/, 'the reason must name the argument as the problem');
    assert.match(result.reason, /"e52c526" \(7 chars\)/, 'the reason must quote and measure what it was given');
    assert.doesNotMatch(result.reason, /no CI run/i, 'must not read as a CI verdict');
    assert.equal(called, false, 'a malformed sha must be refused before the round trip, not after it');
  });
});

describe('check-release-tests import safety', () => {
  it('runs the gate only when executed directly, never on import', () => {
    // THE VACUITY HOLE THIS CLOSES. The gate's side effects used to be
    // top-level. With `GITHUB_ACTIONS=true` set (which is exactly how the unit
    // suite runs in CI) importing the module printed the skip line and called
    // process.exit(0), which killed the test runner mid-import: node:test
    // then reported ONE PASSING TEST for this whole file, having executed none
    // of the assertions above. A green run with zero assertions is invisible,
    // so the check has to happen in a child process where an exit is
    // observable rather than fatal.
    const child = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(GATE_URL.href)}); console.log('IMPORT_CLEAN');`],
      { encoding: 'utf8', env: { ...process.env, CI: 'true', GITHUB_ACTIONS: 'true' } },
    );

    assert.equal(child.status, 0, `importing the gate must not exit the process (stderr: ${child.stderr})`);
    assert.match(child.stdout, /IMPORT_CLEAN/, 'the importing process must survive the import and reach its own code');
    assert.doesNotMatch(
      child.stdout,
      /detected, skipping/,
      'importing must produce no gate output; the entry-point guard has regressed',
    );
  });
});

/**
 * Run the gate AS THE ENTRY POINT under a controlled environment. The five
 * variables it reads are cleared first so the parent's shell (a CI runner, a
 * developer's exported DATABASE_URL) cannot leak into a case; `overrides`
 * then sets exactly what the case is about. With no DATABASE_URL the gate
 * refuses before it would spawn `npm test`, so every case is side-effect free.
 */
function runGate(overrides: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'CI',
    'GITHUB_ACTIONS',
    'DATABASE_URL',
    'TURBINE_PUBLISH_WITHOUT_DB',
    'TURBINE_PUBLISH_WITHOUT_CI',
  ]) {
    delete env[key];
  }
  const child = spawnSync(process.execPath, [fileURLToPath(GATE_URL)], {
    encoding: 'utf8',
    env: { ...env, ...overrides },
  });
  return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}

describe('check-release-tests skips only on GitHub Actions', () => {
  it("skips when GITHUB_ACTIONS=true, where release.yml's own needs chain is the gate", () => {
    const r = runGate({ GITHUB_ACTIONS: 'true', CI: 'true' });
    assert.equal(r.status, 0, `expected the skip, got exit ${r.status} (stderr: ${r.stderr})`);
    assert.match(r.stdout, /GitHub Actions detected, skipping/);
  });

  it('does NOT skip on CI=1 alone: a laptop exporting CI is not a release pipeline', () => {
    // The old test was `if (process.env.CI)`, satisfied by ANY value, so
    // `CI=1 npm publish` bypassed the DB-backed suite AND the CI-status check
    // with one informational line. The gate must run, and with no
    // DATABASE_URL running means refusing.
    const r = runGate({ CI: '1' });
    assert.equal(r.status, 1, `CI=1 must not skip the gate (stdout: ${r.stdout})`);
    assert.doesNotMatch(r.stdout, /skipping/);
    assert.match(r.stderr, /no DATABASE_URL is set/, 'the gate ran and refused for the reason it should have');
  });

  it('does NOT skip on CI=true either, the value GitHub sets, without its own marker', () => {
    const r = runGate({ CI: 'true' });
    assert.equal(r.status, 1, `CI=true must not skip the gate (stdout: ${r.stdout})`);
    assert.match(r.stderr, /no DATABASE_URL is set/);
  });

  it('does NOT skip on GITHUB_ACTIONS=1: the runner sets the string "true" and only that is accepted', () => {
    const r = runGate({ GITHUB_ACTIONS: '1' });
    assert.equal(r.status, 1, `GITHUB_ACTIONS=1 must not skip the gate (stdout: ${r.stdout})`);
    assert.match(r.stderr, /no DATABASE_URL is set/);
  });
});
