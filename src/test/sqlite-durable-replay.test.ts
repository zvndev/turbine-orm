import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runContracts } from './fixtures/sqlite-durable-replay/contracts.js';
import { skipGate } from './helpers.js';

let available = false;
try {
  available = typeof createRequire(import.meta.url)('node:sqlite').DatabaseSync === 'function';
} catch {}
const { it } = skipGate(!available, 'requires node:sqlite (Node >=22.16)');
it('durable SQLite application preserves exact values, transactions, replay and caller ownership', {
  timeout: 15000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-durable-replay-'));
  const groups = await runContracts(root);
  assert.equal(groups.length, 12);
});
