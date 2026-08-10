import { pgTable, bigint, text, boolean, integer, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─── Tables ─────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: bigint('org_id', { mode: 'number' }).notNull(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').notNull().default('member'),
  avatarUrl: text('avatar_url'),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_users_org_id').on(table.orgId),
]);

export const posts = pgTable('posts', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  orgId: bigint('org_id', { mode: 'number' }).notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  published: boolean('published').notNull().default(false),
  viewCount: integer('view_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_posts_user_id').on(table.userId),
  index('idx_posts_org_id').on(table.orgId),
  index('idx_posts_created_at').on(table.createdAt),
]);

export const comments = pgTable('comments', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  postId: bigint('post_id', { mode: 'number' }).notNull(),
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_comments_post_id').on(table.postId),
  index('idx_comments_user_id').on(table.userId),
]);

export const tags = pgTable('tags', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  name: text('name').notNull().unique(),
  slug: text('slug').notNull().unique(),
});

export const postTags = pgTable('post_tags', {
  postId: bigint('post_id', { mode: 'number' }).notNull(),
  tagId: bigint('tag_id', { mode: 'number' }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.postId, table.tagId] }),
  index('idx_post_tags_tag_id').on(table.tagId),
]);

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
const wideBool = Object.fromEntries(
  Array.from({ length: 5 }, (_, i) => {
    const c = `b${String(i + 1).padStart(2, '0')}`;
    return [c, boolean(c).notNull()];
  }),
) as Record<string, ReturnType<typeof boolean>>;
const wideDate = Object.fromEntries(
  Array.from({ length: 3 }, (_, i) => {
    const c = `d${String(i + 1).padStart(2, '0')}`;
    return [c, timestamp(c, { withTimezone: true }).notNull()];
  }),
) as Record<string, ReturnType<typeof timestamp>>;

export const benchWide = pgTable('bench_wide', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  ...wideText,
  ...wideInt,
  ...wideBool,
  ...wideDate,
});

export const benchWrites = pgTable('bench_writes', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: bigint('org_id', { mode: 'number' }).notNull(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
  amount: integer('amount').notNull().default(0),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('idx_bench_writes_org_id').on(table.orgId),
]);

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
