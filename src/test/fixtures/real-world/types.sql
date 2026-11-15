-- Type zoo: enums and enum arrays, citext, hstore, a composite type, ranges, and a spread of
-- default shapes (shared and renamed sequences, smallserial and bigserial, and defaults whose
-- literal text merely contains nextval().
-- Fixture for src/test/real-world-schemas.integration.test.ts; loaded into its own database.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS hstore;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE mood AS ENUM ('sad','ok','happy');
CREATE DOMAIN year_dom AS integer CHECK (VALUE >= 1901 AND VALUE <= 2155);
CREATE TYPE inventory_item AS (name text, supplier_id int, price numeric);
CREATE SEQUENCE shared_seq;
CREATE SEQUENCE old_seq_name;
ALTER SEQUENCE old_seq_name RENAME TO renamed_seq;
CREATE TABLE shared_a (id int PRIMARY KEY DEFAULT nextval('shared_seq'), label text);
CREATE TABLE shared_b (id int PRIMARY KEY DEFAULT nextval('shared_seq'), label text);
CREATE TABLE renamed_t (id int PRIMARY KEY DEFAULT nextval('renamed_seq'), label text);
CREATE TABLE smalls (id smallserial PRIMARY KEY, v smallint);
CREATE TABLE bigs (id bigserial PRIMARY KEY, v bigint);
CREATE TABLE serials (id serial PRIMARY KEY, v int);
CREATE TABLE persons (
  id serial PRIMARY KEY,
  current_mood mood,
  mood_history mood[],
  email citext UNIQUE,
  attrs hstore,
  favorite inventory_item,
  availability daterange,
  prices numrange,
  tags text[],
  matrix int[][],
  uuids uuid[],
  plain_doc json,
  doc jsonb DEFAULT '{"nextval(": 1}',
  fake_default text DEFAULT 'nextval(fake)',
  fake_default2 text DEFAULT 'call nextval(''seq''::regclass) now',
  real_next int,
  birth_year year_dom,
  at_time time, at_timetz timetz, span interval, addr inet, mac macaddr, bits bit(8), varbits varbit, money_col money, xml_col xml,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT mood_check CHECK (current_mood <> 'sad' OR email IS NOT NULL),
  CONSTRAINT spaced_check CHECK (fake_default <> 'a  b')
);
CREATE INDEX persons_moods_gin ON persons USING gin (mood_history);
CREATE INDEX persons_attrs_gin ON persons USING gin (attrs);
CREATE TABLE enum_holder (id serial PRIMARY KEY, person_id int REFERENCES persons(id), moods mood[] NOT NULL DEFAULT '{}', one mood NOT NULL DEFAULT 'ok');
INSERT INTO shared_a (label) VALUES ('a1'),('a2');
INSERT INTO shared_b (label) VALUES ('b1');
INSERT INTO renamed_t (label) VALUES ('r1');
INSERT INTO smalls (v) VALUES (1);
INSERT INTO bigs (v) VALUES (9007199254740993);
INSERT INTO serials (v) VALUES (7);
INSERT INTO persons (current_mood,mood_history,email,attrs,favorite,availability,tags,uuids) VALUES
  ('happy','{ok,happy}','Ada@Example.com','"k"=>"v"',ROW('widget',3,9.99),'[2026-01-01,2026-02-01)','{x,y}','{11111111-1111-4111-8111-111111111111}'),
  ('ok','{sad}','grace@example.com',NULL,NULL,NULL,'{}',NULL);
INSERT INTO enum_holder (person_id,moods,one) VALUES (1,'{happy,ok}','happy');
