import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export async function neutralBundle(entry: string, format: 'esm' | 'cjs') {
  return build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'neutral',
    format,
    logLevel: 'silent',
    plugins: [
      {
        name: 'supplied-transport-import-boundary',
        setup(b) {
          b.onResolve({ filter: /^[^./]/ }, ({ path, importer }) =>
            path === 'node:async_hooks'
              ? { path, external: true }
              : { errors: [{ text: `Core must not import ${path} from ${relative(ROOT, importer)}` }] },
          );
        },
      },
    ],
  });
}

describe('driver-neutral source import boundary', () => {
  it('fails the native-client control and accepts the entire optional graph before tree shaking', async () => {
    await assert.rejects(neutralBundle('src/client.ts', 'esm'), /Core must not import #pg/);
    for (const format of ['esm', 'cjs'] as const) {
      const result = await neutralBundle('src/core.ts', format);
      const inputs = Object.keys(result.metafile.inputs);
      assert.ok(inputs.length >= 35, 'the full query engine is present');
      assert.ok(inputs.includes('src/core.ts'));
      assert.ok(inputs.includes('src/query/builder.ts'));
      assert.ok(inputs.includes('src/query-utils.ts'));
      assert.ok(!inputs.includes('src/client.ts'));
      assert.ok(!inputs.includes('src/query/utils.ts'));
      assert.ok(!inputs.some((path) => path.includes('pg-type-parsers') || path.includes('node_modules')));
    }
  });

  it('runs ESM and CJS bundles with actual resolver absence controls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'core-absence-'));
    try {
      for (const [format, extension] of [
        ['esm', 'mjs'],
        ['cjs', 'cjs'],
      ] as const) {
        const result = await neutralBundle('src/core.ts', format);
        writeFileSync(join(dir, `core.${extension}`), result.outputFiles[0]!.text);
      }
      writeFileSync(
        join(dir, 'probe.mjs'),
        `
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
for (const driver of ['pg','mysql2','mssql','@neondatabase/serverless','@libsql/client']) {
 assert.throws(()=>require(driver),{code:'MODULE_NOT_FOUND'});
 await assert.rejects(import(driver),{code:'ERR_MODULE_NOT_FOUND'});
}
for(const path of ['./core.mjs','./core.cjs']) {
 const loaded=await import(path),core=path.endsWith('.cjs')?loaded.default:loaded;
 const calls=[],pool={query:async(text,values)=>{calls.push([text,values]);return{rows:[{answer:42}],rowCount:1}},connect:async()=>{throw Error('unexpected checkout')},end:async()=>{throw Error('caller pool closed')}};
 const db=core.turbineCore(pool,{tables:{},enums:{}});
 assert.deepEqual(await db.rawUnsafe('SELECT $1 AS answer',42),[{answer:42}]);
 assert.deepEqual(calls,[['SELECT $1 AS answer',[42]]]);
 assert.throws(()=>db.$transaction(()=>{throw Error('callback entered')}),{code:'TURBINE_E017'});
 await db.disconnect();
}
process.stdout.write('ESM/CJS graph executed with five drivers absent');
`,
      );
      const output = execFileSync(process.execPath, [join(dir, 'probe.mjs')], {
        cwd: dir,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(output, 'ESM/CJS graph executed with five drivers absent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
