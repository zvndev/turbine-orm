/**
 * Studio: write mode, PII redaction, and origin/nonce hardening.
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
  // `name` is a nullable, non-PK column: it drives the explicit-null write path
  // and the `nullable` schema-payload assertion.
  markNullable(users, 'name');

  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'secret', field: 'secret', pgType: 'text' },
    ],
    {
      // The forward (belongsTo) side of users.posts: the click-through target.
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );
  markPii(posts, 'secret');

  // Sessions carries three belongsTo relations that exercise the PII rules on
  // both ends of a link: a clean one, one pointing AT a PII column, and one
  // whose own FK column is PII.
  const sessions = mockTable(
    'sessions',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'owner_email', field: 'ownerEmail', pgType: 'text' },
      { name: 'secret_ref', field: 'secretRef', pgType: 'text' },
    ],
    {
      user: {
        type: 'belongsTo',
        name: 'user',
        from: 'sessions',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
      owner: {
        type: 'belongsTo',
        name: 'owner',
        from: 'sessions',
        to: 'users',
        foreignKey: 'owner_email',
        referenceKey: 'email',
      },
      secretUser: {
        type: 'belongsTo',
        name: 'secretUser',
        from: 'sessions',
        to: 'users',
        foreignKey: 'secret_ref',
        referenceKey: 'id',
      },
    },
  );
  markPii(sessions, 'secret_ref');

  // A relation-free table: the "degrade silently" case (defineSchema-only or
  // PowDB metadata, where relations are always empty).
  const tags = mockTable('tags', [
    { name: 'id', field: 'id' },
    { name: 'label', field: 'label', pgType: 'text' },
  ]);

  return { tables: { users, posts, sessions, tags }, enums: {} };
}

function markPii(table: TableMetadata, columnName: string): void {
  const col = table.columns.find((c) => c.name === columnName);
  if (col) col.pii = true;
}

function markNullable(table: TableMetadata, columnName: string): void {
  const col = table.columns.find((c) => c.name === columnName);
  if (col) col.nullable = true;
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

describe('Studio write: route gating (read-only mode)', () => {
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

describe('Studio write: single-row round-trips', () => {
  it('update compiles a parameterized UPDATE with a PK-covering WHERE in a plain txn', async () => {
    const { pool, calls } = makePool([
      {}, // BEGIN
      {}, // set_config statement_timeout
      {}, // set_config search_path
      { rows: [{ id: 1, name: 'Bob' }], fields: [{ name: 'id' }] }, // UPDATE ... RETURNING non-PII list
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
    // email is PII on this fixture: the write returns an explicit non-PII list,
    // never `RETURNING *`, so PII never leaves the database on a write.
    assert.match(write.text, /RETURNING "id", "name"/);
    assert.ok(!/RETURNING[^;]*"email"/.test(write.text), 'PII column excluded from RETURNING');
    assert.deepEqual(write.values, ['Bob', 1]);

    const json = r.json as { operation: string; row: Record<string, unknown> };
    assert.equal(json.operation, 'update');
    assert.equal(json.row.id, 1);
  });

  it('insert compiles a parameterized INSERT with a non-PII RETURNING list', async () => {
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
    // email is PII: written freely (it is in the VALUES list) but excluded from
    // the RETURNING projection, so it never crosses the wire back to the client.
    assert.match(write.text, /RETURNING "id", "name"/);
    assert.ok(!/RETURNING[^;]*"email"/.test(write.text), 'PII column excluded from RETURNING');
    assert.deepEqual(write.values, ['Ada', 'ada@x.com']);
  });

  it('update with an explicit null data value compiles SET "col" = $1 with a null param', async () => {
    const { pool, calls } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 1, name: null, email: 'bob@x.com' }], fields: [{ name: 'id' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 1 }, data: { name: null } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const write = firstDataQuery(calls);
    assert.match(write.text, /^UPDATE "users"/);
    assert.match(write.text, /SET "name" = \$1/);
    assert.match(write.text, /WHERE "id" = \$2/);
    // The null reaches the driver as a bound param, not inlined into SQL.
    assert.deepEqual(write.values, [null, 1]);
  });

  it('insert with an explicit null data value reaches VALUES with a null param', async () => {
    const { pool, calls } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 7, name: null, email: 'ada@x.com' }], fields: [{ name: 'id' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/insert',
      headers: authHeaders(),
      body: { table: 'users', data: { name: null, email: 'ada@x.com' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const write = firstDataQuery(calls);
    assert.match(write.text, /^INSERT INTO "users"/);
    // users has a PII column, so the write returns the non-PII projection.
    assert.match(write.text, /RETURNING "id", "name"/);
    // Both columns bound as params; the null is a real $N, never inlined.
    assert.deepEqual(write.values, [null, 'ada@x.com']);
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
// Bulk writes: `rows` array on insert/delete: one txn, all-or-nothing,
// every row still PK-addressed / column-validated.
// ---------------------------------------------------------------------------

describe('Studio write: bulk rows', () => {
  it('bulk insert compiles one INSERT per row inside a single txn', async () => {
    const { pool, calls } = makePool([
      {}, // BEGIN
      {}, // set_config statement_timeout
      {}, // set_config search_path
      { rows: [{ id: 1, name: 'A', email: 'a@x.com' }], fields: [{ name: 'id' }] },
      { rows: [{ id: 2, name: 'B', email: 'b@x.com' }], fields: [{ name: 'id' }] },
      {}, // COMMIT
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/insert',
      headers: authHeaders(),
      body: {
        table: 'users',
        rows: [
          { name: 'A', email: 'a@x.com' },
          { name: 'B', email: 'b@x.com' },
        ],
      },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const inserts = calls.filter((c) => /^INSERT INTO "users"/.test(c.text));
    assert.equal(inserts.length, 2, 'one INSERT per row');
    assert.equal(calls.filter((c) => c.text.trim() === 'BEGIN').length, 1, 'exactly one txn');
    assert.equal(calls.filter((c) => c.text.trim() === 'COMMIT').length, 1);

    const json = r.json as { operation: string; rows: Array<Record<string, unknown>>; rowCount: number };
    assert.equal(json.operation, 'insert');
    assert.equal(json.rowCount, 2);
    assert.equal(json.rows.length, 2);
    // The echoed rows are redacted like any read.
    for (const row of json.rows) {
      if (row.email != null) assert.equal(row.email, PII_REDACTED, 'bulk echo redacts PII');
    }
  });

  it('bulk delete compiles one PK-addressed DELETE per row', async () => {
    const { pool, calls } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 1 }], fields: [{ name: 'id' }] },
      { rows: [{ id: 2 }], fields: [{ name: 'id' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/delete',
      headers: authHeaders(),
      body: { table: 'users', rows: [{ id: 1 }, { id: 2 }] },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const deletes = calls.filter((c) => /^DELETE FROM "users"/.test(c.text));
    assert.equal(deletes.length, 2);
    for (const d of deletes) {
      assert.match(d.text, /WHERE "id" = \$1/, 'each delete is PK-addressed');
    }
    assert.deepEqual(
      deletes.map((d) => d.values),
      [[1], [2]],
    );
    assert.equal((r.json as { rowCount: number }).rowCount, 2);
  });

  it('rolls back the WHOLE bulk delete when any row matches nothing (404, no COMMIT)', async () => {
    const { pool, calls } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 1 }], fields: [{ name: 'id' }] }, // first delete hits
      { rows: [] }, // second delete matches nothing
      {}, // ROLLBACK
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/delete',
      headers: authHeaders(),
      body: { table: 'users', rows: [{ id: 1 }, { id: 999 }] },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 404, r.body);
    assert.ok(
      calls.some((c) => c.text.trim() === 'ROLLBACK'),
      'txn rolled back',
    );
    assert.ok(!calls.some((c) => c.text.trim() === 'COMMIT'), 'nothing committed');
  });

  it('rejects bulk update (400)', async () => {
    const { pool, calls } = makePool();
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', rows: [{ id: 1 }], data: { name: 'x' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /bulk update is not supported/i);
    assert.equal(calls.length, 0, 'no statement ran');
  });

  it('caps bulk requests at 500 rows (400, nothing runs)', async () => {
    const { pool, calls } = makePool();
    const ctx = makeCtx(pool, { writable: true });
    const rows = Array.from({ length: 501 }, (_, i) => ({ id: i + 1 }));
    const req = makeReq({
      method: 'POST',
      url: '/api/row/delete',
      headers: authHeaders(),
      body: { table: 'users', rows },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /too many rows/i);
    assert.equal(calls.length, 0, 'no statement ran');
  });

  it('rejects an empty rows array (400)', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/insert',
      headers: authHeaders(),
      body: { table: 'users', rows: [] },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400);
    assert.match((r.json as { error: string }).error, /at least one entry/i);
  });

  it('names the offending row on a per-row validation failure (400, nothing runs)', async () => {
    const { pool, calls } = makePool();
    const ctx = makeCtx(pool, { writable: true });

    // insert: unknown column in the second row
    const badInsert = makeReq({
      method: 'POST',
      url: '/api/row/insert',
      headers: authHeaders(),
      body: { table: 'users', rows: [{ name: 'ok' }, { nope: 'x' }] },
    });
    const a = makeRes();
    await handleRequest(badInsert, a.res, ctx);
    const ra = await a.done;
    assert.equal(ra.status, 400);
    assert.match((ra.json as { error: string }).error, /unknown column "nope"[\s\S]*rows\[1\]/);

    // delete: second row missing the PK
    const badDelete = makeReq({
      method: 'POST',
      url: '/api/row/delete',
      headers: authHeaders(),
      body: { table: 'users', rows: [{ id: 1 }, { name: 'no pk' }] },
    });
    const b = makeRes();
    await handleRequest(badDelete, b.res, ctx);
    const rb = await b.done;
    assert.equal(rb.status, 400);
    assert.match((rb.json as { error: string }).error, /primary key[\s\S]*rows\[1\]/);

    assert.equal(calls.length, 0, 'validation happens before any statement');
  });
});

// ---------------------------------------------------------------------------
// CSRF + auth on write routes
// ---------------------------------------------------------------------------

describe('Studio write: auth + CSRF perimeter', () => {
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

describe('Studio PII: redaction on the wire', () => {
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

  it('exposes per-column nullable in the schema payload (drives the NULL toggle)', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = makeCtx(pool, {});
    const req = makeReq({ method: 'GET', url: '/api/schema', headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    const tables = (r.json as { tables: Array<{ name: string; columns: Array<{ name: string; nullable: boolean }> }> })
      .tables;
    const users = tables.find((t) => t.name === 'users')!;
    const name = users.columns.find((c) => c.name === 'name')!;
    const id = users.columns.find((c) => c.name === 'id')!;
    assert.equal(name.nullable, true, 'a nullable column advertises nullable:true');
    assert.equal(id.nullable, false, 'the PK is not nullable');
  });
});

// ---------------------------------------------------------------------------
// CSP nonce hardening
// ---------------------------------------------------------------------------

describe('Studio hardening: CSP nonce on the HTML shell', () => {
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

// ---------------------------------------------------------------------------
// Write predicate: extra non-PK where keys are stripped (regression lock)
// ---------------------------------------------------------------------------

describe('Studio write: the effective WHERE is rebuilt from the PK alone', () => {
  it('drops extra non-PK keys (including operator objects) from an update where', async () => {
    const { pool, calls } = makePool([
      {},
      {},
      {},
      { rows: [{ id: 1, name: 'Bob', email: 'b@x.com' }], fields: [{ name: 'id' }] },
      {},
    ]);
    const ctx = makeCtx(pool, { writable: true });
    const req = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      // A widened predicate: the PK plus a scalar and an operator object.
      body: { table: 'users', where: { id: 1, name: 'Bob', email: { not: null } }, data: { name: 'Bobby' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const write = firstDataQuery(calls);
    assert.match(write.text, /WHERE "id" = \$2\s*(RETURNING|$)/, 'WHERE must contain the PK predicate only');
    assert.ok(
      !/("name"|"email")\s*(=|IS)/.test(write.text.split('WHERE')[1] ?? ''),
      'non-PK keys must not reach the WHERE',
    );
    assert.deepEqual(write.values, ['Bobby', 1]);
  });

  it('drops extra non-PK keys from a delete where', async () => {
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
      body: { table: 'users', where: { id: 3, name: 'Widened' } },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const write = firstDataQuery(calls);
    assert.match(write.text, /^DELETE FROM "users"/);
    // Scope the check to the statement BEFORE the RETURNING projection: "name"
    // legitimately appears in the non-PII RETURNING list, but the widened
    // non-PK where key must not reach the DELETE's WHERE clause.
    const beforeReturning = write.text.split('RETURNING')[0]!;
    assert.ok(!/"name"/.test(beforeReturning), 'non-PK key must not reach the DELETE WHERE');
    assert.deepEqual(write.values, [3]);
  });
});

// ---------------------------------------------------------------------------
// PII inference hardening: redacted columns are not search/orderBy oracles
// ---------------------------------------------------------------------------

describe('Studio PII: redacted columns are excluded from search and orderBy', () => {
  it('search ILIKE OR-set omits PII columns when redaction is on', async () => {
    const { pool, calls } = makePool([{}, {}, { rows: [] }, { rows: [{ count: '0' }] }, {}]);
    const ctx = makeCtx(pool, {});
    const req = makeReq({
      method: 'GET',
      url: '/api/tables/users?search=probe',
      headers: authHeaders(),
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const main = calls.find((c) => /^SELECT \* FROM/.test(c.text.trim()));
    assert.ok(main, 'main rows query recorded');
    assert.match(main!.text, /"name" ILIKE/);
    assert.ok(!/"email" ILIKE/.test(main!.text), 'a redacted PII column must not be substring-probeable');
  });

  it('search includes PII columns again under --show-pii', async () => {
    const { pool, calls } = makePool([{}, {}, { rows: [] }, { rows: [{ count: '0' }] }, {}]);
    const ctx = makeCtx(pool, { showPii: true });
    const req = makeReq({
      method: 'GET',
      url: '/api/tables/users?search=probe',
      headers: authHeaders(),
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    await done;

    const main = calls.find((c) => /^SELECT \* FROM/.test(c.text.trim()));
    assert.ok(main, 'main rows query recorded');
    assert.match(main!.text, /"email" ILIKE/, 'with --show-pii the column is fair game');
  });

  it('orderBy on a redacted PII column falls back to the PK ordering', async () => {
    const { pool, calls } = makePool([{}, {}, { rows: [] }, { rows: [{ count: '0' }] }, {}]);
    const ctx = makeCtx(pool, {});
    const req = makeReq({
      method: 'GET',
      url: '/api/tables/users?orderBy=email&dir=asc',
      headers: authHeaders(),
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    await done;

    const main = calls.find((c) => /^SELECT \* FROM/.test(c.text.trim()));
    assert.ok(main, 'main rows query recorded');
    assert.ok(!/ORDER BY "email"/.test(main!.text), 'sort position must not leak a redacted value');
    assert.match(main!.text, /ORDER BY "id"/, 'falls back to PK ordering');
  });

  it('orderBy on a PII column works under --show-pii', async () => {
    const { pool, calls } = makePool([{}, {}, { rows: [] }, { rows: [{ count: '0' }] }, {}]);
    const ctx = makeCtx(pool, { showPii: true });
    const req = makeReq({
      method: 'GET',
      url: '/api/tables/users?orderBy=email&dir=asc',
      headers: authHeaders(),
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    await done;

    const main = calls.find((c) => /^SELECT \* FROM/.test(c.text.trim()));
    assert.ok(main, 'main rows query recorded');
    assert.match(main!.text, /ORDER BY "email" ASC/);
  });
});

// ---------------------------------------------------------------------------
// Foreign-key click-through navigation
//
// Links are derived from relation metadata and served on /api/schema; following
// one is an ordinary /api/tables read with a single equals filter, so it adds no
// route and inherits that route's validation, redaction, auth, and read-only
// posture. These tests pin both halves.
// ---------------------------------------------------------------------------

interface SchemaTablePayload {
  name: string;
  foreignKeys: Array<{ column: string; relation: string; targetTable: string; targetColumn: string }>;
  referencedBy: Array<{ column: string; relation: string; targetTable: string; targetColumn: string }>;
}

async function fetchSchemaTables(ctx: StudioContext): Promise<SchemaTablePayload[]> {
  const req = makeReq({ method: 'GET', url: '/api/schema', headers: authHeaders() });
  const { res, done } = makeRes();
  await handleRequest(req, res, ctx);
  const r = await done;
  assert.equal(r.status, 200, r.body);
  return (r.json as { tables: SchemaTablePayload[] }).tables;
}

function tableNamed(tables: SchemaTablePayload[], name: string): SchemaTablePayload {
  const t = tables.find((x) => x.name === name);
  assert.ok(t, `${name} present in schema payload`);
  return t as SchemaTablePayload;
}

describe('Studio navigation: foreign-key link derivation', () => {
  it('derives forward links from belongsTo metadata, never from column names', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = makeCtx(pool, {});
    const posts = tableNamed(await fetchSchemaTables(ctx), 'posts');
    assert.deepEqual(posts.foreignKeys, [
      { column: 'user_id', relation: 'author', targetTable: 'users', targetColumn: 'id' },
    ]);
  });

  it('derives reverse links from hasMany metadata AND from inbound belongsTo', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = makeCtx(pool, {});
    const users = tableNamed(await fetchSchemaTables(ctx), 'users');
    // `posts` comes from users' own hasMany. `sessions` is declared ONLY on the
    // child side (`sessions.user -> users`), which is the norm in a
    // defineSchema-authored schema; scanning just this table's own relations
    // made those children unreachable even though the child grid renders the FK.
    assert.deepEqual(users.referencedBy, [
      { column: 'id', relation: 'posts', targetTable: 'posts', targetColumn: 'user_id' },
      { column: 'id', relation: 'user', targetTable: 'sessions', targetColumn: 'user_id' },
    ]);
    // users itself holds no belongsTo relation, so it offers no forward link.
    assert.deepEqual(users.foreignKeys, []);
  });

  it('emits no links at all for a relation-free table', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = makeCtx(pool, {});
    const tags = tableNamed(await fetchSchemaTables(ctx), 'tags');
    assert.deepEqual(tags.foreignKeys, []);
    assert.deepEqual(tags.referencedBy, []);
  });

  it('omits a link whose target column is PII-redacted, and restores it under --show-pii', async () => {
    const redacted = tableNamed(await fetchSchemaTables(makeCtx(makePool([{ rows: [] }]).pool, {})), 'sessions');
    const columns = redacted.foreignKeys.map((l) => l.column);
    assert.ok(!columns.includes('owner_email'), 'a link pointing at users.email must not be offered');

    const shown = tableNamed(
      await fetchSchemaTables(makeCtx(makePool([{ rows: [] }]).pool, { showPii: true })),
      'sessions',
    );
    const shownLink = shown.foreignKeys.find((l) => l.column === 'owner_email');
    assert.ok(shownLink, 'the link is available once PII is shown');
    assert.equal(shownLink?.targetColumn, 'email');
  });

  it('omits a link whose own FK column is PII-redacted, and restores it under --show-pii', async () => {
    const redacted = tableNamed(await fetchSchemaTables(makeCtx(makePool([{ rows: [] }]).pool, {})), 'sessions');
    const columns = redacted.foreignKeys.map((l) => l.column);
    assert.ok(!columns.includes('secret_ref'), 'a redacted cell holds no clickable value');
    // The clean link on the same table is unaffected.
    assert.ok(columns.includes('user_id'));

    const shown = tableNamed(
      await fetchSchemaTables(makeCtx(makePool([{ rows: [] }]).pool, { showPii: true })),
      'sessions',
    );
    assert.ok(shown.foreignKeys.some((l) => l.column === 'secret_ref'));
  });
});

describe('Studio navigation: following a link', () => {
  it('compiles a parameterized equals filter on the target column', async () => {
    const { pool, calls } = makePool([{}, {}, { rows: [{ id: 4 }] }, { rows: [{ count: '1' }] }, {}]);
    const ctx = makeCtx(pool, {});
    const filters = encodeURIComponent(JSON.stringify([{ column: 'id', op: 'equals', value: 4 }]));
    const req = makeReq({ method: 'GET', url: `/api/tables/users?filters=${filters}`, headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;

    assert.equal(r.status, 200, r.body);
    const main = calls.find((c) => /^SELECT \* FROM/.test(c.text.trim()));
    assert.ok(main, 'main rows query recorded');
    assert.match(main!.text, /WHERE "id" = \$3/, 'the value is a bound parameter, never inlined');
    assert.deepEqual(main!.values, [50, 0, 4]);
    // Still a read: navigation never leaves the READ ONLY transaction.
    assert.ok(calls.some((c) => /BEGIN READ ONLY/.test(c.text)));
  });

  it('refuses a destination table that is not in the metadata', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, {});
    const req = makeReq({ method: 'GET', url: '/api/tables/pg_shadow', headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 404);
  });

  it('refuses a destination column that is not in the metadata', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, {});
    const filters = encodeURIComponent(JSON.stringify([{ column: 'id; DROP TABLE users', op: 'equals', value: 1 }]));
    const req = makeReq({ method: 'GET', url: `/api/tables/users?filters=${filters}`, headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /unknown filter column/);
  });

  it('refuses a hand-forged jump onto a redacted PII column', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, {});
    const filters = encodeURIComponent(JSON.stringify([{ column: 'email', op: 'equals', value: 'a@b.c' }]));
    const req = makeReq({ method: 'GET', url: `/api/tables/users?filters=${filters}`, headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400);
    assert.match(String((r.json as { error: string }).error), /PII-redacted/);
  });

  it('requires the session token to read link metadata or follow a link', async () => {
    for (const url of ['/api/schema', '/api/tables/users?filters=%5B%5D']) {
      const { pool } = makePool([{ rows: [] }]);
      const ctx = makeCtx(pool, {});
      const req = makeReq({ method: 'GET', url, headers: { origin: ORIGIN } });
      const { res, done } = makeRes();
      await handleRequest(req, res, ctx);
      const r = await done;
      assert.equal(r.status, 401, url);
    }
  });

  it('opens no write surface: a followed link still 404s the write routes in read-only mode', async () => {
    const { pool } = makePool([{}, {}, { rows: [{ id: 4 }] }, { rows: [{ count: '1' }] }, {}]);
    const ctx = makeCtx(pool, { writable: false });
    const filters = encodeURIComponent(JSON.stringify([{ column: 'id', op: 'equals', value: 4 }]));
    const nav = makeReq({ method: 'GET', url: `/api/tables/users?filters=${filters}`, headers: authHeaders() });
    const navRes = makeRes();
    await handleRequest(nav, navRes.res, ctx);
    assert.equal((await navRes.done).status, 200);

    const write = makeReq({
      method: 'POST',
      url: '/api/row/update',
      headers: authHeaders(),
      body: { table: 'users', where: { id: 4 }, data: { name: 'x' } },
    });
    const writeRes = makeRes();
    await handleRequest(write, writeRes.res, ctx);
    assert.equal((await writeRes.done).status, 404);
  });
});

// ---------------------------------------------------------------------------
// PII guard: relation-filter wrappers
//
// The guard walked `{ rel: <clause> }` against the relation's TARGET table, but
// a relation predicate normally arrives wrapped (`{ rel: { some: <clause> } }`).
// Walking the wrapper treated `some` as a column name, so the inner clause was
// never visited and `where: { author: { is: { email: { startsWith: 'a' } } } }`
// was answered: a binary oracle that reads a redacted value one character at a
// time.
// ---------------------------------------------------------------------------

describe('Studio builder: PII guard covers relation-filter wrappers', () => {
  async function build(ctx: StudioContext, table: string, args: unknown): Promise<RecordedResponse> {
    const req = makeReq({ method: 'POST', url: '/api/builder', headers: authHeaders(), body: { table, args } });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    return done;
  }

  for (const wrapper of ['some', 'none', 'every', 'is', 'isNot']) {
    it(`refuses a PII predicate wrapped in \`${wrapper}\``, async () => {
      const { pool } = makePool([{ rows: [] }]);
      const ctx = makeCtx(pool, {});
      const r = await build(ctx, 'posts', { where: { author: { [wrapper]: { email: { startsWith: 'a' } } } } });
      assert.equal(r.status, 400, r.body);
      assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
    });

    it(`refuses a \`${wrapper}\`-wrapped PII predicate one level down inside a with clause`, async () => {
      const { pool } = makePool([{ rows: [] }]);
      const ctx = makeCtx(pool, {});
      const r = await build(ctx, 'users', {
        with: { posts: { where: { author: { [wrapper]: { email: { equals: 'a@b.c' } } } } } },
      });
      assert.equal(r.status, 400, r.body);
      assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
    });
  }

  it('refuses a wrapper nested under a boolean combinator', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = makeCtx(pool, {});
    const r = await build(ctx, 'posts', {
      where: { OR: [{ id: 1 }, { author: { is: { email: { contains: '@' } } } }] },
    });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
  });

  it('still refuses the bare (unwrapped) relation form', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = makeCtx(pool, {});
    const r = await build(ctx, 'posts', { where: { author: { email: { startsWith: 'a' } } } });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
  });

  it('leaves a non-PII wrapped relation filter alone', async () => {
    const { pool } = makePool([{}, {}, {}, { rows: [{ id: 1 }] }, {}]);
    const ctx = makeCtx(pool, {});
    const r = await build(ctx, 'users', { where: { posts: { some: { id: 1 } } }, limit: 1 });
    assert.equal(r.status, 200, r.body);
  });

  it('allows the wrapped PII predicate once --show-pii is on', async () => {
    const { pool } = makePool([{}, {}, {}, { rows: [{ id: 1 }] }, {}]);
    const ctx = makeCtx(pool, { showPii: true });
    const r = await build(ctx, 'posts', { where: { author: { is: { email: { startsWith: 'a' } } } }, limit: 1 });
    assert.equal(r.status, 200, r.body);
  });
});

// ---------------------------------------------------------------------------
// The rest of the predicate surface: cursor, distinct, array orderBy
// ---------------------------------------------------------------------------

/** A builder request that reaches the pool needs BEGIN + timeout + search_path + data + COMMIT. */
function okPool(): pg.Pool {
  return makePool([{}, {}, {}, { rows: [{ id: 1 }] }, {}]).pool;
}

