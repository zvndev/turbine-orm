// Regenerates site/lib/version.ts from the ROOT package.json version at build
// time (wired as `predev` + `prebuild` in package.json). This is the single
// source of truth: the deployed hero badge / docs sidebar can never drift from
// the published package version, because every build re-derives it here.
//
// In-repo builds read the root package.json and regenerate lib/version.ts.
// Site-only build contexts (e.g. `vercel deploy` run from site/, which uploads
// ONLY this directory — a real deploy failed with ENOENT on /vercel/package.json)
// don't have the root manifest; there we keep the COMMITTED lib/version.ts,
// which the last in-repo build already regenerated. A malformed root manifest
// still fails loudly — only absence falls back.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const rootPkgPath = resolve(here, '../../package.json');
const outPath = resolve(here, '../lib/version.ts');

if (!existsSync(rootPkgPath)) {
  console.warn(
    `gen-version: ${rootPkgPath} not in this build context (site-only upload); keeping committed lib/version.ts`
  );
  process.exit(0);
}

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
