import type { MetadataRoute } from 'next';

const SITE = 'https://turbineorm.dev';

const ROUTES = [
  '',
  '/quickstart',
  '/neon',
  '/migrate-from-prisma',
  '/migrate-from-drizzle',
  '/queries',
  '/relations',
  '/transactions',
  '/vector',
  '/realtime',
  '/schema',
  '/serverless',
  '/compatibility',
  '/cli',
  '/errors',
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
