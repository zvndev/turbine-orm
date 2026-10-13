/**
 * Studio and Observe: the second layer of the loopback perimeter.
 *
 * The token, CSP, rate limit and Origin checks already stood. What this file pins
 * is what sat beside them:
 *
 *  - a `Host` allowlist, so a page on another domain that re-resolves to this
 *    loopback port (DNS rebinding) is refused before any route logic runs;
 *  - a ONE-TIME login ticket in the printed URL, separate from the session
 *    credential, so a URL left in browser history or a process listing is spent;
 *  - request bodies over the limit refused with 413 before they are buffered, and
 *    malformed ones with 400 (both used to surface as 500);
 *  - Studio's Query tab capped in rows, and its saved queries capped in count;
 *  - a PII column named in a Query-tab `select` served REDACTED (core now refuses
 *    the bare name, and Studio, which redacts every row, is the caller that grants
 *    the opt-in), while a request-supplied `includePii: true` stays refused.
 *
 * Most tests drive `handleRequest` with fake request and response objects. A few
 * start the real server and speak HTTP to it.
 *
 * Run: npx tsx --test src/test/security-perimeter-local-servers.test.ts
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { createLoginGate, isAllowedHostHeader, redeemLogin } from '../cli/local-server-guard.js';
import { type ObserveOptions, handleRequest as observeRequest, startObserve } from '../cli/observe.js';
import {
  handleRequest,
  MAX_BUILDER_ROWS,
  PII_REDACTED,
  type StudioContext,
  type StudioOptions,
  startStudio,
} from '../cli/studio.js';
import { createDemoContext } from '../cli/studio-demo.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// The Host allowlist, as a table
// ---------------------------------------------------------------------------

describe('isAllowedHostHeader', () => {
  const PORT = 4983;
  const allowed: Array<[string, string]> = [
    ['127.0.0.1:4983', '127.0.0.1'],
    ['localhost:4983', '127.0.0.1'],
    ['LOCALHOST:4983', '127.0.0.1'],
    ['[::1]:4983', '127.0.0.1'],
    ['127.0.0.1:4983', '::1'],
    ['[::1]:4983', '::1'],
    ['localhost:4983', '[::1]'],
    ['studio.internal:4983', 'studio.internal'],
    ['Studio.Internal:4983', 'studio.internal'],
    ['10.1.2.3:4983', '0.0.0.0'],
    ['[fe80::1]:4983', '::'],
  ];
  const refused: Array<[string, string]> = [
    ['evil.example:4983', '127.0.0.1'],
    ['evil.example', '127.0.0.1'],
    ['127.0.0.1.evil.example:4983', '127.0.0.1'],
    ['localhost.evil.example:4983', '127.0.0.1'],
    ['evil.example:4983', '0.0.0.0'],
    ['rebind.attacker.test:4983', '::'],
    ['127.0.0.1:9999', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['localhost:4983, evil.example', '127.0.0.1'],
    ['', '127.0.0.1'],
    ['  ', '127.0.0.1'],
    ['[::1', '127.0.0.1'],
    ['::1:4983', '127.0.0.1'],
    ['a:b:4983', '127.0.0.1'],
    ['127.0.0.1:port', '127.0.0.1'],
    ['studio.internal:4983', '127.0.0.1'],
  ];

  for (const [header, bound] of allowed) {
    it(`allows "${header}" on a server bound to ${bound}`, () => {
      assert.equal(isAllowedHostHeader(header, bound, PORT), true);
    });
  }
  for (const [header, bound] of refused) {
    it(`refuses "${header}" on a server bound to ${bound}`, () => {
      assert.equal(isAllowedHostHeader(header, bound, PORT), false);
    });
  }

  it('allows an absent header (an HTTP/1.0 client; a browser always sends one)', () => {
    assert.equal(isAllowedHostHeader(undefined, '127.0.0.1', PORT), true);
  });

  it('refuses a header that arrived as an array', () => {
    assert.equal(isAllowedHostHeader(['localhost:4983', 'evil.example'], '127.0.0.1', PORT), false);
  });

  it('accepts a host with no port only on port 80', () => {
    assert.equal(isAllowedHostHeader('localhost', '127.0.0.1', 80), true);
    assert.equal(isAllowedHostHeader('localhost', '127.0.0.1', 8080), false);
  });
});

describe('one-time login gate', () => {
  it('grants once, then reports used; a wrong token is invalid and never spends it', () => {
    const gate = createLoginGate();
    assert.equal(redeemLogin(gate, 'nope'), 'invalid');
    assert.equal(gate.used, false, 'a wrong guess does not burn the ticket');
    assert.equal(redeemLogin(gate, gate.token), 'granted');
    assert.equal(redeemLogin(gate, gate.token), 'used');
    assert.equal(redeemLogin(gate, 'nope'), 'invalid');
  });

  it('mints a distinct ticket per gate', () => {
    assert.notEqual(createLoginGate().token, createLoginGate().token);
  });
});

// ---------------------------------------------------------------------------
// Fake request / response plumbing
// ---------------------------------------------------------------------------

interface Recorded {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  json: unknown;
}

function makeRes(): { res: http.ServerResponse; done: Promise<Recorded> } {
  let resolveDone!: (r: Recorded) => void;
  const done = new Promise<Recorded>((r) => {
    resolveDone = r;
  });
  let status = 0;
  let headers: Record<string, string | number> = {};
  const res = {
    setHeader(k: string, v: string | number) {
      headers[k] = v;
    },
    writeHead(s: number, h?: Record<string, string | number>) {
      status = s;
      headers = { ...headers, ...(h ?? {}) };
      return this;
    },
    end(payload?: string) {
      const body = payload ?? '';
      let json: unknown = null;
      try {
        json = body ? JSON.parse(body) : null;
      } catch {
        json = null;
      }
      resolveDone({ status, headers, body, json });
    },
  } as unknown as http.ServerResponse;
  return { res, done };
}

const HOST = '127.0.0.1';
const PORT = 4983;
const ORIGIN = `http://${HOST}:${PORT}`;
const SESSION = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718';

function request(
  method: string,
  url: string,
  headers: Record<string, string>,
  chunks: Buffer[] = [],
  onChunk?: () => void,
): http.IncomingMessage {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        onChunk?.();
        yield chunk;
      }
    },
  } as unknown as http.IncomingMessage;
}

function json(value: unknown): Buffer[] {
  return [Buffer.from(JSON.stringify(value), 'utf8')];
}

// ---------------------------------------------------------------------------
// Studio fixtures
// ---------------------------------------------------------------------------

function options(): StudioOptions {
  return {
    url: 'demo://in-memory',
    schema: 'public',
    port: PORT,
    host: HOST,
    openBrowser: false,
    stateDir: tmpdir(),
    demo: true,
  };
}

function demoCtx(extra: Partial<StudioContext> = {}): StudioContext {
  const demo = createDemoContext();
  return {
    pool: demo.pool,
    metadata: demo.metadata,
    options: options(),
    authToken: SESSION,
    stateDir: tmpdir(),
    statementTimeout: { sql: 'SELECT 1', params: [] },
    rateLimiter: new Map(),
    writable: false,
    showPii: false,
    demo: true,
    dialect: demo.dialect,
    ...extra,
  };
}

async function studio(
  ctx: StudioContext,
  method: string,
  url: string,
  headers: Record<string, string> = {},
  chunks: Buffer[] = [],
): Promise<Recorded> {
  const { res, done } = makeRes();
  await handleRequest(request(method, url, { host: `${HOST}:${PORT}`, ...headers }, chunks), res, ctx);
  return done;
}

const authed = { 'x-turbine-token': SESSION, origin: ORIGIN };

// ---------------------------------------------------------------------------
// Studio: Host header
// ---------------------------------------------------------------------------

describe('Studio refuses a foreign Host before any route runs', () => {
  it('403 on the API with a valid token, on the shell, on the favicon, and with a ticket', async () => {
    const ctx = demoCtx();
    const evil = { host: 'evil.example:4983' };
    for (const [method, url, extra] of [
      ['GET', '/api/schema', authed],
      ['GET', '/', {}],
      ['GET', '/favicon.ico', {}],
      ['GET', `/?token=${SESSION}`, {}],
    ] as const) {
      const r = await studio(ctx, method, url, { ...extra, ...evil });
      assert.equal(r.status, 403, `${method} ${url}`);
      assert.match(String((r.json as { error: string }).error), /host not allowed/);
    }
  });

  it('the same requests pass with the right Host (the refusal is the Host, not the route)', async () => {
    const ctx = demoCtx();
    assert.equal((await studio(ctx, 'GET', '/api/schema', authed)).status, 200);
    assert.equal((await studio(ctx, 'GET', '/', {})).status, 200);
    assert.equal((await studio(ctx, 'GET', '/api/schema', { ...authed, host: `localhost:${PORT}` })).status, 200);
  });

  it('a rebinding attempt does not spend the login ticket', async () => {
    const login = createLoginGate();
    const ctx = demoCtx({ login });
    const refused = await studio(ctx, 'GET', `/?token=${login.token}`, { host: 'evil.example:4983' });
    assert.equal(refused.status, 403);
    assert.equal(login.used, false);
    const granted = await studio(ctx, 'GET', `/?token=${login.token}`);
    assert.equal(granted.status, 302);
  });
});

// ---------------------------------------------------------------------------
// Studio: one-time ticket
// ---------------------------------------------------------------------------

describe('Studio login ticket is single use and is not the session credential', () => {
  it('exchanges the ticket for the SESSION cookie, once', async () => {
    const login = createLoginGate();
    assert.notEqual(login.token, SESSION, 'fixture: ticket and session credential differ');
    const ctx = demoCtx({ login });

    const first = await studio(ctx, 'GET', `/?token=${login.token}`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.Location, '/');
    const cookie = String(first.headers['Set-Cookie']);
    assert.match(cookie, /^turbine_studio_token=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.ok(cookie.includes(SESSION), 'the cookie carries the session credential');
    assert.equal(cookie.includes(login.token), false, 'the ticket itself is never stored as the credential');

    const replay = await studio(ctx, 'GET', `/?token=${login.token}`);
    assert.equal(replay.status, 403, 'a replayed ticket opens nothing');
    assert.equal(replay.headers['Set-Cookie'], undefined, 'and sets no cookie');
    assert.match(replay.body, /already used/);
  });

  it('a signed-in browser that reloads the old URL is sent back to / without a new cookie', async () => {
    const login = createLoginGate();
    const ctx = demoCtx({ login });
    await studio(ctx, 'GET', `/?token=${login.token}`);
    const reload = await studio(ctx, 'GET', `/?token=${login.token}`, { cookie: `turbine_studio_token=${SESSION}` });
    assert.equal(reload.status, 302);
    assert.equal(reload.headers.Location, '/');
    assert.equal(reload.headers['Set-Cookie'], undefined);
  });

  it('the ticket does not authorize the API, as a header or as a cookie', async () => {
    const login = createLoginGate();
    const ctx = demoCtx({ login });
    const attempts: Record<string, string>[] = [
      { 'x-turbine-token': login.token },
      { cookie: `turbine_studio_token=${login.token}` },
    ];
    for (const headers of attempts) {
      const r = await studio(ctx, 'GET', '/api/schema', headers);
      assert.equal(r.status, 401);
    }
  });

  it('a HEAD request carrying the ticket does not spend it', async () => {
    const login = createLoginGate();
    const ctx = demoCtx({ login });
    const head = await studio(ctx, 'HEAD', `/?token=${login.token}`);
    assert.equal(head.status, 200, 'served the shell, redeemed nothing');
    assert.equal(login.used, false);
    assert.equal((await studio(ctx, 'GET', `/?token=${login.token}`)).status, 302);
  });

  it('a wrong token still gets the shell and no cookie, as before', async () => {
    const ctx = demoCtx({ login: createLoginGate() });
    const r = await studio(ctx, 'GET', '/?token=not-it');
    assert.equal(r.status, 200);
    assert.equal(r.headers['Set-Cookie'], undefined);
  });

  it('a hand-built context with no gate uses its own token as the ticket, once', async () => {
    const ctx = demoCtx();
    assert.equal((await studio(ctx, 'GET', `/?token=${SESSION}`)).status, 302);
    assert.equal((await studio(ctx, 'GET', `/?token=${SESSION}`)).status, 403);
  });
});

// ---------------------------------------------------------------------------
// Studio: request bodies
// ---------------------------------------------------------------------------

describe('Studio request bodies: 413 before buffering, 400 for malformed', () => {
  const post = (ctx: StudioContext, headers: Record<string, string>, chunks: Buffer[], onChunk?: () => void) => {
    const { res, done } = makeRes();
    const req = request('POST', '/api/builder', { host: `${HOST}:${PORT}`, ...authed, ...headers }, chunks, onChunk);
    return handleRequest(req, res, ctx).then(() => done);
  };

  it('refuses a declared Content-Length over the limit, and runs nothing', async () => {
    const { pool, calls } = recordingPool();
    const ctx = pgCtx(pool, widgetSchema());
    const r = await post(ctx, { 'content-length': String(2 * 1024 * 1024) }, json({ table: 'widgets', args: {} }));
    assert.equal(r.status, 413);
    assert.match(String((r.json as { error: string }).error), /too large/);
    assert.equal(calls.length, 0, 'the oversized request reached no database call');
  });

  it('counts a chunked body and answers 413 once it passes the limit, even though it keeps arriving', async () => {
    const chunk = Buffer.alloc(400 * 1024, 0x20);
    const r = await post(demoCtx(), {}, [chunk, chunk, chunk, chunk, chunk, chunk]);
    assert.equal(r.status, 413);
  });

  it('discards at most a bounded amount of an endless body, then drops the connection', async () => {
    let read = 0;
    let destroyed = false;
    const chunk = Buffer.alloc(512 * 1024, 0x20);
    const req = {
      method: 'POST',
      url: '/api/builder',
      headers: { host: `${HOST}:${PORT}`, ...authed },
      destroy() {
        destroyed = true;
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          read++;
          yield chunk;
          if (read > 1000) return; // a runaway guard for the test itself
        }
      },
    } as unknown as http.IncomingMessage;
    const { res, done } = makeRes();
    await handleRequest(req, res, demoCtx());
    assert.equal((await done).status, 413);
    assert.equal(destroyed, true, 'the connection was dropped');
    assert.ok(read <= 40, `read ${read} chunks of an endless stream; the discard must be bounded (16 MiB)`);
  });

  it('a body exactly at the limit is not refused for size', async () => {
    const pad = ' '.repeat(1024 * 1024 - 2);
    const r = await post(demoCtx(), {}, [Buffer.from(`{}${pad}`)]);
    assert.notEqual(r.status, 413);
  });

  it('malformed JSON is 400, not 500', async () => {
    const r = await post(demoCtx(), {}, [Buffer.from('{"table": ')]);
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /invalid json/);
  });

  it('a body that is JSON but not an object is 400', async () => {
    for (const body of ['[1,2]', 'null', '"x"', '7']) {
      const r = await post(demoCtx(), {}, [Buffer.from(body)]);
      assert.equal(r.status, 400, body);
      assert.match(String((r.json as { error: string }).error), /must be a JSON object/);
    }
  });

  it('applies to the other body routes too (saved queries, demo mode switch)', async () => {
    const ctx = demoCtx();
    const { res, done } = makeRes();
    await handleRequest(
      request('POST', '/api/saved-queries', { host: `${HOST}:${PORT}`, ...authed, 'content-length': '5000000' }),
      res,
      ctx,
    );
    assert.equal((await done).status, 413);
  });
});

// ---------------------------------------------------------------------------
// Studio: row cap, saved-query cap
// ---------------------------------------------------------------------------

function widgetSchema(): SchemaMetadata {
  const widgets: TableMetadata = mockTable('widgets', [
    { name: 'id', field: 'id' },
    { name: 'label', field: 'label', pgType: 'text' },
  ]);
  return { enums: {}, tables: { widgets } };
}

/** A recording pool answering every statement with an empty result. */
function recordingPool(): { pool: pg.Pool; calls: Array<{ text: string; values: unknown[] }> } {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return { rows: [], rowCount: 0, fields: [] };
    },
    release() {},
  };
  const pool = { connect: async () => client, query: client.query, end: async () => {} } as unknown as pg.Pool;
  return { pool, calls };
}

