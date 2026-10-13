/**
 * Oracle 7: operand-shape fuzz.
 *
 * Request data reaches `where` as whatever JSON.parse produced, so any value
 * position can hold an object, an array, an empty object or something shaped
 * like an operator or a column reference. The rule under test: such an operand
 * either throws a typed Turbine error or returns exactly the rows an
 * independent evaluator returns. Never a broader match, never a raw driver
 * error, never a statement that silently ignored the operand.
 *
 * Two surfaces:
 *   reads         findMany and count, with the operand placed directly, under AND,
 *                 under OR and under NOT. The expectation per operand is one of
 *                 `rows` (a legitimate value, so the model's answer),
 *                 `throws` (not a value for the column, so a typed error), or
 *                 `either` (a typed error, or exactly the model's answer).
 *   one-row guard findUnique, update, delete and upsert. Only a scalar or
 *                 `{ equals: <scalar> }` identifies a row. Anything else must
 *                 throw, and the table must be left exactly as it was. Afterwards
 *                 the table is read back with raw SQL: a delete that "threw" but
 *                 removed rows is the failure this exists for.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-operand-shape.test.ts
 */

import { describe } from 'node:test';
import type pg from 'pg';
import * as turbineExports from '../index.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, FULL, rngFor, SKIP, scaled } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { dumpJson, rawReader, rawWriter, runScript } from './oracle/raw.js';
import {
  attempt,
  describeError,
  introspectTables,
  isTurbineError,
  makeClient,
  type OracleClient,
  show,
  stable,
} from './oracle/util.js';
import { camelRow, type Model, matchingIds } from './oracle/where-model.js';

const FILE = 'oracle-operand-shape.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const T = 'orc_o_items';

const DDL = `
DROP TABLE IF EXISTS ${T} CASCADE;
CREATE TABLE ${T} (
  id int PRIMARY KEY,
  code text NOT NULL UNIQUE,
  n int,
  name text,
  flag boolean,
  at timestamptz
);
`;

const SEED = `
TRUNCATE ${T};
INSERT INTO ${T} VALUES
  (1,  'c1',  1,    'ann',  true,  '2024-01-01T00:00:00Z'),
  (2,  'c2',  2,    'bob',  false, '2024-01-02T00:00:00Z'),
  (3,  'c3',  3,    'Bob',  NULL,  '2024-01-03T00:00:00Z'),
  (4,  'c4',  3,    'cy',   true,  NULL),
  (5,  'c5',  4,    'a%b',  false, '2024-01-05T00:00:00Z'),
  (6,  'c6',  5,    'a_b',  true,  '2024-01-06T00:00:00Z'),
  (7,  'c7',  NULL, 'zed',  NULL,  '2024-01-07T00:00:00Z'),
  (8,  'c8',  7,    NULL,   false, '2024-01-08T00:00:00Z'),
  (9,  'c9',  8,    'dee',  true,  '2024-01-09T00:00:00Z'),
  (10, 'c10', NULL, 'eve',  false, NULL),
  (11, 'c11', 10,   'ann',  true,  '2024-01-11T00:00:00Z'),
  (12, 'c12', 11,   'x',    NULL,  '2024-01-12T00:00:00Z');
`;

let db: OracleClient;
let reader: pg.Client;
let writer: pg.Client;
let model: Model;

type Verdict = 'rows' | 'throws' | 'either';

interface Operand {
  label: string;
  value: unknown;
  verdict: Verdict;
  /** A well-formed operator object: invalid as an operand, but it IS the syntax at `not` and at the bare field position. */
  operatorObject?: boolean;
}

const ok = (label: string, value: unknown): Operand => ({ label, value, verdict: 'rows' });
const bad = (label: string, value: unknown): Operand => ({ label, value, verdict: 'throws' });
const badOperator = (label: string, value: unknown): Operand => ({
  label,
  value,
  verdict: 'throws',
  operatorObject: true,
});
const maybe = (label: string, value: unknown): Operand => ({ label, value, verdict: 'either' });

