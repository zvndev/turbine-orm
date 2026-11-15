/**
 * Reading the SQL text the PostgreSQL catalog renders.
 *
 * A pure leaf with ZERO imports, so introspect.ts, schema-sql.ts and
 * cli/mcp.ts read the same rules without a new import edge between them.
 *
 * ## Why this file exists
 *
 * Three catalog facts reach Turbine only as text: an index's structure
 * (`pg_indexes.indexdef`, which is `pg_get_indexdef`), a column's default
 * (`information_schema.columns.column_default`) and a CHECK constraint
 * (`pg_get_constraintdef`). Each used to be read with an unanchored search over
 * the whole string, and the string also carries identifiers and literals the
 * user chose. An index named `"USING btree (kind)"` supplied the key list of an
 * index over `slug`; a column named `"owner_id DESC"` lost its suffix to an
 * ordering-word regex and became `owner_id`; a default of `'nextval(fake)'`
 * read as a sequence; a CHECK's `'a  b'` compared equal to `'a b'`. The first
 * two decide whether `findUnique`, `update` and `delete` accept a `where`, and
 * whether a foreign key is a to-one relation, so a wrong answer deleted rows.
 *
 * So the text is LEXED the way PostgreSQL writes it, and every question is
 * asked of tokens: a quoted identifier (doubled `""` inside), a string literal
 * (doubled `''`), a bare word, a single `(`, `)`, `,` or `.`, or a run of
 * operator characters. A word inside a quoted identifier or a literal is never
 * a keyword, and a paren inside one never opens a group.
 *
 * Not `cli/sql-statements.ts`: that tokenizer splits a migration file into
 * statements and hands back text views of each, not tokens, and library code
 * imports one CLI file only. This one reads a single statement or expression
 * the catalog wrote, which has no comments and no dollar quotes.
 *
 * ## The contract every caller relies on
 *
 * When the text does not have the shape PostgreSQL renders, the reader says it
 * cannot read it (`null`), and the caller treats that as the answer that claims
 * least: not unique, no columns to trust, partial, not a sequence. Nothing here
 * falls back to a looser search, because the input a reader cannot parse is
 * exactly the one it must not vouch for.
 */

/** A lexed token: `k` is its kind, `t` its text as written, `at` its offset. */
interface Token {
  /** `' '` whitespace, `w` bare word or number, `q` quoted identifier, `s` string literal, `p` punctuation or operator. */
  k: string;
  t: string;
  at: number;
}

// One alternative per token kind, in priority order, each kind its own capture
// group: whitespace, string literal, quoted identifier, bare word. A lone `(`,
// `)`, `,` or `.` and a run of operator characters are punctuation. Every
// alternative that can contain a quote is quote-aware, and `'`, `"` and `$` are
// in no other class, so an unterminated literal or identifier matches nothing
// and the lex fails rather than reading on. So does a `$` quote, which the
// catalog never renders, and an `E'...'` string with a backslash-escaped quote,
// which PostgreSQL never renders here and CockroachDB only inside an expression
// or a predicate: the definition then does not read, and claims least. The
// literal patterns are linear: their branches start with different characters.
// PostgreSQL quotes every identifier that is not plain lower-case ASCII, so a
// non-ASCII letter outside quotes is read as punctuation: in a key that makes
// an expression, the reading that claims less.
const TOKEN = /(\s+)|('(?:''|[^'])*')|("(?:""|[^"])*")|(\w[\w$]*)|[(),.]|[^\s\w$'"(),.]+/y;

function lex(text: string): Token[] | null {
  const out: Token[] = [];
  for (let at = 0; at < text.length; at = TOKEN.lastIndex) {
    TOKEN.lastIndex = at;
    const m = TOKEN.exec(text);
    if (!m) return null;
    out.push({ k: m[1] ? ' ' : m[2] ? 's' : m[3] ? 'q' : m[4] ? 'w' : 'p', t: m[0], at });
  }
  return out;
}

/** The index of the `)` closing the `(` at `i`, or -1. */
function closing(t: Token[], i: number): number {
  if (t[i]?.t !== '(') return -1;
  for (let depth = 0; i < t.length; i++) {
    if (t[i]!.t === '(') depth++;
    else if (t[i]!.t === ')' && --depth === 0) return i;
  }
  return -1;
}

/** The (upper-cased) bare word at `i`, or `''` for anything else. */
const wordAt = (t: Token[], i: number): string => (t[i]?.k === 'w' ? t[i]!.t.toUpperCase() : '');

/** Past a possibly qualified name (`a`, `"A"`, `s."T"`) starting at `i`, or -1. */
function pastName(t: Token[], i: number): number {
  for (;;) {
    if (t[i]?.k !== 'w' && t[i]?.k !== 'q') return -1;
    if (t[++i]?.t !== '.') return i;
    i++;
  }
}

// ---------------------------------------------------------------------------
// Index definitions
// ---------------------------------------------------------------------------

/** One entry of an index's key list. */
export interface IndexKey {
  /**
   * The column it indexes, unquoted (`"A"` is `A`, `"q""x"` is `q"x`), or
   * `null` when the entry is an expression (`lower(email)`, `((a + b))`).
   */
  column: string | null;
  /**
   * For a column, the COLLATE clause and operator class after its name, token
   * by token as written (`['COLLATE', '"C"', 'text_pattern_ops']`). Ordering
   * words (`ASC` / `DESC` / `NULLS FIRST` / `NULLS LAST`) are not modifiers:
   * they change no equality. Empty for a bare column and for an expression.
   */
  modifiers: string[];
}

