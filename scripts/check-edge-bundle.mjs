#!/usr/bin/env node
/**
 * Gate: `turbine-orm/serverless` must bundle for an edge runtime.
 *
 * The serverless entry is documented for Vercel Edge and other runtimes with
 * no TCP sockets and no Node builtins, and it shares its whole client/query
 * graph with the main entry. When a shared module imported `pg` statically,
 * every edge build failed (webpack on `fs`, Turbopack on `node:util/types`)
 * while every Node-side gate stayed green, because nothing here ever bundled
 * the entry the way an edge bundler does.
 *
 * This does. It bundles dist/serverless.js with esbuild for a neutral platform
 * under the conditions Next.js and Vercel use for edge code, and fails on any import of the pg family, any Node
 * builtin outside ALLOWED_BUILTINS, and any other package at all (the runtime
 * dependency set is `pg` alone, so a new bare import in this graph is news).
 *
 * The CONTROL runs first: the same bundle under Node's conditions must reach
 * `pg`. If it does not, the scan is not seeing the driver and a green edge
 * result would mean nothing, so the gate refuses to pass.
 *
 * Reads dist/, so it must run after `npm run build`.
 */

import { statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Conditions Next.js and Vercel resolve edge code with. */
const EDGE_CONDITIONS = ['edge-light', 'worker', 'browser'];

/**
 * Node builtins an edge runtime provides. `node:async_hooks` backs the `$tag`
 * scope and the per-client error-message mode (AsyncLocalStorage); Vercel
 * Edge, Next.js edge routes, Deno and Cloudflare Workers (`nodejs_als` or
 * `nodejs_compat`) all supply it.
 */
const ALLOWED_BUILTINS = new Set(['node:async_hooks']);

// ESM only. Every subpath export lists `import` before `require`, so an edge
// bundle resolves the ESM files; the CJS build is Node-only and names `pg`
// directly (scripts/finish-cjs-build.mjs).
const ENTRIES = ['dist/serverless.js'];

const isBuiltin = (specifier) => specifier.startsWith('node:') || builtinModules.includes(specifier.split('/')[0]);
const isPgFamily = (specifier) => /^pg$|^pg[/-]/.test(specifier);

/** Bundle `entry` and return every bare import reached, plus pg files bundled. */
async function scan(entry, conditions) {
  const imports = [];
  const result = await build({
    entryPoints: [join(root, entry)],
    bundle: true,
    write: false,
    metafile: true,
    logLevel: 'silent',
    platform: 'neutral',
    format: 'esm',
    mainFields: ['module', 'main'],
    conditions,
    plugins: [
      {
        name: 'record-bare-imports',
        setup(b) {
          // `#pg` is left to esbuild: resolving the package `imports` map under
          // these conditions is the thing being tested.
          b.onResolve({ filter: /^[^./#]/ }, (args) => {
            imports.push({ specifier: args.path, from: relative(root, args.importer) });
            return { path: args.path, external: true };
          });
        },
      },
    ],
  });
  const pgFiles = Object.keys(result.metafile.inputs).filter((f) => /node_modules\/pg\//.test(f));
  return { imports, pgFiles };
}

function violations({ imports, pgFiles }) {
  const bad = imports.filter(({ specifier }) => !(isBuiltin(specifier) && ALLOWED_BUILTINS.has(specifier)));
  return [...bad.map(({ specifier, from }) => `${specifier} (imported by ${from})`), ...pgFiles];
}

for (const entry of ENTRIES) {
  try {
    statSync(join(root, entry));
  } catch {
    console.error(`::error::check-edge-bundle: ${entry} does not exist. Run \`npm run build\` first.`);
    process.exit(1);
  }
}

let failed = false;
for (const entry of ENTRIES) {
  const control = await scan(entry, ['node']);
  if (!control.pgFiles.length && !control.imports.some(({ specifier }) => isPgFamily(specifier))) {
    console.error(
      `::error::check-edge-bundle: CONTROL FAILED for ${entry}: bundled for Node it does not reach pg, so this scan cannot see the driver and an edge pass would be vacuous.`,
    );
    failed = true;
    continue;
  }
  const edge = violations(await scan(entry, EDGE_CONDITIONS));
  if (edge.length) {
    console.error(`::error::check-edge-bundle: ${entry} is not edge-safe. Bundled for ${EDGE_CONDITIONS.join(', ')} it reaches:`);
    for (const line of edge) console.error(`  ${line}`);
    failed = true;
  } else {
    console.log(`check-edge-bundle: ${entry} bundles for ${EDGE_CONDITIONS.join(', ')} with no pg and no Node builtins beyond ${[...ALLOWED_BUILTINS].join(', ')} (control: the Node bundle reaches pg)`);
  }
}
if (failed) {
  console.error(
    '\nA module the serverless entry reaches imports pg or a Node builtin. Import the driver as `#pg` (see package.json //imports and src/pg-edge.ts). A dynamic import does not help: edge bundlers follow it.',
  );
  process.exit(1);
}
