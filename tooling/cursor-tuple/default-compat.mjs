import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

// Both arguments are concretely staged packages, never alternate source checkouts.
const [before, after] = process.argv.slice(2).map(p => resolve(p));
assert.ok(before && after, 'Pass baseline and candidate package directories');
const load = (dir, entry = 'index') => import(pathToFileURL(join(dir, `dist/${entry}.js`)).href);
const apis = await Promise.all([load(before), load(after)]);
const column = (name, pgType = 'int4', nullable = false) => ({ name, field: name.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), pgType, pgArrayType: `${pgType}[]`, nullable, hasDefault: false, tsType: pgType === 'text' ? 'string' : 'number', isArray: pgType.startsWith('_') });
function table(name, relations = {}) {
  const columns = [column('id'), column('sort_key'), column('tenant_id'), column('amount', 'numeric'), column('name', 'text'), column('meta', 'jsonb'), column('tags', '_text'), column('happened_at', 'timestamp'), column('optional_key', 'int4', true)];
  return { name, columns, columnMap: Object.fromEntries(columns.map(c => [c.field, c.name])), reverseColumnMap: Object.fromEntries(columns.map(c => [c.name, c.field])), allColumns: columns.map(c => c.name), pgTypes: Object.fromEntries(columns.map(c => [c.name, c.pgType])), dateColumns: new Set(['happened_at']), primaryKey: ['id'], uniqueColumns: [['id']], indexes: [], relations };
}
const schema = { enums: {}, tables: {
  items: table('items', {
    children: { name: 'children', type: 'hasMany', from: 'items', to: 'children', foreignKey: 'tenant_id', referenceKey: 'id' },
    parent: { name: 'parent', type: 'belongsTo', from: 'items', to: 'children', foreignKey: 'tenant_id', referenceKey: 'id' },
    peers: { name: 'peers', type: 'manyToMany', from: 'items', to: 'children', foreignKey: 'id', referenceKey: 'id', through: { table: 'links', sourceKey: 'source_id', targetKey: 'target_id' } },
  }), children: table('children'), links: table('links'),
} };
const wheres = [undefined, { id: 2 }, { AND: [{ id: { gt: 2 } }, { name: { startsWith: 'a' } }] }, { OR: [{ name: { contains: 'a', endsWith: 'z' } }, { NOT: { id: { in: [1, 2] } } }] }, { OR: [{}, { id: 2 }] }, { optionalKey: null }, { meta: { path: ['rank'], gte: 2, stringContains: 'a' } }, { tags: { hasSome: ['a'], isEmpty: false } }, { happenedAt: new Date('2025-02-03T12:00:00Z') }, { children: { some: { AND: [{ id: 2 }, { name: 'x' }] }, none: { id: 3 }, every: { id: { gte: 1 } } } }, { parent: { is: null, isNot: { id: 4 } } }, { peers: { some: { id: 2 }, none: { name: 'x' }, every: {} } }];
const withs = [undefined, { children: true }, { children: { where: { OR: [{ id: 1 }, { name: { contains: 'x' } }] }, limit: 2, orderBy: { id: 'desc' } }, parent: { where: { name: 'a' } } }, { peers: { limit: 2, offset: 1, orderBy: { id: 'desc' } } }];
const orders = [{ id: 'asc' }, [{ sortKey: 'desc' }, { id: 'desc' }], { parent: { name: 'asc' } }, { children: { _count: 'desc' } }, { meta: { path: ['rank'], direction: 'asc', type: 'numeric' } }];
const cases = [];
for (const where of wheres) for (const withClause of withs) for (const orderBy of orders) {
  cases.push(['buildFindMany', { where, with: withClause, orderBy, limit: 3, jsonEncoding: 'object' }]);
}
for (const withClause of withs) for (const where of [{ id: 2 }, { id: { equals: 2 } }, { id: 2, AND: [{ name: 'a' }] }]) {
  for (const method of ['buildFindUnique', 'buildFindUniqueOrThrow', 'buildFindFirst', 'buildFindFirstOrThrow']) cases.push([method, { where, with: withClause, jsonEncoding: 'object', select: { id: true, sortKey: true } }]);
}
for (const direction of ['asc', 'desc']) for (const mode of [undefined, 'lexicographic']) {
  cases.push(['buildFindMany', { cursor: { sortKey: 3, id: 2 }, cursorPredicate: mode, orderBy: { sortKey: direction }, limit: 4 }]);
}
for (const method of ['buildAggregate', 'buildGroupBy']) for (const where of wheres) {
  cases.push([method, { where, ...(method === 'buildGroupBy' ? { by: ['tenantId'] } : {}), _count: { _all: true, id: true }, _sum: { amount: true }, _avg: { sortKey: true }, _min: { happenedAt: true }, _max: { name: true } }]);
}
for (const where of wheres) {
  cases.push(['buildUpdateMany', { where, data: { sortKey: { increment: 2 }, name: 'updated' } }]);
  cases.push(['buildDeleteMany', { where }]);
}
for (const data of [null, undefined, 0, false, 'ab']) cases.push(['buildUpdateMany', { where: { id: 2 }, data }]);
for (const direction of ['asc', 'desc']) for (const mode of [undefined, 'lexicographic']) {
  for (const orderBy of [{ sortKey: direction }, { optionalKey: direction }]) cases.push(['buildFindMany', { cursor: { id: 2 }, cursorPredicate: mode, orderBy, limit: 4 }]);
  cases.push(['buildFindMany', { cursor: { id: 2, optionalKey: null }, cursorPredicate: mode, orderBy: { optionalKey: direction }, limit: 4 }]);
}
const raw = { id: 2, sort_key: 3, tenant_id: 4, amount: '12.34', name: 'row', happened_at: '2025-02-03 12:00:00', children: [], parent: null, peers: [], _count__all: 2, _count_id: 2, _sum_amount: '24.68', _avg_sort_key: '3.5', _min_happened_at: '2025-02-03 12:00:00', _max_name: 'z' };
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? `${v}n` : v);
let comparisons = 0, errors = 0;
const digest = createHash('sha256');
for (const engine of ['postgresql', 'sqlite', 'mysql', 'mssql']) {
  const dialects = engine === 'postgresql' ? apis.map(a => a.postgresDialect) : await Promise.all([before, after].map(async dir => (await load(dir, engine))[`${engine}Dialect`]));
  const options = { preparedStatements: true, diagnostics: { mode: 'production', cacheCheck: 'every-hit', advice: false }, globalFilters: { children: { tenantId: 7 } } };
  const qs = apis.map((a, i) => new a.QueryInterface({ query() { throw Error('must not execute'); } }, 'items', schema, [], { ...options, dialect: dialects[i] }));
  for (const [method, args] of cases) for (let run = 0; run < 2; run++) {
    const snapshots = qs.map(q => {
      try {
        const d = q[method](args);
        return { sql: d.sql, params: json(d.params), name: d.preparedName, tag: d.tag, lock: d.rowLock, output: json(d.transform({ rows: [raw], rowCount: 1 })), fingerprints: [...q.sqlTemplateCache.cache.keys()] };
      } catch (e) { return { error: e.code, name: e.name, message: e.message }; }
    });
    assert.deepEqual(snapshots[1], snapshots[0], `${engine} ${method} ${json(args)} run=${run}`);
    if (snapshots[0].error) errors++;
    digest.update(json(snapshots[0])); comparisons++;
  }
}
assert.equal(cases.length, 357);
assert.equal(comparisons, 2856);
assert.ok(errors < comparisons / 2, 'Most cases must actually compile');
console.log(JSON.stringify({ comparisons, cases: cases.length, expectedRefusals: errors, digest: digest.digest('hex'), status: 'passed' }));
