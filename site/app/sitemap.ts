import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { MetadataRoute } from 'next';

const SITE = 'https://turbineorm.dev';

const ROUTES = [
  '',
  '/quickstart',
  '/neon',
  '/batadb',
  '/migrate-from-prisma',
  '/migrate-from-drizzle',
  '/queries',
  '/relations',
  '/global-filters',
  '/nested-writes',
  '/transactions',
  '/optimistic-locking',
  '/vector',
  '/realtime',
  '/schema',
  '/migrate',
  '/seeding',
  '/views',
  '/zod',
  '/serverless',
  '/read-replicas',
  '/engines',
  '/compatibility',
  '/powdb',
  '/dialects',
  '/cli',
  '/cli-module',
  '/studio',
  '/mcp',
  '/ai-agents',
  '/observability',
  '/errors',
  '/recipes',
  '/benchmarks',
  '/changelog',
] as const;

/**
 * Last-modified is DERIVED from each page file's mtime rather than a
 * hand-maintained constant (which was stamped 2026-07-21 and had already gone
 * stale). Sitemaps are generated at build time in a Node context, so the file
 * is right there to stat. A page nobody touched keeps its old date, which is
 * exactly what the field is supposed to mean, and there is nothing to remember
 * to bump.
 *
 * The build directory is the site root, so page files resolve relative to it.
 * If a stat fails for any reason, the field is simply omitted for that route:
 * `lastModified` is optional in the sitemap spec, and a wrong date is worse
 * than no date.
 */
function pageLastModified(route: string): Date | undefined {
  const dir = route === '' ? 'app' : join('app', '(docs)', route.slice(1));
  for (const file of ['page.mdx', 'page.tsx']) {
    try {
      return statSync(join(process.cwd(), dir, file)).mtime;
    } catch {
      // Try the next extension.
    }
  }
  return undefined;
}

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((path) => {
    const lastModified = pageLastModified(path);
    return {
      url: `${SITE}${path}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: 'weekly' as const,
      priority: path === '' ? 1 : 0.8,
    };
  });
}
