/**
 * The `diagnostics` client option: one switch, resolved once at construction.
 *
 * - `resolveDiagnostics` maps a mode or per-part overrides, plus the
 *   environment, to a frozen `{ mode, advice, cacheCheck }`, and refuses a
 *   malformed option with E003.
 * - The default mode is `NODE_ENV`'s, read once when the client is built: a
 *   later change to `NODE_ENV` changes nothing for that client.
 * - The option beats `NODE_ENV` in both directions.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { type DiagnosticsEnv, resolveDiagnostics } from '../diagnostics.js';
import { ValidationError } from '../errors.js';
import { CLIENT_LOG_CONTEXT, type ClientLogContext, type TurbineLogEntry, type TurbineLogger } from '../logger.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { QueryInterface } from '../query/index.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { fakePool } from './fleet-logger-triggers.js';
import { mockTable } from './helpers.js';

const DEV: DiagnosticsEnv = { NODE_ENV: 'development' };
const PROD: DiagnosticsEnv = { NODE_ENV: 'production' };

function isE003(pattern: RegExp): (err: unknown) => boolean {
  return (err) =>
    err instanceof ValidationError &&
    err.code === 'TURBINE_E003' &&
    /Invalid diagnostics option/.test(err.message) &&
    pattern.test(err.message);
}

describe('diagnostics: the mode default', () => {
  it('development unless NODE_ENV is production', () => {
    assert.deepEqual(
      { ...resolveDiagnostics(undefined, DEV) },
      { mode: 'development', advice: true, cacheCheck: 'every-hit' },
    );
    assert.deepEqual(
      { ...resolveDiagnostics(undefined, {}) },
      { mode: 'development', advice: true, cacheCheck: 'every-hit' },
    );
    assert.equal(resolveDiagnostics(undefined, { NODE_ENV: 'test' }).mode, 'development');
    assert.deepEqual(
      { ...resolveDiagnostics(undefined, PROD) },
      { mode: 'production', advice: false, cacheCheck: 'off' },
    );
  });

  it('a runtime with no process is production', () => {
    assert.equal(resolveDiagnostics(undefined, null).mode, 'production');
  });

  it('null is unset', () => {
    assert.equal(resolveDiagnostics(null, PROD).mode, 'production');
  });
});

describe('diagnostics: the option beats NODE_ENV', () => {
  it('a mode string', () => {
    assert.equal(resolveDiagnostics('production', DEV).mode, 'production');
    assert.equal(resolveDiagnostics('production', DEV).advice, false);
    assert.equal(resolveDiagnostics('development', PROD).mode, 'development');
    assert.equal(resolveDiagnostics('development', PROD).cacheCheck, 'every-hit');
  });

  it('per-part overrides on top of a mode, or on top of the NODE_ENV mode', () => {
    assert.deepEqual(
      { ...resolveDiagnostics({ advice: true }, PROD) },
      { mode: 'production', advice: true, cacheCheck: 'off' },
    );
    assert.deepEqual(
      { ...resolveDiagnostics({ mode: 'development', advice: false }, PROD) },
      { mode: 'development', advice: false, cacheCheck: 'every-hit' },
    );
    assert.deepEqual(resolveDiagnostics({ cacheCheck: { sample: 0.5 } }, PROD).cacheCheck, { sample: 0.5 });
    assert.equal(resolveDiagnostics({ cacheCheck: 'off' }, DEV).cacheCheck, 'off');
    assert.equal(resolveDiagnostics({ cacheCheck: 'every-hit' }, PROD).cacheCheck, 'every-hit');
  });
});

describe('diagnostics: the legacy cache-check variables', () => {
  it('TURBINE_DISABLE_CACHE_CHECK=1 turns the check off in either mode', () => {
    assert.equal(resolveDiagnostics(undefined, { ...DEV, TURBINE_DISABLE_CACHE_CHECK: '1' }).cacheCheck, 'off');
    assert.equal(
      resolveDiagnostics(undefined, { ...PROD, TURBINE_DISABLE_CACHE_CHECK: '1', TURBINE_CACHE_CHECK_SAMPLE: '0.5' })
        .cacheCheck,
      'off',
    );
    assert.equal(
      resolveDiagnostics(undefined, { ...DEV, TURBINE_DISABLE_CACHE_CHECK: 'true' }).cacheCheck,
      'every-hit',
    );
  });

  it('TURBINE_CACHE_CHECK_SAMPLE sets a rate in production and is not read in development', () => {
    assert.deepEqual(resolveDiagnostics(undefined, { ...PROD, TURBINE_CACHE_CHECK_SAMPLE: '0.25' }).cacheCheck, {
      sample: 0.25,
    });
    assert.deepEqual(resolveDiagnostics(undefined, { ...PROD, TURBINE_CACHE_CHECK_SAMPLE: '5' }).cacheCheck, {
      sample: 1,
    });
    assert.equal(resolveDiagnostics(undefined, { ...PROD, TURBINE_CACHE_CHECK_SAMPLE: '0' }).cacheCheck, 'off');
    assert.equal(resolveDiagnostics(undefined, { ...PROD, TURBINE_CACHE_CHECK_SAMPLE: '-1' }).cacheCheck, 'off');
    assert.equal(resolveDiagnostics(undefined, { ...PROD, TURBINE_CACHE_CHECK_SAMPLE: 'often' }).cacheCheck, 'off');
    assert.equal(resolveDiagnostics(undefined, { ...DEV, TURBINE_CACHE_CHECK_SAMPLE: '0.25' }).cacheCheck, 'every-hit');
  });

  it('an explicit cacheCheck beats both variables', () => {
    assert.equal(
      resolveDiagnostics({ cacheCheck: 'every-hit' }, { ...PROD, TURBINE_DISABLE_CACHE_CHECK: '1' }).cacheCheck,
      'every-hit',
    );
    assert.deepEqual(
      resolveDiagnostics({ cacheCheck: { sample: 0.1 } }, { ...PROD, TURBINE_CACHE_CHECK_SAMPLE: '0.9' }).cacheCheck,
      { sample: 0.1 },
    );
  });
});

describe('diagnostics: a malformed option is E003', () => {
  for (const [label, value, pattern] of [
    ['an unknown mode', 'staging', /unknown mode "staging"/],
    ['an unknown mode in the object form', { mode: 'test' }, /unknown mode "test"/],
    ['an unknown key', { advise: true }, /unknown key "advise"/],
    ['a non-boolean advice', { advice: 'yes' }, /advice must be a boolean, got "yes"/],
    ['a sample of 0', { cacheCheck: { sample: 0 } }, /sample must be a number in \(0, 1\], got 0/],
    ['a sample above 1', { cacheCheck: { sample: 1.5 } }, /got 1\.5/],
    ['a NaN sample', { cacheCheck: { sample: Number.NaN } }, /got NaN/],
    ['a string sample', { cacheCheck: { sample: '0.5' } }, /got "0\.5"/],
    ['an unknown cacheCheck mode', { cacheCheck: 'always' }, /cacheCheck "always"/],
    ['an extra key beside sample', { cacheCheck: { sample: 0.5, every: 2 } }, /exactly one key, sample/],
    ['a boolean', true, /true/],
    ['a number', 1, /Invalid diagnostics option: 1\./],
    ['an array', ['production'], /an array/],
  ] as const) {
    it(label, () => {
      assert.throws(() => resolveDiagnostics(value, DEV), isE003(pattern));
    });
  }
});

describe('diagnostics: the resolved value', () => {
  it('is frozen, and so is a sampled cacheCheck', () => {
    const r = resolveDiagnostics({ cacheCheck: { sample: 0.5 } }, DEV);
    assert.ok(Object.isFrozen(r));
    assert.ok(Object.isFrozen(r.cacheCheck));
  });

  it('resolving it again hands back the same object without reading the environment', () => {
    const r = resolveDiagnostics('development', DEV);
    assert.equal(resolveDiagnostics(r, PROD), r);
  });

  it('a look-alike object is validated, not trusted', () => {
    assert.throws(
      () => resolveDiagnostics({ mode: 'production', advice: false, cacheCheck: 'off', extra: 1 }, DEV),
      isE003(/unknown key "extra"/),
    );
  });
});

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

function itemsSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      items: mockTable('items', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

const COMPAT_MAP = {
  enums: {},
  models: {
    Item: { table: 'items', accessor: 'items', fields: { id: 'id', name: 'name' }, relations: {}, compoundUniques: {} },
  },
} as unknown as Parameters<typeof createPrismaCompatClient>[1];

function recorder(): { logger: TurbineLogger; codes: string[] } {
  const codes: string[] = [];
  const push = (_message: string, entry: TurbineLogEntry): void => {
    codes.push(entry.code);
  };
  return { logger: { debug: push, info: push, warn: push, error: push }, codes };
}

function logContext(db: TurbineClient): ClientLogContext {
  return (db as unknown as { [CLIENT_LOG_CONTEXT]: ClientLogContext })[CLIENT_LOG_CONTEXT];
}

/** Run `fn` with NODE_ENV set to `value` (or unset), restoring it afterwards. */
async function withNodeEnv<T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

