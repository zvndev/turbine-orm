/**
 * Fixture shared by the fix-where suites: one small schema (users with a JSON
 * column, their posts), usable build-only, and live on PostgreSQL
 * (DATABASE_URL), MySQL (MYSQL_URL, in a database of its own), in-memory
 * SQLite and embedded PowDB, so one where clause can be run on every engine.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TurbineClient } from '../client.js';
import type { QueryInterfaceOptions } from '../query/deferred.js';
import { UNSAFE } from '../query/types.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';

/** `node:sqlite` is a builtin only on Node >= 22.5, so it is probed rather than imported. */
export const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

/** Whether the embedded PowDB addon loads on this platform. */
export async function powdbEmbeddedLoads(): Promise<boolean> {
  try {
    const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
    return typeof mod?.Database?.open === 'function';
  } catch {
    return false;
  }
}

/** The MySQL database these suites create and drop (never the URL's own). */
const MYSQL_DATABASE = 'turbine_dev_fix_where';

export interface FwUser {
  id: number;
  name: string;
  score: number | null;
  data: unknown;
  tenant: number;
}

export interface FwPost {
  id: number;
  userId: number;
  title: string;
}

function nullable(meta: TableMetadata, ...columns: string[]): TableMetadata {
  for (const c of meta.columns) if (columns.includes(c.name)) c.nullable = true;
  return meta;
}

