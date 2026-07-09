import type { Metadata } from 'next';
import Link from 'next/link';
import { codeToHtml } from 'shiki';
import { CopyButton } from '../components/CopyButton';
import { TURBINE_MINOR } from '../lib/version';

export const metadata: Metadata = {
  title: 'Turbine ORM — the Postgres ORM your DBA will sign off on.',
  description:
    'A read-only Studio that physically cannot mutate prod, errors that never leak PII, one dependency (pg, no WASM engine), and SQL-first migrations with SHA-256 drift detection. Postgres-maximalist underneath: typed pgvector, RLS sessions, LISTEN/NOTIFY, full-text.',
};

const heroCode = `const docs = await db.documents.findMany({
  where: {
    body: { search: 'vector & index' },
    embedding: { distance: { to: queryVec, metric: 'cosine', lt: 0.4 } },
  },
  orderBy: { embedding: { distance: { to: queryVec, metric: 'cosine' } } },
  with: { author: true },
  limit: 10,
});

// full-text + pgvector KNN + a typed relation
// ^ one Postgres query, fully parameterized`;

const sqlCode = `SELECT "users".*,
  (SELECT COALESCE(json_agg(json_build_object(
    'id', t0."id",
    'title', t0."title",
    'comments', (SELECT COALESCE(json_agg(json_build_object(
      'id', t1."id",
      'body', t1."body"
    )), '[]'::json) FROM "comments" t1
      WHERE t1."post_id" = t0."id")
  )), '[]'::json)
  FROM (SELECT * FROM "posts"
    WHERE "posts"."user_id" = "users"."id"
    ORDER BY "posts"."created_at" DESC
    LIMIT 5) t0
  ) AS "posts"
FROM "users"
WHERE "users"."org_id" = $1`;

const features = [
  {
    title: 'One dependency. No WASM.',
    description:
      'Turbine ships pg and nothing else — no WASM at all. Prisma 7 dropped its Rust engine but its client still bundles a TS/WASM query compiler (~1.6 MB) plus a required driver adapter. No adapter chain, no lockstep package upgrades. The main entry bundles to ~42 KB brotli, ~33 KB on the edge.',
    stat: '1',
    statLabel: 'runtime dep',
  },
  {
    title: 'Read-only Studio your DBA will approve',
    description:
      'npx turbine studio launches a loopback-bound web UI. Every query runs inside BEGIN READ ONLY. 192-bit auth token, no raw-SQL surface at all, X-Frame-Options: DENY. No other TS ORM ships this.',
    stat: '0',
    statLabel: 'write paths',
  },
  {
    title: 'PII-safe error messages',
    description:
      'Turbine errors show WHERE keys, not values. A UniqueConstraintError says which column violated the constraint — never the actual user data. Safe to log, safe to surface to monitoring, no scrubbing needed.',
    stat: 'keys',
    statLabel: 'not values',
  },
  {
    title: 'SQL-first migrations with drift detection',
    description:
      'Write real SQL. SHA-256 checksums catch modified migrations. pg_try_advisory_lock() prevents concurrent runs. Each migration in its own transaction. No magic DSL between you and your database.',
    stat: 'SHA-256',
    statLabel: 'checksums',
  },
  {
    title: 'Edge-native. One import swap.',
    description:
      'turbineHttp(pool, SCHEMA) — same API on Neon, Vercel Postgres, Cloudflare Hyperdrive, Supabase. No WASM bundle to ship, no adapter package to install, no separate serverless build step.',
    stat: '~33 KB',
    statLabel: 'edge bundle (brotli)',
  },
  {
    title: 'Pipeline batching via wire protocol',
    description:
      'Real Parse/Bind/Execute pipeline — not queries wrapped in a transaction. N independent queries in one round-trip. Deep with clauses compile to one SQL statement using json_agg.',
    stat: '1',
    statLabel: 'round-trip',
  },
];

