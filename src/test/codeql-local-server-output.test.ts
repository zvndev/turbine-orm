/**
 * turbine-orm, what Studio and Observe put out of the process.
 *
 * Two things leave the local servers that are not entirely ours: the text of an
 * error response (a caught value can be anything a dependency threw) and the
 * command that opens a browser (its URL carries the host from `--host`). Both
 * now go through `cli/local-server-output.ts`. These tests pin that a stack, or
 * a rendering of a foreign thrown object, never reaches a response body, and
 * that a URL carrying shell syntax is never handed to a launcher.
 *
 * Run: npx tsx --test src/test/codeql-local-server-output.test.ts
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { type BrowserLaunch, isLaunchableUrl, openInBrowser, responseErrorText } from '../cli/local-server-output.js';
import { type ObserveOptions, handleRequest as observeRequest } from '../cli/observe.js';
import { type StudioContext, handleRequest as studioRequest } from '../cli/studio.js';
import type { PgCompatPool } from '../pg-types.js';
import { mockTable } from './helpers.js';
import { studioTestStateDir } from './studio-test-state.js';

const STATE_DIR = studioTestStateDir();

/** What a foreign error type can look like: nothing safe to print, and a stack in its string form. */
const HOSTILE = {
  message: 'not an Error instance',
  toString: () => 'Error: boom\n    at secret (/home/dev/app.ts:1:1)',
};
const STACK_TEXT = 'Error: x\n    at secret (/home/dev/app.ts:9:9)';

// ---------------------------------------------------------------------------
// responseErrorText
// ---------------------------------------------------------------------------

describe('responseErrorText', () => {
  it('returns an Error message and never its stack', () => {
    const err = Object.assign(new Error('canceling statement due to statement timeout'), { stack: STACK_TEXT });
    assert.equal(responseErrorText(err), 'canceling statement due to statement timeout');
  });

  it('falls back to the aggregated messages when the message is empty', () => {
    const err = new AggregateError([
      new Error('connect ECONNREFUSED ::1:5432'),
      new Error('connect ECONNREFUSED 127.0.0.1:5432'),
    ]);
    assert.equal(err.message, '');
    assert.equal(responseErrorText(err), 'connect ECONNREFUSED ::1:5432; connect ECONNREFUSED 127.0.0.1:5432');
  });

  it('falls back to the cause, then the code, then the name', () => {
    const empty = (extra: Record<string, unknown> = {}) => Object.assign(new Error(''), extra);
    assert.equal(responseErrorText(empty({ cause: new Error('root cause') })), 'root cause');
    assert.equal(responseErrorText(empty({ code: 'ECONNRESET' })), 'ECONNRESET');
    assert.equal(responseErrorText(empty({ name: 'CustomFailure' })), 'CustomFailure');
  });

  it('skips aggregated and cause values that are not Errors', () => {
    const err = new AggregateError([HOSTILE, 'plain string'], '');
    assert.equal(responseErrorText(err), 'AggregateError');
    assert.equal(responseErrorText(Object.assign(new Error(''), { cause: HOSTILE, code: 'EPIPE' })), 'EPIPE');
  });

  it('gives a thrown non-Error a fixed sentence, whatever it renders as', () => {
    for (const thrown of [HOSTILE, 'plain string', 42, null, undefined, { stack: STACK_TEXT }, Symbol('s')]) {
      const text = responseErrorText(thrown);
      assert.equal(text, 'unexpected error');
      assert.ok(!text.includes('secret'), text);
    }
  });
});

// ---------------------------------------------------------------------------
// The servers' own error paths
// ---------------------------------------------------------------------------

interface Recorded {
  status: number;
  body: string;
  json: { error?: string } | null;
}

