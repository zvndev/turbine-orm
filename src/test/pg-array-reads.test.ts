import assert from 'node:assert/strict';
import diagnosticsChannel from 'node:diagnostics_channel';
import { after, describe, it } from 'node:test';
import { types as valueTypes } from 'node:util';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { postgresDialect } from '../dialect.js';
import type { PgCompatFieldDef, PgCompatPool, PgCompatQueryResult } from '../pg-types.js';
import type { MiddlewareFn, QueryEvent, QueryInterfaceOptions } from '../query/deferred.js';
import { QueryInterface, UNSAFE } from '../query/index.js';
import type { FindManyArgs } from '../query/types.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import { QUERY_CHANNEL, type QueryChannelContext } from '../query-channel.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { type TypeParserTable, typedQueryPool } from '../supplied-pool-types.js';
import { mockTable, skipGate } from './helpers.js';

const columns = [
  { name: 'id', field: 'id', pgType: 'int4' },
  { name: 'created_at', field: 'createdAt', pgType: 'timestamptz' },
  { name: 'big_value', field: 'bigValue', pgType: 'int8' },
  { name: 'data', field: 'data', pgType: 'bytea' },
  { name: 'score', field: 'score', pgType: 'float8' },
  { name: 'secret', field: 'secret', pgType: 'text', pii: true },
  { name: '__proto__', field: '__proto__', pgType: 'text' },
  { name: 'constructor', field: 'constructor', pgType: 'text' },
  { name: 'toString', field: 'toString', pgType: 'text' },
  { name: '1', field: 'first', pgType: 'text' },
  { name: '2', field: 'second', pgType: 'text' },
];
const table = mockTable('array_read_fixture', columns);
table.columnMap = Object.fromEntries(columns.map((c) => [c.field, c.name]));
table.reverseColumnMap = Object.fromEntries(columns.map((c) => [c.name, c.field]));
table.dateColumns = new Set(['created_at']);
table.relations.parent = {
  type: 'belongsTo',
  name: 'parent',
  from: table.name,
  to: table.name,
  foreignKey: 'id',
  referenceKey: 'id',
};
const schema: SchemaMetadata = { tables: { array_read_fixture: table }, enums: {} };

/**
 * A value whose content lives in internal slots rather than in own
 * properties, so walking its keys would compare nothing.
 */
function hasInternalState(value: object): boolean {
  return (
    valueTypes.isMap(value) ||
    valueTypes.isSet(value) ||
    valueTypes.isAnyArrayBuffer(value) ||
    valueTypes.isDataView(value) ||
    valueTypes.isRegExp(value) ||
    valueTypes.isBoxedPrimitive(value) ||
    valueTypes.isNativeError(value)
  );
}

/**
 * Strict equality of two decoded results: prototypes, own keys in order,
 * property flags, primitives by `Object.is`, dates by their time value and
 * buffers by their bytes. Written out instead of `assert.deepStrictEqual`
 * over the whole result because that reports two Invalid Dates as unequal on
 * Node 20, and the temporal cases here produce one on both sides. A value
 * that keeps its content in internal slots (a Map, a Set, a boxed primitive)
 * still goes to `assert.deepStrictEqual`, which is what can see inside it.
 */
function exact(actual: unknown, expected: unknown): void {
  if (actual === null || typeof actual !== 'object') {
    assert.ok(Object.is(actual, expected), `${String(actual)} is not ${String(expected)}`);
    return;
  }
  assert.ok(expected !== null && typeof expected === 'object');
  assert.equal(Object.getPrototypeOf(actual), Object.getPrototypeOf(expected));
  // A buffer's bytes are compared at once; its index keys are then skipped and
  // any other property it carries is walked like everything else.
  const bytes = Buffer.isBuffer(actual);
  if (bytes) assert.ok(Buffer.isBuffer(expected) && actual.equals(expected));
  else if (actual instanceof Date) assert.ok(Object.is(actual.getTime(), (expected as Date).getTime()));
  else if (actual instanceof URL) assert.equal(actual.href, (expected as URL).href);
  else if (hasInternalState(actual)) assert.deepStrictEqual(actual, expected);
  const keys = (value: object) =>
    Reflect.ownKeys(value).filter((key) => !bytes || typeof key === 'symbol' || !/^\d+$/.test(key));
  assert.deepEqual(keys(actual), keys(expected));
  for (const key of keys(actual)) {
    const { value: a, ...flags } = Object.getOwnPropertyDescriptor(actual, key)!;
    const { value: e, ...expectedFlags } = Object.getOwnPropertyDescriptor(expected, key)!;
    assert.deepEqual(flags, expectedFlags);
    exact(a, e);
  }
}

interface Config {
  text: string;
  values?: unknown[];
  name?: string;
  rowMode?: 'array';
  types?: TypeParserTable;
}

