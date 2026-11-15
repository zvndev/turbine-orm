/** SQL Server migration lexing. This deliberately does not reuse the PostgreSQL lexer. */
import { MigrationError } from '../errors.js';
import type { DestructiveStatement } from './destructive.js';
import type { ParsedMigration } from './migrate.js';

interface Token {
  kind: 'word' | 'identifier' | 'string' | 'symbol' | 'comment';
  value: string;
  start: number;
  end: number;
}
const isDot = (token: Token | undefined): boolean => token?.kind === 'symbol' && token.value === '.';

function lex(sql: string): Token[] {
  if (sql.includes('\0')) throw new MigrationError('SQL Server migration source contains NUL.');
  const tokens: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      tokens.push({ kind: 'comment', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (sql.startsWith('/*', i)) {
      let depth = 1;
      i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith('*/', i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth) throw new MigrationError('Unterminated SQL Server migration block comment.');
      tokens.push({ kind: 'comment', value: sql.slice(start, i), start, end: i });
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      let value = '';
      let closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            value += close;
            i += 2;
          } else {
            i++;
            closed = true;
            break;
          }
        } else value += sql[i++]!;
      }
      if (!closed) throw new MigrationError('Unterminated SQL Server migration literal or quoted identifier.');
      tokens.push({ kind: ch === "'" ? 'string' : 'identifier', value, start, end: i });
      continue;
    }
    if (/[\p{L}\p{N}_@$#]/u.test(ch)) {
      i++;
      while (i < sql.length && /[\p{L}\p{N}_@$#]/u.test(sql[i]!)) i++;
      tokens.push({ kind: 'word', value: sql.slice(start, i), start, end: i });
      continue;
    }
    i++;
    tokens.push({ kind: 'symbol', value: ch, start, end: i });
  }
  return tokens;
}

/** Shared UP/DOWN format, with section-looking lines inside literals/comments preserved. */
export function parseMssqlMigrationContent(content: string, source?: string): ParsedMigration {
  const markers = lex(content).filter(
    (token) =>
      token.kind === 'comment' &&
      /^[ \t]*$/.test(content.slice(content.lastIndexOf('\n', token.start - 1) + 1, token.start)) &&
      /^--\s*(UP|DOWN)\s*;?\s*$/i.test(token.value),
  );
  if (
    !markers.length ||
    !/^--\s*UP\b/i.test(markers[0]!.value) ||
    markers.length > 2 ||
    (markers[1] && !/^--\s*DOWN\b/i.test(markers[1].value))
  ) {
    throw new MigrationError(
      `SQL Server migration requires one -- UP and at most one following -- DOWN marker: ${source ?? 'source'}.`,
    );
  }
  const up = markers[0]!;
  const down = markers[1];
  return {
    up: content.slice(up.end, down?.start ?? content.length).trim(),
    down: down ? content.slice(down.end).trim() : '',
    noTransaction: /--\s*turbine:no-transaction\b/i.test(content.slice(0, up.start)),
  };
}

/** GO is a client batch separator, never sent to SQL Server. GO counts/sqlcmd are unsupported. */
export function splitMssqlMigrationBatches(sql: string): string[] {
  const tokens = lex(sql);
  const batches: string[] = [];
  let from = 0;
  for (const token of tokens) {
    if (token.kind !== 'word' || token.value.toUpperCase() !== 'GO') continue;
    const start = sql.lastIndexOf('\n', token.start - 1) + 1;
    const newline = sql.indexOf('\n', token.end);
    const end = newline < 0 ? sql.length : newline;
    if (
      !/^[ \t\r]*$/.test(sql.slice(start, token.start)) ||
      !/^[ \t\r]*(?:--[^\n]*)?$/.test(sql.slice(token.end, end))
    ) {
      throw new MigrationError('SQL Server GO must occupy its own line; GO counts and inline GO are unsupported.');
    }
    const batch = sql.slice(from, start).trim();
    if (lex(batch).some((t) => t.kind !== 'comment')) batches.push(batch);
    from = end;
  }
  const last = sql.slice(from).trim();
  if (lex(last).some((t) => t.kind !== 'comment')) batches.push(last);
  return batches;
}

const FORBIDDEN = new Set([
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVE',
  'SAVEPOINT',
  'END',
  'TRY',
  'CATCH',
  'EXEC',
  'EXECUTE',
  'USE',
  'SET',
  'DBCC',
  'BACKUP',
  'RESTORE',
  'RECONFIGURE',
  'GRANT',
  'DENY',
  'REVOKE',
  'REVERT',
  'KILL',
  'SHUTDOWN',
  'BULK',
  'OPENROWSET',
  'OPENQUERY',
  'OPENDATASOURCE',
  'WAITFOR',
  'GOTO',
  'RETURN',
  'RAISERROR',
  'THROW',
  'PROCEDURE',
  'PROC',
  'TRIGGER',
  'FUNCTION',
  'DATABASE',
  'LOGIN',
  'USER',
  'ROLE',
  'ASSEMBLY',
  'EXTERNAL',
  'FULLTEXT',
  'MEMORY_OPTIMIZED',
  'FILESTREAM',
  'FILETABLE',
  'DISTRIBUTED',
  'SEQUENCE',
  'SYNONYM',
  'NEXT',
  'IDENTITY_INSERT',
  'CHECKPOINT',
  'DECLARE',
  'CURSOR',
  'IF',
  'WHILE',
  'BREAK',
  'CONTINUE',
  'PRINT',
  'RESUMABLE',
]);
const STARTS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'SELECT',
  'WITH',
]);

