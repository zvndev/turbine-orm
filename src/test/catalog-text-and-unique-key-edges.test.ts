/**
 * Anchoring and least-claim edges: a sequence default must be the WHOLE
 * default, a text array must start with the array brace, an internal
 * global-filter conjunction identifies a row when ANY branch does, and
 * the nested-write pre-walk tolerates a table the schema does not know.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertNestedArrayWrites } from '../nested-write.js';
import { isSequenceDefault } from '../pg-catalog-text.js';
import { whereIdentifiesOneRow } from '../query/compound-unique.js';
import { markInternalCombinator, readTextArray } from '../query-utils.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

describe('isSequenceDefault is anchored at both ends', () => {
  it('a default that merely CONTAINS a nextval call is not a sequence default', () => {
    assert.equal(isSequenceDefault("xnextval('users_id_seq'::regclass)"), false);
    assert.equal(isSequenceDefault("log(nextval('users_id_seq'::regclass))"), false);
    assert.equal(isSequenceDefault("'nextval(fake)'::text"), false);
  });

  it('the rendered forms still read as sequence defaults', () => {
    assert.equal(isSequenceDefault("nextval('users_id_seq'::regclass)"), true);
    assert.equal(isSequenceDefault("(nextval('s'::regclass))::integer"), true);
  });
});

describe('readTextArray', () => {
  it('parses array text and leaves other strings alone', () => {
    assert.deepEqual(readTextArray('{ok,sad}'), ['ok', 'sad']);
    assert.equal(readTextArray('[ok]'), '[ok]');
    assert.equal(readTextArray('plain'), 'plain');
    assert.equal(readTextArray(42), 42);
  });
});

describe('whereIdentifiesOneRow over an internal combinator', () => {
  it('one identifying branch is enough (the global-filter conjunction)', () => {
    const meta = mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'tenant_id', field: 'tenantId' },
    ]);
    meta.primaryKey = ['id'];
    meta.uniqueColumns = [['id']];
    const where = markInternalCombinator({ AND: [{ id: 7 }, { tenantId: 3 }] });
    assert.equal(whereIdentifiesOneRow(meta, where), true);
    const noKey = markInternalCombinator({ AND: [{ tenantId: 3 }] });
    assert.equal(whereIdentifiesOneRow(meta, noKey), false);
  });
});

describe('assertNestedArrayWrites on an unknown table', () => {
  it('skips quietly instead of throwing', () => {
    const schema = { enums: {}, tables: {} } as unknown as SchemaMetadata;
    assert.doesNotThrow(() => assertNestedArrayWrites(schema, 'missing_table', { tags: ['a'] }));
  });
});
