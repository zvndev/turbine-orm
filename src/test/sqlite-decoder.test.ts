/** Result metadata must follow the executed SQLite statement across schema changes. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { PgCompatPoolClient } from '../client.js';
import { UnsupportedFeatureError } from '../errors.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { SqlitePool, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
const reportsTypes = typeof native?.StatementSync.prototype.columns === 'function';
const nativeStreaming = (() => {
  if (!native || typeof native.StatementSync.prototype.iterate !== 'function') return false;
  const probe = new native.DatabaseSync(':memory:');
  try {
    return typeof probe.isTransaction === 'boolean';
  } finally {
    probe.close();
  }
})();
const booleanRows = [{ v: true }, { v: false }, { v: 2 }, { v: null }];
const integerRows = [{ v: 1 }, { v: 0 }, { v: 2 }, { v: null }];
const select = 'SELECT v FROM changing ORDER BY rowid';

async function fixture(run: (db: DatabaseSync, client: PgCompatPoolClient, pool: SqlitePool) => Promise<void>) {
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db);
  const client = await pool.connect();
  try {
    await run(db, client, pool);
  } finally {
    client.release();
    await pool.end();
  }
}

async function check(client: PgCompatPoolClient, sql: string, rows: unknown[], values: unknown[] = []) {
  assert.deepEqual((await client.query(sql, values)).rows, rows);
  if (!nativeStreaming) return;
  const streamed = [];
  for await (const batch of client.streamBatches!(sql, values, 1)) streamed.push(...batch);
  assert.deepEqual(streamed, rows);
}

function replace(db: DatabaseSync, type: 'BOOLEAN' | 'INTEGER') {
  db.exec(`DROP TABLE IF EXISTS changing; CREATE TABLE changing(v ${type});
    INSERT INTO changing VALUES(1),(0),(2),(NULL)`);
}

it('same-handle native DDL updates ordinary and iterator types in both directions', async () => {
  await fixture(async (db, client, pool) => {
    replace(db, 'BOOLEAN');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    replace(db, 'INTEGER');
    assert.deepEqual((await pool.query(select)).rows, integerRows);
    await check(client, select, integerRows);
    replace(db, 'BOOLEAN');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
  });
});

it('pool-issued DDL refreshes previously empty and nonempty decoder answers', async () => {
  await fixture(async (_db, client) => {
    await client.query('CREATE TABLE changing(v INTEGER)');
    await check(client, select, []);
    await client.query('DROP TABLE changing');
    await client.query('CREATE TABLE changing(v BOOLEAN)');
    await client.query('INSERT INTO changing VALUES(1)');
    await check(client, select, [{ v: reportsTypes ? true : 1 }]);
    await client.query('DROP TABLE changing');
    await client.query('CREATE TABLE changing(v INTEGER)');
    await client.query('INSERT INTO changing VALUES(0)');
    await check(client, select, [{ v: 0 }]);
  });
});

it('rollback and reused schema versions cannot resurrect decoder metadata', async () => {
  await fixture(async (db, client) => {
    replace(db, 'INTEGER');
    const version = () => db.prepare('PRAGMA main.schema_version').get()!.schema_version;
    const original = version();
    await check(client, select, integerRows);
    await client.query('BEGIN');
    replace(db, 'BOOLEAN');
    const transient = version();
    assert.notEqual(transient, original);
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    await client.query('ROLLBACK');
    assert.equal(version(), original);
    await check(client, select, integerRows);
    await client.query('BEGIN');
    replace(db, 'INTEGER');
    assert.equal(version(), transient, 'a schema cookie can repeat for a different schema');
    await check(client, select, integerRows);
    await client.query('COMMIT');
    assert.equal(db.isTransaction ?? false, false);
  });
});

it('savepoint rollback restores the correct result types', async () => {
  await fixture(async (db, client) => {
    replace(db, 'BOOLEAN');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    await client.query('SAVEPOINT types');
    replace(db, 'INTEGER');
    await check(client, select, integerRows);
    await client.query('ROLLBACK TO types');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    await client.query('RELEASE types');
  });
});

for (const race of [false, true]) {
  it(`second native connection DDL is observed${race ? ' between prepare and first step' : ''}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-decoder-'));
    const db = new native!.DatabaseSync(join(dir, 'database.sqlite'));
    const writer = new native!.DatabaseSync(join(dir, 'database.sqlite'));
    const pool = new SqlitePool(db);
    const client = await pool.connect();
    try {
      db.exec('PRAGMA journal_mode=WAL');
      replace(writer, 'BOOLEAN');
      await check(client, select, reportsTypes ? booleanRows : integerRows);
      const prepare = db.prepare.bind(db);
      let armed = race;
      db.prepare = (sql) => {
        const stmt = prepare(sql);
        if (armed && sql === select) {
          armed = false;
          replace(writer, 'INTEGER');
        }
        return stmt;
      };
      if (!race) replace(writer, 'INTEGER');
      await check(client, select, integerRows);
      if (nativeStreaming && race) {
        // Exercise reprepare during iterator startup independently of .all().
        replace(writer, 'BOOLEAN');
        armed = true;
        const rows = [];
        for await (const batch of client.streamBatches!(select, [], 1)) rows.push(...batch);
        assert.deepEqual(rows, integerRows);
        assert.equal(armed, false);
      }
    } finally {
      client.release();
      await pool.end();
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it('temp shadowing and attached database replacement follow native name resolution', async () => {
  await fixture(async (db, client) => {
    replace(db, 'BOOLEAN');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    db.exec('CREATE TEMP TABLE changing(v INTEGER); INSERT INTO temp.changing VALUES(0)');
    await check(client, select, [{ v: 0 }]);
    db.exec('DROP TABLE temp.changing');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    db.exec(`ATTACH DATABASE ':memory:' AS extra; CREATE TABLE extra.changing(v BOOLEAN);
      INSERT INTO extra.changing VALUES(1)`);
    const attached = 'SELECT v FROM extra.changing';
    await check(client, attached, [{ v: reportsTypes ? true : 1 }]);
    db.exec(`DETACH DATABASE extra; ATTACH DATABASE ':memory:' AS extra;
      CREATE TABLE extra.changing(v INTEGER); INSERT INTO extra.changing VALUES(1)`);
    await check(client, attached, [{ v: 1 }]);
    db.exec('DROP TABLE main.changing');
    await check(client, select, [{ v: 1 }]);
    db.exec('DETACH DATABASE extra');
  });
});

it('a suspended native iterator keeps its snapshot while later executions see external DDL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-decoder-'));
  const db = new native!.DatabaseSync(join(dir, 'snapshot.sqlite'));
  const writer = new native!.DatabaseSync(join(dir, 'snapshot.sqlite'));
  const pool = new SqlitePool(db);
  const client = await pool.connect();
  try {
    db.exec('PRAGMA journal_mode=WAL');
    replace(db, 'BOOLEAN');
    if (!nativeStreaming) {
      await assert.rejects(client.streamBatches!(select, [], 1).next(), UnsupportedFeatureError);
      return;
    }
    const stream = client.streamBatches!(select, [], 1);
    try {
      assert.deepEqual((await stream.next()).value, [{ v: true }]);
      replace(writer, 'INTEGER');
      const remaining = [];
      for await (const batch of stream) remaining.push(...batch);
      assert.deepEqual(remaining, booleanRows.slice(1));
    } finally {
      await stream.return!();
    }
    await check(client, select, integerRows);
  } finally {
    client.release();
    await pool.end();
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('bound values, placeholder spellings, aliases and changing result shapes stay independent', async () => {
  await fixture(async (db, client) => {
    replace(db, 'BOOLEAN');
    const shapes = [
      'SELECT v AS value FROM changing WHERE rowid = $1',
      'SELECT v AS value FROM changing WHERE rowid = :p1 /* shape */',
    ];
    for (const sql of shapes) {
      await check(client, sql, [{ value: reportsTypes ? true : 1 }], [1]);
      await check(client, sql, [{ value: reportsTypes ? false : 0 }], [2]);
      await check(client, sql, [], [null]);
    }
    const star = 'SELECT * FROM changing WHERE rowid = $1';
    await check(client, star, [{ v: reportsTypes ? true : 1 }], [1]);
    replace(db, 'INTEGER');
    db.exec('ALTER TABLE changing ADD COLUMN extra BOOLEAN DEFAULT 1');
    for (const sql of shapes) await check(client, sql, [{ value: 1 }], [1]);
    await check(client, star, [{ v: 1, extra: reportsTypes ? true : 1 }], [1]);
    await check(client, 'SELECT v + 0 AS v FROM changing WHERE rowid = 1', [{ v: 1 }]);
  });
});

