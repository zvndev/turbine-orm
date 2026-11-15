/**
 * The reader of catalog SQL text (src/pg-catalog-text.ts) and the index
 * metadata built from it.
 *
 * Every definition under "PostgreSQL 18.6" was created on a real server and
 * copied from `pg_indexes.indexdef`; the CockroachDB ones are its v24.1
 * `pg_indexes` output. The adversarial cases are the reason the reader lexes
 * instead of searching: an index named `"USING btree (kind)"` used to supply
 * the key list of an index over `slug`, a column named `"owner_id DESC"` was
 * read as `owner_id`, and `UNIQUE (kind, lower(slug))` was recorded as unique
 * on `kind`. Each of those let a `where` naming one value write every row with
 * it.
 *
 * Run: npx tsx --test src/test/pg-catalog-text.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  detectUniqueForeignKeySets,
  indexDefIsUnique,
  indexHasWhere,
  indexMetadataFromDefinition,
  parseIndexColumns,
  parsePlainUniqueIndexColumns,
} from '../introspect.js';
import { foldSqlText, isSequenceDefault, readIndexDefinition } from '../pg-catalog-text.js';
import { describeIndexDefMismatch } from '../schema-sql.js';

/** `[definition, unique, partial, key columns (null = expression)]` */
type Case = [string, boolean, boolean, (string | null)[]];

const POSTGRES: Case[] = [
  ['CREATE INDEX plain ON public.t USING btree (a)', false, false, ['a']],
  ['CREATE INDEX composite ON public.t USING btree (a, b)', false, false, ['a', 'b']],
  ['CREATE UNIQUE INDEX uniq ON public.t USING btree (email)', true, false, ['email']],
  ['CREATE UNIQUE INDEX t_pkey ON public.t USING btree (id)', true, false, ['id']],
  ['CREATE UNIQUE INDEX nnd ON public.t USING btree (slug) NULLS NOT DISTINCT', true, false, ['slug']],
  ['CREATE UNIQUE INDEX incl ON public.t USING btree (a) INCLUDE (c, d)', true, false, ['a']],
  ['CREATE UNIQUE INDEX part ON public.t USING btree (b) WHERE (c IS NOT NULL)', true, true, ['b']],
  [
    "CREATE UNIQUE INDEX part_lit ON public.t USING btree (kind) WHERE (note <> 'UNIQUE  x'::text)",
    true,
    true,
    ['kind'],
  ],
  ['CREATE INDEX boolpart ON public.t USING btree (k) WHERE flag', false, true, ['k']],
  ['CREATE UNIQUE INDEX expr ON public.t USING btree (lower(email))', true, false, [null]],
  ['CREATE UNIQUE INDEX mixed ON public.t USING btree (kind, lower(slug))', true, false, ['kind', null]],
  ['CREATE INDEX mixed2 ON public.t USING btree (((a + b)), c)', false, false, [null, 'c']],
  ['CREATE INDEX coalesce_e ON public.t USING btree (COALESCE(c, d))', false, false, [null]],
  ['CREATE INDEX castexpr ON public.t USING btree (((k)::integer))', false, false, [null]],
  ["CREATE INDEX lit_expr ON public.t USING btree (((email || 'ceo@example.com'::text)))", false, false, [null]],
  ["CREATE UNIQUE INDEX e_str ON public.t USING btree (((c || 'a\\b''c'::text)))", true, false, [null]],
  [
    'CREATE INDEX descs ON public.t USING btree (a DESC, b NULLS FIRST, c DESC NULLS LAST)',
    false,
    false,
    ['a', 'b', 'c'],
  ],
  ['CREATE INDEX opc ON public.t USING btree (c text_pattern_ops, d varchar_pattern_ops)', false, false, ['c', 'd']],
  ['CREATE INDEX coll ON public.t USING btree (c COLLATE "C", d COLLATE "POSIX" DESC)', false, false, ['c', 'd']],
  ["CREATE INDEX trgm ON public.t USING gist (c gist_trgm_ops (siglen='32'))", false, false, ['c']],
  ['CREATE INDEX gin_trgm ON public.t USING gin (c gin_trgm_ops)', false, false, ['c']],
  ['CREATE INDEX exprmods ON public.w USING btree (lower(c) COLLATE "C" text_pattern_ops DESC)', false, false, [null]],
  ["CREATE INDEX ff ON public.t USING btree (a) WITH (fillfactor='70')", false, false, ['a']],
  ['CREATE INDEX hashidx ON public.t USING hash (kind)', false, false, ['kind']],
  ['CREATE INDEX brin_idx ON public.t USING brin (a)', false, false, ['a']],
  ['CREATE UNIQUE INDEX on_only ON ONLY public.parts USING btree (id)', true, false, ['id']],
  ['CREATE UNIQUE INDEX other_idx ON other.o USING btree (v)', true, false, ['v']],
  ['CREATE INDEX kw_cols ON public.t USING btree (nulls, first DESC NULLS LAST)', false, false, ['nulls', 'first']],
  [
    'CREATE UNIQUE INDEX combo ON "we(ird, ""q"" WHERE".w USING btree (k DESC NULLS LAST) INCLUDE (id) NULLS NOT ' +
      "DISTINCT WITH (fillfactor='80', deduplicate_items=off) WHERE (k <> 'WHERE  ( x'::text)",
    true,
    true,
    ['k'],
  ],
];

