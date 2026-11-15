import { ValidationError } from '../errors.js';
import { rewritePositionalPlaceholders } from '../sql-placeholders.js';
import { leadingWords } from '../transaction-control.js';
import { type LibsqlStatement, parameter } from './values.js';

/** SQLite named bindings, ignoring comments, values and quoted identifiers. */
function names(sql: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      i++;
      while (i < sql.length) {
        if (sql[i++] !== close) continue;
        if (ch !== '[' && sql[i] === close) {
          i++;
          continue;
        }
        break;
      }
    } else if (ch === ':' || ch === '@' || ch === '$' || ch === '?') {
      let end = i + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) end++;
      found.push(sql.slice(i, end));
      i = end;
    } else {
      // SQLite accepts a BOM as SQL whitespace, but the shared PostgreSQL
      // scanner treats it as an identifier. Refuse it outside quoted content
      // rather than allowing transaction control to bypass both guards.
      if (ch === '\uFEFF') throw new ValidationError('libSQL SQL cannot contain an unquoted byte-order mark.');
      // $ is part of an unquoted identifier when it follows a word.
      if (/[A-Za-z0-9_\u0080-\uffff]/.test(ch)) {
        while (i < sql.length && sql[i] !== '\uFEFF' && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[i]!)) i++;
      } else i++;
    }
  }
  return found;
}

export function statement(text: string, values: unknown[] = []): LibsqlStatement {
  // Native execute silently ignores trailing statements. Refuse before prepare,
  // including PRAGMAs, which can have effects during preparation.
  if (text.includes('\u0000') || leadingWords(text, 'sqlite').length !== 1) {
    throw new ValidationError('libSQL query accepts exactly one statement.');
  }
  const sql = rewritePositionalPlaceholders(
    text,
    'sqlite',
    values.length,
    (index) => `:p${index}`,
    (message) => {
      throw new ValidationError(message);
    },
  );
  const args: NonNullable<LibsqlStatement['args']> = {};
  for (const token of names(sql)) {
    const match = /^:p([1-9]\d*)$/.exec(token);
    const index = match ? Number(match[1]) - 1 : -1;
    if (index < 0 || index >= values.length || !Number.isSafeInteger(index)) {
      throw new ValidationError(
        'libSQL bindings require $1, $2 or generated :p1, :p2 placeholders with matching values.',
      );
    }
    args[`p${index + 1}`] = parameter(values[index]);
  }
  return { sql, args };
}
