PRAGMA foreign_keys = ON;

CREATE TABLE rowid_keys (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'note');
CREATE TABLE auto_keys (id INTEGER PRIMARY KEY AUTOINCREMENT);
CREATE TABLE default_rowid_keys (id INTEGER PRIMARY KEY DEFAULT 41);
CREATE TABLE table_rowid_keys (id INTEGER, PRIMARY KEY (id DESC));
CREATE TABLE desc_keys (id INTEGER PRIMARY KEY DESC);
CREATE TABLE int_keys (id INT PRIMARY KEY NOT NULL);
CREATE TABLE text_keys (slug TEXT PRIMARY KEY NOT NULL, label TEXT NOT NULL);
CREATE TABLE nullable_keys (slug TEXT PRIMARY KEY, note TEXT);
CREATE TABLE composite_keys (
  tenant_id INTEGER NOT NULL, code TEXT NOT NULL, PRIMARY KEY (tenant_id, code)
);
CREATE TABLE nullable_composite_keys (tenant_id INTEGER, code TEXT, PRIMARY KEY (code, tenant_id));
CREATE TABLE without_keys (id INTEGER PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE without_composite_keys (tenant_id INTEGER, code TEXT, PRIMARY KEY (code, tenant_id)) WITHOUT ROWID;
CREATE TABLE strict_keys (slug TEXT PRIMARY KEY) STRICT;
CREATE TABLE default_keys (
  slug TEXT PRIMARY KEY NOT NULL DEFAULT 'new', count INTEGER NOT NULL DEFAULT 0, optional_text TEXT DEFAULT NULL
);
CREATE TABLE default_without_keys (id INTEGER PRIMARY KEY DEFAULT 73) WITHOUT ROWID;
CREATE TABLE generated_records (
  id INTEGER PRIMARY KEY, quantity INTEGER NOT NULL,
  virtual_total INTEGER GENERATED ALWAYS AS (quantity * 2) VIRTUAL,
  stored_total INTEGER GENERATED ALWAYS AS (quantity * 3) STORED
);
CREATE VIEW key_view AS SELECT id FROM rowid_keys;

CREATE TABLE parents (id INTEGER PRIMARY KEY);
CREATE TABLE profiles (id INTEGER PRIMARY KEY, parent_id INTEGER UNIQUE REFERENCES parents, label TEXT NOT NULL);
CREATE TABLE primary_profiles (parent_id INTEGER PRIMARY KEY REFERENCES parents);
CREATE TABLE indexed_profiles (id INTEGER PRIMARY KEY, parent_id INT NOT NULL REFERENCES parents);
CREATE UNIQUE INDEX indexed_profiles_parent ON indexed_profiles(parent_id);
CREATE TABLE partial_profiles (
  id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents, active INTEGER NOT NULL
);
CREATE UNIQUE INDEX partial_profiles_parent ON partial_profiles(parent_id) WHERE active = 1;
CREATE TABLE expression_profiles (
  id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents, scope INTEGER NOT NULL DEFAULT 0, label TEXT NOT NULL
);
CREATE UNIQUE INDEX expression_profiles_parent ON expression_profiles(parent_id, scope, lower(label));
CREATE TABLE superset_profiles (
  id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents, label TEXT NOT NULL, UNIQUE(parent_id, label)
);
CREATE TABLE composite_parents (
  tenant_id INTEGER, code TEXT, PRIMARY KEY(tenant_id, code)
) WITHOUT ROWID;
CREATE TABLE composite_links (
  id INTEGER PRIMARY KEY, tenant_id INTEGER, code TEXT, UNIQUE(code, tenant_id),
  FOREIGN KEY(tenant_id, code) REFERENCES composite_parents
);
CREATE TABLE collated_parents (id TEXT PRIMARY KEY COLLATE NOCASE);
CREATE TABLE collation_profiles (
  id INTEGER PRIMARY KEY, parent_id TEXT COLLATE NOCASE REFERENCES collated_parents(id)
);
CREATE UNIQUE INDEX collation_profiles_parent ON collation_profiles(parent_id COLLATE BINARY);
CREATE TABLE affinity_profiles (id INTEGER PRIMARY KEY, parent_id TEXT UNIQUE REFERENCES parents);
CREATE TABLE numeric_parents (id NUMERIC PRIMARY KEY NOT NULL);
CREATE TABLE any_profiles (id INTEGER PRIMARY KEY, parent_id ANY UNIQUE REFERENCES numeric_parents) STRICT;