/** Identifiers that spell the syntax the reader looks for. All real PostgreSQL 18.6 output. */
const ADVERSARIAL: Case[] = [
  // Index names.
  ['CREATE UNIQUE INDEX "USING btree (kind)" ON public.t USING btree (slug)', true, false, ['slug']],
  ['CREATE UNIQUE INDEX "WHERE x" ON public.t USING btree (note)', true, false, ['note']],
  ['CREATE INDEX "UNIQUE idx" ON public.t USING btree (kind)', false, false, ['kind']],
  [
    'CREATE UNIQUE INDEX "CREATE UNIQUE INDEX" ON "we(ird, ""q"" WHERE".w USING btree (id, c)',
    true,
    false,
    ['id', 'c'],
  ],
  ['CREATE INDEX "q""uote" ON public.t USING btree (kind)', false, false, ['kind']],
  ['CREATE INDEX "comma, idx" ON public.t USING btree (kind)', false, false, ['kind']],
  ['CREATE INDEX "paren (idx" ON public.t USING btree (kind)', false, false, ['kind']],
  ['CREATE INDEX "line\nbreak" ON public.t USING btree (kind)', false, false, ['kind']],
  [
    `CREATE INDEX "USING btree (k) WHERE" ON "we(ird, ""q"" WHERE".w USING btree (((c || ' WHERE x'::text)))`,
    false,
    false,
    [null],
  ],
  // Table and schema names.
  ['CREATE UNIQUE INDEX spoof_tbl ON public."USING btree (kind) WHERE x" USING btree (slug)', true, false, ['slug']],
  ['CREATE INDEX t2a ON public."UNIQUE t" USING btree (k)', false, false, ['k']],
  ['CREATE UNIQUE INDEX t2b ON public."quo""te" USING btree (k)', true, false, ['k']],
  ['CREATE UNIQUE INDEX t2c ON public."com,ma" USING btree (k)', true, false, ['k']],
  ['CREATE UNIQUE INDEX t2d ON public."par(en" USING btree (k)', true, false, ['k']],
  ['CREATE UNIQUE INDEX t2e ON public."new\nline" USING btree (k)', true, false, ['k']],
  ['CREATE UNIQUE INDEX t2f ON public."WHERE t" USING btree (k)', true, false, ['k']],
  ['CREATE UNIQUE INDEX t2g ON "we(ird, ""q"" WHERE".w USING btree (k)', true, false, ['k']],
  // Column names: the ordering words and the punctuation stay part of the name.
  ['CREATE UNIQUE INDEX col_desc ON public.t USING btree ("owner_id DESC")', true, false, ['owner_id DESC']],
  ['CREATE UNIQUE INDEX col_asc ON public.t USING btree ("x ASC")', true, false, ['x ASC']],
  ['CREATE UNIQUE INDEX col_nulls ON public.t USING btree ("y NULLS FIRST")', true, false, ['y NULLS FIRST']],
  ['CREATE UNIQUE INDEX col_comma ON public.t USING btree ("a,b")', true, false, ['a,b']],
  ['CREATE UNIQUE INDEX col_paren ON public.t USING btree ("p(q)")', true, false, ['p(q)']],
  [`CREATE UNIQUE INDEX col_apos ON public.t USING btree ("it's")`, true, false, ["it's"]],
  ['CREATE UNIQUE INDEX col_quote ON public.t USING btree ("q""uote")', true, false, ['q"uote']],
  ['CREATE UNIQUE INDEX col_mixed ON public.t USING btree ("Mixed")', true, false, ['Mixed']],
  // A collation named like an ordering word is a name, not an ordering.
  ['CREATE UNIQUE INDEX coll_desc ON public."ONLY" USING btree (a COLLATE "DESC")', true, false, ['a']],
  ['CREATE UNIQUE INDEX coll_desc2 ON public."ONLY" USING btree (a COLLATE "DESC" DESC)', true, false, ['a']],
];

