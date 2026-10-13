/**
 * Observe dashboard (cli/observe.ts): the request handler and the server around it.
 *
 * Three layers, cheapest first:
 *
 *  1. `handleRequest` driven with fake request/response objects and a recording
 *     fake pool. No database. Covers every route's response shape, the exact
 *     statements each route runs (read-only transaction, transaction-local
 *     timeout, bound interval), the perimeter checks in the order they fire, and
 *     the error paths.
 *  2. `startObserve` against a fake Postgres wire server (a TCP listener that
 *     speaks just enough of the protocol to answer `SELECT 1`). No database
 *     either: it exercises the real `pg.Pool`, the real HTTP server, the printed
 *     URL, dispose, the browser launcher and the failure paths around start-up.
 *  3. A live Postgres, gated on DATABASE_URL, for what only a real server can
 *     prove: the aggregates the queries compute, and that the connection really
 *     is read-only inside the request and unchanged outside it.
 *
 * Run: npx tsx --test src/test/observe-cli.test.ts
 */

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import net, { type AddressInfo } from 'node:net';
import { describe, it, mock } from 'node:test';
import pg from 'pg';
import { createTicketGate } from '../cli/local-server-guard.js';
import { handleRequest, type ObserveOptions, startObserve } from '../cli/observe.js';
import { OBSERVE_HTML } from '../cli/observe-ui.js';
import { RATE_LIMIT_MAX_REQUESTS } from '../cli/rate-limit.js';
import { PgMetricsSink } from '../observe.js';
import type { PgCompatPool, PgCompatPoolClient, PgCompatQueryResult } from '../pg-types.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Fake request / response plumbing
// ---------------------------------------------------------------------------

// Every `assert.ok` below carries an explicit message on purpose. Without one,
// Node builds the failure text by re-parsing the test's source around the failing
// line, which under tsx lands on the wrong spot in a file this size and spins
// until the file times out: a regression then shows up as a timeout, not a failure.

const HOST = '127.0.0.1';
const PORT = 4984;
const ORIGIN = `http://${HOST}:${PORT}`;
const TOKEN = 'abcdef0123456789abcdef0123456789abcdef0123456789';
const OPTIONS: ObserveOptions = { url: 'postgres://fake', port: PORT, host: HOST, openBrowser: false };
const JSON_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";

type Limiter = Map<string, { count: number; resetAt: number }>;

interface Recorded {
  status: number;
  headers: Record<string, string | number>;
  body: string;
  json: unknown;
}

