-- ============================================================================
-- turbine-orm — CI integration test seed
-- ============================================================================
--
-- Provides the schema + minimal data the integration test suites
-- (turbine.test.ts, comprehensive.test.ts, gaps.test.ts, integration-combinations.test.ts)
-- expect to find. This is intentionally light: a handful of orgs/users/posts/
-- comments — just enough to exercise nested relations, cursor pagination,
-- aggregates, and the JSONB / array operators.
--
-- Schema mirrors benchmarks/prisma/schema.prisma + the metadata/tags columns
-- the comprehensive suite assumes. Column counts must match the assertions in
-- turbine.test.ts ("schema has correct column count").
--
-- Idempotent: drops everything first so reruns work cleanly.
-- ============================================================================

DROP TABLE IF EXISTS comments CASCADE;
DROP TABLE IF EXISTS posts CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;

-- ----------------------------------------------------------------------------
-- organizations (7 columns)
-- ----------------------------------------------------------------------------
CREATE TABLE organizations (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL DEFAULT 'free',
  metadata    JSONB,
  tags        TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- users (8 columns)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- posts (9 columns)
-- ----------------------------------------------------------------------------
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

-- ----------------------------------------------------------------------------
-- comments (5 columns)
-- ----------------------------------------------------------------------------
CREATE TABLE comments (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id     BIGINT NOT NULL REFERENCES posts(id),
  user_id     BIGINT NOT NULL REFERENCES users(id),
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_comments_post_id ON comments(post_id);
CREATE INDEX idx_comments_user_id ON comments(user_id);

-- ============================================================================
-- DATA
-- ============================================================================

-- ---- Organizations ---------------------------------------------------------
-- id 1: enterprise-tier, has SSO + enterprise tags
-- id 2: pro-tier with the exact metadata equality the comprehensive suite tests
-- id 3: pro/sso mix
-- id 4: empty tags (test array isEmpty: true)
-- id 5: empty tags
INSERT INTO organizations (name, slug, plan, metadata, tags) VALUES
  ('Acme Inc',        'acme',      'enterprise', '{"tier": "enterprise", "features": ["api", "sso", "audit"], "maxUsers": 500}'::jsonb, ARRAY['enterprise', 'sso', 'audit']),
  ('Beta LLC',        'beta',      'pro',        '{"tier": "pro", "features": ["api"], "maxUsers": 25}'::jsonb,                          ARRAY['pro', 'api']),
  ('Gamma Co',        'gamma',     'pro',        '{"tier": "enterprise", "features": ["sso"], "maxUsers": 100}'::jsonb,                  ARRAY['enterprise', 'sso']),
  ('Delta Corp',      'delta',     'free',       '{"tier": "free"}'::jsonb,                                                              ARRAY[]::TEXT[]),
  ('Epsilon Studios', 'epsilon',   'free',       '{"tier": "free"}'::jsonb,                                                              ARRAY[]::TEXT[]);

-- ---- Users -----------------------------------------------------------------
-- Need: roles admin/editor/member, some null avatar_url, emails like user1@example.com
INSERT INTO users (org_id, email, name, role, avatar_url, last_login_at) VALUES
  (1, 'user1@example.com',  'Alice Admin',   'admin',  'https://avatars.example.com/1.png', NOW() - INTERVAL '1 day'),
  (1, 'user2@example.com',  'Bob Editor',    'editor', 'https://avatars.example.com/2.png', NOW() - INTERVAL '2 days'),
  (1, 'user3@example.com',  'Carol Member',  'member', NULL,                                NOW() - INTERVAL '3 days'),
  (1, 'user4@example.com',  'Dave Member',   'member', 'https://avatars.example.com/4.png', NULL),
  (2, 'user5@example.com',  'Eve Admin',     'admin',  NULL,                                NOW() - INTERVAL '5 days'),
  (2, 'user6@example.com',  'Frank Member',  'member', 'https://avatars.example.com/6.png', NOW() - INTERVAL '6 days'),
  (3, 'user7@example.com',  'Grace Editor',  'editor', 'https://avatars.example.com/7.png', NOW() - INTERVAL '7 days'),
  (3, 'user8@example.com',  'Heidi Member',  'member', NULL,                                NULL);

-- ---- Posts -----------------------------------------------------------------
-- ~10 posts spread across users; mix of published/unpublished, varying view counts.
-- User 1 (admin) gets several published posts to satisfy "some published posts" filters.
INSERT INTO posts (user_id, org_id, title, content, published, view_count, created_at) VALUES
  (1, 1, 'Hello World',          'First post body',         TRUE,  100, NOW() - INTERVAL '10 days'),
  (1, 1, 'Second Post',           'More content',            TRUE,   75, NOW() - INTERVAL '9 days'),
  (1, 1, 'Draft Post',            'Not yet ready',           FALSE,   0, NOW() - INTERVAL '8 days'),
  (2, 1, 'Editor Post',           'Editor wrote this',       TRUE,   42, NOW() - INTERVAL '7 days'),
  (2, 1, 'Another Editor Post',   'Editor wrote this too',   FALSE,  10, NOW() - INTERVAL '6 days'),
  (3, 1, 'Member Post',           'Members can post',        TRUE,   30, NOW() - INTERVAL '5 days'),
  (5, 2, 'Org 2 Admin Post',      'Across orgs',             TRUE,   60, NOW() - INTERVAL '4 days'),
  (6, 2, 'Org 2 Member Post',     'A member post in org 2',  TRUE,   20, NOW() - INTERVAL '3 days'),
  (7, 3, 'Grace on Gamma',        'Editor in org 3',         TRUE,   55, NOW() - INTERVAL '2 days'),
  (7, 3, 'Grace draft',           'Not published yet',       FALSE,   5, NOW() - INTERVAL '1 day');

-- ---- Comments --------------------------------------------------------------
-- ~20 comments distributed across posts; gives enough nesting depth for L3 with-clauses.
INSERT INTO comments (post_id, user_id, body) VALUES
  (1, 2, 'Nice post!'),
  (1, 3, 'I agree'),
  (1, 4, 'Great read'),
  (2, 2, 'Solid follow up'),
  (2, 3, 'Thanks for sharing'),
  (4, 1, 'Approved by admin'),
  (4, 3, 'Useful content'),
  (4, 4, 'Liked it'),
  (6, 1, 'Welcome to the team'),
  (6, 2, 'Good job'),
  (7, 1, 'Cross-org comment'),
  (7, 5, 'Internal comment'),
  (8, 5, 'From the admin'),
  (8, 6, 'From a member'),
  (9, 7, 'Self comment'),
  (9, 8, 'Friend comment'),
  (1, 5, 'Late comment'),
  (2, 6, 'Cross-org reply'),
  (4, 7, 'Another reply'),
  (6, 8, 'Final comment');
