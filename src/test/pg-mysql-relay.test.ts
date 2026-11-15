import assert from 'node:assert/strict';
import { test } from 'node:test';

const { openOrderRelay } = await import(
  new URL('../../examples/postgres-mysql-relay/application.ts', import.meta.url).href
);

// Invalid deployment input must fail before touching a pool, even if access to
// that caller-owned resource would throw. Healthy delivery is tested natively.
function options(extra: Record<string, unknown>) {
  return {
    schema: 'relay_test',
    sourceHistoryId: '00000000-0000-0000-0000-000000000001',
    consumer: 'mail',
    endpoint: 'direct',
    onDiagnostic() {},
    get sourcePool(): never {
      throw new Error('source pool accessed before invalid-input refusal');
    },
    get targetPool(): never {
      throw new Error('target pool accessed before invalid-input refusal');
    },
    ...extra,
  };
}

test('invalid finite bounds are rejected before caller resources are accessed', async () => {
  for (const name of ['batchSize', 'sqlMs', 'operationMs'] as const) {
    for (const value of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(openOrderRelay(options({ [name]: value })), TypeError);
    }
  }
});

test('unbound histories and incompatible consumers are refused before caller resources are accessed', async () => {
  for (const sourceHistoryId of ['', 'not_uuid', 'AAAAAAAA-0000-0000-0000-000000000001']) {
    await assert.rejects(openOrderRelay(options({ sourceHistoryId })), TypeError);
  }
  for (const consumer of ['', 'a'.repeat(28), 'é', 'a b', 'a\0']) {
    await assert.rejects(openOrderRelay(options({ consumer })), TypeError);
  }
});
