import type { Metadata } from 'next';
import Link from 'next/link';
import { codeToHtml } from 'shiki';
import { CopyButton } from '../components/CopyButton';
import { HERO_TAGLINE } from '../lib/tagline';
import { TURBINE_MINOR } from '../lib/version';

export const metadata: Metadata = {
  title: 'Turbine ORM: a Postgres ORM written from scratch. One dependency.',
  description:
    'Typed queries compiled straight to SQL: no query engine, no WASM, one runtime dependency (pg). Nested relations in one statement, an 11-tool read-only MCP server for coding agents, offline index advice, and migration guards. MIT.',
};

const heroCode = `const users = await db.users.findMany({
  where: { orgId: 1 },
  with: {
    posts: {
      with: { comments: { with: { author: true } } },
      orderBy: { createdAt: 'desc' },
      limit: 5,
    },
  },
});

// One SQL statement, any depth, typed end to end:
users[0].posts[0].comments[0].author.name
//                                  ^ autocompletes

// Everything between your code and Postgres:
//   "dependencies": { "pg": "^8.13.1" }`;

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

const pillars = [
  {
    title: 'Written from scratch, on pg alone',
    description:
      'No query engine, no WASM compiler, no query-builder library underneath. Query compilation is plain string building into a bounded LRU of SQL templates, and dependencies is one line: pg. The optional engines (SQLite, MySQL, SQL Server, PowDB) are peer dependencies or Node builtins you install only if you use them.',
    stat: '1',
    statLabel: 'runtime dependency',
  },
  {
    title: 'Nested relations, one statement',
    description:
      'A with clause compiles to correlated json_agg subqueries, so users with posts with comments is one round trip. The result is typed end to end at any depth, with no manual annotation. Four load strategies produce identical rows: join, batched and auto are held to byte-identical output by a differential fuzz suite, flatten by its own parity suite.',
    stat: '1',
    statLabel: 'query, any depth',
  },
  {
    title: 'Close to hand-written SQL',
    description:
      'In the last published run, Turbine ran at 1.08x a hand-written pg control by geometric mean, where Drizzle ran at 1.47x and Prisma at 1.81x. Losses are published with the wins: the row-at-a-time streaming API still trails the Drizzle 1.0 release candidate, and the benchmarks page states the noise floor next to the numbers.',
    stat: '1.08x',
    statLabel: 'vs raw pg (last run)',
  },
  {
    title: 'Small enough for the edge',
    description:
      'The main entry is held under 87 kB brotli as an import graph with pg external, the edge entry under 69 kB, enforced by size-limit in CI. One import swap runs the same API on Neon, Vercel Postgres, Cloudflare Hyperdrive, and Supabase. No separate serverless build, no WASM bundle in your cold start.',
    stat: '87 kB',
    statLabel: 'CI-enforced ceiling',
  },
  {
    title: 'MIT, no cloud tier',
    description:
      'Studio, doctor, the MCP server, observability: everything named on this site is in the npm package. No paid tier, no telemetry, no account. All SQL generation routes through a documented Dialect contract, so if you need an engine Turbine does not ship, you extend the seam instead of forking the core.',
    stat: 'MIT',
    statLabel: 'everything in the box',
  },
];

const agentTools = [
  ['relation_graph', 'The whole relation graph, or one table’s subtree: cardinality, keys, junction tables.'],
  ['find_join_path', 'How to get from comments to orgs: the relation chain and the with clause to write.'],
  ['table_stats', 'Planner row estimate, on-disk size, indexes. Reports analyzed: false instead of guessing 0.'],
  ['explain_query', 'EXPLAIN for a schema-validated findMany plan. No free-form SQL input exists.'],
  ['explain_error', 'A Turbine error code mapped to cause, fix, and docs link.'],
  ['sample_rows', 'Up to 50 rows, PII-tagged columns redacted before they reach the model.'],
  ['compile_query', 'The exact SQL a read query compiles to, without running it. Zero database writes, zero execution.'],
];

