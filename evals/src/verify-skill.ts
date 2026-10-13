/**
 * Executes every factual claim the packaged skill makes.
 *
 * The skill tells a model what Turbine accepts and what it refuses. That is a
 * claim about the running code, and a claim about running code that nobody runs
 * is how documentation goes stale without anyone noticing. The 0.71.0 candidate
 * skill carried a table saying snake_case column names were REJECTED in
 * `orderBy`, `groupBy`'s `by` and the aggregate targets. It was true when it was
 * written and 0.72.0 made it false, and the only thing that would have caught it
 * is this file.
 *
 * So every row here is one sentence of `skills/turbine-orm/SKILL.md`, executed
 * against the live eval database. If a claim stops being true, this exits
 * non-zero and names the sentence to change.
 *
 * Run: `npm run verify:skill` (needs the seeded eval database).
 */
import { deepStrictEqual } from 'node:assert';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { col, expr, TurbineError, type SchemaMetadata } from 'turbine-orm';
import { assertEvalDatabase, EVAL_DATABASE_URL } from './config.js';
import { closeClient, evalClient } from './execute.js';
import { evalSchema } from './schema-meta.js';

/**
 * A scratch table for the exact-total claim. The eval schema has no bigint or
 * numeric column (its numbers are `integer` and `serial`), so the skill's
 * sentence about `_sum` / `_avg` returning PostgreSQL's exact text over those
 * types had nothing to run against. Created BEFORE the schema is introspected,
 * so `db.table()` knows it, and dropped after the claims run; IF NOT EXISTS plus
 * TRUNCATE make a leftover from an aborted run harmless. The rows are 2^53 + 1
 * twice: the sum is 18014398509481986, which a double renders as ...984, so a
 * Number() anywhere on the path shows up as a wrong digit, not only a wrong type.
 */
const EXACT_TOTALS_TABLE = 'qa78_skill_exact_totals';

async function createExactTotalsFixture(client: pg.Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${EXACT_TOTALS_TABLE} (
       id serial PRIMARY KEY,
       big bigint NOT NULL,
       amount numeric(12,2) NOT NULL,
       small integer NOT NULL
     )`,
  );
  await client.query(`TRUNCATE ${EXACT_TOTALS_TABLE}`);
  await client.query(
    `INSERT INTO ${EXACT_TOTALS_TABLE} (big, amount, small) VALUES (9007199254740993, 1020.50, 3), (9007199254740993, 0.10, 4)`,
  );
}

async function dropExactTotalsFixture(client: pg.Client): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${EXACT_TOTALS_TABLE}`);
}

type Db = ReturnType<typeof evalClient>;
type Args = Record<string, unknown>;

interface Claim {
  /** The sentence in SKILL.md this backs. */
  says: string;
  run: (db: Db) => Promise<void>;
}

/** Runs, and the rows are irrelevant: the claim is only that it is accepted. */
const accepts = (table: string, method: string, args: Args) => async (db: Db) => {
  await call(db, table, method, args);
};

/** Refused with a specific Turbine code. A DIFFERENT code is a failure too. */
const throws = (code: string, table: string, method: string, args: Args) => async (db: Db) => {
  try {
    await call(db, table, method, args);
  } catch (err) {
    if (err instanceof TurbineError && err.code === code) return;
    throw new Error(`expected ${code}, got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  }
  throw new Error(`expected ${code}, but the query was accepted`);
};

/**
 * Refused with a specific code AND a specific phrase in the message.
 *
 * `throws` alone passes on ANY error of that code, and that is how a sentence
 * about WHICH operators a JSON path accepts was "verified" for two releases by
 * an E003 that listed a different set from the one the skill named. When the
 * message IS the claim (the accepted list, the suggested spelling), the check
 * has to read the message.
 */
const throwsSaying = (code: string, phrase: string, table: string, method: string, args: Args) => async (db: Db) => {
  try {
    await call(db, table, method, args);
  } catch (err) {
    if (!(err instanceof TurbineError) || err.code !== code) {
      throw new Error(`expected ${code}, got ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    }
    if (!err.message.includes(phrase)) {
      throw new Error(`expected the ${code} message to say "${phrase}", got: ${err.message.split('\n')[0]}`);
    }
    return;
  }
  throw new Error(`expected ${code}, but the query was accepted`);
};

/**
 * The JSON-path operator set SKILL.md lists, spelled the way the runtime's own
 * refusal message spells it (sorted, so the set and not the order is the claim).
 * If the runtime gains or loses an operator this string stops matching, which
 * is the point: the skill's sentence has to change with it.
 */
const JSON_PATH_OPERATORS =
  'Supported operators: contains, equals, gt, gte, hasKey, lt, lte, mode, path, stringContains, stringEndsWith, stringStartsWith.';

/**
 * Two spellings, one answer. This is the assertion that matters for the whole
 * camelCase/snake_case half of the skill: "accepted" is not the claim, "returns
 * the same rows" is. An arg position that accepted a name and then quietly
 * resolved it to something else is exactly the bug class 0.72.0 fixed.
 */
const same = (table: string, method: string, a: Args, b: Args) => async (db: Db) => {
  const [ra, rb] = await Promise.all([call(db, table, method, a), call(db, table, method, b)]);
  deepStrictEqual(ra, rb);
};

/**
 * Run `fn` inside a transaction that is always rolled back, so a claim about a
 * write can execute the write without changing the seeded eval data. The
 * sentinel is the only error swallowed; a real failure inside `fn` propagates.
 */
