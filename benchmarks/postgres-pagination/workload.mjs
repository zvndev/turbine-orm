import assert from 'node:assert/strict';
import pg from 'pg';
import { TurbineClient } from '../../src/client.ts';
import { defineSchema } from '../../src/schema-builder.ts';
import { schemaDefToMetadata } from '../../src/schema-metadata.ts';
import { args, cursor, digest, expected, lookupArgs, verifyRows } from './corpus.mjs';

const columns = { id: { type: 'integer', primaryKey: true }, score: { type: 'integer', nullable: true },
  bucket: { type: 'integer', notNull: true }, label: { type: 'text', notNull: true } };
export const metadata = schemaDefToMetadata(defineSchema({
  items: columns, tiny: columns,
  parents: { id: { type: 'integer', primaryKey: true } },
  children: { id: { type: 'integer', primaryKey: true }, parent: { type: 'integer', notNull: true }, label: { type: 'text', notNull: true } },
}));
metadata.tables.parents.relations.children = { type: 'hasMany', name: 'children', from: 'parents', to: 'children', foreignKey: 'parent', referenceKey: 'id' };
const options = { logger: {}, preparedStatements: true, warnOnUnlimited: false, diagnostics: { mode: 'production', advice: false, cacheCheck: 'off' },
  relationLoadStrategy: 'join', jsonEncoding: 'object' };
export const table = (c) => c.parents ? 'parents' : c.tiny ? 'tiny' : 'items';
export const statement = (d) => ({ sql: d.sql, params: d.params, name: d.preparedName ?? '' });
const template = new TurbineClient({ ...options, pool: { query() { throw new Error('Compilation only'); } } }, metadata);
const templateCache = new Map();
export function templates(c, method) {
  const key = `${c.id}/${method}`;
  if (templateCache.has(key)) return templateCache.get(key);
  const q = template.table(table(c));
  const value = [...(method === 'locate' ? [statement(q.buildFindMany(lookupArgs(c)))] : []), statement(q.buildFindMany(args(c, method)))];
  templateCache.set(key, value);
  return value;
}

export { DDL, setup } from './setup.mjs';

// Both arms share this exact pg boundary, noise, counters and full-value oracle.
export function open(url, registry, fault, arm) {
  const native = new pg.Pool({ connectionString: url, max: 1, application_name: 'pagination-owned',
    connectionTimeoutMillis: 3000, query_timeout: 15000 });
  native.on('error', () => {});
  const context = { trace: [], connections: [], native, fault };
  native.on('connect', (c) => context.connections.push(c.processID));
  const pool = { options: native.options, query: async (config, params) => {
    let text = typeof config === 'string' ? config : config.text;
    const values = (typeof config === 'string' ? params : config.values) ?? [];
    const name = typeof config === 'string' ? '' : config.name ?? '';
    if (fault === 'materialization' && text !== 'SELECT 1 AS noise') text = text.replace(/ LIMIT \$\d+(?: OFFSET \$\d+)?$/, '');
    // Removing binds is deliberate only in the fault; keep wire SQL well formed.
    const used = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const sent = fault === 'materialization' ? values.slice(0, Math.max(0, ...used)) : values;
    const result = await native.query({ ...(typeof config === 'string' ? {} : config), text, values: sent, name: fault ? undefined : name || undefined });
    context.trace.push({ sql: text, params: structuredClone(sent), name, rows: result.rows.length,
      rowCount: result.rowCount, command: result.command, resultSha256: digest(result.rows) });
    return result;
  } };
  if (arm === 'turbine') context.db = new TurbineClient({ ...options, pool }, metadata);
  context.pool = pool;
  context.close = async () => { await native.end(); registry.delete(context); };
  registry.add(context);
  return context;
}
export async function execute(context, arm, c, method) {
  const { pool, db, fault } = context;
  await pool.query('SELECT 1 AS noise');
  let supplied = cursor(c);
  const q = arm === 'turbine' ? db.table(table(c)) : undefined;
  if (method === 'locate') {
    const lookup = arm === 'raw' ? (await pool.query(toConfig(templates(c, method)[0]))).rows : await q.findMany(lookupArgs(c));
    assert.deepEqual(lookup, [supplied], 'Cursor lookup must return the predetermined identity and shape');
    supplied = lookup[0];
  }
  let rows = arm === 'raw' ? (await pool.query(toConfig(templates(c, method).at(-1)))).rows : await q.findMany(args(c, method, supplied));
  if (fault === 'ordering') rows = [...rows].reverse();
  if (fault === 'materialization') rows = rows.slice(method === 'offset' ? c.offset : 0, (method === 'offset' ? c.offset : 0) + expected(c).length);
  return verifyRows(rows, c, fault);
}
export const toConfig = (s) => ({ text: s.sql, values: s.params, name: s.name || undefined });
export function verifyTrace(trace, c, method, iterations) {
  const queries = templates(c, method);
  const required = [{ sql: 'SELECT 1 AS noise', params: [], name: '', rows: 1 }, ...queries.map((q, i) => ({ ...q,
    rows: method === 'locate' && i === 0 ? 1 : expected(c).length }))];
  assert.equal(trace.length, required.length * iterations, 'Unexpected query/materialization count');
  trace.forEach((entry, i) => {
    const wanted = required[i % required.length];
    assert.deepEqual({ sql: entry.sql, params: entry.params, name: entry.name, rows: entry.rows }, wanted, 'Wire SQL/parameter/row identity');
    assert.equal(entry.rowCount, entry.rows);
    assert.equal(entry.command, 'SELECT');
  });
}
export function planFacts(document) {
  assert.ok(Array.isArray(document) && document.length === 1 && document[0].Plan, 'Native EXPLAIN JSON required');
  const nodes = [];
  const walk = (n) => {
    assert.ok(typeof n['Node Type'] === 'string' && Number.isFinite(n['Actual Rows']) && n['Actual Rows'] >= 0 && Number.isFinite(n['Actual Loops']) && n['Actual Loops'] >= 0);
    nodes.push({ type: n['Node Type'], relation: n['Relation Name'] ?? null, index: n['Index Name'] ?? null,
      actualRows: n['Actual Rows'], loops: n['Actual Loops'], removed: n['Rows Removed by Filter'] ?? 0,
      sharedHits: n['Shared Hit Blocks'] ?? 0, sharedReads: n['Shared Read Blocks'] ?? 0 });
    for (const child of n.Plans ?? []) walk(child);
  };
  walk(document[0].Plan);
  return { rootRows: document[0].Plan['Actual Rows'], nodes, planningMs: document[0]['Planning Time'], executionMs: document[0]['Execution Time'] };
}