function makeRes(): { res: ServerResponse; done: Promise<Recorded> } {
  let resolveDone!: (r: Recorded) => void;
  const done = new Promise<Recorded>((r) => {
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
      let json: Recorded['json'] = null;
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

function makeReq(method: string, url: string, headers: Record<string, string>, body?: unknown): IncomingMessage {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (payload.length) yield payload;
    },
  } as unknown as IncomingMessage;
}

/** A pool whose connection throws `thrown` from its first statement. */
function failingPool(thrown: unknown): pg.Pool & PgCompatPool {
  const client = {
    async query() {
      throw thrown;
    },
    release() {},
  };
  return {
    async connect() {
      return client;
    },
    async query() {
      throw thrown;
    },
    async end() {},
  } as unknown as pg.Pool & PgCompatPool;
}

const HOST = '127.0.0.1';
const PORT = 4983;
const TOKEN = 'codeql-token';

async function observeModels(thrown: unknown): Promise<Recorded> {
  const options: ObserveOptions = { url: 'postgres://fake', port: PORT, host: HOST, openBrowser: false };
  const { res, done } = makeRes();
  await observeRequest(
    makeReq('GET', '/api/models', { host: `${HOST}:${PORT}`, 'x-turbine-token': TOKEN }),
    res,
    failingPool(thrown),
    options,
    TOKEN,
    new Map(),
  );
  return done;
}

async function studioBuilder(thrown: unknown): Promise<Recorded> {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  const ctx = {
    pool: failingPool(thrown),
    metadata: { tables: { users }, enums: {} },
    options: {
      url: 'postgres://fake',
      schema: 'public',
      port: PORT,
      host: HOST,
      openBrowser: false,
      stateDir: STATE_DIR,
    },
    authToken: TOKEN,
    stateDir: STATE_DIR,
    statementTimeout: { sql: `SELECT set_config('statement_timeout', $1, true)`, params: ['30s'] },
    rateLimiter: new Map(),
    writable: false,
    showPii: false,
  } as unknown as StudioContext;
  const { res, done } = makeRes();
  await studioRequest(
    makeReq(
      'POST',
      '/api/builder',
      { host: `${HOST}:${PORT}`, 'x-turbine-token': TOKEN, origin: `http://${HOST}:${PORT}` },
      { table: 'users', args: {} },
    ),
    res,
    ctx,
  );
  return done;
}

for (const [name, run] of [
  ['Observe /api/models', observeModels],
  ['Studio /api/builder', studioBuilder],
] as const) {
  describe(`${name}: error responses`, () => {
    it('carries an Error message and nothing from its stack', async () => {
      const r = await run(Object.assign(new Error('relation "x" does not exist'), { stack: STACK_TEXT }));
      assert.ok(r.status >= 400, String(r.status));
      assert.equal(r.json?.error, 'relation "x" does not exist');
      assert.ok(!r.body.includes('/home/dev'), r.body);
      assert.ok(!r.body.includes('    at '), r.body);
    });

    it('does not render a thrown object that is not an Error', async () => {
      const r = await run(HOSTILE);
      assert.ok(r.status >= 400, String(r.status));
      assert.equal(r.json?.error, 'unexpected error');
      assert.ok(!r.body.includes('secret'), r.body);
    });
  });
}

// ---------------------------------------------------------------------------
// The browser launch
// ---------------------------------------------------------------------------

describe('isLaunchableUrl', () => {
  const launchable = [
    'http://127.0.0.1:4983/?token=0f1e2d3c',
    'http://localhost:3000/?token=abc-DEF_123',
    'http://[::1]:4983/?token=ff',
    'http://[fe80::1]:4983/?token=ff',
    'http://my-host.internal:80/',
    'http://0.0.0.0:1/?token=x',
  ];
  const refused = [
    'http://127.0.0.1&calc:3000/?token=ab',
    'http://127.0.0.1|calc:3000/?token=ab',
    'http://127.0.0.1:3000/?token=a&b=c',
    'http://127.0.0.1:3000/?token=a"b',
    'http://127.0.0.1:3000/?token=%41',
    'http://127.0.0.1:3000/?token=a^b',
    'http://127.0.0.1:3000/?token=a;b',
    'http://127.0.0.1:3000/?token=a b',
    'http://127.0.0.1:3000/?token=a\nb',
    'http://127.0.0.1:3000/path',
    'http://user:pw@127.0.0.1:3000/',
    'http://127.0.0.1/',
    'https://127.0.0.1:3000/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    '--help',
    '',
  ];
  for (const url of launchable) {
    it(`launches ${JSON.stringify(url)}`, () => assert.equal(isLaunchableUrl(url), true));
  }
  for (const url of refused) {
    it(`refuses ${JSON.stringify(url)}`, () => assert.equal(isLaunchableUrl(url), false));
  }
});

describe('openInBrowser', () => {
  interface Call {
    command: string;
    args: string[];
    options: unknown;
  }

  function fakeLaunch(platform: string, behaviour: 'child' | 'throw' = 'child') {
    const calls: Call[] = [];
    const children: Array<EventEmitter & { unrefs: number }> = [];
    const launch: BrowserLaunch = {
      platform,
      spawn: ((command: string, args: string[], options: unknown) => {
        if (behaviour === 'throw') throw new Error('spawn is unavailable');
        calls.push({ command, args, options });
        const child = Object.assign(new EventEmitter(), {
          unrefs: 0,
          unref() {
            this.unrefs++;
          },
        });
        children.push(child);
        return child;
      }) as unknown as BrowserLaunch['spawn'],
    };
    return { launch, calls, children };
  }

  const URL_OK = 'http://127.0.0.1:4983/?token=abc123';

  it('starts the platform launcher with an argument list and no shell', () => {
    for (const [platform, command, args] of [
      ['linux', 'xdg-open', [URL_OK]],
      ['darwin', 'open', [URL_OK]],
      ['win32', 'cmd', ['/c', 'start', '', URL_OK]],
    ] as const) {
      const run = fakeLaunch(platform);
      assert.equal(openInBrowser(URL_OK, run.launch), true);
      assert.equal(run.calls.length, 1);
      assert.equal(run.calls[0]?.command, command);
      assert.deepEqual(run.calls[0]?.args, args);
      assert.deepEqual(run.calls[0]?.options, { stdio: 'ignore', detached: true });
      assert.equal(run.children[0]?.unrefs, 1, 'the launcher must not keep the server alive');
    }
  });

  it('survives a launcher that is missing: the failure arrives as an event', () => {
    const run = fakeLaunch('linux');
    openInBrowser(URL_OK, run.launch);
    const missing = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' });
    assert.doesNotThrow(() => run.children[0]?.emit('error', missing));
  });

  it('reports false when the launcher cannot be started', () => {
    assert.equal(openInBrowser(URL_OK, fakeLaunch('linux', 'throw').launch), false);
  });

  it('starts nothing for a URL carrying shell syntax, on any platform', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const run = fakeLaunch(platform);
      assert.equal(openInBrowser('http://127.0.0.1&calc:3000/?token=ab', run.launch), false);
      assert.equal(run.calls.length, 0, `${platform} handed a hostile URL to its launcher`);
    }
  });
});
