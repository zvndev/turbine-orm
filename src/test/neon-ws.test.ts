import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { NeonWsOptions, NeonWsSource } from '../neon-ws.js';
import { turbineNeonWs, withNeonWs } from '../neon-ws.js';
import type { SchemaMetadata } from '../schema.js';

const schema: SchemaMetadata = { tables: {}, enums: {} };
const source = { connection: { connectionString: 'postgresql://localhost/example' } };
const options: NeonWsOptions = { sessionMode: 'persistent', lifetime: 'persistent' };

describe('Neon WebSocket admission without optional driver or network', () => {
  it('requires an explicit endpoint and invocation contract', async () => {
    await assert.rejects(turbineNeonWs(source, schema, {} as NeonWsOptions), /explicit sessionMode and lifetime/);
    await assert.rejects(
      turbineNeonWs(source, schema, { ...options, lifetime: 'unknown' } as unknown as NeonWsOptions),
      /explicit sessionMode and lifetime/,
    );
  });
  it('refuses named statements on transaction poolers before resolving a driver', async () => {
    await assert.rejects(
      turbineNeonWs(source, schema, { ...options, sessionMode: 'transaction', preparedStatements: true }),
      /Named statements/,
    );
  });
  it('refuses cancellation that would destroy a caller-owned Client', async () => {
    await assert.rejects(
      turbineNeonWs({ client: {} } as NeonWsSource, schema, { ...options, signal: new AbortController().signal }),
      /caller connection/,
    );
  });
  it('honors an already aborted lifetime before resolving a driver', async () => {
    const signal = AbortSignal.abort(new Error('invocation ended'));
    await assert.rejects(turbineNeonWs(source, schema, { ...options, signal }), /invocation ended/);
  });
  it('invocation helper requires ownership even from untyped callers', async () => {
    let called = false;
    await assert.rejects(
      withNeonWs({ pool: {} } as unknown as typeof source, schema, { sessionMode: 'persistent' }, async () => {
        called = true;
      }),
      /owned connection/,
    );
    assert.equal(called, false);
  });
});
