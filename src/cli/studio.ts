/**
 * turbine-orm CLI — Studio
 *
 * A local, read-only web UI for browsing databases, exploring relations,
 * and running SELECT queries. Pure Node (built-in `http` module), no
 * runtime dependencies beyond `pg`, bound to 127.0.0.1 only.
 *
 * Security model:
 *   • Bind 127.0.0.1 only (never 0.0.0.0 — no LAN exposure)
 *   • Random auth token generated per process, required in Cookie header
 *   • SELECT/WITH-only guard on the query endpoint
 *   • Every query runs in a READ ONLY transaction (belt-and-suspenders)
 *   • 30s statement timeout
 *
 * Not implemented (deliberately): row editing, DDL, destructive operations.
 * Studio is for inspection. Use the CLI, migrate, or raw SQL for writes.
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { platform } from 'node:os';
import { dirname, resolve as pathResolve } from 'node:path';
import pg from 'pg';
import { introspect } from '../introspect.js';
import type { FindManyArgs } from '../query.js';
import { QueryInterface, quoteIdent } from '../query.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StudioOptions {
  url: string;
  schema: string;
  port: number;
  host: string;
  openBrowser: boolean;
  include?: string[];
  exclude?: string[];
  /** Directory where studio-queries.json is persisted. Defaults to `.turbine/` in cwd. */
  stateDir?: string;
}

export interface StudioHandle {
  /** Shut down the server + pool cleanly. */
  dispose: () => Promise<void>;
  /** Random per-process session token the UI sends via cookie. */
  authToken: string;
  /** Full URL including `?token=...` — safe to print for the user. */
  url: string;
}

