import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defineSchema, schemaDefToMetadata } from '../../src/index.js';
import { MysqlPool } from '../../src/mysql.js';
import { piiColumns, piiFields } from '../../src/query/writes.js';

function poolFor(rows: unknown[], fields: unknown) {
  const query = async (): Promise<[unknown, unknown]> => [rows, fields];
  return new MysqlPool({
    query,
    execute: query,
    getConnection: async () => ({ query, execute: query, release() {} }),
    end: async () => {},
  });
}
const boolean = (name: string) => ({ name, columnType: 1, columnLength: 1 });

describe('MySQL result normalization preservation', () => {
  it('preserves current boolean values, row identities, own keys and prototypes', async () => {
    for (const fieldCount of [0, 1, 2]) {
      const values = [0, 1, 2, -1, null, undefined, '1', true, false];
      const rows = values.map((flag) => Object.assign(Object.create(null), { flag, other: flag }));
      const before = rows.map((row) => Object.keys(row));
      const fields = ['flag', 'other'].slice(0, fieldCount).map(boolean);
      const result = await poolFor(rows, fields).query('SELECT flags');
      assert.equal(result.rows, rows);
      assert.equal(result.rowCount, values.length);
      for (let i = 0; i < values.length; i++) {
        const row = rows[i]!;
        assert.equal(Object.getPrototypeOf(row), null);
        assert.deepEqual(Object.keys(row), before[i]);
        for (const [at, name] of ['flag', 'other'].entries()) {
          const value = values[i];
          assert.equal(row[name], at < fieldCount && (value === 0 || value === 1) ? value === 1 : value);
        }
      }
    }
  });

  it('preserves row-major access, setters, duplicates and exact thrown errors', async () => {
    const events: string[] = [];
    const rows = [0, 1].map((id) => {
      const row = {};
      for (const name of ['flag', 'other'])
        Object.defineProperty(row, name, {
          configurable: true,
          enumerable: true,
          get() {
            events.push(`get:${id}:${name}`);
            return id;
          },
          set(value) {
            events.push(`set:${id}:${name}:${value}`);
          },
        });
      return row;
    });
    await poolFor(rows, [boolean('flag'), boolean('other'), boolean('flag')]).query('SELECT accessors');
    assert.deepEqual(
      events,
      [0, 1].flatMap((id) =>
        ['flag', 'other', 'flag'].flatMap((name) => [`get:${id}:${name}`, `set:${id}:${name}:${id === 1}`]),
      ),
    );
    const sentinel = new Error('normalization accessor sentinel');
    const throwing = Object.defineProperty({}, 'flag', {
      get() {
        throw sentinel;
      },
    });
    await assert.rejects(
      poolFor([throwing], [boolean('flag')]).query('SELECT throwing'),
      (error) => error === sentinel,
    );
    assert.equal(Object.getOwnPropertyDescriptor(rows[0]!, 'flag')!.get instanceof Function, true);
  });

  it('keeps field metadata access order and never caches changed metadata', async () => {
    const events: string[] = [];
    const field = {
      get columnType() {
        events.push('type');
        return 1;
      },
      get columnLength() {
        events.push('length');
        return 1;
      },
      get name() {
        events.push('name');
        return 'flag';
      },
    };
    const rows = [{ flag: 1 }];
    const pool = poolFor(rows, [field]);
    await pool.query('SELECT metadata');
    assert.deepEqual(events, ['type', 'length', 'name', 'name']);
    const metadata = [boolean('flag')];
    const reused = [{ flag: 1 }];
    const changing = poolFor(reused, metadata);
    await changing.query('SELECT same');
    assert.equal(reused[0]!.flag, true);
    metadata[0]!.columnLength = 4;
    reused[0]!.flag = 1;
    await changing.query('SELECT same');
    assert.equal(reused[0]!.flag, 1);
  });

  it('preserves a reentrant replacement of the names iterator between rows', async () => {
    const original = Array.prototype[Symbol.iterator];
    const events: string[] = [];
    const replacement = function* (this: unknown[]): Generator<unknown, undefined, unknown> {
      if (this.length === 1 && this[0] === 'flag') yield 'other';
      else yield* original.call(this);
      return undefined;
    };
    const restore = () => {
      Array.prototype[Symbol.iterator] = original;
    };
    const first = Object.defineProperty({}, 'flag', {
      get() {
        Array.prototype[Symbol.iterator] = replacement;
        return 1;
      },
      set(value) {
        events.push(`first:${value}`);
      },
    });
    const second = {};
    for (const name of ['flag', 'other'])
      Object.defineProperty(second, name, {
        enumerable: true,
        get() {
          return name === 'flag' ? 0 : 1;
        },
        set(value) {
          restore();
          events.push(`${name}:${value}`);
        },
      });
    try {
      await poolFor([first, second], [boolean('flag')]).query('SELECT reentrant');
    } finally {
      restore();
    }
    assert.deepEqual(events, ['first:true', 'other:true']);
  });
});

