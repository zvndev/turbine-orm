import assert from 'node:assert/strict';
import { digest, fixture, PAGE } from '../postgres-pagination/corpus.mjs';
import { compileTuple, quote } from './candidate.mjs';

export const ARMS = ['expanded-or', 'tuple'];
export const METHODS = ['provided', 'locate'];
export const MODES = ['connection-cold', 'warm'];
const keys = (columns, direction = 'asc') => columns.map((column) => ({ column, direction, nullable: false }));
export const CASES = [
  { id: 'deep', keys: keys(['score', 'id']), offset: 18003 },
  { id: 'deep-desc', keys: keys(['score', 'id'], 'desc'), offset: 18003 },
  { id: 'composite-ties', keys: keys(['bucket', 'score', 'id']), offset: 18003 },
  { id: 'composite-ties-desc', keys: keys(['bucket', 'score', 'id'], 'desc'), offset: 18003 },
  { id: 'selective', keys: keys(['score', 'id']), selective: true, offset: 201 },
  { id: 'tiny', keys: keys(['score', 'id']), tiny: true, offset: 3 },
  { id: 'final', keys: keys(['score', 'id']), tail: 5 },
  { id: 'empty', keys: keys(['score', 'id']), tail: 0 },
].map((c) => {
  // Independent oracle: only input values and a JS comparator, no compiled SQL.
  const ordered = fixture(c.tiny ? 17 : undefined).filter((r) => r.score !== null && (!c.selective || r.bucket === 7));
  ordered.sort((a, b) => {
    for (const key of c.keys) if (a[key.column] !== b[key.column]) return (a[key.column] - b[key.column]) * (key.direction === 'asc' ? 1 : -1);
    return 0;
  });
  const offset = c.offset ?? ordered.length - c.tail;
  assert.ok(offset > 0 && offset <= ordered.length);
  const previous = ordered[offset - 1];
  return { ...c, offset, count: ordered.length, cursor: Object.fromEntries(c.keys.map((k) => [k.column, previous[k.column]])), expected: ordered.slice(offset, offset + PAGE) };
});

export const REFUSALS = [
  { id: 'nullable-domain', keys: [{ column: 'score', direction: 'asc', nullable: true }, ...keys(['id'])], cursor: { score: 2, id: 9 }, uniqueSuffix: ['id'] },
  { id: 'null-cursor', keys: keys(['score', 'id']), cursor: { score: null, id: 19 }, uniqueSuffix: ['id'] },
  { id: 'mixed-direction', keys: [...keys(['score'], 'desc'), ...keys(['id'])], cursor: { score: 2, id: 9 }, uniqueSuffix: ['id'] },
];
const table = (c) => c.tiny ? 'tiny' : 'items';
const domain = (c) => `"score" IS NOT NULL AND "bucket" ${c.selective ? '=' : '>='} $1`;
const baseParams = (c) => [c.selective ? 7 : 0];
const order = (c) => c.keys.map((k) => `${quote(k.column)} ${k.direction.toUpperCase()}`).join(', ');
const select = (c) => `SELECT "id", "score", "bucket", "label" FROM "${table(c)}" WHERE ${domain(c)}`;

export function statements(c, arm, method, fault) {
  const params = baseParams(c);
  const lookup = { sql: `SELECT ${c.keys.map((k) => quote(k.column)).join(', ')} FROM "${table(c)}" WHERE ${domain(c)} ORDER BY ${order(c)} LIMIT $2 OFFSET $3`, params: [...params, 1, c.offset - 1], role: 'lookup' };
  let predicate;
  if (arm === 'tuple') {
    const compiled = compileTuple({ keys: c.keys, cursor: c.cursor, uniqueSuffix: ['id'], start: 2 });
    assert.equal(compiled.supported, true, compiled.reason);
    predicate = compiled.sql;
    params.push(...compiled.params);
    if (fault === 'missing-predicate') { predicate = 'TRUE'; params.splice(1); }
    if (fault === 'missing-tiebreaker') {
      predicate = `(${c.keys.slice(0, -1).map((k) => quote(k.column)).join(', ')}) ${c.keys[0].direction === 'asc' ? '>' : '<'} (${c.keys.slice(0, -1).map((_, i) => `$${i + 2}`).join(', ')})`;
      params.pop();
    }
  } else {
    // Deliberately separate expansion; repeating equality binds is observable.
    predicate = `(${c.keys.map((key, i) => `(${c.keys.slice(0, i + 1).map((k, j) => {
      params.push(c.cursor[k.column]);
      return `${quote(k.column)} ${j === i ? (key.direction === 'asc' ? '>' : '<') : '='} $${params.length}`;
    }).join(' AND ')})`).join(' OR ')})`;
  }
  params.push(PAGE);
  const page = { sql: `${select(c)} AND ${predicate} ORDER BY ${order(c)} LIMIT $${params.length}`, params, role: 'page' };
  return method === 'locate' ? [lookup, page] : [page];
}

