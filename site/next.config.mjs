import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import createMDX from '@next/mdx';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Tracing root must match what the Vercel builder treats as the deploy root:
// the builder resolves the .next output RELATIVE to this path. Git-connected
// deploys clone the whole repo (/vercel/path0) and build in path0/site, so
// the root is the repo root — pinning it to site/ made the builder lstat
// /vercel/path0/.next (ENOENT, failed deploy). Site-only CLI uploads have no
// root manifest; there the app dir itself is the root.
const repoRoot = resolve(__dirname, '..');
const tracingRoot = existsSync(join(repoRoot, 'package.json')) ? repoRoot : __dirname;

/** @type {import('rehype-pretty-code').Options} */
const prettyCodeOptions = {
  theme: 'github-dark-dimmed',
  keepBackground: false,
  defaultLang: 'ts',
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  pageExtensions: ['ts', 'tsx', 'js', 'jsx', 'md', 'mdx'],
  reactStrictMode: true,
  outputFileTracingRoot: tracingRoot,
};

// Next 16 builds with Turbopack by default, which requires MDX loader options
// to be serializable. Pass remark/rehype plugins as [name, options] string
// tuples (not imported function references) so Turbopack can resolve them.
const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins: [['remark-gfm', {}]],
    rehypePlugins: [
      ['rehype-slug', {}],
      ['rehype-pretty-code', prettyCodeOptions],
    ],
  },
});

export default withMDX(nextConfig);
