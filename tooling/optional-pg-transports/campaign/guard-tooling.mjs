// Optional development-only resolver for a clean checkout without root installs.
// Used solely by the existing esbuild lifecycle test, never by the workload.
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
if (process.env.OPTIONAL_PG_ESBUILD) registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'esbuild'
      ? nextResolve(pathToFileURL(process.env.OPTIONAL_PG_ESBUILD).href, context)
      : nextResolve(specifier, context);
  },
});
