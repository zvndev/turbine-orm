export const dynamic = 'force-dynamic';

import { CodeBlock } from '../../components/code-block';
import { getDb, type User, type Post, type Comment } from '../../lib/db';

async function getUser(id: number) {
  const { db } = await getDb();

  const user = (await db.table<User>('users').findUnique({
    where: { id },
    with: {
      organization: true,
      posts: {
        orderBy: { createdAt: 'desc' },
        limit: 20,
        with: {
          comments: {
            limit: 10,
            orderBy: { createdAt: 'desc' },
          },
        },
      },
    },
  })) as User | null;

  return user;
}

export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getUser(Number(id));

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">User not found</h1>
          <a href="/users" className="mt-4 inline-block text-sm text-zinc-500 hover:text-zinc-900">
            &larr; Back to users
          </a>
        </div>
      </div>
    );
  }

  const totalComments =
    user.posts?.reduce((sum, post) => sum + (post.comments?.length ?? 0), 0) ?? 0;

  return (
    <div className="min-h-screen">
      {/* Header */}
      <section className="pt-24 pb-12 px-6 border-b border-zinc-100">
        <div className="max-w-4xl mx-auto">
          <a
            href="/users"
            className="inline-flex items-center text-sm text-zinc-400 hover:text-zinc-700 transition-colors mb-8"
          >
            &larr; <span className="ml-1">Users</span>
          </a>

          <div className="flex items-start gap-5">
            <div className="w-14 h-14 rounded-full bg-zinc-100 flex items-center justify-center text-lg font-medium text-zinc-600 shrink-0">
              {user.name?.charAt(0)?.toUpperCase() ?? '?'}
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-semibold tracking-tight">{user.name}</h1>
              <p className="text-zinc-500 mt-0.5">{user.email}</p>
              <div className="flex items-center gap-4 mt-3 text-xs text-zinc-400">
                <span className="font-mono uppercase tracking-wider bg-zinc-50 px-2 py-0.5 rounded border border-zinc-100">
                  {user.role}
                </span>
                {user.organization && (
                  <span>{(user.organization as { name: string }).name}</span>
                )}
                <span>{user.posts?.length ?? 0} posts</span>
                <span>{totalComments} comments</span>
                <span>
                  Joined{' '}
                  {user.createdAt
                    ? new Date(user.createdAt).toLocaleDateString('en-US', {
                        month: 'short',
                        year: 'numeric',
                      })
                    : 'unknown'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Query that produced this */}
      <section className="py-8 px-6 bg-zinc-50/50 border-b border-zinc-100">
        <div className="max-w-4xl mx-auto">
          <details className="group">
            <summary className="text-xs font-mono text-zinc-400 cursor-pointer hover:text-zinc-600 transition-colors">
              <span className="group-open:hidden">Show query that loaded this page</span>
              <span className="hidden group-open:inline">Hide query</span>
            </summary>
            <div className="mt-4">
              <CodeBlock
                title="Single query — user + org + posts + comments"
                code={`const user = await db.users.findUnique({
  where: { id: ${id} },
  with: {
    organization: true,
    posts: {
      orderBy: { createdAt: 'desc' },
      limit: 20,
      with: {
        comments: { limit: 10 },
      },
    },
  },
});
// 4-level deep object graph in one round-trip`}
              />
            </div>
          </details>
        </div>
      </section>

      {/* Posts */}
      <section className="py-12 px-6">
        <div className="max-w-4xl mx-auto">
          <h2 className="text-lg font-semibold mb-6">Posts</h2>

          {!user.posts || user.posts.length === 0 ? (
            <p className="text-sm text-zinc-400">No posts yet.</p>
          ) : (
            <div className="space-y-6">
              {user.posts.map((post: Post) => (
                <article
                  key={post.id}
                  className="rounded-xl border border-zinc-200 bg-white overflow-hidden"
                >
                  <div className="p-6">
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-medium text-zinc-900">{post.title}</h3>
                      <div className="flex items-center gap-2 shrink-0">
                        {post.published ? (
                          <span className="text-[10px] font-mono uppercase tracking-wider text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded">
                            Published
                          </span>
                        ) : (
                          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-400 bg-zinc-50 px-2 py-0.5 rounded">
                            Draft
                          </span>
                        )}
                      </div>
                    </div>
                    <p className="mt-2 text-sm text-zinc-500 leading-relaxed line-clamp-2">
                      {post.content}
                    </p>
                    <div className="mt-3 flex items-center gap-4 text-xs text-zinc-400">
                      <span>{post.viewCount?.toLocaleString() ?? 0} views</span>
                      <span>
                        {post.createdAt
                          ? new Date(post.createdAt).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })
                          : ''}
                      </span>
                    </div>
                  </div>

                  {/* Comments */}
                  {post.comments && post.comments.length > 0 && (
                    <div className="border-t border-zinc-100 bg-zinc-50/50 px-6 py-4 space-y-3">
                      <p className="text-xs text-zinc-400 font-medium">
                        {post.comments.length} comment{post.comments.length !== 1 ? 's' : ''}
                      </p>
                      {post.comments.map((comment: Comment) => (
                        <div key={comment.id} className="flex gap-3">
                          <div className="w-5 h-5 rounded-full bg-zinc-200 flex items-center justify-center text-[9px] font-medium text-zinc-500 shrink-0 mt-0.5">
                            ?
                          </div>
                          <p className="text-sm text-zinc-600 leading-relaxed">
                            {comment.body}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