it('prepare, bind and step errors leave subsequent decoder results correct', async () => {
  await fixture(async (db, client) => {
    replace(db, 'BOOLEAN');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    db.exec('DROP TABLE changing');
    await assert.rejects(client.query(select), /no such table/);
    if (nativeStreaming) await assert.rejects(client.streamBatches!(select, [], 1).next(), /no such table/);
    replace(db, 'INTEGER');
    await check(client, select, integerRows);
    await assert.rejects(client.query('SELECT v FROM changing WHERE rowid=:missing', [1]), /Unknown named parameter/);
    // SQLite evaluates this expression at step time, including on Node 22.5
    // which lacks DatabaseSync.function(). No custom-function capability needed.
    db.exec('UPDATE changing SET v=-9223372036854775808 WHERE rowid=1');
    const sql = 'SELECT v FROM changing WHERE abs(v)>=0 ORDER BY rowid';
    await assert.rejects(client.query(sql), /integer overflow/);
    if (nativeStreaming) await assert.rejects(client.streamBatches!(sql, [], 1).next(), /integer overflow/);
    replace(db, 'BOOLEAN');
    await check(client, sql, (reportsTypes ? booleanRows : integerRows).slice(0, 3));
    const result = await client.query('UPDATE changing SET v=0 WHERE rowid=1 RETURNING v');
    assert.deepEqual(result.rows, [{ v: reportsTypes ? false : 0 }]);
  });
});