const postgresFeatures = [
  {
    title: 'Vector search (pgvector)',
    description:
      'KNN ranking and distance filters over vector columns — orderBy: { embedding: { distance: { to, metric: "cosine" } } }. l2 / cosine / inner-product, every value bound as a parameter.',
    href: '/vector',
    cta: 'Vector docs',
  },
  {
    title: 'Realtime (LISTEN / NOTIFY)',
    description:
      'Postgres pub/sub with db.$listen(channel, handler) and db.$notify(channel, payload). No broker, no extra service — your database is the message bus.',
    href: '/realtime',
    cta: 'Realtime docs',
  },
  {
    title: 'RLS session context',
    description:
      'Multi-tenant isolation the database enforces. $transaction(fn, { sessionContext }) sets transaction-local GUCs so Row-Level Security policies filter rows for you.',
    href: '/transactions',
    cta: 'Transactions docs',
  },
  {
    title: 'Full-text search',
    description:
      "where: { body: { search: 'postgres & orm' } } compiles to to_tsvector @@ to_tsquery with the query bound as a parameter. Pick any text search config. No extension, no extra service.",
    href: '/queries#full-text-search',
    cta: 'Operator docs',
  },
  {
    title: 'Many-to-many, auto-detected',
    description:
      'Pure junction tables are detected at generate time — db.posts.findMany({ with: { tags: true } }) just works. Self-relations too: a self-referencing FK gives you parent + children.',
    href: '/relations',
    cta: 'Relations docs',
  },
  {
    title: 'Observability, in the box',
    description:
      'db.$on("query") taps every query with PII-redacted params. db.$observe() flushes p50/p95/p99 aggregates to Postgres, and npx turbine observe is the dashboard. No agent, no SaaS.',
    href: '/observability',
    cta: 'Observability docs',
  },
];

