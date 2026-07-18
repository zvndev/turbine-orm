/**
 * turbine-orm CLI — Studio
 *
 * A local web UI for browsing databases, exploring relations, and composing
 * queries visually. ORM-native since v0.19: there is no raw-SQL input surface.
 * The Query tab builds `findMany` args that are validated against introspected
 * metadata and compiled by QueryInterface (`/api/builder`). Pure Node (built-in
 * `http` module), no runtime dependencies beyond `pg`. CLI defaults to 127.0.0.1
 * and refuses non-loopback hosts unless `npx turbine studio --allow-remote`.
 *
 * Read-only by default. `turbine studio --write` opts in to single-row writes
 * (see the write model below); without the flag the write API routes do not
 * exist (they 404) and the UI renders no write affordances.
 *
 * Security model:
 *   • Loopback by default; CLI refuses non-loopback without --allow-remote
 *   • Random auth token generated per process, required in Cookie header
 *   • No SQL input surface at all: every identifier in a builder or write
 *     request is validated against the introspected schema; all values are
 *     $N params compiled through the query builders
 *   • Read routes run in a READ ONLY transaction (belt-and-suspenders)
 *   • Write routes (only when `--write` is set) run in a plain BEGIN/COMMIT
 *     transaction, require a matching Origin header (CSRF), and target exactly
 *     one row by its full primary key
 *   • 30s statement timeout via parameterized set_config()
 *   • Per-session rate limiting, cross-origin refusal, security headers, and a
 *     per-request CSP nonce for the inline script (no `unsafe-inline`)
 *
 * PII: columns tagged `pii` in code-first metadata are redacted server-side in
 * every row-bearing response (the literal `•• redacted ••`) unless the server
 * was started with `--show-pii`.
 *
 * Write model (opt-in): update/insert/delete a single row. DDL and multi-row or
 * unconditional writes are deliberately unsupported. Use the CLI or migrate for
 * schema changes and bulk operations.
 */

import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { platform } from 'node:os';
import { dirname, resolve as pathResolve } from 'node:path';
import pg from 'pg';
import { introspect } from '../introspect.js';
import type { CreateArgs, DeleteArgs, FindManyArgs, UpdateArgs } from '../query/index.js';
import { QueryInterface, quoteIdent } from '../query/index.js';
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
  /** Database adapter for dialect-specific behavior (e.g. statement timeout syntax). */
  adapter?: import('../adapters/index.js').DatabaseAdapter;
  /**
   * Opt in to single-row write routes (`/api/row/update|insert|delete`) and the
   * write UI. Default `false`: read-only, with the write routes absent (404).
   */
  write?: boolean;
  /**
   * Reveal PII-tagged column values instead of redacting them. Default `false`.
   */
  showPii?: boolean;
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
  /** Resolved statement timeout (adapter-aware) — parameterized SQL + values. */
  statementTimeout: { sql: string; params: unknown[] };
  /** Rate limiter state — tracks requests per authenticated session. */
  rateLimiter: Map<string, { count: number; resetAt: number }>;
  /**
   * True when write mode is enabled (`--write`): the `/api/row/*` routes exist
   * and the UI renders write affordances. Absent/false → read-only.
   */
  writable?: boolean;
  /** True when PII redaction is disabled (`--show-pii`). Absent/false → redact. */
  showPii?: boolean;
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
  const statementTimeout = options.adapter?.statementTimeout?.(30) ?? {
    // Postgres rejects parameters in `SET LOCAL` (`SET LOCAL ... = $1` is a
    // syntax error). `set_config(name, value, is_local=true)` is the
    // parameterizable, transaction-local equivalent and works on every
    // Postgres-compatible engine.
    sql: `SELECT set_config('statement_timeout', $1, true)`,
    params: ['30s'],
  };
  const rateLimiter = new Map<string, { count: number; resetAt: number }>();
  const ctx: StudioContext = {
    pool,
    metadata,
    options,
    authToken,
    stateDir,
    statementTimeout,
    rateLimiter,
    writable: options.write === true,
    showPii: options.showPii === true,
  };

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

