import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { unpackD1 } from './packed.js';

// Required runtime suite: an absent prerequisite is a failure, never a passing skip.
test('D1 Worker executes prepared statements and transactional batches in local workerd', async () => {
  const req = createRequire(import.meta.url);
  const module = process.env.TURBINE_D1_MINIFLARE_MODULE ?? 'miniflare';
  // Verify the exact executable Miniflare will use before it opens listeners.
  // A missing executable otherwise emits an uncaught spawn error on Node22
  // while dispatchFetch and the runtime's disposal remain pending.
  const nativeRequire = createRequire(req.resolve(module));
  const executable = process.env.MINIFLARE_WORKERD_PATH ?? (nativeRequire('workerd') as { default: string }).default;
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(version, /^workerd \d{4}-\d{2}-\d{2}\b/);
  const { Miniflare } = req(module) as {
    Miniflare: new (
      options: object,
    ) => { dispatchFetch(url: string): Promise<{ status: number; text(): Promise<string> }>; dispose(): Promise<void> };
  };
  const root = mkdtempSync(join(tmpdir(), 'turbine-d1-runtime-'));
  let mf: InstanceType<typeof Miniflare> | undefined;
  try {
    const library = unpackD1(root);
    const result = await build({
      entryPoints: [resolve('src/test/fixtures/d1/worker.ts')],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd'],
      plugins: [
        {
          name: 'packed-d1-entry',
          setup(builder) {
            builder.onResolve({ filter: /^\.\.\/\.\.\/\.\.\/d1\.js$/ }, () => ({ path: join(library, 'dist/d1.js') }));
          },
        },
      ],
      external: ['node:async_hooks'],
      mainFields: ['module', 'main'],
      metafile: true,
    });
    const inputs = Object.keys(result.metafile!.inputs);
    assert(inputs.some((path) => path.endsWith('node_modules/turbine-orm/dist/d1.js')));
    assert(!inputs.some((path) => /node_modules\/(pg|pg-[^/]+|mysql2|mssql)\//.test(path)));
    assert(!inputs.some((path) => path.endsWith('src/sqlite.ts')));
    mf = new Miniflare({
      modules: true,
      script: result.outputFiles[0]!.text,
      compatibilityDate: '2026-01-01',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: { DB: 'test-d1-binding' },
      host: '127.0.0.1',
      port: 0,
    });
    const response = await mf.dispatchFetch('http://localhost/');
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const output = JSON.parse(text);
    assert.equal(output.ok, true);
    assert.equal(output.groups, 24);
    assert(output.prepares > 10);
    assert(output.batches >= 3);
  } finally {
    try {
      await mf?.dispose();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
