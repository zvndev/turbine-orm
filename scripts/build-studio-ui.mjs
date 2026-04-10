#!/usr/bin/env node
/**
 * build-studio-ui.mjs
 *
 * Code-generates `src/cli/studio-ui.generated.ts` from the designer-authored
 * `src/cli/studio-ui.html`. The generated file exports a single `STUDIO_HTML`
 * string constant that `studio.ts` ships as the Studio UI.
 *
 * Why a build step instead of fs.readFileSync at runtime?
 *   - Keeps the published package self-contained (no extra file to ship)
 *   - Lets tsc type-check the HTML constant alongside the rest of the code
 *   - Avoids a runtime filesystem dependency inside the CLI binary
 *
 * Why JSON.stringify instead of a template literal?
 *   - JSON.stringify escapes backticks, `${}`, backslashes, quotes, and control
 *     characters correctly for free. Building a template literal by hand would
 *     require replicating all of that, and any miss would produce a broken
 *     TypeScript file or, worse, a working file that unexpectedly interpolates
 *     `${...}` fragments from the designer's HTML.
 *
 * Regenerate via: `node scripts/build-studio-ui.mjs` from the repo root.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');

const inputPath = resolve(repoRoot, 'src/cli/studio-ui.html');
const outputPath = resolve(repoRoot, 'src/cli/studio-ui.generated.ts');

let html;
try {
  html = readFileSync(inputPath, 'utf8');
} catch (err) {
  if (err && err.code === 'ENOENT') {
    console.error(`build-studio-ui: source file not found at ${inputPath}`);
    console.error('The designer-authored Studio HTML must exist before the build step runs.');
    console.error('If you are building from a published tarball, this script should not run —');
    console.error('the generated file is shipped pre-built. Run from a git checkout instead.');
    process.exit(1);
  }
  throw err;
}

const banner =
  '// AUTO-GENERATED from src/cli/studio-ui.html. Do not edit by hand.\n' +
  '// Regenerate via: node scripts/build-studio-ui.mjs\n';

const body = `export const STUDIO_HTML: string = ${JSON.stringify(html)};\n`;

const output = `${banner}\n${body}`;

writeFileSync(outputPath, output, 'utf8');

const bytes = Buffer.byteLength(output, 'utf8');
console.log(`wrote src/cli/studio-ui.generated.ts (${bytes} bytes)`);
