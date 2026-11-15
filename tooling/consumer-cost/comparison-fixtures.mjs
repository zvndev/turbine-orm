import { syntheticSchema } from '../../scripts/measure-consumer-cost-fixtures.mjs';

export const comparisonPins = {
  tools: { typescript: '6.0.3', '@types/node': '22.20.4', '@types/pg': '8.23.1' },
  driver: { pg: '8.23.1' },
  arms: {
    turbine: {},
    'drizzle-stable': { 'drizzle-orm': '0.45.4' },
    'drizzle-rc': { 'drizzle-orm': '1.0.0-rc.5' },
    prisma: { '@prisma/client': '7.10.1', '@prisma/adapter-pg': '7.10.1' },
  },
};

export function comparisonSchema(arm, count, format = 'esm') {
  syntheticSchema(count); // Same validation and eight-column/ring contract as the original harness.
  if (arm === 'turbine') {
    const schema = syntheticSchema(count);
    // Turbine's documented default int8 reading is safe number, otherwise string.
    // This fixture must describe the actual supplied-pool runtime, not pg's raw parser.
    for (const table of Object.values(schema.tables))
      for (const column of table.columns) if (column.pgType === 'int8') column.tsType = 'number | string';
    return { 'schema.json': JSON.stringify(schema) };
  }
  if (arm === 'prisma') {
    return { 'schema.prisma': `generator client {
  provider = "prisma-client-js"
  output = "./generated"
  previewFeatures = ["relationJoins"]
}
datasource db {
  provider = "postgresql"
}
${Array.from({ length: count }, (_, i) => `model Records${i} {
  id BigInt @id
  parentId BigInt @map("parent_id")
  amount Decimal @db.Decimal(30, 10)
  label String
  rank Int
  active Boolean
  createdAt DateTime @map("created_at") @db.Timestamptz(3)
  note String?
  parent Records${(i + count - 1) % count} @relation("edge${i}", fields: [parentId], references: [id])
  children Records${(i + 1) % count}[] @relation("edge${(i + 1) % count}")
  @@map("records_${i}")
}`).join('\n')}
` };
  }
  const rc = arm === 'drizzle-rc';
  const ext = format === 'esm' ? 'ts' : 'cts';
  const tables = Array.from({ length: count }, (_, i) => `export const records_${i} = pgTable('records_${i}', {
  id: bigint('id', { mode: 'bigint' }).primaryKey(),
  parentId: bigint('parent_id', { mode: 'bigint' }).notNull(),
  amount: numeric('amount', { precision: 30, scale: 10 }).notNull(),
  label: text('label').notNull(), rank: integer('rank').notNull(),
  active: boolean('active').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, precision: 3, mode: 'date' }).notNull(),
  note: text('note'),
});`);
  const names = Array.from({ length: count }, (_, i) => `records_${i}`).join(', ');
  const relations = rc
    ? `export const graph = defineRelations({ ${names} }, r => ({\n${Array.from({ length: count }, (_, i) => `records_${i}: {
  parent: r.one.records_${(i + count - 1) % count}({ from: r.records_${i}.parentId, to: r.records_${(i + count - 1) % count}.id, alias: 'edge${i}' }),
  children: r.many.records_${(i + 1) % count}({ alias: 'edge${(i + 1) % count}' }),
},`).join('\n')}\n}));`
    : Array.from({ length: count }, (_, i) => `export const relation${i} = relations(records_${i}, ({ one, many }) => ({
  parent: one(records_${(i + count - 1) % count}, { fields: [records_${i}.parentId], references: [records_${(i + count - 1) % count}.id], relationName: 'edge${i}' }),
  children: many(records_${(i + 1) % count}, { relationName: 'edge${(i + 1) % count}' }),
}));`).join('\n');
  return { [`schema.${ext}`]: `import { pgTable, bigint, numeric, text, integer, boolean, timestamp } from 'drizzle-orm/pg-core';
import { ${rc ? 'defineRelations' : 'relations'} } from 'drizzle-orm/relations';
${tables.join('\n')}
${relations}
` };
}

