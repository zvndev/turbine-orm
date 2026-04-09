/**
 * Seed the benchmark database (Neon or local Postgres).
 *
 * Creates the bench schema and loads a fixed, reproducible dataset:
 *   - 5 organizations
 *   - 1,000 users
 *   - 10,000 posts
 *   - 50,000 comments
 *
 * Values are generated deterministically from a seeded counter so every
 * run is identical — no faker, no randomness, fair comparison.
 *
 * Run with:
 *   DATABASE_URL=... npx tsx seed-neon.ts
 */

import pg from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const USERS = Number(process.env['USERS'] ?? 1000);
const POSTS_PER_USER = Number(process.env['POSTS_PER_USER'] ?? 10);
const COMMENTS_PER_POST = Number(process.env['COMMENTS_PER_POST'] ?? 5);

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

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });

  console.log('Applying schema...');
  await pool.query(SCHEMA_SQL);

  console.log(`Seeding: ${USERS} users, ${USERS * POSTS_PER_USER} posts, ${USERS * POSTS_PER_USER * COMMENTS_PER_POST} comments`);

  // 5 orgs
  await pool.query(`
    INSERT INTO organizations (name, slug, plan) VALUES
      ('Acme Inc', 'acme', 'enterprise'),
      ('Beta LLC', 'beta', 'pro'),
      ('Gamma Co', 'gamma', 'pro'),
      ('Delta Corp', 'delta', 'free'),
      ('Epsilon Studios', 'epsilon', 'free')
  `);

  // Users — 1K, bulk UNNEST insert
  console.log('  users...');
  {
    const orgIds: number[] = [];
    const emails: string[] = [];
    const names: string[] = [];
    const roles: string[] = [];
    for (let i = 1; i <= USERS; i++) {
      orgIds.push(((i - 1) % 5) + 1);
      emails.push(`user${i}@bench.example.com`);
      names.push(`User ${i}`);
      roles.push(i % 10 === 0 ? 'admin' : i % 5 === 0 ? 'editor' : 'member');
    }
    await pool.query(
      `INSERT INTO users (org_id, email, name, role)
       SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::text[], $4::text[])`,
      [orgIds, emails, names, roles],
    );
  }

  // Posts — 10K, batched UNNEST
  console.log('  posts...');
  {
    const BATCH = 2000;
    let total = 0;
    for (let batchStart = 1; batchStart <= USERS; batchStart += BATCH / POSTS_PER_USER) {
      const batchEnd = Math.min(batchStart + BATCH / POSTS_PER_USER - 1, USERS);
      const userIds: number[] = [];
      const orgIds: number[] = [];
      const titles: string[] = [];
      const contents: string[] = [];
      const published: boolean[] = [];
      const viewCounts: number[] = [];
      for (let userId = batchStart; userId <= batchEnd; userId++) {
        for (let p = 1; p <= POSTS_PER_USER; p++) {
          userIds.push(userId);
          orgIds.push(((userId - 1) % 5) + 1);
          titles.push(`Post ${p} from user ${userId}`);
          contents.push(`Content body for post ${p} by user ${userId}. Lorem ipsum dolor sit amet consectetur.`);
          published.push(p % 3 !== 0);
          viewCounts.push(p * 17 % 500);
        }
      }
      await pool.query(
        `INSERT INTO posts (user_id, org_id, title, content, published, view_count)
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::text[], $4::text[], $5::boolean[], $6::int[])`,
        [userIds, orgIds, titles, contents, published, viewCounts],
      );
      total += userIds.length;
      process.stdout.write(`    ${total} / ${USERS * POSTS_PER_USER}\r`);
    }
    process.stdout.write('\n');
  }

  // Comments — 50K, batched UNNEST
  console.log('  comments...');
  {
    // Fetch post id range
    const r = await pool.query<{ min: string; max: string }>('SELECT MIN(id)::text AS min, MAX(id)::text AS max FROM posts');
    const minPost = Number(r.rows[0]!.min);
    const maxPost = Number(r.rows[0]!.max);
    const BATCH = 5000;
    let total = 0;
    let postId = minPost;
    while (postId <= maxPost) {
      const batchEndPost = Math.min(postId + BATCH / COMMENTS_PER_POST - 1, maxPost);
      const postIds: number[] = [];
      const userIds: number[] = [];
      const bodies: string[] = [];
      for (let pid = postId; pid <= batchEndPost; pid++) {
        for (let c = 1; c <= COMMENTS_PER_POST; c++) {
          postIds.push(pid);
          userIds.push(((pid + c - 1) % USERS) + 1);
          bodies.push(`Comment ${c} on post ${pid}. Great article, thanks for sharing!`);
        }
      }
      await pool.query(
        `INSERT INTO comments (post_id, user_id, body)
         SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::text[])`,
        [postIds, userIds, bodies],
      );
      total += postIds.length;
      process.stdout.write(`    ${total} / ${USERS * POSTS_PER_USER * COMMENTS_PER_POST}\r`);
      postId = batchEndPost + 1;
    }
    process.stdout.write('\n');
  }

  // Final counts
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM organizations)::int AS orgs,
      (SELECT COUNT(*) FROM users)::int         AS users,
      (SELECT COUNT(*) FROM posts)::int         AS posts,
      (SELECT COUNT(*) FROM comments)::int      AS comments
  `);
  console.log('Final counts:', rows[0]);

  // Analyze so query plans are accurate
  console.log('ANALYZE...');
  await pool.query('ANALYZE organizations; ANALYZE users; ANALYZE posts; ANALYZE comments');

  await pool.end();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
