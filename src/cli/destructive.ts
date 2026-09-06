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
  | 'rewrite-rule'
  | 'dynamic-destructive'
  | 'dynamic-unclassified';

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
  'rewrite-rule':
    'installs a rewrite rule that runs a destructive statement every time a later ordinary statement matches it',
  'dynamic-destructive':
    'runs destructive SQL assembled at run time, what it destroys cannot be known without running it',
  'dynamic-unclassified':
    'runs SQL assembled at run time whose statement the scanner cannot read; confirm what it does yourself',
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
  {
    // `CREATE RULE r AS ON INSERT TO t DO INSTEAD DELETE FROM u`. The rule
    // destroys nothing when it is created, which is why it passed: the DELETE
    // runs later, on every ordinary INSERT into `t`, and the first one emptied
    // the table. Deferred destruction is still destruction the migration
    // installs. `DO ALSO` counts too (the action runs in addition), and the
    // action may be a parenthesized list, whose FIRST statement decides.
    kind: 'rewrite-rule',
    regex: new RegExp(
      String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?RULE\s+${IDENT}\s+AS\s+ON\s+(?:SELECT|INSERT|UPDATE|DELETE)\s+TO\s+${IDENT}${OUTSIDE_QUOTES}\bDO\s+(?:ALSO\s+|INSTEAD\s+)?\(?\s*(DELETE|UPDATE|TRUNCATE|DROP)\b`,
      'i',
    ),
    target: (m) => `${qualified(m, 4)} (${(m[7] ?? '').toUpperCase()} on every matching statement)`,
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
/**
 * One destructive verb found inside a procedural body, with the text of its own
 * statement on either side of it. `before` exists because the evidence that a
 * statement is ASSEMBLED does not always sit after the verb: in
 * `concat('DROP TABLE ', t)` the verb is inside the assembling call's argument
 * list, so everything that identifies the call is to its LEFT.
 */
interface ProceduralCandidate {
  /** The statement from the verb to its end: what the rules and the kind test read. */
  text: string;
  /** The same statement up to the verb, bounded at the statement, never the whole body. */
  before: string;
}

function proceduralCandidates(body: string): ProceduralCandidate[] {
  const out: ProceduralCandidate[] = [];
  for (const statement of tokenizeSql(body)) {
    // `code` is the statement with comments gone and everything else verbatim.
    // Literals have to survive: they are where dynamic SQL keeps its payload,
    // and `stripped` would have emptied exactly them.
    const text = statement.code;
    const re = /\b(?:DROP|TRUNCATE|DELETE|ALTER|UPDATE|MERGE)\s/gi;
    let m: RegExpExecArray | null = re.exec(text);
    while (m !== null) {
      out.push({ text: text.slice(m.index), before: text.slice(0, m.index) });
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
    const proceduralParts: ProceduralCandidate[] = [];
    for (const block of procedural ? statement.blocks : []) {
      for (const part of proceduralCandidates(block)) {
        // The body was blanked in `display`, so name the fragment that matched.
        candidates.push({
          text: part.text,
          display: `${display} [in block: ${part.text.replace(/\s+/g, ' ').slice(0, 60)}]`,
        });
        proceduralParts.push(part);
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
    let dynamicHit = false;
    for (const part of proceduralParts) {
      const kind = dynamicDestructiveKind(part);
      if (!kind) continue;
      found.push({
        statement: `${display} [in block: ${part.text.replace(/\s+/g, ' ').slice(0, 60)}]`,
        kind,
        target: DYNAMIC_TARGET,
      });
      dynamicHit = true;
      break;
    }
    if (dynamicHit) continue;

    // Still nothing, in a procedural body. Every pass above needs to SEE a verb,
    // and an EXECUTE whose text is assembled so that no verb is visible
    // (`'D' || 'ROP TABLE t'`, `chr(68) || ...`, `reverse(...)`, an escape-
    // encoded literal, a variable built across statements) walked past all of
    // them and dropped the table live. The scanner cannot classify such a
    // statement, and "cannot classify" must not be reported as "clean": that is
    // the consent gate deciding in the author's favour on no evidence. So it
    // asks, with a kind whose label says exactly that.
    for (const block of procedural ? statement.blocks : []) {
      const unreadable = unclassifiableExecute(block);
      if (unreadable === null) continue;
      found.push({
        statement: `${display} [in block: ${unreadable.replace(/\s+/g, ' ').slice(0, 60)}]`,
        kind: 'dynamic-unclassified',
        target: DYNAMIC_TARGET,
      });
      break;
    }
  }
  return found;
}

/**
 * Statement openers that destroy nothing, so an assembled `EXECUTE` whose text
 * visibly begins with one of them is left alone. `UPDATE` is here because its
 * destructive form is the ABSENCE of a `WHERE`, which the tail of an assembled
 * fragment cannot answer; flagging every dynamic `UPDATE ... WHERE` is the
 * false-positive cost this module refuses to pay.
 */
const HARMLESS_OPENER =
  /^(?:SELECT|INSERT|UPDATE|CREATE|COMMENT|GRANT|REVOKE|ANALYZE|ANALYSE|REFRESH|VACUUM|REINDEX|CLUSTER|SET|RESET|SHOW|NOTIFY|LOCK|CALL|PERFORM|EXPLAIN)\b/i;

/**
 * Openers the verb-anchored passes above already decide, one way or the other
 * (`ALTER TABLE ... ADD` is silent there on purpose, `DROP ...` is reported).
 * Reporting them AGAIN here would double-count, or contradict a deliberate
 * silence.
 */
const VERB_HANDLED_OPENER = /^(?:DROP|TRUNCATE|DELETE|ALTER|MERGE|WITH)\b/i;

/**
 * Functions whose FIRST literal argument is the statement text (or its
 * template), so the opener can be read through the call.
 */
const TEMPLATE_FN = /^(?:format|replace|regexp_replace|concat|concat_ws|array_to_string)\s*\(/i;

/** The leading string literal of `text`: its raw content and whether it can hide a verb. */
function leadingLiteral(text: string): { content: string; rest: string; escaped: boolean } | null {
  const m = /^(U&'|[EeBbXx]'|'|\$([A-Za-z_][\w]*)?\$)/.exec(text);
  if (!m) return null;
  const open = m[1]!;
  if (open.startsWith('$')) {
    const close = text.indexOf(open, open.length);
    if (close === -1) return null;
    return { content: text.slice(open.length, close), rest: text.slice(close + open.length), escaped: false };
  }
  // Single-quoted: `''` is an escaped quote inside the literal.
  let i = open.length;
  let content = '';
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'") {
      if (text[i + 1] === "'") {
        content += "'";
        i += 2;
        continue;
      }
      break;
    }
    content += ch;
    i++;
  }
  if (i >= text.length) return null;
  // `E'\x44ROP'` and `U&'\0044ROP'` spell a verb the scanner cannot see; an
  // escape string with no backslash in it hides nothing.
  const escaped = open !== "'" && content.includes('\\');
  return { content, rest: text.slice(i + 1), escaped };
}

/**
 * The first word of the statement an `EXECUTE` argument would run, read as far
 * as the text allows, plus whether the argument is one PLAIN literal (in which
 * case the literal passes already had their chance and this pass stays out).
 * `null` opener = the scanner cannot see a verb at all.
 */
function executeOpener(expr: string): { opener: string | null; plain: boolean } {
  const text = expr.trim();
  const lit = leadingLiteral(text);
  if (lit) {
    const word = /^\s*([A-Za-z_][\w]*)/.exec(lit.content)?.[1] ?? null;
    // Plain: the literal IS the whole argument (bar an INTO / USING clause),
    // spelled without escapes.
    const plain = !lit.escaped && /^\s*(?:;|INTO\b|USING\b|$)/i.test(lit.rest);
    return { opener: lit.escaped ? null : word, plain };
  }
  if (TEMPLATE_FN.test(text)) {
    // Read the opener from the first literal argument that carries a word: a
    // `concat_ws(' ', ...)` separator or a `format('%s', ...)` placeholder is
    // not a verb, and neither is a `concat('DR', 'OP', ...)` fragment.
    const inner = text.slice(text.indexOf('(') + 1);
    let cursor = inner;
    for (let guard = 0; guard < 16; guard++) {
      const lit2 = leadingLiteral(cursor.trimStart());
      if (!lit2) break;
      const word = /^\s*([A-Za-z_][\w]*)/.exec(lit2.content)?.[1];
      if (word) return { opener: lit2.escaped ? null : word, plain: false };
      const comma = lit2.rest.indexOf(',');
      if (comma === -1) break;
      cursor = lit2.rest.slice(comma + 1);
    }
    return { opener: null, plain: false };
  }
  // Any other function call, a parenthesised expression, or a bare variable
  // (`EXECUTE s`, built across earlier statements): nothing readable.
  return { opener: null, plain: false };
}

/**
 * The EXECUTE argument in `body`, when it is assembled or encoded such that no
 * statement verb is visible to the passes above. Returns the offending
 * fragment for display, or `null` when every EXECUTE in the body either is a
 * plain literal (the literal rules own it) or visibly begins with a verb some
 * other rule has already judged.
 */
function unclassifiableExecute(body: string): string | null {
  for (const statement of tokenizeSql(body)) {
    const code = statement.code;
    const m = /\bEXECUTE\s+([\s\S]+)$/i.exec(code);
    if (!m) continue;
    const expr = m[1]!;
    const { opener, plain } = executeOpener(expr);
    if (plain) continue;
    if (opener !== null && (HARMLESS_OPENER.test(opener) || VERB_HANDLED_OPENER.test(opener))) continue;
    return `EXECUTE ${expr}`;
  }
  return null;
}

/** Shown in place of an object name that does not exist until the block runs. */
export const DYNAMIC_TARGET = '<name assembled at run time>';

/**
 * The concatenation operator, and `format()`'s placeholders. Case-sensitive on
 * purpose: `%I`, `%s` and `%L` are the only specifiers `format()` accepts, and
 * folding case here would also match `%i`, which is not one and does occur in
 * prose.
 */
const DYNAMIC_ASSEMBLY = /\|\||%[IsL]/;

/**
 * Functions that BUILD a statement out of parts, looked for anywhere in the
 * fragment (a proximity test, so the list stays tight).
 *
 * `concat` / `concat_ws` are the additions, and they are not a nicety: they are
 * the function spelling of `||`, and the NULL-tolerant one, so they are exactly
 * what an author reaches for when a name may be null. Their absence was
 * fail-open in a safety guard, verified on PostgreSQL 16:
 *
 *   DO $$ BEGIN EXECUTE 'DROP TABLE ' || 'users'; END $$;       -> flagged
 *   DO $$ BEGIN EXECUTE concat('DROP TABLE ', 'users'); END $$; -> NOT flagged
 *
 * Both drop the table. The second reported a clean inventory, so `migrate up`
 * never armed its data-loss prompt and applied the drop with no confirmation
 * and no `--allow-destructive`.
 */
const ASSEMBLY_FN = /\b(?:format|concat_ws|concat|quote_ident|quote_literal|quote_nullable)\s*\(/i;

/**
 * The same question asked of the text BEFORE the verb, and asked PRECISELY: an
 * assembling call whose parenthesis is still OPEN where the verb appears, i.e.
 * the verb is one of that call's arguments (`concat('DROP TABLE ', t)`). That
 * is what `[^)]*$` says, and it is the whole reason a pre-verb test is safe to
 * add at all: this is not "an assembly function is somewhere nearby", it is
 * "the destructive verb is inside one".
 *
 * Being inside an assembling call is still not enough on its own, and the
 * counter-example is not hypothetical, it appeared the first time this ran:
 *
 *   DO $$ BEGIN UPDATE t SET a = regexp_replace(a, 'DROP .*', '') WHERE id = 1; END $$;
 *
 * Nothing there is assembled and nothing is destroyed, but the verb does sit
 * inside a call. So the pre-verb test ALSO requires an `EXECUTE` in the same
 * statement, which is the keyword that turns assembled text into a running
 * statement, and the one thing a data-cleanup expression never has. The
 * statement bound comes free: {@link proceduralCandidates} builds `before` from
 * the candidate's OWN statement, so an `EXECUTE` three statements earlier in
 * the body cannot vouch for this one.
 *
 * Precision is also what lets this list be wider than {@link ASSEMBLY_FN}'s.
 * `array_to_string` joins a list of names into one statement, the shape a
 * drop-many loop collapses to; `replace` / `regexp_replace` are template
 * substitution (`EXECUTE replace('DROP TABLE $t', '$t', name)`). Neither may go
 * in the proximity list: there they would arm the dynamic pass on any body that
 * both mentions a destructive verb and tidies a string, and a guard that fires
 * on innocent migrations teaches operators to confirm without reading, which is
 * this module's other failure mode and costs more than it saves.
 *
 * Deliberately left out entirely: `string_agg` (it aggregates over ROWS, and the
 * per-row half it aggregates is itself a `||` or a `concat` these already
 * catch), `overlay`, and `substr`/`left`/`right` (they cut text down, they do
 * not assemble a statement out of parts).
 */
const WRAPPING_ASSEMBLY_FN =
  /\b(?:format|concat_ws|concat|quote_ident|quote_literal|quote_nullable|array_to_string|regexp_replace|replace)\s*\([^)]*$/i;

/** Dynamic SQL only runs if something runs it. Scoped to the candidate's own statement. */
const RUNS_DYNAMIC_SQL = /\bEXECUTE\b/i;

/**
 * `ALTER TABLE <assembled name> DROP [COLUMN] ...`: the sub-action that loses
 * rows, with the same exclusions as the static `drop-column` rule (`DROP
 * CONSTRAINT` / `DEFAULT` / `NOT NULL` / `IDENTITY` / `EXPRESSION` lose none).
 * Matches when the keyword `COLUMN`, an `IF EXISTS`, or a literal column name
 * follows the `DROP`; a `DROP` followed by nothing literal is handled below.
 * {@link OUTSIDE_QUOTES} keeps `ADD COLUMN "drop me"` out, as it does statically.
 */
const DYNAMIC_ALTER_DROP_COLUMN = new RegExp(
  String.raw`^ALTER\s+TABLE\b${OUTSIDE_QUOTES}\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b)(?:COLUMN\b|IF\s+EXISTS\b|${IDENT})`,
  'i',
);

/** `ALTER TABLE <assembled name> ALTER [COLUMN] <col> [SET DATA] TYPE ...`. */
const DYNAMIC_ALTER_COLUMN_TYPE = new RegExp(
  String.raw`^ALTER\s+TABLE\b${OUTSIDE_QUOTES}\bALTER\s+(?:COLUMN\s+)?${IDENT}\s+(?:SET\s+DATA\s+)?TYPE\b`,
  'i',
);

/** The `DROP <thing>` sub-actions of ALTER TABLE that lose no rows. */
const DYNAMIC_ALTER_DROP_HARMLESS = new RegExp(
  String.raw`^ALTER\s+TABLE\b${OUTSIDE_QUOTES}\bDROP\s+(?:CONSTRAINT|DEFAULT|NOT\s+NULL|IDENTITY|EXPRESSION)\b`,
  'i',
);

/**
 * The kind a runtime-assembled procedural fragment should be reported as, or
 * `null` when it is not dynamic (so a rule already had its chance) or its verb
 * is not one that destroys data on its own.
 *
 * `ALTER TABLE` IS decided here, by the sub-action that follows the assembled
 * table name, because in the shape that matters that sub-action is literal
 * text: a multi-tenant loop assembles the TABLE (`'ALTER TABLE ' ||
 * quote_ident(t) || ' DROP COLUMN legacy_phone'`) and writes out what it does
 * to it. That statement dropped the column from every tenant table while the
 * scan reported a clean inventory, and its `DROP TABLE` twin was already being
 * flagged, so an operator who had seen the guard fire once would assume this
 * was covered. Only the forms that lose rows are reported (`DROP [COLUMN]`,
 * `ALTER COLUMN ... TYPE`), with the same exclusions as their static rules; an
 * assembled `ADD COLUMN` stays silent. A `DROP` whose object is itself in the
 * runtime expression (`' DROP ' || what`) is `dynamic-destructive`, the bare
 * `DROP` precedent below: alarming is fine, wrong is not.
 *
 * `UPDATE` is still deliberately absent even though {@link proceduralCandidates}
 * collects it: its destructive form is the ABSENCE of a `WHERE`, and absence
 * is not decidable from a fragment whose tail is a runtime expression, so
 * including it would flag every dynamic `UPDATE ... WHERE` in the file.
 */
function dynamicDestructiveKind({ text, before }: ProceduralCandidate): DestructiveKind | null {
  const assembled =
    DYNAMIC_ASSEMBLY.test(text) ||
    ASSEMBLY_FN.test(text) ||
    (RUNS_DYNAMIC_SQL.test(before) && WRAPPING_ASSEMBLY_FN.test(before));
  if (!assembled) return null;
  if (/^ALTER\s+TABLE\b/i.test(text)) {
    if (DYNAMIC_ALTER_DROP_COLUMN.test(text)) return 'drop-column';
    if (DYNAMIC_ALTER_COLUMN_TYPE.test(text)) return 'alter-column-type';
    if (DYNAMIC_ALTER_DROP_HARMLESS.test(text)) return null;
    if (new RegExp(String.raw`^ALTER\s+TABLE\b${OUTSIDE_QUOTES}\bDROP\b`, 'i').test(text)) return 'dynamic-destructive';
    return null;
  }
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
