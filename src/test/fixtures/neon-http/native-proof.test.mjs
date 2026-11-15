import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('positive HTTP admission refuses missing scopes and contradictory native proof', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./native_proof_test.py', import.meta.url)), '-v'], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 6 tests/);
});