export default async function Home() {
  const [heroHtml, sqlHtml] = await Promise.all([
    codeToHtml(heroCode, { lang: 'typescript', theme: 'github-dark-dimmed' }),
    codeToHtml(sqlCode, { lang: 'sql', theme: 'github-dark-dimmed' }),
  ]);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Turbine ORM',
    description:
      'The Postgres ORM your DBA will sign off on: a read-only Studio that physically cannot mutate prod, PII-safe error messages, one runtime dependency with no WASM engine, and SQL-first migrations with SHA-256 drift detection. Postgres-maximalist underneath — pgvector search, RLS session context, LISTEN/NOTIFY, and full-text as typed first-class API.',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any',
    url: 'https://turbineorm.dev',
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    author: {
      '@type': 'Organization',
      name: 'ZVN',
      url: 'https://github.com/zvndev',
    },
  };

  return (
    <div>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {/* ========== HERO ========== */}
      <section className="landing-hero">
        <div className="relative z-10 flex flex-col items-center w-full max-w-landing mx-auto">
          <div className="hero-badge animate-fade-in">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" fill="#F59E0B" />
            </svg>
            {TURBINE_MINOR} — PowDB engine support &amp; the BataDB guide
          </div>

          <h1 className="hero-title animate-fade-in-up delay-1">
            <span className="text-white">The Postgres ORM your DBA will sign off on.</span>
            <br />
            <span className="amber">Read-only Studio. PII-safe errors. One dependency.</span>
          </h1>

          <p className="hero-subtitle animate-fade-in-up delay-2">
            A Studio that physically cannot mutate prod, error messages that
            never leak PII, one dependency (<code>pg</code>, no WASM engine),
            and SQL-first migrations with checksum drift detection. Underneath
            it&apos;s Postgres-maximalist — typed pgvector, RLS sessions, and
            realtime are all first-class. The rest is below.
          </p>

          <div className="animate-fade-in-up delay-3">
            <div className="hero-install">
              <span className="dollar">$</span>
              <span>npm install turbine-orm</span>
              <CopyButton text="npm install turbine-orm" />
            </div>
          </div>

          <div className="hero-code-window animate-slide-in-right delay-5 w-full">
            <div className="code-window-bar">
              <div className="code-window-dot" />
              <div className="code-window-dot" />
              <div className="code-window-dot" />
              <span className="code-window-title">query.ts</span>
            </div>
            <div
              className="code-window-body"
              dangerouslySetInnerHTML={{ __html: heroHtml }}
            />
          </div>
        </div>
      </section>

      {/* ========== POSTGRES-NATIVE ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">Postgres-native</p>
          <h2 className="section-title">
            Use the database you actually have.
          </h2>
        </div>

        <div className="feature-grid">
          {postgresFeatures.map((f, i) => (
            <Link
              key={f.title}
              href={f.href}
              className={`feature-card animate-fade-in-up delay-${i + 1}`}
              style={{ textDecoration: 'none', display: 'block' }}
            >
              <h3>{f.title}</h3>
              <p>{f.description}</p>
              <span
                className="font-mono"
                style={{ color: 'var(--accent)', fontSize: '0.8rem' }}
              >
                {f.cta} &rarr;
              </span>
            </Link>
          ))}
        </div>
      </section>

      {/* ========== FEATURES ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">What Prisma and Drizzle don&apos;t ship</p>
          <h2 className="section-title">
            Built in, not bolted on.
          </h2>
        </div>

        <div className="feature-grid">
          {features.map((f, i) => (
            <div
              key={f.title}
              className={`feature-card animate-fade-in-up delay-${i + 1}`}
            >
              <div className="feature-card-stat">
                <span className="feature-stat-value">{f.stat}</span>
                <span className="feature-stat-label">{f.statLabel}</span>
              </div>
              <h3>{f.title}</h3>
              <p>{f.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ========== CODE SHOWCASE ========== */}
      <section className="showcase-section">
        <div className="showcase-inner">
          <p className="section-label">How it works</p>
          <h2 className="section-title" style={{ marginBottom: '2rem' }}>
            One query. Any depth.
          </h2>

          <div className="showcase-columns">
            <div className="showcase-text">
              <h3>Your code writes one call. Turbine writes one query.</h3>
              <p>
                Every ORM claims single-query nested loads now. Turbine uses
                the same <code>json_agg</code> approach as Prisma 7 and
                Drizzle. The difference isn&apos;t the query strategy &mdash; it&apos;s
                everything around it: the one-dependency, no-WASM footprint, the
                read-only Studio, and the error messages that never expose user data.
              </p>

              <ul className="showcase-list">
                <li>
                  <span className="check">&#10003;</span>
                  <span>Correlated subqueries with json_agg + json_build_object</span>
                </li>
                <li>
                  <span className="check">&#10003;</span>
                  <span>COALESCE ensures empty relations return [] not null</span>
                </li>
                <li>
                  <span className="check">&#10003;</span>
                  <span>Inner subquery wrapping for per-relation LIMIT/ORDER BY</span>
                </li>
                <li>
                  <span className="check">&#10003;</span>
                  <span>Pipeline batching via real Parse/Bind/Execute protocol</span>
                </li>
                <li>
                  <span className="check">&#10003;</span>
                  <span>SQL template caching with FNV-1a shape fingerprinting</span>
                </li>
              </ul>
            </div>

            <div className="showcase-code">
              <div className="showcase-code-bar">Generated SQL</div>
              <div dangerouslySetInnerHTML={{ __html: sqlHtml }} />
            </div>
          </div>
        </div>
      </section>

      {/* ========== COMPARISON ========== */}
      <section className="features-section">
        <p className="section-label">Comparison</p>
        <h2 className="section-title">Turbine vs. Prisma vs. Drizzle</h2>

        <div className="overflow-x-auto" style={{ margin: '0 -1.5rem', padding: '0 1.5rem' }}>
          <table
            className="w-full text-sm"
            style={{
              borderCollapse: 'collapse',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              overflow: 'hidden',
            }}
          >
            <thead>
              <tr style={{ background: 'var(--bg-tertiary)' }}>
                <th
                  className="font-mono text-left"
                  style={{
                    padding: '0.7rem 1rem',
                    fontSize: '0.7rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border)',
                  }}
                />
                <th
                  className="font-mono text-left"
                  style={{
                    padding: '0.7rem 1rem',
                    fontSize: '0.7rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--accent)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  Turbine
                </th>
                <th
                  className="font-mono text-left"
                  style={{
                    padding: '0.7rem 1rem',
                    fontSize: '0.7rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  Prisma
                </th>
                <th
                  className="font-mono text-left"
                  style={{
                    padding: '0.7rem 1rem',
                    fontSize: '0.7rem',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-muted)',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  Drizzle
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Engine / runtime', 'No engine binary (pg only)', 'Client + TS/WASM query compiler', 'No engine'],
                ['Runtime deps', '1 (pg)', '@prisma/client + required driver adapter', '0'],
                ['Main bundle (brotli)', '~42 KB', '~1.6 MB client (TS/WASM compiler)', '~7 KB core'],
                ['Studio', 'Read-only, 192-bit auth', 'Full CRUD, cloud-hosted', 'Drizzle Studio (free; Gateway paid)'],
                ['Error PII safety', 'Keys only by default', 'Values in messages', 'Raw pg errors'],
                ['Migrations', 'SQL-first, SHA-256 drift detection', 'DSL-generated, shadow DB', 'SQL or Drizzle Kit'],
                ['Edge runtime', 'One import swap, ~33 KB brotli', 'Driver adapter + WASM compiler', 'Native'],
                ['Pipeline batching', 'Parse/Bind/Execute protocol', 'Sequential in txn', 'Sequential'],
                ['Typed errors', 'isRetryable discriminant', 'Error codes only', 'None'],
                ['Nested relations', '1 query, deep type inference', '1 query, shallow inference', 'relations() re-declaration'],
                ['Many-to-many', 'Auto-detected from junctions', 'Implicit/explicit', 'Explicit relations()'],
                ['Vector search', 'Built-in distance / KNN', 'Preview / raw', 'Extension API'],
                ['LISTEN/NOTIFY', '$listen / $notify', 'None', 'None'],
              ].map(([label, turbine, prisma, drizzle]) => (
                <tr key={label} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td
                    className="font-mono"
                    style={{
                      padding: '0.65rem 1rem',
                      color: '#fff',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {label}
                  </td>
                  <td
                    style={{
                      padding: '0.65rem 1rem',
                      color: 'var(--accent-light)',
                      fontSize: '0.8rem',
                    }}
                  >
                    {turbine}
                  </td>
                  <td
                    style={{
                      padding: '0.65rem 1rem',
                      color: 'var(--text-secondary)',
                      fontSize: '0.8rem',
                    }}
                  >
                    {prisma}
                  </td>
                  <td
                    style={{
                      padding: '0.65rem 1rem',
                      color: 'var(--text-secondary)',
                      fontSize: '0.8rem',
                    }}
                  >
                    {drizzle}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p
          style={{
            marginTop: '1.5rem',
            maxWidth: '48rem',
            color: 'var(--text-secondary)',
            fontSize: '0.9rem',
            lineHeight: 1.7,
          }}
        >
          Building nested reads by hand? Kysely&apos;s <code>jsonArrayFrom</code>{' '}
          recipe uses the same correlated-subquery-plus-JSON approach &mdash;
          proof the pattern is right. But once rows are aggregated into JSON the
          driver can no longer see their types, so a <code>Date</code> inside a{' '}
          <code>jsonArrayFrom</code> result is typed <code>Date</code> yet arrives
          as a string, and the nesting isn&apos;t type-checked at depth. Turbine
          types the whole tree and re-applies date coercion to every nested row,
          so <code>users[0].posts[0].createdAt</code> is a real <code>Date</code>{' '}
          at any depth &mdash; no plugin to wire up.
        </p>
      </section>

      {/* ========== CTA ========== */}
      <section className="cta-section">
        <h2>Start building</h2>
        <p>
          One install, one generate, one query. Get a typed Postgres client
          in under two minutes.
        </p>

        <div className="cta-links">
          <Link href="/quickstart" className="cta-btn cta-btn-primary">
            Quick Start
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
          </Link>
          <a
            href="https://github.com/zvndev/turbine-orm"
            target="_blank"
            rel="noopener noreferrer"
            className="cta-btn cta-btn-secondary"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
          <Link href="/queries" className="cta-btn cta-btn-secondary">
            API Reference
          </Link>
        </div>
      </section>

      {/* ========== FOOTER ========== */}
      <footer className="landing-footer">
        <p>
          One dependency. No WASM engine. Zero compromises. Built by{' '}
          <a href="https://github.com/zvndev" target="_blank" rel="noopener noreferrer">
            ZVN
          </a>
        </p>
      </footer>
    </div>
  );
}
