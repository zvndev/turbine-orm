/**
 * turbine-orm CLI — TypeScript loader registration
 *
 * The CLI loads user-supplied config and schema files via dynamic `import()`.
 * Plain Node has no built-in `.ts` loader, so importing `turbine.config.ts`
 * blows up with `ERR_UNKNOWN_FILE_EXTENSION` unless we register a TypeScript
 * loader first.
 *
 * Strategy:
 *   1. If the file we're about to import ends in `.ts` / `.mts` / `.cts`,
 *      probe whether `tsx` is resolvable from the user's CWD.
 *   2. Prefer tsx's supported programmatic API, `tsx/esm/api`'s `register()`.
 *      Calling Node's `module.register('tsx/esm', ...)` directly throws
 *      "tsx must be loaded with --import instead of --loader" on every Node
 *      version that has `module.register()` (>= 20.6) — tsx's hook file
 *      guards against being loaded that way. The `tsx/esm/api` entry point
 *      is the documented path and works everywhere `module.register()` does.
 *   3. Fall back to `module.register('tsx/esm', ...)` only for very old tsx
 *      versions (< 4.0) that predate `tsx/esm/api`.
 *   4. If tsx isn't installed, or registration genuinely fails, surface an
 *      actionable error — including the REAL underlying error message, never
 *      a misdiagnosed "tsx is not installed".
 *
 * `tsx` is intentionally NOT a runtime dependency — many projects already
 * have it, and adding a heavy dev tool to a 1-dependency ORM would be silly.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/**
 * Detect whether a config / schema file path needs the tsx ESM loader.
 * Returns true for `.ts`, `.mts`, and `.cts` files; false for `.js`, `.mjs`,
 * `.cjs`, `.json`, missing paths, or anything else.
 */
export function needsTsLoader(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return /\.(ts|mts|cts)$/i.test(filePath);
}

/**
 * Probe whether `tsx/esm` is resolvable from the user's current working
 * directory. Returns true if `tsx` is installed in the user's project.
 *
 * Accepts an injected `resolver` so unit tests don't need a real filesystem.
 */
export function canResolveTsx(resolver?: (id: string) => string): boolean {
  try {
    if (resolver) {
      resolver('tsx/esm');
      return true;
    }
    // Probe relative to the user's CWD, not Turbine's install location.
    // This way we honour whatever `tsx` version the user has pinned.
    const userRequire = createRequire(`${process.cwd()}/`);
    userRequire.resolve('tsx/esm');
    return true;
  } catch {
    return false;
  }
}

export type TsLoaderStatus = 'registered' | 'already' | 'unsupported' | 'missing' | 'failed';

let tsLoaderState: TsLoaderStatus | null = null;
let tsLoaderError: string | null = null;

/**
 * The underlying error message from the last failed registration attempt,
 * or null. Lets the CLI report the REAL cause instead of guessing.
 */
export function getTsLoaderError(): string | null {
  return tsLoaderError;
}

/**
 * Register the tsx ESM loader so subsequent dynamic imports of `.ts` files
 * work. Safe to call multiple times — internal flag prevents double registration.
 *
 * Returns:
 *   - 'registered'  loader was successfully registered this call
 *   - 'already'     a loader was previously registered (idempotent)
 *   - 'unsupported' Node lacks `module.register()` (Node < 20.6) and tsx has
 *                   no programmatic API to fall back to
 *   - 'missing'     `tsx` is not installed in the user's project
 *   - 'failed'      tsx IS installed but registration threw — see
 *                   {@link getTsLoaderError} for the underlying message
 */
export async function registerTsLoader(): Promise<TsLoaderStatus> {
  if (tsLoaderState === 'registered' || tsLoaderState === 'already') {
    return 'already';
  }

  const userRequire = createRequire(`${process.cwd()}/`);

  // Preferred: tsx's supported programmatic API (tsx >= 4.0).
  let apiPath: string | null = null;
  try {
    apiPath = userRequire.resolve('tsx/esm/api');
  } catch {
    apiPath = null;
  }

  if (apiPath) {
    try {
      const api = (await import(pathToFileURL(apiPath).href)) as { register?: () => unknown };
      if (typeof api.register !== 'function') {
        throw new Error(`tsx/esm/api resolved at ${apiPath} but exports no register() function`);
      }
      api.register();
      tsLoaderState = 'registered';
      tsLoaderError = null;
      return 'registered';
    } catch (err) {
      tsLoaderState = 'failed';
      tsLoaderError = err instanceof Error ? err.message : String(err);
      return 'failed';
    }
  }

  // tsx/esm/api not resolvable — is tsx installed at all?
  if (!canResolveTsx()) {
    tsLoaderState = 'missing';
    return 'missing';
  }

  // Legacy fallback for tsx < 4.0 (no tsx/esm/api): Node's module.register.
  // On tsx >= 4.19 this path throws ("tsx must be loaded with --import
  // instead of --loader") — but those versions all ship tsx/esm/api, so we
  // only land here for genuinely old installs.
  try {
    const mod = await import('node:module');
    const register = (mod as { register?: (specifier: string, parentURL: URL) => void }).register;
    if (typeof register !== 'function') {
      tsLoaderState = 'unsupported';
      return 'unsupported';
    }
    register('tsx/esm', pathToFileURL(`${process.cwd()}/`));
    tsLoaderState = 'registered';
    tsLoaderError = null;
    return 'registered';
  } catch (err) {
    tsLoaderState = 'failed';
    tsLoaderError = err instanceof Error ? err.message : String(err);
    return 'failed';
  }
}

/** Reset the loader state — used by unit tests only. */
export function _resetTsLoaderStateForTests(): void {
  tsLoaderState = null;
  tsLoaderError = null;
}
