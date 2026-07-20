import type { MetadataRoute } from 'next';

const SITE = 'https://turbineorm.dev';

// A stable, build-time constant so we don't stamp every page as "modified"
// on every deploy (which `new Date()` did). Bump this when docs content
// meaningfully changes.
const LAST_MODIFIED = '2026-07-19';

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
  '/cli',
  '/studio',
  '/mcp',
  '/observability',
  '/errors',
  '/recipes',
  '/benchmarks',
  '/changelog',
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  return ROUTES.map((path) => ({
    url: `${SITE}${path}`,
    lastModified: LAST_MODIFIED,
    changeFrequency: 'weekly',
    priority: path === '' ? 1 : 0.8,
  }));
}
