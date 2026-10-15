'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { TURBINE_VERSION } from '../lib/version';
import { GitHubIcon, Wordmark } from './SiteChrome';

type NavItem = { href: string; label: string };
type NavSection = { title: string; items: NavItem[] };

const sections: NavSection[] = [
  {
    title: 'Start here',
    items: [
      { href: '/why-turbine', label: 'Why Turbine' },
      { href: '/quickstart', label: 'Quick start' },
      { href: '/migrate-from-prisma', label: 'Migrate from Prisma' },
      { href: '/migrate-from-drizzle', label: 'Migrate from Drizzle' },
    ],
  },
  {
    title: 'Querying',
    items: [
      { href: '/queries', label: 'Reading and writing' },
      { href: '/filtering', label: 'Filtering and sorting' },
      { href: '/relations', label: 'Relations' },
      { href: '/nested-writes', label: 'Nested writes' },
      { href: '/aggregations', label: 'Aggregations' },
      { href: '/transactions', label: 'Transactions and pipelines' },
      { href: '/raw-sql', label: 'Raw SQL' },
      { href: '/client', label: 'Client API' },
    ],
  },
  {
    title: 'Features',
    items: [
      { href: '/global-filters', label: 'Global filters' },
      { href: '/optimistic-locking', label: 'Optimistic locking' },
      { href: '/vector', label: 'Vector search' },
      { href: '/realtime', label: 'Realtime (LISTEN/NOTIFY)' },
    ],
  },
  {
    title: 'Schema',
    items: [
      { href: '/schema', label: 'Schema' },
      { href: '/migrate', label: 'Migrations' },
      { href: '/seeding', label: 'Seeding' },
      { href: '/views', label: 'Views and generated columns' },
      { href: '/zod', label: 'Zod schemas' },
    ],
  },
  {
    title: 'Deploy',
    items: [
      { href: '/serverless', label: 'Serverless and edge' },
      { href: '/neon', label: 'Neon' },
      { href: '/batadb', label: 'BataDB' },
      { href: '/read-replicas', label: 'Read replicas' },
      { href: '/recipes', label: 'Framework recipes' },
    ],
  },
  {
    title: 'Engines',
    items: [
      { href: '/engines', label: 'Database engines' },
      { href: '/compatibility', label: 'Postgres-compatible databases' },
      { href: '/powdb', label: 'PowDB' },
      { href: '/dialects', label: 'Writing a dialect' },
    ],
  },
  {
    title: 'Tooling',
    items: [
      { href: '/cli', label: 'CLI' },
      { href: '/cli-module', label: 'CLI config module' },
      { href: '/doctor', label: 'turbine doctor' },
      { href: '/studio', label: 'Studio' },
      { href: '/mcp', label: 'MCP server' },
      { href: '/ai-agents', label: 'AI agents' },
      { href: '/observability', label: 'Observability' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { href: '/errors', label: 'Typed errors' },
      { href: '/benchmarks', label: 'Benchmarks' },
      { href: '/upgrading-to-0-90', label: 'Upgrading to 0.90' },
      { href: '/changelog', label: 'Changelog' },
    ],
  },
];

function NpmIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M0 7.334v8h6.666v1.332H12v-1.332h12v-8H0zm6.666 6.664H5.334v-4H3.999v4H1.335V8.667h5.331v5.331zm4 0h-2.666V8.667h2.666v5.331zm12 0h-2.666v-4h-1.334v4h-1.335v-4h-1.335v4h-2.666V8.667H22.666v5.331zM11.333 8.667h2.666v4h-2.666v-4z" />
    </svg>
  );
}

function MenuIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      {open ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 5h14M3 10h14M3 15h14" />}
    </svg>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  const isActive = (href: string) => pathname === href || pathname?.startsWith(`${href}/`);

  return (
    <>
      {/* Mobile top bar */}
      <div className="docs-topbar">
        <Link href="/" aria-label="Turbine ORM home" style={{ textDecoration: 'none' }}>
          <Wordmark />
        </Link>
        <button
          type="button"
          className="docs-menu-btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="docs-nav"
        >
          <MenuIcon open={open} />
          {open ? 'Close' : 'Menu'}
        </button>
      </div>

      {open && (
        <div
          className="fixed inset-0 z-30 md:hidden"
          style={{ background: 'rgba(0, 0, 0, 0.6)', backdropFilter: 'blur(4px)' }}
          onClick={close}
          role="presentation"
        />
      )}

      <nav
        id="docs-nav"
        aria-label="Documentation"
        className={`docs-sidebar fixed top-0 left-0 h-screen flex flex-col overflow-y-auto z-40 transition-transform duration-200 ease-in-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        } md:translate-x-0`}
        style={{ width: 'var(--sidebar-width)' }}
      >
        <div className="px-5 pt-5 pb-4 flex items-center justify-between gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <Link href="/" aria-label="Turbine ORM home" style={{ textDecoration: 'none' }} onClick={close}>
            <Wordmark />
          </Link>
          <span className="version-chip">v{TURBINE_VERSION}</span>
        </div>

        <div className="py-3 px-3 flex-1">
          {sections.map((section) => (
            <div key={section.title} className="mb-1">
              <div className="sidebar-section-label">{section.title}</div>
              {section.items.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={close}
                  aria-current={isActive(item.href) ? 'page' : undefined}
                  className={`sidebar-link ${isActive(item.href) ? 'active' : ''}`}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          ))}
        </div>

        <div className="px-5 py-4 flex items-center gap-4" style={{ borderTop: '1px solid var(--border)' }}>
          <a
            href="https://github.com/zvndev/turbine-orm"
            target="_blank"
            rel="noopener noreferrer"
            data-lf="github-sidebar"
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
      </nav>
    </>
  );
}
