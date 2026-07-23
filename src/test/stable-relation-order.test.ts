/**
 * turbine-orm — opt-in stableRelationOrder (finding 10)
 *
 * When enabled, every to-many `with` relation lacking an explicit orderBy is
 * loaded ordered by the target PK ascending. Flag OFF must be byte-identical to
 * today; an explicit relation orderBy always wins.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
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
      orgs: {
        type: 'manyToMany',
        name: 'orgs',
        from: 'users',
        to: 'orgs',
        foreignKey: 'id',
        referenceKey: 'id',
        through: { table: 'user_orgs', sourceKey: 'user_id', targetKey: 'org_id' },
      },
      events: {
        type: 'hasMany',
        name: 'events',
        from: 'users',
        to: 'events',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
      logs: { type: 'hasMany', name: 'logs', from: 'users', to: 'logs', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  (posts.relations as TableMetadata['relations']).comments = {
    type: 'hasMany',
    name: 'comments',
    from: 'posts',
    to: 'comments',
    foreignKey: 'post_id',
    referenceKey: 'id',
  };
  const comments = mockTable('comments', [
    { name: 'id', field: 'id' },
    { name: 'post_id', field: 'postId' },
  ]);
  const profiles = mockTable('profiles', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
  ]);
  const orgs = mockTable('orgs', [{ name: 'id', field: 'id' }]);
  const userOrgs = mockTable('user_orgs', [
    { name: 'user_id', field: 'userId' },
    { name: 'org_id', field: 'orgId' },
  ]);
  // Composite-PK target for the composite branch.
  const events = mockTable('events', [
    { name: 'ev_a', field: 'evA' },
    { name: 'ev_b', field: 'evB' },
    { name: 'user_id', field: 'userId' },
  ]);
  events.primaryKey = ['ev_a', 'ev_b'];
  // PK-less target → nothing stable to order by.
  const logs = mockTable('logs', [
    { name: 'user_id', field: 'userId' },
    { name: 'msg', field: 'msg', pgType: 'text' },
  ]);
  logs.primaryKey = [];
  return { enums: {}, tables: { users, posts, comments, profiles, orgs, user_orgs: userOrgs, events, logs } };
}

describe('stableRelationOrder OFF (byte-identical default)', () => {
  it('injects no ORDER BY into an unordered to-many subquery', () => {
    const q = makeQuery('users', schema());
    const { sql } = q.buildFindMany({ with: { posts: true } } as never);
    assert.doesNotMatch(sql, /ORDER BY/);
  });

  it('on vs off produce DIFFERENT SQL (distinct cache entries)', () => {
    const off = makeQuery('users', schema()).buildFindMany({ with: { posts: true } } as never);
    const on = makeQuery('users', schema(), { stableRelationOrder: true }).buildFindMany({
      with: { posts: true },
    } as never);
    assert.notEqual(off.sql, on.sql);
  });
});

describe('stableRelationOrder ON', () => {
  const on = () => makeQuery('users', schema(), { stableRelationOrder: true });

  it('fills PK-asc ORDER BY into an unordered hasMany', () => {
    const { sql } = on().buildFindMany({ with: { posts: true } } as never);
    assert.match(sql, /ORDER BY [^)]*"id" ASC/);
  });

  it('fills PK-asc ORDER BY into an unordered m2m', () => {
    const { sql } = on().buildFindMany({ with: { orgs: true } } as never);
    assert.match(sql, /ORDER BY [^)]*"id" ASC/);
  });

  it('emits BOTH columns for a composite-PK target', () => {
    const { sql } = on().buildFindMany({ with: { events: true } } as never);
    assert.match(sql, /"ev_a" ASC/);
    assert.match(sql, /"ev_b" ASC/);
  });

  it('leaves an explicit relation orderBy untouched', () => {
    const explicitOn = on().buildFindMany({ with: { posts: { orderBy: { title: 'desc' } } } } as never);
    const explicitOff = makeQuery('users', schema()).buildFindMany({
      with: { posts: { orderBy: { title: 'desc' } } },
    } as never);
    assert.equal(explicitOn.sql, explicitOff.sql, 'explicit orderBy wins — flag is a no-op');
    assert.match(explicitOn.sql, /"title" DESC/);
  });

  it('recurses into nested with (orders comments too)', () => {
    const { sql } = on().buildFindMany({ with: { posts: { with: { comments: true } } } } as never);
    // Two ordered subqueries: posts by its PK and comments by its PK.
    const orders = [...sql.matchAll(/ORDER BY/g)];
    assert.ok(orders.length >= 2, `expected nested ordering, got: ${sql}`);
  });

  it('skips to-one relations (single row, nothing to order)', () => {
    const { sql } = on().buildFindMany({ with: { profile: true } } as never);
    assert.doesNotMatch(sql, /ORDER BY/);
  });

  it('skips a PK-less target silently', () => {
    const { sql } = on().buildFindMany({ with: { logs: true } } as never);
    assert.doesNotMatch(sql, /ORDER BY/);
  });
});

describe('stableRelationOrder precedence (per-query beats client)', () => {
  it('per-query true overrides client false', () => {
    const q = makeQuery('users', schema(), { stableRelationOrder: false });
    const { sql } = q.buildFindMany({ with: { posts: true }, stableRelationOrder: true } as never);
    assert.match(sql, /ORDER BY [^)]*"id" ASC/);
  });

  it('per-query false overrides client true', () => {
    const q = makeQuery('users', schema(), { stableRelationOrder: true });
    const { sql } = q.buildFindMany({ with: { posts: true }, stableRelationOrder: false } as never);
    assert.doesNotMatch(sql, /ORDER BY/);
  });
});
