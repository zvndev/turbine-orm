# Turbine SDK — Developer Experience Showcase

**Turbine ORM: the fastest end-to-end path from a serverless function to nested relational data and back.**

Turbine is a TypeScript ORM that gives you Prisma's developer experience with the performance characteristics of hand-tuned SQL. One `npm install`, one `generate` command, and you're writing fully type-safe queries that compile to optimal Postgres — including nested relations in a single query, pipelined batches in a single round-trip, and batch inserts that don't generate 100 INSERT statements.

> **Status transparency:** This document describes the target developer experience for the TypeScript SDK. Features marked with **[Proven]** are backed by established Postgres techniques and working Rust implementations. Features marked with **[In Validation]** are being benchmarked in the POC phase. See the "What's Proven vs Aspirational" section at the end for the full breakdown.

---

## Setup (30 seconds)

```bash
npm install turbine-orm
```

```bash
# Point at your Postgres database and generate types
npx turbine generate

# Output:
# ✓ Connected to Postgres
# ✓ Introspected 4 tables, 27 columns, 6 indexes
# ✓ Generated types → node_modules/.turbine/generated.ts
# ✓ Ready. Import from 'turbine-orm' and start querying.
```

That's it. No `prisma migrate`, no schema file to maintain, no binary to download. Turbine reads your live database schema and generates TypeScript types directly. When your schema changes, run `generate` again.

---

## Configuration

```typescript
// lib/db.ts
import { createTurbineClient } from 'turbine-orm';

export const db = createTurbineClient({
  connectionString: process.env.DATABASE_URL,
});
```

The client is lightweight — no Rust binary, no WASM blob, no query engine process. It connects to your Postgres database directly, with built-in connection pooling and prepared statement caching.

For development, you can point it at any Postgres instance:

```typescript
// Works with local Postgres too — Turbine generates standard SQL
export const db = createTurbineClient({
  connectionString: 'postgres://localhost:5432/myapp',
});
```

---

## 1. Simple Queries — Prisma-like API, SQL-grade Performance

Every query is fully typed. Your IDE autocompletes table names, column names, where clauses, and return types — all inferred from your actual database schema.

### Find one record

```typescript
const user = await db.users.findUnique({
  where: { id: 123 },
});
// typeof user: User | null
// → SELECT id, email, name, role, avatar_url, last_login_at, created_at
//   FROM users WHERE id = $1
```

### Find many with filters and ordering

```typescript
const recentMembers = await db.users.findMany({
  where: { orgId: 42, role: 'member' },
  orderBy: { createdAt: 'desc' },
  limit: 20,
});
// typeof recentMembers: User[]
// → SELECT id, email, name, role, avatar_url, last_login_at, created_at
//   FROM users WHERE org_id = $1 AND role = $2
//   ORDER BY created_at DESC LIMIT 20
```

### Create a record

```typescript
const post = await db.posts.create({
  data: {
    userId: 123,
    orgId: 42,
    title: 'Introducing Turbine',
    content: 'The fastest path from serverless to Postgres.',
    published: true,
  },
});
// typeof post: Post (includes generated id, timestamps)
// → INSERT INTO posts (user_id, org_id, title, content, published)
//   VALUES ($1, $2, $3, $4, $5)
//   RETURNING id, user_id, org_id, title, content, published,
//             view_count, created_at, updated_at
```

### Update a record

```typescript
const updated = await db.posts.update({
  where: { id: 456 },
  data: {
    title: 'Introducing Turbine (Updated)',
    content: 'Now with benchmarks.',
  },
});
// typeof updated: Post
// → UPDATE posts SET title = $1, content = $2, updated_at = NOW()
//   WHERE id = $3
//   RETURNING id, user_id, org_id, title, content, published,
//             view_count, created_at, updated_at
```

### Delete a record

```typescript
const deleted = await db.comments.delete({
  where: { id: 789 },
});
// typeof deleted: Comment
// → DELETE FROM comments WHERE id = $1 RETURNING *
```

### Aggregations

```typescript
const stats = await db.users.groupBy({
  by: ['orgId', 'role'],
  _count: true,
  where: { orgId: 42 },
});
// typeof stats: { orgId: number; role: string; _count: number }[]
// → SELECT org_id, role, COUNT(*) AS _count
//   FROM users GROUP BY org_id, role HAVING org_id = $1
```

