import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { findTransactionControl } from '../transaction-control.js';

export function refuse(operation: string): never {
  throw new UnsupportedFeatureError(
    operation,
    'neon-http',
    'Neon HTTP has no pinned session. Use a session-capable transport, or an array of single-statement queries with batch().',
  );
}

/** Conservative raw-SQL boundary, not a proof about functions or triggers. */
export function assertStatelessSql(sql: string): void {
  if (typeof sql !== 'string' || sql.trim() === '') throw new ValidationError('Neon HTTP requires nonempty SQL.');
  if (findTransactionControl(sql, 'postgresql').length > 0) refuse('Transaction control SQL');
  const tokens: string[] = [];
  let ended = false;
  for (let i = 0; i < sql.length; ) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new ValidationError('Neon HTTP SQL has an unterminated comment.');
      continue;
    }
    if (ended) refuse('Multiple SQL statements');
    if (c === ';') {
      ended = true;
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      const escaped = quote === "'" && /[eE]/.test(sql[i - 1] ?? '') && !/[\w$]/.test(sql[i - 2] ?? '');
      let value = '';
      let closed = false;
      i++;
      while (i < sql.length) {
        if (escaped && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            value += quote;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += sql[i++]!;
      }
      if (!closed) throw new ValidationError('Neon HTTP SQL has an unterminated quote.');
      tokens.push(quote === '"' ? `@identifier:${value.toLowerCase()}` : '<literal>');
      continue;
    }
    if (c === '$') {
      const delimiter = /^(?:\$[a-zA-Z_][\w]*\$|\$\$)/.exec(sql.slice(i))?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        if (end === -1) throw new ValidationError('Neon HTTP SQL has an unterminated dollar quote.');
        i = end + delimiter.length;
        tokens.push('<literal>');
        continue;
      }
    }
    const word = /^[a-zA-Z_][\w$]*/.exec(sql.slice(i))?.[0];
    if (word) {
      tokens.push(word.toLowerCase());
      i += word.length;
    } else {
      tokens.push(c);
      i++;
    }
  }
  if (!['select', 'insert', 'update', 'delete', 'with', 'explain', 'values'].includes(tokens[0] ?? '')) {
    refuse('Session, DDL or administrative SQL');
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const word = token.startsWith('@identifier:') ? token.slice(12) : token;
    if (tokens[i + 1] === '(' && (word.startsWith('pg_advisory_') || word === 'set_config' || word === 'pg_notify')) {
      refuse('Session functions or notifications');
    }
    if (token === 'for' && ['update', 'share', 'no', 'key'].includes(tokens[i + 1] ?? '')) refuse('Row locks');
  }
}