export async function handleRequest(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
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
    sendHtml(res, 200, STUDIO_HTML, cspNonce());
    return;
  }

  // Favicon — answered before the auth gate so the browser's automatic request
  // doesn't 401/404 on every load. No icon body needed (204).
  if (pathname === '/favicon.ico') {
    res.writeHead(204, { 'Content-Length': '0' });
    res.end();
    return;
  }

  // API routes — all require auth.
  if (!isAuthorized(req, ctx.authToken)) {
    sendJson(res, 401, { error: 'unauthorized — use the URL printed in the terminal' });
    return;
  }

  // Rate limiting — 100 requests per 60 seconds per authenticated session.
  const rateLimitResult = checkRateLimit(ctx.rateLimiter, ctx.authToken);
  if (!rateLimitResult.allowed) {
    const retryAfter = Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: 'Rate limit exceeded', retryAfter });
    return;
  }

  if (pathname === '/api/schema' && req.method === 'GET') {
    return apiSchema(res, ctx);
  }

  if (pathname.startsWith('/api/tables/') && req.method === 'GET') {
    const rawName = decodeURIComponent(pathname.slice('/api/tables/'.length));
    return apiTableRows(res, ctx, rawName, url.searchParams);
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

  // Write routes: ONLY exist in write mode. In read-only mode they fall through
  // to the 404 below (deliberately not 403: a read-only Studio has no such API).
  if (ctx.writable && pathname.startsWith('/api/row/') && req.method === 'POST') {
    // CSRF: a state-changing request MUST carry a same-origin Origin header. The
    // top-of-handler check already rejects a MISMATCHED origin (403); this also
    // rejects an ABSENT one, which read (GET) routes tolerate for curl ergonomics
    // but a browser always sends on a cross-scheme/site POST. `fetch` from the
    // Studio page always sets it for same-origin, so the real UI is unaffected.
    if (origin !== expectedOrigin) {
      sendJson(res, 403, { error: 'a matching Origin header is required for write requests' });
      return;
    }
    const op = pathname.slice('/api/row/'.length);
    if (op === 'update') return apiRowWrite(req, res, ctx, 'update');
    if (op === 'insert') return apiRowWrite(req, res, ctx, 'insert');
    if (op === 'delete') return apiRowWrite(req, res, ctx, 'delete');
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

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds
const RATE_LIMIT_MAX_REQUESTS = 100;

interface RateLimitResult {
  allowed: boolean;
  resetAt: number;
}

function checkRateLimit(limiter: Map<string, { count: number; resetAt: number }>, token: string): RateLimitResult {
  const now = Date.now();
  const entry = limiter.get(token);

  if (!entry || now >= entry.resetAt) {
    // Start a new window
    const resetAt = now + RATE_LIMIT_WINDOW_MS;
    limiter.set(token, { count: 1, resetAt });
    return { allowed: true, resetAt };
  }

  entry.count++;
  if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
    return { allowed: false, resetAt: entry.resetAt };
  }

  return { allowed: true, resetAt: entry.resetAt };
}

function constantTimeEqual(a: string, b: string): boolean {
  // Hash both inputs to fixed-length 32-byte SHA-256 digests before comparing.
  // This makes the comparison constant-length (timingSafeEqual never throws on a
  // length mismatch) and leaks neither length nor content via timing.
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Build a helpful "unknown table" error that lists the available tables so the
 * caller can spot a typo or schema mismatch immediately.
 */
function unknownTableMessage(name: string, ctx: StudioContext): string {
  const available = Object.keys(ctx.metadata.tables);
  const list = available.length ? available.join(', ') : '(none)';
  return `[turbine] Unknown table "${name}" in schema "${ctx.options.schema}". Available: ${list}`;
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
      pii: col.pii === true,
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
    // pg_class.reltuples is -1 on PG14+ until a table is ANALYZEd; clamp so the
    // sidebar never shows a negative estimate.
    counts.set(row.relname, Math.max(0, Number(row.reltuples)));
  }

  sendJson(res, 200, {
    schema: ctx.options.schema,
    tables: tables.map((t) => ({ ...t, estimatedRows: counts.get(t.name) ?? 0 })),
    enums: ctx.metadata.enums,
    // Client-config flags the UI reads to gate write affordances / PII masking.
    // Read-only Studio reports `writable: false` so the UI renders no write UI.
    writable: ctx.writable === true,
    showPii: ctx.showPii === true,
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
    sendJson(res, 404, { error: unknownTableMessage(rawTableName, ctx) });
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
    const conds = textColumns.map((c) => `${quoteIdent(c)} ILIKE $3 ESCAPE '\\'`);
    mainWhere = `WHERE (${conds.join(' OR ')})`;
  }

  // Count query: $1 = pattern (if search)
  const countValues: unknown[] = [];
  let countWhere = '';
  if (hasSearch && pattern !== null) {
    countValues.push(pattern);
    const conds = textColumns.map((c) => `${quoteIdent(c)} ILIKE $1 ESCAPE '\\'`);
    countWhere = `WHERE (${conds.join(' OR ')})`;
  }

  const qualifiedTable = `${quoteIdent(ctx.options.schema)}.${quoteIdent(table.name)}`;
  const sql = `SELECT * FROM ${qualifiedTable} ${mainWhere} ${orderByClause} LIMIT $1 OFFSET $2`;
  const countSql = `SELECT COUNT(*)::text AS count FROM ${qualifiedTable} ${countWhere}`;

  const client = await ctx.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(ctx.statementTimeout.sql, ctx.statementTimeout.params);
    const result = await client.query(sql, mainValues);
    const countResult = await client.query<{ count: string }>(countSql, countValues);
    await client.query('COMMIT');

    const piiKeys = ctx.showPii ? NO_PII_KEYS : piiKeysForTable(table);
    sendJson(res, 200, {
      table: table.name,
      columns: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: result.rows.map((r) => serializeRow(redactFlatRow(r, piiKeys))),
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
// API: /api/builder — Turbine ORM findMany spec runner
// ---------------------------------------------------------------------------

export async function apiBuilder(req: IncomingMessage, res: ServerResponse, ctx: StudioContext): Promise<void> {
  const body = await readJsonBody(req);
  const tableName = typeof body?.table === 'string' ? body.table : '';
  const args = (body?.args ?? {}) as FindManyArgs<Record<string, unknown>>;

  if (!tableName || !ctx.metadata.tables[tableName]) {
    sendJson(res, 400, { error: unknownTableMessage(tableName, ctx) });
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
    await client.query(ctx.statementTimeout.sql, ctx.statementTimeout.params);
    // QueryInterface emits unqualified table identifiers, which resolve via
    // the connection's search_path. Pin it to the configured --schema so the
    // Query tab reads the same schema as the Data tab (set_config is
    // transaction-local and fully parameterized).
    await client.query(`SELECT set_config('search_path', $1, true)`, [ctx.options.schema]);
    const started = Date.now();
    const result = await client.query(deferred.sql, deferred.params);
    const elapsedMs = Date.now() - started;
    await client.query('COMMIT');

    const rawRows = result.rows as Record<string, unknown>[];
    const redactedRows = ctx.showPii ? rawRows : redactBuilderRows(rawRows, tableName, args.with, ctx.metadata);
    sendJson(res, 200, {
      sql: deferred.sql,
      columns: result.fields.map((f) => ({ name: f.name, dataTypeID: f.dataTypeID })),
      rows: redactedRows.map((r) => serializeRow(r)),
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
// API: /api/row/update | /api/row/insert | /api/row/delete (single-row writes)
//
// Write mode only (the routes do not exist otherwise). Every column identifier
// is validated against the introspected metadata and the statement is compiled
// through the query builders (`buildUpdate`/`buildCreate`/`buildDelete`) so all
// values are $N params; there is no raw SQL. update/delete require the caller
// to supply the FULL primary key in `where`; the effective predicate is rebuilt
// from those PK values alone, so a write can only ever touch one row.
// ---------------------------------------------------------------------------

export async function apiRowWrite(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: StudioContext,
  op: 'update' | 'insert' | 'delete',
): Promise<void> {
  const body = await readJsonBody(req);
  const tableName = typeof body?.table === 'string' ? body.table : '';
  const table = ctx.metadata.tables[tableName];
  if (!table) {
    sendJson(res, 400, { error: unknownTableMessage(tableName, ctx) });
    return;
  }
  if (table.isView) {
    sendJson(res, 400, { error: `[turbine] "${tableName}" is a view; Studio cannot write to it.` });
    return;
  }

  const data = (body?.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
  const rawWhere = (body?.where && typeof body.where === 'object' ? body.where : {}) as Record<string, unknown>;

  // Validate every column name up front for a clean typed 400 (the builders
  // would also reject unknowns, but an explicit check keeps the message clear).
  if (op === 'insert' || op === 'update') {
    const badKey = firstUnknownColumn(table, data);
    if (badKey) {
      sendJson(res, 400, { error: `[turbine] unknown column "${badKey}" on table "${tableName}"` });
      return;
    }
    if (!Object.keys(data).some((k) => data[k] !== undefined)) {
      sendJson(res, 400, { error: '[turbine] `data` must include at least one column' });
      return;
    }
  }

  // update/delete: require the table to have a PK and the caller to cover it.
  let effectiveWhere = rawWhere;
  if (op === 'update' || op === 'delete') {
    if (table.primaryKey.length === 0) {
      sendJson(res, 400, {
        error: `[turbine] "${tableName}" has no primary key; single-row writes require one.`,
      });
      return;
    }
    const pk = extractPkWhere(table, rawWhere);
    if ('error' in pk) {
      sendJson(res, 400, { error: `[turbine] ${pk.error}` });
      return;
    }
    // Empty-where can never happen by construction (PK covered above); assert.
    if (Object.keys(pk.where).length === 0) {
      sendJson(res, 400, { error: '[turbine] refusing a write with an empty predicate' });
      return;
    }
    effectiveWhere = pk.where;
  }

  let deferred: { sql: string; params: unknown[] };
  try {
    const qi = new QueryInterface<Record<string, unknown>>(ctx.pool, tableName, ctx.metadata, [], {
      warnOnUnlimited: false,
      sqlCache: false,
      preparedStatements: false,
    });
    if (op === 'insert') {
      deferred = qi.buildCreate({ data } as CreateArgs<Record<string, unknown>>);
    } else if (op === 'update') {
      deferred = qi.buildUpdate({ where: effectiveWhere, data } as UpdateArgs<Record<string, unknown>>);
    } else {
      deferred = qi.buildDelete({ where: effectiveWhere } as DeleteArgs<Record<string, unknown>>);
    }
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }

  const client = await ctx.pool.connect();
  try {
    // A real write transaction, NOT `READ ONLY`. Same parameterized
    // statement-timeout + search_path pin as the read paths.
    await client.query('BEGIN');
    await client.query(ctx.statementTimeout.sql, ctx.statementTimeout.params);
    await client.query(`SELECT set_config('search_path', $1, true)`, [ctx.options.schema]);
    const result = await client.query(deferred.sql, deferred.params);
    await client.query('COMMIT');

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      const msg = op === 'insert' ? 'insert returned no row' : 'no row matched the primary key';
      sendJson(res, 404, { error: `[turbine] ${msg}` });
      return;
    }
    // The echoed row is redacted the same way as any read (unless --show-pii),
    // even though a write to a pii column is allowed.
    const piiKeys = ctx.showPii ? NO_PII_KEYS : piiKeysForTable(table);
    sendJson(res, 200, {
      operation: op,
      row: serializeRow(redactFlatRow(row, piiKeys)),
      rowCount: result.rowCount ?? 1,
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

/**
 * Return the first key in `obj` that does not resolve to a real column on
 * `table` (accepting either the camelCase field or snake_case column name), or
 * `null` when every key is valid. Skips `undefined` values.
 */
function firstUnknownColumn(table: TableMetadata, obj: Record<string, unknown>): string | null {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) continue;
    if (!resolveColumnName(table, k)) return k;
  }
  return null;
}

/**
 * Build a primary-key-only `where` from the caller's `where`. Every PK column
 * must be present (as its field or column name) with a scalar value; anything
 * else is rejected so a write can only ever target one row. Keys are emitted as
 * the camelCase field name (the query builder accepts field or column names).
 */
function extractPkWhere(
  table: TableMetadata,
  where: Record<string, unknown>,
): { where: Record<string, unknown> } | { error: string } {
  const resolved = new Map<string, unknown>();
  for (const [k, v] of Object.entries(where)) {
    const col = resolveColumnName(table, k);
    if (col) resolved.set(col, v);
  }
  const pkWhere: Record<string, unknown> = {};
  for (const pkCol of table.primaryKey) {
    if (!resolved.has(pkCol)) {
      return { error: `\`where\` must fully cover the primary key (missing "${pkCol}")` };
    }
    const v = resolved.get(pkCol);
    if (v === undefined || v === null || typeof v === 'object') {
      return { error: `primary key "${pkCol}" must be a scalar value in \`where\`` };
    }
    const field = table.reverseColumnMap[pkCol] ?? pkCol;
    pkWhere[field] = v;
  }
  return { where: pkWhere };
}

// ---------------------------------------------------------------------------
// API: /api/saved-queries — persisted per-table query library
// ---------------------------------------------------------------------------

interface SavedQuery {
  id: string;
  table: string;
  name: string;
  /** Studio only saves visual-builder queries — there is no raw-SQL surface. */
  kind: 'builder';
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

/** One-shot flag so the legacy saved-query notice isn't logged on every request. */
let legacyDropNoticeShown = false;

function loadSavedQueries(ctx: StudioContext): SavedQueriesFile {
  const file = savedQueriesPath(ctx);
  if (!existsSync(file)) return { version: 1, queries: [] };
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as SavedQueriesFile;
    if (!parsed.queries || !Array.isArray(parsed.queries)) return { version: 1, queries: [] };
    // Drop any legacy raw-SQL entries — Studio is builder-only now. Tell the
    // user instead of silently discarding their saved work (the file on disk
    // is only rewritten when a new query is saved, so this is recoverable).
    const queries = parsed.queries.filter((q) => q && q.kind === 'builder');
    const dropped = parsed.queries.length - queries.length;
    if (dropped > 0 && !legacyDropNoticeShown) {
      legacyDropNoticeShown = true;
      console.warn(
        `[turbine studio] Ignoring ${dropped} legacy raw-SQL saved quer${dropped === 1 ? 'y' : 'ies'} in ${file} — ` +
          'Studio is builder-only since v0.19. The entries remain in the file until a new query is saved.',
      );
    }
    return { version: 1, queries };
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

  if (!table || !ctx.metadata.tables[table]) {
    sendJson(res, 400, { error: unknownTableMessage(table, ctx) });
    return;
  }
  if (!name) {
    sendJson(res, 400, { error: 'name is required' });
    return;
  }
  // Studio only persists visual-builder queries (no raw SQL surface).
  if (body?.kind !== 'builder') {
    sendJson(res, 400, { error: 'kind must be "builder"' });
    return;
  }

  const data = loadSavedQueries(ctx);
  const entry: SavedQuery = {
    id: randomUUID(),
    table,
    name,
    kind: 'builder',
    args: body?.args,
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

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

/** The literal replacement value for a redacted PII cell. */
export const PII_REDACTED = '•• redacted ••';

/** Shared empty key set for the `--show-pii` fast path (no redaction). */
const NO_PII_KEYS: ReadonlySet<string> = new Set<string>();

/**
 * The set of keys (both snake_case column and camelCase field names) for the
 * table's PII-tagged columns. Covering both spellings means the same set works
 * for `SELECT *` rows (snake keys) and for json_build_object relation rows
 * (camel keys).
 */
function piiKeysForTable(table: TableMetadata): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const col of table.columns) {
    if (col.pii === true) {
      keys.add(col.name);
      keys.add(col.field);
    }
  }
  return keys;
}

/**
 * Redact PII keys in a single flat row. Returns the row unchanged when there is
 * nothing to redact (no allocation); otherwise a shallow copy with each present,
 * non-null PII value replaced by {@link PII_REDACTED}. A null/undefined value
 * carries no PII, so it is left as-is.
 */
function redactFlatRow(row: Record<string, unknown>, piiKeys: ReadonlySet<string>): Record<string, unknown> {
  if (piiKeys.size === 0) return row;
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(row)) {
    if (piiKeys.has(k) && row[k] !== null && row[k] !== undefined) {
      if (!out) out = { ...row };
      out[k] = PII_REDACTED;
    }
  }
  return out ?? row;
}

/**
 * Redact PII in builder result rows, walking the `with` tree so nested relation
 * rows are redacted against THEIR target table's PII columns (relation rows
 * arrive as parsed json objects keyed by camelCase field names).
 */
function redactBuilderRows(
  rows: Record<string, unknown>[],
  tableName: string,
  withClause: unknown,
  metadata: SchemaMetadata,
): Record<string, unknown>[] {
  const table = metadata.tables[tableName];
  if (!table) return rows;
  const piiKeys = piiKeysForTable(table);
  const relEntries =
    withClause && typeof withClause === 'object'
      ? Object.entries(withClause as Record<string, unknown>).filter(([, v]) => v)
      : [];
  // Nothing to do at this level or below → return as-is.
  if (piiKeys.size === 0 && relEntries.length === 0) return rows;

  return rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const k of piiKeys) {
      if (k in out && out[k] !== null && out[k] !== undefined) out[k] = PII_REDACTED;
    }
    for (const [relName, relVal] of relEntries) {
      const rel = table.relations[relName];
      if (!rel) continue;
      const nestedWith = relVal && typeof relVal === 'object' ? (relVal as { with?: unknown }).with : undefined;
      const child = out[relName];
      if (Array.isArray(child)) {
        out[relName] = redactBuilderRows(child as Record<string, unknown>[], rel.to, nestedWith, metadata);
      } else if (child && typeof child === 'object') {
        out[relName] = redactBuilderRows([child as Record<string, unknown>], rel.to, nestedWith, metadata)[0];
      }
    }
    return out;
  });
}

/**
 * A fresh CSP nonce for one HTML response. Base64 of 16 random bytes; the value
 * is stamped into both the `Content-Security-Policy` header and the inline
 * `<script nonce="...">` tag(s) so `unsafe-inline` can be dropped from script-src.
 */
function cspNonce(): string {
  return randomBytes(16).toString('base64');
}

function clampInt(value: string | null, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
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
    // JSON responses render no document; no inline script is needed, so keep
    // script-src to 'self' with no 'unsafe-inline'.
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'",
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

function sendHtml(res: ServerResponse, status: number, template: string, nonce: string): void {
  // Stamp the per-request nonce into the inline <script nonce="__CSP_NONCE__">
  // tag(s) so the CSP can use a nonce instead of 'unsafe-inline'.
  const body = template.replaceAll('__CSP_NONCE__', nonce);
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // style-src keeps 'unsafe-inline' (nonces don't cover style="" attributes,
    // which the UI relies on); script-src moves to the per-request nonce.
    'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'`,
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
