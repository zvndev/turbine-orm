/**
 * Deterministic seed for the parity harness.
 *
 * Loads a SMALL, fully-deterministic dataset so all three ORMs query the
 * exact same rows:
 *   - 4 organizations
 *   - 20 users
 *   - 100 posts (5 per user)
 *   - 300 comments (3 per post)
 *
 * The data is intentionally varied so the where-operator / aggregate /
 * orderBy scenarios actually exercise distinct branches:
 *   - roles cycle through admin / editor / member
 *   - names use a mix of cases so `mode: insensitive` differs from default
 *   - avatar_url / last_login_at are NULL for some rows (null-check coverage)
 *   - view_count is a spread of integers (sum/avg/min/max coverage)
 *   - published alternates (boolean equality coverage)
 *
 * Timestamps are pinned to fixed values (no NOW()) so created_at ordering
 * and ISO normalisation are 100% reproducible across runs and machines.
 *
 * Run:
 *   DATABASE_URL=postgres://localhost:5432/turbine_parity npx tsx parity/seed.ts
 */

import pg from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

export const N_ORGS = 4;
export const N_USERS = 20;
export const POSTS_PER_USER = 5;
export const COMMENTS_PER_POST = 3;

const SCHEMA_SQL = `
DROP TABLE IF EXISTS comments CASCADE;
DROP TABLE IF EXISTS posts CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;

CREATE TABLE organizations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id        BIGINT NOT NULL REFERENCES organizations(id),
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  avatar_url    TEXT,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_org_id ON users(org_id);

CREATE TABLE posts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id),
  org_id      BIGINT NOT NULL REFERENCES organizations(id),
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  published   BOOLEAN NOT NULL DEFAULT FALSE,
  view_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_posts_user_id ON posts(user_id);
CREATE INDEX idx_posts_org_id ON posts(org_id);
CREATE INDEX idx_posts_created_at ON posts(created_at);

CREATE TABLE comments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id     BIGINT NOT NULL REFERENCES posts(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_comments_post_id ON comments(post_id);
CREATE INDEX idx_comments_user_id ON comments(user_id);
`;

// Fixed epoch anchor so every created_at is deterministic.
const BASE = Date.UTC(2025, 0, 1, 12, 0, 0); // 2025-01-01T12:00:00Z
const iso = (offsetMinutes: number) => new Date(BASE + offsetMinutes * 60_000).toISOString();

// A small pool of name fragments chosen so case-insensitive matching,
// startsWith / endsWith / contains all hit different result sets.
const FIRST = ['Alice', 'Bob', 'Carol', 'dave', 'Eve', 'frank', 'Grace', 'Heidi', 'Ivan', 'judy'];
const LAST = ['Smith', 'jones', 'Brown', 'WILLIAMS', 'Taylor'];

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

  console.log('Applying schema...');
  await pool.query(SCHEMA_SQL);

  // ── Organizations ──────────────────────────────────────────
  await pool.query(`
    INSERT INTO organizations (name, slug, plan, created_at) VALUES
      ('Acme Inc',        'acme',    'enterprise', $1),
      ('Beta LLC',        'beta',    'pro',        $2),
      ('Gamma Co',        'gamma',   'free',       $3),
      ('Delta Corp',      'delta',   'free',       $4)
  `, [iso(0), iso(1), iso(2), iso(3)]);

  // ── Users ──────────────────────────────────────────────────
  {
    const orgIds: number[] = [];
    const emails: string[] = [];
    const names: string[] = [];
    const roles: string[] = [];
    const avatars: (string | null)[] = [];
    const logins: (string | null)[] = [];
    const created: string[] = [];
    for (let i = 1; i <= N_USERS; i++) {
      orgIds.push(((i - 1) % N_ORGS) + 1);
      emails.push(`user${i}@parity.example.com`);
      names.push(`${FIRST[(i - 1) % FIRST.length]} ${LAST[(i - 1) % LAST.length]}`);
      roles.push(i % 5 === 0 ? 'admin' : i % 3 === 0 ? 'editor' : 'member');
      // Every 4th user has no avatar; every 3rd has never logged in.
      avatars.push(i % 4 === 0 ? null : `https://avatars.example.com/u${i}.png`);
      logins.push(i % 3 === 0 ? null : iso(100 + i));
      created.push(iso(10 + i));
    }
    await pool.query(
      `INSERT INTO users (org_id, email, name, role, avatar_url, last_login_at, created_at)
       SELECT * FROM UNNEST(
         $1::bigint[], $2::text[], $3::text[], $4::text[],
         $5::text[], $6::timestamptz[], $7::timestamptz[]
       )`,
      [orgIds, emails, names, roles, avatars, logins, created],
    );
  }

  // ── Posts ──────────────────────────────────────────────────
  {
    const userIds: number[] = [];
    const orgIds: number[] = [];
    const titles: string[] = [];
    const contents: string[] = [];
    const published: boolean[] = [];
    const viewCounts: number[] = [];
    const created: string[] = [];
    const updated: string[] = [];
    let postSeq = 0;
    for (let u = 1; u <= N_USERS; u++) {
      for (let p = 1; p <= POSTS_PER_USER; p++) {
        postSeq++;
        userIds.push(u);
        orgIds.push(((u - 1) % N_ORGS) + 1);
        titles.push(`Post ${p} from user ${u}`);
        contents.push(`Body for post ${p} by user ${u}. Lorem ipsum dolor.`);
        published.push(postSeq % 2 === 0);
        // Deterministic spread 0..495.
        viewCounts.push((postSeq * 17) % 500);
        created.push(iso(1000 + postSeq));
        updated.push(iso(2000 + postSeq));
      }
    }
    await pool.query(
      `INSERT INTO posts (user_id, org_id, title, content, published, view_count, created_at, updated_at)
       SELECT * FROM UNNEST(
         $1::bigint[], $2::bigint[], $3::text[], $4::text[],
         $5::boolean[], $6::int[], $7::timestamptz[], $8::timestamptz[]
       )`,
      [userIds, orgIds, titles, contents, published, viewCounts, created, updated],
    );
  }

  // ── Comments ───────────────────────────────────────────────
  {
    const postIds: number[] = [];
    const userIds: number[] = [];
    const bodies: string[] = [];
    const created: string[] = [];
    const totalPosts = N_USERS * POSTS_PER_USER;
    let commentSeq = 0;
    for (let pid = 1; pid <= totalPosts; pid++) {
      for (let c = 1; c <= COMMENTS_PER_POST; c++) {
        commentSeq++;
        postIds.push(pid);
        userIds.push(((pid + c - 1) % N_USERS) + 1);
        bodies.push(`Comment ${c} on post ${pid}`);
        created.push(iso(5000 + commentSeq));
      }
    }
    await pool.query(
      `INSERT INTO comments (post_id, user_id, body, created_at)
       SELECT * FROM UNNEST(
         $1::bigint[], $2::bigint[], $3::text[], $4::timestamptz[]
       )`,
      [postIds, userIds, bodies, created],
    );
  }

  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM organizations)::int AS orgs,
      (SELECT COUNT(*) FROM users)::int         AS users,
      (SELECT COUNT(*) FROM posts)::int         AS posts,
      (SELECT COUNT(*) FROM comments)::int      AS comments
  `);
  console.log('Seeded:', rows[0]);

  await pool.query('ANALYZE organizations; ANALYZE users; ANALYZE posts; ANALYZE comments');
  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
