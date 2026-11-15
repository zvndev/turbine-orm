-- Rails shape: schema_migrations, ar_internal_metadata, polymorphic (type, id) columns,
-- an expression unique index on lower(email), ActiveStorage-style tables.
-- Fixture for src/test/real-world-schemas.integration.test.ts; loaded into its own database.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE schema_migrations (version varchar PRIMARY KEY);
CREATE TABLE ar_internal_metadata (key varchar PRIMARY KEY, value varchar, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
-- Rails 7 bigint PKs
CREATE TABLE users (id bigserial PRIMARY KEY, email varchar NOT NULL DEFAULT '', encrypted_password varchar NOT NULL DEFAULT '',
  reset_password_token varchar, sign_in_count int NOT NULL DEFAULT 0, admin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE UNIQUE INDEX index_users_on_lower_email ON users (lower(email));
CREATE UNIQUE INDEX index_users_on_reset_password_token ON users (reset_password_token);
CREATE TABLE posts (id bigserial PRIMARY KEY, user_id bigint NOT NULL REFERENCES users(id), title varchar, body text,
  status varchar NOT NULL DEFAULT 'draft', published_at timestamptz, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  CONSTRAINT chk_status CHECK (status IN ('draft','published','archived')));
CREATE INDEX index_posts_on_user_id ON posts(user_id);
CREATE INDEX index_posts_on_status_and_published_at ON posts(status, published_at DESC) WHERE status = 'published';
-- polymorphic comments + counter-cache style
CREATE TABLE comments (id bigserial PRIMARY KEY, commentable_type varchar NOT NULL, commentable_id bigint NOT NULL,
  user_id bigint REFERENCES users(id), body text, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL);
CREATE INDEX index_comments_on_commentable ON comments(commentable_type, commentable_id);
-- ActiveStorage-style unique blob key, attachments unique triple
CREATE TABLE active_storage_blobs (id bigserial PRIMARY KEY, key varchar NOT NULL UNIQUE, filename varchar NOT NULL, byte_size bigint NOT NULL, checksum varchar, created_at timestamptz NOT NULL);
CREATE TABLE active_storage_attachments (id bigserial PRIMARY KEY, name varchar NOT NULL, record_type varchar NOT NULL, record_id bigint NOT NULL,
  blob_id bigint NOT NULL REFERENCES active_storage_blobs(id), created_at timestamptz NOT NULL);
CREATE UNIQUE INDEX index_active_storage_attachments_uniqueness ON active_storage_attachments(record_type, record_id, name, blob_id);
-- ActionText / taggings
CREATE TABLE tags (id bigserial PRIMARY KEY, name varchar UNIQUE);
CREATE TABLE taggings (id bigserial PRIMARY KEY, tag_id bigint NOT NULL REFERENCES tags(id), taggable_type varchar NOT NULL, taggable_id bigint NOT NULL,
  CONSTRAINT uq_tagging UNIQUE (tag_id, taggable_type, taggable_id));
INSERT INTO schema_migrations VALUES ('20260101000001'),('20260102000002');
INSERT INTO ar_internal_metadata VALUES ('environment','production',now(),now());
INSERT INTO users (email,created_at,updated_at) VALUES ('Alice@Example.com',now(),now()),('bob@example.com',now(),now());
INSERT INTO posts (user_id,title,status,created_at,updated_at) VALUES (1,'Hello Rails','published',now(),now()),(2,'Draft post','draft',now(),now());
INSERT INTO comments (commentable_type,commentable_id,user_id,body,created_at,updated_at) VALUES ('Post',1,2,'Nice!',now(),now()),('Post',1,1,'Thanks',now(),now()),('User',1,2,'Profile note',now(),now());
INSERT INTO active_storage_blobs (key,filename,byte_size,created_at) VALUES ('abc123key','photo.png',1024,now());
INSERT INTO active_storage_attachments (name,record_type,record_id,blob_id,created_at) VALUES ('avatar','User',1,1,now());
INSERT INTO tags (name) VALUES ('ruby'),('postgres');
INSERT INTO taggings (tag_id,taggable_type,taggable_id) VALUES (1,'Post',1),(2,'Post',1);
