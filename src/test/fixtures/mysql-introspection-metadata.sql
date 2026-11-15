CREATE TABLE metadata_parents (id INT PRIMARY KEY);
CREATE TABLE metadata_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_id INT NULL UNIQUE,
  label VARCHAR(50) NOT NULL DEFAULT 'profile',
  FOREIGN KEY (parent_id) REFERENCES metadata_parents(id)
);
CREATE TABLE metadata_primary_profiles (
  parent_id INT PRIMARY KEY,
  FOREIGN KEY (parent_id) REFERENCES metadata_parents(id)
);
CREATE TABLE metadata_indexed_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_id INT,
  UNIQUE INDEX uq_parent (parent_id DESC) COMMENT 'native unique',
  FOREIGN KEY (parent_id) REFERENCES metadata_parents(id)
);
CREATE TABLE metadata_expression_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_id INT,
  label VARCHAR(50),
  scope INT NOT NULL DEFAULT 0,
  UNIQUE INDEX uq_expression (parent_id, (lower(label)), scope),
  FOREIGN KEY (parent_id) REFERENCES metadata_parents(id)
);
CREATE TABLE metadata_superset_profiles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  parent_id INT,
  scope INT,
  UNIQUE INDEX uq_scope (parent_id, scope),
  FOREIGN KEY (parent_id) REFERENCES metadata_parents(id)
);
CREATE TABLE metadata_composite_parents (
  tenant_id INT,
  code VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  PRIMARY KEY (code, tenant_id)
);
CREATE TABLE metadata_composite_links (
  tenant_id INT,
  code VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci,
  PRIMARY KEY (code, tenant_id),
  FOREIGN KEY (code, tenant_id) REFERENCES metadata_composite_parents(code, tenant_id)
);
CREATE TABLE metadata_text_parents (
  id VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci PRIMARY KEY
);
CREATE TABLE metadata_text_profiles (
  parent_id VARCHAR(20) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci UNIQUE,
  FOREIGN KEY (parent_id) REFERENCES metadata_text_parents(id)
);
CREATE TABLE metadata_length_profiles (
  parent_id VARCHAR(30) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci UNIQUE,
  FOREIGN KEY (parent_id) REFERENCES metadata_text_parents(id)
);
CREATE TABLE metadata_float_parents (id DOUBLE PRIMARY KEY);
CREATE TABLE metadata_float_profiles (
  parent_id DOUBLE UNIQUE,
  FOREIGN KEY (parent_id) REFERENCES metadata_float_parents(id)
);
CREATE TABLE metadata_prefix_keys (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(50),
  UNIQUE INDEX uq_prefix (email(3))
);
CREATE TABLE metadata_native_indexes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(50),
  body TEXT,
  INDEX ix_hidden (title DESC) INVISIBLE COMMENT 'hidden native fact',
  FULLTEXT INDEX ix_fulltext (body)
);
CREATE TABLE metadata_defaults (
  id INT AUTO_INCREMENT PRIMARY KEY,
  required_count INT NOT NULL,
  optional_text VARCHAR(50),
  explicit_null VARCHAR(50) DEFAULT NULL,
  literal_text VARCHAR(50) NOT NULL DEFAULT 'a,b''c',
  zero_count INT NOT NULL DEFAULT 0,
  token VARCHAR(36) NOT NULL DEFAULT (uuid()),
  touched TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
CREATE TABLE metadata_generated (
  id INT AUTO_INCREMENT PRIMARY KEY,
  quantity INT NOT NULL,
  virtual_total INT GENERATED ALWAYS AS (quantity * 2) VIRTUAL,
  stored_total INT GENERATED ALWAYS AS (quantity * 3) STORED
);
CREATE VIEW metadata_view AS SELECT id FROM metadata_parents;
