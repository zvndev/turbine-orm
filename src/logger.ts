/**
 * turbine-orm, the pluggable logger.
 *
 * Every line Turbine writes goes through a {@link TurbineLogger}: the client's
 * `logger` option, or {@link consoleLogger} when none is set. Each line is a
 * human message plus a {@link TurbineLogEntry} whose `code` is stable and
 * machine-readable; the message text is not a stable contract.
 *
 * No log line carries a bound parameter value or a row value, whatever
 * `logQueryParams` says: that option governs `$on('query')` events only. An
 * entry about a where clause names its keys, never its values.
 *
 * This module and `seed.ts` (a CLI-driven runner) are the only library modules
 * that call `console` directly; a source scan fails the build on another.
 */

import type { ResolvedDiagnostics } from './diagnostics.js';
import { ValidationError } from './errors.js';
import type { TurbineLogCode } from './log-codes.js';

export type { TurbineLogCode } from './log-codes.js';

/** The structured half of a log line. */
export interface TurbineLogEntry {
  /** Stable, machine-readable id of the line, e.g. `'pool-error'`, `'unknown-config-key'`. */
  code: string;
  /** The table the line is about, when there is one. */
  table?: string;
  /** The operation the line is about (`'findMany'`, `'$transaction'`), when there is one. */
  operation?: string;
  /** The error the line reports, when it reports one. */
  error?: unknown;
  [field: string]: unknown;
}

/**
 * Where Turbine's log lines go. Every method is optional, and a missing method
 * drops that level, so `{}` silences Turbine entirely. The argument order,
 * `(message, entry)`, matches `console` and winston; pino and bunyan take
 * `(object, message)` and need a two-line adapter.
 *
 * A method that throws is ignored: logging never fails the operation that
 * logged.
 */
export interface TurbineLogger {
  debug?(message: string, entry: TurbineLogEntry): void;
  info?(message: string, entry: TurbineLogEntry): void;
  warn?(message: string, entry: TurbineLogEntry): void;
  error?(message: string, entry: TurbineLogEntry): void;
}

/** One of the four {@link TurbineLogger} levels. */
export type TurbineLogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: readonly TurbineLogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * What the default logger prints for one line: `[turbine] <message>`, plus the
 * entry's error as a second argument when the message ends with a colon. Such
 * a message names a failure and the error completes it (`Query listener error:`
 * followed by the error and its stack); every other message is complete on its
 * own and already carries what it needs from the error.
 */
function consoleArgs(message: string, entry: TurbineLogEntry): unknown[] {
  // turbine-prefix-ok: this line only ever reaches the console.* calls in consoleLogger, never an Error.
  const line = `[turbine] ${message}`;
  return entry.error !== undefined && message.endsWith(':') ? [line, entry.error] : [line];
}

/**
 * The logger a client uses when `logger` is not set. `console` is looked up
 * on every call, not captured, so anything that replaces `console.warn` (a
 * test, an APM agent) sees Turbine's lines.
 */
export const consoleLogger: TurbineLogger = Object.freeze({
  debug(message: string, entry: TurbineLogEntry): void {
    console.log(...consoleArgs(message, entry));
  },
  info(message: string, entry: TurbineLogEntry): void {
    console.info(...consoleArgs(message, entry));
  },
  warn(message: string, entry: TurbineLogEntry): void {
    console.warn(...consoleArgs(message, entry));
  },
  error(message: string, entry: TurbineLogEntry): void {
    console.error(...consoleArgs(message, entry));
  },
});

/**
 * Validate the `logger` option: unset means {@link consoleLogger}; otherwise an
 * object whose `debug` / `info` / `warn` / `error` members, where present, are
 * functions. Other members are ignored, so a pino, winston or console object is
 * accepted as it is. Throws `ValidationError` (E003) otherwise.
 */
export function resolveLogger(logger: unknown): TurbineLogger {
  if (logger === undefined) return consoleLogger;
  if ((typeof logger !== 'object' && typeof logger !== 'function') || logger === null || Array.isArray(logger)) {
    throw new ValidationError(
      `Invalid logger option: expected an object with optional debug, info, warn and error methods, got ${
        logger === null ? 'null' : Array.isArray(logger) ? 'an array' : typeof logger
      }. Pass {} to silence Turbine, or leave the option unset for console.`,
    );
  }
  for (const level of LEVELS) {
    const member = (logger as Record<string, unknown>)[level];
    if (member !== undefined && typeof member !== 'function') {
      throw new ValidationError(
        `Invalid logger option: logger.${level} must be a function (message, entry) or absent, got ${typeof member}.`,
      );
    }
  }
  return logger as TurbineLogger;
}

/** An entry as Turbine's own emitters build it: the code is one of {@link TurbineLogCode}. */
export interface InternalLogEntry extends TurbineLogEntry {
  code: TurbineLogCode;
}

/**
 * Send one line to `logger` at `level`. A logger without that level drops it;
 * a logger that throws is ignored. Called as a method, so a class-based
 * logger keeps its `this`.
 *
 * Callers build `message` only once they know the line is wanted (behind the
 * `logging` flag, the advice gate, or the warn-once registry), so a silenced
 * line costs nothing.
 */
export function logTo(logger: TurbineLogger, level: TurbineLogLevel, message: string, entry: InternalLogEntry): void {
  const method = logger[level];
  if (typeof method !== 'function') return;
  try {
    method.call(logger, message, entry);
  } catch {
    // A logging failure must never become the caller's failure.
  }
}

/**
 * What a client hands to code that wraps it (prisma-compat) or runs on its
 * behalf: its logger and its resolved diagnostics.
 */
export interface ClientLogContext {
  readonly logger: TurbineLogger;
  readonly diagnostics: ResolvedDiagnostics;
}

/**
 * The key a `TurbineClient` exposes its {@link ClientLogContext} under.
 * `Symbol.for`, so an ESM and a CJS copy of the package agree on it.
 */
export const CLIENT_LOG_CONTEXT: unique symbol = Symbol.for('turbine-orm.clientLogContext');
