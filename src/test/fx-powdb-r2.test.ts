/**
 * PowDB answers like Postgres, or refuses like Postgres, on four more shapes:
 *
 *   - enum columns: stored and filtered as their label text, with Postgres's
 *     label checks and declaration-order range filters; orderings that would
 *     come back alphabetical are refused (E017) instead;
 *   - the logger and diagnostics a client passes reach the PowDB interface;
 *   - a groupBy `by` it cannot group by is E003 with the SQL engines' message;
 *   - the mass-mutation guard treats a NOT NULL column's `not: null` as TRUE.
 *
 * The engine cases run the real in-process `@zvndev/powdb-embedded` engine.
 * The oracle suite runs the same matrix on Postgres (gated on DATABASE_URL) and
 * diffs the two, so the expected values are Postgres's.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it as plainIt } from 'node:test';
import { TurbineClient } from '../client.js';
import type { TurbineLogEntry, TurbineLogger } from '../logger.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import {
  coerceValue,
  isJsonColumn,
  isPowdbDecimalTextColumn,
  type PowdbEnums,
  powdbEnumLabels,
  powqlColumnType,
} from '../powdb-shared.js';
import { assertGroupByKeys } from '../query/aggregates.js';
import { UNSAFE } from '../query/index.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { ColumnMetadata, SchemaMetadata } from '../schema.js';
import { defineSchema, type SchemaDef } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { skipGate } from './helpers.js';

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

// biome-ignore lint/suspicious/noExplicitAny: the cases drive many arg shapes through untyped table accessors
type Db = any;

// Declaration order is deliberately not alphabetical, so an alphabetical
// comparison and Postgres's declaration-order comparison disagree.
const LABELS = ['open', 'blocked', "it's", 'done'] as const;

const def: SchemaDef = defineSchema(
  {
    tickets: {
      id: { type: 'integer', primaryKey: true },
      status: { type: 'enum', enumName: 'ticket_status', notNull: true, default: "'open'" },
      prev: { type: 'enum', enumName: 'ticket_status' },
      name: { type: 'text', notNull: true },
      note: { type: 'text' },
    },
  } as never,
  { enums: { ticket_status: [...LABELS] } },
);
const SCHEMA: SchemaMetadata = schemaDefToMetadata(def);

async function seed(db: Db): Promise<void> {
  await db.table('tickets').createMany({
    data: [
      { id: 1, status: 'open', prev: null, name: 't1', note: 'x' },
      { id: 2, status: 'blocked', prev: 'open', name: 't2', note: null },
      { id: 3, status: "it's", prev: 'blocked', name: 't3', note: 'y' },
      { id: 4, status: 'done', prev: "it's", name: 't4', note: null },
      { id: 5, status: 'open', prev: 'done', name: 't5', note: 'z' },
    ],
  });
}

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function openPow(opts: Record<string, unknown> = {}): Promise<Db> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-fx-powdb-r2-'));
  dirs.push(dir);
  const boot = await turbinePowDB({ embedded: dir }, SCHEMA, { warnOnUnlimited: false });
  for (const stmt of powqlSchemaDDL(SCHEMA)) await boot.rawUnsafe(stmt);
  await seed(boot);
  await boot.disconnect();
  return turbinePowDB({ embedded: dir }, SCHEMA, { warnOnUnlimited: false, ...opts });
}

async function withDb<R>(opts: Record<string, unknown>, fn: (db: Db) => Promise<R>): Promise<R> {
  const db = await openPow(opts);
  try {
    return await fn(db);
  } finally {
    await db.disconnect();
  }
}

/** A result, or the error's code (and, when asked, its message). */
async function outcome(fn: () => Promise<unknown>, withMessage = false): Promise<unknown> {
  try {
    return { ok: await fn() };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return withMessage ? { error: e.code, message: e.message } : { error: e.code ?? String(err) };
  }
}

const t = (db: Db) => db.table('tickets');
const ids = async (db: Db, where: unknown): Promise<number[]> =>
  (await t(db).findMany({ where, orderBy: { id: 'asc' } })).map((r: { id: number }) => r.id);

interface Case {
  name: string;
  run: (db: Db) => Promise<unknown>;
  /** The code both engines refuse with; absent when both answer. */
  refuses?: string;
}

const E3 = 'TURBINE_E003';

