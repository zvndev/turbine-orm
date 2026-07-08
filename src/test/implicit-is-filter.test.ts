import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeQuery, mockTable } from './helpers.js';

const schema = {
  tables: {
    posts: mockTable(
      'posts',
      [
        { name: 'id', field: 'id' },
        { name: 'author_id', field: 'authorId' },
        { name: 'title', field: 'title', pgType: 'text' },
      ],
      {
        author: {
          type: 'belongsTo' as const,
          name: 'author',
          from: 'posts',
          to: 'users',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
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
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ]),
    comments: mockTable('comments', [
      { name: 'id', field: 'id' },
      { name: 'post_id', field: 'postId' },
      { name: 'body', field: 'body', pgType: 'text' },
    ]),
  },
  enums: {},
};

test('bare to-one relation filter is treated as implicit `is`', () => {
  const q = makeQuery('posts', schema);
  const bare = q.buildFindMany({ where: { author: { name: { contains: 'kirby' } } } } as never);
  const explicit = q.buildFindMany({
    where: { author: { is: { name: { contains: 'kirby' } } } },
  } as never);
  assert.equal(bare.sql, explicit.sql);
  assert.deepEqual(bare.params, explicit.params);
});

test('bare to-many relation filter still requires some/every/none', () => {
  const q = makeQuery('posts', schema);
  assert.throws(() => q.buildFindMany({ where: { comments: { body: 'x' } } } as never));
});

test('is:null / isNot:null are relation existence checks', () => {
  const q = makeQuery('posts', schema);
  const isNull = q.buildFindMany({ where: { author: { is: null } } } as never);
  assert.match(isNull.sql, /NOT EXISTS \(SELECT 1 FROM "users"/);
  const isNotNull = q.buildFindMany({ where: { author: { isNot: null } } } as never);
  assert.match(isNotNull.sql, /(?<!NOT )EXISTS \(SELECT 1 FROM "users"/);
});