function makeRes(): { res: http.ServerResponse; done: Promise<Recorded> } {
  let resolveDone!: (r: Recorded) => void;
  const done = new Promise<Recorded>((r) => {
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
  } as unknown as http.ServerResponse;
  return { res, done };
}

interface ReqInit {
  method?: string;
  headers?: Record<string, string>;
  remote?: string;
}

function makeReq(url: string | undefined, init: ReqInit = {}): http.IncomingMessage {
  return {
    method: init.method ?? 'GET',
    url,
    headers: { host: `${HOST}:${PORT}`, ...(init.headers ?? {}) },
    socket: init.remote ? { remoteAddress: init.remote } : undefined,
  } as unknown as http.IncomingMessage;
}

// ---------------------------------------------------------------------------
// A recording fake pool
// ---------------------------------------------------------------------------

interface Statement {
  sql: string;
  params: unknown[] | undefined;
}

interface FakePoolInit {
  /** Rows returned for the data SELECT. */
  rows?: unknown[];
  /** A statement-prefix to the value thrown when a statement starts with it. */
  failOn?: Record<string, unknown>;
  /** Make `pool.connect()` itself reject. */
  connectError?: Error;
}

class FakePool implements PgCompatPool {
  readonly statements: Statement[] = [];
  connects = 0;
  releases = 0;
  readonly releaseArgs: unknown[] = [];
  constructor(private readonly init: FakePoolInit = {}) {}

  async query<R>(): Promise<PgCompatQueryResult<R>> {
    throw new Error('the dashboard never queries the pool directly');
  }

  async connect(): Promise<PgCompatPoolClient> {
    if (this.init.connectError) throw this.init.connectError;
    this.connects++;
    return {
      query: async <R>(sql: string, params?: unknown[]): Promise<PgCompatQueryResult<R>> => {
        this.statements.push({ sql, params });
        for (const [prefix, thrown] of Object.entries(this.init.failOn ?? {})) {
          if (sql.startsWith(prefix)) throw thrown;
        }
        const rows = sql.startsWith('SELECT') ? (this.init.rows ?? []) : [];
        return { rows: rows as R[], rowCount: rows.length };
      },
      release: (arg?: Error | boolean) => {
        this.releases++;
        this.releaseArgs.push(arg);
      },
    };
  }

  async end(): Promise<void> {}

  get sql(): string[] {
    return this.statements.map((s) => s.sql);
  }
}

interface DispatchInit extends ReqInit {
  pool?: PgCompatPool;
  limiter?: Limiter;
  options?: ObserveOptions;
  gate?: ReturnType<typeof createTicketGate>;
}

async function dispatch(url: string | undefined, init: DispatchInit = {}): Promise<Recorded> {
  const { res, done } = makeRes();
  await handleRequest(
    makeReq(url, init),
    res,
    init.pool ?? new FakePool(),
    init.options ?? OPTIONS,
    TOKEN,
    init.limiter ?? new Map(),
    init.gate,
  );
  return done;
}

const AUTH = { 'x-turbine-token': TOKEN };

/** Every statement a route may send. A write, a DDL statement or a session-level SET is not in the list. */
function assertReadOnlyVocabulary(statements: string[]): void {
  assert.equal(statements[0], 'BEGIN READ ONLY', 'the first statement opens a read-only transaction');
  for (const sql of statements) {
    const allowed =
      sql === 'BEGIN READ ONLY' ||
      sql === "SET LOCAL statement_timeout = '30s'" ||
      sql.startsWith('SELECT ') ||
      sql === 'COMMIT' ||
      sql === 'ROLLBACK';
    assert.ok(allowed, `unexpected statement: ${sql}`);
    assert.ok(!/^\s*SET\s+(?!LOCAL)/i.test(sql), `session-level SET: ${sql}`);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|TRUNCATE)\b/i.test(sql.replace(/'[^']*'/g, '')), sql);
  }
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

describe('Observe CLI: /api/latency', () => {
  const ROWS = [
    { bucket: '2026-01-01T00:00:00.000Z', count: '40', avg_ms: 3.5, p95_ms: 9, p99_ms: 12 },
    { bucket: '2026-01-01T00:01:00.000Z', count: '30', avg_ms: 4, p95_ms: 7, p99_ms: 10 },
  ];

  it('answers 200 with the rows as JSON and the hardened headers', async () => {
    const pool = new FakePool({ rows: ROWS });
    const r = await dispatch('/api/latency', { headers: AUTH, pool });

    assert.equal(r.status, 200);
    assert.deepEqual(r.json, ROWS);
    assert.equal(r.headers['Content-Type'], 'application/json');
    assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(r.headers['X-Frame-Options'], 'DENY');
    assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
    assert.equal(r.headers['Content-Security-Policy'], JSON_CSP);
  });

  it('runs one read-only transaction with a transaction-local timeout and a bound interval', async () => {
    const pool = new FakePool({ rows: ROWS });
    await dispatch('/api/latency?range=6h', { headers: AUTH, pool });

    assert.equal(pool.sql.length, 4);
    assert.equal(pool.sql[0], 'BEGIN READ ONLY');
    assert.equal(pool.sql[1], "SET LOCAL statement_timeout = '30s'");
    assert.match(String(pool.sql[2]), /^SELECT bucket/);
    assert.equal(pool.sql[3], 'COMMIT');

    const select = pool.statements[2]!;
    assert.deepEqual(select.params, ['6 hours'], 'the interval is a bound parameter');
    assert.match(select.sql, /FROM _turbine_metrics/);
    assert.match(select.sql, /\$1::interval/);
    assert.match(select.sql, /GROUP BY bucket\b/);
    assert.match(select.sql, /ORDER BY bucket\b/);
    assert.ok(!select.sql.includes('6 hours'), 'the interval is not interpolated into the text');
    assertReadOnlyVocabulary(pool.sql);
  });

  it('returns the connection to the pool exactly once, with no error argument', async () => {
    const pool = new FakePool({ rows: ROWS });
    await dispatch('/api/latency', { headers: AUTH, pool });
    assert.equal(pool.connects, 1);
    assert.equal(pool.releases, 1);
    assert.deepEqual(pool.releaseArgs, [undefined]);
  });
});

describe('Observe CLI: /api/models', () => {
  const ROWS = [
    { model: 'users', action: 'findMany', count: 40, avg_ms: 3.5, p95_ms: 9, p99_ms: 12, error_count: 1 },
    { model: 'posts', action: 'create', count: 30, avg_ms: 4, p95_ms: 7, p99_ms: 10, error_count: 0 },
  ];

  it('answers 200 with the rows as JSON and the hardened headers', async () => {
    const pool = new FakePool({ rows: ROWS });
    const r = await dispatch('/api/models', { headers: AUTH, pool });

    assert.equal(r.status, 200);
    assert.deepEqual(r.json, ROWS);
    assert.equal(r.headers['Content-Type'], 'application/json');
    assert.equal(r.headers['Content-Security-Policy'], JSON_CSP);
  });

  it('runs one read-only transaction, grouped by model and action, capped at 50 rows', async () => {
    const pool = new FakePool({ rows: ROWS });
    await dispatch('/api/models?range=24h', { headers: AUTH, pool });

    assert.deepEqual(pool.sql.slice(0, 2), ['BEGIN READ ONLY', "SET LOCAL statement_timeout = '30s'"]);
    assert.equal(pool.sql[3], 'COMMIT');
    const select = pool.statements[2]!;
    assert.deepEqual(select.params, ['24 hours']);
    assert.match(select.sql, /^SELECT model, action/);
    assert.match(select.sql, /GROUP BY model, action\b/);
    assert.match(select.sql, /ORDER BY MAX\(p95_ms\) DESC\b/);
    assert.match(select.sql, /LIMIT 50\b/);
    assertReadOnlyVocabulary(pool.sql);
    assert.equal(pool.releases, 1);
  });
});

describe('Observe CLI: the range parameter', () => {
  const CASES: Array<[string | null, string]> = [
    [null, '1 hour'],
    ['1h', '1 hour'],
    ['6h', '6 hours'],
    ['24h', '24 hours'],
    ['7d', '7 days'],
    ['', '1 hour'],
    ['30d', '1 hour'],
    ['1H', '1 hour'],
    ['6 hours', '1 hour'],
    ["1h'; DROP TABLE _turbine_metrics; --", '1 hour'],
  ];

  for (const route of ['/api/latency', '/api/models']) {
    for (const [range, interval] of CASES) {
      it(`${route}?range=${range === null ? '(absent)' : JSON.stringify(range)} binds ${JSON.stringify(interval)}`, async () => {
        const pool = new FakePool();
        const path = range === null ? route : `${route}?range=${encodeURIComponent(range)}`;
        const r = await dispatch(path, { headers: AUTH, pool });
        assert.equal(r.status, 200);
        assert.deepEqual(pool.statements[2]?.params, [interval]);
        assertReadOnlyVocabulary(pool.sql);
      });
    }
  }
});

describe('Observe CLI: routing', () => {
  it('answers an unknown path, a wrong method and a near-miss path with 404 and opens no connection', async () => {
    for (const [method, url] of [
      ['GET', '/api/unknown'],
      ['GET', '/api'],
      ['GET', '/api/latency/'],
      ['GET', '/api/models/extra'],
      ['POST', '/api/latency'],
      ['PUT', '/api/models'],
      ['DELETE', '/api/models'],
      ['GET', '/nope'],
    ] as const) {
      const pool = new FakePool();
      const r = await dispatch(url, { method, headers: AUTH, pool });
      assert.equal(r.status, 404, `${method} ${url}`);
      assert.deepEqual(r.json, { error: 'not found' });
      assert.equal(pool.connects, 0, `${method} ${url} must not touch the database`);
    }
  });

  it('treats a request with no URL as the dashboard page', async () => {
    const r = await dispatch(undefined);
    assert.equal(r.status, 200);
    assert.match(r.body, /<!doctype html>/i);
  });

  it('never reads a request body, so there is no size to cap', async () => {
    const touched = new Set<string | symbol>();
    const base = makeReq('/api/latency', {
      method: 'POST',
      headers: { ...AUTH, 'content-length': String(64 * 1024 * 1024) },
    });
    const req = new Proxy(base, {
      get(target, prop) {
        touched.add(prop);
        return Reflect.get(target, prop);
      },
    });
    const { res, done } = makeRes();
    await handleRequest(req, res, new FakePool(), OPTIONS, TOKEN, new Map());
    assert.equal((await done).status, 404);
    const allowed = new Set<string | symbol>(['method', 'url', 'headers', 'socket']);
    const extra = [...touched].filter((p) => !allowed.has(p));
    assert.deepEqual(extra, [], 'only the request line, headers and peer address are inspected');
  });

  it('answers a request target that is not a URL with 400, before authentication and without the database', async () => {
    for (const target of ['//', 'http://']) {
      const pool = new FakePool();
      const r = await dispatch(target, { pool });
      assert.equal(r.status, 400, target);
      assert.deepEqual(r.json, { error: 'malformed request target' });
      assert.equal(pool.connects, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// The dashboard page and the one-time login
// ---------------------------------------------------------------------------

describe('Observe CLI: the page', () => {
  it('serves the dashboard at / and /index.html with a nonce and no session credential in it', async () => {
    for (const path of ['/', '/index.html']) {
      const r = await dispatch(path);
      assert.equal(r.status, 200, path);
      assert.equal(r.headers['Content-Type'], 'text/html; charset=utf-8');
      assert.equal(r.headers['X-Frame-Options'], 'DENY');
      assert.equal(r.headers['X-Content-Type-Options'], 'nosniff');
      assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
      const csp = String(r.headers['Content-Security-Policy']);
      const nonce = /script-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce, `nonce in ${csp}`);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /connect-src 'self'/);
      assert.ok(r.body.includes(`<script nonce="${nonce}">`), 'the inline script carries the nonce');
      assert.ok(!r.body.includes(TOKEN), 'the page never embeds the session credential');
      assert.equal(r.body, OBSERVE_HTML.replaceAll('__CSP_NONCE__', nonce));
    }
  });

  it('refuses any method but GET and HEAD with 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of ['/', '/index.html']) {
        const r = await dispatch(path, { method });
        assert.equal(r.status, 405, `${method} ${path}`);
        assert.equal(r.body, 'Method Not Allowed');
        assert.equal(r.headers['Content-Type'], 'text/plain');
        assert.equal(r.headers['Content-Security-Policy'], JSON_CSP);
      }
    }
  });

  it('serves a HEAD for the page', async () => {
    assert.equal((await dispatch('/', { method: 'HEAD' })).status, 200);
  });
});

describe('Observe CLI: the one-time login ticket', () => {
  it('trades the ticket for a session cookie that then authenticates the API', async () => {
    const gate = createTicketGate();
    const pool = new FakePool({ rows: [] });
    const first = await dispatch(`/?token=${gate.token}`, { gate });

    assert.equal(first.status, 302);
    assert.equal(first.headers.Location, '/');
    assert.equal(first.headers['Set-Cookie'], `turbine_observe_token=${TOKEN}; Path=/; HttpOnly; SameSite=Strict`);
    assert.equal(first.body, '');

    const cookie = String(first.headers['Set-Cookie']).split(';')[0]!;
    const api = await dispatch('/api/latency', { headers: { cookie }, pool, gate });
    assert.equal(api.status, 200, 'the cookie the exchange set is accepted');
  });

  it('refuses a replayed ticket with 403 and no cookie', async () => {
    const gate = createTicketGate();
    await dispatch(`/?token=${gate.token}`, { gate });
    const replay = await dispatch(`/?token=${gate.token}`, { gate });

    assert.equal(replay.status, 403);
    assert.equal(replay.body, 'This login link was already used. Restart Observe to get a new one.');
    assert.equal(replay.headers['Set-Cookie'], undefined);
    assert.equal(replay.headers['Content-Type'], 'text/plain');
  });

  it('redirects a replayed ticket to the page when the caller already holds the session', async () => {
    const gate = createTicketGate();
    await dispatch(`/?token=${gate.token}`, { gate });

    const viaCookie = await dispatch(`/?token=${gate.token}`, {
      gate,
      headers: { cookie: `turbine_observe_token=${TOKEN}` },
    });
    assert.equal(viaCookie.status, 302);
    assert.equal(viaCookie.headers.Location, '/');
    assert.equal(viaCookie.headers['Set-Cookie'], undefined, 'a session is not re-issued');

    const viaHeader = await dispatch(`/?token=${gate.token}`, { gate, headers: AUTH });
    assert.equal(viaHeader.status, 302);
  });

  it('serves the page for a wrong ticket and leaves the real one unspent', async () => {
    const gate = createTicketGate();
    const wrong = await dispatch('/?token=not-the-ticket', { gate });
    assert.equal(wrong.status, 200);
    assert.equal(wrong.headers['Set-Cookie'], undefined);
    assert.equal(gate.used, false, 'a wrong guess does not spend the ticket');

    const empty = await dispatch('/?token=', { gate });
    assert.equal(empty.status, 200);
    assert.equal(gate.used, false);

    assert.equal((await dispatch(`/?token=${gate.token}`, { gate })).status, 302, 'the real ticket still works');
  });

  it('does not let a HEAD request spend the ticket', async () => {
    const gate = createTicketGate();
    const head = await dispatch(`/?token=${gate.token}`, { gate, method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers['Set-Cookie'], undefined);
    assert.equal(gate.used, false);
    assert.equal((await dispatch(`/?token=${gate.token}`, { gate })).status, 302);
  });

  it('does not accept the ticket as an API credential', async () => {
    const gate = createTicketGate();
    const pool = new FakePool();
    const r = await dispatch('/api/latency', { gate, pool, headers: { 'x-turbine-token': gate.token } });
    assert.equal(r.status, 401);
    assert.equal(pool.connects, 0);
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('Observe CLI: credentials', () => {
  const ACCEPTED: Array<[string, Record<string, string>]> = [
    ['the token header', { 'x-turbine-token': TOKEN }],
    ['the session cookie', { cookie: `turbine_observe_token=${TOKEN}` }],
    ['the cookie among others', { cookie: `theme=dark; turbine_observe_token=${TOKEN}; lang=en` }],
    [
      'the cookie after a same-suffix decoy',
      { cookie: `x_turbine_observe_token=deadbeef; turbine_observe_token=${TOKEN}` },
    ],
    ['a right cookie behind a wrong header', { 'x-turbine-token': 'wrong', cookie: `turbine_observe_token=${TOKEN}` }],
  ];
  const REFUSED: Array<[string, Record<string, string>]> = [
    ['no credential', {}],
    ['a wrong header', { 'x-turbine-token': 'wrong' }],
    ['an empty header', { 'x-turbine-token': '' }],
    ['a header that is the token plus a suffix', { 'x-turbine-token': `${TOKEN}0` }],
    ['a header that is a prefix of the token', { 'x-turbine-token': TOKEN.slice(0, -1) }],
    ['a wrong cookie', { cookie: 'turbine_observe_token=deadbeef' }],
    ['a cookie that is a prefix of the token', { cookie: `turbine_observe_token=${TOKEN.slice(0, -1)}` }],
    ['an empty cookie value', { cookie: 'turbine_observe_token=' }],
    ['a decoy cookie that only ends with the right name', { cookie: `x_turbine_observe_token=${TOKEN}` }],
    ['an unrelated cookie', { cookie: 'session=abc' }],
  ];

  for (const [label, headers] of ACCEPTED) {
    it(`accepts ${label}`, async () => {
      const pool = new FakePool();
      const r = await dispatch('/api/latency', { headers, pool });
      assert.equal(r.status, 200);
      assert.equal(pool.connects, 1);
    });
  }

  for (const [label, headers] of REFUSED) {
    it(`refuses ${label} with 401 before the database is touched`, async () => {
      const pool = new FakePool();
      for (const route of ['/api/latency', '/api/models']) {
        const r = await dispatch(route, { headers, pool });
        assert.equal(r.status, 401, route);
        assert.deepEqual(r.json, { error: 'unauthorized' });
        assert.equal(r.headers['Content-Security-Policy'], JSON_CSP);
      }
      assert.equal(pool.connects, 0);
    });
  }

  it('answers an unauthenticated unknown path with 401, not 404', async () => {
    assert.equal((await dispatch('/nope')).status, 401);
  });
});

// ---------------------------------------------------------------------------
// Host and Origin
// ---------------------------------------------------------------------------

describe('Observe CLI: Host and Origin', () => {
  it('refuses a foreign Host with 403 everywhere, even with a valid credential', async () => {
    for (const host of ['evil.example', `evil.example:${PORT}`, `127.0.0.1:${PORT + 1}`, '127.0.0.1']) {
      const pool = new FakePool();
      for (const path of ['/', `/?token=${TOKEN}`, '/api/latency', '/api/models', '/nope']) {
        const r = await dispatch(path, { headers: { ...AUTH, host }, pool });
        assert.equal(r.status, 403, `${host} ${path}`);
        assert.match(String((r.json as { error: string }).error), /host not allowed/);
      }
      assert.equal(pool.connects, 0);
    }
  });

  it('accepts the loopback names on the bound port, and a request with no Host at all', async () => {
    for (const host of [`localhost:${PORT}`, `127.0.0.1:${PORT}`, `LOCALHOST:${PORT}`, `[::1]:${PORT}`]) {
      assert.equal((await dispatch('/api/latency', { headers: { ...AUTH, host } })).status, 200, host);
    }
    const { res, done } = makeRes();
    const noHost = makeReq('/api/latency', { headers: AUTH });
    delete (noHost.headers as Record<string, unknown>).host;
    await handleRequest(noHost, res, new FakePool(), OPTIONS, TOKEN, new Map());
    assert.equal((await done).status, 200);
  });

  it('checks the Host before the Origin', async () => {
    const r = await dispatch('/api/latency', {
      headers: { ...AUTH, host: 'evil.example', origin: 'http://evil.example' },
    });
    assert.match(String((r.json as { error: string }).error), /host not allowed/);
  });

  it('refuses a foreign Origin with 403 on the page and the API, before authentication', async () => {
    for (const origin of ['http://evil.example', 'null', 'https://127.0.0.1:4984', `http://localhost:${PORT}`]) {
      for (const [path, headers] of [
        ['/', {}],
        ['/api/latency', {}],
        ['/api/latency', AUTH],
      ] as const) {
        const pool = new FakePool();
        const r = await dispatch(path, { headers: { ...headers, origin }, pool });
        assert.equal(r.status, 403, `${origin} ${path}`);
        assert.deepEqual(r.json, { error: 'cross-origin requests not allowed' });
        assert.equal(pool.connects, 0);
      }
    }
  });

  it('accepts a request whose Origin is exactly this server', async () => {
    const r = await dispatch('/api/latency', { headers: { ...AUTH, origin: ORIGIN } });
    assert.equal(r.status, 200);
  });

  it('expects a bracketed IPv6 origin for an IPv6 bind address, bracketed or not', async () => {
    for (const host of ['::1', '[::1]']) {
      const options = { ...OPTIONS, host };
      const same = `http://[::1]:${PORT}`;
      const ok = await dispatch('/api/latency', { options, headers: { ...AUTH, host: `[::1]:${PORT}`, origin: same } });
      assert.equal(ok.status, 200, host);
      const bad = await dispatch('/api/latency', {
        options,
        headers: { ...AUTH, host: `[::1]:${PORT}`, origin: ORIGIN },
      });
      assert.equal(bad.status, 403, host);
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

describe('Observe CLI: rate limiting', () => {
  it('allows a full window of authorized requests, then answers 429 with Retry-After', async () => {
    const limiter: Limiter = new Map();
    const pool = new FakePool();
    for (let i = 0; i < RATE_LIMIT_MAX_REQUESTS; i++) {
      const r = await dispatch('/api/latency', { headers: AUTH, limiter, pool, remote: '10.0.0.1' });
      assert.equal(r.status, 200, `request ${i}`);
    }
    const limited = await dispatch('/api/latency', { headers: AUTH, limiter, pool, remote: '10.0.0.1' });
    assert.equal(limited.status, 429);
    const retryAfter = Number(limited.headers['Retry-After']);
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter} is within the 60 s window`);
    assert.deepEqual(limited.json, { error: 'Rate limit exceeded', retryAfter });
    assert.equal(pool.connects, RATE_LIMIT_MAX_REQUESTS, 'the refused request never reached the database');
  });

  it('throttles before it authenticates, so a guess loop is counted too', async () => {
    const limiter: Limiter = new Map([
      ['anon:10.0.0.2', { count: RATE_LIMIT_MAX_REQUESTS, resetAt: Date.now() + 30_000 }],
    ]);
    const r = await dispatch('/api/latency', { headers: { 'x-turbine-token': 'guess' }, limiter, remote: '10.0.0.2' });
    assert.equal(r.status, 429);
    const retryAfter = (r.json as { retryAfter: number }).retryAfter;
    assert.ok(retryAfter >= 29 && retryAfter <= 30, `retryAfter ${retryAfter} tracks the remaining window`);
  });

  it('keeps an unauthorized caller and a session in separate buckets, and one bucket per peer address', async () => {
    const limiter: Limiter = new Map();
    await dispatch('/api/latency', { limiter, remote: '10.0.0.3' });
    await dispatch('/api/latency', { headers: AUTH, limiter, remote: '10.0.0.3' });
    await dispatch('/api/latency', { headers: AUTH, limiter, remote: '10.0.0.4' });
    await dispatch('/api/latency', { headers: AUTH, limiter });
    assert.deepEqual([...limiter.keys()].sort(), [
      'anon:10.0.0.3',
      'session:10.0.0.3',
      'session:10.0.0.4',
      'session:unknown',
    ]);

    limiter.set('anon:10.0.0.3', { count: RATE_LIMIT_MAX_REQUESTS, resetAt: Date.now() + 30_000 });
    assert.equal((await dispatch('/api/latency', { limiter, remote: '10.0.0.3' })).status, 429);
    assert.equal(
      (await dispatch('/api/latency', { headers: AUTH, limiter, remote: '10.0.0.3' })).status,
      200,
      'exhausting the anonymous bucket does not lock out the session',
    );
    assert.equal(
      (await dispatch('/api/latency', { limiter, remote: '10.0.0.9' })).status,
      401,
      'another peer is unaffected',
    );
  });

  it('starts a fresh window once the old one has expired', async () => {
    const limiter: Limiter = new Map([
      ['session:10.0.0.5', { count: RATE_LIMIT_MAX_REQUESTS + 40, resetAt: Date.now() - 1 }],
    ]);
    const r = await dispatch('/api/latency', { headers: AUTH, limiter, remote: '10.0.0.5' });
    assert.equal(r.status, 200);
    assert.equal(limiter.get('session:10.0.0.5')?.count, 1);
  });

  it('does not rate-limit the static page, which carries no data', async () => {
    const limiter: Limiter = new Map([
      ['anon:10.0.0.6', { count: RATE_LIMIT_MAX_REQUESTS * 2, resetAt: Date.now() + 30_000 }],
    ]);
    assert.equal((await dispatch('/', { limiter, remote: '10.0.0.6' })).status, 200);
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('Observe CLI: error paths', () => {
  for (const route of ['/api/latency', '/api/models']) {
    it(`${route}: a failing query rolls back, releases once and reports the database's own message`, async () => {
      const pool = new FakePool({ failOn: { SELECT: new Error('relation "_turbine_metrics" does not exist') } });
      const r = await dispatch(route, { headers: AUTH, pool });

      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { error: 'relation "_turbine_metrics" does not exist' });
      assert.equal(r.headers['Content-Type'], 'application/json');
      assert.deepEqual(pool.sql.slice(-1), ['ROLLBACK']);
      assert.ok(!pool.sql.includes('COMMIT'), 'no COMMIT after a failure');
      assert.equal(pool.releases, 1);
      assertReadOnlyVocabulary(pool.sql);
    });

    it(`${route}: a failure to open the transaction still rolls back and releases`, async () => {
      const pool = new FakePool({ failOn: { 'BEGIN READ ONLY': new Error('too many connections') } });
      const r = await dispatch(route, { headers: AUTH, pool });
      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { error: 'too many connections' });
      assert.deepEqual(pool.sql, ['BEGIN READ ONLY', 'ROLLBACK']);
      assert.equal(pool.releases, 1);
    });

    it(`${route}: a failing COMMIT is reported, not hidden`, async () => {
      const pool = new FakePool({ failOn: { COMMIT: new Error('commit failed') } });
      const r = await dispatch(route, { headers: AUTH, pool });
      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { error: 'commit failed' });
      assert.equal(pool.releases, 1);
    });

    it(`${route}: when ROLLBACK also fails, the original error is the one reported`, async () => {
      const pool = new FakePool({
        failOn: {
          SELECT: new Error('canceling statement due to statement timeout'),
          ROLLBACK: new Error('connection terminated'),
        },
      });
      const r = await dispatch(route, { headers: AUTH, pool });
      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { error: 'canceling statement due to statement timeout' });
      assert.equal(pool.releases, 1);
    });

    it(`${route}: a thrown non-Error gets a fixed sentence, never its own rendering`, async () => {
      const pool = new FakePool({ failOn: { SELECT: 'plain string failure' } });
      const r = await dispatch(route, { headers: AUTH, pool });
      assert.equal(r.status, 500);
      assert.deepEqual(r.json, { error: 'unexpected error' });
    });

    it(`${route}: a pool that cannot hand out a connection rejects to the server's 500 handler`, async () => {
      const pool = new FakePool({ connectError: new Error('pool exhausted') });
      const { res } = makeRes();
      await assert.rejects(
        handleRequest(makeReq(route, { headers: AUTH }), res, pool, OPTIONS, TOKEN, new Map()),
        /pool exhausted/,
      );
      assert.equal(pool.releases, 0, 'nothing was checked out, so nothing is released');
    });
  }
});

// ---------------------------------------------------------------------------
// A fake Postgres wire server: just enough protocol for a pool's `SELECT 1`
// ---------------------------------------------------------------------------

function pgMessage(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([head, payload]);
}

function pgInt32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}

function pgError(severity: string, code: string, message: string): Buffer {
  const field = (tag: string, value: string) => Buffer.from(`${tag}${value}\0`, 'utf8');
  return pgMessage('E', Buffer.concat([field('S', severity), field('C', code), field('M', message), Buffer.from([0])]));
}

const READY = pgMessage('Z', Buffer.from('I'));

/** `SELECT 1`: one int4 column named ?column?, one row. */
function selectOneReply(): Buffer {
  const rowDescription = Buffer.concat([
    Buffer.from([0, 1]),
    Buffer.from('?column?\0', 'utf8'),
    pgInt32(0),
    Buffer.from([0, 0]),
    pgInt32(23),
    Buffer.from([0, 4]),
    pgInt32(-1),
    Buffer.from([0, 0]),
  ]);
  const dataRow = Buffer.concat([Buffer.from([0, 1]), pgInt32(1), Buffer.from('1')]);
  return Buffer.concat([
    pgMessage('T', rowDescription),
    pgMessage('D', dataRow),
    pgMessage('C', Buffer.from('SELECT 1\0')),
    READY,
  ]);
}

type FakePostgresMode = 'ok' | 'refuse-login' | 'fail-queries';

interface FakePostgres {
  port: number;
  url: string;
  queries: string[];
  openConnections(): number;
  /** Cut every connection and stop listening, as a database restart would. */
  kill(): Promise<void>;
  close(): Promise<void>;
}

function startFakePostgres(mode: FakePostgresMode = 'ok'): Promise<FakePostgres> {
  const sockets = new Set<net.Socket>();
  const queries: string[] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    let started = false;
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (!started) {
          if (buf.length < 8) return;
          const len = buf.readInt32BE(0);
          if (buf.length < len) return;
          const code = buf.readInt32BE(4);
          buf = buf.subarray(len);
          if (code === 80877103) {
            socket.write('N'); // SSLRequest: decline
            continue;
          }
          started = true;
          if (mode === 'refuse-login') {
            socket.end(pgError('FATAL', '28P01', 'password authentication failed for user "fake"'));
            return;
          }
          socket.write(Buffer.concat([pgMessage('R', pgInt32(0)), READY]));
          continue;
        }
        if (buf.length < 5) return;
        const type = String.fromCharCode(buf[0] as number);
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) return;
        const payload = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);
        if (type === 'Q') {
          const sql = payload.toString('utf8', 0, payload.length - 1);
          queries.push(sql);
          socket.write(
            mode === 'fail-queries'
              ? Buffer.concat([pgError('ERROR', '57014', 'probe refused'), READY])
              : selectOneReply(),
          );
        } else if (type === 'X') {
          socket.end();
          return;
        }
      }
    });
  });

  const closeServer = () => new Promise<void>((resolve) => server.close(() => resolve()));
  const destroyAll = () => {
    for (const s of sockets) s.destroy();
  };

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        url: `postgres://fake@127.0.0.1:${port}/fake?sslmode=disable`,
        queries,
        openConnections: () => sockets.size,
        kill: async () => {
          const closing = closeServer();
          destroyAll();
          await closing;
        },
        close: async () => {
          destroyAll();
          await closeServer().catch(() => {});
        },
      });
    });
  });
}

