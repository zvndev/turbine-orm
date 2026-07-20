// Regenerates site/lib/changelog.generated.ts from the ROOT CHANGELOG.md at
// build time (wired as `predev` + `prebuild` alongside gen-version.mjs). Same
// single-source-of-truth contract as gen-version: the hero badge tagline and
// the /changelog page are both derived from the canonical CHANGELOG.md, so
// they can never rot the way a hand-written tagline does.
//
// Two things are emitted:
//   1. CHANGELOG_HTML: the whole changelog rendered to an HTML string via the
//      same remark/rehype pipeline the docs pages use (gfm + heading slugs +
//      shiki highlighting). Rendered here (not as MDX) so the 1,500+ lines of
//      prose can contain bare `<` / `{` without breaking the MDX parser.
//   2. LATEST_VERSION / LATEST_TAGLINE: the newest release's version and a
//      short human tagline parsed from its section, for the hero badge.
//
// Site-only build contexts (a `vercel deploy` run from site/, which uploads
// only this directory) have no root CHANGELOG.md; there we keep the COMMITTED
// changelog.generated.ts that the last in-repo build already wrote. A malformed
// changelog still fails loudly (only absence falls back).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import rehypePrettyCode from 'rehype-pretty-code';
import { toHtml } from 'hast-util-to-html';

const here = dirname(fileURLToPath(import.meta.url));
const changelogPath = resolve(here, '../../CHANGELOG.md');
const outPath = resolve(here, '../lib/changelog.generated.ts');

if (!existsSync(changelogPath)) {
  console.warn(
    `gen-changelog: ${changelogPath} not in this build context (site-only upload); keeping committed lib/changelog.generated.ts`
  );
  process.exit(0);
}

const markdown = readFileSync(changelogPath, 'utf8');

/**
 * Derive a short tagline for the newest release from its section body.
 * Prefers the first bullet's bold lead-in (e.g. `- **Studio demo mode.** ...`
 * -> "Studio demo mode"); falls back to the first prose sentence, capped.
 */
function parseLatest(md) {
  const headingRe = /^##\s+(\d+\.\d+\.\d+)\b.*$/m;
  const match = md.match(headingRe);
  if (!match) {
    throw new Error('gen-changelog: no "## <x.y.z>" release heading found in CHANGELOG.md');
  }
  const version = match[1];

  // Body = everything from just after this heading to the next `## ` heading.
  const afterHeading = md.slice(match.index + match[0].length);
  const nextHeading = afterHeading.search(/^##\s+/m);
  const body = (nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading)).trim();

  const stripInline = (s) =>
    s
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
      .replace(/\*([^*]+)\*/g, '$1') // italic
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links
      .replace(/\s+/g, ' ')
      .trim();

  // Preferred: first bullet's bold lead-in.
  const bulletBold = body.match(/^[-*]\s+\*\*(.+?)\*\*/m);
  if (bulletBold) {
    return { version, tagline: stripInline(bulletBold[1]).replace(/[.:\s]+$/, '') };
  }

  // Fallback: first non-empty prose line, first sentence, capped.
  const firstProse = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('-') && !l.startsWith('*'));
  if (firstProse) {
    const sentence = stripInline(firstProse).split(/(?<=\.)\s/)[0];
    const cap = 72;
    const tagline = sentence.length > cap ? `${sentence.slice(0, cap - 1).trimEnd()}…` : sentence;
    return { version, tagline: tagline.replace(/[.\s]+$/, '') };
  }

  return { version, tagline: `v${version}` };
}

const { version, tagline } = parseLatest(markdown);

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypePrettyCode, {
    theme: 'github-dark-dimmed',
    keepBackground: false,
    defaultLang: 'ts',
  });

const mdast = processor.parse(markdown);
const hast = await processor.run(mdast);
const html = toHtml(hast);

const contents = `/**
 * GENERATED FILE: do not edit by hand.
 *
 * Derived from the root CHANGELOG.md at build time by
 * site/scripts/gen-changelog.mjs (runs as predev/prebuild). It is the single
 * source of truth for the /changelog page body and the hero badge tagline, so
 * neither can drift from the canonical changelog. To change it, edit the root
 * CHANGELOG.md and rebuild.
 */

/** Newest release version, e.g. "0.37.0". */
export const LATEST_VERSION = ${JSON.stringify(version)};

/** Short human tagline for the newest release, e.g. "Studio demo mode". */
export const LATEST_TAGLINE = ${JSON.stringify(tagline)};

/** The whole CHANGELOG.md rendered to HTML (gfm + heading slugs + shiki). */
export const CHANGELOG_HTML = ${JSON.stringify(html)};
`;

writeFileSync(outPath, contents);
console.log(
  `gen-changelog: wrote lib/changelog.generated.ts (LATEST_VERSION='${version}', tagline='${tagline}', ${html.length} bytes html)`
);
