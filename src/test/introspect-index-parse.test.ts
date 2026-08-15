/**
 * turbine-orm: index `indexdef` parsing (parseIndexColumns / indexHasWhere)
 *
 * The old greedy `/\((.+)\)/` swallowed a PARTIAL index's trailing
 * `WHERE (...)` parentheses into the captured column list, so IndexMetadata
 * carried a raw predicate fragment that then leaked into generated
 * compound-unique selector names. These build-only tests pin the USING-anchored
 * parse: clean columns, no WHERE fragment, quoted identifiers de-quoted, and the
 * partial-index flag.
 *
 * They also pin the clauses that follow the key list. `INCLUDE (...)`,
 * `WITH (...)` and a COLLATE / opclass key are the shapes `cli/mcp.ts`'s
 * independently written copy of this parser got wrong while this one did not
 * (`['id) INCLUDE (email']` against `['id']`), which is what made the ORM and the
 * MCP server disagree about whether an index covers a column, and therefore
 * about relation cardinality. Both surfaces consume this scanner now, so they
 * cannot answer differently; these tests are what pins its answers. (Two OTHER
 * indexdef parsers still exist, `parsePlainUniqueIndexColumns` in introspect.ts
 * and `describeIndexDefMismatch` in schema-sql.ts, and a fix here does not reach
 * them; see the catalogue on `parseIndexKeyEntries`.)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { indexHasWhere, indexKeyColumn, parseIndexColumns, parseIndexKeyEntries } from '../introspect.js';

describe('parseIndexColumns', () => {
  it('parses a plain multi-column index', () => {
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (org_id, user_id)'), ['org_id', 'user_id']);
  });

  it('drops a PARTIAL index WHERE clause instead of splicing it into the columns', () => {
    const def = 'CREATE UNIQUE INDEX u ON pos USING btree (ledger_id, line_id) WHERE (line_id IS NOT NULL)';
    const cols = parseIndexColumns(def);
    assert.deepEqual(cols, ['ledger_id', 'line_id']);
    // No WHERE / predicate garbage leaked into the column names.
    for (const c of cols) assert.doesNotMatch(c, /WHERE|IS NOT NULL|\)/i);
  });

  it('de-quotes quoted uppercase identifiers (Prisma implicit junction "A"/"B")', () => {
    assert.deepEqual(parseIndexColumns('CREATE UNIQUE INDEX u ON "_UserOrgs" USING btree ("A", "B")'), ['A', 'B']);
  });

  it('strips ASC/DESC ordering keywords', () => {
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (created_at DESC, id ASC)'), [
      'created_at',
      'id',
    ]);
  });

  it('drops expression columns conservatively', () => {
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (lower(email))'), []);
  });

  it('stops at the key list and ignores an INCLUDE clause', () => {
    // The covering-index shape. `INCLUDE` columns are payload, not key columns:
    // they are not what the index can be probed by, so a unique index over
    // (id) INCLUDE (email) makes `id` unique and says nothing about `email`.
    assert.deepEqual(parseIndexColumns('CREATE UNIQUE INDEX u ON tbl USING btree (id) INCLUDE (email)'), ['id']);
    assert.deepEqual(parseIndexColumns('CREATE UNIQUE INDEX u ON tbl USING btree (a, b) INCLUDE (c, d)'), ['a', 'b']);
  });

  it('ignores a WITH (storage parameter) clause', () => {
    assert.deepEqual(parseIndexColumns("CREATE INDEX idx ON tbl USING btree (a) WITH (fillfactor='70')"), ['a']);
  });

  it('reads the column out of a COLLATE / opclass key', () => {
    // `{ column } [COLLATE c] [opclass] [ASC|DESC] [NULLS ...]`: the column is the
    // LEADING token and the rest are modifiers. Returning the whole entry (which
    // suffix-stripping ASC/DESC alone did) yields a "column name" matching no
    // real column, so the index was invisible to relation derivation and to the
    // FK-index advisor.
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (email COLLATE "C" text_pattern_ops)'), [
      'email',
    ]);
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (email varchar_pattern_ops)'), ['email']);
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (a text_ops, b DESC NULLS LAST)'), [
      'a',
      'b',
    ]);
  });

  it('does not split a comma INSIDE an expression key', () => {
    // `.split(',')` cut this in half and produced two entries, neither of which
    // is a column and neither of which is a whole expression.
    assert.deepEqual(parseIndexKeyEntries('CREATE INDEX idx ON tbl USING btree (coalesce(a, b))'), ['coalesce(a, b)']);
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (coalesce(a, b))'), []);
  });

  it('does not read an apostrophe inside a quoted identifier as a string literal', () => {
    assert.deepEqual(parseIndexColumns(`CREATE INDEX idx ON tbl USING btree ("it's")`), ["it's"]);
  });

  it('returns nothing for a definition it cannot parse, never the whole of it', () => {
    // The one input this cannot read must not be the one it forwards.
    assert.deepEqual(parseIndexKeyEntries('CREATE INDEX idx ON tbl USING btree (a, b'), []);
    assert.deepEqual(parseIndexColumns('not an index definition at all'), []);
  });

  it('drops an expression key from a MIXED key list, so the column count is not the arity', () => {
    // THE PROPERTY EVERY CONSUMER OF `columns` HAS TO KNOW, pinned here because
    // one of them did not: on `(a, lower(b), c)` the column list is `['a', 'c']`
    // while the index has THREE keys, so `columns.length` is not the index's
    // arity and `columns` is not a key set the database enforces. `(a, c)` is
    // not unique; only `(a, lower(b), c)` is.
    //
    // Reading a length-2 `columns` as "a two-column index" is how a unique index
    // of this shape came to qualify as an m2m junction key
    // (`deriveCatalogRelations`, which now re-reads the arity from the raw
    // definition and requires the two to agree).
    const def = 'CREATE UNIQUE INDEX u ON t USING btree (a, lower(b), c)';
    assert.deepEqual(parseIndexKeyEntries(def), ['a', 'lower(b)', 'c']);
    assert.deepEqual(parseIndexColumns(def), ['a', 'c']);
    assert.notEqual(parseIndexKeyEntries(def).length, parseIndexColumns(def).length);
    // An all-plain key list is the case where the two DO agree.
    const plain = 'CREATE UNIQUE INDEX u ON t USING btree (a, b, c)';
    assert.equal(parseIndexKeyEntries(plain).length, parseIndexColumns(plain).length);
  });

  it('handles every trailing clause at once, predicate included', () => {
    const def =
      "CREATE UNIQUE INDEX u ON tbl USING btree (id) INCLUDE (email) WITH (fillfactor='70') WHERE (secret = 'x')";
    assert.deepEqual(parseIndexColumns(def), ['id']);
    // The stored value in the predicate is nowhere in the parsed key list.
    assert.equal(JSON.stringify(parseIndexKeyEntries(def)).includes('x'), false);
  });
});

describe('parseIndexKeyEntries / indexKeyColumn', () => {
  /**
   * The one difference between the two exports, and the reason `cli/mcp.ts` can
   * consume this module instead of keeping a copy: `parseIndexColumns` DROPS an
   * expression key (generated metadata has nowhere to say a key was not a
   * column), while the entries variant keeps it so the MCP server can report
   * `columnsWithheld: true` rather than silently returning a shorter list.
   */
  it('keeps an expression entry that parseIndexColumns drops', () => {
    const def = "CREATE INDEX idx ON tbl USING btree (id, (email || 'ceo@example.com'))";
    assert.deepEqual(parseIndexKeyEntries(def), ['id', "(email || 'ceo@example.com')"]);
    assert.deepEqual(parseIndexColumns(def), ['id']);
  });

  it('refuses a QUOTED name that is followed by anything but whitespace', () => {
    // A quoted identifier immediately followed by `(` is a function CALL, not a
    // column: `"MyFunc"(email)` is the same expression as `lower(email)` with a
    // case-preserving function name. The quoted branch returned at the closing
    // quote without looking at what came next, so it answered `MyFunc`, a column
    // that does not exist on the table. The unquoted branch has always applied
    // this rule; both do now.
    //
    // The phantom is not confined to the parse: it reaches generated metadata,
    // the FK-advisor's leading-column check, compound-unique selector derivation
    // and m2m junction detection.
    assert.equal(indexKeyColumn('"MyFunc"(email)'), null);
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree ("MyFunc"(email))'), []);
    assert.equal(indexKeyColumn('"a"::text'), null);
    assert.equal(indexKeyColumn('"a"||"b"'), null);
    // A quoted key alongside a real one: only the expression is dropped.
    assert.deepEqual(parseIndexColumns('CREATE INDEX idx ON tbl USING btree (org_id, "MyFunc"(email))'), ['org_id']);
    // ...and the shapes that legitimately follow a quoted name still resolve.
    assert.equal(indexKeyColumn('"MyCol"'), 'MyCol');
    assert.equal(indexKeyColumn('"MyCol" DESC'), 'MyCol');
    assert.equal(indexKeyColumn('"MyCol" COLLATE "C" text_pattern_ops'), 'MyCol');
    assert.equal(indexKeyColumn('"MyCol"  '), 'MyCol');
  });

  it('indexKeyColumn returns null for exactly the entries parseIndexColumns drops', () => {
    for (const entry of ['lower(email)', '(a || b)', "(email || 'x')", '(id)::text', '']) {
      assert.equal(indexKeyColumn(entry), null, `${entry} is not a plain column`);
    }
    for (const [entry, column] of [
      ['id', 'id'],
      ['"A"', 'A'],
      ['created_at DESC', 'created_at'],
      ['email COLLATE "C" text_pattern_ops', 'email'],
      ['"weird ""quoted"" name" DESC', 'weird "quoted" name'],
    ] as const) {
      assert.equal(indexKeyColumn(entry), column);
    }
  });
});

describe('indexHasWhere', () => {
  it('is true for a partial index and false for a full index', () => {
    assert.equal(indexHasWhere('CREATE UNIQUE INDEX u ON t USING btree (a, b) WHERE (b IS NOT NULL)'), true);
    assert.equal(indexHasWhere('CREATE UNIQUE INDEX u ON t USING btree (a, b)'), false);
  });
});