describe('write PII membership snapshots', () => {
  it('keeps compound primary keys addressable, strips only PII nonkeys, and returns fresh collections', () => {
    const schema = schemaDefToMetadata(
      defineSchema({
        membership: {
          tenantId: { type: 'integer', primaryKey: true, pii: true },
          email: { type: 'text', primaryKey: true, pii: true },
          secret: { type: 'text', pii: true },
          label: { type: 'text' },
        },
      }),
    );
    const meta = schema.tables.membership!;
    const ctx = {} as Parameters<typeof piiColumns>[0];
    assert.deepEqual([...piiColumns(ctx, meta)], ['secret']);
    assert.deepEqual(piiFields(ctx, meta), ['secret']);
    const first = piiColumns(ctx, meta);
    first.clear();
    assert.deepEqual([...piiColumns(ctx, meta)], ['secret']);
    const fields = piiFields(ctx, meta);
    fields.push('label');
    assert.deepEqual(piiFields(ctx, meta), ['secret']);
    meta.columns.find((column) => column.name === 'secret')!.pii = false;
    assert.deepEqual([...piiColumns(ctx, meta)], []);
    assert.deepEqual(piiFields(ctx, meta), []);
  });

  it('snapshots the primary-key iterable before reading column accessors', () => {
    const meta = schemaDefToMetadata(
      defineSchema({
        membership: { id: { type: 'integer', primaryKey: true, pii: true }, secret: { type: 'text', pii: true } },
      }),
    ).tables.membership!;
    const ctx = {} as Parameters<typeof piiColumns>[0];
    for (const collect of [piiColumns, piiFields]) {
      const events: string[] = [];
      meta.primaryKey = ['id'];
      const keys = meta.primaryKey;
      keys[Symbol.iterator] = function* (): Generator<string, undefined, unknown> {
        events.push('keys:start');
        yield 'id';
        events.push('keys:end');
        return undefined;
      };
      Object.defineProperty(meta.columns[0]!, 'pii', {
        configurable: true,
        get() {
          events.push('column:pii');
          keys.length = 0;
          return true;
        },
      });
      assert.deepEqual([...collect(ctx, meta)], ['secret']);
      assert.deepEqual(events, ['keys:start', 'keys:end', 'column:pii']);
    }
  });
});

it('returns before iterating rows when reentrant push appends no names', async () => {
  const push = Array.prototype.push;
  let visits = 0;
  const rows = [{ flag: 1 }];
  rows[Symbol.iterator] = function* (): Generator<{ flag: number }, undefined, unknown> {
    visits++;
    yield rows[0]!;
    return undefined;
  };
  const field = {
    columnType: 1,
    columnLength: 1,
    get name() {
      Array.prototype.push = function () {
        return this.length;
      };
      return 'flag';
    },
  };
  try {
    await poolFor(rows, [field]).query('SELECT empty names');
  } finally {
    Array.prototype.push = push;
  }
  assert.equal(visits, 0);
  assert.equal(rows[0]!.flag, 1);
});