/** Same answer, or same refusal, on PowDB and Postgres. */
const MATRIX: Case[] = [
  { name: 'seed reads back the labels', run: (db) => outcome(() => t(db).findMany({ orderBy: { id: 'asc' } })) },
  { name: 'equals a label', run: (db) => outcome(() => ids(db, { status: 'blocked' })) },
  { name: 'equals a label with a quote', run: (db) => outcome(() => ids(db, { status: "it's" })) },
  { name: 'in', run: (db) => outcome(() => ids(db, { status: { in: ['open', 'done'] } })) },
  { name: 'notIn', run: (db) => outcome(() => ids(db, { status: { notIn: ['open'] } })) },
  { name: 'not', run: (db) => outcome(() => ids(db, { status: { not: 'open' } })) },
  { name: 'nullable equals null', run: (db) => outcome(() => ids(db, { prev: null })) },
  { name: 'nullable not null', run: (db) => outcome(() => ids(db, { prev: { not: null } })) },
  { name: 'gt in declaration order', run: (db) => outcome(() => ids(db, { status: { gt: 'blocked' } })) },
  { name: 'gte in declaration order', run: (db) => outcome(() => ids(db, { status: { gte: 'blocked' } })) },
  { name: 'lt in declaration order', run: (db) => outcome(() => ids(db, { status: { lt: 'done' } })) },
  { name: 'lte in declaration order', run: (db) => outcome(() => ids(db, { status: { lte: "it's" } })) },
  { name: 'gt the last label', run: (db) => outcome(() => ids(db, { status: { gt: 'done' } })) },
  { name: 'lt the first label', run: (db) => outcome(() => ids(db, { status: { lt: 'open' } })) },
  { name: 'gt on a nullable column', run: (db) => outcome(() => ids(db, { prev: { gt: 'open' } })) },
  { name: 'range pair', run: (db) => outcome(() => ids(db, { status: { gt: 'open', lt: 'done' } })) },
  { name: 'NOT over a range', run: (db) => outcome(() => ids(db, { NOT: { prev: { gt: 'blocked' } } })) },
  { name: 'not with a range object', run: (db) => outcome(() => ids(db, { prev: { not: { lte: 'blocked' } } })) },
  {
    name: 'OR over a range',
    run: (db) => outcome(() => ids(db, { OR: [{ status: { gte: 'done' } }, { prev: 'open' }] })),
  },
  {
    name: 'create takes the enum default',
    run: (db) => outcome(() => t(db).create({ data: { id: 9, name: 'n' } })),
  },
  {
    name: 'update writes a label',
    run: (db) => outcome(() => t(db).update({ where: { id: 1 }, data: { status: 'done', prev: "it's" } })),
  },
  {
    name: 'groupBy an enum key',
    run: (db) =>
      outcome(async () =>
        (await t(db).groupBy({ by: ['status'], _count: { _all: true } })).sort(
          (a: { status: string }, b: { status: string }) => a.status.localeCompare(b.status),
        ),
      ),
  },
  {
    name: 'count of an enum column',
    run: (db) => outcome(() => t(db).aggregate({ _count: { prev: true } })),
  },
  // Refusals Postgres makes too (E003).
  { name: 'unknown label in a filter', refuses: E3, run: (db) => outcome(() => ids(db, { status: 'bogus' })) },
  { name: 'label in another case', refuses: E3, run: (db) => outcome(() => ids(db, { status: 'Open' })) },
  {
    name: 'unknown label in `in`',
    refuses: E3,
    run: (db) => outcome(() => ids(db, { status: { in: ['open', 'bogus'] } })),
  },
  {
    name: 'unknown label in `notIn`',
    refuses: E3,
    run: (db) => outcome(() => ids(db, { prev: { notIn: ['bogus'] } })),
  },
  { name: 'unknown label in `gt`', refuses: E3, run: (db) => outcome(() => ids(db, { status: { gt: 'bogus' } })) },
  { name: 'a number in a filter', refuses: E3, run: (db) => outcome(() => ids(db, { status: 5 })) },
  {
    name: 'unknown label written',
    refuses: E3,
    run: (db) => outcome(() => t(db).create({ data: { id: 9, name: 'n', status: 'x' } })),
  },
  {
    name: 'a number written',
    refuses: E3,
    run: (db) => outcome(() => t(db).create({ data: { id: 9, name: 'n', status: 3 } })),
  },
  {
    name: 'unknown label in an update',
    refuses: E3,
    run: (db) => outcome(() => t(db).update({ where: { id: 1 }, data: { prev: 'nope' } })),
  },
  { name: 'contains on an enum', refuses: E3, run: (db) => outcome(() => ids(db, { status: { contains: 'o' } })) },
  { name: 'startsWith on an enum', refuses: E3, run: (db) => outcome(() => ids(db, { status: { startsWith: 'o' } })) },
  {
    name: 'insensitive equals on an enum',
    refuses: E3,
    run: (db) => outcome(() => ids(db, { status: { equals: 'OPEN', mode: 'insensitive' } })),
  },
  { name: '_sum of an enum', refuses: E3, run: (db) => outcome(() => t(db).aggregate({ _sum: { status: true } })) },
  // The mass-mutation guard over NOT NULL columns.
  {
    name: 'deleteMany where a NOT NULL column is not null',
    refuses: E3,
    run: (db) => outcome(() => t(db).deleteMany({ where: { name: { not: null } } })),
  },
  {
    name: 'updateMany where NOT (a NOT NULL column is null)',
    refuses: E3,
    run: (db) => outcome(() => t(db).updateMany({ where: { NOT: { name: null } }, data: { note: 'w' } })),
  },
  {
    name: 'deleteMany where a NOT NULL enum is not null',
    refuses: E3,
    run: (db) => outcome(() => t(db).deleteMany({ where: { status: { not: null } } })),
  },
  {
    name: 'deleteMany where a nullable column is not null still runs',
    run: (db) =>
      outcome(async () => [
        await t(db).deleteMany({ where: { note: { not: null } } }),
        await t(db).findMany({ orderBy: { id: 'asc' }, select: { id: true } }),
      ]),
  },
  {
    name: 'deleteMany where NOT NULL is not null, with allowFullTableScan',
    run: (db) =>
      outcome(async () => [
        await t(db).deleteMany({ where: { name: { not: null } }, allowFullTableScan: UNSAFE }),
        await t(db).count(),
      ]),
  },
  // groupBy `by` refusals: same code AND same message.
  ...(
    [
      ['missing', {}],
      ['a string', { by: 'status' }],
      ['empty', { by: [] }],
      ['a null entry', { by: [null] }],
    ] as const
  ).map(
    ([label, args]): Case => ({
      name: `groupBy by ${label}`,
      refuses: E3,
      run: (db) => outcome(() => t(db).groupBy({ ...args, _count: { _all: true } }), true),
    }),
  ),
];

