/**
 * @batadata/turbine/serverless — HTTP-based query driver for edge functions
 *
 * Use this driver when you cannot establish a direct TCP connection to Postgres
 * (e.g., Vercel Edge Functions, Cloudflare Workers, Deno Deploy).
 *
 * It sends queries as JSON over HTTP to a Turbine query endpoint, which executes
 * them against the actual database and returns typed results.
 *
 * NOTE: This is a scaffold. The server-side query endpoint does not exist yet.
 * The HTTP protocol and response format are defined here and will be implemented
 * on the server side in a future release.
 *
 * @example
 * ```ts
 * import { createServerlessClient } from '@batadata/turbine/serverless';
 *
 * const db = createServerlessClient({
 *   endpoint: 'https://your-turbine-proxy.fly.dev/query',
 *   authToken: process.env.TURBINE_AUTH_TOKEN!,
 * });
 *
 * const result = await db.query('SELECT * FROM users WHERE id = $1', [1]);
 * ```
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the serverless HTTP driver */
export interface ServerlessConfig {
  /** URL of the Turbine query endpoint (e.g. https://proxy.example.com/query) */
  endpoint: string;
  /** Authentication token for the endpoint */
  authToken: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeout?: number;
  /** Custom fetch implementation (defaults to global fetch) */
  fetch?: typeof globalThis.fetch;
  /** Custom headers to include with every request */
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Query types — the HTTP protocol between client and server
// ---------------------------------------------------------------------------

/** A single SQL query to execute */
export interface QueryRequest {
  /** SQL query string with $1, $2, ... parameter placeholders */
  sql: string;
  /** Parameter values */
  params?: unknown[];
  /** Hint for the server about expected result shape */
  mode?: 'rows' | 'one' | 'count' | 'void';
}

/** Batch of queries to execute in a single round-trip */
export interface BatchRequest {
  queries: QueryRequest[];
  /** Whether to wrap the batch in a transaction */
  transaction?: boolean;
}

/** Response from the query endpoint for a single query */
export interface QueryResponse<T = Record<string, unknown>> {
  /** Returned rows */
  rows: T[];
  /** Number of rows affected (for INSERT/UPDATE/DELETE) */
  rowCount: number;
  /** Column metadata */
  fields?: Array<{ name: string; dataTypeID: number }>;
  /** Server-side execution time in milliseconds */
  durationMs?: number;
}

/** Response from the query endpoint for a batch */
export interface BatchResponse {
  results: QueryResponse[];
  /** Total server-side execution time in milliseconds */
  totalDurationMs?: number;
}

/** Error response from the query endpoint */
export interface QueryError {
  error: string;
  code?: string;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Serverless client
// ---------------------------------------------------------------------------

/**
 * HTTP-based Postgres query client for serverless/edge environments.
 *
 * Sends SQL queries as JSON POST requests to a Turbine query endpoint.
 * Does not require a direct TCP connection to Postgres.
 */
export class ServerlessClient {
  private readonly config: Required<Pick<ServerlessConfig, 'endpoint' | 'authToken' | 'timeout'>> & ServerlessConfig;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(config: ServerlessConfig) {
    if (!config.endpoint) {
      throw new Error('[turbine/serverless] endpoint is required');
    }
    if (!config.authToken) {
      throw new Error('[turbine/serverless] authToken is required');
    }

    this.config = {
      ...config,
      timeout: config.timeout ?? 10_000,
    };
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  /**
   * Execute a single SQL query.
   *
   * @param sql - SQL string with $1, $2, ... placeholders
   * @param params - Parameter values
   * @returns Query result with typed rows
   *
   * @example
   * ```ts
   * const result = await client.query<{ id: number; name: string }>(
   *   'SELECT id, name FROM users WHERE org_id = $1',
   *   [42]
   * );
   * console.log(result.rows);
   * ```
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResponse<T>> {
    const request: QueryRequest = { sql, params, mode: 'rows' };
    const response = await this.post<QueryResponse<T>>('/query', request);
    return response;
  }

  /**
   * Execute a single SQL query and return the first row, or null.
   */
  async queryOne<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<T | null> {
    const request: QueryRequest = { sql, params, mode: 'one' };
    const response = await this.post<QueryResponse<T>>('/query', request);
    return response.rows[0] ?? null;
  }

  /**
   * Execute a batch of queries in a single HTTP request.
   * Optionally wraps them in a transaction.
   *
   * @param queries - Array of queries to execute
   * @param options - Batch options
   * @returns Array of results, one per query
   *
   * @example
   * ```ts
   * const results = await client.batch([
   *   { sql: 'SELECT * FROM users WHERE id = $1', params: [1] },
   *   { sql: 'SELECT COUNT(*) FROM posts WHERE user_id = $1', params: [1] },
   * ], { transaction: true });
   * ```
   */
  async batch(
    queries: QueryRequest[],
    options?: { transaction?: boolean },
  ): Promise<BatchResponse> {
    const request: BatchRequest = {
      queries,
      transaction: options?.transaction ?? false,
    };
    return this.post<BatchResponse>('/batch', request);
  }

  /**
   * Tagged template helper for SQL queries.
   *
   * @example
   * ```ts
   * const users = await client.sql<{ id: number; name: string }>`
   *   SELECT id, name FROM users WHERE org_id = ${orgId}
   * `;
   * ```
   */
  async sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]> {
    let sqlStr = '';
    strings.forEach((str, i) => {
      sqlStr += str;
      if (i < values.length) {
        sqlStr += `$${i + 1}`;
      }
    });
    const result = await this.query<T>(sqlStr, values);
    return result.rows;
  }

  // -------------------------------------------------------------------------
  // Internal HTTP transport
  // -------------------------------------------------------------------------

  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = this.config.endpoint.replace(/\/$/, '') + path;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.authToken}`,
          'User-Agent': '@batadata/turbine-serverless',
          ...this.config.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let parsed: QueryError | undefined;
        try {
          parsed = JSON.parse(errorBody) as QueryError;
        } catch {
          // Not JSON
        }

        const message = parsed?.error ?? `HTTP ${response.status}: ${errorBody.slice(0, 200)}`;
        const err = new Error(`[turbine/serverless] ${message}`) as unknown as Record<string, unknown>;
        err['status'] = response.status;
        err['code'] = parsed?.code;
        throw err;
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(
          `[turbine/serverless] Request timed out after ${this.config.timeout}ms`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a serverless Turbine client for edge/serverless environments.
 *
 * @param config - Endpoint URL and auth token
 * @returns A ServerlessClient instance
 *
 * @example
 * ```ts
 * import { createServerlessClient } from '@batadata/turbine/serverless';
 *
 * const db = createServerlessClient({
 *   endpoint: process.env.TURBINE_ENDPOINT!,
 *   authToken: process.env.TURBINE_AUTH_TOKEN!,
 * });
 *
 * const users = await db.sql`SELECT * FROM users LIMIT 10`;
 * ```
 */
export function createServerlessClient(config: ServerlessConfig): ServerlessClient {
  return new ServerlessClient(config);
}
