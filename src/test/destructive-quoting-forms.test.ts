/**
 * The destructive-migration guard against the QUOTING FORM a routine body is
 * written in, and against the word `EXECUTE` appearing where nothing executes.
 *
 * A routine body does not have to be dollar-quoted. `DO 'BEGIN DROP TABLE
 * users; END'` is ordinary PostgreSQL and it runs. `SqlStatement.blocks` was
 * filled only by the dollar-quote and `BEGIN ATOMIC` branches of the
 * tokenizer, so a single-quoted body came back with NO blocks, and the scanner
 * iterates `procedural ? statement.blocks : []`: the statement was correctly
 * recognized as procedural and then scanned against nothing. Every pass was
 * skipped, including the fail-closed "cannot classify" backstop, so the guard
 * reported a clean inventory and `migrate up` applied the file with no prompt.
 * Verified live on PostgreSQL 17 before the fix: table gone.
 *
 * The existing suites are 100% dollar-quoted, which is why the backstop was
 * green without ever having been exercised against this form. That is the
 * shape of every miss in this file: a control chosen around the implementation
 * rather than around the rule.
 *
 * The other half is the opposite error. `unclassifiableExecute` matched
 * `/\bEXECUTE\s+/` anywhere in a statement's `code`, which keeps literal
 * contents, so `GRANT EXECUTE ON FUNCTION f() TO app` and `RAISE NOTICE
 * 'EXECUTE the plan'` both armed the gate. A guard that fires on prose teaches
 * operators to confirm without reading, which is the cost this module's own
 * doctrine refuses to pay, and under `migrate deploy` there is no terminal to
 * confirm at, so it fails an ordinary migration outright.
 *
 * Run: npx tsx --test src/test/destructive-quoting-forms.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DYNAMIC_TARGET, scanDestructiveSql } from '../cli/destructive.js';

const kinds = (sql: string) => scanDestructiveSql(sql).map((s) => s.kind);

describe('destructive scan: a routine body is read whatever it is quoted with', () => {
  // The SAME body, spelled five ways. The verdict must not depend on the
  // quoting, because the server does not care either.
  const bodies: Array<[string, string]> = [
    ['dollar-quoted (the form every other suite uses)', `DO $$ BEGIN DROP TABLE victim; END $$;`],
    ['dollar-quoted with a tag', `DO $body$ BEGIN DROP TABLE victim; END $body$;`],
    ['single-quoted', `DO 'BEGIN DROP TABLE victim; END';`],
    ['single-quoted with an explicit language', `DO LANGUAGE plpgsql 'BEGIN DROP TABLE victim; END';`],
    ['E-string quoted', `DO E'BEGIN DROP TABLE victim; END';`],
  ];

  for (const [name, sql] of bodies) {
    it(`${name}: reports drop-table`, () => {
      assert.deepEqual(kinds(sql), ['drop-table'], sql);
    });
  }

  it('every destructive verb, not only DROP TABLE, inside a single-quoted body', () => {
    assert.deepEqual(kinds(`DO 'BEGIN TRUNCATE victim; END';`), ['truncate']);
    assert.deepEqual(kinds(`DO 'BEGIN DELETE FROM victim; END';`), ['delete']);
    assert.deepEqual(kinds(`DO 'BEGIN ALTER TABLE victim DROP COLUMN email; END';`), ['drop-column']);
  });

  it('a nested EXECUTE inside a single-quoted body, where the inner quotes are doubled', () => {
    // The payload of `DO 'BEGIN EXECUTE ''DROP TABLE victim''; END'` is
    // `EXECUTE 'DROP TABLE victim'`, so the block has to be un-escaped before
    // it is lexed or the doubled quote sits where a string opener belongs.
    assert.deepEqual(kinds(`DO LANGUAGE plpgsql 'BEGIN EXECUTE ''DROP TABLE victim''; END';`), ['drop-table']);
  });

  it('a routine body, not only a DO block', () => {
    assert.deepEqual(kinds(`CREATE FUNCTION purge() RETURNS void AS 'DELETE FROM victim' LANGUAGE sql;`), ['delete']);
    assert.deepEqual(kinds(`CREATE PROCEDURE p() LANGUAGE plpgsql AS 'BEGIN DROP TABLE victim; END';`), ['drop-table']);
  });

  it('an obfuscated verb in a single-quoted body still reaches the backstop', () => {
    assert.deepEqual(kinds(`DO LANGUAGE plpgsql 'BEGIN EXECUTE ''D'' || ''ROP TABLE victim''; END';`), [
      'dynamic-unclassified',
    ]);
  });
});

describe('destructive scan: two adjacent literals are ONE string in PostgreSQL', () => {
  it('a statement split across a continuation is not readable and is refused', () => {
    // `'DROP TABLE '\n'victim'` is one string. Every earlier pass declines:
    // the literal rules because a quote is not an identifier, the assembly
    // test because continuation is lexical and carries no `||`, `concat` or
    // `format`. The opener reads as DROP, and the skip for an
    // already-reported verb was unconditional, so the statement was passed
    // over on the strength of a pass that never spoke.
    const found = scanDestructiveSql(`DO $$ BEGIN EXECUTE 'DROP TABLE '\n'victim'; END $$;`);
    assert.deepEqual(
      found.map((f) => f.kind),
      ['dynamic-unclassified'],
    );
    assert.equal(found[0]?.target, DYNAMIC_TARGET);
  });

  it('the same shape for DELETE and for a three-part split', () => {
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE 'DELETE FROM '\n'victim'; END $$;`), ['dynamic-unclassified']);
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE 'DRO'\n'P TABLE '\n'victim'; END $$;`), ['dynamic-unclassified']);
  });
});

describe('destructive scan: COPY runs the DML inside its parentheses', () => {
  it('COPY (DELETE ... RETURNING) TO reports the DELETE', () => {
    // Reads as a COPY, which nothing treats as destructive, and empties the
    // table. `TO STDOUT` needs no server-side file permission, so it goes
    // through an ordinary client connection. `cteSubstatements` never saw it:
    // that one fires only on a leading WITH.
    assert.deepEqual(kinds(`COPY (DELETE FROM victim RETURNING *) TO STDOUT;`), ['delete']);
    assert.deepEqual(kinds(`COPY (DELETE FROM victim RETURNING *) TO '/tmp/out.csv';`), ['delete']);
    assert.deepEqual(kinds(`COPY (DELETE FROM victim RETURNING *) TO PROGRAM 'cat';`), ['delete']);
  });

  it('COPY (UPDATE without a WHERE) TO reports the update', () => {
    assert.deepEqual(kinds(`COPY (UPDATE victim SET n = 1 RETURNING *) TO STDOUT;`), ['update-without-where']);
  });

  it('a data-modifying CTE inside a COPY is read too', () => {
    assert.deepEqual(kinds(`COPY (WITH d AS (DELETE FROM victim RETURNING *) SELECT * FROM d) TO STDOUT;`), ['delete']);
  });

  it('the ordinary export forms are silent', () => {
    assert.deepEqual(kinds(`COPY (SELECT * FROM victim) TO STDOUT;`), []);
    assert.deepEqual(kinds(`COPY victim TO STDOUT;`), []);
    assert.deepEqual(kinds(`COPY victim FROM STDIN;`), []);
    assert.deepEqual(kinds(`COPY (SELECT * FROM victim WHERE n > 1) TO PROGRAM 'gzip > /tmp/x.gz';`), []);
  });
});

describe('destructive scan: the word EXECUTE where nothing executes', () => {
  const benign: Array<[string, string]> = [
    ['GRANT EXECUTE on a function', `DO $$ BEGIN GRANT EXECUTE ON FUNCTION f() TO app; END $$;`],
    ['REVOKE EXECUTE on a function', `DO $$ BEGIN REVOKE EXECUTE ON FUNCTION f() FROM app; END $$;`],
    ['the word inside a RAISE NOTICE', `DO $$ BEGIN RAISE NOTICE 'EXECUTE the plan'; END $$;`],
    ['the word inside inserted data', `DO $$ BEGIN INSERT INTO log(msg) VALUES ('EXECUTE me later'); END $$;`],
    ['a column named execute_at', `DO $$ BEGIN UPDATE jobs SET execute_at = now() WHERE id = 1; END $$;`],
  ];

  for (const [name, sql] of benign) {
    it(`${name}: stays silent`, () => {
      assert.deepEqual(kinds(sql), [], sql);
    });
  }

  it('an ordinary updatable-view rewrite rule is not destruction', () => {
    // `DO INSTEAD UPDATE ... WHERE` is the standard updatable-view idiom. An
    // UPDATE action is judged the way a top-level UPDATE is, destructive only
    // without a WHERE. DELETE, TRUNCATE and DROP stay unconditional.
    assert.deepEqual(kinds(`CREATE RULE v_upd AS ON UPDATE TO v DO INSTEAD UPDATE base SET n = 1 WHERE id = 2;`), []);
    assert.deepEqual(kinds(`CREATE RULE v_upd AS ON UPDATE TO v DO INSTEAD UPDATE base SET n = 1;`), ['rewrite-rule']);
    assert.deepEqual(kinds(`CREATE RULE v_del AS ON DELETE TO v DO INSTEAD DELETE FROM base WHERE id = 1;`), [
      'rewrite-rule',
    ]);
  });
});

describe('destructive scan: one body, several statements, each judged on its own', () => {
  it('a second obfuscated EXECUTE is not hidden by a sibling that already matched', () => {
    // Reporting the first and stopping meant the DROP TABLE ran under a
    // confirmation the operator gave for the DROP COLUMN, which is the
    // "confirmed what they were shown" failure this module exists to prevent,
    // one level down.
    const found = kinds(
      `DO $$ BEGIN EXECUTE 'ALTER TABLE t DROP COLUMN x'; EXECUTE 'D' || 'ROP TABLE victim'; END $$;`,
    );
    assert.deepEqual(found, ['drop-column', 'dynamic-unclassified']);
  });

  it('one statement is still reported once, not once per pass', () => {
    // The anti-noise direction of the same rule: a readable assignment plus
    // `EXECUTE s` is ONE thing the operator needs to know, and a second
    // "cannot classify" entry for it would contradict the first.
    assert.deepEqual(kinds(`DO $$ DECLARE s text; BEGIN s := 'DROP TABLE ' || 'victim'; EXECUTE s; END $$;`), [
      'drop-table',
    ]);
    assert.deepEqual(kinds(`DO $$ BEGIN EXECUTE array_to_string(ARRAY['DROP TABLE', 'victim'], ' '); END $$;`), [
      'drop-table',
    ]);
  });

  it('a bare EXECUTE of a variable nothing explained is still refused', () => {
    // The suppression above is conditional on an earlier pass having spoken.
    // When the assembly itself is unreadable, this is the whole finding.
    assert.deepEqual(kinds(`DO $$ DECLARE s text; BEGIN s := chr(68) || 'ROP TABLE victim'; EXECUTE s; END $$;`), [
      'dynamic-unclassified',
    ]);
  });
});
