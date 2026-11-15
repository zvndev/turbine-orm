/** SQLite benchmark schema, built against this arm's own Drizzle package. */

import { relations, sql } from 'drizzle-orm';
import { customType, index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

// ─── Relations ──────────────────────────────────────────────

export const organizationsRelations = relations(organizations, ({ many }) => ({
  users: many(users),
  posts: many(posts),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [users.orgId],
    references: [organizations.id],
  }),
  posts: many(posts),
  comments: many(comments),
}));

export const postsRelations = relations(posts, ({ one, many }) => ({
  user: one(users, {
    fields: [posts.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [posts.orgId],
    references: [organizations.id],
  }),
  comments: many(comments),
  // Drizzle has no many-to-many primitive: the junction is a first-class table
  // with two to-one relations, and reaching the tags of a post is two hops the
  // caller writes out. That difference is the point of the m2m scenario, so it
  // is modelled exactly as Drizzle's own docs prescribe rather than worked
  // around.
  postTags: many(postTags),
}));

export const tagsRelations = relations(tags, ({ many }) => ({
  postTags: many(postTags),
}));

export const postTagsRelations = relations(postTags, ({ one }) => ({
  post: one(posts, {
    fields: [postTags.postId],
    references: [posts.id],
  }),
  tag: one(tags, {
    fields: [postTags.tagId],
    references: [tags.id],
  }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  post: one(posts, {
    fields: [comments.postId],
    references: [posts.id],
  }),
  user: one(users, {
    fields: [comments.userId],
    references: [users.id],
  }),
}));

export const benchParentsRelations = relations(benchParents, ({ many }) => ({ children: many(benchChildren) }));
export const benchChildrenRelations = relations(benchChildren, ({ one }) => ({
  parentRow: one(benchParents, { fields: [benchChildren.parent], references: [benchParents.id] }),
}));
