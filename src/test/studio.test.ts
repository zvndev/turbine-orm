/**
 * Studio — unit tests for the read-only statement guard and the HTTP
 * API handlers (`/api/builder`, `/api/saved-queries`, `/api/tables/:name`
 * with search).
 *
 * The query-endpoint guard tests lock down the first line of defense for
 * `/api/query`. The second line of defense is the `BEGIN READ ONLY`
 * transaction wrapper at runtime. If either layer regresses, a destructive
 * query could run inside Studio — so both must be tested.
 *
 * The API handler tests use an in-memory mock pool (same pattern as
 * serverless.test.ts) and a tiny fake IncomingMessage/ServerResponse pair
 * so we can exercise the endpoints without a real HTTP server or database.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type pg from 'pg';
import {
  apiBuilder,
  apiCreateSavedQuery,
  apiDeleteSavedQuery,
  apiListSavedQueries,
  apiTableRows,
  escapeLikePattern,
  isReadOnlyStatement,
  isTextishType,
  resolveColumnName,
  type StudioContext,
  type StudioOptions,
} from '../cli/studio.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

describe('Studio — isReadOnlyStatement', () => {
  it('accepts plain SELECT', () => {
    assert.equal(isReadOnlyStatement('SELECT * FROM users'), true);
  });

  it('accepts lowercase SELECT', () => {
    assert.equal(isReadOnlyStatement('select 1'), true);
  });

  it('accepts WITH (CTE) queries', () => {
    assert.equal(isReadOnlyStatement('WITH t AS (SELECT 1) SELECT * FROM t'), true);
  });

  it('accepts SELECT with trailing semicolon', () => {
    assert.equal(isReadOnlyStatement('SELECT 1;'), true);
  });

  it('accepts SELECT with trailing whitespace + semicolon', () => {
    assert.equal(isReadOnlyStatement('SELECT 1 ;  '), true);
  });

  it('rejects empty input', () => {
    assert.equal(isReadOnlyStatement(''), false);
    assert.equal(isReadOnlyStatement('   '), false);
  });

  it('rejects INSERT', () => {
    assert.equal(isReadOnlyStatement('INSERT INTO users VALUES (1)'), false);
  });

  it('rejects UPDATE', () => {
    assert.equal(isReadOnlyStatement('UPDATE users SET name = $1'), false);
  });

  it('rejects DELETE', () => {
    assert.equal(isReadOnlyStatement('DELETE FROM users'), false);
  });

  it('rejects DROP', () => {
    assert.equal(isReadOnlyStatement('DROP TABLE users'), false);
  });

  it('rejects TRUNCATE', () => {
    assert.equal(isReadOnlyStatement('TRUNCATE users'), false);
  });

  it('rejects GRANT', () => {
    assert.equal(isReadOnlyStatement('GRANT ALL ON users TO public'), false);
  });

  it('rejects CREATE TABLE', () => {
    assert.equal(isReadOnlyStatement('CREATE TABLE x (id int)'), false);
  });

  it('rejects statement stacking (SELECT ; DROP)', () => {
    assert.equal(isReadOnlyStatement('SELECT 1; DROP TABLE users'), false);
  });

  it('rejects stacking hidden in line comment bypass', () => {
    // The stripper removes the comment first, so the stacking check still
    // catches the embedded DROP.
    assert.equal(isReadOnlyStatement('SELECT 1 -- harmless\n; DROP TABLE users'), false);
  });

  it('rejects stacking hidden in block comment bypass', () => {
    assert.equal(isReadOnlyStatement('SELECT 1 /* comment */ ; DELETE FROM users'), false);
  });

  it('rejects leading comment followed by DROP', () => {
    assert.equal(isReadOnlyStatement('-- innocent\nDROP TABLE users'), false);
  });

  it('rejects leading block comment followed by INSERT', () => {
    assert.equal(isReadOnlyStatement('/* look harmless */ INSERT INTO users VALUES (1)'), false);
  });

  it('accepts SELECT with inline comment', () => {
    assert.equal(isReadOnlyStatement('SELECT id -- the pk\nFROM users'), true);
  });

  it('accepts SELECT with block comment before it', () => {
    assert.equal(isReadOnlyStatement('/* summary query */ SELECT count(*) FROM users'), true);
  });
});

