/**
 * turbine-orm: a client given no database says so, with the fix.
 *
 * With no `pool`, no connection string, no host settings and no DATABASE_URL,
 * the client used to connect to a guessed `postgres@localhost:5432/postgres`,
 * so a missing `.env` surfaced one query later as ECONNREFUSED or "role
 * postgres does not exist". Now the first query (and every checkout) rejects
 * with ConnectionError E004 naming DATABASE_URL and how to load `.env`.
 * Constructing still succeeds, so a build step that imports the client module
 * without a database keeps working, and building SQL needs no database.
 *
 * The standard PG* variables pg reads were also overridden by those guessed
 * defaults; a field the environment sets is now left for pg to read.
 *
 * No database: every case here is decided before a socket would open.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ConnectionError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const ENV_KEYS = ['DATABASE_URL', 'PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER'] as const;

function schema(): SchemaMetadata {
  return { enums: {}, tables: { users: mockTable('users', [{ name: 'id', field: 'id' }]) } };
}

function noDatabase(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ConnectionError, `expected ConnectionError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E004');
    assert.match(err.message, /No database configured/);
    assert.match(err.message, pattern, err.message);
    assert.match(err.message, /does not read `\.env` files/);
    assert.match(err.message, /--env-file=\.env/);
    return true;
  };
}

/** The config pg was handed, for the cases that do build a real pool. */
function poolOptions(db: TurbineClient): Record<string, unknown> {
  return (db as unknown as { pool: { options: Record<string, unknown> } }).pool.options;
}

describe('no database configured', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('constructs, builds SQL, and rejects the first query with the fix', async () => {
    const db = new TurbineClient({}, schema());
    const users = db.table('users');
    assert.match(users.buildCount().sql, /count/i, 'building SQL needs no database');
    const why = noDatabase(/DATABASE_URL environment variable is not set/);
    await assert.rejects(users.count(), why);
    await assert.rejects(db.raw`SELECT 1`, why);
    await assert.rejects(
      db.$transaction(async () => 1),
      why,
    );
    await assert.rejects(db.pipeline([users.buildCount()]), why);
    await assert.rejects(db.connect(), why);
    await db.disconnect();
  });

  it('an empty connectionString is named as the cause', async () => {
    const db = new TurbineClient({ connectionString: '' }, schema());
    await assert.rejects(db.table('users').count(), noDatabase(/`connectionString` is an empty string/));
    await db.disconnect();
  });

  it('a PG* variable is a database target, and pg reads it rather than a guessed default', async () => {
    process.env.PGHOST = 'pg.example.internal';
    process.env.PGUSER = 'app';
    const db = new TurbineClient({ database: 'appdb' }, schema());
    const options = poolOptions(db);
    assert.equal(options.host, undefined, 'PGHOST is left for pg to read');
    assert.equal(options.user, undefined, 'PGUSER is left for pg to read');
    assert.equal(options.database, 'appdb');
    assert.equal(options.port, 5432, 'no PGPORT, so the default still applies');
    await db.disconnect();
  });

  it('PG* variables alone are enough', async () => {
    process.env.PGDATABASE = 'fromenv';
    const db = new TurbineClient({}, schema());
    assert.equal(poolOptions(db).database, undefined);
    await db.disconnect();
  });

  it('DATABASE_URL is still the default target', async () => {
    process.env.DATABASE_URL = 'postgres://u:p@db.example.internal:5432/app';
    const db = new TurbineClient({}, schema());
    assert.equal(poolOptions(db).connectionString, 'postgres://u:p@db.example.internal:5432/app');
    await db.disconnect();
  });

  it('explicit host settings keep the documented defaults', async () => {
    const db = new TurbineClient({ host: 'db.example.internal' }, schema());
    const options = poolOptions(db);
    assert.equal(options.host, 'db.example.internal');
    assert.equal(options.user, 'postgres');
    assert.equal(options.database, 'postgres');
    await db.disconnect();
  });
});