/** Orderings Postgres answers in declaration order and PowDB refuses (E017). */
const POWDB_REFUSES: Case[] = [
  { name: 'orderBy an enum', run: (db) => outcome(() => t(db).findMany({ orderBy: { status: 'asc' } })) },
  {
    name: 'orderBy an enum with a sort spec',
    run: (db) => outcome(() => t(db).findMany({ orderBy: { prev: { sort: 'desc', nulls: 'last' } } })),
  },
  { name: '_min of an enum', run: (db) => outcome(() => t(db).aggregate({ _min: { status: true } })) },
  { name: '_max of an enum', run: (db) => outcome(() => t(db).aggregate({ _max: { prev: true } })) },
  {
    name: 'groupBy ordered by an enum key',
    run: (db) => outcome(() => t(db).groupBy({ by: ['status'], _count: { _all: true }, orderBy: { status: 'asc' } })),
  },
  {
    name: 'groupBy _min of an enum',
    run: (db) => outcome(() => t(db).groupBy({ by: ['name'], _min: { status: true } })),
  },
];

describe('PowDB enum columns, refusals and the guard (embedded)', () => {
  for (const c of MATRIX) {
    it(c.name, async () => {
      const got = (await withDb({}, c.run)) as { ok?: unknown; error?: string };
      if (c.refuses) assert.equal(got.error, c.refuses, JSON.stringify(got));
      else assert.ok('ok' in got, JSON.stringify(got));
    });
  }

  it('the enum answers PowDB gives without a Postgres to compare against', async () => {
    await withDb({}, async (db) => {
      assert.deepEqual(await ids(db, { status: { gt: 'blocked' } }), [3, 4]);
      assert.deepEqual(await ids(db, { status: { lt: 'blocked' } }), [1, 5]);
      assert.deepEqual(await ids(db, { prev: { gte: "it's" } }), [4, 5]);
      const created = await t(db).create({ data: { id: 9, name: 'n' } });
      assert.equal(created.status, 'open');
      await assert.rejects(t(db).create({ data: { id: 10, name: 'n', status: 'bogus' } }), { code: 'TURBINE_E003' });
      await assert.rejects(ids(db, { status: { in: ['bogus'] } }), { code: 'TURBINE_E003' });
    });
  });

  for (const c of POWDB_REFUSES) {
    it(`${c.name}: E017, not an alphabetical answer`, async () => {
      assert.deepEqual(await withDb({}, c.run), { error: 'TURBINE_E017' });
    });
  }

  it('a nested `with` ordered by an enum is refused too', async () => {
    const twoTables = defineSchema(
      {
        boards: { id: { type: 'integer', primaryKey: true } },
        cards: {
          id: { type: 'integer', primaryKey: true },
          boardId: { type: 'integer', notNull: true, references: 'boards.id' },
          status: { type: 'enum', enumName: 'card_status', notNull: true },
        },
      } as never,
      { enums: { card_status: ['b', 'a'] } },
    );
    const meta = schemaDefToMetadata(twoTables);
    const dir = mkdtempSync(join(tmpdir(), 'turbine-fx-powdb-r2-'));
    dirs.push(dir);
    const db = await turbinePowDB({ embedded: dir }, meta, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(meta)) await db.rawUnsafe(stmt);
      await db.table('boards').create({ data: { id: 1 } });
      await db.table('cards').createMany({
        data: [
          { id: 1, boardId: 1, status: 'a' },
          { id: 2, boardId: 1, status: 'b' },
        ],
      });
      for (const strategy of ['batched', 'join'] as const) {
        await assert.rejects(
          db.table('boards').findMany({
            with: { cards: { orderBy: { status: 'asc' } } },
            relationLoadStrategy: strategy,
          }),
          { code: 'TURBINE_E017' },
          strategy,
        );
      }
      // Without the ordering it loads, labels intact.
      const rows = (await db.table('boards').findMany({ with: { cards: { orderBy: { id: 'asc' } } } })) as Db[];
      assert.deepEqual(
        rows[0].cards.map((c: { status: string }) => c.status),
        ['a', 'b'],
      );
    } finally {
      await db.disconnect();
    }
  });
});