// ---------------------------------------------------------------------------
// Small helpers for exercising Studio's helper functions
// ---------------------------------------------------------------------------

describe('Studio — resolveColumnName', () => {
  it('returns the postgres column name when passed the snake name', () => {
    const table = mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    ]);
    assert.equal(resolveColumnName(table, 'created_at'), 'created_at');
  });

  it('returns the postgres column name when passed the camel field', () => {
    const table = mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    ]);
    assert.equal(resolveColumnName(table, 'createdAt'), 'created_at');
  });

  it('returns null for unknown names', () => {
    const table = mockTable('users', [{ name: 'id', field: 'id' }]);
    assert.equal(resolveColumnName(table, 'nope'), null);
  });
});

describe('Studio — isTextishType', () => {
  it('treats text, varchar, char, citext and uuid as searchable', () => {
    for (const t of ['text', 'varchar', 'character varying', 'char', 'character', 'citext', 'uuid']) {
      assert.equal(isTextishType(t), true, `${t} should be searchable`);
    }
  });

  it('rejects numeric / date / json types', () => {
    for (const t of ['int4', 'int8', 'numeric', 'timestamp', 'jsonb']) {
      assert.equal(isTextishType(t), false, `${t} should not be searchable`);
    }
  });
});

describe('Studio — escapeLikePattern', () => {
  it('escapes LIKE wildcards literally', () => {
    assert.equal(escapeLikePattern('100%'), '100\\%');
    assert.equal(escapeLikePattern('foo_bar'), 'foo\\_bar');
    assert.equal(escapeLikePattern('a\\b'), 'a\\\\b');
  });

  it('leaves plain text alone', () => {
    assert.equal(escapeLikePattern('hello world'), 'hello world');
  });
});

// ---------------------------------------------------------------------------
// Mock HTTP req/res + mock pg.Pool so we can drive the API handlers without
// spinning up a real server or database.
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
    writeHead(s: number, h?: Record<string, string | number>) {
      status = s;
      headers = { ...(h ?? {}) };
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

function makePool(programmed: Array<{ rows: unknown[]; fields?: Array<{ name: string }> }> = []): {
  pool: pg.Pool;
  calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  let next = 0;
  const respond = () => {
    const p = programmed[next++] ?? { rows: [] };
    return {
      rows: p.rows,
      rowCount: p.rows.length,
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

function buildSchema(): SchemaMetadata {
  return {
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'email', field: 'email', pgType: 'text' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
      ]),
    },
    enums: {},
  };
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
  return {
    pool,
    metadata: buildSchema(),
    options,
    authToken: 'test-token',
    stateDir,
  };
}

// Find the first real SQL (not BEGIN/COMMIT/SET) in the recorded call log.
function firstDataQuery(calls: QueryCall[]): QueryCall {
  const ignore = /^(BEGIN|COMMIT|ROLLBACK|SET\b)/i;
  for (const c of calls) {
    if (!ignore.test(c.text.trim())) return c;
  }
  throw new Error('no data query recorded');
}

// ---------------------------------------------------------------------------
// /api/builder — exercises QueryInterface.buildFindMany via the HTTP handler
// ---------------------------------------------------------------------------

describe('Studio — apiBuilder', () => {
  it('builds and runs a findMany-shaped query through the pool', async () => {
    const { pool, calls } = makePool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SET LOCAL statement_timeout
      {
        rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }],
        fields: [{ name: 'id' }, { name: 'name' }, { name: 'email' }],
      },
      { rows: [] }, // COMMIT
    ]);
    const ctx = makeCtx(pool, tmpdir());
    const req = makeReq({ table: 'users', args: { where: { name: 'Alice' }, limit: 10 } });
    const { res, done } = makeRes();

    await apiBuilder(req, res, ctx);
    const response = await done;

    assert.equal(response.status, 200);
    const data = response.json as { sql: string; rows: unknown[]; rowCount: number };
    assert.match(data.sql, /SELECT/i);
    assert.match(data.sql, /FROM "users"/);
    assert.match(data.sql, /WHERE/i);
    assert.equal(data.rowCount, 1);

    // Verify the actual SQL sent to the pool matched the sql returned to the caller.
    const dataCall = firstDataQuery(calls);
    assert.match(dataCall.text, /SELECT/i);
    assert.match(dataCall.text, /FROM "users"/);
  });

  it('rejects unknown tables with 400', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, tmpdir());
    const req = makeReq({ table: 'ghost', args: {} });
    const { res, done } = makeRes();

    await apiBuilder(req, res, ctx);
    const response = await done;

    assert.equal(response.status, 400);
    const data = response.json as { error: string };
    assert.match(data.error, /unknown table/i);
  });

  it('returns 400 when the builder rejects invalid args (e.g. bogus field)', async () => {
    const { pool } = makePool();
    const ctx = makeCtx(pool, tmpdir());
    const req = makeReq({ table: 'users', args: { where: { notARealField: 'x' } } });
    const { res, done } = makeRes();

    await apiBuilder(req, res, ctx);
    const response = await done;

    assert.equal(response.status, 400);
    const data = response.json as { error: string };
    assert.ok(data.error.length > 0);
  });
});

