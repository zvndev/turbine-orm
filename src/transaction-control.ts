/**
 * turbine-orm, finding transaction-control statements in SQL the caller wrote
 *
 * A `COMMIT`, `ROLLBACK`, `BEGIN`, `SAVEPOINT` (and the rest of the family) sent
 * through a transaction's raw paths ends or reshapes the transaction behind the
 * state that tracks it: later statements autocommit, a savepoint sits on a stack
 * Turbine did not push, and the final COMMIT or ROLLBACK reports on a transaction
 * that is no longer there. {@link TransactionState.runRaw} refuses them, and this
 * leaf is how it recognises one.
 *
 * It reads statement STARTS only: the leading words of every statement in the
 * text, found with the lexical rules of the engine that will run it, so a
 * `COMMIT` inside a string literal, a quoted identifier, a dollar-quoted body or a
 * comment is not mistaken for a statement. It is NOT a second statement
 * splitter: `cli/sql-statements.ts` owns that job for migrations, and
 * `src/test/fx-tx-control.test.ts` holds this file to it (same statement
 * boundaries, same first word, over an adversarial corpus). It lives apart from
 * that file because the CLI tokenizer is a CLI module (the library imports one
 * file from `cli/`, `destructive.ts`, and nothing else), and importing it here
 * would put it in every engine entry and the edge entry, whose size is a
 * published claim.
 *
 * Where a reading is ambiguous the scan treats more text as quoted, never less:
 * a statement it fails to see goes through exactly as it did before this guard
 * existed, while one it invents inside a literal would refuse a valid query.
 *
 * Zero imports.
 */

/** Which engine's lexical rules to read the text with. */
export type ControlSyntax = 'postgresql' | 'mysql' | 'sqlite' | 'mssql';

export type ControlKind =
  | 'begin'
  | 'commit'
  | 'rollback'
  | 'rollback-to'
  | 'savepoint'
  | 'release'
  | 'set-transaction'
  | 'prepare';

/** One transaction-control statement found in a piece of SQL. */
export interface ControlStatement {
  readonly kind: ControlKind;
  /** The statement's leading keyword(s) in upper case, for a message (`COMMIT`, `START TRANSACTION`). */
  readonly label: string;
}

/** Words that may follow `BEGIN` when it opens a transaction (and not a block, `BEGIN TRY`, `BEGIN ATOMIC`). */
const BEGIN_NEXT = new Set([
  'work',
  'transaction',
  'tran',
  'isolation',
  'read',
  'not',
  'deferrable',
  'deferred',
  'immediate',
  'exclusive',
  'distributed',
]);

/** Leading words kept per statement: enough for `ROLLBACK WORK TO SAVEPOINT name`. */
const LEADING_WORDS = 4;

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

interface Rules {
  /** Block comments nest (PostgreSQL, SQL Server). */
  nestedBlockComments: boolean;
  /** `#` starts a line comment (MySQL). */
  hashComment: boolean;
  /** `--` needs whitespace after it to start a comment (MySQL). */
  dashNeedsSpace: boolean;
  /** Backslash escapes inside `'...'` (MySQL always; PostgreSQL only after `E`). */
  backslashAlways: boolean;
  /** `$tag$ ... $tag$` quoting (PostgreSQL). */
  dollarQuotes: boolean;
  /** `` `ident` `` quoting (MySQL, SQLite). */
  backtick: boolean;
  /** `[ident]` quoting (SQLite, SQL Server). */
  bracket: boolean;
}

const RULES: Readonly<Record<ControlSyntax, Rules>> = {
  postgresql: {
    nestedBlockComments: true,
    hashComment: false,
    dashNeedsSpace: false,
    backslashAlways: false,
    dollarQuotes: true,
    backtick: false,
    bracket: false,
  },
  mysql: {
    nestedBlockComments: false,
    hashComment: true,
    dashNeedsSpace: true,
    backslashAlways: true,
    dollarQuotes: false,
    backtick: true,
    bracket: false,
  },
  sqlite: {
    nestedBlockComments: false,
    hashComment: false,
    dashNeedsSpace: false,
    backslashAlways: false,
    dollarQuotes: false,
    backtick: true,
    bracket: true,
  },
  mssql: {
    nestedBlockComments: true,
    hashComment: false,
    dashNeedsSpace: false,
    backslashAlways: false,
    dollarQuotes: false,
    backtick: false,
    bracket: true,
  },
};

