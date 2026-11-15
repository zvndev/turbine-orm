/** Conservative SQLite CREATE TABLE decomposition, separate from the PostgreSQL migration lexer. */
import { ValidationError } from '../errors.js';

interface Token {
  text: string;
  value: string;
  kind: 'name' | 'literal' | 'symbol';
  start: number;
  end: number;
}

function refuse(message: string): never {
  throw new ValidationError(`SQLite schema: ${message}. Use an explicit reviewed SQL migration.`);
}

/** SQLite quotes/comments are consumed before punctuation, including commas in literals. */
function tokens(sql: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const start = i;
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) refuse('unterminated catalog comment');
      i = end + 2;
      continue;
    }
    let value = '';
    let kind: Token['kind'] = 'symbol';
    if (['"', "'", '`', '['].includes(ch)) {
      const close = ch === '[' ? ']' : ch;
      kind = ch === "'" ? 'literal' : 'name';
      i++;
      let closed = false;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (ch !== '[' && sql[i + 1] === close) {
            value += close;
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        value += sql[i++]!;
      }
      if (!closed) refuse('unterminated catalog quote');
    } else if (/\d/.test(ch) || (ch === '.' && /\d/.test(sql[i + 1] ?? ''))) {
      const numeric = /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(sql.slice(i))![0];
      kind = 'literal';
      value = numeric;
      i += numeric.length;
    } else if (/[a-z_\u0080-\uffff]/i.test(ch)) {
      kind = 'name';
      while (i < sql.length && /[a-z\d_$\u0080-\uffff]/i.test(sql[i]!)) value += sql[i++]!;
    } else {
      value = ch;
      i++;
    }
    result.push({ text: sql.slice(start, i), value, kind, start, end: i });
  }
  return result;
}

function key(ts: Token[]): string {
  return JSON.stringify(ts.map((t) => (t.kind === 'name' ? ['name', t.value.toUpperCase()] : [t.kind, t.value])));
}

export interface SqliteColumnDdl {
  name: string;
  sql: string;
  /** Definition with only anonymous NOT NULL and DEFAULT clauses removed. */
  fixedSql: string;
  fixedKey: string;
  notNull: boolean;
  autoincrement: boolean;
  defaultSql?: string;
  defaultKey: string;
}
export interface SqliteTableDdl {
  name: string;
  columns: SqliteColumnDdl[];
  constraints: string[];
  constraintsKey: string;
  strict: boolean;
  withoutRowid: boolean;
  /** Validated catalog table options, kept in their original order/spelling. */
  suffixSql: string;
}

function column(sql: string): SqliteColumnDdl {
  const ts = tokens(sql);
  if (ts[0]?.kind !== 'name') refuse('ambiguous column name');
  const removed = new Set<number>();
  let depth = 0;
  let notNull = false;
  let defaultSql: string | undefined;
  let defaultKey = '';
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i]!;
    if (t.text === '(') {
      depth++;
      continue;
    }
    if (t.text === ')') {
      depth--;
      continue;
    }
    if (depth !== 0 || t.kind !== 'name' || t.text !== t.value) continue;
    const word = t.value.toUpperCase();
    if (word === 'GENERATED' || word === 'AS' || word === 'CONSTRAINT') {
      refuse(`column ${ts[0]!.value} has a generated or named column constraint`);
    }
    if (word === 'NOT' && ts[i + 1]?.value.toUpperCase() === 'NULL') {
      if (notNull || ts[i + 2]?.value.toUpperCase() === 'ON') refuse('ambiguous NOT NULL conflict policy');
      notNull = true;
      removed.add(i);
      removed.add(++i);
    } else if (word === 'DEFAULT' && ts[i - 1]?.value.toUpperCase() !== 'SET') {
      if (defaultSql !== undefined || !ts[i + 1]) refuse('ambiguous DEFAULT clause');
      const begin = i + 1;
      let end = begin;
      if (ts[end]!.text === '(') {
        let nesting = 1;
        while (++end < ts.length && nesting) {
          if (ts[end]!.text === '(') nesting++;
          if (ts[end]!.text === ')') nesting--;
        }
        end--;
        if (nesting !== 0) refuse('unbalanced DEFAULT expression');
      } else {
        if (['+', '-'].includes(ts[end]!.text)) end++;
      }
      defaultSql = sql.slice(ts[begin]!.start, ts[end]!.end);
      let expression = ts.slice(begin, end + 1);
      while (expression[0]?.text === '(' && expression.at(-1)?.text === ')') expression = expression.slice(1, -1);
      defaultKey = key(expression);
      for (let j = i; j <= end; j++) removed.add(j);
      i = end;
    }
  }
  const fixed = ts.filter((_, i) => !removed.has(i));
  // Remove clause token spans while preserving operators, quoting and comments.
  return {
    name: ts[0]!.value,
    sql,
    fixedSql: ts
      .reduceRight((text, t, index) => (removed.has(index) ? text.slice(0, t.start) + text.slice(t.end) : text), sql)
      .trim(),
    fixedKey: key(fixed),
    notNull,
    autoincrement: fixed.some((t, index) => index > 0 && t.text.toUpperCase() === 'AUTOINCREMENT'),
    defaultSql,
    defaultKey,
  };
}

