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
  ReadOnlyError,
  TimeoutError,
  TurbineErrorCode,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
} from '../errors.js';
import {
  ALL_POWDB_CAPABILITIES,
  assertSupportedPowdbVersion,
  capabilitiesFromVersion,
  coerceValue,
  encodePowqlLiteral,
  introspectPowdbDatabase,
  isJsonColumn,
  isStaleFramePowdbError,
  materializePowql,
  POWQL_LEXER_TESTED_CEILING,
  type PowdbCapabilities,
  PowdbEmbeddedPool,
  PowdbFloatParam,
  PowdbJsonParam,
  PowdbPool,
  type PowdbPoolOptions,
  parsePowdbUrl,
  powdbDialect,
  powqlColumnType,
  powqlSchemaDDL,
  quotePowqlIdent,
  requireCapability,
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
    // A json-document table for F1/F2 (JSON path filters, ordering, grouping).
    doc: table('doc', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
      col('region', 'region', 'string', 'text', { nullable: true }),
    ]),
  },
};

/** A mock PowdbPool that records every emitted PowQL and returns canned rows. */
function mockPool(caps: PowdbCapabilities = ALL_POWDB_CAPABILITIES) {
  const calls: { powql: string; params: unknown[] }[] = [];
  let nextRows: Record<string, unknown>[] = [];
  let nextScalar = '0';
  const pool = {
    capabilities: caps,
    retryStaleReads: false,
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

  it('rejects array / bytes columns (no PowDB equivalent)', () => {
    assert.throws(() => powqlColumnType(col('tags', 'tags', 'string[]', 'text', { isArray: true })), ValidationError);
    assert.throws(() => powqlColumnType(col('blob', 'blob', 'Buffer', 'bytea')), ValidationError);
  });

  it('maps JSON / object columns onto the native `json` document type', () => {
    // pgType jsonb is authoritative...
    assert.equal(powqlColumnType(col('meta', 'meta', 'Record<string, unknown>', 'jsonb')), 'json');
    assert.equal(powqlColumnType(col('doc', 'doc', 'unknown', 'json')), 'json');
    // ...as is the tsType heuristic when the db type is unspecific.
    assert.equal(powqlColumnType(col('cfg', 'cfg', 'Record<string, number>', 'text')), 'json');
    // A jsonb column keeps mapping to json even when tsType reads `string`.
    assert.equal(powqlColumnType(col('raw', 'raw', 'string', 'jsonb')), 'json');
    // A json array column (jsonb, isArray) still throws, PowDB arrays only live inside a document.
    assert.throws(() => powqlColumnType(col('list', 'list', 'unknown[]', 'jsonb', { isArray: true })), ValidationError);
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
// F4a: doc-field expression index DDL
// ---------------------------------------------------------------------------

describe('powdb: powqlSchemaDDL doc-field expression indexes', () => {
  /** A `doc` table whose json column carries the supplied index declarations. */
  function docTable(indexes: TableMetadata['indexes']): SchemaMetadata {
    const t: TableMetadata = {
      ...table('doc', [
        col('id', 'id', 'string', 'text', { hasDefault: true }),
        col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
      ]),
      indexes,
    };
    return { enums: {}, tables: { doc: t } };
  }

  /** The `alter doc add …` statements from a DDL emission (skip the `type` block). */
  function alters(schema: SchemaMetadata): string[] {
    return powqlSchemaDDL(schema).filter((s) => s.startsWith('alter'));
  }

  it('emits a MANDATORY-parenthesized doc-field index', () => {
    const ddl = alters(
      docTable([
        { name: 'doc_data_ns_value_idx', columns: ['data'], unique: false, definition: '', docPath: ['ns', 'value'] },
      ]),
    );
    assert.deepEqual(ddl, ['alter doc add index (.data->"ns"->"value")']);
  });

  it('emits a doc-field UNIQUE expression index', () => {
    const ddl = alters(
      docTable([{ name: 'doc_data_ext_idx', columns: ['data'], unique: true, definition: '', docPath: ['ext'] }]),
    );
    assert.deepEqual(ddl, ['alter doc add unique (.data->"ext")']);
  });

  it('emits integer array-index segments bare (not quoted)', () => {
    const ddl = alters(
      docTable([{ name: 'i', columns: ['data'], unique: false, definition: '', docPath: ['tags', 0] }]),
    );
    assert.deepEqual(ddl, ['alter doc add index (.data->"tags"->0)']);
  });

  it('escapes hostile string segments lexer-exact (quotes/backslashes)', () => {
    const ddl = alters(
      docTable([{ name: 'i', columns: ['data'], unique: false, definition: '', docPath: ['a"b\\c'] }]),
    );
    assert.deepEqual(ddl, ['alter doc add index (.data->"a\\"b\\\\c")']);
  });

  it('a JSON `$1`-shaped segment is inert DDL text (never a placeholder)', () => {
    // DDL is executed directly, never routed through materializePowql, so a
    // literal `$1` in a segment cannot be rewritten; it is emitted verbatim.
    const ddl = alters(docTable([{ name: 'i', columns: ['data'], unique: false, definition: '', docPath: ['$1'] }]));
    assert.deepEqual(ddl, ['alter doc add index (.data->"$1")']);
  });

  it('emits a plain single-column index / unique when no docPath is set', () => {
    const idxDdl = alters(docTable([{ name: 'i', columns: ['data'], unique: false, definition: '' }]));
    assert.deepEqual(idxDdl, ['alter doc add index .data']);
    const uniqDdl = alters(docTable([{ name: 'u', columns: ['data'], unique: true, definition: '' }]));
    assert.deepEqual(uniqDdl, ['alter doc add unique .data']);
  });

  it('throws E017 for a composite (multi-column) plain index', () => {
    assert.throws(
      () => powqlSchemaDDL(docTable([{ name: 'c', columns: ['id', 'data'], unique: false, definition: '' }])),
      UnsupportedFeatureError,
    );
  });

  it('does not double-emit a plain unique index that duplicates the PK', () => {
    // `id` is already `required unique` inline; a redundant unique index on it
    // must be skipped.
    const ddl = alters(docTable([{ name: 'dup', columns: ['id'], unique: true, definition: '' }]));
    assert.deepEqual(ddl, []);
  });

  it('gates doc-field indexes behind the docFieldIndexes capability', () => {
    const schema = docTable([{ name: 'i', columns: ['data'], unique: false, definition: '', docPath: ['k'] }]);
    // Capability OFF (engine < 0.13) → typed E017 with a version hint.
    assert.throws(
      () => powqlSchemaDDL(schema, { capabilities: capabilitiesFromVersion('0.12.0') }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /0\.13/.test((e as Error).message),
    );
    // Capability ON → emits.
    const ddl = powqlSchemaDDL(schema, { capabilities: capabilitiesFromVersion('0.13.0') }).filter((s) =>
      s.startsWith('alter'),
    );
    assert.deepEqual(ddl, ['alter doc add index (.data->"k")']);
    // No capabilities supplied (pure-function caller) → emits unconditionally.
    assert.deepEqual(alters(schema), ['alter doc add index (.data->"k")']);
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

  it('maps a read-only refusal to ReadOnlyError (E018), both engine shapes, prefixed or not', () => {
    // Embedded read-only handle (opened for snapshot serving): the engine text
    // arrives GenericFailure with no prefix.
    const snapshot = wrapPowdbError({
      code: 'GenericFailure',
      message: 'readonly mode: statement requires a writer (this database was opened read-only for snapshot serving)',
    });
    assert.ok(snapshot instanceof ReadOnlyError);
    assert.equal(snapshot.code, TurbineErrorCode.READ_ONLY);
    assert.match(snapshot.message, /Route writes to a writable primary/);
    // The 0.15 driver spec distinguishes the two families: snapshot mode means
    // nothing can write here, RBAC means this connection's role may not.
    assert.equal(snapshot.reason, 'snapshot');

    // Networked read-only role: the message is prefixed `query failed: `, the
    // substring match must still classify it (not anchor on the start).
    const role = wrapPowdbError({
      code: 'query_failed',
      message: `query failed: permission denied: role 'reader' cannot execute write statements`,
    });
    assert.ok(role instanceof ReadOnlyError);
    assert.equal(role.code, TurbineErrorCode.READ_ONLY);
    assert.equal(role.reason, 'rbac');

    // The role form also covers schema-definition (DDL) refusals.
    const ddl = wrapPowdbError({
      code: 'query_failed',
      message: `query failed: permission denied: role 'reader' cannot execute schema-definition statements`,
    });
    assert.ok(ddl instanceof ReadOnlyError);
    // .cause is preserved for both shapes.
    assert.equal((snapshot as { cause?: unknown }).cause !== undefined, true);
  });

  it('takes PRECEDENCE over the generic Execution/type-mismatch → E003 regex', () => {
    // A read-only refusal wrapped in an Execution(...) envelope would otherwise
    // match the generic ValidationError regex, the E018 checks run first.
    const wrapped = wrapPowdbError({
      code: 'GenericFailure',
      message: `Execution("readonly mode: statement requires a writer")`,
    });
    assert.ok(wrapped instanceof ReadOnlyError, 'read-only wins over the E003 Execution match');
    assert.ok(!(wrapped instanceof ValidationError));
  });

  it('maps the remaining 0.14 spec families (timeout / cancel / bounded join / read-only open)', () => {
    // Per-query deadline → TimeoutError (message path, embedded has no .code).
    // The engine prose is preserved through the message override, not collapsed
    // to the "timed out after 0ms" placeholder.
    const timeout = wrapPowdbError({ code: 'GenericFailure', message: 'query timeout after 5000ms' });
    assert.ok(timeout instanceof TimeoutError);
    assert.match(timeout.message, /query timeout after 5000ms/);
    assert.doesNotMatch(timeout.message, /timed out after 0ms/);
    assert.ok((timeout as TimeoutError).cause, 'cause preserved');
    // A closed embedded handle reaching a queued statement → ConnectionError E004.
    const closed = wrapPowdbError({ code: 'GenericFailure', message: 'database is closed' });
    assert.ok(closed instanceof ConnectionError);
    assert.equal((closed as ConnectionError).code, TurbineErrorCode.CONNECTION);
    // Client-initiated cancellation → ConnectionError (final, never auto-retried).
    assert.ok(
      wrapPowdbError({ code: 'aborted', message: 'query cancelled by client disconnect' }) instanceof ConnectionError,
    );
    // Bounded join rejection → ValidationError, fix-hint preserved verbatim.
    const join = wrapPowdbError({
      code: 'query_failed',
      message:
        'query failed: nested-loop join would evaluate 4000000 candidate pairs, above the 1000000 pair limit; add an equi-key to ON',
    });
    assert.ok(join instanceof ValidationError);
    assert.match(join.message, /add an equi-key to ON/);
    assert.ok(
      wrapPowdbError({ code: 'query_failed', message: 'query failed: join result exceeds row limit' }) instanceof
        ValidationError,
    );
    // Open-time read-only failure (non-empty WAL) → ConnectionError, recover hint.
    const wal = wrapPowdbError({
      code: 'GenericFailure',
      message: 'cannot open read-only: the WAL is not empty; recover the directory first',
    });
    assert.ok(wal instanceof ConnectionError);
    assert.match(wal.message, /flush the WAL/);
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

  // PowDB spec limitation: PowQL `returning` is a bare keyword that hands back
  // every column (the driver contract exposes NO column-list form). So (unlike
  // the SQL engines, which emit an explicit non-PII RETURNING/OUTPUT projection)
  // the create/update/delete PowQL is UNCHANGED and PII must be stripped from the
  // returned row client-side (stripWritePii). The upsert path is different: it
  // reselects by PK through the read projection, which already omits PII, so PII
  // never crosses the wire there.
  describe('PII on writes (spec-limited: bare `returning` + client strip)', () => {
    const piiSchema: SchemaMetadata = {
      enums: {},
      tables: {
        app_user: table('app_user', [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('name', 'name', 'string', 'text'),
          col('email', 'email', 'string', 'text', { pii: true }),
        ]),
      },
    };
    const piiQi = (m: ReturnType<typeof mockPool>) => new PowqlInterface(m.pool, 'app_user', piiSchema);

    it('create still emits the bare `returning` keyword (no column list) and strips PII from the row', async () => {
      const m = mockPool();
      m.setRows([{ id: 'u1', name: 'Ada', email: 'ada@x.test' }]);
      const row = await piiQi(m).create({ data: { name: 'Ada', email: 'ada@x.test' } });
      const insert = m.calls.find((c) => c.powql.startsWith('insert'))!;
      // Unchanged: trailing bare `returning`, never a `returning { .id, .name }` list.
      assert.match(insert.powql, /\}\s*returning$/);
      assert.doesNotMatch(insert.powql, /returning\s*\{/);
      // The persisted value is still written (email is bound as a param)...
      assert.ok(insert.params.includes('ada@x.test'), 'PII is written freely');
      // ...but stripped from the returned entity (client-side, defense of last resort).
      assert.equal((row as { name: string }).name, 'Ada');
      assert.ok(!('email' in (row as Record<string, unknown>)), 'PII stripped from the write result');
    });

    it('update and delete keep the bare `returning` keyword and strip PII', async () => {
      const mu = mockPool();
      mu.setRows([{ id: 'u1', name: 'Zed', email: 'z@x.test' }]);
      const uRow = await piiQi(mu).update({ where: { id: 'u1' }, data: { name: 'Zed' } });
      assert.match(mu.last().powql, /\}\s*returning$/);
      assert.ok(!('email' in (uRow as Record<string, unknown>)));

      const md = mockPool();
      md.setRows([{ id: 'u1', name: 'Gone', email: 'g@x.test' }]);
      const dRow = await piiQi(md).delete({ where: { id: 'u1' } });
      assert.match(md.last().powql, /delete returning$/);
      assert.ok(!('email' in (dRow as Record<string, unknown>)));
    });

    it('upsert reselect-by-PK projects the non-PII column list (email excluded)', async () => {
      const m = mockPool();
      m.setRows([{ id: 'u1', name: 'X' }]);
      await piiQi(m).upsert({ where: { id: 'u1' }, create: { id: 'u1', name: 'X' }, update: { name: 'Y' } });
      const reselect = m.calls.find((c) => /^app_user filter \.id = \$1/.test(c.powql.trimStart()))!;
      assert.ok(reselect, 'upsert reselects by PK');
      assert.match(reselect.powql, /\{ \.id, \.name \}/, 'reselect projects the non-PII columns');
      assert.doesNotMatch(reselect.powql, /\.email/, 'PII column excluded from the reselect projection');
    });
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

  it('a begin queued past disconnect() rejects ConnectionError E004 (never runs against the closed handle)', async () => {
    const { pool } = fakeEmbeddedDb({ kind: 'ok', affected: 0n });
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    // T1 opens a transaction, taking the single global write lock.
    await c1.query('begin');
    // T2's begin queues behind T1's still-open transaction (pending).
    const queued = c2.query('begin');
    // The pool is disconnected while T2 is still waiting for the gate.
    await pool.end();
    // Tearing down T1's connection fires a best-effort rollback and releases the
    // gate, handing the slot to T2. T2 must re-check `closed` and refuse rather
    // than run `begin` against the now-closed handle.
    c1.release();
    const err = await queued.then(
      () => null,
      (e: unknown) => e as Error,
    );
    assert.ok(err instanceof ConnectionError, 'queued begin rejects ConnectionError');
    assert.equal((err as ConnectionError).code, TurbineErrorCode.CONNECTION);
  });
});

// ---------------------------------------------------------------------------
// F1: embedded native typed transport (addon >= 0.14)
// ---------------------------------------------------------------------------

/**
 * A fake embedded Database exposing BOTH wires: `queryWithParams` (native typed
 * wire, records the untouched PowQL + the bound params) and `query` (legacy
 * string wire, records the materialized text). Which one a {@link
 * PowdbEmbeddedPool} calls is decided by `capabilities.nativeRaw` + the per-call
 * feature-detect, so the recorded arrays prove the routing.
 */
function fakeNativeDb() {
  const nativeSeen: { powql: string; params: unknown[] }[] = [];
  const legacySeen: string[] = [];
  const db = {
    query(powql: string) {
      legacySeen.push(powql);
      return { kind: 'ok', affected: 1n };
    },
    querySql: (sql: string) => ({ kind: 'message', message: sql }),
    queryReadonly: (powql: string) => ({ kind: 'message', message: powql }),
    isPoisoned: () => false,
    queryWithParams(powql: string, params: unknown[]) {
      nativeSeen.push({ powql, params });
      // A str "null" cell to prove the native decode keeps it a string (no
      // legacy collapse) at the pool layer.
      return {
        kind: 'rows',
        columns: ['id', 's'],
        rows: [
          [
            { type: 'str', value: 'u1' },
            { type: 'str', value: 'null' },
          ],
        ],
      };
    },
    close() {},
  };
  return { db, nativeSeen, legacySeen };
}

describe('powdb: PowdbEmbeddedPool native typed transport (F1)', () => {
  it('routes to queryWithParams (params NOT materialized) when nativeRaw + queryWithParams present', async () => {
    const { db, nativeSeen, legacySeen } = fakeNativeDb();
    const pool = new PowdbEmbeddedPool(db as never, {
      capabilities: capabilitiesFromVersion('0.14.0', { hasNativeRaw: true }),
    });
    const res = await pool.query('app_user filter .id = $1 { .id, .s }', ['u1']);
    // Native path chosen: legacy string wire untouched.
    assert.equal(legacySeen.length, 0);
    assert.equal(nativeSeen.length, 1);
    // The `$1` placeholder is NOT materialized into the text, it goes as a bound param.
    assert.equal(nativeSeen[0]!.powql, 'app_user filter .id = $1 { .id, .s }');
    assert.deepEqual(nativeSeen[0]!.params, ['u1']);
    // Native decode keeps a genuine str "null" as the string "null" (no collapse).
    assert.deepEqual(res.rows, [{ id: 'u1', s: 'null' }]);
    assert.equal((res as { native?: boolean }).native, true);
  });

  it('falls back to the legacy materialized wire when nativeRaw is OFF (older server gate)', async () => {
    const { db, nativeSeen, legacySeen } = fakeNativeDb();
    // 0.13 without hasNativeRaw → nativeRaw false, even though the handle exposes queryWithParams.
    const pool = new PowdbEmbeddedPool(db as never, { capabilities: capabilitiesFromVersion('0.13.0') });
    await pool.query('insert app_user { id := $1 } returning', ['u1']);
    assert.equal(nativeSeen.length, 0);
    assert.deepEqual(legacySeen, ['insert app_user { id := "u1" } returning']);
  });

  it('falls back to the legacy wire when the handle lacks queryWithParams (per-call feature-detect)', async () => {
    // nativeRaw is ON in caps, but the fake db (from fakeEmbeddedDb) has no
    // queryWithParams, the defensive per-call detect must keep it on legacy.
    const { pool, seen } = fakeEmbeddedDb(
      { kind: 'ok', affected: 1n },
      { capabilities: capabilitiesFromVersion('0.14.0', { hasNativeRaw: true }) },
    );
    await pool.query('insert app_user { id := $1 }', ['u1']);
    assert.deepEqual(seen, ['insert app_user { id := "u1" }']);
  });

  it('binds params via toPowdbParam, every bound value is in the NativeParam union (null|bigint|number|boolean|string)', async () => {
    const { db, nativeSeen } = fakeNativeDb();
    const pool = new PowdbEmbeddedPool(db as never, {
      capabilities: capabilitiesFromVersion('0.14.0', { hasNativeRaw: true }),
    });
    const when = new Date(1_700_000_000_000);
    await pool.query('insert t { a := $1, b := $2, c := $3, d := $4, e := $5, f := $6, g := $7 } returning', [
      when,
      new PowdbFloatParam(42),
      new PowdbJsonParam({ a: 1 }),
      7n,
      true,
      'x',
      null,
    ]);
    const bound = nativeSeen[0]!.params;
    for (const p of bound) {
      const t = typeof p;
      assert.ok(
        p === null || t === 'bigint' || t === 'number' || t === 'boolean' || t === 'string',
        `bound param ${String(p)} (${t}) is not assignable to the NativeParam union`,
      );
    }
    // Spot-check the coercions the binder applies.
    assert.equal(bound[0], BigInt(when.getTime()) * 1000n); // Date → epoch micros bigint
    assert.equal(bound[1], 42); // PowdbFloatParam → plain number
    assert.equal(bound[2], JSON.stringify({ a: 1 })); // PowdbJsonParam → canonical JSON text
    assert.equal(bound[3], 7n);
    assert.equal(bound[4], true);
    assert.equal(bound[5], 'x');
    assert.equal(bound[6], null);
  });

  it('end() calls the addon close() (0.14 checkpoint flush) when present', async () => {
    let closed = 0;
    const { db } = fakeNativeDb();
    (db as unknown as { close: () => void }).close = () => {
      closed += 1;
    };
    const pool = new PowdbEmbeddedPool(db as never, {
      capabilities: capabilitiesFromVersion('0.14.0', { hasNativeRaw: true }),
    });
    await pool.end();
    assert.equal(closed, 1);
    // Idempotent: a second end() does not double-close.
    await pool.end();
    assert.equal(closed, 1);
  });
});

// ---------------------------------------------------------------------------
// F3: read-only awareness: pool flag + embedded readonly target routing
// ---------------------------------------------------------------------------

/**
 * A fake embedded MODULE recording how each handle was opened (open /
 * openWithMemoryLimit / openReadOnly / openReadOnlyWithMemoryLimit). Injected
 * into `turbinePowDB` via `powdbEmbeddedModule`, so `openEmbeddedPool`'s routing
 * is unit-testable without the real napi addon.
 */
function fakeEmbeddedModule(calls: unknown[][], opts: { withReadOnly?: boolean } = {}) {
  const db = {
    query: () => ({ kind: 'ok', affected: 0n }),
    querySql: () => ({ kind: 'message', message: '' }),
    queryReadonly: () => ({ kind: 'message', message: '' }),
    isPoisoned: () => false,
    queryWithParams: () => ({ kind: 'ok', affected: 0n }),
    setSyncMode: () => {},
    close: () => {},
  };
  const withReadOnly = opts.withReadOnly ?? true;
  const Database: Record<string, unknown> = {
    open: (dir: string) => {
      calls.push(['open', dir]);
      return db;
    },
    openWithMemoryLimit: (dir: string, n: number) => {
      calls.push(['openWithMemoryLimit', dir, n]);
      return db;
    },
  };
  if (withReadOnly) {
    Database.openReadOnly = (dir: string) => {
      calls.push(['openReadOnly', dir]);
      return db;
    };
    Database.openReadOnlyWithMemoryLimit = (dir: string, n: number) => {
      calls.push(['openReadOnlyWithMemoryLimit', dir, n]);
      return db;
    };
  }
  return { Database };
}

describe('powdb: readonly awareness (F3)', () => {
  it('ReadOnlyError carries code E018 and the routing hint', () => {
    const e = new ReadOnlyError('PowDB refused a write on a read-only database.');
    assert.equal(e.code, TurbineErrorCode.READ_ONLY);
    assert.equal(e.code, 'TURBINE_E018');
    assert.equal(e.name, 'ReadOnlyError');
    assert.match(e.message, /Route writes to a writable primary/);
  });

  it('a directly-constructed pool defaults readonly to false; the option flips it', () => {
    assert.equal(new PowdbEmbeddedPool({} as never).readonly, false);
    assert.equal(new PowdbEmbeddedPool({} as never, { readonly: true }).readonly, true);
    assert.equal(new PowdbPool({} as never).readonly, false);
    assert.equal(new PowdbPool({} as never, undefined, { readonly: true }).readonly, true);
  });

  it('embedded `readonly: true` routes to openReadOnly and forces the pool flag', async () => {
    const calls: unknown[][] = [];
    const db = await turbinePowDB({ embedded: '/tmp/snap', readonly: true }, schema, {
      powdbEmbeddedModule: fakeEmbeddedModule(calls) as never,
      assumeEngineVersion: '0.14.0',
      warnOnUnlimited: false,
    });
    assert.deepEqual(calls, [['openReadOnly', '/tmp/snap']]);
    await db.disconnect();
  });

  it('embedded `readonly` + `memoryLimit` routes to openReadOnlyWithMemoryLimit', async () => {
    const calls: unknown[][] = [];
    const db = await turbinePowDB({ embedded: '/tmp/snap', readonly: true, memoryLimit: 4096 }, schema, {
      powdbEmbeddedModule: fakeEmbeddedModule(calls) as never,
      assumeEngineVersion: '0.14.0',
      warnOnUnlimited: false,
    });
    assert.deepEqual(calls, [['openReadOnlyWithMemoryLimit', '/tmp/snap', 4096]]);
    await db.disconnect();
  });

  it('rejects readonly + syncMode with a ValidationError (a read-only engine never writes)', async () => {
    await assert.rejects(
      () =>
        turbinePowDB({ embedded: '/tmp/snap', readonly: true, syncMode: 'normal' }, schema, {
          powdbEmbeddedModule: fakeEmbeddedModule([]) as never,
          assumeEngineVersion: '0.14.0',
          warnOnUnlimited: false,
        }),
      ValidationError,
    );
  });

  it('readonly on an addon WITHOUT openReadOnly throws a ConnectionError naming >= 0.14', async () => {
    await assert.rejects(
      () =>
        turbinePowDB({ embedded: '/tmp/snap', readonly: true }, schema, {
          powdbEmbeddedModule: fakeEmbeddedModule([], { withReadOnly: false }) as never,
          assumeEngineVersion: '0.13.0',
          warnOnUnlimited: false,
        }),
      (err: Error) => err instanceof ConnectionError && />= 0\.14/.test(err.message),
    );
  });

  it('a non-readonly embedded target still routes to plain open (regression guard)', async () => {
    const calls: unknown[][] = [];
    const db = await turbinePowDB({ embedded: '/tmp/rw' }, schema, {
      powdbEmbeddedModule: fakeEmbeddedModule(calls) as never,
      assumeEngineVersion: '0.14.0',
      warnOnUnlimited: false,
    });
    assert.deepEqual(calls, [['open', '/tmp/rw']]);
    await db.disconnect();
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
    // Since the cold-burst fix, the re-entrancy marker exists ONLY inside
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
// the dogfood consumer regression (ITEM 3): the re-entrancy marker is scoped to the
// transaction CALLBACK's async subtree. acquire() used to enterWith() the
// marker into the CALLER's context, so a context that merely had a begin in
// its await chain was falsely flagged re-entrant: on a cold client, the first
// same-tick burst of db.$transaction calls saw call #1's live marker from
// every sibling (9/10 rejected E017 in production).
// ---------------------------------------------------------------------------

describe('powdb: re-entrancy marker never leaks into the caller context (dogfood report)', () => {
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
// the dogfood consumer regression (ITEM 1): owned-pool disconnect() must close every driver
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

// ---------------------------------------------------------------------------
// v0.31 review fixes — release destroy contract, closed guards, implicit-tx marker
// ---------------------------------------------------------------------------

describe('powdb: connection release honors the destroy contract (review fix)', () => {
  function countingClientPool() {
    const sent: string[] = [];
    let released = 0;
    let destroyed = 0;
    const client = {
      serverVersion: '0.8.0',
      query: async (powql: string) => {
        sent.push(powql);
        return { kind: 'message', message: 'ok' };
      },
      close: async () => {},
    };
    const pool = {
      acquire: async () => client,
      release() {
        released++;
      },
      destroy() {
        destroyed++;
      },
      withClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
      close: async () => {},
    };
    return {
      pool: pool as unknown as ConstructorParameters<typeof PowdbPool>[0],
      sent,
      counts: () => ({ released, destroyed }),
    };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('release(err) after an un-ended begin rolls back, then DESTROYS (never re-idles)', async () => {
    const fake = countingClientPool();
    const client = await new PowdbPool(fake.pool).connect();
    await client.query('begin');
    client.release(new Error('tx timeout'));
    await settle();
    assert.deepEqual(fake.sent, ['begin', 'rollback'], 'open server-side tx is ended before the gate moves on');
    assert.deepEqual(fake.counts(), { released: 0, destroyed: 1 });
  });

  it('release() with an open hold but no error still rolls back; clean rollback re-idles', async () => {
    const fake = countingClientPool();
    const client = await new PowdbPool(fake.pool).connect();
    await client.query('begin');
    client.release();
    await settle();
    assert.deepEqual(fake.sent, ['begin', 'rollback']);
    assert.deepEqual(fake.counts(), { released: 1, destroyed: 0 });
  });

  it('clean commit then release() re-idles with no extra rollback', async () => {
    const fake = countingClientPool();
    const client = await new PowdbPool(fake.pool).connect();
    await client.query('begin');
    await client.query('commit');
    client.release();
    await settle();
    assert.deepEqual(fake.sent, ['begin', 'commit']);
    assert.deepEqual(fake.counts(), { released: 1, destroyed: 0 });
  });

  it('the gate hands over only after the teardown rollback completes', async () => {
    const fake = countingClientPool();
    const pool = new PowdbPool(fake.pool);
    const c1 = await pool.connect();
    await c1.query('begin');
    const c2 = await pool.connect();
    const secondBegin = c2.query('begin');
    c1.release(new Error('boom'));
    await secondBegin;
    const beginIdx = fake.sent.lastIndexOf('begin');
    const rollbackIdx = fake.sent.indexOf('rollback');
    assert.ok(rollbackIdx >= 0 && rollbackIdx < beginIdx, `rollback precedes next begin: ${fake.sent}`);
    await c2.query('commit');
    c2.release();
  });
});

describe('powdb: closed-pool guard is typed on BOTH transports (review fix)', () => {
  it('networked query()/connect() after end() throw ConnectionError E004', async () => {
    const fake = fakeNetworkedClientPool();
    const pool = new PowdbPool(fake.pool);
    await pool.end();
    await assert.rejects(pool.query('app_user { .id }'), ConnectionError);
    await assert.rejects(pool.connect(), ConnectionError);
  });

  it("wrapPowdbError classifies the driver's raw pool lifecycle errors", () => {
    assert.ok(wrapPowdbError(new Error('pool closed')) instanceof ConnectionError);
    assert.ok(wrapPowdbError(new Error('pool acquire timeout after 5000ms')) instanceof ConnectionError);
  });
});

describe('powdb: runInImplicitTx plants the re-entrancy marker (review fix)', () => {
  it('nested-write implicit tx runs its callback through wrapTransactionCallback', async () => {
    let wrapped = 0;
    const sent: string[] = [];
    const client = {
      query: async (powql: string) => {
        sent.push(powql);
        if (/^insert app_user/.test(powql)) {
          return {
            rows: [{ id: 'u1', name: 'x', age: null, score: null, active: null, created_at: null }],
            rowCount: 1,
          };
        }
        if (/^insert post/.test(powql)) {
          return { rows: [{ id: 'p1', author_id: 'u1', title: 't', views: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      wrapTransactionCallback: <R>(fn: () => Promise<R>): Promise<R> => {
        wrapped++;
        return fn();
      },
      release() {},
    };
    const pool = {
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => client,
    } as unknown as PowdbPool;
    const qi = new PowqlInterface(pool, 'app_user', schema, [], {
      queryInterfaceFactory: (p: never, t: string, s: never, m: never, o: never) =>
        new PowqlInterface(p, t, s, m, o) as never,
    } as never);
    const row = await qi.create({ data: { name: 'x', posts: { create: [{ title: 't' }] } } } as never);
    assert.equal(wrapped, 1, 'user callback subtree carries the single-writer marker');
    assert.equal((row as { id: string }).id, 'u1');
    assert.ok(sent.includes('begin') && sent.includes('commit'));
  });
});

// ---------------------------------------------------------------------------
// B1: capability gating (per-version feature flags + version-hint E017s)
// ---------------------------------------------------------------------------

describe('powdb: capability gating (PowdbCapabilities)', () => {
  it('derives feature gates from the engine semver', () => {
    // Pre-introspection (< 0.10): nothing gated on.
    const v09 = capabilitiesFromVersion('0.9.5');
    assert.deepEqual(v09, {
      engineVersion: '0.9.5',
      introspection: false,
      jsonDocs: false,
      docFieldIndexes: false,
      serverJoins: false,
      nativeRaw: false,
    });
    // 0.10: introspection only.
    assert.equal(capabilitiesFromVersion('0.10.0').introspection, true);
    assert.equal(capabilitiesFromVersion('0.10.0').jsonDocs, false);
    // 0.12: json docs unlocked, expression indexes still gated.
    const v12 = capabilitiesFromVersion('0.12.3');
    assert.equal(v12.jsonDocs, true);
    assert.equal(v12.docFieldIndexes, false);
    // 0.13: everything, plus nativeRaw when the client exposes queryNativeRaw.
    assert.equal(capabilitiesFromVersion('0.13.0').docFieldIndexes, true);
    assert.equal(capabilitiesFromVersion('0.13.0', { hasNativeRaw: true }).nativeRaw, true);
    // nativeRaw needs BOTH the feature AND server >= 0.13.
    assert.equal(capabilitiesFromVersion('0.13.0', { hasNativeRaw: false }).nativeRaw, false);
    assert.equal(capabilitiesFromVersion('0.12.9', { hasNativeRaw: true }).nativeRaw, false);
  });

  it('gates serverJoins at >= 0.13 (0.12 false, 0.13 true)', () => {
    // Server-side joins are hash-accelerated and bounded since 0.13.
    assert.equal(capabilitiesFromVersion('0.12.9').serverJoins, false);
    assert.equal(capabilitiesFromVersion('0.13.0').serverJoins, true);
    assert.equal(capabilitiesFromVersion('0.14.2').serverJoins, true);
    assert.equal(capabilitiesFromVersion('1.0.0').serverJoins, true);
    // Unknown / non-semver version turns it off, like every other feature gate.
    assert.equal(capabilitiesFromVersion('preview-build').serverJoins, false);
    assert.equal(capabilitiesFromVersion(null).serverJoins, false);
    // The E017 hint for a missing serverJoins names the 0.13 floor.
    assert.throws(
      () => requireCapability(capabilitiesFromVersion('0.12.0'), 'serverJoins', 'server-side joins'),
      /server-side joins requires PowDB >= 0\.13/,
    );
  });

  it('turns every gate OFF for an unknown / non-semver version', () => {
    const caps = capabilitiesFromVersion('preview-build');
    assert.deepEqual(caps, {
      engineVersion: 'preview-build',
      introspection: false,
      jsonDocs: false,
      docFieldIndexes: false,
      serverJoins: false,
      nativeRaw: false,
    });
    assert.equal(capabilitiesFromVersion(null).engineVersion, null);
  });

  it('requireCapability throws a version-hinting E017 when the gate is off', () => {
    const caps = capabilitiesFromVersion('0.11.0');
    let thrown: UnsupportedFeatureError | undefined;
    try {
      requireCapability(caps, 'jsonDocs', 'JSON path filters');
    } catch (e) {
      thrown = e as UnsupportedFeatureError;
    }
    assert.ok(thrown instanceof UnsupportedFeatureError);
    assert.match(thrown.message, /JSON path filters requires PowDB >= 0.12/);
    assert.match(thrown.message, /this connection reports 0\.11\.0/);
    assert.match(thrown.message, /assumeEngineVersion/);
    // A satisfied gate is a no-op.
    assert.doesNotThrow(() =>
      requireCapability(capabilitiesFromVersion('0.13.0'), 'docFieldIndexes', 'expression indexes'),
    );
  });

  it('the E017 hint notes an undetectable version distinctly', () => {
    // A null (unresolvable) version reads "could not report a version"...
    assert.throws(
      () => requireCapability(capabilitiesFromVersion(null), 'introspection', 'describe introspection'),
      /could not report a version/,
    );
    // ...while a reported-but-non-semver string is echoed verbatim.
    assert.throws(
      () => requireCapability(capabilitiesFromVersion('weird'), 'introspection', 'describe introspection'),
      /this connection reports weird/,
    );
  });

  it('ALL_POWDB_CAPABILITIES is the trusted-caller default (feature gates on, nativeRaw off)', () => {
    assert.deepEqual(ALL_POWDB_CAPABILITIES, {
      engineVersion: null,
      jsonDocs: true,
      docFieldIndexes: true,
      introspection: true,
      serverJoins: true,
      nativeRaw: false,
    });
    // A directly-constructed pool defaults to it.
    assert.deepEqual(new PowdbPool({} as never).capabilities, ALL_POWDB_CAPABILITIES);
  });
});

describe('powdb: introspectPowdbDatabase gating + mis-shaped exec guard', () => {
  it('gates on the introspection capability (< 0.10 → E017 hint, not a raw parse error)', async () => {
    const exec = async () => ({ rows: [] as Record<string, unknown>[] });
    await assert.rejects(
      introspectPowdbDatabase(exec, { capabilities: capabilitiesFromVersion('0.9.0') }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /requires PowDB >= 0\.10/.test((e as Error).message),
    );
  });

  it('runs when the introspection capability is present (>= 0.10)', async () => {
    // schema returns one table; describe returns its columns, all record-keyed.
    const exec = async (q: string) => {
      if (q === 'schema') return { rows: [{ name: 'widget', columns: '1' }] };
      return { rows: [{ column: 'id', type: 'str', nullable: 'false', index: 'unique' }] };
    };
    const meta = await introspectPowdbDatabase(exec, { capabilities: capabilitiesFromVersion('0.10.0') });
    assert.deepEqual(Object.keys(meta.tables), ['widget']);
  });

  it('throws on a mis-shaped exec (positional rows) instead of returning an empty schema', async () => {
    // Simulates the raw client's positional string[][] rows passed straight
    // through: `name` is undefined, so every table would silently drop out.
    const exec = async (q: string) => {
      if (q === 'schema') return { rows: [['widget', '3'] as unknown as Record<string, unknown>] };
      return { rows: [] as Record<string, unknown>[] };
    };
    await assert.rejects(
      introspectPowdbDatabase(exec),
      (e: unknown) => e instanceof ValidationError && /POSITIONAL rows/.test((e as Error).message),
    );
  });

  it('an empty database (zero schema rows) returns an empty schema, not an error', async () => {
    const exec = async () => ({ rows: [] as Record<string, unknown>[] });
    const meta = await introspectPowdbDatabase(exec);
    assert.deepEqual(meta, { tables: {}, enums: {} });
  });
});

// ---------------------------------------------------------------------------
// B1: native `json` document column type
// ---------------------------------------------------------------------------

describe('powdb: json document column type', () => {
  it('isJsonColumn keys off jsonb/json db type, then the tsType heuristic', () => {
    assert.equal(isJsonColumn(col('m', 'm', 'Record<string, unknown>', 'jsonb')), true);
    assert.equal(isJsonColumn(col('m', 'm', 'unknown', 'json')), true);
    assert.equal(isJsonColumn(col('m', 'm', 'string', 'jsonb')), true); // db type authoritative
    assert.equal(isJsonColumn(col('m', 'm', 'MyShape', 'text')), false); // scalar-shaped tsType
    assert.equal(isJsonColumn(col('m', 'm', 'string', 'text')), false);
    assert.equal(isJsonColumn(col('m', 'm', 'number', 'int4')), false);
    // A json array COLUMN is not a json column (PowDB arrays live inside docs).
    assert.equal(isJsonColumn(col('m', 'm', 'unknown[]', 'jsonb', { isArray: true })), false);
  });

  it('powqlSchemaDDL emits `data: json` and gates it on the jsonDocs capability', () => {
    const s: SchemaMetadata = {
      enums: {},
      tables: {
        doc: table('doc', [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
        ]),
      },
    };
    // No capabilities → unconditional emission.
    assert.match(powqlSchemaDDL(s).find((x) => x.startsWith('type doc'))!, /data: json/);
    // jsonDocs on → still emits.
    assert.doesNotThrow(() => powqlSchemaDDL(s, { capabilities: capabilitiesFromVersion('0.12.0') }));
    // jsonDocs off → E017 with the version hint.
    assert.throws(
      () => powqlSchemaDDL(s, { capabilities: capabilitiesFromVersion('0.11.0') }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /requires PowDB >= 0.12/.test((e as Error).message),
    );
  });
});

// ---------------------------------------------------------------------------
// B1: json write encoding (PowdbJsonParam) + read coercion
// ---------------------------------------------------------------------------

describe('powdb: json value round-trip (encode + coerce)', () => {
  const jcol = (nullable = true) => col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable });

  it('encodePowqlLiteral serializes a PowdbJsonParam to a canonical JSON string literal', () => {
    assert.equal(encodePowqlLiteral(new PowdbJsonParam({ a: 1, b: 'x' })), '"{\\"a\\":1,\\"b\\":\\"x\\"}"');
    assert.equal(encodePowqlLiteral(new PowdbJsonParam({ a: null })), '"{\\"a\\":null}"');
    assert.equal(encodePowqlLiteral(new PowdbJsonParam([1, 2, 3])), '"[1,2,3]"');
    // The wrapped JSON STRING "null" is distinct from a bare null.
    assert.equal(encodePowqlLiteral(new PowdbJsonParam('null')), '"\\"null\\""');
  });

  it('materializePowql inlines a PowdbJsonParam without corrupting the $N scan', () => {
    // A json document containing a literal `$1` must round-trip as data, never
    // be re-scanned as a placeholder (the value is a param, not inlined text).
    const powql = 'insert doc { data := $1 } returning';
    const out = materializePowql(powql, [new PowdbJsonParam({ note: 'costs $1 today', x: 2 })]);
    assert.equal(out, 'insert doc { data := "{\\"note\\":\\"costs $1 today\\",\\"x\\":2}" } returning');
  });

  it('coerceValue JSON.parses a json column and distinguishes null / "null" / documents', () => {
    assert.deepEqual(coerceValue('{"a":null}', jcol()), { a: null });
    assert.deepEqual(coerceValue('{}', jcol()), {});
    assert.deepEqual(coerceValue('{"a":"null"}', jcol()), { a: 'null' });
    assert.deepEqual(coerceValue('[1,2,3]', jcol()), [1, 2, 3]);
    // A json STRING document renders WITH quotes and parses to the string.
    assert.equal(coerceValue('"null"', jcol()), 'null');
    // The bare `null` bareword (absent OR a top-level JSON-null doc, legacy-wire
    // ambiguity) maps to null.
    assert.equal(coerceValue('null', jcol()), null);
    // Defensive: non-JSON text falls through to the raw string.
    assert.equal(coerceValue('not json', jcol()), 'not json');
  });

  it('rowToEntity parses a json column end-to-end', () => {
    const meta = table('doc', [
      col('id', 'id', 'string', 'text'),
      col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
    ]);
    const entity = rowToEntity({ id: 'd1', data: '{"a":[1,{"b":true}]}' }, meta);
    assert.deepEqual(entity.data, { a: [1, { b: true }] });
  });
});

// ---------------------------------------------------------------------------
// B1: injected-client-pool version probe fix
// ---------------------------------------------------------------------------

describe('powdb: injected client pool runs the version probe (B1 fix)', () => {
  /** A minimal PowdbClientPool whose single client reports `serverVersion`. */
  function injectedClientPool(serverVersion: string) {
    const client = {
      serverVersion,
      query: async () => ({ kind: 'ok', affected: 0n }),
      close: async () => {},
    };
    return {
      acquire: async () => client,
      release() {},
      destroy() {},
      withClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
      close: async () => {},
    } as unknown as ConstructorParameters<typeof PowdbPool>[0];
  }

  it('rejects an injected pool whose server is below the floor (previously skipped)', async () => {
    await assert.rejects(
      () => turbinePowDB(injectedClientPool('0.6.0'), schema, { warnOnUnlimited: false }),
      ConnectionError,
    );
  });

  it('accepts an injected pool on a supported server and derives its capabilities', async () => {
    const db = await turbinePowDB(injectedClientPool('0.13.0'), schema, { warnOnUnlimited: false });
    await db.disconnect();
  });
});

// ---------------------------------------------------------------------------
// F3: native typed wire (queryNativeRaw) materialization + feature-detect
// ---------------------------------------------------------------------------

/**
 * A fake `@zvndev/powdb-client` pool whose ONE client optionally exposes
 * `queryNativeRaw`. `nativeRows` are returned as a native (WireValue) rows
 * result; every non-native call falls back to a legacy string result. `calls`
 * records which surface (`native` / `legacy`) served each statement.
 */
function fakeNativeClientPool(opts: {
  nativeRows?: { columns: string[]; rows: unknown[][] };
  legacyRows?: { columns: string[]; rows: string[][] };
  withNative?: boolean;
}) {
  const calls: { surface: 'native' | 'legacy'; powql: string }[] = [];
  const legacy = opts.legacyRows ?? { columns: [], rows: [] };
  const client: Record<string, unknown> = {
    serverVersion: '0.13.0',
    query: async (powql: string) => {
      calls.push({ surface: 'legacy', powql });
      return { kind: 'rows', columns: legacy.columns, rows: legacy.rows };
    },
    close: async () => {},
  };
  if (opts.withNative !== false) {
    client.queryNativeRaw = async (powql: string) => {
      calls.push({ surface: 'native', powql });
      const nr = opts.nativeRows ?? { columns: [], rows: [] };
      return { kind: 'rows', columns: nr.columns, rows: nr.rows };
    };
  }
  const pool = {
    acquire: async () => client,
    release() {},
    destroy() {},
    withClient: async (fn: (c: typeof client) => Promise<unknown>) => fn(client),
    close: async () => {},
  } as unknown as ConstructorParameters<typeof PowdbPool>[0];
  return { pool, calls };
}

const nativeCaps = { ...ALL_POWDB_CAPABILITIES, engineVersion: '0.13.0', nativeRaw: true };

describe('powdb: F3 native wire materialization', () => {
  it('decodes every WireValue cell type into JS via queryNativeRaw', async () => {
    const uuidBytes = new Uint8Array([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef,
    ]);
    const { pool, calls } = fakeNativeClientPool({
      nativeRows: {
        columns: ['e', 'i', 'f', 'b', 's', 'snull', 'dt', 'uid', 'jdoc', 'jnull'],
        rows: [
          [
            { type: 'empty' },
            { type: 'int', value: 42n },
            { type: 'float', value: 9.5 },
            { type: 'bool', value: true },
            { type: 'str', value: 'hi' },
            { type: 'str', value: 'null' }, // a genuine str "null" stays a string on native
            { type: 'datetime', value: 1_577_836_800_000_000n },
            { type: 'uuid', value: uuidBytes },
            { type: 'json', value: { a: [1, null], b: 'x' }, pj1: new Uint8Array() },
            { type: 'json', value: null }, // a JSON-null document (distinct from empty)
          ],
        ],
      },
    });
    const p = new PowdbPool(pool, undefined, { capabilities: nativeCaps });
    const res = await p.query('app_user filter .id = $1 { .id }', ['x']);
    assert.equal(calls[0]!.surface, 'native', 'nativeRaw capability routes through queryNativeRaw');
    const row = res.rows[0] as Record<string, unknown>;
    assert.equal(row.e, null); // empty -> null
    assert.equal(row.i, 42n); // int stays bigint (row layer applies the int8 policy)
    assert.equal(row.f, 9.5);
    assert.equal(row.b, true);
    assert.equal(row.s, 'hi');
    assert.equal(row.snull, 'null'); // NOT collapsed to null on the native wire
    assert.equal(row.dt, 1_577_836_800_000_000n); // datetime stays bigint micros
    assert.equal(row.uid, '01234567-89ab-cdef-0123-456789abcdef');
    assert.deepEqual(row.jdoc, { a: [1, null], b: 'x' }); // no re-parse
    assert.equal(row.jnull, null); // JSON-null document decodes to null
  });

  it('falls back to the legacy wire when the client lacks queryNativeRaw (feature-detect)', async () => {
    const { pool, calls } = fakeNativeClientPool({
      withNative: false,
      legacyRows: { columns: ['id'], rows: [['u1']] },
    });
    const p = new PowdbPool(pool, undefined, { capabilities: nativeCaps });
    const res = await p.query('app_user { .id }', []);
    assert.equal(calls[0]!.surface, 'legacy', 'a client with no queryNativeRaw uses the legacy query path');
    assert.deepEqual(res.rows, [{ id: 'u1' }]);
  });

  it('uses the legacy wire when the server capability nativeRaw is off (even if the method exists)', async () => {
    const { pool, calls } = fakeNativeClientPool({
      legacyRows: { columns: ['id'], rows: [['u1']] },
      nativeRows: { columns: ['id'], rows: [[{ type: 'str', value: 'NOPE' }]] },
    });
    // capabilities.nativeRaw defaults false (ALL_POWDB_CAPABILITIES).
    const p = new PowdbPool(pool);
    const res = await p.query('app_user { .id }', []);
    assert.equal(calls[0]!.surface, 'legacy');
    assert.deepEqual(res.rows, [{ id: 'u1' }]);
  });
});

describe('powdb: F3 rowToEntity native branch', () => {
  const meta = table('app_user', [
    col('id', 'id', 'string', 'text'),
    col('name', 'name', 'string', 'text', { nullable: true }),
    col('age', 'age', 'number', 'int4', { nullable: true }),
    col('big', 'big', 'number', 'int8', { nullable: true }), // number-typed int8 → safe-int policy
    col('bigc', 'bigc', 'bigint', 'int8', { nullable: true }), // bigint-typed → passthrough
    col('created_at', 'createdAt', 'Date', 'timestamptz', { nullable: true }),
    col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
  ]);

  it('coerces pre-typed native cells and never collapses a genuine str "null"', () => {
    const entity = rowToEntity(
      {
        id: 'u1',
        name: 'null', // native str "null", stays the string, NOT null
        age: 30n, // int -> safe number
        big: 9_007_199_254_740_993n, // number column, beyond safe int -> string (int8 policy)
        bigc: 9_007_199_254_740_993n, // bigint column -> bigint passthrough
        created_at: 1_577_836_800_000_000n, // datetime micros -> Date
        data: { a: 1 }, // NativeJson doc passthrough
      },
      meta,
      true,
    );
    assert.equal(entity.name, 'null');
    assert.equal(entity.age, 30);
    assert.equal(entity.big, '9007199254740993');
    assert.equal(entity.bigc, 9_007_199_254_740_993n);
    assert.ok(entity.createdAt instanceof Date);
    assert.equal((entity.createdAt as Date).toISOString(), '2020-01-01T00:00:00.000Z');
    assert.deepEqual(entity.data, { a: 1 });
  });

  it('an empty-decoded null stays null; the legacy branch is unchanged (default arg)', () => {
    const nativeNull = rowToEntity({ name: null }, meta, true);
    assert.equal(nativeNull.name, null);
    // Legacy default: a string "null" on a nullable str still collapses (documented wart).
    const legacy = rowToEntity({ name: 'null' }, meta);
    assert.equal(legacy.name, null);
  });
});

// ---------------------------------------------------------------------------
// F5: typed connection errors + stale-frame classification
// ---------------------------------------------------------------------------

describe('powdb: F5 wrapPowdbError connection-class reclassification', () => {
  it('maps the stale "received unexpected frame from server" to ConnectionError (was E003), cause preserved', () => {
    const raw = Object.assign(new Error('received unexpected frame from server'), { code: 'protocol_error' });
    const wrapped = wrapPowdbError(raw);
    assert.ok(wrapped instanceof ConnectionError, 'stale frame is a connection defect, not a query defect');
    assert.match(wrapped.message, /connection is in an invalid state/);
    assert.equal((wrapped as { cause?: unknown }).cause, raw);
  });

  it('maps a bare protocol_error code (any message) to ConnectionError with cause', () => {
    const raw = { code: 'protocol_error', message: 'truncated payload' };
    const wrapped = wrapPowdbError(raw);
    assert.ok(wrapped instanceof ConnectionError);
    assert.equal((wrapped as { cause?: unknown }).cause, raw);
  });

  it('classifies unknown-message / bad-framing shapes by message even without protocol_error code', () => {
    assert.ok(wrapPowdbError({ message: 'unknown message type 99' }) instanceof ConnectionError);
    assert.ok(wrapPowdbError({ message: 'bad framing on the wire' }) instanceof ConnectionError);
  });

  it('does NOT reclassify a Parse "unexpected token" (stays a query ValidationError E003)', () => {
    const wrapped = wrapPowdbError({
      code: 'query_failed',
      message: `Parse("unexpected token in expression: '='")`,
    });
    assert.ok(wrapped instanceof ValidationError, 'a parse error is still a query defect');
  });

  it('maps auth_failed to ConnectionError with a remediation hint and cause', () => {
    const raw = { code: 'auth_failed', message: 'invalid password' };
    const wrapped = wrapPowdbError(raw);
    assert.ok(wrapped instanceof ConnectionError);
    assert.match(wrapped.message, /authentication failed/);
    assert.match(wrapped.message, /user \/ password \/ dbName/);
    assert.equal((wrapped as { cause?: unknown }).cause, raw);
  });

  it('connect_failed / timeout keep their classes and now carry the cause', () => {
    const cf = { code: 'connect_failed', message: 'ECONNREFUSED' };
    const wrappedCf = wrapPowdbError(cf);
    assert.ok(wrappedCf instanceof ConnectionError);
    assert.equal((wrappedCf as { cause?: unknown }).cause, cf);

    const to = { code: 'timeout', message: 'query timed out' };
    const wrappedTo = wrapPowdbError(to);
    assert.ok(wrappedTo instanceof TimeoutError);
    assert.equal((wrappedTo as { cause?: unknown }).cause, to);
  });

  it('size_exceeded stays a ValidationError (E003)', () => {
    assert.ok(wrapPowdbError({ code: 'size_exceeded', message: 'frame too big' }) instanceof ValidationError);
  });
});

describe('powdb: F5 isStaleFramePowdbError predicate + retryStaleReads plumbing', () => {
  it('recognizes exactly the stale-frame ConnectionError (for the read-retry seam)', () => {
    const stale = wrapPowdbError(
      Object.assign(new Error('received unexpected frame from server'), { code: 'protocol_error' }),
    );
    assert.equal(isStaleFramePowdbError(stale), true);
    // A protocol_error whose message lacks the phrase still qualifies via the cause code.
    assert.equal(isStaleFramePowdbError(wrapPowdbError({ code: 'protocol_error', message: 'bad framing' })), true);
    // Non-stale errors do not.
    assert.equal(isStaleFramePowdbError(wrapPowdbError({ code: 'query_failed', message: 'boom' })), false);
    assert.equal(isStaleFramePowdbError(wrapPowdbError({ code: 'connect_failed', message: 'x' })), false);
    assert.equal(isStaleFramePowdbError(new Error('plain')), false);
  });

  it('retryStaleReads plumbs onto the pool for the interface to read (default false)', () => {
    assert.equal(new PowdbPool({} as never).retryStaleReads, false);
    assert.equal(new PowdbPool({} as never, undefined, { retryStaleReads: true }).retryStaleReads, true);
  });
});

// ---------------------------------------------------------------------------
// F1: JsonFilter → PowQL path filters
// ---------------------------------------------------------------------------

describe('powdb F1: JsonFilter → PowQL path filters', () => {
  it('equals with path → `.data->$1->$2 = $3` with typed params', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ where: { data: { path: ['ns', 'value'], equals: 7 } }, limit: 1 });
    assert.match(m.last().powql, /^doc filter \.data->\$1->\$2 = \$3 order.*|^doc filter \.data->\$1->\$2 = \$3 limit/);
    assert.deepEqual(m.last().params.slice(0, 3), ['ns', 'value', 7]);
  });

  it('equals binds string / boolean / int / float by JS shape (never stringified)', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({
      where: { AND: [{ data: { path: ['a'], equals: 'x' } }, { data: { path: ['b'], equals: true } }] },
      limit: 1,
    });
    // ns/value params: $1='a',$2='x',$3='b',$4=true, typed, not String()'d.
    assert.deepEqual(m.last().params.slice(0, 4), ['a', 'x', 'b', true]);
    const m2 = mockPool();
    await qi(m2, 'doc').findMany({ where: { data: { path: ['f'], equals: 2.5 } }, limit: 1 });
    assert.equal(m2.last().params[1], 2.5);
    assert.equal(typeof m2.last().params[1], 'number');
  });

  it('equals: null → `is null` (matches JSON null OR missing key)', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ where: { data: { path: ['a'], equals: null } }, limit: 1 });
    assert.match(m.last().powql, /\.data->\$1 is null/);
    // Only the path segment binds; no equals value param.
    assert.deepEqual(m.last().params.slice(0, 1), ['a']);
  });

  it('range ops → `.data->$n > $m`, joined with `and`, path required + reused', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ where: { data: { path: ['k'], gte: 1, lt: 10 } }, limit: 1 });
    assert.match(m.last().powql, /\(\.data->\$1 >= \$2 and \.data->\$1 < \$3\)/);
    assert.deepEqual(m.last().params.slice(0, 3), ['k', 1, 10]);
  });

  it('hasKey → `json_type(.data->$n) is not null` (ignores path, mirrors PG `?`)', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ where: { data: { hasKey: 'tag' } }, limit: 1 });
    assert.match(m.last().powql, /json_type\(\.data->\$1\) is not null/);
    assert.equal(m.last().params[0], 'tag');
  });

  it('numeric-index and quote/backslash/$N path segments bind as params (materializer-safe)', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ where: { data: { path: ['a"; drop', '$1'], equals: 1 } }, limit: 1 });
    // Segments are $1/$2 tokens; hostile text is a param value, never inlined.
    assert.match(m.last().powql, /\.data->\$1->\$2 = \$3/);
    assert.deepEqual(m.last().params.slice(0, 3), ['a"; drop', '$1', 1]);
  });

  it('a digit-only STRING segment binds as an int array index (SQL parity, matches arrays)', async () => {
    // JsonFilter.path is typed string[], so an array index can only be a digit
    // string. It must bind as an int token (like the SQL builder's `[n]`) or
    // PowDB's typed `->` treats it as a string KEY and silently matches nothing
    // on an array.
    const m = mockPool();
    await qi(m, 'doc').findMany({ where: { data: { path: ['tags', '0'], equals: 'x' } }, limit: 1 });
    assert.match(m.last().powql, /\.data->\$1->\$2 = \$3/);
    // 'tags' stays a str; '0' becomes the number 0 (int index); value 'x'.
    assert.deepEqual(m.last().params.slice(0, 3), ['tags', 0, 'x']);
    assert.equal(typeof m.last().params[1], 'number');
  });

  it('combinators (OR/NOT) wrap JSON conditions', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({
      where: { OR: [{ data: { path: ['a'], equals: 1 } }, { NOT: { data: { path: ['b'], gt: 2 } } }] },
      limit: 1,
    });
    assert.match(m.last().powql, /\(\.data->\$1 = \$2 or not \(\.data->\$3 > \$4\)\)/);
  });

  it('contains → E017 (PowQL has no containment operator)', async () => {
    const m = mockPool();
    await assert.rejects(
      qi(m, 'doc').findMany({ where: { data: { contains: { a: 1 } } as never }, limit: 1 }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /containment/i.test((e as Error).message),
    );
  });

  it('pathless equals → E017 (no whole-document containment)', async () => {
    const m = mockPool();
    await assert.rejects(
      qi(m, 'doc').findMany({ where: { data: { equals: { a: 1 } } as never }, limit: 1 }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /equals without path/i.test((e as Error).message),
    );
  });

  it('jsonDocs capability OFF → E017 with a version hint', async () => {
    const m = mockPool(capabilitiesFromVersion('0.11.0'));
    await assert.rejects(
      qi(m, 'doc').findMany({ where: { data: { path: ['a'], equals: 1 } }, limit: 1 }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /requires PowDB >= 0\.12/.test((e as Error).message),
    );
  });

  it('a bare `{ path }` compiles to no clauses → mutation refused by the empty-where guard', async () => {
    const m = mockPool();
    await assert.rejects(
      qi(m, 'doc').updateMany({ where: { data: { path: ['a'] } }, data: { region: 'z' } }),
      (e: unknown) => e instanceof ValidationError && /where` clause is empty/.test((e as Error).message),
    );
  });

  it('relation-filter resolution flows a JSON inner where through the same compiler', async () => {
    // app_user.posts (hasMany). The inner where on the child runs as a real
    // findMany; give it a JSON filter and assert that inner statement's PowQL.
    const relSchema: SchemaMetadata = {
      enums: {},
      tables: {
        app_user: table('app_user', [col('id', 'id', 'string', 'text', { hasDefault: true })], {
          docs: {
            type: 'hasMany',
            name: 'docs',
            from: 'app_user',
            to: 'doc2',
            foreignKey: 'owner_id',
            referenceKey: 'id',
          },
        }),
        doc2: table('doc2', [
          col('id', 'id', 'string', 'text', { hasDefault: true }),
          col('owner_id', 'ownerId', 'string', 'text'),
          col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
        ]),
      },
    };
    const m = mockPool();
    m.setRows([]); // inner collect returns no keys → outer resolves to a no-match
    const userQi = new PowqlInterface(m.pool, 'app_user', relSchema, [], { warnOnUnlimited: false });
    await userQi.findMany({ where: { docs: { some: { data: { path: ['k'], equals: 5 } } } }, limit: 1 });
    const inner = m.calls.find((c) => c.powql.startsWith('doc2'));
    assert.ok(inner, 'inner child query ran');
    assert.match(inner!.powql, /\.data->\$1 = \$2/);
    assert.deepEqual(inner!.params.slice(0, 2), ['k', 5]);
  });
});

// ---------------------------------------------------------------------------
// F2: JSON-path orderBy and groupBy
// ---------------------------------------------------------------------------

describe('powdb F2: JSON-path orderBy', () => {
  it('path order → `order .data->$n asc`', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ orderBy: { data: { path: ['k'] } } as never, limit: 1 });
    assert.match(m.last().powql, / order \.data->\$1 asc /);
  });

  it('desc + numeric cast', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({
      orderBy: { data: { path: ['n'], direction: 'desc', type: 'numeric' } } as never,
      limit: 1,
    });
    assert.match(m.last().powql, / order cast\(\.data->\$1, "float"\) desc /);
  });

  it('nulls:last accepted (no-op); nulls:first → E017', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ orderBy: { data: { path: ['k'], nulls: 'last' } } as never, limit: 1 });
    assert.match(m.last().powql, / order \.data->\$1 asc /);
    await assert.rejects(
      qi(mockPool(), 'doc').findMany({ orderBy: { data: { path: ['k'], nulls: 'first' } } as never, limit: 1 }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /NULLS FIRST/i.test((e as Error).message),
    );
  });

  it('OrderBySpec { sort, nulls:last } accepted; nulls:first → E017', async () => {
    const m = mockPool();
    await qi(m, 'doc').findMany({ orderBy: { region: { sort: 'desc', nulls: 'last' } } as never, limit: 1 });
    assert.match(m.last().powql, / order \.region desc /);
    await assert.rejects(
      qi(mockPool(), 'doc').findMany({ orderBy: { region: { sort: 'asc', nulls: 'first' } } as never, limit: 1 }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /NULLS FIRST/i.test((e as Error).message),
    );
  });

  it('jsonDocs OFF → E017 version hint on path order', async () => {
    await assert.rejects(
      new PowqlInterface(mockPool(capabilitiesFromVersion('0.11.0')).pool, 'doc', schema).findMany({
        orderBy: { data: { path: ['k'] } } as never,
        limit: 1,
      }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /requires PowDB >= 0\.12/.test((e as Error).message),
    );
  });
});

describe('powdb F2: JSON-path + aggregate groupBy', () => {
  it('JSON group key → `group .data->$1` with `gk_0` alias + `min(json_type)` discriminator + `count(*)`', async () => {
    const m = mockPool();
    m.setRows([]);
    await qi(m, 'doc').groupBy({ by: [{ field: 'data', path: ['a'] }] as never, _count: true });
    const p = m.last().powql;
    assert.match(p, /group \.data->\$1/);
    assert.match(p, /gk_0: \.data->\$1/);
    assert.match(p, /gt_0: min\(json_type\(\.data->\$1\)\)/);
    assert.match(p, /agg_0: count\(\*\)/);
    assert.equal(m.last().params[0], 'a');
  });

  it('native pool omits the discriminator projection', async () => {
    const m = mockPool({ ...ALL_POWDB_CAPABILITIES, nativeRaw: true });
    m.setRows([]);
    await qi(m, 'doc').groupBy({ by: [{ field: 'data', path: ['a'] }] as never, _count: true });
    assert.doesNotMatch(m.last().powql, /json_type/);
    assert.match(m.last().powql, /gk_0: \.data->\$1/);
  });

  it('JSON aggregate target → `sum(cast(.data->$n, "float"))`; _sum type:text → E003', async () => {
    const m = mockPool();
    m.setRows([]);
    await qi(m, 'doc').groupBy({
      by: ['region'],
      _sum: { rev: { field: 'data', path: ['rev'] } } as never,
    });
    // `_count` is default-selected (SQL parity), so it takes `agg_0` and the
    // `_sum` target shifts to `agg_1`.
    assert.match(m.last().powql, /agg_0: count\(\*\)/);
    assert.match(m.last().powql, /agg_1: sum\(cast\(\.data->\$1, "float"\)\)/);
    await assert.rejects(
      qi(mockPool(), 'doc').groupBy({
        by: ['region'],
        _sum: { rev: { field: 'data', path: ['rev'], type: 'text' } } as never,
      }),
      (e: unknown) => e instanceof ValidationError && /always numeric/.test((e as Error).message),
    );
  });

  it('orderBy by _count / _sum alias emits `order .agg_N`; unrequested aggregate → E003', async () => {
    const m = mockPool();
    m.setRows([]);
    await qi(m, 'doc').groupBy({ by: ['region'], _count: true, orderBy: { _count: 'desc' } });
    assert.match(m.last().powql, / order \.agg_0 desc /);
    // _sum not requested → E003 listing valid keys.
    await assert.rejects(
      qi(mockPool(), 'doc').groupBy({ by: ['region'], _count: true, orderBy: { _sum: { rev: 'desc' } } }),
      (e: unknown) => e instanceof ValidationError && /not requested/.test((e as Error).message),
    );
  });

  it('orderBy by an unknown key → E003 listing orderable keys', async () => {
    await assert.rejects(
      qi(mockPool(), 'doc').groupBy({ by: ['region'], _count: true, orderBy: { nope: 'asc' } }),
      (e: unknown) => e instanceof ValidationError && /Unknown field "nope"/.test((e as Error).message),
    );
  });

  it('JSON group-key alias collision with a by-column → E003', async () => {
    await assert.rejects(
      qi(mockPool(), 'doc').groupBy({ by: ['region', { field: 'data', path: ['region'] }] as never }),
      (e: unknown) => e instanceof ValidationError && /collides/.test((e as Error).message),
    );
  });

  it('HAVING _count uses count(*)', async () => {
    const m = mockPool();
    m.setRows([]);
    await qi(m, 'doc').groupBy({ by: ['region'], _count: true, having: { _count: { gt: 1 } } } as never);
    assert.match(m.last().powql, /having count\(\*\) > \$/);
  });

  it('groupBy nulls:first ordering → E017', async () => {
    await assert.rejects(
      qi(mockPool(), 'doc').groupBy({
        by: ['region'],
        _count: true,
        orderBy: { region: { sort: 'asc', nulls: 'first' } },
      }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /NULLS FIRST/.test((e as Error).message),
    );
  });

  it('jsonDocs OFF → E017 version hint on JSON group key', async () => {
    await assert.rejects(
      new PowqlInterface(mockPool(capabilitiesFromVersion('0.11.0')).pool, 'doc', schema).groupBy({
        by: [{ field: 'data', path: ['a'] }] as never,
        _count: true,
      }),
      (e: unknown) => e instanceof UnsupportedFeatureError && /requires PowDB >= 0\.12/.test((e as Error).message),
    );
  });

  it('discriminator disambiguates the legacy-wire null / string-"null" groups in the transform', async () => {
    const m = mockPool();
    // Two "null"-rendering groups: gt_0="null" → JS null; gt_0="string" → "null".
    m.setRows([
      { gk_0: 'null', gt_0: 'null', agg_0: '2' },
      { gk_0: 'null', gt_0: 'string', agg_0: '1' },
      { gk_0: '7', gt_0: 'number', agg_0: '3' },
    ]);
    const out = await qi(m, 'doc').groupBy({ by: [{ field: 'data', path: ['a'] }] as never, _count: true });
    assert.deepEqual(out, [
      { a: null, _count: 2 },
      { a: 'null', _count: 1 },
      { a: '7', _count: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Integration hooks: PowdbJsonParam write path, nativeRaw shape() threading,
// retryStaleReads exec retry
// ---------------------------------------------------------------------------

describe('powdb hook: param() wraps a json document in PowdbJsonParam on write', () => {
  it('create binds an object/array value as a PowdbJsonParam for a json column', async () => {
    const m = mockPool();
    m.setRows([{ id: 'd1', data: '{"a":1}', region: null }]);
    await qi(m, 'doc').create({ data: { id: 'd1', data: { a: 1 }, region: null } as never });
    const jsonParam = m.last().params.find((p) => p instanceof PowdbJsonParam) as PowdbJsonParam | undefined;
    assert.ok(jsonParam, 'the object value is wrapped in PowdbJsonParam');
    assert.deepEqual(jsonParam!.value, { a: 1 });
    // A JS string to a json column passes through raw (not wrapped).
    const m2 = mockPool();
    m2.setRows([{ id: 'd2', data: '"x"', region: null }]);
    await qi(m2, 'doc').create({ data: { id: 'd2', data: '"x"' } as never });
    assert.equal(
      m2.last().params.some((p) => p instanceof PowdbJsonParam),
      false,
    );
  });
});

describe('powdb hook: shape() threads capabilities.nativeRaw into rowToEntity', () => {
  it('native pool keeps a genuine str "null" (no legacy collapse)', async () => {
    const m = mockPool({ ...ALL_POWDB_CAPABILITIES, nativeRaw: true });
    // Native cells arrive pre-typed: region "null" is a real string, absent id is null.
    m.setRows([{ id: 'd1', data: { a: 1 }, region: 'null' }]);
    const [row] = await qi(m, 'doc').findMany({ limit: 1 });
    assert.equal((row as { region: string }).region, 'null');
    assert.deepEqual((row as { data: unknown }).data, { a: 1 });
  });

  it('legacy pool collapses a str "null" to null (unchanged wart)', async () => {
    const m = mockPool(); // nativeRaw false
    m.setRows([{ id: 'd1', region: 'null' }]);
    const [row] = await qi(m, 'doc').findMany({ limit: 1 });
    assert.equal((row as { region: unknown }).region, null);
  });

  it('per-result native flag overrides the pool capability (heterogeneous legacy fallback)', async () => {
    // Pool advertises nativeRaw, but THIS result was served by the legacy wire
    // (native:false tag from adaptResult): shape() must key coercion on the
    // per-result flag, so a legacy-wire str "null" still collapses instead of
    // being handed to the native no-collapse policy.
    const pool = {
      capabilities: { ...ALL_POWDB_CAPABILITIES, nativeRaw: true },
      retryStaleReads: false,
      query: () => Promise.resolve({ rows: [{ id: 'd1', region: 'null' }], rowCount: 1, native: false }),
    } as unknown as PowdbPool;
    const [row] = await new PowqlInterface(pool, 'doc', schema).findMany({ limit: 1 });
    assert.equal((row as { region: unknown }).region, null);
  });

  it('a native-tagged result keeps a genuine str "null" even on a legacy-capability pool', async () => {
    const pool = {
      capabilities: { ...ALL_POWDB_CAPABILITIES, nativeRaw: false },
      retryStaleReads: false,
      query: () => Promise.resolve({ rows: [{ id: 'd1', region: 'null' }], rowCount: 1, native: true }),
    } as unknown as PowdbPool;
    const [row] = await new PowqlInterface(pool, 'doc', schema).findMany({ limit: 1 });
    assert.equal((row as { region: string }).region, 'null');
  });
});

describe('powdb hook: groupBy result cells go through the same native coercion as findMany', () => {
  it('native plain by-key int cell (bigint) becomes a number, not a leaked bigint', async () => {
    const m = mockPool({ ...ALL_POWDB_CAPABILITIES, nativeRaw: true });
    m.setRows([{ age: 30n, agg_0: 2n }]);
    const out = await qi(m, 'app_user').groupBy({ by: ['age'] });
    assert.equal(out[0]!.age, 30);
    assert.equal(typeof out[0]!.age, 'number');
    assert.equal(out[0]!._count, 2); // _count default-selected (SQL parity)
    assert.doesNotThrow(() => JSON.stringify(out), 'no BigInt serialize crash');
  });

  it('native plain by-key datetime cell (bigint micros) becomes a Date', async () => {
    const m = mockPool({ ...ALL_POWDB_CAPABILITIES, nativeRaw: true });
    const micros = BigInt(Date.UTC(2026, 0, 1)) * 1000n;
    m.setRows([{ created_at: micros, agg_0: 1n }]);
    const out = await qi(m, 'app_user').groupBy({ by: ['createdAt'] });
    assert.ok(out[0]!.createdAt instanceof Date);
    assert.equal((out[0]!.createdAt as Date).toISOString(), '2026-01-01T00:00:00.000Z');
  });

  it('native plain by-key str "null" stays "null" (no legacy collapse in groupBy)', async () => {
    const m = mockPool({ ...ALL_POWDB_CAPABILITIES, nativeRaw: true });
    m.setRows([{ region: 'null', agg_0: 1n }]);
    const out = await qi(m, 'doc').groupBy({ by: ['region'] });
    assert.equal(out[0]!.region, 'null');
  });

  it('native JSON group key (bigint / bool) comes back as PG-text-parity strings', async () => {
    const m = mockPool({ ...ALL_POWDB_CAPABILITIES, nativeRaw: true });
    m.setRows([
      { gk_0: 7n, agg_0: 2n },
      { gk_0: true, agg_0: 1n },
      { gk_0: null, agg_0: 3n },
    ]);
    const out = await qi(m, 'doc').groupBy({ by: [{ field: 'data', path: ['k'] }] as never });
    assert.equal(out[0]!.k, '7'); // not 7n
    assert.equal(out[1]!.k, 'true');
    assert.equal(out[2]!.k, null);
    assert.doesNotThrow(() => JSON.stringify(out), 'no BigInt serialize crash');
  });

  it('legacy and native groupBy agree on value types for the same data (int key)', async () => {
    const legacy = mockPool();
    legacy.setRows([{ age: '30', agg_0: '2' }]);
    const l = await qi(legacy, 'app_user').groupBy({ by: ['age'] });
    const native = mockPool({ ...ALL_POWDB_CAPABILITIES, nativeRaw: true });
    native.setRows([{ age: 30n, agg_0: 2n }]);
    const n = await qi(native, 'app_user').groupBy({ by: ['age'] });
    assert.deepEqual(l, n); // identical shape across transports
  });
});

describe('powdb hook: retryStaleReads replays a READ once, never a write, never in a tx', () => {
  /** A pool whose query() throws the stale-frame error on the first N calls, then succeeds. */
  function flakyPool(failFirst: number, opts: { retryStaleReads?: boolean } = {}) {
    let attempts = 0;
    const pool = {
      capabilities: ALL_POWDB_CAPABILITIES,
      retryStaleReads: opts.retryStaleReads ?? true,
      query(_powql: string, _params: unknown[]) {
        attempts++;
        if (attempts <= failFirst) {
          return Promise.reject(
            wrapPowdbError(
              Object.assign(new Error('received unexpected frame from server'), { code: 'protocol_error' }),
            ),
          );
        }
        return Promise.resolve({ rows: [{ id: 'ok' }], rowCount: 1 });
      },
    } as unknown as PowdbPool;
    return { pool, attempts: () => attempts };
  }

  it('a findMany retries exactly once on the stale-frame error and succeeds', async () => {
    const f = flakyPool(1);
    const rows = await new PowqlInterface(f.pool, 'doc', schema).findMany({ limit: 1 });
    assert.equal(rows.length, 1);
    assert.equal(f.attempts(), 2, 'one original + one retry');
  });

  it('does NOT retry when retryStaleReads is off', async () => {
    const f = flakyPool(1, { retryStaleReads: false });
    await assert.rejects(new PowqlInterface(f.pool, 'doc', schema).findMany({ limit: 1 }), ConnectionError);
    assert.equal(f.attempts(), 1);
  });

  it('does NOT retry a WRITE (create): one attempt, error surfaces', async () => {
    const f = flakyPool(1);
    await assert.rejects(
      new PowqlInterface(f.pool, 'doc', schema).create({ data: { id: 'x' } as never }),
      ConnectionError,
    );
    assert.equal(f.attempts(), 1);
  });

  it('does NOT retry inside a _txScoped interface', async () => {
    const f = flakyPool(1);
    const txQi = new PowqlInterface(f.pool, 'doc', schema, [], { _txScoped: true } as never);
    await assert.rejects(txQi.findMany({ limit: 1 }), ConnectionError);
    assert.equal(f.attempts(), 1);
  });

  it('gives up after one retry when the error persists', async () => {
    const f = flakyPool(2);
    await assert.rejects(new PowqlInterface(f.pool, 'doc', schema).findMany({ limit: 1 }), ConnectionError);
    assert.equal(f.attempts(), 2, 'original + exactly one retry, then throws');
  });

  it('a concurrent READ never turns a failing WRITE into a replayed insert (per-call action, not shared state)', async () => {
    // Regression for the currentAction race: TurbineClient caches ONE
    // PowqlInterface per table, so a concurrent findMany used to flip the
    // shared `currentAction` to a read action while a create's insert was in
    // flight; when the insert then hit the stale-frame error, the retry gate
    // read the flipped state and REPLAYED the mutation (double insert). The
    // action is now a per-call argument, so a write is never mistaken for a
    // read no matter what a sibling op is doing.
    let inserts = 0;
    let releaseInsert!: () => void;
    const insertGate = new Promise<void>((r) => {
      releaseInsert = r;
    });
    const pool = {
      capabilities: ALL_POWDB_CAPABILITIES,
      retryStaleReads: true,
      async query(powql: string) {
        if (/^insert .* returning$/.test(powql)) {
          inserts++;
          // Fail only AFTER the concurrent read has run (which, in the old
          // code, had already flipped the shared action to 'findMany').
          await insertGate;
          throw wrapPowdbError(
            Object.assign(new Error('received unexpected frame from server'), { code: 'protocol_error' }),
          );
        }
        // The read: it has now started concurrently, release the insert's failure.
        releaseInsert();
        return { rows: [{ id: 'ok' }], rowCount: 1 };
      },
    } as unknown as PowdbPool;
    const iface = new PowqlInterface(pool, 'doc', schema);
    const [createResult, readResult] = await Promise.allSettled([
      iface.create({ data: { id: 'x' } as never }),
      iface.findMany({ limit: 1 }),
    ]);
    assert.equal(readResult.status, 'fulfilled', 'the concurrent read still succeeds');
    assert.equal(createResult.status, 'rejected', 'the write surfaces its error, never a replayed success');
    assert.ok(
      (createResult as PromiseRejectedResult).reason instanceof ConnectionError,
      'the write rejects with the typed ConnectionError (E004)',
    );
    assert.equal(inserts, 1, 'the insert executed EXACTLY once: the write was never replayed');
  });
});

// ---------------------------------------------------------------------------
// E1: legacy string-wire lexer-ceiling assertion (MED-1)
// ---------------------------------------------------------------------------

describe('powdb: PowdbEmbeddedPool legacy-wire lexer ceiling (E1)', () => {
  it('the tested ceiling is the expected engine line', () => {
    // A canary: bumping the ceiling MUST be a deliberate, reviewed act (it
    // asserts the escaper was re-verified against a newer lexer).
    assert.equal(POWQL_LEXER_TESTED_CEILING, '0.16');
  });

  it('refuses the legacy materialize path on an addon newer than the ceiling', async () => {
    // A legacy-only handle (no queryWithParams) whose capabilities claim engine
    // 0.17.0, newer than the escaper's verified lexer range. Reaching the legacy
    // wire in this state is the dangerous "newer-addon-without-native" anomaly, so
    // exec() must refuse rather than inline-encode against an unverified lexer.
    const { pool, seen } = fakeEmbeddedDb(
      { kind: 'ok', affected: 1n },
      { capabilities: capabilitiesFromVersion('0.17.0', { hasNativeRaw: true }) },
    );
    const err = await pool.query('insert app_user { name := $1 }', ['Ada']).then(
      () => null,
      (e: unknown) => e as Error,
    );
    assert.ok(err instanceof ValidationError, 'refusal is a typed ValidationError');
    assert.equal((err as ValidationError).code, TurbineErrorCode.VALIDATION);
    assert.match((err as Error).message, /0\.17\.0/, 'names the reported engine version');
    assert.match((err as Error).message, new RegExp(POWQL_LEXER_TESTED_CEILING.replace('.', '\\.')));
    assert.match((err as Error).message, /queryWithParams/, 'explains the feature-detect anomaly');
    // Nothing was ever handed to the engine.
    assert.equal(seen.length, 0, 'the query never reached the addon');
  });

  it('still materializes literals on a pre-0.14 legacy addon (happy path untouched)', async () => {
    // 0.13.0 is within the verified lexer range and legitimately has no native
    // wire, so the legacy materialize path stays live and byte-for-byte unchanged.
    const { pool, seen } = fakeEmbeddedDb(
      { kind: 'rows', columns: ['id', 'name'], rows: [['u1', 'Ada']] },
      { capabilities: capabilitiesFromVersion('0.13.0') },
    );
    const res = await pool.query('insert app_user { id := $1, name := $2 } returning', ['u1', 'Ada']);
    assert.equal(seen.length, 1);
    assert.equal(seen[0], 'insert app_user { id := "u1", name := "Ada" } returning');
    assert.deepEqual(res.rows, [{ id: 'u1', name: 'Ada' }]);
  });
});
