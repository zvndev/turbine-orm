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
import { TurbineClient } from '../client.js';
import {
  ConnectionError,
  NotNullViolationError,
  TimeoutError,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.js';
import {
  assertSupportedPowdbVersion,
  coerceValue,
  encodePowqlLiteral,
  materializePowql,
  PowdbEmbeddedPool,
  PowdbFloatParam,
  PowdbPool,
  type PowdbPoolOptions,
  parsePowdbUrl,
  powdbDialect,
  powqlColumnType,
  powqlSchemaDDL,
  quotePowqlIdent,
  rowToEntity,
  turbinePowDB,
  wrapPowdbError,
} from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { DeferredQuery } from '../query/index.js';
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

  it('emits the `auto` modifier for a server-generated int PK', () => {
    const s: SchemaMetadata = {
      enums: {},
      tables: {
        widget: table('widget', [
          col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
          col('label', 'label', 'string', 'text'),
        ]),
      },
    };
    const ddl = powqlSchemaDDL(s);
    assert.match(ddl[0]!, /required unique auto id: int/);
  });

  it('does NOT mark composite-PK columns individually unique (PowDB has no composite unique)', () => {
    const junction: TableMetadata = {
      ...table('user_tags', [col('user_id', 'userId', 'number', 'int8'), col('tag_id', 'tagId', 'number', 'int8')]),
      primaryKey: ['user_id', 'tag_id'],
      uniqueColumns: [],
    };
    const ddl = powqlSchemaDDL({ enums: {}, tables: { user_tags: junction } } as SchemaMetadata);
    assert.match(ddl[0]!, /required user_id: int/);
    assert.match(ddl[0]!, /required tag_id: int/);
    assert.ok(!/unique/.test(ddl[0]!), 'composite-PK columns must not be marked unique');
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
  it('maps networked PowDB error codes to typed Turbine errors', () => {
    assert.ok(
      wrapPowdbError({ message: 'unique constraint violation on app_user.id' }) instanceof UniqueConstraintError,
    );
    assert.ok(wrapPowdbError({ code: 'connect_failed', message: 'x' }) instanceof ConnectionError);
    assert.ok(wrapPowdbError({ code: 'timeout', message: 'x' }) instanceof TimeoutError);
    assert.ok(wrapPowdbError({ code: 'query_failed', message: 'x' }) instanceof ValidationError);
  });

  it('maps EMBEDDED napi errors (code:GenericFailure) by message shape', () => {
    // The embedded addon tags EVERY error code:'GenericFailure' — the class can
    // only be recovered from the message. These are real engine message shapes.
    const notNull = wrapPowdbError({
      code: 'GenericFailure',
      message: `query failed: Execution("column 'email' is required but no value was provided")`,
    });
    assert.ok(notNull instanceof NotNullViolationError);
    assert.equal((notNull as NotNullViolationError).column, 'email');

    const typeMismatch = wrapPowdbError({
      code: 'GenericFailure',
      message: `query failed: Execution("type mismatch for column 'id': expected Int, got str")`,
    });
    assert.ok(typeMismatch instanceof ValidationError);

    const parse = wrapPowdbError({ code: 'GenericFailure', message: `query failed: Parse("unexpected token")` });
    assert.ok(parse instanceof ValidationError);

    const storage = wrapPowdbError({
      code: 'GenericFailure',
      message: `query failed: StorageError("row too large: 5000 exceeds max 4070 bytes")`,
    });
    assert.ok(storage instanceof ValidationError);

    const unique = wrapPowdbError({
      code: 'GenericFailure',
      message: 'unique constraint violation on app_user.id',
    });
    assert.ok(unique instanceof UniqueConstraintError);
  });

  it('maps a not-null message on the NETWORKED path too (no longer collapses to E003)', () => {
    const e = wrapPowdbError({ code: 'query_failed', message: "column 'name' is required, no value" });
    assert.ok(e instanceof NotNullViolationError);
  });

  it('preserves the original error as .cause', () => {
    const raw = { code: 'GenericFailure', message: `Execution("column 'x' is required")` };
    const wrapped = wrapPowdbError(raw) as NotNullViolationError;
    assert.equal((wrapped as { cause?: unknown }).cause, raw);
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

  it('relation filter `some` resolves client-side to a literal in-list (never an IN-subquery)', async () => {
    // PowDB caches a subquery's result by plan shape, ignoring the literal, so a
    // second IN-subquery of the same shape returns stale rows. Turbine therefore
    // resolves the inner predicate to keys first, then filters with `in (list)`.
    const m = mockPool();
    m.setRows([
      { id: 'p1', author_id: 'u7' },
      { id: 'p2', author_id: 'u9' },
    ]);
    await qi(m).findMany({ where: { posts: { some: { views: { gte: 80 } } } } });
    // 1) a resolution query selects the child FK on the target table
    assert.ok(
      m.calls.some((c) => /^post filter \.views >= \$1 \{/.test(c.powql.trimStart())),
      'expected a resolution query on the post table',
    );
    // 2) the main query filters by a literal in-list of the resolved keys — no subquery
    const main = m.last();
    assert.match(main.powql, /\.id in \(\$\d/);
    assert.ok(!/in \(post filter/.test(main.powql), 'must NOT emit an IN-subquery');
    assert.deepEqual(main.params, ['u7', 'u9']);
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

  it('FIX 1: guard gates on the COMPILED filter — combinators that compile empty are refused', async () => {
    // These pass the old shape-based check (they HAVE keys) but compile to an
    // empty PowQL filter — so they must be rejected and emit no write.
    const cases: Record<string, unknown>[] = [
      { OR: [] },
      { AND: [] },
      { NOT: {} },
      { id: undefined },
      { OR: [{ name: undefined }] },
    ];
    for (const where of cases) {
      const m = mockPool();
      await assert.rejects(
        () => qi(m).updateMany({ where: where as never, data: { age: 0 } }),
        ValidationError,
        `updateMany should reject ${JSON.stringify(where)}`,
      );
      await assert.rejects(
        () => qi(m).update({ where: where as never, data: { age: 0 } }),
        ValidationError,
        `update should reject ${JSON.stringify(where)}`,
      );
      await assert.rejects(
        () => qi(m).deleteMany({ where: where as never }),
        ValidationError,
        `deleteMany should reject ${JSON.stringify(where)}`,
      );
      await assert.rejects(
        () => qi(m).delete({ where: where as never }),
        ValidationError,
        `delete should reject ${JSON.stringify(where)}`,
      );
      // No write PowQL was ever emitted.
      assert.equal(m.calls.length, 0, `no query should run for ${JSON.stringify(where)}`);
    }
  });

  it('FIX 1: a real predicate still compiles + runs; allowFullTableScan opts in', async () => {
    const m = mockPool();
    await qi(m).updateMany({ where: { age: { gte: 18 } }, data: { age: 0 } });
    assert.match(m.last().powql, /^app_user filter \.age >= \$1 update \{ age := \$2 \}$/);

    const m2 = mockPool();
    await qi(m2).updateMany({ where: {}, allowFullTableScan: true, data: { age: 0 } });
    assert.match(m2.last().powql, /^app_user update \{ age := \$1 \}$/);
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
  it('createMany/upsert reject nested-write relation data (only create/update support it)', async () => {
    const m = mockPool();
    await assert.rejects(
      () => qi(m).createMany({ data: [{ name: 'x', posts: { create: [] } }] as never }),
      UnsupportedFeatureError,
    );
    await assert.rejects(
      () => qi(m).upsert({ where: { id: 'x' }, create: { name: 'x', posts: { create: [] } }, update: {} } as never),
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
function fakeEmbeddedDb(
  result: Record<string, unknown> = { kind: 'ok', affected: 1n },
  options: PowdbPoolOptions = {},
) {
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
  return { pool: new PowdbEmbeddedPool(db as never, options), seen };
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

// ---------------------------------------------------------------------------
// FIX 2 — single-writer transaction model
// ---------------------------------------------------------------------------

describe('powdb: transaction model (single-writer)', () => {
  it('powdbDialect savepoint keywords throw E017 (no nested tx)', () => {
    assert.throws(() => powdbDialect.savepointStatement('sp_1'), UnsupportedFeatureError);
    assert.throws(() => powdbDialect.releaseSavepointStatement('sp_1'), UnsupportedFeatureError);
    assert.throws(() => powdbDialect.rollbackToSavepointStatement('sp_1'), UnsupportedFeatureError);
    // begin/commit/rollback are the real lowercase PowQL keywords (single-level tx works).
    assert.equal(powdbDialect.beginStatement(), 'begin');
    assert.equal(powdbDialect.commitStatement(), 'commit');
    assert.equal(powdbDialect.rollbackStatement(), 'rollback');
  });

  it('a second same-context raw begin QUEUES behind the open manual tx (markers are callback-scoped)', async () => {
    // Since the Capa cold-burst fix, the re-entrancy marker exists ONLY inside
    // a $transaction callback's async subtree. A manual raw `begin` span does
    // not mark its caller, so a second begin from the same context is treated
    // as an independent concurrent transaction: it waits FIFO for the manual
    // commit instead of throwing E017 (the old contract) or hitting the engine.
    const { pool, seen } = fakeEmbeddedDb();
    await pool.query('begin');
    const second = (async () => {
      const c = await pool.connect();
      await c.query('begin');
      await c.query('commit');
      c.release();
    })();
    await drainMicrotasks();
    assert.deepEqual(seen, ['begin'], 'the second begin must still be queued while the manual tx is open');
    await pool.query('commit');
    await second;
    assert.deepEqual(seen, ['begin', 'commit', 'begin', 'commit'], 'strict FIFO serialization');
  });

  it('PowdbEmbeddedPool clears the flag on connect().release() (timeout safety net)', async () => {
    const { pool } = fakeEmbeddedDb();
    const client = await pool.connect();
    await client.query('begin');
    // Releasing without an explicit commit/rollback must not wedge the pool.
    client.release();
    await assert.doesNotReject(() => pool.query('begin'));
  });

  it('recognizes the SQL-spelling transaction keywords case-insensitively', async () => {
    const { pool, seen } = fakeEmbeddedDb(undefined, { transactionQueueTimeoutMs: 25 });
    await pool.query('BEGIN TRANSACTION');
    // 'start transaction' is recognized as a begin: it queues on the gate
    // (timing out here) instead of being forwarded into the open transaction.
    await assert.rejects(() => pool.query('start transaction'), TimeoutError);
    assert.deepEqual(seen, ['BEGIN TRANSACTION'], 'the queued begin never reached the engine');
    await pool.query('ROLLBACK');
    await assert.doesNotReject(() => pool.query('begin'));
    await pool.query('commit');
  });

  it('REVIEW 1: a stray commit/rollback with no gate hold never reaches the embedded engine', async () => {
    const { pool, seen } = fakeEmbeddedDb();
    // No begin ever ran in this scope — e.g. a "best-effort" ROLLBACK issued
    // after a begin that failed its queue timeout. On the ONE shared handle,
    // forwarding it would end whatever transaction ANOTHER caller has open.
    const rolled = await pool.query('rollback');
    assert.deepEqual(rolled.rows, []);
    await pool.query('commit');
    assert.deepEqual(seen, [], 'the stray commit/rollback must not hit the engine');
    // A checked-out client that never began is guarded the same way.
    const client = await pool.connect();
    await client.query('rollback');
    client.release();
    assert.deepEqual(seen, []);
    // A REAL transaction still forwards its own control statements.
    await pool.query('begin');
    await pool.query('commit');
    assert.deepEqual(seen, ['begin', 'commit']);
  });

  it('REVIEW 1 (networked): a stray commit/rollback with no gate hold never reaches the wire', async () => {
    const fake = fakeNetworkedClientPool();
    const pool = new PowdbPool(fake.pool);
    await pool.query('rollback');
    await pool.query('commit');
    assert.deepEqual(fake.sent, []);
    const client = await pool.connect();
    await client.query('rollback');
    client.release();
    assert.deepEqual(fake.sent, []);
    // A real begin…commit through a checked-out client still hits the wire.
    const c2 = await pool.connect();
    await c2.query('begin');
    await c2.query('commit');
    c2.release();
    assert.deepEqual(fake.sent, ['begin', 'commit']);
  });
});

// ---------------------------------------------------------------------------
// Cross-pool re-entrancy — the ALS marker is a CHAIN, so a transaction on a
// second pool cannot shadow the outer pool's marker (single-slot storage).
// ---------------------------------------------------------------------------

describe('powdb: cross-pool re-entrancy (chained ALS marker)', () => {
  it("REVIEW 2: an inner begin on the OUTER pool throws E017 even with another pool's tx in between", async () => {
    // dbA tx → dbB tx → dbA tx. dbB's marker goes innermost, chaining to dbA's
    // (PowdbTxContext.parent); the chain walk must find the live dbA ancestor
    // and throw re-entrant E017 instead of queueing behind dbA's own open
    // transaction (deadlock until the queue timeout).
    const a = fakeEmbeddedDb();
    const b = fakeEmbeddedDb();
    const dbA = new TurbineClient({ pool: a.pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    const dbB = new TurbineClient({ pool: b.pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    await assert.rejects(
      dbA.$transaction(async () => {
        await dbB.$transaction(async () => {
          await dbA.$transaction(async () => 'inner'); // re-entrant on A through B's context
        });
      }),
      UnsupportedFeatureError,
    );
    // Both gates recovered: done markers are pruned, fresh transactions pass.
    assert.equal(await dbA.$transaction(async () => 'a-after'), 'a-after');
    assert.equal(await dbB.$transaction(async () => 'b-after'), 'b-after');
    assert.deepEqual(a.seen, ['begin', 'rollback', 'begin', 'commit']);
    assert.deepEqual(b.seen, ['begin', 'rollback', 'begin', 'commit']);
  });
});

// ---------------------------------------------------------------------------
// Capa regression (ITEM 3): the re-entrancy marker is scoped to the
// transaction CALLBACK's async subtree. acquire() used to enterWith() the
// marker into the CALLER's context, so a context that merely had a begin in
// its await chain was falsely flagged re-entrant: on a cold client, the first
// same-tick burst of db.$transaction calls saw call #1's live marker from
// every sibling (9/10 rejected E017 in production).
// ---------------------------------------------------------------------------

describe('powdb: re-entrancy marker never leaks into the caller context (Capa cold-burst fix)', () => {
  it('a context that opened a manual tx is not falsely re-entrant: $transaction queues FIFO', async () => {
    const { pool, seen } = fakeEmbeddedDb();
    const db = new TurbineClient({ pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    // Open a manual transaction from THIS context. Before the fix, acquire()'s
    // enterWith() left a LIVE marker in this context, and the $transaction
    // below threw instant E017 even though queueing it is perfectly safe. This is
    // the deterministic reduction of the cold-client same-tick burst: a live
    // marker visible from a context that is NOT inside any tx callback.
    await pool.query('begin');
    const queued = db.$transaction(async () => 'queued-ok');
    await drainMicrotasks();
    assert.deepEqual(seen, ['begin'], 'the $transaction begin must queue behind the manual tx');
    await pool.query('commit');
    assert.equal(await queued, 'queued-ok');
    assert.deepEqual(seen, ['begin', 'commit', 'begin', 'commit']);
  });

  it('10 db.$transaction calls launched in the SAME synchronous tick on a fresh client all succeed', async () => {
    const { pool } = fakeEmbeddedDb();
    const db = new TurbineClient({ pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    // The reported cold-client shape: no prior transaction on this client,
    // all launches in one tick: zero E017, strict FIFO success.
    const ps = Array.from({ length: 10 }, (_, i) => db.$transaction(async () => i));
    assert.deepEqual(await Promise.all(ps), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('sequential awaited transactions from one long-lived context never chain into false E017', async () => {
    const { pool } = fakeEmbeddedDb();
    const db = new TurbineClient({ pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    for (let i = 0; i < 5; i++) {
      assert.equal(await db.$transaction(async () => i), i);
    }
  });
});

// ---------------------------------------------------------------------------
// Batch pipelining — the networked driver advertises FIFO in-flight support,
// so `$transaction([...])` dispatches all statements in one write burst.
// ---------------------------------------------------------------------------

/** Let the promise chain progress until it blocks on an unresolved reply. */
function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * A fake `@zvndev/powdb-client` pool with ONE client whose non-transaction
 * queries stay pending until the test releases them — so "dispatched before
 * any reply" assertions are exact, never timing-based. Mirrors the real
 * client's contract: requests are written immediately, replies match FIFO.
 */
function fakeNetworkedClientPool() {
  const sent: string[] = [];
  const pending: { powql: string; resolve: (r: unknown) => void; reject: (e: Error) => void }[] = [];
  const client = {
    serverVersion: '0.8.0',
    query(powql: string, _params?: unknown[]) {
      sent.push(powql);
      if (powql === 'begin' || powql === 'commit' || powql === 'rollback') {
        return Promise.resolve({ kind: 'message', message: 'ok' });
      }
      return new Promise((resolve, reject) => {
        pending.push({ powql, resolve, reject });
      });
    },
    close: async () => {},
  };
  const pool = {
    acquire: async () => client,
    release() {},
    destroy() {},
    withClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    close: async () => {},
  };
  return { pool: pool as unknown as ConstructorParameters<typeof PowdbPool>[0], sent, pending };
}

describe('powdb: batch $transaction pipelining (networked driver)', () => {
  it('PowdbPool.connect() advertises supportsPipelining', async () => {
    const fake = fakeNetworkedClientPool();
    const client = await new PowdbPool(fake.pool).connect();
    assert.equal(client.supportsPipelining, true);
    client.release();
  });

  it('PowdbEmbeddedPool.connect() does NOT (in-process, nothing to pipeline)', async () => {
    const { pool } = fakeEmbeddedDb();
    const client = await pool.connect();
    assert.equal(client.supportsPipelining, undefined);
    client.release();
  });

  it('dispatches every batch statement before any reply arrives, inside begin…commit', async () => {
    const fake = fakeNetworkedClientPool();
    const db = new TurbineClient({ pool: new PowdbPool(fake.pool), dialect: powdbDialect }, { tables: {}, enums: {} });

    const dq = (powql: string): DeferredQuery<number> => ({
      sql: powql,
      params: [],
      tag: 'raw',
      transform: (r) => r.rowCount ?? -1,
    });
    const batch = db.$transaction([dq('app_user filter .age > 27 update { active := false }'), dq('post delete')]);
    await drainMicrotasks();

    // Both statements hit the wire while zero replies have arrived (1 round
    // trip of waiting instead of one per statement).
    assert.deepEqual(fake.sent, ['begin', 'app_user filter .age > 27 update { active := false }', 'post delete']);
    assert.equal(fake.pending.length, 2, 'both statements in flight at once');

    fake.pending[0]!.resolve({ kind: 'ok', affected: 3n });
    fake.pending[1]!.resolve({ kind: 'ok', affected: 5n });

    assert.deepEqual(await batch, [3, 5], 'results stay positional and pg-compat adapted');
    assert.equal(fake.sent.at(-1), 'commit', 'commit only after every reply');
  });

  it('a mid-batch failure rolls back and surfaces the wrapped first error', async () => {
    const fake = fakeNetworkedClientPool();
    const db = new TurbineClient({ pool: new PowdbPool(fake.pool), dialect: powdbDialect }, { tables: {}, enums: {} });

    const dq = (powql: string): DeferredQuery<number> => ({
      sql: powql,
      params: [],
      tag: 'raw',
      transform: (r) => r.rowCount ?? -1,
    });
    const batch = db.$transaction([dq('insert app_user { id := "u1" } returning'), dq('post delete')]);
    await drainMicrotasks();
    assert.equal(fake.pending.length, 2, 'pipelined: the statement after the failure was already sent');

    fake.pending[0]!.reject(
      Object.assign(new Error('query failed: unique constraint violation on app_user.id'), {
        code: 'query_failed',
      }),
    );
    fake.pending[1]!.resolve({ kind: 'ok', affected: 1n });

    await assert.rejects(batch, UniqueConstraintError);
    assert.equal(fake.sent.at(-1), 'rollback', 'rolled back after draining in-flight replies');
    assert.ok(!fake.sent.includes('commit'), 'never committed');
  });
});

// ---------------------------------------------------------------------------
// FIX 6 — connection-string parsing + version guard
// ---------------------------------------------------------------------------

describe('powdb: parsePowdbUrl', () => {
  it('parses powdb://host:port with defaults', () => {
    assert.deepEqual(parsePowdbUrl('powdb://127.0.0.1:5463'), { host: '127.0.0.1', port: 5463 });
    assert.deepEqual(parsePowdbUrl('powdb://localhost'), { host: 'localhost', port: 5433 });
  });

  it('parses user / password / db name', () => {
    const opts = parsePowdbUrl('powdb://alice:s%40cret@db.host:6000/appdb');
    assert.equal(opts.host, 'db.host');
    assert.equal(opts.port, 6000);
    assert.equal(opts.user, 'alice');
    assert.equal(opts.password, 's@cret'); // URL-decoded
    assert.equal(opts.dbName, 'appdb');
  });

  it('rejects a non-powdb scheme and a malformed URL', () => {
    assert.throws(() => parsePowdbUrl('postgres://x:5432'), ConnectionError);
    assert.throws(() => parsePowdbUrl('not a url'), ConnectionError);
  });
});

describe('powdb: assertSupportedPowdbVersion', () => {
  it('accepts >= 0.7.0', () => {
    assert.doesNotThrow(() => assertSupportedPowdbVersion('0.7.0'));
    assert.doesNotThrow(() => assertSupportedPowdbVersion('0.8.2'));
    assert.doesNotThrow(() => assertSupportedPowdbVersion('1.0.0'));
    assert.doesNotThrow(() => assertSupportedPowdbVersion('0.7.0-rc1'));
  });

  it('rejects < 0.7.0 with a ConnectionError', () => {
    assert.throws(() => assertSupportedPowdbVersion('0.6.2'), ConnectionError);
    assert.throws(() => assertSupportedPowdbVersion('0.1.0'), ConnectionError);
  });

  it('tolerates an unknown / non-semver version (cannot prove too old)', () => {
    assert.doesNotThrow(() => assertSupportedPowdbVersion(undefined));
    assert.doesNotThrow(() => assertSupportedPowdbVersion(''));
    assert.doesNotThrow(() => assertSupportedPowdbVersion('dev'));
  });
});

// ---------------------------------------------------------------------------
// T-7 — concurrent transactions queue FIFO on the single-writer gate instead
// of failing fast with E017. Re-entrant transactions (which queueing would
// deadlock) still throw. Queue waits are bounded by transactionQueueTimeoutMs.
// ---------------------------------------------------------------------------

/**
 * Run one begin…marker…commit transaction through a checked-out client. The
 * `await pool.connect()` before `begin` matters: it puts the transaction in
 * its own async continuation — like any real concurrent caller — so begin's
 * re-entrancy marker stays confined to this transaction's context instead of
 * leaking into the test's.
 */
async function runClientTx(pool: PowdbEmbeddedPool, marker: string): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`note ${marker}`);
    await client.query('commit');
    return marker;
  } finally {
    client.release();
  }
}

describe('powdb: concurrent transactions queue FIFO (single-writer gate)', () => {
  it('10 concurrent transactions all succeed, serialized in submission order', async () => {
    const { pool, seen } = fakeEmbeddedDb();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => runClientTx(pool, `t${i}`)));
    assert.deepEqual(
      results,
      Array.from({ length: 10 }, (_, i) => `t${i}`),
    );
    // Strict serialization: every begin…commit span is contiguous, in FIFO order.
    const expected = Array.from({ length: 10 }, (_, i) => ['begin', `note t${i}`, 'commit']).flat();
    assert.deepEqual(seen, expected);
  });

  it('a second db.$transaction queues (no begin on the wire) until the first commits', async () => {
    const fake = fakeNetworkedClientPool();
    const db = new TurbineClient({ pool: new PowdbPool(fake.pool), dialect: powdbDialect }, { tables: {}, enums: {} });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p1 = db.$transaction(async () => {
      await firstGate;
      return 1;
    });
    const p2 = db.$transaction(async () => 2);
    await drainMicrotasks();
    assert.deepEqual(fake.sent, ['begin'], 'the second begin waits in the queue, never racing the open tx');
    releaseFirst();
    assert.deepEqual(await Promise.all([p1, p2]), [1, 2]);
    assert.deepEqual(fake.sent, ['begin', 'commit', 'begin', 'commit']);
  });

  it('a failed transaction rolls back and hands the gate to the next in line', async () => {
    const { pool, seen } = fakeEmbeddedDb();
    const db = new TurbineClient({ pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    const p1 = db.$transaction(async () => {
      throw new Error('boom');
    });
    const p2 = db.$transaction(async () => 'second');
    await assert.rejects(p1, /boom/);
    assert.equal(await p2, 'second');
    assert.deepEqual(seen, ['begin', 'rollback', 'begin', 'commit']);
  });
});

describe('powdb: re-entrant transactions still throw E017 (queueing would deadlock)', () => {
  it('db.$transaction inside an active db.$transaction callback throws, then the queue recovers', async () => {
    const { pool } = fakeEmbeddedDb();
    const db = new TurbineClient({ pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    await assert.rejects(
      db.$transaction(async () => {
        // The outer callback awaits an inner db.$transaction — the inner would
        // queue behind the outer's lock while the outer waits on the inner:
        // a deadlock. The gate detects the shared async context and throws.
        await db.$transaction(async () => 'inner');
      }),
      UnsupportedFeatureError,
    );
    // The gate is not wedged: a fresh transaction runs fine afterwards.
    assert.equal(await db.$transaction(async () => 'after'), 'after');
  });

  it('the same re-entrant shape throws on the networked pool too', async () => {
    const fake = fakeNetworkedClientPool();
    const db = new TurbineClient({ pool: new PowdbPool(fake.pool), dialect: powdbDialect }, { tables: {}, enums: {} });
    await assert.rejects(
      db.$transaction(async () => {
        await db.$transaction(async () => 'inner');
      }),
      UnsupportedFeatureError,
    );
    assert.equal(await db.$transaction(async () => 'after'), 'after');
  });

  it('nested tx.$transaction throws E017 via the savepoint override', async () => {
    const { pool } = fakeEmbeddedDb();
    const db = new TurbineClient({ pool, dialect: powdbDialect }, { tables: {}, enums: {} });
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$transaction(async () => {});
      }),
      UnsupportedFeatureError,
    );
  });
});

describe('powdb: transaction queue timeout', () => {
  it('a queued transaction fails with TimeoutError after transactionQueueTimeoutMs', async () => {
    const { pool } = fakeEmbeddedDb(undefined, { transactionQueueTimeoutMs: 25 });
    const holder = await pool.connect();
    await (async () => {
      await Promise.resolve(); // own async context — see runClientTx
      await holder.query('begin');
    })();
    await assert.rejects(
      (async () => {
        await Promise.resolve();
        await pool.query('begin');
      })(),
      TimeoutError,
    );
    // The timed-out waiter gave up its queue slot: once the holder finishes,
    // the next transaction proceeds instead of stalling behind a dead slot.
    await holder.query('rollback');
    holder.release();
    assert.equal(await runClientTx(pool, 'after-timeout'), 'after-timeout');
  });

  it('transactionQueueTimeoutMs: 0 waits without limit', async () => {
    const { pool } = fakeEmbeddedDb(undefined, { transactionQueueTimeoutMs: 0 });
    const holder = await pool.connect();
    await (async () => {
      await Promise.resolve();
      await holder.query('begin');
    })();
    let began = false;
    const queued = (async () => {
      await Promise.resolve();
      await pool.query('begin');
      began = true;
      await pool.query('commit');
    })();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(began, false, 'still queued after 60ms — no default timeout applied');
    await holder.query('commit');
    holder.release();
    await queued;
    assert.equal(began, true);
  });

  it('turbinePowDB plumbs transactionQueueTimeoutMs through to the pool', async () => {
    const fake = fakeNetworkedClientPool();
    const db = await turbinePowDB(fake.pool as never, { tables: {}, enums: {} }, { transactionQueueTimeoutMs: 20 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const p1 = db.$transaction(async () => {
      await firstGate;
      return 1;
    });
    await drainMicrotasks();
    await assert.rejects(
      db.$transaction(async () => 2),
      TimeoutError,
    );
    releaseFirst();
    assert.equal(await p1, 1);
  });
});

// ---------------------------------------------------------------------------
// N-6 — warnOnUnlimited per-table map handling on the PowQL interface.
// PowqlInterface previously treated an object map as plain truthy, so ANY map
// (even `{ userProfiles: false }` for this exact table) left the warning on.
// It now applies the same per-table resolution as QueryInterface: snake_case
// table name OR camelCase accessor key, snake_case winning on conflict.
// ---------------------------------------------------------------------------

describe('powdb: warnOnUnlimited per-table map (N-6)', () => {
  const profilesSchema: SchemaMetadata = {
    enums: {},
    tables: {
      user_profiles: table('user_profiles', [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('bio', 'bio', 'string', 'text'),
      ]),
    },
  };

  async function warningsFor(warnOnUnlimited?: boolean | Record<string, boolean>): Promise<string[]> {
    const mock = mockPool();
    const q = new PowqlInterface(mock.pool, 'user_profiles', profilesSchema, [], { warnOnUnlimited });
    const captured: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    try {
      await q.findMany({});
    } finally {
      console.warn = original;
    }
    return captured;
  }

  it('warns by default without a limit', async () => {
    const warnings = await warningsFor(undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /user_profiles/);
  });

  it('accessor-keyed map ({ userProfiles: false }) suppresses the warning', async () => {
    assert.deepEqual(await warningsFor({ userProfiles: false }), []);
  });

  it('snake-keyed map ({ user_profiles: false }) suppresses the warning', async () => {
    assert.deepEqual(await warningsFor({ user_profiles: false }), []);
  });

  it('snake_case wins on conflict', async () => {
    const warnings = await warningsFor({ user_profiles: true, userProfiles: false });
    assert.equal(warnings.length, 1);
  });

  it('a map naming OTHER tables keeps the default (warn)', async () => {
    const warnings = await warningsFor({ posts: false });
    assert.equal(warnings.length, 1);
  });
});

// ---------------------------------------------------------------------------
// PowQL reserved-word quoting (PowDB ≥ 0.10 backticks) + gate-timeout mapping
// ---------------------------------------------------------------------------

describe('powdb: reserved-word identifiers are backtick-quoted in bare positions', () => {
  // A table named `order` with columns named `type` and `limit` — all PowQL
  // keywords. Dotted references (.type in filters/projections) bypass keyword
  // lookup on every engine version and must stay bare for ≤0.9 compat.
  const kwSchema: SchemaMetadata = {
    enums: {},
    tables: {
      order: table('order', [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('type', 'type', 'string', 'text'),
        col('limit', 'limit', 'number', 'int4', { nullable: true }),
        col('name', 'name', 'string', 'text', { nullable: true }),
      ]),
    },
  };
  const kwQi = (m: ReturnType<typeof mockPool>) => new PowqlInterface(m.pool, 'order', kwSchema);

  it('quotePowqlIdent quotes keywords and illegal identifiers, passes normal names through', () => {
    assert.equal(quotePowqlIdent('order'), '`order`');
    assert.equal(quotePowqlIdent('schema'), '`schema`'); // new v0.10 keyword
    assert.equal(quotePowqlIdent('describe'), '`describe`'); // new v0.10 keyword
    assert.equal(quotePowqlIdent('users'), 'users');
    assert.equal(quotePowqlIdent('Order'), 'Order'); // keyword match is case-sensitive
    assert.equal(quotePowqlIdent('full name'), '`full name`');
    assert.throws(() => quotePowqlIdent('back`tick'), /backtick/);
  });

  it('powqlSchemaDDL quotes keyword type and field names (incl. index DDL)', () => {
    const uniq = { ...kwSchema.tables.order!, uniqueColumns: [['id'], ['type']] };
    const ddl = powqlSchemaDDL({ enums: {}, tables: { order: uniq } });
    assert.match(ddl[0]!, /^type `order` \{/);
    assert.match(ddl[0]!, /required `type`: str/);
    assert.match(ddl[0]!, /`limit`: int/);
    assert.match(ddl[0]!, /required unique id: str/); // normal names stay bare
    assert.equal(ddl[1], 'alter `order` add unique .`type`');
  });

  it('insert/update/upsert quote the table ref and assignment targets; dotted refs stay bare', async () => {
    const m = mockPool();
    m.setRows([{ id: 'x', type: 'news', limit: null, name: null }]);
    await kwQi(m).create({ data: { type: 'news' } as never });
    assert.match(m.last().powql, /^insert `order` \{ /);
    assert.match(m.last().powql, /`type` := \$\d/);

    await kwQi(m).update({ where: { type: 'news' }, data: { limit: { increment: 1 } } as never });
    // filter uses the dotted ref (bare); the assignment target is quoted.
    assert.match(m.last().powql, /^`order` filter \.type = \$1 update \{ `limit` := \.limit \+ \$2 \} returning$/);

    await kwQi(m).upsert({
      where: { id: 'x' },
      create: { id: 'x', type: 'a' },
      update: { type: 'b' },
    } as never);
    const upsert = m.calls.find((c) => c.powql.startsWith('upsert'))!;
    assert.match(upsert.powql, /^upsert `order` on \.id \{ /);
    assert.match(upsert.powql, /`type` := \$\d/);
  });

  it('findMany quotes the table ref only — filter/order/projection stay dotted-bare', async () => {
    const m = mockPool();
    await kwQi(m).findMany({ where: { type: 'news' }, orderBy: { limit: 'asc' }, limit: 5 });
    assert.match(
      m.last().powql,
      /^`order` filter \.type = \$1 order \.limit asc limit \$2 \{ \.id, \.type, \.limit, \.name \}$/,
    );
  });
});

describe('powdb: server tx-gate timeout maps to TimeoutError (PowDB ≥ 0.10)', () => {
  it('maps the message shape on both transports', () => {
    assert.ok(
      wrapPowdbError({ code: 'query_failed', message: 'transaction gate timeout after 5000ms' }) instanceof
        TimeoutError,
    );
    assert.ok(wrapPowdbError({ code: 'GenericFailure', message: 'Transaction gate timeout' }) instanceof TimeoutError);
  });
});

// ---------------------------------------------------------------------------
// Capa regression (ITEM 1): owned-pool disconnect() must close every driver
// client. client.ts treats TurbineConfig.pool as external (ownsPool = false)
// and skips pool.end(), so turbinePowDB patches disconnect()/end() on owned
// pools; and the driver Pool.close() only closes IDLE clients, so
// PowdbPool.end() destroys any still checked out.
// ---------------------------------------------------------------------------

/**
 * A fake `@zvndev/powdb-client` module whose Pool mirrors the real dist
 * (`clients/ts/src/pool.ts`) semantics that matter here: `acquire` reuses an
 * idle client or creates one, `release` returns to idle (or closes when the
 * pool is closed), `destroy`/`close` close clients. Crucially,
 * `close()` closes IDLE clients only. Every created client is counted so the
 * tests can assert zero live sockets after disconnect().
 */
function fakeCountingClientModule() {
  type FakeClient = {
    serverVersion: string;
    closed: boolean;
    query: (powql: string, params?: unknown[]) => Promise<unknown>;
    close: () => Promise<void>;
  };
  const clients: FakeClient[] = [];
  let closeCalled = false;
  // The real Pool constructor takes connection options; a default constructor
  // accepts (and ignores) them at runtime just the same.
  class FakePool {
    private idle: FakeClient[] = [];
    private poolClosed = false;
    async acquire(): Promise<FakeClient> {
      if (this.poolClosed) throw new Error('pool closed');
      const existing = this.idle.pop();
      if (existing) return existing;
      const c: FakeClient = {
        serverVersion: '0.10.0',
        closed: false,
        query: async () => ({ kind: 'message', message: 'ok' }),
        close: async () => {
          c.closed = true;
        },
      };
      clients.push(c);
      return c;
    }
    release(c: FakeClient): void {
      if (this.poolClosed) {
        void c.close();
        return;
      }
      this.idle.push(c);
    }
    destroy(c: FakeClient): void {
      void c.close();
    }
    async withClient<T>(fn: (c: FakeClient) => Promise<T>): Promise<T> {
      const c = await this.acquire();
      try {
        const out = await fn(c);
        this.release(c);
        return out;
      } catch (err) {
        this.destroy(c);
        throw err;
      }
    }
    async close(): Promise<void> {
      closeCalled = true;
      this.poolClosed = true;
      // Real semantics: close IDLE clients only; checked-out ones are the
      // caller's responsibility ("Checked-out clients are NOT tracked").
      const idle = this.idle.splice(0, this.idle.length);
      await Promise.all(idle.map((c) => c.close()));
    }
  }
  const mod = {
    Client: {
      connect: async (): Promise<never> => {
        throw new Error('fake module: Client.connect unused');
      },
    },
    Pool: FakePool,
  };
  return {
    mod: mod as unknown as NonNullable<Parameters<typeof turbinePowDB>[2]>['powdbClientModule'],
    clients,
    live: () => clients.filter((c) => !c.closed).length,
    closeCalled: () => closeCalled,
  };
}

describe('powdb: owned-pool disconnect() closes every driver client (socket-leak fix)', () => {
  it('connect → version probe → query → disconnect leaves ZERO live clients', async () => {
    const fake = fakeCountingClientModule();
    // Owned networked form (conn options), including the serverVersion probe
    // (the prime leak suspect): its client must be released AND closed.
    const db = await turbinePowDB(
      { host: '127.0.0.1', port: 5433 },
      { tables: {}, enums: {} },
      {
        powdbClientModule: fake.mod,
      },
    );
    assert.ok(fake.clients.length >= 1, 'the version probe checked out a client');
    await db.raw(['note work'] as never);
    await db.$transaction(async () => 'tx-work');
    await db.disconnect();
    assert.ok(fake.closeCalled(), 'disconnect() must close the OWNED driver pool (was skipped entirely)');
    assert.equal(fake.live(), 0, `every client the pool ever created is closed (${fake.clients.length} created)`);
  });

  it('the powdb:// URL form is patched the same way', async () => {
    const fake = fakeCountingClientModule();
    const db = await turbinePowDB(
      'powdb://127.0.0.1:5433',
      { tables: {}, enums: {} },
      {
        powdbClientModule: fake.mod,
      },
    );
    await db.raw(['note work'] as never);
    await db.end(); // the end() alias must be patched too
    assert.equal(fake.live(), 0);
  });

  it('PowdbPool.end() destroys clients still CHECKED OUT (driver close() only closes idle)', async () => {
    const fake = fakeCountingClientModule();
    const db = await turbinePowDB(
      { host: '127.0.0.1', port: 5433 },
      { tables: {}, enums: {} },
      {
        powdbClientModule: fake.mod,
      },
    );
    // Check out a connection and never release it (e.g. a caller that crashed
    // mid-transaction). disconnect() must still not leak its socket.
    const client = await (
      db as unknown as { pool: { connect(): Promise<{ query(t: string): Promise<unknown> }> } }
    ).pool.connect();
    await client.query('note held');
    await db.disconnect();
    assert.equal(fake.live(), 0, 'the checked-out client was destroyed on disconnect');
  });

  it('an INJECTED driver pool stays the caller responsibility (disconnect no-op)', async () => {
    const fake = fakeCountingClientModule();
    const FakePool = (fake.mod as unknown as { Pool: new (o: unknown) => unknown }).Pool;
    const driverPool = new FakePool({});
    const db = await turbinePowDB(driverPool as never, { tables: {}, enums: {} });
    await db.raw(['note work'] as never);
    await db.disconnect();
    assert.ok(!fake.closeCalled(), 'injected pool must NOT be closed by disconnect()');
  });

  it('embedded: queries after disconnect() fail with a typed ConnectionError (pool really closed)', async () => {
    const { pool } = fakeEmbeddedDb();
    // Owned-embedded shape reduced to the pool: end() marks it closed.
    await pool.query('note before');
    await pool.end();
    await assert.rejects(() => pool.query('note after'), ConnectionError);
  });
});
