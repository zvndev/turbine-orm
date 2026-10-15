import type { Metadata } from 'next';
import Link from 'next/link';
import { codeToHtml } from 'shiki';
import { CodeTabs } from '../components/CodeTabs';
import { CopyButton } from '../components/CopyButton';
import { HeroFallback } from '../components/hero/HeroFallback';
import { HeroStage } from '../components/hero/HeroStage';
import { SiteFooter, SiteHeader } from '../components/SiteChrome';

export const metadata: Metadata = {
  title: 'Turbine ORM: raw SQL speed, zero raw SQL',
  description:
    'The TypeScript ORM for Postgres that runs within 8% of hand-written SQL. A whole page of nested data in one round trip, types down to the last relation, one dependency, and tools for your coding agent. MIT.',
};

/*
 * Every figure on this page has a source in the repo:
 *   8%, 2.02x, 1.46x, the bars: benchmarks/RESULTS-0.71.0.md
 *   7.16x, 24 ms vs 172 ms:    benchmarks/RESULTS-NETWORK-0.78.0.md
 *   97% (up from 73%):         evals/AGENT-EVAL-0.73.0.md, CHANGELOG 0.73.0
 *   streaming loss:            CHANGELOG 0.76.0
 */

const examples = [
  {
    label: 'Read',
    file: 'feed.ts',
    caption: 'A user, their five latest posts and every comment with its author. One round trip, typed to the last field.',
    code: `const feed = await db.users.findMany({
  where: { orgId },
  with: {
    posts: {
      orderBy: { createdAt: 'desc' },
      limit: 5,
      with: { comments: { with: { author: true } } },
    },
  },
});

feed[0].posts[0].comments[0].author.name; // string, autocompleted`,
  },
  {
    label: 'Write',
    file: 'signup.ts',
    caption: 'A user and their first posts in one call. If any row fails, none of them are written.',
    code: `const user = await db.users.create({
  data: {
    email: 'ada@example.com',
    name: 'Ada',
    posts: {
      create: [{ title: 'Hello, Postgres' }, { title: 'Second post' }],
    },
  },
});`,
  },
  {
    label: 'Transactions',
    file: 'checkout.ts',
    caption: 'All or nothing. If anything inside throws, none of it happened.',
    code: `await db.$transaction(async (tx) => {
  const order = await tx.orders.create({ data: { userId, total } });

  await tx.users.update({
    where: { id: userId },
    data: { credits: { decrement: total } },
  });

  return order;
});`,
  },
  {
    label: 'Vectors',
    file: 'search.ts',
    caption: 'Nearest-neighbour search on pgvector. Your AI features, without a second database.',
    code: `const similar = await db.docs.findMany({
  where: { workspaceId },
  orderBy: {
    embedding: { distance: { to: queryVector, metric: 'cosine' } },
  },
  limit: 5,
});`,
  },
  {
    label: 'Stream',
    file: 'export.ts',
    caption: 'Millions of rows in constant memory. Break out early and the cursor closes itself.',
    code: `for await (const order of db.orders.findManyStream({
  where: { status: 'paid' },
  orderBy: { id: 'asc' },
})) {
  await invoices.send(order);
}`,
  },
];

const stats = [
  { value: '8%', label: 'from raw SQL speed', note: 'geometric mean, see benchmarks' },
  { value: '1', label: 'round trip for nested data', note: 'no N+1, no waterfalls' },
  { value: 'pg', label: 'the only dependency', note: 'no engine, no WASM' },
  { value: '97%', label: 'agent first-try pass rate', note: 'with the bundled agent skill' },
];

const pains = [
  {
    pain: 'Forty queries to render one page.',
    fix: 'Ask for users, their posts and every comment in one call. It all comes back in one round trip, already nested and typed.',
  },
  {
    pain: 'One bad filter away from an empty table.',
    fix: 'An update or delete with an empty or always-true filter throws instead of running. Doing it on purpose takes a flag no request body can fake.',
  },
  {
    pain: 'A slow query nobody can explain.',
    fix: 'Print any query before it runs, pull its plan from your code, and let turbine doctor find the index you forgot.',
  },
  {
    pain: 'Dependencies you never asked for.',
    fix: (
      <>
        Turbine&apos;s entire dependency list is <code>{'"pg": "^8.15.0"'}</code>. No engine binary, nothing to keep in
        sync, and it runs on Node, Vercel Edge, Cloudflare Workers and Deno Deploy.
      </>
    ),
  },
];

const bars = [
  { name: 'hand-written SQL', ratio: 1.0, tone: 'base' },
  { name: 'Turbine', ratio: 1.08, tone: 'lead' },
  { name: 'Drizzle', ratio: 1.47, tone: 'other' },
  { name: 'Prisma', ratio: 1.81, tone: 'other' },
];

