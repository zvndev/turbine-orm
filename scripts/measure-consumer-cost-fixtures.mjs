// These sources are copied into isolated consumers; all package imports use public exports.
export function profileSource(name) {
  if (Object.hasOwn(integratedRuntime, name)) return integratedRuntime[name];
  const schema = 'const schema = { tables: {}, enums: {} };\n';
  switch (name) {
    case 'postgres':
      return `import pg from 'pg';
import { TurbineClient } from 'turbine-orm';
${schema}
export async function initialize() {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1 });
  const db = new TurbineClient({ pool }, schema);
  return async () => { await db.disconnect(); await pool.end(); };
}
`;
    case 'serverless':
      return `import pg from 'pg';
import { turbineHttp } from 'turbine-orm/serverless';
${schema}
export async function initialize() {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1 });
  const db = turbineHttp(pool, schema);
  return async () => { await db.disconnect(); await pool.end(); };
}
`;
    case 'mysql':
      return `import mysql from 'mysql2/promise';
export { turbineMysql } from 'turbine-orm/mysql';
export const driver = mysql;
`;
    case 'sqlite':
      return `import { turbineSqlite } from 'turbine-orm/sqlite';
${schema}
export async function initialize() {
  const db = turbineSqlite(':memory:', schema);
  return async () => { await db.disconnect(); };
}
`;
    case 'sql':
      return "export { sql, identifier, join, compile } from 'turbine-orm/sql';\n";
    case 'mysql-seed':
      return "export { defineMysqlSeed, runMysqlSeed } from 'turbine-orm/mysql/seed';\n";
    case 'mssql-seed':
      return "export { defineMssqlSeed, runMssqlSeed } from 'turbine-orm/mssql/seed';\n";
    case 'cli':
      return "import * as config from 'turbine-orm/cli';\nexport const publicExports = Object.keys(config);\n";
    default:
      throw new Error(`Unknown consumer profile: ${name}`);
  }
}

// Ring topology: each table has one required parent and a to-many children relation.
// PG int8/numeric retain their public string types; no lossy number substitution.
export function syntheticSchema(count) {
  if (!Number.isSafeInteger(count) || count < 2) throw new Error('Schema size must be an integer >= 2');
  const tables = {};
  for (let i = 0; i < count; i++) {
    const name = `records_${i}`;
    const parent = `records_${(i + count - 1) % count}`;
    const child = `records_${(i + 1) % count}`;
    const columns = [
      ['id', 'id', 'int8', 'string', false],
      ['parent_id', 'parentId', 'int8', 'string', false],
      ['amount', 'amount', 'numeric', 'string', false],
      ['label', 'label', 'text', 'string', false],
      ['rank', 'rank', 'int4', 'number', false],
      ['active', 'active', 'bool', 'boolean', false],
      ['created_at', 'createdAt', 'timestamptz', 'Date', false],
      ['note', 'note', 'text', 'string', true],
    ].map(([name, field, pgType, tsType, nullable]) => ({
      name,
      field,
      pgType,
      tsType: nullable ? `${tsType} | null` : tsType,
      nullable,
      hasDefault: false,
      isArray: false,
      pgArrayType: `${pgType}[]`,
    }));
    tables[name] = {
      name,
      columns,
      columnMap: Object.fromEntries(columns.map((c) => [c.field, c.name])),
      reverseColumnMap: Object.fromEntries(columns.map((c) => [c.name, c.field])),
      pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
      dateColumns: new Set(['created_at']),
      allColumns: columns.map((c) => c.name),
      primaryKey: ['id'],
      uniqueColumns: [],
      indexes: [],
      relations: {
        parent: {
          name: 'parent',
          type: 'belongsTo',
          from: name,
          to: parent,
          foreignKey: 'parent_id',
          referenceKey: 'id',
        },
        children: {
          name: 'children',
          type: 'hasMany',
          from: name,
          to: child,
          foreignKey: 'parent_id',
          referenceKey: 'id',
        },
      },
    };
  }
  return { tables, enums: {} };
}

