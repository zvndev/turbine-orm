/**
 * PII tags for tools that build their schema from live introspection.
 *
 * `ColumnMetadata.pii` is a CODE-FIRST declaration: it comes from
 * `defineSchema({ pii: true })` or the fluent `.pii()`, and `introspect.ts`
 * never sets it (there is no reliable way to infer "this column holds personal
 * data" from a Postgres catalog, and guessing would be worse than not trying).
 *
 * Studio and the MCP server introspect a live database, so on their own they
 * see NO tags at all and their redaction is inert. This module closes that gap
 * by reading the tags out of the generated `metadata.ts` that `turbine
 * generate` writes, and handing back a table -> column-name map the caller
 * layers onto its introspected metadata.
 *
 * The generated file is TypeScript in the user's project, so a compiled CLI
 * cannot import it (there is no TS loader in the published `dist`, and running
 * user code to learn which columns to hide would be a worse trade than reading
 * it). It is read as TEXT and scanned STRUCTURALLY. Nothing is executed.
 *
 * WHY STRUCTURALLY, and not with line-anchored regexes (which is what this did
 * until it was found to fail open): the old scan required exactly 8 leading
 * spaces, single-quoted keys, and the whole column object on ONE line. Real
 * emitted column lines run past 120 characters, which is this repo's own Biome
 * `lineWidth`, so ANY formatter run over a user's generated directory rewraps
 * them and every tag silently disappears. Redaction then reported success with
 * an empty column list, indistinguishable from "this table has no PII". The
 * scanner below is whitespace-, quote-, and line-break-insensitive, and when it
 * cannot find the structure at all it says so (`PiiScan.ok === false`) instead
 * of returning an empty map that reads like a clean bill of health. Callers are
 * expected to FAIL CLOSED on `ok === false`.
 *
 * "Cannot find the structure" includes a file that STOPS PART-WAY. A tag is
 * recorded only when its column object CLOSES, so a metadata.ts cut short by an
 * interrupted `turbine generate`, a full disk, or a merge conflict yields fewer
 * tags than the file declares, and every scan-level signal (a `tables:` map, a
 * column object) is already present by then. The scan therefore also requires
 * that the tokenizer reached the end of the file cleanly and that every `{`/`[`
 * it opened was closed; a leftover frame means the tail was lost, and the tags
 * from the lost tail with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Table name -> the snake_case column names tagged `pii: true`. */
export type PiiTagMap = Record<string, string[]>;

/**
 * Outcome of scanning one generated-metadata file.
 *
 * `ok: false` means the scan could not prove anything about this file: it did
 * not look like `generateMetadata` output (no `tables:` map, or not a single
 * parsable column object), or it did not parse to completion (it ends inside a
 * string, a comment, or an unclosed object). An empty `tags` with `ok: true` is
 * a real "no tagged columns"; an empty `tags` with `ok: false` is "we do not
 * know", and the two must never be treated the same way. Nor is a NON-empty
 * `tags` with `ok: false` usable: a truncated file's surviving tags are a
 * prefix of the real set, so trusting them still under-redacts.
 */
export interface PiiScan {
  tags: PiiTagMap;
  ok: boolean;
  /** Human-readable cause, present only when `ok` is false. */
  reason?: string;
  /** Table entries seen under `tables:`. */
  tablesSeen: number;
  /** Column objects seen under any table's `columns:` list, tagged or not. */
  columnsSeen: number;
}

export interface PiiTagSource {
  /** Absolute path that was read. */
  path: string;
  tags: PiiTagMap;
  /** Total tagged columns, across tables. */
  count: number;
  /** Full scan outcome. Callers that can fail closed should read `scan.ok`. */
  scan: PiiScan;
}

type TokenKind = 'string' | 'word' | 'punct';

interface Token {
  kind: TokenKind;
  value: string;
}

const WORD_CHAR = /[A-Za-z0-9_$.]/;

interface TokenStream {
  tokens: Token[];
  /** Set when the source ends inside a token, i.e. the file is cut short. */
  truncated: string | null;
}