const safetyFeatures = [
  {
    title: 'The database UI is read-only by default',
    description:
      'npx turbine studio binds loopback, authenticates with a per-process token, and runs every read inside BEGIN READ ONLY. Without --write, the write endpoints do not exist in the router, so there is nothing to bypass. There is no raw-SQL surface: queries are composed in a builder validated identifier by identifier. Try it with no database: npx turbine-orm@latest studio --demo.',
    stat: '0',
    statLabel: 'write endpoints by default',
  },
  {
    title: 'PII is enforced in the emitted SQL',
    description:
      'Tag a column pii: true and it is excluded from every default projection at the SQL level: RETURNING "id", "name" instead of RETURNING *. It is also refused as a groupBy key and a _min / _max target. Reading it back takes includePii: UNSAFE, a symbol, so a request body spread into query args cannot unlock it: JSON.parse cannot produce a symbol.',
    stat: 'pii: true',
    statLabel: 'enforced in the projection',
  },
  {
    title: 'Errors carry keys, never values',
    description:
      'A NotFoundError says where: { id, email } without printing the email. A UniqueConstraintError names the column that conflicted. Errors are safe to forward to your tracker with no scrubbing rule, and the full where object stays available as err.where in code.',
    stat: 'keys',
    statLabel: 'not values',
  },
  {
    title: 'Destructive migrations need consent',
    description:
      'migrate up, migrate down and push scan for DROP TABLE, DROP COLUMN, TRUNCATE, unqualified DELETE and UPDATE, and ALTER COLUMN ... TYPE, print an itemized report, and refuse to run. Interactively you type "destroy my data", then yes; in CI you pass --allow-destructive. A refused batch applies nothing. Migrations are SQL, checksummed with SHA-256.',
    stat: 'SHA-256',
    statLabel: 'checksums + refusal',
  },
  {
    title: 'Index advice, offline',
    description:
      'Turbine loads relations as correlated subqueries, so an unindexed FK is a scan per parent row. npx turbine doctor reports every relation column set with no covering index, with a cost tier per finding, and --fix writes the migration. It reads your schema and your database’s own statistics: no cloud service, no account.',
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
      'Postgres pub/sub with db.$listen(channel, handler) and db.$notify(channel, payload). No broker, no extra service: your database is the message bus.',
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
      "where: { body: { search: 'postgres & orm' } } compiles to to_tsvector @@ to_tsquery with the query bound as a parameter. Pick any text search config.",
    href: '/queries#full-text-search',
    cta: 'Operator docs',
  },
  {
    title: 'Many-to-many, auto-detected',
    description:
      'Pure junction tables are detected at generate time, so db.posts.findMany({ with: { tags: true } }) needs no declaration. A self-referencing FK gives you parent and children.',
    href: '/relations',
    cta: 'Relations docs',
  },
  {
    title: 'Real pipelining',
    description:
      'db.pipeline(...) uses the extended-query protocol (Parse/Bind/Execute/Sync) to put N queries in one TCP flush. Wire pipelining, not a batch transaction. Write builders batch too.',
    href: '/transactions',
    cta: 'Pipeline docs',
  },
];

