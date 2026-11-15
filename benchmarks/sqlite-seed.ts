/** Full-size deterministic SQLite fixture for the original comparison catalog. */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveTurbine } from './sqlite-comparison-identity.js';

export const EPOCH = '2023-11-14T22:13:20.000Z';
export const volumes = {
  organizations: 5,
  users: 1000,
  posts: 10000,
  comments: 50000,
  tags: 50,
  post_tags: 30000,
  bench_wide: 2000,
  bench_writes: 0,
  bench_page: 24000,
  bench_tiny: 17,
  bench_parents: 4,
  bench_children: 52,
};
export const fields: Record<string, string[]> = {
  organizations: ['id', 'name', 'slug', 'plan', 'createdAt'],
  users: ['id', 'orgId', 'email', 'name', 'role', 'avatarUrl', 'lastLoginAt', 'createdAt'],
  posts: ['id', 'userId', 'orgId', 'title', 'content', 'published', 'viewCount', 'createdAt', 'updatedAt'],
  comments: ['id', 'postId', 'userId', 'body', 'createdAt'],
  tags: ['id', 'name', 'slug'],
  post_tags: ['postId', 'tagId'],
  bench_writes: ['id', 'orgId', 'slug', 'label', 'amount', 'active', 'createdAt'],
  bench_wide: [
    'id',
    ...Array.from({ length: 20 }, (_, i) => `t${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 10 }, (_, i) => `n${String(i + 1).padStart(2, '0')}`),
    ...Array.from({ length: 5 }, (_, i) => `b${String(i + 1).padStart(2, '0')}`),
    'd01',
    'd02',
    'd03',
  ],
  bench_page: ['id', 'score', 'bucket', 'label'],
  bench_tiny: ['id', 'score', 'bucket', 'label'],
  bench_parents: ['id'],
  bench_children: ['id', 'parent', 'label'],
};
export const column = (key: string) => key.replace(/[A-Z]/g, (x) => `_${x.toLowerCase()}`);
export function decodeRow(table: string, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of fields[table]!) {
    let v = Object.hasOwn(input, key) ? input[key] : input[column(key)];
    if (v !== null && (key.endsWith('At') || /^d\d\d$/.test(key))) v = new Date(v as string);
    if (v !== null && (key === 'published' || key === 'active' || /^b\d\d$/.test(key))) {
      if (v !== 0 && v !== 1 && typeof v !== 'boolean') throw new Error(`Invalid boolean ${table}.${key}`);
      v = v === 1 || v === true;
    }
    out[key] = v;
  }
  return out;
}
export function fixtureRow(table: string, id: number): Record<string, unknown> {
  const orgId = ((id - 1) % 5) + 1;
  switch (table) {
    case 'organizations':
      return {
        id,
        name: ['Acme Inc', 'Beta LLC', 'Gamma Co', 'Delta Corp', 'Epsilon Studios'][id - 1],
        slug: ['acme', 'beta', 'gamma', 'delta', 'epsilon'][id - 1],
        plan: ['enterprise', 'pro', 'pro', 'free', 'free'][id - 1],
        createdAt: new Date(EPOCH),
      };
    case 'users':
      return {
        id,
        orgId,
        email: `user${id}@bench.example.com`,
        name: `User ${id}`,
        role: id % 10 === 0 ? 'admin' : id % 5 === 0 ? 'editor' : 'member',
        avatarUrl: null,
        lastLoginAt: null,
        createdAt: new Date(EPOCH),
      };
    case 'posts': {
      const userId = Math.floor((id - 1) / 10) + 1,
        p = ((id - 1) % 10) + 1;
      return {
        id,
        userId,
        orgId: ((userId - 1) % 5) + 1,
        title: `Post ${p} from user ${userId}`,
        content: `Content body for post ${p} by user ${userId}. Lorem ipsum dolor sit amet consectetur.`,
        published: p % 3 !== 0,
        viewCount: (p * 17) % 500,
        createdAt: new Date(EPOCH),
        updatedAt: new Date(EPOCH),
      };
    }
    case 'comments': {
      const postId = Math.floor((id - 1) / 5) + 1,
        c = ((id - 1) % 5) + 1;
      return {
        id,
        postId,
        userId: ((postId + c - 1) % 1000) + 1,
        body: `Comment ${c} on post ${postId}. Great article, thanks for sharing!`,
        createdAt: new Date(EPOCH),
      };
    }
    case 'tags':
      return { id, name: `Tag ${id}`, slug: `tag-${id}` };
    case 'bench_wide':
      return Object.fromEntries(
        fields[table]!.map((k) => [
          k,
          k === 'id'
            ? id
            : k[0] === 't'
              ? `row ${id} text value ${Number(k.slice(1))}`
              : k[0] === 'n'
                ? (id * (Number(k.slice(1)) + 2)) % 10000
                : k[0] === 'b'
                  ? (id + Number(k.slice(1)) - 1) % 2 === 0
                  : new Date(1700000000000 + id * Number(k.slice(1)) * 1000),
        ]),
      );
    case 'bench_parents':
      return { id };
    case 'bench_children': {
      const parent = Math.floor((id - 1) / 13) + 1;
      return { id, parent, label: `child:${parent}:${((id - 1) % 13) + 1}` };
    }
    case 'bench_tiny':
    case 'bench_page':
      return {
        id,
        score: id % 19 === 0 ? null : Math.floor((id - 1) / 4) % 300,
        bucket: id % 100,
        label: `page:${id}:λ'\\`,
      };
    default:
      throw new Error(`No fixture generator for ${table}`);
  }
}
const defaultDate = `DATETIME NOT NULL DEFAULT '${EPOCH}'`;
export const ddl = `
CREATE TABLE organizations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,plan TEXT NOT NULL DEFAULT 'free',created_at ${defaultDate});
CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT,org_id INTEGER NOT NULL REFERENCES organizations(id),email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,role TEXT NOT NULL DEFAULT 'member',avatar_url TEXT,last_login_at DATETIME,created_at ${defaultDate});
CREATE INDEX idx_users_org_id ON users(org_id);
CREATE TABLE posts(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL REFERENCES users(id),org_id INTEGER NOT NULL REFERENCES organizations(id),title TEXT NOT NULL,content TEXT NOT NULL,published BOOLEAN NOT NULL DEFAULT 0,view_count INTEGER NOT NULL DEFAULT 0,created_at ${defaultDate},updated_at ${defaultDate});
CREATE INDEX idx_posts_user_id ON posts(user_id); CREATE INDEX idx_posts_org_id ON posts(org_id); CREATE INDEX idx_posts_created_at ON posts(created_at);
CREATE TABLE comments(id INTEGER PRIMARY KEY AUTOINCREMENT,post_id INTEGER NOT NULL REFERENCES posts(id),user_id INTEGER NOT NULL REFERENCES users(id),body TEXT NOT NULL,created_at ${defaultDate});
CREATE INDEX idx_comments_post_id ON comments(post_id); CREATE INDEX idx_comments_user_id ON comments(user_id);
CREATE TABLE tags(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,slug TEXT NOT NULL UNIQUE);
CREATE TABLE post_tags(post_id INTEGER NOT NULL REFERENCES posts(id),tag_id INTEGER NOT NULL REFERENCES tags(id),PRIMARY KEY(post_id,tag_id)); CREATE INDEX idx_post_tags_tag_id ON post_tags(tag_id);
CREATE TABLE bench_wide(id INTEGER PRIMARY KEY AUTOINCREMENT,${fields
  .bench_wide!.slice(1)
  .map(
    (k) => `${k} ${k[0] === 't' ? 'TEXT' : k[0] === 'n' ? 'INTEGER' : k[0] === 'b' ? 'BOOLEAN' : 'DATETIME'} NOT NULL`,
  )
  .join(',')});
CREATE TABLE bench_writes(id INTEGER PRIMARY KEY AUTOINCREMENT,org_id INTEGER NOT NULL,slug TEXT NOT NULL UNIQUE,label TEXT NOT NULL,amount INTEGER NOT NULL DEFAULT 0,active BOOLEAN NOT NULL DEFAULT 1,created_at ${defaultDate}); CREATE INDEX idx_bench_writes_org_id ON bench_writes(org_id);
CREATE TABLE bench_parents(id INTEGER PRIMARY KEY); CREATE TABLE bench_children(id INTEGER PRIMARY KEY,parent INTEGER NOT NULL REFERENCES bench_parents(id),label TEXT NOT NULL); CREATE INDEX idx_bench_children_parent ON bench_children(parent,id);
CREATE TABLE bench_tiny(id INTEGER PRIMARY KEY,score INTEGER,bucket INTEGER NOT NULL,label TEXT NOT NULL);
CREATE TABLE bench_page(id INTEGER PRIMARY KEY,score INTEGER,bucket INTEGER NOT NULL,label TEXT NOT NULL); CREATE INDEX idx_bench_page_score ON bench_page(score,id);
`;
export const seedHandleAudit: { file: string; closed: boolean }[] = [];
export async function seedSqlite(file: string): Promise<void> {
  if (existsSync(file)) throw new Error(`Refusing to overwrite SQLite file: ${file}`);
  const implementation = resolveTurbine();
  const { generate } = await import(pathToFileURL(implementation.generationEntry).href);
  const { introspectSqliteDatabase } = await import(pathToFileURL(implementation.entry).href);
  const db = new DatabaseSync(file);
  const audit = { file, closed: false };
  seedHandleAudit.push(audit);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN');
    db.exec(ddl);
    for (const [table, n] of Object.entries(volumes)) {
      if (table === 'post_tags' || !n) continue;
      const keys = fields[table]!;
      const insert = db.prepare(
        `INSERT INTO ${table} (${keys.map(column).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      );
      for (let i = 1; i <= n; i++) {
        const row = fixtureRow(table, i);
        insert.run(
          ...(keys.map((k) =>
            row[k] instanceof Date
              ? (row[k] as Date).toISOString()
              : typeof row[k] === 'boolean'
                ? Number(row[k])
                : row[k],
          ) as (string | number | null)[]),
        );
      }
    }
    const junction = db.prepare('INSERT INTO post_tags VALUES (?,?)');
    for (let p = 1; p <= 10000; p++) for (const off of [0, 17, 31]) junction.run(p, (((p % 50) + off) % 50) + 1);
    db.exec('COMMIT; ANALYZE');
    generate({
      schema: introspectSqliteDatabase(db),
      target: 'sqlite',
      outDir: fileURLToPath(new URL('./generated/sqlite-turbine', import.meta.url)),
      noTimestamp: true,
      importExtension: 'js',
    });
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
    audit.closed = !db.isOpen;
  }
  if (!audit.closed) throw new Error('Seed native handle failed to close');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.SQLITE_FILE) throw new Error('SQLITE_FILE is required and must not already exist');
  await seedSqlite(resolve(process.env.SQLITE_FILE));
  console.log(JSON.stringify({ file: resolve(process.env.SQLITE_FILE), volumes }));
}