const Result = (
  pg as unknown as {
    Result: new (
      mode?: string,
      types?: TypeParserTable,
    ) => PgCompatQueryResult & {
      addFields(fields: PgCompatFieldDef[]): void;
      parseRow(values: (string | null)[]): Record<string, unknown>;
    };
  }
).Result;

function fixture(
  fields: PgCompatFieldDef[],
  rows: (string | null)[][],
  options: QueryInterfaceOptions & { middlewares?: MiddlewareFn[] } = {},
  parsers: Record<number, (value: string) => unknown> = {},
  meta: TableMetadata = table,
  metadata: SchemaMetadata = schema,
) {
  const calls: Config[] = [];
  const parsing: string[] = [];
  let failure: Error | undefined;
  const pool = new pg.Pool({
    types: {
      getTypeParser(oid: number, format?: string) {
        const parse = parsers[oid] ?? pg.types.getTypeParser(oid, format as 'text');
        return (value: string) => {
          parsing.push(`${oid}:${format}:${value}`);
          return oid === 25 ? `custom:${value}` : parse(value);
        };
      },
    },
  });
  const send = async (input: string | Config, values?: unknown[]) => {
    const config = typeof input === 'string' ? { text: input, values } : input;
    calls.push(config);
    if (failure) throw failure;
    const result = new Result(config.rowMode, config.types ?? pool.options.types);
    result.addFields(fields);
    result.rows = rows.map((row) => result.parseRow(row));
    result.rowCount = rows.length;
    return result;
  };
  Object.defineProperty(pool, 'query', { value: send, writable: true, configurable: true });
  const typed = typedQueryPool(pool, options.utcTimestamps !== false)!;
  const objectPool: PgCompatPool = {
    query: typed.query.bind(typed),
    connect: typed.connect.bind(typed),
    end: typed.end.bind(typed),
  };
  const qi = (source: PgCompatPool, extra: QueryInterfaceOptions = {}) =>
    new QueryInterface<Record<string, unknown>>(source, meta.name, metadata, options.middlewares, {
      warnOnUnlimited: false,
      preparedStatements: true,
      ...options,
      ...extra,
    });
  return {
    pool,
    calls,
    parsing,
    array: qi(typed),
    object: qi(objectPool),
    qi,
    typed,
    fail(error: Error) {
      failure = error;
    },
  };
}

const field = (name: string, dataTypeID = 25): PgCompatFieldDef => ({ name, dataTypeID, format: 'text' });

// Wire inputs are fed through pg.Result in both modes, not pre-decoded mocks.
const wireTypes: [string, number, number, string[]][] = [
  ['int2', 21, 1005, ['-32768', '32767']],
  ['int4', 23, 1007, ['-2147483648', '2147483647']],
  ['int8', 20, 1016, ['42', '9007199254740993', '-9223372036854775808']],
  ['numeric', 1700, 1231, ['12345678901234567890.123456789', 'NaN', 'Infinity', '-Infinity']],
  ['float4', 700, 1021, ['1.25', 'NaN', 'Infinity', '-Infinity', '-0']],
  ['float8', 701, 1022, ['1.25', 'NaN', 'Infinity', '-Infinity', '-0']],
  ['bool', 16, 1000, ['t', 'f']],
  ['text', 25, 1009, ['', 'NULL', 'quote" slash\\ comma, braces{}', '日本語']],
  ['bytea', 17, 1001, ['\\x', '\\x0001ff']],
  ['uuid', 2950, 2951, ['a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11']],
  ['json', 114, 199, ['{"b":2,"a":[null,1,true],"__proto__":{"x":1}}', 'null', '[1,"x"]']],
  ['jsonb', 3802, 3807, ['{"a": [null, 1, true], "b": 2}', 'null', '[1,"x"]']],
  ['date', 1082, 1182, ['2024-02-29', 'infinity', '-infinity', '0001-01-01 BC', '10000-01-01', '5874897-12-31']],
  [
    'timestamp',
    1114,
    1115,
    [
      '2024-02-29 12:34:56.123456',
      'infinity',
      '-infinity',
      '0001-01-01 00:00:00 BC',
      '10000-01-01 00:00:00',
      '294276-12-31 23:59:59',
    ],
  ],
  [
    'timestamptz',
    1184,
    1185,
    [
      '2024-02-29 12:34:56.123456+05:45',
      'infinity',
      '-infinity',
      '0001-01-01 00:00:00+00 BC',
      '10000-01-01 00:00:00+00',
      '294276-12-31 23:59:59+00',
    ],
  ],
  ['interval', 1186, 1187, ['1 year 2 mons -3 days 04:05:06.789', '00:00:00']],
  ['array_read_mood', 99001, 99002, ['happy', 'comma,quote"slash\\']],
  ['vector', 99003, 99004, ['[1,2,3]', '[]']],
];
const arrayText = (values: (string | null)[]) =>
  `{${values.map((value) => (value === null ? 'NULL' : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)).join(',')}}`;