function pgCtx(pool: pg.Pool, metadata: SchemaMetadata): StudioContext {
  return {
    pool: pool as unknown as StudioContext['pool'],
    metadata,
    options: { ...options(), demo: false },
    authToken: SESSION,
    stateDir: tmpdir(),
    statementTimeout: { sql: `SELECT set_config('statement_timeout', $1, true)`, params: ['30s'] },
    rateLimiter: new Map(),
    writable: false,
    showPii: false,
  };
}

describe('Studio Query tab caps the rows a request can load', () => {
  const run = async (args: Record<string, unknown>) => {
    const { pool, calls } = recordingPool();
    const r = await studio(
      pgCtx(pool, widgetSchema()),
      'POST',
      '/api/builder',
      { ...authed, 'content-type': 'application/json' },
      json({ table: 'widgets', args }),
    );
    const select = calls.find((c) => /FROM "widgets"/.test(c.text));
    return { r, select };
  };

  it('supplies a limit when the request has none', async () => {
    const { r, select } = await run({});
    assert.equal(r.status, 200, r.body);
    assert.ok(select, 'the SELECT ran');
    assert.match(select.text, /LIMIT/);
    assert.ok(select.values.includes(MAX_BUILDER_ROWS), `bound ${JSON.stringify(select.values)}`);
  });

  it('clamps a limit over the cap, and a take over the cap', async () => {
    for (const args of [{ limit: 5_000_000 }, { take: 5_000_000 }]) {
      const { r, select } = await run(args);
      assert.equal(r.status, 200, r.body);
      assert.ok(select!.values.includes(MAX_BUILDER_ROWS), JSON.stringify(args));
      assert.equal(select!.values.includes(5_000_000), false, 'the huge value never reaches the database');
    }
  });

  it('leaves a smaller limit alone', async () => {
    const { select } = await run({ limit: 25 });
    assert.ok(select!.values.includes(25));
    assert.equal(select!.values.includes(MAX_BUILDER_ROWS), false);
  });

  it('reports the cap and whether it may have ended the list', async () => {
    const { r } = await run({});
    const body = r.json as { rowLimit: number; truncated: boolean };
    assert.equal(body.rowLimit, MAX_BUILDER_ROWS);
    assert.equal(body.truncated, false, 'zero rows is not a truncated list');
  });
});

