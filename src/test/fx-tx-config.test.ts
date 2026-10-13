/**
 * turbine-orm: pooler detection reads PGHOST / PGPORT the way node-postgres
 * does, and SQLSTATE 25P02 is a typed error.
 *
 * No database: pools are lazy, nothing connects.
 *
 * Run: npx tsx --test src/test/fx-tx-config.test.ts
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { detectPooler, fillTargetFromEnvironment, parseConnectionTarget } from '../connection-url.js';
import { TransactionRolledBackError, TurbineError, wrapPgError } from '../errors.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: { users: mockTable('users', [{ name: 'id', field: 'id', pgType: 'int4' }]) },
  enums: {},
};

const ENV_KEYS = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER'] as const;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** The client's default for named prepared statements, which is off behind a pooler. */
function named(config: Record<string, unknown>): boolean | undefined {
  const db = new TurbineClient(config, schema);
  const value = (db as unknown as { queryOptions: { preparedStatements?: boolean } }).queryOptions.preparedStatements;
  void db.disconnect();
  return value;
}

describe('fillTargetFromEnvironment', () => {
  it('fills only what the target leaves unset', () => {
    assert.deepEqual(fillTargetFromEnvironment({ host: null, port: null }, { host: 'DB.Example', port: '6543' }), {
      host: 'db.example',
      port: 6543,
    });
    assert.deepEqual(fillTargetFromEnvironment({ host: 'url.host', port: null }, { host: 'env.host', port: '6543' }), {
      host: 'url.host',
      port: 6543,
    });
    assert.deepEqual(fillTargetFromEnvironment({ host: null, port: 5432 }, { host: 'env.host', port: '6543' }), {
      host: 'env.host',
      port: 5432,
    });
  });

  it('ignores what is not a port or a host', () => {
    assert.deepEqual(fillTargetFromEnvironment({ host: null, port: null }, { host: '  ', port: 'abc' }), {
      host: null,
      port: null,
    });
    assert.deepEqual(fillTargetFromEnvironment({ host: null, port: null }, {}), { host: null, port: null });
  });

  it('detectPooler with an environment sees the target pg would connect to', () => {
    const url = 'postgresql://u@db.internal/app';
    assert.equal(detectPooler(url).pooled, false);
    assert.equal(detectPooler(url, { port: '6432' }).pooled, true, 'PGPORT is the pooler port');
    assert.equal(detectPooler('postgresql:///app', { host: 'ep-x-pooler.eu.neon.tech' }).pooled, true);
    assert.equal(detectPooler('postgresql://u@db.internal:5432/app', { port: '6432' }).pooled, false, 'the URL wins');
    assert.deepEqual(parseConnectionTarget('postgresql:///app'), { host: null, port: null });
  });
});

describe('preparedStatements defaults off behind a pooler named by the environment', () => {
  it('PGHOST naming a pooler, with no connection string', () => {
    process.env.PGHOST = 'ep-cool-pooler.us-east-2.aws.neon.tech';
    assert.equal(named({}), false);
  });

  it('PGPORT naming a pooler port, with no connection string', () => {
    process.env.PGHOST = 'db.internal';
    process.env.PGPORT = '6543';
    assert.equal(named({}), false);
    process.env.PGPORT = '6432';
    assert.equal(named({}), false);
  });

  it('host settings that leave the host or the port to the environment', () => {
    process.env.PGHOST = 'aws-0-eu.pooler.supabase.com';
    assert.equal(named({ database: 'app' }), false, 'only a database given: the host is PGHOST');
    assert.equal(named({ port: 5432 }), false, 'only a port given: the host is PGHOST');
    delete process.env.PGHOST;
    process.env.PGPORT = '6543';
    assert.equal(named({ host: 'db.internal' }), false, 'only a host given: the port is PGPORT');
  });

  it('a DATABASE_URL or connection string that names no port leaves it to PGPORT', () => {
    process.env.PGPORT = '6432';
    assert.equal(named({ connectionString: 'postgresql://u@db.internal/app' }), false);
    process.env.DATABASE_URL = 'postgresql://u@db.internal/app';
    assert.equal(named({}), false);
  });

  it('a replica string is read the same way', () => {
    process.env.PGPORT = '6543';
    assert.equal(
      named({ connectionString: 'postgresql://u@db.internal:5432/app', replicas: ['postgresql://u@r.internal/app'] }),
      false,
    );
  });

  it('what the configuration names wins over the environment', () => {
    process.env.PGHOST = 'ep-cool-pooler.us-east-2.aws.neon.tech';
    process.env.PGPORT = '6543';
    assert.equal(named({ connectionString: 'postgresql://u@db.internal:5432/app' }), true, 'the URL names both');
    assert.equal(named({ host: 'db.internal', port: 5432 }), true, 'the settings name both');
  });

  it('a direct environment keeps named statements', () => {
    process.env.PGHOST = 'db.internal';
    process.env.PGPORT = '5432';
    assert.equal(named({}), true);
    delete process.env.PGHOST;
    delete process.env.PGPORT;
    assert.equal(named({ host: 'db.internal' }), true);
  });

  it('an explicit preparedStatements: true still warns, naming the endpoint the environment gave', () => {
    resetWarnOnce('preparedStatementsOnPooler');
    process.env.PGHOST = 'db.internal';
    process.env.PGPORT = '6543';
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      assert.equal(named({ preparedStatements: true }), true);
    } finally {
      console.warn = warn;
    }
    assert.equal(warnings.length, 1, warnings.join('\n'));
    assert.match(warnings[0] as string, /db\.internal:6543, which looks like a connection pooler/);
  });
});

describe('SQLSTATE 25P02', () => {
  const pg25P02 = Object.assign(
    new Error('current transaction is aborted, commands ignored until end of transaction block'),
    { code: '25P02', severity: 'ERROR' },
  );

  it('is E019, with the driver error as cause, not an untyped driver error', () => {
    const wrapped = wrapPgError(pg25P02);
    assert.ok(wrapped instanceof TransactionRolledBackError, String(wrapped));
    assert.ok(wrapped instanceof TurbineError);
    assert.equal(wrapped.code, 'TURBINE_E019');
    assert.equal(wrapped.cause, pg25P02);
    assert.equal('isRetryable' in wrapped, false);
    assert.match(wrapped.message, /after an earlier statement in the same transaction failed/);
    assert.match(wrapped.message, /nested `tx\.\$transaction/);
  });

  it('wrapping an already wrapped error changes nothing', () => {
    const once = wrapPgError(pg25P02);
    assert.equal(wrapPgError(once), once);
  });
});
