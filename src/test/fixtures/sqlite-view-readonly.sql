CREATE TABLE records(id INTEGER PRIMARY KEY, label TEXT NOT NULL, active BOOLEAN, payload JSON, created_at DATETIME, amount REAL, bytes BLOB, optional_text TEXT);
INSERT INTO records VALUES(1,'alpha',1,'{"nested":[true,null]}','2025-02-03T04:05:06.789Z',1.2345678901234567,X'00FF80',NULL);
CREATE TABLE _turbine_migrations(id INTEGER PRIMARY KEY);
CREATE TABLE ordinary_data(id INTEGER PRIMARY KEY);
CREATE VIRTUAL TABLE search_docs USING fts5(title);
CREATE VIEW record_views AS SELECT * FROM records;
CREATE VIEW computed_views AS SELECT id, label || '-computed' AS display_name, amount * 2 AS doubled, NULL AS absent FROM records;
CREATE VIEW nested_views AS SELECT * FROM record_views;
CREATE VIEW "quoted""view" AS SELECT id AS "quoted""column", label FROM records;
