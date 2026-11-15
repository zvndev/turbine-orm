-- UP
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL
);

-- DOWN
DROP TABLE users;
