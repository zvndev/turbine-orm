/**
 * Studio fails CLOSED when the generated metadata's PII tags cannot be read.
 *
 * `loadPiiTags` was rewritten to distinguish "this file declares no PII" from
 * "this file could not be understood" (`PiiScan.ok === false`), precisely so a
 * reformatted or truncated `metadata.ts` could no longer look like a clean bill
 * of health. Studio then ignored `scan.ok` entirely: it applied the empty tag
 * map, redacted nothing, and reported a tag count as though everything were
 * fine, in the one tool that also has a `--write` mode.
 *
 * The fix is expressed as data, not as a new flag: on `ok === false` every
 * column of every table is marked `pii`, so redaction, the orderBy / search /
 * filter refusals, and the write echo all follow through the code paths that
 * already exist. These tests drive the REAL request handler against the real
 * in-memory demo store with that metadata, so what is asserted is the served
 * bytes rather than the intent.
 *
 * `node:sqlite` is a builtin only on Node >= 22.5, so (like studio-demo.test.ts)
 * it is probed for without a static import and the DB-backed tests register as
 * skipped when it is absent.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it as nodeIt } from 'node:test';
import { loadPiiTags } from '../cli/pii-tags.js';
import {
  forceTagAllColumnsPii,
  handleRequest,
  PII_REDACTED,
  type StudioContext,
  type StudioOptions,
} from '../cli/studio.js';
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
      nodeIt(name, { skip: 'the studio demo store requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof nodeIt);

const HOST = '127.0.0.1';
const ORIGIN = `http://${HOST}:0`;
const TOKEN = 'test-token';

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

async function get(ctx: StudioContext, path: string): Promise<RecordedResponse> {
  const req = {
    method: 'GET',
    url: path,
    headers: { 'x-turbine-token': TOKEN, origin: ORIGIN },
  } as unknown as IncomingMessage;
  const { res, done } = makeRes();
  await handleRequest(req, res, ctx);
  return done;
}

async function postBuilder(ctx: StudioContext, table: string, args: unknown): Promise<RecordedResponse> {
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

/**
 * A demo context whose metadata has been through the fail-closed path, which is
 * exactly what `startStudio` does when `loadPiiTags(...).scan.ok` is false.
 */
function failClosedCtx(): { ctx: StudioContext; forced: number } {
  const demo = createDemoContext();
  // `createDemoContext` hands back the shared DEMO_SCHEMA constant, and
  // force-tagging mutates in place (that is the point: the enforcement points
  // read the tags off the metadata). Clone so one test cannot tag the schema
  // every later test reads. `startStudio` has no such concern, its metadata is
  // a fresh `introspect()` result.
  const metadata = structuredClone(demo.metadata);
  const forced = forceTagAllColumnsPii(metadata);
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
    forced,
    ctx: {
      pool: demo.pool,
      metadata,
      options,
      authToken: TOKEN,
      stateDir: tmpdir(),
      statementTimeout: { sql: 'SELECT 1', params: [] },
      rateLimiter: new Map(),
      writable: false,
      showPii: false,
      demo: true,
      dialect: demo.dialect,
      piiScanFailed: { path: '/tmp/generated/metadata.ts', reason: 'no parsable column object', columns: forced },
    },
  };
}

