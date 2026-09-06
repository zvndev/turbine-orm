/**
 * Two transport-level contracts of the MCP server, both about what happens on
 * the ONE pooled client a session holds.
 *
 * 1. Catalog reads are SERIAL. `loadSchemaMetadata` used to issue its seven
 *    catalog queries in one `Promise.all` on the client `withReadOnly` had
 *    checked out, which node-postgres tolerates today by queueing them with a
 *    `DeprecationWarning` (`Calling client.query() when the client is already
 *    executing a query ... will be removed in pg@9.0`) on every session, and
 *    which pg 9 refuses outright. Asserted structurally, through a client that
 *    counts in-flight queries, so it holds whichever driver version is
 *    installed.
 *
 * 2. A framing loss ENDS the session. After the 8 MiB unframed-buffer refusal
 *    the server used to write `-32600`, detach its stdin listener, and then
 *    neither exit nor answer, so a supervisor saw a live process that would
 *    never speak again. The handle now resolves `closed` with the reason and
 *    the pool is ended, which is what lets `runMcpServer` return and the
 *    process exit non-zero.
 *
 * Run: npx tsx --test src/test/mcp-transport-bounds.test.ts
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { MAX_STDIO_BUFFER_BYTES, startMcpServer } from '../cli/mcp.js';
import type { PgCompatPool } from '../pg-types.js';

interface PoolTrace {
  /** Highest number of queries in flight at once on the checked-out client. */
  maxInFlight: number;
  /** Every SQL text, in the order the calls were MADE. */
  calls: string[];
  ended: boolean;
}

/**
 * A pool whose single client answers every catalog query with no rows, one
 * macrotask later, and records how many queries were outstanding when each
 * call was made. A `Promise.all` over seven queries drives `maxInFlight` to 7;
 * sequential awaits keep it at 1.
 */
function tracingPool(trace: PoolTrace): PgCompatPool {
  let inFlight = 0;
  const client = {
    query(sql: string) {
      trace.calls.push(sql);
      inFlight++;
      trace.maxInFlight = Math.max(trace.maxInFlight, inFlight);
      return new Promise((resolve) =>
        setImmediate(() => {
          inFlight--;
          resolve({ rows: [], rowCount: 0, fields: [] });
        }),
      );
    },
    release() {},
  };
  return {
    connect: () => Promise.resolve(client),
    query: () => Promise.resolve({ rows: [], rowCount: 0, fields: [] }),
    end: () => {
      trace.ended = true;
      return Promise.resolve();
    },
  } as unknown as PgCompatPool;
}

function harness(pool: PgCompatPool) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: string[] = [];
  output.on('data', (c: Buffer) => {
    for (const l of c.toString().split('\n')) if (l.trim()) lines.push(l);
  });
  const handle = startMcpServer(
    { url: 'postgres://example.invalid/turbine', schema: 'public', migrationsDir: './turbine/migrations' },
    { input, output, pool },
  );
  return { input, lines, handle };
}

async function waitFor(pred: () => boolean, label: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('MCP: catalog queries run one at a time on the shared client', () => {
  it('schema_overview never has two queries in flight on the checked-out client', async () => {
    const trace: PoolTrace = { maxInFlight: 0, calls: [], ended: false };
    const { input, lines, handle } = harness(tracingPool(trace));
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'schema_overview', arguments: {} } })}\n`,
    );
    await waitFor(() => lines.length >= 1, 'the schema_overview reply');
    const reply = JSON.parse(lines[0]!);
    assert.equal(reply.error, undefined, JSON.stringify(reply).slice(0, 300));

    // Anti-vacuous: the catalog was actually read (seven queries plus the
    // transaction bookkeeping), so a serial result is not "nothing ran".
    const catalog = trace.calls.filter((sql) => /information_schema|pg_catalog|pg_indexes|pg_enum/i.test(sql));
    assert.ok(catalog.length >= 7, `expected the seven catalog queries, saw ${catalog.length}`);
    assert.equal(
      trace.maxInFlight,
      1,
      `${trace.maxInFlight} queries were in flight at once on one client (pg queues these with a DeprecationWarning today and refuses them in pg@9)`,
    );
    await handle.dispose();
  });
});

describe('MCP stdio: a framing loss ends the session, not just the reader', () => {
  it('after the unframed-buffer refusal the handle reports closed and the pool is ended', async () => {
    const trace: PoolTrace = { maxInFlight: 0, calls: [], ended: false };
    const { input, lines, handle } = harness(tracingPool(trace));

    // One byte past the bound, no newline, in socket-sized chunks.
    const chunk = 'x'.repeat(1024 * 1024);
    for (let sent = 0; sent < MAX_STDIO_BUFFER_BYTES; sent += chunk.length) input.write(chunk);
    input.write('x');

    const reason = await Promise.race([
      handle.closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('the server never signalled close after the refusal')), 2000),
      ),
    ]);
    assert.equal(reason, 'framing-lost');
    assert.ok(
      lines.some((l) => JSON.parse(l)?.error?.code === -32600),
      `the -32600 refusal must still be written first, got ${JSON.stringify(lines).slice(0, 300)}`,
    );
    assert.equal(trace.ended, true, 'the pool must be ended so the process can exit');
    // Idempotent with the explicit path a signal handler takes.
    await handle.dispose();
  });

  it('an explicit dispose() resolves closed with "disposed", so a supervisor can tell the two apart', async () => {
    const trace: PoolTrace = { maxInFlight: 0, calls: [], ended: false };
    const { handle } = harness(tracingPool(trace));
    await handle.dispose();
    assert.equal(await handle.closed, 'disposed');
    assert.equal(trace.ended, true);
  });
});
