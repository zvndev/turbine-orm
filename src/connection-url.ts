/**
 * Connection-string inspection: pooler detection, and connection-time GUCs.
 *
 * A pure leaf. It imports nothing (not even `pg`), so every consumer, the CLI,
 * the statistics collectors, and the tests, reads the same rules without
 * dragging a driver in.
 *
 * ## Why this file exists
 *
 * A **transaction-pooling** proxy (PgBouncer, a Neon `-pooler` endpoint,
 * Supabase's pooler) does not give a client its own server backend. It
 * multiplexes many clients onto a few shared backends and hands a backend back
 * to the pool at the end of each TRANSACTION, without running `DISCARD ALL`.
 * Two consequences drive everything below:
 *
 *   1. A session-level `SET` issued outside an explicit transaction attaches to
 *      whichever shared backend served that statement, and stays there for the
 *      next client that gets it. A `SET statement_timeout` meant to bound one
 *      tool's own reads becomes a setting imposed on an application's queries.
 *      This is a production-incident class, not a theoretical one.
 *   2. Session-scoped catalogs (`pg_prepared_statements` above all) describe
 *      whichever backend answered, which through a pooler is not "your" session
 *      in any useful sense.
 *
 * So there are two jobs here. {@link withStatementTimeoutOption} removes the
 * need for the `SET` in (1) by moving the GUC into the connection's startup
 * parameters, the same mechanism `TurbineClient` uses for `plan_cache_mode`.
 * {@link detectPooler} lets a command that depends on session semantics refuse
 * the endpoint outright rather than degrade silently.
 *
 * NEITHER is a substitute for the other. The connection parameter is what makes
 * the collectors safe for any caller; the refusal is what keeps a diagnostic
 * command from reporting confidently about a connection it cannot reason about.
 */

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Host and port pulled out of a connection string, `null` when not stated. */
export interface ConnectionTarget {
  /** Lower-cased hostname, or `null` for a unix socket / unparseable string. */
  host: string | null;
  /** Port number, or `null` when the string does not name one. */
  port: number | null;
}

/**
 * Host and port from a connection string, in either shape libpq accepts.
 *
 * URL form (`postgres://user:pw@host:5432/db`) goes through `URL`; the
 * key/value DSN form (`host=db.example.com port=6543 dbname=app`) falls back to
 * a scan. An unparseable string yields `{ host: null, port: null }`, which every
 * caller here treats as "no evidence", never as "safe".
 */
