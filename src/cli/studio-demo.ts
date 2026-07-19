/**
 * turbine-orm CLI: Studio demo mode (`turbine studio --demo`)
 *
 * Boots Studio with NO database and NO DATABASE_URL: a baked-in, seeded sample
 * dataset served from an in-memory engine. It is the "feel the product in 10
 * seconds" experience: read mode, PII redaction, and the single-row write flow,
 * all safely fake.
 *
 * The store is backed by Turbine's OWN SQLite engine over `node:sqlite`'s
 * `:memory:` database (a built-in on Node >= 22.5, zero new dependency). Because
 * `:memory:` is per-handle, the store dies with the process and every launch
 * starts pristine: writes genuinely apply (edits stick, a refresh shows them)
 * but nothing is ever persisted anywhere.
 *
 * This module lives under `src/cli/` (coverage-excluded, never imported by
 * library code) and reuses `SqlitePool` + `sqliteDialect` from `../sqlite.js`;
 * it never writes its own SQL evaluator.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import type { PgCompatPool } from '../client.js';
import type { Dialect } from '../dialect.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { SqlitePool, sqliteDialect } from '../sqlite.js';

// ---------------------------------------------------------------------------
// Node-version-scoped driver load
// ---------------------------------------------------------------------------

/** The shape of `node:sqlite`'s `DatabaseSync` constructor. */
type DatabaseSyncCtor = new (path: string) => DatabaseSync;

/**
 * Load `node:sqlite`'s `DatabaseSync` constructor, throwing a clear,
 * demo-specific message on older Node. Kept lazy (called only when a demo
 * context is actually created) so `import`ing this module never crashes the CLI
 * on Node < 22.5.
 */
