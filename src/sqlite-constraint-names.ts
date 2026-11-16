/**
 * Foreign-key constraint names for SQLite tables.
 *
 * SQLite keeps no constraint name in its catalog (`PRAGMA foreign_key_list` has
 * no name column), only in the statement text `sqlite_master.sql` stores. A
 * relation name reads the constraint name in one shape, a composite foreign key
 * that shares its target with another, so without this a SQLite schema derived
 * different names than the same schema on PostgreSQL and MySQL. The SQLite,
 * libSQL and D1 introspectors share it.
 *
 * Deliberately a reader of the one clause it needs, not a SQL parser. A key it
 * cannot read is named as an unnamed key, with the name PostgreSQL would have
 * given it.
 */

import { type ForeignKeyEntry, foreignKeyConstraintNames } from './catalog-metadata.js';

/** One foreign key a `CREATE TABLE` statement declares, table- or column-level. */
export interface DeclaredForeignKey {
  /** The `CONSTRAINT` name, absent for an unnamed key. */
  name?: string;
  columns: string[];
  table: string;
  /** The referenced columns, empty when the clause names none (the target's primary key). */
  references: string[];
}

interface Token {
  /** `word` is a bare word, `ident` a quoted identifier, `punct` one of `( ) ,`. */
  kind: 'word' | 'ident' | 'string' | 'punct' | 'other';
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
      out.push({ kind: c === "'" ? 'string' : 'ident', value });
      i = j + 1;
    } else if (/[A-Za-z_\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_$\u0080-￿]/.test(sql[j]!)) j++;
      out.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
    } else {
      out.push({ kind: c === '(' || c === ')' || c === ',' ? 'punct' : 'other', value: c });
      i++;
    }
  }
  return out;
}

/** ASCII case folding, the only folding SQLite applies to identifiers and PostgreSQL to a bare word in UTF-8. */
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const keyword = (t: Token | undefined): string | undefined => (t?.kind === 'word' ? t.value.toUpperCase() : undefined);

/**
 * An identifier as PostgreSQL would store it: a bare word folds to lower case,
 * a quoted one keeps its case.
 */
const identifier = (t: Token | undefined): string | undefined =>
  t?.kind === 'word' ? fold(t.value) : t?.kind === 'ident' || t?.kind === 'string' ? t.value : undefined;

const punct = (t: Token | undefined, value: string): boolean => t?.kind === 'punct' && t.value === value;

/** The parenthesized identifier list at `def[at]`, and the index after it. Undefined when there is none. */
function identifierList(def: Token[], at: number): [string[], number] | undefined {
  if (!punct(def[at], '(')) return undefined;
  const names: string[] = [];
  for (let k = at + 1; k < def.length; k += 2) {
    const name = identifier(def[k]);
    if (name === undefined) return undefined;
    names.push(name);
    if (punct(def[k + 1], ')')) return [names, k + 2];
    if (!punct(def[k + 1], ',')) return undefined;
  }
  return undefined;
}

const TABLE_CONSTRAINTS = new Set(['CONSTRAINT', 'PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN']);

