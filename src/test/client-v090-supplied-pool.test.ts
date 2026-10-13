/**
 * turbine-orm: the parser table and pool view Turbine uses on a
 * caller-supplied pool, and the UTC binding of raw-statement Dates. No
 * database; the live paths are in client-v090-supplied-pool.integration.test.ts.
 *
 * Run: npx tsx --test src/test/client-v090-supplied-pool.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { ValidationError } from '../errors.js';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import { rawClientOf, type TypeParserTable, turbineTypeTable, typedQueryPool } from '../supplied-pool-types.js';
import { utcDateParams } from '../typed-sql.js';

type Parser = (text: string) => unknown;
const TURBINE = Symbol.for('turbine.typeParser');
const driverParser = (oid: number): Parser =>
  (pg.types.getTypeParser as unknown as (o: number, f: string) => Parser)(oid, 'text');

/** A base table backed by pg's defaults, with per-OID replacements the test can swap. */
function baseTable(): { table: TypeParserTable; set(oid: number, parser: Parser): void } {
  const custom = new Map<number, Parser>();
  return {
    table: {
      getTypeParser: (oid: number, format = 'text') =>
        format === 'text'
          ? (custom.get(oid) ?? driverParser(oid))
          : (pg.types.getTypeParser as unknown as (o: number, f: string) => Parser)(oid, format),
    },
    set: (oid, parser) => custom.set(oid, parser),
  };
}

const parse = (table: TypeParserTable, oid: number, text: string): unknown =>
  (table.getTypeParser(oid, 'text') as Parser)(text);

describe('turbineTypeTable', () => {
  it('reads int8 as an exact number, and past 2^53 keeps the string', () => {
    const t = turbineTypeTable(() => baseTable().table, false);
    assert.equal(parse(t, 20, '9007199254740991'), 9007199254740991);
    assert.equal(parse(t, 20, '-42'), -42);
    assert.equal(parse(t, 20, '9007199254740993'), '9007199254740993');
  });

  it('reads the zone-less temporals and their arrays as UTC under utcTimestamps', () => {
    const t = turbineTypeTable(() => baseTable().table, true);
    assert.equal((parse(t, 1114, '2026-07-01 12:00:00') as Date).toISOString(), '2026-07-01T12:00:00.000Z');
    assert.equal((parse(t, 1082, '2026-07-21') as Date).toISOString(), '2026-07-21T00:00:00.000Z');
    assert.deepEqual(
      (parse(t, 1115, '{"2026-07-01 12:00:00",NULL}') as Array<Date | null>).map((d) => d?.toISOString() ?? null),
      ['2026-07-01T12:00:00.000Z', null],
    );
    assert.deepEqual(
      (parse(t, 1182, '{2026-07-21}') as Date[]).map((d) => d.toISOString()),
      ['2026-07-21T00:00:00.000Z'],
    );
    assert.equal(parse(t, 1114, 'infinity'), Number.POSITIVE_INFINITY, 'unrecognised text reaches the base parser');
  });

  it('without utcTimestamps hands every temporal OID to the base table untouched', () => {
    const base = baseTable();
    const t = turbineTypeTable(() => base.table, false);
    for (const oid of [1082, 1114, 1115, 1182, 1184, 1185]) {
      assert.equal(t.getTypeParser(oid, 'text'), driverParser(oid), `OID ${oid}`);
    }
  });

  it('hands every OID it does not govern, and every binary format, to the base table at lookup time', () => {
    const base = baseTable();
    const t = turbineTypeTable(() => base.table, true);
    assert.equal(t.getTypeParser(16, 'text'), driverParser(16));
    const numeric = (text: string) => `numeric:${text}`;
    base.set(1700, numeric);
    assert.equal(t.getTypeParser(1700, 'text'), numeric, 'a parser installed later is still the fallback');
    assert.equal(
      t.getTypeParser(20, 'binary'),
      (pg.types.getTypeParser as unknown as (o: number, f: string) => Parser)(20, 'binary'),
    );
  });

  it('rebuilds over a base parser that changed, and reuses one Turbine already installed', () => {
    const base = baseTable();
    const t = turbineTypeTable(() => base.table, true);
    const first = t.getTypeParser(1114, 'text');
    assert.equal(t.getTypeParser(1114, 'text'), first, 'cached while the base is unchanged');
    base.set(1114, () => 'theirs');
    assert.notEqual(t.getTypeParser(1114, 'text'), first);
    assert.equal(parse(t, 1114, 'infinity'), 'theirs', 'the new base parser is the fallback');
    const turbines = Object.assign((text: string) => `turbine:${text}`, { [TURBINE]: true });
    base.set(1114, turbines);
    assert.equal(t.getTypeParser(1114, 'text'), turbines);
  });

  it("decodes timestamptz on the fast path over pg's default and keeps a caller's own parser", () => {
    const base = baseTable();
    const t = turbineTypeTable(() => base.table, true);
    const fast = t.getTypeParser(1184, 'text') as Parser & Record<symbol, unknown>;
    assert.equal(fast[TURBINE], true);
    assert.equal((fast('2026-07-01 12:00:00+00') as Date).toISOString(), '2026-07-01T12:00:00.000Z');
    assert.equal((t.getTypeParser(1185, 'text') as Record<symbol, unknown>)[TURBINE], true);
    const theirs = (text: string) => `tz:${text}`;
    base.set(1184, theirs);
    assert.equal(t.getTypeParser(1184, 'text'), theirs);
    assert.equal(t.getTypeParser(1185, 'text'), driverParser(1185), 'the array half declines with its scalar');
  });
});

interface Sent {
  args: unknown[];
}

