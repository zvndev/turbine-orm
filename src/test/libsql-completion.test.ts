import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@libsql/client/node';
import * as api from '../libsql.js';
import {
  callbackFailures,
  combinations,
  committedAndUnresolved,
  deferred,
} from './fixtures/libsql-completion/contract.js';

test('deferred native FK completion retains its primary error and cleanup rejection', async () => {
  await deferred(api, createClient, mkdtempSync(join(tmpdir(), 'completion-native-')));
});
test('completion preserves arbitrary primary and cleanup reasons and refuses queued reuse', async () => {
  await combinations(api, createClient);
});
test('callback failure remains primary across native rollback and cleanup faults', async () => {
  await callbackFailures(api, createClient);
});
test('committed effects differ from unresolved native state with supplied and owned resources', async () => {
  await committedAndUnresolved(api, createClient);
});