/** Build a client under one NODE_ENV, then issue a compat query with an unknown option under another. */
async function adviceCodes(opts: {
  builtUnder: string | undefined;
  queriedUnder: string | undefined;
  diagnostics?: unknown;
}): Promise<string[]> {
  const { logger, codes } = recorder();
  const { db, compat } = await withNodeEnv(opts.builtUnder, () => {
    const db = new TurbineClient(
      {
        pool: fakePool() as never,
        logger,
        ...(opts.diagnostics !== undefined ? { diagnostics: opts.diagnostics as never } : {}),
      },
      itemsSchema(),
    );
    return { db, compat: createPrismaCompatClient(db, COMPAT_MAP) };
  });
  await withNodeEnv(opts.queriedUnder, async () => {
    await (compat as unknown as Record<string, { findMany(a: unknown): Promise<unknown> }>).Item!.findMany({
      take: 1,
      [`fleetUnknown${Math.random().toString(36).slice(2)}`]: true,
    });
  });
  await db.disconnect();
  return codes.filter((c) => c === 'prisma-compat-unknown-option');
}

describe('diagnostics: the client', () => {
  it('resolves the option once and exposes it to wrappers', () => {
    const db = new TurbineClient(
      { pool: fakePool() as never, diagnostics: { mode: 'production', advice: true } },
      itemsSchema(),
    );
    assert.deepEqual({ ...logContext(db).diagnostics }, { mode: 'production', advice: true, cacheCheck: 'off' });
  });

  it('refuses a malformed option with E003 before any warning is printed', () => {
    const warned: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warned.push(args);
    try {
      assert.throws(
        () =>
          new TurbineClient(
            { pool: fakePool() as never, diagnostics: 'staging' as never, logParams: true } as never,
            itemsSchema(),
          ),
        isE003(/unknown mode "staging"/),
      );
    } finally {
      console.warn = original;
    }
    assert.deepEqual(warned, [], 'the unknown-key warning must not run before diagnostics is validated');
  });

  it("diagnostics: 'production' silences advice under NODE_ENV=development", async () => {
    assert.deepEqual(
      await adviceCodes({ builtUnder: 'development', queriedUnder: 'development', diagnostics: 'production' }),
      [],
    );
  });

  it("diagnostics: 'development' keeps advice under NODE_ENV=production", async () => {
    assert.deepEqual(
      await adviceCodes({ builtUnder: 'production', queriedUnder: 'production', diagnostics: 'development' }),
      ['prisma-compat-unknown-option'],
    );
  });

  it('with no option, NODE_ENV decides', async () => {
    assert.deepEqual(await adviceCodes({ builtUnder: 'development', queriedUnder: 'development' }), [
      'prisma-compat-unknown-option',
    ]);
    assert.deepEqual(await adviceCodes({ builtUnder: 'production', queriedUnder: 'production' }), []);
  });

  it('NODE_ENV is read once, at construction: changing it later changes nothing', async () => {
    assert.deepEqual(await adviceCodes({ builtUnder: 'development', queriedUnder: 'production' }), [
      'prisma-compat-unknown-option',
    ]);
    assert.deepEqual(await adviceCodes({ builtUnder: 'production', queriedUnder: 'development' }), []);
  });

  it('$primary() shares the resolved value by reference', () => {
    const db = new TurbineClient({ pool: fakePool() as never, diagnostics: 'production' }, itemsSchema());
    assert.equal(logContext(db.$primary() as TurbineClient).diagnostics, logContext(db).diagnostics);
  });
});

