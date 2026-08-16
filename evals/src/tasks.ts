/**
 * The task set.
 *
 * Rules every task obeys, because breaking any one of them would quietly turn
 * the pass rate into a measurement of something else:
 *
 *  - EXACTLY ONE correct row set. The prompt names the columns to return and
 *    the ordering to use, so "wrong" always means wrong, never "differently
 *    shaped but arguably right".
 *  - NON-DEGENERATE. No task's answer is the empty set or the whole table.
 *    A task answered correctly by a broken query is worse than no task.
 *  - INDEPENDENTLY CHECKED. `sanityCount` / `sanityIds` are raw SQL written
 *    against the DDL, not against Turbine. They are compared to the reference
 *    args before any model runs, so a mistake in MY reference is caught by
 *    something that does not share its assumptions.
 *  - ANSWERABLE FROM THE SCHEMA. Nothing here needs knowledge of the data
 *    beyond what the prompt states.
 *
 * `trap` marks a task whose natural Prisma phrasing is wrong in Turbine. These
 * are not a separate category of question, they are ordinary questions that
 * punish recall over reading, which is exactly the thing the tools claim to fix.
 */
import type { OrderMode } from './canonical.js';
import type { ReadMethod } from './protocol.js';

export type Shape =
  | 'filter-order'
  | 'relation-to-one'
  | 'relation-to-many'
  | 'nested-two-level'
  | 'many-to-many'
  | 'relation-filter'
  | 'group-having'
  | 'compound-unique'
  | 'json-path'
  | 'aggregate';

export interface Task {
  id: string;
  shape: Shape;
  /** The natural Prisma phrasing of this task is wrong in Turbine. */
  trap?: string;
  prompt: string;
  order: OrderMode;
  reference: { table: string; method: ReadMethod; args: Record<string, unknown> };
  /**
   * Raw SQL returning one integer. Compared against the number of top-level
   * rows, or, when `sanityScalarPath` is set, against the value found at that
   * path in the result. `count` and `aggregate` return a scalar and an object
   * rather than a list, so counting "rows" there would compare 1 against the
   * answer and pass every wrong reference.
   */
  sanityCount?: string;
  /** Path into a non-list result whose value `sanityCount` should equal. */
  sanityScalarPath?: string[];
  /** Raw SQL returning an ordered `id` column that must match the reference. */
  sanityIds?: string;
}