// ---------------------------------------------------------------------------
// /api/tables/:name?search=... — verify WHERE/ILIKE and param bindings
// ---------------------------------------------------------------------------

describe('Studio — apiTableRows with search', () => {
  it('builds an ILIKE WHERE across text columns and binds pattern at $3 for the main query', async () => {
    const { pool, calls } = makePool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SET LOCAL statement_timeout
      { rows: [{ id: 1, name: 'Alice', email: 'a@b.com' }], fields: [{ name: 'id' }] }, // main
      { rows: [{ count: '1' }] }, // count
      { rows: [] }, // COMMIT
    ]);
    const ctx = makeCtx(pool, tmpdir());
    const { res, done } = makeRes();

    const params = new URLSearchParams({ search: 'ali' });
    await apiTableRows(res, ctx, 'users', params);
    const response = await done;

    assert.equal(response.status, 200);

    // First SQL query should be the main select.
    const mainCall = calls.find((c) => /^SELECT \*/i.test(c.text.trim()));
    assert.ok(mainCall, 'main query must be recorded');
    assert.match(mainCall.text, /WHERE/);
    assert.match(mainCall.text, /ILIKE \$3/);
    assert.match(mainCall.text, /"name"/);
    assert.match(mainCall.text, /"email"/);
    assert.match(mainCall.text, /LIMIT \$1 OFFSET \$2/);
    assert.deepEqual(mainCall.values[0], 50); // default limit
    assert.deepEqual(mainCall.values[1], 0); // default offset
    assert.equal(mainCall.values[2], '%ali%');

    // Count query should bind the pattern at $1 (no limit/offset prefix).
    const countCall = calls.find((c) => /COUNT\(\*\)/i.test(c.text));
    assert.ok(countCall, 'count query must be recorded');
    assert.match(countCall.text, /WHERE/);
    assert.match(countCall.text, /ILIKE \$1/);
    assert.equal(countCall.values.length, 1);
    assert.equal(countCall.values[0], '%ali%');
  });

  it('omits WHERE when no search param is provided', async () => {
    const { pool, calls } = makePool([
      { rows: [] }, // BEGIN
      { rows: [] }, // SET LOCAL
      { rows: [], fields: [{ name: 'id' }] }, // main
      { rows: [{ count: '0' }] }, // count
      { rows: [] }, // COMMIT
    ]);
    const ctx = makeCtx(pool, tmpdir());
    const { res, done } = makeRes();

    await apiTableRows(res, ctx, 'users', new URLSearchParams());
    await done;

    const mainCall = calls.find((c) => /^SELECT \*/i.test(c.text.trim()));
    assert.ok(mainCall);
    assert.doesNotMatch(mainCall.text, /WHERE/);
    assert.equal(mainCall.values.length, 2); // limit, offset
  });
});