describe('native pg array read decoding', () => {
  it('generates scalar and array wire cases with nulls, temporal extremes and all governed decoders', async () => {
    const definitions = wireTypes.flatMap(([pgType], i) => [
      { name: `c_${i}`, field: `c${i}`, pgType },
      { name: `a_${i}`, field: `a${i}`, pgType: `${pgType}[]` },
    ]);
    const meta = mockTable('wire_array_reads', definitions);
    meta.dateColumns = new Set(
      definitions.filter((c) => /^(date|timestamp|timestamptz)(\[\])?$/.test(c.pgType)).map((c) => c.name),
    );
    const metadata: SchemaMetadata = {
      tables: { [meta.name]: meta },
      enums: { array_read_mood: ['happy', 'comma,quote"slash\\'] },
    };
    const fields = wireTypes.flatMap(([, oid, arrayOid], i) => [field(`c_${i}`, oid), field(`a_${i}`, arrayOid)]);
    const rows = Array.from({ length: 12 }, (_, n) =>
      wireTypes.flatMap(([, , , values]) => {
        if (n === 0) return [null, null];
        const value = values[(n - 1) % values.length]!;
        return [
          value,
          n === 1
            ? '{}'
            : n === 2
              ? `{{${arrayText([value, null]).slice(1, -1)}},{${arrayText([null, value]).slice(1, -1)}}}`
              : arrayText([value, null, ...values]),
        ];
      }),
    );
    for (const utcTimestamps of [true, false]) {
      for (const temporalInfinity of ['preserve', 'null'] as const) {
        const h = fixture(fields, rows, { utcTimestamps, temporalInfinity }, {}, meta, metadata);
        const expected = await h.object.findMany();
        const parsing = h.parsing.splice(0);
        const actual = await h.array.findMany();
        exact(actual, expected);
        exact(h.parsing, parsing);
        assert.equal(actual.length, 12);
        assert.equal(h.calls.at(-1)!.rowMode, 'array');
        assert.ok(Object.values(actual[0]!).every((v) => v === null));
        assert.equal(actual[3]!.c2, '-9223372036854775808');
        assert.notEqual(actual[1], expected[1]);
        const saved = expected[1]!.c0;
        actual[1]!.c0 = 'mutable';
        assert.equal(expected[1]!.c0, saved);
      }
    }
  });

  it('keeps empty results from invoking dialect decoder factories', async () => {
    const observed: string[] = [];
    const h = fixture([field('id', 23)], [], {
      dialect: {
        ...postgresDialect,
        decodeColumnValue(type) {
          observed.push(type);
          return undefined;
        },
      },
    });
    exact(await h.object.findMany(), []);
    assert.deepEqual(observed, []);
    exact(await h.array.findMany(), []);
    assert.equal(h.calls.at(-1)!.rowMode, 'array');
    assert.deepEqual(observed, []);
  });

  it('preserves custom parser prototypes and per-connection parser tables', async () => {
    class CustomValue {
      constructor(readonly text: string) {}
    }
    const h = fixture([field('value', 99005)], [['custom'], [null]]);
    Reflect.set(h.pool, '_clients', [
      { binary: false, _types: { getTypeParser: () => (value: string) => new CustomValue(value) } },
    ]);
    const expected = await h.object.findMany();
    const actual = await h.array.findMany();
    exact(actual, expected);
    assert.ok(actual[0]!.value instanceof CustomValue);
    assert.equal(h.calls.at(-1)!.rowMode, 'array');
  });

  it('preserves logger observations for unlimited reads and temporal infinity', async () => {
    const observations: unknown[][] = [];
    for (const mode of ['object', 'array'] as const) {
      resetWarnOnce();
      const logs: unknown[] = [];
      const h = fixture([field('created_at', 1184)], [['infinity']], {
        warnOnUnlimited: true,
        diagnostics: { advice: true },
        logger: { warn: (message, entry) => logs.push({ message, entry }) },
      });
      await h[mode].findMany();
      assert.ok(logs.length > 0);
      observations.push(logs);
    }
    exact(observations[1], observations[0]);
    resetWarnOnce();
  });

  it('preserves bigint and Buffer values from caller-owned parsers', async () => {
    const h = fixture(
      [field('id', 23), field('data', 17)],
      [['9007199254740993', '\\x00ff']],
      {},
      {
        23: BigInt,
        17: () => Buffer.from([255, 0, 255]),
      },
    );
    const expected = await h.object.findMany();
    const actual = await h.array.findMany();
    exact(actual, expected);
    assert.equal(actual[0]!.id, 9007199254740993n);
    assert.ok(Buffer.isBuffer(actual[0]!.data));
  });

  it('matches pg object rows for duplicate names, integer keys, special names and converted values', async () => {
    const fields = [
      field('2'),
      field('created_at', 1184),
      field('id', 23),
      field('big_value', 20),
      field('data', 17),
      field('score', 701),
      field('__proto__'),
      field('constructor'),
      field('1'),
      field('id', 23),
      field('unknown_column'),
    ];
    const h = fixture(
      fields,
      [
        [
          'two',
          '2020-01-02 03:04:05.678+00',
          '1',
          '9007199254740993',
          '\\x00ff',
          'NaN',
          'safe',
          'ctor',
          'one',
          '9',
          'raw',
        ],
        [null, 'infinity', '2', '42', '\\x', '-Infinity', null, null, null, '10', null],
      ],
      { temporalInfinity: 'null' },
    );
    const expected = await h.object.findMany();
    const before = h.parsing.splice(0);
    const actual = await h.array.findMany();
    assert.equal(actual.length, 2);
    exact(actual, expected);
    assert.deepEqual(h.parsing, before, 'driver parser call order and inputs stay identical');
    assert.equal(h.calls.at(-1)!.rowMode, 'array');
    assert.equal(actual[0]!.id, 9);
    assert.equal(actual[0]!.bigValue, '9007199254740993');
    assert.equal(actual[1]!.bigValue, 42);
    assert.ok(actual[0]!.createdAt instanceof Date);
    assert.ok(Buffer.isBuffer(actual[0]!.data));
    assert.ok(Object.hasOwn(actual[0]!, '__proto__'));
    assert.equal(Object.getPrototypeOf(actual[0]!), Object.prototype);
  });

  it('differentially checks column permutations, duplicate overwrites and colliding field names', async () => {
    const names = ['id', '2', '__proto__', 'constructor', 'toString', '1', 'created_at', 'createdAt', 'unknown'];
    for (let rotation = 0; rotation < names.length; rotation++) {
      for (const duplicate of names) {
        const order = [...names.slice(rotation), ...names.slice(0, rotation), duplicate];
        const h = fixture(
          order.map((name) => field(name)),
          [order.map((_, i) => `${i}`)],
        );
        const expected = await h.object.findMany();
        const actual = await h.array.findMany();
        assert.equal(actual.length, 1);
        exact(actual, expected);
        assert.equal(h.calls.at(-1)!.rowMode, 'array');
      }
    }
  });

  it('keeps SQL, parameters, prepared names, cache entries, events and middleware results identical', async () => {
    const events: QueryEvent[] = [];
    const seen: unknown[] = [];
    const inputs: unknown[] = [];
    const order: string[] = [];
    const h = fixture([field('id', 23)], [['7']], {
      sqlComment: { static: { app: 'read-test' } },
      _onQuery: (event) => {
        events.push(event);
        order.push('event');
      },
      middlewares: [
        async (params, next) => {
          inputs.push({ ...params });
          order.push('before');
          const result = await next(params);
          order.push('after');
          seen.push(result);
          return result;
        },
      ],
    });
    const args = { where: { id: 7 }, limit: 1 };
    const expected = await h.object.findMany(args);
    const actual = await h.array.findMany(args);
    exact(actual, expected);
    exact(seen, [expected, actual]);
    exact(inputs[1], inputs[0]);
    assert.deepEqual(order, ['before', 'event', 'after', 'before', 'event', 'after']);
    const [object, array] = h.calls;
    assert.ok(object!.name);
    assert.equal(array!.text, object!.text);
    assert.deepEqual(array!.values, object!.values);
    assert.equal(array!.name, object!.name);
    assert.match(array!.text, /app='read-test'/);
    for (const key of ['sql', 'params', 'model', 'action', 'rows', 'comment'] as const) {
      assert.deepEqual(events[1]![key], events[0]![key]);
    }
    assert.equal(events.length, 2);
    assert.equal(events[1]!.rows, 1);
    assert.deepEqual(h.array.cacheStats(), h.object.cacheStats());
    exact(await h.array.findMany(args), expected);
    assert.equal(h.array.cacheStats().hits, 1);
  });

  it('reuses a projection plan only while every fresh descriptor name still matches', async () => {
    const names = ['id', '2', '__proto__', 'constructor', 'toString', '1', 'createdAt', 'unknown', 'id'];
    const fields = names.map((name) => field(name));
    const rows = [names.map((_, i) => `${i}`)];
    const h = fixture(fields, rows);
    const internal = h.array as unknown as { arrayReadPlan?: object };
    for (let rotation = 0; rotation < names.length; rotation++) {
      // Reuse the driver's actual arrays and descriptors, including same-width changes.
      const order = [...names.slice(rotation), ...names.slice(0, rotation)];
      for (let i = 0; i < fields.length; i++) fields[i]!.name = order[i]!;
      const expected = await h.object.findMany();
      exact(await h.array.findMany(), expected);
      const plan = internal.arrayReadPlan;
      assert.ok(plan, 'the executed projection has a cached plan');
      exact(await h.array.findMany(), expected);
      assert.equal(internal.arrayReadPlan, plan, 'matching names reuse the same plan');
    }
  });

  it('rechecks mutable pool eligibility after a successful positional read', async () => {
    const h = fixture([field('id', 23)], [['7']]);
    exact(await h.array.findMany(), [{ id: 7 }]);
    assert.equal(h.calls.at(-1)!.rowMode, 'array');
    for (const [target, key, value] of [
      [h.pool.options, 'binary', true],
      [h.pool, '_clients', [{ binary: true }]],
      [h.pool, '_clients', [null]],
      [h.pool, '_clients', undefined],
      [h.pool, 'Client', class Custom extends pg.Client {}],
      [pg.defaults, 'binary', true],
    ] as const) {
      const previous = Reflect.get(target, key);
      try {
        Reflect.set(target, key, value);
        exact(await h.array.findMany(), [{ id: 7 }]);
        assert.equal(h.calls.at(-1)!.rowMode, undefined, key);
      } finally {
        Reflect.set(target, key, previous);
      }
      exact(await h.array.findMany(), [{ id: 7 }]);
      assert.equal(h.calls.at(-1)!.rowMode, 'array', key);
    }
  });

  it('keeps object rows for custom clients, binary pools, scoped transactions and other drivers', async () => {
    for (const kind of [
      'client',
      'binary',
      'existing-binary',
      'unknown-layout',
      'empty-slot',
      'global-binary',
      'transaction',
      'driver',
      'timed',
    ]) {
      const h = fixture([field('id', 23)], [['7']]);
      const original = pg.defaults.binary;
      let extra: QueryInterfaceOptions = {};
      if (kind === 'client') Object.defineProperty(h.pool, 'Client', { value: class Custom extends pg.Client {} });
      if (kind === 'binary') Reflect.set(h.pool.options, 'binary', true);
      if (kind === 'existing-binary') Reflect.set(h.pool, '_clients', [{ binary: true }]);
      // A pool whose connection list is not where this driver version keeps it.
      if (kind === 'unknown-layout') Reflect.set(h.pool, '_clients', undefined);
      if (kind === 'empty-slot') Reflect.set(h.pool, '_clients', [null]);
      if (kind === 'global-binary') pg.defaults.binary = true;
      if (kind === 'transaction') extra = { _txScoped: true };
      if (kind === 'driver' || kind === 'timed')
        extra = {
          dialect: {
            ...postgresDialect,
            capabilities: {
              ...postgresDialect.capabilities,
              ...(kind === 'driver' ? { connectionDriver: 'none' as const } : { backendCancel: false }),
            },
          },
        };
      try {
        const out = await h.qi(h.typed, extra).findMany(kind === 'timed' ? { timeout: 1000 } : undefined);
        assert.equal(out.length, 1);
        assert.equal(h.calls.at(-1)!.rowMode, undefined, kind);
      } finally {
        pg.defaults.binary = original;
      }
    }
  });

  it('falls back when a supplied pool wrapper returns object rows despite the requested mode', async () => {
    for (const fields of [undefined, [field('id', 23)]]) {
      const h = fixture([field('id', 23)], [['7']]);
      Object.defineProperty(h.pool, 'query', { value: async () => ({ rows: [{ id: 7 }], rowCount: 1, fields }) });
      exact(await h.array.findMany(), [{ id: 7 }]);
    }
  });

  it('keeps deferred transforms and other read methods on object rows', async () => {
    const h = fixture([field('id', 23)], [['7']]);
    const compiled = h.array.buildFindMany();
    exact(compiled.transform({ rows: [{ id: 7 }], rowCount: 1 }), [{ id: 7 }]);
    await h.array.findUnique({ where: { id: 7 } });
    assert.equal(h.calls.at(-1)!.rowMode, undefined);
    const empty = fixture([field('id', 23)], []);
    exact(await empty.array.findMany(), []);
    assert.equal(empty.calls.at(-1)!.rowMode, 'array');
  });

  it('keeps driver errors, parser errors and failed-query events identical', async () => {
    const events: QueryEvent[] = [];
    const h = fixture([field('id', 23)], [['7']], { _onQuery: (event) => events.push(event) });
    h.fail(Object.assign(new Error('missing relation'), { code: '42P01' }));
    let expected: unknown;
    await assert.rejects(h.object.findMany(), (error) => {
      expected = error;
      return true;
    });
    await assert.rejects(h.array.findMany(), (error) => {
      assert.equal(Object.getPrototypeOf(error), Object.getPrototypeOf(expected));
      assert.ok(error instanceof Error);
      assert.equal(error.message, (expected as Error).message);
      assert.equal(Reflect.get(error, 'code'), Reflect.get(expected as object, 'code'));
      assert.equal(error.cause, (expected as Error).cause);
      return true;
    });
    assert.equal(events.length, 2);
    assert.equal(events[1]!.rows, 0);
    assert.equal(events[1]!.sql, events[0]!.sql);
    assert.equal(events[1]!.error!.message, events[0]!.error!.message);
    const bad = fixture(
      [field('id', 23)],
      [['7']],
      {},
      {
        23: () => {
          throw new Error('parser failure');
        },
      },
    );
    await assert.rejects(bad.object.findMany(), /parser failure/);
    await assert.rejects(bad.array.findMany(), /parser failure/);
    const healthy = fixture([field('id', 23)], [['8']]);
    exact(await healthy.array.findMany(), await healthy.object.findMany());
  });

  it('keeps statement tracing phases and row-free context identical', async () => {
    const seen: { phase: string; context: QueryChannelContext }[] = [];
    const channel = diagnosticsChannel.tracingChannel(QUERY_CHANNEL);
    const on = (phase: string) => (value: unknown) => {
      seen.push({ phase, context: { ...(value as QueryChannelContext) } });
    };
    const handlers = {
      start: on('start'),
      end: on('end'),
      asyncStart: on('asyncStart'),
      asyncEnd: on('asyncEnd'),
      error: on('error'),
    };
    channel.subscribe(handlers);
    try {
      const h = fixture([field('id', 23)], [['7']]);
      await h.object.findMany({ where: { id: 7 } });
      await h.array.findMany({ where: { id: 7 } });
      assert.equal(seen.length, 8);
      const normalized = seen.map(({ phase, context: { durationMs: _, ...context } }) => ({ phase, context }));
      exact(normalized.slice(4), normalized.slice(0, 4));
      assert.deepEqual(
        normalized.slice(4).map((entry) => entry.phase),
        ['start', 'end', 'asyncStart', 'asyncEnd'],
      );
      assert.ok(seen.every(({ context }) => !Object.hasOwn(context, 'rows') && !Object.hasOwn(context, 'result')));
    } finally {
      channel.unsubscribe(handlers);
    }
  });
});