### Count

```typescript
const total = await db.posts.count({
  where: { orgId: 42, published: true },
});
// typeof total: number
// → SELECT COUNT(*) FROM posts WHERE org_id = $1 AND published = true
```

---

## 2. Nested Queries — The Main Event

This is where Turbine fundamentally diverges from every other TypeScript ORM.

When you ask Prisma for a user with their posts, it sends **multiple queries** — one for the user, one for the posts. When you add comments, that's another query. This is the N+1 problem dressed up in a nice API.

When you ask Drizzle for nested data, it uses `LATERAL JOIN` — better than N+1, but still multiple result sets that need client-side stitching.

**Turbine pushes the entire nesting into Postgres's JSON engine.** One query goes out. One JSON blob comes back. One parse. Done.

### Level 2: Users with Posts

```typescript
const userWithPosts = await db.users.findUnique({
  where: { id: 123 },
  with: {
    posts: {
      orderBy: { createdAt: 'desc' },
      where: { published: true },
    },
  },
});
```

**What you get back (fully typed):**

```typescript
// typeof userWithPosts:
// {
//   id: number;
//   email: string;
//   name: string;
//   role: string;
//   avatarUrl: string | null;
//   lastLoginAt: Date | null;
//   createdAt: Date;
//   posts: {
//     id: number;
//     title: string;
//     content: string;
//     published: boolean;
//     viewCount: number;
//     createdAt: Date;
//     updatedAt: Date;
//   }[];
// } | null
```

**What SQL Turbine generates:**

```sql
SELECT json_build_object(
  'id', u.id,
  'email', u.email,
  'name', u.name,
  'role', u.role,
  'avatarUrl', u.avatar_url,
  'lastLoginAt', u.last_login_at,
  'createdAt', u.created_at,
  'posts', COALESCE((
    SELECT json_agg(json_build_object(
      'id', p.id,
      'title', p.title,
      'content', p.content,
      'published', p.published,
      'viewCount', p.view_count,
      'createdAt', p.created_at,
      'updatedAt', p.updated_at
    ) ORDER BY p.created_at DESC)
    FROM posts p
    WHERE p.user_id = u.id AND p.published = true
  ), '[]'::json)
) AS data
FROM users u WHERE u.id = $1
```

One query. One result row. One JSON parse. The database does the join and the aggregation in a single plan.

### Level 3: Users with Posts with Comments

```typescript
const userWithEverything = await db.users.findUnique({
  where: { id: 123 },
  with: {
    posts: {
      orderBy: { createdAt: 'desc' },
      with: {
        comments: {
          orderBy: { createdAt: 'desc' },
        },
      },
    },
  },
});
```

**Generated SQL — still one query:**

```sql
SELECT json_build_object(
  'id', u.id, 'email', u.email, 'name', u.name,
  'posts', COALESCE((
    SELECT json_agg(json_build_object(
      'id', p.id,
      'title', p.title,
      'content', p.content,
      'comments', COALESCE((
        SELECT json_agg(json_build_object(
          'id', c.id,
          'body', c.body,
          'userId', c.user_id,
          'createdAt', c.created_at
        ) ORDER BY c.created_at DESC)
        FROM comments c WHERE c.post_id = p.id
      ), '[]'::json)
    ) ORDER BY p.created_at DESC)
    FROM posts p WHERE p.user_id = u.id
  ), '[]'::json)
) AS data
FROM users u WHERE u.id = $1
```

Prisma would send 3 separate queries for this. Drizzle would use nested LATERAL JOINs but still stitch results client-side. Turbine sends one query and Postgres hands back a complete JSON tree.

### Level 4: The Full Hierarchy — Organizations with Users with Posts with Comments

```typescript
const orgDashboard = await db.organizations.findUnique({
  where: { id: 1 },
  with: {
    users: {
      with: {
        posts: {
          where: { published: true },
          orderBy: { createdAt: 'desc' },
          limit: 10,
          with: {
            comments: {
              orderBy: { createdAt: 'desc' },
              limit: 5,
            },
          },
        },
      },
    },
  },
});
```

**Generated SQL:**

