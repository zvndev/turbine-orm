/** Reuses the established D1 generation fixture's full field and relation shape. */
export const definition = {
  users: {
    id: { type: 'serial', primaryKey: true }, displayName: { type: 'text', notNull: true, unique: true },
    active: { type: 'boolean', notNull: true }, profile: { type: 'jsonb', tsType: '{ tags: string[] }' },
    createdAt: { type: 'timestamp', notNull: true }, payload: { type: 'bytea' }, largeId: { type: 'bigint', notNull: true },
  },
  posts: { id: { type: 'serial', primaryKey: true }, userId: { type: 'integer', notNull: true, references: 'users.id' }, title: { type: 'text', notNull: true } },
  pairs: { leftId: { type: 'integer', notNull: true }, rightId: { type: 'integer', notNull: true }, label: { type: 'text', notNull: true }, computed: { type: 'integer', notNull: true }, primaryKey: ['leftId', 'rightId'] },
};
export const ddl = [
  'CREATE TABLE users(id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL, profile JSONB, created_at TIMESTAMP NOT NULL, payload BLOB, large_id BIGINT NOT NULL)',
  'CREATE TABLE posts(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL)',
  'CREATE TABLE pairs(left_id INTEGER NOT NULL, right_id INTEGER NOT NULL, label TEXT NOT NULL, computed INTEGER GENERATED ALWAYS AS (left_id + right_id) STORED, PRIMARY KEY(left_id,right_id))',
  'CREATE TABLE raw_names(id INTEGER PRIMARY KEY, "__proto__" TEXT NOT NULL, constructor TEXT NOT NULL, "toString" TEXT NOT NULL)',
];
