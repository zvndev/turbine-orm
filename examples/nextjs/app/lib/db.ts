import { TurbineClient, introspect } from 'turbine-orm';
import type { SchemaMetadata } from 'turbine-orm';

let cached: { db: TurbineClient; schema: SchemaMetadata } | null = null;

export async function getDb() {
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env.local and configure it.');
  }

  const schema = await introspect({ connectionString });
  const db = new TurbineClient({ connectionString, poolSize: 5 }, schema);
  await db.connect();

  cached = { db, schema };
  return cached;
}

// Types matching the demo schema
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
