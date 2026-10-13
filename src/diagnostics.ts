/**
 * turbine-orm, the `diagnostics` switch.
 *
 * One client option decides what Turbine checks and says about itself at run
 * time: per-query advice (unknown options, unordered pages, deep `with`,
 * strategy notes, missing FK indexes, redundant sort terms) and the SQL-cache
 * self-check. It is resolved ONCE, when a client is constructed, and travels to
 * every query interface the client builds, so no hot path reads `process.env`.
 *
 * This module is the only place in the library (outside `cli/`) that reads
 * `NODE_ENV` or the two `TURBINE_*` cache-check variables; a source scan
 * (`fleet-diagnostics-env-scan.test.ts`) fails the build on a second reader.
 *
 * Zero imports besides errors.ts, so client.ts, query/ and the engines can all
 * depend on it without a new cycle.
 */

import { ValidationError } from './errors.js';

/** `'development'`: advice on, cache self-check on every hit. `'production'`: both off. */
export type DiagnosticsMode = 'development' | 'production';

/** The SQL-cache self-check: rebuild on every cache hit, a sampled fraction of hits, or never. */
export type CacheCheckMode = 'every-hit' | 'off' | { readonly sample: number };

/** Per-part overrides for {@link DiagnosticsConfig}. Unset parts follow the mode. */
export interface DiagnosticsOptions {
  /**
   * Per-query advice: unknown query options, unordered pages, deep `with`
   * trees, relation-strategy notes, missing FK indexes, redundant sort terms.
   * Default: on in development, off in production.
   */
  advice?: boolean | undefined;
  /**
   * SQL-cache self-check. `'every-hit'` rebuilds the SQL on each cache hit
   * and compares; `{ sample }` compares that fraction of hits, in `(0, 1]`;
   * `'off'` never compares. Default: `'every-hit'` in development, `'off'` in
   * production. A mismatch means Turbine has a bug, and throws.
   */
  cacheCheck?: CacheCheckMode | undefined;
}

/**
 * The `diagnostics` client option: a mode, or per-part overrides on top of
 * one. When no mode is given it comes from `NODE_ENV`, read once when the
 * client is constructed: `'production'` when `NODE_ENV` is `'production'` (or
 * when there is no `process` at all, as on an edge runtime), else
 * `'development'`.
 */
export type DiagnosticsConfig = DiagnosticsMode | (DiagnosticsOptions & { mode?: DiagnosticsMode | undefined });

/** What a client actually runs with. Frozen; built only by {@link resolveDiagnostics}. */
export interface ResolvedDiagnostics {
  readonly mode: DiagnosticsMode;
  /** Whether per-query advice is emitted. */
  readonly advice: boolean;
  readonly cacheCheck: CacheCheckMode;
}

/**
 * The environment variables this module reads. `null` in their place means
 * there is no `process` to read (an edge runtime), which resolves to
 * production.
 */
export interface DiagnosticsEnv {
  NODE_ENV?: string | undefined;
  TURBINE_DISABLE_CACHE_CHECK?: string | undefined;
  TURBINE_CACHE_CHECK_SAMPLE?: string | undefined;
}

const MODES: readonly DiagnosticsMode[] = ['development', 'production'];
const OPTION_KEYS: ReadonlySet<string> = new Set(['mode', 'advice', 'cacheCheck']);

/**
 * Marks objects {@link resolveDiagnostics} built, so resolving a resolved value
 * hands it back by reference. A `TransactionClient` builds a query interface
 * per table per transaction from the client's options; re-resolving there would
 * put the environment reads back on a per-transaction path.
 */
const resolvedSet = new WeakSet<object>();

/**
 * Read the variables once. Every read is guarded: no `process` (edge runtimes)
 * and no `process.env` (some sandboxes) both mean "no environment".
 */
function readEnv(): DiagnosticsEnv | null {
  if (typeof process === 'undefined' || process.env === undefined) return null;
  const env = process.env;
  return {
    NODE_ENV: env.NODE_ENV,
    TURBINE_DISABLE_CACHE_CHECK: env.TURBINE_DISABLE_CACHE_CHECK,
    TURBINE_CACHE_CHECK_SAMPLE: env.TURBINE_CACHE_CHECK_SAMPLE,
  };
}

