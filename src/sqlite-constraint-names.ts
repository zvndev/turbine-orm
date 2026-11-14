/**
 * Foreign-key constraint names from a SQLite `CREATE TABLE` statement.
 *
 * SQLite keeps no constraint name in its catalog (`PRAGMA foreign_key_list` has
 * no name column), only in the statement text `sqlite_master.sql` stores. A
 * relation name reads the constraint name in one shape, a composite foreign key
 * that shares its target with another, so without this a SQLite schema derived
 * different names than the same schema on PostgreSQL and MySQL. Zero imports:
 * the SQLite, libSQL and D1 introspectors share it.
 *
 * Deliberately a reader of the one clause it needs, not a SQL parser. Anything
 * it cannot read is left out, and the introspector then falls back to the name
 * PostgreSQL would have given the constraint, which is what every engine uses
 * for an unnamed one.
 */

/** One `CONSTRAINT <name>` that a foreign key declares. */
export interface DeclaredForeignKeyName {
  name: string;
  columns: string[];
  table: string;
}

interface Token {
  /** `word` is a bare word, `ident` a quoted identifier, `punct` one of `( ) ,`. */
  kind: 'word' | 'ident' | 'punct' | 'other';
  value: string;
  /** Inside parentheses within one definition (a type's, a CHECK's). */
  nested?: boolean;
}

function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      // A doubled closing quote is an escaped one, except inside [ ].
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      let value = '';
      while (j < sql.length) {
        if (sql[j] === close) {
          if (close !== ']' && sql[j + 1] === close) {
            value += close;
            j += 2;
            continue;
          }
          break;
        }
        value += sql[j];
        j++;
      }
      // SQLite reads a single-quoted string as an identifier where one is expected.
      out.push({ kind: c === "'" ? 'other' : 'ident', value });
      i = j + 1;
    } else if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[j]!)) j++;
      out.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: c === '(' || c === ')' || c === ',' ? 'punct' : 'other', value: c });
      i++;
    }
  }
  return out;
}

const keyword = (t: Token | undefined): string | undefined => (t?.kind === 'word' ? t.value.toUpperCase() : undefined);

/**
 * An identifier as PostgreSQL would store it: a bare word folds to lower case,
 * a quoted one keeps its case.
 */
const identifier = (t: Token | undefined): string | undefined =>
  t?.kind === 'word' ? t.value.toLowerCase() : t?.kind === 'ident' || t?.kind === 'other' ? t.value : undefined;

const TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

/** Every named foreign key a `CREATE TABLE` statement declares, table- or column-level. */
export function declaredForeignKeyNames(createTable: string): DeclaredForeignKeyName[] {
  const tokens = tokenize(createTable);
  const open = tokens.findIndex((t) => t.kind === 'punct' && t.value === '(');
  if (open === -1) return [];

  // Split the body into its comma-separated definitions, keeping only the
  // tokens at the definition's own depth (a type's or a CHECK's parentheses
  // are skipped whole, except the parenthesized column list of FOREIGN KEY).
  const definitions: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let k = open + 1; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind === 'punct' && t.value === '(') depth++;
    else if (t.kind === 'punct' && t.value === ')') {
      if (depth === 0) {
        definitions.push(current);
        break;
      }
      depth--;
    } else if (t.kind === 'punct' && t.value === ',' && depth === 0) {
      definitions.push(current);
      current = [];
      continue;
    }
    current.push(depth > 0 ? { ...t, nested: true } : t);
  }

  const found: DeclaredForeignKeyName[] = [];
  for (const def of definitions) {
    const first = keyword(def[0]);
    if (first !== undefined && TABLE_CONSTRAINTS.has(first)) {
      // CONSTRAINT <name> FOREIGN KEY (<columns>) REFERENCES <table>
      if (first !== 'CONSTRAINT' || keyword(def[2]) !== 'FOREIGN' || keyword(def[3]) !== 'KEY') continue;
      if (def[4]?.value !== '(') continue;
      const columns: string[] = [];
      let k = 5;
      for (; k < def.length && def[k]!.value !== ')'; k++) {
        if (def[k]!.value === ',') continue;
        const column = identifier(def[k]);
        if (column === undefined) break;
        columns.push(column);
      }
      const name = identifier(def[1]);
      const table = keyword(def[k + 1]) === 'REFERENCES' ? identifier(def[k + 2]) : undefined;
      if (name !== undefined && table !== undefined && columns.length > 0) found.push({ name, columns, table });
      continue;
    }
    // <column> <type> ... CONSTRAINT <name> REFERENCES <table>
    const column = identifier(def[0]);
    const top = def.filter((t) => !t.nested);
    for (let k = 1; k < top.length; k++) {
      if (keyword(top[k]) !== 'CONSTRAINT' || keyword(top[k + 2]) !== 'REFERENCES') continue;
      const name = identifier(top[k + 1]);
      const table = identifier(top[k + 3]);
      if (column !== undefined && name !== undefined && table !== undefined)
        found.push({ name, columns: [column], table });
    }
  }
  return found;
}

/**
 * The declared name of the foreign key over `columns` to `table`, when exactly
 * one declaration matches. SQLite compares identifiers case-insensitively, so
 * the match does too.
 */
export function declaredForeignKeyName(
  declared: DeclaredForeignKeyName[],
  columns: string[],
  table: string,
): string | undefined {
  const fold = (s: string) => s.toLowerCase();
  const matches = declared.filter(
    (d) =>
      fold(d.table) === fold(table) &&
      d.columns.length === columns.length &&
      d.columns.every((c, i) => fold(c) === fold(columns[i]!)),
  );
  return matches.length === 1 ? matches[0]!.name : undefined;
}