// ---------------------------------------------------------------------------
// The query interface: advice and the cache self-check follow the option
// ---------------------------------------------------------------------------

/** A query interface over `items` on a pool that answers every query with no rows. */
function itemsInterface(options: Record<string, unknown>): QueryInterface<Record<string, unknown>> {
  return new QueryInterface(fakePool() as never, 'items', itemsSchema(), [], options as never);
}

/** Warm the cache, corrupt the cached SQL, and report whether the next hit was cross-checked. */
function crossChecks(qi: QueryInterface<Record<string, unknown>>): boolean {
  qi.buildFindMany({ where: { name: 'a' }, limit: 1 } as never);
  const cache = (qi as unknown as { sqlTemplateCache: { cache: Map<string, { sql: string }> } }).sqlTemplateCache.cache;
  for (const entry of cache.values()) entry.sql = 'SELECT 1 -- corrupted';
  try {
    qi.buildFindMany({ where: { name: 'b' }, limit: 1 } as never);
    return false;
  } catch (err) {
    assert.match(String((err as Error).message), /SQL cache lockstep violation/);
    return true;
  }
}

/** Codes a query interface logs for an unknown option plus an unordered page. */
async function queryAdvice(options: Record<string, unknown>): Promise<string[]> {
  const { logger, codes } = recorder();
  resetWarnOnce();
  await itemsInterface({ ...options, logger }).findMany({
    limit: 1,
    [`fleetUnknown${Math.random().toString(36).slice(2)}`]: true,
  } as never);
  return codes.filter((c) => c === 'unknown-query-option' || c === 'unordered-page').sort();
}

