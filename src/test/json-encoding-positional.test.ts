/**
 * Unit tests for the opt-in positional JSON encoding (`jsonEncoding: 'positional'`).
 *
 * These are build-only (no DB): they assert the generated SQL shape and drive
 * each DeferredQuery's transform with hand-built pg result rows (relation columns
 * arrive from pg as JSON strings). The core guarantee is PARITY — the positional
 * transform must produce output byte-identical to the object transform for the
 * equivalent input, so a caller can flip the flag without any result change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresDialect } from '../dialect.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// users → posts (hasMany) → comments (hasMany); users → profile (hasOne).
// Column fields are camelCase so reverseColumnMap yields the emitted JSON keys.
const schema: SchemaMetadata = {
  tables: {
    users: mockTable(
      'users',
      [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name' },
      ],
      {
        posts: {
          type: 'hasMany' as const,
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
        profile: {
          type: 'hasOne' as const,
          name: 'profile',
          from: 'users',
          to: 'profiles',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    posts: mockTable(
      'posts',
      [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
        { name: 'title', field: 'title' },
      ],
      {
        comments: {
          type: 'hasMany' as const,
          name: 'comments',
          from: 'posts',
          to: 'comments',
          foreignKey: 'post_id',
          referenceKey: 'id',
        },
      },
    ),
    comments: mockTable('comments', [
      { name: 'id', field: 'id' },
      { name: 'body', field: 'body' },
    ]),
    profiles: mockTable('profiles', [
      { name: 'id', field: 'id' },
      { name: 'bio', field: 'bio' },
    ]),
  },
  // biome-ignore lint/suspicious/noExplicitAny: minimal schema for build-only tests
} as any;

// biome-ignore lint/suspicious/noExplicitAny: hand-built pg result for transform tests
const fakeResult = (...rows: Record<string, unknown>[]): any => ({
  rows,
  rowCount: rows.length,
  command: 'SELECT',
  fields: [],
});

test('object encoding is the default and emits json_build_object (unchanged)', () => {
  const q = makeQuery('users', schema, { warnOnUnlimited: false });
  const d = q.buildFindMany({ with: { posts: true } } as never);
  assert.match(d.sql, /json_build_object/);
  assert.doesNotMatch(d.sql, /json_build_array/);
});

test('positional encoding emits json_build_array and NO json_build_object key literals', () => {
  const q = makeQuery('users', schema, { jsonEncoding: 'positional', warnOnUnlimited: false });
  const d = q.buildFindMany({ with: { posts: { with: { comments: true } }, profile: true } } as never);
  assert.match(d.sql, /json_build_array/);
  assert.doesNotMatch(d.sql, /json_build_object/);
  // No key-name literals in the JSON payload (the whole point of the encoding).
  assert.doesNotMatch(d.sql, /'title'/);
  assert.doesNotMatch(d.sql, /'body'/);
});

test('positional transform is byte-identical to object transform (nested many + hasOne + null)', () => {
  const withClause = { posts: { with: { comments: true } }, profile: true };
  const objQ = makeQuery('users', schema, { warnOnUnlimited: false });
  const posQ = makeQuery('users', schema, { jsonEncoding: 'positional', warnOnUnlimited: false });
  const objD = objQ.buildFindMany({ with: withClause } as never);
  const posD = posQ.buildFindMany({ with: withClause } as never);

  // Row 1: a post with a comment + a profile. Row 2: no posts, null profile.
  const objRows = [
    {
      id: 1,
      name: 'Ada',
      posts: JSON.stringify([{ id: 10, userId: 1, title: 't1', comments: [{ id: 100, body: 'c1' }] }]),
      profile: JSON.stringify({ id: 5, bio: 'hi' }),
    },
    { id: 2, name: 'Bob', posts: '[]', profile: null },
  ];
  // Positional payload — column order per shape: posts=[id,userId,title,comments],
  // comments=[id,body], profile=[id,bio]. Same information, key-less.
  const posRows = [
    {
      id: 1,
      name: 'Ada',
      posts: JSON.stringify([[10, 1, 't1', [[100, 'c1']]]]),
      profile: JSON.stringify([5, 'hi']),
    },
    { id: 2, name: 'Bob', posts: '[]', profile: null },
  ];

  const expected = objD.transform(fakeResult(...objRows));
  const actual = posD.transform(fakeResult(...posRows));
  assert.deepEqual(actual, expected);
  // Sanity: the decoded shape is the real nested object, not raw arrays.
  assert.deepEqual(actual[0], {
    id: 1,
    name: 'Ada',
    posts: [{ id: 10, userId: 1, title: 't1', comments: [{ id: 100, body: 'c1' }] }],
    profile: { id: 5, bio: 'hi' },
  });
});

test('select column order (user key order) is reflected in shape and stays at parity', () => {
  // `select` preserves the user's key order (not table order), and BOTH encodings
  // resolve columns the same way, so positional decode matches object output.
  const withClause = { posts: { select: { id: true, title: true } } };
  const objQ = makeQuery('users', schema, { warnOnUnlimited: false });
  const posQ = makeQuery('users', schema, { jsonEncoding: 'positional', warnOnUnlimited: false });
  const objD = objQ.buildFindMany({ with: withClause } as never);
  const posD = posQ.buildFindMany({ with: withClause } as never);
  // Emitted order [id, title] (user_id not selected).
  const objRow = { id: 1, name: 'Ada', posts: JSON.stringify([{ id: 10, title: 't1' }]) };
  const posRow = { id: 1, name: 'Ada', posts: JSON.stringify([[10, 't1']]) };
  const actual = posD.transform(fakeResult(posRow));
  assert.deepEqual(actual, objD.transform(fakeResult(objRow)));
  assert.deepEqual(actual[0], { id: 1, name: 'Ada', posts: [{ id: 10, title: 't1' }] });
});

test('omit drops the omitted slot from both SQL and decode', () => {
  const withClause = { posts: { omit: { userId: true } } };
  const objQ = makeQuery('users', schema, { warnOnUnlimited: false });
  const posQ = makeQuery('users', schema, { jsonEncoding: 'positional', warnOnUnlimited: false });
  const objD = objQ.buildFindMany({ with: withClause } as never);
  const posD = posQ.buildFindMany({ with: withClause } as never);
  // Remaining columns: [id, title].
  const objRow = { id: 1, name: 'Ada', posts: JSON.stringify([{ id: 10, title: 't1' }]) };
  const posRow = { id: 1, name: 'Ada', posts: JSON.stringify([[10, 't1']]) };
  assert.deepEqual(posD.transform(fakeResult(posRow)), objD.transform(fakeResult(objRow)));
});

test('wide (>50-column) relation target chunks into jsonb_build_array concatenation', () => {
  const wideCols = Array.from({ length: 60 }, (_, i) => ({ name: `col_${i}`, field: `col${i}`, pgType: 'text' }));
  const wideSchema: SchemaMetadata = {
    tables: {
      parents: mockTable('parents', [{ name: 'id', field: 'id' }], {
        wide: {
          type: 'hasMany' as const,
          name: 'wide',
          from: 'parents',
          to: 'wides',
          foreignKey: 'parent_id',
          referenceKey: 'id',
        },
      }),
      wides: mockTable('wides', [{ name: 'id', field: 'id' }, { name: 'parent_id', field: 'parentId' }, ...wideCols]),
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal schema
  } as any;

  const q = makeQuery('parents', wideSchema, { jsonEncoding: 'positional', warnOnUnlimited: false });
  const d = q.buildFindMany({ with: { wide: true }, limit: 1 } as never);
  assert.match(d.sql, /jsonb_build_array/);
  assert.match(d.sql, /\|\|/);
  assert.match(d.sql, /::json/);
  // Never a single json_build_array with more than 100 args.
  for (const m of d.sql.matchAll(/json_build_array\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
    const argCount = (m[1] ?? '').split(',').length;
    assert.ok(argCount <= 100, `json_build_array with ${argCount} args`);
  }
});

test('positional on a non-postgres dialect with a `with` clause throws E017', () => {
  // Fully-functional dialect whose only difference is a non-PG name; the gate
  // keys on dialect.name, so every other method still works up to the throw.
  const nonPgDialect = { ...postgresDialect, name: 'sqlite' as const };
  const q = makeQuery('users', schema, { jsonEncoding: 'positional', warnOnUnlimited: false, dialect: nonPgDialect });
  assert.throws(() => q.buildFindMany({ with: { posts: true } } as never), /TURBINE_E017|positional/);
});
