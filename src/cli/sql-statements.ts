/**
 * The ONE SQL statement tokenizer the migration tooling speaks.
 *
 * ## Why this module exists
 *
 * `migrate.ts` executes migration SQL and `destructive.ts` decides whether that
 * SQL is allowed to run. Both need to answer the same two questions, "where does
 * one statement end", and "which characters are code rather than comment or
 * literal", and until v0.66 each answered them with its own hand-written lexer.
 * They disagreed, and the one that was wrong was the GUARD:
 *
 *   - `destructive.ts` ended a block comment at the first `*\/`
 *     (`sql.indexOf('*\/', i + 2)`). Postgres NESTS block comments, so a
 *     commented-out block that itself contains a comment, the ordinary shape of
 *     "I disabled this for now", reopened as CODE partway through and the
 *     scanner resynchronised in the middle of the file.
 *   - `destructive.ts` then split statements with `text.split(';')`, so a
 *     semicolon inside a quoted identifier (`DROP TABLE "we;ird"`) cut a
 *     statement in half and neither half matched a rule.
 *
 * Both bugs FAIL OPEN. The worst measured case printed a partial inventory: for
 * a file holding a nested commented-out block, a `DROP TABLE`, and a `DELETE`,
 * the guard listed only the DELETE. The operator confirms the inventory they
 * were shown, and the unlisted DROP TABLE runs under that confirmation.
 *
 * The tokenizer that replaced them arrived with the same shape of hole one
 * layer down, and it is worth naming the shape rather than the instances: EVERY
 * disagreement with the server's own lexer fails open, because the guard reads
 * a file the server will not execute and the server executes a file the guard
 * never read. Two more were found and fixed after the rewrite, both verified
 * dropping a table live on PostgreSQL 16: a `$` INSIDE an identifier read as a
 * dollar-quote opener (see {@link IDENT_CONT}), and the inner semicolons of a
 * PG14+ `BEGIN ATOMIC` routine body read as statement terminators (see
 * {@link opensAtomicBody}). The rule the module is written to now is to copy
 * Postgres's lexical rules exactly, and where a case is genuinely ambiguous, to
 * pick the reading that shows the operator MORE, never less.
 *
 * A second lexer that agrees today drifts tomorrow, so there is exactly one
 * here and both callers consume it. {@link tokenizeSql} does the whole job in a
 * single pass and hands back, per statement, BOTH the verbatim source (what
 * `migrate.ts` executes, byte for byte) and the comment/literal-stripped source
 * (what `destructive.ts` matches its rules against). Neither view can describe a
 * different set of statements than the other, because there is only one walk.
 *
 * Pure leaf: no imports at all, and in particular none from `migrate.ts` or
 * `destructive.ts` (`migrate.ts` already imports `destructive.ts`, so the shared
 * code cannot live in either of them).
 */

/**
 * A dollar-quote tag. Postgres allows digits after the first character
 * (`$do1$`), so a tag regex that stops at letters reads the body as code and
 * misses everything inside it. The leading character can never be a digit,
 * which is what keeps a `$1` bind placeholder from opening a quoted body.
 *
 * This pattern answers "is this a well-formed tag", NOT "does a body open
 * here". The second question is decided before the pattern is ever run, by
 * whether the walk is standing at the start of a token at all: see
 * {@link IDENT_CONT}.
 */
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/;

/**
 * Postgres identifier characters, copied from its own lexer rather than from
 * intuition (`scan.l`: `ident_start [A-Za-z\200-\377_]`, `ident_cont
 * [A-Za-z\200-\377_0-9\$]`). Every non-ASCII character is an identifier
 * character, and so is `$` in every position but the first.
 *
 * That `$` is the whole reason the walk consumes an identifier as ONE token.
 * Postgres lexes by LONGEST MATCH, so in `SELECT x$y$ FROM t` the identifier
 * rule claims all four characters of `x$y$` and the dollar-quoting rule never
 * gets a look at that `$`. Reading `$y$` as an opener instead starts a body
 * whose tag never appears again, which swallows the REST OF THE FILE:
 *
 *   input:  SELECT x$y$ FROM t;
 *           DROP TABLE users;
 *   guard:  destructive(0): (none)
 *   split:  statements(1)   <- the whole file
 *
 * Measured on PostgreSQL 16.14, that file returns a column named `x$y$` and
 * then drops the table, under an inventory that listed nothing. Collapsing a
 * file to one statement also breaks the one-statement-per-round-trip contract
 * `-- turbine:no-transaction` migrations depend on, which is this module's
 * other production-destroying failure mode.
 *
 * Consuming the identifier run first IS Postgres's rule rather than an
 * approximation of it, which is what keeps the converse working: a digit
 * cannot START an identifier, so the `$$` in `SELECT 1$$x$$` still opens a
 * body (PostgreSQL reports its syntax error at the string `$$x$$`, not at the
 * number). Verified against the same server: `SELECT a$$b`, `SELECT$$x$$`, and
 * `AS$$SELECT 1$$` are each ONE identifier token, and `naïve$col$` is a legal
 * column name.
 */
