/**
 * PowDB against Postgres on where shapes whose VALIDITY or NULL behavior the
 * two engines must agree on: combinator shapes (`AND` / `OR` / `NOT`), the
 * three-valued `NOT`, operator objects naming no operator, `distinct`
 * elements, relation filters over NULL-bearing rows, global filters, and the
 * `skipGlobalFilters` list.
 *
 * Each case runs on both engines through the public client and is compared as
 * an OUTCOME (the returned ids, or the thrown error's class and code), and
 * also against the value written in the case, so two engines agreeing on a
 * wrong answer still fails.
 *
 * Postgres runs in its own schema of DATABASE_URL (selected by the
 * `search_path` connection parameter, never a session SET); PowDB runs
 * embedded in a temporary directory. Fixture and seed: `oracle/engines/`.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/powdb-parity-differential.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineError, ValidationError } from '../errors.js';
import { UNSAFE } from '../query/index.js';
import { skipGate } from './helpers.js';
import {
  type ClientConfig,
  type Db,
  type EngineHarness,
  postgresHarness,
  powdbEmbeddedAvailable,
  powdbHarness,
} from './oracle/engines/harness.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const embedded = await powdbEmbeddedAvailable();
const { it, before, after } = DATABASE_URL
  ? skipGate(!embedded, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)')
  : skipGate(true, 'requires DATABASE_URL (Postgres is the oracle)');

/** A case's outcome: the ids it returned (or a count), or `error:<Class>:<code>`. */
type Outcome = number[] | number | string;

interface Case {
  id: string;
  run(db: Db): Promise<Outcome>;
  expect: Outcome;
  config?: ClientConfig;
  /** A write: both engines are reseeded before it runs. */
  write?: boolean;
  /** An engine gap: what PowDB returns instead of Postgres's outcome, with the reason. */
  powdb?: { expect: Outcome; why: string };
}

const ids = (rows: { id: number }[]): number[] => rows.map((r) => Number(r.id));

/** findMany on `table` with `where` (and extra args), ids ascending. */
const read =
  (table: string, where: unknown, extra: Record<string, unknown> = {}) =>
  async (db: Db): Promise<Outcome> =>
    ids(await db.table(table).findMany({ where, select: { id: true }, orderBy: { id: 'asc' }, ...extra }));

const users = (where: unknown, extra?: Record<string, unknown>) => read('oe_users', where, extra);
const posts = (where: unknown, extra?: Record<string, unknown>) => read('oe_posts', where, extra);
const comments = (where: unknown, extra?: Record<string, unknown>) => read('oe_comments', where, extra);

const E003 = 'error:ValidationError:TURBINE_E003';
const E017 = 'error:UnsupportedFeatureError:TURBINE_E017';
const NO_CURSOR = { expect: E017, why: 'PowDB has no cursor pagination; limit/offset instead' };

/** Every page of `limit` rows over `orderBy`, concatenated. */
const walk =
  (table: string, orderBy: unknown, limit: number) =>
  async (db: Db): Promise<Outcome> => {
    const seen: number[] = [];
    for (let offset = 0; offset < 50; offset += limit) {
      const page = ids(await db.table(table).findMany({ select: { id: true }, orderBy, limit, offset }));
      seen.push(...page);
      if (page.length < limit) break;
    }
    return seen;
  };

/** Update user 1 with `data` and read its `prefs` back as JSON text. */
const updatedPrefs =
  (data: Record<string, unknown>) =>
  async (db: Db): Promise<Outcome> => {
    await db.table('oe_users').update({ where: { id: 1 }, data });
    const row = await db.table('oe_users').findUnique({ where: { id: 1 }, select: { prefs: true } });
    return JSON.stringify(row?.prefs);
  };

/**
 * Update user 1 with a misspelled operator. Both engines refuse it with E003
 * whatever the message, so the outcome is the refusal's NAME of the bad key.
 */
const misspelledOperator =
  (data: Record<string, unknown>) =>
  async (db: Db): Promise<Outcome> => {
    try {
      await db.table('oe_users').update({ where: { id: 1 }, data });
      return 'written';
    } catch (err) {
      const m = err instanceof ValidationError ? /Unknown update operator ("[^"]+")/.exec(err.message) : null;
      if (!m) throw err;
      return `unknown update operator ${m[1]}`;
    }
  };