describe('diagnostics: the query interface', () => {
  it("'production' under NODE_ENV=development: no advice, no cache self-check", async () => {
    await withNodeEnv('development', async () => {
      assert.deepEqual(await queryAdvice({ diagnostics: 'production' }), []);
      assert.equal(crossChecks(itemsInterface({ diagnostics: 'production' })), false);
    });
  });

  it("'development' under NODE_ENV=production: advice and the cache self-check", async () => {
    await withNodeEnv('production', async () => {
      assert.deepEqual(await queryAdvice({ diagnostics: 'development' }), ['unknown-query-option', 'unordered-page']);
      assert.equal(crossChecks(itemsInterface({ diagnostics: 'development' })), true);
    });
  });

  it('per-part overrides: advice on with the check off, and the reverse', async () => {
    assert.deepEqual(await queryAdvice({ diagnostics: { mode: 'production', advice: true } }), [
      'unknown-query-option',
      'unordered-page',
    ]);
    assert.equal(crossChecks(itemsInterface({ diagnostics: { mode: 'production', advice: true } })), false);
    assert.deepEqual(await queryAdvice({ diagnostics: { advice: false } }), []);
    assert.equal(crossChecks(itemsInterface({ diagnostics: { advice: false } })), true);
  });

  it('with no option, NODE_ENV at construction decides, and a later change does not move it', async () => {
    const dev = await withNodeEnv('development', () => itemsInterface({}));
    const prod = await withNodeEnv('production', () => itemsInterface({}));
    await withNodeEnv('production', () => assert.equal(crossChecks(dev), true));
    await withNodeEnv('development', () => assert.equal(crossChecks(prod), false));
  });

  it('a malformed option is E003 at construction', () => {
    assert.throws(() => itemsInterface({ diagnostics: { cacheCheck: { sample: 2 } } }), isE003(/got 2/));
  });

  it("a client's diagnostics reach its table accessors", async () => {
    const { logger, codes } = recorder();
    resetWarnOnce();
    const db = await withNodeEnv(
      'development',
      () => new TurbineClient({ pool: fakePool() as never, logger, diagnostics: 'production' }, itemsSchema()),
    );
    await db.table('items').findMany({ limit: 1, fleetUnknownOption: true } as never);
    assert.deepEqual(
      codes.filter((c) => c === 'unknown-query-option' || c === 'unordered-page'),
      [],
    );
    await db.disconnect();
  });
});