const ROLLBACK = Symbol('verify-skill rollback');
async function inRolledBackTx(db: Db, fn: (tx: Db) => Promise<void>): Promise<void> {
  try {
    await db.$transaction(async (tx) => {
      await fn(tx as unknown as Db);
      throw ROLLBACK;
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

/** Expect `fn` to throw a Turbine error with `code`, inside a rolled-back transaction. */
async function throwsInTx(db: Db, code: string, fn: (tx: Db) => Promise<unknown>): Promise<void> {
  let thrown: unknown = null;
  await inRolledBackTx(db, async (tx) => {
    try {
      await fn(tx);
    } catch (err) {
      thrown = err;
    }
  });
  if (thrown instanceof TurbineError && thrown.code === code) return;
  if (thrown === null) throw new Error(`expected ${code}, but the call was accepted`);
  throw new Error(`expected ${code}, got ${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}`);
}

async function call(db: Db, table: string, method: string, args: Args): Promise<unknown> {
  const qi = db.table(table) as unknown as Record<string, (a?: unknown) => Promise<unknown>>;
  const fn = qi[method];
  if (typeof fn !== 'function') throw new Error(`no method ${method} on ${table}`);
  return fn.call(qi, args);
}

const CLAIMS: Claim[] = [
  // ---- relations are `with` ------------------------------------------------
  {
    says: '`with` attaches a relation.',
    run: async (db) => {
      const rows = (await call(db, 'cheese_wheels', 'findMany', {
        select: { id: true },
        with: { affineur: { select: { id: true } } },
        limit: 1,
      })) as Array<Record<string, unknown>>;
      if (!rows[0] || !('affineur' in rows[0])) throw new Error('no affineur key on the row');
    },
  },
  {
    says: '`include` is not Turbine: it is ignored and the relation is missing from the result.',
    run: async (db) => {
      const rows = (await call(db, 'cheese_wheels', 'findMany', {
        select: { id: true },
        include: { affineur: true },
        limit: 1,
      })) as Array<Record<string, unknown>>;
      if (!rows[0] || 'affineur' in rows[0]) throw new Error('`include` attached the relation after all');
    },
  },

  // ---- single-row writes carry findUnique's identity rule ------------------
  // These three run against the real database and write nothing: the refusal
  // happens before any SQL is built, which is itself part of the claim.
  {
    says: '`update` requires a `where` that identifies one row.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'update', {
      where: { status: 'graded' },
      data: { status: 'graded' },
    }),
  },
  {
    says: '`delete` requires a `where` that identifies one row.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'delete', { where: { status: 'graded' } }),
  },
  {
    says: '`updateMany` and `deleteMany` take no `limit`, `take`, `offset` or `skip` (`TURBINE_E003`).',
    run: async (db) => {
      // `where: { id: -1 }` matches no row, so a broken guard writes nothing; the
      // phrase check keeps an unrelated E003 from passing the claim.
      await throwsSaying('TURBINE_E003', 'is not supported on updateMany', 'cheese_wheels', 'updateMany', {
        where: { id: -1 },
        data: { status: 'graded' },
        take: 1,
      })(db);
      await throwsSaying('TURBINE_E003', 'is not supported on deleteMany', 'cheese_wheels', 'deleteMany', {
        where: { id: -1 },
        skip: 1,
      })(db);
    },
  },
  {
    says: "an upsert's `where` names the row to update (the `ON CONFLICT` target when `create` agrees), so a non-unique one is refused, not sent.",
    run: throwsSaying('TURBINE_E003', 'conflict target', 'cheese_wheels', 'upsert', {
      where: { status: 'graded' },
      create: { status: 'graded' },
      update: { status: 'graded' },
    }),
  },
  {
    says: 'a non-unique upsert `where` is refused the same way when `create` does not carry its values (the lookup path).',
    run: throwsSaying('TURBINE_E003', 'conflict target', 'cheese_wheels', 'upsert', {
      where: { status: 'graded' },
      create: {},
      update: { status: 'graded' },
    }),
  },

  // ---- relation naming ----------------------------------------------------
  {
    says: 'belongsTo is the target table singularised and camelCased (`guild_id` gives `guild`).',
    run: accepts('affineurs', 'findMany', { select: { id: true }, with: { guild: true }, limit: 1 }),
  },
  {
    says: 'hasMany keeps the child table name, camelCased and plural (`cheeseWheels`).',
    run: accepts('guilds', 'findMany', { select: { id: true }, with: { cheeseWheels: true }, limit: 1 }),
  },
  {
    says: 'manyToMany is named for the far table, not the junction (`cultures`).',
    run: accepts('cheese_wheels', 'findMany', { select: { id: true }, with: { cultures: true }, limit: 1 }),
  },
  {
    says: 'the junction is ALSO a plain hasMany, and picking it gives junction rows.',
    run: accepts('cheese_wheels', 'findMany', { select: { id: true }, with: { wheelCultures: true }, limit: 1 }),
  },

  // ---- either spelling, same answer ---------------------------------------
  {
    says: 'a snake_case COLUMN resolves in `where`.',
    run: same('affineurs', 'findMany', { where: { ledger_handle: { startsWith: 'A' } }, orderBy: { id: 'asc' } },
      { where: { ledgerHandle: { startsWith: 'A' } }, orderBy: { id: 'asc' } }),
  },
  {
    says: 'a snake_case COLUMN resolves in `select`.',
    run: same('affineurs', 'findMany', { select: { given_name: true }, orderBy: { id: 'asc' }, limit: 3 },
      { select: { givenName: true }, orderBy: { id: 'asc' }, limit: 3 }),
  },
  {
    says: 'a snake_case COLUMN resolves in `omit`.',
    run: same('affineurs', 'findMany', { omit: { credential_blob: true }, orderBy: { id: 'asc' }, limit: 3 },
      { omit: { credentialBlob: true }, orderBy: { id: 'asc' }, limit: 3 }),
  },
  {
    says: 'a snake_case COLUMN resolves in `orderBy` (0.72.0; it was E003 before).',
    run: same('cheese_wheels', 'findMany', { select: { id: true }, orderBy: [{ pressed_on: 'desc' }, { id: 'asc' }], limit: 5 },
      { select: { id: true }, orderBy: [{ pressedOn: 'desc' }, { id: 'asc' }], limit: 5 }),
  },
  {
    says: 'a snake_case COLUMN resolves in `distinct`.',
    run: same('cheese_wheels', 'findMany', { select: { rind_style: true }, distinct: ['rind_style'], orderBy: { rind_style: 'asc' } },
      { select: { rindStyle: true }, distinct: ['rindStyle'], orderBy: { rindStyle: 'asc' } }),
  },
  {
    says: 'a snake_case COLUMN resolves in `cursor`, and it pages the same way.',
    run: same('cheese_wheels', 'findMany', { select: { id: true }, cursor: { id: 10 }, orderBy: { id: 'asc' }, limit: 5 },
      { select: { id: true }, cursor: { id: 10 }, orderBy: { id: 'asc' }, limit: 5 }),
  },
  {
    says: "a snake_case COLUMN resolves in groupBy's `by` (0.72.0).",
    run: same('cheese_wheels', 'groupBy', { by: ['rind_style'], _count: { id: true }, orderBy: { rind_style: 'asc' } },
      { by: ['rindStyle'], _count: { id: true }, orderBy: { rindStyle: 'asc' } }),
  },
  {
    says: 'a snake_case COLUMN resolves in the aggregate targets (0.72.0).',
    run: same('ripening_checks', 'aggregate', { _avg: { aroma_score: true }, _max: { rind_score: true } },
      { _avg: { aromaScore: true }, _max: { rindScore: true } }),
  },
  {
    says: 'a snake_case RELATION resolves in `with` (0.72.0).',
    run: same('ripening_checks', 'findMany', { select: { id: true }, with: { cheese_wheel: { select: { id: true } } }, orderBy: { id: 'asc' }, limit: 5 },
      { select: { id: true }, with: { cheeseWheel: { select: { id: true } } }, orderBy: { id: 'asc' }, limit: 5 }),
  },
  {
    says: 'a snake_case RELATION resolves in a relation filter (0.72.0).',
    run: same('guilds', 'findMany', { select: { id: true }, where: { cheese_wheels: { some: { status: 'graded' } } }, orderBy: { id: 'asc' } },
      { select: { id: true }, where: { cheeseWheels: { some: { status: 'graded' } } }, orderBy: { id: 'asc' } }),
  },
  {
    says: 'a snake_case RELATION resolves in `_count` and in a relation `orderBy` (0.72.0).',
    run: same('guilds', 'findMany', { select: { id: true }, with: { _count: { cheese_wheels: true } }, orderBy: { cheese_wheels: { _count: 'desc' } }, limit: 3 },
      { select: { id: true }, with: { _count: { cheeseWheels: true } }, orderBy: { cheeseWheels: { _count: 'desc' } }, limit: 3 }),
  },
  {
    says: 'a name that is neither spelling is still refused.',
    run: throws('TURBINE_E003', 'affineurs', 'findMany', { where: { ledger_handel: 'x' } }),
  },
  {
    says: 'a relation name that is neither spelling is still refused.',
    run: throws('TURBINE_E005', 'affineurs', 'findMany', { with: { cheese_wheelz: true } }),
  },

  // ---- projection shape ---------------------------------------------------
  {
    says: '`select` may not name a relation.',
    run: throws('TURBINE_E003', 'affineurs', 'findMany', { select: { id: true, cheeseWheels: true } }),
  },
  {
    says: '`select` and `omit` together are refused.',
    run: throws('TURBINE_E003', 'affineurs', 'findMany', { select: { id: true }, omit: { retiredAt: true } }),
  },
  {
    says: 'a `select` naming no field is refused.',
    run: throws('TURBINE_E003', 'affineurs', 'findMany', { select: {} }),
  },

  // ---- where operators ----------------------------------------------------
  {
    says: 'the WHERE operator set: equals/not/gt/gte/lt/lte/in/notIn/contains/startsWith/endsWith, null, and mode.',
    run: accepts('cheese_wheels', 'findMany', {
      select: { id: true },
      where: {
        status: 'graded',
        cave_humidity_pct: { gte: 90, lte: 94 },
        rind_style: { in: ['washed', 'waxed'] },
        batch_ref: { startsWith: 'WB-' },
        wheel_count: { not: 0 },
      },
    }),
  },
  {
    says: 'a bare null means IS NULL.',
    run: accepts('affineurs', 'findMany', { select: { id: true }, where: { retired_at: null } }),
  },
  {
    says: 'mode: "insensitive" applies to a string operator.',
    run: accepts('affineurs', 'findMany', { select: { id: true }, where: { given_name: { contains: 'a', mode: 'insensitive' } } }),
  },
  {
    says: 'AND / OR / NOT nest, and AND / OR take arrays.',
    run: accepts('cheese_wheels', 'findMany', {
      select: { id: true },
      where: { OR: [{ status: 'graded' }, { AND: [{ wheel_count: { gt: 2 } }, { NOT: { rind_style: 'waxed' } }] }] },
    }),
  },

  // ---- relation filters ---------------------------------------------------
  {
    says: 'some / none / every filter parents by their children and add nothing to the result.',
    run: async (db) => {
      const rows = (await call(db, 'guilds', 'findMany', {
        select: { id: true },
        where: { cheeseWheels: { some: { status: 'quarantined' } } },
      })) as Array<Record<string, unknown>>;
      if (rows.some((r) => 'cheeseWheels' in r)) throw new Error('a relation filter projected the relation');
    },
  },
  {
    says: '`none: {}` means the parent has no rows at all.',
    run: accepts('affineurs', 'findMany', { select: { id: true }, where: { ripeningChecks: { none: {} } } }),
  },

  // ---- per-relation options ----------------------------------------------
  {
    says: 'a per-relation `limit` applies PER PARENT, not to the result overall.',
    run: async (db) => {
      const rows = (await call(db, 'guilds', 'findMany', {
        select: { id: true },
        with: { cheeseWheels: { select: { id: true }, orderBy: { id: 'asc' }, limit: 3 } },
        limit: 4,
      })) as Array<{ cheeseWheels: unknown[] }>;
      if (rows.length < 2) throw new Error('fixture too small to show per-parent limiting');
      if (!rows.every((r) => r.cheeseWheels.length <= 3)) throw new Error('a parent exceeded its limit');
      const total = rows.reduce((n, r) => n + r.cheeseWheels.length, 0);
      if (total <= 3) throw new Error('limit behaved as a global cap, which would make the claim false');
    },
  },
  {
    says: '`with` nests, and each level takes its own where / orderBy / limit / select.',
    run: accepts('guilds', 'findMany', {
      select: { id: true },
      with: {
        affineurs: {
          select: { id: true },
          where: { is_journeyman: true },
          orderBy: { id: 'desc' },
          limit: 3,
          with: { cheeseWheels: { select: { id: true }, limit: 2 } },
        },
      },
      limit: 2,
    }),
  },

  // ---- ordering and paging ------------------------------------------------
  {
    says: '`orderBy` takes an array of objects, applied in order as tie breakers.',
    run: accepts('cheese_wheels', 'findMany', { select: { id: true }, orderBy: [{ pressedOn: 'desc' }, { id: 'desc' }], limit: 5 }),
  },
  {
    says: '`orderBy` accepts a relation `_count`.',
    run: accepts('guilds', 'findMany', { select: { id: true }, orderBy: { affineurs: { _count: 'desc' } }, limit: 3 }),
  },
  {
    says: '`orderBy` accepts a JSON path with a direction.',
    run: accepts('cheese_wheels', 'findMany', { select: { id: true }, orderBy: { tastingNotes: { path: ['panel', 'score'], direction: 'desc' } }, limit: 5 }),
  },
  {
    says: '`take` and `skip` are accepted as aliases for `limit` and `offset`.',
    run: same('cheese_wheels', 'findMany', { select: { id: true }, orderBy: { id: 'asc' }, take: 3, skip: 2 },
      { select: { id: true }, orderBy: { id: 'asc' }, limit: 3, offset: 2 }),
  },

  // ---- JSON ---------------------------------------------------------------
  {
    says: 'a JSON column is filtered by `path` plus the normal operators.',
    run: accepts('cheese_wheels', 'findMany', { select: { id: true }, where: { tastingNotes: { path: ['panel', 'score'], gte: 9 } } }),
  },
  {
    says: 'a JSON path works as a groupBy key via { field, path }.',
    run: accepts('cheese_wheels', 'groupBy', { by: [{ field: 'tastingNotes', path: ['panel', 'verdict'] }], _count: { id: true } }),
  },
  {
    says: 'a JSON path takes a DIFFERENT operator set: equals/gt/gte/lt/lte/hasKey/contains/stringContains/stringStartsWith/stringEndsWith plus mode.',
    run: accepts('cheese_wheels', 'findMany', {
      select: { id: true },
      where: {
        OR: [
          { tastingNotes: { path: ['panel', 'score'], gte: 9 } },
          { tastingNotes: { path: ['panel', 'score'], lt: 3 } },
          { tastingNotes: { path: ['panel', 'verdict'], equals: 'hold' } },
          { tastingNotes: { hasKey: 'descriptors' } },
          { tastingNotes: { contains: { panel: { seats: 4 } } } },
          { tastingNotes: { path: ['descriptors', '0'], stringContains: 'a' } },
          { tastingNotes: { path: ['descriptors', '0'], stringStartsWith: 'B', mode: 'insensitive' } },
          { tastingNotes: { path: ['descriptors', '1'], stringEndsWith: 'y' } },
        ],
      },
    }),
  },
  {
    says: '`contains` on a JSON column is containment (a whole sub-document), not a substring test.',
    run: async (db) => {
      // Containment of `{ panel: { seats: 4 } }` and equality at the path
      // `panel.seats` select the same rows; a substring reading of `contains`
      // could not even take an object operand. Asserted non-empty so the
      // equality is not two empty arrays agreeing.
      const byContainment = (await call(db, 'cheese_wheels', 'findMany', {
        select: { id: true },
        where: { tastingNotes: { contains: { panel: { seats: 4 } } } },
        orderBy: { id: 'asc' },
      })) as unknown[];
      const byPath = await call(db, 'cheese_wheels', 'findMany', {
        select: { id: true },
        where: { tastingNotes: { path: ['panel', 'seats'], equals: 4 } },
        orderBy: { id: 'asc' },
      });
      if (byContainment.length === 0) throw new Error('no wheel has panel.seats = 4; fixture too small to back the claim');
      deepStrictEqual(byContainment, byPath);
    },
  },
  {
    says: 'not / in / notIn / startsWith / endsWith are REFUSED on a JSON path with E003, and the message lists the accepted set.',
    run: async (db) => {
      for (const filter of [
        { path: ['panel', 'verdict'], not: 'hold' },
        { path: ['panel', 'verdict'], in: ['hold'] },
        { path: ['panel', 'verdict'], notIn: ['hold'] },
        { path: ['panel', 'verdict'], startsWith: 'ho' },
        { path: ['panel', 'verdict'], endsWith: 'ld' },
      ]) {
        await throwsSaying('TURBINE_E003', JSON_PATH_OPERATORS, 'cheese_wheels', 'findMany', {
          where: { tastingNotes: filter },
        })(db);
      }
    },
  },
  {
    says: 'the refusal of startsWith / endsWith on a path points at the string* spelling.',
    run: async (db) => {
      await throwsSaying('TURBINE_E003', 'Did you mean `stringStartsWith`?', 'cheese_wheels', 'findMany', {
        where: { tastingNotes: { path: ['panel', 'verdict'], startsWith: 'ho' } },
      })(db);
      await throwsSaying('TURBINE_E003', 'Did you mean `stringEndsWith`?', 'cheese_wheels', 'findMany', {
        where: { tastingNotes: { path: ['panel', 'verdict'], endsWith: 'ld' } },
      })(db);
    },
  },
  {
    says: 'groupBy _sum / _avg / _min / _max accept a JSON path as { field, path } under an alias key, and the alias is the result key.',
    run: async (db) => {
      const rows = (await call(db, 'cheese_wheels', 'groupBy', {
        by: ['rindStyle'],
        _sum: { score: { field: 'tastingNotes', path: ['panel', 'score'] } },
        _avg: { meanScore: { field: 'tastingNotes', path: ['panel', 'score'] } },
        _min: { lowest: { field: 'tastingNotes', path: ['panel', 'score'], type: 'numeric' } },
        _max: { highest: { field: 'tastingNotes', path: ['panel', 'score'] } },
        orderBy: { rindStyle: 'asc' },
      })) as Array<Record<string, Record<string, unknown> | undefined>>;
      if (rows.length === 0) throw new Error('groupBy returned no groups; fixture too small to back the claim');
      const blocks: Array<[string, string]> = [
        ['_sum', 'score'],
        ['_avg', 'meanScore'],
        ['_min', 'lowest'],
        ['_max', 'highest'],
      ];
      for (const [block, alias] of blocks) {
        if (!rows.every((r) => r[block] !== undefined && alias in r[block])) {
          throw new Error(`${block}.${alias} is missing from a group row`);
        }
      }
      if (!rows.some((r) => r._sum?.score !== null)) throw new Error('every _sum.score is null, so the path was not aggregated');
    },
  },
  {
    says: 'aggregate() has no JSON-path form: a { field, path } object is read as `true`, so the whole column reaches the database as avg(jsonb), which the database refuses; that surfaces as TURBINE_E003 with sqlstate 42883, not a Turbine check naming the path.',
    run: async (db) => {
      try {
        await call(db, 'cheese_wheels', 'aggregate', {
          _avg: { tastingNotes: { field: 'tastingNotes', path: ['panel', 'score'] } },
        });
      } catch (err) {
        // 42883 undefined_function, `function avg(jsonb) does not exist`, which
        // wrapPgError types as ValidationError keeping the SQLSTATE. A Turbine
        // check that refused the path itself would carry no sqlstate.
        if (!(err instanceof TurbineError) || err.code !== 'TURBINE_E003') {
          throw new Error(
            `expected TURBINE_E003 from the database's 42883, got ${err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}` : String(err)}`,
          );
        }
        const sqlstate = (err as { sqlstate?: string }).sqlstate;
        if (sqlstate !== '42883') {
          throw new Error(
            `expected sqlstate 42883 (avg(jsonb) does not exist), got ${String(sqlstate)}: ${err.message.split('\n')[0]}; the aggregate() sentence is now wrong`,
          );
        }
        return;
      }
      throw new Error('a JSON-path aggregate() succeeded, so the aggregate() sentence is now wrong');
    },
  },
  {
    says: 'an aggregate() key that is not a column is E003, whatever its value.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'aggregate', {
      _sum: { score: { field: 'tastingNotes', path: ['panel', 'score'] } },
    }),
  },
  {
    says: '_count never takes a path: an object under a _count key is read as `true` and any path in it is ignored.',
    run: same(
      'cheese_wheels',
      'groupBy',
      { by: ['rindStyle'], _count: { tastingNotes: { path: ['panel'] } }, orderBy: { rindStyle: 'asc' } },
      { by: ['rindStyle'], _count: { tastingNotes: true }, orderBy: { rindStyle: 'asc' } },
    ),
  },

  // ---- aggregates and groupBy --------------------------------------------
  {
    says: 'aggregate takes _avg / _min / _max / _sum / _count alongside a where.',
    run: accepts('ripening_checks', 'aggregate', {
      where: { rindScore: { gte: 8 } },
      _avg: { aromaScore: true },
      _max: { aromaScore: true },
      _count: { id: true },
    }),
  },
  {
    says: "_sum / _avg over int8 / bigint and numeric / decimal columns return PostgreSQL's exact text as a string; over int4 they return a number.",
    run: async (db) => {
      const truth = await db.sql<{ sum_big: string; avg_big: string; sum_amount: string; avg_amount: string }>`
        SELECT sum(big)::text AS sum_big, avg(big)::text AS avg_big,
               sum(amount)::text AS sum_amount, avg(amount)::text AS avg_amount
        FROM qa78_skill_exact_totals`.one();
      if (!truth) throw new Error(`${EXACT_TOTALS_TABLE} is empty; the fixture did not seed`);
      if (truth.sum_big !== '18014398509481986') throw new Error(`fixture drifted: sum(big) is ${truth.sum_big}`);
      const agg = (await call(db, EXACT_TOTALS_TABLE, 'aggregate', {
        _sum: { big: true, amount: true, small: true },
        _avg: { big: true, amount: true, small: true },
      })) as { _sum: Record<string, unknown>; _avg: Record<string, unknown> };
      // Compared as STRINGS against the database's own rendering, so a Number()
      // on the path fails on the value (…984 vs …986) and on the type at once.
      deepStrictEqual(agg._sum.big, truth.sum_big);
      deepStrictEqual(agg._avg.big, truth.avg_big);
      deepStrictEqual(agg._sum.amount, truth.sum_amount);
      deepStrictEqual(agg._avg.amount, truth.avg_amount);
      if (typeof agg._sum.small !== 'number' || typeof agg._avg.small !== 'number') {
        throw new Error(`int4 totals should stay numbers, got ${typeof agg._sum.small} / ${typeof agg._avg.small}`);
      }
    },
  },
  {
    says: 'groupBy `having` is column first, aggregate second.',
    run: accepts('cheese_wheels', 'groupBy', {
      by: ['rindStyle'],
      _count: { id: true },
      having: { id: { _count: { gt: 5 } } },
      orderBy: { rindStyle: 'asc' },
    }),
  },
  {
    says: 'a `having` on a summed column reads the same way.',
    run: accepts('cheese_wheels', 'groupBy', {
      by: ['rindStyle'],
      _sum: { wheelCount: true },
      having: { wheelCount: { _sum: { gt: 100 } } },
    }),
  },

  // ---- unique lookups -----------------------------------------------------
  {
    says: 'findUnique on a single-column unique names the column.',
    run: accepts('cultures', 'findUnique', { where: { cultureCode: 'PR-01' } }),
  },
  {
    says: 'a compound unique is addressed by its joined selector, in either spelling, or flat.',
    run: async (db) => {
      const a = await call(db, 'cheese_wheels', 'findUnique', { where: { guildId_batchRef: { guildId: 1, batchRef: 'WB-0001' } } });
      const b = await call(db, 'cheese_wheels', 'findUnique', { where: { guild_id_batch_ref: { guildId: 1, batchRef: 'WB-0001' } } });
      const c = await call(db, 'cheese_wheels', 'findUnique', { where: { guildId: 1, batchRef: 'WB-0001' } });
      deepStrictEqual(a, b);
      deepStrictEqual(a, c);
    },
  },
  {
    says: 'a non-unique column in findUnique is refused; use findFirst.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'findUnique', { where: { status: 'graded' } }),
  },

  // ---- count --------------------------------------------------------------
  {
    says: '`count` answers "how many" and returns a number, not rows.',
    run: async (db) => {
      const n = await call(db, 'cheese_wheels', 'count', { where: { status: 'graded' } });
      if (typeof n !== 'number') throw new Error(`count returned ${typeof n}`);
    },
  },
  // ---- 0.90 additions (proposed rows) ---------------------------------------
  {
    says: '`not` also takes an operator object: `givenName: { not: { contains: \'Roux\' } }`.',
    run: async (db) => {
      const all = (await call(db, 'affineurs', 'findMany', { select: { id: true }, where: { givenName: { not: null } } })) as unknown[];
      const hit = (await call(db, 'affineurs', 'findMany', { select: { id: true }, where: { givenName: { contains: 'Roux' } } })) as unknown[];
      const neg = (await call(db, 'affineurs', 'findMany', { select: { id: true }, where: { givenName: { not: { contains: 'Roux' } } } })) as unknown[];
      if (hit.length === 0) throw new Error('fixture has no Roux, the claim tests nothing');
      if (neg.length + hit.length !== all.length) throw new Error(`not-contains ${neg.length} + contains ${hit.length} != ${all.length}`);
    },
  },
  {
    says: 'To compare two columns, wrap the other one in `col()`: `rindScore: { gt: col(\'aromaScore\') }`.',
    run: async (db) => {
      const rows = (await call(db, 'ripening_checks', 'findMany', {
        select: { rindScore: true, aromaScore: true },
        where: { rindScore: { gt: col('aromaScore') } },
      })) as Array<{ rindScore: number; aromaScore: number }>;
      if (rows.length === 0) throw new Error('no rows, the claim tests nothing');
      for (const r of rows) if (!(r.rindScore > r.aromaScore)) throw new Error(`row ${JSON.stringify(r)} violates gt`);
    },
  },
  {
    says: 'A plain `{ col: \'x\' }` object is refused with `TURBINE_E003`.',
    run: throws('TURBINE_E003', 'ripening_checks', 'findMany', { where: { rindScore: { gt: { col: 'aromaScore' } } } }),
  },
  {
    says: 'an operand that does not fit its operator, such as an array for `equals`, is refused with `TURBINE_E003`.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'findMany', { where: { wheelCount: { equals: [1, 2] } } }),
  },
  {
    says: 'an operand that does not fit its operator, such as `null` for `gt`, is refused with `TURBINE_E003`.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'findMany', { where: { wheelCount: { gt: null } } }),
  },
  {
    says: 'A key whose value is `undefined` is left out, as in Prisma.',
    run: same('cheese_wheels', 'findMany', { select: { id: true }, where: { status: 'graded', batchRef: undefined }, orderBy: { id: 'asc' }, limit: 20 },
      { select: { id: true }, where: { status: 'graded' }, orderBy: { id: 'asc' }, limit: 20 }),
  },
  {
    says: 'When that empties the whole `where`, `findFirst` throws `TURBINE_E003`.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'findFirst', { where: { batchRef: undefined } }),
  },
  {
    says: 'A cursor names the last row by a unique key; the page excludes that row and continues in the query\'s `orderBy`, with the primary key added as a tiebreaker.',
    run: async (db) => {
      const page = (await call(db, 'cheese_wheels', 'findMany', {
        select: { id: true, pressedOn: true }, orderBy: { pressedOn: 'desc' }, limit: 40,
      })) as Array<{ id: number }>;
      const anchor = page[9]!;
      const next = (await call(db, 'cheese_wheels', 'findMany', {
        select: { id: true, pressedOn: true }, orderBy: { pressedOn: 'desc' }, cursor: { id: anchor.id }, limit: 5,
      })) as Array<{ id: number }>;
      if (next.some((r) => r.id === anchor.id)) throw new Error('cursor row was included');
      const full = (await call(db, 'cheese_wheels', 'findMany', {
        select: { id: true, pressedOn: true }, orderBy: [{ pressedOn: 'desc' }, { id: 'desc' }],
      })) as Array<{ id: number }>;
      const at = full.findIndex((r) => r.id === anchor.id);
      deepStrictEqual(next.map((r) => r.id), full.slice(at + 1, at + 6).map((r) => r.id));
    },
  },
  {
    says: '`equals` at a path compares JSON values, so `equals: null` matches a JSON `null` and not the string `"null"`.',
    run: accepts('affineurs', 'findMany', { select: { id: true }, where: { credentialBlob: { path: ['tier'], equals: null } } }),
  },
  {
    says: 'Without a `path`, `equals` compares the whole document exactly.',
    run: async (db) => {
      const one = (await call(db, 'affineurs', 'findFirst', {
        select: { id: true, credentialBlob: true }, where: { credentialBlob: { not: null } }, orderBy: { id: 'asc' },
      })) as { id: number; credentialBlob: Record<string, unknown> } | null;
      if (!one) throw new Error('no JSON document in the fixture');
      const keys = Object.keys(one.credentialBlob);
      if (keys.length < 2) throw new Error('document too small to test containment vs equality');
      const partial = { [keys[0]!]: one.credentialBlob[keys[0]!] };
      const exact = (await call(db, 'affineurs', 'findMany', { select: { id: true }, where: { id: one.id, credentialBlob: { equals: one.credentialBlob } } })) as unknown[];
      const sub = (await call(db, 'affineurs', 'findMany', { select: { id: true }, where: { id: one.id, credentialBlob: { equals: partial } } })) as unknown[];
      if (exact.length !== 1) throw new Error('whole document did not match itself');
      if (sub.length !== 0) throw new Error('a sub-document matched: equals is still containment');
    },
  },
  // ---- 0.90 Wave C (proposed rows) -------------------------------------------
  {
    says: '`_percentile: { aromaScore: { p: 0.9 } }` returns the 90th percentile, on PostgreSQL only.',
    run: async (db) => {
      const r = (await call(db, 'ripening_checks', 'aggregate', {
        _percentile: { aromaScore: { p: 0.9 } }, _min: { aromaScore: true }, _max: { aromaScore: true },
      })) as { _percentile: { aromaScore: number }; _min: { aromaScore: number }; _max: { aromaScore: number } };
      const v = r._percentile.aromaScore;
      if (typeof v !== 'number') throw new Error(`percentile is ${typeof v}, not a number`);
      if (v < r._min.aromaScore || v > r._max.aromaScore) throw new Error(`percentile ${v} outside [${r._min.aromaScore}, ${r._max.aromaScore}]`);
    },
  },
  {
    says: '`p` may be an array of fractions, and the result is then an array in the same order.',
    run: async (db) => {
      const r = (await call(db, 'ripening_checks', 'aggregate', {
        _percentile: { aromaScore: { p: [0.1, 0.5, 0.9] } },
      })) as { _percentile: { aromaScore: number[] } };
      const v = r._percentile.aromaScore;
      if (!Array.isArray(v) || v.length !== 3) throw new Error(`expected an array of 3, got ${JSON.stringify(v)}`);
      if (!(v[0]! <= v[1]! && v[1]! <= v[2]!)) throw new Error(`not in fraction order: ${JSON.stringify(v)}`);
    },
  },
  {
    says: "The default `method: 'cont'` interpolates and is refused on a date column with `TURBINE_E003`; use `method: 'disc'` there.",
    run: async (db) => {
      await throwsSaying('TURBINE_E003', "method: 'disc'", 'cheese_wheels', 'aggregate', { _percentile: { pressedOn: { p: 0.5 } } })(db);
      const r = (await call(db, 'cheese_wheels', 'aggregate', { _percentile: { pressedOn: { p: 0.5, method: 'disc' } } })) as {
        _percentile: { pressedOn: unknown };
      };
      if (!(r._percentile.pressedOn instanceof Date)) throw new Error(`disc on a date returned ${typeof r._percentile.pressedOn}`);
    },
  },
  {
    says: 'To set a column from the row\'s own values, build the value with `expr` and `col()`.',
    run: (db) =>
      inRolledBackTx(db, async (tx) => {
        const before = (await call(tx, 'cheese_wheels', 'findUnique', { where: { id: 7 }, select: { wheelCount: true } })) as { wheelCount: number };
        const after = (await call(tx, 'cheese_wheels', 'update', {
          where: { id: 7 }, data: { wheelCount: expr.add(col('wheelCount'), 1) }, select: { wheelCount: true },
        })) as { wheelCount: number };
        if (after.wheelCount !== before.wheelCount + 1) throw new Error(`${before.wheelCount} + 1 gave ${after.wheelCount}`);
      }),
  },
  {
    says: 'A plain object shaped like an expression (`{ kind: \'add\', args: [1, 2] }`) is refused with `TURBINE_E003`.',
    run: (db) => throwsInTx(db, 'TURBINE_E003', (tx) =>
      call(tx, 'cheese_wheels', 'update', { where: { id: 7 }, data: { wheelCount: { kind: 'add', args: [1, 2] } } })),
  },
  {
    says: 'and so is an expression in `create` data.',
    run: (db) => throwsInTx(db, 'TURBINE_E003', (tx) =>
      call(tx, 'ripening_checks', 'create', {
        data: { cheeseWheelId: 7, affineurId: 1, checkedOn: new Date('2026-01-01'), rindScore: expr.add(1, 2), aromaScore: 1 },
      })),
  },
  {
    says: '`createMany` with `onConflict` inserts the new keys and updates the rows that already exist.',
    run: (db) =>
      inRolledBackTx(db, async (tx) => {
        const row = (await call(tx, 'cheese_wheels', 'findUnique', { where: { id: 7 } })) as Record<string, unknown>;
        const { id: _id, ...rest } = row;
        const total = (await call(tx, 'cheese_wheels', 'count', {})) as number;
        const fresh = { ...rest, batchRef: 'VERIFY-SKILL-NEW', status: 'verify-new' };
        const out = (await call(tx, 'cheese_wheels', 'createMany', {
          data: [{ ...rest, status: 'verify-upserted' }, fresh],
          onConflict: { target: ['guildId', 'batchRef'], update: ['status'] },
        })) as Array<{ id: number; status: string; batchRef: string }>;
        const updated = out.find((r) => r.id === 7);
        if (!updated || updated.status !== 'verify-upserted') throw new Error(`existing row not updated: ${JSON.stringify(out)}`);
        if (!out.some((r) => r.batchRef === 'VERIFY-SKILL-NEW')) throw new Error('new key not inserted');
        const after = (await call(tx, 'cheese_wheels', 'count', {})) as number;
        if (after !== total + 1) throw new Error(`count went ${total} -> ${after}, expected +1`);
      }),
  },
  {
    says: 'The target must be the primary key or one whole unique key; any other column list is refused with `TURBINE_E003`.',
    run: (db) => throwsInTx(db, 'TURBINE_E003', async (tx) => {
      const row = (await call(tx, 'cheese_wheels', 'findUnique', { where: { id: 7 } })) as Record<string, unknown>;
      const { id: _id, ...rest } = row;
      return call(tx, 'cheese_wheels', 'createMany', { data: [rest], onConflict: { target: ['batchRef'], update: ['status'] } });
    }),
  },
  {
    says: "`lock: 'update'` on `findMany`, `findFirst` or `findUnique` locks the rows it returns; it must run on the `tx` inside `db.$transaction`.",
    run: (db) =>
      inRolledBackTx(db, async (tx) => {
        const r = (await call(tx, 'cheese_wheels', 'findFirst', { where: { status: 'graded' }, orderBy: { id: 'asc' }, lock: 'update' })) as { id: number } | null;
        if (!r) throw new Error('no row, the claim tests nothing');
        const held = (await (tx as unknown as { rawUnsafe: (t: string) => Promise<Array<{ n: number }>> }).rawUnsafe(
          "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'transactionid' AND pid = pg_backend_pid()",
        ))[0]!.n;
        if (held < 1) throw new Error('FOR UPDATE took no transaction lock');
      }),
  },
  {
    says: 'on `db` it throws `TURBINE_E003`.',
    run: throws('TURBINE_E003', 'cheese_wheels', 'findFirst', { orderBy: { id: 'asc' }, lock: 'update' }),
  },
];

/** SKILL.md's frontmatter name. Read back to prove the right file was opened. */
const SKILL_IDENTITY = 'name: turbine-orm';

/**
 * Second gate: does CLAIMS still describe most of what SKILL.md asserts?
 *
 * Every claim above is hand-written, so a sentence ADDED to SKILL.md becomes an
 * unverified claim silently: the loop above still reports "46/46 hold" while
 * the file it speaks for has grown past it. That is the same shape as a suite
 * that skips every test and reports green. This counts the skill's assertive
 * sentences and refuses a large gap.
 *
 * The count is a heuristic, deliberately: recognising an assertion in prose is
 * not decidable, and this only has to notice a file that has roughly doubled
 * without anyone adding rows. The ratio can exceed 100%, because several claims
 * routinely back one sentence.
 *
 * Fails closed on every ambiguous input. An unreadable file, a file that is not
 * SKILL.md, and a zero-sentence parse are all refusals rather than passes: a
 * denominator of zero would otherwise make the ratio infinite and the gate
 * green precisely when the parse has broken.
 *
 * @returns true when coverage is adequate, false when the run must fail.
 */
function claimCoverageHolds(): boolean {
  const MIN_RATIO = 0.5;
  let skillText: string;
  const skillPath = new URL('../../skills/turbine-orm/SKILL.md', import.meta.url);
  try {
    skillText = readFileSync(skillPath, 'utf8');
  } catch (err) {
    console.error(`\ncould not read ${skillPath.pathname}: ${err instanceof Error ? err.message : String(err)}`);
    console.error('The skill is a published file (package.json `files`), so this is a refusal, not a skip.');
    return false;
  }

  if (!skillText.includes(SKILL_IDENTITY)) {
    console.error(`\n${skillPath.pathname} does not contain "${SKILL_IDENTITY}"; this is not the shipped skill.`);
    return false;
  }

  const assertiveSentences = skillText
    .split('\n')
    .filter((l) => !l.startsWith('#') && !l.startsWith('```') && !l.startsWith('|'))
    .join(' ')
    .split(/(?<=\.)\s+/)
    .filter((s) => /\b(returns?|throws?|accepts?|rejects?|emits?|is|are|must|never|always)\b/i.test(s.trim()))
    .filter((s) => s.trim().length > 30);

  if (assertiveSentences.length === 0) {
    console.error('\nparsed zero assertive sentences out of SKILL.md; the heuristic has broken. Refusing to pass.');
    return false;
  }

  const ratio = CLAIMS.length / assertiveSentences.length;
  console.log(
    `claim coverage: ${CLAIMS.length} claims for ~${assertiveSentences.length} assertive sentences (${(ratio * 100).toFixed(0)}%)`,
  );
  if (ratio < MIN_RATIO) {
    console.error('');
    console.error('SKILL.md has grown well past its verified claim set. README.md states that');
    console.error('every factual claim in it is executed against a live database before');
    console.error('release. Add CLAIMS rows for the new sentences, or soften the README.');
    return false;
  }
  return true;
}

async function main(): Promise<void> {
  // The database-name guard runs before the scratch table is created, so a
  // stray URL can never receive DDL from this harness.
  assertEvalDatabase(EVAL_DATABASE_URL);
  const scratch = new pg.Client({ connectionString: EVAL_DATABASE_URL });
  await scratch.connect();
  let failed = 0;
  try {
    await createExactTotalsFixture(scratch);
    const schema: SchemaMetadata = await evalSchema();
    const db = evalClient(schema);

    for (const claim of CLAIMS) {
      try {
        await claim.run(db);
        console.log(`  ok    ${claim.says}`);
      } catch (err) {
        failed++;
        console.log(`  FAIL  ${claim.says}`);
        console.log(`        ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
    }

    await closeClient();
  } finally {
    // Dropped whatever happened above, and BEFORE any process.exit below,
    // which would skip a finally.
    await dropExactTotalsFixture(scratch).catch(() => {});
    await scratch.end().catch(() => {});
  }
  console.log(`\n${CLAIMS.length - failed}/${CLAIMS.length} claims hold`);

  // Computed before the claim-failure exit so one run reports both problems.
  const coverageHolds = claimCoverageHolds();

  if (failed > 0) {
    console.log('Every FAIL above is a sentence in skills/turbine-orm/SKILL.md that is now wrong.');
    process.exit(1);
  }
  if (!coverageHolds) process.exit(1);
}

main().catch(async (err) => {
  await closeClient().catch(() => {});
  console.error(err);
  process.exit(1);
});
