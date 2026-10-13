/**
 * Oracle 4: createMany(rows) vs N x create(row) vs raw INSERT, on database state.
 *
 * The same rows are written three ways into three identical tables and the
 * stored values are read back with raw SQL as text:
 *
 *   a   createMany({ data: rows })
 *   b   create({ data: row }) once per row
 *   c   a hand-written INSERT with an explicit cast per column (the oracle)
 *
 * a, b and c must match column for column, and a must hold exactly as many rows
 * as were sent. The table covers the common column types, and JSON columns get
 * the values that are easy to mishandle: objects, empty and non-empty arrays,
 * nested arrays, arrays of objects, JSON text passed as a string, and scalars.
 *
 * JSON write contract: a JS array or object is stored as that JSON document; a
 * JS string is RAW JSON TEXT (so `'[1,2]'` stores the array and `'"hi"'` stores
 * the string "hi"); `jsonValue(v)` stores `JSON.stringify(v)` whatever v is.
 *
 * The process time zone is set to a non-UTC zone for the run so a zone-less
 * `timestamp` or `date` written from a `Date` cannot agree by accident.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-createmany-vs-create.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type pg from 'pg';
import * as turbineExports from '../index.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, rngFor, SKIP, scaled } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { rawReader, rawWriter, runScript } from './oracle/raw.js';
import { describeError, introspectTables, makeClient, type OracleClient, show } from './oracle/util.js';

const FILE = 'oracle-createmany-vs-create.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const TABLE_A = 'orc_w_many';
const TABLE_B = 'orc_w_each';
const TABLE_C = 'orc_w_raw';
const ENUM = 'orc_w_mood';

interface ColumnSpec {
  /** Database column name. */
  readonly col: string;
  /** Turbine field name. */
  readonly field: string;
  /** Postgres type, used for the DDL and for the oracle's cast. */
  readonly pgType: string;
  /** SQL expression that renders the stored value as comparable text. */
  readonly render: (col: string) => string;
  /** How the oracle binds a JS value. */
  readonly bind: (v: unknown) => unknown;
  readonly cases: readonly unknown[];
}

const asIs = (v: unknown): unknown => v;
const text = (c: string): string => `${c}::text`;
const jsonBind = (v: unknown): unknown => (typeof v === 'string' ? v : JSON.stringify(v));
const jsonRender = (c: string): string => `${c}::jsonb::text || '/' || coalesce(json_typeof(${c}::json), 'null')`;

const JSON_CASES: readonly unknown[] = [
  { a: 1 },
  {},
  [],
  [1, 2, 3],
  [[1, 2], [3]],
  [{ x: 1 }, { y: [2, null] }],
  { nested: [1, { deep: [] }], s: 'it\'s "quoted"' },
  '{"raw":"text"}',
  '[1,2]',
  '"just a string"',
  5,
  true,
  null,
];