export function comparisonEntry(arm, format = 'esm') {
  const cjs = format === 'cjs';
  const schema = cjs ? './schema.cjs' : './schema.js';
  const entry = cjs ? './entry.cjs' : './entry.js';
  if (arm === 'turbine') return `${cjs ? "import pg = require('pg');" : "import pg from 'pg';"}
import { turbine } from './generated/index.js';
export function initialize(url?: string) {
  const pool = new pg.Pool(url ? { connectionString: url } : { host: '127.0.0.1', port: 1 });
  const db = turbine({ pool });
  return { db, close: async () => { await db.disconnect(); await pool.end(); } };
}
`;
  if (arm === 'prisma') return `${cjs ? "import pg = require('pg');" : "import pg from 'pg';"}
import { PrismaClient } from './generated/index.js';
import { PrismaPg } from '@prisma/adapter-pg';
export function initialize(url?: string) {
  const pool = new pg.Pool(url ? { connectionString: url } : { host: '127.0.0.1', port: 1 });
  const db = new PrismaClient({ adapter: new PrismaPg(pool) });
  return { db, close: async () => { await db.$disconnect(); await pool.end(); } };
}
`;
  return `${cjs ? "import pg = require('pg');" : "import pg from 'pg';"}
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '${schema}';
export function initialize(url?: string) {
  const pool = new pg.Pool(url ? { connectionString: url } : { host: '127.0.0.1', port: 1 });
  const db = ${arm === 'drizzle-rc' ? 'drizzle({ client: pool, relations: schema.graph })' : 'drizzle(pool, { schema })'};
  return { db, close: async () => { await pool.end(); } };
}
void '${entry}';
`;
}

function queries(arm, i) {
  const full = arm === 'turbine'
    ? `db.records_${i}.findMany({ orderBy: { id: 'asc' }, limit: 2, with: {
      parent: { select: { id: true, label: true } },
      children: { select: { id: true, amount: true }, orderBy: { id: 'asc' }, with: { parent: { select: { id: true, label: true } } } },
    } })`
    : arm === 'prisma'
      ? `db.records${i}.findMany({ orderBy: { id: 'asc' }, take: 2, include: {
      parent: { select: { id: true, label: true } },
      children: { orderBy: { id: 'asc' }, select: { id: true, amount: true, parent: { select: { id: true, label: true } } } },
    } })`
      : `db.query.records_${i}.findMany({ orderBy: ${arm === 'drizzle-rc' ? "{ id: 'asc' }" : '(t, { asc }) => [asc(t.id)]'}, limit: 2, with: {
      parent: { columns: { id: true, label: true } },
      children: { columns: { id: true, amount: true }, orderBy: ${arm === 'drizzle-rc' ? "{ id: 'asc' }" : '(t, { asc }) => [asc(t.id)]'}, with: { parent: { columns: { id: true, label: true } } } },
    } })`;
  const selected = arm === 'turbine'
    ? `db.records_${i}.findMany({ select: { id: true, amount: true }, orderBy: { id: 'asc' }, limit: 2 })`
    : arm === 'prisma'
      ? `db.records${i}.findMany({ select: { id: true, amount: true }, orderBy: { id: 'asc' }, take: 2 })`
      : `db.query.records_${i}.findMany({ columns: { id: true, amount: true }, orderBy: ${arm === 'drizzle-rc' ? "{ id: 'asc' }" : '(t, { asc }) => [asc(t.id)]'}, limit: 2 })`;
  const dynamic = arm === 'turbine'
    ? `db.records_${i}.findMany({ where: { rank: { gte: minimum }, active: enabled }, orderBy: { id: 'asc' } })`
    : arm === 'prisma'
      ? `db.records${i}.findMany({ where: { rank: { gte: minimum }, active: enabled }, orderBy: { id: 'asc' } })`
      : `db.query.records_${i}.findMany({ where: ${arm === 'drizzle-rc' ? '{ rank: { gte: minimum }, active: enabled }' : '(t, { and, gte, eq }) => and(gte(t.rank, minimum), eq(t.active, enabled))'}, orderBy: ${arm === 'drizzle-rc' ? "{ id: 'asc' }" : '(t, { asc }) => [asc(t.id)]'} })`;
  return { full, selected, dynamic };
}

