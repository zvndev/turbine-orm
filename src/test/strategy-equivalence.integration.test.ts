/**
 * turbine-orm, strategy equivalence across query SHAPES (live)
 *
 * `src/query/batched-loader.ts` states the contract in its module doc:
 *
 *   "**Identical output shape.** The stitched result is byte-for-byte the same
 *   shape the join strategy produces."
 *
 * The existing suites pin that contract on a handful of hand-picked queries.
 * What was never pinned is the SHAPE SPACE: projections (`select` / `omit`) at
 * the top level and at every relation level, crossed with nesting, crossed with
 * cardinality. A relation projection is exactly where the two strategies stop
 * being equivalent by construction, because the join strategy resolves a nested
 * relation in SQL (a correlated subquery can reference any column of the row,
 * projected or not) while the batched strategy resolves it in JavaScript from
 * the columns that actually came back. Any key the projection dropped is a key
 * the stitcher no longer has.
 *
 * That difference is silent: the query succeeds, the HTTP status is 200, and a
 * to-one relation is simply `null`.
 *
 * This suite is the property-style guard for the whole class. It enumerates
 * query shapes as data, runs each one under BOTH `relationLoadStrategy: 'join'`
 * and `'batched'`, and asserts:
 *
 *   1. same VALUES        (`deepEqual`)
 *   2. same KEY ORDER     (`JSON.stringify`, which `deepEqual` ignores and which
 *                          callers observe through HTTP bodies, ETags and cache
 *                          keys)
 *   3. same ACCEPTANCE    (a shape one strategy refuses and the other executes
 *                          is a divergence too, so both outcomes are captured
 *                          rather than thrown)
 *
 * plus, per case, a NON-DEGENERACY precondition on the join result: if both
 * strategies return an empty array or a null relation, equality holds vacuously
 * and the case proves nothing. Every case declares the relation path that must
 * have loaded something, and the fixture is asserted against it.
 *
 * It creates and drops its own tables, so it needs no seeded fixture, only a
 * reachable Postgres:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/strategy-equivalence.integration.test.ts
 *
 * @module
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping strategy-equivalence integration tests: DATABASE_URL not set');
}

/** DDL/teardown run on a plain pg pool: the ORM has no raw-DDL surface. */
async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** Drop order matters: children before parents, junction before both sides. */
const DROP =
  'DROP TABLE IF EXISTS se_article_tags, se_profile_links, se_comments, se_articles, ' +
  'se_profiles, se_tags, se_journals, se_authors CASCADE';

/**
 * The fixture exists to make every relation cardinality reachable in one graph,
 * and to make the interesting ABSENCES reachable too:
 *
 *   - `se_articles.se_journal_id` is NULLABLE and NULL on some rows, so a
 *     genuinely-absent to-one is covered alongside a present one (both must be
 *     `null` vs an object under both strategies, and the two look identical when
 *     a stitch key goes missing, which is precisely why the bug class is silent).
 *   - `se_comments.se_author_id` is nullable for the same reason one level down.
 *   - `se_authors` #6 has no articles and no profile, `se_journals` #3 has no
 *     articles, `se_articles` #10 has no tags: empty to-many and null to-one on
 *     the SAME query as populated ones.
 *   - `se_profiles.se_author_id` is UNIQUE, which is what makes introspection
 *     emit `se_authors.seProfile` as a `hasOne` rather than a `hasMany`.
 *   - `se_article_tags` is a pure two-column junction, which is what makes
 *     introspection emit the `manyToMany` pair.
 *
 * NO index is created on any foreign key column. Two indexes are unavoidable
 * (the junction's composite primary key and the unique constraint that defines
 * the hasOne) and neither covers a plain child FK, so every relation probe here
 * is on an unindexed column: that is the condition under which real schemas end
 * up on the batched loader in the first place (`relationLoadStrategy: 'auto'`
 * demotes exactly these relations), so it is the condition the parity guard
 * should run under.
 */