export const TASKS: Task[] = [
  // ---------------------------------------------------------------- floor --
  {
    id: 'T01',
    shape: 'filter-order',
    prompt:
      'From cheese_wheels, return every row whose status is exactly "graded". Return only the id and batch_ref columns, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: { where: { status: 'graded' }, select: { id: true, batchRef: true }, orderBy: { id: 'asc' } },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels WHERE status = 'graded'`,
    sanityIds: `SELECT id FROM cheese_wheels WHERE status = 'graded' ORDER BY id ASC`,
  },
  {
    id: 'T02',
    shape: 'filter-order',
    prompt:
      'From affineurs, return every row where is_journeyman is true AND retired_at is null. Return only id and ledger_handle, ordered by ledger_handle ascending.',
    order: 'deep',
    reference: {
      table: 'affineurs',
      method: 'findMany',
      args: {
        where: { isJourneyman: true, retiredAt: null },
        select: { id: true, ledgerHandle: true },
        orderBy: { ledgerHandle: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM affineurs WHERE is_journeyman AND retired_at IS NULL`,
    sanityIds: `SELECT id FROM affineurs WHERE is_journeyman AND retired_at IS NULL ORDER BY ledger_handle ASC`,
  },
  {
    id: 'T03',
    shape: 'filter-order',
    prompt:
      'From cheese_wheels, return rows where cave_humidity_pct is greater than or equal to 90 and less than or equal to 94. Return only id and cave_humidity_pct, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: {
        where: { caveHumidityPct: { gte: 90, lte: 94 } },
        select: { id: true, caveHumidityPct: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels WHERE cave_humidity_pct BETWEEN 90 AND 94`,
    sanityIds: `SELECT id FROM cheese_wheels WHERE cave_humidity_pct BETWEEN 90 AND 94 ORDER BY id ASC`,
  },
  {
    id: 'T04',
    shape: 'filter-order',
    prompt:
      'From affineurs, return rows whose given_name contains the substring "Roux". Return only id and given_name, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'affineurs',
      method: 'findMany',
      args: {
        where: { givenName: { contains: 'Roux' } },
        select: { id: true, givenName: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM affineurs WHERE given_name LIKE '%Roux%'`,
    sanityIds: `SELECT id FROM affineurs WHERE given_name LIKE '%Roux%' ORDER BY id ASC`,
  },
  {
    id: 'T05',
    shape: 'filter-order',
    prompt:
      'From cheese_wheels, return rows whose rind_style is either "washed" or "waxed". Order by pressed_on descending, then id descending, and return only the first 10. Return only id, rind_style and pressed_on.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: {
        where: { rindStyle: { in: ['washed', 'waxed'] } },
        select: { id: true, rindStyle: true, pressedOn: true },
        orderBy: [{ pressedOn: 'desc' }, { id: 'desc' }],
        limit: 10,
      },
    },
    sanityCount: `SELECT 10`,
    sanityIds: `SELECT id FROM cheese_wheels WHERE rind_style IN ('washed','waxed') ORDER BY pressed_on DESC, id DESC LIMIT 10`,
  },
  {
    id: 'T06',
    shape: 'filter-order',
    prompt:
      'From cheese_wheels, return rows ordered by id ascending, skipping the first 20 rows and returning the next 5. Return only the id column.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: { select: { id: true }, orderBy: { id: 'asc' }, offset: 20, limit: 5 },
    },
    sanityCount: `SELECT 5`,
    sanityIds: `SELECT id FROM cheese_wheels ORDER BY id ASC OFFSET 20 LIMIT 5`,
  },
  {
    id: 'T07',
    shape: 'filter-order',
    prompt:
      'How many rows in cheese_wheels have a status that is NOT "dispatched"? Return the count. Use a method that returns the number itself, not the rows.',
    order: 'none',
    reference: {
      table: 'cheese_wheels',
      method: 'count',
      args: { where: { status: { not: 'dispatched' } } },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels WHERE status <> 'dispatched'`,
    sanityScalarPath: [],
  },
  {
    id: 'T08',
    shape: 'filter-order',
    prompt:
      'From ripening_checks, return the single row with the highest aroma_score, breaking ties by choosing the lowest id. Return only id, aroma_score and rind_score. Use a method that returns one row rather than a list.',
    order: 'deep',
    reference: {
      table: 'ripening_checks',
      method: 'findFirst',
      args: {
        select: { id: true, aromaScore: true, rindScore: true },
        orderBy: [{ aromaScore: 'desc' }, { id: 'asc' }],
      },
    },
  },

  // ------------------------------------------------------------ relations --
  {
    id: 'T09',
    shape: 'relation-to-one',
    trap: 'Prisma spells this `include`; Turbine spells it `with`, and an unknown top-level key is ignored rather than rejected.',
    prompt:
      'From cheese_wheels, return rows whose status is "quarantined", each one together with the guild it belongs to. Return only id and batch_ref from the wheel, and only guild_name from the guild, nested under the relation. Order by id ascending.',
    order: 'top',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: {
        where: { status: 'quarantined' },
        select: { id: true, batchRef: true },
        with: { guild: { select: { guildName: true } } },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels WHERE status = 'quarantined'`,
    sanityIds: `SELECT id FROM cheese_wheels WHERE status = 'quarantined' ORDER BY id ASC`,
  },
  {
    id: 'T10',
    shape: 'relation-to-many',
    trap: 'Prisma spells this `include`; Turbine spells it `with`.',
    prompt:
      'From guilds, return every guild ordered by id ascending, each with at most 3 of its affineurs. Pick the affineurs with the highest id first. Return only id and guild_name from the guild, and only id and ledger_handle from each affineur, nested under the relation.',
    order: 'deep',
    reference: {
      table: 'guilds',
      method: 'findMany',
      args: {
        select: { id: true, guildName: true },
        with: { affineurs: { select: { id: true, ledgerHandle: true }, orderBy: { id: 'desc' }, limit: 3 } },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM guilds`,
    sanityIds: `SELECT id FROM guilds ORDER BY id ASC`,
  },
  {
    id: 'T11',
    shape: 'nested-two-level',
    trap: 'Two levels of `include` in Prisma; Turbine nests `with` inside `with`.',
    prompt:
      'From guilds, return the guild whose id is 2, with its affineurs, and for each affineur that affineur\'s cheese_wheels whose status is "graded". Return only id from the guild; only id from each affineur; and only id and batch_ref from each cheese wheel. Order guilds by id ascending, affineurs by id ascending, and cheese wheels by id ascending.',
    order: 'deep',
    reference: {
      table: 'guilds',
      method: 'findMany',
      args: {
        where: { id: 2 },
        select: { id: true },
        with: {
          affineurs: {
            select: { id: true },
            orderBy: { id: 'asc' },
            with: {
              cheeseWheels: {
                where: { status: 'graded' },
                select: { id: true, batchRef: true },
                orderBy: { id: 'asc' },
              },
            },
          },
        },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT 1`,
  },
  {
    id: 'T12',
    shape: 'many-to-many',
    trap: 'The junction table is not the relation name: `wheel_cultures` is a hasMany, the many-to-many is `cultures`.',
    prompt:
      'From cheese_wheels, return the rows whose id is 1, 2 or 3, each with the cultures associated with it through the junction table. Return only id from the wheel, and only id and culture_code from each culture. Order wheels by id ascending and cultures by id ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: {
        where: { id: { in: [1, 2, 3] } },
        select: { id: true },
        with: { cultures: { select: { id: true, cultureCode: true }, orderBy: { id: 'asc' } } },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT 3`,
  },
  {
    id: 'T13',
    shape: 'many-to-many',
    prompt:
      'From cultures, return the rows where is_thermophilic is true, each with at most 2 of the cheese_wheels linked to it through the junction table, picking the lowest wheel id first. Return only id and culture_code from the culture, and only id from each cheese wheel. Order cultures by id ascending.',
    order: 'deep',
    reference: {
      table: 'cultures',
      method: 'findMany',
      args: {
        where: { isThermophilic: true },
        select: { id: true, cultureCode: true },
        with: { cheeseWheels: { select: { id: true }, orderBy: { id: 'asc' }, limit: 2 } },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM cultures WHERE is_thermophilic`,
    sanityIds: `SELECT id FROM cultures WHERE is_thermophilic ORDER BY id ASC`,
  },

  // ----------------------------------------------------- relation filters --
  {
    id: 'T14',
    shape: 'relation-filter',
    prompt:
      'From affineurs, return every affineur who has at least one cheese wheel whose status is "quarantined". Return only id and ledger_handle, ordered by id ascending. Do not return the wheels themselves.',
    order: 'deep',
    reference: {
      table: 'affineurs',
      method: 'findMany',
      args: {
        where: { cheeseWheels: { some: { status: 'quarantined' } } },
        select: { id: true, ledgerHandle: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM affineurs a WHERE EXISTS (SELECT 1 FROM cheese_wheels w WHERE w.affineur_id=a.id AND w.status='quarantined')`,
    sanityIds: `SELECT a.id FROM affineurs a WHERE EXISTS (SELECT 1 FROM cheese_wheels w WHERE w.affineur_id=a.id AND w.status='quarantined') ORDER BY a.id ASC`,
  },
  {
    id: 'T15',
    shape: 'relation-filter',
    prompt:
      'From cheese_wheels, return every wheel that has no ripening_checks at all. Return only id and batch_ref, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: {
        where: { ripeningChecks: { none: {} } },
        select: { id: true, batchRef: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels w WHERE NOT EXISTS (SELECT 1 FROM ripening_checks r WHERE r.cheese_wheel_id=w.id)`,
    sanityIds: `SELECT w.id FROM cheese_wheels w WHERE NOT EXISTS (SELECT 1 FROM ripening_checks r WHERE r.cheese_wheel_id=w.id) ORDER BY w.id ASC`,
  },
  {
    id: 'T16',
    shape: 'relation-filter',
    prompt:
      'From affineurs, return every affineur for whom every one of their cheese_wheels has a cave_humidity_pct of 85 or more. Return only id and ledger_handle, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'affineurs',
      method: 'findMany',
      args: {
        where: { cheeseWheels: { every: { caveHumidityPct: { gte: 85 } } } },
        select: { id: true, ledgerHandle: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM affineurs a WHERE NOT EXISTS (SELECT 1 FROM cheese_wheels w WHERE w.affineur_id=a.id AND w.cave_humidity_pct < 85)`,
    sanityIds: `SELECT a.id FROM affineurs a WHERE NOT EXISTS (SELECT 1 FROM cheese_wheels w WHERE w.affineur_id=a.id AND w.cave_humidity_pct < 85) ORDER BY a.id ASC`,
  },
  {
    id: 'T17',
    shape: 'relation-filter',
    prompt:
      'From cheese_wheels, return every wheel that has at least one ripening check with an aroma_score of 10 AND whose own status is "cellared". Return only id, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: {
        where: { status: 'cellared', ripeningChecks: { some: { aromaScore: 10 } } },
        select: { id: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels w WHERE w.status='cellared' AND EXISTS (SELECT 1 FROM ripening_checks r WHERE r.cheese_wheel_id=w.id AND r.aroma_score=10)`,
    sanityIds: `SELECT w.id FROM cheese_wheels w WHERE w.status='cellared' AND EXISTS (SELECT 1 FROM ripening_checks r WHERE r.cheese_wheel_id=w.id AND r.aroma_score=10) ORDER BY w.id ASC`,
  },

  // ------------------------------------------------------- group / having --
  {
    id: 'T18',
    shape: 'group-having',
    prompt:
      'Group cheese_wheels by status and return each status together with the number of rows having it, counting the id column. Order by status ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'groupBy',
      args: { by: ['status'], _count: { id: true }, orderBy: { status: 'asc' } },
    },
    sanityCount: `SELECT count(DISTINCT status) FROM cheese_wheels`,
  },
  {
    id: 'T19',
    shape: 'group-having',
    prompt:
      'Group cheese_wheels by rind_style, counting the id column, and keep only the groups whose count is greater than 55. Order by rind_style ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'groupBy',
      args: {
        by: ['rindStyle'],
        _count: { id: true },
        having: { id: { _count: { gt: 55 } } },
        orderBy: { rindStyle: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM (SELECT rind_style FROM cheese_wheels GROUP BY 1 HAVING count(id) > 55) s`,
  },
  {
    id: 'T20',
    shape: 'group-having',
    prompt:
      'Group cheese_wheels by both guild_id and status, counting the id column and also summing wheel_count. Keep only groups whose summed wheel_count is greater than 400. Order by guild_id ascending then status ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'groupBy',
      args: {
        by: ['guildId', 'status'],
        _count: { id: true },
        _sum: { wheelCount: true },
        having: { wheelCount: { _sum: { gt: 400 } } },
        orderBy: [{ guildId: 'asc' }, { status: 'asc' }],
      },
    },
    sanityCount: `SELECT count(*) FROM (SELECT guild_id, status FROM cheese_wheels GROUP BY 1,2 HAVING sum(wheel_count) > 400) s`,
  },
  {
    id: 'T21',
    shape: 'aggregate',
    prompt:
      'Across all rows of ripening_checks whose rind_score is 8 or more, return the average aroma_score, the maximum aroma_score and the number of rows (counting the id column), as a single aggregate result.',
    order: 'none',
    reference: {
      table: 'ripening_checks',
      method: 'aggregate',
      args: {
        where: { rindScore: { gte: 8 } },
        _avg: { aromaScore: true },
        _max: { aromaScore: true },
        _count: { id: true },
      },
    },
    sanityCount: `SELECT count(*) FROM ripening_checks WHERE rind_score >= 8`,
    sanityScalarPath: ['_count', 'id'],
  },

  // ---------------------------------------------------- compound uniques --
  {
    id: 'T22',
    shape: 'compound-unique',
    trap: 'batch_ref alone is not unique; the unique constraint is (guild_id, batch_ref).',
    prompt:
      'From cheese_wheels, return the single row identified by the unique combination guild_id = 4 and batch_ref = "WB-0007". Return only id, batch_ref and guild_id. Use the method meant for looking a row up by a unique key.',
    order: 'none',
    reference: {
      table: 'cheese_wheels',
      method: 'findUnique',
      args: {
        where: { guildId_batchRef: { guildId: 4, batchRef: 'WB-0007' } },
        select: { id: true, batchRef: true, guildId: true },
      },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels WHERE guild_id=4 AND batch_ref='WB-0007'`,
  },
  {
    id: 'T23',
    shape: 'compound-unique',
    prompt:
      'From affineurs, return the single row whose ledger_handle is "aff-017". Return only id, ledger_handle and guild_id. Use the method meant for looking a row up by a unique key.',
    order: 'none',
    reference: {
      table: 'affineurs',
      method: 'findUnique',
      args: { where: { ledgerHandle: 'aff-017' }, select: { id: true, ledgerHandle: true, guildId: true } },
    },
    sanityCount: `SELECT count(*) FROM affineurs WHERE ledger_handle='aff-017'`,
  },

  // ------------------------------------------------------------ json path --
  {
    id: 'T24',
    shape: 'json-path',
    prompt:
      'From cheese_wheels, return rows where the tasting_notes JSON has panel.score greater than or equal to 9. Return only id, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: {
        where: { tastingNotes: { path: ['panel', 'score'], gte: 9 } },
        select: { id: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels WHERE (tasting_notes->'panel'->>'score')::int >= 9`,
    sanityIds: `SELECT id FROM cheese_wheels WHERE (tasting_notes->'panel'->>'score')::int >= 9 ORDER BY id ASC`,
  },
  {
    id: 'T25',
    shape: 'json-path',
    prompt:
      'From cheese_wheels, count how many rows have a non-null value at the tasting_notes JSON path panel.score. Return that as an aggregate result counting that JSON path.',
    order: 'none',
    reference: {
      table: 'cheese_wheels',
      method: 'aggregate',
      args: { _count: { tastingNotes: { path: ['panel', 'score'] } } },
    },
    sanityCount: `SELECT count(*) FROM cheese_wheels WHERE tasting_notes->'panel'->'score' IS NOT NULL`,
    sanityScalarPath: ['_count', 'tastingNotes'],
  },
  {
    id: 'T26',
    shape: 'json-path',
    prompt:
      'From affineurs, return rows where the credential_blob JSON has tier equal to the string "master". Return only id and ledger_handle, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'affineurs',
      method: 'findMany',
      args: {
        where: { credentialBlob: { path: ['tier'], equals: 'master' } },
        select: { id: true, ledgerHandle: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM affineurs WHERE credential_blob->>'tier' = 'master'`,
    sanityIds: `SELECT id FROM affineurs WHERE credential_blob->>'tier' = 'master' ORDER BY id ASC`,
  },

  // ------------------------------------------------------- mixed / traps --
  {
    id: 'T27',
    shape: 'relation-to-one',
    trap: 'Naming a relation inside `select` is a validation error in Turbine; relations belong in `with`.',
    prompt:
      'From ripening_checks, return the rows whose aroma_score is 10, each together with the cheese wheel it belongs to. Return only id and aroma_score from the check, and only batch_ref from the wheel, nested under the relation. Order by id ascending.',
    order: 'top',
    reference: {
      table: 'ripening_checks',
      method: 'findMany',
      args: {
        where: { aromaScore: 10 },
        select: { id: true, aromaScore: true },
        with: { cheeseWheel: { select: { batchRef: true } } },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM ripening_checks WHERE aroma_score = 10`,
    sanityIds: `SELECT id FROM ripening_checks WHERE aroma_score = 10 ORDER BY id ASC`,
  },
  {
    id: 'T28',
    shape: 'relation-to-many',
    prompt:
      'From guilds, return every guild ordered by the number of affineurs it has, largest first, breaking ties by id ascending. Return only id and guild_name. Do not return the affineurs themselves.',
    order: 'deep',
    reference: {
      table: 'guilds',
      method: 'findMany',
      args: {
        select: { id: true, guildName: true },
        orderBy: [{ affineurs: { _count: 'desc' } }, { id: 'asc' }],
      },
    },
    sanityCount: `SELECT count(*) FROM guilds`,
    sanityIds: `SELECT g.id FROM guilds g ORDER BY (SELECT count(*) FROM affineurs a WHERE a.guild_id=g.id) DESC, g.id ASC`,
  },
  {
    id: 'T29',
    shape: 'filter-order',
    prompt:
      'From cheese_wheels, return the distinct set of values of the status column. Return only the status column, ordered by status ascending, with one row per distinct value.',
    order: 'deep',
    reference: {
      table: 'cheese_wheels',
      method: 'findMany',
      args: { distinct: ['status'], select: { status: true }, orderBy: { status: 'asc' } },
    },
    sanityCount: `SELECT count(DISTINCT status) FROM cheese_wheels`,
  },
  {
    id: 'T30',
    shape: 'relation-filter',
    prompt:
      'From guilds, return every guild that has at least one affineur who is retired (retired_at is not null). Return only id and guild_name, ordered by id ascending.',
    order: 'deep',
    reference: {
      table: 'guilds',
      method: 'findMany',
      args: {
        where: { affineurs: { some: { retiredAt: { not: null } } } },
        select: { id: true, guildName: true },
        orderBy: { id: 'asc' },
      },
    },
    sanityCount: `SELECT count(*) FROM guilds g WHERE EXISTS (SELECT 1 FROM affineurs a WHERE a.guild_id=g.id AND a.retired_at IS NOT NULL)`,
    sanityIds: `SELECT g.id FROM guilds g WHERE EXISTS (SELECT 1 FROM affineurs a WHERE a.guild_id=g.id AND a.retired_at IS NOT NULL) ORDER BY g.id ASC`,
  },
];

export const SMOKE_TASK_IDS = ['T01', 'T05', 'T09', 'T12', 'T15', 'T19', 'T22', 'T24'];

export function selectTasks(ids?: string[]): Task[] {
  if (!ids || ids.length === 0) return TASKS;
  const set = new Set(ids);
  return TASKS.filter((t) => set.has(t.id));
}