// ---------------------------------------------------------------------------
// /api/saved-queries — round-trip create → list → delete → list-empty
// ---------------------------------------------------------------------------

describe('Studio — saved queries round-trip', () => {
  it('creates, lists, and deletes a saved query from a temp state dir', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'turbine-studio-'));
    try {
      const { pool } = makePool();
      const ctx = makeCtx(pool, tmp);

      // List — should be empty before any writes.
      {
        const { res, done } = makeRes();
        apiListSavedQueries(res, ctx, new URLSearchParams());
        const response = await done;
        assert.equal(response.status, 200);
        const data = response.json as { queries: unknown[] };
        assert.deepEqual(data.queries, []);
      }

      // Create a SQL-kind saved query.
      let createdId = '';
      {
        const req = makeReq({
          table: 'users',
          name: 'active users',
          kind: 'sql',
          sql: 'SELECT id FROM users',
        });
        const { res, done } = makeRes();
        await apiCreateSavedQuery(req, res, ctx);
        const response = await done;
        assert.equal(response.status, 200);
        const data = response.json as { query: { id: string; name: string; kind: string } };
        assert.equal(data.query.name, 'active users');
        assert.equal(data.query.kind, 'sql');
        assert.ok(data.query.id);
        createdId = data.query.id;
      }

      // List — should now contain the saved query.
      {
        const { res, done } = makeRes();
        apiListSavedQueries(res, ctx, new URLSearchParams());
        const response = await done;
        const data = response.json as { queries: Array<{ id: string; name: string }> };
        assert.equal(data.queries.length, 1);
        assert.equal(data.queries[0]?.id, createdId);
      }

      // Verify the on-disk file exists and contains what we wrote.
      const file = join(tmp, 'studio-queries.json');
      assert.ok(existsSync(file));
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        queries: Array<{ id: string; sql?: string }>;
      };
      assert.equal(parsed.queries.length, 1);
      assert.equal(parsed.queries[0]?.sql, 'SELECT id FROM users');

      // Delete.
      {
        const { res, done } = makeRes();
        apiDeleteSavedQuery(res, ctx, createdId);
        const response = await done;
        assert.equal(response.status, 200);
      }

      // List — should be empty again.
      {
        const { res, done } = makeRes();
        apiListSavedQueries(res, ctx, new URLSearchParams());
        const response = await done;
        const data = response.json as { queries: unknown[] };
        assert.deepEqual(data.queries, []);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects creating a saved SQL query that is not SELECT/WITH', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'turbine-studio-'));
    try {
      const { pool } = makePool();
      const ctx = makeCtx(pool, tmp);

      const req = makeReq({
        table: 'users',
        name: 'bad',
        kind: 'sql',
        sql: 'DELETE FROM users',
      });
      const { res, done } = makeRes();
      await apiCreateSavedQuery(req, res, ctx);
      const response = await done;
      assert.equal(response.status, 400);
      const data = response.json as { error: string };
      assert.match(data.error, /SELECT\/WITH/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns 404 when deleting a non-existent saved query', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'turbine-studio-'));
    try {
      const { pool } = makePool();
      const ctx = makeCtx(pool, tmp);

      const { res, done } = makeRes();
      apiDeleteSavedQuery(res, ctx, 'nope');
      const response = await done;
      assert.equal(response.status, 404);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