describe('Studio saved queries are capped in count', () => {
  it('refuses the 501st with the fix named', async () => {
    const ctx = demoCtx();
    const save = (n: number) => {
      ctx.rateLimiter.clear(); // 501 requests would otherwise trip the 100/min limiter first
      return studio(
        ctx,
        'POST',
        '/api/saved-queries',
        { ...authed },
        json({ table: 'users', name: `q${n}`, kind: 'builder', args: {} }),
      );
    };
    for (let i = 0; i < 500; i++) assert.equal((await save(i)).status, 200, `save ${i}`);
    const over = await save(500);
    assert.equal(over.status, 400);
    assert.match(String((over.json as { error: string }).error), /at most 500 saved queries/);
  });
});

// ---------------------------------------------------------------------------
// Studio: PII named in a select is served redacted
// ---------------------------------------------------------------------------

describe('Studio Query tab: a PII column in select is served redacted, never raw', () => {
  const builder = (ctx: StudioContext, args: unknown) =>
    studio(ctx, 'POST', '/api/builder', { ...authed }, json({ table: 'users', args }));

  it('top-level select naming a PII column returns the marker, not the value', async () => {
    const r = await builder(demoCtx(), { select: { id: true, email: true }, limit: 3 });
    assert.equal(r.status, 200, r.body);
    const rows = (r.json as { rows: Array<Record<string, unknown>> }).rows;
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.email, PII_REDACTED);
    assert.doesNotMatch(r.body, /@example\.com/);
  });

  it('a nested relation select is redacted, and so is a sibling relation with no select', async () => {
    const r = await studio(
      demoCtx(),
      'POST',
      '/api/builder',
      { ...authed },
      json({
        table: 'posts',
        args: {
          with: { author: { select: { id: true, email: true } } },
          limit: 2,
        },
      }),
    );
    assert.equal(r.status, 200, r.body);
    assert.doesNotMatch(r.body, /@example\.com/);
  });

  it('a top-level select naming PII does not widen a sibling relation: its PII is still redacted', async () => {
    // The opt-in is per query, so a relation with no select of its own would now
    // fetch its PII columns. The server-side redaction is what keeps them off the wire.
    const r = await studio(
      demoCtx(),
      'POST',
      '/api/builder',
      { ...authed },
      json({
        table: 'users',
        args: { select: { id: true, email: true }, with: { posts: { limit: 1 } }, limit: 2 },
      }),
    );
    assert.equal(r.status, 200, r.body);
    assert.doesNotMatch(r.body, /@example\.com/);
  });

  it('a request-supplied includePii: true is still refused (only the UNSAFE symbol unlocks)', async () => {
    const r = await builder(demoCtx(), { includePii: true, limit: 2 });
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /includePii|UNSAFE/);
    const withSelect = await builder(demoCtx(), { includePii: true, select: { email: true }, limit: 2 });
    assert.doesNotMatch(withSelect.body, /@example\.com/, 'combining it with a PII select leaks nothing');
  });

  it('a select that names no PII column is unchanged (no grant is made)', async () => {
    const r = await builder(demoCtx(), { select: { id: true, name: true }, limit: 2 });
    assert.equal(r.status, 200, r.body);
  });

  it('with --show-pii the value is served, which proves the redaction above is not vacuous', async () => {
    const r = await builder(demoCtx({ showPii: true }), { select: { id: true, email: true }, limit: 2 });
    assert.equal(r.status, 200, r.body);
    assert.match(r.body, /@example\.com/);
  });
});

