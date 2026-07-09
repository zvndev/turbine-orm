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
] as const;

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map((path) => ({
    url: `${SITE}${path}`,
    lastModified,
    changeFrequency: 'weekly',
    priority: path === '' ? 1 : 0.8,
  }));
}
