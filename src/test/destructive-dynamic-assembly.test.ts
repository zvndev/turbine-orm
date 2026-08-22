/**
 * The destructive-migration guard's DYNAMIC-SQL pass, and the assembly
 * functions it recognises.
 *
 * `migrate up` arms its data-loss confirmation from `scanDestructiveSql`. Inside
 * a `DO` block the object name does not exist until the block runs, so the
 * normal rules cannot match it and the scan falls back to "is this fragment
 * ASSEMBLED at run time". That gate listed `||`, `format(`, `quote_*(` and
 * `%I/%s/%L`, and nothing else, so the function spelling of `||` walked past it:
 *
 *   DO $$ BEGIN EXECUTE 'DROP TABLE ' || 'users'; END $$;       -> flagged
 *   DO $$ BEGIN EXECUTE concat('DROP TABLE ', 'users'); END $$; -> NOT flagged
 *
 * Both drop the table on PostgreSQL 16. The second reported a clean inventory,
 * so the prompt never appeared and the migration applied a real `DROP TABLE`
 * with no confirmation and no `--allow-destructive`. Fail-open in a safety
 * guard.
 *
 * The controls matter as much as the catches: over-matching here produces false
 * refusals on innocent migrations, which teaches operators to confirm without
 * reading and costs more than it saves.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DYNAMIC_TARGET, scanDestructiveSql } from '../cli/destructive.js';

const kinds = (sql: string) => scanDestructiveSql(sql).map((s) => s.kind);

describe('destructive scan: run-time assembly by function call', () => {
  // The verb sits INSIDE the assembling call's argument list, so every trace of
  // the call is to its left. The old gate only ever looked to its right.
  const caught: Array<[string, string]> = [
    ['concat', `DO $$ BEGIN EXECUTE concat('DROP TABLE ', 'users'); END $$;`],
    ['concat_ws', `DO $$ BEGIN EXECUTE concat_ws(' ', 'DROP TABLE', 'users'); END $$;`],
    ['array_to_string', `DO $$ BEGIN EXECUTE array_to_string(ARRAY['DROP TABLE', 'users'], ' '); END $$;`],
    ['replace (templated)', `DO $$ BEGIN EXECUTE replace('DROP TABLE $t', '$t', 'users'); END $$;`],
  ];
  for (const [label, sql] of caught) {
    it(`${label}: a dropped table is reported, with an unknown target`, () => {
      const found = scanDestructiveSql(sql);
      assert.equal(found.length, 1, `expected exactly one finding, got ${JSON.stringify(found)}`);
      assert.equal(found[0]!.kind, 'drop-table');
      assert.equal(found[0]!.target, DYNAMIC_TARGET);
    });
  }

  it('the verb, not just DROP TABLE: TRUNCATE and DELETE assembled by concat', () => {
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE concat('TRUNCATE ', 'users'); END $$;`), ['truncate']);
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE concat('DELETE FROM ', 'users'); END $$;`), ['delete']);
  });

  it('a bare DROP whose object keyword is itself assembled is reported as dynamic-destructive', () => {
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE concat('DROP ', 'TABLE users'); END $$;`), ['dynamic-destructive']);
  });

  it('the pre-existing || and format() forms are unchanged', () => {
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE 'DROP TABLE ' || 'users'; END $$;`), ['drop-table']);
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'users'); END $$;`), ['drop-table']);
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE 'DROP TABLE ' || quote_ident('users'); END $$;`), ['drop-table']);
  });

  it('a literal DROP TABLE, in a block or not, still names its target', () => {
    assert.deepEqual(scanDestructiveSql('DROP TABLE users;'), [
      { statement: 'DROP TABLE users', kind: 'drop-table', target: 'users' },
    ]);
    const inBlock = scanDestructiveSql(`DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;`);
    assert.equal(inBlock[0]!.target, 'users');
  });
});

describe('destructive scan: what must NOT be flagged', () => {
  it('prose in a RAISE NOTICE, with no assembly anywhere', () => {
    assert.deepEqual(kinds(`DO $$ BEGIN RAISE NOTICE 'DROP the mic'; END $$;`), []);
  });

  it('concat used as ordinary data, with no destructive verb inside it', () => {
    assert.deepEqual(kinds(`DO $$ BEGIN INSERT INTO log(msg) VALUES (concat('user ', 'left')); END $$;`), []);
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE concat('SELECT ', '1'); END $$;`), []);
  });

  it('regexp_replace CLEANING a column that happens to contain the word DROP', () => {
    // The verb is inside an assembling call, but nothing here is executed as
    // SQL, which is exactly why the pre-verb test also demands an EXECUTE.
    assert.deepEqual(kinds(`DO $$ BEGIN UPDATE t SET a = regexp_replace(a, 'DROP .*', '') WHERE id = 1; END $$;`), []);
    assert.deepEqual(kinds(`DO $$ BEGIN UPDATE t SET a = replace(a, 'DROP', 'remove') WHERE id = 1; END $$;`), []);
  });

  it('an EXECUTE three statements away cannot vouch for an unrelated cleanup', () => {
    // `before` is bounded at the candidate's OWN statement, so the EXECUTE in
    // the first statement is not visible to the UPDATE in the second.
    assert.deepEqual(
      kinds(`DO $$ BEGIN EXECUTE 'ANALYZE t'; UPDATE t SET a = replace(a, 'DROP', 'x') WHERE id = 1; END $$;`),
      [],
    );
  });

  it('a concat in a non-procedural statement is not procedural SQL at all', () => {
    assert.deepEqual(kinds(`INSERT INTO audit(msg) VALUES (concat('DROP TABLE ', 'users'));`), []);
  });

  it('an ordinary additive migration stays clean', () => {
    assert.deepEqual(kinds('CREATE TABLE t (id int); CREATE INDEX idx_t_id ON t (id);'), []);
  });
});