// ---------------------------------------------------------------------------
// Studio: messages escape names
// ---------------------------------------------------------------------------

describe('Studio messages escape names', () => {
  it('an unknown table is shown escaped, and so are the available tables', async () => {
    const r = await studio(
      demoCtx(),
      'POST',
      '/api/builder',
      { ...authed },
      json({ table: 'no\u001b[2Jpe‮', args: {} }),
    );
    assert.equal(r.status, 400);
    const message = String((r.json as { error: string }).error);
    assert.equal(message.includes('\u001b'), false, 'no raw ESC');
    assert.equal(message.includes('‮'), false, 'no raw bidi override');
    assert.match(message, /no\\u001b\[2Jpe\\u202e/);
  });
});

// ---------------------------------------------------------------------------
// Real servers
// ---------------------------------------------------------------------------

interface Wire {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function wire(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('a real Studio server (demo store)', () => {
  it('prints a one-time ticket, honours the Host allowlist and answers an oversized body with 413', async () => {
    const port = await freePort();
    const handle = await startStudio({ ...options(), port });
    try {
      const url = new URL(handle.url);
      const ticket = url.searchParams.get('token');
      assert.ok(ticket, 'the printed URL carries a ticket');
      assert.notEqual(ticket, handle.authToken, 'and it is not the session credential');
      assert.equal(handle.url.includes(handle.authToken), false);

      // A foreign Host never reaches the ticket.
      const rebound = await wire(port, 'GET', `/?token=${ticket}`, { Host: 'evil.example' });
      assert.equal(rebound.status, 403);

      const first = await wire(port, 'GET', `/?token=${ticket}`);
      assert.equal(first.status, 302);
      const cookie = String(first.headers['set-cookie']?.[0] ?? '');
      assert.ok(cookie.includes(handle.authToken));

      const second = await wire(port, 'GET', `/?token=${ticket}`);
      assert.equal(second.status, 403, 'the ticket is spent');

      const api = await wire(port, 'GET', '/api/schema', { Cookie: cookie.split(';')[0]!, Host: `127.0.0.1:${port}` });
      assert.equal(api.status, 200);

      const rebindApi = await wire(port, 'GET', '/api/schema', {
        Cookie: cookie.split(';')[0]!,
        Host: 'evil.example',
      });
      assert.equal(rebindApi.status, 403, 'a valid session cookie is not enough behind a foreign Host');

      // Oversized body: declared length over the limit, real bytes behind it.
      const big = Buffer.alloc(1024 * 1024 + 4096, 0x20);
      const tooBig = await wire(
        port,
        'POST',
        '/api/builder',
        {
          Cookie: cookie.split(';')[0]!,
          Origin: `http://127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': String(big.length),
        },
        big,
      );
      assert.equal(tooBig.status, 413);

      // The server survived it.
      const after = await wire(port, 'GET', '/api/schema', { Cookie: cookie.split(';')[0]! });
      assert.equal(after.status, 200);
    } finally {
      await handle.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------

describe('Observe: the same Host allowlist and one-time ticket', () => {
  const OBSERVE: ObserveOptions = { url: 'postgres://fake', port: PORT, host: HOST, openBrowser: false };
  const TOKEN = 'abcdef0123456789abcdef0123456789abcdef0123456789';
  const NO_POOL = {} as unknown as pg.Pool;

  async function observe(
    url: string,
    headers: Record<string, string>,
    login?: ReturnType<typeof createLoginGate>,
    method = 'GET',
  ): Promise<Recorded> {
    const { res, done } = makeRes();
    const req = request(method, url, { host: `${HOST}:${PORT}`, ...headers });
    if (login) await observeRequest(req, res, NO_POOL, OBSERVE, TOKEN, new Map(), login);
    else await observeRequest(req, res, NO_POOL, OBSERVE, TOKEN, new Map());
    return done;
  }

  it('refuses a foreign Host everywhere, including with a valid token', async () => {
    for (const [url, headers] of [
      ['/api/latency', { 'x-turbine-token': TOKEN }],
      ['/', {}],
      [`/?token=${TOKEN}`, {}],
    ] as const) {
      const r = await observe(url, { ...headers, host: 'evil.example:4983' });
      assert.equal(r.status, 403, url);
      assert.match(String((r.json as { error: string }).error), /host not allowed/);
    }
  });

  it('exchanges the ticket for the session cookie once and not again', async () => {
    const login = createLoginGate();
    const first = await observe(`/?token=${login.token}`, {}, login);
    assert.equal(first.status, 302);
    const cookie = String(first.headers['Set-Cookie']);
    assert.match(cookie, /^turbine_observe_token=/);
    assert.ok(cookie.includes(TOKEN) && !cookie.includes(login.token));

    const replay = await observe(`/?token=${login.token}`, {}, login);
    assert.equal(replay.status, 403);
    assert.equal(replay.headers['Set-Cookie'], undefined);

    const ticketAsCredential = await observe('/api/latency', { 'x-turbine-token': login.token }, login);
    assert.equal(ticketAsCredential.status, 401);
  });

  it('a hand-built dispatch with no gate treats the token as the ticket, once', async () => {
    assert.equal((await observe(`/?token=${TOKEN}`, {})).status, 302);
    assert.equal((await observe(`/?token=${TOKEN}`, {})).status, 403);
  });
});

describe('a real Observe server', () => {
  const dbUrl = process.env.DATABASE_URL;
  const live = skipGate(!dbUrl, 'requires DATABASE_URL (live Postgres for startObserve)');

  live.it(
    'prints a one-time ticket, honours the Host allowlist, and keeps the session credential out of the URL',
    async () => {
      const port = await freePort();
      const handle = await startObserve({ url: dbUrl as string, port, host: '127.0.0.1', openBrowser: false });
      try {
        const ticket = new URL(handle.url).searchParams.get('token');
        assert.ok(ticket);
        assert.notEqual(ticket, handle.authToken);
        assert.equal(handle.url.includes(handle.authToken), false);

        assert.equal((await wire(port, 'GET', `/?token=${ticket}`, { Host: 'evil.example' })).status, 403);

        const first = await wire(port, 'GET', `/?token=${ticket}`);
        assert.equal(first.status, 302);
        const cookie = String(first.headers['set-cookie']?.[0] ?? '');
        assert.match(cookie, /^turbine_observe_token=/);
        assert.ok(cookie.includes(handle.authToken));

        assert.equal((await wire(port, 'GET', `/?token=${ticket}`)).status, 403, 'the ticket is spent');
        assert.equal(
          (await wire(port, 'GET', '/api/models', { Cookie: cookie.split(';')[0]!, Host: 'evil.example' })).status,
          403,
          'a valid session cookie is not enough behind a foreign Host',
        );
      } finally {
        await handle.dispose();
      }
    },
  );
});
