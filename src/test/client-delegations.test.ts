/**
 * The three `TurbineClient` methods a public-method sweep found untested:
 * `$retry`, `$observe`, and `pipelineSupported`.
 *
 * All three are thin, and two of them delegate to code that IS covered
 * (`withRetry` in retry.test.ts, the observe engine in observe*.test.ts), which
 * is exactly why they went uncovered: "the thing it calls is tested" reads like
 * coverage until the wiring itself is wrong. What is unproven in a delegation
 * is the wiring: that options reach the callee, that the handle a caller gets
 * back actually detaches what it attached, and that replacing one engine stops
 * the previous one instead of leaving two listeners on the bus.
 *
 * `pipelineSupported` has its own file (pipeline-supported.test.ts) because it
 * has real branching; the client method is asserted here only for the hand-off.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { DeadlockError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

function inertPool(): PgCompatPool {
  return {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
    },
    async end() {},
    on() {},
  } as unknown as PgCompatPool;
}

function client(): TurbineClient {
  return new TurbineClient({ pool: inertPool() }, schema());
}

describe('TurbineClient.$retry', () => {
  it('returns the callback result when nothing throws', async () => {
    assert.equal(await client().$retry(async () => 42), 42);
  });

  it('retries a retryable error and eventually succeeds', async () => {
    let attempts = 0;
    const out = await client().$retry(
      async () => {
        attempts++;
        if (attempts < 3) throw new DeadlockError({ message: 'deadlock detected' });
        return 'ok';
      },
      { baseDelay: 1 },
    );
    assert.equal(out, 'ok');
    assert.equal(attempts, 3);
  });

  it('does not retry an error that is not retryable', async () => {
    let attempts = 0;
    await assert.rejects(
      () =>
        client().$retry(async () => {
          attempts++;
          throw new Error('plain failure');
        }),
      /plain failure/,
    );
    assert.equal(attempts, 1, 'a non-retryable error must be raised on the first attempt');
  });

  it('forwards its options rather than silently using the defaults', async () => {
    // The delegation bug this catches: `$retry(fn, options)` calling
    // `withRetry(fn)` would still pass every test above, because the default
    // maxAttempts is 3.
    let attempts = 0;
    const seen: number[] = [];
    await assert.rejects(() =>
      client().$retry(
        async () => {
          attempts++;
          throw new DeadlockError({ message: 'deadlock detected' });
        },
        { maxAttempts: 5, baseDelay: 1, onRetry: (_e, n) => seen.push(n) },
      ),
    );
    assert.equal(attempts, 5, 'maxAttempts must reach withRetry');
    assert.deepEqual(seen, [1, 2, 3, 4], 'onRetry must reach withRetry, once per retry');
  });
});

describe('TurbineClient.$observe', () => {
  /**
   * A sink that records what it is handed. Behaviour, not listener counts:
   * TurbineClient exposes `$on`/`$off` rather than an EventEmitter surface, and
   * what actually matters is whether queries reach the engine, which is what a
   * caller would notice.
   */
  function recordingSink() {
    const batches: { rows: unknown[] }[] = [];
    return {
      batches,
      rowCount: () => batches.reduce((n, b) => n + b.rows.length, 0),
      sink: {
        async flush(batch: { rows: unknown[] }) {
          if (batch.rows.length) batches.push(batch);
        },
      },
    };
  }

  const config = (sink: unknown) => ({ sink, flushIntervalMs: 60_000 }) as never;

  it('routes queries to the sink, and the handle stops routing them', async () => {
    const db = client();
    const rec = recordingSink();
    const handle = await db.$observe(config(rec.sink));

    await db.table('users').findMany({});
    await handle.stop(); // stop() flushes what it buffered
    const afterStop = rec.rowCount();
    assert.ok(afterStop > 0, 'the observed query should have reached the sink');

    // Anything after stop() must not be observed: the handle detaches.
    await db.table('users').findMany({});
    const rec2 = recordingSink();
    const handle2 = await db.$observe(config(rec2.sink));
    await handle2.stop();
    assert.equal(rec.rowCount(), afterStop, 'a stopped observer must receive nothing further');
  });

  it('replacing an active observer stops the previous one', async () => {
    // Two engines both listening would double-count every query, which looks
    // like a traffic spike rather than a bug.
    const db = client();
    const first = recordingSink();
    const second = recordingSink();
    const h1 = await db.$observe(config(first.sink));
    const h2 = await db.$observe(config(second.sink));

    await db.table('users').findMany({});
    await h2.stop();
    // The superseded engine must be FLUSHED before its emptiness means
    // anything: an engine that is still attached buffers silently, so without
    // this the assertion below passes whether or not it was detached. A mutant
    // that deleted the stop-the-previous-engine block escaped this test until
    // the flush was added.
    await h1.stop();

    assert.ok(second.rowCount() > 0, 'the newest observer should receive the query');
    assert.equal(first.rowCount(), 0, 'the superseded observer must not still be attached');
  });
});

describe('TurbineClient.pipelineSupported', () => {
  it('hands the client pool to the probe and returns its answer', async () => {
    // The inert pool's client has no `connection` object, so the extended-query
    // path is unavailable and the honest answer is false.
    assert.equal(await client().pipelineSupported(), false);
  });
});
