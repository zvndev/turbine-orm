/**
 * Fixture shared by the fx-where suites: users with a text token, a JSON
 * document, NOT NULL and nullable columns, and their posts with a NOT NULL and
 * a nullable foreign key. Usable build-only, and live on PostgreSQL
 * (DATABASE_URL, tables of its own), MySQL (MYSQL_URL, in a database of its
 * own) and in-memory SQLite.
 */

import { createRequire } from 'node:module';
import type { TurbineClient } from '../client.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';

/** The MySQL database these suites create and drop (never the URL's own). */
const MYSQL_DATABASE = process.env.FX_WHERE_MYSQL_DATABASE ?? 'turbine_dev_fx_where';

/** `node:sqlite` is a builtin only on Node >= 22.5, so it is probed rather than imported. */
export const HAVE_NODE_SQLITE = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

export const USERS_TABLE = 'fxwh_users';
export const POSTS_TABLE = 'fxwh_posts';

function nullable(meta: TableMetadata, ...columns: string[]): TableMetadata {
  for (const c of meta.columns) if (columns.includes(c.name)) c.nullable = true;
  return meta;
}

/**
 * `fxwh_users` / `fxwh_posts`. `data` is a JSON column of the engine's kind;
 * with `arrays`, users also get a NOT NULL and a nullable text array
 * (PostgreSQL only, so build-only elsewhere).
 */