const COLUMNS: readonly ColumnSpec[] = [
  {
    col: 'c_text',
    field: 'cText',
    pgType: 'text',
    render: text,
    bind: asIs,
    cases: ['plain', '', "it's", 'a"b\\c', 'ünï 😀', 'two\nlines', null],
  },
  {
    col: 'c_int',
    field: 'cInt',
    pgType: 'int',
    render: text,
    bind: asIs,
    cases: [0, -1, 2147483647, -2147483648, null],
  },
  {
    col: 'c_bigint',
    field: 'cBigint',
    pgType: 'bigint',
    render: text,
    bind: String,
    cases: [
      '9007199254740993',
      '-9223372036854775808',
      '9223372036854775807',
      9007199254740991,
      0n,
      123456789012345678n,
      null,
    ],
  },
  {
    col: 'c_numeric',
    field: 'cNumeric',
    pgType: 'numeric(40,10)',
    render: text,
    bind: String,
    cases: ['12345678901234567890.1234567890', '-0.0000000001', 0.1, 3, 'NaN', null],
  },
  {
    col: 'c_float',
    field: 'cFloat',
    pgType: 'double precision',
    render: text,
    bind: asIs,
    cases: [1.5, -2.25, 1e308, NaN, Infinity, -Infinity, 0, null],
  },
  { col: 'c_bool', field: 'cBool', pgType: 'boolean', render: text, bind: asIs, cases: [true, false, null] },
  {
    col: 'c_timestamptz',
    field: 'cTimestamptz',
    pgType: 'timestamptz',
    render: (c) => `extract(epoch from ${c})::text`,
    bind: (v) => (v as Date).toISOString(),
    cases: [
      new Date('2024-03-10T10:30:00.123Z'),
      new Date('1970-01-01T00:00:00Z'),
      new Date('1969-12-31T23:59:59.999Z'),
      new Date('2038-01-19T03:14:08Z'),
      null,
    ],
  },
  {
    col: 'c_timestamp',
    field: 'cTimestamp',
    pgType: 'timestamp',
    render: text,
    bind: (v) => (v as Date).toISOString(),
    cases: [
      new Date('2024-03-10T10:30:00.123Z'),
      new Date('2024-11-03T01:30:00Z'),
      new Date('1970-01-01T00:00:00Z'),
      new Date('2024-03-10T02:30:00Z'),
      null,
    ],
  },
  {
    col: 'c_date',
    field: 'cDate',
    pgType: 'date',
    render: text,
    bind: (v) => (v as Date).toISOString().slice(0, 10),
    cases: [
      new Date('2024-03-10T00:00:00Z'),
      new Date('1970-01-01T00:00:00Z'),
      new Date('2000-02-29T00:00:00Z'),
      new Date('2024-11-03T00:00:00Z'),
      null,
    ],
  },
  {
    col: 'c_uuid',
    field: 'cUuid',
    pgType: 'uuid',
    render: text,
    bind: asIs,
    cases: ['00000000-0000-4000-8000-000000000001', 'ffffffff-ffff-4fff-8fff-ffffffffffff', null],
  },
  { col: 'c_json', field: 'cJson', pgType: 'json', render: jsonRender, bind: jsonBind, cases: JSON_CASES },
  { col: 'c_jsonb', field: 'cJsonb', pgType: 'jsonb', render: jsonRender, bind: jsonBind, cases: JSON_CASES },
  {
    col: 'c_text_arr',
    field: 'cTextArr',
    pgType: 'text[]',
    render: text,
    bind: asIs,
    cases: [[], ['a', 'b'], ['with "quote"', "it's", 'x,y', '{brace}', ''], ['a', null], null],
  },
  {
    col: 'c_int_arr',
    field: 'cIntArr',
    pgType: 'int[]',
    render: text,
    bind: asIs,
    cases: [[], [1, 2, 3], [1, null, 3], [2147483647], null],
  },
  { col: 'c_mood', field: 'cMood', pgType: ENUM, render: text, bind: asIs, cases: ['sad', 'ok', 'happy', null] },
  {
    col: 'c_mood_arr',
    field: 'cMoodArr',
    pgType: `${ENUM}[]`,
    render: text,
    bind: asIs,
    cases: [[], ['sad', 'happy'], ['ok'], null],
  },
  {
    col: 'c_bytea',
    field: 'cBytea',
    pgType: 'bytea',
    render: (c) => `encode(${c}, 'hex')`,
    bind: asIs,
    cases: [Buffer.from([0, 255, 16]), Buffer.alloc(0), Buffer.from('plain'), null],
  },
];

const tableDdl = (name: string): string => `
CREATE TABLE ${name} (
  id serial PRIMARY KEY,
  k int NOT NULL,
  ${COLUMNS.map((c) => `${c.col} ${c.pgType}`).join(',\n  ')}
);`;

const DDL = `
DROP TABLE IF EXISTS ${TABLE_A}, ${TABLE_B}, ${TABLE_C} CASCADE;
DROP TYPE IF EXISTS ${ENUM} CASCADE;
CREATE TYPE ${ENUM} AS ENUM ('sad', 'ok', 'happy');
${tableDdl(TABLE_A)}
${tableDdl(TABLE_B)}
${tableDdl(TABLE_C)}
`;

let db: OracleClient;
let reader: pg.Client;
let writer: pg.Client;
let savedTz: string | undefined;

type RowInput = Record<string, unknown>;

const caseLabel = (v: unknown): string => show(v);