export function consumerTypeSource(count) {
  const lines = [
    "import { turbine } from './generated/index.js';",
    'const db = turbine();',
    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    'function exact<T extends true>() {}',
    'async function consumer() {',
  ];
  for (let i = 0; i < count; i++) {
    lines.push(`{
  const rows = await db.records_${i}.findMany({
    where: { id: '9007199254740993', amount: { gt: '123456789.0123456789' }, rank: { gte: 1 } },
    with: { parent: true, children: { with: { parent: true } } },
    limit: 1,
  });
  const row = rows[0]!;
  exact<Equal<typeof row.id, string>>();
  exact<Equal<typeof row.amount, string>>();
  exact<Equal<typeof row.rank, number>>();
  exact<Equal<typeof row.createdAt, Date>>();
  exact<Equal<typeof row.note, string | null>>();
  exact<Equal<NonNullable<typeof row.parent>['id'], string>>();
  exact<Equal<typeof row.children[number]['amount'], string>>();
  exact<Equal<NonNullable<typeof row.children[number]['parent']>['id'], string>>();
  // @ts-expect-error exact numeric values are returned as strings
  const lossy: number = row.amount;
  // @ts-expect-error relations must exist on the generated client
  await db.records_${i}.findMany({ with: { nonexistentRelation: true } });
}`);
  }
  lines.push('}', 'void consumer;');
  return `${lines.join('\n')}\n`;
}

export const runtimeProbe = `import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
const start = performance.now();
const entry = await import('./entry.mjs');
const imported = performance.now();
const cleanup = entry.initialize ? await entry.initialize() : undefined;
const initialized = performance.now();
if (cleanup) await cleanup();
writeFileSync(process.argv[2], JSON.stringify({
  importMs: imported - start,
  initMs: entry.initialize ? initialized - imported : null,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
}));
`;

export const processMonitor = `import { writeFileSync } from 'node:fs';
const start = process.hrtime.bigint();
process.on('exit', () => writeFileSync(process.env.CONSUMER_COST_RESOURCE_FILE, JSON.stringify({
  processMs: Number(process.hrtime.bigint() - start) / 1e6,
  peakRssBytes: process.resourceUsage().maxRSS * 1024,
  cpuUserMicros: process.resourceUsage().userCPUTime,
  cpuSystemMicros: process.resourceUsage().systemCPUTime,
})));
`;

// Separate correctness processes: no assertion/helper work enters runtime timings.
export function profileBehaviorSource(name) {
  if (Object.hasOwn(integratedBehavior, name)) return integratedBehaviorSource(name);
  const header = "import assert from 'node:assert/strict';\nimport * as entry from './entry.mjs';\n";
  if (name === 'sql')
    return (
      header +
      `
const { sql, identifier, join, compile } = entry;
const dialect = {
  paramPlaceholder: (i) => '$' + i,
  quoteIdentifier: (name) => '"' + name.replaceAll('"', '""') + '"',
};
const unsafe = "value'); DROP TABLE users; --";
const fragment = sql\`SELECT * FROM \${identifier('app', 'odd"name')} WHERE id IN (\${join([unsafe, 2])})\`;
assert.deepEqual(compile(fragment, dialect), {
  sql: 'SELECT * FROM "app"."odd""name" WHERE id IN ($1, $2)', params: [unsafe, 2],
});
assert.throws(() => compile({}, dialect), TypeError);
assert.throws(() => identifier(''), TypeError);
assert.throws(() => join([1], {}), TypeError);
assert.deepEqual(compile(sql\`SELECT \${unsafe}\`, dialect).params, [unsafe]);
console.log('sql composition and refusal controls passed; no execution');
`
    );
  if (name === 'mysql-seed' || name === 'mssql-seed') {
    const engine = name === 'mysql-seed' ? 'Mysql' : 'Mssql';
    return (
      header +
      `
const { define${engine}Seed: define, run${engine}Seed: run } = entry;
assert.equal(typeof run, 'function');
let calls = 0;
const callback = async () => { calls++; };
assert.equal(define(callback), callback);
assert.equal(calls, 0, 'declaration must never execute the callback');
for (const bad of [null, {}, 'callback', 42]) {
  assert.throws(() => define(bad), (error) => error?.code === 'TURBINE_E003');
}
console.log('seed declaration identity/laziness/refusal controls passed; no native execution');
`
    );
  }
  return null;
}

