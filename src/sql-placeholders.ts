/**
 * Where the bind placeholders are in a statement, read with the lexical rules
 * of the engine that will run it.
 *
 * The SQLite, MySQL and SQL Server shims rewrite placeholders before handing a
 * statement to their driver: a `$n` written in raw SQL becomes the engine's own
 * spelling, and MySQL expands an `in` list into one placeholder per element. A
 * rewrite that lands inside a string literal, a quoted identifier or a comment
 * changes what the statement means, so the scan has to agree with the ENGINE
 * about which characters are code. That is why this is not the migration
 * tokenizer in `cli/sql-statements.ts`: that one copies PostgreSQL's lexer
 * (dollar quoting, `E''` strings, nested comments) and knows nothing of
 * backtick or bracket identifiers, `#` comments or MySQL's backslash escapes,
 * each of which would put a rewrite inside quoted text here.
 *
 * Where a reading is ambiguous the scan treats more text as quoted, never less:
 * a placeholder it fails to see reaches the driver unrewritten and fails
 * loudly, while one it invents inside a literal silently changes stored data.
 * MySQL's backslash escapes are the case in point. A pool Turbine builds turns
 * them off (`NO_BACKSLASH_ESCAPES`), an injected pool may not, and treating
 * `\'` as an escape is the reading that can only hide a placeholder.
 *
 * Zero imports: every engine entry shares it.
 */

/** Which engine's lexical rules to apply. */
export type PlaceholderSyntax = 'mysql' | 'sqlite' | 'mssql';

/** One placeholder found in code (never inside a literal, a quoted identifier or a comment). */
export interface PlaceholderToken {
  /** `$n` (the portable positional spelling), a named `:name` (MySQL only), or a bare `?`. */
  readonly kind: 'positional' | 'named' | 'question';
  /** Offset of the first character (`$` or `:`). */
  readonly start: number;
  /** Offset just past the last character. */
  readonly end: number;
  /** The digits of a `$n`, the name of a `:name`, or `?`. */
  readonly name: string;
}

