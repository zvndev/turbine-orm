/**
 * Codegen and introspection against hostile catalog names.
 *
 * Postgres accepts almost any characters in a quoted identifier, so a table,
 * column, enum label or type name is text somebody else chose. Three things must
 * hold whatever that text is:
 *
 *   1. The generated TypeScript is valid, strict-clean, and carries the name
 *      back out exactly (no payload runs, nothing is lost or reordered).
 *   2. Records keyed by catalog names have no prototype, so a table called
 *      `__proto__` or `constructor` is a table and not a prototype assignment.
 *   3. A name printed in an error or a log line cannot drive the terminal.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/codegen-cli-hardening.test.ts
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import pg from 'pg';
import { generateIndex, generateMetadata, generateTypes, generateZod } from '../generate.js';
import {
  applyRelationRenames,
  assertDistinctColumnFields,
  buildRelationsFromForeignKeys,
  introspect,
  nullRecord,
  printableCatalogName,
} from '../introspect.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { diagnosticsIn, makeProject, type Project, typecheckFiles } from './codegen-cli-fixture.js';
import { skipGate } from './helpers.js';

const ESC = String.fromCharCode(27);
const NUL = String.fromCharCode(0);

// ---------------------------------------------------------------------------
// Names printed to a terminal
// ---------------------------------------------------------------------------

describe('printableCatalogName', () => {
  const cases: Array<[string, string, string]> = [
    ['newline', 'a\nb', 'a\\nb'],
    ['carriage return', 'a\rb', 'a\\rb'],
    ['tab', 'a\tb', 'a\\tb'],
    ['ESC (an ANSI sequence)', `a${ESC}[2Jb`, 'a\\u001b[2Jb'],
    ['NUL', `a${NUL}b`, 'a\\u0000b'],
    ['DEL', 'a\u007fb', 'a\\u007fb'],
    ['a C1 control (CSI)', 'a\u009bb', 'a\\u009bb'],
    ['a line separator', 'a\u2028b', 'a\\u2028b'],
    ['a right-to-left override', 'a\u202eb', 'a\\u202eb'],
    ['a directional isolate', 'a\u2066b', 'a\\u2066b'],
  ];
  for (const [what, input, expected] of cases) {
    it(`escapes ${what}`, () => {
      assert.equal(printableCatalogName(input), expected);
    });
  }

  it('leaves ordinary names and non-ASCII letters alone', () => {
    for (const name of ['users', 'café', '日本語', '😀', "it's", 'a"b', 'back\\slash', 'with space']) {
      assert.equal(printableCatalogName(name), name);
    }
  });

  it('its output never contains a character it escapes', () => {
    const all = Array.from({ length: 0xa0 }, (_, i) => String.fromCharCode(i)).join('');
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control characters are gone
    assert.doesNotMatch(printableCatalogName(all), /[\u0000-\u001f\u007f-\u009f]/);
  });
});

describe('error messages print hostile names escaped', () => {
  const hostile = `evil${ESC}[2J\n\u202ename`;
  const noRawControls = (message: string) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting control characters are gone
    assert.doesNotMatch(message, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/, message);
  };

  it('a field collision names its columns and table escaped', () => {
    const columns = [
      { name: `a${ESC}b`, field: 'x' },
      { name: `c\nd`, field: 'x' },
    ] as ColumnMetadata[];
    assert.throws(
      () => assertDistinctColumnFields(hostile, columns),
      (err: unknown) => {
        const message = (err as Error).message;
        noRawControls(message);
        assert.match(message, /a\\u001bb/);
        assert.match(message, /c\\nd/);
        return true;
      },
    );
  });

  it('an unknown table in relationNames is printed escaped', () => {
    assert.throws(
      () => applyRelationRenames({ enums: {}, tables: {} }, { [hostile]: { a: 'b' } }),
      (err: unknown) => {
        noRawControls((err as Error).message);
        assert.match((err as Error).message, /evil\\u001b\[2J\\n\\u202ename/);
        return true;
      },
    );
  });

  it('a relation name collision warning is printed escaped', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      // Two foreign keys from one table to the same target whose derived relation
      // name equals an existing column field: the collision path warns by name.
      buildRelationsFromForeignKeys(
        [
          {
            sourceTable: hostile,
            sourceColumns: ['owner_id'],
            targetTable: 'owners',
            targetColumns: ['id'],
            constraintName: `fk${ESC}1`,
          },
        ],
        new Map([
          [hostile, new Set(['owner', 'ownerId'])],
          ['owners', new Set(['id'])],
        ]),
      );
    } finally {
      console.warn = original;
    }
    for (const warning of warnings) noRawControls(warning);
  });
});

// ---------------------------------------------------------------------------
// A hostile column set, built by hand
// ---------------------------------------------------------------------------

/** Names that need quoting, escaping, or both, in every emission position. */
const HOSTILE_COLUMNS = [
  "it's",
  'back\\slash',
  'end*/mark',
  '日本語',
  '$dollar',
  'constructor',
  'with space',
  'a"b',
  'Weird Case',
  '😀',
  'x*/ globalThis.__INJECTED_1 = 1; /*y',
  "a': (globalThis.__INJECTED_2 = 1), 'b",
  "[Function('globalThis.__INJECTED_3=1')()+'x']",
  ['`', '$', '{globalThis.__INJECTED_4 = 1}', '`'].join(''),
  'toString',
];
const HOSTILE_ENUM_LABELS = [
  "it's",
  'a\\b',
  'x*/y',
  '日本',
  'with "dq"',
  '__proto__',
  'constructor',
  ['`', '$', '{1}', '`'].join(''),
];