// Integrated entries retain the complete selected driver imports. Their installed
// production closure (including mandatory pg) is a separate fact from this graph.
const emptySchema = 'const schema = { tables: {}, enums: {} };';
const integratedRuntime = {
  core: `import pg from 'pg';
export { turbineCore } from 'turbine-orm/core';
import { turbineCore } from 'turbine-orm/core';
${emptySchema}
export async function initialize() {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1 });
  try {
    const db = turbineCore(pool, schema, { ownership: 'client' });
    return () => db.disconnect();
  } catch (error) { await pool.end(); throw error; }
}
`,
  'neon-ws': `export { turbineNeonWs, withNeonWs } from 'turbine-orm/neon-ws';
export { Pool as driver } from '@neondatabase/serverless';
export { default as webSocketConstructor } from 'ws';
`,
  'neon-http': `export { turbineNeonHttp, NEON_HTTP_CAPABILITIES } from 'turbine-orm/neon-http';
export { neon as driver } from '@neondatabase/serverless';
`,
  'notification-hub': `import pg from 'pg';
export { createNotificationHub } from 'turbine-orm/notification-hub';
import { createNotificationHub } from 'turbine-orm/notification-hub';
export async function initialize() {
  const pool = new pg.Pool({ host: '127.0.0.1', port: 1 });
  try {
    const hub = createNotificationHub(pool, { endpoint: 'direct', ownership: 'owned' });
    return () => hub.close();
  } catch (error) { await pool.end(); throw error; }
}
`,
  'live-query': "export { liveQuery } from 'turbine-orm/live-query';\n",
  d1: "export { turbineD1, d1Dialect } from 'turbine-orm/d1';\n",
  libsql: `export { turbineLibsql } from 'turbine-orm/libsql';
import { turbineLibsql } from 'turbine-orm/libsql';
export { createClient as driver } from '@libsql/client/node';
import { createClient } from '@libsql/client/node';
${emptySchema}
export async function initialize() {
  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  try {
    const db = await turbineLibsql({ client: native, url: ':memory:' }, schema);
    return async () => {
      try { await db.disconnect(); } finally { native.close(); }
      if (!native.closed) throw new Error('Native libSQL memory client was not closed');
    };
  } catch (error) { native.close(); throw error; }
}
`,
};

function integratedBehaviorSource(name) {
  return `import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as entry from './entry.mjs';
const require = createRequire(import.meta.url);
${emptySchema}
for (const [format, api] of [['esm', entry], ['cjs', require('turbine-orm/${name}')]]) {
${integratedBehavior[name]}
  console.log(format + ': ${name} public behavior passed');
}
`;
}

