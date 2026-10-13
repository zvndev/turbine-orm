/**
 * The release ancestry guard (scripts/check-tag-ancestry.mjs), driven against
 * real temporary git repositories rather than a mocked git.
 *
 * Four questions. A commit on main passes. A commit off main (a branch that
 * never merged) is refused. A shallow clone is refused even for a commit that
 * IS on main, because there `merge-base` cannot see the history and a guard
 * that passes when blind is not a guard. A name that does not resolve is
 * refused. The last test runs the script as a process, the way release.yml
 * does, and checks the exit code and the message.
 *
 * Run: npx tsx --test src/test/ci-release-tag-ancestry.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT_URL = new URL('../../scripts/check-tag-ancestry.mjs', import.meta.url);
const SCRIPT = fileURLToPath(SCRIPT_URL);

type Decide = (input: { commit: string; mainRef?: string; cwd?: string }) => { ok: boolean; reason: string };
const { decideAncestry: decide } = (await import(SCRIPT_URL.href)) as { decideAncestry: Decide };

// Fixture repositories only. An identity is supplied through the environment
// so the test runs on a machine with no git identity configured (CI runners).
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', file);
  return git(cwd, 'rev-parse', 'HEAD');
}

describe('release ancestry guard', () => {
  let root = '';
  let origin = '';
  let clone = '';
  let onMain = '';
  let offMain = '';

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'turbine-ancestry-'));
    origin = join(root, 'origin');
    git(root, 'init', '-q', '-b', 'main', origin);
    commit(origin, 'a');
    onMain = commit(origin, 'b');
    commit(origin, 'c');
    git(origin, 'checkout', '-q', '-b', 'feature', onMain);
    offMain = commit(origin, 'unmerged');
    git(origin, 'checkout', '-q', 'main');
    clone = join(root, 'clone');
    git(root, 'clone', '-q', '--no-local', origin, clone);
    git(clone, 'fetch', '-q', 'origin', 'feature');
  });

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('passes a commit that is on origin/main, including its tip', () => {
    assert.equal(decide({ commit: onMain, cwd: clone }).ok, true);
    assert.equal(decide({ commit: 'origin/main', cwd: clone }).ok, true);
  });

  it('refuses a commit that is not on origin/main', () => {
    const d = decide({ commit: offMain, cwd: clone });
    assert.equal(d.ok, false);
    assert.match(d.reason, /is not on origin\/main/);
  });

  it('refuses in a shallow clone, even for a commit on main', () => {
    const shallow = join(root, 'shallow');
    git(root, 'clone', '-q', '--depth', '1', `file://${origin}`, shallow);
    const d = decide({ commit: 'HEAD', cwd: shallow });
    assert.equal(d.ok, false);
    assert.match(d.reason, /shallow/);
  });

  it('refuses a name that does not resolve, and a missing main ref', () => {
    assert.equal(decide({ commit: 'no-such-ref', cwd: clone }).ok, false);
    assert.equal(decide({ commit: '', cwd: clone }).ok, false);
    const d = decide({ commit: onMain, mainRef: 'origin/no-such-branch', cwd: clone });
    assert.equal(d.ok, false);
    assert.match(d.reason, /does not resolve/);
  });

  it('as a process: exit 1 with a named refusal off main, exit 0 on main', () => {
    const run = (sha: string) => spawnSync(process.execPath, [SCRIPT, sha], { cwd: clone, encoding: 'utf8' });
    const refused = run(offMain);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /::error::Refusing to release: .* is not on origin\/main/);
    const passed = run(onMain);
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /is on origin\/main/);
  });
});
