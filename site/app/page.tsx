import type { Metadata } from 'next';
import Link from 'next/link';
import { codeToHtml } from 'shiki';
import { CopyButton } from '../components/CopyButton';
import { HERO_TAGLINE } from '../lib/tagline';
import { TURBINE_MINOR } from '../lib/version';

export const metadata: Metadata = {
  title: 'Turbine ORM: the Postgres ORM that assumes your database has real data in it.',
  description:
    'A database UI that is read-only by default, PII tagged in the schema and enforced in the SQL, errors that carry keys and never values, destructive migrations that need consent, and offline missing-index advice. One runtime dependency (pg), no WASM engine.',
};

const heroCode = `export default defineSchema({
  users: {
    id:    { type: 'serial', primaryKey: true },
    name:  { type: 'text', notNull: true },
    email: { type: 'text', notNull: true, pii: true },
    //                                    ^^^^^^^^^
  },
});

// That one flag changes what the SQL is allowed to say:
//
//  1. the column is left out of every default projection,
//     on every engine: top-level rows, 'with' subqueries,
//     batched loaders, write returns. It is omitted from
//     the emitted SQL, not filtered out afterwards.
//  2. it is refused as a groupBy key and as a _min / _max
//     target, because both hand back a stored cell.
//  3. Studio renders it redacted, and refuses to filter,
//     sort or page on it.

import { UNSAFE } from 'turbine-orm';

await db.users.findMany();                       // no email
await db.users.findMany({ includePii: UNSAFE }); // email
// includePii: true throws. A privilege option cannot be
// enabled by a value JSON.parse can produce, or a spread
// request body would unlock it.`;

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

const safetyFeatures = [
  {
    title: 'The database UI is read-only by default',
    description:
      'npx turbine studio binds loopback, authenticates with a 192-bit per-process token, and runs every read inside BEGIN READ ONLY. In the default mode the write endpoints do not exist in the router at all, so there is nothing to bypass. There has been no raw-SQL surface since v0.19: queries are composed in the ORM builder and validated identifier by identifier. --write opts one launch in to edits, each addressed by its full primary key rather than a predicate. Try it with no database: npx turbine-orm@latest studio --demo boots a seeded in-memory sample DB with a live Read-only / Show PII / Write switcher.',
    stat: '0',
    statLabel: 'write endpoints by default',
  },
  {
    title: 'PII is a schema contract the SQL enforces',
    description:
      'Tag a column pii: true and it is excluded from every default projection on every engine: top-level rows, with subqueries, batched loaders, write returns, and Studio. It is also refused as a groupBy key and as a _min / _max target, because both hand back a stored cell. includePii: UNSAFE unlocks it explicitly, per read, and the symbol is the only value that works: a request body spread into query args cannot escalate, because JSON.parse cannot produce a symbol. A schema with no tagged column emits byte-identical SQL.',
    stat: 'pii: true',
    statLabel: 'enforced in the projection',
  },
  {
    title: 'Errors carry keys, never values',
    description:
      'A NotFoundError says where: { id, email }. A UniqueConstraintError names the column that conflicted. Neither prints the row. That means the error is safe to forward straight to Sentry or Datadog with no scrubbing rule in front of it, and the full where object is still available as err.where in code.',
    stat: 'keys',
    statLabel: 'not values',
  },
  {
    title: 'Destructive migrations need consent',
    description:
      'migrate up, migrate down and push scan for DROP TABLE, DROP COLUMN, TRUNCATE, unqualified DELETE and UPDATE, and ALTER COLUMN ... TYPE, print an itemized report, and refuse to run. Interactively you type "destroy my data" and then yes; in CI you pass --allow-destructive. A refused batch applies nothing. Migrations are real SQL, checksummed with SHA-256 and serialized behind pg_try_advisory_lock().',
    stat: 'SHA-256',
    statLabel: 'checksums + refusal',
  },
  {
    title: 'The review a DBA would have given you, offline',
    description:
      'npx turbine doctor derives every column set the relation subqueries probe and reports the ones with no covering index, with a cost tier per finding. --fix writes the migration. In dev the first query over an unindexed FK logs the exact CREATE INDEX. No cloud service, no telemetry, no account: it reads your introspected schema.',
    stat: 'doctor',
    statLabel: 'no account required',
  },
];