```sql
SELECT json_build_object(
  'id', o.id,
  'name', o.name,
  'slug', o.slug,
  'plan', o.plan,
  'users', COALESCE((
    SELECT json_agg(json_build_object(
      'id', u.id,
      'email', u.email,
      'name', u.name,
      'posts', COALESCE((
        SELECT json_agg(json_build_object(
          'id', p.id,
          'title', p.title,
          'comments', COALESCE((
            SELECT json_agg(
              json_build_object('id', c.id, 'body', c.body, 'createdAt', c.created_at)
              ORDER BY c.created_at DESC
            )
            FROM comments c WHERE c.post_id = p.id
            LIMIT 5
          ), '[]'::json)
        ) ORDER BY p.created_at DESC)
        FROM posts p
        WHERE p.user_id = u.id AND p.published = true
        LIMIT 10
      ), '[]'::json)
    ))
    FROM users u WHERE u.org_id = o.id
  ), '[]'::json)
) AS data
FROM organizations o WHERE o.id = $1
```

Four levels of nesting. One query. One round-trip. One parse.

### Nested findMany — Multiple Root Records

It works for lists too, not just single lookups:

```typescript
const usersWithPosts = await db.users.findMany({
  where: { orgId: 42 },
  limit: 20,
  with: {
    posts: {
      where: { published: true },
      orderBy: { createdAt: 'desc' },
      limit: 5,
    },
  },
});
// typeof usersWithPosts: (User & { posts: Post[] })[]
```

```sql
SELECT json_build_object(
  'id', u.id, 'email', u.email, 'name', u.name,
  'posts', COALESCE((
    SELECT json_agg(json_build_object(
      'id', p.id, 'title', p.title, 'published', p.published
    ) ORDER BY p.created_at DESC)
    FROM posts p
    WHERE p.user_id = u.id AND p.published = true
    LIMIT 5
  ), '[]'::json)
) AS data
FROM users u WHERE u.org_id = $1
LIMIT 20
```

### Why This Is Faster

| ORM | What happens when you request User + Posts + Comments |
|-----|------------------------------------------------------|
| **Prisma** | Sends 3 separate SQL queries. Waits for each. Stitches results in JS. If you're loading 20 users, that can become 1 + 20 + N queries (classic N+1). |
| **Drizzle** | Uses LATERAL JOINs — better than Prisma, one query per nesting level. But returns a flat result set that must be de-duplicated and re-structured client-side. |
| **Turbine** | One query with `json_build_object` + `json_agg`. Postgres builds the entire nested JSON tree server-side. Client receives one JSON blob and parses it once. No stitching, no de-duplication, no extra round-trips. **[In Validation]** |

The performance advantage scales with depth. At 2 levels, Turbine saves 1 round-trip. At 4 levels with multiple root records, it can save dozens of queries and all of their associated network latency.

---

## 3. Pipeline API — Multiple Queries, One Round-Trip

Real pages don't make one query. A dashboard might need the current user, their org stats, recent activity, notification count, and feature flags. That's 5 independent queries.

Without pipelining, those 5 queries execute sequentially:

```
Query 1: 2ms network + 1ms execute = 3ms
Query 2: 2ms network + 1ms execute = 3ms
Query 3: 2ms network + 1ms execute = 3ms
Query 4: 2ms network + 1ms execute = 3ms
Query 5: 2ms network + 1ms execute = 3ms
Total: 15ms
```

With Turbine's pipeline, all 5 go out in one batch and come back together:

```
All 5 queries: 2ms network + 5ms execute (parallel in Postgres) = 7ms
Total: 7ms
```

That's a 2x improvement on same-AZ queries. On cross-region connections (~30ms RTT), it's the difference between 150ms and 35ms — **a 4x improvement**. **[Proven technique — Postgres wire protocol natively supports pipelining]**

### The API

```typescript
const [user, postCount, recentPosts, notifications, orgStats] = await db.pipeline(
  db.users.findUnique({ where: { id: userId } }),
  db.posts.count({ where: { userId } }),
  db.posts.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    limit: 5,
    with: { comments: { limit: 3 } },
  }),
  db.notifications.findMany({
    where: { userId, read: false },
    limit: 10,
  }),
  db.users.count({ where: { orgId } }),
);

// Every element is fully typed:
// user:          User | null
// postCount:     number
// recentPosts:   (Post & { comments: Comment[] })[]
// notifications: Notification[]
// orgStats:      number
```

