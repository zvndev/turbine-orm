/** Explicit local endpoint and pool policy for the MySQL comparison. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import mysql, { type Pool } from 'mysql2/promise';

export const MYSQL_SESSION_IDENTITY_SQL =
  'SELECT @@session.sql_mode AS sqlMode, @@session.transaction_isolation AS isolationLevel, @@session.time_zone AS timeZone, @@session.character_set_client AS characterSetClient, @@session.collation_connection AS collationConnection, CAST(@@session.autocommit AS CHAR) AS autocommit, CAST(CONNECTION_ID() AS CHAR) AS connectionId';
export const MYSQL2_SETTINGS = {
  connectionLimit: 10,
  namedPlaceholders: true,
  supportBigNumbers: true,
  bigNumberStrings: false,
  timezone: 'Z',
  dateStrings: false,
  connectTimeout: 5000,
} as const;
export const POOL_SIZE = 10;
export const BATCH_SIZE = 1000;
export const COUNTS = {
  organizations: 5,
  users: 1000,
  posts: 10000,
  comments: 50000,
  tags: 50,
  post_tags: 30000,
  bench_wide: 2000,
  bench_writes: 0,
};
export const FIXTURE_TIME = new Date('2023-11-14T22:13:20.000Z');
export function connectionOptions() {
  const value = process.env.MYSQL_COMPARISON_URL;
  assert.ok(value, 'MYSQL_COMPARISON_URL is required (a private, directly owned endpoint)');
  const url = new URL(value);
  assert.equal(url.protocol, 'mysql:');
  assert.equal(url.hostname, '127.0.0.1', 'only an owned loopback native service is permitted');
  assert.equal(process.env.MYSQL_COMPARISON_OWNED, '1', 'owned-service admission required');
  const database = decodeURIComponent(url.pathname.slice(1));
  assert.match(database, /^mysql_comparison_[a-z0-9_]+$/, 'dedicated mysql_comparison_ database required');
  assert.ok(!url.search, 'URL options are not silently ignored; pass a plain direct MySQL URL');
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}
const pools: { pool: Pool; role: string; threadIds: number[] }[] = [];
export function poolSnapshots() {
  return pools.map(({ pool, role, threadIds }) => {
    const raw = pool.pool as unknown as {
      _closed: boolean;
      _allConnections: { length: number };
      _connectionQueue: { length: number };
    };
    return {
      role,
      threadIds,
      closed: raw._closed,
      connections: raw._allConnections.length,
      queued: raw._connectionQueue.length,
    };
  });
}
export function makePool(role = 'oracle') {
  const pool = mysql.createPool({
    ...connectionOptions(),
    ...MYSQL2_SETTINGS,
  });
  const record = { pool, role, threadIds: [] as number[] };
  pools.push(record);
  pool.on('connection', (c) => record.threadIds.push(c.threadId));
  return pool;
}
export function packageVersions() {
  const require = createRequire(import.meta.url);
  const version = (name: string) => {
    let entry = require.resolve(name === 'prisma' ? 'prisma/package.json' : name);
    for (;;) {
      const cut = entry.lastIndexOf('/');
      assert.ok(cut > 0, `package manifest missing: ${name}`);
      entry = entry.slice(0, cut);
      try {
        const pkg = JSON.parse(readFileSync(`${entry}/package.json`, 'utf8'));
        if (pkg.version) return pkg.version as string;
      } catch {}
    }
  };
  const versions = Object.fromEntries(
    [
      'mysql2',
      'mariadb',
      'drizzle-orm',
      'drizzle-rc',
      'prisma',
      '@prisma/client',
      '@prisma/adapter-mariadb',
      'turbine-orm',
      'pg',
    ].map((name) => [name, version(name)]),
  );
  for (const [name, expected] of Object.entries({
    mysql2: '3.24.6',
    pg: '8.23.1',
    mariadb: '3.5.4',
    'drizzle-orm': '0.45.4',
    'drizzle-rc': '1.0.0-rc.5',
    prisma: '7.10.1',
    '@prisma/client': '7.10.1',
    '@prisma/adapter-mariadb': '7.10.1',
  }))
    assert.equal(versions[name], expected, `wrong comparison package ${name}`);
  return versions;
}

export function bind(values: unknown[]): (string | number | bigint | boolean | Date | null)[] {
  return values.map((value) => {
    assert.ok(
      value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'bigint' ||
        typeof value === 'boolean' ||
        value instanceof Date,
      'unsupported native bind value',
    );
    return value as string | number | bigint | boolean | Date | null;
  });
}
