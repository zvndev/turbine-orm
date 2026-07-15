import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findMissingRelationIndexes,
  isProbeIndexed,
  missingIndexForRelation,
  schemaHasIndexInfo,
} from '../index-advisor.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function makeSchema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
      profile: {
        type: 'hasOne',
        name: 'profile',
        from: 'users',
        to: 'profiles',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
      teams: {
        type: 'manyToMany',
        name: 'teams',
        from: 'users',
        to: 'teams',
        foreignKey: 'id',
        referenceKey: 'id',
        through: { table: 'team_members', sourceKey: 'user_id', targetKey: 'team_id' },
      },
    },
  );
  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'title', field: 'title', pgType: 'text' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );
  const profiles = mockTable('profiles', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
  ]);
  const teams = mockTable('teams', [{ name: 'id', field: 'id' }]);
  const teamMembers = mockTable('team_members', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'team_id', field: 'teamId' },
  ]);

  return {
    tables: { users, posts, profiles, teams, team_members: teamMembers },
    enums: {},
  } as SchemaMetadata;
}

test('flags unindexed hasMany/hasOne FK probes and m2m junction keys', () => {
  const schema = makeSchema();
  // Give one table index info so schemaHasIndexInfo passes for runtime checks.
  schema.tables.users!.indexes = [{ name: 'users_pkey', columns: ['id'], unique: true, definition: '' }];

  const missing = findMissingRelationIndexes(schema);
  const keys = missing.map((m) => `${m.table}(${m.columns.join(',')})`).sort();
  assert.deepEqual(keys, ['posts(user_id)', 'profiles(user_id)', 'team_members(user_id)']);

  const posts = missing.find((m) => m.table === 'posts')!;
  assert.equal(posts.probes[0]?.relation, 'posts');
  assert.match(posts.createSql, /CREATE INDEX IF NOT EXISTS "idx_posts_user_id" ON "posts" \("user_id"\);/);
  assert.match(posts.dropSql, /DROP INDEX IF EXISTS "idx_posts_user_id";/);
});

test('belongsTo probes are covered by the target primary key', () => {
  const schema = makeSchema();
  const missing = findMissingRelationIndexes(schema);
  // posts.author probes users(id) — covered by PK, so users never appears.
  assert.ok(!missing.some((m) => m.table === 'users'));
});

test('an index leading with the FK column covers the probe', () => {
  const schema = makeSchema();
  schema.tables.posts!.indexes = [
    { name: 'posts_user_id_idx', columns: ['user_id', 'title'], unique: false, definition: '' },
  ];
  const missing = findMissingRelationIndexes(schema);
  assert.ok(!missing.some((m) => m.table === 'posts'));
});

test('an index with the FK in a NON-leading position does not cover the probe', () => {
  const schema = makeSchema();
  schema.tables.posts!.indexes = [
    { name: 'posts_title_user_idx', columns: ['title', 'user_id'], unique: false, definition: '' },
  ];
  const missing = findMissingRelationIndexes(schema);
  assert.ok(missing.some((m) => m.table === 'posts'));
});

test('isProbeIndexed honors PK, indexes, and unique constraints', () => {
  const schema = makeSchema();
  const posts = schema.tables.posts!;
  assert.equal(isProbeIndexed(posts, ['id']), true); // PK
  assert.equal(isProbeIndexed(posts, ['user_id']), false);
  posts.uniqueColumns = [['id'], ['user_id']];
  assert.equal(isProbeIndexed(posts, ['user_id']), true); // unique constraint
});

test('missingIndexForRelation returns null without schema index info', () => {
  const schema = makeSchema(); // no table carries indexes
  assert.equal(schemaHasIndexInfo(schema), false);
  const rel = schema.tables.users!.relations.posts!;
  assert.equal(missingIndexForRelation(schema, rel), null);
});

test('missingIndexForRelation names the probe when index info exists', () => {
  const schema = makeSchema();
  schema.tables.users!.indexes = [{ name: 'users_pkey', columns: ['id'], unique: true, definition: '' }];
  const rel = schema.tables.users!.relations.posts!;
  const miss = missingIndexForRelation(schema, rel);
  assert.ok(miss);
  assert.equal(miss.table, 'posts');
  assert.deepEqual(miss.columns, ['user_id']);
  assert.match(miss.createSql, /CREATE INDEX "idx_posts_user_id" ON "posts" \("user_id"\)/);
});