// ---------------------------------------------------------------------------
// The type mapping, without an engine
// ---------------------------------------------------------------------------

const col = (over: Partial<ColumnMetadata>): ColumnMetadata =>
  ({
    name: 'c',
    field: 'c',
    dialectType: 'text',
    pgType: 'text',
    nullable: true,
    hasDefault: false,
    isArray: false,
    arrayType: 'text[]',
    pgArrayType: 'text[]',
    tsType: 'string',
    ...over,
  }) as ColumnMetadata;

describe('PowDB type mapping of enum columns', () => {
  const enums: PowdbEnums = { mood: ['ok', 'unknown'], money_kind: ['cash', 'card'] };
  // `defineSchema` gives an enum column `tsType: 'unknown'`.
  const fromDefineSchema = col({ dialectType: 'mood', pgType: 'mood', tsType: 'unknown | null' });
  // Introspection gives a union of the labels, and a label can read like a type.
  const fromIntrospection = col({ dialectType: 'mood', pgType: 'mood', tsType: "'ok' | 'unknown' | null" });
  // An enum type's name is free text.
  const moneyNamed = col({ dialectType: 'money_kind', pgType: 'money_kind', tsType: 'string' });

  plainIt('an enum column is a `str` holding its labels', () => {
    for (const c of [fromDefineSchema, fromIntrospection]) {
      assert.deepEqual(powdbEnumLabels(c, enums), ['ok', 'unknown']);
      assert.equal(isJsonColumn(c, enums), false);
      assert.equal(powqlColumnType(c, enums), 'str');
      assert.equal(coerceValue('ok', c, enums), 'ok');
      assert.equal(coerceValue('null', c, enums), null);
    }
    assert.equal(isPowdbDecimalTextColumn(moneyNamed, enums), false);
  });

  plainIt('without the enum map the old heuristic answers, which is why every engine call passes it', () => {
    assert.equal(isJsonColumn(fromDefineSchema), true);
    assert.equal(isJsonColumn(fromIntrospection), true);
    assert.equal(isPowdbDecimalTextColumn(moneyNamed), true);
    assert.equal(powdbEnumLabels(fromDefineSchema, undefined), undefined);
    // A type named like an inherited property is not an enum.
    assert.equal(powdbEnumLabels(col({ dialectType: 'constructor' }), enums), undefined);
  });

  plainIt('powqlSchemaDDL declares an enum column as str', () => {
    const ddl = powqlSchemaDDL(SCHEMA).find((s) => s.startsWith('type tickets '));
    assert.ok(ddl, 'the tickets type');
    assert.match(ddl!, /required status: str/);
    assert.match(ddl!, /\bprev: str/);
    assert.doesNotMatch(ddl!, /json/);
  });

  /**
   * Every call the engine makes to a mapping function passes the schema's
   * enums. Without them an enum column falls back to the tsType heuristic
   * (json), so one forgotten argument is a column read or written as JSON.
   */
  plainIt('every engine call to the type mapping passes the enum map', () => {
    const arity: Record<string, number> = {
      isJsonColumn: 2,
      powqlColumnType: 2,
      isPowdbDecimalTextColumn: 2,
      coerceValue: 3,
      rowToEntity: 4,
      emulateColumnDefault: 3,
      decodeAggregateCell: 4,
    };
    let calls = 0;
    const short: string[] = [];
    for (const file of ['powql.ts', 'powdb.ts']) {
      const text = stripComments(readFileSync(join(import.meta.dirname, '..', file), 'utf8'));
      for (const [fn, want] of Object.entries(arity)) {
        const re = new RegExp(`(?<![\\w.])${fn}\\(`, 'g');
        for (let m = re.exec(text); m; m = re.exec(text)) {
          const before = text.slice(Math.max(0, m.index - 9), m.index);
          if (/function\s*$/.test(before)) continue; // the definition
          const args = topLevelArgs(text, m.index + m[0].length);
          calls++;
          if (args < want) short.push(`${file}: ${fn}(...) with ${args} argument(s), needs ${want}`);
        }
      }
    }
    // 21 calls when this was written; a lexer that swallowed code would see far fewer.
    assert.ok(calls >= 20, `only ${calls} calls found; the scan is not reading the engine`);
    assert.deepEqual(short, []);
  });
});