const integratedBehavior = {
  core: `
  assert.throws(() => api.turbineCore({}, schema), /supplied pool/);
  const { default: pg } = await import('pg');
  for (const ownership of ['caller', 'client']) {
    const pool = new pg.Pool({ host: '127.0.0.1', port: 1 });
    try {
      const db = api.turbineCore(pool, schema, { ownership });
      assert.throws(() => db.$transaction(async () => {}), /[Tt]ransaction/);
      await db.disconnect();
      await db.disconnect();
      assert.equal(pool.ended, ownership === 'client', 'disconnect must respect pool ownership');
    } finally { if (!pool.ended) await pool.end(); }
  }
`,
  'neon-ws': `
  assert.equal(typeof api.withNeonWs, 'function');
  assert.equal(typeof entry.driver, 'function');
  assert.equal(typeof entry.webSocketConstructor, 'function');
  // Refusal happens before driver construction; no endpoint or session is invented.
  await assert.rejects(api.turbineNeonWs({}, schema, {}), /sessionMode and lifetime/);
  await assert.rejects(api.turbineNeonWs({}, schema, {
    sessionMode: 'transaction', lifetime: 'invocation', preparedStatements: true,
  }), /preparedStatements/);
`,
  'neon-http': `
  assert.equal(typeof entry.driver, 'function');
  assert.equal(api.NEON_HTTP_CAPABILITIES.transport, 'neon-http');
  assert.throws(() => api.turbineNeonHttp({}, schema), /query function returned by neon/);
  assert.throws(() => api.turbineNeonHttp(() => {}, schema), /query function returned by neon/);
`,
  'notification-hub': `
  const { default: pg } = await import('pg');
  for (const ownership of ['external', 'owned']) {
    const pool = new pg.Pool({ host: '127.0.0.1', port: 1 });
    try {
      assert.throws(() => api.createNotificationHub(pool, { endpoint: 'transaction-pool' }), /session-pool endpoint/);
      const hub = api.createNotificationHub(pool, { endpoint: 'direct', ownership });
      assert.deepEqual(hub.stats, { channels: 0, subscriptions: 0, connected: false, reconnecting: false, closed: false });
      await hub.close();
      await hub.close();
      assert.equal(hub.stats.closed, true);
      assert.equal(pool.ended, ownership === 'owned', 'hub must respect pool ownership');
      assert.equal(pool.totalCount, 0, 'unsubscribed hub must never check out a client');
    } finally { if (!pool.ended) await pool.end(); }
  }
`,
  'live-query': `
  let unsubscribed = 0;
  let invalidate;
  let version = 1;
  const order = [];
  const live = api.liveQuery({
    query(signal) { assert.equal(signal.aborted, false); order.push('query'); return { id: version }; },
    subscribe(callback) { order.push('subscribe'); invalidate = callback; return { unsubscribe() { unsubscribed++; } }; },
  });
  try {
    await live.ready;
    assert.deepEqual(await live.next(), { done: false, value: { id: 1 } });
    assert.deepEqual(order.slice(0, 2), ['subscribe', 'query']);
    version = 2;
    invalidate();
    assert.deepEqual(await live.next(), { done: false, value: { id: 2 } });
  } finally { await live.dispose(); }
  await live.dispose();
  await live.closed;
  assert.equal(unsubscribed, 1);
  assert.equal((await live.next()).done, true);
  const failure = new Error('subscription refusal control');
  const refused = api.liveQuery({ query() { assert.fail('query before subscription'); }, subscribe() { throw failure; } });
  await assert.rejects(refused.ready, (error) => error === failure);
  await assert.rejects(refused.closed, (error) => error === failure);
`,
  d1: `
  // Invalid binding admission only. No object masquerades as a working D1 binding.
  for (const invalid of [null, {}, { prepare: 1 }, { batch: 1 }]) {
    assert.throws(() => api.turbineD1(invalid, schema), /supplied Worker D1Database binding/);
  }
  assert.equal(api.d1Dialect.name, 'd1');
  assert.equal(api.d1Dialect.capabilities.maxBindParameters, 100);
  assert.throws(() => api.d1Dialect.beginStatement(), /[Tt]ransaction/);
`,
  libsql: `
  for (const target of ['https://example.invalid', 'libsql://example.invalid', 'file:local.db?sync=1']) {
    await assert.rejects(api.turbineLibsql(target, schema), /[Ll]ocal|[Rr]emote/);
  }
  // Real local native client. The facade must leave a supplied client caller-owned.
  const { createClient } = format === 'esm' ? await import('@libsql/client/node') : require('@libsql/client/node');
  const native = createClient({ url: ':memory:', intMode: 'bigint' });
  try {
    const db = await api.turbineLibsql({ client: native, url: ':memory:' }, schema);
    await db.disconnect();
    await db.disconnect();
    assert.equal(native.closed, false);
  } finally { native.close(); }
  assert.equal(native.closed, true, 'native memory client must be closed');
  // Exercise the profile's owned-memory initialization and idempotent cleanup too.
  const owned = await api.turbineLibsql(':memory:', schema);
  await owned.disconnect();
  await owned.disconnect();
  await assert.rejects(owned.rawUnsafe('SELECT 1'), /closed|disconnected|ended/i);
`,
};

