import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = dirname(fileURLToPath(import.meta.url));
const controls = [
  { file: 'validate.mjs', pattern: 'rejects FETCH ALL', line: '    assert.equal(t.sql, `FETCH ${c.batch} FROM "${sample.portal.name}"`, \'Bounded server FETCH quantity required; FETCH ALL refused\');' },
  { file: 'validate.mjs', pattern: 'rejects missing independent server FETCH', line: "  assert.deepEqual(native, stream.map(t => t.sql), 'Independent server/driver cursor command reconciliation');" },
  { file: 'model.mjs', pattern: 'rejects retained cleanup failure', line: "  assert.deepEqual(report.cleanupErrors, [], 'Cleanup errors refuse success');" },
];
const results = [];
for (const c of controls) {
  const stage = mkdtempSync(join(tmpdir(), 'pg-stream-omission-'));
  try {
    cpSync(source, stage, { recursive: true });
    const args = ['--test', '--test-name-pattern', c.pattern, join(stage, 'harness.test.mjs')];
    const positive = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
    assert.equal(positive.status, 0, `Positive guard prerequisite: ${positive.stdout}${positive.stderr}`);
    const file = join(stage, c.file), text = readFileSync(file, 'utf8');
    assert.equal(text.split(c.line).length, 2, 'Exactly one intended assertion must be omitted');
    writeFileSync(file, text.replace(c.line, '// Isolated omission control.'));
    const negative = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 20000 });
    assert.equal(negative.status, 1, 'Omitting the assertion must fail its intended guard');
    assert.match(negative.stdout + negative.stderr, /Missing expected exception/, 'Intended assertion failure required');
    assert.doesNotMatch(negative.stdout + negative.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module/);
    results.push({ pattern: c.pattern, positiveExit: positive.status, omissionExit: negative.status, intended: 'Missing expected exception' });
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ runtime: process.version, controls: results, stagingRemoved: true }, null, 2));
