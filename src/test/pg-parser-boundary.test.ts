import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import pg from 'pg';
import type { TurbineLogger } from '../logger.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';

type Parser = (text: string) => unknown;
const get = pg.types.getTypeParser as unknown as (oid: number, format: 'text' | 'binary') => Parser;
const set = pg.types.setTypeParser as unknown as (oid: number, parse: Parser) => void;
const OIDS = [20, 16, 1700, 1082, 1114, 1115, 1182, 1184, 1185] as const;
// Capture before importing either registration entry. Static imports of them
// would run too early to detect accidental registration during module loading.
const original = new Map<number, Parser>(OIDS.map((oid) => [oid, get(oid, 'text')]));
const binary = new Map<number, Parser>(OIDS.map((oid) => [oid, get(oid, 'binary')]));
const temporal = await import('../query/temporal-parsers.js');
const boundary = await import('../query/pg-type-parsers.js');
const utils = await import('../query/utils.js');
const afterImport = new Map(OIDS.map((oid) => [oid, get(oid, 'text')]));

afterEach(() => {
  for (const [oid, parser] of original) set(oid, parser);
  resetWarnOnce(WARN_NS.parserOverwrite);
});

/** Render Dates by their instant, retaining nulls, infinity and nested arrays. */
function renderReading(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return Array.isArray(value) ? value.map(renderReading) : value;
}

