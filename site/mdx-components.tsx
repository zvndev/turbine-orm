import type { MDXComponents } from 'mdx/types';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * Callout kinds. `warning` is for footguns that can cost you data or an
 * outage; `note` is neutral context; `tip` is an optional improvement.
 */
type CalloutType = 'note' | 'warning' | 'tip';

const CALLOUT_STYLES: Record<CalloutType, { accent: string; tint: string; label: string }> = {
  note: { accent: '#60A5FA', tint: 'rgba(96, 165, 250, 0.08)', label: 'Note' },
  warning: { accent: '#F59E0B', tint: 'rgba(245, 158, 11, 0.08)', label: 'Warning' },
  tip: { accent: '#34D399', tint: 'rgba(52, 211, 153, 0.08)', label: 'Tip' },
};

/**
 * A titled callout box. Available in every MDX page without an import,
 * because Next.js injects everything this file returns as the MDX provider.
 *
 * ```mdx
 * <Callout type="warning" title="Behind a transaction pooler">
 *   Set `preparedStatements: false`.
 * </Callout>
 * ```
 */
export function Callout({
  type = 'note',
  title,
  children,
}: {
  type?: CalloutType;
  title?: string;
  children: ReactNode;
}) {
  const style = CALLOUT_STYLES[type] ?? CALLOUT_STYLES.note;
  return (
    <aside
      style={{
        margin: '1.5rem 0',
        padding: '0.9rem 1.1rem',
        borderLeft: `3px solid ${style.accent}`,
        borderRadius: '0 8px 8px 0',
        background: style.tint,
      }}
    >
      <p
        style={{
          margin: '0 0 0.35rem',
          fontSize: '0.72rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: style.accent,
        }}
      >
        {title ?? style.label}
      </p>
      <div style={{ fontSize: '0.92rem', lineHeight: 1.7 }}>{children}</div>
    </aside>
  );
}

/**
 * Heading with a hover-revealed anchor link. `rehype-slug` has already
 * stamped the `id`, so we only need to render a link to it; a heading with no
 * id renders unchanged.
 */
function anchoredHeading(Tag: 'h2' | 'h3') {
  return function Heading({ id, children, ...rest }: ComponentPropsWithoutRef<'h2'>) {
    if (!id) return <Tag {...rest}>{children}</Tag>;
    return (
      <Tag id={id} className="heading-anchored" {...rest}>
        {children}
        <a href={`#${id}`} aria-label="Link to this section" className="heading-anchor">
          #
        </a>
      </Tag>
    );
  };
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    h2: anchoredHeading('h2'),
    h3: anchoredHeading('h3'),
    Callout,
    ...components,
  };
}