/** `fw_users` / `fw_posts`, with `data` as a JSON column of the engine's kind. */
export function fixWhereSchema(jsonType = 'jsonb'): SchemaMetadata {
  const users = nullable(
    mockTable(
      'fw_users',
      [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'score', field: 'score', pgType: 'int4' },
        { name: 'data', field: 'data', pgType: jsonType },
        { name: 'tenant', field: 'tenant', pgType: 'int4' },
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'fw_users',
          to: 'fw_posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    'score',
    'data',
  );
  for (const c of users.columns) {
    if (c.name === 'name' || c.name === 'data') c.tsType = c.name === 'name' ? 'string' : 'unknown';
  }
  const posts = mockTable(
    'fw_posts',
    [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'user_id', field: 'userId', pgType: 'int4' },
      { name: 'title', field: 'title', pgType: 'text' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'fw_posts',
        to: 'fw_users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );
  for (const c of posts.columns) if (c.name === 'title') c.tsType = 'string';
  return { enums: {}, tables: { fw_users: users, fw_posts: posts } };
}

/** Six users (ids 1..6) and their posts. Scores tie and include NULLs. */
export const USERS: readonly FwUser[] = [
  { id: 1, name: 'ann', score: 10, data: { a: 1, tags: ['x'] }, tenant: 1 },
  { id: 2, name: 'bob', score: 10, data: { a: 2 }, tenant: 1 },
  { id: 3, name: 'cy', score: null, data: { contains: { a: 1 } }, tenant: 1 },
  { id: 4, name: 'dee', score: 20, data: null, tenant: 2 },
  { id: 5, name: 'eve', score: null, data: { secret: true }, tenant: 2 },
  { id: 6, name: 'fay', score: 20, data: { a: 1 }, tenant: 2 },
];

/** user_id per post: users 1 and 2 have two posts, 4 has one, 3, 5 and 6 none. */
export const POSTS: readonly FwPost[] = [
  { id: 1, userId: 1, title: 'p1' },
  { id: 2, userId: 1, title: 'p2' },
  { id: 3, userId: 2, title: 'p3' },
  { id: 4, userId: 2, title: 'p4' },
  { id: 5, userId: 4, title: 'p5' },
];

function rowsSql(quote: (v: unknown) => string, json: (v: unknown) => string): string[] {
  return [
    `INSERT INTO fw_users (id, name, score, data, tenant) VALUES ${USERS.map(
      (u) =>
        `(${u.id}, ${quote(u.name)}, ${u.score ?? 'NULL'}, ${u.data === null ? 'NULL' : json(u.data)}, ${u.tenant})`,
    ).join(', ')}`,
    `INSERT INTO fw_posts (id, user_id, title) VALUES ${POSTS.map((p) => `(${p.id}, ${p.userId}, ${quote(p.title)})`).join(', ')}`,
  ];
}

const quoteText = (v: unknown): string => `'${String(v).replace(/'/g, "''")}'`;

export interface EngineHandle {
  name: 'postgresql' | 'mysql' | 'sqlite' | 'powdb';
  db: TurbineClient;
  /** Re-seed both tables to {@link USERS} / {@link POSTS}. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function openPostgres(
  options: QueryInterfaceOptions & Record<string, unknown> = {},
): Promise<EngineHandle> {
  const { TurbineClient } = await import('../client.js');
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const reset = async (): Promise<void> => {
    await admin.query('DROP TABLE IF EXISTS fw_posts');
    await admin.query('DROP TABLE IF EXISTS fw_users');
    await admin.query(
      'CREATE TABLE fw_users (id INT PRIMARY KEY, name TEXT NOT NULL, score INT, data JSONB, tenant INT NOT NULL)',
    );
    await admin.query('CREATE TABLE fw_posts (id INT PRIMARY KEY, user_id INT NOT NULL, title TEXT NOT NULL)');
    for (const sql of rowsSql(quoteText, (v) => `${quoteText(JSON.stringify(v))}::jsonb`)) await admin.query(sql);
  };
  await reset();
  const db = new TurbineClient(
    { connectionString: DATABASE_URL, poolSize: 2, warnOnUnlimited: false, ...options },
    fixWhereSchema('jsonb'),
  );
  return {
    name: 'postgresql',
    db,
    reset,
    close: async () => {
      await db.disconnect();
      await admin.query('DROP TABLE IF EXISTS fw_posts');
      await admin.query('DROP TABLE IF EXISTS fw_users');
      await admin.end();
    },
  };
}

export async function openMysql(options: Record<string, unknown> = {}): Promise<EngineHandle> {
  const { createPool } = await import('mysql2/promise');
  const url = new URL(MYSQL_URL);
  const server = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
  const admin = createPool(server);
  await admin.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\``);
  await admin.end();
  const rawPool = createPool({
    ...server,
    database: MYSQL_DATABASE,
    namedPlaceholders: true,
    supportBigNumbers: true,
    timezone: 'Z',
    connectionLimit: 4,
  });
  const reset = async (): Promise<void> => {
    await rawPool.query('DROP TABLE IF EXISTS fw_posts');
    await rawPool.query('DROP TABLE IF EXISTS fw_users');
    await rawPool.query(
      'CREATE TABLE fw_users (id INT PRIMARY KEY, name VARCHAR(32) NOT NULL, score INT NULL, data JSON NULL, tenant INT NOT NULL)',
    );
    await rawPool.query('CREATE TABLE fw_posts (id INT PRIMARY KEY, user_id INT NOT NULL, title VARCHAR(32) NOT NULL)');
    for (const sql of rowsSql(quoteText, (v) => `CAST(${quoteText(JSON.stringify(v))} AS JSON)`)) {
      await rawPool.query(sql);
    }
  };
  await reset();
  const { MysqlPool, turbineMysql } = await import('../mysql.js');
  const db = (await turbineMysql(new MysqlPool(rawPool), fixWhereSchema('json'), {
    warnOnUnlimited: false,
    ...options,
  } as never)) as unknown as TurbineClient;
  return {
    name: 'mysql',
    db,
    reset,
    close: async () => {
      await rawPool.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``);
      await rawPool.end();
    },
  };
}

export async function openSqlite(options: Record<string, unknown> = {}): Promise<EngineHandle> {
  const { DatabaseSync } = await import('node:sqlite');
  const { turbineSqlite } = await import('../sqlite.js');
  const raw = new DatabaseSync(':memory:');
  const reset = async (): Promise<void> => {
    raw.exec('DROP TABLE IF EXISTS fw_posts');
    raw.exec('DROP TABLE IF EXISTS fw_users');
    raw.exec(
      'CREATE TABLE fw_users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score INTEGER, data TEXT, tenant INTEGER NOT NULL)',
    );
    raw.exec('CREATE TABLE fw_posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL)');
    for (const sql of rowsSql(quoteText, (v) => quoteText(JSON.stringify(v)))) raw.exec(sql);
  };
  await reset();
  const db = turbineSqlite(raw, fixWhereSchema('json'), { warnOnUnlimited: false, ...options } as never);
  return {
    name: 'sqlite',
    db,
    reset,
    close: async () => {
      await db.disconnect();
    },
  };
}

export async function openPowdb(options: Record<string, unknown> = {}): Promise<EngineHandle> {
  const { powqlSchemaDDL, turbinePowDB } = await import('../powdb.js');
  const dir = mkdtempSync(join(tmpdir(), 'turbine-fix-where-powdb-'));
  const schema = fixWhereSchema('jsonb');
  const db = (await turbinePowDB({ embedded: dir }, schema, {
    warnOnUnlimited: false,
    ...options,
  } as never)) as unknown as TurbineClient;
  for (const stmt of powqlSchemaDDL(schema)) await db.rawUnsafe(stmt);
  const reset = async (): Promise<void> => {
    for (const table of ['fw_posts', 'fw_users']) {
      await db.table(table).deleteMany({ where: {}, allowFullTableScan: UNSAFE } as never);
    }
    await db.table('fw_users').createMany({ data: USERS.map((u) => ({ ...u })) } as never);
    await db.table('fw_posts').createMany({ data: POSTS.map((p) => ({ ...p })) } as never);
  };
  await reset();
  return {
    name: 'powdb',
    db,
    reset,
    close: async () => {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Sorted ids of a result set. */
export function ids(rows: readonly { id: unknown }[]): number[] {
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}
