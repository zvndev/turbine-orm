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
 * SQL inside a `DO`/function body, an `UPDATE` whose only WHERE sits inside a
 * subquery (which restricts nothing), a `DROP ... CASCADE` of a non-table
 * object (which takes dependent COLUMNS with it), a detached partition, and an
 * `EXPLAIN ANALYZE` of any of the above (which really executes it).
 *
 * The lexing, "where does a statement end" and "which characters are code",
 * is NOT done here: it lives in `sql-statements.ts` and is shared with the
 * migration runner. Two lexers is how this guard came to disagree with the
 * executor about what a file contained (see that module's header).
 */

import { tokenizeSql } from './sql-statements.js';

export type DestructiveKind =
  | 'drop-table'
  | 'drop-schema'
  | 'drop-database'
  | 'drop-owned'
  | 'drop-matview'
  | 'drop-column'
  | 'drop-cascade'
  | 'detach-partition'
  | 'truncate'
  | 'delete'
  | 'update-without-where'
  | 'alter-column-type'
  | 'merge-delete'
  | 'rename'
  | 'dynamic-destructive';

export interface DestructiveStatement {
  /** The offending SQL statement (trimmed, possibly long, display truncated) */
  statement: string;
  kind: DestructiveKind;
  /**
   * Best-effort extracted object name (table, schema, or table.column). For
   * `drop-cascade` it is prefixed with the object kind (`TYPE order_status`),
   * because the same rule covers eight different kinds of object and the bare
   * name would not tell the operator what they are about to lose.
   */
  target: string;
}

/** Human explanation per kind, used in CLI output. */
export const DESTRUCTIVE_KIND_LABEL: Record<DestructiveKind, string> = {
  'drop-table': 'drops a table and ALL its rows',
  'drop-schema': 'drops an entire schema',
  'drop-database': 'drops an entire database and everything in it',
  'drop-owned': 'drops every object owned by a role, and their rows',
  'drop-matview': 'drops a materialized view and its stored rows',
  'drop-column': 'drops a column and its data in every row',
  'drop-cascade': 'drops an object AND every dependent object, columns and their data included',
  'detach-partition': 'detaches a partition, every row in it leaves the table',
  truncate: 'deletes every row',
  delete: 'deletes rows',
  'update-without-where': 'rewrites every row (no WHERE clause)',
  'alter-column-type': 'rewrites a column type (cast may truncate or fail)',
  'merge-delete': 'deletes matched rows (MERGE ... THEN DELETE)',
  rename: 'renames a table or column, every query and view referencing the old name breaks',
  'dynamic-destructive':
    'runs destructive SQL assembled at run time, what it destroys cannot be known without running it',
};

/** Unquote a "quoted" identifier for display. */
const ident = (raw: string | undefined): string => (raw ?? '?').replace(/^"|"$/g, '');

const IDENT = String.raw`("[^"]+"|[a-zA-Z_][\w$]*)(\.("[^"]+"|[a-zA-Z_][\w$]*))?`;

/**
 * Render one `IDENT` capture triple (name, `.qualifier`, qualifier) as text,
 * where `base` is the 1-based index of the triple's first group.
 */
const qualified = (m: RegExpMatchArray, base: number): string =>
  m[base + 2] ? `${ident(m[base])}.${ident(m[base + 2])}` : ident(m[base]);

/**
 * Filler between an `ALTER TABLE <name>` head and the sub-action keyword that
 * follows it, for the multi-action forms.
 *
 * NOT `[\s\S]*?`: that lets the lazy walk stop INSIDE a quoted identifier,
 * because a quoted name is kept verbatim in the stripped text. `ALTER TABLE t
 * ADD COLUMN "drop me" int` was flagged `drop-column` on `t.me`, a pure false
 * positive on a statement that adds data and removes none. Consuming either a
 * WHOLE quoted identifier or a single non-quote character means the scan can
 * never begin a keyword match part-way through a quoted name.
 */
const OUTSIDE_QUOTES = '(?:"[^"]*"|[^"])*?';

interface Rule {
  kind: DestructiveKind;
  regex: RegExp;
  target: (m: RegExpMatchArray) => string;
  /** Extra predicate on the whole statement (e.g. UPDATE only when no WHERE). */
  also?: (stmt: string) => boolean;
}

/** Ordered rules, first match per statement wins. */
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
    kind: 'drop-matview',
    regex: new RegExp(String.raw`^DROP\s+MATERIALIZED\s+VIEW\s+(IF\s+EXISTS\s+)?${IDENT}`, 'i'),
    target: (m) => (m[4] ? `${ident(m[2])}.${ident(m[4])}` : ident(m[2])),
  },
  {
    kind: 'drop-database',
    regex: new RegExp(String.raw`^DROP\s+DATABASE\s+(IF\s+EXISTS\s+)?${IDENT}`, 'i'),
    target: (m) => ident(m[2]),
  },
  {
    // `DROP OWNED BY role` removes every object that role owns, rows included.
    kind: 'drop-owned',
    regex: new RegExp(String.raw`^DROP\s+OWNED\s+BY\s+${IDENT}`, 'i'),
    target: (m) => ident(m[1]),
  },
  {
    // `DROP <object> ... CASCADE` on anything OTHER than a table. Without
    // CASCADE these are safe: Postgres refuses the drop while a dependency
    // exists. With it, the dependents go too, and a dependent of a TYPE or a
    // DOMAIN is typically a COLUMN, so `DROP TYPE order_status CASCADE`
    // silently removes `orders.status` and every value in it. The presence of
    // CASCADE is therefore the whole rule, not an extra detail.
    kind: 'drop-cascade',
    regex: new RegExp(
      String.raw`^DROP\s+(TYPE|DOMAIN|EXTENSION|SEQUENCE|FUNCTION|PROCEDURE|ROUTINE|AGGREGATE)\s+(IF\s+EXISTS\s+)?${IDENT}${OUTSIDE_QUOTES}\bCASCADE\b`,
      'i',
    ),
    target: (m) => `${m[1]!.toUpperCase()} ${qualified(m, 3)}`,
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
      String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}${OUTSIDE_QUOTES}\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b)(COLUMN\s+)?(IF\s+EXISTS\s+)?${IDENT}`,
      'i',
    ),
    target: (m) => `${ident(m[3])}.${ident(m[8])}`,
  },
  {
    // A detached partition keeps its rows, but they leave the parent table:
    // every query against the parent stops seeing them the moment this runs.
    kind: 'detach-partition',
    regex: new RegExp(
      String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}\s+DETACH\s+PARTITION\s+${IDENT}`,
      'i',
    ),
    target: (m) => `${qualified(m, 3)}.${qualified(m, 6)}`,
  },
  {
    kind: 'alter-column-type',
    regex: new RegExp(
      String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}${OUTSIDE_QUOTES}\bALTER\s+(COLUMN\s+)?${IDENT}\s+(SET\s+DATA\s+)?TYPE\b`,
      'i',
    ),
    target: (m) => `${ident(m[3])}.${ident(m[7])}`,
  },
  {
    kind: 'delete',
    regex: new RegExp(String.raw`^DELETE\s+FROM\s+(ONLY\s+)?${IDENT}`, 'i'),
    target: (m) => (m[4] ? `${ident(m[2])}.${ident(m[4])}` : ident(m[2])),
  },
  {
    // MERGE's DELETE action removes rows from the target table.
    kind: 'merge-delete',
    regex: new RegExp(String.raw`^MERGE\s+INTO\s+(ONLY\s+)?${IDENT}\b${OUTSIDE_QUOTES}\bTHEN\s+DELETE\b`, 'i'),
    target: (m) => (m[4] ? `${ident(m[2])}.${ident(m[4])}` : ident(m[2])),
  },
  {
    // A WHERE inside a scalar subquery (`SET x = (SELECT ... WHERE ...)`) does
    // NOT restrict the rows updated, so the guard tests only the TOP level.
    kind: 'update-without-where',
    regex: new RegExp(String.raw`^UPDATE\s+(ONLY\s+)?${IDENT}\b`, 'i'),
    target: (m) => (m[4] ? `${ident(m[2])}.${ident(m[4])}` : ident(m[2])),
    also: (stmt) => !hasTopLevelWhere(stmt),
  },
  // Renames come LAST: they destroy no data, so any statement that is BOTH a
  // rename and a data-loss operation should report the data loss instead.
  {
    // `ALTER TABLE t RENAME TO u`. Nothing is lost, but every query, view,
    // function, and application reference to `t` breaks the moment it lands,
    // and it is the second half of the sanctioned backfill swap, so an operator
    // confirming a migration deserves to see it in the inventory.
    kind: 'rename',
    regex: new RegExp(String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}\s+RENAME\s+TO\s+${IDENT}`, 'i'),
    target: (m) => qualified(m, 3),
  },
  {
    // `ALTER TABLE t RENAME [COLUMN] old TO new`. The lookahead keeps the
    // table-rename form (handled above) and `RENAME CONSTRAINT` (which breaks
    // nothing a query can name) out of this rule.
    kind: 'rename',
    regex: new RegExp(
      String.raw`^ALTER\s+TABLE\s+(IF\s+EXISTS\s+)?(ONLY\s+)?${IDENT}\s+RENAME\s+(COLUMN\s+)?(?!TO\b|CONSTRAINT\b)${IDENT}\s+TO\s+${IDENT}`,
      'i',
    ),
    target: (m) => `${qualified(m, 3)}.${qualified(m, 7)}`,
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

/**
 * A leading CTE list is a prefix, not a statement: `WITH c AS (SELECT 1) DELETE
 * FROM users` is a plain DELETE that the anchored rules would otherwise skip.
 * Strip balanced `WITH name AS ( ... )` groups (and their comma-separated
 * siblings) so the real statement head is what gets matched. The CTE bodies
 * themselves are handled separately by {@link cteSubstatements}.
 */
function stripLeadingCtes(stmt: string): string {
  if (!/^WITH\b/i.test(stmt)) return stmt;
  let rest = stmt.replace(/^WITH\s+(RECURSIVE\s+)?/i, '');
  for (;;) {
    const open = rest.indexOf('(');
    if (open === -1) return stmt;
    const close = closingParenIndex(rest, open);
    rest = rest.slice(close + 1).trimStart();
    if (rest.startsWith(',')) {
      rest = rest.slice(1).trimStart();
      continue;
    }
    return rest;
  }
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

/**
 * An `EXPLAIN` prefix, either the parenthesized option list or the bare keyword
 * form. Used to answer one question: does this EXPLAIN actually RUN the
 * statement it wraps?
 */
const EXPLAIN_PREFIX = /^EXPLAIN\s*(?:\(([^)]*)\)|((?:(?:ANALYZE|ANALYSE|VERBOSE)\s+)*))/i;

/**
 * `EXPLAIN ANALYZE <DML>` EXECUTES the statement, it does not merely plan it.
 * `EXPLAIN ANALYZE DELETE FROM t` empties `t`, and the guard used to see a
 * statement whose head was `EXPLAIN` and match no rule at all. Returned is the
 * inner statement when the EXPLAIN executes, otherwise the statement unchanged
 * (a plain `EXPLAIN DELETE ...` only plans, and must NOT be flagged).
 *
 * `ANALYZE false` / `ANALYZE off` is treated as executing even though it does
 * not: this module's asymmetry is that a false positive costs a confirmation
 * prompt while a false negative costs data, and spelling out boolean option
 * values here would trade the cheap error for the expensive one.
 */
function stripExecutingExplain(stmt: string): string {
  const m = EXPLAIN_PREFIX.exec(stmt);
  if (!m) return stmt;
  const options = m[1] ?? m[2] ?? '';
  if (!/\bANALY[SZ]E\b/i.test(options)) return stmt;
  return stmt.slice(m[0].length).trimStart();
}

/** Statements whose dollar-quoted body is executable SQL rather than data. */
const PROCEDURAL_STATEMENT = /^(DO\b|CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b)/i;

/**
 * Candidate fragments inside a procedural body (a `DO $$ ... $$` block, a
 * function source, or a PG14+ `BEGIN ATOMIC` body). The body's own string
 * literals are NOT stripped: the whole point is dynamic SQL, whose payload
 * lives in a literal (`EXECUTE 'DROP TABLE users'`). Rules are anchored, so
 * every keyword-leading position in the body is offered as its own candidate.
 * This deliberately over-reports (a body that merely mentions "drop table" in a
 * message string is flagged) in keeping with the module's
 * false-positives-only asymmetry.
 *
 * Comments come out via the SHARED tokenizer, never a regex. The pair that used
 * to do it here, `/\/\*[\s\S]*?\*\//g` and `/--[^\n]*\/g`, was the exact
 * hand-written lexer the tokenizer was written to delete, still in place one
 * level down and on the path that exists specifically to catch dynamic SQL.
 * Neither pattern nests and neither respects string literals, so ONE earlier
 * literal containing `--` or an unclosed `/*` blanked every destructive
 * statement after it. Both of these reported an empty inventory and dropped the
 * table on PostgreSQL 16.14:
 *
 *   DO $$ DECLARE s text := 'x --'; BEGIN EXECUTE 'DROP TABLE users'; END $$;
 *   DO $$ DECLARE s text := 'a /*'; BEGIN EXECUTE 'DROP TABLE users';
 *          RAISE NOTICE '% b *\/', s; END $$;
 *
 * The `--` shape is the worse of the two because it is reachable by ACCIDENT:
 * any single-line body whose earlier literal holds a `--` (a date range, a
 * separator, a placeholder) hides everything that follows it.
 *
 * Tokenizing also bounds each candidate at its own statement instead of at the
 * end of the body, so a later `WHERE` can no longer talk the `update-without-
 * where` rule out of an earlier unrestricted UPDATE.
 */
function proceduralCandidates(body: string): string[] {
  const out: string[] = [];
  for (const statement of tokenizeSql(body)) {
    // `code` is the statement with comments gone and everything else verbatim.
    // Literals have to survive: they are where dynamic SQL keeps its payload,
    // and `stripped` would have emptied exactly them.
    const text = statement.code;
    const re = /\b(?:DROP|TRUNCATE|DELETE|ALTER|UPDATE|MERGE)\s/gi;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      out.push(text.slice(m.index));
      m = re.exec(text);
    }
  }
  return out;
}

