/**
 * turbine-orm/powdb — build-only unit tests (no server required).
 *
 * These run in the normal `test:unit` lane: they cover the pure type-mapping /
 * coercion / error layer, and assert the exact PowQL that `PowqlInterface`
 * emits for each operation by capturing it through a mock pool. A separate live
 * suite (gated on a running `powdb-server`) exercises the wire end-to-end.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ConnectionError,
  TimeoutError,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.js';
import {
  coerceValue,
  encodePowqlLiteral,
  materializePowql,
  PowdbEmbeddedPool,
  PowdbFloatParam,
  type PowdbPool,
  powqlColumnType,
  powqlSchemaDDL,
  rowToEntity,
  wrapPowdbError,
} from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
}

function table(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef> = {}): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    app_user: table(
      'app_user',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('name', 'name', 'string', 'text'),
        col('age', 'age', 'number', 'int4', { nullable: true }),
        col('score', 'score', 'number', 'float8', { nullable: true }),
        col('active', 'active', 'boolean', 'bool', { nullable: true }),
        col('created_at', 'createdAt', 'Date', 'timestamptz', { nullable: true }),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'app_user',
          to: 'post',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
    post: table(
      'post',
      [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('author_id', 'authorId', 'string', 'text'),
        col('title', 'title', 'string', 'text'),
        col('views', 'views', 'number', 'int4', { nullable: true }),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'post',
          to: 'app_user',
          foreignKey: 'author_id',
          referenceKey: 'id',
        },
      },
    ),
  },
};

/** A mock PowdbPool that records every emitted PowQL and returns canned rows. */
function mockPool() {
  const calls: { powql: string; params: unknown[] }[] = [];
  let nextRows: Record<string, unknown>[] = [];
  let nextScalar = '0';
  const pool = {
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      const head = powql.trimStart();
      // Writes that carry a trailing `returning` hand back the canned rows;
      // upsert (no `returning`) and bulk update/delete return an affected count.
      if (/\breturning$/.test(powql)) return Promise.resolve({ rows: nextRows, rowCount: nextRows.length });
      if (head.startsWith('upsert')) return Promise.resolve({ rows: [], rowCount: 1 });
      if (/ update \{| delete$/.test(powql)) return Promise.resolve({ rows: [], rowCount: 1 });
      if (/^(count|sum|avg|min|max)\(/.test(head))
        return Promise.resolve({ rows: [{ value: nextScalar }], rowCount: 1 });
      return Promise.resolve({ rows: nextRows, rowCount: nextRows.length });
    },
  } as unknown as PowdbPool;
  return {
    pool,
    calls,
    last: () => calls[calls.length - 1]!,
    setRows: (r: Record<string, unknown>[]) => {
      nextRows = r;
    },
    setScalar: (v: string) => {
      nextScalar = v;
    },
  };
}

function qi(mock: ReturnType<typeof mockPool>, t = 'app_user') {
  return new PowqlInterface(mock.pool, t, schema);
}

// ---------------------------------------------------------------------------
// Type mapping
// ---------------------------------------------------------------------------

describe('powdb: type mapping', () => {
  it('maps Turbine types onto the four writable PowQL scalars', () => {
    assert.equal(powqlColumnType(col('id', 'id', 'string', 'text')), 'str');
    assert.equal(powqlColumnType(col('age', 'age', 'number', 'int4')), 'int');
    assert.equal(powqlColumnType(col('score', 'score', 'number', 'float8')), 'float');
    assert.equal(powqlColumnType(col('n', 'n', 'bigint', 'int8')), 'int');
    assert.equal(powqlColumnType(col('active', 'active', 'boolean', 'bool')), 'bool');
    assert.equal(powqlColumnType(col('created', 'created', 'Date', 'timestamptz')), 'int'); // epoch micros
  });

  it('rejects array / bytes / JSON columns (no PowDB equivalent)', () => {
    assert.throws(() => powqlColumnType(col('tags', 'tags', 'string[]', 'text', { isArray: true })), ValidationError);
    assert.throws(() => powqlColumnType(col('blob', 'blob', 'Buffer', 'bytea')), ValidationError);
    assert.throws(() => powqlColumnType(col('meta', 'meta', 'Record<string, unknown>', 'jsonb')), ValidationError);
  });

  it('emits PowQL DDL with required/unique PK and float column', () => {
    const ddl = powqlSchemaDDL(schema);
    const userType = ddl.find((s) => s.startsWith('type app_user'))!;
    assert.match(userType, /required unique id: str/);
    assert.match(userType, /score: float/);
    assert.match(userType, /created_at: int/); // Date → int micros
  });
});

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

describe('powdb: coercion (wire string → JS)', () => {
  const c = (ts: string, pg = 'text', nullable = true) => col('x', 'x', ts, pg, { nullable });
  it('coerces scalars by column type', () => {
    assert.equal(coerceValue('42', c('number', 'int4')), 42);
    assert.equal(coerceValue('9.5', c('number', 'float8')), 9.5);
    assert.equal(coerceValue('true', c('boolean', 'bool')), true);
    assert.equal(coerceValue('false', c('boolean', 'bool')), false);
    assert.deepEqual(coerceValue('1577836800000000', c('Date', 'timestamptz')), new Date('2020-01-01T00:00:00Z'));
  });
  it('resolves the "null" bareword for nullable non-string columns', () => {
    assert.equal(coerceValue('null', c('number', 'int4')), null);
    assert.equal(coerceValue('null', c('boolean', 'bool')), null);
    // a non-nullable string keeps a literal "null"
    assert.equal(coerceValue('null', col('s', 's', 'string', 'text', { nullable: false })), 'null');
  });
  it('rowToEntity maps snake columns to camel fields and coerces', () => {
    const entity = rowToEntity({ id: 'abc', created_at: '1577836800000000', age: '30' }, schema.tables.app_user!);
    assert.equal(entity.id, 'abc');
    assert.equal(entity.age, 30);
    assert.ok(entity.createdAt instanceof Date);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('powdb: wrapPowdbError', () => {
  it('maps PowDB error codes to typed Turbine errors', () => {
    assert.ok(
      wrapPowdbError({ message: 'unique constraint violation on app_user.id' }) instanceof UniqueConstraintError,
    );
    assert.ok(wrapPowdbError({ code: 'connect_failed', message: 'x' }) instanceof ConnectionError);
    assert.ok(wrapPowdbError({ code: 'timeout', message: 'x' }) instanceof TimeoutError);
    assert.ok(wrapPowdbError({ code: 'query_failed', message: 'x' }) instanceof ValidationError);
  });
});

// ---------------------------------------------------------------------------
// PowQL generation — reads
// ---------------------------------------------------------------------------

describe('powdb: findMany generation', () => {
  it('emits filter / order / limit / projection with $N params', async () => {
    const m = mockPool();
    await qi(m).findMany({ where: { age: { gte: 30 } }, orderBy: { name: 'asc' }, limit: 10, offset: 5 });
    const { powql, params } = m.last();
    assert.match(
      powql,
      /^app_user filter \.age >= \$1 order \.name asc limit \$2 offset \$3 \{ \.id, \.name, \.age, \.score, \.active, \.created_at \}$/,
    );
    assert.deepEqual(params, [30, 10, 5]);
  });

  it('select projects only chosen columns plus the PK', async () => {
    const m = mockPool();
    await qi(m).findMany({ where: {}, select: { name: true } } as never);
    assert.match(m.last().powql, /\{ \.id, \.name \}$/);
  });

  it('in / contains / insensitive / OR operators', async () => {
    const m = mockPool();
    await qi(m).findMany({ where: { name: { in: ['a', 'b'] } } });
    assert.match(m.last().powql, /\.name in \(\$1, \$2\)/);

    await qi(m).findMany({ where: { name: { contains: 'x' } } });
    assert.match(m.last().powql, /\.name like \$1/);
    assert.deepEqual(m.last().params, ['%x%']);

    await qi(m).findMany({ where: { name: { equals: 'ada', mode: 'insensitive' } } });
    assert.match(m.last().powql, /lower\(\.name\) = lower\(\$1\)/);

    await qi(m).findMany({ where: { OR: [{ name: 'a' }, { name: 'b' }] } });
    assert.match(m.last().powql, /\(\.name = \$1 or \.name = \$2\)/);
  });

  it('relation filter `some` uses the IN-subquery form (not exists)', async () => {
    const m = mockPool();
    await qi(m).findMany({ where: { posts: { some: { views: { gte: 80 } } } } });
    assert.match(m.last().powql, /\.id in \(post filter \.views >= \$1 \{ \.author_id \}\)/);
  });

  it('count emits count(T filter …) scalar', async () => {
    const m = mockPool();
    m.setScalar('7');
    const n = await qi(m).count({ where: { age: { gte: 30 } } });
    assert.equal(n, 7);
    assert.match(m.last().powql, /^count\(app_user filter \.age >= \$1\)$/);
  });
});

// ---------------------------------------------------------------------------
// PowQL generation — writes (RETURNING + UUID + float $N params)
// ---------------------------------------------------------------------------

describe('powdb: write generation', () => {
  it('create generates a client UUID and reads the row back via `returning`', async () => {
    const m = mockPool();
    m.setRows([{ id: 'fixed', name: 'Ada', age: '36' }]);
    const row = await qi(m).create({ data: { name: 'Ada', age: 36 } });
    const insert = m.calls.find((c) => c.powql.startsWith('insert'))!;
    assert.match(insert.powql, /^insert app_user \{ .*name := \$\d.*age := \$\d.*id := \$\d.* \} returning$/);
    // a 36-char UUID was generated and bound for the PK
    const uuid = insert.params.find((p) => typeof p === 'string' && p.length === 36);
    assert.ok(uuid, 'expected a generated UUID param');
    assert.equal((row as { name: string }).name, 'Ada');
    // No follow-up reselect SELECT — the insert was the only call.
    assert.equal(m.calls.length, 1);
  });

  it('createMany emits a multi-row insert with `returning` and shapes the rows', async () => {
    const m = mockPool();
    m.setRows([
      { id: 'a', name: 'A', age: '1' },
      { id: 'b', name: 'B', age: '2' },
    ]);
    const rows = await qi(m).createMany({
      data: [
        { name: 'A', age: 1 },
        { name: 'B', age: 2 },
      ],
    });
    const insert = m.last();
    assert.match(insert.powql, /^insert app_user \{ .* \}, \{ .* \} returning$/);
    assert.equal(m.calls.length, 1); // no reselect
    assert.equal(rows.length, 2);
    assert.equal((rows[1] as { age: number }).age, 2); // coerced from "2"
  });

  it('update emits `returning` and shapes the post-update row (no reselect)', async () => {
    const m = mockPool();
    m.setRows([{ id: 'a', name: 'Z', age: '40' }]);
    const row = await qi(m).update({ where: { id: 'a' }, data: { name: 'Z' } });
    const upd = m.last();
    assert.match(upd.powql, /^app_user filter \.id = \$1 update \{ name := \$2 \} returning$/);
    assert.equal(m.calls.length, 1);
    assert.equal((row as { name: string }).name, 'Z');
  });

  it('delete emits `returning` and shapes the deleted row (no pre-image reselect)', async () => {
    const m = mockPool();
    m.setRows([{ id: 'a', name: 'Gone', age: '5' }]);
    const row = await qi(m).delete({ where: { id: 'a' } });
    const del = m.last();
    assert.match(del.powql, /^app_user filter \.id = \$1 delete returning$/);
    assert.equal(m.calls.length, 1);
    assert.equal((row as { name: string }).name, 'Gone');
  });

  it('float-column write values are $N params (wrapped PowdbFloatParam), not inlined literals', async () => {
    const m = mockPool();
    m.setRows([{ id: 'a', score: '10' }]);
    await qi(m).update({ where: { id: 'a' }, data: { score: 10, age: { increment: 1 } } });
    const upd = m.calls.find((c) => / update \{/.test(c.powql))!;
    // score (float) is now `:= $N` (not `10.0`); age (int) atomic increment.
    assert.match(upd.powql, /score := \$\d+/);
    assert.doesNotMatch(upd.powql, /score := 10\.0/);
    assert.match(upd.powql, /age := \.age \+ \$/);
    // The float value travels wrapped so the embedded encoder can force a float literal.
    const floatParam = upd.params.find((p) => p instanceof PowdbFloatParam) as PowdbFloatParam | undefined;
    assert.ok(floatParam, 'expected a PowdbFloatParam-wrapped float value');
    assert.equal(floatParam.value, 10);
  });

  it('upsert emits on .pk / on conflict WITHOUT returning (PowDB upsert rejects it)', async () => {
    const m = mockPool();
    m.setRows([{ id: 'a', name: 'X' }]);
    await qi(m).upsert({ where: { id: 'a' }, create: { id: 'a', name: 'X' }, update: { name: 'Y' } });
    const up = m.calls.find((c) => c.powql.startsWith('upsert'))!;
    assert.match(up.powql, /^upsert app_user on \.id \{ .* \} on conflict \{ name := \$\d+ \}$/);
    assert.doesNotMatch(up.powql, /returning/);
    // Upsert (no returning) must reselect by PK — so there is a follow-up SELECT.
    assert.ok(m.calls.some((c) => /^app_user filter \.id = \$1/.test(c.powql.trimStart())));
  });

  it('empty-where guard blocks unscoped updateMany/deleteMany', async () => {
    const m = mockPool();
    await assert.rejects(() => qi(m).updateMany({ where: {}, data: { age: 0 } }), ValidationError);
    await assert.rejects(() => qi(m).deleteMany({ where: {} }), ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Capability guards — "what doesn't make sense on PowDB"
// ---------------------------------------------------------------------------

describe('powdb: capability guards throw E017', () => {
  it('cursor streaming is unsupported', async () => {
    const m = mockPool();
    await assert.rejects(() => qi(m).findManyStream().next(), UnsupportedFeatureError);
  });
  it('vector / JSON / array filters are unsupported', async () => {
    const m = mockPool();
    await assert.rejects(
      () => qi(m).findMany({ where: { score: { distance: { to: [1], metric: 'cosine', lt: 1 } } } as never }),
      UnsupportedFeatureError,
    );
  });
  it('manyToMany nested reads and nested writes are Phase B', async () => {
    const m = mockPool();
    // nested write (relation key in data)
    await assert.rejects(
      () => qi(m).create({ data: { name: 'x', posts: { create: [] } } as never }),
      UnsupportedFeatureError,
    );
  });
});

// ---------------------------------------------------------------------------
// Embedded literal encoder — the security-critical surface (no params on the wire)
// ---------------------------------------------------------------------------

describe('powdb: encodePowqlLiteral (typed encoding)', () => {
  it('encodes scalars by JS type', () => {
    assert.equal(encodePowqlLiteral('hello'), '"hello"');
    assert.equal(encodePowqlLiteral(42), '42'); // integer literal
    assert.equal(encodePowqlLiteral(4.2), '4.2'); // float literal (dot)
    assert.equal(encodePowqlLiteral(true), 'true');
    assert.equal(encodePowqlLiteral(false), 'false');
    assert.equal(encodePowqlLiteral(123n), '123'); // bigint → int literal
    assert.equal(encodePowqlLiteral(null), 'null');
    assert.equal(encodePowqlLiteral(undefined), 'null');
  });

  it('forces a float-form literal for a PowdbFloatParam even when integer-valued', () => {
    assert.equal(encodePowqlLiteral(new PowdbFloatParam(10)), '10.0');
    assert.equal(encodePowqlLiteral(new PowdbFloatParam(10.5)), '10.5');
  });

  it('encodes a Date as epoch micros (int literal)', () => {
    const d = new Date('2020-01-01T00:00:00Z');
    assert.equal(encodePowqlLiteral(d), `${BigInt(d.getTime()) * 1000n}`);
    assert.equal(encodePowqlLiteral(d), '1577836800000000');
  });

  it('rejects unencodable types and non-finite numbers', () => {
    assert.throws(() => encodePowqlLiteral({ a: 1 } as unknown), ValidationError);
    assert.throws(() => encodePowqlLiteral([1, 2] as unknown), ValidationError);
    assert.throws(() => encodePowqlLiteral(Number.NaN), ValidationError);
    assert.throws(() => encodePowqlLiteral(Number.POSITIVE_INFINITY), ValidationError);
    assert.throws(() => encodePowqlLiteral(new PowdbFloatParam(Number.NaN)), ValidationError);
  });

  it('ADVERSARIAL: escapes break-out characters per the PowDB lexer rules', () => {
    // The lexer recognizes only \" \\ \n \t inside a "…" literal; every other
    // char is taken literally. So we escape \ and " (the only break-out vectors)
    // and render \n / \t as their recognized escapes.
    assert.equal(encodePowqlLiteral('a"b'), '"a\\"b"'); // embedded quote escaped
    assert.equal(encodePowqlLiteral('a\\b'), '"a\\\\b"'); // backslash doubled
    assert.equal(encodePowqlLiteral('a\\"b'), '"a\\\\\\"b"'); // backslash + quote
    assert.equal(encodePowqlLiteral('line1\nline2'), '"line1\\nline2"');
    assert.equal(encodePowqlLiteral('a\tb'), '"a\\tb"');
    // A raw CR must stay raw — \r is NOT a lexer escape (would drop the backslash).
    assert.equal(encodePowqlLiteral('a\rb'), '"a\rb"');
  });

  it('ADVERSARIAL: injection payloads round-trip as inert data', () => {
    // None of these can break out of the string literal or start a second statement.
    const inject = '"); drop User; --';
    assert.equal(encodePowqlLiteral(inject), '"\\"); drop User; --"');
    // A trailing backslash must not escape the closing quote.
    assert.equal(encodePowqlLiteral('trailing\\'), '"trailing\\\\"');
    // `$1` as a value is inert text, not a placeholder (it is already inside a literal).
    assert.equal(encodePowqlLiteral('$1'), '"$1"');
    // Unicode / emoji pass through untouched.
    assert.equal(encodePowqlLiteral('café 😀'), '"café 😀"');
  });
});

describe('powdb: materializePowql ($N substitution)', () => {
  it('substitutes positional placeholders with encoded literals', () => {
    const out = materializePowql('insert U { name := $1, age := $2, score := $3 } returning', [
      'Ada',
      36,
      new PowdbFloatParam(9),
    ]);
    assert.equal(out, 'insert U { name := "Ada", age := 36, score := 9.0 } returning');
  });

  it('does not re-substitute a $N that appears inside an encoded string value', () => {
    // The user value "$2" must survive as data; only the template's own $1 is a placeholder.
    const out = materializePowql('U filter .name = $1 { .id }', ['$2']);
    assert.equal(out, 'U filter .name = "$2" { .id }');
  });

  it('handles multi-digit placeholders ($1 vs $10) without collision', () => {
    const params = Array.from({ length: 10 }, (_, i) => i + 1);
    const out = materializePowql('x $10 $1', params);
    assert.equal(out, 'x 10 1');
  });

  it('throws on an out-of-range placeholder', () => {
    assert.throws(() => materializePowql('U filter .id = $2 { .id }', ['only-one']), ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Embedded pool — materializes params into the PowQL text (addon takes no params)
// ---------------------------------------------------------------------------

/** A fake @zvndev/powdb-embedded Database that records the materialized query string. */
function fakeEmbeddedDb(result: Record<string, unknown> = { kind: 'ok', affected: 1n }) {
  const seen: string[] = [];
  const db = {
    query(powql: string) {
      seen.push(powql);
      return result;
    },
    querySql: (sql: string) => ({ kind: 'message', message: sql }),
    queryReadonly: (powql: string) => ({ kind: 'message', message: powql }),
    isPoisoned: () => false,
  };
  // PowdbEmbeddedPool's constructor takes the EmbeddedDatabase interface.
  return { pool: new PowdbEmbeddedPool(db as never), seen };
}

describe('powdb: PowdbEmbeddedPool param materialization', () => {
  it('materializes $N params into the PowQL text before calling the addon', async () => {
    const { pool, seen } = fakeEmbeddedDb({
      kind: 'rows',
      columns: ['id', 'name'],
      rows: [['u1', 'Ada']],
    });
    const res = await pool.query('insert app_user { id := $1, name := $2 } returning', ['u1', 'Ada']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'insert app_user { id := "u1", name := "Ada" } returning');
    // The 'rows' result is adapted into pg-compat row objects keyed by column name.
    assert.deepEqual(res.rows, [{ id: 'u1', name: 'Ada' }]);
  });

  it('encodes an adversarial string value safely (cannot break out / inject)', async () => {
    const { pool, seen } = fakeEmbeddedDb();
    await pool.query('insert app_user { name := $1 }', ['a"b\\c']);
    assert.equal(seen[0], 'insert app_user { name := "a\\"b\\\\c" }');
  });

  it('adapts an {affected} result into a rowCount', async () => {
    const { pool } = fakeEmbeddedDb({ kind: 'ok', affected: 3n });
    const res = await pool.query('app_user filter .age > $1 delete', [18]);
    assert.equal(res.rowCount, 3);
    assert.deepEqual(res.rows, []);
  });

  it('connect() returns a client that materializes on the shared handle', async () => {
    const { pool, seen } = fakeEmbeddedDb();
    const client = await pool.connect();
    await client.query('begin');
    await client.query('insert app_user { id := $1 }', ['x']);
    await client.query('commit');
    client.release();
    assert.deepEqual(seen, ['begin', 'insert app_user { id := "x" }', 'commit']);
  });
});
