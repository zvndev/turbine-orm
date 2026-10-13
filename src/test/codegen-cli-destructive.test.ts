/**
 * The destructive-migration guard against statements that rewrite or remove
 * rows without saying DELETE or "no WHERE":
 *
 *   - a WHERE that restricts nothing (`true`, `1 = 1`, `x OR true`, `id = id`)
 *   - `PREPARE name AS <DELETE | UPDATE>` followed by `EXECUTE name`
 *   - `INSERT ... ON CONFLICT DO UPDATE` with no restricting WHERE
 *   - `DROP VIEW ... CASCADE` and `DROP MATERIALIZED VIEW`
 *   - `lo_unlink(...)`, which deletes large objects with no WHERE to look for
 *
 * Every shape has a look-alike that must stay quiet: the same words inside a
 * string literal or a comment. A guard that fires on prose teaches operators to
 * confirm without reading.
 *
 * Run: npx tsx --test src/test/codegen-cli-destructive.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DESTRUCTIVE_KIND_LABEL, scanDestructiveSql } from '../cli/destructive.js';

const kinds = (sql: string) => scanDestructiveSql(sql).map((s) => s.kind);
const targets = (sql: string) => scanDestructiveSql(sql).map((s) => s.target);

describe('destructive scan: an UPDATE whose WHERE restricts nothing', () => {
  const unrestricted: Array<[string, string]> = [
    ['WHERE true', 'UPDATE t SET c = 1 WHERE true'],
    ['WHERE TRUE with RETURNING', 'UPDATE t SET c = 1 WHERE TRUE RETURNING id'],
    ['WHERE (true)', 'UPDATE t SET c = 1 WHERE (true)'],
    ['WHERE 1=1', 'UPDATE t SET c = 1 WHERE 1=1'],
    ['WHERE 1 = 1 with RETURNING', 'UPDATE t SET c=1 WHERE 1 = 1 RETURNING *'],
    ['WHERE (1 = 1)', 'UPDATE t SET c = 1 WHERE (1 = 1)'],
    ['WHERE 2 > 1', 'UPDATE t SET c = 1 WHERE 2 > 1'],
    ['a literal compared to itself', "UPDATE t SET c = 1 WHERE 'a' = 'a'"],
    ['a column compared to itself', 'UPDATE t SET c = 1 WHERE id = id'],
    ['an inequality of constants that holds', 'UPDATE t SET c = 1 WHERE 1 <> 0'],
    ['a != of constants that holds', 'UPDATE t SET c = 1 WHERE 1 != 0'],
    ['a < of constants that holds', 'UPDATE t SET c = 1 WHERE 1 < 2'],
    ['a <= of constants that holds', 'UPDATE t SET c = 1 WHERE 2 <= 2'],
    ['a >= of constants that holds', 'UPDATE t SET c = 1 WHERE 3 >= 3'],
    ['a quoted column named or beside OR true', 'UPDATE t SET c = 1 WHERE "or" = 1 OR true'],
    ['OR true', 'UPDATE t SET c = 1 WHERE id > 0 OR true'],
    ['NOT false', 'UPDATE t SET c = 1 WHERE NOT false'],
    ['true AND true', 'UPDATE t SET c = 1 WHERE true AND true'],
    ['a quoted table name', 'UPDATE "t" SET c = 1 WHERE true'],
    ['a schema-qualified quoted table', 'UPDATE "s"."t" SET c = 1 WHERE 1 = 1'],
    ['UPDATE ONLY', 'UPDATE ONLY t SET c = 1 WHERE true'],
    ['no WHERE at all (control)', 'UPDATE t SET c = 1'],
    ['no WHERE, quoted table (control)', 'UPDATE "t" SET c = 1;'],
  ];
  for (const [name, sql] of unrestricted) {
    it(`reports ${name}`, () => {
      assert.deepEqual(kinds(sql), ['update-without-where'], sql);
    });
  }

  const restricted: Array<[string, string]> = [
    ['an equality on a column', 'UPDATE t SET c = 1 WHERE id = 1'],
    ['a bind parameter', 'UPDATE t SET c = 1 WHERE id = $1'],
    ['WHERE false', 'UPDATE t SET c = 1 WHERE false'],
    ['WHERE 1 = 0', 'UPDATE t SET c = 1 WHERE 1 = 0'],
    ['AND with a real predicate', 'UPDATE t SET c = 1 WHERE id > 0 AND true'],
    ['WHERE CURRENT OF', 'UPDATE t SET c = 1 WHERE CURRENT OF cur'],
    ['IS NULL', 'UPDATE t SET c = 1 WHERE x IS NULL'],
    ['an inequality of constants that fails', 'UPDATE t SET c = 1 WHERE 1 != 1'],
    ['a < of constants that fails', 'UPDATE t SET c = 1 WHERE 2 < 1'],
    ['a <= of constants that fails', 'UPDATE t SET c = 1 WHERE 3 <= 2'],
    ['a >= of constants that fails', 'UPDATE t SET c = 1 WHERE 1 >= 2'],
    ['NOT true', 'UPDATE t SET c = 1 WHERE NOT true'],
    ['a quoted column named or', 'UPDATE t SET c = 1 WHERE "or" = 1'],
    ['a quoted column named and beside AND true', 'UPDATE t SET c = 1 WHERE "and" = 1 AND true'],
    ['a quoted column named where', 'UPDATE t SET c = 1 WHERE "where" = 1'],
    ['false OR false', 'UPDATE t SET c = 1 WHERE false OR false'],
    ['a subquery predicate', 'UPDATE t SET c = 1 WHERE id IN (SELECT id FROM u)'],
  ];
  for (const [name, sql] of restricted) {
    it(`stays quiet for ${name}`, () => {
      assert.deepEqual(kinds(sql), [], sql);
    });
  }

  it('names the table, quoted or not', () => {
    assert.deepEqual(targets('UPDATE "t" SET c = 1'), ['t']);
    assert.deepEqual(targets('UPDATE public."t" SET c = 1'), ['public.t']);
    assert.deepEqual(targets('UPDATE ONLY "t" SET c = 1'), ['t']);
  });

  it('a DELETE with WHERE true is still reported as a delete', () => {
    assert.deepEqual(kinds('DELETE FROM t WHERE true'), ['delete']);
    assert.deepEqual(kinds('DELETE FROM t WHERE 1 = 1'), ['delete']);
  });

  it('judges the same predicate inside a DO block', () => {
    assert.deepEqual(kinds('DO $$ BEGIN UPDATE t SET c = 1 WHERE true; END $$;'), ['update-without-where']);
    assert.deepEqual(kinds('DO $$ BEGIN UPDATE t SET c = 1 WHERE id = 1; END $$;'), []);
  });

  describe('look-alikes in literals and comments', () => {
    it('a literal that spells a restricting WHERE does not restrict the UPDATE', () => {
      assert.deepEqual(kinds("UPDATE t SET note = 'WHERE id = 1'"), ['update-without-where']);
    });
    it('a line comment that spells a restricting WHERE does not restrict the UPDATE', () => {
      assert.deepEqual(kinds('UPDATE t SET c = 1 -- WHERE id = 1'), ['update-without-where']);
    });
    it('a block comment that spells a restricting WHERE does not restrict the UPDATE', () => {
      assert.deepEqual(kinds('UPDATE t SET c = 1 /* WHERE id = 1 */'), ['update-without-where']);
    });
    it('a literal that spells WHERE true does not make a real predicate constant', () => {
      assert.deepEqual(kinds("UPDATE t SET note = 'x' WHERE note = 'WHERE true'"), []);
    });
    it('a trailing comment that spells OR true does not make a real predicate constant', () => {
      assert.deepEqual(kinds('UPDATE t SET c = 1 WHERE id = 1 -- or WHERE true'), []);
      assert.deepEqual(kinds('UPDATE t SET c = 1 WHERE id = 1 /* OR true */'), []);
    });
    it('a quoted column named "where" is not a WHERE clause', () => {
      assert.deepEqual(kinds('UPDATE t SET "where" = 1'), ['update-without-where']);
    });
  });
});

