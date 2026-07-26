/**
 * turbine-orm, `pgArrayType` coverage (the `createMany` UNNEST cast)
 *
 * `createMany` compiles to `UNNEST(ARRAY[...]::<arrtype>)`, and the cast comes
 * from `pgArrayType`. A type missing from that map falls back to `text[]`,
 * which Postgres accepts ONLY for types with an assignment cast from `text`.
 * For everything else the insert fails with
 * `42804 column "x" is of type <t> but expression is of type text`, that is
 * exactly what happened to `time` / `timetz` (and, latently, to `interval`,
 * `money`, `cidr`, `macaddr`, ranges, `tsvector` and `vector`).
 *
 * This test pins the map against the type list the rest of the codebase knows
 * about (`pgTypeToTs`), so a future type addition cannot silently reintroduce
 * the `text[]` fallback.
 *
 * Run: npx tsx --test src/test/pg-array-type.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pgArrayType, pgTypeToTs } from '../schema.js';

/**
 * Every non-character type `pgTypeToTs` recognizes. `varchar` / `char` /
 * `bpchar` are deliberately excluded: `text` assignment-casts to all three, so
 * the `text[]` cast is correct for them and pinning it would change emitted SQL
 * for no gain.
 */
const KNOWN_TYPES = [
  'int2',
  'int4',
  'int8',
  'float4',
  'float8',
  'oid',
  'numeric',
  'money',
  'bool',
  'name',
  'uuid',
  'citext',
  'xml',
  'timestamptz',
  'timestamp',
  'date',
  'time',
  'timetz',
  'interval',
  'json',
  'jsonb',
  'bytea',
  'inet',
  'cidr',
  'macaddr',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
  'tsvector',
  'tsquery',
  'vector',
];

describe('pgArrayType', () => {
  it('has a real entry for every type the codebase maps to TypeScript', () => {
    const missing = KNOWN_TYPES.filter((t) => pgArrayType(t) === 'text[]');
    assert.deepEqual(missing, [], `these types still fall back to the text[] cast: ${missing.join(', ')}`);
  });

  it('every entry is the type name plus []', () => {
    for (const t of KNOWN_TYPES) {
      // The numeric/bool spellings differ from their udt_name, so only check
      // the ones whose udt_name IS the SQL name.
      if (['int2', 'int4', 'int8', 'float4', 'float8', 'bool'].includes(t)) continue;
      assert.equal(pgArrayType(t), `${t}[]`, `pgArrayType('${t}')`);
    }
  });

  it('the release-blocking time-of-day casts are right', () => {
    assert.equal(pgArrayType('time'), 'time[]');
    assert.equal(pgArrayType('timetz'), 'timetz[]');
  });

  it('covers range and multirange types', () => {
    for (const t of [
      'int4range',
      'int8range',
      'numrange',
      'tsrange',
      'tstzrange',
      'daterange',
      'int4multirange',
      'int8multirange',
      'nummultirange',
      'tsmultirange',
      'tstzmultirange',
      'datemultirange',
    ]) {
      assert.equal(pgArrayType(t), `${t}[]`);
    }
  });

  it('keeps the historical integer / float / bool spellings', () => {
    assert.equal(pgArrayType('int2'), 'smallint[]');
    assert.equal(pgArrayType('int4'), 'integer[]');
    assert.equal(pgArrayType('int8'), 'bigint[]');
    assert.equal(pgArrayType('float4'), 'real[]');
    assert.equal(pgArrayType('float8'), 'double precision[]');
    assert.equal(pgArrayType('bool'), 'boolean[]');
  });

  it('keeps text[] for the character types and for unknown types', () => {
    for (const t of ['text', 'varchar', 'char', 'bpchar', 'some_user_defined_type']) {
      assert.equal(pgArrayType(t), 'text[]');
    }
  });

  it('KNOWN_TYPES is in sync with pgTypeToTs (no type silently dropped from the audit)', () => {
    for (const t of KNOWN_TYPES) {
      // json/jsonb intentionally map to `unknown` (the TS type, not "unmapped").
      if (t === 'json' || t === 'jsonb') continue;
      assert.notEqual(pgTypeToTs(t, false), 'unknown', `${t} is no longer known to pgTypeToTs`);
    }
  });
});
