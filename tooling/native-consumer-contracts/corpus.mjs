// Held-out billing corpus. SQLite uses TEXT for exact decimal storage deliberately.
export const huge = '9007199254740993';
export const decimal = '12345678901234567890.0123456789';
export const stamp = '2025-02-03T04:05:06.789Z';
export const modes = [
  'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
  'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,ANSI_QUOTES,NO_BACKSLASH_ESCAPES',
];
export function ddl(engine) {
  const sqlite = engine === 'sqlite';
  const pg = engine === 'postgresql';
  return [
    'CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR(80) NOT NULL, email VARCHAR(120) NOT NULL UNIQUE)',
    'CREATE TABLE profiles (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL UNIQUE, label VARCHAR(80) NOT NULL, FOREIGN KEY (customer_id) REFERENCES customers(id))',
    `CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, external_id BIGINT NOT NULL, amount ${sqlite ? 'TEXT' : 'DECIMAL(30,10)'} NOT NULL, payload ${pg ? 'JSONB' : 'JSON'}, note VARCHAR(80), issued_at ${sqlite ? 'DATETIME' : pg ? 'TIMESTAMPTZ' : 'DATETIME(3)'} NOT NULL, score INTEGER NOT NULL, doubled INTEGER GENERATED ALWAYS AS (score * 2) ${pg || !sqlite ? 'STORED' : 'VIRTUAL'}, FOREIGN KEY (customer_id) REFERENCES customers(id))`,
  ];
}
export function nativeRows() {
  return [11, 12, 13, 21, 22, 23].map((id) => ({
    id,
    customer_id: id < 20 ? 1 : 2,
    external_id: huge,
    amount: decimal,
    payload: id === 13 ? null : { flags: [true, null, '雪'], nested: { code: "O'Reilly\\east" } },
    note: id === 11 ? "Updated 'quote' \\ slash 雪" : null,
    issued_at: stamp,
    score: id % 10 === 3 ? 2 : id % 10,
    doubled: (id % 10 === 3 ? 2 : id % 10) * 2,
  }));
}
export const relations = [
  { id: 1, profiles: { id: 10, label: 'Primary' }, invoices: [{ id: 12 }, { id: 11 }] },
  { id: 2, profiles: null, invoices: [{ id: 22 }, { id: 21 }] },
];
export function application(engine) {
  let source = `import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { turbine } from './generated/index.js';
async function main() {
 const url = process.env.DATABASE_URL;
 if (!url) throw new Error('DATABASE_URL required');
 const db = await turbine(url, { logger: {}, logQueryParams: true });
 const trace: unknown[] = [];
 db.$on('query', event => trace.push(event));
 let result: unknown;
 try {
 switch (process.argv[2]) {
 case 'write': {
  for (const [id, name] of [[1, 'Ada'], [2, 'Lin']] as const)
   await db.customers.create({ data: { id, name, email: name.toLowerCase() + '@example.test' } });
  await db.profiles.create({ data: { id: 10, customerId: 1, label: 'Primary' } });
  for (const id of [11, 12, 13, 21, 22, 23]) {
   await db.invoices.create({ data: { id, customerId: id < 20 ? 1 : 2,
    externalId: '${huge}', amount: '${decimal}',
    payload: id === 13 ? null : { flags: [true, null, '雪'], nested: { code: "O'Reilly\\\\east" } },
    note: null, issuedAt: new Date('${stamp}'), score: id % 10 === 3 ? 2 : id % 10 } });
  }
  await db.invoices.update({ where: { id: 11 }, data: { note: "Updated 'quote' \\\\ slash 雪" } });
  result = { written: 6 };
  break;
 }
 case 'values':
 case 'nested-values': {
  const rows = process.argv[2] === 'values'
   ? await db.invoices.findMany({ orderBy: { id: 'asc' } })
   : (await db.customers.findMany({ select: { id: true }, orderBy: { id: 'asc' },
      with: { invoices: { orderBy: { id: 'asc' } } } })).flatMap(row => row.invoices);
  assert.equal(rows.length, 6);
  for (const row of rows) {
   const externalId: number | string | bigint = row.externalId;
   const amount: string = row.amount;
   const issued: Date = row.issuedAt;
   const note: string | null = row.note;
   assert.equal(externalId, '${huge}'); assert.equal(amount, '${decimal}');
   assert.ok(issued instanceof Date); assert.equal(issued.toISOString(), '${stamp}');
   assert.equal(note, row.id === 11 ? "Updated 'quote' \\\\ slash 雪" : null);
   assert.deepEqual(row.payload, row.id === 13 ? null : { flags: [true, null, '雪'], nested: { code: "O'Reilly\\\\east" } });
   assert.equal(row.doubled, row.score * 2);
  }
  result = rows;
  break;
 }
 case 'relations': {
  const rows = await db.customers.findMany({ orderBy: { id: 'asc' }, select: { id: true }, with: {
   profiles: { select: { id: true, label: true } },
   invoices: { select: { id: true }, orderBy: { score: 'desc', id: 'desc' }, limit: 2, offset: 1 }
  } });
  const one: { id: number; label: string } | null | undefined = rows[0]?.profiles;
  const many: { id: number }[] | undefined = rows[0]?.invoices;
  void one; void many;
  assert.deepEqual(rows, ${JSON.stringify(relations)});
  // Repeat the ordered per-parent window; neither a global LIMIT nor missing ORDER BY is acceptable.
  assert.deepEqual(await db.customers.findMany({ orderBy: { id: 'asc' }, select: { id: true }, with: {
   profiles: { select: { id: true, label: true } },
   invoices: { select: { id: true }, orderBy: { score: 'desc', id: 'desc' }, limit: 2, offset: 1 }
  } }), rows);
  result = rows; break;
 }
 case 'selection': {
  const rows = await db.customers.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } });
  assert.deepEqual(rows, [{id: 1, name: 'Ada'}, {id: 2, name: 'Lin'}]);
  for (const row of rows) assert.equal(Object.hasOwn(row, 'email'), false);
  result = rows; break;
 }
 case 'refusal': {
  await assert.rejects(db.invoices.update({ where: { id: 11 }, data: { doubled: 999 } } as never), /generated|writ|column|unknown/i);
  await assert.rejects(db.invoices.create({ data: { id: 90, customerId: 999, externalId: 1, amount: '1', payload: null, note: null, issuedAt: new Date('${stamp}'), score: 1 } }), /foreign|constraint|referenc/i);
  result = { refused: true }; break;
 }
 default: throw new Error('Unknown application case');
 }
 console.log(JSON.stringify(result, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value));
 } finally {
  writeFileSync('trace-' + process.argv[2] + '.json', JSON.stringify(trace, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value, 2));
  await db.disconnect();
 }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
`;
  if (engine === 'postgresql')
    source = source
      .replace(
        'turbine(url, { logger: {}, logQueryParams: true })',
        'turbine({ connectionString: url, logger: {}, logQueryParams: true })',
      )
      .replaceAll('   profiles: {', '   profile: {')
      .replace('?.profiles;', '?.profile;')
      .replaceAll('"profiles":', '"profile":');
  return source;
}
export function expectedRelations(engine) {
  return engine === 'postgresql' ? relations.map(({ profiles, ...row }) => ({ ...row, profile: profiles })) : relations;
}
export const invalid = [
  'db.invoices.update({ where: { id: 11 }, data: { doubled: 999 } });',
  "db.invoices.create({ data: { id: 90, customerId: 1, externalId: 1, amount: '1', issuedAt: new Date(), score: 1, doubled: 2 } });",
  'db.invoices.update({ where: { id: 11 }, data: { amount: { invalid: true } } });',
  'db.invoices.findMany({ where: { missingColumn: 1 } });',
  'db.customers.findMany({ with: { profiles: true } }).then(rows => rows[0]!.profiles!.map);',
  'db.customers.findMany({ with: { invoices: true } }).then(rows => rows[0]!.invoices.id);',
  'db.customers.findMany({ select: { name: true } }).then(rows => rows[0]!.email);',
];
export function negativeStatements(engine) {
  return engine === 'postgresql'
    ? invalid.map((line) =>
        line.replace('with: { profiles:', 'with: { profile:').replace('!.profiles!.map', '!.profile!.map'),
      )
    : invalid;
}
export function typeControls(engine) {
  return `import { turbine } from './generated/index.js';\nasync function invalidCalls() {\nconst db = await ${engine === 'postgresql' ? "turbine({connectionString: 'unused'})" : "turbine('unused')"};\n${negativeStatements(
    engine,
  )
    .map((line) => '// @ts-expect-error intentional invalid application\n' + line)
    .join('\n')}\n}\nvoid invalidCalls;\n`;
}
