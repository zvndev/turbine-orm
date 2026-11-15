/** SQLite benchmark schema, built against this arm's own Drizzle package. */

import { defineRelations, sql } from 'drizzle-rc';
import { customType, index, integer, primaryKey, sqliteTable, text } from 'drizzle-rc/sqlite-core';

const dateTime = customType<{ data: Date; driverData: string }>({
  dataType: () => 'datetime',
  fromDriver: (v) => new Date(v),
  toDriver: (v) => v.toISOString(),
});
export const organizations = sqliteTable('organizations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  createdAt: dateTime('created_at').notNull().default(sql`'2023-11-14T22:13:20.000Z'`),
});

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: integer('org_id').notNull(),
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: text('role').notNull().default('member'),
    avatarUrl: text('avatar_url'),
    lastLoginAt: dateTime('last_login_at'),
    createdAt: dateTime('created_at').notNull().default(sql`'2023-11-14T22:13:20.000Z'`),
  },
  (table) => [index('idx_users_org_id').on(table.orgId)],
);

export const posts = sqliteTable(
  'posts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    orgId: integer('org_id').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    published: integer('published', { mode: 'boolean' }).notNull().default(false),
    viewCount: integer('view_count').notNull().default(0),
    createdAt: dateTime('created_at').notNull().default(sql`'2023-11-14T22:13:20.000Z'`),
    updatedAt: dateTime('updated_at').notNull().default(sql`'2023-11-14T22:13:20.000Z'`),
  },
  (table) => [
    index('idx_posts_user_id').on(table.userId),
    index('idx_posts_org_id').on(table.orgId),
    index('idx_posts_created_at').on(table.createdAt),
  ],
);

export const comments = sqliteTable(
  'comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: integer('post_id').notNull(),
    userId: integer('user_id').notNull(),
    body: text('body').notNull(),
    createdAt: dateTime('created_at').notNull().default(sql`'2023-11-14T22:13:20.000Z'`),
  },
  (table) => [index('idx_comments_post_id').on(table.postId), index('idx_comments_user_id').on(table.userId)],
);

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
});

export const postTags = sqliteTable(
  'post_tags',
  {
    postId: integer('post_id').notNull(),
    tagId: integer('tag_id').notNull(),
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
    return [c, integer(c).notNull()];
  }),
) as Record<string, ReturnType<typeof integer>>;
const booleanColumn = (name: string) => integer(name, { mode: 'boolean' }).notNull();
const wideBool = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => {
    const c = `b${String(i + 1).padStart(2, '0')}`;
    return [c, booleanColumn(c)];
  }),
) as Record<string, ReturnType<typeof booleanColumn>>;
const wideDate = Object.fromEntries(
  Array.from({ length: 3 }, (_, i) => {
    const c = `d${String(i + 1).padStart(2, '0')}`;
    return [c, dateTime(c).notNull()];
  }),
) as Record<string, ReturnType<typeof dateTime>>;

export const benchWide = sqliteTable('bench_wide', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ...wideText,
  ...wideInt,
  ...wideBool,
  ...wideDate,
});

export const benchWrites = sqliteTable(
  'bench_writes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    orgId: integer('org_id').notNull(),
    slug: text('slug').notNull().unique(),
    label: text('label').notNull(),
    amount: integer('amount').notNull().default(0),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: dateTime('created_at').notNull().default(sql`'2023-11-14T22:13:20.000Z'`),
  },
  (table) => [index('idx_bench_writes_org_id').on(table.orgId)],
);

export const benchParents = sqliteTable('bench_parents', { id: integer('id').primaryKey() });
export const benchChildren = sqliteTable('bench_children', {
  id: integer('id').primaryKey(),
  parent: integer('parent').notNull(),
  label: text('label').notNull(),
});
export const benchTiny = sqliteTable('bench_tiny', {
  id: integer('id').primaryKey(),
  score: integer('score'),
  bucket: integer('bucket').notNull(),
  label: text('label').notNull(),
});
export const benchPage = sqliteTable('bench_page', {
  id: integer('id').primaryKey(),
  score: integer('score'),
  bucket: integer('bucket').notNull(),
  label: text('label').notNull(),
});

// ─── Relations (RQB v2) ─────────────────────────────────────
// Same graph as schema.ts, expressed in 1.0's central form. `from`/`to` replace
// 0.45's `fields`/`references`; the many side is declared without a config
// because 1.0 infers it from the matching one side.

export const schema = {
  organizations,
  users,
  posts,
  comments,
  tags,
  postTags,
  benchWide,
  benchWrites,
  benchPage,
  benchTiny,
  benchParents,
  benchChildren,
};
export const relations = defineRelations(schema, (r) => ({
  benchParents: { children: r.many.benchChildren() },
  benchChildren: { parentRow: r.one.benchParents({ from: r.benchChildren.parent, to: r.benchParents.id }) },
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
    tags: r.many.tags({ from: r.posts.id.through(r.postTags.postId), to: r.tags.id.through(r.postTags.tagId) }),
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
