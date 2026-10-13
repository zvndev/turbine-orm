/**
 * Oracle 1: warm SQL cache vs cold, production mode, `undefined` holes.
 *
 * A caller who writes `{ gte: from, lte: to }` with either bound optional passes
 * `undefined` inside an operator object. Contract: `undefined` means absent, so
 * `{ gte: undefined, lte: 2 }` is `{ lte: 2 }`, an object emptied by removal is
 * removed, and a combinator element that empties is dropped.
 *
 * What goes wrong without it is silent. The SQL-template cache keys on filter
 * SHAPE, and when `undefined` slips past the key, a later call with the OTHER
 * hole is served the first call's SQL and params. The dev-only cache
 * cross-check throws on that, which is why the suite never saw it: this file
 * runs under NODE_ENV=production, where the cross-check is off and the
 * poisoned statement just runs.
 *
 * Every expectation comes from outside the library:
 *   - named pairs: hand-written SQL predicates run through a raw pg client
 *   - random trees: a JS three-valued-logic evaluator over raw table dumps
 *
 * Each case is run through a client with the SQL cache warm (one long-lived
 * client that sees every call in sequence) and a client with `sqlCache: false`.
 * Both must equal the oracle. "cold != oracle" is a compiler bug with holes;
 * "warm != oracle but cold == oracle" is cache poisoning.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-cache-warm-cold.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type pg from 'pg';
import { skipGate } from './helpers.js';
import { DATABASE_URL, rngFor, SKIP, scaled } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { ALL_PRESENT, type Gen, genWhere, randomMask, type TableGens } from './oracle/hole-gen.js';
import { dumpJson, ids, rawReader, runScript } from './oracle/raw.js';
import {
  attempt,
  describeError,
  introspectTables,
  makeClient,
  type OracleClient,
  show,
  stable,
} from './oracle/util.js';
import { camelRow, type Model, matchingIds } from './oracle/where-model.js';

const FILE = 'oracle-cache-warm-cold.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const T_USERS = 'orc_c_users';
const T_POSTS = 'orc_c_posts';
const T_ORGS = 'orc_c_orgs';

const DDL = `
DROP TABLE IF EXISTS ${T_POSTS}, ${T_USERS}, ${T_ORGS} CASCADE;
CREATE TABLE ${T_ORGS} (id int PRIMARY KEY, name text NOT NULL);
CREATE TABLE ${T_USERS} (
  id int PRIMARY KEY,
  org_id int REFERENCES ${T_ORGS}(id),
  name text,
  score int,
  active boolean,
  tags text[] NOT NULL DEFAULT '{}',
  data jsonb
);
CREATE TABLE ${T_POSTS} (
  id int PRIMARY KEY,
  author_id int REFERENCES ${T_USERS}(id),
  views int NOT NULL,
  published boolean NOT NULL,
  title text NOT NULL,
  rating int
);
CREATE INDEX ON ${T_POSTS}(author_id);
CREATE INDEX ON ${T_USERS}(org_id);
`;

const NAMES = ['ann', 'bob', 'Bob', 'cy', 'a%b', 'a_b', 'zed', '', 'dee'];
const SCORES = [0, 1, 2, 3, 5];
const TAGS = ['sql', 'pg', 'js'];
const TITLES = ['alpha', 'beta', 'a%', 'b_', 'gamma'];
// Every document holding a=1 is EXACTLY {"a":1}, so equality and containment on it agree;
// every "n" is numeric, so a numeric cast on a path cannot fail the whole query.
const DOCS = ['{"n":1}', '{"n":5}', '{"n":2}', '{"n":10}', '{"a":1}', '{"a":2}', '{"k":"v"}'];

const sqlLit = (v: unknown): string =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

function seedSql(): string {
  const rng = rngFor('cache-warm-cold:data');
  const out: string[] = [];
  const orgNames = ['acme', 'Acme', 'beta', 'gamma', 'delta'];
  for (const [i, n] of orgNames.entries()) out.push(`INSERT INTO ${T_ORGS} VALUES (${i + 1}, ${sqlLit(n)});`);
  for (let id = 1; id <= 48; id++) {
    const org = rng.chance(0.2) ? null : rng.int(1, 5);
    const name = rng.chance(0.1) ? null : rng.pick(NAMES);
    const score = rng.chance(0.2) ? null : rng.pick(SCORES);
    const active = rng.chance(0.2) ? 'NULL' : rng.chance(0.5) ? 'true' : 'false';
    const tags = TAGS.filter(() => rng.chance(0.35));
    const doc = rng.chance(0.15) ? null : rng.pick(DOCS);
    out.push(
      `INSERT INTO ${T_USERS} VALUES (${id}, ${sqlLit(org)}, ${sqlLit(name)}, ${sqlLit(score)}, ${active}, ARRAY[${tags
        .map(sqlLit)
        .join(',')}]::text[], ${doc === null ? 'NULL' : `${sqlLit(doc)}::jsonb`});`,
    );
  }
  for (let id = 1; id <= 130; id++) {
    const author = rng.chance(0.05) ? null : rng.int(1, 40);
    const rating = rng.chance(0.3) ? null : rng.pick(SCORES);
    out.push(
      `INSERT INTO ${T_POSTS} VALUES (${id}, ${sqlLit(author)}, ${rng.pick([0, 1, 3, 5])}, ${rng.chance(0.5)}, ${sqlLit(
        rng.pick(TITLES),
      )}, ${sqlLit(rating)});`,
    );
  }
  return out.join('\n');
}

const TABLES: TableGens = {
  users: {
    name: T_USERS,
    fields: [
      { key: 'name', kind: 'text', values: NAMES, nullable: true },
      { key: 'score', kind: 'int', values: SCORES, nullable: true },
      { key: 'orgId', kind: 'int', values: [1, 2, 3, 9], nullable: true },
      { key: 'active', kind: 'bool', values: [true, false], nullable: true },
      { key: 'tags', kind: 'textArray', values: TAGS, nullable: false },
    ],
    relations: [
      { key: 'posts', many: true, target: 'posts' },
      { key: 'org', many: false, target: 'orgs' },
    ],
  },
  posts: {
    name: T_POSTS,
    fields: [
      { key: 'views', kind: 'int', values: [0, 1, 3, 5], nullable: false },
      { key: 'published', kind: 'bool', values: [true, false], nullable: false },
      { key: 'title', kind: 'text', values: TITLES, nullable: false },
      { key: 'rating', kind: 'int', values: SCORES, nullable: true },
    ],
    relations: [],
  },
  orgs: {
    name: T_ORGS,
    fields: [{ key: 'name', kind: 'text', values: ['acme', 'Acme', 'beta', 'zzz'], nullable: false }],
    relations: [],
  },
};

let warm: OracleClient;
let cold: OracleClient;
let reader: pg.Client;
let model: Model;
let schema: Awaited<ReturnType<typeof introspectTables>>;
let savedNodeEnv: string | undefined;

function newClient(config: Parameters<typeof makeClient>[2] = {}): OracleClient {
  return makeClient(DATABASE_URL!, schema, config);
}

describe('oracle: warm SQL cache vs cold, production mode, undefined holes', () => {
  before(async () => {
    // The dev cache cross-check throws on a poisoned hit; production does not.
    savedNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    await runScript(DATABASE_URL!, DDL + seedSql());
    schema = await introspectTables(DATABASE_URL!, [T_ORGS, T_USERS, T_POSTS], {
      [T_USERS]: { orcCPosts: 'posts', orcCOrg: 'org' },
      [T_POSTS]: { orcCUser: 'author' },
      [T_ORGS]: { orcCUsers: 'users' },
    });
    warm = newClient();
    cold = newClient({ sqlCache: false });
    reader = await rawReader(DATABASE_URL!);

    const dump = async (table: string) => (await dumpJson(reader, table)).map(camelRow);
    model = {
      users: {
        rows: await dump(T_USERS),
        relations: {
          posts: { many: true, target: 'posts', local: 'id', remote: 'authorId' },
          org: { many: false, target: 'orgs', local: 'orgId', remote: 'id' },
        },
      },
      posts: { rows: await dump(T_POSTS), relations: {} },
      orgs: { rows: await dump(T_ORGS), relations: {} },
    };
  });

  after(async () => {
    process.env.NODE_ENV = savedNodeEnv;
    await warm?.disconnect();
    await cold?.disconnect();
    await reader?.end();
    if (!SKIP) await runScript(DATABASE_URL!, `DROP TABLE IF EXISTS ${T_POSTS}, ${T_USERS}, ${T_ORGS} CASCADE`);
  });

  // -------------------------------------------------------------------------
  // Named pairs: "warm with one hole, then the other hole"
  // -------------------------------------------------------------------------

  type PairCase =
    | { kind: 'ids'; args: Record<string, unknown>; where: string }
    | { kind: 'ordered'; args: Record<string, unknown>; sql: string }
    | { kind: 'withPosts'; postsWhere: Record<string, unknown>; childWhere: string }
    | { kind: 'rows'; args: Record<string, unknown>; sql: string }
    | { kind: 'throws'; args: Record<string, unknown> };

  interface Pair {
    label: string;
    a: PairCase;
    b: PairCase;
  }

  const AFTER_ID3 = (order: string): string =>
    `SELECT id FROM (SELECT id, row_number() OVER (ORDER BY ${order}) rn FROM ${T_USERS}) x ` +
    `WHERE rn > (SELECT rn FROM (SELECT id, row_number() OVER (ORDER BY ${order}) rn FROM ${T_USERS}) y WHERE y.id = 3) ORDER BY rn`;

  const PAIRS: Pair[] = [
    {
      label: 'scalar range: gte/lte',
      a: { kind: 'ids', args: { where: { score: { gte: undefined, lte: 2 } } }, where: 'u.score <= 2' },
      b: { kind: 'ids', args: { where: { score: { gte: 2, lte: undefined } } }, where: 'u.score >= 2' },
    },
    {
      label: 'scalar not/equals',
      a: { kind: 'ids', args: { where: { score: { not: undefined, equals: 3 } } }, where: 'u.score = 3' },
      b: { kind: 'ids', args: { where: { score: { not: 3, equals: undefined } } }, where: 'u.score <> 3' },
    },
    {
      label: 'in / notIn',
      a: { kind: 'ids', args: { where: { score: { in: [1], notIn: undefined } } }, where: 'u.score = 1' },
      b: { kind: 'ids', args: { where: { score: { in: undefined, notIn: [1] } } }, where: 'u.score <> 1' },
    },
    {
      label: 'text startsWith/gt',
      a: {
        kind: 'ids',
        args: { where: { name: { startsWith: undefined, gt: 'm' } } },
        where: `u.name COLLATE "C" > 'm'`,
      },
      b: { kind: 'ids', args: { where: { name: { startsWith: 'b', gt: undefined } } }, where: `u.name LIKE 'b%'` },
    },
    {
      label: 'text endsWith/contains',
      a: { kind: 'ids', args: { where: { name: { endsWith: 'b', contains: undefined } } }, where: `u.name LIKE '%b'` },
      b: { kind: 'ids', args: { where: { name: { endsWith: undefined, contains: 'o' } } }, where: `u.name LIKE '%o%'` },
    },
    {
      label: 'json path gt/lt',
      a: {
        kind: 'ids',
        args: { where: { data: { path: ['n'], gt: undefined, lt: 3 } } },
        where: `(u.data #>> '{n}')::numeric < 3`,
      },
      b: {
        kind: 'ids',
        args: { where: { data: { path: ['n'], gt: 3, lt: undefined } } },
        where: `(u.data #>> '{n}')::numeric > 3`,
      },
    },
    {
      label: 'json contains/hasKey',
      a: {
        kind: 'ids',
        args: { where: { data: { contains: { a: 1 }, hasKey: undefined } } },
        where: `u.data @> '{"a":1}'`,
      },
      b: { kind: 'ids', args: { where: { data: { contains: undefined, hasKey: 'a' } } }, where: `u.data ? 'a'` },
    },
    {
      label: 'array has/hasSome',
      a: {
        kind: 'ids',
        args: { where: { tags: { has: undefined, hasSome: ['sql', 'pg'] } } },
        where: `u.tags && ARRAY['sql','pg']`,
      },
      b: { kind: 'ids', args: { where: { tags: { has: 'sql', hasSome: undefined } } }, where: `'sql' = ANY(u.tags)` },
    },
    {
      label: 'array hasEvery/isEmpty',
      a: {
        kind: 'ids',
        args: { where: { tags: { hasEvery: undefined, isEmpty: true } } },
        where: 'cardinality(u.tags) = 0',
      },
      b: {
        kind: 'ids',
        args: { where: { tags: { hasEvery: ['sql', 'pg'], isEmpty: undefined } } },
        where: `u.tags @> ARRAY['sql','pg']`,
      },
    },
    {
      label: 'relation some/none',
      a: {
        kind: 'ids',
        args: { where: { posts: { some: undefined, none: { views: 1 } } } },
        where: `NOT EXISTS (SELECT 1 FROM ${T_POSTS} p WHERE p.author_id = u.id AND p.views = 1)`,
      },
      b: {
        kind: 'ids',
        args: { where: { posts: { some: { views: 1 }, none: undefined } } },
        where: `EXISTS (SELECT 1 FROM ${T_POSTS} p WHERE p.author_id = u.id AND p.views = 1)`,
      },
    },
    {
      label: 'to-one relation is/isNot',
      a: {
        kind: 'ids',
        args: { where: { org: { is: undefined, isNot: { name: 'acme' } } } },
        where: `NOT EXISTS (SELECT 1 FROM ${T_ORGS} o WHERE o.id = u.org_id AND o.name = 'acme')`,
      },
      b: {
        kind: 'ids',
        args: { where: { org: { is: { name: 'acme' }, isNot: undefined } } },
        where: `EXISTS (SELECT 1 FROM ${T_ORGS} o WHERE o.id = u.org_id AND o.name = 'acme')`,
      },
    },
    {
      label: 'relation filter body range',
      a: {
        kind: 'ids',
        args: { where: { posts: { some: { views: { gt: undefined, lt: 3 } } } } },
        where: `EXISTS (SELECT 1 FROM ${T_POSTS} p WHERE p.author_id = u.id AND p.views < 3)`,
      },
      b: {
        kind: 'ids',
        args: { where: { posts: { some: { views: { gt: 3, lt: undefined } } } } },
        where: `EXISTS (SELECT 1 FROM ${T_POSTS} p WHERE p.author_id = u.id AND p.views > 3)`,
      },
    },
    {
      label: 'with.where range',
      a: { kind: 'withPosts', postsWhere: { views: { gt: undefined, lt: 3 } }, childWhere: 'p.views < 3' },
      b: { kind: 'withPosts', postsWhere: { views: { gt: 3, lt: undefined } }, childWhere: 'p.views > 3' },
    },
    {
      label: 'orderBy nulls: undefined vs first',
      a: {
        kind: 'ordered',
        args: { orderBy: [{ score: { sort: 'asc', nulls: undefined } }, { id: 'asc' }] },
        sql: `SELECT id FROM ${T_USERS} ORDER BY score ASC, id ASC`,
      },
      b: {
        kind: 'ordered',
        args: { orderBy: [{ score: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }] },
        sql: `SELECT id FROM ${T_USERS} ORDER BY score ASC NULLS FIRST, id ASC`,
      },
    },
    {
      label: 'cursor key: id kept, score undefined vs score kept, id undefined',
      a: {
        kind: 'ordered',
        args: { orderBy: [{ score: 'asc' }, { id: 'asc' }], cursor: { score: undefined, id: 3 } },
        sql: AFTER_ID3('score ASC, id ASC'),
      },
      b: { kind: 'throws', args: { orderBy: [{ score: 'asc' }, { id: 'asc' }], cursor: { score: 2, id: undefined } } },
    },
    {
      label: 'select: id vs name',
      a: {
        kind: 'rows',
        args: { select: { id: true, name: undefined } },
        sql: `SELECT json_build_object('id', id)::text FROM ${T_USERS} ORDER BY id LIMIT 3`,
      },
      b: {
        kind: 'rows',
        args: { select: { id: undefined, name: true } },
        sql: `SELECT json_build_object('name', name)::text FROM ${T_USERS} ORDER BY id LIMIT 3`,
      },
    },
    {
      label: 'mode: undefined vs insensitive',
      a: { kind: 'ids', args: { where: { name: { equals: 'bob', mode: undefined } } }, where: `u.name = 'bob'` },
      b: {
        kind: 'ids',
        args: { where: { name: { equals: 'bob', mode: 'insensitive' } } },
        where: `lower(u.name) = 'bob'`,
      },
    },
    {
      label: 'NOT body',
      a: { kind: 'ids', args: { where: { NOT: { score: undefined, name: 'bob' } } }, where: `NOT (u.name = 'bob')` },
      b: { kind: 'ids', args: { where: { NOT: { score: 1, name: undefined } } }, where: 'NOT (u.score = 1)' },
    },
    {
      label: 'limit vs offset',
      a: {
        kind: 'ordered',
        args: { orderBy: { id: 'asc' }, limit: undefined, offset: 2 },
        sql: `SELECT id FROM ${T_USERS} ORDER BY id OFFSET 2`,
      },
      b: {
        kind: 'ordered',
        args: { orderBy: { id: 'asc' }, limit: 2, offset: undefined },
        sql: `SELECT id FROM ${T_USERS} ORDER BY id LIMIT 2`,
      },
    },
    {
      label: 'OR element that empties',
      a: { kind: 'ids', args: { where: { OR: [{ score: undefined }, { name: 'bob' }] } }, where: `u.name = 'bob'` },
      b: { kind: 'ids', args: { where: { OR: [{ score: 1 }, { name: undefined }] } }, where: 'u.score = 1' },
    },
  ];

  const usersT = (db: OracleClient) => db.t(T_USERS);

  async function runCase(
    db: OracleClient,
    c: PairCase,
  ): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
    switch (c.kind) {
      case 'ids':
        return attempt(async () =>
          (await usersT(db).findMany({ ...c.args, select: { id: true }, orderBy: { id: 'asc' } })).map(
            (r: { id: number }) => r.id,
          ),
        );
      case 'ordered':
        return attempt(async () =>
          (await usersT(db).findMany({ ...c.args, select: { id: true } })).map((r: { id: number }) => r.id),
        );
      case 'withPosts':
        return attempt(async () =>
          (
            await usersT(db).findMany({
              select: { id: true },
              orderBy: { id: 'asc' },
              with: { posts: { where: c.postsWhere, select: { id: true }, orderBy: { id: 'asc' } } },
            })
          ).map((u: { id: number; posts: { id: number }[] }) => [u.id, u.posts.map((p) => p.id)]),
        );
      case 'rows':
        return attempt(async () => await usersT(db).findMany({ ...c.args, orderBy: { id: 'asc' }, limit: 3 }));
      case 'throws':
        return attempt(async () => usersT(db).findMany({ ...c.args, select: { id: true } }));
    }
  }

  async function oracleCase(c: PairCase): Promise<unknown> {
    switch (c.kind) {
      case 'ids':
        return ids(reader, `SELECT u.id FROM ${T_USERS} u WHERE ${c.where} ORDER BY u.id`);
      case 'ordered':
        return ids(reader, c.sql);
      case 'withPosts': {
        const result = await reader.query({
          text: `SELECT u.id, coalesce((SELECT json_agg(p.id ORDER BY p.id) FROM ${T_POSTS} p WHERE p.author_id = u.id AND (${c.childWhere})), '[]'::json)::text
                 FROM ${T_USERS} u ORDER BY u.id`,
          rowMode: 'array',
        });
        return (result.rows as string[][]).map((r) => [Number(r[0]), JSON.parse(r[1] as string) as number[]]);
      }
      case 'rows': {
        const result = await reader.query({ text: c.sql, rowMode: 'array' });
        return (result.rows as string[][]).map((r) => JSON.parse(r[0] as string));
      }
      case 'throws':
        return 'THROWS';
    }
  }

  for (const pair of PAIRS) {
    it(`warm with one hole, then the other: ${pair.label}`, async () => {
      const failures = new Failures(FILE);
      const expectA = await oracleCase(pair.a);
      const expectB = await oracleCase(pair.b);
      if (pair.a.kind !== 'throws' && pair.b.kind !== 'throws') {
        assert.notDeepEqual(
          expectA,
          expectB,
          `test bug: the oracle gives the same answer for both sides of "${pair.label}", so poisoning would go unseen`,
        );
      }
      for (const [firstLabel, first, second, expectFirst, expectSecond] of [
        ['A', pair.a, pair.b, expectA, expectB],
        ['B', pair.b, pair.a, expectB, expectA],
      ] as const) {
        // A fresh client per order, so the only warm state is what this pair puts there.
        const db = newClient();
        try {
          for (const [step, c, expected] of [
            [`${firstLabel} first`, first, expectFirst],
            ['then the other', second, expectSecond],
          ] as const) {
            failures.checked();
            const got = await runCase(db, c);
            if (expected === 'THROWS') {
              if (got.ok)
                failures.add(
                  `${pair.label}: should have thrown (${step})`,
                  `args ${show((c as { args: unknown }).args)}\ngot ${stable(got.value)}`,
                );
              else if (!(got.error instanceof Error) || !describeError(got.error).includes('TURBINE_E')) {
                failures.add(`${pair.label}: threw an untyped error (${step})`, describeError(got.error));
              }
              continue;
            }
            if (!got.ok) {
              failures.add(
                `${pair.label}: threw instead of answering (${step})`,
                `${describeError(got.error)}\ncase ${show(c)}`,
              );
            } else if (stable(got.value) !== stable(expected)) {
              failures.add(
                `${pair.label}: wrong answer on the ${step === 'then the other' ? 'SECOND (warm)' : 'first (cold)'} call`,
                `case ${show(c)}\nexpected ${stable(expected)}\ngot      ${stable(got.value)}`,
              );
            }
            // count() shares the where fingerprint with findMany.
            if (c.kind === 'ids') {
              failures.checked();
              const n = await attempt(() => usersT(db).count({ where: (c.args as { where: unknown }).where }));
              if (!n.ok) failures.add(`${pair.label}: count() threw (${step})`, describeError(n.error));
              else if (n.value !== (expected as number[]).length) {
                failures.add(
                  `${pair.label}: count() wrong on the ${step === 'then the other' ? 'SECOND (warm)' : 'first'} call`,
                  `expected ${(expected as number[]).length} got ${n.value}\ncase ${show(c)}`,
                );
              }
            }
          }
        } finally {
          await db.disconnect();
        }
      }
      failures.assertClean(`pair "${pair.label}"`, 4);
    });
  }

  // -------------------------------------------------------------------------
  // Random trees
  // -------------------------------------------------------------------------

  it('random where trees with undefined holes: warm cache, cold cache and the model agree', async () => {
    const rng = rngFor('cache-warm-cold:trees');
    const shapes = scaled(250, 3000);
    const failures = new Failures(FILE, 2);
    const strategies = ['join', 'batched', 'auto'] as const;
    let case_ = 0;

    for (let s = 0; s < shapes; s++) {
      const shapeSeed = rng.int(1, 2 ** 31 - 1);
      const postSeed = rng.int(1, 2 ** 31 - 1);
      const strategy = rng.pick(strategies);
      const maskStreams = [ALL_PRESENT, randomMask(rng, 0.55), randomMask(rng, 0.7)];

      for (const [m, mask] of maskStreams.entries()) {
        const mk = (seed: number) => rngFor(`shape:${seed}`);
        const gen: Gen = genWhere(mk(shapeSeed), mask, TABLES, 'users', 0, { nullFree: false, maxDepth: 2 });
        const postGen: Gen = genWhere(mk(postSeed), mask, TABLES, 'posts', 1, { nullFree: false, maxDepth: 1 });
        const expectedIds = matchingIds(model, 'users', gen.intended);
        const kids = (uid: number): number[] =>
          matchingIds(model, 'posts', {
            AND: [{ authorId: uid }, ...(postGen.intended === undefined ? [] : [postGen.intended])],
          });
        const expectedWith = expectedIds.map((id) => [id, kids(id)]);
        case_++;

        const kindsLabel = [...gen.kinds, ...postGen.kinds].sort().join(',') || 'none';
        const describeCase = () =>
          `case ${case_} (shape ${s}, mask ${m}), holes: ${kindsLabel}\nwhere    ${show(gen.holey)}\nintended ${show(gen.intended)}`;

        for (const [label, db] of [
          ['warm', warm],
          ['cold', cold],
        ] as const) {
          const record = (method: string, detail: string) => {
            failures.add(`${label} ${method}`, `${describeCase()}\n${detail}`);
            for (const k of new Set([...gen.kinds, ...postGen.kinds]))
              failures.tally(`${label} ${method}: case contains "${k}"`);
          };

          failures.checked();
          const found = await attempt(async () =>
            (await usersT(db).findMany({ where: gen.holey, select: { id: true }, orderBy: { id: 'asc' } })).map(
              (r: { id: number }) => r.id,
            ),
          );
          if (!found.ok) record('findMany threw', describeError(found.error));
          else if (stable(found.value) !== stable(expectedIds))
            record('findMany', `expected ${stable(expectedIds)}\ngot      ${stable(found.value)}`);

          failures.checked();
          const counted = await attempt(() => usersT(db).count({ where: gen.holey }));
          if (!counted.ok) record('count threw', describeError(counted.error));
          else if (counted.value !== expectedIds.length)
            record('count', `expected ${expectedIds.length} got ${counted.value}`);

          failures.checked();
          const withKids = await attempt(async () =>
            (
              await usersT(db).findMany({
                where: gen.holey,
                select: { id: true },
                orderBy: { id: 'asc' },
                relationLoadStrategy: strategy,
                with: { posts: { where: postGen.holey, select: { id: true }, orderBy: { id: 'asc' } } },
              })
            ).map((u: { id: number; posts: { id: number }[] }) => [u.id, u.posts.map((p) => p.id)]),
          );
          if (!withKids.ok) record(`with(posts.where) threw [${strategy}]`, describeError(withKids.error));
          else if (stable(withKids.value) !== stable(expectedWith)) {
            record(
              `with(posts.where) [${strategy}]`,
              `post where ${show(postGen.holey)}\nintended ${show(postGen.intended)}\nexpected ${stable(expectedWith).slice(0, 300)}\ngot      ${stable(withKids.value).slice(0, 300)}`,
            );
          }
        }
      }
    }
    failures.assertClean('random where trees with holes', shapes * 3 * 3);
  });
});