/**
 * Tokenize generated-metadata source far enough to walk its object structure:
 * strings (all three quote styles, backslash escapes honoured), bare words, and
 * single-character punctuation. Comments are skipped.
 *
 * Strings are a distinct token kind on purpose: a column's `definition` field
 * carries raw index DDL, which contains braces and parentheses. Treating that
 * text as structure would desynchronize the brace depth and silently drop every
 * later table.
 *
 * A string or block comment that never closes is REPORTED rather than accepted:
 * that is a half-written file, and the tokens before the cut are a partial view
 * of the tags in it.
 */
function tokenize(source: string): TokenStream {
  const tokens: Token[] = [];
  let truncated: string | null = null;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i]!;

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++;
      continue;
    }

    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) truncated = 'the file ends inside an unterminated block comment';
      i = end === -1 ? n : end + 2;
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let out = '';
      let closed = false;
      i++;
      while (i < n) {
        const c = source[i]!;
        if (c === '\\') {
          // Only the escapes `escSQ` and JSON.stringify can emit matter here;
          // anything else is passed through as its literal second character.
          const next = source[i + 1];
          if (next === undefined) break;
          out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
          continue;
        }
        if (c === quote) {
          i++;
          closed = true;
          break;
        }
        out += c;
        i++;
      }
      if (!closed) truncated = 'the file ends inside an unterminated string literal';
      tokens.push({ kind: 'string', value: out });
      continue;
    }

    if (WORD_CHAR.test(ch)) {
      let out = '';
      while (i < n && WORD_CHAR.test(source[i]!)) {
        out += source[i]!;
        i++;
      }
      tokens.push({ kind: 'word', value: out });
      continue;
    }

    tokens.push({ kind: 'punct', value: ch });
    i++;
  }

  return { tokens, truncated };
}

interface Frame {
  /** The object key that introduced this container, or null for an array element. */
  key: string | null;
  /** Collected fields, populated only for a frame that IS a column object. */
  column?: { name?: string; pii?: boolean };
}

/**
 * True when `stack`'s innermost frame is a column object, i.e. the path ends
 * `... tables -> <tableName> -> columns -> <array element>`.
 *
 * Checking the TAIL rather than an absolute depth is what makes this survive
 * the wrapper the generator puts around the map (`export const SCHEMA: ... = {`)
 * and any future nesting change above `tables`. It also keeps unrelated
 * `columns:` lists out: an index entry's `columns` sits under
 * `... -> indexes -> <element> -> columns`, whose great-grandparent is
 * `indexes`, not `tables`.
 */
function isColumnFrame(stack: Frame[]): boolean {
  const len = stack.length;
  if (len < 4) return false;
  return (
    stack[len - 1]!.key === null && stack[len - 2]!.key === 'columns' && stack[len - 4]!.key === 'tables'
    // stack[len - 3] is the table name; any name is valid, so it is not checked.
  );
}

/**
 * Scan generated-metadata source text for PII-tagged columns, reporting whether
 * the scan actually understood the file.
 *
 * Exported for testing and for callers that need to fail closed; the plain-map
 * convenience wrapper is {@link parsePiiTags}.
 */