Each argument to `pipeline()` is a deferred query — it doesn't execute until the pipeline flushes them all at once. Under the hood, Turbine sends all 5 queries over the wire before reading any responses, then reads all 5 responses in order. This is standard Postgres wire protocol pipelining, not a Turbine invention — but no other TypeScript ORM exposes it.

### Pipeline with Nested Queries

Pipelines compose with nested queries. You can pipeline 3 nested queries and get `3 * (1 query with full nesting)` instead of `3 * (N queries per nesting level)`:

```typescript
const [myProfile, teamActivity, orgOverview] = await db.pipeline(
  // Nested: me + my posts + comments on my posts
  db.users.findUnique({
    where: { id: myId },
    with: { posts: { with: { comments: true }, limit: 10 } },
  }),
  // Nested: team members + their recent posts
  db.users.findMany({
    where: { orgId, role: 'member' },
    limit: 20,
    with: { posts: { limit: 3 } },
  }),
  // Nested: org + all users + post counts
  db.organizations.findUnique({
    where: { id: orgId },
    with: { users: true },
  }),
);
```

Three pipelined queries, each with nested relations. Total round-trips: **1**. Total SQL queries sent: **3** (each is a single json_agg query). Without Turbine, this would be 3+ round-trips and 9+ individual queries.

---

## 4. Batch Operations

### createMany with UNNEST — [Proven]

Most ORMs generate one INSERT statement per row, or a single INSERT with a massive VALUES list. Both are inefficient at scale.

Turbine uses Postgres's `UNNEST` to insert any number of rows in a single parameterized query with exactly 3 parameters (one per column array), regardless of row count:

```typescript
const newComments = await db.comments.createMany({
  data: comments.map(c => ({
    postId: c.postId,
    userId: c.userId,
    body: c.body,
  })),
});
// typeof newComments: Comment[] (all 100 rows with generated ids)
```

**Generated SQL (whether you insert 1 row or 10,000):**

```sql
INSERT INTO comments (post_id, user_id, body)
SELECT * FROM UNNEST($1::bigint[], $2::bigint[], $3::text[])
RETURNING id, post_id, user_id, body, created_at
```

Three parameters. One prepared statement. Works for 1 row or 100,000 rows.

Compare this to what other ORMs do:

| ORM | 100-row insert strategy | Parameters |
|-----|------------------------|------------|
| **Prisma** | Single INSERT with 100-row VALUES list | 300 parameters ($1-$300) |
| **Drizzle** | Single INSERT with 100-row VALUES list | 300 parameters ($1-$300) |
| **Turbine** | UNNEST with 3 array parameters | 3 parameters ($1-$3) |

