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
import { STUDIO_HTML } from './studio-ui.generated.js';

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

export interface StudioContext {
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
  if (match?.[1] && constantTimeEqual(match[1], expectedToken)) {
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

export async function apiTableRows(
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

export function resolveColumnName(table: TableMetadata, nameOrField: string): string | null {
  for (const c of table.columns) {
    if (c.name === nameOrField || c.field === nameOrField) return c.name;
  }
  return null;
}

export function isTextishType(pgType: string): boolean {
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

export function escapeLikePattern(s: string): string {
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

export async function apiBuilder(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
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

export function apiListSavedQueries(res: ServerResponse, ctx: StudioContext, params: URLSearchParams): void {
  const { queries } = loadSavedQueries(ctx);
  const table = params.get('table');
  const filtered = table ? queries.filter((q) => q.table === table) : queries;
  sendJson(res, 200, { queries: filtered });
}

export async function apiCreateSavedQuery(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: StudioContext,
): Promise<void> {
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

export function apiDeleteSavedQuery(res: ServerResponse, ctx: StudioContext, id: string): void {
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
