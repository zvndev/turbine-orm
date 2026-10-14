import type { Metadata } from 'next';
import Link from 'next/link';
import { codeToHtml } from 'shiki';
import { CopyButton } from '../components/CopyButton';
import { HeroFallback } from '../components/hero/HeroFallback';
import { HeroStage } from '../components/hero/HeroStage';
import { SiteFooter, SiteHeader } from '../components/SiteChrome';
import { HERO_TAGLINE } from '../lib/tagline';
import { TURBINE_MINOR } from '../lib/version';

export const metadata: Metadata = {
  title: 'Turbine ORM: one query, any depth',
  description:
    'A TypeScript ORM for Postgres that compiles nested reads into one SQL statement you can read. No query engine, no WASM, one runtime dependency (pg). Read-only MCP tools for coding agents, offline index advice, migration guards. MIT.',
};

/*
 * Bundle-size claims. These exact phrases are checked against the size-limit
 * gates by src/test/size-claim-sync.test.ts, and the stat strip below reads
 * its figure out of them, so the two cannot drift apart.
 */
const MAIN_SIZE_CLAIM = 'under 148 kB brotli';
const EDGE_SIZE_CLAIM = 'under 116 kB brotli';
const sizeOf = (claim: string) => claim.match(/\d+ kB/)?.[0] ?? '';

const queryCode = `const users = await db.users.findMany({
  where: { orgId: 1 },
  with: {
    posts: {
      with: { comments: { with: { author: true } } },
      orderBy: { createdAt: 'desc' },
      limit: 5,
    },
  },
});

users[0].posts[0].comments[0].author.name;
//                                  ^ typed, end to end

// Everything between your code and Postgres:
//   "dependencies": { "pg": "^8.15.0" }`;

const sqlCode = `SELECT "users"."id", "users"."name", "users"."email",
  (SELECT COALESCE(json_agg(json_build_array(
    t0i."id"::text,
    t0i."title",
    COALESCE((SELECT COALESCE(json_agg(json_build_array(
      t1."id"::text,
      t1."body"
    )), '[]'::json) FROM "comments" t1
      WHERE t1."post_id" = "t0i"."id"), '[]'::json)
  )), '[]'::json)
  FROM (SELECT t0."id", t0."title" FROM "posts" t0
    WHERE t0."user_id" = "users"."id"
    ORDER BY t0."created_at" DESC
    LIMIT $2) t0i
  ) AS "posts"
FROM "users" WHERE "org_id" = $1`;

const stats = [
  { value: '1.08x', label: 'hand-written pg', note: 'geometric mean, see benchmarks' },
  { value: '1', label: 'runtime dependency', note: 'pg, and nothing else' },
  { value: sizeOf(MAIN_SIZE_CLAIM), label: 'brotli ceiling', note: 'enforced by size-limit in CI' },
  { value: '11', label: 'read-only agent tools', note: 'an MCP server in the package' },
];