function loadDatabaseSync(): DatabaseSyncCtor {
  let ctor: DatabaseSyncCtor | undefined;
  try {
    const req = createRequire(process.cwd());
    ctor = (req('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor }).DatabaseSync;
  } catch {
    ctor = undefined;
  }
  if (typeof ctor !== 'function') {
    throw new Error('studio --demo needs Node 22.5+ (uses the built-in node:sqlite engine)');
  }
  return ctor;
}

// ---------------------------------------------------------------------------
// DEMO_SCHEMA: hand-written SchemaMetadata for the sample dataset
// ---------------------------------------------------------------------------

interface DemoColumnSpec {
  name: string;
  field: string;
  pgType: string;
  nullable?: boolean;
  pii?: boolean;
  isGenerated?: boolean;
  hasDefault?: boolean;
}

/** Map a demo column's Postgres-flavored type to a TypeScript type string. */
function demoTsType(pgType: string, nullable: boolean): string {
  let base: string;
  if (/int|serial/i.test(pgType)) base = 'number';
  else if (/bool/i.test(pgType)) base = 'boolean';
  else if (/timestamp|date/i.test(pgType)) base = 'Date';
  else base = 'string';
  return nullable ? `${base} | null` : base;
}

function demoColumn(spec: DemoColumnSpec): ColumnMetadata {
  const nullable = spec.nullable === true;
  return {
    name: spec.name,
    field: spec.field,
    dialectType: spec.pgType,
    pgType: spec.pgType,
    tsType: demoTsType(spec.pgType, nullable),
    nullable,
    hasDefault: spec.hasDefault ?? spec.isGenerated ?? false,
    isGenerated: spec.isGenerated === true,
    pii: spec.pii === true,
    isArray: false,
    pgArrayType: 'text[]',
  };
}

function demoTable(
  name: string,
  columnSpecs: DemoColumnSpec[],
  relations: TableMetadata['relations'] = {},
): TableMetadata {
  const columns = columnSpecs.map(demoColumn);
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const dateColumns = new Set<string>();
  const pgTypes: Record<string, string> = {};
  const allColumns: string[] = [];

  for (const col of columns) {
    columnMap[col.field] = col.name;
    reverseColumnMap[col.name] = col.field;
    pgTypes[col.name] = col.pgType;
    allColumns.push(col.name);
    if (/timestamp|date/i.test(col.pgType)) dateColumns.add(col.name);
  }

  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns,
    dialectTypes: pgTypes,
    pgTypes,
    allColumns,
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

/**
 * The seeded sample schema. Four tables with realistic relations; `email` and
 * `phone` are tagged `pii` so Studio's redaction path is exercised out of the
 * box.
 */
export const DEMO_SCHEMA: SchemaMetadata = {
  tables: {
    users: demoTable(
      'users',
      [
        { name: 'id', field: 'id', pgType: 'int4', isGenerated: true },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'email', field: 'email', pgType: 'text', pii: true },
        { name: 'phone', field: 'phone', pgType: 'text', nullable: true, pii: true },
        { name: 'role', field: 'role', pgType: 'text' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    posts: demoTable(
      'posts',
      [
        { name: 'id', field: 'id', pgType: 'int4', isGenerated: true },
        { name: 'user_id', field: 'userId', pgType: 'int4' },
        { name: 'title', field: 'title', pgType: 'text' },
        { name: 'body', field: 'body', pgType: 'text' },
        { name: 'published', field: 'published', pgType: 'bool' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
      ],
      {
        comments: {
          type: 'hasMany',
          name: 'comments',
          from: 'posts',
          to: 'comments',
          foreignKey: 'post_id',
          referenceKey: 'id',
        },
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'posts',
          to: 'users',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    comments: demoTable(
      'comments',
      [
        { name: 'id', field: 'id', pgType: 'int4', isGenerated: true },
        { name: 'post_id', field: 'postId', pgType: 'int4' },
        { name: 'user_id', field: 'userId', pgType: 'int4' },
        { name: 'body', field: 'body', pgType: 'text' },
        { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
      ],
      {
        post: {
          type: 'belongsTo',
          name: 'post',
          from: 'comments',
          to: 'posts',
          foreignKey: 'post_id',
          referenceKey: 'id',
        },
        user: {
          type: 'belongsTo',
          name: 'user',
          from: 'comments',
          to: 'users',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    orgs: demoTable('orgs', [
      { name: 'id', field: 'id', pgType: 'int4', isGenerated: true },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'plan', field: 'plan', pgType: 'text' },
    ]),
  },
  enums: {},
};

// ---------------------------------------------------------------------------
// Deterministic seed data (hardcoded, no randomness)
// ---------------------------------------------------------------------------

/** A fixed base instant so every launch produces byte-identical timestamps. */
const SEED_EPOCH = Date.UTC(2024, 0, 1, 9, 0, 0);
const DAY_MS = 86_400_000;

/** ISO timestamp `n` days after the seed epoch (deterministic, no `Date.now()`). */
function seedTime(dayOffset: number): string {
  return new Date(SEED_EPOCH + dayOffset * DAY_MS).toISOString();
}

interface SeedUser {
  id: number;
  name: string;
  email: string;
  phone: string | null;
  role: string;
}

const USERS: SeedUser[] = [
  { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', phone: '+1-202-555-0101', role: 'admin' },
  { id: 2, name: 'Grace Hopper', email: 'grace@example.com', phone: '+1-202-555-0102', role: 'admin' },
  { id: 3, name: 'Alan Turing', email: 'alan@example.com', phone: '+1-202-555-0103', role: 'member' },
  { id: 4, name: 'Katherine Johnson', email: 'katherine@example.com', phone: '+1-202-555-0104', role: 'member' },
  { id: 5, name: 'Linus Torvalds', email: 'linus@example.com', phone: '+1-202-555-0105', role: 'member' },
  { id: 6, name: 'Margaret Hamilton', email: 'margaret@example.com', phone: null, role: 'member' },
  { id: 7, name: 'Dennis Ritchie', email: 'dennis@example.com', phone: '+1-202-555-0107', role: 'member' },
  { id: 8, name: 'Barbara Liskov', email: 'barbara@example.com', phone: '+1-202-555-0108', role: 'viewer' },
];

const ORGS: { id: number; name: string; plan: string }[] = [
  { id: 1, name: 'Analytical Engines', plan: 'pro' },
  { id: 2, name: 'Compiler Collective', plan: 'team' },
  { id: 3, name: 'Kernel Works', plan: 'free' },
];

interface SeedPost {
  id: number;
  userId: number;
  title: string;
  body: string;
  published: boolean;
  createdAt: string;
}

const POST_TOPICS = [
  'Notes on the Analytical Engine',
  'Debugging the first moth',
  'On computable numbers',
  'Orbital mechanics by hand',
  'Why monolithic kernels win',
  'The Apollo guidance software',
  'A tour of the C language',
  'Abstraction and specification',
  'Loop invariants in practice',
  'Sequential vs parallel search',
];

/** 20 deterministic posts spread across the 8 users. */
const POSTS: SeedPost[] = Array.from({ length: 20 }, (_, i) => {
  const id = i + 1;
  const userId = (i % USERS.length) + 1;
  return {
    id,
    userId,
    title: `${POST_TOPICS[i % POST_TOPICS.length]} (part ${Math.floor(i / POST_TOPICS.length) + 1})`,
    body: `A short sample body for post ${id}, written by user ${userId}. Everything here is fake demo data.`,
    published: id % 4 !== 0,
    createdAt: seedTime(id),
  };
});

interface SeedComment {
  id: number;
  postId: number;
  userId: number;
  body: string;
  createdAt: string;
}

/** 40 deterministic comments (two per post), authored round-robin. */
const COMMENTS: SeedComment[] = Array.from({ length: 40 }, (_, i) => {
  const id = i + 1;
  const postId = (i % POSTS.length) + 1;
  const userId = ((i * 3) % USERS.length) + 1;
  return {
    id,
    postId,
    userId,
    body: `Comment ${id} on post ${postId}. Nicely done. This is seeded demo content.`,
    createdAt: seedTime(20 + id),
  };
});

// ---------------------------------------------------------------------------
// DDL + seeding
// ---------------------------------------------------------------------------

/** SQLite DDL for the demo tables. Types map cleanly onto SQLite affinities. */
const DEMO_DDL = `
CREATE TABLE orgs (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  plan  TEXT NOT NULL
);
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT,
  role        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE posts (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  published   INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE comments (
  id          INTEGER PRIMARY KEY,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  user_id     INTEGER NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
`;

function seedDemoData(db: DatabaseSync): void {
  const insOrg = db.prepare('INSERT INTO orgs (id, name, plan) VALUES (?, ?, ?)');
  for (const o of ORGS) insOrg.run(o.id, o.name, o.plan);

  const insUser = db.prepare('INSERT INTO users (id, name, email, phone, role, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const u of USERS) insUser.run(u.id, u.name, u.email, u.phone, u.role, seedTime(u.id));

  const insPost = db.prepare(
    'INSERT INTO posts (id, user_id, title, body, published, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  for (const p of POSTS) insPost.run(p.id, p.userId, p.title, p.body, p.published ? 1 : 0, p.createdAt);

  const insComment = db.prepare('INSERT INTO comments (id, post_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const c of COMMENTS) insComment.run(c.id, c.postId, c.userId, c.body, c.createdAt);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

export interface DemoContext {
  /** In-memory SQLite pool (pg-compatible) backing the demo store. */
  pool: PgCompatPool;
  /** The seeded sample schema metadata. */
  metadata: SchemaMetadata;
  /** The SQLite dialect the Studio handlers compile against in demo mode. */
  dialect: Dialect;
}

/**
 * Open a fresh, seeded in-memory demo store and return the pool + metadata +
 * dialect Studio needs. Each call yields an independent, pristine database
 * (`:memory:` is per-handle), so demo launches never share state.
 *
 * @throws Error on Node < 22.5 (no built-in `node:sqlite`).
 */
export function createDemoContext(): DemoContext {
  const DatabaseSyncCtor = loadDatabaseSync();
  const db = new DatabaseSyncCtor(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(DEMO_DDL);
  seedDemoData(db);
  return { pool: new SqlitePool(db), metadata: DEMO_SCHEMA, dialect: sqliteDialect };
}
