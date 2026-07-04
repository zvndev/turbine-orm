import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import createMDX from '@next/mdx';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  // Pin tracing to this app so the outer turbine-orm lockfile isn't picked up.
  outputFileTracingRoot: __dirname,
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