The UNNEST approach has two advantages: it reuses the same prepared statement regardless of batch size (Postgres doesn't need to re-plan), and it sends far less data over the wire.

### updateMany

```typescript
await db.posts.updateMany({
  where: { orgId: 42, published: false },
  data: { published: true },
});
// → UPDATE posts SET published = $1 WHERE org_id = $2 AND published = $3
```

### deleteMany

```typescript
await db.comments.deleteMany({
  where: { postId: { in: [1, 2, 3] } },
});
// → DELETE FROM comments WHERE post_id IN ($1, $2, $3)
```

---

## 5. Raw SQL Escape Hatch

Sometimes you need SQL that no query builder can express. Turbine provides a tagged template literal that gives you parameterized queries with full type safety:

```typescript
import { sql } from 'turbine-orm';

// The sql tag automatically parameterizes interpolated values
const results = await db.query<{
  day: Date;
  postCount: number;
  commentCount: number;
}>(sql`
  SELECT
    DATE_TRUNC('day', p.created_at) AS day,
    COUNT(DISTINCT p.id) AS post_count,
    COUNT(DISTINCT c.id) AS comment_count
  FROM posts p
  LEFT JOIN comments c ON c.post_id = p.id
  WHERE p.org_id = ${orgId}
    AND p.created_at > NOW() - INTERVAL '30 days'
  GROUP BY day
  ORDER BY day
`);
// typeof results: { day: Date; postCount: number; commentCount: number }[]
```

**What gets sent to Postgres:**

```sql
SELECT
  DATE_TRUNC('day', p.created_at) AS day,
  COUNT(DISTINCT p.id) AS post_count,
  COUNT(DISTINCT c.id) AS comment_count
FROM posts p
LEFT JOIN comments c ON c.post_id = p.id
WHERE p.org_id = $1
  AND p.created_at > NOW() - INTERVAL '30 days'
GROUP BY day
ORDER BY day
-- params: [orgId]
```

Interpolated values become parameterized `$N` placeholders — no SQL injection, ever. The generic type parameter gives you typed results.

### Raw SQL in Pipelines

Raw queries work inside pipelines too:

```typescript
const [leaderboard, dailyStats] = await db.pipeline(
  db.query<{ name: string; postCount: number }>(sql`
    SELECT u.name, COUNT(p.id) AS post_count
    FROM users u
    LEFT JOIN posts p ON p.user_id = u.id
    WHERE u.org_id = ${orgId}
    GROUP BY u.id, u.name
    ORDER BY post_count DESC
    LIMIT 10
  `),
  db.query<{ day: Date; count: number }>(sql`
    SELECT DATE_TRUNC('day', created_at) AS day, COUNT(*) AS count
    FROM posts
    WHERE org_id = ${orgId}
      AND created_at > NOW() - INTERVAL '30 days'
    GROUP BY day ORDER BY day
  `),
);
```

---

## 6. In a Next.js Server Component

Here's what a real page looks like. No hooks, no loading states on the data layer, no client-side fetching. Just `async/await` in a Server Component.

```typescript
// app/dashboard/page.tsx
import { db } from '@/lib/db';
import { auth } from '@/lib/auth';

export default async function Dashboard() {
  const session = await auth();
  if (!session) redirect('/login');

  // One round-trip. Five queries. All typed.
  const [user, postCount, recentPosts, teamMembers, orgStats] = await db.pipeline(
    db.users.findUnique({
      where: { id: session.userId },
    }),
    db.posts.count({
      where: { userId: session.userId },
    }),
    db.posts.findMany({
      where: { userId: session.userId },
      orderBy: { createdAt: 'desc' },
      limit: 5,
      with: {
        comments: {
          orderBy: { createdAt: 'desc' },
          limit: 3,
        },
      },
    }),
    db.users.findMany({
      where: { orgId: session.orgId },
      limit: 10,
    }),
    db.users.count({
      where: { orgId: session.orgId },
    }),
  );

  return (
    <div>
      <h1>Welcome back, {user?.name}</h1>
      <p>{postCount} posts published</p>
      <p>{orgStats} team members</p>

      <section>
        <h2>Recent Posts</h2>
        {recentPosts.map(post => (
          <article key={post.id}>
            <h3>{post.title}</h3>
            <p>{post.comments.length} comments</p>
            {post.comments.map(comment => (
              <p key={comment.id}>{comment.body}</p>
            ))}
          </article>
        ))}
      </section>

      <section>
        <h2>Team</h2>
        {teamMembers.map(member => (
          <div key={member.id}>{member.name} — {member.role}</div>
        ))}
      </section>
    </div>
  );
}
```

**What happened on the server:**
1. `db.pipeline()` collected 5 query definitions
2. Turbine generated 5 SQL strings (the posts query includes nested json_agg for comments)
3. All 5 were flushed to the database connection in a single write
4. All 5 responses were read back in a single pass
5. Results were parsed and typed
6. Total database time: **~7ms** (one round-trip + parallel query execution)

Compare with Prisma doing the same page: 5 sequential queries, each paying a round-trip. Plus the posts query triggers N+1 for comments unless you remember to `include` them. Total: **~25ms** at same-AZ latency, more if you forget an include.

### In a Server Action

```typescript
// app/actions.ts
'use server';

import { db } from '@/lib/db';
import { auth } from '@/lib/auth';
import { revalidatePath } from 'next/cache';

export async function createPost(formData: FormData) {
  const session = await auth();
  if (!session) throw new Error('Unauthorized');

  const post = await db.posts.create({
    data: {
      userId: session.userId,
      orgId: session.orgId,
      title: formData.get('title') as string,
      content: formData.get('content') as string,
      published: false,
    },
  });

  revalidatePath('/dashboard');
  return post;
}
```

### In a Route Handler

```typescript
// app/api/posts/route.ts
import { db, sql } from '@/lib/db';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orgId = Number(searchParams.get('orgId'));

  const [posts, total] = await db.pipeline(
    db.posts.findMany({
      where: { orgId, published: true },
      orderBy: { createdAt: 'desc' },
      limit: 20,
      with: { comments: { limit: 5 } },
    }),
    db.posts.count({ where: { orgId, published: true } }),
  );

  return Response.json({ posts, total });
}
```

---

## 7. Comparison Table

| Feature | Turbine | Prisma | Drizzle |
|---------|---------|--------|---------|
| **Nested query approach** | `json_build_object` + `json_agg` — one query, one JSON blob **[In Validation]** | Multiple queries (N+1 pattern), stitched client-side | LATERAL JOINs, de-duplicated client-side |
| **Pipeline support** | Native — `db.pipeline()` sends N queries in one round-trip **[Proven]** | None — queries are sequential | None — queries are sequential |
| **Batch insert** | `UNNEST` arrays — 3 params for any row count **[Proven]** | VALUES list — params grow linearly | VALUES list — params grow linearly |
| **Cold start** | Near-zero — no binary engine, no WASM, no runtime code generation | Heavy — downloads + starts Rust query engine binary (~15MB) | Light — pure JS, but no connection pre-warming |
| **Type safety** | Full inference from DB schema — types generated at build time | Full inference from Prisma schema file | Full inference from Drizzle schema file |
| **Schema source** | Your database IS the schema — `npx turbine generate` reads it | `.prisma` schema file — must be kept in sync | TypeScript schema definition — must be kept in sync |
| **Generated SQL quality** | Optimal — json_agg nesting, UNNEST batches, prepared statements | Acceptable — multiple queries, no pipelining | Good — LATERAL JOINs, but no pipelining |
| **Connection pooling** | Built-in via Turbine proxy — pre-warmed connections **[In Validation]** | Requires external pooler (PgBouncer, Prisma Accelerate) | Requires external pooler |
| **Raw SQL** | Tagged template literal with type params | `$queryRaw` with Prisma types | `sql` template with Drizzle types |
| **Bundle size** | Minimal — thin client, no engine binary | ~15MB+ engine binary | ~50KB (pure JS) |

### Performance Characteristics (Estimated)

For a dashboard page making 5 queries, one with 2-level nesting (same-AZ, ~1ms RTT):

| Metric | Turbine | Prisma | Drizzle |
|--------|---------|--------|---------|
| Round-trips | 1 | 5-7 | 5 |
| Total queries sent | 5 | 7+ (N+1 on nested) | 6 (extra for nesting) |
| Estimated latency | ~7ms | ~25ms | ~18ms |
| Cold start overhead | <50ms | ~300-500ms (engine boot) | <50ms |

> **Honesty note:** These latency estimates are projections based on the architecture. Real benchmarks are in progress as part of the POC validation. We will publish all results — including cases where Turbine does NOT win. See `TURBINE_POC_BENCHMARKS.md` for the full test plan.

---

## 8. What Happens Under the Hood

```
┌──────────────────────────────────────────────────────────┐
│  YOUR NEXT.JS APP                                        │
│                                                          │
│  db.users.findUnique({                                   │
│    where: { id: 123 },                                   │
│    with: { posts: { with: { comments: true } } }         │
│  })                                                      │
│                                                          │
│  ↓ Turbine TS Client generates SQL                       │
├──────────────────────────────────────────────────────────┤
│  GENERATED SQL                                           │
│                                                          │
│  SELECT json_build_object(                               │
│    'id', u.id, 'email', u.email,                         │
│    'posts', (SELECT json_agg(...) FROM posts p ...)      │
│  ) AS data FROM users u WHERE u.id = $1                  │
│                                                          │
│  ↓ Sent via Postgres wire protocol (pipelined)           │
├──────────────────────────────────────────────────────────┤
│  TURBINE PROXY (Rust)                                    │
│                                                          │
│  • Pre-warmed connection pool (no cold connect)          │
│  • Prepared statement cache (no re-parse overhead)       │
│  • TLS session resumption (fast reconnects)              │
│  • Standard Postgres wire protocol (works with any tool) │
│                                                          │
│  ↓ Routes to optimal connection                          │
├──────────────────────────────────────────────────────────┤
│  POSTGRES                                                │
│                                                          │
│  • Executes json_agg query in a single plan              │
│  • Uses indexes on foreign keys                          │
│  • Returns one JSON blob                                 │
│  • No multiple round-trips, no N+1                       │
└──────────────────────────────────────────────────────────┘
```

### The key insight

Your TypeScript code calls `db.users.findUnique()`. Turbine generates optimal SQL:

- **`json_build_object` + `json_agg`** for nested relations — Postgres builds the entire object tree server-side. No client-side stitching, no N+1, no wasted bandwidth from duplicate parent rows in JOIN results.

- **`UNNEST`** for batch inserts — one prepared statement handles any batch size. Postgres receives typed arrays and expands them internally.

- **Pipelined futures** for parallel independent queries — the wire protocol sends all queries before reading any responses. Network latency is paid once, not once per query.

- **The Rust proxy** pre-warms connections and caches prepared statements so your serverless function doesn't pay connection setup costs on every invocation.

The result: you write Prisma-like TypeScript and get performance that approaches hand-tuned SQL over a connection-pooled, pipelining-aware transport.

---

## 9. What's Proven vs Aspirational

We believe in earning claims with benchmarks, not marketing slides. Here's where everything stands:

### Definitively proven (established techniques, working code)

- **`json_build_object` + `json_agg` for nested queries** — Standard Postgres SQL, stable for years. The generated SQL is valid and correct. The Rust query builder already produces it.
- **UNNEST for batch inserts** — Standard Postgres technique. Implemented and tested.
- **Query pipelining** — Native Postgres wire protocol feature. tokio-postgres (which powers the Rust side) supports it out of the box. Gains are proportional to network RTT.
- **Zero-overhead entity mapping** — Rust derive macros generate direct `row.get(index)` calls. No runtime reflection. This is the same technique used by Diesel and serde.
- **Prisma-like TypeScript API** — API design is proven by Prisma and Drizzle. We're not inventing a new query language.

### In validation (plausible, being benchmarked in POC)

- **json_agg faster than LATERAL JOINs** — Probably true for typical web app shapes (2-3 levels, <1000 child rows). Being benchmarked head-to-head. If LATERAL wins, we switch the default — the API stays the same.
- **<5% overhead vs raw tokio-postgres** — Estimated based on the abstraction layer design. Could be 2% or 12%. POC Test 1 will measure this precisely.
- **Pipeline API saving meaningful latency at same-AZ** — Mathematically sound (fewer round-trips = less latency), but real-world gains depend on query execution time vs network time. Being measured.
- **Proxy adding <0.5ms latency** — Based on PgBouncer benchmarks as a reference point. Building and measuring in POC Test 4.
- **TypeScript WebSocket transport competitive with Drizzle** — JSON serialization overhead is real. If WebSocket is too slow, we fall back to NAPI-RS native bindings.

### Aspirational (stacked assumptions, might not fully work)

- **Sub-10ms cold start** — Only achievable for the Rust SDK path with warm compute + cached TLS session ticket. The TypeScript SDK will likely be ~50-70ms. We'll be precise about which path achieves what.
- **Proxy prepared statement pre-warming** — Might not save meaningful time vs transparent re-preparation. Needs benchmarking before claiming.
- **"Fastest end-to-end path"** — The tagline is an aspiration until benchmark results prove it. If we can't back it up, we'll change it.

---

## Get Started

```bash
# Install
npm install turbine-orm

# Generate types from your database
npx turbine generate

# Start building
```

```typescript
import { createTurbineClient } from 'turbine-orm';

const db = createTurbineClient({
  connectionString: process.env.DATABASE_URL,
});

// Your first query — fully typed, optimally executed
const user = await db.users.findUnique({
  where: { id: 1 },
  with: {
    posts: {
      where: { published: true },
      with: { comments: true },
    },
  },
});
```

One install. One generate. One query for nested data. One round-trip for multiple queries. That's Turbine.