const capabilities = [
  {
    title: 'Streaming with a true cursor',
    description:
      'findManyStream iterates any result set with constant memory over DECLARE CURSOR, on a dedicated connection. Any orderBy, safe early break, nested with per batch.',
    href: '/queries#findmanystream',
    cta: 'Streaming docs',
  },
  {
    title: 'Global filters and the UNSAFE symbol',
    description:
      'Soft delete and multi-tenancy as client config: a WhereClause AND-merged into every query on a table. Opting out takes a symbol JSON.parse cannot produce, so a spread request body cannot disable tenancy.',
    href: '/global-filters',
    cta: 'Global filters docs',
  },
  {
    title: 'Multi-engine, one typed API',
    description:
      'The same findMany / with / where surface runs on SQLite (node:sqlite, zero installs), MySQL 8, SQL Server, and PowDB through subpath exports. Postgres-only features throw a typed error instead of degrading silently.',
    href: '/engines',
    cta: 'Engines docs',
  },
  {
    title: 'explain() without dropping to raw',
    description:
      'Every table accessor has explain(args): it compiles the exact statement findMany(args) would run and returns the engine plan. Verify the query the ORM emits hits the index you expect.',
    href: '/queries#explain',
    cta: 'explain() docs',
  },
  {
    title: 'Observability, in the box',
    description:
      'db.$on("query") taps every query with params redacted by default. db.$observe() flushes p50/p95/p99 aggregates to Postgres, and npx turbine observe is the dashboard. No agent, no SaaS.',
    href: '/observability',
    cta: 'Observability docs',
  },
  {
    title: 'Typed errors with stable codes',
    description:
      'Every error carries a code (TURBINE_E001..E018) and a docs link. Retryable failures expose isRetryable: true as a typed const, so a retry loop is compiler-checked.',
    href: '/errors',
    cta: 'Error reference',
  },
  {
    title: 'Coming from Prisma? Keep your call sites.',
    description:
      'turbine migrate-from-prisma reads schema.prisma and emits a typed mapping. createPrismaCompatClient then wraps Turbine in a PrismaClient-shaped surface, so prisma.user.findMany({ include }) keeps working while you port module by module.',
    href: '/migrate-from-prisma',
    cta: 'Prisma migration guide',
  },
  {
    title: 'Coming from Drizzle?',
    description:
      'The API mapping, the schema translation, and the behavioural differences worth auditing before you cut over: the empty-where guard, relation declaration, and differing defaults.',
    href: '/migrate-from-drizzle',
    cta: 'Drizzle migration guide',
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
      'A Postgres ORM written from scratch with one runtime dependency (pg). Typed queries compiled straight to SQL, nested relations in one statement, an 11-tool read-only MCP server for coding agents, offline index advice from turbine doctor, and destructive-migration guards. Runs on the edge under a CI-enforced size budget. MIT.',
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
            <span className="text-white">A Postgres ORM written from scratch.</span>
            <br />
            <span className="amber">One dependency.</span>
          </h1>

          <p className="hero-subtitle animate-fade-in-up delay-2">
            Turbine compiles typed queries straight to SQL: no query engine, no
            WASM, nothing between your code and Postgres but <code>pg</code>.
            Nested relations resolve in one statement. Small enough for a
            Worker, close enough to hand-written SQL that the benchmarks
            publish the control arm, and built so a coding agent can explore
            your schema through read-only tools instead of guessing. MIT, with
            the engine seam documented if you want to fork it.
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
            makes the case, and says what is not a reason to switch.
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

      {/* ========== THE PILLARS ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">What you are actually installing</p>
          <h2 className="section-title">Five claims, each checkable.</h2>
          <p
            style={{
              maxWidth: '48rem',
              marginTop: '0.75rem',
              color: 'var(--text-secondary)',
              fontSize: '0.95rem',
              lineHeight: 1.7,
            }}
          >
            Every number here traces to a source you can run: the benchmark
            results file, the size-limit config in CI, or the package&apos;s own{' '}
            <code>dependencies</code> field. Nothing on this page is a mood.
          </p>
        </div>

        <div className="feature-grid">
          {pillars.map((f, i) => (
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

      {/* ========== AGENTS ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">Point an agent at it</p>
          <h2 className="section-title">
            Typed tools for agents, not a SQL prompt.
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
            <code>npx turbine mcp</code> ships in the package: a read-only MCP
            server with eleven tools, every one running inside{' '}
            <code>BEGIN READ ONLY</code> with PII-tagged columns redacted before
            rows reach a model. An agent explores the schema, finds the join
            path, checks the plan, and reads the error catalog through typed
            tools. It cannot write, and there is no free-form SQL input to talk
            it into. The rest is structural: typed query args turn a wrong
            query into a compile error an agent can read, and stable error
            codes give it something to branch on.
          </p>
        </div>

        <div className="feature-grid">
          {agentTools.map(([name, desc], i) => (
            <div
              key={name}
              className={`feature-card animate-fade-in-up delay-${i + 1}`}
            >
              <h3 className="font-mono">{name}</h3>
              <p>{desc}</p>
            </div>
          ))}
        </div>

        <p
          style={{
            marginTop: '1.25rem',
            color: 'var(--text-secondary)',
            fontSize: '0.9rem',
          }}
        >
          Plus <code>schema_overview</code>, <code>table_detail</code>,{' '}
          <code>migrate_status</code>, and <code>doctor_report</code>. Setup for
          Claude Code and Cursor, a drop-in instructions snippet, and{' '}
          <code>llms.txt</code>:{' '}
          <Link href="/ai-agents" style={{ color: 'var(--accent)' }}>
            Turbine for AI agents
          </Link>
          .
        </p>
      </section>

      {/* ========== SAFETY DEFAULTS ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">Designed for a database with real rows in it</p>
          <h2 className="section-title">
            The dangerous operations ask first.
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
            The same posture the agent tools inherit, applied everywhere: reads
            are safe by construction, and anything that can lose or leak data
            requires an explicit, unspoofable opt-in.
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
          <p className="section-label">Postgres-first underneath</p>
          <h2 className="section-title">
            The parts other ORMs push to raw SQL are typed here.
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

      {/* ========== CAPABILITIES ========== */}
      <section className="features-section">
        <div className="animate-fade-in-up">
          <p className="section-label">And the rest of the box</p>
          <h2 className="section-title">
            Tooling your DBA will sign off on.
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
                A nested read is one statement, at any depth. Turbine compiles{' '}
                <code>with</code> into correlated <code>json_agg</code> +{' '}
                <code>json_build_array</code> subqueries, so ten users with
                their posts and each post&apos;s comments is a single round
                trip, not an N+1 cascade. The default <code>auto</code>{' '}
                strategy keeps that plan, falling back to one flat follow-up
                statement for a relation whose correlation column has no
                covering index. The rows are identical either way.
              </p>
              <p>
                The part that takes the work is staying correct at depth: an
                empty relation returns <code>[]</code> and never{' '}
                <code>null</code>, per-relation <code>limit</code> and{' '}
                <code>orderBy</code> apply per parent rather than to the whole
                result, and every type survives the JSON round trip, dates
                included. The join, batched and auto strategies are held to
                byte-identical output by a differential fuzz suite, and flatten
                to the same parity by its own suite.
              </p>

              <ul className="showcase-list">
                <li>
                  <span className="check">&#10003;</span>
                  <span>Correlated subqueries with json_agg + json_build_array</span>
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
                  'under 87 KB import graph, pg external',
                  '~1.6 MB client (TS/WASM compiler)',
                  '~7 KB core',
                ],
                ['Studio', 'Read-only by default', 'Full CRUD, cloud-hosted', 'Drizzle Studio (free)'],
                ['Index advice', 'turbine doctor, offline, --fix', 'Optimize retired (cloud Query Insights)', 'None'],
                ['MCP server for agents', '11 read-only tools, PII-redacted', 'Official MCP server', 'drizzle-kit mcp'],
                ['Error PII safety', 'Keys only by default', 'Values in messages', 'Raw pg errors'],
                ['Migrations', 'SQL-first, SHA-256 drift detection', 'DSL-generated, shadow DB', 'SQL or Drizzle Kit'],
                ['Edge runtime', 'One import swap, under 69 KB brotli', 'Driver adapter + WASM compiler', 'Native'],
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
          Competitor columns last checked August 2026, against Prisma 7 and
          Drizzle 0.45. Features marked Preview may change, and bundle sizes
          move release to release. The longer version of this argument,
          including what is not a reason to switch, is on{' '}
          <Link href="/why-turbine" style={{ color: 'var(--accent)' }}>
            Why Turbine
          </Link>
          ; performance claims are measured on the{' '}
          <Link href="/benchmarks" style={{ color: 'var(--accent)' }}>
            benchmarks page
          </Link>
          .
        </p>
      </section>

      {/* ========== CTA ========== */}
      <section className="cta-section">
        <h2>Start building</h2>
        <p>
          One install, one generate, one query. A typed Postgres client in
          under two minutes.
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
          <Link href="/ai-agents" className="cta-btn cta-btn-secondary">
            For AI agents
          </Link>
        </div>
      </section>

      {/* ========== FOOTER ========== */}
      <footer className="landing-footer">
        <p>
          One dependency. No WASM. MIT. Built by{' '}
          <a href="https://github.com/zvndev" target="_blank" rel="noopener noreferrer">
            ZVN
          </a>
        </p>
      </footer>
    </div>
  );
}
