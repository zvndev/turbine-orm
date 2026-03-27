import Link from "next/link";
import { db } from "@/lib/db";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

export const metadata: Metadata = {
  title: "Authors",
  description: "Meet the writers behind the Turbine Blog",
};

export default async function AuthorsPage() {
  const raw = await db.authors.findMany({
    with: {
      articles: {
        where: { published: true },
        with: {
          articleTags: true,
          category: true,
        },
        orderBy: { publishedAt: "desc" },
      },
    },
    orderBy: { name: "asc" },
  });

  const authors = raw as unknown as R[];

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
        <span className="text-zinc-300">Authors</span>
      </nav>

      {/* Page Header */}
      <div className="mb-12">
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-3">
          Authors
        </h1>
        <p className="text-zinc-400 text-lg">
          Meet the writers behind the Turbine Blog. Each author profile is loaded
          with their articles using a nested Turbine query.
        </p>
      </div>

      {/* Authors Grid */}
      <div className="grid gap-6 md:grid-cols-2">
        {authors.map((author: R) => {
          const articles: R[] = author.articles || [];

          // Collect unique categories
          const categories = new Set<string>();
          for (const article of articles) {
            const cat = article.category as R | null;
            if (cat?.name) categories.add(cat.name);
          }

          // Collect unique tags
          const tags = new Set<string>();
          for (const article of articles) {
            const aTags: R[] = article.articleTags || [];
            for (const t of aTags) {
              if (t.tag) tags.add(t.tag);
            }
          }

          const initials = String(author.name)
            .split(" ")
            .map((n: string) => n[0])
            .join("")
            .slice(0, 2)
            .toUpperCase();

          return (
            <Link
              key={author.id}
              href={`/authors/${author.id}`}
              className="group block border border-zinc-800/60 rounded-xl overflow-hidden bg-zinc-900/30 hover:border-zinc-700 hover:bg-zinc-900/50 transition-all duration-200"
            >
              {/* Gradient header */}
              <div className="h-16 bg-gradient-to-r from-emerald-500/10 via-cyan-500/5 to-violet-500/10 relative">
                <div className="absolute inset-0 bg-grid opacity-20" />
              </div>

              <div className="px-6 pb-6 -mt-6 relative">
                <div className="flex items-start gap-4">
                  <div className="w-14 h-14 rounded-lg bg-zinc-900 border-2 border-zinc-950 text-emerald-400 flex items-center justify-center text-lg font-semibold shrink-0 shadow-lg group-hover:border-emerald-500/30 transition-colors">
                    {initials}
                  </div>
                  <div className="pt-2 flex-1 min-w-0">
                    <h2 className="text-lg font-semibold group-hover:text-emerald-400 transition-colors truncate">
                      {author.name}
                    </h2>
                    <p className="text-xs text-zinc-500 truncate">{author.email}</p>
                  </div>
                </div>

                {author.bio && (
                  <p className="text-sm text-zinc-400 mt-3 line-clamp-2 leading-relaxed">
                    {author.bio}
                  </p>
                )}

                {/* Stats */}
                <div className="flex items-center gap-4 mt-4 pt-4 border-t border-zinc-800/40">
                  <div className="flex items-center gap-1.5">
                    <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-zinc-600">
                      <path d="M2 3h12v10H2z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                      <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    <span className="text-xs text-zinc-400">
                      <span className="font-medium text-zinc-300">{articles.length}</span> articles
                    </span>
                  </div>
                  {categories.size > 0 && (
                    <div className="flex items-center gap-1.5">
                      <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-zinc-600">
                        <path d="M2 4l5-2 7 3v7l-7 3-5-2V4z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                      </svg>
                      <span className="text-xs text-zinc-400">
                        <span className="font-medium text-zinc-300">{categories.size}</span> categories
                      </span>
                    </div>
                  )}
                </div>

                {/* Recent tags */}
                {tags.size > 0 && (
                  <div className="flex gap-1.5 flex-wrap mt-3">
                    {Array.from(tags).slice(0, 5).map((tag) => (
                      <span
                        key={tag}
                        className="text-[10px] bg-zinc-800/60 text-zinc-500 px-1.5 py-0.5 rounded-full"
                      >
                        {tag}
                      </span>
                    ))}
                    {tags.size > 5 && (
                      <span className="text-[10px] text-zinc-600 px-1.5 py-0.5">
                        +{tags.size - 5} more
                      </span>
                    )}
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {authors.length === 0 && (
        <p className="text-zinc-500 text-center py-20">
          No authors found.
        </p>
      )}

      {/* Turbine Info */}
      <div className="mt-16 border border-zinc-800/60 rounded-lg p-5 bg-zinc-900/20">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-md bg-emerald-500/10 flex items-center justify-center shrink-0 mt-0.5">
            <svg viewBox="0 0 16 16" fill="none" className="w-4 h-4 text-emerald-400">
              <path d="M8 1L14 5V11L8 15L2 11V5L8 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M8 5V11M5 7L8 5L11 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p className="text-sm font-medium text-zinc-300 mb-1">
              Nested queries in action
            </p>
            <p className="text-xs text-zinc-500 leading-relaxed">
              Each author card above includes their articles, categories, and tags --
              all loaded via a single{" "}
              <code className="text-emerald-400 bg-zinc-800 px-1 py-0.5 rounded text-[11px] font-mono">
                db.authors.findMany({"{"} with: {"{"} articles: {"{"} with: {"{"} articleTags, category {"}"} {"}"} {"}"} {"}"})
              </code>{" "}
              call.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