/** Offset just past the quoted run that opens at `i`, doubled closing quotes honoured. */
function skipQuoted(sql: string, i: number, close: string, backslash: boolean): number {
  const n = sql.length;
  let j = i + 1;
  while (j < n) {
    const ch = sql[j];
    if (backslash && ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === close) {
      if (sql[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

/** Offset just past the block comment that opens at `i`. */
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

/** Offset just past the end of the line that `i` is on. */
function skipLine(sql: string, i: number): number {
  const end = sql.indexOf('\n', i);
  return end === -1 ? sql.length : end + 1;
}

/**
 * Every transaction-control statement in `sql`, in order. Empty when there is
 * none, which is the answer for almost every statement and costs one pass.
 */
export function findTransactionControl(sql: string, syntax: ControlSyntax): ControlStatement[] {
  const found: ControlStatement[] = [];
  for (const words of leadingWords(sql, syntax)) {
    const statement = classify(words, syntax);
    if (statement !== undefined) found.push(statement);
  }
  return found;
}

/**
 * The leading words of every statement in `sql`, lower-cased (`?` stands for a
 * token that is not a word: a literal, a quoted identifier, a symbol). This is
 * the whole of what the scan decides, exported so the test that holds it to
 * `cli/sql-statements.ts` can compare statement boundaries directly.
 */
export function leadingWords(sql: string, syntax: ControlSyntax): string[][] {
  const rules = RULES[syntax];
  const statements: string[][] = [];
  const n = sql.length;
  let words: string[] = [];
  /** Where the previous word ended, and the word, so `E'...'` is read as one token. */
  let lastWordEnd = -1;
  let lastWord = '';
  /** Inside a `BEGIN ATOMIC ... END` routine body, whose semicolons do not end the statement. */
  let atomic = false;
  let caseDepth = 0;

  const finish = (): void => {
    if (words.length > 0) statements.push(words);
    words = [];
  };
  const note = (word: string): void => {
    if (words.length < LEADING_WORDS) words.push(word);
  };

  let i = 0;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === ';') {
      if (!atomic) finish();
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i++;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const after = sql[i + 2];
      if (!rules.dashNeedsSpace || after === undefined || /\s/.test(after) || after.charCodeAt(0) < 32) {
        i = skipLine(sql, i);
        continue;
      }
    }
    if (ch === '#' && rules.hashComment) {
      i = skipLine(sql, i);
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i, rules.nestedBlockComments);
      continue;
    }
    if (ch === "'") {
      // PostgreSQL's `E'...'` honours backslash escapes; every other `'...'` there does not.
      const escaped =
        rules.backslashAlways || (syntax === 'postgresql' && lastWordEnd === i && /^[eE]$/.test(lastWord));
      i = skipQuoted(sql, i, "'", escaped);
      note('?');
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(sql, i, '"', rules.backslashAlways);
      note('?');
      continue;
    }
    if (ch === '`' && rules.backtick) {
      i = skipQuoted(sql, i, '`', false);
      note('?');
      continue;
    }
    if (ch === '[' && rules.bracket) {
      i = skipQuoted(sql, i, ']', false);
      note('?');
      continue;
    }
    if (ch === '$' && rules.dollarQuotes) {
      const tag = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/.exec(sql.slice(i, i + 130));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        i = close === -1 ? n : close + tag[0].length;
        note('?');
        continue;
      }
    }
    if (WORD_START.test(ch)) {
      // A whole identifier, so a `$` inside it never opens a dollar quote.
      let j = i + 1;
      while (j < n && WORD_PART.test(sql[j]!)) j++;
      const word = sql.slice(i, j).toLowerCase();
      if (syntax === 'postgresql') {
        // PostgreSQL 14's SQL-standard function body: its inner semicolons are not statement ends.
        // `CASE ... END` inside it is the only other END a body can hold.
        if (!atomic && word === 'atomic' && lastWord === 'begin' && lastWordEnd <= i && sqlGap(sql, lastWordEnd, i)) {
          atomic = true;
          caseDepth = 0;
        } else if (atomic) {
          if (word === 'case') caseDepth++;
          else if (word === 'end') {
            if (caseDepth > 0) caseDepth--;
            else atomic = false;
          }
        }
      }
      note(word);
      lastWordEnd = j;
      lastWord = word;
      i = j;
      continue;
    }
    note('?');
    lastWord = '';
    i++;
  }
  finish();
  return statements;
}

/** Whether only whitespace lies between `from` and `to` (comments count as something). */
function sqlGap(sql: string, from: number, to: number): boolean {
  return /^\s*$/.test(sql.slice(from, to));
}

/** The control statement whose leading `words` these are, if they are one. */
function classify(words: readonly string[], syntax: ControlSyntax): ControlStatement | undefined {
  const [w0, w1, w2] = words;
  switch (w0) {
    case 'begin':
      return w1 === undefined || BEGIN_NEXT.has(w1) ? { kind: 'begin', label: 'BEGIN' } : undefined;
    case 'start':
      return w1 === 'transaction' ? { kind: 'begin', label: 'START TRANSACTION' } : undefined;
    case 'commit':
      return { kind: 'commit', label: 'COMMIT' };
    case 'end':
      return (syntax === 'postgresql' || syntax === 'sqlite') &&
        (w1 === undefined || w1 === 'work' || w1 === 'transaction' || w1 === 'and')
        ? { kind: 'commit', label: 'END' }
        : undefined;
    case 'rollback':
      return w1 === 'to' || ((w1 === 'work' || w1 === 'transaction' || w1 === 'tran') && w2 === 'to')
        ? { kind: 'rollback-to', label: 'ROLLBACK TO SAVEPOINT' }
        : { kind: 'rollback', label: 'ROLLBACK' };
    case 'abort':
      return syntax === 'postgresql' ? { kind: 'rollback', label: 'ABORT' } : undefined;
    case 'savepoint':
      return { kind: 'savepoint', label: 'SAVEPOINT' };
    case 'save':
      return syntax === 'mssql' && (w1 === 'tran' || w1 === 'transaction')
        ? { kind: 'savepoint', label: 'SAVE TRANSACTION' }
        : undefined;
    case 'release':
      return { kind: 'release', label: 'RELEASE SAVEPOINT' };
    case 'set':
      return w1 === 'transaction' ? { kind: 'set-transaction', label: 'SET TRANSACTION' } : undefined;
    case 'prepare':
      return w1 === 'transaction' ? { kind: 'prepare', label: 'PREPARE TRANSACTION' } : undefined;
    default:
      return undefined;
  }
}

/** Whether `text` could hold a transaction-control statement at all (a cheap test before the scan). */
export function mayHoldTransactionControl(text: string): boolean {
  return /\b(?:begin|start|commit|end|rollback|abort|savepoint|save|release|set|prepare)\b/i.test(text);
}
