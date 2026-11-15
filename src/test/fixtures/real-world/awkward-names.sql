-- Reserved words and awkward names: index and column names whose text must not change the
-- meaning of the index they ride on. Two table names ("Order Details", "123numbers") cannot
-- become TypeScript identifiers, so client generation over this fixture must refuse.
-- Fixture for src/test/real-world-schemas.integration.test.ts; loaded into its own database.
CREATE TABLE "user" (id serial PRIMARY KEY, "order" int, "select" text, "from" text, "group" text);
CREATE TABLE "order" (id serial PRIMARY KEY, "user" int REFERENCES "user"(id), "table" text, "where" text, total numeric);
CREATE TABLE "Order Details" (id serial PRIMARY KEY, "order id" int REFERENCES "order"(id), "unit price" numeric, "qty." int);
CREATE TABLE weird (
  id serial PRIMARY KEY,
  "name with spaces" text,
  "quote""inside" text,
  "dot.name" text,
  "col DESC" text,
  "owner_id DESC" int,
  kind text,
  slug text,
  "日本語カラム" text,
  "emoji🚀" text,
  "MixedCase" text,
  "UNIQUE_col" text,
  "USING" text,
  "trailing " text,
  notes text DEFAULT 'nextval(fake)',
  fakeseq text DEFAULT 'prefix nextval(''x''::regclass) suffix'
);
-- Trap 1 (changelog): a non-unique index whose NAME contains UNIQUE
CREATE INDEX "IDX_UNIQUE_kind" ON weird (kind);
-- Trap 2 (changelog): a unique index whose name looks like a USING clause over another column
CREATE UNIQUE INDEX "USING btree (kind)" ON weird (slug);
-- Trap 3 (changelog): unique index over a column literally named "<x> DESC"
CREATE UNIQUE INDEX weird_owner_unique ON weird ("owner_id DESC");
-- Trap 4: column named with the word UNIQUE in it, plain index
CREATE INDEX weird_uniquecol_idx ON weird ("UNIQUE_col");
-- Trap 5: expression text inside a column default + a unique index over (id) redundant w/ PK is skipped; use natural traps instead
CREATE UNIQUE INDEX weird_mixed_key ON weird ("MixedCase", "dot.name") WHERE kind IS NOT NULL;
CREATE TABLE records (id serial PRIMARY KEY, recorded_on date, payload jsonb, "user" int REFERENCES "user"(id));
CREATE TABLE dates (id serial PRIMARY KEY, record_id int REFERENCES records(id), on_date date, label text);
CREATE TABLE "schéma" (id serial PRIMARY KEY, "café" text, record_id int REFERENCES records(id));
CREATE TABLE "123numbers" (id serial PRIMARY KEY, "1st" text, val int);
INSERT INTO "user" ("order","select","from","group") VALUES (1,'a','b','c'),(2,'d','e','f');
INSERT INTO "order" ("user","table","where",total) VALUES (1,'t1','w1',9.99),(2,'t2','w2',19.99);
INSERT INTO "Order Details" ("order id","unit price","qty.") VALUES (1,4.99,2),(1,5.00,1);
INSERT INTO weird ("name with spaces","quote""inside","dot.name","col DESC","owner_id DESC",kind,slug,"日本語カラム","MixedCase","UNIQUE_col") VALUES ('sp','q"i','d.n','cd',11,'k1','s1','あ','M1','u1'),('sp2','q2','d2','cd2',22,'k1','s2','い','M2','u2'),('sp3','q3','d3','cd3',33,'k2','s3','う','M3','u3');
INSERT INTO records (recorded_on,"user") VALUES ('2026-01-01',1),('2026-01-02',2);
INSERT INTO dates (record_id,on_date,label) VALUES (1,'2026-02-01','x'),(2,'2026-02-02','y');
INSERT INTO "schéma" ("café",record_id) VALUES ('oui',1);
INSERT INTO "123numbers" ("1st",val) VALUES ('first',1);