describe('destructive scan: PREPARE then EXECUTE', () => {
  const prepared: Array<[string, string, string]> = [
    ['a DELETE', 'PREPARE p AS DELETE FROM t; EXECUTE p;', 'delete'],
    ['a DELETE with a bind', 'PREPARE p AS DELETE FROM t WHERE id = $1', 'delete'],
    ['a quoted statement name', 'PREPARE "p" AS DELETE FROM t', 'delete'],
    ['an UPDATE with no WHERE', 'PREPARE p (int) AS UPDATE t SET c = $1; EXECUTE p(1);', 'update-without-where'],
    ['lower case', 'prepare p as update t set c = 1', 'update-without-where'],
    ['several parameter types', 'PREPARE p (int, text) AS UPDATE "t" SET c = $1 WHERE true', 'update-without-where'],
    [
      'an upsert with no WHERE',
      'PREPARE p AS INSERT INTO t (a) VALUES ($1) ON CONFLICT (a) DO UPDATE SET c = 1',
      'overwrite-on-conflict',
    ],
  ];
  for (const [name, sql, kind] of prepared) {
    it(`reports a prepared ${name}`, () => {
      assert.deepEqual(kinds(sql), [kind], sql);
    });
  }

  it('stays quiet for a prepared UPDATE with a real WHERE', () => {
    assert.deepEqual(kinds('PREPARE p AS UPDATE t SET c = 1 WHERE id = $1'), []);
  });
  it('stays quiet for a prepared SELECT', () => {
    assert.deepEqual(kinds('PREPARE p AS SELECT 1; EXECUTE p;'), []);
  });
  it('stays quiet for PREPARE TRANSACTION', () => {
    assert.deepEqual(kinds("PREPARE TRANSACTION 'x'"), []);
  });

  describe('look-alikes in literals and comments', () => {
    it('a literal that spells a PREPARE', () => {
      assert.deepEqual(kinds("SELECT 'PREPARE p AS DELETE FROM t'"), []);
    });
    it('a line comment that spells a PREPARE', () => {
      assert.deepEqual(kinds('-- PREPARE p AS DELETE FROM t'), []);
    });
    it('a block comment that spells a PREPARE', () => {
      assert.deepEqual(kinds('/* PREPARE p AS DELETE FROM t */ SELECT 1'), []);
    });
    it('a COMMENT ON text that spells a PREPARE', () => {
      assert.deepEqual(kinds("COMMENT ON TABLE t IS 'PREPARE x AS DELETE FROM t'"), []);
    });
  });
});