// One compiler invocation resolves BOTH conditional declaration graphs. Import
// assignment selects require even in the ESM consumer; each branch runs the same
// positive and negative type contract independently, without executing this file.
function integratedTypeSource(name) {
  return `import * as esm from 'turbine-orm/${name}';
import cjs = require('turbine-orm/${name}');
${['esm', 'cjs'].map((format) => `function check_${format}() {\n${integratedTypes[name].replaceAll('PUBLIC', format)}\n}\nvoid check_${format};`).join('\n')}
`;
}

const integratedTypes = {
  core: `
  const pool = null! as PUBLIC.PgCompatPool;
  const schema = { tables: {}, enums: {} };
  const db: PUBLIC.CoreClient = PUBLIC.turbineCore(pool, schema, { ownership: 'client' });
  db.table<{ id: number; amount: string }>('records').findMany({ select: { id: true } }).then((rows) => {
    const id: number = rows[0]!.id;
    // @ts-expect-error projection excludes amount
    rows[0]!.amount;
    void id;
  });
  // @ts-expect-error core ownership is caller or client
  PUBLIC.turbineCore(pool, schema, { ownership: 'owned' });
`,
  'neon-ws': `
  const source = null! as PUBLIC.NeonWsSource;
  const schema = { tables: {}, enums: {} };
  const options: PUBLIC.NeonWsOptions = { sessionMode: 'persistent', lifetime: 'persistent' };
  void PUBLIC.turbineNeonWs(source, schema, options);
  // @ts-expect-error explicit lifetime and session mode are required
  void PUBLIC.turbineNeonWs(source, schema, {});
  // @ts-expect-error HTTP is not a WebSocket session assertion
  void PUBLIC.turbineNeonWs(source, schema, { sessionMode: 'http', lifetime: 'persistent' });
  // @ts-expect-error source must select a transport
  const invalid: PUBLIC.NeonWsSource = {};
  void invalid;
`,
  'neon-http': `
  const sql = null! as PUBLIC.NeonHttpSql;
  const schema = { tables: {}, enums: {} };
  const db: PUBLIC.TurbineNeonHttp = PUBLIC.turbineNeonHttp(sql, schema);
  const rows: Promise<{ id: number }[]> = db.rawUnsafe<{ id: number }>('SELECT id FROM records');
  // @ts-expect-error HTTP accepts issued batches, not interactive callbacks
  void db.$transaction(async () => {});
  // @ts-expect-error a structural query/transaction source is required
  PUBLIC.turbineNeonHttp({}, schema);
  void rows;
`,
  'notification-hub': `
  const pool = null! as Parameters<typeof PUBLIC.createNotificationHub>[0];
  const hub: PUBLIC.NotificationHub = PUBLIC.createNotificationHub(pool, { endpoint: 'direct', ownership: 'owned' });
  void hub.subscribe('records', (payload) => { const text: string = payload; void text; }, {
    onResync(reason) { const value: 'overflow' | 'reconnect' = reason; void value; },
  });
  // @ts-expect-error transaction pooling cannot LISTEN
  PUBLIC.createNotificationHub(pool, { endpoint: 'transaction-pool' });
  // @ts-expect-error stats are readonly
  hub.stats.closed = false;
`,
  'live-query': `
  const live: PUBLIC.LiveQuery<{ id: number }> = PUBLIC.liveQuery({
    query: async (signal) => { const aborted: boolean = signal.aborted; void aborted; return { id: 1 }; },
    subscribe: () => ({ unsubscribe() {} }),
  });
  // @ts-expect-error snapshot value retains number
  const bad: PUBLIC.LiveQuery<{ id: string }> = live;
  // @ts-expect-error subscription must return an owned unsubscribe handle
  PUBLIC.liveQuery({ query: () => 1, subscribe: () => ({}) });
  void [live.ready, live.closed, live.dispose(), bad];
`,
  d1: `
  const binding = null! as PUBLIC.D1DatabaseBinding;
  const db = PUBLIC.turbineD1(binding, { tables: {}, enums: {} });
  const result: Promise<{ id: number }[]> = db.rawUnsafe<{ id: number }>('SELECT id FROM records');
  void db.$batch([db.table<{ id: number }>('records').buildCount()]);
  // @ts-expect-error no Worker binding can be omitted
  PUBLIC.turbineD1({}, { tables: {}, enums: {} });
  // @ts-expect-error D1 batches require issued deferred queries, not callbacks
  void db.$batch(async () => {});
  // @ts-expect-error D1 never owns the Worker binding
  PUBLIC.turbineD1(binding, { tables: {}, enums: {} }, { ownership: 'client' });
  void result;
`,
  libsql: `
  const schema = { tables: {}, enums: {} };
  const source = null! as PUBLIC.LibsqlLocalSource;
  const local = PUBLIC.turbineLibsql(':memory:', schema);
  void PUBLIC.turbineLibsql(source, schema);
  local.then((db) => {
    const rows: Promise<{ amount: string }[]> = db.rawUnsafe<{ amount: string }>('SELECT amount FROM records');
    // @ts-expect-error supplied row type retains exact string values
    const lossy: Promise<{ amount: number }[]> = rows;
    void lossy;
  });
  // @ts-expect-error native libSQL construction is asynchronous
  local.disconnect();
  // @ts-expect-error remote replica options are outside the public local factory
  PUBLIC.turbineLibsql(':memory:', schema, { syncUrl: 'https://example.invalid' });
`,
};