const pains = [
  {
    pain: 'Forty queries to render one page.',
    fix: (
      <>
        A nested <code>with</code> compiles to one statement of correlated <code>json_agg</code> subqueries.
        Users, their posts, each post&apos;s comments: one round trip, typed at every level. An empty relation
        comes back as <code>[]</code>, never <code>null</code>.
      </>
    ),
  },
  {
    pain: 'An engine riding along in your deploy.',
    fix: (
      <>
        <code>dependencies</code> is one line: <code>pg</code>. No engine binary, no WASM compiler, no adapter
        packages to keep in lockstep. The main entry stays {MAIN_SIZE_CLAIM}, and the edge entry{' '}
        {EDGE_SIZE_CLAIM}.
      </>
    ),
  },
  {
    pain: 'SQL you never get to read.',
    fix: (
      <>
        Every query is a parameterized statement you can print before it runs.{' '}
        <code>buildFindMany(args).sql</code> shows it, <code>explain(args)</code> returns the plan, and{' '}
        <code>$on(&apos;query&apos;)</code> hands you each one with its parameters redacted.
      </>
    ),
  },
  {
    pain: (
      <>
        <code>deleteMany(&#123; where: &#123;&#125; &#125;)</code> on a Friday.
      </>
    ),
    fix: (
      <>
        An empty or always-true <code>where</code> on an update or delete throws. Running it anyway takes{' '}
        <code>allowFullTableScan: UNSAFE</code>, a symbol that a spread request body cannot produce.
      </>
    ),
  },
];

const bars = [
  { name: 'hand-written pg', ratio: 1.0, tone: 'base' },
  { name: 'Turbine 0.71', ratio: 1.08, tone: 'lead' },
  { name: 'Drizzle 0.45.2', ratio: 1.47, tone: 'other' },
  { name: 'Prisma 7.9.1', ratio: 1.81, tone: 'other' },
];

const agentTools = [
  ['relation_graph', 'Every relation and the exact name a with clause accepts.'],
  ['find_join_path', 'From comments to orgs: the chain, and the with clause to write.'],
  ['compile_query', 'The SQL a read compiles to, without running it.'],
  ['explain_query', 'The plan for a schema-checked findMany. No SQL input exists.'],
  ['table_stats', 'Row estimate, size and indexes. Says analyzed: false instead of guessing.'],
  ['sample_rows', 'Up to 50 rows, PII-tagged columns redacted first.'],
  ['explain_error', 'A Turbine error code mapped to its cause, fix and docs link.'],
];

const safety = [
  {
    title: 'Studio is read-only until you say otherwise',
    body: 'npx turbine studio binds loopback, checks a per-process token, and runs every read inside BEGIN READ ONLY. Without --write the write routes do not exist. Try it with no database: npx turbine-orm@latest studio --demo.',
  },
  {
    title: 'PII stays out of the SQL',
    body: 'Tag a column pii: true and default projections leave it out of the statement itself: RETURNING "id", "name", not RETURNING *. Reading it takes includePii: UNSAFE.',
  },
  {
    title: 'Errors carry keys, not values',
    body: 'A NotFoundError says where: { id, email } without printing the email. Forward errors to your tracker without a scrubbing rule.',
  },
  {
    title: 'Destructive migrations need consent',
    body: 'migrate and push refuse DROP TABLE, DROP COLUMN, TRUNCATE, an unqualified DELETE or UPDATE, and column type changes until you type "destroy my data" or pass --allow-destructive in CI. A refused batch applies nothing.',
  },
  {
    title: 'Index advice, offline',
    body: 'npx turbine doctor finds every relation column with no covering index, ranks each by cost, and --fix writes the migration. No cloud service, no account.',
  },
];

const inTheBox = [
  { title: 'Vector search', body: 'pgvector KNN ordering and distance filters, every value bound.', href: '/vector' },
  { title: 'LISTEN / NOTIFY', body: '$listen and $notify. Your database is the message bus.', href: '/realtime' },
  { title: 'RLS session context', body: 'Transaction-local settings so row-level security filters for you.', href: '/transactions' },
  { title: 'Full-text search', body: "where: { body: { search: 'postgres & orm' } }, bound as a parameter.", href: '/queries#full-text-search' },
  { title: 'Wire pipelining', body: 'N queries in one round trip over Parse, Bind, Execute, Sync.', href: '/transactions' },
  { title: 'True cursor streaming', body: 'Constant memory over DECLARE CURSOR, any orderBy, safe early break.', href: '/queries#findmanystream' },
  { title: 'Global filters', body: 'Soft delete and tenancy as config, merged into every query on a table.', href: '/global-filters' },
  { title: 'explain()', body: 'The plan for the exact statement a findMany would run.', href: '/queries#explain' },
  { title: 'Observability', body: 'Query events, p50 to p99 metrics, and a local dashboard. No SaaS.', href: '/observability' },
  { title: 'Typed errors', body: 'Stable codes, a docs link in every message, isRetryable as a typed const.', href: '/errors' },
  { title: 'Many-to-many', body: 'Junction tables detected at generate time. No declaration needed.', href: '/relations' },
  { title: 'Four more engines', body: 'SQLite, MySQL, SQL Server and PowDB behind subpath imports.', href: '/engines' },
];

export default async function Home() {
  const [queryHtml, sqlHtml] = await Promise.all([
    codeToHtml(queryCode, { lang: 'typescript', theme: 'github-dark-dimmed' }),
    codeToHtml(sqlCode, { lang: 'sql', theme: 'github-dark-dimmed' }),
  ]);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Turbine ORM',
    description:
      'A TypeScript ORM for Postgres with one runtime dependency (pg). Nested reads compile to one SQL statement. Read-only MCP tools for coding agents, offline index advice from turbine doctor, and destructive-migration guards. MIT.',
    applicationCategory: 'DeveloperApplication',
    operatingSystem: 'Any',
    url: 'https://turbineorm.dev',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    author: { '@type': 'Organization', name: 'ZVN', url: 'https://github.com/zvndev' },
  };

  return (
    <div className="landing">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SiteHeader />

      <main id="main">
        {/* ========== HERO ========== */}
        <section className="hero" aria-labelledby="hero-title">
          <HeroStage>
            <HeroFallback />
          </HeroStage>
          <div className="hero-scrim" aria-hidden="true" />

          <div className="hero-inner">
            <Link href="/changelog" className="hero-badge">
              <span className="hero-badge-version">{TURBINE_MINOR}</span>
              <span className="hero-badge-text">{HERO_TAGLINE}</span>
            </Link>

            <p className="eyebrow">TypeScript ORM for Postgres</p>
            <h1 id="hero-title" className="hero-title">
              One query.
              <br />
              <span className="hero-title-accent">Any depth.</span>
            </h1>

            <p className="hero-lede">
              Turbine compiles a nested read into a single SQL statement you can read, then hands it straight to{' '}
              <code>pg</code>. No query engine. No WASM. One runtime dependency.
            </p>

            <div className="hero-actions">
              <div className="install">
                <span className="install-prompt" aria-hidden="true">
                  $
                </span>
                <code>npm install turbine-orm</code>
                <CopyButton text="npm install turbine-orm" />
              </div>
              <Link href="/quickstart" className="btn btn-primary" data-lf="quickstart-hero">
                Quick start
                <Arrow />
              </Link>
              <Link href="/why-turbine" className="btn btn-ghost">
                Why Turbine
              </Link>
            </div>
          </div>

          <dl className="hero-stats">
            {stats.map((s) => (
              <div key={s.label} className="hero-stat">
                <dt>
                  {s.label}
                  <span className="hero-stat-note">{s.note}</span>
                </dt>
                <dd>{s.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ========== WHY SWITCH ========== */}
        <section className="section" aria-labelledby="why-title">
          <header className="section-head">
            <p className="eyebrow">Why switch</p>
            <h2 id="why-title" className="section-title">
              Less machinery. More Postgres.
            </h2>
            <p className="section-lede">
              Turbine writes the SQL, <code>pg</code> sends it, and Postgres does the work. No engine sits in
              between, so there is nothing extra to ship, tune or guess about.
            </p>
          </header>
          <ul className="pain-grid">
            {pains.map((p, i) => (
              <li key={i} className="pain-card">
                <p className="pain">{p.pain}</p>
                <p className="fix">{p.fix}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ========== HOW IT WORKS ========== */}
        <section className="section" aria-labelledby="how-title">
          <header className="section-head">
            <p className="eyebrow">How it works</p>
            <h2 id="how-title" className="section-title">
              One call in. One statement out.
            </h2>
            <p className="section-lede">
              A <code>with</code> clause becomes correlated <code>json_agg</code> subqueries. Postgres builds the
              nested result and sends it back in one round trip. You get the tree, typed at every level, with no
              manual annotation.
            </p>
          </header>

          <div className="code-pair">
            <figure className="panel">
              <figcaption className="panel-bar">
                <span>query.ts</span>
              </figcaption>
              <div className="panel-code" dangerouslySetInnerHTML={{ __html: queryHtml }} />
            </figure>
            <figure className="panel">
              <figcaption className="panel-bar">
                <span>the statement Postgres receives</span>
              </figcaption>
              <div className="panel-code" dangerouslySetInnerHTML={{ __html: sqlHtml }} />
            </figure>
          </div>

          <ul className="checklist">
            <li>
              Per-relation <code>limit</code> and <code>orderBy</code> apply per parent, not to the whole result.
            </li>
            <li>Every type survives the JSON round trip, dates included.</li>
            <li>
              The default <code>auto</code> strategy keeps the single statement, and moves a relation whose foreign
              key has no covering index to one flat follow-up query.
            </li>
            <li>
              The join, batched and auto strategies return byte-identical rows. A differential fuzz suite holds
              them there.
            </li>
          </ul>
        </section>

        {/* ========== BENCHMARKS ========== */}
        <section className="section" aria-labelledby="bench-title">
          <header className="section-head">
            <p className="eyebrow">Benchmarks</p>
            <h2 id="bench-title" className="section-title">
              Within 8% of hand-written SQL.
            </h2>
            <p className="section-lede">
              The suite runs Turbine, Prisma and Drizzle against a hand-written <code>pg</code> control on the same
              schema, data and pool. The losses are published next to the wins.
            </p>
          </header>

          <div className="bench">
            <figure className="bench-chart">
              <figcaption>
                Overhead above hand-written <code>pg</code>. Geometric mean over the eight scenarios with a raw
                control. Lower is better.
              </figcaption>
              <ol className="bars">
                {bars.map((b) => (
                  <li key={b.name} className={`bar bar-${b.tone}`}>
                    <span className="bar-name">{b.name}</span>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${(b.ratio / 1.81) * 100}%` }} />
                    </span>
                    <span className="bar-value">{b.ratio.toFixed(2)}x</span>
                  </li>
                ))}
              </ol>
            </figure>

            <div className="bench-notes">
              <div className="note">
                <p className="note-figure">2.02x / 1.46x</p>
                <p>
                  Faster than Prisma 7.9.1 and Drizzle 0.45.2, by geometric mean across all ten scenarios.
                </p>
              </div>
              <div className="note">
                <p className="note-figure">7.16x</p>
                <p>
                  A five-query dashboard batch through <code>pipeline()</code> against the same queries sent one by
                  one, over a real 22 ms link to Neon: 24 ms instead of 172 ms.
                </p>
              </div>
              <div className="note note-loss">
                <p className="note-figure">Where it loses</p>
                <p>
                  Streaming. In this run Drizzle 0.45.2 drained 50,000 rows in 39.5 ms to Turbine&apos;s 50.4 ms. A
                  later re-measurement reversed that against Drizzle 0.45.2. Against Drizzle 1.0.0-rc.4 the batch
                  API ties, and the per-row API is 5 to 11% slower.
                </p>
              </div>
            </div>
          </div>

          <p className="fineprint">
            Turbine 0.71.0, Prisma 7.9.1, Drizzle 0.45.2. Local PostgreSQL 17.9 over a Unix socket, 1,000 users,
            10,000 posts and 50,000 comments, medians of three runs of 200 interleaved rounds, measured 2026-08-15.
            The pipeline figure is Turbine 0.78.0 against itself on Neon in us-east-1. Full method, raw data and
            noise floor on the{' '}
            <Link href="/benchmarks">benchmarks page</Link>.
          </p>
        </section>

        {/* ========== AGENTS ========== */}
        <section className="section" aria-labelledby="agents-title">
          <header className="section-head">
            <p className="eyebrow">For coding agents</p>
            <h2 id="agents-title" className="section-title">
              Give your agent tools, not a SQL prompt.
            </h2>
            <p className="section-lede">
              <code>npx turbine mcp</code> starts a read-only MCP server with eleven tools. Every call runs inside{' '}
              <code>BEGIN READ ONLY</code>, PII-tagged columns are redacted before rows reach the model, and no tool
              accepts SQL text. Typed query args turn a wrong query into a compile error your agent can read.
            </p>
          </header>
          <ul className="tool-grid">
            {agentTools.map(([name, desc]) => (
              <li key={name} className="tool">
                <code className="tool-name">{name}</code>
                <span>{desc}</span>
              </li>
            ))}
            <li className="tool tool-more">
              <span>
                Plus <code>schema_overview</code>, <code>table_detail</code>, <code>migrate_status</code> and{' '}
                <code>doctor_report</code>.
              </span>
              <Link href="/ai-agents">
                Set it up for Claude Code or Cursor <Arrow />
              </Link>
            </li>
          </ul>
        </section>

        {/* ========== SAFETY ========== */}
        <section className="section" aria-labelledby="safety-title">
          <header className="section-head">
            <p className="eyebrow">Built for a database with real rows in it</p>
            <h2 id="safety-title" className="section-title">
              The dangerous operations ask first.
            </h2>
            <p className="section-lede">
              Reads are safe by default. Anything that can lose or leak data needs an explicit opt-in, and the
              privileged opt-ins are a symbol, so <code>JSON.parse</code> cannot produce one.
            </p>
          </header>
          <ul className="safety-grid">
            {safety.map((s) => (
              <li key={s.title} className="card">
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ========== IN THE BOX ========== */}
        <section className="section" aria-labelledby="box-title">
          <header className="section-head">
            <p className="eyebrow">Postgres-first</p>
            <h2 id="box-title" className="section-title">
              The parts you used to drop to raw SQL for.
            </h2>
            <p className="section-lede">
              Typed, documented and in the npm package. No paid tier, no telemetry, no account.
            </p>
          </header>
          <ul className="box-grid">
            {inTheBox.map((f) => (
              <li key={f.title}>
                <Link href={f.href} className="box-tile">
                  <span className="box-title">{f.title}</span>
                  <span className="box-body">{f.body}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        {/* ========== MIGRATE ========== */}
        <section className="section" aria-labelledby="move-title">
          <header className="section-head">
            <p className="eyebrow">Switching</p>
            <h2 id="move-title" className="section-title">
              Bring your call sites with you.
            </h2>
          </header>
          <div className="move-grid">
            <Link href="/migrate-from-prisma" className="move-card">
              <span className="move-from">From Prisma</span>
              <span className="move-body">
                <code>turbine migrate-from-prisma</code> reads <code>schema.prisma</code> and emits a typed map. A
                compat client keeps <code>prisma.user.findMany(&#123; include &#125;)</code> working while you port
                module by module.
              </span>
              <span className="move-cta">
                Prisma migration guide <Arrow />
              </span>
            </Link>
            <Link href="/migrate-from-drizzle" className="move-card">
              <span className="move-from">From Drizzle</span>
              <span className="move-body">
                The API mapping, the schema translation, and the behaviour differences to audit before you cut over,
                starting with the empty-where guard.
              </span>
              <span className="move-cta">
                Drizzle migration guide <Arrow />
              </span>
            </Link>
          </div>
        </section>

        {/* ========== CTA ========== */}
        <section className="cta" aria-labelledby="cta-title">
          <h2 id="cta-title">Take the fast line.</h2>
          <p>Install it, point it at Postgres, and run your first typed query.</p>
          <div className="cta-actions">
            <Link href="/quickstart" className="btn btn-primary" data-lf="quickstart-cta">
              Quick start
              <Arrow />
            </Link>
            <a
              href="https://github.com/zvndev/turbine-orm"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost"
              data-lf="github-cta"
            >
              GitHub
            </a>
            <Link href="/queries" className="btn btn-ghost">
              API reference
            </Link>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  );
}