describe('destructive scan: INSERT ... ON CONFLICT DO UPDATE without a WHERE', () => {
  const overwrites: Array<[string, string]> = [
    ['no WHERE', 'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1'],
    ['a quoted table', 'INSERT INTO "t" (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1'],
    ['a schema-qualified quoted table', 'INSERT INTO "s"."t" (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1'],
    ['ON CONSTRAINT', 'INSERT INTO t (a) VALUES (1) ON CONFLICT ON CONSTRAINT t_pkey DO UPDATE SET c = 1'],
    ['a WHERE that is always true', 'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1 WHERE true'],
    [
      'only an index predicate before DO UPDATE',
      'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) WHERE a > 0 DO UPDATE SET c = 1',
    ],
    ['a CTE in front', 'WITH x AS (SELECT 1) INSERT INTO t (a) SELECT 1 ON CONFLICT (a) DO UPDATE SET c = 1'],
    [
      'a literal that spells a WHERE',
      "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET note = 'WHERE id = 1'",
    ],
  ];
  for (const [name, sql] of overwrites) {
    it(`reports ${name}`, () => {
      assert.deepEqual(kinds(sql), ['overwrite-on-conflict'], sql);
    });
  }

  it('reports it inside a DO block, as the upsert and not as an UPDATE', () => {
    assert.deepEqual(kinds('DO $$ BEGIN INSERT INTO t(a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1; END $$;'), [
      'overwrite-on-conflict',
    ]);
  });

  it('names the table', () => {
    assert.deepEqual(targets('INSERT INTO "t" (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1'), ['t']);
    assert.deepEqual(targets('INSERT INTO "s"."t" (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1'), ['s.t']);
  });

  it('has a label that says what to change', () => {
    assert.match(DESTRUCTIVE_KIND_LABEL['overwrite-on-conflict'], /ON CONFLICT DO UPDATE/);
  });

  it('stays quiet when a WHERE says which conflicting rows may change', () => {
    assert.deepEqual(
      kinds(
        'INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = EXCLUDED.c WHERE t.c IS DISTINCT FROM EXCLUDED.c',
      ),
      [],
    );
  });
  it('stays quiet for DO NOTHING', () => {
    assert.deepEqual(kinds('INSERT INTO t (a) VALUES (1) ON CONFLICT DO NOTHING'), []);
  });
  it('stays quiet for a plain INSERT', () => {
    assert.deepEqual(kinds('INSERT INTO t (a) VALUES (1)'), []);
  });

  describe('look-alikes in literals and comments', () => {
    it('a literal that spells the clause', () => {
      assert.deepEqual(kinds("INSERT INTO t (a) VALUES ('ON CONFLICT DO UPDATE')"), []);
    });
    it('a line comment that spells the clause', () => {
      assert.deepEqual(kinds('INSERT INTO t (a) VALUES (1) -- ON CONFLICT (a) DO UPDATE SET c = 1'), []);
    });
    it('a block comment that spells the clause', () => {
      assert.deepEqual(kinds('INSERT INTO t (a) VALUES (1) /* ON CONFLICT (a) DO UPDATE SET c = 1 */'), []);
    });
    it('a comment that spells a WHERE does not restrict the upsert', () => {
      assert.deepEqual(kinds('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET c = 1 -- WHERE a = 1'), [
        'overwrite-on-conflict',
      ]);
    });
  });
});