/** Values that are not scalars for any of this table's columns. */
const NOT_SCALARS: Operand[] = [
  bad('plain column reference {col:"id"}', { col: 'id' }),
  bad('plain column reference {col:"n"}', { col: 'n' }),
  bad('plain column reference {col:"name"}', { col: 'name' }),
  bad('empty object', {}),
  bad('empty array', []),
  bad('array [3]', [3]),
  bad('array of strings', ['ann']),
  bad('object {a:1}', { a: 1 }),
  badOperator('operator-shaped {contains:"a"}', { contains: 'a' }),
  badOperator('operator-shaped {equals:3}', { equals: 3 }),
  bad('nested {equals:{col:"id"}}', { equals: { col: 'id' } }),
  bad('Map', new Map([[1, 2]])),
  bad('Set', new Set([3])),
  bad('null-prototype object', Object.assign(Object.create(null), { x: 1 })),
  bad('function', () => 3),
  bad('symbol', Symbol('x')),
];

const INT_SCALARS: Operand[] = [ok('3', 3), ok('0', 0), ok('-1', -1), ok('4', 4)];
const TEXT_SCALARS: Operand[] = [
  ok('"ann"', 'ann'),
  ok('"%"', '%'),
  ok('"a_b"', 'a_b'),
  ok('empty string', ''),
  ok('"Bob"', 'Bob'),
];
const BOOL_SCALARS: Operand[] = [ok('true', true), ok('false', false)];
const DATE_SCALARS: Operand[] = [ok('Date 2024-01-05', new Date('2024-01-05T00:00:00Z'))];

const ODD_NUMBERS: Operand[] = [maybe('NaN', Number.NaN), maybe('Infinity', Infinity), maybe('-Infinity', -Infinity)];
const ODD_DATES: Operand[] = [maybe('Invalid Date', new Date('nope'))];

interface Column {
  field: string;
  ops: readonly string[];
  scalars: Operand[];
  odd: Operand[];
  listItems: Operand[];
}

const COLUMNS: Column[] = [
  {
    field: 'n',
    ops: ['equals', 'not', 'gt', 'gte', 'lt', 'lte'],
    scalars: INT_SCALARS,
    odd: ODD_NUMBERS,
    listItems: INT_SCALARS,
  },
  {
    field: 'name',
    ops: ['equals', 'not', 'contains', 'startsWith', 'endsWith'],
    scalars: TEXT_SCALARS,
    odd: [],
    listItems: TEXT_SCALARS,
  },
  { field: 'flag', ops: ['equals', 'not'], scalars: BOOL_SCALARS, odd: [], listItems: BOOL_SCALARS },
  {
    field: 'at',
    ops: ['equals', 'not', 'gt', 'gte', 'lt', 'lte'],
    scalars: DATE_SCALARS,
    odd: ODD_DATES,
    listItems: DATE_SCALARS,
  },
];

/** `in` / `notIn` operands: arrays of scalars are values, everything else is not. */
function listOperands(c: Column): Operand[] {
  return [
    ok('one-element list', [c.listItems[0]?.value]),
    ok('two-element list', [c.listItems[0]?.value, c.listItems[1]?.value ?? c.listItems[0]?.value]),
    ok('empty list', []),
    bad('a scalar instead of a list', c.listItems[0]?.value),
    bad('an object instead of a list', { a: 1 }),
    bad('list holding an object', [{}]),
    bad('list holding a column reference', [{ col: 'id' }]),
    bad('list holding a list', [[c.listItems[0]?.value]]),
    bad('empty object instead of a list', {}),
  ];
}

