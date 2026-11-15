/**
 * turbine-orm CLI, TypeScript loader registration
 *
 * The CLI loads user-supplied config and schema files via dynamic `import()`.
 * Plain Node has no built-in `.ts` loader, so importing `turbine.config.ts`
 * fails with `ERR_UNKNOWN_FILE_EXTENSION` unless a TypeScript
 * loader is registered first.
 *
 * Strategy:
 *   1. If the file being imported ends in `.ts` / `.mts` / `.cts`,
 *      probe whether `tsx` is resolvable from the user's CWD.
 *   2. Prefer tsx's supported programmatic ESM and CommonJS registration APIs.
 *      Calling Node's `module.register('tsx/esm', ...)` directly throws
 *      "tsx must be loaded with --import instead of --loader" on every Node
 *      version that has `module.register()` (>= 20.6), tsx's hook file
 *      guards against being loaded that way. The `tsx/esm/api` entry point
 *      is the documented path and works everywhere `module.register()` does.
 *      CommonJS registration also handles `.ts` in a CommonJS project.
 *   3. Fall back to `module.register('tsx/esm', ...)` only for very old tsx
 *      versions (< 4.0) that predate `tsx/esm/api`.
 *   4. If tsx isn't installed, or registration genuinely fails, surface an
 *      actionable error, including the REAL underlying error message, never
 *      a misdiagnosed "tsx is not installed".
 *
 * `tsx` is intentionally NOT a runtime dependency, many projects already
 * have it, and adding a heavy dev tool to a 1-dependency ORM would be silly.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import importOptionalPeer from '../optional-peer-import.cjs';

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
    // This uses the `tsx` version pinned by the user.
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

function registerCjsLoader(userRequire: ReturnType<typeof createRequire>): void {
  let apiPath: string | null;
  try {
    apiPath = userRequire.resolve('tsx/cjs/api');
  } catch {
    apiPath = null;
  }
  if (apiPath) {
    const api = userRequire(apiPath) as { register?: () => unknown };
    if (typeof api.register !== 'function') {
      throw new Error(`tsx/cjs/api resolved at ${apiPath} but exports no register() function`);
    }
    api.register();
  } else {
    // Older releases expose only the side-effect registration entry.
    userRequire('tsx/cjs');
  }
}

/**
 * The underlying error message from the last failed registration attempt,
 * or null. Lets the CLI report the REAL cause instead of guessing.
 */
export function getTsLoaderError(): string | null {
  return tsLoaderError;
}

/**
 * Register tsx's ESM and CommonJS loaders so dynamic imports of `.ts` files
 * work. Safe to call multiple times, internal flag prevents double registration.
 *
 * Returns:
 *   - 'registered'  loader was successfully registered this call
 *   - 'already'     a loader was previously registered (idempotent)
 *   - 'unsupported' Node lacks `module.register()` (Node < 20.6) and tsx has
 *                   no programmatic API to fall back to
 *   - 'missing'     `tsx` is not installed in the user's project
 *   - 'failed'      tsx IS installed but registration threw, see
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
    // Select the user's published import entry when present. Loading the
    // require entry with import() still selects its CJS implementation; recent
    // tsx CJS builds resolve their async Node 22 loader relative to the wrong
    // bundled directory. The ESM entry retains the correct module base.
    try {
      const manifest = userRequire.resolve('tsx/package.json');
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
        exports?: { './esm/api'?: { import?: string | { default?: string } } };
      };
      const entry = pkg.exports?.['./esm/api']?.import;
      const path = typeof entry === 'string' ? entry : entry?.default;
      if (path?.startsWith('./')) apiPath = resolve(dirname(manifest), path);
    } catch {
      // Older tsx versions may not export their manifest; keep their API path.
    }
  } catch {
    apiPath = null;
  }

  if (apiPath) {
    try {
      const api = (await importOptionalPeer(apiPath)) as { register?: () => unknown };
      if (typeof api.register !== 'function') {
        throw new Error(`tsx/esm/api resolved at ${apiPath} but exports no register() function`);
      }
      registerCjsLoader(userRequire);
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

  // tsx/esm/api not resolvable, is tsx installed at all?
  if (!canResolveTsx()) {
    tsLoaderState = 'missing';
    return 'missing';
  }

  // Legacy fallback for tsx < 4.0 (no tsx/esm/api): Node's module.register.
  // On tsx >= 4.19 this path throws ("tsx must be loaded with --import
  // instead of --loader"), but those versions all ship tsx/esm/api, so this
  // fallback only serves older installs.
  try {
    const mod = await import('node:module');
    const register = (mod as { register?: (specifier: string, parentURL: URL) => void }).register;
    if (typeof register !== 'function') {
      tsLoaderState = 'unsupported';
      return 'unsupported';
    }
    registerCjsLoader(userRequire);
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

/** Reset the loader state, used by unit tests only. */
export function _resetTsLoaderStateForTests(): void {
  tsLoaderState = null;
  tsLoaderError = null;
}
