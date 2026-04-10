'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

type NavItem = { href: string; label: string };
type NavSection = { title: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    title: 'Getting Started',
    items: [
      { href: '/quickstart', label: 'Quick Start' },
    ],
  },
  {
    title: 'Guide',
    items: [
      { href: '/queries', label: 'API Reference' },
      { href: '/schema', label: 'Schema & Migrations' },
      { href: '/cli', label: 'CLI' },
      { href: '/errors', label: 'Typed Errors' },
    ],
  },
  {
    title: 'Reference',
    items: [{ href: '/benchmarks', label: 'Benchmarks' }],
  },
];

function GitHubIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function NpmIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0h-2.666V8.667h2.666v5.331zm12 0h-2.666v-4h-1.334v4h-1.335v-4h-1.335v4h-2.666V8.667H22.666v5.331zM11.333 8.667h2.666v4h-2.666v-4z" />
    </svg>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';
    return pathname === href || pathname?.startsWith(`${href}/`);
  };

  return (
    <>
      {/* Mobile toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Toggle navigation"
        className="fixed top-4 left-4 z-50 md:hidden p-2 rounded-lg"
        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
      >
        <svg
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          aria-hidden="true"
        >
          <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="fixed inset-0 z-30 md:hidden"
          style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
          onClick={() => setOpen(false)}
          onKeyDown={() => {}}
          role="presentation"
        />
      )}

      <nav
        className={`fixed top-0 left-0 h-screen flex flex-col overflow-y-auto z-40 transition-transform duration-200 ease-in-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        } md:translate-x-0`}
        style={{
          width: 'var(--sidebar-width)',
          background: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border)',
        }}
      >
        {/* Brand */}
        <div className="px-5 pt-6 pb-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <Link href="/" className="block" style={{ textDecoration: 'none' }} onClick={() => setOpen(false)}>
            <div className="flex items-center gap-2.5">
              <div
                className="flex items-center justify-center rounded-lg"
                style={{
                  width: 28,
                  height: 28,
                  background: 'var(--accent-glow)',
                  border: '1px solid rgba(245, 158, 11, 0.2)',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" fill="#F59E0B" />
                </svg>
              </div>
              <div>
                <span
                  className="font-display font-bold text-sm"
                  style={{ color: '#fff', letterSpacing: '-0.02em' }}
                >
                  Turbine ORM
                </span>
                <span
                  className="font-mono text-xs ml-2"
                  style={{
                    color: 'var(--accent)',
                    background: 'var(--accent-glow)',
                    padding: '1px 6px',
                    borderRadius: '4px',
                    fontSize: '0.6rem',
                    fontWeight: 600,
                  }}
                >
                  v0.9.1
                </span>
              </div>
            </div>
          </Link>
        </div>

        {/* Navigation */}
        <div className="py-4 flex-1">
          {sections.map((section) => (
            <div key={section.title} className="px-3 mb-2">
              <div className="sidebar-section-label">{section.title}</div>
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  className={`sidebar-link ${isActive(item.href) ? 'active' : ''}`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="px-5 py-4" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-4">
            <a
              href="https://github.com/zvndev/turbine-orm"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs"
              style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
            >
              <GitHubIcon />
              <span>GitHub</span>
            </a>
            <a
              href="https://www.npmjs.com/package/turbine-orm"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-xs"
              style={{ color: 'var(--text-muted)', textDecoration: 'none' }}
            >
              <NpmIcon />
              <span>npm</span>
            </a>
          </div>
        </div>
      </nav>
    </>
  );
}