describe('Studio builder: PII guard covers cursor, distinct, and array orderBy', () => {
  async function build(ctx: StudioContext, table: string, args: unknown): Promise<RecordedResponse> {
    const req = makeReq({ method: 'POST', url: '/api/builder', headers: authHeaders(), body: { table, args } });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    return done;
  }

  // `cursor` compiles to a WHERE range comparison against the sort key
  // (`"email" > $1`). Paired with a NON-PII orderBy it used to sail past a guard
  // that only looked at `where` and `orderBy`, and the fully redacted response
  // body is exactly what made it look safe: the row COUNT is the oracle, and a
  // byte-range binary search reads the hidden value out a character at a time.
  it('refuses a cursor on a PII column paired with a non-PII sort key', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', {
      orderBy: { id: 'asc' },
      cursor: { email: 'ada@example.com' },
      take: 100,
    });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
  });

  for (const [table, column] of [
    ['users', 'email'],
    ['posts', 'secret'],
  ] as const) {
    it(`refuses a cursor on ${table}.${column}`, async () => {
      const ctx = makeCtx(okPool(), {});
      const r = await build(ctx, table, { orderBy: { id: 'asc' }, cursor: { [column]: 'x' }, take: 5 });
      assert.equal(r.status, 400, r.body);
      assert.match(String((r.json as { error: string }).error), new RegExp(`"${column}"`));
    });
  }

  it('refuses distinct on a PII column (a cardinality leak at minimum)', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', { distinct: ['email'], limit: 5 });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
  });

  // `OrderByClause` is `OrderByObject | OrderByObject[]`. The array form walked
  // as `{ '0': {...} }`, whose key is an index rather than a column name, so the
  // PII column inside was never inspected.
  it('refuses the ARRAY form of orderBy on a PII column', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', { orderBy: [{ id: 'asc' }, { email: 'asc' }], limit: 5 });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
  });

  it('refuses a cursor on a PII column one level down in a with clause', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', { with: { posts: { cursor: { secret: 'x' } } } });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted/);
  });

  // Positive controls: the guard must not have turned into a blanket refusal.
  it('allows a cursor on a NON-PII column', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', { orderBy: { id: 'asc' }, cursor: { id: 3 }, take: 5 });
    assert.equal(r.status, 200, r.body);
  });

  it('allows the array form of orderBy over non-PII columns', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', { orderBy: [{ id: 'asc' }, { name: 'desc' }], limit: 5 });
    assert.equal(r.status, 200, r.body);
  });

  for (const [label, args] of [
    ['cursor', { orderBy: { id: 'asc' }, cursor: { email: 'ada@example.com' }, take: 5 }],
    ['distinct', { distinct: ['email'], limit: 5 }],
    ['array orderBy', { orderBy: [{ email: 'asc' }], limit: 5 }],
  ] as const) {
    it(`allows the same ${label} once --show-pii is on`, async () => {
      const ctx = makeCtx(okPool(), { showPii: true });
      const r = await build(ctx, 'users', args);
      assert.equal(r.status, 200, r.body);
    });
  }
});