/** A middleware that assigns into `params.args`. */
const rewritingMiddleware = async (
  params: { args: Record<string, unknown> },
  next: (p: unknown) => Promise<unknown>,
): Promise<unknown> => {
  params.args.where = { id: 1 };
  return next(params);
};
const ALL_USERS = [1, 2, 3, 4, 5, 6];

// Seed facts the expectations below rely on (oracle/engines/fixture.ts):
//   users  age:      1=34 2=27 3=NULL 4=34 5=19 6=51
//          nickname: 1=ally 2=NULL 3=cc 4=ally 5=NULL 6=Ally
//   posts  (user, rating): 1=(1,4.5) 2=(1,NULL) 3=(1,3) 4=(2,2.5) 5=(4,5) 6=(NULL,1) 7=(5,NULL)
//   comments likes: 1=3 2=NULL 3=0 4=10 5=1 6=NULL 7=2
const CASES: Case[] = [
  // --- options, middleware and paging (builder parity) ---------------------
  {
    id: 'timeout of zero means no timeout',
    run: users({}, { timeout: 0 }),
    expect: ALL_USERS,
  },
  { id: 'negative timeout', run: users({}, { timeout: -5 }), expect: E003 },
  { id: 'timeout past the timer range', run: users({}, { timeout: 3_000_000_000 }), expect: E003 },
  { id: 'timeout as a string', run: users({}, { timeout: '100' }), expect: E003 },
  { id: 'unknown relationLoadStrategy', run: users({}, { relationLoadStrategy: 'lateral' }), expect: E003 },
  { id: 'a valid timeout runs', run: users({ age: 34 }, { timeout: 5000 }), expect: [1, 4] },
  {
    id: 'updateMany with limit',
    write: true,
    run: async (db) =>
      (await db.table('oe_comments').updateMany({ where: { likes: 3 }, data: { likes: 4 }, limit: 1 })).count,
    expect: E003,
  },
  {
    id: 'deleteMany with take',
    write: true,
    run: async (db) => (await db.table('oe_comments').deleteMany({ where: { likes: 3 }, take: 1 })).count,
    expect: E003,
  },
  {
    id: 'deleteMany with skip',
    write: true,
    run: async (db) => (await db.table('oe_comments').deleteMany({ where: { likes: 3 }, skip: 1 })).count,
    expect: E003,
  },
  {
    id: 'middleware rewriting args throws',
    config: {},
    run: async (db) => {
      db.$use(rewritingMiddleware);
      return ids(await db.table('oe_users').findMany({ select: { id: true } }));
    },
    expect: 'error:TypeError',
  },
  {
    id: 'middleware reading args passes',
    config: {},
    run: async (db) => {
      db.$use(async (params: { args: { where?: unknown } }, next: (p: unknown) => Promise<unknown>) => {
        if (!params.args.where) throw new Error('args not visible');
        return next(params);
      });
      return ids(
        await db.table('oe_users').findMany({ where: { age: 34 }, select: { id: true }, orderBy: { id: 'asc' } }),
      );
    },
    expect: [1, 4],
  },

  // --- page-1 tiebreaker: every row exactly once ---------------------------
  { id: 'walk over a tying desc order', run: walk('oe_posts', { views: 'desc' }, 2), expect: [1, 2, 6, 5, 4, 7, 3] },
  { id: 'walk over a tying boolean order', run: walk('oe_users', { active: 'asc' }, 2), expect: [2, 5, 1, 3, 4, 6] },
  {
    id: 'walk over a tying order, pages of 3',
    run: walk('oe_posts', [{ published: 'asc' }], 3),
    expect: [3, 6, 1, 2, 4, 5, 7],
  },

  // --- cursor values (equality rule) ----------------------------------------
  { id: 'cursor holding an operator object', run: users({}, { cursor: { id: { gt: 1 } }, limit: 2 }), expect: E003 },
  { id: 'cursor holding an array', run: users({}, { cursor: { id: [1] }, limit: 2 }), expect: E003 },
  { id: 'cursor naming no column', run: users({}, { cursor: { nope: 1 }, limit: 2 }), expect: E003 },
  {
    id: 'cursor whose every field is undefined',
    run: users({}, { cursor: { id: undefined }, limit: 2 }),
    expect: E003,
  },
  { id: 'cursor: {} names no row', run: users({}, { cursor: {}, limit: 2 }), expect: E003 },
  { id: 'cursor: null names no row', run: users({}, { cursor: null, limit: 2 }), expect: E003 },
  {
    id: 'a valid cursor',
    run: users({}, { cursor: { id: 2 }, limit: 2 }),
    expect: [3, 4],
    powdb: NO_CURSOR,
  },
  {
    id: 'a cursor value written as { equals }',
    run: users({}, { cursor: { id: { equals: 2 } }, limit: 2 }),
    expect: [3, 4],
    powdb: NO_CURSOR,
  },

  // --- combinator shapes refused (E003) -------------------------------------
  { id: 'OR written as an object', run: users({ OR: { age: 34 } }), expect: E003 },
  { id: 'AND as a string', run: users({ AND: 'x' }), expect: E003 },
  { id: 'NOT as a number', run: users({ NOT: 1 }), expect: E003 },
  { id: 'OR null', run: users({ OR: null }), expect: E003 },
  { id: 'OR holding a number', run: users({ OR: [1] }), expect: E003 },
  { id: 'AND holding null', run: users({ AND: [null] }), expect: E003 },
  { id: 'NOT holding a string', run: users({ NOT: ['x'] }), expect: E003 },
  { id: 'malformed OR under NOT', run: users({ NOT: { OR: { age: 34 } } }), expect: E003 },
  {
    id: 'malformed OR inside a relation filter',
    run: users({ oePosts: { some: { OR: { title: 'Draft' } } } }),
    expect: E003,
  },
  {
    id: 'malformed AND inside an every filter',
    run: users({ oePosts: { every: { AND: 'x' } } }),
    expect: E003,
  },
  {
    id: 'malformed OR in a global filter',
    config: { globalFilters: { oe_users: () => ({ OR: { orgId: 1 } }) } },
    run: users({}),
    expect: E003,
  },
  {
    id: 'malformed combinator in a deleteMany where',
    write: true,
    run: async (db) => (await db.table('oe_comments').deleteMany({ where: { OR: { likes: 3 } } })).count,
    expect: E003,
  },

  // --- combinator meanings -------------------------------------------------
  { id: 'OR: [] matches no row', run: users({ OR: [] }), expect: [] },
  { id: 'OR: [] beside a column', run: users({ OR: [], age: 34 }), expect: [] },
  { id: 'NOT over OR: [] matches every row', run: users({ NOT: { OR: [] } }), expect: ALL_USERS },
  { id: 'AND: [] applies no condition', run: users({ AND: [] }), expect: ALL_USERS },
  { id: 'NOT: [] applies no condition', run: users({ NOT: [] }), expect: ALL_USERS },
  { id: 'NOT over an empty object applies no condition', run: users({ NOT: {} }), expect: ALL_USERS },
  { id: 'NOT over AND: [] applies no condition', run: users({ NOT: { AND: [] } }), expect: ALL_USERS },
  { id: 'NOT over OR: [{}] matches no row', run: users({ NOT: { OR: [{}] } }), expect: [] },
  {
    id: 'NOT array with an empty branch',
    run: users({ NOT: [{}, { age: 34 }] }),
    expect: [2, 5, 6],
  },
  {
    id: 'every over AND: [] holds for every parent',
    run: users({ oePosts: { every: { AND: [] } } }),
    expect: ALL_USERS,
  },
  {
    id: 'every over OR: [] holds only for parents without children',
    run: users({ oePosts: { every: { OR: [] } } }),
    expect: [3, 6],
  },
  { id: 'AND written as an object', run: users({ AND: { age: 34 } }), expect: [1, 4] },
  { id: 'OR with an empty member matches every row', run: users({ OR: [{}, { age: 34 }] }), expect: ALL_USERS },
  {
    id: 'NOT array negates each branch',
    run: users({ NOT: [{ age: 34 }, { nickname: 'ally' }] }),
    expect: [6],
  },
  {
    id: 'OR: [] inside a some filter',
    run: users({ oePosts: { some: { OR: [] } } }),
    expect: [],
  },
  {
    id: 'deleteMany with OR: [] deletes nothing',
    write: true,
    run: async (db) => (await db.table('oe_comments').deleteMany({ where: { OR: [] } })).count,
    expect: 0,
  },

  // --- three-valued NOT ------------------------------------------------------
  { id: 'NOT equality excludes NULL', run: users({ NOT: { age: 34 } }), expect: [2, 5, 6] },
  { id: 'NOT on a text column excludes NULL', run: users({ NOT: { nickname: 'ally' } }), expect: [3, 6] },
  { id: 'NOT gt excludes NULL', run: users({ NOT: { age: { gt: 30 } } }), expect: [2, 5] },
  {
    id: 'NOT over OR with a NULL branch',
    run: users({ NOT: { OR: [{ age: 34 }, { nickname: 'cc' }] } }),
    expect: [6],
  },
  {
    id: 'NOT over AND with a NULL branch',
    run: users({ NOT: { AND: [{ age: { gt: 20 } }, { nickname: { not: null } }] } }),
    expect: [2, 5],
  },
  { id: 'double NOT', run: users({ NOT: { NOT: { age: 34 } } }), expect: [1, 4] },
  { id: 'NOT is-null', run: users({ NOT: { nickname: null } }), expect: [1, 3, 4, 6] },
  { id: 'NOT over an empty in', run: users({ NOT: { age: { in: [] } } }), expect: ALL_USERS },
  { id: 'NOT over an empty notIn', run: users({ NOT: { age: { notIn: [] } } }), expect: [] },
  { id: 'NOT on comments likes', run: comments({ NOT: { likes: { gt: 1 } } }), expect: [3, 5] },
  { id: 'not: value excludes NULL', run: users({ age: { not: 34 } }), expect: [2, 5, 6] },
  {
    id: 'not: operator object excludes NULL',
    run: users({ nickname: { not: { contains: 'ally' } } }),
    expect: [3, 6],
  },
  {
    id: 'NOT over a to-one relation keeps a NULL foreign key',
    run: posts({ NOT: { oeUser: { is: { age: 34 } } } }),
    expect: [4, 6, 7],
  },
  {
    id: 'NOT over some keeps parents without children',
    run: users({ NOT: { oePosts: { some: { rating: { gt: 4 } } } } }),
    expect: [2, 3, 5, 6],
  },
  {
    id: 'every with NULL ratings',
    run: users({ oePosts: { every: { rating: { gt: 3 } } } }),
    expect: [3, 4, 5, 6],
  },
  {
    id: 'none with NULL ratings',
    run: users({ oePosts: { none: { rating: { lt: 3 } } } }),
    expect: [1, 3, 4, 5, 6],
  },
  {
    id: 'NOT inside some',
    run: users({ oePosts: { some: { NOT: { rating: { gt: 4 } } } } }),
    expect: [1, 2],
  },
  {
    id: 'NOT inside every',
    run: users({ oePosts: { every: { NOT: { rating: { lt: 3 } } } } }),
    expect: [1, 3, 4, 5, 6],
  },
  {
    id: 'NOT inside none',
    run: users({ oePosts: { none: { NOT: { rating: { gt: 3 } } } } }),
    expect: [3, 4, 5, 6],
  },
  {
    id: 'global filter with NOT excludes NULL',
    config: { globalFilters: { oe_users: { NOT: { nickname: 'ally' } } } },
    run: users({}),
    expect: [3, 6],
  },
  {
    id: 'updateMany under NOT leaves NULL rows alone',
    write: true,
    run: async (db) =>
      (await db.table('oe_comments').updateMany({ where: { NOT: { likes: 3 } }, data: { likes: 9 } })).count,
    expect: 4,
  },

  // --- update values: operator or document ----------------------------------
  {
    id: 'an object written to a json column is the document',
    write: true,
    run: updatedPrefs({ prefs: { replaced: true } }),
    expect: '{"replaced":true}',
  },
  {
    id: 'an operator-shaped object on a json column is the document',
    write: true,
    run: updatedPrefs({ prefs: { increment: 1 } }),
    expect: '{"increment":1}',
  },
  {
    id: 'set on a json column writes its operand',
    write: true,
    run: updatedPrefs({ prefs: { set: { set: 1 } } }),
    expect: '{"set":1}',
  },
  {
    id: 'increment on an integer column',
    write: true,
    run: async (db) =>
      Number((await db.table('oe_users').update({ where: { id: 1 }, data: { age: { increment: 2 } } })).age),
    expect: 36,
  },
  {
    id: 'a misspelled update operator is refused',
    write: true,
    run: misspelledOperator({ age: { incremnt: 2 } }),
    expect: 'unknown update operator "incremnt"',
  },
  {
    id: 'a misspelled update operator on a text column is refused',
    write: true,
    run: misspelledOperator({ nickname: { sett: 'x' } }),
    expect: 'unknown update operator "sett"',
  },

  // --- aggregates over int8 ---------------------------------------------------
  {
    id: '_sum over a bigint column keeps every digit',
    run: async (db) => JSON.stringify((await db.table('oe_users').aggregate({ _sum: { big: true } }))._sum),
    expect: '{"big":"9007199254740996"}',
  },
  {
    id: '_sum over a bigint column is text even when small',
    run: async (db) =>
      JSON.stringify(
        (await db.table('oe_users').aggregate({ where: { id: { in: [2, 4] } }, _sum: { big: true } }))._sum,
      ),
    expect: '{"big":"2"}',
  },
  {
    id: 'groupBy _sum over a bigint column keeps every digit',
    run: async (db) =>
      JSON.stringify(
        await db.table('oe_users').groupBy({
          by: ['id'],
          where: { id: { in: [1, 2] } },
          _sum: { big: true },
          _count: false,
          orderBy: { id: 'asc' },
        }),
      ),
    expect: '[{"id":1,"_sum":{"big":"9007199254740993"}},{"id":2,"_sum":{"big":"-5"}}]',
  },
  {
    id: '_sum over an integer column stays a number',
    run: async (db) => JSON.stringify((await db.table('oe_users').aggregate({ _sum: { age: true } }))._sum),
    expect: '{"age":165}',
  },

  // --- date text against Date columns -----------------------------------------
  { id: 'a date column equals ISO date text', run: users({ birthday: '2000-02-29' }), expect: [3] },
  {
    id: 'a date column ignores the time and zone in its text',
    run: users({ birthday: '2000-02-29T23:30:00-05:00' }),
    expect: [3],
  },
  { id: 'a date column compared with date text', run: users({ birthday: { lt: '1986-01-01' } }), expect: [4, 6] },
  {
    id: 'a date column in a list of date text',
    run: users({ birthday: { in: ['1990-01-31', '1973-12-01'] } }),
    expect: [1, 6],
  },
  {
    id: 'a timestamptz column equals ISO text with an offset',
    run: users({ createdAt: '2026-01-15T14:00:00+02:00' }),
    expect: [4, 5],
  },
  {
    // Postgres reads zone-less text against timestamptz in the session time
    // zone, so which row it names depends on the server. This instant matches
    // no row in any zone, so the Postgres outcome is fixed; PowDB has no
    // session zone and refuses the text instead of guessing one.
    id: 'a timestamptz column with zone-less text',
    run: users({ createdAt: '2026-03-08 06:59:59.998' }),
    expect: [],
    powdb: { expect: E003, why: 'zone-less text against timestamptz needs a session time zone PowDB does not have' },
  },
  {
    id: 'a timestamptz column with date-only text',
    run: users({ createdAt: { lt: '1999-01-01' } }),
    expect: [],
    powdb: { expect: E003, why: 'date-only text against timestamptz is midnight in a session time zone' },
  },
  {
    id: 'a timestamptz column with millisecond text',
    run: users({ createdAt: { gte: '2026-03-29T01:30:00.123Z' } }),
    expect: [2],
  },
  {
    id: 'date text naming no calendar day',
    run: users({ birthday: '2001-02-29' }),
    expect: E003,
  },
  {
    id: 'a date word Postgres reads',
    run: users({ birthday: { lt: 'tomorrow' } }),
    expect: [1, 3, 4, 6],
    powdb: { expect: E003, why: 'PowDB reads ISO 8601 text only; date words are refused, not guessed' },
  },

  // --- operator objects ------------------------------------------------------
  { id: 'operator object naming no operator', run: users({ name: { mode: 'insensitive' } }), expect: E003 },
  { id: 'not object naming no operator', run: users({ name: { not: { mode: 'insensitive' } } }), expect: E003 },
  {
    id: 'operator object emptied by undefined is no filter',
    run: users({ name: { contains: undefined, mode: 'insensitive' } }),
    expect: ALL_USERS,
  },
  {
    id: 'empty operator object',
    run: users({ age: {} }),
    expect: E003,
  },

  // --- distinct ----------------------------------------------------------------
  { id: 'distinct holding a number', run: users({}, { distinct: [1] }), expect: E003 },
  { id: 'distinct holding an array', run: users({}, { distinct: [['name']] }), expect: E003 },

  // --- skipGlobalFilters names ------------------------------------------------
  {
    id: 'skip list by table name',
    config: { globalFilters: { oe_posts: { published: true } } },
    run: posts({}, { skipGlobalFilters: [UNSAFE, 'oe_posts'] }),
    expect: [1, 2, 3, 4, 5, 6, 7],
  },
  {
    id: 'skip list by accessor',
    config: { globalFilters: { oe_posts: { published: true } } },
    run: posts({}, { skipGlobalFilters: [UNSAFE, 'oePosts'] }),
    expect: [1, 2, 3, 4, 5, 6, 7],
  },
  {
    id: 'skip list by accessor reaches a relation filter',
    config: { globalFilters: { oe_posts: { published: true } } },
    run: users({ oePosts: { some: { published: false } } }, { skipGlobalFilters: [UNSAFE, 'oePosts'] }),
    expect: [1],
  },
  {
    id: 'filter still applies without a skip',
    config: { globalFilters: { oe_posts: { published: true } } },
    run: posts({}),
    expect: [1, 2, 4, 5, 7],
  },
  {
    id: 'skip list naming no table on a client with no global filters',
    run: posts({}, { skipGlobalFilters: [UNSAFE, 'oe_postz'] }),
    expect: E003,
  },
  {
    id: 'skip list naming no table',
    config: { globalFilters: { oe_posts: { published: true } } },
    run: posts({}, { skipGlobalFilters: [UNSAFE, 'oe_postz'] }),
    expect: E003,
  },
];