const IDENT_START = /[A-Za-z_\u0080-\uFFFF]/;
const IDENT_CONT = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/**
 * A statement head that can carry a PG14+ SQL-standard routine body. Requiring
 * it is what stops an ordinary transaction-control `BEGIN` from ever putting
 * the walk into body mode, where semicolons stop terminating statements.
 */
const SQL_BODY_HEAD = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i;

/**
 * `BEGIN` as the immediately preceding token. The leading character class
 * spells out what `\b` gets wrong here: `$` is an identifier character in
 * Postgres, so `\bBEGIN` would also match the tail of `x$BEGIN`.
 */
const BEGIN_BEFORE_ATOMIC = /(?:^|[^A-Za-z0-9_$\u0080-\uFFFF])BEGIN\s+$/i;

/**
 * True when the identifier just scanned opens a PG14+ SQL-standard routine
 * body: `CREATE FUNCTION ... BEGIN ATOMIC <stmt>; <stmt>; END`.
 *
 * Those inner semicolons are not statement terminators, and splitting there
 * cost the guard the entire body. `CREATE FUNCTION purge() RETURNS void
 * LANGUAGE SQL BEGIN ATOMIC DELETE FROM users; END;` became three fragments:
 * the first headed `CREATE FUNCTION`, which matches no destructive rule, and
 * the rest headless. A function whose only job is to empty a table therefore
 * reported a clean inventory (verified live: the function creates, runs, and
 * leaves zero rows). It also handed the no-transaction runner a fragment that
 * cannot execute on its own.
 *
 * The two keywords must be ADJACENT (whitespace and comments aside) because
 * both are unreserved. `CREATE FUNCTION f() RETURNS TABLE (begin int, atomic
 * int)` is a legal header, verified on PostgreSQL 16, and reading that as a
 * body would swallow every following statement up to the next `END`: the
 * fail-OPEN direction, which is the one this guard cannot afford.
 */
function opensAtomicBody(word: string, before: string): boolean {
  return /^ATOMIC$/i.test(word) && BEGIN_BEFORE_ATOMIC.test(before) && SQL_BODY_HEAD.test(before);
}

/** One top-level statement, in both of the forms its two consumers need. */
export interface SqlStatement {
  /**
   * The statement exactly as written, trimmed, with its terminating semicolon
   * removed. This is what gets EXECUTED, so it is sliced straight out of the
   * source rather than reassembled: a tokenizer that rebuilds the text can
   * silently alter it, and a mangled statement run against production is the
   * failure this module exists to prevent.
   */
  raw: string;
  /**
   * The same statement with comments removed, string literals emptied to `''`,
   * and dollar-quoted bodies emptied to `''`. Quoted identifiers are kept
   * VERBATIM, because the destructive rules match on object names.
   */
  stripped: string;
  /**
   * The same statement with comments removed and EVERYTHING ELSE verbatim:
   * string literals, quoted identifiers, and dollar-quoted bodies all keep
   * their contents.
   *
   * This is the view dynamic SQL has to be read through. A `DO` block keeps its
   * payload in a LITERAL (`EXECUTE 'DROP TABLE users'`), which is precisely
   * what `stripped` empties, so the destructive scanner cannot use `stripped`
   * for a procedural body and cannot use `raw` either (a comment in the body
   * would hide the statement after it). Removing the comments here means the
   * scanner never has to strip them itself, which is what it used to do, with a
   * pair of regexes that were the exact hand-written lexer this module exists
   * to delete.
   */
  code: string;
  /**
   * Executable SQL carried INSIDE this statement, in source order, with its
   * delimiters excluded: every dollar-quoted body, plus a PG14+ `BEGIN ATOMIC`
   * routine body. A `DO` block or a routine source is code rather than data, so
   * the destructive scanner re-scans these.
   */
  blocks: string[];
  /** True when the statement holds nothing but comments and whitespace. */
  commentOnly: boolean;
}

