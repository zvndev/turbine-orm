/**
 * Studio: the builder route serves ENTITY rows, not driver rows.
 *
 * `/api/builder` used to serialize `result.rows` straight from the driver and
 * redact those. That was two defects in one:
 *
 *   1. SECURITY. `relationLoadStrategy: 'flatten'` projects a to-one relation's
 *      columns flat onto the parent row under generated aliases (`f0__email`).
 *      `redactBuilderRows` finds a relation's PII by walking the `with` tree
 *      into the NESTED relation object, so on a flat row it walked into nothing
 *      and every prefixed PII cell went out in the clear. The predicate guard
 *      (`assertNoPiiPredicates`) deliberately ALLOWS `select` on a PII column on
 *      the grounds that the values "are redacted on the way out", so this was
 *      the one place that promise could break.
 *   2. Correctness. Driver rows are keyed by raw SQL output column
 *      (`created_at`), not by the camelCase field name the ORM returns and the
 *      user would write, so the grid (and anything copied out of it) named keys
 *      that do not exist on a real result.
 *
 * Both are fixed by running the result through the query's own `transform`.
 * These tests drive the real `handleRequest` against the REAL in-memory
 * `node:sqlite` demo store, so the flatten plan is genuinely compiled and
 * executed. `node:sqlite` is a builtin only on Node >= 22.5, so (like
 * studio-demo.test.ts) it is probed for WITHOUT a static import and every test
 * registers skipped when absent.
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
// Mock req / res (same shape studio-demo.test.ts drives handleRequest with)
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
    setHeader() {},
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

const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:0`;
const TOKEN = 'test-token';

function makeDemoCtx(showPii = false): StudioContext {
  const demo = createDemoContext();
  const options: StudioOptions = {
    url: 'demo://in-memory',
    schema: 'public',
    port: 0,
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
    showPii,
    demo: true,
    dialect: demo.dialect,
  };
}

interface BuilderResponse {
  sql: string;
  columns: Array<{ name: string }>;
  rows: Array<Record<string, unknown>>;
  rowCount: number;
}

async function runBuilder(ctx: StudioContext, table: string, args: unknown): Promise<RecordedResponse> {
  const payload = Buffer.from(JSON.stringify({ table, args }), 'utf8');
  const req = {
    method: 'POST',
    url: '/api/builder',
    headers: { 'x-turbine-token': TOKEN, origin: ORIGIN },
    async *[Symbol.asyncIterator]() {
      yield payload;
    },
  } as unknown as IncomingMessage;
  const { res, done } = makeRes();
  await handleRequest(req, res, ctx);
  return done;
}

// The flat projection prefix a flatten plan generates. If the plan ever stops
// engaging, the leak-shaped assertions below would pass vacuously, so each test
// that depends on it also asserts the plan is really in the SQL.
const FLATTEN_ALIAS = /f\d+__/;

describe('Studio builder: the flatten strategy cannot bypass PII redaction', () => {
  it('redacts a flattened to-one relation PII column and re-nests it under the relation name', async () => {
    // `select` is the shape that puts a PII column on the wire at all: the
    // default projection already excludes PII at the SQL level, and the
    // predicate guard permits an explicit `select` on the grounds that the
    // value is redacted on the way out. Flatten is where that stopped being
    // true, so this is exactly the leaking query.
    const ctx = makeDemoCtx();
    const r = await runBuilder(ctx, 'posts', {
      with: { author: { select: { id: true, name: true, email: true } } },
      relationLoadStrategy: 'flatten',
      limit: 3,
    });
    assert.equal(r.status, 200, r.body);
    const json = r.json as BuilderResponse;

    // The plan really compiled to a flat join, so the redaction below is
    // exercising the shape that used to leak.
    assert.match(json.sql, FLATTEN_ALIAS, 'flatten plan engaged (prefixed aliases in the SQL)');
    assert.ok(json.rows.length > 0, 'has post rows');

    // Asserted FIRST and against the raw body, because it is the actual defect:
    // before the fix the address went out in the clear under the alias key
    // `f0__email`, and every structural assertion below would have to be read
    // to notice. The seed's addresses all end in @example.com.
    assert.doesNotMatch(r.body, /@example\.com/, 'no seeded email address anywhere in the response');

    for (const row of json.rows) {
      const author = row.author as Record<string, unknown> | null;
      assert.ok(author && typeof author === 'object', 'author re-nested as an object, not flat columns');
      assert.equal(author.email, PII_REDACTED, 'nested author email redacted');
      assert.equal(typeof author.name, 'string', 'non-PII author column still readable');
      assert.notEqual(author.name, PII_REDACTED);
      // No prefixed alias survives into the payload: a leftover `f0__email`
      // would be an un-redacted cell under a different name.
      for (const key of Object.keys(row)) {
        assert.doesNotMatch(key, FLATTEN_ALIAS, `row key "${key}" is a raw flatten alias`);
      }
    }
  });

  it('serves the real value when --show-pii is on (proving the redaction test is not vacuous)', async () => {
    const ctx = makeDemoCtx(true);
    const r = await runBuilder(ctx, 'posts', {
      with: { author: { select: { id: true, email: true } } },
      relationLoadStrategy: 'flatten',
      limit: 1,
    });
    assert.equal(r.status, 200, r.body);
    const json = r.json as BuilderResponse;
    assert.match(json.sql, FLATTEN_ALIAS, 'flatten plan engaged');
    const author = json.rows[0]?.author as Record<string, unknown>;
    assert.match(String(author.email), /@example\.com/, 'real email served with --show-pii');
  });

  it('projects no PII at all on a flattened relation that does not select it', async () => {
    // Defense in depth, and the reason the leak needed an explicit `select` to
    // reach: the default projection drops PII columns AT THE SQL LEVEL on the
    // flattened side too, so an unredacted cell never leaves the database.
    const ctx = makeDemoCtx();
    const r = await runBuilder(ctx, 'posts', {
      with: { author: true },
      relationLoadStrategy: 'flatten',
      limit: 2,
    });
    assert.equal(r.status, 200, r.body);
    const json = r.json as BuilderResponse;
    assert.match(json.sql, FLATTEN_ALIAS, 'flatten plan engaged');
    assert.doesNotMatch(json.sql, /"email"/, 'no PII column in the emitted projection');
    for (const row of json.rows) {
      const author = row.author as Record<string, unknown> | null;
      assert.ok(author, 'author present');
      assert.ok(!('email' in author), 'PII column absent entirely, not merely redacted');
      assert.equal(typeof author.name, 'string', 'non-PII columns still projected');
    }
  });
});

describe('Studio builder: rows are entity rows', () => {
  it('keys rows by camelCase field name, not by raw column name', async () => {
    const ctx = makeDemoCtx();
    const r = await runBuilder(ctx, 'users', { limit: 1 });
    assert.equal(r.status, 200, r.body);
    const json = r.json as BuilderResponse;
    const row = json.rows[0] as Record<string, unknown>;
    assert.ok(row, 'has a user row');
    // `created_at` is the column; `createdAt` is the field the ORM returns and
    // the name a user has to write in `orderBy` / `select`.
    assert.ok('createdAt' in row, 'row carries the camelCase field name');
    assert.ok(!('created_at' in row), 'row does not carry the raw column name');
  });

  it('reports columns that match the row keys exactly', async () => {
    const ctx = makeDemoCtx();
    const r = await runBuilder(ctx, 'posts', { with: { author: true }, limit: 2 });
    assert.equal(r.status, 200, r.body);
    const json = r.json as BuilderResponse;
    const names = json.columns.map((c) => c.name).sort();
    const keys = Object.keys(json.rows[0] as Record<string, unknown>).sort();
    assert.deepEqual(names, keys, 'header names are the keys the grid will look up');
    assert.ok(names.includes('author'), 'the relation is a column of the result');
  });

  it('still nests a to-many relation on the default strategy', async () => {
    const ctx = makeDemoCtx();
    const r = await runBuilder(ctx, 'users', { with: { posts: true }, limit: 3 });
    assert.equal(r.status, 200, r.body);
    const json = r.json as BuilderResponse;
    const withPosts = json.rows.find((row) => Array.isArray(row.posts) && (row.posts as unknown[]).length > 0);
    assert.ok(withPosts, 'at least one user has a parsed posts array');
    const firstPost = (withPosts?.posts as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
    assert.equal(typeof firstPost.title, 'string');
    assert.ok('createdAt' in firstPost, 'nested rows are field-keyed too');
  });
});
