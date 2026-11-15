export const definition = {
  users: {
    id: { type: 'serial', primaryKey: true }, displayName: { type: 'text', notNull: true, unique: true },
    active: { type: 'boolean', notNull: true }, profile: { type: 'jsonb' },
    createdAt: { type: 'timestamp', notNull: true }, payload: { type: 'bytea' },
    largeId: { type: 'bigint', notNull: true }, score: { type: 'real', notNull: true },
    amount: { type: 'numeric', notNull: true },
  },
  posts: { id: { type: 'serial', primaryKey: true }, userId: { type: 'integer', notNull: true, references: 'users.id' }, title: { type: 'text', notNull: true } },
};
export const ddl = [
  'CREATE TABLE users(id INT PRIMARY KEY AUTO_INCREMENT, display_name VARCHAR(200) NOT NULL UNIQUE, active BOOLEAN NOT NULL, profile JSON, created_at DATETIME(3) NOT NULL, payload BLOB, large_id BIGINT NOT NULL, score DOUBLE NOT NULL, amount DECIMAL(24,4) NOT NULL)',
  'CREATE TABLE posts(id INT PRIMARY KEY AUTO_INCREMENT, user_id INT NOT NULL, title TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES users(id))',
];
