// Isolated guard mutation: remove one real validator assertion, require its
// focused rejection test to fail. Never changes source or any other checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const cases = [
  ['materialization', 'stream claim used materializing callback', 'materialization masquerading'],
  ['effect', 'independent transaction effect', 'wrong transaction effects'],
  ['signal', 'AbortSignal was omitted', 'omitted signal'],
  ['cleanup', 'sessions independently closed', 'false session cleanup'],
  ['failure', 'retains primary failure', 'reject sample retained failure'],
  ['interruption', 'retains interruption', 'reject service retained interrupted'],
  ['cleanup-error', 'retains cleanup errors', 'reject campaign retained cleanupErrors'],
  [
    'batch-bytes',
    'batch payload bytes match its complete ordered rows',
    'reject balanced batch payload byte transfer',
  ],
  ['counter-names', 'exact named server counters', 'reject additional unrecognized counter'],
  [
    'counter-delta',
    'server counter delta agrees with endpoints:',
    'reject inconsistent counter value in serverCounterDelta',
  ],
  [
    'rss-peak',
    'sampled peak RSS covers both observed endpoints',
    'reject sampled peak RSS below after observation',
  ],
];
const results = [];
for (const [name, message, pattern] of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'mysql-stream-omission-'));
  try {
    for (const f of ['oracle.mjs', 'harness.test.mjs', 'validate.mjs', 'driver.mjs'])
      copyFileSync(new URL(f, import.meta.url), join(dir, f));
    mkdirSync(join(dir, 'results'));
    copyFileSync(
      new URL('results/native.json.gz', import.meta.url),
      join(dir, 'results/native.json.gz'),
    );
    const before = spawnSync(
      process.execPath,
      [`--test-name-pattern=${pattern}`, '--test', join(dir, 'harness.test.mjs')],
      { encoding: 'utf8' },
    );
    assert.equal(before.status, 0, 'unmodified focused guard must pass');
    const p = join(dir, 'validate.mjs'),
      text = readFileSync(p, 'utf8');
    assert.equal(text.split(message).length, 2, 'unique omission anchor');
    const middle = text.indexOf(message),
      start = text.lastIndexOf('assert.', middle),
      end = text.indexOf(';', middle) + 1;
    assert.ok(start >= 0 && end > middle);
    writeFileSync(
      p,
      text.slice(0, start) +
        '/* deliberately omitted in isolated guard control */' +
        text.slice(end),
    );
    const after = spawnSync(
      process.execPath,
      [`--test-name-pattern=${pattern}`, '--test', join(dir, 'harness.test.mjs')],
      { encoding: 'utf8' },
    );
    assert.equal(after.status, 1, 'omitting guard must break its regression');
    assert.match(
      after.stdout + after.stderr,
      /Missing expected exception/,
      'intended assertion omission detected',
    );
    results.push({ name, passed: true, before: before.status, after: after.status });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ node: process.version, controls: results }, null, 2));
