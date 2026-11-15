/** Actual installed public-entry consumer. Native prerequisites are required, never skipped. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const format = process.env.DECODER_FORMAT;
const engine = process.env.DECODER_ENGINE;
assert.ok(['esm', 'cjs'].includes(format), 'DECODER_FORMAT must select esm or cjs');
assert.ok(['postgresql', 'sqlite', 'mysql'].includes(engine), 'DECODER_ENGINE must select a native engine');
const require = createRequire(import.meta.url);
const load = (name) => (format === 'cjs' ? require(name) : import(name));
const api = await load('turbine-orm');
const report = { node: process.version, format, engine, checks: [], skips: [], results: {} };
const schema = api.schemaDefToMetadata(
  api.defineSchema({
    decoder_rows: {
      id: { type: 'integer', primaryKey: true },
      tenantId: { type: 'integer', notNull: true },
      fullName: { type: 'text' },
      createdAt: { type: 'timestamp' },
      amount: { type: 'bigint' },
      score: { type: 'double' },
      flag: { type: 'boolean' },
      payload: { type: 'jsonb' },
      binaryValue: { type: 'bytea', unique: true },
      nullable: { type: 'text' },
    },
  }),
);
const options = {
  logger: {},
  warnOnUnlimited: false,
  diagnostics: 'development',
  globalFilters: { decoder_rows: { tenantId: 1 } },
};
let db;
const check = async (name, run) => {
  await run();
  report.checks.push(name);
};
try {
  if (engine === 'postgresql') {
    assert.ok(process.env.DECODER_PG_URL, 'Owned PostgreSQL endpoint required');
    db = new api.TurbineClient({ ...options, connectionString: process.env.DECODER_PG_URL, poolSize: 1 }, schema);
  } else if (engine === 'sqlite') {
    const binding = await load('turbine-orm/sqlite');
    db = binding.turbineSqlite(':memory:', schema, options);
  } else {
    assert.ok(process.env.DECODER_MYSQL_SOCKET, 'Owned MySQL socket required');
    const binding = await load('turbine-orm/mysql');
    db = await binding.turbineMysql(
      { socketPath: process.env.DECODER_MYSQL_SOCKET, user: 'root', database: 'decoder_contract' },
      schema,
      options,
    );
  }
  await db.connect();
  await db.rawUnsafe('DROP TABLE IF EXISTS decoder_rows');
  const ddl =
    engine === 'mysql'
      ? 'CREATE TABLE decoder_rows(id INT PRIMARY KEY,tenant_id INT NOT NULL,full_name VARCHAR(80),created_at DATETIME(3),amount BIGINT,score DOUBLE,flag BOOLEAN,payload JSON,binary_value VARBINARY(16) UNIQUE,nullable TEXT)'
      : engine === 'sqlite'
        ? 'CREATE TABLE decoder_rows(id INTEGER PRIMARY KEY,tenant_id INTEGER NOT NULL,full_name TEXT,created_at TIMESTAMP,amount BIGINT,score REAL,flag BOOLEAN,payload JSON,binary_value BLOB UNIQUE,nullable TEXT)'
        : 'CREATE TABLE decoder_rows(id INTEGER PRIMARY KEY,tenant_id INTEGER NOT NULL,full_name TEXT,created_at TIMESTAMP,amount BIGINT,score DOUBLE PRECISION,flag BOOLEAN,payload JSONB,binary_value BYTEA UNIQUE,nullable TEXT)';
  await db.rawUnsafe(ddl);
  for (const [id, tenant, name, amount] of [
    [1, 1, 'Ada', '9007199254740993'],
    [2, 2, 'Private', '17'],
    [3, 1, 'Lin', '-9007199254740993'],
  ]) {
    await db.rawUnsafe(
      'INSERT INTO decoder_rows VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      ...[
        id,
        tenant,
        name,
        '2024-02-29 12:34:56.123',
        amount,
        id / 4,
        true,
        '{"nested":[1,null,"x"],"__proto__":{"polluted":true}}',
        Buffer.from([0, id, 255]),
        null,
      ],
    );
  }
  const q = db.table('decoder_rows');
  let expected;
  await check('all fields, order, date, safe integer, JSON, binary and null', async () => {
    expected = await q.findMany({ orderBy: { id: 'asc' } });
    assert.equal(expected.length, 2);
    assert.deepEqual(
      expected.map((r) => r.id),
      [1, 3],
    );
    for (const [i, r] of expected.entries()) {
      assert.deepEqual(Object.keys(r), [
        'id',
        'tenantId',
        'fullName',
        'createdAt',
        'amount',
        'score',
        'flag',
        'payload',
        'binaryValue',
        'nullable',
      ]);
      assert.equal(Object.getPrototypeOf(r), Object.prototype);
      assert.equal(r.tenantId, 1);
      assert.equal(r.fullName, i === 0 ? 'Ada' : 'Lin');
      assert.equal(r.createdAt.toISOString(), '2024-02-29T12:34:56.123Z');
      assert.equal(r.amount, i === 0 ? '9007199254740993' : '-9007199254740993');
      assert.equal(r.score, r.id / 4);
      assert.equal(r.flag, true);
      assert.deepEqual(r.payload.nested, [1, null, 'x']);
      assert.equal(Object.getPrototypeOf(r.payload), Object.prototype);
      assert.equal(Object.hasOwn(r.payload, '__proto__'), true);
      assert.equal(Object.getOwnPropertyDescriptor(r.payload, '__proto__').value.polluted, true);
      assert.deepEqual([...r.binaryValue], [0, r.id, 255]);
      assert.equal(r.nullable, null);
    }
    report.results.rows = expected;
  });
  await check('warm projection changes and tenant filters', async () => {
    assert.deepEqual(await q.findMany({ select: { id: true, fullName: true }, orderBy: { id: 'asc' } }), [
      { id: 1, fullName: 'Ada' },
      { id: 3, fullName: 'Lin' },
    ]);
    assert.deepEqual(
      await q.findMany({ select: { score: true, createdAt: true }, orderBy: { id: 'asc' } }),
      expected.map((r) => ({ createdAt: r.createdAt, score: r.score })),
    );
    assert.deepEqual(await q.findMany({ orderBy: { id: 'asc' } }), expected);
    assert.equal(await q.findUnique({ where: { id: 2 } }), null);
    assert.equal((await q.findUnique({ where: { id: 2 }, skipGlobalFilters: api.UNSAFE })).fullName, 'Private');
    assert.equal(await q.findUnique({ where: { id: 2 } }), null);
  });
  await check('typed binary operand mutation still validates the general filter shape', async () => {
    const value = new Uint8Array([0, 1, 255]);
    assert.equal((await q.findUnique({ where: { binaryValue: value } })).id, 1);
    value.hasKey = 'x';
    await assert.rejects(q.findUnique({ where: { binaryValue: value } }), (e) => e.code === 'TURBINE_E003');
  });
  await check('malformed identity and dates refuse after cache warming', async () => {
    assert.equal((await q.findUnique({ where: { id: 1 } })).id, 1);
    for (const where of [
      {},
      { id: undefined },
      { id: NaN },
      Object.create({ id: 1 }),
      { id: 1, createdAt: new Date(NaN) },
    ]) {
      await assert.rejects(q.findUnique({ where }), (e) => e.code === 'TURBINE_E003');
    }
  });
  await check('transaction rollback preserves effect and ownership', async () => {
    const stop = new Error('rollback');
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table('decoder_rows').update({ where: { id: 1 }, data: { fullName: 'changed' } });
        assert.equal((await tx.table('decoder_rows').findUnique({ where: { id: 1 } })).fullName, 'changed');
        throw stop;
      }),
      (e) => e === stop,
    );
    assert.deepEqual(await q.findMany({ orderBy: { id: 'asc' } }), expected);
  });
  await check('raw aliases and own __proto__ remain data', async () => {
    const quote = engine === 'mysql' ? '`' : '"';
    if (engine === 'mysql') {
      await assert.rejects(
        db.rawUnsafe(
          `SELECT full_name AS ${quote}__proto__${quote},id AS ${quote}raw_id${quote} FROM decoder_rows WHERE id=1`,
        ),
        (error) => error.fatal === true && /field name \(__proto__\).*private property/.test(error.message),
      );
      report.results.rawPrototypeAliasRefused = true;
      return;
    }
    const rows = await db.rawUnsafe(
      `SELECT full_name AS ${quote}__proto__${quote},id AS ${quote}raw_id${quote} FROM decoder_rows WHERE id=1`,
    );
    assert.equal(rows.length, 1);
    assert.deepEqual(Object.keys(rows[0]), ['__proto__', 'raw_id']);
    assert.equal(Object.getPrototypeOf(rows[0]), Object.prototype);
    assert.equal(Object.hasOwn(rows[0], '__proto__'), true);
    assert.equal(Object.getOwnPropertyDescriptor(rows[0], '__proto__').value, 'Ada');
  });
  if (engine === 'postgresql')
    await check('native NaN and temporal infinity preserve configured semantics', async () => {
      await db.rawUnsafe(
        "INSERT INTO decoder_rows(id,tenant_id,full_name,created_at,score) VALUES(4,1,'edge','infinity','NaN')",
      );
      const row = await q.findUnique({ where: { id: 4 } });
      assert.equal(row.createdAt, Infinity);
      assert.ok(Number.isNaN(row.score));
      await db.rawUnsafe('DELETE FROM decoder_rows WHERE id=4');
    });
  await check('disconnect settles before the owned endpoint is stopped', async () => {
    await db.disconnect();
    db = undefined;
  });
  report.passed = true;
} finally {
  if (db) await db.disconnect();
}
const output = process.env.DECODER_RESULT;
assert.ok(output, 'An owned result path is required');
writeFileSync(
  output,
  JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? { bigint: String(v) } : v), 2),
);
console.log(
  JSON.stringify({
    node: report.node,
    format,
    engine,
    checks: report.checks.length,
    passed: report.passed,
    skips: report.skips,
  }),
);