/** Only native STRICT/WITHOUT ROWID options are representable after the column list. */
export function parseSqliteTableDdl(sql: string): SqliteTableDdl {
  const ts = tokens(sql);
  let i = 0;
  if (ts[i++]?.value.toUpperCase() !== 'CREATE' || ts[i++]?.value.toUpperCase() !== 'TABLE')
    refuse('unsupported table definition');
  if (ts[i]?.value.toUpperCase() === 'IF') i += 3;
  const name = ts[i++];
  if (name?.kind !== 'name' || ts[i++]?.text !== '(') refuse('ambiguous table definition');
  const parts: string[] = [];
  let begin = i;
  let depth = 0;
  let closed = false;
  for (; i < ts.length; i++) {
    const t = ts[i]!;
    if (t.text === '(') depth++;
    if (t.text === ')' && depth === 0) {
      parts.push(sql.slice(ts[begin]!.start, t.start).trim());
      i++;
      closed = true;
      break;
    }
    if (t.text === ')') depth--;
    if (t.text === ',' && depth === 0) {
      parts.push(sql.slice(ts[begin]!.start, t.start).trim());
      begin = i + 1;
    }
  }
  if (!closed || depth !== 0) refuse('unbalanced table definition');
  const suffixStart = i;
  let strict = false;
  let withoutRowid = false;
  const word = (index: number, value: string) => ts[index]?.text.toUpperCase() === value;
  while (i < ts.length && ts[i]!.text !== ';') {
    if (word(i, 'STRICT') && !strict) {
      strict = true;
      i++;
    } else if (word(i, 'WITHOUT') && word(i + 1, 'ROWID') && !withoutRowid) {
      withoutRowid = true;
      i += 2;
    } else refuse('table suffix or multiple statements are unsupported');
    if (!ts[i] || ts[i]!.text === ';') break;
    if (ts[i++]!.text !== ',' || !ts[i] || ts[i]!.text === ';')
      refuse('table suffix or multiple statements are unsupported');
  }
  const suffixSql = i > suffixStart ? sql.slice(ts[suffixStart]!.start, ts[i - 1]!.end) : '';
  if (ts[i]?.text === ';') i++;
  if (i !== ts.length) refuse('table suffix or multiple statements are unsupported');
  const columns: SqliteColumnDdl[] = [];
  const constraints: string[] = [];
  for (const part of parts) {
    const first = tokens(part)[0];
    if (first && first.text === first.value && /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i.test(first.value))
      constraints.push(part);
    else columns.push(column(part));
  }
  if (!columns.length) refuse('table has no representable columns');
  return {
    name: name.value,
    columns,
    constraints,
    constraintsKey: JSON.stringify(constraints.map((c) => key(tokens(c))).sort()),
    strict,
    withoutRowid,
    suffixSql,
  };
}

/** Catalog index comparison ignores quoting/whitespace and IF NOT EXISTS only. */
export function sqliteIndexDdlKey(sql: string): string {
  const ts = tokens(sql);
  const semicolon = ts.findIndex((t) => t.text === ';');
  if (semicolon !== -1 && semicolon !== ts.length - 1) refuse('multiple index statements');
  if (semicolon !== -1) ts.pop();
  const index = ts.findIndex((t) => t.text.toUpperCase() === 'INDEX');
  if (ts[0]?.text.toUpperCase() !== 'CREATE' || (index !== 1 && index !== 2)) refuse('unsupported index definition');
  if (
    ts[index + 1]?.text.toUpperCase() === 'IF' &&
    ts[index + 2]?.text.toUpperCase() === 'NOT' &&
    ts[index + 3]?.text.toUpperCase() === 'EXISTS'
  )
    ts.splice(index + 1, 3);
  return key(ts);
}
