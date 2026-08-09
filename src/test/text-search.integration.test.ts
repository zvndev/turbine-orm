/**
 * turbine-orm, full-text `search` against a real Postgres.
 *
 * text-search.test.ts is BUILD-ONLY: it asserts the SQL string and stops. So
 * until this file existed, the `to_tsvector(config, col) @@ to_tsquery(config,
 * $1)` clause had never been executed by a server anywhere in the suite, and
 * neither had the fixture: `grep -c tsvector src/test/fixtures/seed.sql`
 * returned 0. A generated clause that the server rejects, or that quietly
 * matches the wrong rows, would have shipped green.
 *
 * What is asserted here is the part a build-only test cannot reach:
 *
 *   - the statement PARSES and RUNS on a real backend, with the config as a
 *     literal inside the function call and the query as a bound `$1`;
 *   - it returns the right ROWS, not merely some rows;
 *   - `config` reaches the server and CHANGES the answer. `english` and
 *     `simple` disagree on the seeded data by one row, and the difference is
 *     stemming, which is the whole reason to use a tsvector at all rather than
 *     ILIKE;
 *   - `to_tsquery` boolean syntax (`&`, `!`) is the SERVER's, not something
 *     Turbine reinterprets.
 *
 * The seed carries two GIN expression indexes over exactly the expression this
 * filter emits (`idx_posts_title_fts` / `idx_posts_content_fts`). They are not
 * asserted on here: whether the planner picks them is its business, and pinning
 * a plan would make this a flaky test about statistics rather than a test about
 * results. They exist so the fixture models the shape a real application uses.
 *
 * Run against a Postgres seeded by src/test/fixtures/seed.sql:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/text-search.integration.test.ts
 *
 * Gated by DATABASE_URL: absent, every test reports as skipped (never failed).
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping text-search integration tests: DATABASE_URL not set');
}

interface Post {
  id: number;
  title: string;
  content: string;
  published: boolean;
}

let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

/**
 * The seeded fixture is posts 1 through 10 (see `src/test/fixtures/seed.sql`).
 * Every assertion below names an exact row set, so it has to see the seeded
 * corpus and nothing else: other files in this suite insert their own posts
 * into the same table and are not required to clean up after themselves, and
 * the runner executes files in one process at concurrency 1, so a stray row
 * whose title happens to match makes this file fail depending on WHICH files
 * ran before it. Bounding the id here keeps the search itself unconstrained,
 * which is the thing under test, while making the row set deterministic.
 */
const SEEDED_POSTS = 10;

/** Titles of the matching posts, sorted, so the assertion names actual rows. */
async function titles(where: Record<string, unknown>): Promise<string[]> {
  const rows = await db.table<Post>('posts').findMany({
    where: { ...(where as Record<string, unknown>), id: { lte: SEEDED_POSTS } } as never,
    limit: 50,
  });
  return rows.map((r) => r.title).sort();
}

describe('full-text search integration', () => {
  before(async () => {
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    await db.disconnect();
  });

  it('runs on the server and returns the matching rows', async () => {
    assert.deepEqual(await titles({ title: { search: 'editor' } }), ['Another Editor Post', 'Editor Post']);
  });

  it('searches a second column with the same filter', async () => {
    assert.deepEqual(await titles({ content: { search: 'wrote' } }), ['Another Editor Post', 'Editor Post']);
  });

  it("honours to_tsquery's boolean operators, including negation", async () => {
    assert.deepEqual(await titles({ title: { search: 'post & !editor' } }), [
      'Draft Post',
      'Member Post',
      'Org 2 Admin Post',
      'Org 2 Member Post',
      'Second Post',
    ]);
  });

  /**
   * The config is the one piece of this clause that is interpolated into the
   * SQL text rather than bound, so it is the one piece a build-only test can
   * only assert the SPELLING of. Here it changes the answer: `english` stems
   * the query term `members` to `member` and therefore also matches the post
   * whose content says "A member post in org 2", while `simple` tokenizes
   * without stemming and matches only the literal "Members".
   */
  it('sends the config to the server, where it changes the result', async () => {
    const english = await titles({ content: { search: 'members' } });
    const simple = await titles({ content: { search: 'members', config: 'simple' } });
    assert.deepEqual(english, ['Member Post', 'Org 2 Member Post']);
    assert.deepEqual(simple, ['Member Post']);
    assert.notDeepEqual(english, simple, 'the stemmer really ran');
  });

  it('composes with an ordinary predicate in the same where', async () => {
    assert.deepEqual(await titles({ title: { search: 'editor' }, published: true }), ['Editor Post']);
  });

  it('returns no rows for a term that is not in the corpus', async () => {
    assert.deepEqual(await titles({ title: { search: 'zzzznotaword' } }), []);
  });

  /**
   * `to_tsquery` REJECTS a malformed query (unlike `plainto_tsquery`), so a
   * caller's typo surfaces as a database error rather than as silently zero
   * rows. Pinned because the alternative would be a search box that looks like
   * it works and answers nothing.
   */
  it('surfaces a malformed tsquery as an error rather than as no rows', async () => {
    // Matched loosely on purpose. PG 16 says `no operand in tsquery: "editor &"`
    // and other inputs and majors word it differently (`syntax error in
    // tsquery`); what is being pinned is that the failure is a TSQUERY failure
    // reaching the caller, not the exact sentence, which is the server's to
    // change.
    await assert.rejects(() => titles({ title: { search: 'editor &' } }), /tsquery/i);
  });
});