export function scanPiiTags(source: string): PiiScan {
  const tags: PiiTagMap = {};
  const stack: Frame[] = [];
  const tableNames = new Set<string>();
  let columnsSeen = 0;
  let sawTablesMap = false;
  let unbalancedClose = false;
  let pendingKey: string | null = null;

  const { tokens, truncated } = tokenize(source);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token.kind === 'punct' && (token.value === '{' || token.value === '[')) {
      const frame: Frame = { key: pendingKey };
      pendingKey = null;
      stack.push(frame);
      if (frame.key === 'tables') sawTablesMap = true;
      if (token.value === '{' && isColumnFrame(stack)) {
        frame.column = {};
        columnsSeen++;
        const tableName = stack[stack.length - 3]!.key;
        if (tableName !== null) tableNames.add(tableName);
      }
      continue;
    }

    if (token.kind === 'punct' && (token.value === '}' || token.value === ']')) {
      const frame = stack.pop();
      // More closers than openers: the walk is no longer tracking real depth,
      // so `isColumnFrame` can no longer be trusted for the rest of the file.
      if (frame === undefined) unbalancedClose = true;
      pendingKey = null;
      const column = frame?.column;
      if (column?.pii === true && column.name !== undefined) {
        // stack was already popped, so the table name is now the last-but-one.
        const tableName = stack[stack.length - 2]?.key;
        if (tableName) {
          const list = tags[tableName] ?? [];
          list.push(column.name);
          tags[tableName] = list;
        }
      }
      continue;
    }

    // `<key>:` opens a member. Two things happen: the key becomes the label for
    // whatever container may follow, and, inside a column object, a scalar value
    // on the same member is captured directly.
    const next = tokens[i + 1];
    if ((token.kind === 'string' || token.kind === 'word') && next?.kind === 'punct' && next.value === ':') {
      pendingKey = token.value;
      const column = stack[stack.length - 1]?.column;
      const value = tokens[i + 2];
      if (column && value && !(value.kind === 'punct' && (value.value === '{' || value.value === '['))) {
        if (token.value === 'name' && value.kind === 'string') column.name = value.value;
        else if (token.value === 'pii' && value.kind === 'word' && value.value === 'true') column.pii = true;
      }
    }
  }

  const tablesSeen = tableNames.size;
  let reason: string | undefined;
  // Truncation is checked FIRST and independently of what was found. A file cut
  // short mid-write still contains a `tables:` map and parsable columns, so the
  // "did this look like generated metadata" questions all answer yes while the
  // tags after the cut are simply missing. That is the shape this scan used to
  // report as `ok: true` with a short tag list.
  if (truncated) reason = `${truncated}; the generated metadata file looks truncated`;
  else if (stack.length > 0) {
    reason =
      `the file ends with ${stack.length} unclosed object/array level(s); the generated metadata file looks ` +
      `truncated, so any tags after the cut were not seen`;
  } else if (unbalancedClose) reason = 'unbalanced `}`/`]` in the file, so its object structure could not be tracked';
  else if (!sawTablesMap) reason = 'no `tables:` map found; this does not look like generated Turbine metadata';
  else if (columnsSeen === 0) reason = 'found a `tables:` map but no parsable column objects inside it';

  return { tags, ok: reason === undefined, reason, tablesSeen, columnsSeen };
}

/**
 * Tag map only. Kept for callers that already treat "no tags" as safe; anything
 * that redacts should prefer {@link scanPiiTags} so it can see a failed scan.
 */
export function parsePiiTags(source: string): PiiTagMap {
  return scanPiiTags(source).tags;
}

/**
 * Read PII tags from the generated metadata in `outDir`, or return `null` when
 * there is no readable generated metadata there. Never throws.
 *
 * A returned source with `scan.ok === false` means a file WAS found and could
 * not be understood: that is strictly worse than no file at all, because the
 * user believes their tags are in force. Callers must not treat it as "no PII".
 */
export function loadPiiTags(outDir: string): PiiTagSource | null {
  for (const file of ['metadata.ts', 'metadata.js']) {
    const path = join(outDir, file);
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const scan = scanPiiTags(source);
    const count = Object.values(scan.tags).reduce((n, cols) => n + cols.length, 0);
    return { path, tags: scan.tags, count, scan };
  }
  return null;
}

/**
 * Apply `tags` to introspected metadata, in place. Only columns that exist in
 * the live schema are tagged, so a stale generated file can never invent one.
 * Returns the number of columns actually tagged.
 */
export function applyPiiTags(
  metadata: { tables: Record<string, { columns: { name: string; pii?: boolean }[] }> },
  tags: PiiTagMap,
): number {
  let applied = 0;
  for (const [tableName, columns] of Object.entries(tags)) {
    const table = Object.hasOwn(metadata.tables, tableName) ? metadata.tables[tableName] : undefined;
    if (!table) continue;
    for (const col of table.columns) {
      if (columns.includes(col.name)) {
        col.pii = true;
        applied++;
      }
    }
  }
  return applied;
}