describe('Studio: an unreadable PII tag scan is not "no PII"', () => {
  it('the loader reports ok: false for a metadata file it cannot parse', () => {
    // The precondition the whole fix hangs on: a file that exists but does not
    // scan is distinguishable from one with no tagged columns.
    const dir = mkdtempSync(join(tmpdir(), 'turbine-pii-'));
    writeFileSync(join(dir, 'metadata.ts'), 'export const METADATA = { tables: { users: { columns: [ ', 'utf8');
    const source = loadPiiTags(dir);
    assert.ok(source, 'a metadata file was found');
    assert.equal(source?.scan.ok, false, 'the scan could not prove anything about this file');
    assert.deepEqual(source?.tags, {}, 'and the tag map it hands back is empty, which is the trap');
  });

  it('force-tags every column, and says how many', () => {
    const metadata = structuredClone(createDemoContext().metadata);
    const total = Object.values(metadata.tables).reduce((n, t) => n + t.columns.length, 0);
    const alreadyTagged = Object.values(metadata.tables).reduce(
      (n, t) => n + t.columns.filter((c) => c.pii === true).length,
      0,
    );
    const forced = forceTagAllColumnsPii(metadata);
    assert.equal(forced, total - alreadyTagged, 'counts only the columns it changed');
    for (const table of Object.values(metadata.tables)) {
      for (const col of table.columns) assert.equal(col.pii, true, `${table.name}.${col.name} tagged`);
    }
    // Idempotent: a second pass changes nothing.
    assert.equal(forceTagAllColumnsPii(metadata), 0);
  });

  it('redacts every cell of a table read', async () => {
    const { ctx } = failClosedCtx();
    const r = await get(ctx, '/api/tables/users?limit=3');
    assert.equal(r.status, 200, r.body);
    const json = r.json as { rows: Array<Record<string, unknown>> };
    assert.ok(json.rows.length > 0, 'has rows');
    for (const row of json.rows) {
      for (const [k, v] of Object.entries(row)) {
        if (v === null) continue;
        assert.equal(v, PII_REDACTED, `${k} redacted`);
      }
    }
    // The seed's addresses are the concrete thing that must not be on the wire.
    assert.doesNotMatch(r.body, /@example\.com/, 'no seeded value anywhere in the response');
  });

  it('refuses the builder route outright, with the reason', async () => {
    // Not served half-way. The default projection excludes every PII column, so
    // with every column tagged it would be empty and the core would emit
    // `SELECT  FROM "users"`, which the database answers with a bare syntax
    // error. And an explicit `select` cannot be the escape hatch, since the
    // whole premise is that which columns are sensitive is unknown.
    const { ctx } = failClosedCtx();
    for (const args of [
      { with: { posts: true }, limit: 3 },
      { select: { email: true }, limit: 1 },
    ]) {
      const r = await postBuilder(ctx, 'users', args);
      assert.equal(r.status, 400, r.body);
      assert.match(r.body, /Query tab is disabled/);
      assert.match(r.body, /show-pii/);
      assert.doesNotMatch(r.body, /@example\.com/, 'no row data in the refusal');
    }
  });

  it('explains an all-PII table instead of emitting an empty projection', async () => {
    // The same trap without the fail-closed posture: a schema that genuinely
    // tags every column of a table. Before this, the response was the
    // database's syntax error for `SELECT  FROM "users"`.
    const demo = createDemoContext();
    const metadata = structuredClone(demo.metadata);
    for (const col of metadata.tables.users?.columns ?? []) col.pii = true;
    const ctx = { ...failClosedCtx().ctx, metadata, piiScanFailed: undefined };
    const r = await postBuilder(ctx, 'users', { limit: 1 });
    assert.equal(r.status, 400, r.body);
    assert.match(r.body, /default projection is empty/);
    // Naming the columns explicitly is still allowed, and comes back redacted.
    const ok = await postBuilder(ctx, 'users', { select: { id: true, email: true }, limit: 1 });
    assert.equal(ok.status, 200, ok.body);
    const row = (ok.json as { rows: Array<Record<string, unknown>> }).rows[0];
    assert.equal(row?.email, PII_REDACTED);
  });

  it('refuses a filter on a column it is redacting, rather than answering the probe', async () => {
    // A filter is an oracle: "which rows match" leaks the value a redacted cell
    // holds. The existing rule covers tagged columns, and under the fail-closed
    // posture every column is tagged.
    const { ctx } = failClosedCtx();
    const filters = encodeURIComponent(JSON.stringify([{ column: 'email', op: 'equals', value: 'a@example.com' }]));
    const r = await get(ctx, `/api/tables/users?limit=3&filters=${filters}`);
    assert.equal(r.status, 400, r.body);
    assert.match(r.body, /redacted/);
  });

  it('tells the UI why, so a screen of markers is not mistaken for a bug', async () => {
    const { ctx, forced } = failClosedCtx();
    const r = await get(ctx, '/api/schema');
    assert.equal(r.status, 200, r.body);
    const json = r.json as { piiScanFailed: { path: string; reason: string; columns: number } | null };
    assert.ok(json.piiScanFailed, 'the schema payload carries the failure');
    assert.equal(json.piiScanFailed?.reason, 'no parsable column object');
    assert.equal(json.piiScanFailed?.columns, forced);
  });

  it('reports nothing when the scan succeeded (the banner is not always-on)', async () => {
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
    const ctx: StudioContext = {
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
    const r = await get(ctx, '/api/schema');
    const json = r.json as { piiScanFailed: unknown };
    assert.equal(json.piiScanFailed, null);
    // And a normal read still serves real values for untagged columns.
    const rows = (await get(ctx, '/api/tables/users?limit=1')).json as { rows: Array<Record<string, unknown>> };
    assert.equal(typeof rows.rows[0]?.name, 'string');
    assert.notEqual(rows.rows[0]?.name, PII_REDACTED);
  });
});