/**
 * Scan SQL (one file's worth; may contain many `;`-separated statements) and
 * return every statement that can destroy data.
 */
export function scanDestructiveSql(sql: string): DestructiveStatement[] {
  const found: DestructiveStatement[] = [];

  for (const statement of tokenizeSql(sql)) {
    if (statement.commentOnly) continue;
    const stmt = statement.stripped;
    if (!stmt) continue;

    // `EXPLAIN ANALYZE` is a wrapper that RUNS its argument, so the rules are
    // matched against what it wraps. `display` keeps the EXPLAIN, so the
    // inventory shows the operator the statement they actually wrote.
    const body = stripExecutingExplain(stmt);

    // Top level, then data-modifying CTEs, then any procedural body this
    // statement blanked. First match per statement wins, as before.
    const display = stmt.replace(/\s+/g, ' ');
    const candidates: Array<{ text: string; display: string }> = [
      stripLeadingCtes(body),
      ...cteSubstatements(body),
    ].map((text) => ({
      text,
      display,
    }));
    // Only a DO block / routine body is procedural SQL. A dollar-quoted literal
    // used as DATA (`INSERT ... VALUES ($$DELETE FROM x$$)`) stays a literal.
    // The tokenizer hands back each statement's OWN blocks, so which body
    // belongs to which statement is no longer an offset calculation that can
    // disagree with the statement split.
    const procedural = PROCEDURAL_STATEMENT.test(stmt);
    const proceduralTexts: string[] = [];
    for (const block of procedural ? statement.blocks : []) {
      for (const text of proceduralCandidates(block)) {
        // The body was blanked in `display`, so name the fragment that matched.
        candidates.push({ text, display: `${display} [in block: ${text.replace(/\s+/g, ' ').slice(0, 60)}]` });
        proceduralTexts.push(text);
      }
    }

    let matched = false;
    for (const candidate of candidates) {
      const hit = matchRules(candidate.text);
      if (!hit) continue;
      found.push({ statement: candidate.display, kind: hit.kind, target: hit.target });
      matched = true;
      break;
    }
    if (matched) continue;

    // Nothing matched a rule. Inside a PROCEDURAL body that is not the end of
    // the question, because the rules all need a parseable object name and
    // dynamic SQL does not have one until it runs. All three of these execute a
    // real `DROP TABLE` on PostgreSQL 16 and reported NOTHING:
    //
    //   DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'users'); END $$;
    //   DO $$ BEGIN EXECUTE 'DROP ' || 'TABLE users'; END $$;
    //   DO $$ BEGIN EXECUTE 'DROP TABLE ' || quote_ident('users'); END $$;
    //
    // A clean inventory for a file that drops a table is the exact failure this
    // module exists to prevent: the operator confirms what they were shown, and
    // the unlisted statement runs under that confirmation. So report it with an
    // explicit unknown target and let them decide.
    //
    // Gated on evidence of RUNTIME ASSEMBLY rather than on the verb alone, and
    // that gate is complete rather than heuristic: a destructive statement whose
    // object name is written out literally already matches a rule above, so the
    // only way to be dynamic is to concatenate or format. Without the gate,
    // `RAISE NOTICE 'DROP the mic'` would prompt, and a guard that fires on
    // prose teaches operators to confirm without reading, which costs more than
    // it saves.
    for (const text of proceduralTexts) {
      const kind = dynamicDestructiveKind(text);
      if (!kind) continue;
      found.push({
        statement: `${display} [in block: ${text.replace(/\s+/g, ' ').slice(0, 60)}]`,
        kind,
        target: DYNAMIC_TARGET,
      });
      break;
    }
  }
  return found;
}

