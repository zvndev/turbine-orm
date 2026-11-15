/** Minimal declarations for the native synchronous driver used by this lane. */
declare module 'better-sqlite3' {
  export interface RunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  export interface Options {
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
  }
  export interface Statement {
    get(...params: unknown[]): Record<string, unknown> | undefined;
    all(...params: unknown[]): Record<string, unknown>[];
    run(...params: unknown[]): RunResult;
    iterate(...params: unknown[]): IterableIterator<Record<string, unknown>>;
  }
  export interface Database {
    readonly open: boolean;
    readonly inTransaction: boolean;
    prepare(sql: string): Statement;
    exec(sql: string): this;
    pragma(sql: string): unknown;
    close(): void;
  }
  const BetterSqlite3: { new (path: string, options?: Options): Database };
  export default BetterSqlite3;
}
declare module '*postgres-pagination/corpus.mjs' {
  export const PAGE: number;
  export const CASES: {
    id: string;
    tiny?: boolean;
    parents?: boolean;
    selective?: boolean;
    desc?: boolean;
    offset: number;
  }[];
}