const DDL = [
  DROP,
  'CREATE TABLE se_authors (id serial PRIMARY KEY, name text NOT NULL, email text, tier text)',
  'CREATE TABLE se_journals (id serial PRIMARY KEY, title text NOT NULL, ' +
    'se_editor_id int REFERENCES se_authors(id), issn text)',
  'CREATE TABLE se_articles (id serial PRIMARY KEY, se_author_id int NOT NULL REFERENCES se_authors(id), ' +
    'se_journal_id int REFERENCES se_journals(id), title text NOT NULL, body text, word_count int)',
  'CREATE TABLE se_comments (id serial PRIMARY KEY, se_article_id int NOT NULL REFERENCES se_articles(id), ' +
    'se_author_id int REFERENCES se_authors(id), body text NOT NULL)',
  'CREATE TABLE se_profiles (id serial PRIMARY KEY, ' +
    'se_author_id int NOT NULL UNIQUE REFERENCES se_authors(id), bio text)',
  'CREATE TABLE se_profile_links (id serial PRIMARY KEY, ' +
    'se_profile_id int NOT NULL REFERENCES se_profiles(id), url text NOT NULL)',
  'CREATE TABLE se_tags (id serial PRIMARY KEY, label text NOT NULL, se_journal_id int REFERENCES se_journals(id))',
  'CREATE TABLE se_article_tags (se_article_id int NOT NULL REFERENCES se_articles(id), ' +
    'se_tag_id int NOT NULL REFERENCES se_tags(id), PRIMARY KEY (se_article_id, se_tag_id))',
];

/**
 * Rows are inserted in ascending key order and never updated, so a table's
 * physical order equals its primary-key order. That matters for the `true`
 * (bare) relation spec, which carries no `orderBy`: both strategies then return
 * whatever order the engine produces, and the fixture is arranged so that order
 * is the same one on both sides rather than left to chance.
 */
const SEED = [
  `INSERT INTO se_authors (name, email, tier) VALUES
     ('Ada', 'ada@example.test', 'gold'),
     ('Brahm', 'brahm@example.test', 'silver'),
     ('Cyrus', NULL, 'gold'),
     ('Dara', 'dara@example.test', NULL),
     ('Emi', 'emi@example.test', 'bronze'),
     ('Fen', 'fen@example.test', 'gold')`,
  `INSERT INTO se_journals (title, se_editor_id, issn) VALUES
     ('Journal of Ordinary Things', 1, '1111-0001'),
     ('Quarterly of Edge Cases', 2, NULL),
     ('Annals of Nothing', NULL, '1111-0003')`,
  `INSERT INTO se_articles (se_author_id, se_journal_id, title, body, word_count) VALUES
     (1, 1, 'A1', 'body a1', 100),
     (1, 2, 'A2', NULL, 200),
     (1, NULL, 'A3', 'body a3', 300),
     (2, 1, 'A4', 'body a4', NULL),
     (2, NULL, 'A5', 'body a5', 500),
     (3, 2, 'A6', 'body a6', 600),
     (3, 1, 'A7', NULL, 700),
     (4, NULL, 'A8', 'body a8', 800),
     (4, 2, 'A9', 'body a9', 900),
     (5, 1, 'A10', 'body a10', 1000)`,
  `INSERT INTO se_comments (se_article_id, se_author_id, body) VALUES
     (1, 2, 'c1'), (1, NULL, 'c2'),
     (2, 3, 'c3'), (2, 1, 'c4'),
     (3, NULL, 'c5'), (3, 4, 'c6'),
     (4, 5, 'c7'), (4, NULL, 'c8'),
     (5, 1, 'c9'), (5, 2, 'c10'),
     (6, NULL, 'c11'), (6, 3, 'c12'),
     (7, 4, 'c13'), (7, 5, 'c14'),
     (8, 1, 'c15'), (8, NULL, 'c16')`,
  `INSERT INTO se_profiles (se_author_id, bio) VALUES
     (1, 'bio one'), (2, NULL), (3, 'bio three'), (4, 'bio four')`,
  `INSERT INTO se_profile_links (se_profile_id, url) VALUES
     (1, 'https://one.test/a'), (1, 'https://one.test/b'), (2, 'https://two.test/a')`,
  `INSERT INTO se_tags (label, se_journal_id) VALUES
     ('alpha', 1), ('beta', 2), ('gamma', NULL), ('delta', 1), ('epsilon', NULL)`,
  `INSERT INTO se_article_tags (se_article_id, se_tag_id) VALUES
     (1, 1), (1, 2), (2, 3), (3, 1), (3, 4), (4, 5),
     (5, 2), (5, 3), (6, 1), (7, 4), (8, 2), (9, 5)`,
];