/** Shown in place of an object name that does not exist until the block runs. */
export const DYNAMIC_TARGET = '<name assembled at run time>';

/** `||`, `format(...)`, or a `quote_*` helper: the ways a body builds SQL. */
const DYNAMIC_ASSEMBLY = /\|\||\bformat\s*\(|\bquote_(?:ident|literal|nullable)\s*\(|%[IsL]/;

/**
 * The kind a runtime-assembled procedural fragment should be reported as, or
 * `null` when it is not dynamic (so a rule already had its chance) or its verb
 * is not one that destroys data on its own.
 *
 * `ALTER` and `UPDATE` are deliberately absent even though
 * {@link proceduralCandidates} collects them: their destructive forms are
 * narrow (`ALTER COLUMN ... TYPE`, an `UPDATE` with no `WHERE`) and neither is
 * decidable from a fragment whose tail is a runtime expression, so including
 * them would flag every dynamic `UPDATE ... WHERE` in the file.
 */
function dynamicDestructiveKind(text: string): DestructiveKind | null {
  if (!DYNAMIC_ASSEMBLY.test(text)) return null;
  if (/^DROP\s+TABLE\b/i.test(text)) return 'drop-table';
  if (/^DROP\s+SCHEMA\b/i.test(text)) return 'drop-schema';
  if (/^DROP\s+DATABASE\b/i.test(text)) return 'drop-database';
  if (/^DROP\s+MATERIALIZED\s+VIEW\b/i.test(text)) return 'drop-matview';
  // A bare `DROP` whose object keyword is itself part of the runtime expression
  // (`'DROP ' || 'TABLE users'`). Deliberately NOT reported as `drop-cascade`:
  // that label claims dependent objects go too, which would be a factual claim
  // about the operator's migration that we cannot support. Being alarming is
  // fine here; being wrong is not.
  if (/^DROP\b/i.test(text)) return 'dynamic-destructive';
  if (/^TRUNCATE\b/i.test(text)) return 'truncate';
  if (/^DELETE\b/i.test(text)) return 'delete';
  return null;
}
