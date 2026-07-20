import type { Metadata } from 'next';
import { CHANGELOG_HTML, LATEST_VERSION } from '../../../lib/changelog.generated';

export const metadata: Metadata = {
  title: 'Changelog',
  description:
    'Every Turbine ORM release, newest first, rendered from the canonical CHANGELOG.md so it never drifts from the published package.',
  alternates: { canonical: '/changelog' },
};

// The changelog body is rendered to HTML at build time from the root
// CHANGELOG.md by site/scripts/gen-changelog.mjs (same remark/rehype pipeline
// as the MDX docs pages). Rendering there rather than as MDX keeps the 1,500+
// lines of prose safe from MDX's `<` / `{` parsing. The (docs) layout already
// wraps children in `.mdx-content`, so this inherits the docs typography.
export default function ChangelogPage() {
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time-rendered, trusted CHANGELOG.md */}
      <div dangerouslySetInnerHTML={{ __html: CHANGELOG_HTML }} />
      <p className="text-sm" style={{ color: 'var(--text-muted)', marginTop: '2rem' }}>
        Rendered from the repository&apos;s <code>CHANGELOG.md</code> at build time (currently through
        v{LATEST_VERSION}).
      </p>
    </>
  );
}
