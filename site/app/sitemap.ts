import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MetadataRoute } from 'next';

const SITE = 'https://turbineorm.dev';

const DOCS_DIR = join('app', '(docs)');
const PAGE_FILES = ['page.mdx', 'page.tsx'] as const;

/**
 * Routes are DERIVED from the `(docs)` route group rather than hand-listed.
 *
 * The hand-maintained array drifted: `/why-turbine` shipped with its own
 * canonical URL and was in neither the sitemap nor llms.txt, so the one page
 * written to catch evaluator and search traffic was excluded from both machine
 * indexes the site publishes. That is a class of bug, not an instance, and the
 * only fix that survives the next page is to stop maintaining the list by hand.
 *
 * A directory counts as a route when it actually has a page file, which is what
 * Next.js itself requires, so a shared `_components` or a stray folder is not
 * emitted. If the directory cannot be read the build FAILS rather than shipping
 * a one-entry sitemap: a silently truncated index is exactly the failure this
 * function exists to prevent, and it would look like a successful build.
 */
function docsRoutes(): string[] {
  const entries = readdirSync(join(process.cwd(), DOCS_DIR), { withFileTypes: true });
  const routes = entries
    .filter((e) => e.isDirectory() && hasPageFile(join(DOCS_DIR, e.name)))
    .map((e) => `/${e.name}`)
    .sort();
  if (routes.length === 0) {
    throw new Error(`[sitemap] no page directories found under ${DOCS_DIR}; refusing to emit an empty sitemap`);
  }
  return routes;
}

function hasPageFile(dir: string): boolean {
  return PAGE_FILES.some((file) => {
    try {
      statSync(join(process.cwd(), dir, file));
      return true;
    } catch {
      return false;
    }
  });
}

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
  const dir = route === '' ? 'app' : join(DOCS_DIR, route.slice(1));
  for (const file of PAGE_FILES) {
    try {
      return statSync(join(process.cwd(), dir, file)).mtime;
    } catch {
      // Try the next extension.
    }
  }
  return undefined;
}

export default function sitemap(): MetadataRoute.Sitemap {
  return ['', ...docsRoutes()].map((path) => {
    const lastModified = pageLastModified(path);
    return {
      url: `${SITE}${path}`,
      ...(lastModified ? { lastModified } : {}),
      changeFrequency: 'weekly' as const,
      priority: path === '' ? 1 : 0.8,
    };
  });
}
