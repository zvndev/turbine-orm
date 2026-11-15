import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = resolve(process.argv[2]);
const { QueryInterface, postgresDialect } = await import(pathToFileURL(join(dir, 'dist/index.js')));
const { tupleCursorFingerprint } = await import(pathToFileURL(join(dir, 'dist/query/cursor-tuple.js')));
const columns = ['id', 'sort_key'].map(name => ({ name, field: name === 'id' ? 'id' : 'sortKey', pgType: 'int4', nullable: false, hasDefault: false, tsType: 'number', isArray: false }));
function metadata() {
  return { name: 'items', columns: columns.map(c => ({ ...c })), allColumns: ['id', 'sort_key'], columnMap: { id: 'id', sortKey: 'sort_key' }, reverseColumnMap: { id: 'id', sort_key: 'sortKey' }, pgTypes: { id: 'int4', sort_key: 'int4' }, primaryKey: ['id'], uniqueColumns: [['id']], indexes: [], relations: {}, dateColumns: new Set() };
}
let checkouts = 0;
const pool = { query() { checkouts++; throw Error('must not query'); }, connect() { checkouts++; throw Error('must not checkout'); } };
function query(meta = metadata()) { return new QueryInterface(pool, 'items', { enums: {}, tables: { items: meta } }, [], { preparedStatements: true, diagnostics: { mode: 'production', cacheCheck: 'off', advice: false } }); }
const args = { orderBy: { sortKey: 'asc' }, cursor: { sortKey: 2, id: 1 }, limit: 4 };
const q = query();
const normal = q.buildFindMany(args), tuple = q.buildFindMany({ ...args, cursorPredicate: 'tuple' });
assert.notEqual(tuple.sql, normal.sql, 'mode signature must isolate the cached predicate');
assert.match(tuple.sql, /\("items"\."sort_key", "items"\."id"\) > \(\$1, \$2\)/, 'whole effective tuple must be compared');
assert.deepEqual(tuple.params, [2, 1, 4]);
const inherited = metadata();
inherited.primaryKey = Array(1);
Object.setPrototypeOf(inherited.primaryKey, Object.assign(Object.create(Array.prototype), { 0: 'id' }));
assert.throws(() => query(inherited).buildFindMany({ ...args, cursorPredicate: 'tuple' }), { code: 'TURBINE_E017' }, 'inherited array slots must not prove a key');
assert.throws(() => query().buildFindMany({ ...args, orderBy: [{ id: 'asc' }, { sortKey: 'asc' }], cursorPredicate: 'tuple' }), { code: 'TURBINE_E017' }, 'a unique prefix is not a unique suffix');
const newline = metadata(); newline.columns[0].pgType = 'int4\n';
assert.throws(() => tupleCursorFingerprint(newline, [{ column: 'id', desc: false }], new Map([['id', 1]]), [['id']], {}, false), { code: 'TURBINE_E017' }, 'builtin names require an absolute end boundary');
const { PowqlInterface } = await import(pathToFileURL(join(dir, 'dist/powdb.js')));
const meta = metadata(), schema = { enums: {}, tables: { items: meta } };
const powql = new PowqlInterface(pool, 'items', schema, [], {});
await assert.rejects(powql.findMany({ ...args, cursorPredicate: 'tuple' }), { code: 'TURBINE_E017' });
const custom = new QueryInterface(pool, 'items', schema, [], { dialect: { ...postgresDialect, name: 'custom', capabilities: { ...postgresDialect.capabilities, tupleCursorPredicate: undefined } } });
await assert.rejects(custom.findMany({ ...args, cursorPredicate: 'tuple' }), { code: 'TURBINE_E017' });
assert.equal(checkouts, 0);
console.log(JSON.stringify({ checks: 9, checkouts, status: 'passed' }));
