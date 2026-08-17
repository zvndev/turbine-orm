/**
 * `pipelineSupported`, the runtime probe behind `client.pipelineSupported()`.
 *
 * It answers "will a pipeline take the real 1-RTT extended-query path, or fall
 * back to sequential execution", by checking out a connection and duck-typing
 * the driver's wire object. Both the exported function (pipeline.ts) and the
 * client method that delegates to it were reached by no test at all, which
 * matters more than it looks: every failure mode here is SILENT. A probe that
 * wrongly says false costs the batching this module exists for and nothing
 * errors; a probe that leaks the connection it checks out drains the pool a few
 * calls later, somewhere else entirely.
 *
 * `supportsExtendedPipeline`, the shape check itself, was already covered in
 * pipeline-submittable.test.ts. What was missing is everything around it: the
 * acquire, the release, and the failure path.
 *
 * Found by a public-method sweep against the test corpus during the 0.73.1
 * audit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PgCompatPool } from '../pg-types.js';
import { pipelineSupported } from '../pipeline.js';

/** The six connection methods `supportsExtendedPipeline` requires. */
const WIRE_METHODS = ['parse', 'bind', 'describe', 'execute', 'sync', 'on'] as const;

function connection(omit?: (typeof WIRE_METHODS)[number]): Record<string, unknown> {
  const conn: Record<string, unknown> = {};
  for (const m of WIRE_METHODS) if (m !== omit) conn[m] = () => {};
  return conn;
}

interface Probe {
  pool: PgCompatPool;
  acquired: number;
  released: number;
}

function poolWith(client: unknown, opts?: { failConnect?: boolean }): Probe {
  const probe: Probe = { acquired: 0, released: 0, pool: undefined as unknown as PgCompatPool };
  probe.pool = {
    async connect() {
      if (opts?.failConnect) throw new Error('pool exhausted');
      probe.acquired++;
      return Object.assign({} as Record<string, unknown>, client as object, {
        release() {
          probe.released++;
        },
      });
    },
    async query() {
      return { rows: [], rowCount: 0 };
    },
    async end() {},
    on() {},
  } as unknown as PgCompatPool;
  return probe;
}

describe('pipelineSupported', () => {
  it('is true when the checked-out client exposes the full extended-query wire', async () => {
    const probe = poolWith({ connection: connection() });
    assert.equal(await pipelineSupported(probe.pool), true);
  });

  for (const missing of WIRE_METHODS) {
    it(`is false when the connection is missing ${missing}()`, async () => {
      // One case per method rather than one representative: the check is a
      // conjunction, so a dropped clause is invisible unless the method it
      // dropped is the one being omitted.
      const probe = poolWith({ connection: connection(missing) });
      assert.equal(await pipelineSupported(probe.pool), false);
    });
  }

  it('is false when the client has no connection object at all', async () => {
    // The serverless / HTTP drivers are this shape: pg-compatible for queries,
    // with no wire protocol underneath.
    const probe = poolWith({});
    assert.equal(await pipelineSupported(probe.pool), false);
  });

  it('is false, not a throw, when the pool cannot hand out a connection', async () => {
    const probe = poolWith({ connection: connection() }, { failConnect: true });
    assert.equal(await pipelineSupported(probe.pool), false);
  });

  it('releases the connection it checked out', async () => {
    // The whole probe is one acquire; leaking it would drain the pool silently.
    const probe = poolWith({ connection: connection() });
    await pipelineSupported(probe.pool);
    assert.equal(probe.acquired, 1, 'should check out exactly one connection');
    assert.equal(probe.released, 1, 'should release the connection it checked out');
  });

  it('releases the connection even when the answer is false', async () => {
    const probe = poolWith({});
    await pipelineSupported(probe.pool);
    assert.equal(probe.released, 1, 'an unsupported pool must not leak its probe connection');
  });
});
