/**
 * Create the single post that gets hammered. The counter starts at 0.
 */
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

async function seed() {
  await client.connect();
  await client.query('TRUNCATE posts RESTART IDENTITY CASCADE');
  await client.query(
    "INSERT INTO posts (id, title, likes_count) VALUES (1, 'The button', 0)",
  );
  await client.query("SELECT setval('posts_id_seq', 1, true)");
  console.log('Seeded: post id=1, likes_count=0');
  await client.end();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