/** A node-postgres-shaped pool: a `Client` constructor, promise `query`/`connect`. */
class FakePool {
  Client = class {};
  sent: Sent[] = [];
  clientTypes: TypeParserTable = { getTypeParser: () => (text: string) => `client:${text}` };
  client = {
    _types: this.clientTypes,
    processID: 7,
    sent: [] as Sent[],
    query(...args: unknown[]) {
      this.sent.push({ args });
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
    release() {},
    whoami() {
      return this;
    },
  };
  query(...args: unknown[]) {
    this.sent.push({ args });
    return Promise.resolve({ rows: [], rowCount: 0 });
  }
  connect() {
    return Promise.resolve(this.client);
  }
  async end() {}
  get totalCount() {
    return this.sent.length;
  }
}

describe('typedQueryPool', () => {
  it('leaves a pool that is not built on node-postgres alone', () => {
    const plain = { query: async () => ({ rows: [] }), connect: async () => ({}), end: async () => {} };
    assert.equal(typedQueryPool(plain as unknown as PgCompatPool, true), undefined);
  });

  it("attaches the table to every query shape, without touching the caller's config", async () => {
    const fake = new FakePool();
    const pool = typedQueryPool(fake as unknown as PgCompatPool, true) as PgCompatPool;
    assert.ok(pool instanceof FakePool, 'instanceof still sees the pool');
    assert.equal((pool as unknown as FakePool).totalCount, 0, 'getters read the pool');

    await pool.query('SELECT 1');
    await pool.query('SELECT $1', [1]);
    const prepared = { name: 'p1', text: 'SELECT $1', values: [2] };
    await (pool.query as unknown as (c: unknown) => Promise<unknown>)(prepared);
    const ownTypes = { getTypeParser: () => String };
    await (pool.query as unknown as (c: unknown) => Promise<unknown>)({ text: 'SELECT 3', types: ownTypes });

    const [a, b, c, d] = fake.sent.map((s) => s.args[0] as Record<string, unknown>);
    assert.equal(fake.sent[0]?.args.length, 1, 'sent as one config');
    assert.deepEqual(Object.keys(a ?? {}), ['text', 'types']);
    assert.deepEqual(b?.values, [1]);
    assert.equal(b?.types, a?.types);
    assert.equal(c?.name, 'p1');
    assert.equal(c?.types, a?.types);
    assert.equal('types' in prepared, false, 'the caller object is not mutated');
    assert.equal(d?.types, ownTypes, 'an explicit `types` wins');
    assert.equal(parse(a?.types as TypeParserTable, 20, '5'), 5);
  });

  it('hands out clients whose queries carry the table, built over the connection own table', async () => {
    const fake = new FakePool();
    const pool = typedQueryPool(fake as unknown as PgCompatPool, true) as PgCompatPool;
    const client = (await pool.connect()) as PgCompatPoolClient & Record<string, unknown>;
    assert.equal(await pool.connect(), client, 'one view per driver client');
    assert.equal(rawClientOf(client), fake.client);
    assert.equal(client.processID, 7);
    assert.equal((client.whoami as () => unknown)(), fake.client, 'other methods run on the driver client');

    await client.query('SELECT $1', [1]);
    const config = fake.client.sent[0]?.args[0] as { types: TypeParserTable };
    assert.equal(config.types, client._types, '`_types` is the same table, for the pipeline path');
    assert.equal(parse(config.types, 16, 't'), 'client:t', "an ungoverned OID reads the connection's table");
    assert.equal(parse(config.types, 20, '6'), 6);

    const submittable = { submit() {}, _result: { _types: undefined as unknown } };
    await (client.query as unknown as (s: unknown) => unknown)(submittable);
    assert.equal(submittable._result._types, config.types, 'a cursor result without a table gets this one');
    const own = { getTypeParser: () => String };
    const cursor = { submit() {}, _result: { _types: own as unknown } };
    await (client.query as unknown as (s: unknown) => unknown)(cursor);
    assert.equal(cursor._result._types, own);
  });
});

describe('utcDateParams', () => {
  it('returns the params themselves when they hold no Date', () => {
    const params = [1, 'a', null, [1, 2], { at: 'x' }];
    assert.equal(utcDateParams(params, 'raw'), params);
  });

  it('binds Dates, in arrays at any depth, as UTC text, without mutating the input', () => {
    const at = new Date('2026-07-02T08:30:00.004Z');
    const params = [at, [at, null, [at]], 3];
    const out = utcDateParams(params, 'raw');
    assert.deepEqual(out, [
      '2026-07-02T08:30:00.004+00:00',
      ['2026-07-02T08:30:00.004+00:00', null, ['2026-07-02T08:30:00.004+00:00']],
      3,
    ]);
    assert.equal(params[0], at);
    const inYear = (year: number): Date => {
      const date = new Date(0);
      date.setUTCFullYear(year, 0, 1);
      return date;
    };
    assert.equal(utcDateParams([inYear(0)], 'raw')[0], '0001-01-01T00:00:00.000+00:00 BC');
    assert.equal(utcDateParams([inYear(-43)], 'raw')[0], '0044-01-01T00:00:00.000+00:00 BC');
    assert.equal(utcDateParams([inYear(1)], 'raw')[0], '0001-01-01T00:00:00.000+00:00');
  });

  it('refuses an Invalid Date, naming the parameter', () => {
    assert.throws(
      () => utcDateParams([1, new Date(Number.NaN)], 'sql'),
      (err: unknown) => err instanceof ValidationError && /sql: parameter \$2 is an Invalid Date/.test(err.message),
    );
    assert.throws(
      () => utcDateParams([[new Date('nope')]], 'rawUnsafe'),
      (err: unknown) =>
        err instanceof ValidationError && /rawUnsafe: parameter \$1 contains an Invalid Date/.test(err.message),
    );
  });
});