// ---------------------------------------------------------------------------
// The depth cap fails CLOSED
// ---------------------------------------------------------------------------

/** `NOT` wrapped `times` deep around `leaf`. */
function nest(times: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let node: Record<string, unknown> = leaf;
  for (let i = 0; i < times; i++) node = { NOT: node };
  return node;
}

describe('Studio builder: the PII guard depth cap fails closed', () => {
  async function build(ctx: StudioContext, table: string, args: unknown): Promise<RecordedResponse> {
    const req = makeReq({ method: 'POST', url: '/api/builder', headers: authHeaders(), body: { table, args } });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    return done;
  }

  // The guard used to `return` at depth > 10 while the query builder applied no
  // matching cap to boolean combinators, so padding the payload walked the guard
  // off the end of its own recursion and handed the predicate through intact.
  for (const depth of [11, 12, 40, 200]) {
    it(`refuses a PII predicate padded with ${depth} NOT wrappers`, async () => {
      const ctx = makeCtx(okPool(), {});
      const r = await build(ctx, 'users', { where: nest(depth, { email: { startsWith: 'a' } }), limit: 5 });
      assert.equal(r.status, 400, r.body);
      assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted|nested more than/);
    });
  }

  it('refuses a PII predicate reached through many relation hops', async () => {
    const ctx = makeCtx(okPool(), {});
    // users -> posts -> author -> ... -> email, four hops out and back.
    let leaf: Record<string, unknown> = { email: { startsWith: 'ada' } };
    for (let hop = 0; hop < 4; hop++) {
      leaf = { posts: { some: { author: { is: leaf } } } };
    }
    const r = await build(ctx, 'users', { where: leaf, limit: 5 });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /PII-tagged and redacted|nested more than/);
  });

  it('refuses a query nested past the cap even with no PII column in it', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', { where: nest(64, { id: 1 }), limit: 5 });
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /nested more than/);
  });

  it('still allows a normal two-level query', async () => {
    const ctx = makeCtx(okPool(), {});
    const r = await build(ctx, 'users', {
      where: { OR: [{ id: 1 }, { name: 'Ada' }] },
      orderBy: { id: 'asc' },
      with: { posts: { where: { id: 2 }, orderBy: { id: 'desc' }, limit: 2 } },
      limit: 5,
    });
    assert.equal(r.status, 200, r.body);
  });
});

