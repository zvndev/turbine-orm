/**
 * Studio — security-perimeter tests for the HTTP dispatch layer.
 *
 * The existing `studio.test.ts` calls the route handlers directly, bypassing
 * the dispatch perimeter (auth token, cross-origin refusal, rate limiting).
 * These tests cover that perimeter by BEHAVIOR, not implementation, so they
 * stay valid if the token comparison is swapped (e.g. to
 * `crypto.timingSafeEqual`):
 *
 *   • DB-less (always run): the read-only guarantee. Every DB interaction in
 *     `apiBuilder` / `apiTableRows` is wrapped in `BEGIN READ ONLY ... COMMIT`,
 *     and no mutating statement is ever emitted, so a write can never escape
 *     the transaction. Exercised through the exported handlers with a mock pool.
 *
 *   • End-to-end perimeter (DB-gated via `skipGate`): a real Studio server is
 *     started with `startStudio` and driven over HTTP so the genuine dispatch
 *     function runs. Asserts: no/wrong token → 401, correct token → 200,
 *     cross-origin Origin → 403, exceeding 100 req / 60s → 429.
 *     `startStudio` connects to and introspects a live database, so this half
 *     is gated on DATABASE_URL and skips cleanly under `npm run test:unit`.
 *     (The dispatch function `handleRequest` is module-private and cannot be
 *     reached DB-less without modifying `studio.ts`, which these tests do not.)
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type pg from 'pg';
import {
  apiBuilder,
  apiTableRows,
  type StudioContext,
  type StudioHandle,
  type StudioOptions,
  startStudio,
} from '../cli/studio.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock HTTP req/res + mock pg.Pool (same pattern as studio.test.ts) so the
// read-only assertions can exercise the real exported handlers without a DB.
// ---------------------------------------------------------------------------

interface RecordedResponse {
  status: number;
  body: string;
  json: unknown;
}

function makeRes(): { res: ServerResponse; done: Promise<RecordedResponse> } {
  let resolveDone!: (r: RecordedResponse) => void;
  const done = new Promise<RecordedResponse>((r) => {
    resolveDone = r;
  });
  let status = 0;
  const res = {
    writeHead(s: number) {
      status = s;
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
      resolveDone({ status, body, json });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function makeReq(bodyObj: unknown): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(bodyObj), 'utf8');
  async function* iter() {
    yield payload;
  }
  return iter() as unknown as IncomingMessage;
}

interface QueryCall {
  text: string;
  values: unknown[];
}

function makePool(): { pool: pg.Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const respond = () => ({ rows: [] as unknown[], rowCount: 0, fields: [] as Array<{ name: string }> });
  const client = {
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return respond();
    },
    release() {
      /* no-op */
    },
  };
  const pool = {
    async connect() {
      return client;
    },
    async query(text: string, values: unknown[] = []) {
      calls.push({ text, values });
      return respond();
    },
    async end() {
      /* no-op */
    },
  } as unknown as pg.Pool;
  return { pool, calls };
}

function makeCtx(pool: pg.Pool, stateDir: string): StudioContext {
  const options: StudioOptions = {
    url: 'postgres://fake',
    schema: 'public',
    port: 0,
    host: '127.0.0.1',
    openBrowser: false,
    stateDir,
  };
  const metadata: SchemaMetadata = {
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'email', field: 'email', pgType: 'text' },
      ]),
    },
    enums: {},
  };
  return {
    pool,
    metadata,
    options,
    authToken: 'test-token',
    stateDir,
    statementTimeout: { sql: `SELECT set_config('statement_timeout', $1, true)`, params: ['30s'] },
    rateLimiter: new Map(),
  };
}

/** Any statement that could change data or schema — must never be emitted by Studio. */
const MUTATING = /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE)\b/i;

// ---------------------------------------------------------------------------
// Read-only guarantee — runs DB-less in `npm run test:unit`.
// ---------------------------------------------------------------------------

