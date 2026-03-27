import Link from "next/link";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

interface ArticleMetadata {
  readTime?: string;
  readTimeMinutes?: number;
  wordCount?: number;
  difficulty?: string;
}

// Deterministic gradient based on article id
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

function formatDate(date: string | Date | null): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default async function HomePage() {
  const raw = await db.articles.findMany({
    where: { published: true },
    with: {
      author: true,
      category: true,
      articleTags: true,
    },
    orderBy: { publishedAt: "desc" },
    limit: 20,
  });

  const articles = raw as unknown as R[];
  const featured = articles.filter((a) => a.featured);
  const recent = articles.filter((a) => !a.featured);

  // Collect unique categories for the filter bar
  const categoryMap = new Map<number, { id: number; name: string; slug: string }>();
  for (const article of articles) {
    const cat = article.category as R | null;
    if (cat?.id && cat?.name) {
      categoryMap.set(cat.id, { id: cat.id, name: cat.name, slug: cat.slug });
    }
  }
  const categories = Array.from(categoryMap.values());

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      {/* Hero Section */}
      <section className="mb-16 relative">
        <div className="bg-grid absolute inset-0 -z-10 opacity-50" />
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-mono mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Powered by turbine-orm
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight mb-4 leading-[1.1]">
            The Turbine
            <span className="bg-gradient-to-r from-emerald-400 to-cyan-400 bg-clip-text text-transparent">
              {" "}Blog
            </span>
          </h1>
          <p className="text-lg text-zinc-400 leading-relaxed">
            A showcase blog demonstrating deep nested Postgres queries resolved in a
            single SQL round-trip. Every page loads its entire data graph -- author,
            category, tags, comments, recommendations -- in one query.
          </p>
        </div>
      </section>

      {/* Category Filter Bar */}
      {categories.length > 0 && (
        <section className="mb-10">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-mono uppercase tracking-widest text-zinc-600 mr-1">
              Categories
            </span>
            {categories.map((cat) => (
              <span
                key={cat.id}
                className="text-xs bg-zinc-900 text-zinc-400 px-3 py-1.5 rounded-full border border-zinc-800/60 hover:border-zinc-700 transition-colors cursor-default"
              >
                {cat.name}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Hero: Featured Articles */}
      {featured.length > 0 && (
        <section className="mb-16">
          <h2 className="text-xs font-mono uppercase tracking-widest text-emerald-500 mb-6 flex items-center gap-2">
            <span className="w-8 h-px bg-emerald-500/50" />
            Featured
          </h2>
          <div className="grid gap-6 md:grid-cols-2">
            {featured.map((article: R) => (
              <FeaturedCard key={article.id} article={article} />
            ))}
          </div>
        </section>
      )}

      {/* Recent Articles Grid */}
      <section>
        <h2 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-6 flex items-center gap-2">
          <span className="w-8 h-px bg-zinc-700" />
          Recent Articles
        </h2>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {recent.map((article: R) => (
            <ArticleCard key={article.id} article={article} />
          ))}
        </div>
        {articles.length === 0 && (
          <p className="text-zinc-500 text-center py-20">
            No published articles yet.
          </p>
        )}
      </section>

      {/* Query Showcase Banner */}
      <section className="mt-20 border border-zinc-800/60 rounded-xl p-8 bg-zinc-900/30 relative overflow-hidden">
        <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
        <div className="relative">
          <h3 className="text-lg font-semibold mb-2">
            See the query that powers this page
          </h3>
          <p className="text-sm text-zinc-400 mb-4 max-w-lg">
            Every article card above was loaded with its author, category, and tags
            in a single SQL query using nested{" "}
            <code className="text-emerald-400 bg-zinc-800 px-1.5 py-0.5 rounded text-xs font-mono">
              json_agg
            </code>{" "}
            subqueries. No N+1 problems, ever.
          </p>
          <Link
            href="/api/debug"
            className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-lg text-sm font-mono hover:bg-emerald-500/15 hover:border-emerald-500/30 transition-all"
          >
            View Debug API
            <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5">
              <path
                d="M6 3L11 8L6 13"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </Link>
        </div>
      </section>
    </div>
  );
}

function FeaturedCard({ article }: { article: R }) {
  const author = article.author as R | null;
  const category = article.category as R | null;
  const articleTags: R[] = article.articleTags || [];
  const meta = article.metadata as ArticleMetadata | null;
  const readTime = meta?.readTime
    ? meta.readTime
    : meta?.readTimeMinutes
      ? `${meta.readTimeMinutes} min read`
      : null;
  const gradient = getGradient(article.id as number);

  return (
    <Link
      href={`/${article.slug}`}
      className="group relative block rounded-xl overflow-hidden border border-zinc-800/60 hover:border-emerald-500/30 transition-all duration-300 glow-emerald"
    >
      {/* Gradient header band */}
      <div className={`h-32 bg-gradient-to-br ${gradient} relative`}>
        <div className="absolute inset-0 bg-grid opacity-30" />
        {article.featured && (
          <div className="absolute top-3 right-3 flex items-center gap-1.5 px-2 py-0.5 bg-zinc-950/70 backdrop-blur-sm rounded-full border border-zinc-700/50">
            <svg viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 text-amber-400">
              <path d="M8 1l2.2 4.5L15 6.3l-3.5 3.4.8 4.8L8 12.2 3.7 14.5l.8-4.8L1 6.3l4.8-.8L8 1z" />
            </svg>
            <span className="text-[10px] text-zinc-300 font-medium">Featured</span>
          </div>
        )}
      </div>

      <div className="p-6 bg-zinc-900/50">
        <div className="flex items-center gap-2 mb-3">
          {category && (
            <span className="text-xs text-emerald-400 font-medium">
              {category.name}
            </span>
          )}
          {readTime && (
            <>
              <span className="text-zinc-700">&middot;</span>
              <span className="text-xs text-zinc-500">{readTime}</span>
            </>
          )}
          {article.publishedAt && (
            <>
              <span className="text-zinc-700">&middot;</span>
              <span className="text-xs text-zinc-600">{formatDate(article.publishedAt)}</span>
            </>
          )}
        </div>

        <h3 className="text-xl font-semibold mb-2 group-hover:text-emerald-400 transition-colors leading-snug">
          {article.title}
        </h3>

        {article.excerpt && (
          <p className="text-sm text-zinc-400 mb-4 line-clamp-2 leading-relaxed">
            {article.excerpt}
          </p>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <AuthorAvatar name={author?.name || "Unknown"} />
            <div>
              <span className="text-sm text-zinc-300 block leading-tight">
                {author?.name || "Unknown"}
              </span>
              {article.viewCount > 0 && (
                <span className="text-[10px] text-zinc-600">
                  {article.viewCount.toLocaleString()} views
                </span>
              )}
            </div>
          </div>
          {articleTags.length > 0 && (
            <div className="flex gap-1.5 flex-wrap justify-end">
              {articleTags.slice(0, 3).map((t: R) => (
                <span
                  key={t.id}
                  className="text-[11px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded-full"
                >
                  {t.tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </Link>
  );
}

function ArticleCard({ article }: { article: R }) {
  const author = article.author as R | null;
  const category = article.category as R | null;
  const articleTags: R[] = article.articleTags || [];
  const meta = article.metadata as ArticleMetadata | null;
  const readTime = meta?.readTime
    ? meta.readTime
    : meta?.readTimeMinutes
      ? `${meta.readTimeMinutes} min read`
      : null;
  const gradient = getGradient(article.id as number);

  return (
    <Link
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
          {readTime && (
            <>
              <span className="text-zinc-700">&middot;</span>
              <span className="text-[11px] text-zinc-500">{readTime}</span>
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

        <div className="flex items-center justify-between mt-auto">
          <div className="flex items-center gap-2">
            <AuthorAvatar name={author?.name || "Unknown"} size="sm" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-zinc-500">
                {author?.name || "Unknown"}
              </span>
              {article.publishedAt && (
                <>
                  <span className="text-zinc-800">&middot;</span>
                  <span className="text-[11px] text-zinc-600">
                    {formatDate(article.publishedAt)}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

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
}

function AuthorAvatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md";
}) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const dim = size === "sm" ? "w-5 h-5 text-[9px]" : "w-7 h-7 text-[10px]";

  return (
    <div
      className={`${dim} rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center font-medium shrink-0`}
    >
      {initials}
    </div>
  );
}
