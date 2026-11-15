/** MySQL lexical rules for native migration files; shared PG parsing stays untouched. */
import { MigrationError } from '../errors.js';
import type { DestructiveStatement } from './destructive.js';
import { scanMigrationDestructive } from './migrate.js';

export interface MysqlMigrationSqlMode {
  noBackslashEscapes: boolean;
  ansiQuotes: boolean;
}

export interface MysqlMigrationStatement {
  /** Original SQL, including literal spelling. */
  sql: string;
  /** Comments removed, literals masked, identifiers in scanner-compatible quotes. */
  normalized: string;
}

/**
 * Split MySQL SQL without applying PostgreSQL dollar-quote or comment rules.
 * Mode comes from the dedicated connection; this function never changes it.
 */
export function parseMysqlMigrationStatements(sql: string, mode: MysqlMigrationSqlMode): MysqlMigrationStatement[] {
  const statements: MysqlMigrationStatement[] = [];
  let start = 0;
  let normalized = '';
  let tokens: Array<{ value: string; identifier: boolean }> = [];
  const finish = (end: number) => {
    if (tokens.length) {
      assertStatement(tokens);
      statements.push({ sql: sql.slice(start, end).trim(), normalized: normalized.trim() });
    }
    normalized = '';
    tokens = [];
    start = end + 1;
  };
  for (let i = 0; i < sql.length; ) {
    const ch = sql[i]!;
    const afterDash = sql.charCodeAt(i + 2);
    if (ch === '#' || (sql.startsWith('--', i) && (i + 2 === sql.length || afterDash <= 32 || afterDash === 127))) {
      const end = sql.indexOf('\n', i);
      i = end < 0 ? sql.length : end;
      normalized += ' ';
    } else if (sql.startsWith('/*', i)) {
      if (/^\/\*(?:!|M!|\+)/i.test(sql.slice(i))) {
        throw new MigrationError('MySQL migration executable comments and optimizer hints are unsupported.');
      }
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new MigrationError('Unterminated MySQL migration comment.');
      i = end + 2;
      normalized += ' ';
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const identifier = ch === '`' || (ch === '"' && mode.ansiQuotes);
      let value = '';
      let closed = false;
      for (i++; i < sql.length; i++) {
        if (!identifier && sql[i] === '\\' && !mode.noBackslashEscapes) {
          if (++i >= sql.length) break;
          value += sql[i];
        } else if (sql[i] === ch) {
          if (sql[i + 1] === ch) {
            value += ch;
            i++;
          } else {
            i++;
            closed = true;
            break;
          }
        } else {
          value += sql[i];
        }
      }
      if (!closed) throw new MigrationError('Unterminated MySQL migration quoted value.');
      tokens.push({ value: identifier ? value : '', identifier });
      normalized += identifier ? `"${value.replace(/"/g, '""')}"` : "'literal'";
    } else if (ch === ';') {
      finish(i++);
    } else if (/[a-z_$\u0080-\uffff]/i.test(ch)) {
      const word = /^[\w$\u0080-\uffff]+/.exec(sql.slice(i))![0];
      tokens.push({ value: word, identifier: false });
      // A native identifier containing $ is not a PostgreSQL dollar quote.
      normalized += /[$\u0080-\uffff]/.test(word) ? `"${word}"` : word;
      i += word.length;
    } else if (/\d/.test(ch)) {
      const number = /^(?:0[xb][\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/i.exec(sql.slice(i))![0];
      tokens.push({ value: number, identifier: false });
      normalized += number;
      i += number.length;
    } else {
      if (!/\s/.test(ch)) tokens.push({ value: ch, identifier: false });
      // Native -- without whitespace means subtraction/unary minus. Keep it
      // from turning into a PG-style comment in the shared destructive scan.
      normalized += ch === '-' ? ' - ' : ch;
      i++;
    }
  }
  finish(sql.length);
  return statements;
}

function assertStatement(tokens: Array<{ value: string; identifier: boolean }>): void {
  const words = tokens.filter((token) => !token.identifier).map((token) => token.value.toUpperCase());
  const head = words.slice(0, 4).join(' ');
  if (
    !/^(?:CREATE (?:TABLE|(?:UNIQUE )?INDEX) |ALTER TABLE |DROP (?:TABLE|INDEX) |TRUNCATE (?:TABLE )?|INSERT (?:INTO|IGNORE INTO) |UPDATE |DELETE FROM )/.test(
      `${head} `,
    )
  ) {
    throw new MigrationError(
      'Unsupported MySQL migration statement. Use native table/index DDL or INSERT/UPDATE/DELETE; transaction/session control, routines, triggers and DELIMITER are refused.',
    );
  }
  for (const [position, token] of tokens.entries()) {
    if (/^_turbine_migrations$|^_turbine_migration_state$/i.test(token.value)) {
      throw new MigrationError('MySQL migration SQL must not reference runner tracking metadata.');
    }
    if (
      tokens[position + 1]?.value === '(' &&
      /^(?:GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|SERVICE_GET_READ_LOCKS|SERVICE_GET_WRITE_LOCKS|SERVICE_RELEASE_LOCKS)$/i.test(
        token.value,
      )
    ) {
      throw new MigrationError(`Unsupported MySQL migration control or object: ${token.value}.`);
    }
    if (
      !token.identifier &&
      /^(?:GET_LOCK|RELEASE_LOCK|RELEASE_ALL_LOCKS|SERVICE_GET_READ_LOCKS|SERVICE_GET_WRITE_LOCKS|SERVICE_RELEASE_LOCKS|TEMPORARY|OUTFILE|DUMPFILE|PROCEDURE|FUNCTION|TRIGGER|EVENT|DELIMITER|PREPARE|EXECUTE|TABLESPACE|DATA_DIRECTORY|INDEX_DIRECTORY)$/i.test(
        token.value,
      )
    ) {
      throw new MigrationError(`Unsupported MySQL migration control or object: ${token.value}.`);
    }
    // This bounded runner accepts unqualified names only. Refusing every dot
    // also closes qualified references in subqueries and multi-object DDL.
    if (token.value === '.' || token.value === '@' || token.value === '\\' || token.value === '\0') {
      throw new MigrationError(
        'MySQL migrations require unqualified names and no session variables or client commands.',
      );
    }
  }
  for (let engine = 0; engine < tokens.length; engine++) {
    if (tokens[engine]!.identifier || tokens[engine]!.value.toUpperCase() !== 'ENGINE') continue;
    const value = tokens[engine + (tokens[engine + 1]?.value === '=' ? 2 : 1)]?.value;
    if (value?.toUpperCase() !== 'INNODB') {
      throw new MigrationError('MySQL migrations support only InnoDB tables.');
    }
  }
}

/** Apply the shared destructive policy with MySQL-specific rewrite detection. */
export function scanMysqlMigrationDestructive(statements: readonly MysqlMigrationStatement[]): DestructiveStatement[] {
  return statements.flatMap((statement) => {
    const hits = scanMigrationDestructive(statement.normalized).map((hit) => ({ ...hit, statement: statement.sql }));
    if (!hits.length && /^(?:UPDATE|DELETE|TRUNCATE|DROP\s+TABLE)\b/i.test(statement.normalized)) {
      // MySQL truthiness/arithmetic differs from PG. Conservatively request
      // consent for all native UPDATEs, including numeric WHERE expressions.
      const kind = /^UPDATE\b/i.test(statement.normalized)
        ? 'update-without-where'
        : /^DELETE\b/i.test(statement.normalized)
          ? 'delete'
          : /^TRUNCATE\b/i.test(statement.normalized)
            ? 'truncate'
            : 'drop-table';
      hits.push({ statement: statement.sql, kind, target: 'MySQL data mutation' });
    }
    if (
      !hits.length &&
      // Native ALTER includes partition truncation, numeric-leading names,
      // renames and other forms beyond the shared PostgreSQL scanner. Require
      // consent for every ALTER rather than guessing which native rewrite is safe.
      (/^ALTER\s+TABLE\b/i.test(statement.normalized) ||
        /^INSERT\b[\s\S]*\bON\s+DUPLICATE\s+KEY\s+UPDATE\b/i.test(statement.normalized))
    ) {
      const duplicateKeyUpdate = /^INSERT\b/i.test(statement.normalized);
      hits.push({
        statement: statement.sql,
        kind: duplicateKeyUpdate ? 'overwrite-on-conflict' : 'alter-column-type',
        target: duplicateKeyUpdate ? 'MySQL duplicate-key update' : 'MySQL schema/data alteration',
      });
    }
    return hits;
  });
}
