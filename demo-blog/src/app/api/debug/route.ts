import { NextResponse } from "next/server";
import { turbine } from "@/generated";

export const dynamic = "force-dynamic";

export async function GET() {
  // Create a separate client with logging enabled for debug
  const debugDb = turbine({
    connectionString: process.env.DATABASE_URL!,
    poolSize: 2,
    logging: true,
  });

  // Get the first published article with a slug to use for the demo query
  const firstArticle = await debugDb.articles.findMany({
    where: { published: true },
    select: { slug: true },
    limit: 1,
  });

  const slug = firstArticle[0]?.slug as string | undefined;

  if (!slug) {
    return NextResponse.json(
      { error: "No published articles found" },
      { status: 404 }
    );
  }

  // Use buildFindUnique to capture the SQL *before* executing
  const deferred = debugDb.articles.buildFindUnique({
    where: { slug },
    with: {
      author: true,
      category: {
        with: { category: true },
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

  // Time the actual execution
  const startTime = performance.now();
  const article = await debugDb.articles.findUnique({
    where: { slug },
    with: {
      author: true,
      category: {
        with: { category: true },
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
  const endTime = performance.now();

  await debugDb.disconnect();

  return NextResponse.json(
    {
      _meta: {
        description:
          "4-level nested query executed as a SINGLE SQL statement via turbine-orm",
        slug,
        queryTimeMs: Math.round((endTime - startTime) * 100) / 100,
        nestingLevels: [
          "articles (root)",
          "author, category, articleRecommendationsByArticle, comments, articleTags",
          "category.category (parent), recommendedArticle, comments.comments",
          "recommendedArticle.author, comments.comments.comments",
          "comments.comments.comments.comments (level 4 replies)",
        ],
      },
      sql: {
        text: deferred.sql,
        params: deferred.params,
        note: "This entire nested object graph is resolved in ONE round-trip to Postgres using json_agg + json_build_object subqueries. Zero N+1 queries.",
      },
      result: article,
    },
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    }
  );
}