async function waitFor(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(`timed out after ${ms} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

interface Wire {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function wire(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: Buffer,
): Promise<Wire> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function canListenOnIpv6(): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(0, '::1', () => srv.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------------------
// startObserve
// ---------------------------------------------------------------------------

describe('Observe CLI: startObserve', () => {
  it('starts against a database, prints a one-time ticket URL, serves it, and disposes cleanly', async () => {
    const db = await startFakePostgres();
    const port = await freePort();
    const handle = await startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: false });
    try {
      assert.ok(db.queries.includes('SELECT 1'), 'the start-up probe ran');
      assert.equal(db.openConnections(), 1, 'the probe connection is kept in the pool');

      const ticket = new URL(handle.url).searchParams.get('token');
      assert.match(handle.url, new RegExp(`^http://127\\.0\\.0\\.1:${port}/\\?token=[0-9a-f]{48}$`));
      assert.match(handle.authToken, /^[0-9a-f]{48}$/);
      assert.notEqual(ticket, handle.authToken);
      assert.ok(!handle.url.includes(handle.authToken), 'the printed URL never carries the session credential');

      const page = await wire(port, 'GET', '/');
      assert.equal(page.status, 200);
      assert.match(page.body, /<script nonce="/);

      const exchanged = await wire(port, 'GET', `/?token=${ticket}`);
      assert.equal(exchanged.status, 302);
      const cookie = String(exchanged.headers['set-cookie']?.[0]).split(';')[0]!;
      assert.equal(cookie, `turbine_observe_token=${handle.authToken}`);

      assert.equal(
        (await wire(port, 'GET', '/api/unknown', { Cookie: cookie })).status,
        404,
        'the cookie authenticates',
      );
      assert.equal((await wire(port, 'GET', '/api/unknown')).status, 401);
      assert.equal((await wire(port, 'GET', '/api/unknown', { Cookie: cookie, Host: 'evil.example' })).status, 403);

      const big = Buffer.alloc(2 * 1024 * 1024, 0x20);
      // The route takes no body, so the answer is sent without reading it. The
      // server may close the socket before the client has finished writing 2 MB,
      // so a reset on the client's write is as valid an outcome as the 404.
      const post = await wire(
        port,
        'POST',
        '/api/latency',
        { 'x-turbine-token': handle.authToken, 'Content-Length': String(big.length) },
        big,
      ).catch((err: NodeJS.ErrnoException) => err);
      if (post instanceof Error) assert.match(String(post.code), /^(ECONNRESET|EPIPE)$/);
      else assert.equal(post.status, 404);
      assert.equal((await wire(port, 'GET', '/', {})).status, 200, 'the server survived it');
    } finally {
      await handle.dispose();
    }
    await waitFor(() => db.openConnections() === 0, 2000, 'the pool to close its connection');
    await assert.rejects(wire(port, 'GET', '/'), /ECONNREFUSED/, 'the port is released');
    await db.close();
  });

  it('answers a malformed request target with 400 and keeps serving', async () => {
    const db = await startFakePostgres();
    const port = await freePort();
    const handle = await startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: false });
    try {
      const bad = await wire(port, 'GET', '//');
      assert.equal(bad.status, 400);
      assert.deepEqual(JSON.parse(bad.body), { error: 'malformed request target' });
      assert.equal((await wire(port, 'GET', '/')).status, 200, 'the server keeps serving');
    } finally {
      await handle.dispose();
      await db.close();
    }
  });

  it('brackets an IPv6 bind address in the printed URL', async (t) => {
    if (!(await canListenOnIpv6())) return t.skip('no IPv6 loopback on this machine');
    const db = await startFakePostgres();
    const port = await freePort();
    const handle = await startObserve({ url: db.url, port, host: '::1', openBrowser: false });
    try {
      assert.match(handle.url, new RegExp(`^http://\\[::1\\]:${port}/\\?token=[0-9a-f]{48}$`));
    } finally {
      await handle.dispose();
      await db.close();
    }
  });

  it('reports a database that cannot be reached and starts no server', async () => {
    const deadPort = await freePort();
    const port = await freePort();
    await assert.rejects(
      startObserve({
        url: `postgres://fake@127.0.0.1:${deadPort}/fake?sslmode=disable`,
        port,
        host: '127.0.0.1',
        openBrowser: false,
      }),
      /ECONNREFUSED/,
    );
    await assert.rejects(wire(port, 'GET', '/'), /ECONNREFUSED/, 'nothing is listening');
  });

  it("reports the database's own message when the login is refused", async () => {
    const db = await startFakePostgres('refuse-login');
    const port = await freePort();
    try {
      await assert.rejects(
        startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: false }),
        /password authentication failed/,
      );
      await assert.rejects(wire(port, 'GET', '/'), /ECONNREFUSED/);
    } finally {
      await db.close();
    }
  });

  it('closes its database connection when the start-up probe fails', async () => {
    const db = await startFakePostgres('fail-queries');
    const port = await freePort();
    try {
      await assert.rejects(startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: false }), /probe refused/);
      await waitFor(() => db.openConnections() === 0, 2000, 'the failed start to close its connection');
    } finally {
      await db.close();
    }
  });

  it('closes its database connection when the port is already taken', async () => {
    const db = await startFakePostgres();
    const taken = net.createServer();
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve));
    const port = (taken.address() as AddressInfo).port;
    try {
      await assert.rejects(startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: false }), /EADDRINUSE/);
      await waitFor(() => db.openConnections() === 0, 2000, 'the failed start to close its connection');
    } finally {
      await new Promise<void>((resolve) => taken.close(() => resolve()));
      await db.close();
    }
  });

  it('logs a lost database connection and answers 500 once the database is gone', async () => {
    const db = await startFakePostgres();
    const port = await freePort();
    const handle = await startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: false });
    const logged: string[] = [];
    const spy = mock.method(console, 'error', (...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    try {
      const exchanged = await wire(port, 'GET', `/?token=${new URL(handle.url).searchParams.get('token')}`);
      const cookie = String(exchanged.headers['set-cookie']?.[0]).split(';')[0]!;

      await db.kill();
      await waitFor(() => logged.length > 0, 2000, 'the pool error handler to run');
      assert.match(logged[0] as string, /^\[turbine\] observe pool error: /);

      const r = await wire(port, 'GET', '/api/latency', { Cookie: cookie });
      assert.equal(r.status, 500);
      assert.match(JSON.parse(r.body).error, /ECONNREFUSED/);
      assert.equal(
        (await wire(port, 'GET', '/api/unknown', { Cookie: cookie })).status,
        404,
        'the server keeps serving',
      );
    } finally {
      spy.mock.restore();
      await handle.dispose();
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The browser launcher
// ---------------------------------------------------------------------------

describe('Observe CLI: opening the browser', () => {
  class FakeChild extends EventEmitter {
    unrefs = 0;
    unref() {
      this.unrefs++;
    }
  }

  interface SpawnCall {
    command: string;
    args: string[];
    options: Record<string, unknown>;
    child: FakeChild;
  }

  /**
   * Start Observe with `openBrowser: true` while `child_process.spawn` (and the
   * ESM binding observe.ts imported) and `process.platform` are replaced, and put
   * both back as soon as start-up returns. The launcher runs synchronously inside
   * `startObserve`, so nothing outside that call sees the fakes.
   */
  async function launch(platform: string, behaviour: 'child' | 'throw' = 'child') {
    const db = await startFakePostgres();
    const port = await freePort();
    const calls: SpawnCall[] = [];
    const realSpawn = childProcess.spawn;
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
    (childProcess as { spawn: unknown }).spawn = (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      if (behaviour === 'throw') throw new Error('spawn is unavailable');
      const child = new FakeChild();
      calls.push({ command, args, options, child });
      return child;
    };
    syncBuiltinESMExports();
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      const handle = await startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: true });
      return { handle, calls, db };
    } catch (err) {
      await db.close();
      throw err;
    } finally {
      Object.defineProperty(process, 'platform', realPlatform);
      (childProcess as { spawn: unknown }).spawn = realSpawn;
      syncBuiltinESMExports();
    }
  }

  async function stop(run: { handle: { dispose: () => Promise<void> }; db: FakePostgres }): Promise<void> {
    await run.handle.dispose();
    await run.db.close();
  }

  it('hands the ticket URL to xdg-open on Linux, detached and unreferenced', async () => {
    // Linux first on purpose: if the fake did not take effect, the wrong-platform
    // command fails harmlessly instead of opening this machine's browser.
    const run = await launch('linux');
    try {
      assert.equal(run.calls.length, 1, 'spawn was intercepted exactly once');
      assert.equal(run.calls[0]?.command, 'xdg-open');
      assert.deepEqual(run.calls[0]?.args, [run.handle.url]);
      assert.deepEqual(run.calls[0]?.options, { stdio: 'ignore', detached: true });
      assert.equal(run.calls[0]?.child.unrefs, 1);
    } finally {
      await stop(run);
    }
  });

  it('uses open on macOS and cmd /c start on Windows', async () => {
    const darwin = await launch('darwin');
    try {
      assert.equal(darwin.calls[0]?.command, 'open');
      assert.deepEqual(darwin.calls[0]?.args, [darwin.handle.url]);
    } finally {
      await stop(darwin);
    }
    const win = await launch('win32');
    try {
      assert.equal(win.calls[0]?.command, 'cmd');
      assert.deepEqual(win.calls[0]?.args, ['/c', 'start', '', win.handle.url]);
    } finally {
      await stop(win);
    }
  });

  it('survives a launcher that is missing: the failure arrives as an event, not a crash', async () => {
    const run = await launch('linux');
    try {
      const child = run.calls[0]?.child as FakeChild;
      const missing = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
      assert.doesNotThrow(() => child.emit('error', missing));
    } finally {
      await stop(run);
    }
  });

  it('survives a launcher that throws synchronously', async () => {
    const run = await launch('linux', 'throw');
    try {
      assert.match(run.handle.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=/);
    } finally {
      await stop(run);
    }
  });

  it('launches nothing when openBrowser is false', async () => {
    const db = await startFakePostgres();
    const port = await freePort();
    const calls: unknown[] = [];
    const realSpawn = childProcess.spawn;
    (childProcess as { spawn: unknown }).spawn = (...args: unknown[]) => {
      calls.push(args);
      throw new Error('must not be called');
    };
    syncBuiltinESMExports();
    let handle: Awaited<ReturnType<typeof startObserve>> | undefined;
    try {
      handle = await startObserve({ url: db.url, port, host: '127.0.0.1', openBrowser: false });
      assert.equal(calls.length, 0);
    } finally {
      (childProcess as { spawn: unknown }).spawn = realSpawn;
      syncBuiltinESMExports();
      await handle?.dispose();
      await db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Live Postgres
// ---------------------------------------------------------------------------

describe('Observe CLI against a live Postgres', () => {
  const dbUrl = process.env.DATABASE_URL;
  const live = skipGate(!dbUrl, 'requires DATABASE_URL (live Postgres for the _turbine_metrics queries)');
  const MODELS = 'obs\\_cli\\_%';

  let pool: pg.Pool;
  /** Bucket epoch ms for the seeded rows, filled by the seed step. */
  const bucketAt: Record<string, number> = {};

  async function seed(
    key: string,
    minutesAgo: number,
    model: string,
    action: string,
    [count, avg, p50, p95, p99, errors]: [number, number, number, number, number, number],
  ): Promise<void> {
    // An odd sub-minute offset keeps these buckets clear of any other writer's minute buckets.
    const r = await pool.query<{ ms: string }>(
      `INSERT INTO _turbine_metrics (bucket, model, action, count, avg_ms, p50_ms, p95_ms, p99_ms, error_count)
       VALUES (date_trunc('minute', NOW()) - make_interval(mins => $1) + interval '37.123 seconds', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING (extract(epoch from bucket) * 1000)::bigint AS ms`,
      [minutesAgo, model, action, count, avg, p50, p95, p99, errors],
    );
    bucketAt[key] = Number(r.rows[0]?.ms);
  }

  async function get(route: string, p: PgCompatPool = pool): Promise<Recorded> {
    return dispatch(route, { headers: AUTH, pool: p });
  }

  live.before(async () => {
    const sink = new PgMetricsSink({ connectionString: dbUrl as string });
    await sink.init();
    await sink.stop();
    pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
    await pool.query(`DELETE FROM _turbine_metrics WHERE model LIKE '${MODELS}'`);

    await seed('recent-a', 30, 'obs_cli_recent', 'findMany', [10, 2, 1, 5, 8, 1]);
    await seed('recent-b', 30, 'obs_cli_recent', 'create', [30, 4, 3, 9, 12, 2]);
    await seed('recent-c', 45, 'obs_cli_recent', 'findMany', [30, 4, 3, 7, 10, 0]);
    await seed('mid', 3 * 60, 'obs_cli_mid', 'findMany', [5, 1, 1, 2, 3, 0]);
    await seed('day', 12 * 60, 'obs_cli_day', 'findMany', [6, 1, 1, 2, 3, 0]);
    await seed('week', 3 * 24 * 60, 'obs_cli_week', 'findMany', [7, 1, 1, 2, 3, 0]);
    await seed('old', 10 * 24 * 60, 'obs_cli_old', 'findMany', [8, 1, 1, 2, 3, 0]);
  });

  live.after(async () => {
    await pool.query(`DELETE FROM _turbine_metrics WHERE model LIKE '${MODELS}'`);
    await pool.end();
  });

  type MetricRow = Record<string, string | number>;
  const ours = (rows: MetricRow[]) => rows.filter((r) => String(r.model).startsWith('obs_cli_'));

  live.it('/api/models sums, weights and orders per model and action', async () => {
    const r = await get('/api/models?range=1h');
    assert.equal(r.status, 200);
    const rows = ours(r.json as MetricRow[]);
    assert.deepEqual(
      rows.map((x) => [x.model, x.action]),
      [
        ['obs_cli_recent', 'create'],
        ['obs_cli_recent', 'findMany'],
      ],
      'ordered by the worst p95, first',
    );
    const [create, findMany] = rows;
    assert.equal(create?.count, 30);
    assert.equal(create?.avg_ms, 4);
    assert.equal(create?.p95_ms, 9);
    assert.equal(create?.p99_ms, 12);
    assert.equal(create?.error_count, 2);
    assert.equal(findMany?.count, 40, 'counts add across buckets');
    assert.equal(findMany?.avg_ms, 3.5, 'the average is weighted by count: (10*2 + 30*4) / 40');
    assert.equal(findMany?.p95_ms, 7, 'the percentile is the worst bucket, not a mean');
    assert.equal(findMany?.p99_ms, 10);
    assert.equal(findMany?.error_count, 1);
  });

  live.it('/api/latency groups by bucket, weights the average and orders oldest first', async () => {
    const r = await get('/api/latency?range=1h');
    assert.equal(r.status, 200);
    const mine = (r.json as Array<Record<string, string | number>>).filter((x) =>
      Object.values(bucketAt).includes(new Date(x.bucket as string).getTime()),
    );
    assert.deepEqual(
      mine.map((x) => new Date(x.bucket as string).getTime()),
      [bucketAt['recent-c'], bucketAt['recent-a']],
      'two buckets, oldest first',
    );
    const [older, newer] = mine;
    assert.equal(Number(older?.count), 30);
    assert.equal(older?.avg_ms, 4);
    assert.equal(older?.p95_ms, 7);
    assert.equal(older?.p99_ms, 10);
    assert.equal(Number(newer?.count), 40, 'two actions in one bucket are summed');
    assert.equal(newer?.avg_ms, 3.5);
    assert.equal(newer?.p95_ms, 9);
    assert.equal(newer?.p99_ms, 12);
  });

  const WINDOWS: Array<[string | null, string[]]> = [
    [null, ['obs_cli_recent']],
    ['1h', ['obs_cli_recent']],
    ['6h', ['obs_cli_mid', 'obs_cli_recent']],
    ['24h', ['obs_cli_day', 'obs_cli_mid', 'obs_cli_recent']],
    ['7d', ['obs_cli_day', 'obs_cli_mid', 'obs_cli_recent', 'obs_cli_week']],
    ['90d', ['obs_cli_recent']],
  ];

  for (const [range, expected] of WINDOWS) {
    live.it(`range ${range === null ? '(absent)' : range} reads exactly the buckets inside its window`, async () => {
      const route = range === null ? '/api/models' : `/api/models?range=${range}`;
      const models = new Set(ours((await get(route)).json as MetricRow[]).map((x) => x.model));
      assert.deepEqual([...models].sort(), expected);

      const lroute = range === null ? '/api/latency' : `/api/latency?range=${range}`;
      const buckets = ((await get(lroute)).json as Array<{ bucket: string }>).map((x) => new Date(x.bucket).getTime());
      const inWindow = Object.entries(bucketAt)
        .filter(([, ms]) => buckets.includes(ms))
        .map(([key]) => key)
        .sort();
      const wanted = {
        obs_cli_recent: ['recent-a', 'recent-b', 'recent-c'],
        obs_cli_mid: ['mid'],
        obs_cli_day: ['day'],
        obs_cli_week: ['week'],
      } as Record<string, string[]>;
      assert.deepEqual(inWindow, expected.flatMap((m) => wanted[m] ?? []).sort());
    });
  }

  live.it('/api/models returns at most 50 rows, the 50 worst by p95', async () => {
    await pool.query(
      `INSERT INTO _turbine_metrics (bucket, model, action, count, avg_ms, p50_ms, p95_ms, p99_ms, error_count)
       SELECT date_trunc('minute', NOW()) - interval '20 minutes' + interval '41.5 seconds',
              'obs_cli_top_' || lpad(i::text, 2, '0'), 'findMany', 1, 1, 1, 5000000 + i, 5000000 + i, 0
       FROM generate_series(0, 59) AS i`,
    );
    try {
      const r = await get('/api/models?range=1h');
      const rows = r.json as Array<{ model: string; p95_ms: number }>;
      assert.equal(rows.length, 50);
      assert.deepEqual(
        rows.map((x) => x.model),
        Array.from({ length: 50 }, (_, k) => `obs_cli_top_${String(59 - k).padStart(2, '0')}`),
      );
    } finally {
      await pool.query(`DELETE FROM _turbine_metrics WHERE model LIKE 'obs\\_cli\\_top\\_%'`);
    }
  });

  live.it(
    'a request runs inside a real read-only transaction with a 30 s timeout, and leaves the session untouched',
    async () => {
      const seen: { readOnly?: string; timeout?: string; sql: string[] } = { sql: [] };
      const spy: PgCompatPool = {
        query: ((text: string, values?: unknown[]) => pool.query(text, values)) as PgCompatPool['query'],
        end: () => pool.end(),
        connect: async () => {
          const client = await pool.connect();
          return {
            async query(text: string, values?: unknown[]) {
              seen.sql.push(text);
              if (text.startsWith('SELECT ')) {
                const ro = await client.query('SHOW transaction_read_only');
                const to = await client.query('SHOW statement_timeout');
                seen.readOnly = ro.rows[0].transaction_read_only;
                seen.timeout = to.rows[0].statement_timeout;
              }
              return client.query(text, values) as never;
            },
            release: (err?: Error | boolean) => client.release(err),
          };
        },
      };

      for (const route of ['/api/latency', '/api/models']) {
        seen.readOnly = undefined;
        seen.timeout = undefined;
        assert.equal((await get(route, spy)).status, 200);
        assert.equal(seen.readOnly, 'on', `${route}: the connection is read-only while the query runs`);
        assert.equal(seen.timeout, '30s', `${route}: the timeout is 30 s while the query runs`);

        // One connection in the pool, so this is the very backend the request used.
        const after = await pool.query('SHOW transaction_read_only');
        assert.equal(after.rows[0].transaction_read_only, 'off', `${route}: read-only did not leak to the session`);
        const timeout = await pool.query('SHOW statement_timeout');
        assert.equal(timeout.rows[0].statement_timeout, '0', `${route}: the timeout did not leak to the session`);
      }
      assertReadOnlyVocabulary(seen.sql.filter((q) => !q.startsWith('SHOW ')));
    },
  );

  live.it('a missing metrics table is a 500 naming it, and the connection is usable afterwards', async () => {
    const bare = new pg.Pool({ connectionString: dbUrl, max: 1, options: '-c search_path=obs_cli_no_such_schema' });
    try {
      for (const route of ['/api/latency', '/api/models']) {
        const r = await get(route, bare);
        assert.equal(r.status, 500, route);
        assert.match((r.json as { error: string }).error, /relation "_turbine_metrics" does not exist/);
        assert.equal(bare.idleCount, 1, `${route}: the connection went back to the pool`);
      }
      const probe = await bare.query('SELECT 1 AS one');
      assert.equal(probe.rows[0].one, 1, 'the connection was not left in an aborted transaction');
      const ro = await bare.query('SHOW transaction_read_only');
      assert.equal(ro.rows[0].transaction_read_only, 'off');
    } finally {
      await bare.end();
    }
  });

  live.it('serves the seeded metrics through a real server end to end', async () => {
    const port = await freePort();
    const handle = await startObserve({ url: dbUrl as string, port, host: '127.0.0.1', openBrowser: false });
    try {
      const ticket = new URL(handle.url).searchParams.get('token');
      const exchanged = await wire(port, 'GET', `/?token=${ticket}`);
      assert.equal(exchanged.status, 302);
      const cookie = String(exchanged.headers['set-cookie']?.[0]).split(';')[0]!;

      const models = await wire(port, 'GET', '/api/models?range=6h', { Cookie: cookie });
      assert.equal(models.status, 200);
      assert.equal(models.headers['content-type'], 'application/json');
      const rows = ours(JSON.parse(models.body) as MetricRow[]);
      assert.deepEqual(rows.map((x) => x.model).sort(), ['obs_cli_mid', 'obs_cli_recent', 'obs_cli_recent']);

      const latency = await wire(port, 'GET', '/api/latency?range=1h', { Cookie: cookie });
      assert.equal(latency.status, 200);
      assert.ok(Array.isArray(JSON.parse(latency.body)), 'latency is a JSON array');

      assert.equal((await wire(port, 'GET', '/api/models', { Cookie: cookie, Host: 'evil.example' })).status, 403);
    } finally {
      await handle.dispose();
    }
  });
});
