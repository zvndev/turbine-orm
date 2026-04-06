import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

const orgs = [
  { name: 'Acme Corp', slug: 'acme', plan: 'enterprise' },
  { name: 'Widgets Inc', slug: 'widgets', plan: 'pro' },
  { name: 'Startup Co', slug: 'startup', plan: 'free' },
];

const users = [
  { name: 'Alice Chen', email: 'alice@acme.com', role: 'admin', orgSlug: 'acme' },
  { name: 'Bob Park', email: 'bob@acme.com', role: 'editor', orgSlug: 'acme' },
  { name: 'Carol Diaz', email: 'carol@acme.com', role: 'member', orgSlug: 'acme' },
  { name: 'Dave Kim', email: 'dave@widgets.com', role: 'admin', orgSlug: 'widgets' },
  { name: 'Eve Santos', email: 'eve@widgets.com', role: 'editor', orgSlug: 'widgets' },
  { name: 'Frank Wu', email: 'frank@widgets.com', role: 'member', orgSlug: 'widgets' },
  { name: 'Grace Lee', email: 'grace@startup.com', role: 'admin', orgSlug: 'startup' },
  { name: 'Hank Patel', email: 'hank@startup.com', role: 'editor', orgSlug: 'startup' },
  { name: 'Iris Nguyen', email: 'iris@startup.com', role: 'member', orgSlug: 'startup' },
  { name: 'Jack Rivera', email: 'jack@acme.com', role: 'member', orgSlug: 'acme' },
  { name: 'Kate Miller', email: 'kate@widgets.com', role: 'member', orgSlug: 'widgets' },
  { name: 'Leo Foster', email: 'leo@startup.com', role: 'member', orgSlug: 'startup' },
];

const postTitles = [
  'Getting started with Turbine ORM',
  'Why single-query nested relations matter',
  'PostgreSQL json_agg deep dive',
  'Migrating from Prisma to Turbine',
  'Building a REST API with Turbine',
  'Type-safe database queries in TypeScript',
  'Understanding cursor-based pagination',
  'Streaming large datasets with PostgreSQL cursors',
  'Transaction patterns for Node.js apps',
  'Schema-first vs code-first ORMs',
  'How Turbine generates SQL',
  'Benchmarking ORMs: methodology matters',
  'Pipeline batching explained',
  'Raw SQL when you need it',
  'From zero to production with Turbine',
  'Working with JSONB in Turbine',
  'The case for PostgreSQL-only ORMs',
  'Middleware patterns for query logging',
  'Auto-diff migrations: how they work',
  'Optimizing findMany for large tables',
];

const commentBodies = [
  'Great article! This helped me understand the architecture.',
  'I had the same issue. The json_agg approach is elegant.',
  'Have you benchmarked this against raw SQL? Curious about the overhead.',
  'We switched to this pattern last month and saw a 40% reduction in query count.',
  'The code examples are really clear, thanks for sharing.',
  'One thing to note: LIMIT in nested subqueries is important for large datasets.',
  'This is exactly what I was looking for.',
  'Could you expand on the cursor-based pagination section?',
  'We use a similar approach at our company. Works great at scale.',
  'Thanks! Bookmarked for reference.',
];

async function seed() {
  await client.connect();

  console.log('Seeding database...\n');

  // Insert organizations
  const orgIds: Record<string, number> = {};
  for (const org of orgs) {
    const result = await client.query(
      'INSERT INTO organizations (name, slug, plan) VALUES ($1, $2, $3) ON CONFLICT (slug) DO UPDATE SET name = $1 RETURNING id',
      [org.name, org.slug, org.plan],
    );
    orgIds[org.slug] = result.rows[0].id;
    console.log(`  org: ${org.name} (id=${result.rows[0].id})`);
  }

  // Insert users
  const userIds: Record<string, number> = {};
  for (const user of users) {
    const orgId = orgIds[user.orgSlug];
    const result = await client.query(
      'INSERT INTO users (email, name, role, org_id) VALUES ($1, $2, $3, $4) ON CONFLICT (email) DO UPDATE SET name = $2 RETURNING id',
      [user.email, user.name, user.role, orgId],
    );
    userIds[user.email] = result.rows[0].id;
    console.log(`  user: ${user.name} (id=${result.rows[0].id})`);
  }

  // Insert posts
  const postIds: number[] = [];
  const userEmails = Object.keys(userIds);
  for (let i = 0; i < postTitles.length; i++) {
    const email = userEmails[i % userEmails.length]!;
    const userId = userIds[email]!;
    const orgSlug = users.find((u) => u.email === email)!.orgSlug;
    const orgId = orgIds[orgSlug]!;
    const published = Math.random() > 0.2;
    const viewCount = Math.floor(Math.random() * 500);
    const content = `This is the content for "${postTitles[i]}". It covers important concepts and practical examples that developers can use in their projects.`;

    const result = await client.query(
      'INSERT INTO posts (title, content, published, view_count, user_id, org_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [postTitles[i], content, published, viewCount, userId, orgId],
    );
    postIds.push(result.rows[0].id);
    console.log(`  post: ${postTitles[i]!.slice(0, 40)}... (id=${result.rows[0].id})`);
  }

  // Insert comments
  let commentCount = 0;
  for (const postId of postIds) {
    const numComments = Math.floor(Math.random() * 5) + 1;
    for (let i = 0; i < numComments; i++) {
      const email = userEmails[Math.floor(Math.random() * userEmails.length)]!;
      const userId = userIds[email]!;
      const body = commentBodies[Math.floor(Math.random() * commentBodies.length)]!;

      await client.query(
        'INSERT INTO comments (body, user_id, post_id) VALUES ($1, $2, $3)',
        [body, userId, postId],
      );
      commentCount++;
    }
  }
  console.log(`  comments: ${commentCount} total`);

  console.log('\nDone!');
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