// ---------------------------------------------------------------------------
// The matrix, expressed as data
// ---------------------------------------------------------------------------

/**
 * One relation under test, plus everything the matrix needs to build shapes
 * around it. There is one entry per cardinality the loader has to handle, and
 * TWO `belongsTo` entries because a non-null FK and a nullable FK are different
 * cases: only the nullable one can distinguish "no related row" from "the
 * stitch key was projected away".
 */
interface Cardinality {
  /** Label component, also the axis name. */
  kind: string;
  /** Root table of the findMany. */
  table: string;
  /** Relation name on `table` (as introspection derives it). */
  relation: string;
  /** `many` (array) or `one` (object | null): decides the orderBy and the signal check. */
  arity: 'many' | 'one';
  /** Narrowing scalar `select`, deliberately excluding every correlation key. */
  select: Record<string, boolean>;
  /**
   * `omit`, deliberately including the FK/PK the batched loader stitches on AND
   * the FK its own nested to-one would stitch on. Both are columns the join
   * strategy never needs in the projection because its correlation happens in
   * SQL.
   */
  omit: Record<string, boolean>;
  /** A to-one relation of the target, for the nested axis. */
  nestedToOne: string;
  /** A to-many relation of the target, for the nested axis. */
  nestedToMany: string;
  /** A `_count` spec valid on the target, for the nested axis. */
  nestedCount: Record<string, boolean>;
}

const CARDINALITIES: Cardinality[] = [
  {
    kind: 'hasMany',
    table: 'se_authors',
    relation: 'seArticles',
    arity: 'many',
    select: { title: true, wordCount: true },
    omit: { seAuthorId: true, seJournalId: true, body: true },
    nestedToOne: 'seJournal',
    nestedToMany: 'seComments',
    nestedCount: { seComments: true, seTags: true },
  },
  {
    kind: 'hasOne',
    table: 'se_authors',
    relation: 'seProfile',
    arity: 'one',
    select: { bio: true },
    omit: { id: true, seAuthorId: true },
    nestedToOne: 'seAuthor',
    nestedToMany: 'seProfileLinks',
    nestedCount: { seProfileLinks: true },
  },
  {
    kind: 'belongsTo',
    table: 'se_articles',
    relation: 'seAuthor',
    arity: 'one',
    select: { name: true },
    omit: { id: true, email: true },
    nestedToOne: 'seProfile',
    nestedToMany: 'seComments',
    nestedCount: { seArticles: true, seComments: true },
  },
  {
    // Same cardinality, nullable FK: some parents genuinely have no related row.
    kind: 'belongsToNullable',
    table: 'se_articles',
    relation: 'seJournal',
    arity: 'one',
    select: { title: true },
    omit: { id: true, seEditorId: true, issn: true },
    nestedToOne: 'seAuthor',
    nestedToMany: 'seArticles',
    nestedCount: { seArticles: true },
  },
  {
    kind: 'manyToMany',
    table: 'se_articles',
    relation: 'seTags',
    arity: 'many',
    select: { label: true },
    omit: { id: true, seJournalId: true },
    nestedToOne: 'seJournal',
    nestedToMany: 'seArticles',
    nestedCount: { seArticles: true },
  },
];

