import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

const SUGGESTIONS = [
  { href: '/quickstart', label: 'Quick Start', hint: 'Zero to a typed query in five minutes' },
  { href: '/queries', label: 'API Reference', hint: 'Every query method and WHERE operator' },
  { href: '/relations', label: 'Relations', hint: 'The nested `with` clause at depth' },
  { href: '/errors', label: 'Typed Errors', hint: 'Every code from E001 to E018' },
  { href: '/cli', label: 'CLI', hint: 'init, generate, migrate, doctor, studio' },
  { href: '/changelog', label: 'Changelog', hint: 'What shipped, release by release' },
];

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '4rem 1.5rem',
        textAlign: 'center',
      }}
    >
      <p
        className="font-mono"
        style={{
          fontSize: '0.75rem',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--accent)',
          margin: 0,
        }}
      >
        404
      </p>

      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(1.75rem, 5vw, 2.75rem)',
          fontWeight: 800,
          letterSpacing: '-0.02em',
          color: '#fff',
          margin: '0.75rem 0 0',
        }}
      >
        No rows returned.
      </h1>

      <p
        style={{
          maxWidth: '32rem',
          marginTop: '0.9rem',
          color: 'var(--text-secondary)',
          fontSize: '1rem',
          lineHeight: 1.7,
        }}
      >
        That page does not exist. It may have been renamed, or the link that
        brought you here may be out of date. Here is where most people are
        heading.
      </p>

      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: '2.25rem 0 0',
          display: 'grid',
          gap: '0.6rem',
          gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
          width: '100%',
          maxWidth: '46rem',
          textAlign: 'left',
        }}
      >
        {SUGGESTIONS.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              style={{
                display: 'block',
                padding: '0.85rem 1rem',
                borderRadius: 10,
                border: '1px solid var(--border)',
                background: 'var(--bg-tertiary)',
                textDecoration: 'none',
              }}
            >
              <span
                className="font-mono"
                style={{ display: 'block', color: 'var(--accent-light)', fontSize: '0.85rem', fontWeight: 600 }}
              >
                {s.label}
              </span>
              <span style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: '0.2rem' }}>
                {s.hint}
              </span>
            </Link>
          </li>
        ))}
      </ul>

      <div style={{ marginTop: '2.25rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'center' }}>
        <Link href="/" className="cta-btn cta-btn-primary">
          Back to the home page
        </Link>
        <a
          href="https://github.com/zvndev/turbine-orm/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="cta-btn cta-btn-secondary"
        >
          Report a broken link
        </a>
      </div>
    </div>
  );
}
