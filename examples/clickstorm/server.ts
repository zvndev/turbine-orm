/**
 * Clickstorm server — two routes that both increment the same counter.
 *
 *   POST /like/safe    → atomic:  { likesCount: { increment: 1 } }
 *   POST /like/unsafe  → naive:   findUnique + update({ set: current + 1 })
 *
 * Run the load test against both. The /safe counter is always correct.
 * The /unsafe counter loses a sizable chunk of writes because of the
 * classic read-modify-write race.
 *
 * Start with `npm start`, then in another terminal: `npm run storm`.
 */

import { createServer } from 'node:http';
import { DeadlockError, SerializationFailureError, TurbineClient } from 'turbine-orm';
import { SCHEMA } from './generated/turbine/metadata.js';

const db = new TurbineClient(
  { connectionString: process.env.DATABASE_URL, max: 20 },
  SCHEMA,
);

const POST_ID = 1;

/**
 * Atomic path: compiles to
 *   UPDATE posts SET likes_count = likes_count + $1 WHERE id = $2
 * — race-free no matter how many concurrent callers hit it.
 */
async function likeSafe() {
  return withRetry(() =>
    db.posts.update({
      where: { id: POST_ID },
      data: { likesCount: { increment: 1 } },
    }),
  );
}

/**
 * Naive path: read the current count, bump it locally, write it back.
 * Two clients racing will both read the same value and one write gets lost.
 */
async function likeUnsafe() {
  const post = await db.posts.findUniqueOrThrow({ where: { id: POST_ID } });
  await db.posts.update({
    where: { id: POST_ID },
    data: { likesCount: post.likesCount + 1 },
  });
}

/**
 * Retry loop — only catches Turbine's typed retryable errors.
 * `isRetryable` is a `const` property on DeadlockError / SerializationFailureError,
 * so this is a clean discriminator instead of matching pg error code strings.
 */
async function withRetry<R>(fn: () => Promise<R>, attempts = 5): Promise<R> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (
        (err instanceof DeadlockError || err instanceof SerializationFailureError) &&
        err.isRetryable
      ) {
        continue;
      }
      throw err;
    }
  }
  throw new Error(`exhausted ${attempts} retries`);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/like/safe') {
      await likeSafe();
      res.writeHead(200).end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/like/unsafe') {
      await likeUnsafe();
      res.writeHead(200).end('{"ok":true}');
      return;
    }
    if (req.method === 'GET' && req.url === '/count') {
      const post = await db.posts.findUniqueOrThrow({ where: { id: POST_ID } });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ likesCount: post.likesCount }));
      return;
    }
    if (req.method === 'POST' && req.url === '/reset') {
      await db.posts.update({
        where: { id: POST_ID },
        data: { likesCount: { set: 0 } },
      });
      res.writeHead(200).end('{"ok":true}');
      return;
    }
    res.writeHead(404).end();
  } catch (err) {
    console.error(err);
    res.writeHead(500).end(JSON.stringify({ error: String(err) }));
  }
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => {
  console.log(`Clickstorm server on http://localhost:${PORT}`);
  console.log('  POST /like/safe    — atomic increment (race-free)');
  console.log('  POST /like/unsafe  — read-modify-write (races)');
  console.log('  GET  /count        — current likesCount');
  console.log('  POST /reset        — zero the counter');
  console.log();
  console.log('Run `npm run storm` to fire the load test.');
});
