#!/usr/bin/env node
/**
 * Pre-commit guard: block commits whose staged content contains any term
 * listed in the repo-local `.private-terms` file (one term per line, `#`
 * comments allowed). The terms file is gitignored — it never ships — so the
 * blocklist itself stays private. No terms file → no-op, so clones and CI
 * are unaffected.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const TERMS_FILE = '.private-terms';
if (!existsSync(TERMS_FILE)) process.exit(0);

const terms = readFileSync(TERMS_FILE, 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
if (terms.length === 0) process.exit(0);

const staged = execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)
  .filter((f) => f !== TERMS_FILE);

const hits = [];
for (const file of staged) {
  let content;
  try {
    content = execSync(`git show :"${file}"`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    continue; // binary or unreadable — skip
  }
  const lower = content.toLowerCase();
  for (const term of terms) {
    if (!lower.includes(term.toLowerCase())) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(content)) hits.push(`${file}: contains blocked term "${term}"`);
  }
}

if (hits.length) {
  console.error('\ncommit blocked — staged content contains private terms:\n');
  for (const h of hits) console.error(`  ${h}`);
  console.error('\nRemove or rephrase before committing (see .private-terms).\n');
  process.exit(1);
}