export function comparisonWorkload(arm, count, format = 'esm') {
  const idType = arm === 'turbine' ? 'number | string' : 'bigint';
  const numericType = arm === 'prisma' ? 'Prisma.Decimal' : 'string';
  const lines = [
    `import { initialize } from './entry.${format === 'esm' ? 'js' : 'cjs'}';`,
    ...(arm === 'prisma' ? ["import type { Prisma } from './generated/index.js';"] : []),
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    'function exact<T extends true>() {}',
    'type DB = ReturnType<typeof initialize>["db"];',
  ];
  for (let i = 0; i < count; i++) {
    const q = queries(arm, i);
    lines.push(`export async function query${i}(db: DB, minimum: number, enabled: boolean) {
  const full = await ${q.full};
  const selected = await ${q.selected};
  const dynamic = await ${q.dynamic};
  return { full, selected, dynamic };
}
async function types${i}(db: DB) {
  const { full, selected, dynamic } = await query${i}(db, 1, true);
  const row = full[0]!;
  exact<Equal<typeof row.id, ${idType}>>();
  exact<Equal<typeof row.amount, ${numericType}>>();
  exact<Equal<typeof row.rank, number>>();
  exact<Equal<typeof row.active, boolean>>();
  exact<Equal<typeof row.createdAt, Date>>();
  exact<Equal<typeof row.note, string | null>>();
  exact<Equal<NonNullable<typeof row.parent>['id'], ${idType}>>();
  exact<Equal<typeof row.children[number]['amount'], ${numericType}>>();
  exact<Equal<NonNullable<typeof row.children[number]['parent']>['label'], string>>();
  exact<Equal<typeof selected[number]['id'], ${idType}>>();
  exact<Equal<typeof dynamic[number]['rank'], number>>();
  // @ts-expect-error selected projection must not expose label
  selected[0]!.label;
  // @ts-expect-error exact numeric values cannot be assigned to number
  const lossy: number = row.amount;
  // @ts-expect-error nonexistent relations must be refused
  await ${arm === 'turbine' ? `db.records_${i}.findMany({ with: { missingRelation: true } })` : arm === 'prisma' ? `db.records${i}.findMany({ include: { missingRelation: true } })` : `db.query.records_${i}.findMany({ with: { missingRelation: true } })`};
  // @ts-expect-error actual ORM scalar predicate has the wrong input type
  await ${arm === 'turbine' ? `db.records_${i}.findMany({ where: { rank: { gte: 'wrong' } } })` : arm === 'prisma' ? `db.records${i}.findMany({ where: { rank: { gte: 'wrong' } } })` : arm === 'drizzle-rc' ? `db.query.records_${i}.findMany({ where: { rank: { gte: 'wrong' } } })` : `db.query.records_${i}.findMany({ where: (t, { gte }) => gte(t.rank, 'wrong') })`};
}
void types${i};`);
  }
  return `${lines.join('\n')}\n`;
}

