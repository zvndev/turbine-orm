-- Multi-tenant SaaS index zoo: expression unique, partial uniques, INCLUDE, DESC NULLS FIRST,
-- hash, BRIN, GIN (plain and jsonb_path_ops), and an exclusion constraint.
-- Fixture for src/test/real-world-schemas.integration.test.ts; loaded into its own database.
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, plan text NOT NULL DEFAULT 'free');
CREATE TABLE users (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), email text NOT NULL,
  display_name text, deleted_at timestamptz, last_login_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  settings jsonb NOT NULL DEFAULT '{}');
-- expression unique: must NOT read as unique(tenant_id) or unique(tenant_id,email)
CREATE UNIQUE INDEX users_tenant_lower_email_key ON users (tenant_id, lower(email));
-- partial uniques: must NOT be plain unique keys
CREATE UNIQUE INDEX users_tenant_email_active_key ON users (tenant_id, email) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_one_owner_per_tenant ON users (tenant_id) WHERE display_name = 'owner';
-- INCLUDE columns are not key columns
CREATE UNIQUE INDEX users_id_include_email ON users (id) INCLUDE (email, display_name);
-- DESC / NULLS FIRST key (non-unique)
CREATE INDEX users_recent_idx ON users (tenant_id, last_login_at DESC NULLS FIRST, created_at DESC NULLS LAST);
CREATE INDEX users_settings_gin ON users USING gin (settings);
CREATE INDEX users_settings_path_gin ON users USING gin (settings jsonb_path_ops);
CREATE INDEX users_email_hash ON users USING hash (email);
CREATE INDEX users_created_brin ON users USING brin (created_at);
CREATE INDEX users_deleted_partial_idx ON users (deleted_at) WHERE deleted_at IS NOT NULL;
-- tenant-scoped resources with exclusion constraint (no overlapping bookings)
CREATE TABLE rooms (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), name text NOT NULL, CONSTRAINT rooms_tenant_name_key UNIQUE (tenant_id, name));
CREATE TABLE bookings (id bigserial PRIMARY KEY, room_id bigint NOT NULL REFERENCES rooms(id), during tstzrange NOT NULL,
  CONSTRAINT no_overlap EXCLUDE USING gist (room_id WITH =, during WITH &&));
-- api keys: unique token hash, partial unique default key
CREATE TABLE api_keys (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), token_hash text NOT NULL UNIQUE,
  is_default boolean NOT NULL DEFAULT false, revoked_at timestamptz);
CREATE UNIQUE INDEX api_keys_one_default ON api_keys (tenant_id) WHERE is_default;
-- webhook endpoints: composite unique + GIN on events array
CREATE TABLE webhook_endpoints (id bigserial PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), url text NOT NULL,
  events text[] NOT NULL DEFAULT '{}', CONSTRAINT wh_tenant_url_key UNIQUE (tenant_id, url));
CREATE INDEX wh_events_gin ON webhook_endpoints USING gin (events);
INSERT INTO tenants (id,name) VALUES ('11111111-1111-4111-8111-111111111111','Acme'),('22222222-2222-4222-8222-222222222222','Globex');
INSERT INTO users (tenant_id,email,display_name) VALUES ('11111111-1111-4111-8111-111111111111','Ada@Acme.example','owner'),('11111111-1111-4111-8111-111111111111','ben@acme.example','Ben'),('22222222-2222-4222-8222-222222222222','ada@acme.example','Ada G');
INSERT INTO rooms (tenant_id,name) VALUES ('11111111-1111-4111-8111-111111111111','Boardroom'),('22222222-2222-4222-8222-222222222222','Boardroom');
INSERT INTO bookings (room_id,during) VALUES (1,'[2026-01-05T09:00Z,2026-01-05T10:00Z)'),(1,'[2026-01-05T10:00Z,2026-01-05T11:00Z)');
INSERT INTO api_keys (tenant_id,token_hash,is_default) VALUES ('11111111-1111-4111-8111-111111111111','hash1',true),('11111111-1111-4111-8111-111111111111','hash2',false);
INSERT INTO webhook_endpoints (tenant_id,url,events) VALUES ('11111111-1111-4111-8111-111111111111','https://example.com/hook','{invoice.paid,user.created}');
