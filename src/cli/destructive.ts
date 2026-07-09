/**
 * Destructive-migration detection.
 *
 * `migrate up`/`down` execute user-authored SQL files verbatim, which is the
 * one place data loss can hide: a `DROP TABLE` or a `DELETE FROM` in a
 * migration runs with no ceremony. This module scans migration SQL for
 * statements that can destroy data so the CLI can force an explicit,
 * interactive confirmation (and the programmatic API can refuse by default).
 *
 * Deliberately conservative in BOTH directions:
 *   - comments and string literals are stripped first, so `-- DROP TABLE foo`
 *     or `INSERT ... VALUES ('DROP TABLE x')` never false-positive;
 *   - anything that removes rows, columns, tables, or schemas — or rewrites a
 *     column's type (a potentially lossy cast) — is flagged. `DROP INDEX`,
 *     `DROP CONSTRAINT`, and `DROP TRIGGER` are NOT flagged (recreatable
 *     structures; no row data lost).
 */

export type DestructiveKind =
  | 'drop-table'
  | 'drop-schema'
  | 'drop-column'
  | 'truncate'
  | 'delete'
  | 'update-without-where'
  | 'alter-column-type';

export interface DestructiveStatement {
  /** The offending SQL statement (trimmed, possibly long — display truncated) */
  statement: string;
  kind: DestructiveKind;
  /** Best-effort extracted object name (table, schema, or table.column) */
  target: string;
}

/** Human explanation per kind, used in CLI output. */
export const DESTRUCTIVE_KIND_LABEL: Record<DestructiveKind, string> = {
  'drop-table': 'drops a table and ALL its rows',
  'drop-schema': 'drops an entire schema',
  'drop-column': 'drops a column and its data in every row',
  truncate: 'deletes every row',
  delete: 'deletes rows',
  'update-without-where': 'rewrites every row (no WHERE clause)',
  'alter-column-type': 'rewrites a column type (cast may truncate or fail)',
};

/** Strip -- line comments, C-style block comments, and quoted literals. */
function stripCommentsAndStrings(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl; // keep the newline
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (sql[i] === "'") {
      // single-quoted literal ('' escapes a quote)
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      i = j + 1;
      out += "''";
    } else if (sql[i] === '$' && /^\$[a-zA-Z_]*\$/.test(sql.slice(i))) {
      // dollar-quoted literal ($$...$$ / $tag$...$tag$)
      const tag = sql.slice(i).match(/^\$[a-zA-Z_]*\$/)?.[0] ?? '$$';
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += "''";
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

/** Unquote a "quoted" identifier for display. */
const ident = (raw: string | undefined): string => (raw ?? '?').replace(/^"|"$/g, '');

const IDENT = String.raw`("[^"]+"|[a-zA-Z_][\w$]*)(\.("[^"]+"|[a-zA-Z_][\w$]*))?`;

interface Rule {
  kind: DestructiveKind;
  regex: RegExp;
  target: (m: RegExpMatchArray) => string;
  /** Extra predicate on the whole statement (e.g. UPDATE only when no WHERE). */
  also?: (stmt: string) => boolean;
}

/** Ordered rules — first match per statement wins. */
const RULES: Rule[] = [
  {
    kind: 'drop-table',
    regex: new RegExp(String.raw`^DROP\s+TABLE\s+(IF\s+EXISTS\s+)?${IDENT}`, 'i'),
    target: (m) => (m[4] ? `${ident(m[2])}.${ident(m[4])}` : ident(m[2])),
  },
  {
    kind: 'drop-schema',
    regex: new RegExp(String.raw`^DROP\s+SCHEMA\s+(IF\s+EXISTS\s+)?${IDENT}`, 'i'),
    target: (m) => ident(m[2]),
  },
  {
    kind: 'truncate',
    regex: new RegExp(String.raw`^TRUNCATE\s+(TABLE\s+)?(ONLY\s+)?${IDENT}`, 'i'),
    target: (m) => (m[5] ? `${ident(m[3])}.${ident(m[5])}` : ident(m[3])),
  },
  {
    kind: 'drop-column',
    regex: new RegExp(
      String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}[\s\S]*?\bDROP\s+COLUMN\s+(IF\s+EXISTS\s+)?${IDENT}`,
      'i',
    ),
    target: (m) => `${ident(m[3])}.${ident(m[7])}`,
  },
  {
    kind: 'alter-column-type',
    regex: new RegExp(
      String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}[\s\S]*?\bALTER\s+(COLUMN\s+)?${IDENT}\s+(SET\s+DATA\s+)?TYPE\b`,
      'i',
    ),
    target: (m) => `${ident(m[3])}.${ident(m[7])}`,
  },
  {
    kind: 'delete',
    regex: new RegExp(String.raw`^DELETE\s+FROM\s+(ONLY\s+)?${IDENT}`, 'i'),
    target: (m) => ident(m[2]),
  },
  {
    kind: 'update-without-where',
    regex: new RegExp(String.raw`^UPDATE\s+(ONLY\s+)?${IDENT}\b`, 'i'),
    target: (m) => ident(m[2]),
    also: (stmt) => !/\bWHERE\b/i.test(stmt),
  },
];

/**
 * Scan SQL (one file's worth; may contain many `;`-separated statements) and
 * return every statement that can destroy data.
 */
export function scanDestructiveSql(sql: string): DestructiveStatement[] {
  const found: DestructiveStatement[] = [];
  const cleaned = stripCommentsAndStrings(sql);

  for (const rawStmt of cleaned.split(';')) {
    const stmt = rawStmt.trim();
    if (!stmt) continue;

    for (const rule of RULES) {
      const m = stmt.match(rule.regex);
      if (!m) continue;
      if (rule.also && !rule.also(stmt)) continue;
      found.push({ statement: stmt.replace(/\s+/g, ' '), kind: rule.kind, target: rule.target(m) });
      break;
    }
  }
  return found;
}