describe('oracle: createMany, repeated create and a raw INSERT store the same values', () => {
  before(async () => {
    savedTz = process.env.TZ;
    process.env.TZ = 'America/New_York';
    await runScript(DATABASE_URL!, DDL);
    const schema = await introspectTables(DATABASE_URL!, [TABLE_A, TABLE_B, TABLE_C]);
    db = makeClient(DATABASE_URL!, schema);
    reader = await rawReader(DATABASE_URL!);
    writer = await rawWriter(DATABASE_URL!);
  });

  after(async () => {
    process.env.TZ = savedTz;
    if (savedTz === undefined) delete process.env.TZ;
    await db?.disconnect();
    await reader?.end();
    await writer?.end();
    if (!SKIP)
      await runScript(
        DATABASE_URL!,
        `DROP TABLE IF EXISTS ${TABLE_A}, ${TABLE_B}, ${TABLE_C} CASCADE; DROP TYPE IF EXISTS ${ENUM} CASCADE`,
      );
  });

  async function reset(): Promise<void> {
    await writer.query(`TRUNCATE ${TABLE_A}, ${TABLE_B}, ${TABLE_C} RESTART IDENTITY`);
  }

  /** Raw INSERT of one row: only the keys present in `row`, each bound and cast per the column spec. */
  async function rawInsert(row: RowInput): Promise<void> {
    const present = COLUMNS.filter((c) => c.field in row);
    const cols = ['k', ...present.map((c) => c.col)];
    const params = [row.k, ...present.map((c) => (row[c.field] === null ? null : c.bind(row[c.field])))];
    const placeholders = ['$1', ...present.map((c, i) => `$${i + 2}::${c.pgType}`)];
    await writer.query(`INSERT INTO ${TABLE_C} (${cols.join(',')}) VALUES (${placeholders.join(',')})`, params);
  }

  async function snapshot(
    table: string,
    columns: readonly ColumnSpec[],
  ): Promise<Map<number, Record<string, string | null>>> {
    const select = ['k', ...columns.map((c) => `${c.render(c.col)} AS ${c.col}`)].join(', ');
    const result = await reader.query(`SELECT ${select} FROM ${table} ORDER BY k, id`);
    const byK = new Map<number, Record<string, string | null>>();
    for (const r of result.rows as Record<string, string | null>[]) byK.set(Number(r.k), r);
    return byK;
  }

  /**
   * Write `rows` the three ways and compare the stored values of `columns`.
   * `label` names the scenario in the report.
   */
  async function compareWrites(
    failures: Failures,
    label: string,
    rows: RowInput[],
    columns: readonly ColumnSpec[],
  ): Promise<void> {
    await reset();
    for (const row of rows) await rawInsert(row);

    failures.checked();
    let manyThrew = false;
    const createThrew = new Set<number>();
    try {
      await db.t(TABLE_A).createMany({ data: rows });
    } catch (e) {
      manyThrew = true;
      failures.add(`${label}: createMany threw`, `${describeError(e)}\nrows ${caseLabel(rows)}`.slice(0, 600));
    }
    for (const row of rows) {
      try {
        await db.t(TABLE_B).create({ data: row });
      } catch (e) {
        createThrew.add(row.k as number);
        failures.add(`${label}: create threw`, `${describeError(e)}\nrow ${caseLabel(row)}`.slice(0, 500));
      }
    }

    const oracle = await snapshot(TABLE_C, columns);
    for (const [name, table] of [
      ['createMany', TABLE_A],
      ['create', TABLE_B],
    ] as const) {
      const stored = await snapshot(table, columns);
      const total = (await reader.query(`SELECT count(*) AS n FROM ${table}`)).rows[0] as { n: string };
      failures.checked();
      if (Number(total.n) > rows.length) {
        failures.add(
          `${label}: ${name} stored MORE rows than were sent`,
          `sent ${rows.length}, table holds ${total.n}`,
        );
      }
      for (const [k, expected] of oracle) {
        const got = stored.get(k);
        failures.checked();
        const alreadyReported = name === 'createMany' ? manyThrew : createThrew.has(k);
        if (!got) {
          if (!alreadyReported)
            failures.add(
              `${label}: ${name} lost a row`,
              `row k=${k} ${caseLabel(rows.find((r) => r.k === k))}`.slice(0, 400),
            );
          continue;
        }
        for (const c of columns) {
          if (got[c.col] !== expected[c.col]) {
            failures.add(
              `${label}: ${name} stored a different ${c.col}`,
              `input ${caseLabel(rows.find((r) => r.k === k)?.[c.field])}\nraw INSERT stored ${show(expected[c.col])}\n${name} stored ${show(got[c.col])}`,
            );
          }
        }
      }
    }
  }

  for (const spec of COLUMNS) {
    it(`${spec.col} (${spec.pgType}): every value stores identically`, async () => {
      const failures = new Failures(FILE);
      const rows: RowInput[] = spec.cases.map((value, i) => ({ k: i + 1, [spec.field]: value }));
      await compareWrites(failures, spec.col, rows, [spec]);
      failures.assertClean(`${spec.col} writes`, rows.length * 2);
    });
  }

  for (const spec of COLUMNS.filter((c) => c.col === 'c_json' || c.col === 'c_jsonb')) {
    it(`${spec.col}: createMany with array documents stores one row per input row`, async () => {
      // An array bound to a batched insert can be flattened into extra rows; the row count is the tell.
      const failures = new Failures(FILE);
      const text = COLUMNS.find((c) => c.col === 'c_text') as ColumnSpec;
      const scenarios: [string, RowInput[]][] = [
        ['one row, three elements', [{ k: 1, cText: 'a', [spec.field]: [1, 2, 3] }]],
        [
          'two rows, equal-length arrays',
          [
            { k: 1, [spec.field]: [1, 2] },
            { k: 2, [spec.field]: [3, 4] },
          ],
        ],
        [
          'two rows, different lengths',
          [
            { k: 1, [spec.field]: [1, 2, 3] },
            { k: 2, [spec.field]: [4] },
          ],
        ],
        ['one row, empty array', [{ k: 1, cText: 'e', [spec.field]: [] }]],
        [
          'one row, nested arrays',
          [
            {
              k: 1,
              [spec.field]: [
                [1, 2],
                [3, 4],
              ],
            },
          ],
        ],
        [
          'array rows beside an object row',
          [
            { k: 1, [spec.field]: [1] },
            { k: 2, [spec.field]: { a: 1 } },
          ],
        ],
      ];
      for (const [name, rows] of scenarios) {
        const columns = rows.some((r) => 'cText' in r) ? [spec, text] : [spec];
        await compareWrites(failures, name, rows, columns);
      }
      failures.assertClean(`${spec.col} array documents`, 12);
    });
  }

  it('JSON values written with jsonValue() store exactly JSON.stringify of the value', async () => {
    const jsonValue = (turbineExports as Record<string, unknown>).jsonValue as ((v: unknown) => unknown) | undefined;
    assert.equal(typeof jsonValue, 'function', 'jsonValue is not exported from the package root');
    const plain: unknown[] = ['hello', '', 'a "quoted" string', 5, true, null, [1, 2], { a: 1 }, [], 'not json {'];
    const failures = new Failures(FILE);
    for (const spec of COLUMNS.filter((c) => c.col === 'c_json' || c.col === 'c_jsonb')) {
      await reset();
      const rows = plain.map((value, i) => ({ k: i + 1, [spec.field]: jsonValue!(value) }));
      for (const [i, value] of plain.entries()) {
        await writer.query(`INSERT INTO ${TABLE_C} (k, ${spec.col}) VALUES ($1, $2::${spec.pgType})`, [
          i + 1,
          JSON.stringify(value),
        ]);
      }
      failures.checked();
      try {
        await db.t(TABLE_A).createMany({ data: rows });
      } catch (e) {
        failures.add(`${spec.col}: createMany with jsonValue threw`, describeError(e));
      }
      for (const row of rows) {
        try {
          await db.t(TABLE_B).create({ data: row });
        } catch (e) {
          failures.add(`${spec.col}: create with jsonValue threw`, describeError(e));
        }
      }
      const oracle = await snapshot(TABLE_C, [spec]);
      for (const [name, table] of [
        ['createMany', TABLE_A],
        ['create', TABLE_B],
      ] as const) {
        const stored = await snapshot(table, [spec]);
        for (const [k, expected] of oracle) {
          failures.checked();
          if (stored.get(k)?.[spec.col] !== expected[spec.col]) {
            failures.add(
              `${spec.col}: ${name} with jsonValue stored a different value`,
              `input ${caseLabel(plain[k - 1])}\nexpected ${show(expected[spec.col])}\ngot ${show(stored.get(k)?.[spec.col])}`,
            );
          }
        }
      }
    }
    failures.assertClean('jsonValue writes', 20);
  });

  it('all columns together, random rows and random column subsets: createMany == create == raw INSERT', async () => {
    const rng = rngFor('createmany:bulk');
    const batches = scaled(6, 40);
    const rowsPerBatch = scaled(8, 30);
    const failures = new Failures(FILE, 2);
    for (let b = 0; b < batches; b++) {
      // createMany requires every row to supply the same fields, so the subset is per batch.
      const subset = COLUMNS.filter(() => rng.chance(0.65));
      if (subset.length === 0) continue;
      const rows: RowInput[] = [];
      for (let k = 1; k <= rowsPerBatch; k++) {
        const row: RowInput = { k };
        for (const spec of subset) row[spec.field] = rng.pick(spec.cases);
        rows.push(row);
      }
      await compareWrites(failures, `batch ${b} [${subset.map((c) => c.col).join(',')}]`, rows, subset);
    }
    failures.assertClean('bulk writes', batches * rowsPerBatch);
  });
});
