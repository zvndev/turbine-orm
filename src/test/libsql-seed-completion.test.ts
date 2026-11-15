import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import { deferSeedCleanup } from '../libsql/seed-cleanup.js';
import * as api from '../libsql.js';
import * as seed from '../libsql-seed.js';
import { completion, getters, outstanding, scopes } from './fixtures/libsql-seed-completion/contract.js';

test('seed cleanup preserves one event, distinct equal reasons, actual effects and scoped ownership', async () => {
  await completion(api, seed, createClient, mkdtempSync(join(tmpdir(), 'seed-completion-')), deferSeedCleanup);
});
test('seed cleanup avoids caller getters while distinct native primary translation stays observable', async () => {
  await getters(api, seed, createClient);
});

test('independent and reentrant seed scopes cannot change ordinary client completion', async () => {
  await scopes(api, seed, createClient, deferSeedCleanup);
});
test('outstanding work remains primary when rollback cleanup also fails', { timeout: 5000 }, async () => {
  await outstanding(seed, createClient);
});
