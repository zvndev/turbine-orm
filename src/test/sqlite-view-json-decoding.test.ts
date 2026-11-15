import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import type { SchemaMetadata } from '../schema.js';
import { withDbFieldNames } from '../schema.js';
import { introspectSqliteDatabase, SqlitePool, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const DatabaseSync: typeof NativeDatabase | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!DatabaseSync, 'SQLite JSON views require node:sqlite');
const values = [{ rows: [2, false, null], label: 'π' }, [false, { odd: 'text' }], '42', '[]', false, 17, null];

function fixture() {
  assert.ok(DatabaseSync);
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ledger(id INTEGER PRIMARY KEY, doc JSON, text_value TEXT);
    CREATE TABLE other_json(doc JSON);
    CREATE VIEW ledger_views AS SELECT id, doc AS payload_json, text_value AS plain_json FROM ledger;
    CREATE VIEW layer_views AS SELECT id, payload_json, plain_json FROM ledger_views;
  `);
  const insert = db.prepare('INSERT INTO ledger VALUES (?, ?, ?)');
  for (let i = 0; i < values.length; i++) insert.run(i + 1, JSON.stringify(values[i]), JSON.stringify(values[i]));
  return db;
}

function selected(db: NativeDatabase) {
  return introspectSqliteDatabase(db, { includeViews: true, include: ['ledger_views'], logger: {} });
}

for (const mode of ['include', 'exclude', 'nested', 'json-roundtrip', 'database-fields'] as const) {
  it(`view JSON decoding survives ${mode} without an exposed base-table accessor`, async () => {
    const db = fixture();
    let schema =
      mode === 'exclude'
        ? introspectSqliteDatabase(db, { includeViews: true, exclude: ['ledger'], logger: {} })
        : mode === 'nested'
          ? introspectSqliteDatabase(db, { includeViews: true, include: ['layer_views'], logger: {} })
          : selected(db);
    if (mode === 'json-roundtrip') {
      schema = JSON.parse(
        JSON.stringify(schema, (_key, value) => (value instanceof Set ? { $set: [...value] } : value)),
        (_key, value) =>
          value && typeof value === 'object' && Array.isArray(value.$set) ? new Set(value.$set) : value,
      ) as SchemaMetadata;
    }
    if (mode === 'database-fields') schema = withDbFieldNames(schema);
    assert.equal(schema.tables.ledger, undefined);
    const table = mode === 'nested' ? 'layer_views' : 'ledger_views';
    assert.equal(schema.tables[table]!.isView, true);
    const client = turbineSqlite(db, schema, { logger: {}, wal: false });
    try {
      const rows = await client.table(table).findMany({ orderBy: { id: 'asc' } });
      const payload = mode === 'database-fields' ? 'payload_json' : 'payloadJson';
      const plain = mode === 'database-fields' ? 'plain_json' : 'plainJson';
      assert.deepEqual(
        rows.map((row) => row[payload]),
        values,
      );
      assert.deepEqual(
        rows.map((row) => row[plain]),
        values.map((value) => JSON.stringify(value)),
      );
      assert.equal((await client.table(table).findFirst({ where: { id: 3 } }))?.[payload], '42');
      const connection = await client.pool.connect();
      try {
        const query = 'SELECT doc AS payload_json, text_value AS plain_json FROM ledger ORDER BY id';
        const expected = values.map((value) => ({ payload_json: value, plain_json: JSON.stringify(value) }));
        assert.deepEqual((await connection.query(query)).rows, expected);
        assert.ok(connection.streamBatches);
        const streamed = [];
        for await (const batch of connection.streamBatches(query, [], 2)) streamed.push(...batch);
        assert.deepEqual(streamed, expected);
      } finally {
        connection.release();
      }
    } finally {
      await client.disconnect();
      assert.equal(db.prepare('SELECT count(*) AS n FROM ledger').get()!.n, values.length);
      db.close();
    }
  });
}

it('no-schema, empty-schema and ordinary-table-only pools preserve raw native JSON cells', async () => {
  for (const mode of ['none', 'empty', 'unmarked', 'tables-only'] as const) {
    const db = fixture();
    const schema: SchemaMetadata | undefined =
      mode === 'none'
        ? undefined
        : mode === 'empty'
          ? { tables: {}, enums: {} }
          : mode === 'tables-only'
            ? introspectSqliteDatabase(db, { include: ['other_json'], logger: {} })
            : selected(db);
    if (mode === 'unmarked') schema!.tables.ledger_views!.isView = false;
    const query = 'SELECT doc AS payload_json FROM ledger ORDER BY id';
    const expected = db
      .prepare(query)
      .all()
      .map((row) => ({ payload_json: row.payload_json }));
    const pool = new SqlitePool(db, { schema });
    const connection = await pool.connect();
    try {
      assert.deepEqual((await pool.query(query)).rows, expected);
      assert.ok(connection.streamBatches);
      const rows = [];
      for await (const batch of connection.streamBatches(query, [], 2)) rows.push(...batch);
      assert.deepEqual(rows, expected);
    } finally {
      connection.release();
      await pool.end();
    }
  }
});

it('an explicit known-origin schema declaration keeps precedence over native view fallback', async () => {
  const db = fixture();
  const schema = introspectSqliteDatabase(db, { includeViews: true, logger: {} });
  const base = schema.tables.ledger!;
  base.columns.find((column) => column.name === 'doc')!.pgType = 'TEXT';
  base.pgTypes.doc = 'TEXT';
  const query = 'SELECT doc AS payload_json FROM ledger ORDER BY id';
  const expected = db
    .prepare(query)
    .all()
    .map((row) => ({ payload_json: row.payload_json }));
  const pool = new SqlitePool(db, { schema });
  try {
    assert.deepEqual((await pool.query(query)).rows, expected);
  } finally {
    await pool.end();
  }
});

it('a native JSONB view parses text once and preserves native binary JSONB values', async () => {
  assert.ok(DatabaseSync);
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE jsonb_source(id INTEGER, doc JSONB);
    INSERT INTO jsonb_source VALUES (1, '{"native":true}'), (2, jsonb('{"binary":true}'));
    CREATE VIEW jsonb_views AS SELECT id, doc AS payload_json FROM jsonb_source;
  `);
  const binary = db.prepare('SELECT doc FROM jsonb_source WHERE id=2').get()!.doc;
  assert.ok(binary instanceof Uint8Array && binary.length > 0);
  const schema = introspectSqliteDatabase(db, { includeViews: true, include: ['jsonb_views'], logger: {} });
  const client = turbineSqlite(db, schema, { logger: {}, wal: false });
  try {
    const rows = await client.table('jsonb_views').findMany({ orderBy: { id: 'asc' } });
    assert.deepEqual(
      rows.map((row) => row.payloadJson),
      [{ native: true }, binary],
    );
  } finally {
    await client.disconnect();
    db.close();
  }
});