export function parseConnectionTarget(connectionString: string): ConnectionTarget {
  const trimmed = connectionString.trim();
  if (trimmed === '') return { host: null, port: null };

  try {
    const url = new URL(trimmed);
    // A `postgresql:///db?host=/var/run/postgresql` unix socket parses with an
    // empty hostname. Report it as absent rather than as the empty string.
    const host = url.hostname === '' ? null : url.hostname.toLowerCase();
    const port = url.port === '' ? null : Number.parseInt(url.port, 10);
    return { host, port: port !== null && Number.isInteger(port) ? port : null };
  } catch {
    // Not a URL: try the key/value DSN form. Unquoted values only, which is
    // what a host or a port is in practice.
    const hostMatch = /(?:^|\s)host\s*=\s*([^\s'"]+)/i.exec(trimmed);
    const portMatch = /(?:^|\s)port\s*=\s*(\d+)/i.exec(trimmed);
    const host = hostMatch?.[1]?.toLowerCase() ?? null;
    const port = portMatch?.[1] !== undefined ? Number.parseInt(portMatch[1], 10) : null;
    return { host: host === '' ? null : host, port: port !== null && Number.isInteger(port) ? port : null };
  }
}

// ---------------------------------------------------------------------------
// Pooler detection
// ---------------------------------------------------------------------------

/**
 * Hostname tokens that name a pooler.
 *
 * Matched as whole dot/dash/underscore-delimited TOKENS (with an optional
 * trailing instance number), never as substrings of the connection string.
 * Substring matching is what makes this class of check untrustworthy: a
 * database named `poolers`, a role named `pooler_admin`, or a host called
 * `spooler.internal` all contain the letters and none of them is a pooler, and
 * a detector that cries wolf gets disabled by the first person it blocks.
 */
export const POOLER_HOST_TOKENS: readonly string[] = Object.freeze(['pooler', 'pgbouncer']);

/**
 * Ports that name a pooler on their own.
 *
 * 6543 is the transaction-pooling port of the hosted poolers people point a CLI
 * at. 6432 is PgBouncer's own documented default `listen_port`, so anyone who
 * ran PgBouncer without changing it is here.
 *
 * The counter-argument to 6432 is that it refuses someone running plain
 * Postgres on a non-standard port. That is true and it is the right trade,
 * because the two errors do not cost the same: a false positive costs one
 * `--allow-pooler` flag on a command the user is running interactively and
 * reading the output of, while a false negative is silently the exact hazard
 * this gate exists to prevent. When a detector's errors are asymmetric, tune it
 * toward the cheap one.
 */
export const POOLER_PORTS: readonly number[] = Object.freeze([6543, 6432]);

/** Which rule fired, for a message that can say exactly what it saw. */
export type PoolerSignal = 'host' | 'port';

export interface PoolerDetection {
  /** True when the connection string looks like a transaction-pooling endpoint. */
  pooled: boolean;
  /** The rule that fired, or `null` when nothing did. */
  signal: PoolerSignal | null;
  host: string | null;
  port: number | null;
  /** The token that matched, for a `host` signal. */
  matchedToken: string | null;
  /**
   * The direct hostname, when it is DERIVABLE rather than guessed: only the
   * in-label `-pooler` / `-pgbouncer` suffix form (Neon's
   * `ep-x-pooler.<region>.aws.neon.tech`) yields one. When the token is a whole
   * label the direct endpoint is a different name entirely (Supabase's pooler
   * is `<region>.pooler.supabase.com` while its direct host is
   * `db.<ref>.supabase.co`), so this stays `null` rather than inventing a
   * hostname that does not resolve.
   */
  directHost: string | null;
}

/** The "nothing detected" result, so callers never build one by hand. */
function noPooler(target: ConnectionTarget): PoolerDetection {
  return { pooled: false, signal: null, host: target.host, port: target.port, matchedToken: null, directHost: null };
}

/**
 * Whether a connection string points at a transaction-pooling proxy.
 *
 * Deliberately conservative: it answers from the endpoint's SHAPE (hostname
 * tokens, port), because there is no way to ask a pooler what it is without
 * connecting through it, and the whole point is to decide before connecting.
 * A false negative leaves the caller where it already was; a false positive
 * blocks a legitimate database, so precision wins and the caller is expected to
 * offer an override.
 */
export function detectPooler(connectionString: string): PoolerDetection {
  const target = parseConnectionTarget(connectionString);

  if (target.host !== null) {
    for (const label of target.host.split('.')) {
      for (const token of label.split(/[-_]/)) {
        // `pooler`, `pgbouncer`, and numbered instances of either (`pooler2`).
        const base = /^([a-z]+)\d*$/.exec(token)?.[1] ?? token;
        if (POOLER_HOST_TOKENS.includes(base)) {
          return {
            pooled: true,
            signal: 'host',
            host: target.host,
            port: target.port,
            matchedToken: token,
            directHost: deriveDirectHost(target.host, token),
          };
        }
      }
    }
  }

  if (target.port !== null && POOLER_PORTS.includes(target.port)) {
    return {
      pooled: true,
      signal: 'port',
      host: target.host,
      port: target.port,
      matchedToken: null,
      directHost: null,
    };
  }

  return noPooler(target);
}

/**
 * `host` with an in-label `-<token>` pooler suffix removed, or `null`.
 *
 * Only the suffix form is derivable, see {@link PoolerDetection.directHost}.
 */
function deriveDirectHost(host: string, token: string): string | null {
  const labels = host.split('.');
  let changed = false;
  const rewritten = labels.map((label) => {
    if (changed) return label;
    // The token must be a trailing segment of a MULTI-segment label, so
    // `pooler.supabase.com` (a whole label) is not rewritten.
    const suffix = `-${token}`;
    if (label.length > suffix.length && label.endsWith(suffix)) {
      changed = true;
      return label.slice(0, -suffix.length);
    }
    return label;
  });
  return changed ? rewritten.join('.') : null;
}

// ---------------------------------------------------------------------------
// The refusal
// ---------------------------------------------------------------------------

export interface PoolerRefusalOptions {
  /** The command being refused, e.g. `turbine doctor`. */
  command: string;
  /** The flag that overrides the refusal, e.g. `--allow-pooler`. */
  allowFlag: string;
}

/**
 * The lines a command prints when it refuses a pooler endpoint.
 *
 * Plain text, no colour and no `console` call, so it is assertable in a unit
 * test and reusable by any command that grows the same gate.
 */
export function poolerRefusalMessage(detection: PoolerDetection, options: PoolerRefusalOptions): string[] {
  const what =
    detection.signal === 'port'
      ? `port ${detection.port} is a transaction-pooling port`
      : `the hostname contains "${detection.matchedToken}"`;
  const where = detection.host ?? '(host not stated)';

  const lines = [
    `${options.command} refuses to run through a connection pooler.`,
    '',
    `  Endpoint: ${where}${detection.port === null ? '' : `:${detection.port}`}`,
    `  Detected: ${what}`,
    '',
    'A transaction pooler (PgBouncer, a Neon "-pooler" endpoint, Supabase\'s pooler) does not',
    'give a client its own server backend. It multiplexes many clients onto a few shared',
    'backends and reuses one as soon as a transaction ends, so:',
    '',
    '  1. Session state is not private. Anything this command sets on the session can be left',
    '     behind for another client, and whatever an earlier client left behind can be in',
    '     force for this one. That is how a "read-only guardrail" becomes an outage.',
    '  2. Session-scoped views describe the wrong session. pg_prepared_statements, which this',
    '     report tells you to read to confirm a cached plan, belongs to whichever backend',
    '     answered, not to your application.',
    '  3. The read bounds may not apply. This command asks for its statement_timeout as a',
    '     connection parameter, and a pooler is free to drop or reject one.',
    '',
    'Use the DIRECT (non-pooled) endpoint for the same database instead.',
  ];

  if (detection.directHost !== null) {
    lines.push('', `  ${detection.host}`, `  -> ${detection.directHost}`);
    lines.push('', 'That is the same connection string with the pooler marker removed from the host.');
  } else {
    lines.push(
      '',
      'On a managed provider that is the "direct" or "session" connection string in your',
      'dashboard, not the pooled one. Self-hosted, it is the Postgres host itself rather',
      'than the proxy in front of it.',
    );
  }

  lines.push('', `If you are certain this endpoint is not a transaction pooler, re-run with ${options.allowFlag}.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Connection-time statement_timeout
// ---------------------------------------------------------------------------

/** A pg pool/client config, narrowed to the two fields this helper touches. */
export interface ConnectionOptionsConfig {
  connectionString: string;
  /** libpq `options` startup parameter. */
  options?: string;
}

/**
 * `config` with `statement_timeout` moved into the connection's **startup
 * parameters** (`options=-c statement_timeout=<ms>`) instead of a `SET`.
 *
 * PostgreSQL applies the `options` startup parameter as the backend starts the
 * session, so the bound is in force for the connection's very first statement
 * and for its whole life, with no extra round trip and nothing to reset. The
 * alternative, `SET statement_timeout = <ms>` on a fresh connection, is what
 * this exists to remove: outside an explicit transaction it is exactly the
 * session-state write that a transaction pooler leaves on a shared backend.
 *
 * `TurbineClient` uses the same mechanism for `plan_cache_mode`; see the note
 * there for why a `pool.on('connect')` `SET` is not the alternative it looks
 * like (it races the caller's first query through pg's deprecated same-client
 * queueing).
 *
 * Nothing already set is discarded, in either place pg reads `options` from.
 * pg's `ConnectionParameters` lets a value parsed out of the connection string
 * OVERRIDE the explicit `options` field, so when the URL already carries
 * `?options=...` the GUC is appended THERE; the explicit field itself falls back
 * to `process.env.PGOPTIONS` only while unset, so setting it blind would drop a
 * deployment's `PGOPTIONS`. Both are read first and appended to.
 *
 * THE INJECTION BOUNDARY: a GUC value cannot be a bind parameter, so the
 * emitted text necessarily contains a literal. `statementTimeoutMs` is
 * therefore narrowed to a non-negative safe INTEGER and rendered from the
 * narrowed number; anything else (a float, a negative, `NaN`, a string that
 * coerced) returns the config untouched rather than reaching the wire, because
 * a value that can carry a space can carry a second `-c`.
 */
export function withStatementTimeoutOption(
  config: ConnectionOptionsConfig,
  statementTimeoutMs: number,
): ConnectionOptionsConfig {
  if (!Number.isSafeInteger(statementTimeoutMs) || statementTimeoutMs < 0) return config;
  // No unit suffix: statement_timeout's default unit IS milliseconds, which is
  // what `SET statement_timeout = <n>` meant before this replaced it.
  const setting = `-c statement_timeout=${statementTimeoutMs}`;

  const merged = mergeConnectionStringOptions(config.connectionString, setting);
  if (merged !== null) return { ...config, connectionString: merged };

  const existing = config.options || (typeof process !== 'undefined' ? process.env?.PGOPTIONS : undefined);
  return { ...config, options: existing ? `${existing} ${setting}` : setting };
}

/**
 * `connectionString` with `setting` appended to an existing `options` query
 * parameter, or `null` when it carries none (in which case the caller uses the
 * `options` config field, which the connection string does not override).
 *
 * Only the query string is rewritten, never the userinfo or host, so a
 * percent-encoded password cannot be mangled by a round trip through `URL`. The
 * split is on the first `?`, which is also where pg's own parser puts the
 * query-string boundary: a connection string with an unencoded `?` inside the
 * password is not parseable by pg either, so there is no shape this handles
 * differently from the driver.
 *
 * DELIBERATELY DUPLICATED with `TurbineClient.mergeConnectionStringOptions`,
 * which needs the identical merge for `plan_cache_mode`. Collapsing the two
 * onto this copy is the obviously correct refactor and it was tried; it is
 * reverted, and the reason is worth writing down because the next person will
 * try it too.
 *
 * Exporting it and importing it from `client.ts` adds an import edge from a
 * module that ~100 test processes load. In each of those processes this file's
 * top level runs and its functions do not, so c8 merges ~100 top-level-only
 * entries against the one full entry from `pooler-guard.test.ts`, and the file
 * reports 40% in the merged report while measuring 100% in isolation. Real
 * coverage is unchanged either way, but the aggregate gate moved 75.48% ->
 * 75.03% against a 75% floor, i.e. the refactor spent almost all the headroom
 * on a reporting artifact.
 *
 * So: two copies, both small, both pure, neither reachable from the other. If
 * you unify them, re-measure `npm run test:coverage` as a whole and not just
 * this file, and raise the floor's headroom first. Keep this module
 * import-free regardless.
 */
function mergeConnectionStringOptions(connectionString: string, setting: string): string | null {
  const q = connectionString.indexOf('?');
  if (q === -1) return null;
  const params = new URLSearchParams(connectionString.slice(q + 1));
  const existing = params.get('options');
  if (existing === null) return null;
  params.set('options', `${existing} ${setting}`);
  return connectionString.slice(0, q + 1) + params.toString();
}
