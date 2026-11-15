import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build, type Plugin } from 'esbuild';
import { generateD1Files } from '../../../d1/generate.js';
import type { D1DatabaseBinding } from '../../../d1/types.js';
import { ddl, generationSchema } from './schema.js';

const timeout = { timeout: 180_000 };
const subprocess = {
  encoding: 'utf8' as const,
  timeout: 40_000,
  killSignal: 'SIGKILL' as const,
  stdio: 'pipe' as const,
};
const forbidden =
  /^(?:pg(?:\/|$)|pg-[^/]+|mysql2(?:\/|$)|mssql(?:\/|$)|@libsql\/|@neondatabase\/|miniflare(?:\/|$)|node:(?!async_hooks$))/;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

function unpack(root: string) {
  const archive = process.env.TURBINE_D1_GENERATION_ARCHIVE;
  assert(archive && existsSync(archive), 'Required real D1 generation archive is missing');
  assert.equal(hash(readFileSync(archive)), process.env.TURBINE_D1_GENERATION_SHA256, 'Exact archive pin required');
  const library = join(root, 'node_modules/turbine-orm');
  mkdirSync(library, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', library], subprocess);
  const manifest = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8'));
  assert.deepEqual(manifest.dependencies, { pg: '^8.15.0' });
  for (const entry of ['d1', 'd1/generate']) {
    assert.deepEqual(manifest.exports[`./${entry}`], {
      import: { types: `./dist/${entry}.d.ts`, default: `./dist/${entry}.js` },
      require: { types: `./dist/cjs/${entry}.d.ts`, default: `./dist/cjs/${entry}.js` },
    });
  }
  return library;
}

function types(root: string) {
  for (const [name, target] of [
    ['@types/node', 'node_modules/@types/node'],
    ['undici-types', 'node_modules/undici-types'],
    ['@cloudflare/workers-types', 'node_modules/@cloudflare/workers-types'],
  ]) {
    const path = join(root, 'node_modules', name!);
    mkdirSync(join(path, '..'), { recursive: true });
    symlinkSync(resolve(target!), path);
  }
}
function guard(source: boolean): Plugin {
  return {
    name: 'D1-generated-runtime-boundary',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (forbidden.test(args.path)) throw new Error(`Forbidden D1 runtime dependency: ${args.path}`);
        if (args.path === 'node:async_hooks')
          return args.namespace === 'builtin-bridge'
            ? { path: args.path, external: true }
            : { path: args.path, namespace: 'builtin-bridge' };
        if (source && args.path === 'turbine-orm/d1') return { path: resolve('src/d1.ts') };
        return undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: 'builtin-bridge' }, () => ({
        contents: "export { AsyncLocalStorage } from 'node:async_hooks';",
        loader: 'js',
      }));
    },
  };
}

async function runtime(script: string, fail = false, groups = 17) {
  const require = createRequire(import.meta.url);
  assert.equal(require('miniflare/package.json').version, '4.20260730.0');
  assert.equal(require('workerd/package.json').version, '1.20260730.1');
  assert.equal(require('@cloudflare/workers-types/package.json').version, '5.20261106.1');
  const executable = process.env.MINIFLARE_WORKERD_PATH ?? (require('workerd') as { default: string }).default;
  assert.match(execFileSync(executable, ['--version'], subprocess), /workerd 2026-07-30/);
  const { Miniflare } = require('miniflare') as {
    Miniflare: new (
      options: object,
    ) => {
      dispatchFetch(url: string): Promise<{ status: number; text(): Promise<string> }>;
      getD1Database(name: string): Promise<{ prepare(sql: string): { all(): Promise<unknown> } }>;
      dispose(): Promise<void>;
    };
  };
  const mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: '2026-01-01',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: { DB: 'typed-generated' },
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const binding = await mf.getD1Database('DB');
    for (const sql of ddl) await binding.prepare(sql).all();
    if (fail) throw new Error('owned native failure control');
    const response = await mf.dispatchFetch('http://localhost/');
    const result = await response.text();
    assert.equal(response.status, 200, result);
    assert.deepEqual(JSON.parse(result), { ok: true, groups });
  } finally {
    await mf.dispose();
  }
}