/** Drop `//` and block comments, keeping string contents (a crude but sufficient lexer for this scan). */
function stripComments(src: string): string {
  let out = '';
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const ch = src[i]!;
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += src[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    out += ch;
    i++;
  }
  return out;
}

/** The number of top-level arguments of the call whose `(` ends just before `start`. */
function topLevelArgs(src: string, start: number): number {
  let depth = 0;
  let args = 0;
  let sawToken = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return sawToken ? args + 1 : 0;
      depth--;
    } else if (ch === ',' && depth === 0) args++;
    else if (!/\s/.test(ch)) sawToken = true;
  }
  return args;
}

// ---------------------------------------------------------------------------
// Logger and diagnostics
// ---------------------------------------------------------------------------

function recorder(): { logger: TurbineLogger; lines: { level: string; message: string; entry: TurbineLogEntry }[] } {
  const lines: { level: string; message: string; entry: TurbineLogEntry }[] = [];
  const at =
    (level: string) =>
    (message: string, entry: TurbineLogEntry): void => {
      lines.push({ level, message, entry });
    };
  return { logger: { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

/** Run `fn` with console.warn / console.error / console.log counted, never printed. */
async function consoleCalls(fn: () => Promise<void>): Promise<number> {
  const saved = { warn: console.warn, error: console.error, log: console.log };
  let n = 0;
  console.warn =
    console.error =
    console.log =
      () => {
        n++;
      };
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return n;
}

describe('PowDB lines go through the client logger', () => {
  it('the no-limit warning reaches the logger with its code, and never the console', async () => {
    const { logger, lines } = recorder();
    const printed = await consoleCalls(() =>
      withDb({ logger, warnOnUnlimited: true }, async (db) => {
        await t(db).findMany({ where: { id: 1 } });
        await t(db).findMany({ where: { id: 2 } });
      }),
    );
    assert.equal(printed, 0);
    const unlimited = lines.filter((l) => l.entry.code === 'unlimited-find-many');
    assert.equal(unlimited.length, 1, 'once per interface');
    assert.equal(unlimited[0]!.level, 'warn');
    assert.deepEqual(
      { table: unlimited[0]!.entry.table, operation: unlimited[0]!.entry.operation },
      { table: 'tickets', operation: 'findMany' },
    );
    assert.match(unlimited[0]!.message, /findMany on "tickets" has no limit/);
  });

  it('unknown-option advice follows `diagnostics`', async () => {
    for (const [diagnostics, expected] of [
      ['development', 1],
      ['production', 0],
      [{ mode: 'production', advice: true }, 1],
      [{ mode: 'development', advice: false }, 0],
    ] as const) {
      resetWarnOnce(WARN_NS.unknownQueryOption);
      const { logger, lines } = recorder();
      const printed = await consoleCalls(() =>
        withDb({ logger, diagnostics }, async (db) => {
          await t(db).findMany({ include: { x: true }, limit: 1 });
        }),
      );
      assert.equal(printed, 0, JSON.stringify(diagnostics));
      const advice = lines.filter((l) => l.entry.code === 'unknown-query-option');
      assert.equal(advice.length, expected, JSON.stringify(diagnostics));
      if (expected) assert.equal((advice[0]!.entry as { key?: string }).key, 'include');
    }
  });
});

// ---------------------------------------------------------------------------
// groupBy `by`: the shared refusal, word for word
// ---------------------------------------------------------------------------

describe('PowDB groupBy `by` refusals', () => {
  for (const [label, by] of [
    ['missing', undefined],
    ['a string', 'status'],
    ['empty', []],
    ['a null entry', [null]],
    ['a number entry', [3]],
  ] as const) {
    it(`by ${label}: E003, the SQL engines' message`, async () => {
      let want = '';
      try {
        assertGroupByKeys('tickets', by);
      } catch (e) {
        want = (e as Error).message;
      }
      assert.ok(want, 'the shared rule refuses it');
      await withDb({}, async (db) => {
        const args = by === undefined ? { _count: { _all: true } } : { by, _count: { _all: true } };
        await assert.rejects(t(db).groupBy(args), (e: { code?: string; message?: string }) => {
          assert.equal(e.code, 'TURBINE_E003');
          assert.equal(e.message, want);
          return true;
        });
      });
    });
  }

  it('a well-formed `by` still groups', async () => {
    await withDb({}, async (db) => {
      const groups = await t(db).groupBy({ by: ['name'], _count: { _all: true } });
      assert.equal(groups.length, 5);
    });
  });
});

// ---------------------------------------------------------------------------
// Postgres oracle
// ---------------------------------------------------------------------------

const PG_URL = process.env.DATABASE_URL;
const oracle = skipGate(!PG_URL || !embeddedAvailable, 'requires DATABASE_URL and @zvndev/powdb-embedded');
const ORACLE_SCHEMA = 'turbine_fx_powdb_r2_oracle';

function oracleUrl(): string {
  const url = new URL(PG_URL!);
  url.searchParams.set('options', `-c search_path=${ORACLE_SCHEMA}`);
  return url.toString();
}

async function resetOracle(): Promise<void> {
  const admin = new TurbineClient({ connectionString: PG_URL!, warnOnUnlimited: false } as never, SCHEMA);
  await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${ORACLE_SCHEMA}" CASCADE`);
  await admin.rawUnsafe(`CREATE SCHEMA "${ORACLE_SCHEMA}"`);
  await admin.disconnect();
  const boot = new TurbineClient({ connectionString: oracleUrl(), warnOnUnlimited: false } as never, SCHEMA);
  for (const stmt of schemaToSQL(def)) await boot.rawUnsafe(stmt);
  await seed(boot);
  await boot.disconnect();
}

async function onPostgres(run: (db: Db) => Promise<unknown>): Promise<unknown> {
  await resetOracle();
  const pg = new TurbineClient({ connectionString: oracleUrl(), warnOnUnlimited: false } as never, SCHEMA);
  try {
    return await run(pg);
  } finally {
    await pg.disconnect();
  }
}

describe('PowDB enum columns against the Postgres oracle', () => {
  oracle.after(async () => {
    const admin = new TurbineClient({ connectionString: PG_URL!, warnOnUnlimited: false } as never, SCHEMA);
    await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${ORACLE_SCHEMA}" CASCADE`);
    await admin.disconnect();
  });

  for (const c of MATRIX) {
    oracle.it(c.name, async () => {
      const want = await onPostgres(c.run);
      const got = await withDb({}, c.run);
      assert.deepEqual(got, want);
    });
  }

  for (const c of POWDB_REFUSES) {
    oracle.it(`${c.name}: Postgres answers, PowDB refuses`, async () => {
      const want = (await onPostgres(c.run)) as { ok?: unknown };
      assert.ok('ok' in want, `Postgres answers: ${JSON.stringify(want)}`);
      assert.deepEqual(await withDb({}, c.run), { error: 'TURBINE_E017' });
    });
  }
});