test('composite FK probes use all columns and any leading member covers', () => {
  const schema = makeSchema();
  schema.tables.users!.relations.compositeKids = {
    type: 'hasMany',
    name: 'compositeKids',
    from: 'users',
    to: 'posts',
    foreignKey: ['user_id', 'title'],
    referenceKey: ['id', 'name'],
  };
  let missing = findMissingRelationIndexes(schema);
  assert.ok(missing.some((m) => m.table === 'posts' && m.columns.length === 2));

  schema.tables.posts!.indexes = [{ name: 'posts_title_idx', columns: ['title'], unique: false, definition: '' }];
  missing = findMissingRelationIndexes(schema);
  // `title` is one of the probed (equality) columns and leads an index → covered.
  assert.ok(!missing.some((m) => m.table === 'posts' && m.columns.length === 2));
});

test('builder emits a dev-mode warning once for unindexed relation probes', async () => {
  const { makeQuery } = await import('./helpers.js');
  const schema = makeSchema();
  schema.tables.users!.indexes = [{ name: 'users_pkey', columns: ['id'], unique: true, definition: '' }];

  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (msg: string) => warnings.push(String(msg));
  try {
    const q = makeQuery('users', schema);
    q.buildFindMany({ with: { posts: true } });
    q.buildFindMany({ with: { posts: true } }); // second build must not re-warn
  } finally {
    console.warn = original;
  }
  const relevant = warnings.filter((w) => w.includes('no covering index'));
  assert.equal(relevant.length, 1);
  assert.match(relevant[0]!, /"posts"\(user_id\)/);
  assert.match(relevant[0]!, /CREATE INDEX "idx_posts_user_id"/);
  assert.match(relevant[0]!, /turbine doctor/);
});

// ---------------------------------------------------------------------------
// F4a: doc-field (docPath) expression indexes are ignored by the advisor
// ---------------------------------------------------------------------------

test('a doc-field index never satisfies an equality probe on its column', () => {
  const schema = makeSchema();
  const posts = schema.tables.posts!;
  // A doc-field expression index on `user_id` targets `user_id->seg`, not the
  // raw column, so it must NOT cover an equality probe on `user_id`.
  posts.indexes = [
    { name: 'posts_user_id_ns_idx', columns: ['user_id'], unique: false, definition: '', docPath: ['ns'] },
  ];
  assert.equal(isProbeIndexed(posts, ['user_id']), false);
});

test('a doc-only index set keeps schemaHasIndexInfo() false', () => {
  const schema = makeSchema();
  schema.tables.posts!.indexes = [
    { name: 'posts_user_id_ns_idx', columns: ['user_id'], unique: false, definition: '', docPath: ['ns'] },
  ];
  // Doc-field indexes carry no FK-coverage info → the schema stays "unknown".
  assert.equal(schemaHasIndexInfo(schema), false);
  // ...and a plain index alongside it flips it true.
  schema.tables.users!.indexes = [{ name: 'u', columns: ['id'], unique: true, definition: '' }];
  // WeakMap cache is keyed on the object identity; make a fresh schema to avoid
  // a stale cached answer.
  const fresh = makeSchema();
  fresh.tables.posts!.indexes = [{ name: 'd', columns: ['user_id'], unique: false, definition: '', docPath: ['ns'] }];
  fresh.tables.users!.indexes = [{ name: 'u', columns: ['id'], unique: true, definition: '' }];
  assert.equal(schemaHasIndexInfo(fresh), true);
});

test('a doc-field index on an FK column does not spuriously clear a missing-index finding', () => {
  const schema = makeSchema();
  // Real index info exists (so the advisor runs)...
  schema.tables.users!.indexes = [{ name: 'users_pkey', columns: ['id'], unique: true, definition: '' }];
  // ...and posts carries ONLY a doc-field index on the FK column.
  schema.tables.posts!.indexes = [
    { name: 'posts_user_id_ns_idx', columns: ['user_id'], unique: false, definition: '', docPath: ['ns'] },
  ];
  const missing = findMissingRelationIndexes(schema);
  // posts(user_id) is still flagged; the doc index does not cover it.
  assert.ok(missing.some((m) => m.table === 'posts' && m.columns.includes('user_id')));
});
