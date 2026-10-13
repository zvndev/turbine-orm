/**
 * turbine-orm CLI: Observe
 *
 * A local, read-only dashboard for viewing query metrics stored in
 * _turbine_metrics. Same security model as Studio: loopback binding,
 * random token, HttpOnly cookie, CSP headers, read-only transactions.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import pg from 'pg';
import { absorbCheckedOutErrors } from '../connection-guard.js';
import type { PgCompatPool } from '../pg-types.js';
import {
  constantTimeEqual,
  createTicketGate,
  isAllowedHostHeader,
  redeemTicket,
  type TicketGate,
} from './local-server-guard.js';
import { OBSERVE_HTML } from './observe-ui.js';
import { callerKey, checkRateLimit } from './rate-limit.js';
import { redactUrl } from './ui.js';

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
  /** The session credential (header or cookie). Never part of `url`. */
  authToken: string;
  /** Printable URL carrying a ONE-TIME login ticket, exchanged for the session cookie on first load. */
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
  // Idle-client errors surface on the pool, checked-out ones on the client;
  // with no listener either one exits the dashboard (see connection-guard.ts).
  pool.on('error', (err) => {
    console.error(`[turbine] observe pool error: ${redactUrl(err.message)}`);
  });
  absorbCheckedOutErrors(pool);

  const authToken = randomBytes(24).toString('hex');
  const ticketGate = createTicketGate();
  const rateLimiter = new Map<string, { count: number; resetAt: number }>();

  const server = createServer((req, res) => {
    handleRequest(req, res, pool, options, authToken, rateLimiter, ticketGate).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  try {
    const probe = await pool.connect();
    try {
      await probe.query('SELECT 1');
    } finally {
      probe.release();
    }

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, options.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    // A start that fails (probe refused, port taken) must not leave the probe
    // connection idling in a pool nobody holds: it would keep a database session
    // open and the process alive until the idle timeout.
    await pool.end().catch(() => {});
    throw err;
  }

  const hostPart = options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host;
  const url = `http://${hostPart}:${options.port}/?token=${ticketGate.token}`;

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

export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pool: PgCompatPool,
  options: ObserveOptions,
  authToken: string,
  rateLimiter: Map<string, { count: number; resetAt: number }>,
  /** The one-time login ticket. Absent on a hand-built call: the ticket is then `authToken` itself. */
  ticketGate: TicketGate = gateFor(authToken),
): Promise<void> {
  const hostPart = options.host.includes(':') && !options.host.startsWith('[') ? `[${options.host}]` : options.host;
  const expectedOrigin = `http://${hostPart}:${options.port}`;

  // DNS rebinding: a page on another domain that re-resolves to this port still
  // sends its own hostname in `Host`. Checked before any route or token logic.
  if (!isAllowedHostHeader(req.headers.host, options.host, options.port)) {
    sendJson(res, 403, { error: 'host not allowed: open Observe at the address printed in the terminal' });
    return;
  }

  const origin = req.headers.origin;
  if (origin && origin !== expectedOrigin) {
    sendJson(res, 403, { error: 'cross-origin requests not allowed' });
    return;
  }

  // A request target that is not a URL (`GET //`) is a client error, not a 500.
  let url: URL;
  try {
    url = new URL(req.url ?? '/', expectedOrigin);
  } catch {
    sendJson(res, 400, { error: 'malformed request target' });
    return;
  }
  const pathname = url.pathname;

  if (pathname === '/' || pathname === '/index.html') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(res, 405, 'Method Not Allowed');
      return;
    }
    const queryToken = url.searchParams.get('token');
    if (queryToken) {
      // The printed URL's token is a ONE-TIME ticket, exchanged here for the
      // session cookie by the first GET that carries it. HEAD never spends it.
      const outcome = req.method === 'GET' ? redeemTicket(ticketGate, queryToken) : 'invalid';
      if (outcome === 'granted') {
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `turbine_observe_token=${authToken}; Path=/; HttpOnly; SameSite=Strict`,
        });
        res.end();
        return;
      }
      if (outcome === 'used') {
        if (isAuthorized(req, authToken)) {
          res.writeHead(302, { Location: '/' });
          res.end();
        } else {
          sendText(res, 403, 'This login link was already used. Restart Observe to get a new one.');
        }
        return;
      }
    }
    sendHtml(res, 200, OBSERVE_HTML, cspNonce());
    return;
  }

  // Rate limiting: the same fixed window as Studio (shared implementation), applied
  // before the auth gate so unauthenticated probing is throttled too, and keyed
  // per caller so the two never share a bucket.
  const authorized = isAuthorized(req, authToken);
  const rateLimitResult = checkRateLimit(rateLimiter, `${authorized ? 'session' : 'anon'}:${callerKey(req)}`);
  if (!rateLimitResult.allowed) {
    const retryAfter = Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    sendJson(res, 429, { error: 'Rate limit exceeded', retryAfter });
    return;
  }

  if (!authorized) {
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
  // Anchored on a cookie boundary: unanchored, a decoy cookie whose name merely
  // ENDS with this one (`x_turbine_observe_token=...`) matched first and the real
  // token was never compared, denying the legitimate session.
  const match = /(?:^|;\s*)turbine_observe_token=([a-f0-9]+)/.exec(cookieHeader);
  if (match?.[1] && constantTimeEqual(match[1], expectedToken)) {
    return true;
  }
  return false;
}

