/**
 * The cross-engine battery's comparison and allowlist, checked without a
 * database. If `tag` stopped distinguishing a type, or a representation entry
 * accepted more than its one pair, every engine run would pass while comparing
 * less than it claims; this file is what makes that a failure in the unit lane.
 *
 * Run: npx tsx --test src/test/oracle-engines-compare.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BOOLEAN_FIELDS,
  JSON_FIELDS,
  REPRESENTATION_PREDICATES,
  REPRESENTATIONS,
  SCENARIO_ENTRIES,
} from './oracle/engines/allowlist.js';
import { Comparison, lastField, type ReprRule, tag } from './oracle/engines/compare.js';
import { SCENARIOS } from './oracle/engines/scenarios.js';

const differ = (a: unknown, b: unknown) => !new Comparison([]).equal(tag(a), tag(b));
const rule = (id: string): ReprRule => {
  const entry = REPRESENTATIONS.find((r) => r.id === id);
  assert.ok(entry, `no representation entry ${id}`);
  return { id: entry.id, fields: entry.fields, accept: entry.accept };
};

describe('oracle-engines: type-tagged comparison', () => {
  it('distinguishes values that print alike but differ in type', () => {
    assert.ok(differ(1, '1'), 'number vs numeric string');
    assert.ok(differ(true, 1), 'boolean vs 1');
    assert.ok(differ(new Date('2026-01-01T00:00:00.000Z'), '2026-01-01T00:00:00.000Z'), 'Date vs ISO string');
    assert.ok(differ([], {}), 'empty array vs empty object');
    assert.ok(differ(1n, 1), 'bigint vs number');
    assert.ok(differ(null, undefined), 'null vs undefined');
    assert.ok(differ({ a: 1 }, { a: 1, b: null }), 'an extra key, even a null one');
    assert.ok(differ([1, 2], [2, 1]), 'order');
  });

  it('treats key order as no difference', () => {
    assert.ok(!differ({ a: 1, b: 2 }, { b: 2, a: 1 }));
  });

  it('reports the path of each difference', () => {
    const cmp = new Comparison([]);
    assert.equal(cmp.equal(tag([{ id: 1, n: 2 }]), tag([{ id: 1, n: '2' }])), false);
    assert.deepEqual(cmp.diffs, [{ path: '$[0].n', oracle: 'num:2', engine: 'str:"2"' }]);
  });

  it('a representation entry accepts its pair only under its fields, and counts the use', () => {
    const bool: ReprRule = {
      id: 'boolean-as-integer',
      fields: BOOLEAN_FIELDS,
      accept: REPRESENTATION_PREDICATES.booleanAsInteger,
    };
    const cmp = new Comparison([bool]);
    assert.ok(cmp.equal(tag({ active: true }), tag({ active: 1 })));
    assert.equal(cmp.used.get(bool.id), 1);
    assert.equal(new Comparison([bool]).equal(tag({ active: true }), tag({ active: 0 })), false, 'true is not 0');
    assert.equal(new Comparison([bool]).equal(tag({ age: true }), tag({ age: 1 })), false, 'outside its fields');
  });

  it('json-as-text decodes the text and still compares it exactly', () => {
    const json: ReprRule = { id: 'json-as-text', fields: JSON_FIELDS, accept: REPRESENTATION_PREDICATES.jsonAsText };
    assert.ok(new Comparison([json]).equal(tag({ prefs: { a: [1, 'x'] } }), tag({ prefs: '{"a":[1,"x"]}' })));
    assert.equal(new Comparison([json]).equal(tag({ prefs: { a: [1, 'x'] } }), tag({ prefs: '{"a":[1,"y"]}' })), false);
    assert.equal(new Comparison([json]).equal(tag({ prefs: [] }), tag({ prefs: '{}' })), false, '[] is not {}');
  });

  it('a padded decimal equals its value and nothing else', () => {
    const scale = rule('mysql-numeric-padded-scale');
    assert.ok(new Comparison([scale]).equal(tag({ balance: '7.50' }), tag({ balance: '7.500000' })));
    assert.equal(new Comparison([scale]).equal(tag({ balance: '7.50' }), tag({ balance: '7.510000' })), false);
    assert.equal(new Comparison([scale]).equal(tag({ balance: '100' }), tag({ balance: '1.000' })), false);
  });

  it('an unordered comparison allows a permutation and nothing more', () => {
    assert.ok(new Comparison([]).equalUnordered(tag([1, 2, 3]), tag([3, 1, 2])));
    assert.equal(new Comparison([]).equalUnordered(tag([1, 2, 3]), tag([3, 1, 1])), false);
    assert.equal(new Comparison([]).equalUnordered(tag([1, 2]), tag([1, 2, 2])), false);
  });

  it('lastField reads the property a path ends in', () => {
    assert.equal(lastField('$.state.oe_users[2].active'), 'active');
    assert.equal(lastField('$[0].oeUsers[1].big'), 'big');
    assert.equal(lastField('$'), '');
  });
});

describe('oracle-engines: allowlist integrity', () => {
  const ids = new Set(SCENARIOS.map((s) => s.id));

  it('has a non-trivial scenario list with unique ids', () => {
    assert.ok(SCENARIOS.length >= 60, `only ${SCENARIOS.length} scenarios`);
    assert.equal(ids.size, SCENARIOS.length, 'two scenarios share an id');
    for (const s of SCENARIOS) {
      if (s.kind === 'write') assert.ok(s.state?.length, `${s.id} is a write with no state to compare`);
    }
  });

  it('every scenario entry names a real scenario, once per engine, with a reason', () => {
    const seen = new Set<string>();
    for (const e of SCENARIO_ENTRIES) {
      assert.ok(ids.has(e.scenario), `allowlist names an unknown scenario ${e.scenario}`);
      const key = `${e.engine} ${e.scenario}`;
      assert.ok(!seen.has(key), `duplicate allowlist entry ${key}`);
      seen.add(key);
      assert.ok(e.note.length > 20, `${key} has no real note`);
      if (e.relax) assert.equal(e.kind, 'difference', `${key}: only a difference may relax`);
    }
  });

  it('every representation entry is scoped to named fields', () => {
    for (const r of REPRESENTATIONS) {
      assert.ok(r.fields.length > 0, `${r.id} applies to no field`);
      assert.ok(r.note.length > 20, `${r.id} has no real note`);
    }
  });
});