export function profileTypeSource(name) {
  if (Object.hasOwn(integratedTypes, name)) return integratedTypeSource(name);
  if (name === 'sql')
    return `import { sql, identifier, join, compile, type CompiledSql } from 'turbine-orm/sql';
const result: CompiledSql = compile(sql\`SELECT \${identifier('id')} WHERE id IN (\${join([1, 2])})\`, {
  paramPlaceholder: (i) => '$' + i,
  quoteIdentifier: (name) => '"' + name + '"',
});
const text: string = result.sql;
const params: unknown[] = result.params;
// @ts-expect-error opaque fragments cannot be manufactured
compile({}, { paramPlaceholder: String, quoteIdentifier: String });
// @ts-expect-error identifiers require strings
identifier(1);
void [text, params];
`;
  if (name === 'mysql-seed' || name === 'mssql-seed') {
    const engine = name === 'mysql-seed' ? 'Mysql' : 'Mssql';
    return `import { define${engine}Seed, run${engine}Seed, type ${engine}SeedFunction } from 'turbine-orm/${name.replace('-seed', '/seed')}';
const seed: ${engine}SeedFunction = define${engine}Seed(async (tx) => {
  const rows = await tx.table<{ id: string; amount: string }>('records').findMany({ where: { id: '1' } });
  const amount: string = rows[0]!.amount;
  // @ts-expect-error exact numeric reads remain strings
  const lossy: number = rows[0]!.amount;
  // @ts-expect-error raw SQL is not exposed on the restricted handle
  tx.rawUnsafe('DROP TABLE records');
  // @ts-expect-error connection ownership is not exposed
  tx.pool;
  // @ts-expect-error deferred builders are not exposed on seed tables
  tx.table('records').buildFindMany();
  await tx.$transaction(async (inner) => { await inner.table('records').count(); });
  void [amount, lossy];
});
// @ts-expect-error a seed must be callable
define${engine}Seed({});
void [seed, run${engine}Seed];
`;
  }
  return null;
}
