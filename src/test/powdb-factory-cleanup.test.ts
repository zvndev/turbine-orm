/**
 * `turbinePowDB` closes what it opened when a later step throws, and only that.
 *
 * The factory builds a networked pool (a URL or a host and port) or opens an
 * embedded database handle, then probes the server version and constructs the
 * client. When either of those later steps refuses (a server below the version
 * floor, or the client constructor rejecting a config such as a static global
 * filter that names no table) the caller receives an exception and no client,
 * so nothing else can close what the factory built. A networked pool left open
 * keeps the process alive; an embedded handle is never flushed.
 *
 * A pool or handle the caller supplied is theirs and must stay open.
 *
 * No database or PowDB install is needed: the client and embedded modules are
 * injected as doubles that count `close()`.
 *
 * Run: npx tsx --test src/test/powdb-factory-cleanup.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConnectionError, ValidationError } from '../errors.js';
import { capabilitiesFromVersion, PowdbPool, turbinePowDB } from '../powdb.js';
import type { SchemaMetadata } from '../schema.js';

// biome-ignore lint/suspicious/noExplicitAny: driver doubles are loosely typed.
type Any = any;

const EMPTY: SchemaMetadata = { tables: {}, enums: {} };

/** A static global filter naming no table: refused by the client CONSTRUCTOR (E003). */
const REFUSED_CONFIG = { globalFilters: { noSuchTable: { id: 1 } }, warnOnUnlimited: false } as Any;

// ---------------------------------------------------------------------------
// Networked: doubles for @zvndev/powdb-client
// ---------------------------------------------------------------------------

/** The pool class of a fake client module, plus how many pools it built and closed. */
function fakeClientModule(version: string) {
  const counter = { built: 0, closes: 0 };
  class FakePool {
    constructor(_options: unknown) {
      counter.built++;
    }
    async acquire() {
      return {} as never;
    }
    release() {}
    destroy() {}
    async withClient<T>(fn: (c: Any) => Promise<T>) {
      return fn({ serverVersion: version, query: async () => ({}) });
    }
    async close() {
      counter.closes++;
    }
  }
  return { counter, mod: { Client: { connect: async () => ({}) }, Pool: FakePool } as Any };
}

/** A pool the CALLER built: same shape the factory accepts for injection. */
function callerClientPool(version: string, counter: { closes: number }) {
  return {
    acquire: async () => ({}) as never,
    release() {},
    destroy() {},
    withClient: async <T>(fn: (c: Any) => Promise<T>) => fn({ serverVersion: version, query: async () => ({}) }),
    close: async () => {
      counter.closes++;
    },
  };
}

describe('turbinePowDB closes a networked pool it built when a later step throws', () => {
  const TARGETS: [string, Any][] = [
    ['a connection URL', 'powdb://127.0.0.1:1'],
    ['a host and port', { host: '127.0.0.1', port: 1 }],
  ];

  for (const [label, target] of TARGETS) {
    it(`${label}: the client constructor refusing the config`, async () => {
      const { mod, counter } = fakeClientModule('0.20.0');
      await assert.rejects(
        () => turbinePowDB(target, EMPTY, { ...REFUSED_CONFIG, powdbClientModule: mod }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, String(err));
          assert.match((err as Error).message, /noSuchTable/);
          return true;
        },
      );
      assert.equal(counter.built, 1, 'the factory built one pool');
      assert.equal(counter.closes, 1, 'and closed it');
    });

    it(`${label}: a server below the version floor`, async () => {
      const { mod, counter } = fakeClientModule('0.1.0');
      await assert.rejects(
        () => turbinePowDB(target, EMPTY, { warnOnUnlimited: false, powdbClientModule: mod } as Any),
        (err: unknown) => {
          assert.ok(err instanceof ConnectionError, String(err));
          return true;
        },
      );
      assert.equal(counter.built, 1);
      assert.equal(counter.closes, 1, 'the probe refused the server, so the pool is closed');
    });

    it(`${label}: a close() that rejects does not hide the original error`, async () => {
      const { mod, counter } = fakeClientModule('0.1.0');
      mod.Pool.prototype.close = async () => {
        counter.closes++;
        throw new Error('close failed');
      };
      await assert.rejects(
        () => turbinePowDB(target, EMPTY, { warnOnUnlimited: false, powdbClientModule: mod } as Any),
        ConnectionError,
      );
      assert.equal(counter.closes, 1);
    });
  }

  it('a successful call leaves the pool open until disconnect() closes it once', async () => {
    const { mod, counter } = fakeClientModule('0.20.0');
    const db = await turbinePowDB('powdb://127.0.0.1:1', EMPTY, { warnOnUnlimited: false, powdbClientModule: mod });
    assert.equal(counter.closes, 0, 'nothing is closed on success');
    await db.disconnect();
    assert.equal(counter.closes, 1);
  });
});

