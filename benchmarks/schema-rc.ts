/**
 * Drizzle 1.0.0-rc.4 schema for the benchmark suite.
 *
 * Why this file exists as a SEPARATE copy of schema.ts:
 *
 *   1. Drizzle 1.0 is installed side by side with the stable 0.45.2 under the
 *      npm alias `drizzle-rc`. Table objects carry an `entityKind` brand that is
 *      checked by identity, so a table built by 0.45's `pg-core` is not a table
 *      as far as the RC's query builder is concerned. Each arm must define its
 *      tables against its OWN copy of the library.
 *
 *   2. The relational query builder is a BREAKING redesign in 1.0 (RQB v2).
 *      0.45 attaches relations per table with `relations(table, ({one, many}))`
 *      and the driver receives them as `{ schema }`; 1.0 declares them centrally
 *      with `defineRelations(schema, (r) => ...)` and the driver receives them
 *      as `{ relations }`. There is no shared spelling, so the port is by hand.
 *
 * The TABLES below are a faithful transcription of schema.ts: same names, same
 * column types, same modes, same indexes. Only the relation DECLARATION syntax
 * differs, because that is the part 1.0 changed. Row-for-row equivalence of the
 * two arms is asserted by `verify-arms.ts` before any timing is recorded.
 */

import {
  pgTable,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
  index,
  primaryKey,
} from 'drizzle-rc/pg-core';
import { defineRelations } from 'drizzle-rc';

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

export const schema = {
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

export const relations = defineRelations(schema, (r) => ({
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
