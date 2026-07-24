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
 *   - anything that removes rows, columns, tables, or schemas, or rewrites a
 *     column's type (a potentially lossy cast), is flagged. `DROP INDEX`,
 *     `DROP CONSTRAINT`, and `DROP TRIGGER` are NOT flagged (recreatable
 *     structures; no row data lost).
 *
 * Row removal hides in more than a leading `DELETE`, so the scan also covers:
 * the optional-`COLUMN` shorthand (`ALTER TABLE t DROP email`), data-modifying
 * CTEs (`WITH d AS (DELETE ...) SELECT ...`), `MERGE ... THEN DELETE`, dynamic
 * SQL inside a `DO`/function body, and an `UPDATE` whose only WHERE sits inside
 * a subquery (which restricts nothing).
 */

export type DestructiveKind =
  | 'drop-table'
  | 'drop-schema'
  | 'drop-column'
  | 'truncate'
  | 'delete'
  | 'update-without-where'
  | 'alter-column-type'
  | 'merge-delete';

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
  'merge-delete': 'deletes matched rows (MERGE ... THEN DELETE)',
};

/** A dollar-quoted body (a DO block or function source) and where it was blanked. */
interface ProceduralBlock {
  /** Offset into the STRIPPED text at which the body was replaced. */
  at: number;
  /** The raw body text, quotes excluded. */
  body: string;
}

interface StrippedSql {
  text: string;
  /** Dollar-quoted bodies, in source order, so procedural SQL can be re-scanned. */
  blocks: ProceduralBlock[];
}