it('caller schema decoding remains consistent across ordinary and iterator reads', async () => {
  const schema = schemaDefToMetadata(defineSchema({ changing: { v: { type: 'boolean' }, payload: { type: 'json' } } }));
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db, { schema });
  const client = await pool.connect();
  try {
    const sql = 'SELECT v,payload FROM changing';
    for (let i = 0; i < 2; i++) {
      db.exec(`DROP TABLE IF EXISTS changing; CREATE TABLE changing(v INTEGER,payload TEXT);
        INSERT INTO changing VALUES(1,'{"ok":true}')`);
      await check(client, sql, [{ v: reportsTypes ? true : 1, payload: reportsTypes ? { ok: true } : '{"ok":true}' }]);
    }
  } finally {
    client.release();
    await pool.end();
  }
});

it('borrowed native handles survive disconnect after external DDL', async () => {
  const db = new native!.DatabaseSync(':memory:');
  const client = turbineSqlite(db, { tables: {}, enums: {} }, { logger: {}, warnOnUnlimited: false });
  try {
    replace(db, 'BOOLEAN');
    assert.deepEqual(await client.rawUnsafe(select), reportsTypes ? booleanRows : integerRows);
    replace(db, 'INTEGER');
    assert.deepEqual(await client.rawUnsafe(select), integerRows);
    await client.disconnect();
    assert.equal(db.prepare('SELECT count(*) AS n FROM changing').get()!.n, 4);
  } finally {
    await client.disconnect();
    db.close();
  }
});

it('missing column descriptions keep stored values and unsupported iterators refuse explicitly', async () => {
  await fixture(async (db, client) => {
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const stmt = prepare(sql);
      Object.defineProperty(stmt, 'columns', { value: undefined });
      return stmt;
    };
    replace(db, 'BOOLEAN');
    assert.deepEqual((await client.query(select)).rows, integerRows);
    replace(db, 'INTEGER');
    assert.deepEqual((await client.query(select)).rows, integerRows);
    if (typeof db.isTransaction !== 'boolean') {
      await assert.rejects(client.streamBatches!(select, [], 1).next(), UnsupportedFeatureError);
    } else {
      const rows = [];
      for await (const batch of client.streamBatches!(select, [], 1)) rows.push(...batch);
      assert.deepEqual(rows, integerRows);
    }
  });
});

it('temporary description failure is retried on the next statement', async () => {
  await fixture(async (db, client) => {
    replace(db, 'BOOLEAN');
    const prepare = db.prepare.bind(db);
    let fail = true;
    db.prepare = (sql) => {
      const stmt = prepare(sql);
      if (fail)
        Object.defineProperty(stmt, 'columns', {
          value: () => {
            throw new Error('description unavailable');
          },
        });
      return stmt;
    };
    assert.deepEqual((await client.query(select)).rows, integerRows);
    fail = false;
    await check(client, select, reportsTypes ? booleanRows : integerRows);
  });
});

it('reused mutable driver descriptions cannot preserve stale decoding', async () => {
  await fixture(async (db, client) => {
    const prepare = db.prepare.bind(db);
    const shared: ReturnType<ReturnType<DatabaseSync['prepare']>['columns']> = [];
    db.prepare = (sql) => {
      const stmt = prepare(sql);
      if (typeof stmt.columns !== 'function') return stmt;
      const columns = stmt.columns.bind(stmt);
      stmt.columns = () => {
        shared.splice(0, shared.length, ...columns());
        return shared;
      };
      return stmt;
    };
    replace(db, 'BOOLEAN');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
    replace(db, 'INTEGER');
    await check(client, select, integerRows);
    replace(db, 'BOOLEAN');
    await check(client, select, reportsTypes ? booleanRows : integerRows);
  });
});

it('matching projected names and storage types do not erase different logical origins', async () => {
  const schema = schemaDefToMetadata(defineSchema({ changing: { v: { type: 'boolean' } } }));
  const db = new native!.DatabaseSync(':memory:');
  const pool = new SqlitePool(db, { schema });
  const client = await pool.connect();
  try {
    db.exec(
      'CREATE TABLE changing(v INTEGER); CREATE TABLE plain(v INTEGER); INSERT INTO changing VALUES(1); INSERT INTO plain VALUES(1)',
    );
    for (let i = 0; i < 3; i++) {
      await check(client, 'SELECT v AS value FROM changing', [{ value: reportsTypes ? true : 1 }]);
      await check(client, 'SELECT v AS value FROM plain', [{ value: 1 }]);
    }
  } finally {
    client.release();
    await pool.end();
  }
});