/** Conservative preflight for authored transactional DDL/DML, not a security sandbox. */
export function assertMssqlMigrationSql(sql: string): void {
  const batches = splitMssqlMigrationBatches(sql);
  if (!batches.length) throw new MigrationError('SQL Server migration has no executable SQL.');
  for (const batch of batches) {
    const tokens = lex(batch).filter((t) => t.kind !== 'comment');
    let updateNeedsSet = false;
    let alteringTable = false;
    const first = tokens[0];
    if (first?.kind !== 'word' || !STARTS.has(first.value.toUpperCase())) {
      throw new MigrationError('Unsupported SQL Server migration statement; use transactional DDL/DML.');
    }
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      const upper = token.value.toUpperCase();
      if ((token.kind === 'word' || token.kind === 'identifier') && upper === '_TURBINE_MIGRATIONS') {
        throw new MigrationError('SQL Server migration SQL must not reference reserved tracking metadata.');
      }
      if (
        (token.kind === 'word' || token.kind === 'identifier') &&
        isDot(tokens[i + 1]) &&
        (isDot(tokens[i + 2]) || isDot(tokens[i + 3]))
      ) {
        throw new MigrationError(
          'SQL Server migrations refuse database/server-qualified references; use schema.object.',
        );
      }
      if (token.kind === 'symbol' && token.value === ';') {
        updateNeedsSet = false;
        alteringTable = false;
      }
      if (token.kind !== 'word') continue;
      if (STARTS.has(upper) && upper !== 'ALTER' && upper !== 'DROP') alteringTable = false;
      if (upper === 'UPDATE') updateNeedsSet = true;
      if (upper === 'SET' && updateNeedsSet) {
        updateNeedsSet = false;
        continue;
      }
      if (FORBIDDEN.has(upper) || token.value.startsWith('@') || token.value.startsWith('#')) {
        throw new MigrationError(`Unsupported SQL Server migration control or operation: ${token.value}.`);
      }
      if (upper === 'GO' || token.value.includes('$')) {
        throw new MigrationError('SQL Server sqlcmd variables and inline GO are unsupported.');
      }
      if (['CREATE', 'ALTER', 'DROP'].includes(upper)) {
        const object = tokens[i + 1]?.value.toUpperCase();
        // These are clauses of the current ALTER TABLE, not new DDL heads.
        // Keep checking subsequent statement heads, including semicolon-free SQL.
        if (
          alteringTable &&
          tokens[i + 1]?.kind === 'word' &&
          ((upper === 'ALTER' && object === 'COLUMN') ||
            (upper === 'DROP' && (object === 'COLUMN' || object === 'CONSTRAINT')))
        )
          continue;
        alteringTable = upper === 'ALTER' && object === 'TABLE';
        if (!object || !['TABLE', 'INDEX', 'UNIQUE', 'CLUSTERED', 'NONCLUSTERED', 'VIEW'].includes(object)) {
          throw new MigrationError('SQL Server migrations support TABLE, INDEX and VIEW DDL only.');
        }
      }
    }
    if (tokens.some((t) => t.kind === 'symbol' && (t.value === ':' || t.value === '!'))) {
      // != remains valid T-SQL.
      if (
        tokens.some(
          (t, i) => t.kind === 'symbol' && (t.value === ':' || (t.value === '!' && tokens[i + 1]?.value !== '=')),
        )
      ) {
        throw new MigrationError('SQL Server sqlcmd commands are unsupported.');
      }
    }
  }
}

/** Candidate names for a second reserved-name check using the actual database collation. */
export function mssqlMigrationIdentifiers(sql: string): string[] {
  return [
    ...new Set(
      lex(sql)
        .filter((token) => token.kind === 'word' || token.kind === 'identifier')
        .map((token) => token.value),
    ),
  ];
}

/** Intentionally conservative: all ALTER/UPDATE/DELETE/MERGE/TRUNCATE/DROP require consent. */
export function scanMssqlMigrationDestructive(sql: string): DestructiveStatement[] {
  const destructive = lex(sql).some(
    (t) =>
      t.kind === 'word' && ['ALTER', 'DROP', 'TRUNCATE', 'UPDATE', 'DELETE', 'MERGE'].includes(t.value.toUpperCase()),
  );
  return destructive ? [{ kind: 'dynamic-unclassified', statement: sql, target: 'SQL Server migration' }] : [];
}
