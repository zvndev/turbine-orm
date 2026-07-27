/**
 * Unknown `TurbineConfig` keys are named in dev, never thrown on.
 *
 * A JavaScript object has no schema, so a config key nobody reads is simply
 * ignored. That makes a typo (or a plausible guess at an option name that does
 * not exist, `logParams` for `logQueryParams`) indistinguishable from a broken
 * feature: nothing happens, and the reasonable conclusion is that the feature
 * does not work rather than that the key is spelled differently.
 *
 * The constructor now names the key and suggests the closest real one. The bar
 * these tests hold it to is two-sided: it has to FIRE on a wrong key, and it
 * must not fire on any legitimate construction path, because a false positive
 * on a real app's startup is worse than the original silence. So every engine
 * factory, the serverless entry, the prisma-compat wrapper, and `$primary()`
 * are CONSTRUCTED here and asserted silent, not reasoned about.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it, it as nodeIt } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { MssqlPool, turbineMssql } from '../mssql.js';
import { MysqlPool, turbineMysql } from '../mysql.js';
import { turbinePowDB } from '../powdb.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { turbineHttp } from '../serverless.js';
import { turbineSqlite } from '../sqlite.js';
import { mockTable } from './helpers.js';

// `node:sqlite` is a builtin only on Node >= 22.5; probe without a static
// import so this file loads (and skips cleanly) on Node 20.
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const sqliteIt: typeof nodeIt = DatabaseSync
  ? nodeIt
  : (((name: string) =>
      nodeIt(name, { skip: 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof nodeIt);

function probeSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      cfg_probe: mockTable('cfg_probe', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

/** A pg-compatible pool that is never actually queried by these tests. */
function idlePool(): PgCompatPool {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    end: async () => {},
  } as unknown as PgCompatPool;
}

/**
 * Run `fn` with `console.warn` captured, from a clean warn registry (the
 * warning is once-per-key PROCESS-wide, so without the reset the second test to
 * use a given key would see nothing).
 */
async function captureWarnings(fn: () => unknown | Promise<unknown>): Promise<string[]> {
  resetWarnOnce(WARN_NS.unknownConfigKey);
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines.filter((l) => l.includes('Unknown option'));
}

// ---------------------------------------------------------------------------
// The warning itself
// ---------------------------------------------------------------------------

