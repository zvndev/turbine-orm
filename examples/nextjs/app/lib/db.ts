/**
 * Turbine client wired up for the Next.js app router.
 *
 * This example uses Turbine's generated typed accessor pattern. After running
 * `npx turbine generate`, the generator emits three files at
 * `generated/turbine/`:
 *
 *   - generated/turbine/index.ts     — typed `TurbineClient` subclass + `turbine()` factory
 *   - generated/turbine/types.ts     — entity interfaces (User, Post, Comment, ...)
 *   - generated/turbine/metadata.ts  — runtime SchemaMetadata
 *
 * Once generated you can import the typed factory and call `db.users.findMany(...)`
 * directly with full autocomplete and per-table types — no `db.table<T>('...')`
 * lookups required.
 *
 * For this example we re-export the same shapes by hand so the code compiles
 * even before `turbine generate` is run. After you point `DATABASE_URL` at a
 * live database and run the codegen, replace the imports below with:
 *
 *   import { turbine } from '../../generated/turbine';
 *   import type { User, Post, Comment, Organization } from '../../generated/turbine/types';
 */

import { TurbineClient, introspect } from 'turbine-orm';
import type { QueryInterface, SchemaMetadata } from 'turbine-orm';

// ----------------------------------------------------------------------------
// Entity types (would normally come from `generated/turbine/types.ts`)
// ----------------------------------------------------------------------------

export interface Organization {
  id: number;
  name: string;
  slug: string;
  plan: string;
  createdAt: Date;
}

export interface User {
  id: number;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  orgId: number;
  createdAt: Date;
  organization?: Organization;
  posts?: Post[];
}

export interface Post {
  id: number;
  title: string;
  content: string;
  published: boolean;
  viewCount: number;
  userId: number;
  orgId: number;
  createdAt: Date;
  user?: User;
  comments?: Comment[];
}

export interface Comment {
  id: number;
  body: string;
  userId: number;
  postId: number;
  createdAt: Date;
  user?: User;
}

// ----------------------------------------------------------------------------
// Typed client surface (would normally come from `generated/turbine/index.ts`)
//
// The real generated file emits a `TurbineClient` subclass with `declare readonly`
// table accessors so `db.users.findMany(...)` is fully typed. Here we mirror
// that shape with a small typed wrapper.
// ----------------------------------------------------------------------------

export interface TypedDb extends TurbineClient {
  users: QueryInterface<User>;
  posts: QueryInterface<Post>;
  comments: QueryInterface<Comment>;
  organizations: QueryInterface<Organization>;
}

let cached: { db: TypedDb; schema: SchemaMetadata } | null = null;

export async function getDb() {
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and configure it.');
  }

  const schema = await introspect({ connectionString });
  const db = new TurbineClient({ connectionString, poolSize: 5 }, schema) as TypedDb;
  await db.connect();

  cached = { db, schema };
  return cached;
}
