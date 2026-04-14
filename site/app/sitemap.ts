import type { MetadataRoute } from 'next';

const SITE = 'https://turbineorm.dev';

const ROUTES = [
  '',
  '/quickstart',
  '/migrate-from-prisma',
  '/queries',
  '/relations',
  '/transactions',
  '/schema',
  '/serverless',
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