/**
 * True when the quote at `quoteAt` opens a Postgres escape string (`E'...'`),
 * whose body treats a backslash as an escape character.
 *
 * The `E` must be a standalone token, so an identifier that merely ends in `e`
 * does not turn the following literal into an E-string. Ordinary literals are
 * left alone on purpose: with the modern `standard_conforming_strings = on`
 * default, `'a\'` IS a complete string.
 *
 * Getting this wrong is not cosmetic. `E'p\'q'` is ONE literal; a tokenizer
 * that ends it at the backslash-quote reads the rest of the file as string
 * content, which merges following statements together (fatal for a
 * `-- turbine:no-transaction` migration, which must issue one statement per
 * round trip) and hides every later statement from the destructive guard.
 */
function isEscapeStringPrefix(sql: string, quoteAt: number): boolean {
  const prev = sql[quoteAt - 1];
  if (prev !== 'E' && prev !== 'e') return false;
  const before = sql[quoteAt - 2];
  return before === undefined || !/[A-Za-z0-9_$"]/.test(before);
}

/**
 * Split a SQL script into its top-level statements.
 *
 * A semicolon inside a single-quoted string (including a backslash-escaping
 * `E'...'` string), a double-quoted identifier, a dollar-quoted body, a PG14+
 * `BEGIN ATOMIC` routine body, a line comment, or a block comment (which
 * Postgres allows to NEST) does not terminate a statement. Nor does a `$` that
 * merely continues an identifier open a dollar-quoted body, which is the same
 * question asked from the other side (see IDENT_CONT and opensAtomicBody for
 * what each of those two cost when they were wrong).
 *
 * Every returned statement is trimmed and carries no
 * trailing semicolon; nothing is dropped, so a comment-only fragment comes back
 * flagged rather than missing (the executor skips those, the scanner ignores
 * them, and neither has to re-derive the fact).
 */
export function tokenizeSql(sql: string): SqlStatement[] {
  const out: SqlStatement[] = [];
  const n = sql.length;

  let stripped = '';
  let code = '';
  let blocks: string[] = [];
  let start = 0;
  let i = 0;
  // Inside a `BEGIN ATOMIC` routine body: 0 means no. The count tracks the
  // `CASE ... END` expressions nested in it, which are the only other `END` a
  // SQL-standard body can hold (`BEGIN ATOMIC SELECT CASE WHEN ... END; END`
  // is legal, verified on PostgreSQL 16), so a body cannot end at the first
  // `END` it happens to contain.
  let atomicDepth = 0;
  let atomicStart = 0;

  const flush = (rawEnd: number): void => {
    const raw = sql.slice(start, rawEnd).trim();
    const strippedTrimmed = stripped.trim();
    if (raw.length > 0) {
      out.push({
        raw,
        stripped: strippedTrimmed,
        code: code.trim(),
        blocks,
        commentOnly: strippedTrimmed.length === 0,
      });
    }
    stripped = '';
    code = '';
    blocks = [];
  };

  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];

    // Line comment: runs to the end of the line. The newline itself is left for
    // the generic branch below, so line structure survives into `stripped`.
    if (ch === '-' && next === '-') {
      let j = i;
      while (j < n && sql[j] !== '\n') j++;
      i = j;
      code += ' ';
      continue;
    }

    // Block comment. Postgres nests these, so depth is counted rather than
    // scanning for the first `*\/`: `/* a /* b */ c */` is ONE comment, and a
    // scanner that stops at the inner terminator treats ` c */ ...` as code.
    if (ch === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth++;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth--;
          j += 2;
        } else {
          j++;
        }
      }
      i = j;
      stripped += ' ';
      code += ' ';
      continue;
    }

    // Single-quoted literal. `''` always escapes a quote; inside an E-string a
    // backslash escapes the next character too.
    if (ch === "'") {
      const escapes = isEscapeStringPrefix(sql, i);
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") break;
        j++;
      }
      const end = Math.min(j + 1, n);
      stripped += "''";
      code += sql.slice(i, end);
      i = end;
      continue;
    }

    // Quoted identifier (`""` escapes a quote). Kept VERBATIM in `stripped`,
    // because the destructive rules match on object names, but consumed as ONE
    // token: an apostrophe inside a quoted name (`"customer's_orders"`) would
    // otherwise open a string literal and hide every following statement, and a
    // semicolon inside one (`"we;ird"`) would otherwise split a statement in
    // half so that neither half matched anything.
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') {
          j += 2;
          continue;
        }
        if (sql[j] === '"') break;
        j++;
      }
      const end = Math.min(j + 1, n);
      stripped += sql.slice(i, end);
      code += sql.slice(i, end);
      i = end;
      continue;
    }

    // Identifier or keyword run, consumed as ONE token because Postgres does.
    // This branch has to sit ABOVE the dollar-quote branch: a `$` that is part
    // of an identifier is not an opener, and reading it as one swallows the
    // rest of the file (see IDENT_CONT). It also gives the `BEGIN ATOMIC`
    // tracking below a token boundary to work from, so `BEGINATOMIC` or a
    // column named `atomic$` can never be mistaken for the keyword pair.
    if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < n && IDENT_CONT.test(sql[j]!)) j++;
      const word = sql.slice(i, j);
      if (atomicDepth === 0) {
        if (opensAtomicBody(word, stripped)) {
          atomicDepth = 1;
          atomicStart = j;
        }
      } else if (/^CASE$/i.test(word)) {
        atomicDepth++;
      } else if (/^END$/i.test(word) && --atomicDepth === 0) {
        blocks.push(sql.slice(atomicStart, i));
      }
      stripped += word;
      code += word;
      i = j;
      continue;
    }

    // Dollar-quoted body ($tag$ ... $tag$).
    if (ch === '$') {
      const tag = DOLLAR_TAG.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        const next = close === -1 ? n : close + tag.length;
        blocks.push(sql.slice(i + tag.length, close === -1 ? n : close));
        stripped += "''";
        code += sql.slice(i, next);
        i = next;
        continue;
      }
    }

    // Top-level statement terminator. The semicolons INSIDE a `BEGIN ATOMIC`
    // routine body are not top level, so while one is open this falls through
    // to the generic branch and the body stays one statement (see
    // opensAtomicBody).
    if (ch === ';' && atomicDepth === 0) {
      flush(i);
      i++;
      start = i;
      continue;
    }

    stripped += ch;
    code += ch;
    i++;
  }

  // A `BEGIN ATOMIC` body still open at EOF (a file that ends mid-routine, or
  // an `END` this walk failed to find) is handed over anyway rather than
  // dropped. Dropping it is the fail-OPEN direction: the body is executable
  // SQL, and it would reach no scanner at all, whereas handing over a body
  // that the server may reject as unterminated costs at most a confirmation
  // prompt for a file that was never going to run.
  if (atomicDepth > 0) blocks.push(sql.slice(atomicStart));
  flush(n);
  return out;
}

/**
 * Split a SQL script into individual executable statements on top-level
 * semicolons, dropping comment-only fragments.
 *
 * This is the list `-- turbine:no-transaction` migrations issue one statement
 * per `client.query()` call, which is the one production-destroying failure
 * mode of the migration runner (a partial statement executed against
 * production), so the behavior is pinned by exhaustive unit tests.
 */
export function splitSqlStatements(sql: string): string[] {
  return tokenizeSql(sql)
    .filter((s) => !s.commentOnly)
    .map((s) => s.raw);
}

/**
 * The whole script with comments removed, string and dollar-quoted literals
 * emptied, and quoted identifiers preserved: the view the destructive rules are
 * written against, joined back into one string.
 *
 * Statement-level consumers should prefer {@link tokenizeSql}, whose per-
 * statement `stripped` is the same text without having to re-split it.
 */
export function stripCommentsAndStrings(sql: string): string {
  return tokenizeSql(sql)
    .map((s) => s.stripped)
    .join('; ');
}