/** CockroachDB v24.1 `pg_indexes.indexdef`: three-part table, `ASC` on every key, `STORING`. */
const COCKROACH: Case[] = [
  ['CREATE UNIQUE INDEX things_pkey ON defaultdb.late_index.things USING btree (id ASC)', true, false, ['id']],
  ['CREATE UNIQUE INDEX real_unique ON defaultdb.late_index.things USING btree (slug ASC)', true, false, ['slug']],
  ['CREATE INDEX "IDX_UNIQUE_kind" ON defaultdb.late_index.things USING btree (kind ASC)', false, false, ['kind']],
  ['CREATE INDEX "CREATE UNIQUE INDEX" ON defaultdb.late_index.things USING btree (note ASC)', false, false, ['note']],
  ['CREATE INDEX "quote""UNIQUE" ON defaultdb.late_index.things USING btree (note ASC)', false, false, ['note']],
  ['CREATE INDEX "line\nUNIQUE" ON defaultdb.late_index.things USING btree (note ASC)', false, false, ['note']],
  ['CREATE UNIQUE INDEX expression ON defaultdb.late_index.things USING btree (lower(slug) ASC)', true, false, [null]],
  [
    'CREATE UNIQUE INDEX included ON defaultdb.late_index.things USING btree (slug ASC) STORING (note)',
    true,
    false,
    ['slug'],
  ],
  [
    "CREATE UNIQUE INDEX partial ON defaultdb.late_index.things USING btree (slug ASC) WHERE (note != 'UNIQUE'::STRING)",
    true,
    true,
    ['slug'],
  ],
];

function check([def, unique, partial, columns]: Case): void {
  const read = readIndexDefinition(def);
  assert.ok(read, `reads ${JSON.stringify(def)}`);
  assert.equal(read.unique, unique, 'unique');
  assert.equal(read.partial, partial, 'partial');
  assert.deepEqual(
    read.keys.map((key) => key.column),
    columns,
    'key columns',
  );
}

