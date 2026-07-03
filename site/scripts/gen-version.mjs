// Regenerates site/lib/version.ts from the ROOT package.json version at build
// time (wired as `predev` + `prebuild` in package.json). This is the single
// source of truth: the deployed hero badge / docs sidebar can never drift from
// the published package version, because every build re-derives it here.
//
// The root package.json is present in the Vercel build context (the whole repo
// is checked out; next.config.mjs pins outputFileTracingRoot to this dir so the
// outer lockfile isn't traced, but the files are still on disk). If it ever
// can't be read we fail loudly rather than silently shipping a stale version.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootPkgPath = resolve(here, '../../package.json');
const outPath = resolve(here, '../lib/version.ts');

const { version } = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
if (!version || typeof version !== 'string') {
  throw new Error(`gen-version: no valid "version" in ${rootPkgPath}`);
}

const contents = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Derived from the root package.json version at build time by
 * site/scripts/gen-version.mjs (runs as predev/prebuild). This is the single
 * source of truth for the version shown on the site (hero badge, docs
 * sidebar); it can never drift from the published package because every build
 * regenerates it. To change it, bump the root package.json and rebuild.
 */
export const TURBINE_VERSION = '${version}';

/** Marketing minor line, e.g. "v0.23" for the hero badge. */
export const TURBINE_MINOR = \`v\${TURBINE_VERSION.split('.').slice(0, 2).join('.')}\`;
`;

writeFileSync(outPath, contents);
console.log(`gen-version: wrote lib/version.ts (TURBINE_VERSION='${version}')`);