async function outcome(h: EngineHarness, c: Case): Promise<Outcome> {
  try {
    return await h.withClient(c.config, (db) => c.run(db));
  } catch (err) {
    if (err instanceof TurbineError) return `error:${err.constructor.name}:${err.code}`;
    return `error:${err instanceof Error ? err.constructor.name : String(err)}`;
  }
}

describe('PowDB agrees with Postgres on where validity and NULL semantics', () => {
  const oracle = postgresHarness(DATABASE_URL || 'postgres://unset/unset', 'powdb_parity');
  const engine = powdbHarness();

  before(async () => {
    await oracle.setup();
    await engine.setup();
    await oracle.reset();
    await engine.reset();
  });
  after(async () => {
    await engine.teardown();
    await oracle.teardown();
  });

  for (const c of CASES) {
    it(c.id, async () => {
      if (c.write) {
        await oracle.reset();
        await engine.reset();
      }
      const pg = await outcome(oracle, c);
      const pow = await outcome(engine, c);
      assert.deepEqual(pg, c.expect, `postgres: ${c.id}`);
      if (c.powdb) assert.deepEqual(pow, c.powdb.expect, `powdb (${c.powdb.why}): ${c.id}`);
      else assert.deepEqual(pow, pg, `powdb disagrees with postgres: ${c.id}`);
    });
  }

  it('every case ran on both engines', () => {
    assert.ok(CASES.length >= 50, `only ${CASES.length} cases`);
    assert.equal(new Set(CASES.map((c) => c.id)).size, CASES.length, 'two cases share an id');
  });
});