describe('turbinePowDB never closes a networked pool the caller supplied', () => {
  it('a client pool, when the client constructor refuses the config', async () => {
    const counter = { closes: 0 };
    await assert.rejects(
      () => turbinePowDB(callerClientPool('0.20.0', counter) as Any, EMPTY, REFUSED_CONFIG),
      ValidationError,
    );
    assert.equal(counter.closes, 0);
  });

  it('a client pool, when the probe refuses the server version', async () => {
    const counter = { closes: 0 };
    await assert.rejects(
      () => turbinePowDB(callerClientPool('0.1.0', counter) as Any, EMPTY, { warnOnUnlimited: false } as Any),
      ConnectionError,
    );
    assert.equal(counter.closes, 0);
  });

  it('a PowdbPool, when the client constructor refuses the config', async () => {
    const counter = { closes: 0 };
    const wrapped = new PowdbPool(callerClientPool('0.20.0', counter) as Any, undefined, {
      capabilities: capabilitiesFromVersion('0.20.0'),
    });
    await assert.rejects(() => turbinePowDB(wrapped, EMPTY, REFUSED_CONFIG), ValidationError);
    assert.equal(counter.closes, 0);
  });
});

// ---------------------------------------------------------------------------
// Embedded: doubles for @zvndev/powdb-embedded
// ---------------------------------------------------------------------------

/** An embedded module whose handles count `close()`. `close` may be absent (an older addon) or throw. */
function fakeEmbeddedModule(
  options: { setSyncMode?: boolean; setSyncModeThrows?: boolean; close?: 'ok' | 'absent' | 'throws' } = {},
) {
  const counter = { opened: 0, closes: 0 };
  const closeKind = options.close ?? 'ok';
  const db: Record<string, unknown> = {
    query: () => ({ kind: 'ok', affected: 0n }),
    querySql: () => ({ kind: 'message', message: '' }),
    queryReadonly: () => ({ kind: 'message', message: '' }),
    isPoisoned: () => false,
    queryWithParams: () => ({ kind: 'ok', affected: 0n }),
  };
  if (options.setSyncMode ?? true) {
    db.setSyncMode = () => {
      if (options.setSyncModeThrows) throw new Error('sync mode refused by the engine');
    };
  }
  if (closeKind !== 'absent') {
    db.close = () => {
      counter.closes++;
      if (closeKind === 'throws') throw new Error('close failed');
    };
  }
  const Database = {
    open: (_dir: string) => {
      counter.opened++;
      return db;
    },
  };
  return { counter, mod: { Database } as Any };
}

describe('turbinePowDB closes an embedded handle it opened when a later step throws', () => {
  const options = (mod: Any, extra: Record<string, unknown> = {}) =>
    ({ powdbEmbeddedModule: mod, assumeEngineVersion: '0.14.0', warnOnUnlimited: false, ...extra }) as Any;

  it('the client constructor refusing the config', async () => {
    const { mod, counter } = fakeEmbeddedModule();
    await assert.rejects(
      () => turbinePowDB({ embedded: '/data/a' }, EMPTY, options(mod, REFUSED_CONFIG)),
      ValidationError,
    );
    assert.equal(counter.opened, 1);
    assert.equal(counter.closes, 1, 'the handle the factory opened is closed');
  });

  it('a syncMode the installed addon cannot apply', async () => {
    const { mod, counter } = fakeEmbeddedModule({ setSyncMode: false });
    await assert.rejects(
      () => turbinePowDB({ embedded: '/data/a', syncMode: 'normal' }, EMPTY, options(mod)),
      (err: unknown) => {
        assert.ok(err instanceof ConnectionError, String(err));
        assert.match((err as Error).message, /syncMode/);
        return true;
      },
    );
    assert.equal(counter.closes, 1);
  });

  it('a setSyncMode that throws surfaces its own error, and the handle is closed', async () => {
    const { mod, counter } = fakeEmbeddedModule({ setSyncModeThrows: true });
    await assert.rejects(
      () => turbinePowDB({ embedded: '/data/a', syncMode: 'off' }, EMPTY, options(mod)),
      /sync mode refused by the engine/,
    );
    assert.equal(counter.closes, 1);
  });

  it('a close() that throws does not hide the original error', async () => {
    const { mod, counter } = fakeEmbeddedModule({ close: 'throws' });
    await assert.rejects(
      () => turbinePowDB({ embedded: '/data/a' }, EMPTY, options(mod, REFUSED_CONFIG)),
      ValidationError,
    );
    assert.equal(counter.closes, 1);
  });

  it('an addon without close() still reports the original error', async () => {
    const { mod, counter } = fakeEmbeddedModule({ close: 'absent' });
    await assert.rejects(
      () => turbinePowDB({ embedded: '/data/a' }, EMPTY, options(mod, REFUSED_CONFIG)),
      ValidationError,
    );
    assert.equal(counter.closes, 0);
  });

  it('a successful call leaves the handle open until disconnect() closes it once', async () => {
    const { mod, counter } = fakeEmbeddedModule();
    const db = await turbinePowDB({ embedded: '/data/a' }, EMPTY, options(mod));
    assert.equal(counter.closes, 0, 'nothing is closed on success');
    await db.disconnect();
    assert.equal(counter.closes, 1);
  });
});
