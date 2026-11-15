import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { introspectD1 } from '../../../d1/introspect.js';
import { generateIndex, generateMetadata, generateTypes } from '../../../generate.js';
import { executeDdl, nativeRuntime, withNative } from './native.js';

const ddl = readFileSync(new URL('./catalog.sql', import.meta.url), 'utf8');
const template = readFileSync(new URL('./consumer.ts.txt', import.meta.url), 'utf8');
const include = [
  'parents',
  'profiles',
  'composite_parents',
  'composite_links',
  'generated_records',
  'default_keys',
  'number_records',
  'prototype_rows',
];
const archive = process.env.TURBINE_D1_INTROSPECTION_ARCHIVE;
const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
function unpack(root: string): string {
  assert.ok(archive && existsSync(archive), 'Set TURBINE_D1_INTROSPECTION_ARCHIVE to the built staged archive.');
  assert.equal(digest(archive), process.env.TURBINE_D1_INTROSPECTION_SHA256, 'Pin exact tested archive SHA256.');
  const destination = join(root, 'node_modules/turbine-orm');
  mkdirSync(destination, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', destination]);
  const manifest = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { pg: '^8.15.0' });
  assert.deepEqual(manifest.exports['./d1/introspect'], {
    import: { types: './dist/d1/introspect.d.ts', default: './dist/d1/introspect.js' },
    require: { types: './dist/cjs/d1/introspect.d.ts', default: './dist/cjs/d1/introspect.js' },
  });
  return destination;
}

