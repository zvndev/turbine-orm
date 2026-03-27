import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import type { Metadata } from "next";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ArticleMetadata {
  readTime?: string;
  readTimeMinutes?: number;
  wordCount?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type R = Record<string, any>;

/** Safe string extraction from record */
function s(obj: R | null | undefined, key: string): string {
  return String(obj?.[key] ?? "");
}

function formatDate(date: string | Date | null): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function formatShortDate(date: string | Date | null): string {
  if (!date) return "";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

// ─── Metadata ────────────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const article = await db.articles.findUnique({
    where: { slug },
  });
  if (!article) return { title: "Not Found" };
  return {
    title: article.title,
    description: article.excerpt || undefined,
  };
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // 4-level nested query — the Turbine showcase
  const raw = await db.articles.findUnique({
    where: { slug },
    with: {
      author: true,
      category: {
        with: { category: true }, // parent category
      },
      articleRecommendationsByArticle: {
        with: {
          recommendedArticle: {
            with: { author: true },
          },
        },
        orderBy: { position: "asc" },
      },
      comments: {
        where: { approved: true, parentId: null },
        with: {
          comments: {
            with: {
              comments: {
                with: {
                  comments: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
      articleTags: true,
    },
  });

  if (!raw) notFound();

  // Cast to any-record for nested relation access
  const article = raw as unknown as R;
  const author = article.author as R | null;
  const category = article.category as R | null;
  const parentCategory = category?.category as R | null;
  const recs: R[] = article.articleRecommendationsByArticle || [];
  const comments: R[] = article.comments || [];
  const articleTags: R[] = article.articleTags || [];
  const meta = article.metadata as ArticleMetadata | null;
  const commentCount = countComments(comments);

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
        {parentCategory && (
          <>
            <span className="text-zinc-400">{s(parentCategory, "name")}</span>
            <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3 text-zinc-700">
              <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </>
        )}
        {category && (
          <span className="text-emerald-500">{s(category, "name")}</span>
        )}
      </nav>

      <div className="lg:grid lg:grid-cols-[1fr_320px] lg:gap-12">
        {/* Main Content */}
        <article className="min-w-0">
          {/* Title + meta */}
          <header className="mb-10">
            {/* Category + read time pills */}
            <div className="flex items-center gap-3 mb-4">
              {category && (
                <span className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full font-medium">
                  {s(category, "name")}
                </span>
              )}
              {meta?.readTime && (
                <span className="text-xs text-zinc-500 bg-zinc-800/60 px-2.5 py-1 rounded-full">
                  {meta.readTime}
                </span>
              )}
              {meta?.wordCount && (
                <span className="text-xs text-zinc-600 bg-zinc-800/40 px-2.5 py-1 rounded-full">
                  {meta.wordCount.toLocaleString()} words
                </span>
              )}
            </div>

            <h1 className="text-3xl md:text-4xl font-bold tracking-tight mb-4 leading-tight">
              {s(article, "title")}
            </h1>

            {article.excerpt && (
              <p className="text-lg text-zinc-400 mb-6 leading-relaxed max-w-2xl">
                {s(article, "excerpt")}
              </p>
            )}

            {/* Author + date bar */}
            <div className="flex items-center gap-4 py-4 border-y border-zinc-800/60">
              {author && (
                <Link
                  href={`/authors/${author.id}`}
                  className="flex items-center gap-3 hover:text-zinc-100 transition-colors group"
                >
                  <AuthorAvatar name={s(author, "name")} size="md" />
                  <div>
                    <span className="text-sm font-medium text-zinc-200 group-hover:text-emerald-400 transition-colors block leading-tight">
                      {s(author, "name")}
                    </span>
                    {author.bio && (
                      <span className="text-xs text-zinc-600 line-clamp-1 block max-w-xs">
                        {s(author, "bio")}
                      </span>
                    )}
                  </div>
                </Link>
              )}
              <div className="ml-auto flex items-center gap-3 text-sm text-zinc-500">
                {article.publishedAt && (
                  <time className="flex items-center gap-1.5">
                    <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-zinc-600">
                      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
                      <path d="M8 4.5V8L10.5 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                    {formatDate(article.publishedAt as string)}
                  </time>
                )}
                {article.viewCount > 0 && (
                  <span className="text-zinc-600 text-xs">
                    {article.viewCount.toLocaleString()} views
                  </span>
                )}
              </div>
            </div>

            {/* Tags */}
            {articleTags.length > 0 && (
              <div className="flex gap-2 flex-wrap mt-4">
                {articleTags.map((t: R) => (
                  <span
                    key={t.id}
                    className="text-xs bg-zinc-800/80 text-zinc-400 px-2.5 py-1 rounded-full border border-zinc-700/30"
                  >
                    {s(t, "tag")}
                  </span>
                ))}
              </div>
            )}
          </header>

          {/* Body */}
          <div className="article-body max-w-none mb-16">
            <ArticleBody body={s(article, "body")} />
          </div>

          {/* Author Card */}
          {author && (
            <div className="border border-zinc-800/60 rounded-xl p-6 mb-12 bg-zinc-900/30 relative overflow-hidden">
              <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-emerald-500/50 via-cyan-500/50 to-transparent" />
              <div className="flex items-start gap-4">
                <AuthorAvatar name={s(author, "name")} size="lg" />
                <div className="flex-1">
                  <p className="text-xs text-zinc-600 uppercase tracking-wide font-mono mb-1">
                    Written by
                  </p>
                  <Link
                    href={`/authors/${author.id}`}
                    className="font-semibold text-zinc-100 hover:text-emerald-400 transition-colors text-lg"
                  >
                    {s(author, "name")}
                  </Link>
                  {author.bio && (
                    <p className="text-sm text-zinc-400 mt-2 leading-relaxed">
                      {s(author, "bio")}
                    </p>
                  )}
                  <Link
                    href={`/authors/${author.id}`}
                    className="inline-flex items-center gap-1 text-xs text-emerald-400 mt-3 hover:text-emerald-300 transition-colors"
                  >
                    View all articles
                    <svg viewBox="0 0 16 16" fill="none" className="w-3 h-3">
                      <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* Comments Section */}
          <section className="mt-12">
            <h2 className="text-lg font-semibold mb-6 flex items-center gap-3">
              <svg viewBox="0 0 16 16" fill="none" className="w-5 h-5 text-zinc-600">
                <path d="M2 3.5C2 2.67 2.67 2 3.5 2h9c.83 0 1.5.67 1.5 1.5v7c0 .83-.67 1.5-1.5 1.5H6L3 14.5V12H3.5C2.67 12 2 11.33 2 10.5v-7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              </svg>
              Comments
              <span className="text-zinc-500 font-normal text-sm bg-zinc-800/60 px-2 py-0.5 rounded-full">
                {commentCount}
              </span>
            </h2>
            {comments.length === 0 ? (
              <div className="text-zinc-500 text-sm py-8 text-center border border-zinc-800/40 rounded-lg bg-zinc-900/20">
                No comments yet. Be the first to share your thoughts.
              </div>
            ) : (
              <div className="space-y-0">
                {comments.map((comment: R) => (
                  <CommentThread
                    key={comment.id}
                    comment={comment}
                    depth={0}
                  />
                ))}
              </div>
            )}
          </section>

          {/* Turbine Query Info Box */}
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
                  This page loaded all data in a single query
                </p>
                <p className="text-xs text-zinc-500 leading-relaxed">
                  Article + author + category + {recs.length} recommendations + {commentCount} comments (nested {getMaxCommentDepth(comments)} levels deep) + {articleTags.length} tags --
                  all resolved in one SQL round-trip via{" "}
                  <code className="text-emerald-400 bg-zinc-800 px-1 py-0.5 rounded text-[11px] font-mono">
                    @batadata/turbine
                  </code>.
                </p>
              </div>
            </div>
          </div>
        </article>

        {/* Sidebar */}
        <aside className="mt-12 lg:mt-0">
          <div className="lg:sticky lg:top-20 space-y-8">
            {/* Table of Contents placeholder -- shows nested query depth */}
            <div className="border border-zinc-800/40 rounded-lg p-5 bg-zinc-900/20">
              <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-3">
                Nested Query Depth
              </h3>
              <div className="space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span className="text-zinc-400">Article (root)</span>
                </div>
                <div className="flex items-center gap-2 ml-3">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/70" />
                  <span className="text-zinc-500">Author, Category, Tags, Comments</span>
                </div>
                <div className="flex items-center gap-2 ml-6">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400/50" />
                  <span className="text-zinc-600">Parent Category, Recommended Articles</span>
                </div>
                <div className="flex items-center gap-2 ml-9">
                  <span className="w-1 h-1 rounded-full bg-emerald-400/30" />
                  <span className="text-zinc-600">Rec Authors, Nested Replies</span>
                </div>
              </div>
            </div>

            {/* Recommended Articles */}
            {recs.length > 0 && (
              <div>
                <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-4 flex items-center gap-2">
                  <span className="w-6 h-px bg-zinc-700" />
                  Recommended
                </h3>
                <div className="space-y-3">
                  {recs.map((rec: R) => {
                    const recArticle = rec.recommendedArticle as R | null;
                    if (!recArticle) return null;
                    const recAuthor = recArticle.author as R | null;
                    return (
                      <Link
                        key={rec.id}
                        href={`/${recArticle.slug}`}
                        className="block p-4 bg-zinc-900/30 border border-zinc-800/40 rounded-lg hover:border-zinc-700 transition-all group"
                      >
                        <h4 className="text-sm font-medium group-hover:text-emerald-400 transition-colors leading-snug mb-1.5">
                          {s(recArticle, "title")}
                        </h4>
                        {recArticle.excerpt && (
                          <p className="text-xs text-zinc-500 line-clamp-2 mb-2 leading-relaxed">
                            {s(recArticle, "excerpt")}
                          </p>
                        )}
                        {recAuthor && (
                          <div className="flex items-center gap-1.5">
                            <AuthorAvatar name={s(recAuthor, "name")} size="sm" />
                            <span className="text-xs text-zinc-600">
                              {s(recAuthor, "name")}
                            </span>
                          </div>
                        )}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tags sidebar */}
            {articleTags.length > 0 && (
              <div>
                <h3 className="text-xs font-mono uppercase tracking-widest text-zinc-500 mb-4 flex items-center gap-2">
                  <span className="w-6 h-px bg-zinc-700" />
                  Tags
                </h3>
                <div className="flex flex-wrap gap-2">
                  {articleTags.map((t: R) => (
                    <span
                      key={t.id}
                      className="text-xs bg-zinc-800/60 text-zinc-400 px-2.5 py-1 rounded-full border border-zinc-700/30"
                    >
                      {s(t, "tag")}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Article Body Renderer ──────────────────────────────────────────────────

function ArticleBody({ body }: { body: string }) {
  // Split by double newlines for paragraphs, handle basic markdown-like formatting
  const paragraphs = body.split(/\n\n+/).filter(Boolean);

  return (
    <>
      {paragraphs.map((paragraph, i) => {
        const trimmed = paragraph.trim();

        // Heading detection (## or ###)
        if (trimmed.startsWith("### ")) {
          return (
            <h3 key={i}>
              {trimmed.slice(4)}
            </h3>
          );
        }
        if (trimmed.startsWith("## ")) {
          return (
            <h2 key={i}>
              {trimmed.slice(3)}
            </h2>
          );
        }

        // Blockquote
        if (trimmed.startsWith("> ")) {
          return (
            <blockquote key={i}>
              {trimmed.slice(2)}
            </blockquote>
          );
        }

        // Horizontal rule
        if (trimmed === "---" || trimmed === "***") {
          return <hr key={i} />;
        }

        // List detection
        if (trimmed.split("\n").every((line) => /^[-*]\s/.test(line.trim()))) {
          return (
            <ul key={i}>
              {trimmed.split("\n").map((line, j) => (
                <li key={j}>{line.replace(/^[-*]\s/, "").trim()}</li>
              ))}
            </ul>
          );
        }

        // Default: paragraph
        return (
          <p key={i}>{trimmed}</p>
        );
      })}
    </>
  );
}

// ─── Comment Thread ──────────────────────────────────────────────────────────

function CommentThread({ comment, depth }: { comment: R; depth: number }) {
  const replies: R[] = comment.comments || [];
  const maxDepth = 5;
  const indent = Math.min(depth, maxDepth);

  const borderColors = [
    "border-emerald-500/30",
    "border-cyan-500/30",
    "border-violet-500/30",
    "border-amber-500/30",
    "border-rose-500/30",
  ];
  const borderColor = borderColors[indent % borderColors.length];

  return (
    <div
      className={indent > 0 ? `ml-6 border-l ${borderColor} pl-4` : ""}
    >
      <div className="py-4">
        <div className="flex items-center gap-2 mb-2">
          <AuthorAvatar name={s(comment, "authorName")} size="sm" />
          <span className="text-sm font-medium text-zinc-300">
            {s(comment, "authorName")}
          </span>
          <span className="text-xs text-zinc-600">
            {formatShortDate(comment.createdAt as string)}
          </span>
        </div>
        <p className="text-sm text-zinc-400 leading-relaxed pl-8">
          {s(comment, "body")}
        </p>
      </div>
      {replies.length > 0 && (
        <div>
          {replies.map((reply: R) => (
            <CommentThread key={reply.id} comment={reply} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function countComments(comments: R[]): number {
  let count = comments.length;
  for (const c of comments) {
    const replies: R[] | undefined = c.comments;
    if (replies) count += countComments(replies);
  }
  return count;
}

function getMaxCommentDepth(comments: R[]): number {
  if (comments.length === 0) return 0;
  let maxDepth = 1;
  for (const c of comments) {
    const replies: R[] | undefined = c.comments;
    if (replies && replies.length > 0) {
      maxDepth = Math.max(maxDepth, 1 + getMaxCommentDepth(replies));
    }
  }
  return maxDepth;
}

function AuthorAvatar({
  name,
  size = "md",
}: {
  name: string;
  size?: "sm" | "md" | "lg";
}) {
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const dims: Record<string, string> = {
    sm: "w-6 h-6 text-[10px]",
    md: "w-8 h-8 text-xs",
    lg: "w-12 h-12 text-base",
  };

  return (
    <div
      className={`${dims[size]} rounded-full bg-emerald-500/15 text-emerald-400 flex items-center justify-center font-medium shrink-0`}
    >
      {initials}
    </div>
  );
}
