import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import createMDX from '@next/mdx';
import rehypePrettyCode from 'rehype-pretty-code';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';

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

const withMDX = createMDX({
  extension: /\.mdx?$/,
  options: {
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeSlug, [rehypePrettyCode, prettyCodeOptions]],
  },
});

export default withMDX(nextConfig);