const postgresFeatures = [
  {
    title: 'Vector search (pgvector)',
    description:
      'KNN ranking and distance filters over vector columns, orderBy: { embedding: { distance: { to, metric: "cosine" } } }. l2 / cosine / inner-product, every value bound as a parameter.',
    href: '/vector',
    cta: 'Vector docs',
  },
  {
    title: 'Realtime (LISTEN / NOTIFY)',
    description:
      'Postgres pub/sub with db.$listen(channel, handler) and db.$notify(channel, payload). No broker, no extra service, your database is the message bus.',
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
      'Pure junction tables are detected at generate time, db.posts.findMany({ with: { tags: true } }) just works. Self-relations too: a self-referencing FK gives you parent + children.',
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

const capabilities = [
  {
    title: 'One dependency. No WASM.',
    description:
      'Turbine ships pg and nothing else, no WASM at all. Prisma 7 dropped its Rust engine but its client still bundles a TS/WASM query compiler (~1.6 MB) plus a required driver adapter. The main entry is held under 77 KB brotli as an import graph with pg external, under 61 KB on the edge, enforced by size-limit in CI rather than quoted from a past measurement. That is the client footprint your bundler sees, not the size of the dual ESM+CJS build on disk, which is larger.',
    href: '/benchmarks',
    cta: 'Benchmarks',
  },
  {
    title: 'turbine doctor: the missing-index advisor',
    description:
      "Turbine loads relations as correlated subqueries, so an unindexed foreign key becomes a full scan per parent row. npx turbine doctor finds every missing FK index before it hits production, and turbine doctor --fix writes the add-index migration for you. In dev, the first query over an unindexed FK also logs the exact CREATE INDEX. The check your DBA would have asked for, run for you.",
    href: '/cli#turbine-doctor',
    cta: 'Doctor docs',
  },
  {
    title: 'Multi-engine, one typed API',
    description:
      'Postgres is the default and the primary target, but the same findMany / with / where surface runs on SQLite, MySQL 8, SQL Server, and PowDB through subpath exports (turbine-orm/sqlite, /mysql, /mssql, /powdb). npm install turbine-orm still pulls exactly one runtime dependency; each engine driver is an optional peer you install only if you use it.',
    href: '/engines',
    cta: 'Engines docs',
  },
  {
    title: 'explain() without dropping to raw',
    description:
      'Every table accessor has explain(args): it compiles the exact statement findMany(args) would run and returns the engine plan as string[] lines. Verify the query the ORM actually emits hits the index you expect, mapped to EXPLAIN / EXPLAIN QUERY PLAN per engine.',
    href: '/queries#explain',
    cta: 'explain() docs',
  },
  {
    title: 'Edge-native, one import swap',
    description:
      'turbineHttp(pool, SCHEMA) gives you the same API on Neon, Vercel Postgres, Cloudflare Hyperdrive, and Supabase. No WASM bundle to ship, no adapter package to install, no separate serverless build step. ~45 KB brotli as an import graph with the driver external.',
    href: '/serverless',
    cta: 'Serverless docs',
  },
  {
    title: 'Real pipelining, not a batch transaction',
    description:
      'db.pipeline(...) uses the Postgres extended-query protocol (Parse/Bind/Execute/Sync) to put N independent queries in one TCP flush. node-postgres does not expose pipelining in its pure-JS core, and Drizzle db.batch() is an implicit transaction on specific drivers rather than independent-query pipelining. Write builders batch too, so a create + createMany + update can go out as one atomic $transaction([...]).',
    href: '/transactions',
    cta: 'Pipeline docs',
  },
  {
    title: 'Coming from Prisma? Keep your call sites.',
    description:
      'turbine migrate-from-prisma reads your schema.prisma and emits a typed mapping plus a migration report. Then createPrismaCompatClient wraps a TurbineClient in a PrismaClient-shaped surface: prisma.user.findMany({ include }) keeps working unchanged, so a port is measured in hours rather than in call sites. It is a runtime shim, not a codemod, so it never edits your source and you can move modules to the native API on your own schedule.',
    href: '/migrate-from-prisma',
    cta: 'Prisma migration guide',
  },
  {
    title: 'Coming from Drizzle?',
    description:
      'The full API mapping, the schema translation, and the behavioural differences worth auditing before you cut over: the empty-where guard, relation declaration, and where the two query builders disagree about defaults.',
    href: '/migrate-from-drizzle',
    cta: 'Drizzle migration guide',
  },
  {
    title: 'MCP server for AI agents',
    description:
      'turbine mcp exposes your database to Claude Code, Cursor, or any MCP client over JSON-RPC stdio. Read-only tools only, no free-form SQL: schema overview, table detail, migrate status, doctor report, EXPLAIN, and sample rows, all inside BEGIN READ ONLY. The same safety stance as Studio.',
    href: '/mcp',
    cta: 'MCP docs',
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
      'The Postgres ORM that assumes your database has real data in it: a read-only-by-default Studio (writes are an explicit --write opt-in), PII tagged in the schema and enforced in the emitted SQL, error messages that carry keys and never values, destructive migrations that require consent, and offline missing-index advice from turbine doctor. One runtime dependency with no WASM engine. Postgres-maximalist underneath: pgvector search, RLS session context, LISTEN/NOTIFY, and full-text as typed first-class API.',
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
          <Link href="/changelog" className="hero-badge animate-fade-in" style={{ textDecoration: 'none' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M13 3L4 14h7l-1 7 9-11h-7l1-7z" fill="#F59E0B" />
            </svg>
            {TURBINE_MINOR} &middot; {HERO_TAGLINE}
          </Link>

          <h1 className="hero-title animate-fade-in-up delay-1">
            <span className="text-white">The Postgres ORM that assumes your database</span>
            <br />
            <span className="amber">has real data in it.</span>
          </h1>

          <p className="hero-subtitle animate-fade-in-up delay-2">
            Most query layers are designed for the shape of a laptop database:
            empty, disposable, nobody&apos;s. Turbine is designed for the same
            schema six months later. The database UI is read-only until you say
            otherwise. Columns you tag as personal data stay out of results,
            logs, and aggregates. Anything that can lose data makes you say so
            out loud. Underneath, it is Postgres-maximalist: typed pgvector, RLS
            sessions, and realtime are all first-class.
          </p>

          <div className="animate-fade-in-up delay-3">
            <div className="hero-install">
              <span className="dollar">$</span>
              <span>npm install turbine-orm</span>
              <CopyButton text="npm install turbine-orm" />
            </div>
          </div>

          <p
            className="animate-fade-in-up delay-4"
            style={{
              marginTop: '1rem',
              marginBottom: '1.5rem',
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
            }}
          >
            Evaluating against Prisma, Drizzle or Kysely?{' '}
            <Link href="/why-turbine" style={{ color: 'var(--accent)' }}>
              Why Turbine
            </Link>{' '}
            says what is genuinely different, and what is table stakes in 2026.
          </p>

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

      {/* ========== SAFETY DEFAULTS (the headline) ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">Designed for a database with real rows in it</p>
          <h2 className="section-title">
            Five defaults, one assumption.
          </h2>
          <p
            style={{
              maxWidth: '48rem',
              marginTop: '0.75rem',
              color: 'var(--text-secondary)',
              fontSize: '0.95rem',
              lineHeight: 1.7,
            }}
          >
            Each of these is checkable, so here is the checkable version, as of
            July 2026. No other TypeScript ORM ships a studio that is read-only
            by default or that redacts PII: Prisma Studio is open source
            (@prisma/studio-core is Apache-2.0) but offers no read-only mode,
            its read-only request has been open since February 2021, Drizzle
            Studio is not open source and self-hosting runs through the paid
            Drizzle Gateway, and TypeORM, MikroORM, Kysely and Sequelize have no
            studio at all. No TypeScript ORM CLI offers missing-index advice, and
            Prisma Optimize was retired in March 2026 in favour of cloud-only
            Query Insights. Prior art exists outside TypeScript, notably Ruby&apos;s
            active_record_doctor, so the honest claim is &quot;no TypeScript
            ORM&quot;, not &quot;no ORM&quot;.
          </p>
        </div>

        <div className="feature-grid">
          {safetyFeatures.map((f, i) => (
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

      {/* ========== POSTGRES-NATIVE ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">And it is still Postgres-maximalist underneath</p>
          <h2 className="section-title">
            None of that costs you the database.
          </h2>
          <p
            style={{
              maxWidth: '48rem',
              marginTop: '0.75rem',
              color: 'var(--text-secondary)',
              fontSize: '0.95rem',
              lineHeight: 1.7,
            }}
          >
            Safe defaults usually arrive as a lowest-common-denominator API that
            can only do what every database can do. Turbine goes the other way:
            Postgres is the primary target, and the parts of it that other
            query layers push you to raw SQL for are typed, first-class surface.
          </p>
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

      {/* ========== OPERATIONS / REACH ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">Ship it and sleep</p>
          <h2 className="section-title">
            Tooling your DBA will thank you for.
          </h2>
        </div>

        <div className="feature-grid">
          {capabilities.map((f, i) => (
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
                This is table stakes, and it is here for correctness rather than
                as a selling point. Drizzle has compiled relational queries to{' '}
                <code>LEFT JOIN LATERAL</code> plus JSON aggregation since 0.28,
                Prisma does the same under its <code>relationJoins</code>{' '}
                preview flag, and Kysely ships{' '}
                <code>jsonArrayFrom</code> / <code>jsonObjectFrom</code>{' '}
                helpers. Turbine uses correlated <code>json_agg</code>{' '}
                subqueries. What is worth reading below is how the nesting stays
                correct at depth: empty relations, per-relation limits, and
                types that survive the JSON round-trip.
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
                [
                  'Main bundle (brotli)',
                  '~60 KB import graph, pg external',
                  '~1.6 MB client (TS/WASM compiler)',
                  '~7 KB core',
                ],
                ['Studio', 'Read-only by default, 192-bit auth', 'Full CRUD, cloud-hosted', 'Drizzle Studio (free; Gateway paid)'],
                ['Error PII safety', 'Keys only by default', 'Values in messages', 'Raw pg errors'],
                ['Migrations', 'SQL-first, SHA-256 drift detection', 'DSL-generated, shadow DB', 'SQL or Drizzle Kit'],
                ['Edge runtime', 'One import swap, ~45 KB brotli', 'Driver adapter + WASM compiler', 'Native'],
                ['Pipeline batching', 'Parse/Bind/Execute protocol', 'Sequential in txn', 'Sequential'],
                ['Typed errors', 'isRetryable discriminant', 'Error codes only', 'None'],
                [
                  'Nested relations',
                  '1 query, deep type inference',
                  '1 query (relationJoins, Preview), shallow inference',
                  '1 query (lateral + JSON agg), relations() re-declaration',
                ],
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
            marginTop: '1rem',
            maxWidth: '48rem',
            color: 'var(--text-muted)',
            fontSize: '0.8rem',
            lineHeight: 1.7,
          }}
        >
          The longer, more honest version of this table, including what is{' '}
          <em>not</em> a reason to switch, is on{' '}
          <Link href="/why-turbine" style={{ color: 'var(--accent)' }}>
            Why Turbine
          </Link>
          . Comparison as of July 2026, against Prisma 7 and Drizzle 0.45.
          Competitor features marked Preview or beta may change, and bundle
          sizes move release to release. Turbine&apos;s bundle-size and
          performance claims are measured on the{' '}
          <Link href="/benchmarks" style={{ color: 'var(--accent)' }}>
            benchmarks page
          </Link>
          .
        </p>

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
          <Link href="/why-turbine" className="cta-btn cta-btn-secondary">
            Why Turbine
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
