export const dynamic = 'force-dynamic';

import { CodeBlock } from './components/code-block';
import { getDb, type User, type Post } from './lib/db';

async function getHomeData() {
  const { db } = await getDb();

  const users = (await db.table<User>('users').findMany({
    limit: 3,
    orderBy: { createdAt: 'desc' },
    with: {
      posts: {
        limit: 2,
        orderBy: { createdAt: 'desc' },
        with: { comments: { limit: 3 } },
      },
    },
  })) as User[];

  const postCount = await db.table<Post>('posts').count({});

  return { users, postCount };
}

export default async function Home() {
  let data: Awaited<ReturnType<typeof getHomeData>> | null = null;
  let error: string | null = null;

  try {
    data = await getHomeData();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Failed to connect to database';
  }

  return (
    <div className="min-h-screen">
      {/* Hero */}
      <section className="pt-32 pb-24 px-6">
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-zinc-100 text-zinc-600 text-xs font-medium mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            1 dependency &middot; 70KB &middot; PostgreSQL native
          </div>

          <h1 className="text-5xl sm:text-6xl font-semibold tracking-tight text-zinc-900 leading-[1.1]">
            Single query.
            <br />
            <span className="text-zinc-400">Full object graph.</span>
          </h1>

          <p className="mt-6 text-lg text-zinc-500 leading-relaxed max-w-xl mx-auto">
            Turbine resolves nested relations in one SQL statement using
            PostgreSQL <code className="text-zinc-700 bg-zinc-100 px-1.5 py-0.5 rounded text-sm font-mono">json_agg</code>.
            No N+1. No WASM. No magic.
          </p>

          <div className="mt-10 flex items-center justify-center gap-4">
            <code className="px-4 py-2.5 bg-zinc-950 text-zinc-300 rounded-lg text-sm font-mono">
              npm install turbine-orm
            </code>
            <a
              href="/users"
              className="px-4 py-2.5 bg-zinc-900 text-white rounded-lg text-sm font-medium hover:bg-zinc-800 transition-colors"
            >
              View demo
            </a>
          </div>
        </div>
      </section>

      {/* Feature cards */}
      <section className="pb-24 px-6">
        <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
          <FeatureCard
            title="One Query"
            description="Nested relations resolved via json_agg correlated subqueries. Users, posts, comments — one round-trip."
          />
          <FeatureCard
            title="Type Safe"
            description="Full TypeScript types generated from your database. Autocomplete for columns, relations, and filters."
          />
          <FeatureCard
            title="70KB"
            description="One runtime dependency (pg). No WASM engine, no query plan compiler, no code generation DSL."
          />
        </div>
      </section>

      {/* Code demo */}
      <section className="pb-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">
              See it in action
            </h2>
            <p className="mt-2 text-zinc-500">
              This page is server-rendered with Turbine. Here&apos;s the query that powers it.
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <CodeBlock
                title="app/page.tsx"
                code={`const users = await db.users.findMany({
  limit: 3,
  orderBy: { createdAt: 'desc' },
  with: {
    posts: {
      limit: 2,
      orderBy: { createdAt: 'desc' },
      with: { comments: { limit: 3 } },
    },
  },
});`}
              />
              <CodeBlock
                title="Generated SQL (single query)"
                language="sql"
                code={`SELECT "users".*,
  (SELECT COALESCE(json_agg(
    json_build_object(
      'id', t0."id",
      'title', t0."title",
      'comments', COALESCE((
        SELECT json_agg(json_build_object(
          'id', t1."id",
          'body', t1."body"
        )) FROM "comments" t1
        WHERE t1."post_id" = t0."id"
        LIMIT 3
      ), '[]'::json)
    )
  ), '[]'::json)
  FROM "posts" t0
  WHERE t0."user_id" = "users"."id"
  ORDER BY t0."created_at" DESC
  LIMIT 2
  ) AS "posts"
FROM "users"
ORDER BY "users"."created_at" DESC
LIMIT 3`}
              />
            </div>

            <div>
              {error ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
                  <p className="text-sm font-medium text-amber-900">Database not connected</p>
                  <p className="mt-2 text-sm text-amber-700">
                    Set <code className="font-mono bg-amber-100 px-1 rounded">DATABASE_URL</code> in{' '}
                    <code className="font-mono bg-amber-100 px-1 rounded">.env.local</code> to see live data.
                  </p>
                  <p className="mt-3 text-xs text-amber-600 font-mono break-all">{error}</p>
                </div>
              ) : data ? (
                <div className="space-y-4">
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-xs font-mono text-zinc-400 uppercase tracking-wider">
                      Live Result
                    </span>
                    <span className="text-xs text-zinc-400">
                      {data.postCount.toLocaleString()} total posts in DB
                    </span>
                  </div>
                  {data.users.map((user) => (
                    <UserCard key={user.id} user={user} />
                  ))}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* Streaming demo */}
      <section className="pb-24 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">
              Stream large result sets
            </h2>
            <p className="mt-2 text-zinc-500">
              PostgreSQL cursors under the hood. Constant memory, any number of rows.
            </p>
          </div>

          <div className="max-w-2xl mx-auto">
            <CodeBlock
              title="streaming.ts"
              code={`for await (const user of db.users.findManyStream({
  where: { role: 'admin' },
  batchSize: 500,
  with: { posts: true },
})) {
  // Each row yielded individually
  // Cursor fetches in batches of 500 internally
  await processUser(user);
}`}
            />
          </div>
        </div>
      </section>

      {/* More features */}
      <section className="pb-32 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">
              Everything you need
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <CodeBlock
              title="Transactions"
              code={`await db.$transaction(async (tx) => {
  const user = await tx.users.create({
    data: { email: 'a@b.com', name: 'A' },
  });
  await tx.posts.create({
    data: { userId: user.id, title: 'First' },
  });
});`}
            />
            <CodeBlock
              title="Pipeline (batch round-trip)"
              code={`const [user, count, recent] = await db.pipeline(
  db.users.buildFindUnique({ where: { id: 1 } }),
  db.posts.buildCount({ where: { orgId: 1 } }),
  db.posts.buildFindMany({ limit: 5 }),
);
// 3 queries, 1 database round-trip`}
            />
            <CodeBlock
              title="Auto-diff migrations"
              code={`// Define schema in TypeScript
export default defineSchema({
  users: {
    id: { type: 'serial', primaryKey: true },
    email: { type: 'text', unique: true },
    name: { type: 'text', notNull: true },
  },
});

// npx turbine migrate create add_users --auto
// -> Generates UP + DOWN SQL automatically`}
            />
            <CodeBlock
              title="Raw SQL"
              code={`const stats = await db.raw<{
  day: Date;
  count: number;
}>\`
  SELECT DATE_TRUNC('day', created_at) AS day,
         COUNT(*)::int AS count
  FROM posts WHERE org_id = \${orgId}
  GROUP BY day ORDER BY day
\`;`}
            />
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-zinc-100 py-8 px-6">
        <div className="max-w-5xl mx-auto flex items-center justify-between text-sm text-zinc-400">
          <span>Turbine ORM</span>
          <span>MIT License</span>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-zinc-100 bg-zinc-50/50 p-6">
      <h3 className="font-medium text-zinc-900">{title}</h3>
      <p className="mt-2 text-sm text-zinc-500 leading-relaxed">{description}</p>
    </div>
  );
}

function UserCard({ user }: { user: User }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 space-y-3">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center text-xs font-medium text-zinc-600">
          {user.name?.charAt(0)?.toUpperCase() ?? '?'}
        </div>
        <div>
          <p className="text-sm font-medium text-zinc-900">{user.name}</p>
          <p className="text-xs text-zinc-400">{user.email}</p>
        </div>
        <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-zinc-400 bg-zinc-50 px-2 py-0.5 rounded">
          {user.role}
        </span>
      </div>

      {user.posts && user.posts.length > 0 && (
        <div className="space-y-2 pl-11">
          {user.posts.map((post: Post) => (
            <div key={post.id} className="border-l-2 border-zinc-100 pl-3">
              <p className="text-sm text-zinc-700 font-medium">{post.title}</p>
              {post.comments && post.comments.length > 0 && (
                <p className="text-xs text-zinc-400 mt-0.5">
                  {post.comments.length} comment{post.comments.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

