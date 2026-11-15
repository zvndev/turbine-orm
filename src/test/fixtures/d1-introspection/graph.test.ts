import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { brotliCompressSync, constants } from 'node:zlib';
import { build } from 'esbuild';

function scan(entry: string, minify: boolean, treeShaking: boolean, format: 'esm' | 'cjs') {
  return build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    minify,
    treeShaking,
    format,
    platform: 'neutral',
    conditions: [format === 'esm' ? 'workerd' : 'node'],
    mainFields: ['module', 'main'],
    metafile: true,
    logLevel: 'silent',
    plugins: [
      {
        name: 'driver-free-catalog',
        setup(builder) {
          builder.onResolve({ filter: /^[^./]/ }, (args) => {
            if (args.path === 'node:async_hooks') return { path: args.path, external: true };
            throw new Error(`Forbidden D1 catalog runtime import: ${args.path}`);
          });
        },
      },
    ],
  });
}

test('source and staged ESM/CJS catalog graphs reject unrelated imports before tree shaking', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'd1-graph-'));
  try {
    const archive = process.env.TURBINE_D1_INTROSPECTION_ARCHIVE;
    assert.ok(archive, 'A built staged archive is required.');
    assert.equal(
      createHash('sha256').update(readFileSync(archive)).digest('hex'),
      process.env.TURBINE_D1_INTROSPECTION_SHA256,
    );
    mkdirSync(join(root, 'package'));
    execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', join(root, 'package')]);
    const report = [];
    for (const [scope, entry, format] of [
      ['source', resolve('src/d1/introspect.ts'), 'esm'],
      ['staged ESM', join(root, 'package/dist/d1/introspect.js'), 'esm'],
      ['staged CJS', join(root, 'package/dist/cjs/d1/introspect.js'), 'cjs'],
    ] as const) {
      const unshaken = await scan(entry, false, false, format);
      const measured = await scan(entry, true, true, format);
      const bytes = measured.outputFiles[0]!.contents;
      const inputs = Object.keys(unshaken.metafile!.inputs);
      assert(inputs.some((input) => /catalog-metadata\.(ts|js)$/.test(input)));
      assert(
        !inputs.some(
          (input) =>
            /(?:^|\/)(introspect|sqlite|libsql|core|client)\.(ts|js)$/.test(input) &&
            !input.endsWith('d1/introspect.ts') &&
            !input.endsWith('d1/introspect.js'),
        ),
      );
      const imports = Object.values(unshaken.metafile!.outputs).flatMap((output) =>
        output.imports.map((item) => item.path),
      );
      assert.deepEqual(imports, ['node:async_hooks']);
      const record = {
        scope,
        format,
        unshakenBytes: unshaken.outputFiles[0]!.contents.byteLength,
        minifiedBytes: bytes.byteLength,
        brotliQ11Bytes: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).byteLength,
        inputs,
        imports,
      };
      report.push(record);
      t.diagnostic(JSON.stringify({ ...record, inputs: inputs.length }));
      for (const specifier of ['pg', '#pg', 'node:sqlite', 'node:net', 'node:tls', 'mysql2', '@libsql/client']) {
        const injected = join(root, 'injected.mjs');
        writeFileSync(injected, `import ${JSON.stringify(specifier)}; export * from ${JSON.stringify(entry)};`);
        await assert.rejects(scan(injected, false, false, format), /Forbidden D1 catalog runtime import/);
      }
    }
    if (process.env.TURBINE_D1_INTROSPECTION_GRAPH_REPORT)
      writeFileSync(process.env.TURBINE_D1_INTROSPECTION_GRAPH_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
