#!/usr/bin/env node
/**
 * Guard against private material reaching a public repo.
 *
 * ## Two modes
 *
 * - No flag (the `.husky/pre-commit` hook): scan STAGED content, via
 *   `git show :<file>`, so the check sees exactly what the commit will contain
 *   rather than whatever the working tree happens to hold.
 * - `--all` (CI, `npm run check:private-terms`): scan every TRACKED file in the
 *   checkout. A hook is advisory, `git commit --no-verify` skips it outright,
 *   and until this mode existed nothing downstream re-asked the question, so a
 *   bypassed commit reached npm unchallenged. Running the whole tree rather
 *   than a diff also needs no merge base, which CI's shallow checkout lacks.
 *
 * ## Two independent rulesets, because they have different secrecy needs
 *
 * 1. BUILTIN_PATTERNS, below. Provenance framing: wording that attributes a
 *    change to who reported it or to whose system it was measured on. The
 *    patterns are not themselves sensitive, so they live in this tracked file
 *    and are therefore enforced in CI and in every clone, not just on the
 *    machine that happens to hold a blocklist.
 *
 * 2. `.private-terms`, a repo-local, gitignored list of literal names (one per
 *    line, `#` comments allowed). Names ARE sensitive, so the blocklist never
 *    ships. No terms file means that half is skipped, which keeps clones and CI
 *    working: CI enforces the builtin half only, and the name half stays a
 *    local pre-commit check on the machines that hold the list.
 *
 * ## Why the builtin half exists
 *
 * A name-only blocklist catches a company name and nothing else. It cannot see
 * a table name pasted out of a bug report into a test fixture, and it cannot
 * see a sentence like "on a real 118-model schema", which identifies a system
 * without naming it. Both shipped to npm before an audit caught them.
 *
 * The patterns target the WORDING that reliably accompanies borrowed material,
 * which is mechanical and low-noise, rather than trying to recognize arbitrary
 * schema identifiers, which is not decidable. A fixture named out of someone
 * else's schema usually arrives with a comment saying where it came from; block
 * the comment and the identifier tends to get renamed with it.
 *
 * Deliberately NOT blocked: "dogfood" used as a plain verb for using our own
 * tooling ("tests can dogfood an already-open pool", "dogfood the
 * introspector"). That is ordinary engineering English and blocking it would
 * train people to bypass the hook.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Provenance framing. Each entry is [regex, why]. Keep them specific: a false
 * positive here costs more than a miss, because a guard people routinely
 * override stops guarding anything.
 */
const BUILTIN_PATTERNS = [
  [/\bdogfood(?:ing)?\s+(?:report|consumer|round|source|bug|item|fixes\s+from)\b/i, 'attributes a change to a reporter'],
  [/\b(?:found|caught|discovered|reported)\s+dogfooding\b/i, 'attributes a defect to where it was reported'],
  [/\bon a real\s+[\w,]*\s*(?:\d[\d,]*-model|multi-tenant|production|customer|client)\b/i, 'identifies a system a measurement was taken on'],
  [/\bon a real\s+\d[\d,]*-\w+\s+schema\b/i, 'identifies a system a measurement was taken on'],
  [/\bthe\s+the\s+\w+\s+consumer\b/i, 'leftover from an earlier redaction; a name was here'],
  [/\((?:T|N)-\d+[a-z]?\)/, 'opaque external-report item label'],
  [/\bdogfood[-\s]source\b/i, 'names a feedback source'],
];

const TERMS_FILE = '.private-terms';
const terms = existsSync(TERMS_FILE)
  ? readFileSync(TERMS_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  : [];

const ALL = process.argv.slice(2).includes('--all');

const listCmd = ALL
  ? 'git ls-files -z'
  : 'git diff --cached --name-only -z --diff-filter=ACMR';

const files = execSync(listCmd, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  .split('\0')
  .filter(Boolean)
  .filter((f) => f !== TERMS_FILE)
  // The changelog's generated mirror is derived from CHANGELOG.md; flagging both
  // reports every hit twice and points at a file nobody edits by hand.
  .filter((f) => !f.endsWith('changelog.generated.ts'));

/**
 * `--all` reads the working tree, which in a CI checkout IS the commit under
 * test; the hook reads the index, because the working tree may hold edits that
 * are not being committed. Either way a file that cannot be decoded as text
 * (or contains a NUL, i.e. is binary) is skipped rather than scanned as mojibake.
 */
function readContent(file) {
  try {
    const raw = ALL
      ? readFileSync(file)
      : execSync(`git show :"${file}"`, { maxBuffer: 64 * 1024 * 1024 });
    if (raw.includes(0)) return undefined;
    return raw.toString('utf8');
  } catch {
    return undefined;
  }
}

const hits = [];
for (const file of files) {
  const content = readContent(file);
  if (content === undefined) continue; // binary, missing or unreadable

  // This script necessarily contains the patterns it looks for.
  if (file !== 'scripts/check-private-terms.mjs') {
    for (const [re, why] of BUILTIN_PATTERNS) {
      const m = content.match(re);
      if (m) hits.push(`${file}: ${why} ("${m[0].trim().slice(0, 60)}")`);
    }
  }

  const lower = content.toLowerCase();
  for (const term of terms) {
    if (!lower.includes(term.toLowerCase())) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(content)) hits.push(`${file}: contains blocked term "${term}"`);
  }
}

if (hits.length) {
  console.error(
    ALL
      ? `\ncheck failed, tracked content contains private material (${files.length} files scanned):\n`
      : '\ncommit blocked, staged content contains private material:\n',
  );
  for (const h of hits) console.error(`  ${h}`);
  console.error(
    '\nDescribe what the software does and what was measured, never who reported it\n' +
      'or whose system it was measured on. Rename borrowed identifiers to synthetic ones.\n',
  );
  process.exit(1);
}

if (ALL) {
  // A zero-file scan is not a clean scan. `--all` is the CI half of this guard
  // and its file list comes from `git ls-files`, which answers empty for a
  // checkout that is not a repository, for a `--filter=blob:none` clone whose
  // index has not been populated, and for a working directory that is not the
  // repo root. Every one of those exits 0 with "0 tracked files scanned", which
  // is a green publish gate over nothing. The count was already printed; it just
  // was not asserted. Mirrors the refusal in scripts/check-skip-gate-reasons.ts.
  // Not applied to the hook path: a staged diff of zero files is an ordinary
  // thing for a commit to be, and the hook is not a release gate.
  if (files.length === 0) {
    console.error(
      'check-private-terms: scanned zero tracked files; `git ls-files` returned nothing, so this check would pass vacuously. Refusing to pass.',
    );
    process.exit(1);
  }
  console.log(`check-private-terms: ${files.length} tracked files scanned, no private material found`);
}