describe('readIndexDefinition', () => {
  for (const [label, cases] of [
    ['PostgreSQL 18.6', POSTGRES],
    ['adversarial identifiers', ADVERSARIAL],
    ['CockroachDB', COCKROACH],
  ] as const) {
    describe(label, () => {
      for (const c of cases) it(JSON.stringify(c[0]).slice(1, 90), () => check(c));
    });
  }

  it('separates a key into column and modifiers, ordering words left out', () => {
    const read = readIndexDefinition(
      'CREATE INDEX x ON public.t USING btree (c COLLATE "C" text_pattern_ops DESC NULLS LAST, "owner_id DESC" ASC)',
    );
    assert.deepEqual(read?.keys, [
      { column: 'c', modifiers: ['COLLATE', '"C"', 'text_pattern_ops'] },
      { column: 'owner_id DESC', modifiers: [] },
    ]);
  });

  it('reads a quoted keyword as a name wherever it sits', () => {
    const read = readIndexDefinition(
      'CREATE UNIQUE INDEX coll_desc2 ON public."ONLY" USING btree (a COLLATE "DESC" DESC)',
    );
    assert.deepEqual(read?.keys[0]?.modifiers, ['COLLATE', '"DESC"']);
    // An unqualified table named "ONLY" is the table, not the ONLY keyword.
    assert.deepEqual(
      readIndexDefinition('CREATE INDEX "INDEX" ON "ONLY" USING btree ("USING")')?.keys.map((key) => key.column),
      ['USING'],
    );
  });

  it('accepts qualified collation and operator class names, and opclass parameters', () => {
    // pg_get_indexdef qualifies these when they are not on the search path.
    const read = readIndexDefinition(
      'CREATE INDEX x ON s.t USING gist (a COLLATE pg_catalog."default", b public.gist_trgm_ops (siglen=\'32\'))',
    );
    assert.deepEqual(
      read?.keys.map((key) => [key.column, key.modifiers.length > 0]),
      [
        ['a', true],
        ['b', true],
      ],
    );
  });

  it('reads an unreserved keyword as the column it is', () => {
    // `nulls` / `first` / `last` are unreserved, so PostgreSQL leaves them bare.
    const read = readIndexDefinition('CREATE INDEX x ON t USING btree (nulls NULLS FIRST, last, first DESC)');
    assert.deepEqual(
      read?.keys.map((key) => [key.column, key.modifiers.length]),
      [
        ['nulls', 0],
        ['last', 0],
        ['first', 0],
      ],
    );
  });

  it('reads a function call with a quoted or qualified name as an expression', () => {
    for (const key of ['"MyFunc"(email)', 'public.lower(email)', '"a"::text', '"a"||"b"', 'a + b', '(id)']) {
      const read = readIndexDefinition(`CREATE INDEX x ON t USING btree (${key})`);
      assert.deepEqual(
        read?.keys.map((k) => k.column),
        [null],
        key,
      );
    }
  });

  it('never reads the predicate, only that one is there', () => {
    // A predicate PostgreSQL would not render still makes the index partial,
    // which is the answer that claims least.
    const read = readIndexDefinition('CREATE UNIQUE INDEX idx ON tbl USING btree (a) WHERE (b');
    assert.deepEqual([read?.unique, read?.partial], [true, true]);
  });

  it('records where the predicate starts', () => {
    const def = 'CREATE UNIQUE INDEX "WHERE" ON t USING btree (a) WHERE (note = \'x WHERE y\')';
    const read = readIndexDefinition(def);
    assert.equal(def.slice(read?.whereAt), "WHERE (note = 'x WHERE y')");
  });

  it('cannot read what is not an index definition, and says so', () => {
    for (const def of [
      '',
      'not an index definition at all',
      'CREATE INDEX idx ON tbl USING btree (a, b',
      'CREATE INDEX idx ON tbl USING btree ()',
      'CREATE INDEX idx ON tbl USING btree (a,)',
      'CREATE INDEX idx ON tbl (a)',
      'CREATE INDEX "unterminated ON tbl USING btree (a)',
      "CREATE INDEX idx ON tbl USING btree ((a || 'unterminated))",
      'CREATE INDEX users_unparsable_idx ON public.users USING btree [truncated cfo@example.com',
      'CREATE INDEX idx ON tbl USING btree (a) SOMETHING ELSE',
      'CREATE INDEX idx ON tbl USING btree (a) WHERE',
      'CREATE INDEX idx ON tbl USING btree (a) INCLUDE b',
      'CREATE INDEX idx ON tbl USING btree (a) INCLUDE (b',
      'DROP INDEX idx',
    ]) {
      assert.equal(readIndexDefinition(def), null, JSON.stringify(def));
    }
  });
});

