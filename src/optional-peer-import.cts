/**
 * True dynamic `import()` for the optional peer dependencies (`mysql2`,
 * `mssql`, `@zvndev/powdb-client`, `@zvndev/powdb-embedded`) — safe in BOTH
 * build outputs, including for peers that are ESM-only.
 *
 * THE PROBLEM THIS FILE SOLVES (the `@zvndev/powdb-client` ≥ 0.9 CJS break):
 * the engine subpaths load their optional peers with dynamic `import()` so the
 * peers stay out of the static graph. The ESM build (`tsconfig.json`, module
 * NodeNext) emits that `import()` verbatim. The CJS build (`tsconfig.cjs.json`,
 * module CommonJS) however TRANSPILES `import()` into
 * `Promise.resolve().then(() => require(...))` — and `require()` of an
 * ESM-only package (no `require` export condition, e.g. powdb-client ≥ 0.9)
 * throws `ERR_PACKAGE_PATH_NOT_EXPORTED`, breaking every CJS consumer.
 *
 * TypeScript offers no way to preserve `import()` under `module: CommonJS`,
 * and the CJS pass cannot switch to `module: NodeNext` (the root package.json
 * says `"type": "module"`, so NodeNext would classify every `.ts` source as
 * ESM and emit ESM into dist/cjs). A `.cts` file is the escape hatch: it is
 * CommonJS-format by extension regardless of package `type`, so under the ESM
 * pass (NodeNext) it compiles to `dist/optional-peer-import.cjs` — a CommonJS
 * file whose `import()` SURVIVES transpilation (NodeNext preserves dynamic
 * import in CJS files precisely because it is the only way CJS can load ESM).
 *
 * That gives the published package two copies of this module:
 *   - `dist/optional-peer-import.cjs`      (ESM pass, NodeNext)  — real `import()`
 *   - `dist/cjs/optional-peer-import.cjs`  (CJS pass, CommonJS)  — lowered to `require()`
 *
 * The lowered copy works fine for CJS-loadable peers (`mysql2`, `mssql`, older
 * powdb peers). When it hits an ESM-only peer, the `require()` fails with a
 * recognizable code and this function falls back to delegating the load to the
 * sibling NodeNext copy one directory up (`../optional-peer-import.cjs`) —
 * which is a plain CommonJS file (loadable by `require()` on every supported
 * Node) whose real `import()` then loads the ESM peer. The ESM-pass copy has
 * no such sibling; its lazy `require` throws and the original error surfaces,
 * so the fallback can never recurse.
 *
 * Keep this module dependency-free and side-effect-free: it must be loadable
 * from both module systems on every supported Node (≥ 20) without pulling in
 * anything else.
 */

/**
 * Does this error mean "the module exists but cannot be loaded via
 * `require()` because it is ESM-only"? These are the only failures worth
 * retrying through a real `import()`; anything else (not installed, throw on
 * init, …) is rethrown untouched so callers keep the original diagnostics.
 */
function isEsmOnlyLoadError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return (
    code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || // exports map has no `require` condition
    code === 'ERR_REQUIRE_ESM' || // require() of an ES module (pre-require(esm) Node)
    code === 'ERR_REQUIRE_ASYNC_MODULE' // require(esm) of a module with top-level await
  );
}

/**
 * Dynamically import an optional peer dependency. In the ESM build this is a
 * plain `import()`. In the CJS build the first attempt is a transpiled
 * `require()`; if the peer turns out to be ESM-only, the load is retried
 * through the ESM-build sibling copy of this file, whose `import()` survived
 * transpilation (see the module doc comment).
 *
 * @param specifier bare package specifier (e.g. `'@zvndev/powdb-client'`).
 * @param allowEsmFallback internal recursion guard — the delegated call passes
 *   `false` so a failure in the sibling copy can never bounce back.
 */
async function importOptionalPeer(specifier: string, allowEsmFallback = true): Promise<unknown> {
  try {
    return await import(specifier);
  } catch (err) {
    if (!allowEsmFallback || !isEsmOnlyLoadError(err)) throw err;
    let esmCapableCopy: typeof importOptionalPeer | undefined;
    try {
      // Only resolvable from dist/cjs/, where it lands on the NodeNext-built
      // dist/optional-peer-import.cjs. From anywhere else (the ESM copy
      // itself, or running the TypeScript source directly) the file does not
      // exist and the original error is rethrown below.
      esmCapableCopy = require('../optional-peer-import.cjs') as typeof importOptionalPeer;
    } catch {
      esmCapableCopy = undefined;
    }
    if (typeof esmCapableCopy !== 'function') throw err;
    return esmCapableCopy(specifier, false);
  }
}

/**
 * Merged namespace so callers can reach {@link peerPackageVersion} off the same
 * default import (`importOptionalPeer.peerPackageVersion(...)`). Lives in this
 * `.cts` file for the same reason the dynamic import does: a `.cts` compiles to
 * CommonJS in BOTH build passes, so `require` / `require.resolve` are natively
 * available and `import.meta` is never emitted (which would break the CJS build
 * and crash CJS consumers, see `resolveEmbeddedVersion` in powdb.ts).
 */
namespace importOptionalPeer {
  /**
   * Resolve an optional peer's declared `package.json` version WITHOUT loading
   * the package itself (so an ESM-only peer never trips `require`). `require` is
   * anchored on THIS module's location (inside the published `dist/`), so bare
   * resolution walks up `node_modules` and finds the peer exactly where
   * `import.meta.url` used to point, but it compiles under `module: CommonJS`
   * too. Returns `null` when the peer / its package.json cannot be resolved.
   */
  export function peerPackageVersion(specifier: string): string | null {
    try {
      const pkg = require(`${specifier}/package.json`) as { version?: string };
      return typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      return null;
    }
  }
}

export = importOptionalPeer;