function column(name: string, field: string, extra: Partial<ColumnMetadata> = {}): ColumnMetadata {
  return {
    name,
    field,
    pgType: 'text',
    tsType: 'string',
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...extra,
  };
}

function tableOf(name: string, columns: ColumnMetadata[]): TableMetadata {
  const own = (entries: Array<[string, string]>) => Object.fromEntries(entries);
  return {
    name,
    columns,
    columnMap: own(columns.map((c) => [c.field, c.name])),
    reverseColumnMap: own(columns.map((c) => [c.name, c.field])),
    dateColumns: new Set<string>(),
    pgTypes: own(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [],
    indexes: [],
    isView: false,
    relations: {},
  };
}

function hostileSchema(): SchemaMetadata {
  const columns = [
    column('id', 'id', { pgType: 'int4', tsType: 'number', hasDefault: true, pgArrayType: 'integer[]' }),
    column('mood', 'mood', { pgType: 'mood', tsType: 'Mood', pgArrayType: 'text[]' }),
    // snakeToCamel turns `__proto__` into `_Proto__`; the column keeps its real name.
    column('__proto__', '_Proto__'),
    ...HOSTILE_COLUMNS.map((name) => column(name, name)),
  ];
  return { enums: { mood: HOSTILE_ENUM_LABELS }, tables: { weird_things: tableOf('weird_things', columns) } };
}

/** The `__INJECTED_*` globals a run of generated code left behind. */
function injected(context: vm.Context): string[] {
  return Object.getOwnPropertyNames(context).filter((k) => k.startsWith('__INJECTED'));
}

/** Evaluate a generated metadata.ts in a fresh context and return the SCHEMA it declares. */
interface EmittedMetadata {
  tables: Record<string, { columns: Array<{ name: string }>; reverseColumnMap: Record<string, string> }>;
  enums: Record<string, string[]>;
}

function runMetadata(source: string): { context: vm.Context; schema: EmittedMetadata } {
  const js = source
    .replace("import type { SchemaMetadata } from 'turbine-orm';\n", '')
    .replace('export const SCHEMA: SchemaMetadata = {', 'globalThis.SCHEMA = {')
    .replace('export const schema = SCHEMA;', ';');
  const context = vm.createContext({});
  vm.runInContext(js, context, { timeout: 5_000 });
  return { context, schema: (context as unknown as { SCHEMA: EmittedMetadata }).SCHEMA };
}

/**
 * The checks every hostile schema must pass: all emitters run, the output
 * compiles under `strict`, no payload executes, and metadata.ts carries every
 * name back out exactly as the catalog spelled it.
 */
function assertGeneratedOutputSound(schema: SchemaMetadata, tableName: string, expectedColumns: string[]) {
  const options = { noTimestamp: true };
  const types = generateTypes(schema, options);
  const metadata = generateMetadata(schema, options);
  const index = generateIndex(schema, options);
  const zod = generateZod(schema, options);

  const checked = typecheckFiles({ 'types.ts': types, 'metadata.ts': metadata, 'index.ts': index });
  assert.deepEqual(
    diagnosticsIn(checked, ['types.ts', 'metadata.ts', 'index.ts']),
    [],
    'generated output failed to typecheck',
  );

  // zod.ts imports a package this repo does not install for tests, so only its SYNTAX is checked.
  const zodChecked = typecheckFiles({ 'types.ts': types, 'zod.ts': zod });
  const syntaxErrors = zodChecked.output.split('\n').filter((line) => /error TS1\d{3}:/.test(line));
  assert.deepEqual(syntaxErrors, [], `zod.ts is not valid TypeScript:\n${syntaxErrors.join('\n')}`);

  const { context, schema: emitted } = runMetadata(metadata);
  assert.deepEqual(injected(context), [], 'a hostile name executed when metadata.ts was evaluated');
  // Arrays built in the vm context have that context's Array.prototype, so compare as plain data.
  const table = emitted.tables[tableName];
  assert.ok(table, `metadata.ts does not declare ${tableName}`);
  assert.deepEqual(
    [...table.columns].map((c) => c.name),
    expectedColumns,
    'a column name did not survive emission',
  );
  return { emitted, context };
}

describe('hostile names: generated code is valid, injection-free and lossless (hand-built schema)', () => {
  const schema = hostileSchema();

  it('typechecks under strict and carries every name back out', () => {
    const { emitted } = assertGeneratedOutputSound(schema, 'weird_things', [
      'id',
      'mood',
      '__proto__',
      ...HOSTILE_COLUMNS,
    ]);
    assert.deepEqual([...(emitted.enums.mood ?? [])], HOSTILE_ENUM_LABELS);
  });

  it('a column named __proto__ is an own property of reverseColumnMap, not a prototype assignment', () => {
    const { schema: emitted } = runMetadata(generateMetadata(schema, { noTimestamp: true }));
    const reverse = emitted.tables.weird_things?.reverseColumnMap ?? {};
    assert.ok(Object.getOwnPropertyNames(reverse).includes('__proto__'), 'the __proto__ key was swallowed');
    assert.equal(Object.getOwnPropertyDescriptor(reverse, '__proto__')?.value, '_Proto__');
  });

  it('control: a payload placed in expression position DOES execute, so a clean run means something', () => {
    const context = vm.createContext({});
    vm.runInContext(`globalThis.out = { [Function('globalThis.__INJECTED_CONTROL=1')()+'x']: 1 };`, context);
    assert.deepEqual(injected(context), ['__INJECTED_CONTROL']);
  });
});

describe('reserved table accessors', () => {
  /** A one-table schema keyed the way introspection keys it, so `__proto__` is an own key. */
  function schemaWithTable(name: string): SchemaMetadata {
    const tables = nullRecord<TableMetadata>();
    tables[name] = tableOf(name, [column('id', 'id', { pgType: 'int4', tsType: 'number', pgArrayType: 'integer[]' })]);
    return { enums: {}, tables };
  }

  it('a table named constructor is refused, naming the fix', () => {
    assert.throws(
      () => generateIndex(schemaWithTable('constructor'), { noTimestamp: true }),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'TURBINE_E003');
        assert.match((err as Error).message, /client accessor "constructor" is a reserved class member name/);
        assert.match((err as Error).message, /Rename the table, or exclude it/);
        return true;
      },
    );
  });

  it('a table named __proto__ gets the ordinary accessor _Proto__ and is emitted', () => {
    const schema = schemaWithTable('__proto__');
    assert.match(generateIndex(schema, { noTimestamp: true }), /declare readonly _Proto__:/);
    const { schema: emitted } = runMetadata(generateMetadata(schema, { noTimestamp: true }));
    assert.ok(Object.getOwnPropertyNames(emitted.tables).includes('__proto__'), 'the __proto__ table was swallowed');
  });
});