// ---------------------------------------------------------------------------
// Prototype-key table lookups, rate limiting, cookie parsing
// ---------------------------------------------------------------------------

describe('Studio perimeter: prototype keys, throttling, cookie parsing', () => {
  for (const key of ['constructor', '__proto__', 'toString']) {
    it(`404s /api/tables/${key} instead of resolving Object.prototype`, async () => {
      const { pool } = makePool();
      const ctx = makeCtx(pool, {});
      const req = makeReq({ method: 'GET', url: `/api/tables/${key}`, headers: authHeaders() });
      const { res, done } = makeRes();
      await handleRequest(req, res, ctx);
      const r = await done;
      assert.equal(r.status, 404, r.body);
      assert.match(String((r.json as { error: string }).error), /Unknown table/);
    });
  }

  it('400s a builder request naming a prototype key as the table', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, {});
    const req = makeReq({
      method: 'POST',
      url: '/api/builder',
      headers: authHeaders(),
      body: { table: 'constructor', args: {} },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    const r = await done;
    assert.equal(r.status, 400, r.body);
    assert.match(String((r.json as { error: string }).error), /Unknown table/);
  });

  it('throttles UNAUTHENTICATED requests (the limiter used to run after the auth gate)', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, {});
    let last = 0;
    for (let i = 0; i < 101; i++) {
      const req = makeReq({ method: 'GET', url: '/api/schema', headers: { origin: ORIGIN } });
      const { res, done } = makeRes();
      await handleRequest(req, res, ctx);
      last = (await done).status;
      if (i < 100) assert.equal(last, 401, `request ${i} should still be a plain 401`);
    }
    assert.equal(last, 429, 'the 101st unauthenticated request is rate limited');
  });

  it('keeps the authenticated bucket separate from the unauthenticated one', async () => {
    const { pool } = makePool(Array.from({ length: 8 }, () => ({ rows: [] })));
    const ctx = makeCtx(pool, {});
    for (let i = 0; i < 101; i++) {
      const req = makeReq({ method: 'GET', url: '/api/schema', headers: { origin: ORIGIN } });
      const { res, done } = makeRes();
      await handleRequest(req, res, ctx);
      await done;
    }
    const req = makeReq({ method: 'GET', url: '/api/schema', headers: authHeaders() });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    assert.equal((await done).status, 200, 'a probing client cannot spend the real session budget');
  });

  // The cookie value is matched as hex (that is what the server issues), so
  // these two use a hex token rather than the header-only TOKEN constant.
  const HEX_TOKEN = 'a1b2c3d4e5f6';

  it('authenticates through a cookie shadowed by a decoy with the same suffix', async () => {
    const { pool } = makePool([{ rows: [] }]);
    const ctx = { ...makeCtx(pool, {}), authToken: HEX_TOKEN };
    const req = makeReq({
      method: 'GET',
      url: '/api/schema',
      headers: { origin: ORIGIN, cookie: `x_turbine_studio_token=deadbeef; turbine_studio_token=${HEX_TOKEN}` },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    assert.equal((await done).status, 200, 'the real cookie is found past the decoy');
  });

  it('still rejects a decoy cookie on its own', async () => {
    const { pool } = makePool();
    const ctx = { ...makeCtx(pool, {}), authToken: HEX_TOKEN };
    const req = makeReq({
      method: 'GET',
      url: '/api/schema',
      headers: { origin: ORIGIN, cookie: 'x_turbine_studio_token=deadbeef' },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, ctx);
    assert.equal((await done).status, 401);
  });
});
