/** MySQL tables built with this arm's own Drizzle package. */

import { defineRelations } from 'drizzle-rc';
import { bigint, boolean, datetime, index, int, mysqlTable, primaryKey, text, varchar } from 'drizzle-rc/mysql-core';

// ─── Tables ─────────────────────────────────────────────────

export const organizations = mysqlTable('organizations', {
  id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  name: text('name').notNull(),
  slug: varchar('slug', { length: 191 }).notNull().unique(),
  plan: text('plan').notNull().default('free'),
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
});

export const users = mysqlTable(
  'users',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    orgId: bigint('org_id', { mode: 'number' }).notNull(),
    email: varchar('email', { length: 191 }).notNull().unique(),
    name: text('name').notNull(),
    role: text('role').notNull().default('member'),
    avatarUrl: text('avatar_url'),
    lastLoginAt: datetime('last_login_at', { mode: 'date', fsp: 3 }),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('idx_users_org_id').on(table.orgId)],
);

export const posts = mysqlTable(
  'posts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    orgId: bigint('org_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    published: boolean('published').notNull().default(false),
    viewCount: int('view_count').notNull().default(0),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
    updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [
    index('idx_posts_user_id').on(table.userId),
    index('idx_posts_org_id').on(table.orgId),
    index('idx_posts_created_at').on(table.createdAt),
  ],
);

export const comments = mysqlTable(
  'comments',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    postId: bigint('post_id', { mode: 'number' }).notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    body: text('body').notNull(),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('idx_comments_post_id').on(table.postId), index('idx_comments_user_id').on(table.userId)],
);

export const tags = mysqlTable('tags', {
  id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  name: varchar('name', { length: 191 }).notNull().unique(),
  slug: varchar('slug', { length: 191 }).notNull().unique(),
});

export const postTags = mysqlTable(
  'post_tags',
  {
    postId: bigint('post_id', { mode: 'number' }).notNull(),
    tagId: bigint('tag_id', { mode: 'number' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] }), index('idx_post_tags_tag_id').on(table.tagId)],
);

const wideText = Object.fromEntries(
  Array.from({ length: 20 }, (_, i) => {
    const c = `t${String(i + 1).padStart(2, '0')}`;
    return [c, text(c).notNull()];
  }),
) as Record<string, ReturnType<typeof text>>;
const wideInt = Object.fromEntries(
  Array.from({ length: 10 }, (_, i) => {
    const c = `n${String(i + 1).padStart(2, '0')}`;
    return [c, int(c).notNull()];
  }),
) as Record<string, ReturnType<typeof int>>;
const wideBool = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => {
    const c = `b${String(i + 1).padStart(2, '0')}`;
    return [c, boolean(c).notNull()];
  }),
) as Record<string, ReturnType<typeof boolean>>;
const wideDate = Object.fromEntries(
  Array.from({ length: 3 }, (_, i) => {
    const c = `d${String(i + 1).padStart(2, '0')}`;
    return [c, datetime(c, { mode: 'date', fsp: 3 }).notNull()];
  }),
) as Record<string, ReturnType<typeof datetime>>;

export const benchWide = mysqlTable('bench_wide', {
  id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
  ...wideText,
  ...wideInt,
  ...wideBool,
  ...wideDate,
});

export const benchWrites = mysqlTable(
  'bench_writes',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().autoincrement(),
    orgId: bigint('org_id', { mode: 'number' }).notNull(),
    slug: varchar('slug', { length: 191 }).notNull().unique(),
    label: text('label').notNull(),
    amount: int('amount').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: datetime('created_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (table) => [index('idx_bench_writes_org_id').on(table.orgId)],
);

export const tables = {
  organizations,
  users,
  posts,
  comments,
  tags,
  postTags,
  benchWide,
  benchWrites,
};

// ─── Relations (RQB v2) ─────────────────────────────────────
// Same graph as schema.ts, expressed in 1.0's central form. `from`/`to` replace
// 0.45's `fields`/`references`; the many side is declared without a config
// because 1.0 infers it from the matching one side.

export const relations = defineRelations(tables, (r) => ({
  organizations: {
    users: r.many.users(),
    posts: r.many.posts(),
  },
  users: {
    organization: r.one.organizations({
      from: r.users.orgId,
      to: r.organizations.id,
    }),
    posts: r.many.posts(),
    comments: r.many.comments(),
  },
  posts: {
    user: r.one.users({
      from: r.posts.userId,
      to: r.users.id,
    }),
    organization: r.one.organizations({
      from: r.posts.orgId,
      to: r.organizations.id,
    }),
    comments: r.many.comments(),
    postTags: r.many.postTags(),
  },
  tags: {
    postTags: r.many.postTags(),
  },
  postTags: {
    post: r.one.posts({
      from: r.postTags.postId,
      to: r.posts.id,
    }),
    tag: r.one.tags({
      from: r.postTags.tagId,
      to: r.tags.id,
    }),
  },
  comments: {
    post: r.one.posts({
      from: r.comments.postId,
      to: r.posts.id,
    }),
    user: r.one.users({
      from: r.comments.userId,
      to: r.users.id,
    }),
  },
}));
