/**
 * The destructive-migration guard against dynamic SQL it cannot READ, and
 * against destruction it installs for later.
 *
 * Every pass in `scanDestructiveSql` needs to see a verb. Seven ways of
 * spelling `DROP TABLE victim` so that no verb is visible each ran live with a
 * clean inventory and no confirmation. "Cannot classify" was being reported as
 * "clean", which is the consent gate deciding in the author's favour on no
 * evidence. It now asks, under a kind whose label says what it does and does
 * not know.
 *
 * `CREATE RULE ... DO INSTEAD DELETE` is the other shape: it destroys nothing
 * when applied and empties the table on the next ordinary INSERT.
 *
 * Run: npx tsx --test src/test/destructive-obfuscation.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DYNAMIC_TARGET, scanDestructiveSql } from '../cli/destructive.js';

const kinds = (sql: string) => scanDestructiveSql(sql).map((s) => s.kind);
const block = (body: string) => `DO $$ BEGIN ${body}; END $$;`;

describe('destructive scan: dynamic SQL whose verb the scanner cannot see is refused, not passed', () => {
  const hidden: Array<[string, string]> = [
    ['split literal', block(`EXECUTE 'D' || 'ROP TABLE victim'`)],
    ['concat of fragments', block(`EXECUTE concat('DR', 'OP', ' TABLE victim')`)],
    ['unicode escape literal', String.raw`DO $$ BEGIN EXECUTE U&'\0044ROP TABLE victim'; END $$;`],
    ['C-style escape literal', String.raw`DO $$ BEGIN EXECUTE E'\x44ROP TABLE victim'; END $$;`],
    ['chr() prefix', block(`EXECUTE chr(68) || 'ROP TABLE victim'`)],
    ['reverse()', block(`EXECUTE reverse('mitciv ELBAT PORD')`)],
    [
      'variable assembled across statements',
      `DO $$ DECLARE s text := 'DRO'; BEGIN s := s || 'P TABLE victim'; EXECUTE s; END $$;`,
    ],
    ['lower-case split literal', block(`EXECUTE 'dr' || 'op table victim'`)],
    ['format() whose template is only a placeholder', block(`EXECUTE format('%s', s)`)],
  ];
  for (const [label, sql] of hidden) {
    it(`${label}: reported as dynamic-unclassified with an unknown target`, () => {
      const found = scanDestructiveSql(sql);
      assert.equal(found.length, 1, `expected exactly one finding, got ${JSON.stringify(found)}`);
      assert.equal(found[0]!.kind, 'dynamic-unclassified');
      assert.equal(found[0]!.target, DYNAMIC_TARGET);
    });
  }

  it('a visible destructive verb keeps its precise kind, it is never downgraded to unclassified', () => {
    assert.deepEqual(kinds(block(`EXECUTE 'DROP TABLE ' || quote_ident(t)`)), ['drop-table']);
    assert.deepEqual(kinds(block(`EXECUTE format('DROP TABLE %I', t)`)), ['drop-table']);
    assert.deepEqual(kinds(block(`EXECUTE 'ALTER TABLE ' || quote_ident(t) || ' DROP COLUMN x'`)), ['drop-column']);
  });

  // Controls: a guard that fires on innocent dynamic SQL teaches operators to
  // confirm without reading.
  it('an assembled statement that visibly begins with a harmless verb is not flagged', () => {
    assert.deepEqual(kinds(block(`EXECUTE 'UPDATE ' || quote_ident(t) || ' SET flag = true WHERE id = 1'`)), []);
    assert.deepEqual(kinds(block(`EXECUTE 'CREATE INDEX ' || quote_ident(i) || ' ON t (c)'`)), []);
    assert.deepEqual(kinds(block(`EXECUTE format('CREATE INDEX %I ON t (c)', i)`)), []);
    assert.deepEqual(kinds(block(`EXECUTE format('SELECT count(*) FROM %I', t) INTO n`)), []);
    assert.deepEqual(kinds(block(`EXECUTE 'INSERT INTO ' || quote_ident(t) || ' SELECT 1'`)), []);
    assert.deepEqual(kinds(block(`EXECUTE concat_ws(' ', 'GRANT SELECT ON', quote_ident(t), 'TO reader')`)), []);
    assert.deepEqual(kinds(block(`EXECUTE format('ALTER TABLE %I ADD COLUMN x int', t)`)), []);
  });

  it('a plain literal, however spelled, is left to the literal rules', () => {
    assert.deepEqual(kinds(block(`EXECUTE 'SELECT 1'`)), []);
    assert.deepEqual(kinds(block(`EXECUTE $q$SELECT 1$q$`)), []);
    assert.deepEqual(kinds(block(`EXECUTE E'SELECT 1'`)), []);
    assert.deepEqual(kinds(block(`EXECUTE 'DROP TABLE victim'`)), ['drop-table']);
  });

  it('a block with no EXECUTE at all is untouched', () => {
    assert.deepEqual(kinds(block(`RAISE NOTICE 'D%', 'ROP TABLE victim'`)), []);
    assert.deepEqual(kinds(block(`PERFORM count(*) FROM users`)), []);
  });
});

describe('destructive scan: rewrite rules that destroy later', () => {
  it('CREATE RULE ... DO INSTEAD DELETE is reported, naming the table the rule is on', () => {
    const found = scanDestructiveSql(`CREATE RULE r_bomb AS ON INSERT TO tags DO INSTEAD DELETE FROM victim;`);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.kind, 'rewrite-rule');
    assert.match(found[0]!.target, /^tags \(DELETE/);
  });

  it('DO ALSO, OR REPLACE, a parenthesised action list, UPDATE / TRUNCATE / DROP actions', () => {
    assert.deepEqual(kinds(`CREATE OR REPLACE RULE r AS ON UPDATE TO t DO ALSO TRUNCATE other;`), ['rewrite-rule']);
    assert.deepEqual(kinds(`CREATE RULE r AS ON DELETE TO t DO INSTEAD (UPDATE other SET x = 1; NOTIFY done);`), [
      'rewrite-rule',
    ]);
    assert.deepEqual(kinds(`CREATE RULE r AS ON SELECT TO v DO INSTEAD DROP TABLE t;`), ['rewrite-rule']);
  });

  it('rules that only add, notify or do nothing are not flagged', () => {
    assert.deepEqual(kinds(`CREATE RULE r AS ON INSERT TO t DO ALSO INSERT INTO audit VALUES (NEW.id);`), []);
    assert.deepEqual(kinds(`CREATE RULE r AS ON INSERT TO t DO INSTEAD NOTHING;`), []);
    assert.deepEqual(kinds(`CREATE RULE r AS ON UPDATE TO t DO ALSO NOTIFY changed;`), []);
  });
});