const agentPowers = [
  {
    title: 'It knows your schema',
    body: 'Every table, every relation, and the path from one to another. No guessing at column names.',
    tools: ['schema_overview', 'relation_graph', 'find_join_path'],
  },
  {
    title: 'It checks before it runs',
    body: 'Your agent can compile a query and read its plan before it ever runs it.',
    tools: ['compile_query', 'explain_query'],
  },
  {
    title: 'It looks, it never touches',
    body: 'Every tool is read-only, and private columns are redacted before the model sees a single row.',
    tools: ['sample_rows', 'table_stats'],
  },
  {
    title: 'It fixes its own mistakes',
    body: 'Every error code comes with its cause and the fix, so your agent can recover without asking you.',
    tools: ['explain_error', 'doctor_report'],
  },
];

const safety = [
  {
    title: 'No accidental wipes',
    body: 'Delete or update with an empty filter and Turbine throws instead of emptying the table. Meant it? There is a flag for that, and a request body cannot set it.',
  },
  {
    title: 'Private columns stay private',
    body: 'Mark a column as PII and it stays out of query results, Studio and your agent until you explicitly ask for it.',
  },
  {
    title: 'Migrations that ask first',
    body: 'Dropping a table or a column waits until you type "destroy my data". In CI you pass a flag, on purpose.',
  },
  {
    title: 'Errors you can ship anywhere',
    body: 'Error messages name the fields, never the values, so they go straight to your error tracker without a scrubbing rule.',
  },
  {
    title: 'A data browser that can’t break things',
    body: 'turbine studio is read-only unless you start it with --write. Try the demo, no database needed.',
  },
  {
    title: 'It finds your missing indexes',
    body: 'turbine doctor spots every relation without an index, ranks them by cost and writes the migration for you.',
  },
];

const inTheBox = [
  { title: 'Vector search', body: 'Similarity search on pgvector for your AI features.', href: '/vector' },
  { title: 'Realtime events', body: 'Push events between servers through Postgres. No Redis.', href: '/realtime' },
  { title: 'Full-text search', body: 'Real search over your text columns. No search cluster to run.', href: '/filtering#full-text-search' },
  { title: 'Row-level security', body: 'Let Postgres decide who sees which rows.', href: '/transactions' },
  { title: 'Batched queries', body: 'Send a whole dashboard of queries in one round trip.', href: '/transactions' },
  { title: 'Streaming', body: 'Walk millions of rows without running out of memory.', href: '/queries#findmanystream' },
  { title: 'Soft delete and tenancy', body: 'Set a filter once and every query on the table respects it.', href: '/global-filters' },
  { title: 'Query plans', body: 'Ask Postgres why a query is slow, right from your code.', href: '/client#explain' },
  { title: 'Metrics', body: 'Latency percentiles and a local dashboard. No SaaS.', href: '/observability' },
  { title: 'Typed errors', body: 'Every error has a code and a link to the fix.', href: '/errors' },
  { title: 'Many-to-many', body: 'Join tables found and wired up for you.', href: '/relations' },
  { title: 'More databases', body: 'SQLite, MySQL and SQL Server when you need them.', href: '/engines' },
];