/** `not` additionally accepts an operator object; the answer, if given, is its negation. */
function notObjects(c: Column): Operand[] {
  const v = c.scalars[0]?.value;
  const out: Operand[] = [maybe('not: {equals}', { equals: v }), maybe('not: {in}', { in: [v] })];
  if (c.field === 'n' || c.field === 'at')
    out.push(maybe('not: {gt}', { gt: v }), maybe('not: {lte,gte}', { lte: v, gte: v }));
  if (c.field === 'name')
    out.push(maybe('not: {contains}', { contains: 'a' }), maybe('not: {startsWith}', { startsWith: 'a' }));
  return out;
}

interface ReadCase {
  column: Column;
  op: string;
  operand: Operand;
  filter: Record<string, unknown>;
}

/**
 * Every (column, operator, operand) combination in the full run. The fast run
 * pairs the non-scalar operands with `equals`, `not` and one random operator per
 * column: the bugs are in how an operand's SHAPE is handled, which does not vary
 * with which comparison operator carries it.
 */
function allReadCases(): ReadCase[] {
  const cases: ReadCase[] = [];
  const rng = rngFor('operand-shape:case-selection');
  for (const column of COLUMNS) {
    const shapeOps = FULL ? column.ops : [...new Set(['equals', 'not', rng.pick(column.ops)])];
    for (const op of column.ops) {
      const operands = [
        ...column.scalars,
        ...column.odd,
        ...(shapeOps.includes(op) ? NOT_SCALARS.filter((o) => !(op === 'not' && o.operatorObject)) : []),
        ...(op === 'not' ? notObjects(column) : []),
      ];
      for (const operand of operands) cases.push({ column, op, operand, filter: { [op]: operand.value } });
    }
    for (const op of ['in', 'notIn']) {
      for (const operand of listOperands(column)) cases.push({ column, op, operand, filter: { [op]: operand.value } });
    }
    // The operand directly at the field, with no operator key: a scalar, or an object that must not be accepted.
    for (const operand of [...column.scalars, ...NOT_SCALARS.filter((o) => !o.operatorObject)]) {
      cases.push({ column, op: '(bare)', operand, filter: operand.value as Record<string, unknown> });
    }
  }
  return cases;
}

/** Where trees that place `filter` directly, under AND, under OR and under NOT. */
function contexts(field: string, filter: unknown): [string, Record<string, unknown>][] {
  const f = { [field]: filter };
  return [
    ['direct', f],
    ['AND with id > 2', { AND: [{ id: { gt: 2 } }, f] }],
    ['OR with id = 1', { OR: [{ id: 1 }, f] }],
    ['NOT', { NOT: f }],
  ];
}

function modelWhere(field: string, op: string, operand: unknown): unknown {
  return { [field]: op === '(bare)' ? operand : { [op]: operand } };
}

function modelOf(context: string, field: string, op: string, operand: unknown): number[] {
  const inner = modelWhere(field, op, operand);
  const tree =
    context === 'direct'
      ? inner
      : context === 'NOT'
        ? { NOT: inner }
        : context.startsWith('AND')
          ? { AND: [{ id: { gt: 2 } }, inner] }
          : { OR: [{ id: 1 }, inner] };
  return matchingIds(model, 'items', tree);
}

