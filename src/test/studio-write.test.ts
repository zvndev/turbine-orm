/**
 * Studio — write mode, PII redaction, and origin/nonce hardening.
 *
 * These tests drive the real dispatch function `handleRequest` DB-less: a mock
 * pg.Pool records every statement, and a fake IncomingMessage/ServerResponse
 * pair carries the method, url, headers, and body. That exercises the genuine
 * perimeter (auth token, cross-origin refusal, write-route gating, CSRF Origin
 * check, CSP nonce) plus the write + redaction handlers, without a server or DB.
 *
 * The existing studio-security.test.ts notes that `handleRequest` was
 * module-private; it is now exported so this half can run under
 * `npm run test:unit`.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { handleRequest, PII_REDACTED, type StudioContext, type StudioOptions } from '../cli/studio.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Mock req / res / pool
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

interface QueryCall {
  text: string;
  values: unknown[];
}

type Programmed = { rows?: unknown[]; fields?: Array<{ name: string }> };

function makePool(programmed: Programmed[] = []): { pool: pg.Pool; calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  let next = 0;
  const respond = () => {
    const p = programmed[next++] ?? {};
    const rows = p.rows ?? [];
    return {
      rows,
      rowCount: rows.length,
      fields: (p.fields ?? []).map((f) => ({ name: f.name, dataTypeID: 0 })),
    };
  };
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

// ---------------------------------------------------------------------------
// Schema fixture: users (email is PII) hasMany posts (secret is PII)
// ---------------------------------------------------------------------------

function buildSchema(): SchemaMetadata {
  const postsRel: RelationDef = {
    type: 'hasMany',
    name: 'posts',
    from: 'users',
    to: 'posts',
    foreignKey: 'user_id',
    referenceKey: 'id',
  };
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
    ],
    { posts: postsRel },
  );
  markPii(users, 'email');

  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'secret', field: 'secret', pgType: 'text' },
  ]);
  markPii(posts, 'secret');

  return { tables: { users, posts }, enums: {} };
}

function markPii(table: TableMetadata, columnName: string): void {
  const col = table.columns.find((c) => c.name === columnName);
  if (col) col.pii = true;
}

const HOST = '127.0.0.1';
const PORT = 0;
const ORIGIN = `http://${HOST}:${PORT}`;
const TOKEN = 'test-token';

function makeCtx(pool: pg.Pool, opts: { writable?: boolean; showPii?: boolean } = {}): StudioContext {
  const options: StudioOptions = {
    url: 'postgres://fake',
    schema: 'public',
    port: PORT,
    host: HOST,
    openBrowser: false,
    stateDir: tmpdir(),
    write: opts.writable,
    showPii: opts.showPii,
  };
  return {
    pool,
    metadata: buildSchema(),
    options,
    authToken: TOKEN,
    stateDir: tmpdir(),
    statementTimeout: { sql: `SELECT set_config('statement_timeout', $1, true)`, params: ['30s'] },
    rateLimiter: new Map(),
    writable: opts.writable === true,
    showPii: opts.showPii === true,
  };
}

/** The first statement that is not a txn/setup control call. */
function firstDataQuery(calls: QueryCall[]): QueryCall {
  const ignore = /^(BEGIN|COMMIT|ROLLBACK|SET\b|SELECT set_config\()/i;
  for (const c of calls) {
    if (!ignore.test(c.text.trim())) return c;
  }
  throw new Error('no data query recorded');
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-turbine-token': TOKEN, origin: ORIGIN, ...extra };
}

// ---------------------------------------------------------------------------
// Write-route gating: routes 404 in read-only mode
// ---------------------------------------------------------------------------

describe('Studio write — route gating (read-only mode)', () => {
  for (const op of ['update', 'insert', 'delete']) {
    it(`returns 404 for /api/row/${op} when write mode is off`, async () => {
      const { pool } = makePool();
      const ctx = makeCtx(pool, { writable: false });
      const req = makeReq({
        method: 'POST',
        url: `/api/row/${op}`,
        headers: authHeaders(),
        body: { table: 'users', where: { id: 1 }, data: { name: 'x' } },
      });
      const { res, done } = makeRes();
      await handleRequest(req, res, ctx);
      const r = await done;
      assert.equal(r.status, 404);
    });
  }

  it('reports writable:false in the schema payload when read-only', async () => {
    const { pool } = makePool([{ rows: [] }]); // pg_class counts query
    const ctx = makeCtx(pool, { writable: false });
    const req = makeReq({ method: 'GET', url: '/api/schema', headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 200);
    const json = r.json as { writable: boolean };
    assert.equal(json.writable, false);
  });
});

// ---------------------------------------------------------------------------
// Write-route round-trips (write mode + valid token + Origin)
// ---------------------------------------------------------------------------

describe('Studio write — single-row round-trips', () => {
  it('update compiles a parameterized UPDATE with a PK-covering WHERE in a plain txn', async () => {
    const { pool, calls } = makePool([
      {}, // BEGIN
      {}, // set_config statement_timeout
      {}, // set_config search_path
      { rows: [{ id: 1, name: 'Bob', email: 'bob@x.com' }], fields: [{ name: 'id' }] }, // UPDATE ... RETURNING *
      {}, // COMMIT
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 1 }, data: { name: 'Bob' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    // Plain write txn: BEGIN, never BEGIN READ ONLY.
    assert.equal(calls[0]?.text.trim(), 'BEGIN');
    assert.ok(!calls.some((c) => /READ ONLY/i.test(c.text)), 'a write must not open a READ ONLY txn');
    assert.ok(calls.some((c) => c.text.trim() === 'COMMIT'));

    const write = firstDataQuery(calls);
    assert.match(write.text, /^UPDATE "users"/);
    assert.match(write.text, /SET "name" = \$1/);
    assert.match(write.text, /WHERE "id" = \$2/);
    assert.match(write.text, /RETURNING \*/);
    assert.deepEqual(write.values, ['Bob', 1]);

    const json = r.json as { operation: string; row: Record<string, unknown> };
    assert.equal(json.operation, 'update');
    assert.equal(json.row.id, 1);
  });

  it('insert compiles a parameterized INSERT ... RETURNING *', async () => {
    const { pool, calls } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 7, name: 'Ada', email: 'ada@x.com' }], fields: [{ name: 'id' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/insert',
      headers: authHeaders(),
      body: { table: 'users', data: { name: 'Ada', email: 'ada@x.com' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    assert.equal(calls[0]?.text.trim(), 'BEGIN');
    const write = firstDataQuery(calls);
    assert.match(write.text, /^INSERT INTO "users"/);
    assert.match(write.text, /VALUES \(\$1, \$2\)/);
    assert.match(write.text, /RETURNING \*/);
    assert.deepEqual(write.values, ['Ada', 'ada@x.com']);
  });

  it('delete compiles a parameterized DELETE with a PK-covering WHERE', async () => {
    const { pool, calls } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 3, name: 'Gone', email: 'g@x.com' }], fields: [{ name: 'id' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/delete',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 3 } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const write = firstDataQuery(calls);
    assert.match(write.text, /^DELETE FROM "users"/);
    assert.match(write.text, /WHERE "id" = \$1/);
    assert.deepEqual(write.values, [3]);
  });

  it('rejects an update whose where does not cover the primary key (400)', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { name: 'Bob' }, data: { name: 'x' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /primary key/i);
  });

  it('rejects an unknown column in data (400)', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/insert',
      headers: authHeaders(),
      body: { table: 'users', data: { nope: 'x' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /unknown column/i);
  });
});

// ---------------------------------------------------------------------------
// CSRF + auth on write routes
// ---------------------------------------------------------------------------

describe('Studio write — auth + CSRF perimeter', () => {
  it('rejects a mutation with an ABSENT Origin header (403)', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: { 'x-turbine-token': TOKEN }, // no Origin
      body: { table: 'users', where: { id: 1 }, data: { name: 'x' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 403);
    assert.match((r.json as { error: string }).error, /origin/i);
  });

  it('rejects a mutation with a wrong token (401) before the Origin check', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: { 'x-turbine-token': 'wrong-token', origin: ORIGIN },
      body: { table: 'users', where: { id: 1 }, data: { name: 'x' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 401);
  });
});

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

describe('Studio PII — redaction on the wire', () => {
  it('redacts PII columns in table rows by default', async () => {
    const { pool } = makePool([
      {}, // BEGIN READ ONLY
      {}, // set_config statement_timeout
      { rows: [{ id: 1, name: 'Bob', email: 'bob@secret.com' }], fields: [{ name: 'id' }] }, // main
      { rows: [{ count: '1' }] }, // count
      {}, // COMMIT
    ]);
    const ctx = makeCtx(pool, {});
    const req = makeReq({ method: 'GET', url: '/api/tables/users', headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 200, r.body);
    const rows = (r.json as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(rows[0]?.email, PII_REDACTED);
    assert.equal(rows[0]?.name, 'Bob', 'non-PII columns are untouched');
  });

  it('redacts PII in builder rows AND nested relation rows', async () => {
    const { pool } = makePool([
      {}, // BEGIN READ ONLY
      {}, // set_config statement_timeout
      {}, // set_config search_path
      {
        rows: [
          {
            id: 1,
            name: 'Bob',
            email: 'bob@secret.com',
            posts: [{ id: 9, userId: 1, secret: 'top-secret' }],
          },
        ],
        fields: [{ name: 'id' }],
      }, // findMany
      {}, // COMMIT
    ]);
    const ctx = makeCtx(pool, {});
    const req = makeReq({
      method: 'POST',
      url: '/api/builder',
      headers: authHeaders(),
      body: { table: 'users', args: { with: { posts: true }, limit: 10 } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 200, r.body);
    const row = (r.json as { rows: Array<Record<string, unknown>> }).rows[0]!;
    assert.equal(row.email, PII_REDACTED, 'top-level PII redacted');
    const posts = row.posts as Array<Record<string, unknown>>;
    assert.equal(posts[0]?.secret, PII_REDACTED, 'nested relation PII redacted');
    assert.equal(posts[0]?.id, 9, 'nested non-PII untouched');
  });

  it('reveals PII when the server runs with --show-pii', async () => {
    const { pool } = makePool([
      {},
      {},
      { rows: [{ id: 1, name: 'Bob', email: 'bob@secret.com' }], fields: [{ name: 'id' }] },
      { rows: [{ count: '1' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { showPii: true });
    const req = makeReq({ method: 'GET', url: '/api/tables/users', headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    const rows = (r.json as { rows: Array<Record<string, unknown>> }).rows;
    assert.equal(rows[0]?.email, 'bob@secret.com');
  });

  it('redacts the echoed row after a write to a PII column', async () => {
    const { pool } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 1, name: 'Bob', email: 'new@secret.com' }], fields: [{ name: 'id' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 1 }, data: { email: 'new@secret.com' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 200, r.body);
    const json = r.json as { row: Record<string, unknown> };
    assert.equal(json.row.email, PII_REDACTED);
  });

  it('badges PII columns in the schema payload', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = makeCtx(pool, {});
    const req = makeReq({ method: 'GET', url: '/api/schema', headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    const tables = (r.json as { tables: Array<{ name: string; columns: Array<{ name: string; pii: boolean }> }> })
      .tables;
    const users = tables.find((t) => t.name === 'users')!;
    const email = users.columns.find((c) => c.name === 'email')!;
    const name = users.columns.find((c) => c.name === 'name')!;
    assert.equal(email.pii, true);
    assert.equal(name.pii, false);
  });
});

// ---------------------------------------------------------------------------
// CSP nonce hardening
// ---------------------------------------------------------------------------

describe('Studio hardening — CSP nonce on the HTML shell', () => {
  it('serves a per-request nonce and drops unsafe-inline from script-src', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, {});
    // No token → the index route serves the HTML shell (not a redirect).
    const req = makeReq({ method: 'GET', url: '/' });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 200);
    const csp = String(r.headers['Content-Security-Policy']);
    assert.match(csp, /script-src 'self' 'nonce-[^']+'/, 'CSP carries a script nonce');
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, "script-src must not allow 'unsafe-inline'");
    // The served HTML must carry the same nonce on its inline script and must
    // not leak the placeholder token.
    assert.doesNotMatch(r.body, /__CSP_NONCE__/, 'the nonce placeholder must be substituted');
    assert.match(r.body, /<script nonce="[^"]+">/, 'the inline script is stamped with a nonce');
  });

  it('mints a different nonce on each HTML response', async () => {
    const ctx = makeCtx(makePool().pool, {});
    const first = makeRes();
    await handleRequest(makeReq({ method: 'GET', url: '/' }), first.res, ctx);
    const second = makeRes();
    await handleRequest(makeReq({ method: 'GET', url: '/' }), second.res, ctx);
    const a = String((await first.done).headers['Content-Security-Policy']);
    const b = String((await second.done).headers['Content-Security-Policy']);
    assert.notEqual(a, b, 'each response should carry a fresh nonce');
  });
});
