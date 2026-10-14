import Link from 'next/link';
import { TURBINE_VERSION } from '../lib/version';

export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" className="logo-mark">
      <path d="M6 2h20l4 4v20l-4 4H6l-4-4V6z" fill="#0d1018" stroke="currentColor" strokeOpacity="0.55" />
      <path d="M17.5 6.5 9.5 18h6l-1.5 7.5 8.5-12h-6z" fill="currentColor" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="wordmark">
      <LogoMark />
      <span className="wordmark-text">Turbine</span>
    </span>
  );
}

const nav = [
  { href: '/quickstart', label: 'Docs' },
  { href: '/queries', label: 'API' },
  { href: '/benchmarks', label: 'Benchmarks' },
  { href: '/changelog', label: 'Changelog' },
];

export function SiteHeader() {
  return (
    <header className="site-header">
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className="site-header-inner">
        <Link href="/" className="site-brand" aria-label="Turbine ORM home">
          <Wordmark />
          <span className="version-chip">v{TURBINE_VERSION}</span>
        </Link>
        <nav aria-label="Primary" className="site-nav">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} className="site-nav-link">
              {n.label}
            </Link>
          ))}
          <a
            href="https://github.com/zvndev/turbine-orm"
            target="_blank"
            rel="noopener noreferrer"
            className="site-nav-link site-nav-gh"
            data-lf="github-header"
          >
            <GitHubIcon />
            <span>GitHub</span>
          </a>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Wordmark />
          <p>Raw SQL speed, zero raw SQL. MIT licensed. Built by ZVN.</p>
        </div>
        <nav aria-label="Footer" className="site-footer-nav">
          <div>
            <p className="site-footer-label">Start</p>
            <Link href="/quickstart">Quick start</Link>
            <Link href="/why-turbine">Why Turbine</Link>
            <Link href="/migrate-from-prisma">From Prisma</Link>
            <Link href="/migrate-from-drizzle">From Drizzle</Link>
          </div>
          <div>
            <p className="site-footer-label">Reference</p>
            <Link href="/queries">API reference</Link>
            <Link href="/errors">Typed errors</Link>
            <Link href="/benchmarks">Benchmarks</Link>
            <Link href="/changelog">Changelog</Link>
          </div>
          <div>
            <p className="site-footer-label">Project</p>
            <a href="https://github.com/zvndev/turbine-orm" target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            <a href="https://www.npmjs.com/package/turbine-orm" target="_blank" rel="noopener noreferrer">
              npm
            </a>
            <Link href="/ai-agents">For AI agents</Link>
            <a href="/llms.txt">llms.txt</a>
          </div>
        </nav>
      </div>
    </footer>
  );
}

export function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
