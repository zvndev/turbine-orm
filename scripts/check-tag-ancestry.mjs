#!/usr/bin/env node
/**
 * Guard: a release publishes only a commit that is already on `main`.
 *
 * ## Why this exists
 *
 * release.yml publishes whatever commit the pushed `v*` tag points at. A tag
 * can point at any commit: a feature branch, a PR head that never merged, a
 * local commit pushed only as a tag. The release gates would test that commit
 * and publish it, so a version could reach npm from code that never went
 * through review or the `ci-ok` check on `main`. Requiring the commit to be an
 * ancestor of `origin/main` closes that: the tag can only name reviewed code.
 *
 * ## Usage
 *
 *   node scripts/check-tag-ancestry.mjs <commit> [main-ref]
 *
 * `main-ref` defaults to `origin/main`. Exits 0 when <commit> is an ancestor
 * of (or equal to) main-ref, 1 otherwise. Every error FAILS CLOSED: a shallow
 * clone, a ref that does not resolve, or a git failure is a refusal, never a
 * pass, because in a shallow clone `merge-base --is-ancestor` can answer "no
 * common history" for a commit that is in fact on main, and a guard that
 * skips when it cannot see is not a guard.
 *
 * The decision is `decideAncestry`, exported so the test can drive it against
 * real temporary repositories (src/test/ci-release-tag-ancestry.test.ts).
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Run git in `cwd`. Returns status and trimmed stdout/stderr. */
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim(), error: r.error };
}

/**
 * Decide whether `commit` is on `mainRef`.
 *
 * @param {{ commit: string, mainRef?: string, cwd?: string }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function decideAncestry({ commit, mainRef = 'origin/main', cwd = process.cwd() }) {
  if (!commit) return { ok: false, reason: 'no commit given' };

  const shallow = git(cwd, ['rev-parse', '--is-shallow-repository']);
  if (shallow.error || shallow.status !== 0) {
    return { ok: false, reason: `not a git repository, or git failed (${shallow.stderr || shallow.error?.message})` };
  }
  if (shallow.stdout === 'true') {
    return {
      ok: false,
      reason:
        'the clone is shallow, so ancestry cannot be decided. Check out with `fetch-depth: 0` and fetch main before this check.',
    };
  }

  const resolve = (ref) => git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const target = resolve(commit);
  if (target.status !== 0 || !target.stdout) return { ok: false, reason: `${commit} does not resolve to a commit` };
  const main = resolve(mainRef);
  if (main.status !== 0 || !main.stdout) {
    return { ok: false, reason: `${mainRef} does not resolve to a commit; fetch it before this check` };
  }

  const r = git(cwd, ['merge-base', '--is-ancestor', target.stdout, main.stdout]);
  if (r.status === 0) {
    return { ok: true, reason: `${commit} (${target.stdout}) is on ${mainRef} (${main.stdout})` };
  }
  if (r.status === 1) {
    return {
      ok: false,
      reason:
        `${commit} (${target.stdout}) is not on ${mainRef} (${main.stdout}). ` +
        'A release publishes only reviewed code: merge the release commit to main through a PR, then tag the merged commit.',
    };
  }
  return { ok: false, reason: `git merge-base failed (exit ${r.status}): ${r.stderr || r.error?.message}` };
}

function main() {
  const [commit, mainRef = 'origin/main'] = process.argv.slice(2);
  const { ok, reason } = decideAncestry({ commit, mainRef });
  if (!ok) {
    console.error(`::error::Refusing to release: ${reason}`);
    process.exit(1);
  }
  console.log(`check-tag-ancestry: ${reason}`);
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry === realpathSync(fileURLToPath(import.meta.url))) main();