it('does not introduce an includes lookup after reentrant metadata access', () => {
  const original = Array.prototype.includes;
  const sentinel = new Error('new includes lookup');
  const meta = schemaDefToMetadata(
    defineSchema({
      membership: { id: { type: 'integer', primaryKey: true, pii: true }, secret: { type: 'text', pii: true } },
    }),
  ).tables.membership!;
  Object.defineProperty(meta.columns[0]!, 'pii', {
    get() {
      Array.prototype.includes = () => {
        throw sentinel;
      };
      return true;
    },
  });
  let columns: Set<string> | undefined;
  let fields: string[] | undefined;
  try {
    columns = piiColumns({} as Parameters<typeof piiColumns>[0], meta);
    fields = piiFields({} as Parameters<typeof piiFields>[0], meta);
  } finally {
    Array.prototype.includes = original;
  }
  assert.deepEqual([...columns!], ['secret']);
  assert.deepEqual(fields, ['secret']);
});

it('keeps parameter-array reads and parameterless driver calls unchanged', async () => {
  const events: string[] = [];
  const params = new Proxy([] as unknown[], {
    get(target, key, receiver) {
      if (key === 'length') events.push('length');
      return Reflect.get(target, key, receiver);
    },
  });
  const query = async (sql: string, values?: unknown): Promise<[unknown, unknown]> => {
    events.push(`query:${sql}:${String(values)}`);
    return [[], []];
  };
  const execute = async (): Promise<[unknown, unknown]> => {
    throw new Error('empty params must use query');
  };
  const pool = new MysqlPool({
    query,
    execute,
    getConnection: async () => ({ query, execute, release() {} }),
    end: async () => {},
  });
  await pool.query('SELECT 1', params);
  assert.deepEqual(events, ['length', 'query:SELECT 1:undefined']);
});

it('keeps exact per-row key order, lazy getters and reentrant typed shapes', async () => {
  const { QueryInterface } = await import('../../src/query/index.js');
  const { mysqlDialect } = await import('../../src/mysql.js');
  const metadata = schemaDefToMetadata(
    defineSchema({
      parser_rows: {
        id: { type: 'integer', primaryKey: true },
        fullName: { type: 'text' },
        score: { type: 'double' },
      },
    }),
  );
  metadata.tables.parser_rows!.columns.find((column) => column.name === 'score')!.pgType = 'float8';
  const q = new QueryInterface<{ id: number; fullName: string; score: number }>(
    {} as ConstructorParameters<typeof QueryInterface>[0],
    'parser_rows',
    metadata,
    [],
    {
      dialect: mysqlDialect,
      sqlCache: false,
      logger: {},
    },
  );
  const outer = q.buildFindMany();
  const sentinel = new Error('lazy decoded field');
  const prior = Object.getOwnPropertyDescriptor(Object.prototype, 'fullName');
  const nested: unknown[] = [];
  let getterReads = 0;
  Object.defineProperty(Object.prototype, 'fullName', {
    configurable: true,
    set(value) {
      nested.push(
        q
          .buildFindMany({ select: { score: true, id: true } })
          .transform({ rows: [{ score: 'NaN', id: 9 }], rowCount: 1 }),
      );
      Object.defineProperty(this, 'fullName', {
        configurable: true,
        enumerable: true,
        get() {
          getterReads++;
          throw sentinel;
        },
      });
      assert.equal(typeof value, 'string');
    },
  });
  let rows: Record<string, unknown>[];
  try {
    rows = outer.transform({
      rows: [
        { full_name: 'first', id: 1, score: 'Infinity' },
        { score: '-Infinity', id: 2, full_name: 'second' },
      ],
      rowCount: 2,
    });
  } finally {
    if (prior) Object.defineProperty(Object.prototype, 'fullName', prior);
    else Reflect.deleteProperty(Object.prototype, 'fullName');
  }
  assert.equal(getterReads, 0);
  assert.deepEqual(
    rows.map((row) => Object.keys(row)),
    [
      ['fullName', 'id', 'score'],
      ['score', 'id', 'fullName'],
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.score]),
    [
      [1, Infinity],
      [2, -Infinity],
    ],
  );
  assert.deepEqual(nested, [[{ score: NaN, id: 9 }], [{ score: NaN, id: 9 }]]);
  assert.throws(
    () => rows[0]!.fullName,
    (error) => error === sentinel,
  );
  assert.equal(getterReads, 1);
});