// An independent fixed oracle covers every returned field/row/order. Native type assertions
// run before normalization. bigint/Decimal are API differences, never number conversions.
export const comparisonOracle = `import assert from 'node:assert/strict';
export function normalize(value, Decimal) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value && typeof value === 'object' && Decimal?.isDecimal(value)) {
    const rendered = value.toFixed(10);
    assert.equal(value.equals(rendered), true, 'Decimal normalization must preserve exact precision');
    return rendered;
  }
  if (Array.isArray(value)) return value.map(v => normalize(v, Decimal));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, Decimal)]));
  return value;
}
const id = i => (9007199254740993n + BigInt(i)).toString();
const selected = i => ({ id: id(i), amount: '123456789.0123456789' });
const parent = { id: id(0), label: 'row0' };
const base = i => ({ id: id(i), parentId: id(0), amount: '123456789.0123456789', label: 'row' + i,
  rank: i, active: i < 2, createdAt: '2024-01-02T03:04:05.006Z', note: i === 0 ? null : 'note' + i });
export const expected = {
  full: [0, 1].map(i => ({ ...base(i), parent, children: i === 0 ? [0, 1, 2].map(j => ({ ...selected(j), parent })) : [] })),
  selected: [0, 1].map(selected), dynamic: [base(1)],
};
const safeText = JSON.stringify(expected).replaceAll('9007199254740993', '1').replaceAll('9007199254740994', '2').replaceAll('9007199254740995', '3').replaceAll('123456789.0123456789', '123.1234567891');
export const safeExpected = JSON.parse(safeText);
export function expectedFor(arm, domain) {
  if (domain !== 'safe') return expected;
  if (arm !== 'turbine') return safeExpected;
  // Default Turbine pg int8 scalars use safe numbers; metadata-decoded relations
  // preserve text for this string-capable column contract. Keep both facts visible.
  const result = structuredClone(safeExpected);
  for (const row of [...result.full, ...result.dynamic]) { row.id = Number(row.id); row.parentId = Number(row.parentId); }
  for (const row of result.selected) row.id = Number(row.id);
  return result;
}
export function verify(result, arm, domain = 'precision', Decimal) {
  assert.equal(result.full.length, 2, 'complete nonempty outer result');
  for (const row of [...result.full, ...result.dynamic]) {
    assert.equal(typeof row.id, arm === 'turbine' ? (domain === 'safe' ? 'number' : 'string') : 'bigint');
    assert.equal(typeof row.parentId, arm === 'turbine' ? (domain === 'safe' ? 'number' : 'string') : 'bigint');
    assert.equal(row.createdAt instanceof Date, true);
    assert.equal(typeof row.rank, 'number'); assert.equal(typeof row.active, 'boolean');
    if (arm === 'prisma') assert.equal(Decimal.isDecimal(row.amount), true, 'actual generated Prisma Decimal');
    else assert.equal(typeof row.amount, 'string');
  }
  for (const row of result.selected) {
    assert.equal(typeof row.id, arm === 'turbine' ? (domain === 'safe' ? 'number' : 'string') : 'bigint');
    if (arm === 'prisma') assert.equal(Decimal.isDecimal(row.amount), true, 'actual generated Prisma Decimal');
    else assert.equal(typeof row.amount, 'string');
  }
  for (const row of result.full) {
    assert.equal(typeof row.parent.id, arm === 'turbine' ? 'string' : 'bigint');
    for (const child of row.children) {
      assert.equal(typeof child.id, arm === 'turbine' ? 'string' : 'bigint');
      assert.equal(typeof child.parent.id, arm === 'turbine' ? 'string' : 'bigint');
      if (arm === 'prisma') assert.equal(Decimal.isDecimal(child.amount), true);
      else assert.equal(typeof child.amount, 'string');
    }
  }
  assert.deepEqual(normalize(result, Decimal), expectedFor(arm, domain), 'all rows, fields, types and ordering');
}
`;

export function comparisonProbe(format) {
  return `import { writeFileSync } from 'node:fs';
const start = performance.now();
const entry = await import('./out/entry.${format === 'esm' ? 'js' : 'cjs'}');
const imported = performance.now();
const warmStart = performance.now();
const again = await import('./out/entry.${format === 'esm' ? 'js' : 'cjs'}');
const warmImportMs = performance.now() - warmStart;
if (again.initialize !== entry.initialize) throw new Error('MODULE_CACHE_IDENTITY');
const coldStart = performance.now(); const first = entry.initialize(); const initMs = performance.now() - coldStart;
await first.close();
const warmInitStart = performance.now(); const second = entry.initialize(); const warmInitMs = performance.now() - warmInitStart;
await second.close();
writeFileSync(process.argv[2], JSON.stringify({ importMs: imported - start, warmImportMs, initMs, warmInitMs,
  peakRssBytes: process.resourceUsage().maxRSS * 1024, cpu: process.cpuUsage(),
  scope: 'Fresh process and same-process cached import; unconnected client/pool construction, no database handshake; cleanup outside initialization' }));
`;
}

/** Small valid installed consumer, independent of the ring workload and its schema. */
export function minimalDrizzleSource(arm, format, withRelations = false) {
  const rc = arm === 'drizzle-rc';
  return `${format === 'esm' ? "import pg from 'pg';" : "import pg = require('pg');"}
import { drizzle } from 'drizzle-orm/node-postgres';
${withRelations ? `import { ${rc ? 'defineRelations' : 'relations'} } from 'drizzle-orm/relations';
import { pgTable } from 'drizzle-orm/pg-core/table';
import { integer } from 'drizzle-orm/pg-core/columns/integer';
const users = pgTable('users', { id: integer('id').primaryKey() });
const schema = { users };
${rc ? 'const graph = defineRelations(schema);' : 'const userRelations = relations(users, () => ({}));'}` : ''}
const pool = new pg.Pool();
const db = ${rc ? `drizzle({ client: pool${withRelations ? ', relations: graph' : ''} })` : `drizzle(pool${withRelations ? ', { schema: { ...schema, userRelations } }' : ''})`};
void db; void pool.end();
`;
}
