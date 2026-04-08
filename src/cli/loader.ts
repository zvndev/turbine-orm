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
 *      probe whether `tsx/esm` is resolvable from the user's CWD.
 *   2. If yes, call `module.register('tsx/esm', ...)` ONCE per process.
 *   3. If no, surface an actionable error telling the user to install `tsx`.
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

export type TsLoaderStatus = 'registered' | 'already' | 'unsupported' | 'missing';

let tsLoaderState: TsLoaderStatus | null = null;

/**
 * Register the tsx ESM loader so subsequent dynamic imports of `.ts` files
 * work. Safe to call multiple times — internal flag prevents double registration.
 *
 * Returns:
 *   - 'registered'  loader was successfully registered this call
 *   - 'already'     a loader was previously registered (idempotent)
 *   - 'unsupported' Node lacks `module.register()` (Node < 20.6)
 *   - 'missing'     `tsx` is not installed in the user's project
 */
export async function registerTsLoader(): Promise<TsLoaderStatus> {
  if (tsLoaderState === 'registered' || tsLoaderState === 'already') {
    return 'already';
  }
  if (!canResolveTsx()) {
    tsLoaderState = 'missing';
    return 'missing';
  }
  try {
    const mod = await import('node:module');
    const register = (mod as { register?: (specifier: string, parentURL: URL) => void }).register;
    if (typeof register !== 'function') {
      tsLoaderState = 'unsupported';
      return 'unsupported';
    }
    register('tsx/esm', pathToFileURL(`${process.cwd()}/`));
    tsLoaderState = 'registered';
    return 'registered';
  } catch {
    tsLoaderState = 'missing';
    return 'missing';
  }
}

/** Reset the loader state — used by unit tests only. */
export function _resetTsLoaderStateForTests(): void {
  tsLoaderState = null;
}
