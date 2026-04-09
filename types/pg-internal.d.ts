/**
 * Ambient type declarations for pg internal modules.
 *
 * These modules are publicly exported via pg's package.json `exports` map:
 *   "exports": { "./lib/*": "./lib/*.js" }
 *
 * They are stable internal APIs used by pg-cursor, pg-query-stream, and
 * other first-party pg ecosystem packages.
 */

declare module 'pg/lib/utils' {
  /**
   * Converts JavaScript values to their Postgres wire-protocol representations.
   * Handles null, Buffer, Date, Array, and objects with `.toPostgres()`.
   */
  export function prepareValue(value: unknown): unknown;

  export function normalizeQueryConfig(
    config: string | Record<string, unknown>,
    values?: unknown[] | ((...args: unknown[]) => unknown),
    callback?: (...args: unknown[]) => unknown,
  ): Record<string, unknown>;

  export function escapeIdentifier(str: string): string;
  export function escapeLiteral(str: string): string;
}

declare module 'pg/lib/result' {
  /**
   * Result accumulator used internally by pg.Query.
   * Collects field descriptions, parses rows, and tracks command completion.
   */
  class Result {
    command: string | null;
    rowCount: number | null;
    oid: number | null;
    rows: Record<string, unknown>[];
    fields: Array<{
      name: string;
      dataTypeID: number;
      format?: string;
    }>;

    /**
     * @param rowMode - 'array' for array rows, undefined for object rows
     * @param types - Type parser override (e.g. client._types)
     */
    constructor(rowMode?: string, types?: unknown);

    /** Register field descriptions from a RowDescription message */
    addFields(
      fieldDescriptions: Array<{
        name: string;
        dataTypeID: number;
        format?: string;
      }>,
    ): void;

    /** Parse a dataRow message's fields into a row object/array */
    parseRow(
      rowData: Array<string | null>,
    ): Record<string, unknown>;

    /** Push a parsed row into the rows array */
    addRow(row: Record<string, unknown>): void;

    /** Process a CommandComplete message */
    addCommandComplete(msg: { text?: string; command?: string }): void;
  }

  export = Result;
}