/** What an index definition states. */
export interface IndexDefinition {
  /** The statement reads `CREATE UNIQUE INDEX`, whatever its keys are. */
  unique: boolean;
  /** The key list, in order. Never empty. INCLUDE / STORING columns are not keys. */
  keys: IndexKey[];
  /** The index has a top-level `WHERE` predicate (a partial index). */
  partial: boolean;
  /** Offset of that `WHERE` in the definition, or -1. */
  whereAt: number;
}

/**
 * Read a `pg_get_indexdef` text: `CREATE [UNIQUE] INDEX <name> ON [ONLY]
 * <qualified table> USING <method> (<keys>) [INCLUDE | STORING (...)] [NULLS
 * [NOT] DISTINCT] [WITH (...)] [TABLESPACE <name>] [WHERE <predicate>]`.
 * CockroachDB's `pg_indexes` renders the same statement with a three-part
 * table name, `ASC` after every key and `STORING` for INCLUDE.
 *
 * Returns `null` for any text not of that shape (see the module contract).
 */
export function readIndexDefinition(text: string): IndexDefinition | null {
  const t = lex(text)?.filter((x) => x.k !== ' ');
  if (!t) return null;
  let i = 0;
  const word = (w: string): boolean => wordAt(t, i) === w && ++i > 0;
  const name = (): boolean => {
    i = pastName(t, i);
    return i >= 0;
  };
  if (!word('CREATE')) return null;
  const unique = word('UNIQUE');
  if (!word('INDEX') || !name() || !word('ON')) return null;
  word('ONLY');
  if (!name() || !word('USING') || !name()) return null;
  const end = closing(t, i);
  if (end < 0) return null;
  const keys: IndexKey[] = [];
  for (let start = i + 1, j = start; j <= end; j++) {
    if (j < end && t[j]!.t === '(') j = closing(t, j);
    else if (j === end || t[j]!.t === ',') {
      if (j === start) return null;
      keys.push(readKey(t.slice(start, j)));
      start = j + 1;
    }
  }
  let whereAt = -1;
  for (i = end + 1; i < t.length && whereAt < 0; ) {
    if (word('INCLUDE') || word('STORING') || word('WITH')) {
      i = closing(t, i) + 1; // 0 when the group does not close
      if (!i) return null;
    } else if (word('NULLS')) {
      word('NOT');
      if (!word('DISTINCT')) return null;
    } else if (word('TABLESPACE')) {
      if (!name()) return null;
    } else if (wordAt(t, i) === 'WHERE' && i < t.length - 1) {
      // The predicate runs to the end; what it says is never read, only that
      // it exists, which already claims the least.
      whereAt = t[i]!.at;
    } else return null;
  }
  return { unique, keys, partial: whereAt >= 0, whereAt };
}

/**
 * One key entry: `{ column | expression } [COLLATE name] [opclass [(params)]]
 * [ASC | DESC] [NULLS FIRST | LAST]`. The column is the LEADING token, read as
 * a token, so the ordering words in `"owner_id DESC"` stay part of the name. A
 * key is a column only when what follows that token is names (the COLLATE
 * clause, the opclass, the ordering words) and an opclass parameter list;
 * anything else (a function call, a cast, an operator) makes it an expression.
 * The ordering words are left out of `modifiers` as PostgreSQL writes them,
 * upper-case; an opclass that happens to be named `first` is written lower-case.
 */
function readKey(k: Token[]): IndexKey {
  const head = k[0]!;
  let j = 1;
  let column = head.k === 'q' || head.k === 'w';
  while (column && j < k.length) {
    // pastName answers -1 and closing() + 1 answers 0 when there is no such thing.
    j = k[j]!.t === '(' && j > 1 ? closing(k, j) + 1 : pastName(k, j);
    column = j > 0;
  }
  return {
    column: column ? (head.k === 'q' ? head.t.slice(1, -1).replace(/""/g, '"') : head.t) : null,
    modifiers: column ? k.slice(1).flatMap((x) => (/^(ASC|DESC|NULLS|FIRST|LAST)$/.test(x.t) ? [] : [x.t])) : [],
  };
}

// ---------------------------------------------------------------------------
// Default and CHECK expressions
// ---------------------------------------------------------------------------

/**
 * Whether a column default IS a sequence call, as PostgreSQL renders one:
 * `nextval('users_id_seq'::regclass)`, possibly cast and parenthesised
 * (`(nextval('s'::regclass))::integer`), with the argument possibly a cast text
 * (`nextval(('s'::text)::regclass)`). The whole default must be that call: the
 * pattern is anchored at both ends and reads the argument as one complete
 * literal, so `'nextval(fake)'::text` is a string default, and one that does
 * arithmetic on the call, `(nextval('s'::regclass) + 1)`, is not the
 * sequence's own value.
 */
export function isSequenceDefault(text: string): boolean {
  return /^\(*nextval\(\(*'(''|[^'])*'(::\w+)?\)*::regclass\)+(::[\w ]+(\(\d+(,\d+)?\))?)*$/i.test(text.trim());
}

/**
 * A default or CHECK expression in the form two spellings of it are compared
 * in: whitespace runs collapsed to one space and bare words (keywords, unquoted
 * names, function names) lower-cased, which leaves string literals and quoted
 * identifiers as written. `'UPPER'` and `'upper'` are different values and
 * `"Col"` and `"col"` different columns, while `NOW()` and `now()`, or a
 * re-indented expression, are the same text. Text that does not lex is
 * returned trimmed, so it compares exactly.
 */
export function foldSqlText(text: string): string {
  const t = lex(text);
  return (t ? t.map((x) => (x.k === 'w' ? x.t.toLowerCase() : x.k === ' ' ? ' ' : x.t)).join('') : text).trim();
}