const DIGIT = /[0-9]/;
/** Characters that continue an unquoted identifier or number on every engine here. */
const WORD = /[A-Za-z0-9_$\u0080-￿]/;
/** SQL Server also continues an identifier with `@` and `#` (`@p1`, `#temp`). */
const MSSQL_WORD = /[A-Za-z0-9_$@#\u0080-￿]/;
/** mysql2's named placeholder: `:` then digits, or a letter and word characters. */
const MYSQL_NAMED = /^:([0-9]+|[A-Za-z][A-Za-z0-9_]*)/;

/**
 * Offset just past a quoted run that opened at `i`. `close` doubled (`''`,
 * `""`, `` ` ` ``, and `]]` on SQL Server) is an escaped quote, not the end;
 * with `backslash`, a backslash escapes the next character too.
 */
function skipQuoted(sql: string, i: number, close: string, doubled: boolean, backslash: boolean): number {
  const n = sql.length;
  let j = i + 1;
  while (j < n) {
    const ch = sql[j];
    if (backslash && ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === close) {
      if (doubled && sql[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

/** Offset just past a block comment opening at `i`. SQL Server nests them; MySQL and SQLite do not. */
function skipBlockComment(sql: string, i: number, nests: boolean): number {
  const n = sql.length;
  let depth = 1;
  let j = i + 2;
  while (j < n) {
    if (nests && sql[j] === '/' && sql[j + 1] === '*') {
      depth++;
      j += 2;
    } else if (sql[j] === '*' && sql[j + 1] === '/') {
      j += 2;
      if (--depth === 0) return j;
    } else {
      j++;
    }
  }
  return n;
}

/** True when `--` at `i` opens a comment. MySQL needs whitespace (or the end) after the dashes. */
function opensLineComment(sql: string, i: number, syntax: PlaceholderSyntax): boolean {
  if (sql[i] !== '-' || sql[i + 1] !== '-') return false;
  if (syntax !== 'mysql') return true;
  const after = sql[i + 2];
  return after === undefined || /\s/.test(after) || after.charCodeAt(0) < 32;
}

/**
 * Every placeholder in `sql` that the engine would read as code, in order.
 *
 * `$n` is reported only where the engine would see a token of its own: not
 * when the `$` continues a word (`price$1`), and not when the digits run on
 * into one (`$1abc`, which MySQL reads as an identifier).
 */
export function scanPlaceholders(sql: string, syntax: PlaceholderSyntax): PlaceholderToken[] {
  const out: PlaceholderToken[] = [];
  const n = sql.length;
  const word = syntax === 'mssql' ? MSSQL_WORD : WORD;
  const backslash = syntax === 'mysql';
  let i = 0;
  while (i < n) {
    const ch = sql[i]!;
    if (opensLineComment(sql, i, syntax) || (syntax === 'mysql' && ch === '#')) {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i, syntax === 'mssql');
      continue;
    }
    if (ch === "'") {
      i = skipQuoted(sql, i, "'", true, backslash);
      continue;
    }
    if (ch === '"') {
      // A string on MySQL, an identifier on SQLite and SQL Server: skipped either way.
      i = skipQuoted(sql, i, '"', true, backslash);
      continue;
    }
    if (ch === '`' && syntax !== 'mssql') {
      i = skipQuoted(sql, i, '`', true, false);
      continue;
    }
    if (ch === '[' && syntax !== 'mysql') {
      // SQLite ends a bracket identifier at the first `]`; SQL Server escapes it as `]]`.
      i = skipQuoted(sql, i, ']', syntax === 'mssql', false);
      continue;
    }
    if (ch === '$' && DIGIT.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < n && DIGIT.test(sql[j]!)) j++;
      if (j < n && word.test(sql[j]!)) {
        // `$1abc`: one word to the engine, not a placeholder.
        while (j < n && word.test(sql[j]!)) j++;
        i = j;
        continue;
      }
      out.push({ kind: 'positional', start: i, end: j, name: sql.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (ch === '?') {
      out.push({ kind: 'question', start: i, end: i + 1, name: '?' });
      i++;
      continue;
    }
    if (ch === ':' && syntax === 'mysql') {
      const m = MYSQL_NAMED.exec(sql.slice(i, i + 64));
      if (m) {
        out.push({ kind: 'named', start: i, end: i + m[0].length, name: m[1]! });
        i += m[0].length;
        continue;
      }
    }
    if (word.test(ch)) {
      // A whole identifier, keyword or number, so a `$` or `:` inside it is never a placeholder.
      let j = i + 1;
      while (j < n && word.test(sql[j]!)) j++;
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Rewrite every `$n` in `sql` to the engine's spelling of value `n`, checked
 * against the number of values the statement was given. Returns `sql` itself
 * when it holds no `$n`. A statement given no values is never rewritten: on
 * MySQL `$1` is a legal identifier, and with nothing to bind there is nothing
 * a placeholder could mean.
 *
 * `refuse` throws the caller's error for a `$n` that names no value, and for a
 * bare `?`: these shims bind values by name, so a `?` could never receive one.
 */
export function rewritePositionalPlaceholders(
  sql: string,
  syntax: PlaceholderSyntax,
  valueCount: number,
  spell: (index: number) => string,
  refuse: (message: string) => never,
): string {
  if (valueCount === 0 || !/\$[0-9]|\?/.test(sql)) return sql;
  const tokens = scanPlaceholders(sql, syntax).filter((t) => t.kind !== 'named');
  if (tokens.length === 0) return sql;
  let out = '';
  let last = 0;
  for (const t of tokens) {
    if (t.kind === 'question') {
      refuse('A `?` placeholder cannot be bound here: write the values as $1, $2, and so on.');
    }
    const index = Number(t.name);
    if (!Number.isSafeInteger(index) || index < 1 || index > valueCount) {
      refuse(
        `$${t.name} names no value: the statement was given ${valueCount} ` +
          `value${valueCount === 1 ? '' : 's'}, numbered $1 to $${valueCount}. Pass one value per placeholder.`,
      );
    }
    out += sql.slice(last, t.start) + spell(index);
    last = t.end;
  }
  return out + sql.slice(last);
}