/**
 * Top-level projection axis, per root table. The `select` variants deliberately
 * drop the column the batched loader has to stitch the top-level relation on
 * (`se_authors.id`, `se_articles.id` / `se_articles.seJournalId`), and the
 * `omit` variants deliberately omit it: both force the loader's
 * "add the key for the query, strip it from the output" path, whose output the
 * join strategy never has to reproduce because it never added anything.
 */
const ROOT_PROJECTIONS: Record<string, { label: string; args: Record<string, unknown> }[]> = {
  se_authors: [
    { label: 'root:none', args: {} },
    { label: 'root:select', args: { select: { name: true, tier: true } } },
    { label: 'root:omit', args: { omit: { id: true, email: true } } },
  ],
  se_articles: [
    { label: 'root:none', args: {} },
    { label: 'root:select', args: { select: { title: true } } },
    { label: 'root:omit', args: { omit: { id: true, seJournalId: true, body: true } } },
  ],
  se_tags: [
    { label: 'root:none', args: {} },
    { label: 'root:select', args: { select: { label: true } } },
    { label: 'root:omit', args: { omit: { id: true, seJournalId: true } } },
  ],
};

/** Relation-spec axis. `bare` is `true`, which by construction can carry no nesting. */
const REL_PROJECTIONS = ['bare', 'plain', 'select', 'omit'] as const;
type RelProjection = (typeof REL_PROJECTIONS)[number];

/** Nesting axis. `count` is `_count` INSIDE the relation, not beside it. */
const NESTINGS = ['none', 'toOne', 'toMany', 'count'] as const;
type Nesting = (typeof NESTINGS)[number];

/** A single matrix cell: one query, run twice. */
interface Case {
  label: string;
  table: string;
  args: Record<string, unknown>;
  /**
   * Relation path that MUST have loaded something on the join result. Without
   * it a case where both strategies return `[]`/`null` passes vacuously and
   * proves nothing at all.
   */
  signal: string[];
}

/** Build the relation spec for one (projection, nesting) cell. */
function relationSpec(card: Cardinality, projection: RelProjection, nesting: Nesting): true | Record<string, unknown> {
  if (projection === 'bare') return true;
  const spec: Record<string, unknown> = {};
  // A to-many needs a deterministic child order to be comparable at all; a
  // to-one returns a single row, so ordering it would only add noise.
  if (card.arity === 'many') spec.orderBy = { id: 'asc' };
  if (projection === 'select') spec.select = card.select;
  if (projection === 'omit') spec.omit = card.omit;
  if (nesting === 'toOne') spec.with = { [card.nestedToOne]: true };
  if (nesting === 'toMany') spec.with = { [card.nestedToMany]: { orderBy: { id: 'asc' } } };
  if (nesting === 'count') spec.with = { _count: card.nestedCount };
  return spec;
}

/** Depth-1 and depth-2 cells (nesting !== 'none' is the second level). */
function buildMatrixCases(): Case[] {
  const cases: Case[] = [];
  for (const card of CARDINALITIES) {
    for (const projection of REL_PROJECTIONS) {
      // `true` is not an object, so it cannot carry a nested `with`.
      const nestings: readonly Nesting[] = projection === 'bare' ? ['none'] : NESTINGS;
      for (const nesting of nestings) {
        for (const root of ROOT_PROJECTIONS[card.table]!) {
          const nestedName =
            nesting === 'toOne'
              ? card.nestedToOne
              : nesting === 'toMany'
                ? card.nestedToMany
                : nesting === 'count'
                  ? '_count'
                  : null;
          const depth = nesting === 'none' ? 1 : 2;
          cases.push({
            label:
              `d${depth} ${card.kind}(${card.table}.${card.relation}) rel:${projection} ` +
              `nested:${nesting === 'none' ? 'none' : `${nesting}(${nestedName})`} ${root.label}`,
            table: card.table,
            args: {
              ...root.args,
              orderBy: { id: 'asc' },
              with: { [card.relation]: relationSpec(card, projection, nesting) },
            },
            signal: nestedName === null ? [card.relation] : [card.relation, nestedName],
          });
        }
      }
    }
  }
  return cases;
}