describe('Studio security — read-only transaction guarantee (DB-less)', () => {
  it('apiBuilder opens BEGIN READ ONLY, commits, and emits no write', async () => {
    const { pool, calls } = makePool();
    const ctx = makeCtx(pool, tmpdir());
    const req = makeReq({ table: 'users', args: { where: { name: 'Alice' }, limit: 10 } });
    const { res, done } = makeRes();

    await apiBuilder(req, res, ctx);
    const response = await done;

    assert.equal(response.status, 200);
    // The very first statement on the checked-out connection opens a READ ONLY txn.
    assert.equal(calls[0]?.text.trim(), 'BEGIN READ ONLY');
    assert.ok(
      calls.some((c) => c.text.trim() === 'COMMIT'),
      'the read-only transaction must be committed',
    );
    for (const c of calls) {
      assert.doesNotMatch(c.text, MUTATING, `Studio must never emit a mutating statement: ${c.text}`);
    }
  });

  it('apiTableRows opens BEGIN READ ONLY, commits, and emits no write', async () => {
    const { pool, calls } = makePool();
    const ctx = makeCtx(pool, tmpdir());
    const { res, done } = makeRes();

    await apiTableRows(res, ctx, 'users', new URLSearchParams());
    const response = await done;

    assert.equal(response.status, 200);
    assert.equal(calls[0]?.text.trim(), 'BEGIN READ ONLY');
    assert.ok(
      calls.some((c) => c.text.trim() === 'COMMIT'),
      'the read-only transaction must be committed',
    );
    for (const c of calls) {
      assert.doesNotMatch(c.text, MUTATING, `Studio must never emit a mutating statement: ${c.text}`);
    }
  });
});

// ---------------------------------------------------------------------------
// HTTP dispatch perimeter — end-to-end against a real server.
// Gated on DATABASE_URL because startStudio probes + introspects a live DB.
// ---------------------------------------------------------------------------

const dbUrl = process.env.DATABASE_URL;
const dbGate = skipGate(!dbUrl, 'requires DATABASE_URL (live Postgres for startStudio)');

/** Grab an ephemeral free port on the loopback interface. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface SimpleResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Minimal GET via node:http with `agent: false` — every request uses a fresh,
 * non-keep-alive connection that closes after the response, so the server's
 * `close()` in dispose never blocks on a pooled socket.
 */
function httpGet(url: string, headers: Record<string, string> = {}): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'GET', headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Studio security — HTTP dispatch perimeter (end-to-end)', () => {
  let handle: StudioHandle | undefined;
  let base = '';
  let token = '';

  dbGate.before(async () => {
    const port = await getFreePort();
    handle = await startStudio({
      url: dbUrl as string,
      schema: 'public',
      port,
      host: '127.0.0.1',
      openBrowser: false,
    });
    base = `http://127.0.0.1:${port}`;
    token = handle.authToken;
  });

  dbGate.after(async () => {
    await handle?.dispose();
  });

  dbGate.it('rejects an /api request with no token (401)', async () => {
    const r = await httpGet(`${base}/api/schema`);
    assert.equal(r.status, 401);
  });

  dbGate.it('rejects an /api request with a wrong token (401)', async () => {
    const r = await httpGet(`${base}/api/schema`, { 'x-turbine-token': 'not-the-real-token-deadbeef' });
    assert.equal(r.status, 401);
  });

  dbGate.it('accepts an /api request with the correct token (200)', async () => {
    const r = await httpGet(`${base}/api/schema`, { 'x-turbine-token': token });
    assert.equal(r.status, 200);
    const json = JSON.parse(r.body) as { tables: unknown[] };
    assert.ok(Array.isArray(json.tables), 'schema response should carry a tables array');
  });

  dbGate.it('refuses a cross-origin request (403) even with a valid token', async () => {
    const r = await httpGet(`${base}/api/schema`, {
      'x-turbine-token': token,
      Origin: 'http://evil.example',
    });
    assert.equal(r.status, 403);
  });

  dbGate.it('returns 429 once the per-session rate limit is exceeded', async () => {
    // Drive well past the 100 req / 60s threshold on the authenticated session.
    let sawRateLimit = false;
    let retryAfter: string | undefined;
    for (let i = 0; i < 130; i++) {
      const r = await httpGet(`${base}/api/schema`, { 'x-turbine-token': token });
      if (r.status === 429) {
        sawRateLimit = true;
        retryAfter = r.headers['retry-after'] as string | undefined;
        break;
      }
      assert.equal(r.status, 200, `request ${i} should be allowed before the limit`);
    }
    assert.ok(sawRateLimit, 'expected a 429 after exceeding the rate limit');
    assert.ok(retryAfter !== undefined, 'a 429 must include a Retry-After header');
  });
});
