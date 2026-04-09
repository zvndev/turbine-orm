/**
 * turbine-orm — SQL cache + prepared statement unit tests
 *
 * Tests the fingerprinting, SQL template caching, and prepared statement name
 * derivation infrastructure WITHOUT a database connection.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fnv1a64Hex, QueryInterface, sqlToPreparedName } from '../query.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const usersTable = mockTable('users', [
  { name: 'id', field: 'id' },
  { name: 'name', field: 'name', pgType: 'text' },
  { name: 'email', field: 'email', pgType: 'text' },
  { name: 'age', field: 'age' },
  { name: 'org_id', field: 'orgId' },
]);

const postsTable = mockTable(
  'posts',
  [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'user_id', field: 'userId' },
    { name: 'published', field: 'published', pgType: 'bool' },
  ],
  {
    comments: {
      name: 'comments',
      type: 'hasMany',
      from: 'posts',
      to: 'comments',
      foreignKey: 'post_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);

const commentsTable = mockTable('comments', [
  { name: 'id', field: 'id' },
  { name: 'body', field: 'body', pgType: 'text' },
  { name: 'post_id', field: 'postId' },
]);

// Users with relations
const usersWithRelations = mockTable(
  'users',
  [
    { name: 'id', field: 'id' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'age', field: 'age' },
    { name: 'org_id', field: 'orgId' },
  ],
  {
    posts: {
      name: 'posts',
      type: 'hasMany',
      from: 'users',
      to: 'posts',
      foreignKey: 'user_id',
      referenceKey: 'id',
    } as RelationDef,
  },
);

function makeSchema(tables: Record<string, ReturnType<typeof mockTable>>): SchemaMetadata {
  return { tables, enums: {} };
}

// ---------------------------------------------------------------------------
// fnv1a64Hex + sqlToPreparedName
// ---------------------------------------------------------------------------

describe('fnv1a64Hex', () => {
  it('returns 16 lowercase hex chars', () => {
    const hash = fnv1a64Hex('SELECT * FROM users WHERE id = $1');
    assert.match(hash, /^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    const a = fnv1a64Hex('SELECT * FROM users WHERE id = $1');
    const b = fnv1a64Hex('SELECT * FROM users WHERE id = $1');
    assert.equal(a, b);
  });

  it('different inputs produce different hashes', () => {
    const a = fnv1a64Hex('SELECT * FROM users WHERE id = $1');
    const b = fnv1a64Hex('SELECT * FROM posts WHERE id = $1');
    assert.notEqual(a, b);
  });
});

describe('sqlToPreparedName', () => {
  it('format matches t_[0-9a-f]{16}', () => {
    const name = sqlToPreparedName('SELECT 1');
    assert.match(name, /^t_[0-9a-f]{16}$/);
    assert.equal(name.length, 18);
  });

  it('is deterministic — same SQL produces same name', () => {
    const sql = 'SELECT * FROM users WHERE id = $1';
    assert.equal(sqlToPreparedName(sql), sqlToPreparedName(sql));
  });

  it('different SQL produces different names', () => {
    const a = sqlToPreparedName('SELECT * FROM users WHERE id = $1');
    const b = sqlToPreparedName('SELECT * FROM posts WHERE id = $1');
    assert.notEqual(a, b);
  });
});

// ---------------------------------------------------------------------------
// fingerprintWhere
// ---------------------------------------------------------------------------

describe('fingerprintWhere', () => {
  const schema = makeSchema({ users: usersTable });
  const qi = makeQuery('users', schema);

  it('is value-invariant: same keys, different values produce identical fingerprint', () => {
    const fp1 = qi.fingerprintWhere({ id: 1 });
    const fp2 = qi.fingerprintWhere({ id: 999 });
    assert.equal(fp1, fp2);
  });

  it('is value-invariant for multiple keys', () => {
    const fp1 = qi.fingerprintWhere({ id: 1, name: 'Alice' });
    const fp2 = qi.fingerprintWhere({ id: 42, name: 'Bob' });
    assert.equal(fp1, fp2);
  });

  it('is shape-sensitive: different keys produce different fingerprint', () => {
    const fp1 = qi.fingerprintWhere({ id: 1 });
    const fp2 = qi.fingerprintWhere({ name: 'Alice' });
    assert.notEqual(fp1, fp2);
  });

  it('distinguishes null from value', () => {
    const fp1 = qi.fingerprintWhere({ id: null });
    const fp2 = qi.fingerprintWhere({ id: 1 });
    assert.notEqual(fp1, fp2);
  });

  it('distinguishes OR from AND', () => {
    const fp1 = qi.fingerprintWhere({ OR: [{ id: 1 }, { id: 2 }] });
    const fp2 = qi.fingerprintWhere({ AND: [{ id: 1 }, { id: 2 }] });
    assert.notEqual(fp1, fp2);
  });

  it('handles NOT combinator', () => {
    const fp1 = qi.fingerprintWhere({ NOT: { id: 1 } });
    const fp2 = qi.fingerprintWhere({ id: 1 });
    assert.notEqual(fp1, fp2);
  });

  it('handles operator objects (gt, lt, etc.)', () => {
    const fp1 = qi.fingerprintWhere({ age: { gt: 18 } });
    const fp2 = qi.fingerprintWhere({ age: { gt: 65 } });
    assert.equal(fp1, fp2); // same operator, different value

    const fp3 = qi.fingerprintWhere({ age: { lt: 18 } });
    assert.notEqual(fp1, fp3); // different operator
  });

  it('handles in/notIn operators', () => {
    const fp1 = qi.fingerprintWhere({ id: { in: [1, 2, 3] } });
    const fp2 = qi.fingerprintWhere({ id: { in: [4, 5, 6] } });
    assert.equal(fp1, fp2);
  });

  it('empty where returns empty string', () => {
    assert.equal(qi.fingerprintWhere({}), '');
  });

  it('ignores undefined values', () => {
    const fp1 = qi.fingerprintWhere({ id: 1, name: undefined });
    const fp2 = qi.fingerprintWhere({ id: 1 });
    assert.equal(fp1, fp2);
  });
});

// ---------------------------------------------------------------------------
// withFingerprint
// ---------------------------------------------------------------------------

describe('withFingerprint', () => {
  const schema = makeSchema({
    users: usersWithRelations,
    posts: postsTable,
    comments: commentsTable,
  });
  const qi = makeQuery('users', schema);

  it('simple include produces consistent fingerprint', () => {
    const fp1 = qi.withFingerprint({ posts: true });
    const fp2 = qi.withFingerprint({ posts: true });
    assert.equal(fp1, fp2);
    assert.ok(fp1.length > 0);
  });

  it('different relations produce different fingerprints', () => {
    // Users only has posts relation, test shape difference
    const fp1 = qi.withFingerprint({ posts: true });
    const fp2 = qi.withFingerprint({ posts: { where: { published: true } } });
    assert.notEqual(fp1, fp2);
  });

  it('same tree, different values produce identical fingerprint', () => {
    const fp1 = qi.withFingerprint({ posts: { where: { published: true } } });
    const fp2 = qi.withFingerprint({ posts: { where: { published: false } } });
    assert.equal(fp1, fp2);
  });

  it('limit presence affects fingerprint', () => {
    const fp1 = qi.withFingerprint({ posts: { limit: 5 } });
    const fp2 = qi.withFingerprint({ posts: true });
    assert.notEqual(fp1, fp2);
  });

  it('orderBy affects fingerprint', () => {
    const fp1 = qi.withFingerprint({ posts: { orderBy: { id: 'asc' } } });
    const fp2 = qi.withFingerprint({ posts: { orderBy: { id: 'desc' } } });
    assert.notEqual(fp1, fp2);
  });

  it('nested with recursion works', () => {
    const postsQi = makeQuery('posts', schema);
    const fp1 = postsQi.withFingerprint({ comments: true });
    const fp2 = postsQi.withFingerprint({ comments: true });
    assert.equal(fp1, fp2);
  });

  it('undefined/empty with returns empty string', () => {
    assert.equal(qi.withFingerprint(undefined), '');
  });
});

// ---------------------------------------------------------------------------
// SQL text identity across calls with different values
// ---------------------------------------------------------------------------

describe('SQL template caching', () => {
  it('same shape queries produce identical SQL text', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildFindUnique({ where: { id: 1 } });
    const d2 = qi.buildFindUnique({ where: { id: 999 } });

    assert.equal(d1.sql, d2.sql);
    assert.notDeepEqual(d1.params, d2.params);
  });

  it('findMany produces identical SQL for same shape', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildFindMany({ where: { orgId: 1 }, limit: 10 });
    const d2 = qi.buildFindMany({ where: { orgId: 2 }, limit: 20 });

    assert.equal(d1.sql, d2.sql);
  });

  it('count produces identical SQL for same shape', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildCount({ where: { orgId: 1 } });
    const d2 = qi.buildCount({ where: { orgId: 2 } });

    assert.equal(d1.sql, d2.sql);
  });

  it('delete produces identical SQL for same shape', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildDelete({ where: { id: 1 } });
    const d2 = qi.buildDelete({ where: { id: 2 } });

    assert.equal(d1.sql, d2.sql);
  });

  it('update produces identical SQL for same shape', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildUpdate({ where: { id: 1 }, data: { name: 'Alice' } });
    const d2 = qi.buildUpdate({ where: { id: 2 }, data: { name: 'Bob' } });

    assert.equal(d1.sql, d2.sql);
  });

  it('updateMany produces identical SQL for same shape', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildUpdateMany({ where: { orgId: 1 }, data: { name: 'Alice' } });
    const d2 = qi.buildUpdateMany({ where: { orgId: 2 }, data: { name: 'Bob' } });

    assert.equal(d1.sql, d2.sql);
  });

  it('deleteMany produces identical SQL for same shape', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildDeleteMany({ where: { orgId: 1 } });
    const d2 = qi.buildDeleteMany({ where: { orgId: 2 } });

    assert.equal(d1.sql, d2.sql);
  });
});

// ---------------------------------------------------------------------------
// Cache hit/miss counters
// ---------------------------------------------------------------------------

describe('cache hit/miss counters', () => {
  it('first call is a miss, subsequent calls are hits', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    qi.buildFindUnique({ where: { id: 1 } });
    let stats = qi.cacheStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 0);

    qi.buildFindUnique({ where: { id: 2 } });
    stats = qi.cacheStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 1);

    qi.buildFindUnique({ where: { id: 3 } });
    qi.buildFindUnique({ where: { id: 4 } });
    qi.buildFindUnique({ where: { id: 5 } });

    stats = qi.cacheStats();
    assert.equal(stats.misses, 1);
    assert.equal(stats.hits, 4);
    assert.ok(stats.hitRate > 0.7);
  });

  it('different shapes are separate misses', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    qi.buildFindUnique({ where: { id: 1 } });
    qi.buildFindUnique({ where: { email: 'a@b.com' } });
    qi.buildFindUnique({ where: { id: 1, email: 'a@b.com' } });
    qi.buildCount({ where: { orgId: 1 } });
    qi.buildCount();

    const stats = qi.cacheStats();
    assert.equal(stats.misses, 5);
    assert.equal(stats.hits, 0);
  });

  it('hitRate is 0 when no queries have been made', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);
    assert.equal(qi.cacheStats().hitRate, 0);
  });
});

// ---------------------------------------------------------------------------
// Cache eviction
// ---------------------------------------------------------------------------

describe('cache eviction', () => {
  it('cache stays at 1000 entries after 1001 unique shapes', () => {
    // Create a table with 1001 columns to get 1001 unique where-key shapes
    const columns = [];
    for (let i = 0; i < 1001; i++) {
      columns.push({ name: `col_${i}`, field: `col${i}`, pgType: 'int8' });
    }
    const bigTable = mockTable('big', columns);
    const schema = makeSchema({ big: bigTable });
    const qi = makeQuery('big', schema);

    // Each call uses a different column key -> different fingerprint
    for (let i = 0; i < 1001; i++) {
      qi.buildCount({ where: { [`col${i}`]: i } });
    }

    const stats = qi.cacheStats();
    assert.equal(stats.size, 1000);
    assert.equal(stats.misses, 1001);
  });
});

// ---------------------------------------------------------------------------
// DeferredQuery carries preparedName
// ---------------------------------------------------------------------------

describe('DeferredQuery.preparedName', () => {
  it('is set on buildFindUnique result', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const deferred = qi.buildFindUnique({ where: { id: 1 } });
    assert.ok(deferred.preparedName);
    assert.match(deferred.preparedName, /^t_[0-9a-f]{16}$/);
  });

  it('is set on buildFindMany result', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const deferred = qi.buildFindMany({ where: { orgId: 1 }, limit: 10 });
    assert.ok(deferred.preparedName);
    assert.match(deferred.preparedName, /^t_[0-9a-f]{16}$/);
  });

  it('is set on buildCount result', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const deferred = qi.buildCount({ where: { orgId: 1 } });
    assert.ok(deferred.preparedName);
    assert.match(deferred.preparedName, /^t_[0-9a-f]{16}$/);
  });

  it('is set on buildDelete result', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const deferred = qi.buildDelete({ where: { id: 1 } });
    assert.ok(deferred.preparedName);
    assert.match(deferred.preparedName, /^t_[0-9a-f]{16}$/);
  });

  it('is set on buildUpdate result', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const deferred = qi.buildUpdate({ where: { id: 1 }, data: { name: 'Alice' } });
    assert.ok(deferred.preparedName);
  });

  it('is set on buildDeleteMany result', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const deferred = qi.buildDeleteMany({ where: { orgId: 1 } });
    assert.ok(deferred.preparedName);
  });

  it('is set on buildUpdateMany result', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const deferred = qi.buildUpdateMany({ where: { orgId: 1 }, data: { name: 'Bob' } });
    assert.ok(deferred.preparedName);
  });

  it('same SQL text produces same preparedName', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildFindUnique({ where: { id: 1 } });
    const d2 = qi.buildFindUnique({ where: { id: 999 } });

    assert.equal(d1.preparedName, d2.preparedName);
  });

  it('different SQL text produces different preparedName', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildFindUnique({ where: { id: 1 } });
    const d2 = qi.buildFindUnique({ where: { email: 'x' } });

    assert.notEqual(d1.preparedName, d2.preparedName);
  });
});

// ---------------------------------------------------------------------------
// With-clause cache hit across param values
// ---------------------------------------------------------------------------

describe('with-clause caching', () => {
  it('findUnique with `with` produces identical SQL for different param values', () => {
    const schema = makeSchema({
      users: usersWithRelations,
      posts: postsTable,
      comments: commentsTable,
    });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildFindUnique({ where: { id: 1 }, with: { posts: true } });
    const d2 = qi.buildFindUnique({ where: { id: 999 }, with: { posts: true } });

    assert.equal(d1.sql, d2.sql);
    assert.equal(d1.preparedName, d2.preparedName);
    assert.notDeepEqual(d1.params, d2.params);
  });

  it('findMany with `with` produces identical SQL for different param values', () => {
    const schema = makeSchema({
      users: usersWithRelations,
      posts: postsTable,
      comments: commentsTable,
    });
    const qi = makeQuery('users', schema);

    const d1 = qi.buildFindMany({ where: { id: 1 }, with: { posts: true }, limit: 10 });
    const d2 = qi.buildFindMany({ where: { id: 2 }, with: { posts: true }, limit: 20 });

    assert.equal(d1.sql, d2.sql);
  });
});

// ---------------------------------------------------------------------------
// Param correctness — ensure params match SQL placeholders
// ---------------------------------------------------------------------------

describe('param order correctness', () => {
  it('findUnique simple: params match where key order', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildFindUnique({ where: { id: 42 } });
    assert.deepEqual(d.params, [42]);
    assert.ok(d.sql.includes('$1'));
  });

  it('findMany with limit and offset: params are [where..., limit, offset]', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildFindMany({ where: { orgId: 5 }, limit: 10, offset: 20 });
    assert.deepEqual(d.params, [5, 10, 20]);
  });

  it('update: params are [set..., where...]', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildUpdate({ where: { id: 7 }, data: { name: 'NewName' } });
    assert.deepEqual(d.params, ['NewName', 7]);
  });

  it('update with atomic operator: params match', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildUpdate({ where: { id: 1 }, data: { age: { increment: 5 } } });
    assert.deepEqual(d.params, [5, 1]);
    assert.ok(d.sql.includes('+ $1'));
    assert.ok(d.sql.includes('= $2'));
  });

  it('count with no where: empty params', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildCount();
    assert.deepEqual(d.params, []);
  });

  it('count with where: correct params', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildCount({ where: { orgId: 3 } });
    assert.deepEqual(d.params, [3]);
  });

  it('findUnique with operator where: params match', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildFindUnique({ where: { age: { gt: 18, lte: 65 } } });
    assert.deepEqual(d.params, [18, 65]);
  });

  it('findUnique with null where: no param for IS NULL', () => {
    const schema = makeSchema({ users: usersTable });
    const qi = makeQuery('users', schema);

    const d = qi.buildFindUnique({ where: { email: null } });
    assert.deepEqual(d.params, []);
    assert.ok(d.sql.includes('IS NULL'));
  });
});

// ---------------------------------------------------------------------------
// sqlCache: false disables caching
// ---------------------------------------------------------------------------

describe('sqlCache: false', () => {
  it('all calls are cache misses when sqlCache is disabled', () => {
    const schema = makeSchema({ users: usersTable });
    // biome-ignore lint/suspicious/noExplicitAny: mock pool not needed for build-only tests
    const qi = new QueryInterface(null as any, 'users', schema, undefined, { sqlCache: false });

    qi.buildFindUnique({ where: { id: 1 } });
    qi.buildFindUnique({ where: { id: 2 } });
    qi.buildFindUnique({ where: { id: 3 } });

    const stats = qi.cacheStats();
    assert.equal(stats.misses, 3);
    assert.equal(stats.hits, 0);
    assert.equal(stats.size, 0);
  });
});