/**
 * Depth-3 chains. Two levels is enough to lose a stitch key once; three is what
 * proves the loader re-derives the keys it needs at EVERY level rather than
 * only at the one the top-level query prepared. Each chain deliberately mixes
 * cardinalities and puts a projection on an intermediate level.
 */
const DEEP_CHAINS: { name: string; table: string; with: Record<string, unknown>; signal: string[] }[] = [
  {
    name: 'hasMany > hasMany > belongsTo, select on both to-many levels',
    table: 'se_authors',
    with: {
      seArticles: {
        orderBy: { id: 'asc' },
        select: { title: true },
        with: { seComments: { orderBy: { id: 'asc' }, select: { body: true }, with: { seAuthor: true } } },
      },
    },
    signal: ['seArticles', 'seComments', 'seAuthor'],
  },
  {
    name: 'hasMany > belongsTo > hasMany (back-reference)',
    table: 'se_authors',
    with: {
      seArticles: {
        orderBy: { id: 'asc' },
        with: { seJournal: { with: { seArticles: { orderBy: { id: 'asc' } } } } },
      },
    },
    signal: ['seArticles', 'seJournal', 'seArticles'],
  },
  {
    name: 'hasOne > hasMany > belongsTo',
    table: 'se_authors',
    with: {
      seProfile: {
        with: { seProfileLinks: { orderBy: { id: 'asc' }, with: { seProfile: true } } },
      },
    },
    signal: ['seProfile', 'seProfileLinks', 'seProfile'],
  },
  {
    name: 'manyToMany > manyToMany > hasMany',
    table: 'se_articles',
    with: {
      seTags: {
        orderBy: { id: 'asc' },
        with: { seArticles: { orderBy: { id: 'asc' }, with: { seComments: { orderBy: { id: 'asc' } } } } },
      },
    },
    signal: ['seTags', 'seArticles', 'seComments'],
  },
  {
    name: 'belongsTo > hasOne > hasMany',
    table: 'se_articles',
    with: {
      seAuthor: { with: { seProfile: { with: { seProfileLinks: { orderBy: { id: 'asc' } } } } } },
    },
    signal: ['seAuthor', 'seProfile', 'seProfileLinks'],
  },
  {
    name: 'belongsTo(nullable) > hasMany > hasMany, omit the stitch key mid-chain',
    table: 'se_articles',
    with: {
      seJournal: {
        omit: { issn: true },
        with: {
          seArticles: {
            orderBy: { id: 'asc' },
            omit: { seJournalId: true },
            with: { seComments: { orderBy: { id: 'asc' } } },
          },
        },
      },
    },
    signal: ['seJournal', 'seArticles', 'seComments'],
  },
  {
    name: 'manyToMany from the other side > hasMany > belongsTo',
    table: 'se_tags',
    with: {
      seArticles: {
        orderBy: { id: 'asc' },
        with: { seComments: { orderBy: { id: 'asc' }, with: { seAuthor: true } } },
      },
    },
    signal: ['seArticles', 'seComments', 'seAuthor'],
  },
  {
    name: 'hasMany > manyToMany > belongsTo, select on the to-many',
    table: 'se_authors',
    with: {
      seArticles: {
        orderBy: { id: 'asc' },
        select: { title: true },
        with: { seTags: { orderBy: { id: 'asc' }, with: { seJournal: true } } },
      },
    },
    signal: ['seArticles', 'seTags', 'seJournal'],
  },
  {
    name: 'hasMany > belongsTo > hasOne through a nullable FK',
    table: 'se_authors',
    with: {
      seComments: {
        orderBy: { id: 'asc' },
        with: { seAuthor: { with: { seProfile: true } } },
      },
    },
    signal: ['seComments', 'seAuthor', 'seProfile'],
  },
  {
    name: 'hasMany > belongsTo > belongsTo, select at the leaf',
    table: 'se_articles',
    with: {
      seComments: {
        orderBy: { id: 'asc' },
        with: { seArticle: { with: { seJournal: { select: { title: true } } } } },
      },
    },
    signal: ['seComments', 'seArticle', 'seJournal'],
  },
];