export function fxWhereSchema(jsonType = 'jsonb', arrays = false): SchemaMetadata {
  const users = nullable(
    mockTable(
      USERS_TABLE,
      [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'email', field: 'email', pgType: 'text', unique: true },
        { name: 'reset_token', field: 'resetToken', pgType: 'varchar' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'score', field: 'score', pgType: 'int4' },
        { name: 'data', field: 'data', pgType: jsonType },
        { name: 'tenant', field: 'tenant', pgType: 'int4' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
        ...(arrays
          ? [
              { name: 'tags', field: 'tags', pgType: '_text' },
              { name: 'labels', field: 'labels', pgType: '_text' },
            ]
          : []),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: USERS_TABLE,
          to: POSTS_TABLE,
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    'reset_token',
    'score',
    'data',
    'labels',
  );
  for (const c of users.columns) {
    if (['email', 'reset_token', 'name'].includes(c.name)) c.tsType = 'string';
    if (c.name === 'data') c.tsType = 'unknown';
    if (c.name === 'created_at') c.tsType = 'Date';
  }
  users.dateColumns = new Set(['created_at']);
  const posts = nullable(
    mockTable(
      POSTS_TABLE,
      [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'user_id', field: 'userId', pgType: 'int4' },
        { name: 'editor_id', field: 'editorId', pgType: 'int4' },
        { name: 'title', field: 'title', pgType: 'text' },
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: POSTS_TABLE,
          to: USERS_TABLE,
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
        editor: {
          type: 'belongsTo',
          name: 'editor',
          from: POSTS_TABLE,
          to: USERS_TABLE,
          foreignKey: 'editor_id',
          referenceKey: 'id',
        },
      },
    ),
    'editor_id',
  );
  for (const c of posts.columns) if (c.name === 'title') c.tsType = 'string';
  return { enums: {}, tables: { [USERS_TABLE]: users, [POSTS_TABLE]: posts } };
}

export interface FxUser {
  id: number;
  email: string;
  resetToken: string | null;
  name: string;
  score: number | null;
  data: unknown;
  tenant: number;
}

/**
 * Four users. Their tokens are the MySQL hazard: `'abc'` and `'0zz'` both
 * equal the NUMBER 0 there. User 2's document has keys holding a backslash and
 * a quote; user 4's has two keys, written in the other order by the tests.
 */
export const USERS: readonly FxUser[] = [
  { id: 1, email: 'ann@x.test', resetToken: 'abc', name: 'ann', score: 10, data: { a: 1 }, tenant: 1 },
  { id: 2, email: 'bob@x.test', resetToken: '0zz', name: 'bob', score: null, data: { 'a\\b': 2, 'q"k': 3 }, tenant: 1 },
  { id: 3, email: 'cy@x.test', resetToken: null, name: 'cy', score: 20, data: null, tenant: 2 },
  { id: 4, email: 'dee@x.test', resetToken: '1', name: 'dee', score: 5, data: { a: 2, b: 3 }, tenant: 2 },
];

/** Posts: author per post, and an editor on two of them. */
export const POSTS: readonly { id: number; userId: number; editorId: number | null; title: string }[] = [
  { id: 1, userId: 1, editorId: null, title: 'p1' },
  { id: 2, userId: 1, editorId: 2, title: 'p2' },
  { id: 3, userId: 2, editorId: null, title: 'p3' },
  { id: 4, userId: 4, editorId: 1, title: 'p4' },
];

const CREATED_AT = '2024-01-02T03:04:05.000Z';

function rowsSql(quote: (v: unknown) => string, json: (v: unknown) => string, at: string): string[] {
  return [
    `INSERT INTO ${USERS_TABLE} (id, email, reset_token, name, score, data, tenant, created_at) VALUES ${USERS.map(
      (u) =>
        `(${u.id}, ${quote(u.email)}, ${u.resetToken === null ? 'NULL' : quote(u.resetToken)}, ${quote(u.name)}, ` +
        `${u.score ?? 'NULL'}, ${u.data === null ? 'NULL' : json(u.data)}, ${u.tenant}, ${at})`,
    ).join(', ')}`,
    `INSERT INTO ${POSTS_TABLE} (id, user_id, editor_id, title) VALUES ${POSTS.map(
      (p) => `(${p.id}, ${p.userId}, ${p.editorId ?? 'NULL'}, ${quote(p.title)})`,
    ).join(', ')}`,
  ];
}

const quoteText = (v: unknown): string => `'${String(v).replace(/'/g, "''")}'`;

export interface EngineHandle {
  name: 'postgresql' | 'mysql' | 'sqlite';
  db: TurbineClient;
  /** Re-seed both tables. */
  reset(): Promise<void>;
  /** A client on the same database built with `options` (closed by `close`). */
  client(options: Record<string, unknown>): Promise<TurbineClient>;
  /**
   * Build a client that is expected to be refused at construction, on a pool
   * this fixture owns and closes (a MySQL pool opened from a connection string
   * by a factory whose client then throws would be left open).
   */
  refusedClient(options: Record<string, unknown>): Promise<TurbineClient>;
  close(): Promise<void>;
}

export async function openPostgres(): Promise<EngineHandle> {
  const { TurbineClient } = await import('../client.js');
  const pg = (await import('pg')).default;
  const admin = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const reset = async (): Promise<void> => {
    await admin.query(`DROP TABLE IF EXISTS ${POSTS_TABLE}`);
    await admin.query(`DROP TABLE IF EXISTS ${USERS_TABLE}`);
    await admin.query(
      `CREATE TABLE ${USERS_TABLE} (id INT PRIMARY KEY, email TEXT NOT NULL UNIQUE, reset_token VARCHAR(32), ` +
        'name TEXT NOT NULL, score INT, data JSONB, tenant INT NOT NULL, created_at TIMESTAMPTZ NOT NULL)',
    );
    await admin.query(
      `CREATE TABLE ${POSTS_TABLE} (id INT PRIMARY KEY, user_id INT NOT NULL REFERENCES ${USERS_TABLE}(id), ` +
        `editor_id INT REFERENCES ${USERS_TABLE}(id), title TEXT NOT NULL)`,
    );
    for (const sql of rowsSql(quoteText, (v) => `${quoteText(JSON.stringify(v))}::jsonb`, quoteText(CREATED_AT))) {
      await admin.query(sql);
    }
  };
  await reset();
  const clients: TurbineClient[] = [];
  const client = async (options: Record<string, unknown>): Promise<TurbineClient> => {
    const db = new TurbineClient(
      { connectionString: DATABASE_URL, poolSize: 2, warnOnUnlimited: false, ...options },
      fxWhereSchema('jsonb'),
    );
    clients.push(db);
    return db;
  };
  const db = await client({});
  return {
    name: 'postgresql',
    db,
    reset,
    client,
    refusedClient: client,
    close: async () => {
      for (const c of clients) await c.disconnect();
      await admin.query(`DROP TABLE IF EXISTS ${POSTS_TABLE}`);
      await admin.query(`DROP TABLE IF EXISTS ${USERS_TABLE}`);
      await admin.end();
    },
  };
}

export async function openMysql(): Promise<EngineHandle> {
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
  const pools: { end(): Promise<void> }[] = [];
  const rawPool = (): ReturnType<typeof createPool> => {
    const pool = createPool({
      ...server,
      database: MYSQL_DATABASE,
      namedPlaceholders: true,
      supportBigNumbers: true,
      timezone: 'Z',
      connectionLimit: 4,
    });
    pools.push(pool);
    return pool;
  };
  const seedPool = rawPool();
  const reset = async (): Promise<void> => {
    await seedPool.query(`DROP TABLE IF EXISTS ${POSTS_TABLE}`);
    await seedPool.query(`DROP TABLE IF EXISTS ${USERS_TABLE}`);
    await seedPool.query(
      `CREATE TABLE ${USERS_TABLE} (id INT PRIMARY KEY, email VARCHAR(64) NOT NULL UNIQUE, reset_token VARCHAR(32) NULL, ` +
        'name VARCHAR(32) NOT NULL, score INT NULL, data JSON NULL, tenant INT NOT NULL, created_at DATETIME(3) NOT NULL)',
    );
    await seedPool.query(
      `CREATE TABLE ${POSTS_TABLE} (id INT PRIMARY KEY, user_id INT NOT NULL, editor_id INT NULL, title VARCHAR(32) NOT NULL, ` +
        `FOREIGN KEY (user_id) REFERENCES ${USERS_TABLE}(id), FOREIGN KEY (editor_id) REFERENCES ${USERS_TABLE}(id))`,
    );
    for (const sql of rowsSql(
      quoteText,
      (v) => `CAST(${quoteText(JSON.stringify(v).replace(/\\/g, '\\\\'))} AS JSON)`,
      quoteText('2024-01-02 03:04:05.000'),
    )) {
      await seedPool.query(sql);
    }
  };
  await reset();
  const { turbineMysql } = await import('../mysql.js');
  // A connection string, so the engine opens (and configures) its own pool.
  const clientUrl = new URL(MYSQL_URL);
  clientUrl.pathname = `/${MYSQL_DATABASE}`;
  const clients: TurbineClient[] = [];
  const client = async (options: Record<string, unknown>): Promise<TurbineClient> => {
    const db = (await turbineMysql(clientUrl.toString(), fxWhereSchema('json'), {
      warnOnUnlimited: false,
      connectionLimit: 2,
      ...options,
    } as never)) as unknown as TurbineClient;
    clients.push(db);
    return db;
  };
  const { MysqlPool } = await import('../mysql.js');
  const refusedClient = async (options: Record<string, unknown>): Promise<TurbineClient> =>
    (await turbineMysql(new MysqlPool(rawPool()), fxWhereSchema('json'), {
      warnOnUnlimited: false,
      ...options,
    } as never)) as unknown as TurbineClient;
  const db = await client({});
  return {
    name: 'mysql',
    db,
    reset,
    client,
    refusedClient,
    close: async () => {
      for (const c of clients) await c.disconnect();
      await seedPool.query(`DROP DATABASE IF EXISTS \`${MYSQL_DATABASE}\``);
      for (const pool of pools) await pool.end();
    },
  };
}

export async function openSqlite(): Promise<EngineHandle> {
  const { DatabaseSync } = await import('node:sqlite');
  const { turbineSqlite } = await import('../sqlite.js');
  const raw = new DatabaseSync(':memory:');
  const reset = async (): Promise<void> => {
    raw.exec(`DROP TABLE IF EXISTS ${POSTS_TABLE}`);
    raw.exec(`DROP TABLE IF EXISTS ${USERS_TABLE}`);
    raw.exec(
      `CREATE TABLE ${USERS_TABLE} (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, reset_token TEXT, ` +
        'name TEXT NOT NULL, score INTEGER, data TEXT, tenant INTEGER NOT NULL, created_at TEXT NOT NULL)',
    );
    raw.exec(
      `CREATE TABLE ${POSTS_TABLE} (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, editor_id INTEGER, title TEXT NOT NULL)`,
    );
    for (const sql of rowsSql(quoteText, (v) => quoteText(JSON.stringify(v)), quoteText(CREATED_AT))) raw.exec(sql);
  };
  await reset();
  const clients: TurbineClient[] = [];
  const client = async (options: Record<string, unknown>): Promise<TurbineClient> => {
    const db = turbineSqlite(raw, fxWhereSchema('json'), { warnOnUnlimited: false, ...options } as never);
    clients.push(db);
    return db;
  };
  const db = await client({});
  return {
    name: 'sqlite',
    db,
    reset,
    client,
    refusedClient: client,
    close: async () => {
      for (const c of clients) await c.disconnect();
    },
  };
}

/** Sorted ids of a result set. */
export function ids(rows: readonly { id: unknown }[]): number[] {
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}
