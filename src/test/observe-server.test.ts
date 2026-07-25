/**
 * Observe dashboard: perimeter tests.
 *
 * Drives the real `handleRequest` from cli/observe.ts DB-less (none of these
 * routes reaches the pool), the same way the Studio perimeter tests do. Covers
 * the three hardening changes: a per-request CSP nonce instead of a blanket
 * `script-src 'unsafe-inline'`, rate limiting (there was none at all), and the
 * anchored session-cookie match.
 */

import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { handleRequest, type ObserveOptions } from '../cli/observe.js';
import { OBSERVE_HTML } from '../cli/observe-ui.js';
import { checkRateLimit, RATE_LIMIT_MAX_REQUESTS } from '../cli/rate-limit.js';

const HOST = '127.0.0.1';
const PORT = 0;
const ORIGIN = `http://${HOST}:${PORT}`;
const TOKEN = 'a1b2c3d4e5f6';

const OPTIONS: ObserveOptions = { url: 'postgres://fake', port: PORT, host: HOST, openBrowser: false };

interface RecordedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: string;
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
      resolveDone({ status, headers, body: payload ?? '' });
    },
  } as unknown as ServerResponse;
  return { res, done };
}

function makeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method: 'GET', url, headers } as unknown as IncomingMessage;
}

const NO_POOL = {} as unknown as pg.Pool;

async function dispatch(
  url: string,
  headers: Record<string, string>,
  limiter: Map<string, { count: number; resetAt: number }>,
): Promise<RecordedResponse> {
  const { res, done } = makeRes();
  await handleRequest(makeReq(url, headers), res, NO_POOL, OPTIONS, TOKEN, limiter);
  return done;
}

describe('Observe: CSP', () => {
  it('serves the dashboard with a per-request nonce and no unsafe-inline script-src', async () => {
    const r = await dispatch('/', { origin: ORIGIN }, new Map());
    assert.equal(r.status, 200);
    const csp = String(r.headers['Content-Security-Policy']);
    const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    assert.ok(nonce, `nonce present in ${csp}`);
    assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'script-src drops unsafe-inline');
    assert.ok(r.body.includes(`<script nonce="${nonce}">`), 'the inline script carries the same nonce');
    assert.ok(!r.body.includes('__CSP_NONCE__'), 'the placeholder is fully stamped');
  });

  it('issues a different nonce on every response', async () => {
    const a = await dispatch('/', { origin: ORIGIN }, new Map());
    const b = await dispatch('/', { origin: ORIGIN }, new Map());
    assert.notEqual(a.headers['Content-Security-Policy'], b.headers['Content-Security-Policy']);
  });

  it('sends a script-inline-free CSP on JSON responses', async () => {
    const r = await dispatch('/api/latency', { origin: ORIGIN }, new Map());
    assert.equal(r.status, 401);
    assert.ok(!String(r.headers['Content-Security-Policy']).includes('unsafe-inline; '));
    assert.match(String(r.headers['Content-Security-Policy']), /script-src 'self'/);
  });
});

describe('Observe: rate limiting', () => {
  it('throttles unauthenticated requests', async () => {
    const limiter = new Map<string, { count: number; resetAt: number }>();
    let last = 0;
    for (let i = 0; i < 101; i++) {
      last = (await dispatch('/api/latency', { origin: ORIGIN }, limiter)).status;
      if (i < 100) assert.equal(last, 401, `request ${i} should still be a plain 401`);
    }
    assert.equal(last, 429);
  });

  // The limiter moved out of cli/studio.ts into the leaf cli/rate-limit.ts so
  // Observe no longer statically imports Studio's embedded UI, demo store, PII
  // redaction and QueryInterface. The shared code is the counter only: each
  // server still owns its own state map, so one cannot spend the other's budget.
  it('keeps each server on its own bucket state (shared code, not shared state)', async () => {
    const observeLimiter = new Map<string, { count: number; resetAt: number }>();
    const otherServerLimiter = new Map<string, { count: number; resetAt: number }>();

    for (let i = 0; i < 101; i++) checkRateLimit(otherServerLimiter, 'anon:unknown');
    assert.equal(checkRateLimit(otherServerLimiter, 'anon:unknown').allowed, false, 'the other map is exhausted');

    const r = await dispatch('/api/latency', { origin: ORIGIN }, observeLimiter);
    assert.equal(r.status, 401, 'observe is untouched by the other server exhausting its own map');
  });

  it('counts a fixed window of RATE_LIMIT_MAX_REQUESTS before refusing', () => {
    const limiter = new Map<string, { count: number; resetAt: number }>();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      assert.equal(checkRateLimit(limiter, 'k').allowed, true, `request ${i} allowed`);
    }
    const refused = checkRateLimit(limiter, 'k');
    assert.equal(refused.allowed, false);
    assert.ok(refused.resetAt > Date.now(), 'resetAt is in the future');
    assert.equal(checkRateLimit(limiter, 'other-key').allowed, true, 'a different bucket is independent');
  });
});

describe('Observe: cookie auth', () => {
  it('finds the real token past a decoy cookie with the same suffix', async () => {
    // 401 would mean the decoy shadowed it; any other status means the request
    // got past the auth gate (this route then reaches the pool, which is absent).
    const r = await dispatch(
      '/nope',
      { origin: ORIGIN, cookie: `x_turbine_observe_token=deadbeef; turbine_observe_token=${TOKEN}` },
      new Map(),
    );
    assert.equal(r.status, 404, 'authorized, so it falls through to the not-found route');
  });

  it('still rejects a decoy cookie on its own', async () => {
    const r = await dispatch('/nope', { origin: ORIGIN, cookie: 'x_turbine_observe_token=deadbeef' }, new Map());
    assert.equal(r.status, 401);
  });
});

describe('Observe: UI escaping', () => {
  it('coerces the count sinks instead of interpolating them raw', () => {
    assert.ok(OBSERVE_HTML.includes('num(row.count)'), 'count goes through the numeric coercion');
    assert.ok(OBSERVE_HTML.includes('num(row.error_count)'), 'error_count goes through the numeric coercion');
    assert.ok(!/\+ row\.count \+/.test(OBSERVE_HTML), 'no raw count interpolation left');
    assert.ok(!/\+ row\.error_count \+/.test(OBSERVE_HTML), 'no raw error_count interpolation left');
  });
});