function buildDeepCases(): Case[] {
  const cases: Case[] = [];
  for (const chain of DEEP_CHAINS) {
    for (const root of ROOT_PROJECTIONS[chain.table]!) {
      cases.push({
        label: `d3 ${chain.name} ${root.label}`,
        table: chain.table,
        args: { ...root.args, orderBy: { id: 'asc' }, with: chain.with },
        signal: chain.signal,
      });
    }
  }
  return cases;
}

const CASES = [...buildMatrixCases(), ...buildDeepCases()];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * The full outcome of one run, INCLUDING refusal. A shape one strategy executes
 * and the other rejects is a divergence in its own right, and letting the throw
 * escape would report it as a crashed test rather than as a parity failure.
 */
type Outcome = { ok: true; rows: unknown[] } | { ok: false; code: string; message: string };

/** One-line rendering of an outcome, for assertion messages. */
function describeOutcome(outcome: Outcome): string {
  return outcome.ok ? `${outcome.rows.length} rows` : `threw ${outcome.code}: ${outcome.message}`;
}

/**
 * Does at least one value at the end of `path` actually carry a loaded relation?
 * Arrays must be non-empty, to-ones must be non-null, and a `_count` leaf must
 * have at least one non-zero entry (a `_count` of all zeros is the same vacuous
 * agreement as an empty array).
 */
function carriesSignal(rows: unknown[], path: string[]): boolean {
  let level: unknown[] = rows;
  for (let i = 0; i < path.length; i++) {
    const key = path[i]!;
    const next: unknown[] = [];
    for (const node of level) {
      if (node === null || typeof node !== 'object') continue;
      const value = (node as Record<string, unknown>)[key];
      if (Array.isArray(value)) next.push(...value.filter((item) => item !== null && item !== undefined));
      else if (value !== null && value !== undefined) next.push(value);
    }
    if (i === path.length - 1) {
      if (key === '_count') {
        return next.some((counts) => Object.values(counts as Record<string, number>).some((n) => n > 0));
      }
      return next.length > 0;
    }
    level = next;
  }
  return false;
}

