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
import { TurbineError, type SchemaMetadata } from 'turbine-orm';
import { closeClient, evalClient } from './execute.js';
import { evalSchema } from './schema-meta.js';

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
 * Two spellings, one answer. This is the assertion that matters for the whole
 * camelCase/snake_case half of the skill: "accepted" is not the claim, "returns
 * the same rows" is. An arg position that accepted a name and then quietly
 * resolved it to something else is exactly the bug class 0.72.0 fixed.
 */
const same = (table: string, method: string, a: Args, b: Args) => async (db: Db) => {
  const [ra, rb] = await Promise.all([call(db, table, method, a), call(db, table, method, b)]);
  deepStrictEqual(ra, rb);
};

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
    says: 'a JSON path takes a narrower operator set: equals/gt/gte/lt/lte/contains/startsWith/endsWith.',
    run: accepts('cheese_wheels', 'findMany', {
      select: { id: true },
      where: {
        OR: [
          { tastingNotes: { path: ['panel', 'score'], gte: 9 } },
          { tastingNotes: { path: ['panel', 'verdict'], equals: 'hold' } },
          { tastingNotes: { path: ['panel', 'verdict'], contains: 'ho' } },
        ],
      },
    }),
  },
  {
    says: 'not / in / notIn are REFUSED on a JSON path, with the accepted list in the message.',
    run: async (db) => {
      for (const filter of [
        { path: ['panel', 'verdict'], not: 'hold' },
        { path: ['panel', 'verdict'], in: ['hold'] },
        { path: ['panel', 'verdict'], notIn: ['hold'] },
      ]) {
        await throws('TURBINE_E003', 'cheese_wheels', 'findMany', { where: { tastingNotes: filter } })(db);
      }
    },
  },
  {
    says: '_avg / _sum / _min / _max do NOT work on a JSON path.',
    run: async (db) => {
      try {
        await call(db, 'cheese_wheels', 'aggregate', { _avg: { tastingNotes: { path: ['panel', 'score'] } } });
      } catch {
        return; // any failure backs the claim; the point is "do not do this"
      }
      throw new Error('a JSON-path aggregate succeeded, so the warning is now wrong');
    },
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
  const schema: SchemaMetadata = await evalSchema();
  const db = evalClient(schema);
  let failed = 0;

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
