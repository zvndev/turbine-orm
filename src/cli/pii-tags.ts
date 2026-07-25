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
 * generate` writes, and handing back a table → column-name map the caller
 * layers onto its introspected metadata.
 *
 * The generated file is TypeScript in the user's project, so it cannot simply
 * be imported by a compiled CLI. It is read as TEXT and scanned for the exact
 * shapes `generate.ts` emits (`serializeColumn`: one column object per line,
 * `pii: true` only when tagged). Nothing is executed. A file that does not
 * parse yields no tags, and the caller decides what to say about that.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Table name → the snake_case column names tagged `pii: true`. */
export type PiiTagMap = Record<string, string[]>;

export interface PiiTagSource {
  /** Absolute path that was read. */
  path: string;
  tags: PiiTagMap;
  /** Total tagged columns, across tables. */
  count: number;
}

/** `    <table>: {` at the table-entry indentation `generateMetadata` emits. */
const TABLE_HEAD = /^ {4}(?:'([^']+)'|([A-Za-z_$][\w$]*)): \{$/;
/** A serialized column object; `pii: true` is emitted only when tagged. */
const COLUMN_LINE = /^ {8}\{ name: '([^']+)'.*\bpii: true\b/;
/** `      columns: [` opens the column list; `      ],` closes it. */
const COLUMNS_OPEN = /^ {6}columns: \[$/;
const COLUMNS_CLOSE = /^ {6}\],$/;

/**
 * Scan generated-metadata source text for PII-tagged columns.
 *
 * Exported for testing; callers normally use {@link loadPiiTags}.
 */
export function parsePiiTags(source: string): PiiTagMap {
  const tags: PiiTagMap = {};
  let table: string | null = null;
  let inColumns = false;

  for (const line of source.split('\n')) {
    const head = TABLE_HEAD.exec(line);
    if (head) {
      table = head[1] ?? head[2] ?? null;
      inColumns = false;
      continue;
    }
    if (!table) continue;
    if (COLUMNS_OPEN.test(line)) {
      inColumns = true;
      continue;
    }
    if (inColumns && COLUMNS_CLOSE.test(line)) {
      inColumns = false;
      continue;
    }
    if (!inColumns) continue;
    const col = COLUMN_LINE.exec(line);
    if (col?.[1]) {
      const list = tags[table] ?? [];
      list.push(col[1]);
      tags[table] = list;
    }
  }
  return tags;
}

/**
 * Read PII tags from the generated metadata in `outDir`, or return `null` when
 * there is no readable generated metadata there. Never throws.
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
    const tags = parsePiiTags(source);
    const count = Object.values(tags).reduce((n, cols) => n + cols.length, 0);
    return { path, tags, count };
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