/** Every foreign key a `CREATE TABLE` statement declares, in statement order. */
export function declaredForeignKeys(createTable: string): DeclaredForeignKey[] {
  const tokens = tokenize(createTable);
  const open = tokens.findIndex((t) => punct(t, '('));
  if (open === -1) return [];

  // Split the body into its comma-separated definitions, marking the tokens
  // inside a definition's own parentheses (a type's, a CHECK's, a column list).
  const definitions: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let k = open + 1; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (punct(t, '(')) depth++;
    else if (punct(t, ')')) {
      if (depth === 0) {
        definitions.push(current);
        break;
      }
      depth--;
    } else if (punct(t, ',') && depth === 0) {
      definitions.push(current);
      current = [];
      continue;
    }
    current.push(depth > 0 ? { ...t, nested: true } : t);
  }

  const found: DeclaredForeignKey[] = [];
  // REFERENCES <table> [(<columns>)] at `def[at]`.
  const reference = (def: Token[], at: number, columns: string[], name: string | undefined) => {
    const table = keyword(def[at]) === 'REFERENCES' ? identifier(def[at + 1]) : undefined;
    if (table === undefined) return;
    const references = punct(def[at + 2], '(') ? identifierList(def, at + 2)?.[0] : [];
    if (references !== undefined) found.push({ ...(name === undefined ? {} : { name }), columns, table, references });
  };
  for (const def of definitions) {
    const first = keyword(def[0]);
    if (first !== undefined && TABLE_CONSTRAINTS.has(first)) {
      // [CONSTRAINT <name>] FOREIGN KEY (<columns>) REFERENCES <table> [(<columns>)]
      const at = first === 'CONSTRAINT' ? 2 : 0;
      if (keyword(def[at]) !== 'FOREIGN' || keyword(def[at + 1]) !== 'KEY') continue;
      const list = identifierList(def, at + 2);
      if (list) reference(def, list[1], list[0], at === 2 ? identifier(def[1]) : undefined);
      continue;
    }
    // <column> <type> ... [CONSTRAINT <name>] REFERENCES <table> [(<column>)], any number of times
    const column = identifier(def[0]);
    if (column === undefined) continue;
    const top = def.flatMap((t, k) => (t.nested ? [] : [k]));
    for (let k = 1; k < top.length; k++) {
      if (keyword(def[top[k]!]) !== 'REFERENCES') continue;
      const named = k >= 3 && keyword(def[top[k - 2]!]) === 'CONSTRAINT';
      reference(def, top[k]!, [column], named ? identifier(def[top[k - 1]!]) : undefined);
    }
  }
  return found;
}

/**
 * Names every foreign key of one SQLite table as PostgreSQL names the same
 * declarations, setting each key's `constraintName`: its declared `CONSTRAINT`
 * name, else (see {@link foreignKeyConstraintNames}) PostgreSQL's default in
 * declaration order, with every declared name reserved first.
 *
 * A key is matched to its declaration by its whole identity, child columns,
 * target table and referenced columns, compared as SQLite compares
 * identifiers. Keys that are identical in all three are matched in declaration
 * order. When the statement holds a different number of declarations of one
 * identity than the catalog holds keys (a clause this reader cannot read), no
 * key of that identity takes a declared name.
 *
 * @param keys the table's foreign keys in `PRAGMA foreign_key_list` id order,
 *   with `targetColumns` still empty where the clause names none. SQLite
 *   numbers the LAST declared key 0, so reversed they are in declaration order.
 * @param taken constraint names already taken in the schema, see
 *   {@link foreignKeyConstraintNames}
 */
export function nameSqliteForeignKeys(
  table: string,
  createTable: string,
  keys: readonly ForeignKeyEntry[],
  taken: Set<string>,
): void {
  const identity = (columns: string[], target: string, references: string[]) =>
    fold(JSON.stringify([columns, target, references]));
  const declared = new Map<string, (string | undefined)[]>();
  for (const d of declaredForeignKeys(createTable)) {
    if (d.name !== undefined) taken.add(d.name);
    const id = identity(d.columns, d.table, d.references);
    declared.set(id, [...(declared.get(id) ?? []), d.name]);
  }
  const ordered = [...keys].reverse();
  const ids = ordered.map((k) => identity(k.sourceColumns, k.targetTable, k.targetColumns));
  const seen = new Map<string, number>();
  const names = foreignKeyConstraintNames(
    table,
    ordered.map((k, i) => {
      const id = ids[i]!;
      const rank = seen.get(id) ?? 0;
      seen.set(id, rank + 1);
      const names = declared.get(id);
      // Every key of this identity has a declaration, so the rank pairs them.
      const matched = names?.length === ids.filter((other) => other === id).length;
      return { columns: k.sourceColumns, name: matched ? names![rank] : undefined };
    }),
    taken,
  );
  ordered.forEach((k, i) => {
    k.constraintName = names[i]!;
  });
}