let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe('join vs batched relation strategies agree across query shapes (live)', () => {
  before(async () => {
    await runSql([...DDL, ...SEED]);
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 8, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    await runSql([DROP]);
  });

  async function run(table: string, args: Record<string, unknown>, strategy: 'join' | 'batched'): Promise<Outcome> {
    try {
      const rows = await db.table(table).findMany({ ...args, relationLoadStrategy: strategy } as never);
      return { ok: true, rows: rows as unknown[] };
    } catch (err) {
      const error = err as { code?: string; message?: string };
      return {
        ok: false,
        code: error.code ?? (err as object)?.constructor?.name ?? 'unknown',
        message: error.message ?? String(err),
      };
    }
  }

  /**
   * The relation names the whole matrix is written against. Introspection
   * derives them from the fixture's foreign keys, so a change in the naming
   * rules would otherwise surface as ~200 identical "unknown relation" failures
   * with no indication that the FIXTURE, not the loader, moved.
   */
  it('precondition: introspection derives the relation names the matrix assumes', () => {
    const expected: Record<string, Record<string, string>> = {
      se_authors: { seArticles: 'hasMany', seComments: 'hasMany', seJournals: 'hasMany', seProfile: 'hasOne' },
      se_articles: {
        seAuthor: 'belongsTo',
        seJournal: 'belongsTo',
        seComments: 'hasMany',
        seTags: 'manyToMany',
      },
      se_journals: { seAuthor: 'belongsTo', seArticles: 'hasMany', seTags: 'hasMany' },
      se_comments: { seArticle: 'belongsTo', seAuthor: 'belongsTo' },
      se_profiles: { seAuthor: 'belongsTo', seProfileLinks: 'hasMany' },
      se_profile_links: { seProfile: 'belongsTo' },
      se_tags: { seJournal: 'belongsTo', seArticles: 'manyToMany' },
    };
    for (const [table, relations] of Object.entries(expected)) {
      const actual = schema.tables[table]?.relations ?? {};
      for (const [name, type] of Object.entries(relations)) {
        assert.equal(
          actual[name]?.type,
          type,
          `${table}.${name} should be a ${type} relation, got ${actual[name]?.type ?? 'nothing'}. ` +
            `Available: ${Object.keys(actual).join(', ')}`,
        );
      }
    }
  });

  it('precondition: no foreign key column carries a covering index', () => {
    // The whole matrix is meant to run on the shape that pushes real schemas
    // onto the batched loader. An index sneaking in would not fail parity, it
    // would just stop the suite from testing the situation it exists for.
    const fkColumns: [string, string][] = [
      ['se_articles', 'se_author_id'],
      ['se_articles', 'se_journal_id'],
      ['se_comments', 'se_article_id'],
      ['se_comments', 'se_author_id'],
      ['se_journals', 'se_editor_id'],
      ['se_profile_links', 'se_profile_id'],
      ['se_tags', 'se_journal_id'],
    ];
    for (const [table, column] of fkColumns) {
      const covering = (schema.tables[table]?.indexes ?? []).filter((idx) => idx.columns[0] === column);
      assert.deepEqual(covering, [], `${table}.${column} unexpectedly has a covering index: the fixture drifted`);
    }
  });

  for (const testCase of CASES) {
    it(testCase.label, async () => {
      const join = await run(testCase.table, testCase.args, 'join');
      const batched = await run(testCase.table, testCase.args, 'batched');

      // ACCEPTANCE parity first: a shape only one strategy accepts is a
      // divergence, and comparing rows would be meaningless anyway.
      assert.equal(
        batched.ok,
        join.ok,
        `${testCase.label}: the strategies disagree on whether this query is even legal. ` +
          `join ${describeOutcome(join)}; batched ${describeOutcome(batched)}. ` +
          `args=${JSON.stringify(testCase.args)}`,
      );
      if (!join.ok || !batched.ok) {
        assert.equal(
          (batched as { code: string }).code,
          (join as { code: string }).code,
          `${testCase.label}: both strategies refused the query but with different error codes. ` +
            `join ${describeOutcome(join)}; batched ${describeOutcome(batched)}`,
        );
        return;
      }

      // NON-DEGENERACY: without this, a case where both strategies return an
      // empty array or a null to-one agrees perfectly and proves nothing.
      assert.ok(
        join.rows.length > 0,
        `${testCase.label}: the join strategy returned no rows, so equality below would be vacuous. ` +
          'The fixture stopped carrying signal for this case.',
      );
      assert.ok(
        carriesSignal(join.rows, testCase.signal),
        `${testCase.label}: nothing loaded at "${testCase.signal.join('.')}" on the join result, so an ` +
          'equality assertion here proves nothing. The fixture stopped carrying signal for this case.',
      );

      assert.deepEqual(
        batched.rows,
        join.rows,
        `${testCase.label}: batched and join disagree on VALUES. args=${JSON.stringify(testCase.args)}`,
      );
      assert.equal(
        JSON.stringify(batched.rows),
        JSON.stringify(join.rows),
        `${testCase.label}: batched and join disagree on KEY ORDER (values matched). ` +
          `args=${JSON.stringify(testCase.args)}`,
      );
    });
  }
});