export async function execute(client, c, arm, method, fault) {
  const trace = [];
  let rows;
  const queries = statements(c, arm, method, fault);
  for (const [i, statement] of queries.entries()) {
    const start = performance.now();
    const result = fault === 'named-execution'
      ? await client.query({ name: `keyset-fault-${digest(statement.sql).slice(0, 32)}`, text: statement.sql, values: statement.params })
      : await client.query(statement.sql, statement.params);
    const end = performance.now();
    trace.push({ ...statement, start, end, elapsedMs: end - start, rows: result.rows, rowCount: result.rowCount, command: result.command, resultSha256: digest(result.rows) });
    rows = result.rows;
    if (statement.role === 'lookup') {
      try { assert.deepEqual(rows, [c.cursor], 'Independent cursor lookup identity'); }
      catch (error) { error.trace = trace; throw error; }
      // Compile the page from the actual located cursor, after proving identity.
      queries[i + 1] = statements({ ...c, cursor: rows[0] }, arm, 'provided', fault)[0];
    }
  }
  try { assert.deepEqual(rows, c.expected, `Independent full row oracle: ${c.id}/${arm}/${method}`); }
  catch (error) { error.trace = trace; throw error; }
  return trace;
}

export function verifyTrace(trace, c, arm, method, iterations) {
  const wanted = statements(c, arm, method);
  assert.equal(trace.length, wanted.length * iterations, 'Charged lookup/page query count');
  for (let i = 0; i < trace.length; i++) {
    const expected = wanted[i % wanted.length];
    const actual = trace[i];
    assert.deepEqual({ sql: actual.sql, params: actual.params, role: actual.role }, expected, 'Exact wire SQL/params/role');
    assert.deepEqual(actual.rows, expected.role === 'lookup' ? [c.cursor] : c.expected, 'Exact wire rows');
    assert.equal(actual.rowCount, actual.rows.length);
    assert.equal(actual.command, 'SELECT');
    assert.equal(actual.resultSha256, digest(actual.rows));
    assert.ok(Number.isFinite(actual.elapsedMs) && actual.elapsedMs >= 0);
  }
}

export function planFacts(document) {
  assert.ok(Array.isArray(document) && document.length === 1 && document[0].Plan, 'Native EXPLAIN JSON required');
  const nodes = [];
  const walk = (n) => {
    assert.ok(typeof n['Node Type'] === 'string' && Number.isFinite(n['Actual Rows']) && n['Actual Rows'] >= 0 && Number.isFinite(n['Actual Loops']) && n['Actual Loops'] >= 0);
    nodes.push({ type: n['Node Type'], relation: n['Relation Name'] ?? null, index: n['Index Name'] ?? null,
      indexCondition: n['Index Cond'] ?? null, filter: n.Filter ?? null, rows: n['Actual Rows'], loops: n['Actual Loops'],
      removedByFilter: n['Rows Removed by Filter'] ?? 0, removedByRecheck: n['Rows Removed by Index Recheck'] ?? 0,
      heapFetches: n['Heap Fetches'] ?? 0, sharedHits: n['Shared Hit Blocks'] ?? 0, sharedReads: n['Shared Read Blocks'] ?? 0 });
    for (const child of n.Plans ?? []) walk(child);
  };
  walk(document[0].Plan);
  for (const key of ['Execution Time', 'Planning Time']) assert.ok(Number.isFinite(document[0][key]) && document[0][key] >= 0, 'Nonnegative native plan timing required');
  return { nodes, executionMs: document[0]['Execution Time'], planningMs: document[0]['Planning Time'] };
}
