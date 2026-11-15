/** Structural subset of Cloudflare's Worker D1 binding, with no runtime peer. */
export interface D1Result<Row = Record<string, unknown>> {
  success: boolean;
  results: Row[];
  meta: {
    changes: number;
    duration: number;
    last_row_id: number;
    [key: string]: unknown;
  };
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  all<Row = Record<string, unknown>>(): Promise<D1Result<Row>>;
}

/** Accepts the real D1Database binding. No connection or close method is invented. */
export interface D1DatabaseBinding {
  prepare(sql: string): D1PreparedStatement;
  batch<Row = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]>;
}

export interface D1Statement {
  sql: string;
  params?: readonly unknown[];
}

export interface D1BatchOptions {
  /** Checked before dispatch. D1 cannot abort an already dispatched batch. */
  signal?: AbortSignal;
}
