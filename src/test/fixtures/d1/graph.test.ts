import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';
import { unpackD1 } from './packed.js';

function scan(entry: string, conditions: string[]) {
  return build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    treeShaking: false,
    format: 'esm',
    platform: 'neutral',
    conditions,
    mainFields: ['module', 'main'],
    logLevel: 'silent',
    plugins: [
      {
        name: 'd1-no-drivers',
        setup(builder) {
          builder.onResolve({ filter: /^[^./#]/ }, (args) => {
            if (args.path === 'node:async_hooks') return { path: args.path, external: true };
            throw new Error(`D1 graph resolved forbidden runtime import: ${args.path}`);
          });
        },
      },
    ],
  });
}

test('D1 optional deployed ESM/CJS graph excludes PostgreSQL, TCP and native SQLite before tree shaking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turbine-d1-packed-graph-'));
  try {
    const source = unpackD1(root);
    for (const [entry, conditions] of [
      ['dist/d1.js', ['workerd']],
      ['dist/cjs/d1.js', ['node']],
    ] as const) {
      const result = await scan(join(source, entry), [...conditions]);
      const inputs = Object.keys(result.metafile!.inputs);
      assert(inputs.length > 20, 'nonempty SQL query graph required');
      assert(inputs.some((path) => path.endsWith('d1/sqlite-dialect.js')));
      assert(!inputs.some((path) => /(?:^|\/)sqlite\.js$|node_modules\/(?:pg|pg-[^/]+|mysql2|mssql)\//.test(path)));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('D1 graph guard rejects injected omitted-driver imports in isolated fixtures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'turbine-d1-graph-'));
  try {
    for (const specifier of ['pg', 'node:sqlite', 'node:net', 'node:tls', 'mysql2']) {
      const entry = join(root, 'bad.mjs');
      writeFileSync(entry, `import ${JSON.stringify(specifier)}; export const control = true;`);
      await assert.rejects(scan(entry, ['workerd']), /D1 graph resolved forbidden runtime import/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
