/**
 * turbine-orm CLI — Observe
 *
 * A local, read-only dashboard for viewing query metrics stored in
 * _turbine_metrics. Same security model as Studio: loopback binding,
 * random token, HttpOnly cookie, CSP headers, read-only transactions.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pg from 'pg';
import { OBSERVE_HTML } from './observe-ui.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObserveOptions {
  url: string;
  port: number;
  host: string;
  openBrowser: boolean;
}

export interface ObserveServerHandle {
  dispose: () => Promise<void>;
  authToken: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function startObserve(options: ObserveOptions): Promise<ObserveServerHandle> {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: 2,
    idleTimeoutMillis: 10_000,
  });

  const probe = await pool.connect();
  try {
    await probe.query('SELECT 1');
  } finally {
    probe.release();
  }

  const authToken = randomBytes(24).toString('hex');

  const server = createServer((req, res) => {
    handleRequest(req, res, pool, options, authToken).catch((err) => {
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

  const hostPart = options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host;
  const url = `http://${hostPart}:${options.port}/?token=${authToken}`;

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

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pool: pg.Pool,
  options: ObserveOptions,
  authToken: string,
): Promise<void> {
  const hostPart = options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host;
  const expectedOrigin = `http://${hostPart}:${options.port}`;

  const origin = req.headers.origin;
  if (origin && origin !== expectedOrigin) {
    sendJson(res, 403, { error: 'cross-origin requests not allowed' });
    return;
  }

  const url = new URL(req.url ?? '/', expectedOrigin);
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }
    const queryToken = url.searchParams.get('token');
    if (queryToken && constantTimeEqual(queryToken, authToken)) {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': `turbine_observe_token=${authToken}; Path=/; HttpOnly; SameSite=Strict`,
      });
      res.end();
      return;
    }
    sendHtml(res, 200, OBSERVE_HTML);
    return;
  }

  if (!isAuthorized(req, authToken)) {
    sendJson(res, 401, { error: 'unauthorized' });
    return;
  }

  if (pathname === '/api/latency' && req.method === 'GET') {
    return apiLatency(res, pool, url.searchParams);
  }

  if (pathname === '/api/models' && req.method === 'GET') {
    return apiModels(res, pool, url.searchParams);
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
  const match = /turbine_observe_token=([a-f0-9]+)/.exec(cookieHeader);
  if (match?.[1] && constantTimeEqual(match[1], expectedToken)) {
    return true;
  }
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Hash both inputs to fixed-length 32-byte SHA-256 digests before comparing.
  // This makes the comparison constant-length (timingSafeEqual never throws on a
  // length mismatch) and leaks neither length nor content via timing.
  const ah = createHash('sha256').update(a).digest();
  const bh = createHash('sha256').update(b).digest();
  return timingSafeEqual(ah, bh);
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------

function rangeToInterval(range: string): string {
  switch (range) {
    case '6h':
      return '6 hours';
    case '24h':
      return '24 hours';
    case '7d':
      return '7 days';
    default:
      return '1 hour';
  }
}

async function apiLatency(res: ServerResponse, pool: pg.Pool, params: URLSearchParams): Promise<void> {
  const range = params.get('range') ?? '1h';
  const interval = rangeToInterval(range);

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const result = await client.query(
      `SELECT bucket, SUM(count) as count,
              SUM(avg_ms * count) / NULLIF(SUM(count), 0) as avg_ms,
              MAX(p95_ms) as p95_ms,
              MAX(p99_ms) as p99_ms
       FROM _turbine_metrics
       WHERE bucket >= NOW() - $1::interval
       GROUP BY bucket
       ORDER BY bucket`,
      [interval],
    );
    await client.query('COMMIT');
    sendJson(res, 200, result.rows);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.release();
  }
}

async function apiModels(res: ServerResponse, pool: pg.Pool, params: URLSearchParams): Promise<void> {
  const range = params.get('range') ?? '1h';
  const interval = rangeToInterval(range);

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '30s'`);
    const result = await client.query(
      `SELECT model, action,
              SUM(count)::int as count,
              SUM(avg_ms * count) / NULLIF(SUM(count), 0) as avg_ms,
              MAX(p95_ms) as p95_ms,
              MAX(p99_ms) as p99_ms,
              SUM(error_count)::int as error_count
       FROM _turbine_metrics
       WHERE bucket >= NOW() - $1::interval
       GROUP BY model, action
       ORDER BY MAX(p95_ms) DESC
       LIMIT 50`,
      [interval],
    );
    await client.query('COMMIT');
    sendJson(res, 200, result.rows);
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {}
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json' });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Browser open
// ---------------------------------------------------------------------------

function openUrl(url: string): void {
  const { platform: os } = process;
  const { spawn } = require('node:child_process') as typeof import('node:child_process');
  try {
    if (os === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    else if (os === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // Best effort
  }
}