/**
 * The ticket for a caller that passed none (a hand-built dispatch): `authToken`
 * itself, remembered per token so it is still spent exactly once.
 */
const FALLBACK_GATES = new Map<string, TicketGate>();
function gateFor(authToken: string): TicketGate {
  let gate = FALLBACK_GATES.get(authToken);
  if (!gate) {
    gate = createTicketGate(authToken);
    FALLBACK_GATES.set(authToken, gate);
  }
  return gate;
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

async function apiLatency(res: ServerResponse, pool: PgCompatPool, params: URLSearchParams): Promise<void> {
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
    } catch {
      // Deliberately swallowed, and only this one. `err` above is the failure
      // worth reporting and it is what the 500 below carries; a ROLLBACK that
      // also fails means the connection is already gone, which node-postgres
      // handles by discarding the client on the release() in `finally`.
      // Surfacing it instead would replace a real diagnosis ("statement
      // timeout", "relation does not exist") with "connection terminated", and
      // this server writes no log of its own, so the HTTP response is the only
      // channel either error could reach. Same shape as cli/studio.ts.
    }
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  } finally {
    client.release();
  }
}

async function apiModels(res: ServerResponse, pool: PgCompatPool, params: URLSearchParams): Promise<void> {
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
    } catch {
      // Deliberately swallowed, and only this one. `err` above is the failure
      // worth reporting and it is what the 500 below carries; a ROLLBACK that
      // also fails means the connection is already gone, which node-postgres
      // handles by discarding the client on the release() in `finally`.
      // Surfacing it instead would replace a real diagnosis ("statement
      // timeout", "relation does not exist") with "connection terminated", and
      // this server writes no log of its own, so the HTTP response is the only
      // channel either error could reach. Same shape as cli/studio.ts.
    }
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
};

/**
 * A fresh CSP nonce for one HTML response, matching Studio's posture: the value
 * is stamped into both the header and the inline `<script nonce="...">` tag so
 * script-src drops `unsafe-inline`.
 */
function cspNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Non-document responses render no markup, so no inline script is allowed at all. */
const JSON_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Security-Policy': JSON_CSP,
    'Content-Type': 'application/json',
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string, nonce: string): void {
  const body = html.replaceAll('__CSP_NONCE__', nonce);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    // style-src keeps 'unsafe-inline' (the dashboard styles inline, and nonces
    // do not cover style attributes); script-src moves to the per-request nonce.
    'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'`,
    'Content-Type': 'text/html; charset=utf-8',
  });
  res.end(body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Security-Policy': JSON_CSP, 'Content-Type': 'text/plain' });
  res.end(text);
}

// ---------------------------------------------------------------------------
// Browser open
// ---------------------------------------------------------------------------

function openUrl(url: string): void {
  const { platform: os } = process;
  const [command, args]: [string, string[]] =
    os === 'darwin' ? ['open', [url]] : os === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // A launcher that is not installed (no xdg-open on a headless machine) is
    // reported as an 'error' EVENT, not a throw; with no listener Node turns it
    // into an uncaught exception and the dashboard dies right after printing its URL.
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best effort
  }
}
