import assert from 'node:assert/strict';
import { limits } from './budgets.mjs';
import { build, stop, version } from 'esbuild';
import { brotliCompressSync, constants } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { entries } from './harness.mjs';

// Same esbuild/node/minification + Brotli q11 family used by size-limit.
// Node/CJS is the enforceable baseline; ESM is a separately labelled observation.
export async function measure(installed, reportPath) {
  const measurements = { methodology: 'esbuild bundle/minify platform=node, Brotli quality 11; complete physical install inventory reported separately', esbuild: version, phase: 'before shared core extraction; recompute after integration', entries: {} };
  for (const entry of entries) {
    const result = {};
    for (const format of ['cjs', 'esm']) {
      const bundle = await build({ entryPoints: [join(installed, 'dist', `${entry}.js`)], bundle: true, minify: true, platform: 'node', format, write: false, metafile: true, external: ['pg', '#pg', '@neondatabase/serverless', 'ws'] });
      const bytes = bundle.outputFiles[0].contents;
      const compressed = brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
      result[format] = { sizeLimitBrotli: compressed - 16, limitBytes: limits[entry], bytes: bytes.length, brotli: compressed, inputs: Object.keys(bundle.metafile.inputs), imports: Object.values(bundle.metafile.outputs).flatMap((output) => output.imports), driverExternalized: ['pg', '#pg', '@neondatabase/serverless', 'ws'] };
      writeFileSync(`${reportPath}.${entry}.${format}.meta.json`, JSON.stringify(bundle.metafile, null, 2));
    }
    assert.ok(result.cjs.sizeLimitBrotli <= limits[entry], `${entry} exceeds new-entry library budget ${result.cjs.sizeLimitBrotli}/${limits[entry]}`);
    measurements.entries[entry] = result;
  }
  return measurements;
}

// Run measurements as an owned command so esbuild's worker belongs to the same
// bounded process lifecycle. No entry graph or budget is changed here.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await measure(process.argv[2], process.argv[3]))); }
  finally { await stop(); }
}