describe('destructive scan: DROP VIEW CASCADE and DROP MATERIALIZED VIEW', () => {
  const cascades: Array<[string, string]> = [
    ['DROP VIEW v CASCADE', 'DROP VIEW v CASCADE;'],
    ['IF EXISTS', 'DROP VIEW IF EXISTS v CASCADE'],
    ['a list of views', 'DROP VIEW a, b CASCADE'],
    ['a quoted name with a space', 'DROP VIEW "my view" CASCADE'],
    ['a schema-qualified name', 'DROP VIEW s.v CASCADE'],
  ];
  for (const [name, sql] of cascades) {
    it(`reports ${name}`, () => {
      assert.deepEqual(kinds(sql), ['drop-cascade'], sql);
    });
  }

  const matviews: Array<[string, string]> = [
    ['a plain name', 'DROP MATERIALIZED VIEW mv'],
    ['IF EXISTS with a quoted qualified name', 'DROP MATERIALIZED VIEW IF EXISTS "s"."mv"'],
    ['CASCADE', 'DROP MATERIALIZED VIEW mv CASCADE'],
    ['inside a DO block', 'DO $$ BEGIN DROP MATERIALIZED VIEW mv; END $$'],
  ];
  for (const [name, sql] of matviews) {
    it(`reports a materialized view dropped with ${name}`, () => {
      assert.deepEqual(kinds(sql), ['drop-matview'], sql);
    });
  }

  it('a plain DROP VIEW without CASCADE stays quiet', () => {
    assert.deepEqual(kinds('DROP VIEW v;'), []);
  });

  describe('look-alikes in literals, comments and names', () => {
    it('a literal that spells DROP VIEW CASCADE', () => {
      assert.deepEqual(kinds("SELECT 'DROP VIEW v CASCADE'"), []);
    });
    it('a comment that spells DROP MATERIALIZED VIEW', () => {
      assert.deepEqual(kinds('-- DROP MATERIALIZED VIEW mv'), []);
      assert.deepEqual(kinds('/* DROP MATERIALIZED VIEW mv */ SELECT 1'), []);
    });
    it('a COMMENT ON VIEW text that spells it', () => {
      assert.deepEqual(kinds("COMMENT ON VIEW v IS 'DROP VIEW v CASCADE'"), []);
    });
    it('a view whose name contains the word', () => {
      assert.deepEqual(kinds('CREATE VIEW v_cascade AS SELECT 1'), []);
      assert.deepEqual(kinds('CREATE OR REPLACE VIEW v AS SELECT 1'), []);
    });
  });
});

describe('destructive scan: lo_unlink', () => {
  const unlinks: Array<[string, string]> = [
    ['over the large object catalog', 'SELECT lo_unlink(oid) FROM pg_largeobject_metadata'],
    ['by id', 'SELECT lo_unlink(16385)'],
    ['schema-qualified', 'SELECT pg_catalog.lo_unlink(1)'],
    ['upper case with a space before the paren', 'SELECT LO_UNLINK (1)'],
    ['in a DO block', 'DO $$ BEGIN PERFORM lo_unlink(1); END $$'],
    ['in a SQL function body', 'CREATE FUNCTION f() RETURNS void AS $$ SELECT lo_unlink(1) $$ LANGUAGE sql'],
  ];
  for (const [name, sql] of unlinks) {
    it(`reports lo_unlink ${name}`, () => {
      assert.deepEqual(kinds(sql), ['large-object-unlink'], sql);
    });
  }

  it('has a label', () => {
    assert.ok(DESTRUCTIVE_KIND_LABEL['large-object-unlink']);
  });

  describe('look-alikes in literals, comments, identifiers and DDL that only names the function', () => {
    it('a literal that spells the call', () => {
      assert.deepEqual(kinds("SELECT 'lo_unlink(1)'"), []);
    });
    it('a line comment and a block comment that spell the call', () => {
      assert.deepEqual(kinds('-- SELECT lo_unlink(1)'), []);
      assert.deepEqual(kinds('/* lo_unlink(1) */ SELECT 1'), []);
    });
    it('a comment inside a DO block that spells the call', () => {
      assert.deepEqual(kinds('DO $$ BEGIN -- lo_unlink(1)\n PERFORM 1; END $$'), []);
    });
    it('a function whose name only ends with the name', () => {
      assert.deepEqual(kinds('SELECT my_lo_unlink(1)'), []);
      assert.deepEqual(kinds('SELECT lo_unlinks(1)'), []);
    });
    it('GRANT, COMMENT and DROP FUNCTION name the function and call nothing', () => {
      assert.ok(!kinds('GRANT EXECUTE ON FUNCTION lo_unlink(oid) TO app').includes('large-object-unlink'));
      assert.ok(!kinds("COMMENT ON FUNCTION lo_unlink(oid) IS 'x'").includes('large-object-unlink'));
      assert.ok(!kinds('DROP FUNCTION lo_unlink(oid)').includes('large-object-unlink'));
      assert.ok(!kinds('REVOKE EXECUTE ON FUNCTION lo_unlink(oid) FROM app').includes('large-object-unlink'));
    });
  });
});