test(
  'actual generated factory compiles strictly and executes native D1 in ESM/CJS with drivers absent',
  timeout,
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'd1-generation-native-'));
    try {
      // Generation runs in Node with mandatory pg installed; Worker consumers have no driver install.
      const generationRoot = join(root, 'generation');
      const generatorLibrary = unpack(generationRoot);
      symlinkSync(resolve('node_modules/pg'), join(generationRoot, 'node_modules/pg'));
      const esmGenerator = await import(pathToFileURL(join(generatorLibrary, 'dist/d1/generate.js')).href);
      const require = createRequire(join(generationRoot, 'consumer.cjs'));
      const cjsGenerator = require('turbine-orm/d1/generate');
      const files = generateD1Files(generationSchema(), { noTimestamp: true });
      assert.deepEqual(esmGenerator.generateD1Files(generationSchema(), { noTimestamp: true }), files);
      assert.deepEqual(cjsGenerator.generateD1Files(generationSchema(), { noTimestamp: true }), files);
      const consumerRoot = join(root, 'consumer');
      const library = unpack(consumerRoot);
      types(consumerRoot);
      const absent = createRequire(join(consumerRoot, 'check.cjs'));
      for (const name of [
        'pg',
        'pg-pool',
        'pg-types',
        'mysql2',
        'mssql',
        '@libsql/client',
        '@neondatabase/serverless',
        'miniflare',
      ])
        assert.throws(() => absent(name), { code: 'MODULE_NOT_FOUND' });
      const template = readFileSync(resolve('src/test/fixtures/d1-generation/consumer.ts.txt'), 'utf8');
      const compilers = [resolve('node_modules/typescript/bin/tsc')];
      if (process.env.TURBINE_D1_GENERATION_TSC59) {
        assert(existsSync(process.env.TURBINE_D1_GENERATION_TSC59), 'Supplied TypeScript 5.9.3 compiler is absent');
        compilers.push(process.env.TURBINE_D1_GENERATION_TSC59);
      }
      assert.match(execFileSync(process.execPath, [compilers[0]!, '--version'], subprocess), /6\.0\.3/);
      if (compilers[1])
        assert.match(execFileSync(process.execPath, [compilers[1], '--version'], subprocess), /5\.9\.3/);
      for (const format of ['module', 'commonjs']) {
        const directory = join(consumerRoot, format);
        mkdirSync(join(directory, 'generated'), { recursive: true });
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: format }));
        for (const [name, content] of Object.entries(files)) writeFileSync(join(directory, 'generated', name), content);
        writeFileSync(join(directory, 'consumer.ts'), template);
        const args = [
          '--strict',
          '--skipLibCheck',
          'false',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--target',
          'ES2023',
          '--exactOptionalPropertyTypes',
          '--noUncheckedIndexedAccess',
          '--types',
          'node',
          '--outDir',
          join(directory, 'out'),
          join(directory, 'consumer.ts'),
        ];
        for (const compiler of compilers)
          execFileSync(process.execPath, [compiler!, ...args], { ...subprocess, cwd: consumerRoot });
        // Exercise exact Node package maps with both generated module formats and native SQLite forbidden.
        const loader = join(directory, 'deny.cjs');
        writeFileSync(
          loader,
          `const M=require('node:module');const load=M._load;M._load=function(id,...args){if(id==='node:sqlite'||id==='pg')throw new Error('Forbidden native dependency '+id);return load.call(this,id,...args)};`,
        );
        const script = join(directory, format === 'module' ? 'resolve.mjs' : 'resolve.cjs');
        writeFileSync(
          script,
          format === 'module'
            ? `import {turbine} from './out/generated/index.js'; if(typeof turbine!=='function')throw Error('factory absent'); console.log('ESM_OK');`
            : `const {turbine}=require('./out/generated/index.js');if(typeof turbine!=='function')throw Error('factory absent');console.log('CJS_OK');`,
        );
        assert.match(
          execFileSync(process.execPath, ['--require', loader, script], { ...subprocess, cwd: consumerRoot }),
          /(?:ESM|CJS)_OK/,
        );
        const worker = join(directory, 'worker.mjs');
        writeFileSync(
          worker,
          "import {run} from './out/consumer.js'; export default {async fetch(_request,env){try{return Response.json(await run(env.DB))}catch(error){return new Response(String(error.stack??error),{status:500})}}};",
        );
        const bundled = await build({
          entryPoints: [worker],
          bundle: true,
          write: false,
          format: 'esm',
          platform: 'neutral',
          conditions: ['workerd'],
          metafile: true,
          plugins: [guard(false)],
        });
        assert(
          Object.keys(bundled.metafile!.inputs).some(
            (path) => path.endsWith('/dist/d1.js') || path.endsWith('/dist/cjs/d1.js'),
          ),
        );
        assert(
          !Object.keys(bundled.metafile!.inputs).some((path) =>
            /\/(?:sqlite\.js|node_modules\/(?:pg|pg-pool|pg-types)\/)/.test(path),
          ),
        );
        await runtime(bundled.outputFiles[0]!.text);
        // Omission controls act only on the disposable installed archive, then restore exact bytes.
        const manifestPath = join(library, 'package.json');
        const original = readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(original);
        delete manifest.exports['./d1'];
        writeFileSync(manifestPath, JSON.stringify(manifest));
        const missing = spawnSync(process.execPath, [compilers[0]!, ...args, '--noEmit'], {
          ...subprocess,
          cwd: consumerRoot,
        });
        assert.notEqual(missing.status, 0);
        assert.match(missing.stdout, /Cannot find module 'turbine-orm\/d1'/);
        writeFileSync(manifestPath, original);
      }
      const directory = join(consumerRoot, 'module');
      const source = await build({
        entryPoints: [join(directory, 'consumer.ts')],
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'neutral',
        metafile: true,
        plugins: [guard(true)],
      });
      assert(Object.keys(source.metafile!.inputs).some((path) => path.endsWith('src/d1.ts')));
      await runtime(source.outputFiles[0]!.text);
      await assert.rejects(runtime(source.outputFiles[0]!.text, true), /owned native failure control/);
      for (const dependency of ['pg', 'node:sqlite', 'node:fs', 'node:net', 'mysql2', 'mssql', '@libsql/client']) {
        await assert.rejects(
          build({
            stdin: { contents: `import '${dependency}';`, resolveDir: directory },
            bundle: true,
            write: false,
            platform: 'neutral',
            plugins: [guard(false)],
            logLevel: 'silent',
          }),
          /Forbidden D1 runtime dependency/,
        );
      }
      // Collect this table through the actual installed catalog export before
      // generating raw-name factories; manual metadata must not hide map loss.
      const { Miniflare } = createRequire(import.meta.url)('miniflare') as {
        Miniflare: new (
          options: object,
        ) => {
          getD1Database(name: string): Promise<D1DatabaseBinding>;
          dispose(): Promise<void>;
        };
      };
      const catalogRuntime = new Miniflare({
        modules: true,
        script: 'export default { fetch() { return new Response("catalog") } }',
        compatibilityDate: '2026-01-01',
        d1Databases: { DB: 'raw-catalog' },
        host: '127.0.0.1',
        port: 0,
      });
      const rawSchema = generationSchema();
      try {
        const binding = await catalogRuntime.getD1Database('DB');
        await binding.prepare(ddl[3]!).all();
        const catalog = await import(pathToFileURL(join(generatorLibrary, 'dist/d1/introspect.js')).href);
        const metadata = await catalog.introspectD1(binding, { keepColumnNames: true, logger: {} });
        assert(Object.hasOwn(metadata.tables.raw_names.columnMap, '__proto__'));
        rawSchema.tables = { ...rawSchema.tables, ...metadata.tables };
      } finally {
        await catalogRuntime.dispose();
      }
      for (const format of ['module', 'commonjs']) {
        const directory = join(consumerRoot, `raw-${format}`);
        mkdirSync(join(directory, 'generated'), { recursive: true });
        writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: format }));
        const rawFiles: ReturnType<typeof generateD1Files> = (
          format === 'module' ? esmGenerator : cjsGenerator
        ).generateD1Files(rawSchema, {
          noTimestamp: true,
          keepColumnNames: true,
        });
        for (const [name, content] of Object.entries(rawFiles))
          writeFileSync(join(directory, 'generated', name), content);
        writeFileSync(
          join(directory, 'consumer.ts'),
          readFileSync(resolve('src/test/fixtures/d1-generation/raw-consumer.ts.txt')),
        );
        for (const compiler of compilers)
          execFileSync(
            process.execPath,
            [
              compiler!,
              '--strict',
              '--skipLibCheck',
              'false',
              '--module',
              'NodeNext',
              '--moduleResolution',
              'NodeNext',
              '--target',
              'ES2023',
              '--exactOptionalPropertyTypes',
              '--noUncheckedIndexedAccess',
              '--types',
              'node',
              '--outDir',
              join(directory, 'out'),
              join(directory, 'consumer.ts'),
            ],
            { ...subprocess, cwd: consumerRoot },
          );
        const worker = join(directory, 'worker.mjs');
        writeFileSync(
          worker,
          "import {run} from './out/consumer.js'; export default {async fetch(_request,env){try{return Response.json(await run(env.DB))}catch(error){return new Response(String(error.stack??error),{status:500})}}};",
        );
        const graph = await build({
          entryPoints: [worker],
          bundle: true,
          write: false,
          format: 'esm',
          platform: 'neutral',
          conditions: ['workerd'],
          plugins: [guard(false)],
        });
        await runtime(graph.outputFiles[0]!.text, false, 6);
      }
      const metadataPath = join(directory, 'generated/metadata.ts');
      const metadata = readFileSync(metadataPath, 'utf8');
      rmSync(metadataPath);
      const noMetadata = spawnSync(
        process.execPath,
        [
          compilers[0]!,
          '--strict',
          '--skipLibCheck',
          'false',
          '--module',
          'NodeNext',
          '--moduleResolution',
          'NodeNext',
          '--target',
          'ES2023',
          '--types',
          'node',
          '--noEmit',
          join(directory, 'consumer.ts'),
        ],
        { ...subprocess, cwd: consumerRoot },
      );
      assert.notEqual(noMetadata.status, 0);
      assert.match(noMetadata.stdout, /Cannot find module '.\/metadata.js'/);
      writeFileSync(metadataPath, metadata);
      const manifestPath = join(generatorLibrary, 'package.json');
      const original = readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(original);
      delete manifest.exports['./d1/generate'];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const missing = spawnSync(process.execPath, ['-e', "require('turbine-orm/d1/generate')"], {
        ...subprocess,
        cwd: generationRoot,
      });
      assert.notEqual(missing.status, 0);
      assert.match(missing.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
      writeFileSync(manifestPath, original);
      console.log(
        `D1 generation: source + actual archive ESM/CJS native execution, TS6.0.3${compilers.length > 1 ? ' + TS5.9.3' : ''}, 7 forbidden-import controls, 3 export-omission + metadata-omission controls, intentional native failure cleanup`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
