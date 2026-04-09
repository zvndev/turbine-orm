/**
 * Seed a realistic HN-style dataset so the autocomplete chain has something
 * meaningful to render: 20 users, 15 stories, ~75 comments, ~150 replies.
 *
 * Run with `npm run db:seed`.
 */
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

const handles = [
  'patio11', 'dhh', 'tdd_guy', 'rust_evangelist', 'gvanrossum',
  'pg_truther', 'vercel_dev', 'edge_runtime', 'postgres_hacker', 'neon_dave',
  'typesafe_ts', 'drizzle_fan', 'prisma_survivor', 'kysely_purist', 'orm_agnostic',
  'schema_first', 'migration_hater', 'json_columns', 'pgbouncer_fan', 'hyperdrive_evangelist',
];

const storySeeds = [
  'Show HN: I built a Postgres ORM where types flow through nested relations',
  'Ask HN: What is the best Postgres driver for Cloudflare Workers in 2026?',
  'Streaming a million rows with constant memory — a deep dive',
  'Prisma 7 vs Drizzle v2 vs Turbine: honest benchmarks',
  'Why your ORM should have typed Postgres errors',
  'Edge runtime Postgres: the state of the art',
  'Pipeline batching: 8 queries, 1 round-trip',
  'The case against multi-database ORMs',
  'Atomic update operators are underrated',
  'Show HN: Thread Machine — HN clone in 120 lines of TS',
  'Postgres advisory locks for migration safety',
  'Cursor-based streaming vs keyset pagination',
  'Code-first vs schema-first: a 2026 retake',
  'Why I stopped fighting the database',
  'json_build_object is secretly amazing',
];

const commentSeeds = [
  'This is the kind of thing I wish I had three years ago.',
  'The type inference demo is genuinely wild.',
  'How does this compare to Drizzle with a full relations declaration?',
  'Does it work with PgBouncer transaction mode?',
  'Benchmarks please — local numbers do not count.',
  'I switched from Prisma last month, never looking back.',
  'The streaming story is what sold me.',
  'Typed errors with isRetryable is chef kiss.',
  'Finally, an ORM that respects Postgres.',
  'What about materialized views?',
];

const replySeeds = [
  'Same, the autocomplete chain is what made me stop scrolling.',
  'Yep, works fine with pgbouncer in session mode. Transaction mode needs a direct connection for streaming cursors.',
  'There is a reproducible benchmark suite in the repo.',
  'The edge story is the real headline for me.',
  'This is now my default pick for new projects.',
  '100% agree.',
  'Curious how it handles migrations under load.',
];

async function seed() {
  await client.connect();

  console.log('Seeding Thread Machine...\n');

  // Reset
  await client.query('TRUNCATE replies, comments, stories, users RESTART IDENTITY CASCADE');

  // Users
  const userIds: number[] = [];
  for (const handle of handles) {
    const karma = Math.floor(Math.random() * 10000);
    const result = await client.query(
      'INSERT INTO users (handle, karma) VALUES ($1, $2) RETURNING id',
      [handle, karma],
    );
    userIds.push(result.rows[0].id);
  }
  console.log(`  users: ${userIds.length}`);

  // Stories
  const storyIds: number[] = [];
  for (let i = 0; i < storySeeds.length; i++) {
    const authorId = userIds[i % userIds.length]!;
    const score = Math.floor(Math.random() * 500) + 10;
    const result = await client.query(
      'INSERT INTO stories (title, url, score, author_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [storySeeds[i], `https://news.example.com/${i}`, score, authorId],
    );
    storyIds.push(result.rows[0].id);
  }
  console.log(`  stories: ${storyIds.length}`);

  // Comments + replies
  let commentCount = 0;
  let replyCount = 0;
  for (const storyId of storyIds) {
    const numComments = Math.floor(Math.random() * 4) + 3;
    for (let i = 0; i < numComments; i++) {
      const body = commentSeeds[Math.floor(Math.random() * commentSeeds.length)]!;
      const authorId = userIds[Math.floor(Math.random() * userIds.length)]!;
      const score = Math.floor(Math.random() * 50) + 1;
      const commentResult = await client.query(
        'INSERT INTO comments (body, score, story_id, author_id) VALUES ($1, $2, $3, $4) RETURNING id',
        [body, score, storyId, authorId],
      );
      commentCount++;
      const commentId = commentResult.rows[0].id;

      const numReplies = Math.floor(Math.random() * 4);
      for (let j = 0; j < numReplies; j++) {
        const replyBody = replySeeds[Math.floor(Math.random() * replySeeds.length)]!;
        const replyAuthor = userIds[Math.floor(Math.random() * userIds.length)]!;
        const replyScore = Math.floor(Math.random() * 20) + 1;
        await client.query(
          'INSERT INTO replies (body, score, comment_id, author_id) VALUES ($1, $2, $3, $4)',
          [replyBody, replyScore, commentId, replyAuthor],
        );
        replyCount++;
      }
    }
  }
  console.log(`  comments: ${commentCount}`);
  console.log(`  replies: ${replyCount}`);

  console.log('\nDone!');
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