describe('index metadata from a definition', () => {
  it('a UNIQUE index is a unique key only when every key is a plain column', () => {
    assert.deepEqual(
      indexMetadataFromDefinition(
        'expr_mix',
        'CREATE UNIQUE INDEX expr_mix ON public.expr USING btree (kind, lower(slug))',
      ),
      {
        name: 'expr_mix',
        columns: ['kind'],
        unique: false,
        definition: 'CREATE UNIQUE INDEX expr_mix ON public.expr USING btree (kind, lower(slug))',
      },
    );
    assert.equal(
      indexMetadataFromDefinition('e', 'CREATE UNIQUE INDEX e ON t USING btree (lower(email))').unique,
      false,
    );
    // Modifiers and ordering do not make a column an expression.
    assert.equal(
      indexMetadataFromDefinition('o', 'CREATE UNIQUE INDEX o ON t USING btree (a DESC, b text_pattern_ops)').unique,
      true,
    );
    // The database's own keyword is still readable from the definition.
    assert.equal(indexDefIsUnique('CREATE UNIQUE INDEX e ON t USING btree (kind, lower(slug))'), true);
  });

  it('a quoted index name cannot supply the key list', () => {
    const def = 'CREATE UNIQUE INDEX "USING btree (kind)" ON late_index.spoof USING btree (slug)';
    const meta = indexMetadataFromDefinition('USING btree (kind)', def);
    assert.deepEqual([meta.columns, meta.unique, meta.partial], [['slug'], true, undefined]);
    assert.deepEqual(parsePlainUniqueIndexColumns(def), ['slug']);
  });

  it('ordering words inside a quoted column name stay part of the name', () => {
    const def = 'CREATE UNIQUE INDEX suffix_key ON late_index.children USING btree ("owner_id DESC")';
    assert.deepEqual(parseIndexColumns(def), ['owner_id DESC']);
    assert.deepEqual(parsePlainUniqueIndexColumns(def), ['owner_id DESC']);
    for (const name of ['x ASC', 'y NULLS FIRST', 'z NULLS LAST', 'w DESC NULLS LAST']) {
      const quoted = `CREATE UNIQUE INDEX k ON t USING btree ("${name}")`;
      assert.deepEqual(parsePlainUniqueIndexColumns(quoted), [name]);
    }
  });

  it('the word WHERE in a name or a literal does not make an index partial', () => {
    assert.equal(indexHasWhere('CREATE UNIQUE INDEX "WHERE x" ON public.t USING btree (note)'), false);
    assert.equal(indexHasWhere('CREATE UNIQUE INDEX t2f ON public."WHERE t" USING btree (k)'), false);
    assert.equal(indexHasWhere('CREATE UNIQUE INDEX u ON t USING btree (a, b) WHERE (b IS NOT NULL)'), true);
  });

  it('a definition that does not read claims nothing', () => {
    for (const def of ['CREATE UNIQUE INDEX u ON t USING btree (a, b', 'garbage']) {
      assert.deepEqual(indexMetadataFromDefinition('u', def), {
        name: 'u',
        columns: [],
        unique: false,
        definition: def,
        partial: true,
      });
      assert.equal(indexDefIsUnique(def), false);
      assert.equal(indexHasWhere(def), true);
      assert.equal(parsePlainUniqueIndexColumns(def), null);
    }
  });

  it('parsePlainUniqueIndexColumns refuses an expression, a predicate, a collation and an operator class', () => {
    for (const def of [
      'CREATE UNIQUE INDEX x ON t USING btree (kind, lower(slug))',
      'CREATE UNIQUE INDEX x ON t USING btree (a) WHERE (b IS NULL)',
      'CREATE UNIQUE INDEX x ON t USING btree (a COLLATE "C")',
      'CREATE UNIQUE INDEX x ON t USING btree (a text_pattern_ops)',
      'CREATE INDEX x ON t USING btree (a)',
    ]) {
      assert.equal(parsePlainUniqueIndexColumns(def), null, def);
    }
    assert.deepEqual(parsePlainUniqueIndexColumns('CREATE UNIQUE INDEX x ON t USING btree (a DESC NULLS LAST, "B")'), [
      'a',
      'B',
    ]);
  });

  it('a to-one relation needs the flags and the definition to agree', () => {
    const def = 'CREATE UNIQUE INDEX x ON t USING btree (owner_id)';
    const sets = (partial?: boolean) =>
      detectUniqueForeignKeySets(
        new Map(),
        new Map(),
        new Map([['t', [{ name: 'x', columns: ['owner_id'], unique: true, definition: def, partial }]]]),
      ).get('t');
    assert.deepEqual(sets(), [['owner_id']]);
    assert.equal(sets(true), undefined);
  });
});

