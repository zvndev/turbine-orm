/**
 * Thread Machine — deep typed `with` inference in one query.
 *
 * This is the whole demo:
 *
 *   const stories = await db.stories.findMany({ with: { ... 4 levels ... } });
 *
 * After that single call, this chain autocompletes with zero casts:
 *
 *   stories[0].comments[0].replies[0].author.handle
 *          ^Story  ^Comment   ^Reply    ^User   ^string
 *
 * Try it yourself: hover any property in your editor. The whole tree is
 * inferred from the `with` clause — not from manual type assertions, not
 * from a separate relations declaration file.
 *
 * Run with `npm start`.
 */

import { TurbineClient } from 'turbine-orm';
import { SCHEMA } from './generated/turbine/metadata.js';

async function main() {
  const db = new TurbineClient(
    { connectionString: process.env.DATABASE_URL },
    SCHEMA,
  );

  console.time('load');

  // One query. Full object graph. Every level typed.
  const stories = await db.stories.findMany({
    where: { score: { gt: 50 } },
    orderBy: { score: 'desc' },
    limit: 10,
    with: {
      author: true,
      comments: {
        orderBy: { score: 'desc' },
        limit: 5,
        with: {
          author: true,
          replies: {
            orderBy: { score: 'desc' },
            limit: 3,
            with: { author: true },
          },
        },
      },
    },
  });

  console.timeEnd('load');
  console.log();

  // The payoff: every property below autocompletes in your editor.
  // Try it — put your cursor on `handle`, `body`, anything.
  for (const story of stories) {
    console.log(`\x1b[1m${story.score}  ${story.title}\x1b[0m`);
    console.log(`        by @${story.author.handle} · ${story.author.karma} karma`);

    for (const comment of story.comments) {
      console.log(`  [${comment.score}] @${comment.author.handle}: ${comment.body}`);

      for (const reply of comment.replies) {
        console.log(`      └ [${reply.score}] @${reply.author.handle}: ${reply.body}`);
      }
    }
    console.log();
  }

  // Bonus: relation filter. "Stories with at least one reply scoring > 10".
  const withHotReplies = await db.stories.count({
    where: {
      comments: { some: { replies: { some: { score: { gt: 10 } } } } },
    },
  });
  console.log(`\x1b[2m${withHotReplies} stories have a hot reply buried in them\x1b[0m`);

  await db.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
