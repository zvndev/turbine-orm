'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const NAV_SECTIONS = [
  {
    title: 'Getting Started',
    links: [
      { href: '/', label: 'Introduction' },
      { href: '/quickstart', label: 'Quick Start' },
    ],
  },
  {
    title: 'Guide',
    links: [
      { href: '/queries', label: 'API Reference' },
      { href: '/schema', label: 'Schema & Migrations' },
      { href: '/cli', label: 'CLI Reference' },
      { href: '/transactions', label: 'Transactions & Pipeline' },
      { href: '/middleware', label: 'Middleware' },
      { href: '/serverless', label: 'Serverless / Edge' },
    ],
  },
  {
    title: 'Deep Dives',
    links: [
      { href: '/how-it-works', label: 'How It Works' },
      { href: '/benchmarks', label: 'Benchmarks' },
      { href: '/comparison', label: 'Turbine vs Prisma vs Drizzle' },
      { href: '/neon', label: 'Neon Integration' },
      { href: '/prisma-migration', label: 'Migrate from Prisma' },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* Mobile toggle */}
      <button
        onClick={() => setMobileOpen(!mobileOpen)}
        className="fixed top-4 left-4 z-50 md:hidden p-2 rounded-lg"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
        aria-label="Toggle navigation"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          {mobileOpen ? (
            <path d="M5 5l10 10M15 5L5 15" />
          ) : (
            <path d="M3 5h14M3 10h14M3 15h14" />
          )}
        </svg>
      </button>

      {/* Overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <nav
        className={`
          fixed top-0 left-0 h-screen overflow-y-auto z-40
          transition-transform duration-200 ease-in-out
          md:translate-x-0
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}
        `}
        style={{
          width: 'var(--sidebar-width)',
          background: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border)',
        }}
      >
        <div className="px-5 pt-6 pb-5" style={{ borderBottom: '1px solid var(--border)' }}>
          <Link href="/" className="block no-underline" onClick={() => setMobileOpen(false)}>
            <h1 className="text-lg font-bold tracking-tight">
              <span style={{ color: 'var(--accent)' }}>Turbine</span>{' '}
              <span className="text-zinc-100">ORM</span>
            </h1>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
              turbine-orm
            </p>
          </Link>
        </div>

        <div className="py-4">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="px-3 mb-2">
              <div
                className="text-[11px] font-semibold uppercase tracking-wider px-2 py-2"
                style={{ color: 'var(--text-muted)' }}
              >
                {section.title}
              </div>
              {section.links.map((link) => {
                const isActive = pathname === link.href;
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMobileOpen(false)}
                    className={`
                      block px-2 py-1.5 rounded-md text-sm no-underline transition-colors
                      ${isActive
                        ? 'text-blue-400 bg-blue-500/10'
                        : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60'
                      }
                    `}
                    style={{ textDecoration: 'none' }}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 mt-auto" style={{ borderTop: '1px solid var(--border)' }}>
          <a
            href="https://github.com/zvndev/turbine-orm"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs no-underline"
            style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
          <a
            href="https://www.npmjs.com/package/turbine-orm"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-xs mt-2 no-underline"
            style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0h-2.666V8.667h2.666v5.331zm12 0h-2.666v-4h-1.334v4h-1.335v-4h-1.335v4h-2.666V8.667H22.666v5.331zM11.333 8.667h2.666v4h-2.666v-4z" />
            </svg>
            npm
          </a>
        </div>
      </nav>
    </>
  );
}
