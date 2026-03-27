import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import type { Metadata } from "next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

function formatDate(date: string | Date | null): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const gradients = [
  "from-emerald-500/20 to-cyan-500/20",
  "from-violet-500/20 to-fuchsia-500/20",
  "from-amber-500/20 to-orange-500/20",
  "from-sky-500/20 to-indigo-500/20",
  "from-rose-500/20 to-pink-500/20",
  "from-teal-500/20 to-emerald-500/20",
];

function getGradient(id: number): string {
  return gradients[id % gradients.length];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const author = await db.authors.findUnique({
    where: { id: Number(id) },
  });
  if (!author) return { title: "Not Found" };
  return {
    title: author.name,
    description: author.bio || undefined,
  };
}

export default async function AuthorPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const raw = await db.authors.findUnique({
    where: { id: Number(id) },
    with: {
      articles: {
        with: {
          articleTags: true,
          category: true,
        },
        where: { published: true },
        orderBy: { publishedAt: "desc" },
      },
    },
  });

  if (!raw) notFound();

  const author = raw as unknown as R;
  const articles: R[] = author.articles || [];

  // Collect unique categories
  const categoryMap = new Map<number, string>();
  for (const article of articles) {
    const cat = article.category as R | null;
    if (cat?.id && cat?.name) {
      categoryMap.set(cat.id, cat.name);
    }
  }

  // Count total tags
  const allTags = new Set<string>();
  for (const article of articles) {
    const tags: R[] = article.articleTags || [];
    for (const t of tags) {
      if (t.tag) allTags.add(t.tag);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-2 text-sm text-zinc-500 mb-8">
        <Link href="/" className="hover:text-zinc-300 transition-colors">
          Home
        </Link>
        <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-zinc-700">
          <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <Link href="/authors" className="hover:text-zinc-300 transition-colors">
          Authors
        </Link>
        <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-zinc-700">
          <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="text-zinc-300">{author.name}</span>
      </nav>

      {/* Author Card */}
      <div className="border border-zinc-800/60 rounded-xl overflow-hidden bg-zinc-900/30 mb-12 relative">
        {/* Gradient banner */}
        <div className="h-24 bg-gradient-to-r from-emerald-500/15 via-cyan-500/10 to-violet-500/15 relative">
          <div className="absolute inset-0 bg-grid opacity-30" />
        </div>

        <div className="px-8 pb-8 -mt-8 relative">
          <div className="flex flex-col sm:flex-row items-start gap-5">
            <div className="w-20 h-20 rounded-xl bg-zinc-900 border-4 border-zinc-950 text-emerald-400 flex items-center justify-center text-2xl font-semibold shrink-0 shadow-xl">
              {String(author.name)
                .split(" ")
                .map((n: string) => n[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </div>
            <div className="flex-1 pt-2">
              <h1 className="text-2xl font-bold mb-1">{author.name}</h1>
              <p className="text-sm text-zinc-500 mb-3">{author.email}</p>
              {author.bio && (
                <p className="text-zinc-400 leading-relaxed max-w-lg">{author.bio}</p>
              )}

              {/* Stats row */}
              <div className="flex items-center gap-6 mt-4">
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold text-zinc-200">{articles.length}</span>
                  <span className="text-xs text-zinc-500">Articles</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold text-zinc-200">{categoryMap.size}</span>
                  <span className="text-xs text-zinc-500">Categories</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-semibold text-zinc-200">{allTags.size}</span>
                  <span className="text-xs text-zinc-500">Tags</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Articles */}
      <section>
        <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-6 flex items-center gap-2">
          <span className="w-8 h-px bg-zinc-700" />
          Articles ({articles.length})
        </h2>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {articles.map((article: R) => {
            const category = article.category as R | null;
            const articleTags: R[] = article.articleTags || [];
            const gradient = getGradient(article.id as number);
            return (
              <Link
                key={article.id}
                href={`/${article.slug}`}
                className="group block bg-zinc-900/30 border border-zinc-800/40 rounded-lg overflow-hidden hover:border-zinc-700 hover:bg-zinc-900/60 transition-all duration-200"
              >
                {/* Thin gradient top bar */}
                <div className={`h-1 bg-gradient-to-r ${gradient}`} />
                <div className="p-5">
                  <div className="flex items-center gap-2 mb-2.5">
                    {category && (
                      <span className="text-[11px] text-emerald-500/80 font-medium">
                        {category.name}
                      </span>
                    )}
                    {article.publishedAt && (
                      <>
                        {category && <span className="text-zinc-800">&middot;</span>}
                        <span className="text-[11px] text-zinc-600">
                          {formatDate(article.publishedAt)}
                        </span>
                      </>
                    )}
                  </div>
                  <h3 className="text-base font-medium mb-1.5 group-hover:text-zinc-50 transition-colors leading-snug">
                    {article.title}
                  </h3>
                  {article.excerpt && (
                    <p className="text-sm text-zinc-500 mb-3 line-clamp-2 leading-relaxed">
                      {article.excerpt}
                    </p>
                  )}
                  {articleTags.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap mt-3">
                      {articleTags.slice(0, 4).map((t: R) => (
                        <span
                          key={t.id}
                          className="text-[10px] bg-zinc-800/60 text-zinc-500 px-1.5 py-0.5 rounded-full"
                        >
                          {t.tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </Link>
            );
          })}
        </div>
        {articles.length === 0 && (
          <p className="text-zinc-500 text-center py-20">
            No published articles by this author.
          </p>
        )}
      </section>
    </div>
  );
}
