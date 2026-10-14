/**
 * turbine-orm: `preparedStatements: true` on a SUPPLIED pool behind a pooler
 * warns (0.90.2)
 *
 * `prepared-statements-on-pooler` used to fire only for a pool Turbine opens,
 * because only its connection settings were read. A `pg.Pool` keeps its own on
 * `pool.options`, so a supplied pool is now read the same way. Measured behind
 * PgBouncer 1.26 in transaction mode with `max_prepared_statements = 0`, a
 * supplied pool with `preparedStatements: true` failed 185 of 200 concurrent
 * named reads (E004, 42P05 / 26000), with no warning at construction. The
 * default (unnamed for a supplied pool) is unchanged and does not warn.
 *
 * Run: npx tsx --test src/test/supplied-pool-pooler-warning.test.ts
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { TurbineLogEntry, TurbineLogger } from '../logger.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: { items: mockTable('items', [{ name: 'id', field: 'id' }]) },
};

function capture(): { logger: TurbineLogger; codes: () => string[]; endpoints: () => unknown[] } {
  const entries: TurbineLogEntry[] = [];
  return {
    logger: { warn: (_message: string, entry: TurbineLogEntry) => entries.push(entry) },
    codes: () => entries.map((e) => e.code),
    endpoints: () => entries.filter((e) => e.code === 'prepared-statements-on-pooler').map((e) => e.endpoint),
  };
}

const pools: pg.Pool[] = [];
function pool(config: pg.PoolConfig): pg.Pool {
  // Constructed, never connected: pg.Pool opens nothing until a query.
  const p = new pg.Pool(config);
  pools.push(p);
  return p;
}

afterEach(async () => {
  resetWarnOnce();
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

describe('a supplied pool behind a pooler', () => {
  it('warns when preparedStatements is turned on (connection string)', () => {
    const log = capture();
    new TurbineClient(
      {
        pool: pool({ connectionString: 'postgresql://app@db-pooler.example.com:6543/app' }),
        preparedStatements: true,
        logger: log.logger,
      },
      SCHEMA,
    );
    assert.deepEqual(log.endpoints(), ['db-pooler.example.com:6543']);
  });

  it('warns for host and port settings, PgBouncer port 6432 included', () => {
    const log = capture();
    new TurbineClient(
      { pool: pool({ host: 'db.internal', port: 6432 }), preparedStatements: true, logger: log.logger },
      SCHEMA,
    );
    assert.deepEqual(log.endpoints(), ['db.internal:6432']);
  });

  it('stays quiet at the default, which already sends unnamed statements', () => {
    const log = capture();
    new TurbineClient(
      { pool: pool({ connectionString: 'postgresql://app@db-pooler.example.com:6543/app' }), logger: log.logger },
      SCHEMA,
    );
    assert.deepEqual(log.codes(), []);
  });

  it('stays quiet for a direct endpoint', () => {
    const log = capture();
    new TurbineClient(
      {
        pool: pool({ connectionString: 'postgresql://app@db.example.com:5432/app' }),
        preparedStatements: true,
        logger: log.logger,
      },
      SCHEMA,
    );
    assert.deepEqual(log.codes(), []);
  });

  it('stays quiet for a pool that exposes no settings, and never fails construction', () => {
    const log = capture();
    const opaque = { query: async () => ({ rows: [] }), connect: async () => ({}), end: async () => {} };
    const throwing = new Proxy(opaque, {
      get(target, key) {
        if (key === 'options') throw new Error('no settings here');
        return Reflect.get(target, key);
      },
    });
    // `options` itself readable, its fields not (a revoked proxy).
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const fieldsThrow = { ...opaque, options: revoked.proxy };
    for (const pool of [opaque, throwing, fieldsThrow]) {
      for (const preparedStatements of [true, undefined]) {
        // biome-ignore lint/suspicious/noExplicitAny: driver-neutral pools
        new TurbineClient({ pool: pool as any, preparedStatements, logger: log.logger }, SCHEMA);
      }
    }
    assert.deepEqual(log.codes(), []);
  });

  it('never reads the pool when prepared statements are not turned on', () => {
    let reads = 0;
    const watched = new Proxy(new pg.Pool({ connectionString: 'postgresql://app@db-pooler.example.com:6543/app' }), {
      get(target, key, receiver) {
        if (key === 'options') reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    pools.push(watched);
    new TurbineClient({ pool: watched, logger: capture().logger }, SCHEMA);
    assert.equal(reads, 0);
  });
});
