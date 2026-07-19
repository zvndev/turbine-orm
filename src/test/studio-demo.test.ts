/**
 * Studio: demo mode (`turbine studio --demo`).
 *
 * These tests drive the real dispatch function `handleRequest` DB-less but with
 * the REAL in-memory `node:sqlite` demo store (via `createDemoContext`), so they
 * exercise the genuine SQLite dialect path end to end: schema payload, PII
 * redaction, the builder's nested-relation query, the live mode switcher, the
 * write flow, and per-launch isolation. No DATABASE_URL, no container, no server.
 *
 * `node:sqlite` is a builtin only on Node >= 22.5, so (like sqlite.test.ts) we
 * probe for it WITHOUT a static import and register every test skipped when it
 * is absent, rather than crashing the whole unit lane.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { describe, it as nodeIt } from 'node:test';
import { handleRequest, PII_REDACTED, type StudioContext, type StudioOptions } from '../cli/studio.js';
import { createDemoContext } from '../cli/studio-demo.js';

const hasSqlite: boolean = (() => {
  try {
    return typeof createRequire(process.cwd())('node:sqlite').DatabaseSync === 'function';
  } catch {
    return false;
  }
})();

const it: typeof nodeIt = hasSqlite
  ? nodeIt
  : (((name: string) =>
      nodeIt(name, { skip: 'studio --demo requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof nodeIt);

// ---------------------------------------------------------------------------
// Mock req / res
// ---------------------------------------------------------------------------

interface RecordedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  json: unknown;
}

function makeRes(): { res: ServerResponse; done: Promise<RecordedResponse> } {
  let resolveDone!: (r: RecordedResponse) => void;
  const done = new Promise<RecordedResponse>((r) => {
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
  } as unknown as ServerResponse;
  return { res, done };
}

interface ReqOpts {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function makeReq(opts: ReqOpts): IncomingMessage {
  const payload = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body), 'utf8') : Buffer.alloc(0);
  const req = {
    method: opts.method,
    url: opts.url,
    headers: opts.headers ?? {},
    async *[Symbol.asyncIterator]() {
      if (payload.length) yield payload;
    },
  };
  return req as unknown as IncomingMessage;
}

// ---------------------------------------------------------------------------
// Context wiring (mirrors startStudio's demo branch)
// ---------------------------------------------------------------------------

const HOST = '127.0.0.1';
const PORT = 0;
const ORIGIN = `http://${HOST}:${PORT}`;
const TOKEN = 'test-token';

function makeDemoCtx(): StudioContext {
  const demo = createDemoContext();
  const options: StudioOptions = {
    url: 'demo://in-memory',
    schema: 'public',
    port: PORT,
    host: HOST,
    openBrowser: false,
    stateDir: tmpdir(),
    demo: true,
  };
  return {
    pool: demo.pool,
    metadata: demo.metadata,
    options,
    authToken: TOKEN,
    stateDir: tmpdir(),
    statementTimeout: { sql: 'SELECT 1', params: [] },
    rateLimiter: new Map(),
    writable: false,
    showPii: false,
    demo: true,
    dialect: demo.dialect,
  };
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-turbine-token': TOKEN, origin: ORIGIN, ...extra };
}

async function dispatch(ctx: StudioContext, opts: ReqOpts): Promise<RecordedResponse> {
  const req = makeReq(opts);
  const { res, done } = makeRes();
  await handleRequest(req, res, ctx);
  return done;
}

// ---------------------------------------------------------------------------
// Boot / schema payload
// ---------------------------------------------------------------------------

describe('Studio demo: schema payload', () => {
  it('reports demo:true, writable:false, showPii:false with the seeded tables', async () => {
    const ctx = makeDemoCtx();
    const r = await dispatch(ctx, { method: 'GET', url: '/api/schema', headers: authHeaders() });
    assert.equal(r.status, 200, r.body);
    const json = r.json as {
      demo: boolean;
      writable: boolean;
      showPii: boolean;
      tables: Array<{ name: string; estimatedRows: number; columns: Array<{ name: string; pii: boolean }> }>;
    };
    assert.equal(json.demo, true);
    assert.equal(json.writable, false);
    assert.equal(json.showPii, false);

    const names = json.tables.map((t) => t.name).sort();
    assert.deepEqual(names, ['comments', 'orgs', 'posts', 'users']);

    const users = json.tables.find((t) => t.name === 'users');
    assert.ok(users, 'users table present');
    assert.equal(users?.estimatedRows, 8, 'seeded row count is exact in demo');
    const piiCols = users?.columns
      .filter((c) => c.pii)
      .map((c) => c.name)
      .sort();
    assert.deepEqual(piiCols, ['email', 'phone'], 'email + phone tagged PII');
  });
});

// ---------------------------------------------------------------------------
// Data tab: PII redaction + search/orderBy exclusion
// ---------------------------------------------------------------------------

describe('Studio demo: table rows + PII', () => {
  it('redacts email and phone by default', async () => {
    const ctx = makeDemoCtx();
    const r = await dispatch(ctx, { method: 'GET', url: '/api/tables/users?limit=8', headers: authHeaders() });
    assert.equal(r.status, 200, r.body);
    const json = r.json as { rows: Array<Record<string, unknown>> };
    assert.equal(json.rows.length, 8);
    for (const row of json.rows) {
      // email is NOT NULL in the seed, so it is always redacted.
      assert.equal(row.email, PII_REDACTED, 'email redacted');
      // name (non-PII) shows through.
      assert.equal(typeof row.name, 'string');
      assert.notEqual(row.name, PII_REDACTED);
      // phone is non-null for most users → redacted; null stays null.
      if (row.phone !== null) assert.equal(row.phone, PII_REDACTED, 'non-null phone redacted');
    }
  });

  it('search matches a non-PII column but never a redacted PII column', async () => {
    const ctx = makeDemoCtx();
    // "Ada" only appears in the (non-PII) name column.
    const byName = await dispatch(ctx, {
      method: 'GET',
      url: `/api/tables/users?search=${encodeURIComponent('Ada')}`,
      headers: authHeaders(),
    });
    const nameJson = byName.json as { rows: Array<{ name: string }>; total: number };
    assert.ok(nameJson.total >= 1, 'name search hits');
    assert.ok(nameJson.rows.some((row) => row.name === 'Ada Lovelace'));

    // "@example.com" only appears in the (redacted) email column, which is
    // excluded from the search OR-set → no rows, no substring oracle.
    const byEmail = await dispatch(ctx, {
      method: 'GET',
      url: `/api/tables/users?search=${encodeURIComponent('@example.com')}`,
      headers: authHeaders(),
    });
    const emailJson = byEmail.json as { total: number };
    assert.equal(emailJson.total, 0, 'PII column excluded from search');
  });
});

// ---------------------------------------------------------------------------
// Builder: nested relations through the SQLite dialect
// ---------------------------------------------------------------------------

describe('Studio demo: builder with relations', () => {
  it('returns nested relation rows (proves the SQLite dialect path)', async () => {
    const ctx = makeDemoCtx();
    const r = await dispatch(ctx, {
      method: 'POST',
      url: '/api/builder',
      headers: authHeaders(),
      body: { table: 'users', args: { with: { posts: true }, limit: 3 } },
    });
    assert.equal(r.status, 200, r.body);
    const json = r.json as { sql: string; rows: Array<Record<string, unknown>> };
    // SQLite dialect signature: json_group_array, not Postgres json_agg.
    assert.match(json.sql, /json_group_array/i);
    assert.ok(json.rows.length > 0, 'has user rows');
    const withPosts = json.rows.find((row) => Array.isArray(row.posts) && (row.posts as unknown[]).length > 0);
    assert.ok(withPosts, 'at least one user has a parsed posts array');
    const firstPost = (withPosts?.posts as Array<Record<string, unknown>>)[0];
    assert.equal(typeof firstPost?.title, 'string', 'nested post row is a real object');
  });
});

// ---------------------------------------------------------------------------
// Live mode switcher
// ---------------------------------------------------------------------------

describe('Studio demo: /api/demo/mode switcher', () => {
  it('flipping showPii:true reveals real email values', async () => {
    const ctx = makeDemoCtx();
    const flip = await dispatch(ctx, {
      method: 'POST',
      url: '/api/demo/mode',
      headers: authHeaders(),
      body: { showPii: true },
    });
    assert.equal(flip.status, 200, flip.body);
    assert.equal((flip.json as { showPii: boolean }).showPii, true);

    const rows = await dispatch(ctx, { method: 'GET', url: '/api/tables/users?limit=1', headers: authHeaders() });
    const json = rows.json as { rows: Array<{ email: string }> };
    assert.equal(json.rows[0]?.email, 'ada@example.com', 'email now shown');
  });

  it('flipping writable:true opens the write routes and edits stick in memory', async () => {
    const ctx = makeDemoCtx();

    // Write route is closed on boot (read-only).
    const closed = await dispatch(ctx, {
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 1 }, data: { name: 'Should Fail' } },
    });
    assert.equal(closed.status, 404, 'write route absent while read-only');

    // Flip to writable.
    const flip = await dispatch(ctx, {
      method: 'POST',
      url: '/api/demo/mode',
      headers: authHeaders(),
      body: { writable: true, showPii: true },
    });
    assert.equal(flip.status, 200, flip.body);
    assert.equal((flip.json as { writable: boolean }).writable, true);

    // Update sticks.
    const upd = await dispatch(ctx, {
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 1 }, data: { name: 'Ada Byron' } },
    });
    assert.equal(upd.status, 200, upd.body);

    // A subsequent read shows the new value (write applied to the in-memory store).
    const rows = await dispatch(ctx, { method: 'GET', url: '/api/tables/users?limit=8', headers: authHeaders() });
    const json = rows.json as { rows: Array<{ id: number; name: string }> };
    const ada = json.rows.find((row) => row.id === 1);
    assert.equal(ada?.name, 'Ada Byron', 'edit persisted for the process lifetime');
  });

  it('requires auth and a matching Origin', async () => {
    const ctx = makeDemoCtx();

    // No token → 401 (global auth gate).
    const noAuth = await dispatch(ctx, {
      method: 'POST',
      url: '/api/demo/mode',
      headers: { origin: ORIGIN },
      body: { showPii: true },
    });
    assert.equal(noAuth.status, 401);

    // Token but no Origin → 403 (CSRF guard on the state-changing route).
    const noOrigin = await dispatch(ctx, {
      method: 'POST',
      url: '/api/demo/mode',
      headers: { 'x-turbine-token': TOKEN },
      body: { showPii: true },
    });
    assert.equal(noOrigin.status, 403);
  });

  it('is 404 when the context is not demo', async () => {
    const ctx = makeDemoCtx();
    ctx.demo = false; // simulate a normal (non-demo) Studio
    const r = await dispatch(ctx, {
      method: 'POST',
      url: '/api/demo/mode',
      headers: authHeaders(),
      body: { showPii: true },
    });
    assert.equal(r.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Per-launch isolation
// ---------------------------------------------------------------------------

describe('Studio demo: isolation', () => {
  it('a second demo context starts pristine (no leaked edits)', async () => {
    const ctxA = makeDemoCtx();
    await dispatch(ctxA, {
      method: 'POST',
      url: '/api/demo/mode',
      headers: authHeaders(),
      body: { writable: true },
    });
    await dispatch(ctxA, {
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 1 }, data: { name: 'Mutated In A' } },
    });

    // A fresh context must not see A's edit.
    const ctxB = makeDemoCtx();
    const rows = await dispatch(ctxB, { method: 'GET', url: '/api/tables/users?limit=8', headers: authHeaders() });
    const json = rows.json as { rows: Array<{ id: number; name: string }> };
    const ada = json.rows.find((row) => row.id === 1);
    assert.equal(ada?.name, 'Ada Lovelace', 'second launch is pristine');
  });
});
