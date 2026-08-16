/**
 * Unit tests for the opt-in positional JSON encoding (`jsonEncoding: 'positional'`).
 *
 * These are build-only (no DB): they assert the generated SQL shape and drive
 * each DeferredQuery's transform with hand-built pg result rows (relation columns
 * arrive from pg as JSON strings). The core guarantee is PARITY, the positional
 * transform must produce output byte-identical to the object transform for the
 * equivalent input, so a caller can flip the flag without any result change.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { postgresDialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
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

test('positional is the DEFAULT on PostgreSQL', () => {
  const q = makeQuery('users', schema, { warnOnUnlimited: false });
  const d = q.buildFindMany({ with: { posts: true } } as never);
  assert.match(d.sql, /json_build_array/);
  assert.doesNotMatch(d.sql, /json_build_object/);
});

test('object stays the default on every non-PostgreSQL dialect', () => {
  // The gate is `dialect.name`, and it has to be: every engine dialect is built
  // by SPREADING postgresDialect, so each of these INHERITS `buildJsonArray`
  // and a "does the dialect have the hook" test would hand all of them the
  // positional encoding they then refuse with E017.
  for (const dialect of [sqliteDialect, mysqlDialect, mssqlDialect]) {
    const q = makeQuery('users', schema, { warnOnUnlimited: false, dialect });
    const sql = q.buildFindMany({ with: { posts: true } } as never).sql;
    assert.doesNotMatch(sql, /json_build_array/, `${dialect.name} must not default to positional`);
  }
});

test('a wire-compatible engine still on postgresDialect gets the PostgreSQL default', () => {
  // The adapters (CockroachDB, YugabyteDB, AlloyDB, Timescale) are adapters over
  // postgresDialect, not dialects of their own, so they reach the same branch.
  // json_build_array is a core PostgreSQL 9.4+ builtin, same vintage as
  // json_build_object, so this widens no compatibility claim.
  const q = makeQuery('users', schema, { warnOnUnlimited: false, dialect: postgresDialect });
  assert.match(q.buildFindMany({ with: { posts: true } } as never).sql, /json_build_array/);
});

test('the per-query option overrides the client default, in both directions', () => {
  const pgDefault = makeQuery('users', schema, { warnOnUnlimited: false });
  assert.match(
    pgDefault.buildFindMany({ with: { posts: true }, jsonEncoding: 'object' } as never).sql,
    /json_build_object/,
  );
  const objectClient = makeQuery('users', schema, { warnOnUnlimited: false, jsonEncoding: 'object' });
  assert.match(
    objectClient.buildFindMany({ with: { posts: true }, jsonEncoding: 'positional' } as never).sql,
    /json_build_array/,
  );
});

test('findUnique honours the per-query option too', () => {
  const q = makeQuery('users', schema, { warnOnUnlimited: false });
  const pos = q.buildFindUnique({ where: { id: 1 }, with: { posts: true } } as never);
  const obj = q.buildFindUnique({ where: { id: 1 }, with: { posts: true }, jsonEncoding: 'object' } as never);
  assert.match(pos.sql, /json_build_array/);
  assert.match(obj.sql, /json_build_object/);
});

test('an unrecognized jsonEncoding throws E003 rather than being ignored', () => {
  const q = makeQuery('users', schema, { warnOnUnlimited: false });
  assert.throws(
    () => q.buildFindMany({ with: { posts: true }, jsonEncoding: 'obect' } as never),
    (err: unknown) => err instanceof ValidationError && /jsonEncoding/.test((err as Error).message),
  );
  // Refused BEFORE the SQL cache is consulted, so a warm template can never
  // serve a call the cold path would refuse.
  q.buildFindMany({ with: { posts: true } } as never);
  assert.throws(() => q.buildFindMany({ with: { posts: true }, jsonEncoding: 'obect' } as never), ValidationError);
});

// ---------------------------------------------------------------------------
// SQL-template cache isolation. THIS is the correctness requirement behind the
// per-query option: one QueryInterface holds one LRU keyed by query SHAPE, and
// the two encodings have the SAME shape. Serving a positional statement to an
// object-planned call hands `parseNestedRow` bare arrays where it expects keyed
// objects, which is silent data corruption rather than an error.
// ---------------------------------------------------------------------------

test('the two encodings never share a cache entry (findMany, alternating on ONE interface)', () => {
  const q = makeQuery('users', schema, { warnOnUnlimited: false });
  const args = { with: { posts: { with: { comments: true } }, profile: true } };
  // Cold, cold, then two cache HITS in the reverse order. The dev cross-check
  // re-runs the builder on every hit and throws on any divergence, so a passing
  // second round is itself part of the assertion.
  const posCold = q.buildFindMany({ ...args, jsonEncoding: 'positional' } as never);
  const objCold = q.buildFindMany({ ...args, jsonEncoding: 'object' } as never);
  const objHot = q.buildFindMany({ ...args, jsonEncoding: 'object' } as never);
  const posHot = q.buildFindMany({ ...args, jsonEncoding: 'positional' } as never);

  assert.notEqual(posCold.sql, objCold.sql);
  assert.equal(posHot.sql, posCold.sql, 'a warm positional entry must not be served the object statement');
  assert.equal(objHot.sql, objCold.sql, 'a warm object entry must not be served the positional statement');
  assert.match(posHot.sql, /json_build_array/);
  assert.match(objHot.sql, /json_build_object/);
});

test('the two encodings never share a cache entry (findUnique)', () => {
  const q = makeQuery('users', schema, { warnOnUnlimited: false });
  const args = { where: { id: 1 }, with: { posts: true } };
  const pos = q.buildFindUnique({ ...args } as never);
  const obj = q.buildFindUnique({ ...args, jsonEncoding: 'object' } as never);
  assert.notEqual(pos.sql, obj.sql);
  assert.equal(q.buildFindUnique({ ...args } as never).sql, pos.sql);
  assert.equal(q.buildFindUnique({ ...args, jsonEncoding: 'object' } as never).sql, obj.sql);
});

test('a warm entry keeps its OWN parser: rows decode by the plan, not by the last build', () => {
  // The failure this pins is not a wrong statement, it is a right statement
  // parsed by the wrong decoder. Each deferred carries the parser built
  // alongside its own SQL, so interleaving builds cannot cross them.
  const q = makeQuery('users', schema, { warnOnUnlimited: false });
  const args = { with: { posts: true } };
  const pos = q.buildFindMany({ ...args, jsonEncoding: 'positional' } as never);
  const obj = q.buildFindMany({ ...args, jsonEncoding: 'object' } as never);
  // Build a third time in the other order, so `currentJsonEncoding` last held
  // 'positional' when the object deferred's transform runs below.
  q.buildFindMany({ ...args, jsonEncoding: 'positional' } as never);

  const expected = [{ id: 1, name: 'Ada', posts: [{ id: 10, userId: 1, title: 't1' }] }];
  assert.deepEqual(pos.transform(fakeResult({ id: 1, name: 'Ada', posts: JSON.stringify([[10, 1, 't1']]) })), expected);
  assert.deepEqual(
    obj.transform(fakeResult({ id: 1, name: 'Ada', posts: JSON.stringify([{ id: 10, userId: 1, title: 't1' }]) })),
    expected,
  );
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

// NOTE on the three parity tests below: the object arm names `jsonEncoding:
// 'object'` EXPLICITLY, and has to. It used to rely on that being the client
// default; once PostgreSQL's default became positional, both arms were
// positional and the comparison was vacuous. It kept PASSING, because
// `decodePositionalObject` returns a non-array value untouched, so feeding
// already-keyed object rows through the positional decoder is a no-op. A parity
// test whose two sides silently became the same side is worse than no test.
test('positional transform is byte-identical to object transform (nested many + hasOne + null)', () => {
  const withClause = { posts: { with: { comments: true } }, profile: true };
  const objQ = makeQuery('users', schema, { jsonEncoding: 'object', warnOnUnlimited: false });
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
  // Positional payload, column order per shape: posts=[id,userId,title,comments],
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
  const objQ = makeQuery('users', schema, { jsonEncoding: 'object', warnOnUnlimited: false });
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
  const objQ = makeQuery('users', schema, { jsonEncoding: 'object', warnOnUnlimited: false });
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