interface StudioContext {
  pool: pg.Pool;
  metadata: SchemaMetadata;
  options: StudioOptions;
  authToken: string;
  stateDir: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Start the Studio server. Returns a handle with the session token, a pre-built
 * URL (including the token) that the CLI can print, and a disposer.
 *
 * Typical usage from the CLI:
 *   const studio = await startStudio(options);
 *   console.log(studio.url);
 *   process.on('SIGINT', () => studio.dispose().then(() => process.exit(0)));
 */
export async function startStudio(options: StudioOptions): Promise<StudioHandle> {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: 4, // small pool — single-user tool
    idleTimeoutMillis: 10_000,
  });

  // Verify connectivity before starting the server — fail fast.
  const probe = await pool.connect();
  try {
    await probe.query('SELECT 1');
  } finally {
    probe.release();
  }

  const metadata = await introspect({
    connectionString: options.url,
    schema: options.schema,
    include: options.include,
    exclude: options.exclude,
  });

  const authToken = randomBytes(24).toString('hex');
  const stateDir = pathResolve(options.stateDir ?? '.turbine');
  const ctx: StudioContext = { pool, metadata, options, authToken, stateDir };

  const server = createServer((req, res) => {
    handleRequest(req, res, ctx).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const url = buildStudioUrl(options.host, options.port, authToken);

  if (options.openBrowser) {
    openUrl(url);
  }

  return {
    authToken,
    url,
    dispose: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

/**
 * Build a browser-safe URL for the given host/port/token. Wraps IPv6 addresses
 * in brackets so `new URL(...)` inside the request handler works correctly.
 */
function buildStudioUrl(host: string, port: number, token: string): string {
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostPart}:${port}/?token=${token}`;
}

function originFor(host: string, port: number): string {
  const hostPart = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${hostPart}:${port}`;
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
  const expectedOrigin = originFor(ctx.options.host, ctx.options.port);
  // CORS: not needed — same-origin only. Explicitly refuse cross-origin.
  const origin = req.headers.origin;
  if (origin && origin !== expectedOrigin) {
    sendJson(res, 403, { error: 'cross-origin requests not allowed' });
    return;
  }

  const url = new URL(req.url ?? '/', expectedOrigin);
  const pathname = url.pathname;

  // The index route serves the HTML shell and embeds the auth token.
  // All other routes require the token in the `x-turbine-token` header
  // or the `token` cookie.
  if (pathname === '/' || pathname === '/index.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }
    const queryToken = url.searchParams.get('token');
    // If the URL includes a token, validate then set a cookie and redirect.
    if (queryToken && constantTimeEqual(queryToken, ctx.authToken)) {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `turbine_studio_token=${ctx.authToken}; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }
    sendHtml(res, 200, STUDIO_HTML);
    return;
  }

  // API routes — all require auth.
  if (!isAuthorized(req, ctx.authToken)) {
    sendJson(res, 401, { error: 'unauthorized — use the URL printed in the terminal' });
    return;
  }

  if (pathname === '/api/schema' && req.method === 'GET') {
    return apiSchema(res, ctx);
  }

  if (pathname.startsWith('/api/tables/') && req.method === 'GET') {
    const rawName = decodeURIComponent(pathname.slice('/api/tables/'.length));
    return apiTableRows(res, ctx, rawName, url.searchParams);
  }

  if (pathname === '/api/query' && req.method === 'POST') {
    return apiQuery(req, res, ctx);
  }

  if (pathname === '/api/builder' && req.method === 'POST') {
    return apiBuilder(req, res, ctx);
  }

  if (pathname === '/api/saved-queries' && req.method === 'GET') {
    return apiListSavedQueries(res, ctx, url.searchParams);
  }

  if (pathname === '/api/saved-queries' && req.method === 'POST') {
    return apiCreateSavedQuery(req, res, ctx);
  }

  if (pathname.startsWith('/api/saved-queries/') && req.method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/saved-queries/'.length));
    return apiDeleteSavedQuery(res, ctx, id);
  }

  sendJson(res, 404, { error: 'not found' });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const headerToken = req.headers['x-turbine-token'];
  if (typeof headerToken === 'string' && constantTimeEqual(headerToken, expectedToken)) {
    return true;
  }
  const cookieHeader = req.headers.cookie ?? '';
  const match = /turbine_studio_token=([a-f0-9]+)/.exec(cookieHeader);
  if (match && match[1] && constantTimeEqual(match[1], expectedToken)) {
    return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ---------------------------------------------------------------------------
// API: /api/schema
// ---------------------------------------------------------------------------

async function apiSchema(res: ServerResponse, ctx: StudioContext): Promise<void> {
  const tables = Object.values(ctx.metadata.tables).map((tbl) => ({
    name: tbl.name,
    primaryKey: tbl.primaryKey,
    columns: tbl.columns.map((col) => ({
      name: col.name,
      field: col.field,
      pgType: col.pgType,
      tsType: col.tsType,
      nullable: col.nullable,
      hasDefault: col.hasDefault,
      isPrimaryKey: tbl.primaryKey.includes(col.name),
    })),
    relations: Object.entries(tbl.relations).map(([name, rel]) => ({
      name,
      type: rel.type,
      to: rel.to,
      foreignKey: rel.foreignKey,
      referenceKey: rel.referenceKey,
    })),
  }));

  // Row counts — cheap enough to fetch inline. Use pg_class reltuples as
  // a fast estimate so we don't hammer big tables with SELECT COUNT(*).
  const countsResult = await ctx.pool.query<{ relname: string; reltuples: string }>(
    `SELECT c.relname, c.reltuples::bigint::text AS reltuples
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind = 'r'`,
    [ctx.options.schema],
  );
  const counts = new Map<string, number>();
  for (const row of countsResult.rows) {
    counts.set(row.relname, Number(row.reltuples));
  }

  sendJson(res, 200, {
    schema: ctx.options.schema,
    tables: tables.map((t) => ({ ...t, estimatedRows: counts.get(t.name) ?? 0 })),
    enums: ctx.metadata.enums,
  });
}

// ---------------------------------------------------------------------------
// API: /api/tables/:name?limit=&offset=&orderBy=&dir=
// ---------------------------------------------------------------------------

async function apiTableRows(
  res: ServerResponse,
  ctx: StudioContext,
  rawTableName: string,
  params: URLSearchParams,
): Promise<void> {
  const table = ctx.metadata.tables[rawTableName];
  if (!table) {
    sendJson(res, 404, { error: `unknown table: ${rawTableName}` });
    return;
  }

  const limit = clampInt(params.get('limit'), 50, 1, 500);
  const offset = clampInt(params.get('offset'), 0, 0, 10_000_000);

  const orderByRaw = params.get('orderBy');
  const dir = params.get('dir')?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  // orderBy — accept either the Postgres column name (snake) or the TS field
  // name (camel). Always emit the Postgres column in the SQL.
  let orderByClause = '';
  if (orderByRaw) {
    const col = resolveColumnName(table, orderByRaw);
    if (col) orderByClause = `ORDER BY ${quoteIdent(col)} ${dir}`;
  }
  if (!orderByClause && table.primaryKey.length > 0 && table.primaryKey[0]) {
    orderByClause = `ORDER BY ${quoteIdent(table.primaryKey[0])} ${dir}`;
  }

  // Full-text-ish search: ILIKE across text/varchar columns. The value is
  // parameterized so injection is impossible. Each query gets its own
  // WHERE clause with parameter indices matching that query's param array.
  const search = params.get('search')?.trim() ?? '';
  const textColumns = table.columns.filter((c) => isTextishType(c.pgType)).map((c) => c.name);
  const hasSearch = search.length > 0 && textColumns.length > 0;
  const pattern = hasSearch ? `%${escapeLikePattern(search)}%` : null;

  // Main query: $1 = limit, $2 = offset, $3 = pattern (if search)
  const mainValues: unknown[] = [limit, offset];
  let mainWhere = '';
  if (hasSearch && pattern !== null) {
    mainValues.push(pattern);
    const conds = textColumns.map((c) => `${quoteIdent(c)} ILIKE $3`);
    mainWhere = `WHERE (${conds.join(' OR ')})`;
  }

  // Count query: $1 = pattern (if search)
  const countValues: unknown[] = [];
  let countWhere = '';
  if (hasSearch && pattern !== null) {
    countValues.push(pattern);
    const conds = textColumns.map((c) => `${quoteIdent(c)} ILIKE $1`);
    countWhere = `WHERE (${conds.join(' OR ')})`;
  }

  const qualifiedTable = `${quoteIdent(ctx.options.schema)}.${quoteIdent(table.name)}`;
  const sql = `SELECT * FROM ${qualifiedTable} ${mainWhere} ${orderByClause} LIMIT $1 OFFSET $2`;
  const countSql = `SELECT COUNT(*)::text AS count FROM ${qualifiedTable} ${countWhere}`;

  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const result = await client.query(sql, mainValues);
    const countResult = await client.query<{ count: string }>(countSql, countValues);
    await client.query('COMMIT');

    sendJson(res, 200, {
      table: table.name,
      columns: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: result.rows.map((r) => serializeRow(r)),
      total: Number(countResult.rows[0]?.count ?? 0),
      limit,
      offset,
      search,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  } finally {
    client.release();
  }
}

function resolveColumnName(table: TableMetadata, nameOrField: string): string | null {
  for (const c of table.columns) {
    if (c.name === nameOrField || c.field === nameOrField) return c.name;
  }
  return null;
}

function isTextishType(pgType: string): boolean {
  return (
    pgType === 'text' ||
    pgType === 'varchar' ||
    pgType === 'character varying' ||
    pgType === 'char' ||
    pgType === 'character' ||
    pgType === 'citext' ||
    pgType === 'uuid'
  );
}

function escapeLikePattern(s: string): string {
  // Escape the LIKE wildcards so user input is treated literally.
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// ---------------------------------------------------------------------------
// API: /api/query — read-only SELECT/WITH runner
// ---------------------------------------------------------------------------

async function apiQuery(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
  const body = await readJsonBody(req);
  const rawSql = typeof body?.sql === 'string' ? body.sql.trim() : '';

  if (!rawSql) {
    sendJson(res, 400, { error: 'missing sql' });
    return;
  }

  if (!isReadOnlyStatement(rawSql)) {
    sendJson(res, 400, {
      error: 'only SELECT / WITH statements are allowed in Studio — use the CLI for writes',
    });
    return;
  }

  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const started = Date.now();
    const result = await client.query(rawSql);
    const elapsedMs = Date.now() - started;
    await client.query('COMMIT');

    sendJson(res, 200, {
      columns: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: result.rows.map((r) => serializeRow(r as Record<string, unknown>)),
      rowCount: result.rowCount ?? result.rows.length,
      elapsedMs,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// API: /api/builder — Turbine ORM findMany spec runner
// ---------------------------------------------------------------------------

async function apiBuilder(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
  const body = await readJsonBody(req);
  const tableName = typeof body?.table === 'string' ? body.table : '';
  const args = (body?.args ?? {}) as FindManyArgs<Record<string, unknown>>;

  if (!tableName || !ctx.metadata.tables[tableName]) {
    sendJson(res, 400, { error: `unknown table: ${tableName}` });
    return;
  }

  let deferred: ReturnType<QueryInterface<Record<string, unknown>>['buildFindMany']>;
  try {
    const qi = new QueryInterface<Record<string, unknown>>(ctx.pool, tableName, ctx.metadata, [], {
      warnOnUnlimited: false,
      sqlCache: false,
      preparedStatements: false,
    });
    deferred = qi.buildFindMany(args);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const started = Date.now();
    const result = await client.query(deferred.sql, deferred.params);
    const elapsedMs = Date.now() - started;
    await client.query('COMMIT');

    sendJson(res, 200, {
      sql: deferred.sql,
      columns: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: result.rows.map((r) => serializeRow(r as Record<string, unknown>)),
      rowCount: result.rowCount ?? result.rows.length,
      elapsedMs,
    });
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore */
    }
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// API: /api/saved-queries — persisted per-table query library
// ---------------------------------------------------------------------------

interface SavedQuery {
  id: string;
  table: string;
  name: string;
  kind: 'sql' | 'builder';
  sql?: string;
  args?: unknown;
  createdAt: string;
}

interface SavedQueriesFile {
  version: 1;
  queries: SavedQuery[];
}

function savedQueriesPath(ctx: StudioContext): string {
  return pathResolve(ctx.stateDir, 'studio-queries.json');
}

function loadSavedQueries(ctx: StudioContext): SavedQueriesFile {
  const file = savedQueriesPath(ctx);
  if (!existsSync(file)) return { version: 1, queries: [] };
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as SavedQueriesFile;
    if (!parsed.queries || !Array.isArray(parsed.queries)) return { version: 1, queries: [] };
    return { version: 1, queries: parsed.queries };
  } catch {
    return { version: 1, queries: [] };
  }
}

function writeSavedQueries(ctx: StudioContext, data: SavedQueriesFile): void {
  const file = savedQueriesPath(ctx);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2));
}

function apiListSavedQueries(res: ServerResponse, ctx: StudioContext, params: URLSearchParams): void {
  const { queries } = loadSavedQueries(ctx);
  const table = params.get('table');
  const filtered = table ? queries.filter((q) => q.table === table) : queries;
  sendJson(res, 200, { queries: filtered });
}

async function apiCreateSavedQuery(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
  const body = await readJsonBody(req);
  const table = typeof body?.table === 'string' ? body.table : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const kind = body?.kind === 'builder' ? 'builder' : body?.kind === 'sql' ? 'sql' : null;

  if (!table || !ctx.metadata.tables[table]) {
    sendJson(res, 400, { error: `unknown table: ${table}` });
    return;
  }
  if (!name) {
    sendJson(res, 400, { error: 'name is required' });
    return;
  }
  if (!kind) {
    sendJson(res, 400, { error: 'kind must be "sql" or "builder"' });
    return;
  }

  const sql = kind === 'sql' && typeof body?.sql === 'string' ? body.sql : undefined;
  const args = kind === 'builder' ? body?.args : undefined;
  if (kind === 'sql' && !sql) {
    sendJson(res, 400, { error: 'sql is required for kind=sql' });
    return;
  }
  if (kind === 'sql' && sql && !isReadOnlyStatement(sql)) {
    sendJson(res, 400, { error: 'saved sql must be SELECT/WITH only' });
    return;
  }

  const data = loadSavedQueries(ctx);
  const entry: SavedQuery = {
    id: randomUUID(),
    table,
    name,
    kind,
    sql,
    args,
    createdAt: new Date().toISOString(),
  };
  data.queries.push(entry);
  writeSavedQueries(ctx, data);
  sendJson(res, 200, { query: entry });
}

function apiDeleteSavedQuery(res: ServerResponse, ctx: StudioContext, id: string): void {
  const data = loadSavedQueries(ctx);
  const before = data.queries.length;
  data.queries = data.queries.filter((q) => q.id !== id);
  if (data.queries.length === before) {
    sendJson(res, 404, { error: 'saved query not found' });
    return;
  }
  writeSavedQueries(ctx, data);
  sendJson(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Accept only SELECT or WITH (CTE) statements. Reject any statement that
 * contains a semicolon followed by non-whitespace (prevents statement
 * stacking), and require the first non-comment keyword to be SELECT or WITH.
 *
 * This is a first-line filter — the transaction's READ ONLY mode is the
 * second line of defense. Both must fail before a destructive statement
 * could run.
 */
export function isReadOnlyStatement(sql: string): boolean {
  const stripped = stripSqlComments(sql).trim();
  if (!stripped) return false;

  // Disallow statement stacking. A single trailing `;` is fine.
  const withoutTrailingSemi = stripped.replace(/;+\s*$/, '');
  if (withoutTrailingSemi.includes(';')) return false;

  const firstWord = withoutTrailingSemi.slice(0, 6).toUpperCase();
  if (firstWord.startsWith('SELECT')) return true;
  if (firstWord.startsWith('WITH')) return true;
  return false;
}

function stripSqlComments(sql: string): string {
  // Strip -- line comments and /* block comments */. Not a full SQL parser,
  // but sufficient to catch the common bypass attempts.
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) {
      out[k] = v.toISOString();
    } else if (typeof v === 'bigint') {
      out[k] = v.toString();
    } else if (Buffer.isBuffer(v)) {
      out[k] = `\\x${v.toString('hex')}`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  const MAX = 1 << 20; // 1 MB cap on query payloads
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('invalid json body');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function openUrl(url: string): void {
  const cmd = platform() === 'darwin' ? 'open' : platform() === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform() === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    // Non-fatal — user can click the URL manually.
  }
}

// ---------------------------------------------------------------------------
// Embedded UI — vanilla HTML/CSS/JS, no deps, dark theme to match turbineorm.dev
// ---------------------------------------------------------------------------

const STUDIO_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Turbine Studio</title>
<style>
  :root {
    --bg: #0a0a0b;
    --bg-elev: #111113;
    --bg-hover: #1a1a1d;
    --border: #26262b;
    --text: #e6e6ea;
    --text-dim: #8a8a93;
    --accent: #60a5fa;
    --accent-hover: #93c5fd;
    --green: #4ade80;
    --orange: #fb923c;
    --red: #f87171;
    --mono: "Geist Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    --sans: Inter, system-ui, -apple-system, Segoe UI, sans-serif;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font-family: var(--sans); height: 100%; }
  body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; font-size: 13px; }
  header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex: none; }
  header .brand { font-family: var(--mono); font-weight: 600; letter-spacing: -0.01em; }
  header .brand span { color: var(--accent); }
  header .meta { color: var(--text-dim); font-family: var(--mono); font-size: 12px; }
  main { display: flex; flex: 1; min-height: 0; }
  aside { width: 280px; border-right: 1px solid var(--border); background: var(--bg-elev); overflow-y: auto; flex: none; }
  aside h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); padding: 14px 16px 6px; margin: 0; font-weight: 600; }
  aside .table-row { padding: 8px 16px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-family: var(--mono); font-size: 12px; border-left: 2px solid transparent; }
  aside .table-row:hover { background: var(--bg-hover); }
  aside .table-row.active { background: var(--bg-hover); border-left-color: var(--accent); color: var(--accent); }
  aside .table-row .count { color: var(--text-dim); font-size: 11px; }
  section.content { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  .tabs { display: flex; border-bottom: 1px solid var(--border); background: var(--bg-elev); flex: none; }
  .tabs button { background: transparent; border: none; color: var(--text-dim); padding: 10px 18px; font-family: var(--mono); font-size: 12px; cursor: pointer; border-bottom: 2px solid transparent; }
  .tabs button:hover { color: var(--text); }
  .tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
  .pane { flex: 1; overflow: auto; padding: 16px; min-height: 0; }
  .pane.hidden { display: none; }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .toolbar .title { font-family: var(--mono); font-size: 13px; color: var(--accent); margin-right: auto; }
  button.btn, select.btn { background: var(--bg-elev); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 4px; cursor: pointer; font-family: var(--mono); font-size: 12px; }
  button.btn:hover { border-color: var(--accent); }
  button.btn:disabled { opacity: 0.4; cursor: not-allowed; }
  table { border-collapse: collapse; width: 100%; font-family: var(--mono); font-size: 12px; }
  table th { text-align: left; padding: 8px 10px; background: var(--bg-elev); color: var(--text-dim); font-weight: 600; border-bottom: 1px solid var(--border); position: sticky; top: 0; }
  table td { padding: 6px 10px; border-bottom: 1px solid var(--border); max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  table tr:hover td { background: var(--bg-hover); }
  .pk { color: var(--orange); }
  .null { color: var(--text-dim); font-style: italic; }
  .schema-block { margin-bottom: 24px; }
  .schema-block h4 { margin: 0 0 8px; font-family: var(--mono); font-size: 13px; color: var(--accent); }
  .col-list { list-style: none; padding: 0; margin: 0; font-family: var(--mono); font-size: 12px; }
  .col-list li { padding: 3px 0; color: var(--text-dim); }
  .col-list li .name { color: var(--text); }
  .col-list li .type { color: var(--green); }
  .rel-list { list-style: none; padding: 0; margin: 8px 0 0; font-family: var(--mono); font-size: 12px; }
  .rel-list li { padding: 3px 0; color: var(--text-dim); }
  .rel-list li .name { color: var(--accent); }
  textarea#sql { width: 100%; min-height: 140px; background: var(--bg); border: 1px solid var(--border); color: var(--text); font-family: var(--mono); font-size: 13px; padding: 10px; border-radius: 4px; resize: vertical; }
  textarea#sql:focus { outline: none; border-color: var(--accent); }
  .query-meta { color: var(--text-dim); font-family: var(--mono); font-size: 11px; margin: 8px 0; }
  .error { color: var(--red); font-family: var(--mono); font-size: 12px; padding: 10px; background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.3); border-radius: 4px; white-space: pre-wrap; }
  .empty { color: var(--text-dim); text-align: center; padding: 40px; font-family: var(--mono); font-size: 12px; }
  kbd { font-family: var(--mono); background: var(--bg-elev); border: 1px solid var(--border); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
</style>
</head>
<body>
<header>
  <div class="brand">turbine<span>·</span>studio</div>
  <div class="meta" id="meta">loading&hellip;</div>
</header>
<main>
  <aside>
    <h3>Tables</h3>
    <div id="tables"></div>
    <h3 id="enums-header" style="display:none">Enums</h3>
    <div id="enums"></div>
  </aside>
  <section class="content">
    <div class="tabs">
      <button data-tab="data" class="active">Data</button>
      <button data-tab="schema">Schema</button>
      <button data-tab="query">Query</button>
    </div>
    <div class="pane" id="pane-data">
      <div class="empty">Select a table from the sidebar to browse rows.</div>
    </div>
    <div class="pane hidden" id="pane-schema">
      <div class="empty">Select a table to view its schema.</div>
    </div>
    <div class="pane hidden" id="pane-query">
      <div class="toolbar">
        <div class="title">Read-only query runner</div>
        <button class="btn" id="runQuery">Run <kbd>&#8984;&#9166;</kbd></button>
      </div>
      <textarea id="sql" placeholder="SELECT * FROM users LIMIT 10;"></textarea>
      <div class="query-meta" id="queryMeta"></div>
      <div id="queryResult"></div>
    </div>
  </section>
</main>
<script>
  const state = { schema: null, current: null, offset: 0, limit: 50, orderBy: null, dir: 'asc' };

  async function api(path, opts) {
    const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts?.headers ?? {}) } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') node.className = v;
      else if (k === 'onclick') node.addEventListener('click', v);
      else if (k === 'onchange') node.addEventListener('change', v);
      else node.setAttribute(k, v);
    }
    for (const c of children || []) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function fmtCount(n) {
    if (n == null) return '';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\\.0$/, '') + 'k';
    return (n / 1_000_000).toFixed(1).replace(/\\.0$/, '') + 'M';
  }

  function fmtCell(v) {
    if (v == null) return el('span', { class: 'null' }, ['null']);
    if (typeof v === 'object') return el('span', {}, [JSON.stringify(v)]);
    return el('span', {}, [String(v)]);
  }

  async function loadSchema() {
    const data = await api('/api/schema');
    state.schema = data;
    const tables = document.getElementById('tables');
    tables.innerHTML = '';
    for (const t of data.tables) {
      const row = el('div', { class: 'table-row', 'data-table': t.name, onclick: () => selectTable(t.name) }, [
        el('span', {}, [t.name]),
        el('span', { class: 'count' }, [fmtCount(t.estimatedRows)]),
      ]);
      tables.appendChild(row);
    }
    const enumKeys = Object.keys(data.enums || {});
    if (enumKeys.length) {
      document.getElementById('enums-header').style.display = 'block';
      const enumsDiv = document.getElementById('enums');
      enumsDiv.innerHTML = '';
      for (const name of enumKeys) {
        const labels = data.enums[name] || [];
        enumsDiv.appendChild(
          el('div', { class: 'table-row', style: 'cursor:default' }, [
            el('span', { style: 'color: var(--accent)' }, [name]),
            el('span', { class: 'count' }, [String(labels.length)]),
          ]),
        );
      }
    }
    document.getElementById('meta').textContent = data.schema + ' · ' + data.tables.length + ' tables';
  }

  async function selectTable(name) {
    state.current = name;
    state.offset = 0;
    state.orderBy = null;
    for (const row of document.querySelectorAll('.table-row')) {
      row.classList.toggle('active', row.getAttribute('data-table') === name);
    }
    await Promise.all([loadData(), renderSchemaPane()]);
  }

  async function loadData() {
    if (!state.current) return;
    const pane = document.getElementById('pane-data');
    pane.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
      const qs = new URLSearchParams({ limit: String(state.limit), offset: String(state.offset), dir: state.dir });
      if (state.orderBy) qs.set('orderBy', state.orderBy);
      const data = await api('/api/tables/' + encodeURIComponent(state.current) + '?' + qs.toString());
      renderDataPane(pane, data);
    } catch (err) {
      pane.innerHTML = '';
      pane.appendChild(el('div', { class: 'error' }, [err.message]));
    }
  }

  function renderDataPane(pane, data) {
    pane.innerHTML = '';
    const toolbar = el('div', { class: 'toolbar' }, [
      el('div', { class: 'title' }, [data.table + ' · ' + data.total + ' rows']),
      el('button', { class: 'btn', onclick: prevPage }, ['<']),
      el('span', { class: 'query-meta' }, [(data.offset + 1) + '-' + Math.min(data.offset + data.limit, data.total)]),
      el('button', { class: 'btn', onclick: nextPage }, ['>']),
    ]);
    pane.appendChild(toolbar);

    if (!data.rows.length) {
      pane.appendChild(el('div', { class: 'empty' }, ['No rows.']));
      return;
    }

    const table = el('table', {}, []);
    const thead = el('thead', {}, [el('tr', {}, data.columns.map((c) => el('th', {}, [c.name])))]);
    const tbody = el('tbody', {}, data.rows.map((row) =>
      el('tr', {}, data.columns.map((c) => el('td', { title: row[c.name] == null ? 'null' : String(row[c.name]) }, [fmtCell(row[c.name])]))),
    ));
    table.appendChild(thead);
    table.appendChild(tbody);
    pane.appendChild(table);
  }

  function prevPage() {
    if (state.offset <= 0) return;
    state.offset = Math.max(0, state.offset - state.limit);
    loadData();
  }

  function nextPage() {
    state.offset += state.limit;
    loadData();
  }

  function renderSchemaPane() {
    const pane = document.getElementById('pane-schema');
    if (!state.current || !state.schema) {
      pane.innerHTML = '<div class="empty">Select a table.</div>';
      return;
    }
    const t = state.schema.tables.find((x) => x.name === state.current);
    if (!t) { pane.innerHTML = '<div class="empty">Table not found.</div>'; return; }
    pane.innerHTML = '';
    const block = el('div', { class: 'schema-block' }, [
      el('h4', {}, [t.name]),
      el('ul', { class: 'col-list' }, t.columns.map((c) =>
        el('li', {}, [
          el('span', { class: c.isPrimaryKey ? 'pk' : 'name' }, [c.field]),
          ' ',
          el('span', { class: 'type' }, [c.tsType + (c.nullable ? ' | null' : '')]),
          '  ',
          el('span', {}, ['(' + c.pgType + ')']),
        ]),
      )),
    ]);
    pane.appendChild(block);
    if (t.relations.length) {
      pane.appendChild(
        el('div', { class: 'schema-block' }, [
          el('h4', {}, ['Relations']),
          el('ul', { class: 'rel-list' }, t.relations.map((r) =>
            el('li', {}, [
              el('span', { class: 'name' }, [r.name]),
              ' → ' + r.to + ' (' + r.type + ', FK: ' + r.foreignKey + ')',
            ]),
          )),
        ]),
      );
    }
  }

  async function runQuery() {
    const sql = document.getElementById('sql').value.trim();
    if (!sql) return;
    const meta = document.getElementById('queryMeta');
    const result = document.getElementById('queryResult');
    meta.textContent = 'Running…';
    result.innerHTML = '';
    try {
      const data = await api('/api/query', { method: 'POST', body: JSON.stringify({ sql }) });
      meta.textContent = data.rowCount + ' row(s) · ' + data.elapsedMs + 'ms';
      if (!data.rows.length) {
        result.appendChild(el('div', { class: 'empty' }, ['No rows returned.']));
        return;
      }
      const table = el('table', {}, []);
      const thead = el('thead', {}, [el('tr', {}, data.columns.map((c) => el('th', {}, [c.name])))]);
      const tbody = el('tbody', {}, data.rows.map((row) =>
        el('tr', {}, data.columns.map((c) => el('td', {}, [fmtCell(row[c.name])]))),
      ));
      table.appendChild(thead);
      table.appendChild(tbody);
      result.appendChild(table);
    } catch (err) {
      meta.textContent = '';
      result.appendChild(el('div', { class: 'error' }, [err.message]));
    }
  }

  function switchTab(name) {
    for (const btn of document.querySelectorAll('.tabs button')) {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === name);
    }
    document.getElementById('pane-data').classList.toggle('hidden', name !== 'data');
    document.getElementById('pane-schema').classList.toggle('hidden', name !== 'schema');
    document.getElementById('pane-query').classList.toggle('hidden', name !== 'query');
  }

  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.getAttribute('data-tab')));
  });
  document.getElementById('runQuery').addEventListener('click', runQuery);
  document.getElementById('sql').addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runQuery(); }
  });

  loadSchema().catch((err) => {
    document.getElementById('meta').textContent = 'error: ' + err.message;
  });
</script>
</body>
</html>`;