const url = process.env.DATABASE_URL;
const native = skipGate(!url, 'DATABASE_URL not set');
describe('native pg array reads with projections and supplied parsers', () => {
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    types: {
      getTypeParser(oid: number, format?: string) {
        if (oid === 25) return (value: string) => `caller:${value}`;
        return pg.types.getTypeParser(oid, format as 'text');
      },
    },
  });
  after(async () => {
    await pool.end();
  });
  native.it('matches full rows, PII projection, select and omit without changing caller pool parsers', async () => {
    await pool.query(
      'CREATE TABLE array_read_fixture (id int PRIMARY KEY, created_at timestamptz, big_value bigint, data bytea, score float8, secret text, "__proto__" text, constructor text, "1" text, "2" text, "toString" text)',
    );
    try {
      await pool.query('INSERT INTO array_read_fixture VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
        1,
        '2020-01-02T03:04:05.678Z',
        '9007199254740993',
        Buffer.from([0, 255]),
        1.5,
        'private',
        'safe',
        'ctor',
        'one',
        'two',
        'method',
      ]);
      const typed = typedQueryPool(pool, true)!;
      const source: PgCompatPool = {
        query: typed.query.bind(typed),
        connect: typed.connect.bind(typed),
        end: typed.end.bind(typed),
      };
      const make = (p: PgCompatPool) =>
        new QueryInterface<Record<string, unknown>>(p, table.name, schema, undefined, { warnOnUnlimited: false });
      const array = make(typed);
      const object = make(source);
      const flatten = { with: { parent: true }, relationLoadStrategy: 'flatten', jsonEncoding: 'object' } as const;
      assert.match(array.buildFindMany(flatten).sql, /f0__id/);
      const projections: FindManyArgs<Record<string, unknown>>[] = [
        { orderBy: { id: 'asc' as const } },
        { includePii: UNSAFE },
        flatten,
        { select: { id: true, createdAt: true, bigValue: true, data: true, constructor: true } },
        { omit: { score: true, createdAt: true } },
      ];
      for (const args of projections) {
        const expected = await object.findMany(args);
        const actual = await array.findMany(args);
        assert.equal(actual.length, 1);
        exact(actual, expected);
        assert.equal(Object.hasOwn(actual[0]!, 'secret'), args.includePii === UNSAFE);
        if (args === flatten) assert.equal((actual[0]!.parent as Record<string, unknown>).id, 1);
      }
      const owned = new TurbineClient({ connectionString: url, warnOnUnlimited: false }, schema);
      try {
        const observed: unknown[] = [];
        owned.$use(async (params, next) => {
          observed.push({ model: params.model, action: params.action, args: params.args });
          const result = await next(params);
          observed.push(result);
          return result;
        });
        const events: QueryEvent[] = [];
        owned.$on('query', (event) => events.push(event));
        const base = owned.pool;
        const reference = make({
          query: base.query.bind(base),
          connect: base.connect.bind(base),
          end: base.end.bind(base),
        });
        const expected = await reference.findMany();
        const actual = await owned.table(table.name).findMany();
        exact(actual, expected);
        exact(observed[1], expected);
        assert.equal(events.length, 1);
        assert.equal(events[0]!.rows, 1);
        assert.equal(events[0]!.action, 'findMany');
      } finally {
        await owned.disconnect();
      }
      assert.equal(
        (await pool.query('SELECT big_value, secret FROM array_read_fixture')).rows[0].big_value,
        '9007199254740993',
      );
      assert.equal((await pool.query('SELECT secret FROM array_read_fixture')).rows[0].secret, 'caller:private');
    } finally {
      await pool.query('DROP TABLE array_read_fixture');
    }
  });
});

