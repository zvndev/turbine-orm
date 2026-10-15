import type { MDXComponents } from 'mdx/types';
import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * Callout kinds. `warning` is for footguns that can cost you data or an
 * outage; `note` is neutral context; `tip` is an optional improvement.
 */
type CalloutType = 'note' | 'warning' | 'tip';

const CALLOUT_STYLES: Record<CalloutType, { accent: string; tint: string; label: string }> = {
  note: { accent: '#7d9cc9', tint: 'rgba(125, 156, 201, 0.07)', label: 'Note' },
  warning: { accent: '#ff9f43', tint: 'rgba(255, 159, 67, 0.07)', label: 'Warning' },
  tip: { accent: '#3ddc84', tint: 'rgba(61, 220, 132, 0.06)', label: 'Tip' },
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
        margin: '1.75rem 0',
        padding: '0.95rem 1.15rem 1rem',
        borderLeft: `2px solid ${style.accent}`,
        background: `linear-gradient(90deg, ${style.tint}, rgba(9, 12, 18, 0.4))`,
        boxShadow: 'inset 0 0 0 1px rgba(26, 32, 48, 0.9)',
      }}
    >
      <p
        style={{
          margin: '0 0 0.4rem',
          fontFamily: 'var(--font-mono)',
          fontSize: '0.7rem',
          fontWeight: 600,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: style.accent,
        }}
      >
        {title ?? style.label}
      </p>
      <div className="callout-body" style={{ fontSize: '0.95rem', lineHeight: 1.7 }}>
        {children}
      </div>
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