// Required native acceptance: every read/write uses the actual workerd D1 binding.
test('strict generated ESM/CJS archive consumers execute native D1 catalog, writes and relations in workerd', async () => {
  const root = mkdtempSync(join(tmpdir(), 'd1-consumer-'));
  const initialHash = archive && digest(archive);
  try {
    const library = unpack(root);
    mkdirSync(join(root, 'node_modules/@types'), { recursive: true });
    symlinkSync(resolve('node_modules/@types/node'), join(root, 'node_modules/@types/node'));
    symlinkSync(resolve('node_modules/undici-types'), join(root, 'node_modules/undici-types'));
    const workers = process.env.TURBINE_D1_WORKERS_TYPES_DIR;
    assert.ok(workers, 'Exact official Worker types prerequisite required.');
    mkdirSync(join(root, 'node_modules/@cloudflare'), { recursive: true });
    symlinkSync(workers, join(root, 'node_modules/@cloudflare/workers-types'));
    const schema = await withNative(async (binding) => {
      await executeDdl(binding, ddl);
      const metadata = await introspectD1(binding, { include, keepColumnNames: true, logger: {} });
      await assert.rejects(async () => generateTypes(await introspectD1(binding)), /Cannot generate code/);
      return metadata;
    });
    for (const format of ['module', 'commonjs'] as const) {
      const directory = join(root, format);
      mkdirSync(join(directory, 'generated'), { recursive: true });
      writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: format }));
      const options = { target: 'sqlite' as const, noTimestamp: true, logger: {} };
      // Existing emitters preserve catalog tsType. Do not enable exactNativeIntegers:
      // that option deliberately widens Node SQLite/libSQL's large-integer contract.
      writeFileSync(join(directory, 'generated/index.ts'), generateIndex(schema, options));
      writeFileSync(join(directory, 'generated/types.ts'), generateTypes(schema, options));
      writeFileSync(join(directory, 'generated/metadata.ts'), generateMetadata(schema, options));
      writeFileSync(join(directory, 'consumer.ts'), template);
      const config = {
        compilerOptions: {
          strict: true,
          skipLibCheck: false,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          target: 'ES2023',
          types: ['node'],
          outDir: 'out',
        },
        include: ['consumer.ts', 'generated/*.ts'],
      };
      writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify(config));
      const args = [resolve('node_modules/typescript/bin/tsc'), '-p', join(directory, 'tsconfig.json')];
      execFileSync(process.execPath, args, { cwd: root, stdio: 'pipe', timeout: 60_000 });
      const packageFile = join(library, 'package.json');
      const manifest = JSON.parse(readFileSync(packageFile, 'utf8'));
      const entry = manifest.exports['./d1/introspect'];
      delete manifest.exports['./d1/introspect'];
      writeFileSync(packageFile, JSON.stringify(manifest));
      const absent = spawnSync(process.execPath, [...args, '--noEmit'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
      });
      assert.notEqual(absent.status, 0);
      assert.match(absent.stdout, /Cannot find module 'turbine-orm\/d1\/introspect'/);
      manifest.exports['./d1/introspect'] = entry;
      writeFileSync(packageFile, JSON.stringify(manifest));
      const entryPoint = join(directory, 'worker.mjs');
      writeFileSync(
        entryPoint,
        `import {run} from './out/consumer.js'; export default {async fetch(_request, env) {try {return Response.json(await run(env.DB));}catch(error){return new Response(String(error.stack ?? error),{status:500});}}};`,
      );
      const graph = await build({
        entryPoints: [entryPoint],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        conditions: ['workerd'],
        metafile: true,
        plugins: [
          {
            name: 'cjs-worker-builtin-bridge',
            setup(builder) {
              builder.onResolve({ filter: /^node:async_hooks$/ }, (args) =>
                args.namespace === 'builtin-bridge'
                  ? { path: args.path, external: true }
                  : { path: args.path, namespace: 'builtin-bridge' },
              );
              builder.onLoad({ filter: /.*/, namespace: 'builtin-bridge' }, () => ({
                contents: "export { AsyncLocalStorage } from 'node:async_hooks';",
                loader: 'js',
              }));
            },
          },
        ],
      });
      const inputs = Object.keys(graph.metafile!.inputs);
      assert(
        inputs.some((path) =>
          path.endsWith(format === 'module' ? '/dist/d1/introspect.js' : '/dist/cjs/d1/introspect.js'),
        ),
      );
      assert(!inputs.some((path) => /node_modules\/(pg|pg-[^/]+|mysql2|mssql|@libsql|sqlite3)\//.test(path)));
      const runtime = nativeRuntime(graph.outputFiles[0]!.text);
      const stop = () => {
        const timer = setTimeout(() => process.exit(1), 5_000);
        timer.unref();
        void runtime.dispose().finally(() => process.exit(1));
      };
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      try {
        await executeDdl(await runtime.getD1Database('DB'), ddl);
        const response = await runtime.dispatchFetch('http://localhost/');
        const output = await response.text();
        assert.equal(response.status, 200, output);
        assert.deepEqual(JSON.parse(output), { ok: true });
      } finally {
        try {
          await runtime.dispose();
        } finally {
          process.removeListener('SIGTERM', stop);
          process.removeListener('SIGINT', stop);
        }
      }
      // Real Node ESM/import and CJS/require resolve exact package export maps,
      // with every unrelated driver and runtime peer absent in this consumer.
      const esm = format === 'module';
      const path = join(directory, esm ? 'load.mjs' : 'load.cjs');
      writeFileSync(
        path,
        `${esm ? "import {introspectD1} from 'turbine-orm/d1/introspect'; import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);" : "const {introspectD1}=require('turbine-orm/d1/introspect');"} if(typeof introspectD1!=='function') throw Error('missing export'); for(const peer of ['pg','pg-pool','pg-types','mysql2','mssql','@libsql/client','miniflare']) {try {require.resolve(peer);throw Error('unexpected peer '+peer);} catch(error) {if(error.code!=='MODULE_NOT_FOUND')throw error;}}`,
      );
      execFileSync(process.execPath, [path], { cwd: root, timeout: 30_000 });
    }
  } finally {
    if (archive) assert.equal(digest(archive), initialHash);
    rmSync(root, { recursive: true, force: true });
  }
});