// Every mapped scalar available without pgvector, plus a composite passthrough.
// Each also gets its real server array type, NULLs and empty arrays.
const nativeSamples: [string, string[]][] = [
  ...wireTypes
    .filter(([type]) => type !== 'vector')
    .map(([type, , , values]): [string, string[]] => [type, type === 'array_read_mood' ? ['happy', 'sad'] : values]),
  ['oid', ['0', '4294967295']],
  ['money', ['1.25', '-9.99']],
  ['varchar', ['', 'quoted " text']],
  ['bpchar', ['x', 'abc']],
  ['"char"', ['x']],
  ['name', ['identifier']],
  ['citext', ['MiXeD']],
  ['xml', ['<root a="1">text</root>']],
  ['time', ['23:59:59.123456', '00:00:00']],
  ['timetz', ['23:59:59.123456+05:45']],
  ['inet', ['127.0.0.1', '2001:db8::1']],
  ['cidr', ['10.0.0.0/8', '2001:db8::/32']],
  ['macaddr', ['08:00:2b:01:02:03']],
  ['macaddr8', ['08:00:2b:01:02:03:04:05']],
  ['point', ['(1,2)']],
  ['line', ['{1,2,3}']],
  ['lseg', ['[(0,0),(1,1)]']],
  ['box', ['(1,1),(0,0)']],
  ['path', ['[(0,0),(1,1)]']],
  ['polygon', ['((0,0),(1,1),(1,0))']],
  ['circle', ['<(1,2),3>']],
  ['bit', ['1', '0']],
  ['varbit', ['1010', '']],
  ['tsvector', ['a fat cat']],
  ['tsquery', ['fat & cat']],
  ['int4range', ['[1,5)', 'empty']],
  ['int8range', ['[9007199254740993,9223372036854775807)', 'empty']],
  ['numrange', ['[1.1234567890123456789,2.5)', '(,)']],
  ['tsrange', ['[2024-01-01,2024-02-01)']],
  ['tstzrange', ['[2024-01-01Z,2024-02-01Z)']],
  ['daterange', ['[2024-01-01,2024-02-01)']],
  ['int4multirange', ['{[1,3),[5,8)}', '{}']],
  ['int8multirange', ['{[9007199254740993,9223372036854775807)}']],
  ['nummultirange', ['{[1.1,2.5)}']],
  ['tsmultirange', ['{[2024-01-01,2024-02-01)}']],
  ['tstzmultirange', ['{[2024-01-01Z,2024-02-01Z)}']],
  ['datemultirange', ['{[2024-01-01,2024-02-01)}']],
  ['array_read_custom', ['(label,7)', '("quoted,label",-1)']],
];