it('JSON-looking TEXT, expressions and attached or temporary origins are never inferred from aliases', async () => {
  const db = fixture();
  const client = turbineSqlite(db, selected(db), { logger: {}, wal: false });
  try {
    db.exec(`
      ATTACH ':memory:' AS side;
      CREATE TABLE side.hidden(doc JSON);
      INSERT INTO side.hidden VALUES ('{"side":true}');
      CREATE TEMP TABLE local_hidden(doc JSON);
      INSERT INTO local_hidden VALUES ('{"temp":true}');
    `);
    const result = await client.rawUnsafe(
      "SELECT text_value AS payload_json, doc || '' AS computed FROM ledger WHERE id=1",
    );
    assert.deepEqual(result, [{ payload_json: JSON.stringify(values[0]), computed: JSON.stringify(values[0]) }]);
    assert.deepEqual(await client.rawUnsafe('SELECT doc AS payload_json FROM side.hidden'), [
      { payload_json: '{"side":true}' },
    ]);
    assert.deepEqual(await client.rawUnsafe('SELECT doc AS payload_json FROM local_hidden'), [
      { payload_json: '{"temp":true}' },
    ]);
  } finally {
    await client.disconnect();
    db.close();
  }
});

it('view-aware decoding follows native type changes and rollback without a stale JSON plan', async () => {
  const db = fixture();
  const client = turbineSqlite(db, selected(db), { logger: {}, wal: false });
  const query = 'SELECT doc AS payload_json FROM ledger WHERE id=1';
  const connection = await client.pool.connect();
  try {
    assert.deepEqual((await connection.query(query)).rows, [{ payload_json: values[0] }]);
    await connection.query('BEGIN');
    db.exec(`
      DROP VIEW layer_views;
      DROP VIEW ledger_views;
      DROP TABLE ledger;
      CREATE TABLE ledger(id INTEGER, doc TEXT);
      INSERT INTO ledger VALUES (1, '{"changed":true}');
      CREATE VIEW ledger_views AS SELECT id, doc AS payload_json FROM ledger;
    `);
    assert.deepEqual((await connection.query(query)).rows, [{ payload_json: '{"changed":true}' }]);
    await connection.query('ROLLBACK');
    assert.deepEqual((await connection.query(query)).rows, [{ payload_json: values[0] }]);
  } finally {
    connection.release();
    await client.disconnect();
    db.close();
  }
});
