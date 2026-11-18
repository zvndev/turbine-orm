/**
 * turbine-orm: Prisma's connection-string parameters (`schema`,
 * `connection_limit`, `pool_timeout`) are honoured, not dropped.
 *
 * node-postgres ignores all three without a word, so a `DATABASE_URL` carried
 * over from Prisma with `?schema=tenant_a` queried `public`. The unit half pins
 * the reader and the pool configuration; the live half (gated on
 * `DATABASE_URL`) proves a query really runs in the named schema.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { readPrismaUrlParameters } from '../connection-url.js';
import { ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL;
const live = skipGate(!url, 'DATABASE_URL not set');

const EMPTY = { enums: {}, tables: {} };

function poolOptions(db: TurbineClient): { max?: number; connectionTimeoutMillis?: number; connectionString?: string } {
  return (db as unknown as { pool: { options: Record<string, never> } }).pool.options;
}

describe('readPrismaUrlParameters', () => {
  it('returns null for a string with none of the parameters, so it passes through untouched', () => {
    assert.equal(readPrismaUrlParameters('postgres://u:p@h:5432/db'), null);
    assert.equal(readPrismaUrlParameters('postgres://u:p@h:5432/db?sslmode=require'), null);
  });

  it('reads and strips all three, keeping every other parameter and the userinfo byte-for-byte', () => {
    const out = readPrismaUrlParameters(
      'postgres://us%40er:p%3Fss@h:5432/db?sslmode=require&schema=tenant_a&connection_limit=7&pool_timeout=20',
    );
    assert.deepEqual(out, {
      connectionString: 'postgres://us%40er:p%3Fss@h:5432/db?sslmode=require',
      schema: 'tenant_a',
      connectionLimit: 7,
      poolTimeoutMs: 20_000,
    });
    assert.equal(readPrismaUrlParameters('postgres://h/db?schema=x')?.connectionString, 'postgres://h/db');
    assert.equal(readPrismaUrlParameters('postgres://h/db?pool_timeout=0')?.poolTimeoutMs, 0);
  });

  it('names an invalid value instead of guessing', () => {
    for (const [query, re] of [
      ['connection_limit=0', /connection_limit/],
      ['connection_limit=abc', /connection_limit/],
      ['pool_timeout=-1', /pool_timeout/],
      ['pool_timeout=1.5', /pool_timeout/],
    ] as const) {
      assert.match(readPrismaUrlParameters(`postgres://h/db?${query}`)?.invalid ?? '', re, query);
    }
  });
});

describe('TurbineClient with Prisma URL parameters', () => {
  it('connection_limit sizes the pool and pool_timeout sets the checkout timeout', async () => {
    const db = new TurbineClient(
      { connectionString: 'postgres://u:p@localhost:5432/db?connection_limit=3&pool_timeout=12' },
      EMPTY,
    );
    const options = poolOptions(db);
    assert.equal(options.max, 3);
    assert.equal(options.connectionTimeoutMillis, 12_000);
    assert.equal(options.connectionString, 'postgres://u:p@localhost:5432/db');
    await db.disconnect();
  });

  it('an explicit client option wins over the URL', async () => {
    const db = new TurbineClient(
      {
        connectionString: 'postgres://u:p@localhost:5432/db?connection_limit=3&pool_timeout=12',
        poolSize: 9,
        connectionTimeoutMs: 1000,
      },
      EMPTY,
    );
    assert.equal(poolOptions(db).max, 9);
    assert.equal(poolOptions(db).connectionTimeoutMillis, 1000);
    await db.disconnect();
  });

  it('a non-public schema becomes the connection search_path; public is left alone', async () => {
    const db = new TurbineClient({ connectionString: 'postgres://u:p@localhost:5432/db?schema=tenant_a' }, EMPTY);
    assert.match(poolOptions(db).connectionString ?? '', /options=-c\+search_path%3D%22tenant_a%22/);
    assert.doesNotMatch(poolOptions(db).connectionString ?? '', /schema=/);
    await db.disconnect();
    const pub = new TurbineClient({ connectionString: 'postgres://u:p@localhost:5432/db?schema=public' }, EMPTY);
    assert.equal(poolOptions(pub).connectionString, 'postgres://u:p@localhost:5432/db');
    await pub.disconnect();
  });

  it('refuses a schema on a pooler, a schema that is not a plain identifier, and an invalid value', () => {
    for (const [connectionString, re] of [
      ['postgres://u:p@ep-x-pooler.us-east-2.aws.neon.tech/db?schema=tenant_a', /transaction pooler/],
      ['postgres://u:p@localhost:6543/db?schema=tenant_a', /transaction pooler/],
      ['postgres://u:p@localhost:5432/db?schema=bad%20name', /whitespace/],
      ['postgres://u:p@localhost:5432/db?schema=bad%22name', /double quote/],
      ['postgres://u:p@localhost:5432/db?schema=bad%5Cname', /backslash/],
      ['postgres://u:p@localhost:5432/db?connection_limit=0', /connection_limit/],
    ] as const) {
      assert.throws(
        () => new TurbineClient({ connectionString }, EMPTY),
        (err: unknown) => err instanceof ValidationError && re.test(err.message) && !err.message.includes('u:p@'),
        connectionString,
      );
    }
  });

  live.it('queries run in the schema the URL names', async () => {
    // A hyphen is ordinary in a Prisma schema name and needs the quoting.
    const schemaName = `prisma-url-${process.pid}`;
    const admin = new TurbineClient({ connectionString: url ?? '' }, EMPTY);
    await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    await admin.rawUnsafe(`CREATE SCHEMA "${schemaName}"`);
    await admin.rawUnsafe(`CREATE TABLE "${schemaName}".only_here (id int)`);
    const separator = (url ?? '').includes('?') ? '&' : '?';
    const db = new TurbineClient({ connectionString: `${url}${separator}schema=${schemaName}` }, EMPTY);
    try {
      const [row] = await db.rawUnsafe<{ s: string }>('SELECT current_schema() AS s');
      assert.equal(row?.s, schemaName);
      assert.deepEqual(await db.rawUnsafe('SELECT count(*)::int AS n FROM only_here'), [{ n: 0 }]);
    } finally {
      await db.disconnect();
      await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      await admin.disconnect();
    }
  });
});