// ---------------------------------------------------------------------------
// The live catalog
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');
/** A table looked up as an own key, since `schema.tables.constructor` is typed as Object's. */
function tableNamed(schema: SchemaMetadata, name: string): TableMetadata {
  const table = Object.getOwnPropertyDescriptor(schema.tables, name)?.value as TableMetadata | undefined;
  assert.ok(table, `no table named ${name}`);
  return table;
}

/** Run `fn` with console.warn captured, so an expected introspection warning does not clutter the run. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;

describe('hostile names through the live catalog', () => {
  const SCHEMA_NAME = `cgcli_host_${process.pid}_${Date.now().toString(36)}`;
  let pool: pg.Pool;

  before(async () => {
    if (!DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await pool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    await pool.query(`CREATE TYPE ${SCHEMA_NAME}.mood AS ENUM (${HOSTILE_ENUM_LABELS.map(lit).join(', ')})`);
    await pool.query(
      `CREATE TABLE ${SCHEMA_NAME}.weird_things (id serial PRIMARY KEY, mood ${SCHEMA_NAME}.mood, ` +
        `${q('__proto__')} text NOT NULL DEFAULT '', ` +
        `${HOSTILE_COLUMNS.map((c, i) => `${q(c)} text${i % 2 ? " NOT NULL DEFAULT ''" : ''}`).join(', ')})`,
    );
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    await pool.end();
  });

  live.it('introspection keeps every name, and the generated client is sound', async () => {
    const schema = await quietly(() => introspect({ connectionString: DATABASE_URL!, schema: SCHEMA_NAME }));
    const names = schema.tables.weird_things!.columns.map((c) => c.name);
    assert.deepEqual(names.sort(), ['id', 'mood', '__proto__', ...HOSTILE_COLUMNS].sort());
    assertGeneratedOutputSound(
      schema,
      'weird_things',
      schema.tables.weird_things!.columns.map((c) => c.name),
    );
  });
});

describe('catalog-keyed records have no prototype (live catalog)', () => {
  const SCHEMA_NAME = `cgcli_np_${process.pid}_${Date.now().toString(36)}`;
  let pool: pg.Pool;

  before(async () => {
    if (!DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await pool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    await pool.query(`CREATE TYPE ${SCHEMA_NAME}.${q('hasOwnProperty')} AS ENUM ('a', 'b')`);
    await pool.query(`CREATE TYPE ${SCHEMA_NAME}.${q('toString')} AS (a int)`);
    await pool.query(`CREATE TABLE ${SCHEMA_NAME}.${q('__proto__')} (id serial PRIMARY KEY, label text NOT NULL)`);
    await pool.query(
      `CREATE TABLE ${SCHEMA_NAME}.${q('constructor')} (id serial PRIMARY KEY, ` +
        `proto_id int REFERENCES ${SCHEMA_NAME}.${q('__proto__')}(id), ` +
        `kind ${SCHEMA_NAME}.${q('hasOwnProperty')}, shape ${SCHEMA_NAME}.${q('toString')}, ${q('__proto__')} text)`,
    );
    await pool.query(`CREATE TABLE ${SCHEMA_NAME}.${q('valueOf')} (id serial PRIMARY KEY)`);
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    await pool.end();
  });

  live.it('every map keyed by a catalog name is prototype-less and holds the odd names as own keys', async () => {
    const schema = await quietly(() => introspect({ connectionString: DATABASE_URL!, schema: SCHEMA_NAME }));
    assert.equal(Object.getPrototypeOf(schema.tables), null, 'tables');
    assert.equal(Object.getPrototypeOf(schema.enums), null, 'enums');
    assert.deepEqual(Object.keys(schema.tables).sort(), ['__proto__', 'constructor', 'valueOf']);
    assert.deepEqual(Object.keys(schema.enums), ['hasOwnProperty']);
    assert.deepEqual(schema.enums.hasOwnProperty, ['a', 'b']);
    for (const table of Object.values(schema.tables)) {
      for (const key of ['columnMap', 'reverseColumnMap', 'pgTypes', 'dialectTypes', 'relations'] as const) {
        assert.equal(Object.getPrototypeOf(table[key]), null, `${table.name}.${key}`);
      }
    }
    // Nothing is inherited, so a lookup of a name that is not there is undefined.
    assert.equal(schema.enums.toString, undefined);
    assert.equal(schema.tables.hasOwnProperty, undefined);
    const proto = tableNamed(schema, '__proto__');
    assert.equal(proto.name, '__proto__');
    assert.ok(proto.relations && Object.keys(proto.relations).length === 1, 'the hasMany side of the foreign key');
    const ctor = tableNamed(schema, 'constructor');
    assert.equal(Object.keys(ctor.relations).length, 1, 'the belongsTo side of the foreign key');
    assert.ok(Object.hasOwn(ctor.reverseColumnMap, '__proto__'), 'a column named __proto__ is an own key');
  });

  live.it(
    'a column typed as a user type named after an Object.prototype member is unknown, not function source',
    async () => {
      const schema = await quietly(() => introspect({ connectionString: DATABASE_URL!, schema: SCHEMA_NAME }));
      const shape = tableNamed(schema, 'constructor').columns.find((c) => c.name === 'shape');
      assert.ok(shape);
      assert.equal(shape.tsType, 'unknown | null');
      assert.doesNotMatch(shape.tsType, /native code|function/);
    },
  );

  live.it('generate refuses the table whose accessor is a reserved class member, naming the fix', async () => {
    const schema = await quietly(() => introspect({ connectionString: DATABASE_URL!, schema: SCHEMA_NAME }));
    assert.throws(
      () => generateIndex(schema, { noTimestamp: true }),
      /client accessor "constructor" is a reserved class member name/,
    );
  });

  live.it(
    'excluding that table leaves a schema that generates, typechecks, and keeps the __proto__ table',
    async () => {
      const schema = await quietly(() =>
        introspect({ connectionString: DATABASE_URL!, schema: SCHEMA_NAME, exclude: ['constructor'] }),
      );
      assert.deepEqual(Object.keys(schema.tables).sort(), ['__proto__', 'valueOf']);
      const types = generateTypes(schema, { noTimestamp: true });
      const metadata = generateMetadata(schema, { noTimestamp: true });
      const index = generateIndex(schema, { noTimestamp: true });
      const checked = typecheckFiles({ 'types.ts': types, 'metadata.ts': metadata, 'index.ts': index });
      assert.deepEqual(diagnosticsIn(checked, ['types.ts', 'metadata.ts', 'index.ts']), []);
      const { schema: emitted } = runMetadata(metadata);
      assert.ok(Object.getOwnPropertyNames(emitted.tables).includes('__proto__'), 'the __proto__ table was swallowed');
    },
  );
});

// ---------------------------------------------------------------------------
// What the CLI prints
// ---------------------------------------------------------------------------

describe('the CLI prints catalog names escaped (live catalog)', () => {
  // A right-to-left override is not a control character the introspection guard
  // refuses, so a table can carry it all the way to the terminal.
  const BIDI = String.fromCharCode(0x202e);
  const SCHEMA_NAME = `cgcli_bidi_${process.pid}_${Date.now().toString(36)}`;
  const TABLE = `evil${BIDI}name`;
  let pool: pg.Pool;
  let project: Project;

  before(async () => {
    if (!DATABASE_URL) return;
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    await pool.query(`CREATE SCHEMA ${SCHEMA_NAME}`);
    await pool.query(`CREATE TABLE ${SCHEMA_NAME}.${q(TABLE)} (id serial PRIMARY KEY, ${q(`col${BIDI}umn`)} text)`);
    project = makeProject('hardening-cli', { databaseUrl: DATABASE_URL });
    project.write('turbine.config.js', `export default { schema: ${JSON.stringify(SCHEMA_NAME)} };\n`);
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA_NAME} CASCADE`);
    await pool.end();
    project?.cleanup();
  });

  live.it('status lists the table and its column with the override escaped', () => {
    const run = project.cli(['status']);
    assert.equal(run.status, 0, run.output);
    assert.ok(run.output.includes('evil\\u202ename'), `the table name was not escaped:\n${run.output}`);
    assert.ok(run.output.includes('col\\u202eumn'), `the column name was not escaped:\n${run.output}`);
    assert.ok(!run.output.includes(BIDI), 'a raw bidi override reached the terminal');
  });

  live.it('generate refuses the name and prints it escaped', () => {
    const run = project.cli(['generate', '--out', './generated/bidi']);
    assert.notEqual(run.status, 0, run.output);
    assert.ok(!run.output.includes(BIDI), 'a raw bidi override reached the terminal');
    assert.match(run.output, /evil\\u202ename/);
  });
});
