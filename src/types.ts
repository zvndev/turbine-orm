/**
 * turbine-orm — Generated entity types
 *
 * These types mirror the Postgres schema and would normally be auto-generated
 * by `npx turbine generate` from your database schema or Rust entity definitions.
 *
 * Schema: turbine/sql/schema.sql
 */

// ---------------------------------------------------------------------------
// Base entity types (1:1 with table columns)
// ---------------------------------------------------------------------------

export interface Organization {
  id: number;
  name: string;
  slug: string;
  plan: string;
  createdAt: Date;
}

export interface User {
  id: number;
  orgId: number;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface Post {
  id: number;
  userId: number;
  orgId: number;
  title: string;
  content: string;
  published: boolean;
  viewCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Comment {
  id: number;
  postId: number;
  userId: number;
  body: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Create/update input types (omit auto-generated columns)
// ---------------------------------------------------------------------------

export type OrganizationCreate = Omit<Organization, 'id' | 'createdAt'>;
export type OrganizationUpdate = Partial<Omit<Organization, 'id' | 'createdAt'>>;

export type UserCreate = Omit<User, 'id' | 'createdAt'>;
export type UserUpdate = Partial<Omit<User, 'id' | 'createdAt'>>;

export type PostCreate = Omit<Post, 'id' | 'createdAt' | 'updatedAt' | 'viewCount'>;
export type PostUpdate = Partial<Omit<Post, 'id' | 'createdAt' | 'updatedAt'>>;

export type CommentCreate = Omit<Comment, 'id' | 'createdAt'>;
export type CommentUpdate = Partial<Omit<Comment, 'id' | 'createdAt'>>;

// ---------------------------------------------------------------------------
// Relation types for nested queries
// ---------------------------------------------------------------------------

/** User with their posts loaded */
export interface UserWithPosts extends User {
  posts: Post[];
}

/** User with posts and each post's comments */
export interface UserWithPostsAndComments extends User {
  posts: (Post & { comments: Comment[] })[];
}

/** Post with its comments loaded */
export interface PostWithComments extends Post {
  comments: Comment[];
}

/** Organization with all nested relations (full tree) */
export interface OrgWithEverything extends Organization {
  users: (User & { posts: (Post & { comments: Comment[] })[] })[];
}

/** Organization with users loaded */
export interface OrgWithUsers extends Organization {
  users: User[];
}

// ---------------------------------------------------------------------------
// Column-name mappings (camelCase <-> snake_case)
// ---------------------------------------------------------------------------

/** Maps camelCase field names to snake_case column names */
export const COLUMN_MAP: Record<string, Record<string, string>> = {
  organizations: {
    id: 'id',
    name: 'name',
    slug: 'slug',
    plan: 'plan',
    createdAt: 'created_at',
  },
  users: {
    id: 'id',
    orgId: 'org_id',
    email: 'email',
    name: 'name',
    role: 'role',
    avatarUrl: 'avatar_url',
    lastLoginAt: 'last_login_at',
    createdAt: 'created_at',
  },
  posts: {
    id: 'id',
    userId: 'user_id',
    orgId: 'org_id',
    title: 'title',
    content: 'content',
    published: 'published',
    viewCount: 'view_count',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  comments: {
    id: 'id',
    postId: 'post_id',
    userId: 'user_id',
    body: 'body',
    createdAt: 'created_at',
  },
} as const;

/** Reverse map: snake_case column -> camelCase field */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Forward map: camelCase field -> snake_case column */
export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Relation metadata (used by query builder for JOINs / subqueries)
// ---------------------------------------------------------------------------

export interface RelationDef {
  type: 'hasMany' | 'hasOne' | 'belongsTo';
  from: string;       // source table
  to: string;         // target table
  foreignKey: string;  // column on the "many" side (snake_case)
  referenceKey: string; // column on the "one" side (snake_case)
}

export const RELATIONS: Record<string, Record<string, RelationDef>> = {
  organizations: {
    users: {
      type: 'hasMany',
      from: 'organizations',
      to: 'users',
      foreignKey: 'org_id',
      referenceKey: 'id',
    },
  },
  users: {
    organization: {
      type: 'belongsTo',
      from: 'users',
      to: 'organizations',
      foreignKey: 'org_id',
      referenceKey: 'id',
    },
    posts: {
      type: 'hasMany',
      from: 'users',
      to: 'posts',
      foreignKey: 'user_id',
      referenceKey: 'id',
    },
  },
  posts: {
    user: {
      type: 'belongsTo',
      from: 'posts',
      to: 'users',
      foreignKey: 'user_id',
      referenceKey: 'id',
    },
    comments: {
      type: 'hasMany',
      from: 'posts',
      to: 'comments',
      foreignKey: 'post_id',
      referenceKey: 'id',
    },
  },
  comments: {
    post: {
      type: 'belongsTo',
      from: 'comments',
      to: 'posts',
      foreignKey: 'post_id',
      referenceKey: 'id',
    },
    user: {
      type: 'belongsTo',
      from: 'comments',
      to: 'users',
      foreignKey: 'user_id',
      referenceKey: 'id',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Timestamp columns that need Date parsing
// ---------------------------------------------------------------------------

export const DATE_COLUMNS: Record<string, Set<string>> = {
  organizations: new Set(['created_at']),
  users: new Set(['last_login_at', 'created_at']),
  posts: new Set(['created_at', 'updated_at']),
  comments: new Set(['created_at']),
};