describe('PostgreSQL parser boundary compatibility', () => {
  it('imports without registering any governed or unrelated text parser', () => {
    for (const oid of OIDS) assert.equal(afterImport.get(oid), original.get(oid), `OID ${oid}`);
  });

  it('retains the exact compatibility exports without wrapper functions', () => {
    for (const name of Object.keys(temporal) as Array<keyof typeof temporal>) {
      assert.equal(utils[name], temporal[name], name);
    }
    for (const name of Object.keys(boundary) as Array<keyof typeof boundary>) {
      assert.equal(utils[name], boundary[name], name);
    }
    assert.equal(Object.keys(temporal).length, 6);
    assert.equal(Object.keys(boundary).length, 5);
  });

  it('registers exactly the six temporal text OIDs and leaves binary and other parsers alone', () => {
    boundary.registerUtcTemporalParsers({});
    for (const oid of [1082, 1114, 1115, 1182, 1184, 1185]) {
      assert.notEqual(get(oid, 'text'), original.get(oid), `registered OID ${oid}`);
      assert.equal((get(oid, 'text') as unknown as Record<symbol, unknown>)[Symbol.for('turbine.typeParser')], true);
    }
    for (const oid of [20, 16, 1700]) assert.equal(get(oid, 'text'), original.get(oid), `untouched OID ${oid}`);
    for (const oid of OIDS) assert.equal(get(oid, 'binary'), binary.get(oid), `binary OID ${oid}`);
    assert.equal(renderReading(get(1082, 'text')('0044-03-15 BC')), '-000043-03-15T00:00:00.000Z');
    assert.equal(renderReading(get(1114, 'text')('0000-02-29 12:00:00.123456')), '0000-02-29T12:00:00.123Z');
    assert.equal(renderReading(get(1184, 'text')('2026-11-05 12:00:00+05:30')), '2026-11-05T06:30:00.000Z');
    assert.deepEqual(renderReading(get(1182, 'text')('{{0001-01-01,NULL},{infinity,-infinity}}')), [
      ['0001-01-01T00:00:00.000Z', null],
      [Infinity, -Infinity],
    ]);
    assert.deepEqual(renderReading(get(1115, 'text')('{"12026-11-05 12:00:00",infinity,NULL}')), [
      '+012026-11-05T12:00:00.000Z',
      Infinity,
      null,
    ]);
    assert.deepEqual(renderReading(get(1185, 'text')('{"0044-03-15 12:00:00+00 BC",-infinity,NULL}')), [
      '-000043-03-15T12:00:00.000Z',
      -Infinity,
      null,
    ]);
  });

  it('captures each fallback before registration and keeps that snapshot after later changes', () => {
    const seen: string[] = [];
    const sentinel = { fallback: 'before registration' };
    set(1082, (text) => {
      seen.push(`date:${text}`);
      return sentinel;
    });
    set(1114, (text) => {
      seen.push(`timestamp:${text}`);
      return sentinel;
    });
    boundary.registerUtcTemporalParsers({});
    seen.length = 0; // Discard the documented default-parser probes.
    const date = get(1082, 'text');
    const timestamp = get(1114, 'text');
    const dates = get(1182, 'text');
    const timestamps = get(1115, 'text');
    set(1082, () => 'later date');
    set(1114, () => 'later timestamp');
    assert.equal(date('infinity'), sentinel);
    assert.equal(timestamp('future shape'), sentinel);
    assert.deepEqual(dates('{infinity,NULL}'), [sentinel, null]);
    assert.deepEqual(timestamps('{"future shape",NULL}'), [sentinel, null]);
    assert.deepEqual(seen, ['date:infinity', 'timestamp:future shape', 'date:infinity', 'timestamp:future shape']);
    assert.equal(renderReading(date('2026-11-05')), '2026-11-05T00:00:00.000Z');
    assert.equal(get(1082, 'text')('infinity'), 'later date');
  });

  it('is behaviorally idempotent across registration entry points without repeated warnings', () => {
    const warnings: number[] = [];
    const logger: TurbineLogger = {
      warn: (_message, entry) => {
        warnings.push(Number(entry.oid));
      },
    };
    set(1082, (text) => (text === 'infinity' ? Infinity : `custom:${text}`));
    boundary.registerUtcTemporalParsers(logger);
    assert.deepEqual(warnings, [1082]);
    const readings = [
      [1082, 'infinity'],
      [1082, '0044-03-15 BC'],
      [1114, '12026-11-05 12:00:00.123456'],
      [1115, '{infinity,NULL}'],
      [1182, '{infinity,NULL}'],
      [1184, '0044-03-15 12:00:00+00 BC'],
      [1185, '{infinity,NULL}'],
    ] as const;
    const before = readings.map(([oid, text]) => renderReading(get(oid, 'text')(text)));
    for (let i = 0; i < 3; i++) utils.registerUtcTemporalParsers(logger);
    assert.deepEqual(
      readings.map(([oid, text]) => renderReading(get(oid, 'text')(text))),
      before,
    );
    assert.deepEqual(warnings, [1082]);
  });

  it('keeps custom timestamptz parsers and declines the array when its scalar is customized', () => {
    const custom = (text: string) => `custom-tz:${text}`;
    set(1184, custom);
    boundary.registerUtcTemporalParsers({});
    assert.equal(get(1184, 'text'), custom);
    assert.equal(get(1185, 'text'), original.get(1185));
    assert.equal(get(1184, 'text')('infinity'), 'custom-tz:infinity');
    assert.equal(renderReading(get(1082, 'text')('2026-11-05')), '2026-11-05T00:00:00.000Z');
  });

  it('keeps a custom timestamptz array parser when only that slot is customized', () => {
    const custom = (text: string) => `custom-array:${text}`;
    set(1185, custom);
    boundary.registerUtcTemporalParsers({});
    assert.equal(get(1185, 'text'), custom);
    assert.notEqual(get(1184, 'text'), original.get(1184));
  });

  it('retains PG array escaping, nulls, dimensions, nested values and malformed-input errors', () => {
    const seen: string[] = [];
    const parse = boundary.createPgArrayParser((text) => {
      seen.push(text);
      return text;
    });
    assert.deepEqual(parse(String.raw`{"a,b","a\\b","a\"b",NULL,"NULL",""}`), [
      'a,b',
      String.raw`a\b`,
      'a"b',
      null,
      'NULL',
      '',
    ]);
    assert.deepEqual(seen, ['a,b', String.raw`a\b`, 'a"b', 'NULL', '']);
    assert.deepEqual(parse('[2:3]={a,b}'), ['a', 'b']);
    assert.deepEqual(parse('{{a,NULL},{b,c}}'), [
      ['a', null],
      ['b', 'c'],
    ]);
    assert.deepEqual(parse('{}'), []);
    assert.equal(parse(''), null);
    assert.throws(() => parse('{a'), /array dimension not balanced/);
    const error = new Error('element parser rejected input');
    assert.throws(
      () =>
        boundary.createPgArrayParser(() => {
          throw error;
        })('{a}'),
      (caught) => caught === error,
    );
  });
});