function invalid(detail: string): ValidationError {
  return new ValidationError(
    `Invalid diagnostics option: ${detail}. Expected 'development', 'production', or ` +
      "{ mode?, advice?: boolean, cacheCheck?: 'every-hit' | 'off' | { sample: number in (0, 1] } }.",
  );
}

function checkSample(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw invalid(`cacheCheck.sample must be a number in (0, 1], got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return String(value);
  }
  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}

function resolveCacheCheck(value: unknown): CacheCheckMode {
  if (value === 'every-hit' || value === 'off') return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== 'sample') {
      throw invalid(`cacheCheck object takes exactly one key, sample; got { ${keys.join(', ')} }`);
    }
    return Object.freeze({ sample: checkSample((value as { sample: unknown }).sample) });
  }
  throw invalid(`cacheCheck ${describe(value)}`);
}

/**
 * The legacy cache-check variables, under an explicit `cacheCheck`.
 * `TURBINE_DISABLE_CACHE_CHECK=1` turns the check off in any mode. In
 * production mode, `TURBINE_CACHE_CHECK_SAMPLE` sets a sample rate: a rate of
 * 1 or more checks every hit, and 0, a negative or an unparseable value leaves
 * the check off, as these variables always behaved. Development mode already
 * checks every hit, so the sample variable is not read there.
 */
function legacyCacheCheck(mode: DiagnosticsMode, env: DiagnosticsEnv | null): CacheCheckMode | undefined {
  if (env === null) return undefined;
  if (env.TURBINE_DISABLE_CACHE_CHECK === '1') return 'off';
  if (mode !== 'production' || env.TURBINE_CACHE_CHECK_SAMPLE === undefined) return undefined;
  const rate = Number.parseFloat(env.TURBINE_CACHE_CHECK_SAMPLE);
  if (!Number.isFinite(rate) || rate <= 0) return 'off';
  return Object.freeze({ sample: Math.min(rate, 1) });
}

/**
 * Resolve the `diagnostics` option, once, at client construction.
 *
 * Precedence for each part: the explicit option, then (for `cacheCheck` only)
 * the legacy `TURBINE_DISABLE_CACHE_CHECK` / `TURBINE_CACHE_CHECK_SAMPLE`
 * variables, then the mode's default. The mode itself is the option's, else
 * `NODE_ENV`'s.
 *
 * Throws `ValidationError` (E003) for an unknown mode, an unknown key, a
 * non-boolean `advice`, or a `sample` outside `(0, 1]`. A value this function
 * returned is handed back by reference.
 *
 * @param env - The environment to read; defaults to `process.env`. Tests pass
 *   one explicitly; `null` stands for a runtime with no `process`.
 */
export function resolveDiagnostics(config?: unknown, env: DiagnosticsEnv | null = readEnv()): ResolvedDiagnostics {
  if (typeof config === 'object' && config !== null && resolvedSet.has(config)) {
    return config as ResolvedDiagnostics;
  }
  let options: DiagnosticsOptions & { mode?: unknown } = {};
  if (typeof config === 'string') {
    if (!MODES.includes(config as DiagnosticsMode)) throw invalid(`unknown mode ${describe(config)}`);
    options = { mode: config };
  } else if (typeof config === 'object' && config !== null && !Array.isArray(config)) {
    for (const key of Object.keys(config)) {
      if (!OPTION_KEYS.has(key)) throw invalid(`unknown key "${key}"`);
    }
    options = config as DiagnosticsOptions & { mode?: unknown };
    if (options.mode !== undefined && !MODES.includes(options.mode as DiagnosticsMode)) {
      throw invalid(`unknown mode ${describe(options.mode)}`);
    }
    if (options.advice !== undefined && typeof options.advice !== 'boolean') {
      throw invalid(`advice must be a boolean, got ${describe(options.advice)}`);
    }
  } else if (config !== undefined && config !== null) {
    throw invalid(describe(config));
  }

  const mode: DiagnosticsMode =
    (options.mode as DiagnosticsMode | undefined) ??
    (env === null || env.NODE_ENV === 'production' ? 'production' : 'development');
  const cacheCheck =
    options.cacheCheck !== undefined
      ? resolveCacheCheck(options.cacheCheck)
      : (legacyCacheCheck(mode, env) ?? (mode === 'production' ? 'off' : 'every-hit'));
  const resolved: ResolvedDiagnostics = Object.freeze({
    mode,
    advice: options.advice ?? mode === 'development',
    cacheCheck,
  });
  resolvedSet.add(resolved);
  return resolved;
}
