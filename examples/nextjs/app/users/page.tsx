export const dynamic = 'force-dynamic';

import { getDb, type User } from '../lib/db';

async function getUsers() {
  const { db } = await getDb();

  const users = (await db.users.findMany({
    limit: 50,
    orderBy: { createdAt: 'desc' },
    with: {
      posts: { limit: 3, orderBy: { createdAt: 'desc' } },
    },
  })) as User[];

  return users;
}

export default async function UsersPage() {
  const users = await getUsers();

  return (
    <div className="min-h-screen">
      <section className="pt-24 pb-16 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-baseline justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
              <p className="mt-1 text-zinc-500">
                {users.length} users loaded with nested posts in a single query.
              </p>
            </div>
            <code className="text-xs font-mono text-zinc-400 bg-zinc-50 px-3 py-1.5 rounded-lg border border-zinc-100">
              db.users.findMany(&#123; with: &#123; posts &#125; &#125;)
            </code>
          </div>
        </div>
      </section>

      <section className="pb-32 px-6">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {users.map((user) => (
              <a
                key={user.id}
                href={`/users/${user.id}`}
                className="group rounded-xl border border-zinc-200 bg-white p-5 hover:border-zinc-300 hover:shadow-sm transition-all"
              >
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center text-sm font-medium text-zinc-600 group-hover:bg-zinc-200 transition-colors">
                    {user.name?.charAt(0)?.toUpperCase() ?? '?'}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">
                      {user.name}
                    </p>
                    <p className="text-xs text-zinc-400 truncate">{user.email}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="font-mono uppercase tracking-wider bg-zinc-50 px-2 py-0.5 rounded">
                    {user.role}
                  </span>
                  <span>{user.posts?.length ?? 0} posts</span>
                  <span className="ml-auto text-zinc-300 group-hover:text-zinc-400 transition-colors">
                    &rarr;
                  </span>
                </div>

                {user.posts && user.posts.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-zinc-100 space-y-2">
                    {user.posts.map((post) => (
                      <p
                        key={post.id}
                        className="text-xs text-zinc-500 truncate"
                      >
                        {post.title}
                      </p>
                    ))}
                  </div>
                )}
              </a>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
