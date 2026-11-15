// Fixed exact integers, independent of the runtime number parser.
export const values = [
  '-9223372036854775808', '-9007199254740993', '-9007199254740992', '-9007199254740991',
  '-1', '0', '1', '9007199254740991', '9007199254740992', '9007199254740993', '9223372036854775807',
];
export const modes = [
  'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
  'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,NO_BACKSLASH_ESCAPES',
];
export const readInteger = (digits) => BigInt(digits) >= -9007199254740991n && BigInt(digits) <= 9007199254740991n
  ? Number(digits) : digits;
export function expectedRows(engine) {
  return values.map((value, i) => ({ id: i + 1, parent_id: values[i % 2 ? 9 : 1], value,
    optional: i % 2 ? value : null, tiny: engine === 'sqlite' ? value : '7', computed: value }));
}
export function ddl(engine) {
  return [
    `CREATE TABLE parents (id BIGINT NOT NULL PRIMARY KEY, label ${engine === 'mysql' ? 'VARCHAR(40)' : 'TEXT'} NOT NULL)`,
    `CREATE TABLE samples (id ${engine === 'sqlite' ? 'INTEGER' : 'INT'} NOT NULL PRIMARY KEY,
      parent_id BIGINT NOT NULL, value ${engine === 'sqlite' ? '_INT' : 'BIGINT'} NOT NULL, optional BIGINT,
      tiny ${engine === 'sqlite' ? 'TINYINT' : 'SMALLINT'} NOT NULL,
      computed BIGINT GENERATED ALWAYS AS (value) STORED,
      FOREIGN KEY(parent_id) REFERENCES parents(id))`,
    `CREATE TABLE scalar_checks (id INT NOT NULL PRIMARY KEY, amount DECIMAL(8,2) NOT NULL, fraction ${engine === 'mysql' ? 'DOUBLE' : 'REAL'} NOT NULL, enabled BOOLEAN NOT NULL)`,
    ...(engine === 'mysql' ? ['CREATE TABLE unsigned_samples (id INT NOT NULL PRIMARY KEY, value BIGINT UNSIGNED NOT NULL)'] : []),
  ];
}
export function application(engine) {
  return `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { turbine } from './generated/index.js';
${engine === 'mysql' ? "import { createPool } from 'mysql2/promise';" : ''}
const values = ${JSON.stringify(values)};
const readInteger = (s: string): number | string => BigInt(s) >= -9007199254740991n && BigInt(s) <= 9007199254740991n ? Number(s) : s;
async function main() {
  ${engine === 'mysql' ? "const pool = createPool({ uri: process.env.INTEGER_DATABASE!, supportBigNumbers: true, bigNumberStrings: false, namedPlaceholders: true });" : ''}
  const db = await turbine(${engine === 'mysql' ? 'pool' : 'process.env.INTEGER_DATABASE!'}, { logger: {} });
  ${engine === 'mysql' ? `const [[facts]] = await pool.query<any[]>('SELECT @@sql_mode AS sqlMode, VERSION() AS version');
  assert.equal(facts.version, '8.4.0');
  assert.deepEqual(facts.sqlMode.split(',').filter((s: string) => s !== 'IGNORE_SPACE').sort(), process.env.INTEGER_SQL_MODE!.split(',').sort());
  writeFileSync('application-service.json', JSON.stringify(facts));` : ''}
  try {
    await db.parents.create({ data: { id: BigInt(values[1]!), label: 'negative' } });
    await db.parents.create({ data: { id: values[9]!, label: 'positive' } });
    for (const [i, digits] of values.entries()) {
      const input = i % 3 === 0 ? BigInt(digits) : i % 3 === 1 ? digits : readInteger(digits);
      const row = await db.samples.create({ data: { id: i + 1, parentId: values[i % 2 ? 9 : 1]!, value: input,
        optional: i % 2 ? input : null, tiny: ${engine === 'sqlite' ? 'input' : '7'} } });
      const typed: number | string = row.value;
      const computed: number | string | null = row.computed;
      assert.equal(typed, readInteger(digits)); assert.equal(computed, readInteger(digits));
    }
    await db.samples.update({ where: { id: 1 }, data: { value: { set: BigInt(values[0]!) } } });
    const expected = values.map((digits, i) => ({ id: i + 1, parentId: readInteger(values[i % 2 ? 9 : 1]!),
      value: readInteger(digits), optional: i % 2 ? readInteger(digits) : null,
      tiny: ${engine === 'sqlite' ? 'readInteger(digits)' : '7'}, computed: readInteger(digits) }));
    const direct = await db.samples.findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(direct, expected);
    for (const strategy of ['join', 'batched'] as const) {
      const parents = await db.parents.findMany({ with: { samples: { orderBy: { id: 'asc' } } }, relationLoadStrategy: strategy, orderBy: { id: 'asc' } });
      assert.equal(parents.length, 2);
      for (const parent of parents) {
        const nested: number | string | undefined = parent.samples[0]?.value;
        assert.ok(nested !== undefined);
        assert.deepEqual(parent.samples, expected.filter((row) => row.parentId === parent.id));
      }
    }
    for (const [i, digits] of values.entries()) {
      const rows = await db.samples.findMany({ where: { value: { equals: digits } }, select: { value: true } });
      const selected: number | string | undefined = rows[0]?.value;
      assert.deepEqual(rows, [{ value: readInteger(digits) }]); assert.equal(selected, readInteger(digits));
    }
    const filtered = await db.parents.findMany({ where: { samples: { some: { value: values[0]! } } } });
    assert.deepEqual(filtered.map((row) => row.id), [readInteger(values[1]!)]);
    ${engine === 'mysql' ? `await db.unsignedSamples.create({ data: { id: 1, value: 18446744073709551615n } });
    assert.equal((await db.unsignedSamples.findUniqueOrThrow({ where: { id: 1 } })).value, '18446744073709551615');` : ''}
    writeFileSync('observed.json', JSON.stringify(direct));
  } finally { await db.disconnect(); ${engine === 'mysql' ? 'await pool.end();' : ''} }
}
void main();
`;
}
export const negativeStatements = [
  'const numberOnly: number = row.value;',
  'const stringOnly: string = row.value;',
  'const bigintRead: bigint = row.value;',
  'const nonnull: number | string = row.optional;',
  'const bogus = selected.value;',
  'const wrongCardinality: { value: number | string } = related[0]!.samples;',
  'db.samples.create({ data: { id: 20, parentId: 1, value: 1, tiny: 7, computed: 1 } });',
  'db.samples.update({ where: { id: 1 }, data: { computed: 1 } });',
  'db.samples.update({ where: { id: 1 }, data: { value: true } });',
  'db.samples.create({ data: { id: 20, parentId: 1, value: null, tiny: 7 } });',
  "db.samples.findMany({ where: { value: { equals: true } } });",
  'db.samples.findMany({ where: { value: 1n } });',
  'db.parents.create({ data: { id: 20, label: "x", samples: { create: { id: 20, value: false, tiny: 7 } } } });',
  'db.samples.findMany({ select: { missing: true } });',
  "db.scalarChecks.create({ data: { id: 1, amount: 1n, fraction: 1.5, enabled: true } });",
  "db.scalarChecks.create({ data: { id: 1, amount: '1.25', fraction: 1n, enabled: true } });",
  "db.scalarChecks.create({ data: { id: 1, amount: '1.25', fraction: 1.5, enabled: 1n } });",
];
// TypeScript 6.0.3: read unions, selected field, relation array, generated writes, then scalar inputs.
export const negativeCodes = [2322, 2322, 2322, 2322, 2339, 2741, 2353, 2353, 2322, 2322, 2322, 2322, 2322, 2322, 2322, 2322, 2322];
export function typeControls() {
  return `import { turbine } from './generated/index.js';
async function controls() {
const db = await turbine('unused');
const row = await db.samples.findFirstOrThrow();
const selected = (await db.samples.findMany({ select: { id: true } }))[0]!;
const related = await db.parents.findMany({ with: { samples: true } });
await db.samples.update({ where: { id: 1 }, data: { value: 1n, optional: { set: null } } });
await db.samples.update({ where: { id: 1 }, data: { value: { set: '9007199254740993' } } });
await db.samples.update({ where: { id: 1 }, data: { value: { increment: 1 } } });
await db.parents.create({ data: { id: 99n, label: 'x', samples: { create: { id: 20, value: 1n, tiny: 7 } } } });
await db.scalarChecks.create({ data: { id: 1, amount: '1.25', fraction: 1.5, enabled: true } });
${negativeStatements.map((statement) => `// @ts-expect-error intentional refusal\n${statement}`).join('\n')}
}
void controls;
`;
}
// SQL Server metadata/declaration fixture only; never a native service claim.
export function mssqlFixture() {
  const column = (name, type, nullable = false, extra = {}) => ({
    name, field: name.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), pgType: type, dialectType: type,
    tsType: `${['bigint', 'int', 'smallint', 'float'].includes(type) ? 'number' : type === 'bit' ? 'boolean' : 'string'}${nullable ? ' | null' : ''}`,
    nullable, hasDefault: false, isArray: false, pgArrayType: 'text[]', ...extra,
  });
  const table = (name, columns, relations) => ({ name, columns, primaryKey: ['id'], relations,
    columnMap: Object.fromEntries(columns.map((c) => [c.field, c.name])),
    reverseColumnMap: Object.fromEntries(columns.map((c) => [c.name, c.field])),
    dateColumns: [], jsonColumns: [], booleanColumns: [], numericColumns: [],
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])), indexes: [], allColumns: columns.map((c) => c.name), nullableColumns: columns.filter((c) => c.nullable).map((c) => c.name), uniqueColumns: [],
  });
  return { tables: {
    scalar_checks: table('scalar_checks', [column('id', 'int'), column('amount', 'decimal'), column('fraction', 'float'), column('enabled', 'bit')], {}),
    parents: table('parents', [column('id', 'bigint'), column('label', 'nvarchar')], {
      samples: { type: 'hasMany', name: 'samples', from: 'parents', to: 'samples', foreignKey: 'parent_id', referenceKey: 'id' },
    }),
    samples: table('samples', [column('id', 'int'), column('parent_id', 'bigint'), column('value', 'bigint'),
      column('optional', 'bigint', true), column('tiny', 'smallint'), column('computed', 'bigint', false, { isGeneratedStored: true })], {
      parent: { type: 'belongsTo', name: 'parent', from: 'samples', to: 'parents', foreignKey: 'parent_id', referenceKey: 'id' },
    }),
  }, enums: {} };
}
