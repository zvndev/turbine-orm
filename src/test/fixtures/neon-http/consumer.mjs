import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mode = process.argv[2];
const { turbineNeonHttp } = mode === 'cjs' ? require('turbine-orm/neon-http') : await import('turbine-orm/neon-http');
const { neon } = mode === 'cjs' ? require('@neondatabase/serverless') : await import('@neondatabase/serverless');
const schema = {
  enums: {},
  tables: {
    items: {
      name: 'items',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int4',
          nullable: false,
          hasDefault: false,
          isPrimaryKey: true,
          isUnique: true,
        },
      ],
      columnMap: { id: 'id' },
      reverseColumnMap: { id: 'id' },
      dateColumns: new Set(),
      pgTypes: { id: 'int4' },
      dialectTypes: { id: 'int4' },
      allColumns: ['id'],
      primaryKey: ['id'],
      uniqueColumns: [['id']],
      relations: {},
      indexes: [],
    },
  },
};
let requests = 0;
globalThis.fetch = async (_url, init) => {
  requests++;
  const body = JSON.parse(init.body);
  if (body.queries) {
    assert.equal(body.queries.length, 2);
    assert.deepEqual(body.queries[0].params, ['7', '1']);
    assert.deepEqual(body.queries[1].params, []);
    const results = [
      { fields: [{ name: 'id', dataTypeID: 23 }], rows: [['7']], rowCount: 1, command: 'SELECT' },
      { fields: [{ name: 'count', dataTypeID: 23 }], rows: [['3']], rowCount: 1, command: 'SELECT' },
    ];
    if (process.env.NEON_HTTP_FAULT === 'reverse-results') results.reverse();
    if (process.env.NEON_HTTP_FAULT === 'omit-batch-result') results.pop();
    return new Response(JSON.stringify({ results }), { status: 200 });
  }
  if (process.env.NEON_HTTP_FAULT === 'omit-param') body.params = [];
  assert.deepEqual(body.params, ['7', '1']);
  const omit = process.env.NEON_HTTP_FAULT === 'omit-id';
  return new Response(
    JSON.stringify({
      fields: omit ? [] : [{ name: 'id', dataTypeID: 23 }],
      rows: omit ? [[]] : [['7']],
      rowCount: 1,
      command: 'SELECT',
      rowAsArray: true,
    }),
    { status: 200 },
  );
};
const sql = neon('postgresql://fixture_user:fixture_password@database.invalid/fixture_database');
const db = turbineNeonHttp(sql, schema);
assert.deepEqual(await db.table('items').findMany({ where: { id: 7 }, limit: 1 }), [{ id: 7 }]);
assert.deepEqual(
  await db.batch([db.table('items').buildFindMany({ where: { id: 7 }, limit: 1 }), db.table('items').buildCount()]),
  [[{ id: 7 }], 3],
);
let invoked = false;
assert.throws(() =>
  db.transaction(() => {
    invoked = true;
  }),
);
assert.equal(invoked, false);
assert.equal(requests, 2);
await db.disconnect();
console.log(JSON.stringify({ format: mode, requests, passed: true }));
