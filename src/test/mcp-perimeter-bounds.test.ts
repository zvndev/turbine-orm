/**
 * The MCP server's three UNBOUNDED-INPUT perimeters, closed in 0.76.0.
 *
 * None of these is a query-builder bug; all three are the surrounding transport
 * accepting something with no ceiling on it, which is the class the 0.75.0
 * review found the query builder to be clean of and the tooling not to be.
 *
 *   1. the stdio reader's unframed buffer (a peer that never sends `\n`)
 *   2. the fail-closed "does this arg name a column" test, which read the top
 *      level only, so a nested `with.where` slipped past it
 *   3. the shared rate limiter's key map, which never evicted
 *
 * Each is asserted at the scale that made it a defect, not at a token one: a
 * bound tested with two inputs is a bound nobody has measured.
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { carriesColumnNamingArg } from '../cli/compile-query.js';
import { startMcpServer } from '../cli/mcp.js';
import { checkRateLimit } from '../cli/rate-limit.js';

describe('MCP stdio: the unframed buffer is bounded', () => {
  /** Drive the real reader loop; the transport is exercised, the pool never is. */
  function harness() {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (c: Buffer) => {
      for (const l of c.toString().split('\n')) if (l.trim()) lines.push(l);
    });
    const handle = startMcpServer(
      { url: 'postgres://example.invalid/turbine', schema: 'public', migrationsDir: './turbine/migrations' },
      { input, output },
    );
    return { input, lines, handle };
  }

  it('a line that never terminates does not grow without limit', async () => {
    const { input, lines, handle } = harness();
    // 12 MiB with no newline, past the 8 MiB bound, delivered in chunks the way
    // a socket would. Asserted through the PROTOCOL reply rather than by
    // reaching into the buffer, so it holds however the reader is rewritten.
    const chunk = 'x'.repeat(1024 * 1024);
    for (let i = 0; i < 12; i++) input.write(chunk);
    await new Promise((r) => setImmediate(r));

    const refusal = lines.map((l) => JSON.parse(l)).find((m) => m?.error?.message === 'Message too large');
    assert.ok(refusal, `expected a "Message too large" refusal, got ${JSON.stringify(lines).slice(0, 400)}`);
    assert.equal(refusal.error.code, -32600);

    // And the session is closed rather than resynchronized: continuing would
    // splice the tail of the over-long line onto whatever arrives next.
    const before = lines.length;
    input.write('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await new Promise((r) => setImmediate(r));
    assert.equal(lines.length, before, 'the reader must be detached after a framing loss');
    await handle.dispose();
  });

  it('many complete messages are unaffected however much they total', async () => {
    // Anti-vacuous for the bound above: it is on the UNFRAMED remainder, so a
    // client sending far more than 8 MiB in properly framed lines must be fine.
    const { input, lines, handle } = harness();
    const line = `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"${'y'.repeat(200_000)}"}}\n`;
    for (let i = 0; i < 60; i++) input.write(line); // ~12 MiB, all framed
    await new Promise((r) => setImmediate(r));
    assert.ok(
      !lines.some((l) => l.includes('Message too large')),
      'framed traffic must never trip the unframed-remainder bound',
    );
    await handle.dispose();
  });
});

describe('compile_query fail-closed: the column-naming test reaches every depth', () => {
  // The refusal this feeds fires when the PII tag file cannot be read, so
  // `false` is a claim that the query CANNOT be filtering on a hidden column.
  for (const [label, args, expected] of [
    ['top-level where', { where: { id: 1 } }, true],
    ['nested with.where', { with: { posts: { where: { secretNote: { not: null } } } } }, true],
    ['depth-3 with.orderBy', { with: { posts: { with: { author: { orderBy: { email: 'asc' } } } } } }, true],
    ['orderBy in array form, nested', { with: { posts: { orderBy: [{ id: 'asc' }] } } }, true],
    ['nested cursor', { with: { posts: { cursor: { id: 5 } } } }, true],
    // These must stay FALSE or the tool refuses queries it can prove are safe.
    ['bare with', { with: { posts: true } }, false],
    ['with limit only', { with: { posts: { limit: 5 } } }, false],
    ['select at any depth', { with: { posts: { select: { title: true } } } }, false],
    ['omit at any depth', { with: { posts: { omit: { body: true } } } }, false],
    ['no naming args at all', { limit: 10 }, false],
  ] as [string, Record<string, unknown>, boolean][]) {
    it(`${label} -> ${expected}`, () => {
      assert.equal(carriesColumnNamingArg(args), expected);
    });
  }

  it('errs toward refusing past the depth cap', () => {
    // Fail-closed means the cap answers TRUE. Built past PII_GUARD_MAX_DEPTH
    // with nothing that names a column, so a `false` here could only come from
    // running out of depth and shrugging.
    let deep: Record<string, unknown> = { limit: 1 };
    for (let i = 0; i < 40; i++) deep = { with: { rel: deep } };
    assert.equal(carriesColumnNamingArg(deep), true);
  });
});

describe('rate limiter: the key map is bounded and evicts safely', () => {
  it('50,000 distinct callers do not grow the map without limit', () => {
    const limiter = new Map<string, { count: number; resetAt: number }>();
    for (let i = 0; i < 50_000; i++) checkRateLimit(limiter, `10.0.${(i / 256) | 0}.${i % 256}`);
    assert.ok(limiter.size <= 10_000, `expected the map bounded at 10k keys, got ${limiter.size}`);
    // Anti-vacuous: a limiter that dropped everything would also satisfy the
    // bound, so it must still be tracking a real population.
    assert.ok(limiter.size > 1_000, `expected the map to still track callers, got ${limiter.size}`);
  });

  it('eviction can only forgive a caller, never deny one within budget', () => {
    const limiter = new Map<string, { count: number; resetAt: number }>();
    checkRateLimit(limiter, 'me');
    for (let i = 0; i < 20_000; i++) checkRateLimit(limiter, `other-${i}`);
    assert.equal(checkRateLimit(limiter, 'me').allowed, true);
  });

  it('the budget itself is unchanged for a single caller', () => {
    // The eviction must not have become a way to reset your own window.
    const limiter = new Map<string, { count: number; resetAt: number }>();
    let denied = 0;
    for (let i = 0; i < 150; i++) if (!checkRateLimit(limiter, 'one').allowed) denied++;
    assert.ok(denied > 0, 'the limiter must still deny past its budget');
  });
});