describe('TurbineConfig: unknown keys are named', () => {
  it('names the key and suggests the real one (logParams → logQueryParams)', async () => {
    const warnings = await captureWarnings(() => {
      new TurbineClient({ pool: idlePool(), logParams: true } as never, probeSchema());
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"logParams"/);
    assert.match(warnings[0]!, /Did you mean "logQueryParams"\?/);
    assert.match(warnings[0]!, /ignored/);
  });

  it('warns once per key, however many clients are built', async () => {
    const warnings = await captureWarnings(() => {
      for (let i = 0; i < 3; i++) new TurbineClient({ pool: idlePool(), logParams: true } as never, probeSchema());
    });
    assert.equal(warnings.length, 1);
  });

  it('names a key with no plausible match, without inventing a suggestion', async () => {
    // The other spelling reached for in the field. Nothing in the config
    // surface is close enough to `redactParams` to be worth guessing, so the
    // message must still name the key and stop there.
    const warnings = await captureWarnings(() => {
      new TurbineClient({ pool: idlePool(), redactParams: false } as never, probeSchema());
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"redactParams"/);
  });

  it('reports every unknown key, once each', async () => {
    const warnings = await captureWarnings(() => {
      new TurbineClient({ pool: idlePool(), logParams: true, deffaultLimit: 5 } as never, probeSchema());
    });
    assert.equal(warnings.length, 2);
    assert.ok(warnings.some((w) => w.includes('"logParams"')));
    assert.ok(warnings.some((w) => w.includes('"deffaultLimit"') && w.includes('Did you mean "defaultLimit"?')));
  });

  it('says nothing about known keys', async () => {
    const warnings = await captureWarnings(() => {
      new TurbineClient(
        {
          pool: idlePool(),
          logging: false,
          logQueryParams: true,
          errorMessages: 'verbose',
          defaultLimit: 10,
          warnOnUnlimited: false,
          utcTimestamps: true,
          scopedConnect: true,
          relationLoadStrategy: 'batched',
          stableRelationOrder: true,
          implicitPkOrdering: true,
          autoToOneJoinMaxRows: 100,
          autoRoundTripMs: 0.5,
          jsonEncoding: 'object',
          preparedStatements: false,
          sqlCache: true,
          sqlCacheSize: 10,
          globalFilters: {},
          replicas: [],
        },
        probeSchema(),
      );
    });
    assert.deepEqual(warnings, []);
  });

  it('is silent in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const warnings = await captureWarnings(() => {
        new TurbineClient({ pool: idlePool(), logParams: true } as never, probeSchema());
      });
      assert.deepEqual(warnings, []);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('never throws, whatever the config object is', async () => {
    // A forward-compatible app built against a NEWER turbine must keep running
    // on this one, and an exotic config object must not take the constructor
    // down either: this Proxy throws from `ownKeys`, the one operation the
    // check performs.
    const hostile = new Proxy(
      { pool: idlePool() },
      {
        ownKeys() {
          throw new Error('ownKeys is not available');
        },
      },
    );
    const warnings = await captureWarnings(() => {
      const db = new TurbineClient(hostile as never, probeSchema());
      assert.ok(db.table('cfg_probe'), 'the client is fully constructed');
      new TurbineClient({ pool: idlePool(), someOptionFromTheFuture: true } as never, probeSchema());
    });
    assert.equal(warnings.length, 1, 'the future key is named, and nothing threw');
  });

  it('$primary() does not warn on its internal seed config', async () => {
    const db = new TurbineClient({ pool: idlePool() }, probeSchema());
    const warnings = await captureWarnings(() => db.$primary());
    assert.deepEqual(warnings, []);
  });
});

// ---------------------------------------------------------------------------
// No false positives: every construction path, actually constructed
// ---------------------------------------------------------------------------

describe('TurbineConfig: legitimate construction paths stay silent', () => {
  sqliteIt('turbineSqlite, including its own pragma options', async () => {
    const warnings = await captureWarnings(async () => {
      const handle = new DatabaseSync!(':memory:');
      handle.exec('CREATE TABLE cfg_probe (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      const db = turbineSqlite(handle, probeSchema(), {
        wal: false,
        busyTimeoutMs: 100,
        foreignKeys: false,
        logQueryParams: true,
      });
      await db.disconnect();
    });
    assert.deepEqual(warnings, []);
  });

  sqliteIt('but an unknown key passed to an engine factory IS named', async () => {
    // The silence above has to be the check running and finding nothing, not
    // the check never reaching the engine path at all.
    const warnings = await captureWarnings(async () => {
      const db = turbineSqlite(new DatabaseSync!(':memory:'), probeSchema(), { logParams: true } as never);
      await db.disconnect();
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"logParams".*Did you mean "logQueryParams"\?/);
  });

  it('turbineMysql, including connectionLimit', async () => {
    const warnings = await captureWarnings(async () => {
      const db = await turbineMysql(fakeMysqlPool(), probeSchema(), {
        connectionLimit: 3,
        logQueryParams: true,
      });
      await db.disconnect();
    });
    assert.deepEqual(warnings, []);
  });

  it('turbineMssql, including its `schema` option', async () => {
    const warnings = await captureWarnings(async () => {
      await turbineMssql(fakeMssqlPool(), probeSchema(), { schema: 'sales', logQueryParams: true });
    });
    assert.deepEqual(warnings, []);
  });

  it('turbinePowDB, whose config carries the internal queryInterfaceFactory', async () => {
    const warnings = await captureWarnings(async () => {
      const db = await turbinePowDB(
        fakePowdbClientPool() as never,
        { tables: {}, enums: {} },
        {
          warnOnUnlimited: false,
        },
      );
      await db.disconnect();
    });
    assert.deepEqual(warnings, []);
  });

  it('turbineHttp (serverless entry)', async () => {
    const warnings = await captureWarnings(() => {
      turbineHttp(idlePool(), probeSchema(), { logging: false, defaultLimit: 25 });
    });
    assert.deepEqual(warnings, []);
  });

  it('a client wrapped by prisma-compat', async () => {
    const warnings = await captureWarnings(() => {
      const db = new TurbineClient({ pool: idlePool(), implicitPkOrdering: true }, probeSchema());
      const map: PrismaCompatMap = {
        enums: {},
        models: {
          CfgProbe: {
            table: 'cfg_probe',
            accessor: 'cfgProbe',
            fields: { id: 'id', name: 'name' },
            relations: {},
            compoundUniques: {},
          },
        },
      };
      const compat = createPrismaCompatClient(db, map, { stablePkOrder: true });
      assert.ok(compat.CfgProbe, 'the delegate exists');
    });
    assert.deepEqual(warnings, []);
  });

  it('a config object spread from a turbine.config file (schema / url) stays silent', async () => {
    // `turbine.config.ts` carries a Postgres schema NAME and a `url` for the
    // CLI, and that object is routinely spread into the client factory. The
    // client ignores both; warning about them would be pure noise.
    const warnings = await captureWarnings(() => {
      new TurbineClient({ pool: idlePool(), schema: 'public', url: 'postgres://x/y' } as never, probeSchema());
    });
    assert.deepEqual(warnings, []);
  });
});

// ---------------------------------------------------------------------------
// Driver fakes, so every engine is constructed for real on any machine
// ---------------------------------------------------------------------------

/**
 * The slice of a mysql2 pool the factory touches: the `SELECT VERSION()` probe
 * (via `query`, which returns `[rows]`), plus the pool lifecycle methods
 * `isMysql2Pool` looks for.
 */
function fakeMysqlPool(): MysqlPool {
  const raw = {
    query: async () => [[{ v: '8.0.36' }]],
    execute: async () => [[]],
    getConnection: async () => ({ release: () => {} }),
    end: async () => {},
  };
  return new MysqlPool(raw as unknown as ConstructorParameters<typeof MysqlPool>[0]);
}

/**
 * The slice of an `mssql` ConnectionPool the factory touches: `request()` and
 * `close()`. The version probe reads `recordset[0].v`, so report SQL Server 2022.
 */
function fakeMssqlPool(): MssqlPool {
  const raw = {
    request: () => ({
      input: () => {},
      query: async (text: string) => ({
        recordset: /ProductMajorVersion/.test(text) ? [{ v: 16 }] : [],
        rowsAffected: [0],
      }),
    }),
    close: async () => {},
  };
  return new MssqlPool(raw as unknown as ConstructorParameters<typeof MssqlPool>[0], {} as never);
}

/** A fake `@zvndev/powdb-client` pool: one client, enough for the version probe. */
function fakePowdbClientPool() {
  const client = {
    serverVersion: '0.8.0',
    query: async () => ({ kind: 'message', message: 'ok' }),
    close: async () => {},
  };
  return {
    acquire: async () => client,
    release() {},
    destroy() {},
    withClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    close: async () => {},
  };
}