/** Strip -- line comments, C-style block comments, and quoted literals. */
function stripCommentsAndStrings(sql: string): StrippedSql {
  const blocks: ProceduralBlock[] = [];
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
      blocks.push({ at: out.length, body: sql.slice(i + tag.length, end === -1 ? sql.length : end) });
      i = end === -1 ? sql.length : end + tag.length;
      out += "''";
    } else {
      out += sql[i];
      i++;
    }
  }
  return { text: out, blocks };
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
    // `COLUMN` is OPTIONAL in Postgres: `ALTER TABLE t DROP email` drops the
    // column and its data exactly like the spelled-out form. The lookahead
    // excludes the other `DROP <thing>` sub-actions, none of which lose rows.
    kind: 'drop-column',
    regex: new RegExp(
      String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}[\s\S]*?\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b)(COLUMN\s+)?(IF\s+EXISTS\s+)?${IDENT}`,
      'i',
    ),
    target: (m) => `${ident(m[3])}.${ident(m[8])}`,
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
    // MERGE's DELETE action removes rows from the target table.
    kind: 'merge-delete',
    regex: new RegExp(String.raw`^MERGE\s+INTO\s+(ONLY\s+)?${IDENT}\b[\s\S]*?\bTHEN\s+DELETE\b`, 'i'),
    target: (m) => ident(m[2]),
  },
  {
    // A WHERE inside a scalar subquery (`SET x = (SELECT ... WHERE ...)`) does
    // NOT restrict the rows updated, so the guard tests only the TOP level.
    kind: 'update-without-where',
    regex: new RegExp(String.raw`^UPDATE\s+(ONLY\s+)?${IDENT}\b`, 'i'),
    target: (m) => ident(m[2]),
    also: (stmt) => !hasTopLevelWhere(stmt),
  },
];

/** True when the statement has a `WHERE` outside every parenthesized group. */
function hasTopLevelWhere(stmt: string): boolean {
  const re = /[()]|\bWHERE\b/gi;
  let depth = 0;
  let m: RegExpExecArray | null = re.exec(stmt);
  while (m !== null) {
    if (m[0] === '(') depth++;
    else if (m[0] === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) return true;
    m = re.exec(stmt);
  }
  return false;
}

/** First matching rule for one candidate fragment, or null. */
function matchRules(candidate: string): { kind: DestructiveKind; target: string } | null {
  for (const rule of RULES) {
    const m = candidate.match(rule.regex);
    if (!m) continue;
    if (rule.also && !rule.also(candidate)) continue;
    return { kind: rule.kind, target: rule.target(m) };
  }
  return null;
}

/**
 * Data-modifying CTE bodies: `WITH d AS (DELETE FROM t ...) SELECT ...` runs a
 * real DELETE even though the statement reads as a SELECT. Each candidate is cut
 * at the paren that closes its CTE, so the outer query's WHERE cannot mask a
 * `WITH u AS (UPDATE t SET ...) SELECT ... WHERE ...`.
 */
function cteSubstatements(stmt: string): string[] {
  if (!/^WITH\b/i.test(stmt)) return [];
  const out: string[] = [];
  const re = /\(\s*(?=(?:DELETE|UPDATE|INSERT|TRUNCATE|DROP|ALTER|MERGE)\b)/gi;
  let m: RegExpExecArray | null = re.exec(stmt);
  while (m !== null) {
    const start = m.index + m[0].length;
    out.push(stmt.slice(start, closingParenIndex(stmt, m.index)));
    m = re.exec(stmt);
  }
  return out;
}

/** Index of the `)` closing the `(` at `openAt`, or the end of the string. */
function closingParenIndex(stmt: string, openAt: number): number {
  let depth = 0;
  for (let i = openAt; i < stmt.length; i++) {
    if (stmt[i] === '(') depth++;
    else if (stmt[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return stmt.length;
}

/** Statements whose dollar-quoted body is executable SQL rather than data. */
const PROCEDURAL_STATEMENT = /^(DO\b|CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b)/i;

/**
 * Candidate fragments inside a procedural body (a `DO $$ ... $$` block or a
 * function source). The body's own string literals are NOT stripped here: the
 * whole point is dynamic SQL, whose payload lives in a literal
 * (`EXECUTE 'DROP TABLE users'`). Rules are anchored, so every keyword-leading
 * position in the body is offered as its own candidate. This deliberately
 * over-reports (a body that merely mentions "drop table" in a message string is
 * flagged) in keeping with the module's false-positives-only asymmetry.
 */
function proceduralCandidates(body: string): string[] {
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const out: string[] = [];
  const re = /\b(?:DROP|TRUNCATE|DELETE|ALTER|UPDATE|MERGE)\s/gi;
  let m: RegExpExecArray | null = re.exec(withoutComments);
  while (m !== null) {
    out.push(withoutComments.slice(m.index));
    m = re.exec(withoutComments);
  }
  return out;
}

/**
 * Scan SQL (one file's worth; may contain many `;`-separated statements) and
 * return every statement that can destroy data.
 */
export function scanDestructiveSql(sql: string): DestructiveStatement[] {
  const found: DestructiveStatement[] = [];
  const cleaned = stripCommentsAndStrings(sql);

  let offset = 0;
  for (const rawStmt of cleaned.text.split(';')) {
    const start = offset;
    const end = offset + rawStmt.length;
    offset = end + 1; // the ';' consumed by split

    const stmt = rawStmt.trim();
    if (!stmt) continue;

    // Top level, then data-modifying CTEs, then any procedural body this
    // statement blanked. First match per statement wins, as before.
    const display = stmt.replace(/\s+/g, ' ');
    const candidates: Array<{ text: string; display: string }> = [stmt, ...cteSubstatements(stmt)].map((text) => ({
      text,
      display,
    }));
    // Only a DO block / routine body is procedural SQL. A dollar-quoted literal
    // used as DATA (`INSERT ... VALUES ($$DELETE FROM x$$)`) stays a literal.
    const procedural = PROCEDURAL_STATEMENT.test(stmt);
    for (const block of procedural ? cleaned.blocks : []) {
      if (block.at < start || block.at >= end) continue;
      for (const text of proceduralCandidates(block.body)) {
        // The body was blanked in `display`, so name the fragment that matched.
        candidates.push({ text, display: `${display} [in block: ${text.replace(/\s+/g, ' ').slice(0, 60)}]` });
      }
    }

    for (const candidate of candidates) {
      const hit = matchRules(candidate.text);
      if (!hit) continue;
      found.push({ statement: candidate.display, kind: hit.kind, target: hit.target });
      break;
    }
  }
  return found;
}
