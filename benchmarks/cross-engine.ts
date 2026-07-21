/**
 * Cross-engine benchmark for turbine-orm.
 *
 * Runs the SAME ORM-realistic operation mix through Turbine against each
 * supported engine (Postgres, SQLite, MySQL, SQL Server, PowDB) and reports
 * p50/p95/p99 latency + throughput per operation, so you can see where each
 * engine is strong or weak *through Turbine's API* (not a raw-driver shootout).
 *
 * Methodology (kept deliberately conventional, à la tinybench / drizzle-benchmarks):
 *   - one connection per engine (isolates engine latency, not pool concurrency)
 *   - a fixed, deterministic seed (no faker, no randomness — identical every run)
 *   - per-op warmup then N measured iterations; report p50/p95/p99/mean + ops/sec
 *   - identical schema + identical operations across engines; app-assigned integer
 *     PKs everywhere (the one shape all five engines share — PowDB has no
 *     generated IDs, so auto-increment can't be the common denominator)
 *
 * Env knobs: USERS, POSTS_PER_USER, COMMENTS_PER_POST, ITERATIONS, WARMUP,
 * ENGINES (csv of pg,sqlite,mysql,mssql,powdb), PG_URL, MYSQL_URL, MSSQL_URL,
 * POWDB_HOST, POWDB_PORT.
 *
 * Run: npx tsx benchmarks/cross-engine.ts
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurbineClient } from '../src/client.js';
import { powqlSchemaDDL, turbinePowDB } from '../src/powdb.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../src/schema.js';
import { turbineSqlite } from '../src/sqlite.js';
import { turbineMysql } from '../src/mysql.js';
import { turbineMssql } from '../src/mssql.js';

const require = createRequire(import.meta.url);

/** Installed @zvndev/powdb-embedded version, read at runtime for the engine label. */
function powdbEmbeddedVersion(): string {
  try {
    return (require('@zvndev/powdb-embedded/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USERS = Number(process.env.USERS ?? 100);
const POSTS_PER_USER = Number(process.env.POSTS_PER_USER ?? 10);
const COMMENTS_PER_POST = Number(process.env.COMMENTS_PER_POST ?? 5);
const ITERATIONS = Number(process.env.ITERATIONS ?? 200);
const WARMUP = Number(process.env.WARMUP ?? 30);
const ORGS = 5;

const PG_URL = process.env.PG_URL ?? 'postgresql://localhost:5432/turbine_bench';
const MYSQL_URL = process.env.MYSQL_URL ?? 'mysql://root@127.0.0.1:3306/turbine_bench';
const MSSQL_URL = process.env.MSSQL_URL ?? 'mssql://sa:Turbine_bench1@127.0.0.1:1433/master';
const POWDB_HOST = process.env.POWDB_HOST ?? '127.0.0.1';
const POWDB_PORT = Number(process.env.POWDB_PORT ?? 5457);
const POWDB_SOCKET = process.env.POWDB_SOCKET; // if set, the networked engine connects via this Unix socket
const POWDB_EMB_DIR = process.env.POWDB_EMB_DIR; // optional fixed data dir for the embedded engine (else a temp dir)

const ENGINES = (process.env.ENGINES ?? 'pg,sqlite,mysql,mssql,powdb').split(',').map((s) => s.trim());

// ---------------------------------------------------------------------------
// Schema (4 tables, app-assigned integer PKs, FK indexes)
// ---------------------------------------------------------------------------

// Map a column pgType to its Postgres array type — used by Turbine's createMany
// UNNEST path (Postgres only; other engines ignore pgArrayType).
const PG_ARRAY: Record<string, string> = { int8: 'bigint[]', int4: 'integer[]', bool: 'boolean[]', text: 'text[]' };

function col(name: string, field: string, tsType: string, pgType: string, opts: Partial<ColumnMetadata> = {}): ColumnMetadata {
  return {
    name,
    field,
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: PG_ARRAY[pgType] ?? 'text[]',
    ...opts,
  };
}

function makeTable(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef>): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

const rel = (type: RelationDef['type'], name: string, from: string, to: string, fk: string, ref: string): RelationDef => ({
  type,
  name,
  from,
  to,
  foreignKey: fk,
  referenceKey: ref,
});

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    organizations: makeTable(
      'organizations',
      [
        col('id', 'id', 'number', 'int8'),
        col('name', 'name', 'string', 'text'),
        col('slug', 'slug', 'string', 'text'),
        col('plan', 'plan', 'string', 'text'),
      ],
      {
        users: rel('hasMany', 'users', 'organizations', 'users', 'org_id', 'id'),
        posts: rel('hasMany', 'posts', 'organizations', 'posts', 'org_id', 'id'),
      },
    ),
    users: makeTable(
      'users',
      [
        col('id', 'id', 'number', 'int8'),
        col('org_id', 'orgId', 'number', 'int8'),
        col('email', 'email', 'string', 'text'),
        col('name', 'name', 'string', 'text'),
        col('role', 'role', 'string', 'text'),
      ],
      {
        organization: rel('belongsTo', 'organization', 'users', 'organizations', 'org_id', 'id'),
        posts: rel('hasMany', 'posts', 'users', 'posts', 'user_id', 'id'),
        comments: rel('hasMany', 'comments', 'users', 'comments', 'user_id', 'id'),
      },
    ),
    posts: makeTable(
      'posts',
      [
        col('id', 'id', 'number', 'int8'),
        col('user_id', 'userId', 'number', 'int8'),
        col('org_id', 'orgId', 'number', 'int8'),
        col('title', 'title', 'string', 'text'),
        col('content', 'content', 'string', 'text'),
        col('published', 'published', 'boolean', 'bool'),
        col('view_count', 'viewCount', 'number', 'int4'),
      ],
      {
        author: rel('belongsTo', 'author', 'posts', 'users', 'user_id', 'id'),
        comments: rel('hasMany', 'comments', 'posts', 'comments', 'post_id', 'id'),
      },
    ),
    comments: makeTable(
      'comments',
      [
        col('id', 'id', 'number', 'int8'),
        col('post_id', 'postId', 'number', 'int8'),
        col('user_id', 'userId', 'number', 'int8'),
        col('body', 'body', 'string', 'text'),
      ],
      {
        post: rel('belongsTo', 'post', 'comments', 'posts', 'post_id', 'id'),
        author: rel('belongsTo', 'author', 'comments', 'users', 'user_id', 'id'),
      },
    ),
  },
};

// ---------------------------------------------------------------------------
// Per-engine DDL (app-assigned integer PKs + FK indexes)
// ---------------------------------------------------------------------------

const TABLES = ['comments', 'posts', 'users', 'organizations'] as const;

function sqlDDL(d: 'pg' | 'sqlite' | 'mysql' | 'mssql'): string[] {
  const int = d === 'mssql' ? 'BIGINT' : d === 'sqlite' ? 'INTEGER' : 'BIGINT';
  const i32 = d === 'mssql' ? 'INT' : d === 'sqlite' ? 'INTEGER' : d === 'mysql' ? 'INT' : 'INTEGER';
  const txt = d === 'mysql' ? 'VARCHAR(512)' : d === 'mssql' ? 'NVARCHAR(512)' : 'TEXT';
  const bool = d === 'pg' ? 'BOOLEAN' : d === 'mssql' ? 'BIT' : d === 'mysql' ? 'TINYINT(1)' : 'INTEGER';
  const pk = `${int} PRIMARY KEY`;
  const drops = TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`);
  const creates = [
    `CREATE TABLE organizations (id ${pk}, name ${txt}, slug ${txt}, plan ${txt})`,
    `CREATE TABLE users (id ${pk}, org_id ${int}, email ${txt}, name ${txt}, role ${txt})`,
    `CREATE TABLE posts (id ${pk}, user_id ${int}, org_id ${int}, title ${txt}, content ${txt}, published ${bool}, view_count ${i32})`,
    `CREATE TABLE comments (id ${pk}, post_id ${int}, user_id ${int}, body ${txt})`,
  ];
  const indexes = [
    `CREATE INDEX idx_users_org ON users (org_id)`,
    `CREATE INDEX idx_posts_user ON posts (user_id)`,
    `CREATE INDEX idx_posts_org ON posts (org_id)`,
    `CREATE INDEX idx_posts_pub ON posts (published)`,
    `CREATE INDEX idx_comments_post ON comments (post_id)`,
    `CREATE INDEX idx_comments_user ON comments (user_id)`,
  ];
  return [...drops, ...creates, ...indexes];
}

// ---------------------------------------------------------------------------
// Deterministic seed data
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
function buildSeed() {
  const orgs: Row[] = [];
  const users: Row[] = [];
  const posts: Row[] = [];
  const comments: Row[] = [];
  for (let o = 1; o <= ORGS; o++) orgs.push({ id: o, name: `Org ${o}`, slug: `org-${o}`, plan: o % 2 ? 'pro' : 'free' });
  let pid = 1;
  let cid = 1;
  for (let u = 1; u <= USERS; u++) {
    const orgId = ((u - 1) % ORGS) + 1;
    users.push({ id: u, orgId, email: `user${u}@bench.dev`, name: `User ${u}`, role: u % 10 === 0 ? 'admin' : 'member' });
    for (let p = 0; p < POSTS_PER_USER; p++) {
      const thisPid = pid++;
      posts.push({
        id: thisPid,
        userId: u,
        orgId,
        title: `Post ${thisPid}`,
        content: `Content for post ${thisPid} `.repeat(3),
        published: thisPid % 3 !== 0,
        viewCount: (thisPid * 7) % 1000,
      });
      for (let c = 0; c < COMMENTS_PER_POST; c++) {
        comments.push({ id: cid++, postId: thisPid, userId: ((cid % USERS) + 1), body: `Comment ${cid}` });
      }
    }
  }
  return { orgs, users, posts, comments };
}

const SEED = buildSeed();
const TOTAL_ROWS = SEED.orgs.length + SEED.users.length + SEED.posts.length + SEED.comments.length;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface Stat {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  ops: number;
}
function stats(times: number[]): Stat {
  const s = [...times].sort((a, b) => a - b);
  const pct = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { p50: pct(50), p95: pct(95), p99: pct(99), mean, ops: 1000 / mean };
}

async function bench(fn: (i: number) => Promise<unknown>, iters = ITERATIONS, warmup = WARMUP): Promise<Stat> {
  for (let i = 0; i < warmup; i++) await fn(i);
  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    await fn(i);
    times.push(performance.now() - t);
  }
  return stats(times);
}

// ---------------------------------------------------------------------------
// Seeding (uniform: Turbine createMany in batches)
// ---------------------------------------------------------------------------

async function seed(db: TurbineClient) {
  const batch = 200;
  const load = async (tbl: string, rows: Row[]) => {
    const t = db.table(tbl);
    for (let i = 0; i < rows.length; i += batch) {
      await t.createMany({ data: rows.slice(i, i + batch) as never });
    }
  };
  await load('organizations', SEED.orgs);
  await load('users', SEED.users);
  await load('posts', SEED.posts);
  await load('comments', SEED.comments);
}

// ---------------------------------------------------------------------------
// The operation suite (identical across engines)
// ---------------------------------------------------------------------------

const OPS: { key: string; label: string; iters?: number }[] = [
  { key: 'point_read', label: 'findUnique by PK' },
  { key: 'filtered_list', label: 'findMany filter+order+limit' },
  { key: 'nested', label: 'nested with (posts→comments)', iters: 80 },
  { key: 'insert_one', label: 'create (single insert)', iters: 150 },
  { key: 'bulk_insert', label: 'createMany (100 rows)', iters: 40 },
  { key: 'atomic_update', label: 'update (increment)', iters: 150 },
];

async function runOps(db: TurbineClient): Promise<Record<string, Stat>> {
  const users = db.table('users');
  const posts = db.table('posts');
  const comments = db.table('comments');
  const maxPost = SEED.posts.length;
  let nextId = TOTAL_ROWS + 1_000_000; // PK space for inserts, away from seed
  const out: Record<string, Stat> = {};

  out.point_read = await bench((i) => posts.findUnique({ where: { id: (i % maxPost) + 1 } }));

  out.filtered_list = await bench(() =>
    posts.findMany({ where: { published: true }, orderBy: { viewCount: 'desc' }, limit: 20 }),
  );

  out.nested = await bench(
    () => users.findMany({ where: { role: 'member' }, with: { posts: { with: { comments: true }, limit: 5 } }, limit: 10 }),
    80,
  );

  out.insert_one = await bench(
    (i) => posts.create({ data: { id: nextId++, userId: 1, orgId: 1, title: `b${i}`, content: 'x', published: true, viewCount: 0 } }),
    150,
  );

  out.bulk_insert = await bench(() => {
    const data = Array.from({ length: 100 }, (_, k) => ({
      id: nextId++,
      postId: 1,
      userId: 1,
      body: `bulk ${k}`,
    }));
    return comments.createMany({ data: data as never });
  }, 40);

  out.atomic_update = await bench(
    (i) => posts.update({ where: { id: (i % maxPost) + 1 }, data: { viewCount: { increment: 1 } } }),
    150,
  );

  return out;
}

// ---------------------------------------------------------------------------
// Engine adapters
// ---------------------------------------------------------------------------

interface Engine {
  name: string;
  setup(): Promise<TurbineClient>;
  teardown(db: TurbineClient): Promise<void>;
}

const engines: Record<string, Engine> = {
  pg: {
    name: 'Postgres 16',
    async setup() {
      const pg = require('pg');
      const pool = new pg.Pool({ connectionString: PG_URL });
      for (const stmt of sqlDDL('pg')) await pool.query(stmt);
      await pool.end();
      return new TurbineClient({ connectionString: PG_URL, poolSize: 1 }, schema);
    },
    async teardown(db) {
      await db.disconnect();
    },
  },
  sqlite: {
    name: 'SQLite (node:sqlite)',
    async setup() {
      const { DatabaseSync } = require('node:sqlite');
      const dbi = new DatabaseSync(':memory:');
      for (const stmt of sqlDDL('sqlite')) dbi.exec(stmt);
      return turbineSqlite(dbi, schema, { warnOnUnlimited: false });
    },
    async teardown(db) {
      await db.disconnect();
    },
  },
  mysql: {
    name: 'MySQL 9',
    async setup() {
      const mysql = require('mysql2/promise');
      const conn = await mysql.createConnection(MYSQL_URL);
      for (const stmt of sqlDDL('mysql')) await conn.query(stmt);
      await conn.end();
      return turbineMysql(MYSQL_URL, schema, { warnOnUnlimited: false });
    },
    async teardown(db) {
      await db.disconnect();
    },
  },
  mssql: {
    name: 'SQL Server 2022',
    async setup() {
      const mssql = require('mssql');
      const pool = await mssql.connect(MSSQL_URL);
      for (const stmt of sqlDDL('mssql')) await pool.request().query(stmt);
      await pool.close();
      return turbineMssql(MSSQL_URL, schema, { warnOnUnlimited: false });
    },
    async teardown(db) {
      await db.disconnect();
    },
  },
  powdb: {
    // Networked v0.7.0. Start the server with POWDB_SYNC_MODE=normal (and
    // optionally -s <sock>) to measure the Normal-durability + Unix-socket path.
    name: POWDB_SOCKET ? 'PowDB 0.7.1 (net+sock)' : 'PowDB 0.7.1 (net)',
    async setup() {
      const conn = POWDB_SOCKET ? { path: POWDB_SOCKET } : { host: POWDB_HOST, port: POWDB_PORT };
      const { Client } = await import('@zvndev/powdb-client');
      const raw = await Client.connect(conn as never);
      // PowDB has no "DROP IF EXISTS"; drop each type (ignore if absent) then recreate.
      for (const t of Object.keys(schema.tables)) await raw.query(`drop ${t}`).catch(() => {});
      for (const stmt of powqlSchemaDDL(schema)) await raw.query(stmt);
      await raw.close();
      return turbinePowDB(conn as never, schema, { warnOnUnlimited: false });
    },
    async teardown(db) {
      await db.disconnect();
    },
  },
  powdb_emb: {
    // In-process embedded v0.7.1 (@zvndev/powdb-embedded). No server, no wire —
    // the SQLite-shaped path. Single handle: DDL runs through db.raw() (NOT a
    // second Database.open on the same dir, which has no lock and would corrupt).
    // syncMode:'normal' (0.7.1) moves fsync off the commit path — the knob that
    // closes the embedded-write gap.
    name: `PowDB ${powdbEmbeddedVersion()} (embed·norm)`,
    async setup() {
      const dir = POWDB_EMB_DIR ?? mkdtempSync(join(tmpdir(), 'powdb-emb-bench-'));
      powdbEmbDir = dir;
      const db = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, schema, { warnOnUnlimited: false });
      // DDL on the single embedded handle (no params → raw PowQL passthrough).
      for (const t of Object.keys(schema.tables)) {
        await (db.raw as unknown as (s: string[]) => Promise<unknown>)([`drop ${t}`]).catch(() => {});
      }
      for (const stmt of powqlSchemaDDL(schema)) {
        await (db.raw as unknown as (s: string[]) => Promise<unknown>)([stmt]);
      }
      return db;
    },
    async teardown(db) {
      await db.disconnect();
      if (powdbEmbDir && !POWDB_EMB_DIR) rmSync(powdbEmbDir, { recursive: true, force: true });
      powdbEmbDir = undefined;
    },
  },
};

let powdbEmbDir: string | undefined;

// ---------------------------------------------------------------------------
// Runner + report
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nturbine-orm cross-engine benchmark`);
  console.log(`seed: ${ORGS} orgs / ${SEED.users.length} users / ${SEED.posts.length} posts / ${SEED.comments.length} comments (${TOTAL_ROWS} rows)`);
  console.log(`iterations: ${ITERATIONS} (warmup ${WARMUP}); engines: ${ENGINES.join(', ')}\n`);

  const results: Record<string, Record<string, Stat>> = {};
  const seedTimes: Record<string, number> = {};

  for (const key of ENGINES) {
    const engine = engines[key];
    if (!engine) {
      console.log(`  ?? unknown engine "${key}" — skipping`);
      continue;
    }
    process.stdout.write(`  ${engine.name.padEnd(22)} setup… `);
    let db: TurbineClient | undefined;
    try {
      db = await engine.setup();
      const t0 = performance.now();
      await seed(db);
      seedTimes[key] = performance.now() - t0;
      process.stdout.write(`seed ${seedTimes[key].toFixed(0)}ms … running… `);
      results[key] = await runOps(db);
      console.log(`done`);
    } catch (err) {
      console.log(`FAILED: ${(err as Error).message.split('\n')[0]}`);
    } finally {
      if (db) await engine.teardown(db).catch(() => {});
    }
  }

  // Report: one table per op, engines as columns.
  const ran = ENGINES.filter((k) => results[k]);
  const namePad = 30;
  console.log(`\n${'='.repeat(80)}\nRESULTS — median (p50) latency in ms, lower is better\n${'='.repeat(80)}`);
  const header = 'operation'.padEnd(namePad) + ran.map((k) => engines[k]!.name.split(' ')[0]!.padStart(12)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const op of OPS) {
    const line = op.label.padEnd(namePad) + ran.map((k) => (results[k]![op.key]?.p50.toFixed(3) ?? '—').padStart(12)).join('');
    console.log(line);
  }

  console.log(`\np95 latency (ms):`);
  console.log('-'.repeat(header.length));
  for (const op of OPS) {
    const line = op.label.padEnd(namePad) + ran.map((k) => (results[k]![op.key]?.p95.toFixed(3) ?? '—').padStart(12)).join('');
    console.log(line);
  }

  console.log(`\nthroughput (ops/sec, from mean):`);
  console.log('-'.repeat(header.length));
  for (const op of OPS) {
    const line = op.label.padEnd(namePad) + ran.map((k) => (results[k]![op.key]?.ops.toFixed(0) ?? '—').padStart(12)).join('');
    console.log(line);
  }

  console.log(`\nseed time (${TOTAL_ROWS} rows via createMany): ` + ran.map((k) => `${engines[k]!.name.split(' ')[0]}=${seedTimes[k]?.toFixed(0)}ms`).join('  '));

  // Machine-readable dump.
  console.log(`\nJSON:\n${JSON.stringify({ config: { USERS, POSTS_PER_USER, COMMENTS_PER_POST, ITERATIONS }, seedTimes, results }, null, 0)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