describe('describeIndexDefMismatch reads the same definition', () => {
  it('a quoted index name cannot make the existing columns match', () => {
    const def = 'CREATE UNIQUE INDEX "USING btree (kind)" ON late_index.spoof USING btree (slug)';
    assert.match(
      describeIndexDefMismatch({ columns: ['kind'], unique: true }, def) ?? '',
      /differ from existing \(slug\)/,
    );
    assert.equal(describeIndexDefMismatch({ columns: ['slug'], unique: true }, def), null);
  });

  it('an ordering word inside a quoted column name is not dropped', () => {
    const def = 'CREATE UNIQUE INDEX k ON t USING btree ("owner_id DESC")';
    assert.notEqual(describeIndexDefMismatch({ columns: ['ownerId'], unique: true }, def), null);
  });

  it('ordering words are not compared; an expression, collation or opclass is a mismatch', () => {
    assert.equal(
      describeIndexDefMismatch(
        { columns: ['orgId', 'createdAt'] },
        'CREATE INDEX i ON t USING btree (org_id, created_at DESC)',
      ),
      null,
    );
    for (const key of ['lower(email)', 'email COLLATE "C"', 'email text_pattern_ops']) {
      assert.match(
        describeIndexDefMismatch({ columns: ['email'] }, `CREATE INDEX i ON t USING btree (${key})`) ?? '',
        /differ from existing/,
        key,
      );
    }
  });

  it('a WHERE in a name is not a predicate, and an unreadable definition is a mismatch', () => {
    assert.equal(
      describeIndexDefMismatch(
        { columns: ['note'], unique: true },
        'CREATE UNIQUE INDEX "WHERE x" ON t USING btree (note)',
      ),
      null,
    );
    assert.equal(
      describeIndexDefMismatch({ columns: ['note'] }, 'CREATE INDEX i ON t USING btree (note) WHERE (note IS NULL)'),
      'existing index is partial (has a WHERE clause)',
    );
    assert.match(
      describeIndexDefMismatch({ columns: ['a'] }, 'CREATE INDEX i ON t USING btree (a') ?? '',
      /differ from existing \(unreadable\)/,
    );
  });
});

describe('isSequenceDefault', () => {
  // `information_schema.columns.column_default`, PostgreSQL 18.6.
  for (const def of [
    "nextval('sd_a_seq'::regclass)", // serial, bigserial and smallserial all render this way
    "nextval('s1'::regclass)",
    "(nextval('s1'::regclass))::integer",
    "(nextval('s1'::regclass))::text",
    `nextval('"MySeq"'::regclass)`,
    "nextval('other.s2'::regclass)",
    "nextval(('s1'::text)::regclass)",
    "nextval('public.t_id_seq'::REGCLASS)", // CockroachDB with serial_normalization = sql_sequence
  ]) {
    it(`is a sequence: ${def}`, () => assert.equal(isSequenceDefault(def), true));
  }
  for (const def of [
    "'nextval(fake)'::text",
    "'x nextval(''s''::regclass)'::text",
    "(nextval('s1'::regclass) + 1)",
    "nextval('a'::regclass) || 'b'",
    "upper('nextval(s)')",
    'now()',
    'unique_rowid()',
    "'free'::text",
    "nextval('unterminated",
    '',
  ]) {
    it(`is not a sequence: ${def}`, () => assert.equal(isSequenceDefault(def), false));
  }
});

describe('foldSqlText', () => {
  it('folds case and whitespace outside literals and quoted identifiers', () => {
    assert.equal(foldSqlText('  NOW()  '), 'now()');
    assert.equal(foldSqlText('(n >= 1)   AND\n(n <= 10)'), '(n >= 1) and (n <= 10)');
    assert.equal(foldSqlText('CURRENT_TIMESTAMP'), foldSqlText('current_timestamp'));
  });

  it('leaves a literal and a quoted identifier as written', () => {
    assert.notEqual(foldSqlText("'UPPER'"), foldSqlText("'upper'"));
    assert.notEqual(foldSqlText("(v <> 'a  b'::text)"), foldSqlText("(v <> 'a b'::text)"));
    assert.notEqual(foldSqlText('"Col" > 0'), foldSqlText('"col" > 0'));
    assert.notEqual(foldSqlText("E'A\\'B'"), foldSqlText("E'a\\'b'"));
    assert.notEqual(foldSqlText('$$A  B$$'), foldSqlText('$$a b$$'));
    assert.equal(foldSqlText("v  =  'it''s  so'"), "v = 'it''s  so'");
  });

  it('compares text that does not lex exactly', () => {
    assert.equal(foldSqlText("  'unterminated  X "), "'unterminated  X");
  });
});