native.it('differentially reads all available mapped PostgreSQL scalars and arrays on a supplied pool', async () => {
  class CustomValue {
    constructor(readonly wire: string) {}
  }
  let customOid: number | undefined;
  const pool = new pg.Pool({
    connectionString: url,
    max: 1,
    types: {
      getTypeParser(oid: number, format?: string) {
        if (oid === customOid) return (value: string) => new CustomValue(value);
        return pg.types.getTypeParser(oid, format as 'text');
      },
    },
  });
  const name = 'array_read_all_types';
  try {
    await pool.query('CREATE EXTENSION IF NOT EXISTS citext');
    await pool.query('CREATE TYPE array_read_mood AS ENUM ($$happy$$, $$sad$$)');
    await pool.query('CREATE TYPE array_read_custom AS (label text, weight int)');
    customOid = (await pool.query("SELECT 'array_read_custom'::regtype::oid AS oid")).rows[0].oid;
    const definitions = [
      { name: 'id', field: 'id', pgType: 'int4' },
      ...nativeSamples.flatMap(([type], i) => [
        { name: `c_${i}`, field: `c${i}`, pgType: type },
        { name: `a_${i}`, field: `a${i}`, pgType: `${type}[]` },
      ]),
    ];
    const meta = mockTable(name, definitions);
    meta.dateColumns = new Set(
      definitions.filter((c) => /^(date|timestamp|timestamptz)(\[\])?$/.test(c.pgType)).map((c) => c.name),
    );
    const metadata: SchemaMetadata = { tables: { [name]: meta }, enums: { array_read_mood: ['happy', 'sad'] } };
    await pool.query(
      `CREATE TABLE ${name} (id int PRIMARY KEY, ${nativeSamples.map(([type], i) => `c_${i} ${type}, a_${i} ${type}[]`).join(', ')})`,
    );
    for (let row = 0; row < 9; row++) {
      const params = nativeSamples.map(([, values]) => (row === 0 ? null : values[(row - 1) % values.length]));
      const expressions = nativeSamples.flatMap(([type], i) => {
        const value = `$${i + 1}::${type}`;
        const array =
          row === 0 ? `NULL::${type}[]` : row === 8 ? `ARRAY[]::${type}[]` : `ARRAY[${value},NULL::${type}]`;
        return [value, array];
      });
      await pool.query(`INSERT INTO ${name} SELECT ${row}, ${expressions.join(', ')}`, params);
    }
    const captures: Config[] = [];
    const send = pool.query.bind(pool) as unknown as (
      input: string | Config,
      values?: unknown[],
    ) => Promise<PgCompatQueryResult>;
    Object.defineProperty(pool, 'query', {
      value: (input: string | Config, values?: unknown[]) => {
        captures.push(typeof input === 'string' ? { text: input, values } : input);
        return send(input, values);
      },
      configurable: true,
      writable: true,
    });
    const typed = typedQueryPool(pool, true)!;
    const objectPool: PgCompatPool = {
      query: typed.query.bind(typed),
      connect: typed.connect.bind(typed),
      end: typed.end.bind(typed),
    };
    for (const temporalInfinity of ['preserve', 'null'] as const) {
      const make = (source: PgCompatPool) =>
        new QueryInterface<Record<string, unknown>>(source, name, metadata, undefined, {
          warnOnUnlimited: false,
          temporalInfinity,
        });
      const object = make(objectPool);
      const array = make(typed);
      const args = { orderBy: { id: 'asc' as const } };
      const expected = await object.findMany(args);
      assert.equal(captures.at(-1)!.rowMode, undefined);
      const actual = await array.findMany(args);
      assert.equal(captures.at(-1)!.rowMode, 'array');
      assert.equal(actual.length, 9);
      exact(actual, expected);
      assert.equal(Object.keys(actual[0]!).length, 1 + 2 * nativeSamples.length);
      assert.ok(Object.entries(actual[0]!).every(([key, value]) => key === 'id' || value === null));
      assert.ok(
        Object.entries(actual[8]!)
          .filter(([key]) => key.startsWith('a'))
          .every(([, value]) => (Array.isArray(value) ? value.length === 0 : value === '{}')),
      );
      assert.ok(actual[1]![`c${nativeSamples.length - 1}`] instanceof CustomValue);
      exact(await array.findMany({ where: { id: -1 } }), await object.findMany({ where: { id: -1 } }));
      const bad = { where: { id: 'not-an-integer' } };
      let expectedError: Error | undefined;
      await assert.rejects(object.findMany(bad), (error) => {
        assert.ok(error instanceof Error);
        expectedError = error;
        return true;
      });
      await assert.rejects(array.findMany(bad), (error) => {
        assert.ok(error instanceof Error);
        assert.equal(Object.getPrototypeOf(error), Object.getPrototypeOf(expectedError));
        assert.equal(Reflect.get(error, 'code'), Reflect.get(expectedError!, 'code'));
        assert.equal(error.message, expectedError!.message);
        assert.equal(Object.getPrototypeOf(error.cause), Object.getPrototypeOf(expectedError!.cause));
        assert.equal((error.cause as Error).message, (expectedError!.cause as Error).message);
        assert.equal((error.cause as { code?: string }).code, (expectedError!.cause as { code?: string }).code);
        return true;
      });
      exact(await array.findMany(args), expected); // the same connection is usable after the failure
      exact(await array.groupBy({ by: ['id'], _count: true }), await object.groupBy({ by: ['id'], _count: true }));
      assert.equal(captures.at(-2)!.rowMode, undefined);
      assert.equal(captures.at(-1)!.rowMode, undefined);
      exact(
        await array.findMany({ select: { c0: true, a0: true }, ...args }),
        await object.findMany({ select: { c0: true, a0: true }, ...args }),
      );
      exact(
        await array.findMany({ omit: { c0: true, a0: true }, ...args }),
        await object.findMany({ omit: { c0: true, a0: true }, ...args }),
      );
    }
    assert.ok(
      (await pool.query(`SELECT c_${nativeSamples.length - 1} AS value FROM ${name} WHERE id=1`)).rows[0]
        .value instanceof CustomValue,
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${name}`);
    await pool.query('DROP TYPE IF EXISTS array_read_custom, array_read_mood');
    await pool.end();
  }
});