export default async function Home() {
  const tabs = await Promise.all(
    examples.map(async ({ code, ...rest }) => ({
      ...rest,
      html: await codeToHtml(code, { lang: 'typescript', theme: 'github-dark-dimmed' }),
    })),
  );

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'Turbine ORM',
    description:
      'The TypeScript ORM for Postgres that runs within 8% of hand-written SQL. Nested data in one round trip, types down to the last relation, one dependency (pg), and read-only tools for coding agents. MIT.',
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
            <p className="eyebrow">The TypeScript ORM for Postgres</p>
            <h1 id="hero-title" className="hero-title">
              Raw SQL speed.
              <br />
              <span className="hero-title-accent">Zero raw SQL.</span>
            </h1>

            <p className="hero-lede">
              Turbine is the TypeScript ORM that keeps up with Postgres. Your data arrives in one round trip, every
              field is typed down to the last relation, and the only thing you install is <code>pg</code>.
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
                Get started
                <Arrow />
              </Link>
              <Link href="/benchmarks" className="btn btn-ghost">
                See the benchmarks
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
              Stop fighting your ORM.
            </h2>
            <p className="section-lede">
              The things that make database code slow, scary and hard to debug, fixed at the source.
            </p>
          </header>
          <ul className="pain-grid">
            {pains.map((p) => (
              <li key={p.pain} className="pain-card">
                <p className="pain">{p.pain}</p>
                <p className="fix">{p.fix}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ========== THE API ========== */}
        <section className="section api-layout" aria-labelledby="api-title">
          <header className="section-head">
            <p className="eyebrow">The API</p>
            <h2 id="api-title" className="section-title">
              The API you already know.
              <br />
              The speed you never got.
            </h2>
            <p className="section-lede">
              If you have written Prisma, you can write Turbine today: <code>findMany</code>, <code>where</code>,{' '}
              <code>with</code>, <code>create</code>. The difference is what happens after you hit save.
            </p>
          </header>
          <CodeTabs tabs={tabs} />
        </section>

        {/* ========== BENCHMARKS ========== */}
        <section className="section" aria-labelledby="bench-title">
          <header className="section-head">
            <p className="eyebrow">Benchmarks</p>
            <h2 id="bench-title" className="section-title">
              2x faster than Prisma.
              <br />
              1.46x faster than Drizzle.
            </h2>
            <p className="section-lede">
              Same schema, same data, same connection pool, ten real query shapes. Turbine lands within 8% of SQL
              written by hand. We publish where we lose, too.
            </p>
          </header>

          <div className="bench">
            <figure className="bench-chart">
              <figcaption>Time per query against hand-written SQL. Shorter is faster.</figcaption>
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
                <p className="note-figure">7x faster dashboards</p>
                <p>
                  Five dashboard queries sent as one batch instead of one at a time, over a real network link: 24 ms
                  instead of 172 ms.
                </p>
              </div>
              <div className="note note-loss">
                <p className="note-figure">Where we lose</p>
                <p>
                  Row-by-row streaming. Against Drizzle&apos;s 1.0 release candidate our per-row stream is 5 to 11%
                  slower. The batched stream ties.
                </p>
              </div>
            </div>
          </div>

          <p className="fineprint">
            Turbine 0.71.0, Prisma 7.9.1 and Drizzle 0.45.2 on local PostgreSQL 17.9: 1,000 users, 10,000 posts and
            50,000 comments, medians of three runs of 200 interleaved rounds, measured 2026-08-15. The bars are the
            geometric mean over the eight scenarios with a hand-written control; the headline compares all ten. The
            batch figure is Turbine 0.78.0 against itself on Neon. Method, raw data and noise floor on the{' '}
            <Link href="/benchmarks">benchmarks page</Link>.
          </p>
        </section>

        {/* ========== AGENTS ========== */}
        <section className="section" aria-labelledby="agents-title">
          <header className="section-head">
            <p className="eyebrow">For coding agents</p>
            <h2 id="agents-title" className="section-title">
              Let your agent drive.
              <br />
              Turbine keeps it on the track.
            </h2>
            <p className="section-lede">
              Turbine ships an agent skill and an MCP server for Claude Code, Cursor and the rest. With the skill
              installed, agents wrote correct Turbine queries on the first try 97% of the time, up from 73%.
            </p>
          </header>
          <ul className="tool-grid">
            {agentPowers.map((p) => (
              <li key={p.title} className="tool">
                <h3 className="tool-title">{p.title}</h3>
                <p className="tool-body">{p.body}</p>
                <p className="tool-tags">
                  {p.tools.map((t) => (
                    <code key={t}>{t}</code>
                  ))}
                </p>
              </li>
            ))}
          </ul>
          <p className="section-link">
            <Link href="/ai-agents">
              Set it up in Claude Code or Cursor <Arrow />
            </Link>
          </p>
        </section>

        {/* ========== SAFETY ========== */}
        <section className="section" aria-labelledby="safety-title">
          <header className="section-head">
            <p className="eyebrow">Production-safe</p>
            <h2 id="safety-title" className="section-title">
              Safe to deploy on a Friday.
            </h2>
            <p className="section-lede">
              Anything that can lose or leak data asks first. Everything else just works.
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
            <p className="eyebrow">In the box</p>
            <h2 id="box-title" className="section-title">
              Everything you used to drop to raw SQL for.
            </h2>
            <p className="section-lede">Typed, documented and free. No paid tier, no account, no telemetry.</p>
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

        {/* ========== SWITCHING ========== */}
        <section className="section" aria-labelledby="move-title">
          <header className="section-head">
            <p className="eyebrow">Switching</p>
            <h2 id="move-title" className="section-title">
              Move over one file at a time.
            </h2>
            <p className="section-lede">No big-bang rewrite. Your old queries keep running while the new ones land.</p>
          </header>
          <div className="move-grid">
            <Link href="/migrate-from-prisma" className="move-card">
              <span className="move-from">From Prisma</span>
              <span className="move-body">
                One command reads your <code>schema.prisma</code>. A compatibility client keeps most of your
                existing Prisma code running while you port at your own pace.
              </span>
              <span className="move-cta">
                Prisma migration guide <Arrow />
              </span>
            </Link>
            <Link href="/migrate-from-drizzle" className="move-card">
              <span className="move-from">From Drizzle</span>
              <span className="move-body">
                The Drizzle calls you use, mapped to Turbine, plus the behavior differences to check before you
                switch.
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
          <p>Install Turbine, point it at Postgres, and run your first typed query in minutes.</p>
          <div className="cta-actions">
            <Link href="/quickstart" className="btn btn-primary" data-lf="quickstart-cta">
              Get started
              <Arrow />
            </Link>
            <a
              href="https://github.com/zvndev/turbine-orm"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost"
              data-lf="github-cta"
            >
              Star on GitHub
            </a>
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