describe('oracle: operand shapes either throw typed errors or match the oracle', () => {
  before(async () => {
    await runScript(DATABASE_URL!, DDL + SEED);
    const schema = await introspectTables(DATABASE_URL!, [T]);
    db = makeClient(DATABASE_URL!, schema);
    reader = await rawReader(DATABASE_URL!);
    writer = await rawWriter(DATABASE_URL!);
    model = {
      items: { rows: (await dumpJson(reader, T)).map(camelRow), relations: {} },
    };
  });

  after(async () => {
    await db?.disconnect();
    await reader?.end();
    await writer?.end();
    if (!SKIP) await runScript(DATABASE_URL!, `DROP TABLE IF EXISTS ${T} CASCADE`);
  });

  async function checkRead(
    failures: Failures,
    rc: ReadCase,
    context: string,
    where: Record<string, unknown>,
  ): Promise<void> {
    // count() shares the where compiler with findMany; asking it everywhere only repeats the answer.
    const methods = context === 'direct' ? (['findMany', 'count'] as const) : (['findMany'] as const);
    const label = `${rc.column.field}.${rc.op} <- ${rc.operand.label} [${context}]`;
    let expected: number[] | undefined;
    if (rc.operand.verdict !== 'throws') {
      try {
        expected = modelOf(context, rc.column.field, rc.op, rc.operand.value);
      } catch {
        expected = undefined; // the model does not cover this combination; only "typed error or any answer" is checkable
      }
    }

    for (const method of methods) {
      failures.checked();
      const run = await attempt(async () =>
        method === 'findMany'
          ? (await db.t(T).findMany({ where, select: { id: true }, orderBy: { id: 'asc' } })).map(
              (r: { id: number }) => r.id,
            )
          : db.t(T).count({ where }),
      );
      if (!run.ok) {
        if (!isTurbineError(run.error))
          failures.add(`${method}: raw or non-Turbine error escaped`, `${label}\n${describeError(run.error)}`);
        else if (rc.operand.verdict === 'rows')
          failures.add(`${method}: refused a legitimate value`, `${label}\n${describeError(run.error)}`);
        continue;
      }
      if (rc.operand.verdict === 'throws') {
        failures.add(
          `${method}: accepted an operand that is not a scalar for the column`,
          `${label}\n${show(where)}\nreturned ${method === 'count' ? run.value : stable(run.value)} (the table has 12 rows)`,
        );
        failures.tally(`${rc.op === '(bare)' ? 'bare operand' : rc.op} accepted ${rc.operand.label.split(' ')[0]}`);
        continue;
      }
      if (expected === undefined) continue;
      const got = method === 'count' ? run.value : (run.value as number[]);
      const want = method === 'count' ? expected.length : expected;
      if (stable(got) !== stable(want)) {
        failures.add(
          `${method}: returned different rows than the oracle`,
          `${label}\n${show(where)}\nexpected ${stable(want)}\ngot      ${stable(got)}`,
        );
      }
    }
  }

  it('column operands: scalars match the oracle, non-scalars throw typed errors (direct, AND, OR, NOT)', async () => {
    const failures = new Failures(FILE, 2);
    const rng = rngFor('operand-shape:contexts');
    for (const rc of allReadCases()) {
      const all = contexts(rc.column.field, rc.op === '(bare)' ? rc.operand.value : { [rc.op]: rc.operand.value });
      // Always the direct form; the wrapped forms are sampled in the fast run and exhaustive in the full one.
      const chosen = FULL ? all : [all[0] as (typeof all)[number], rng.pick(all.slice(1))];
      for (const [context, where] of chosen) await checkRead(failures, rc, context, where);
    }
    failures.assertClean('operand shapes in reads', 300);
  });

  it('seeded random operand and context combinations', async () => {
    const rng = rngFor('operand-shape:random');
    const cases = allReadCases();
    const failures = new Failures(FILE, 2);
    const count = scaled(150, 2500);
    for (let i = 0; i < count; i++) {
      const rc = rng.pick(cases);
      const filter = rc.op === '(bare)' ? rc.operand.value : { [rc.op]: rc.operand.value };
      // A second, unrelated predicate in the same object: the bad operand must not be neutralized by its neighbour.
      const neighbour = rng.pick([{ id: { gt: 2 } }, { n: { not: null } }, { name: { startsWith: 'a' } }]);
      const where = rng.chance(0.5)
        ? { ...neighbour, [rc.column.field]: filter }
        : { OR: [neighbour, { [rc.column.field]: filter }] };
      failures.checked();
      const run = await attempt(() => db.t(T).findMany({ where, select: { id: true } }));
      if (!run.ok) {
        if (!isTurbineError(run.error))
          failures.add('raw or non-Turbine error escaped', `${show(where)}\n${describeError(run.error)}`);
        continue;
      }
      if (rc.operand.verdict === 'throws') {
        failures.add(
          'accepted a non-scalar operand next to another predicate',
          `${show(where)}\nreturned ${(run.value as unknown[]).length} rows`,
        );
      }
    }
    failures.assertClean('random operand shapes', count);
  });

  it('a branded column reference compares two columns, when the package exports col()', async () => {
    const col = (turbineExports as Record<string, unknown>).col as ((name: string) => unknown) | undefined;
    if (typeof col !== 'function') {
      throw new Error(
        'col() is not exported from the package root; plain {col} objects are refused, so there would be no way to compare two columns',
      );
    }
    const rows = await db
      .t(T)
      .findMany({ where: { n: { equals: col('id') } }, select: { id: true }, orderBy: { id: 'asc' } });
    const expected = (await dumpJson(reader, T)).filter((r) => r.n === r.id).map((r) => r.id as number);
    const failures = new Failures(FILE);
    failures.checked();
    if (stable(rows.map((r: { id: number }) => r.id)) !== stable(expected)) {
      failures.add(
        'col("id") comparison returned the wrong rows',
        `expected ${stable(expected)}\ngot ${stable(rows.map((r: { id: number }) => r.id))}`,
      );
    }
    failures.assertClean('branded column reference');
  });

  // -------------------------------------------------------------------------
  // The one-row guard
  // -------------------------------------------------------------------------

  type Row = { id: number; code: string; n: number | null; name: string | null };
  const dump = async (): Promise<Row[]> => (await dumpJson(reader, T)) as unknown as Row[];

  interface Identity {
    label: string;
    /** Value at the key; `forCode` is the same shape for the text key. */
    forId: unknown;
    forCode: unknown;
    /** 'row': addresses row 3. 'throws': refused. 'either': refused, or addresses no row. */
    verdict: 'row' | 'throws' | 'either';
  }

  const IDENTITIES: Identity[] = [
    { label: 'plain scalar', forId: 3, forCode: 'c3', verdict: 'row' },
    { label: '{ equals: scalar }', forId: { equals: 3 }, forCode: { equals: 'c3' }, verdict: 'row' },
    {
      label: '{ equals: {col} }',
      forId: { equals: { col: 'id' } },
      forCode: { equals: { col: 'code' } },
      verdict: 'throws',
    },
    { label: '{ col }', forId: { col: 'id' }, forCode: { col: 'code' }, verdict: 'throws' },
    { label: '{ not: scalar }', forId: { not: 3 }, forCode: { not: 'c3' }, verdict: 'throws' },
    { label: '{ in: [...] }', forId: { in: [1, 2, 3] }, forCode: { in: ['c1', 'c2', 'c3'] }, verdict: 'throws' },
    { label: '{ notIn: [...] }', forId: { notIn: [1] }, forCode: { notIn: ['c1'] }, verdict: 'throws' },
    { label: '{ gt }', forId: { gt: 0 }, forCode: { gt: 'a' }, verdict: 'throws' },
    { label: '{ gte, lte }', forId: { gte: 3, lte: 3 }, forCode: { gte: 'c3', lte: 'c3' }, verdict: 'throws' },
    { label: '{ contains }', forId: { contains: 3 }, forCode: { contains: 'c' }, verdict: 'throws' },
    {
      label: '{ equals, mode: insensitive }',
      forId: { equals: 3, mode: 'insensitive' },
      forCode: { equals: 'C3', mode: 'insensitive' },
      verdict: 'throws',
    },
    { label: '{ equals, not }', forId: { equals: 3, not: 3 }, forCode: { equals: 'c3', not: 'c3' }, verdict: 'throws' },
    { label: 'empty object', forId: {}, forCode: {}, verdict: 'throws' },
    { label: 'empty array', forId: [], forCode: [], verdict: 'throws' },
    { label: 'array [3]', forId: [3], forCode: ['c3'], verdict: 'throws' },
    { label: 'object {a:1}', forId: { a: 1 }, forCode: { a: 1 }, verdict: 'throws' },
    { label: '{ equals: undefined }', forId: { equals: undefined }, forCode: { equals: undefined }, verdict: 'throws' },
    { label: 'undefined', forId: undefined, forCode: undefined, verdict: 'throws' },
    { label: 'null', forId: null, forCode: null, verdict: 'either' },
    { label: '{ equals: null }', forId: { equals: null }, forCode: { equals: null }, verdict: 'either' },
  ];

  type Method = 'findUnique' | 'update' | 'delete' | 'upsert';
  let initial: Row[];

  for (const method of ['findUnique', 'update', 'delete', 'upsert'] as Method[]) {
    for (const key of ['id', 'code'] as const) {
      it(`${method} by ${key}: only a scalar or { equals } identifies a row, and a refusal leaves the table untouched`, async () => {
        const failures = new Failures(FILE, 2);
        await writer.query(SEED);
        initial = await dump();
        for (const identity of IDENTITIES) {
          let before = await dump();
          if (stable(before) !== stable(initial)) {
            await writer.query(SEED);
            before = await dump();
          }
          const where = { [key]: key === 'id' ? identity.forId : identity.forCode };
          failures.checked();
          const run = await attempt(async () => {
            switch (method) {
              case 'findUnique':
                return db.t(T).findUnique({ where });
              case 'update':
                return db.t(T).update({ where, data: { name: 'CHANGED' } });
              case 'delete':
                return db.t(T).delete({ where });
              case 'upsert':
                return db.t(T).upsert({
                  where,
                  create: { id: 100, code: 'created', name: 'CREATED' },
                  update: { name: 'CHANGED' },
                });
            }
          });
          const after = await dump();

          // What the table must look like. Row 3 is the only row any acceptable operand addresses.
          let expectedAfter = before;
          if (method === 'update' || method === 'upsert')
            expectedAfter = before.map((r) => (r.id === 3 ? { ...r, name: 'CHANGED' } : r));
          if (method === 'delete') expectedAfter = before.filter((r) => r.id !== 3);
          const touchedRow = identity.verdict === 'row' && run.ok;
          const expected = touchedRow ? expectedAfter : before;
          const tag = `${method}(${key}: ${identity.label})`;

          if (!run.ok) {
            if (!isTurbineError(run.error))
              failures.add('raw or non-Turbine error escaped', `${tag}\n${describeError(run.error)}`);
            else if (identity.verdict === 'row')
              failures.add('refused a legitimate identity', `${tag}\n${describeError(run.error)}`);
          } else if (identity.verdict === 'throws') {
            failures.add(
              `${method}: accepted an operand that does not identify one row`,
              `${tag}\nwhere ${show(where)}\nresult ${show(run.value)}`,
            );
          } else if (method === 'findUnique' && identity.verdict === 'row') {
            const got = run.value as { id?: number } | null;
            if (got?.id !== 3) failures.add('findUnique returned the wrong row', `${tag}\ngot ${show(got)}`);
          }
          if (stable(after) !== stable(expected)) {
            failures.add(
              `${method}: table state is wrong${run.ok ? '' : ' after a refused call'}`,
              `${tag}\nwhere ${show(where)}\nrows before ${before.length}, after ${after.length}\nchanged ids: ${
                after
                  .filter((r) => stable(r) !== stable(expected.find((e) => e.id === r.id)))
                  .map((r) => r.id)
                  .join(',') || 'none'
              }; missing ids: ${
                expected
                  .filter((e) => !after.some((r) => r.id === e.id))
                  .map((e) => e.id)
                  .join(',') || 'none'
              }`,
            );
            failures.tally(`${method} changed rows it should not have (${identity.label})`);
          }
        }
        failures.assertClean(`${method} by ${key}`, IDENTITIES.length);
      });
    }
  }
});
