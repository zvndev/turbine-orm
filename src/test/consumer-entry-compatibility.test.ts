import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);

function compile(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-consumer-types-'));
  try {
    writeFileSync(join(dir, 'consumer.mts'), source);
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          types: ['node'],
          typeRoots: [join(root, 'node_modules/@types')],
        },
        files: ['consumer.mts'],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [require.resolve('typescript/bin/tsc'), '-p', join(dir, 'tsconfig.json')],
      {
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('published consumer entry compatibility', () => {
  it('loads Neon WebSocket declarations with exact optional property types', () => {
    compile(`
import { turbineNeonWs } from ${JSON.stringify(join(root, 'dist/neon-ws.js'))};
export const factory = turbineNeonWs;
`);
  });

  for (const format of ['esm', 'cjs'] as const) {
    it(`reports a Turbine connection error when the Neon peer is absent (${format})`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'turbine-consumer-peer-'));
      try {
        cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
        writeFileSync(join(dir, 'package.json'), readFileSync(join(root, 'package.json')));
        mkdirSync(join(dir, 'node_modules'));
        symlinkSync(dirname(require.resolve('pg/package.json')), join(dir, 'node_modules/pg'), 'dir');
        const modulePath = join(dir, format === 'esm' ? 'dist/neon-ws.js' : 'dist/cjs/neon-ws.js');
        const load =
          format === 'esm'
            ? `await import(${JSON.stringify(pathToFileURL(modulePath).href)})`
            : `createRequire(import.meta.url)(${JSON.stringify(modulePath)})`;
        const result = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { createRequire } from 'node:module';
const { turbineNeonWs } = ${load};
try {
  await turbineNeonWs(
    { connection: { connectionString: 'postgres://localhost/unused' } },
    { tables: {}, enums: {} },
    { sessionMode: 'persistent', lifetime: 'invocation' },
  );
  throw new Error('factory unexpectedly succeeded');
} catch (error) {
  console.log(JSON.stringify({ name: error.name, code: error.code, message: error.message }));
}`,
          ],
          { cwd: dir, encoding: 'utf8', timeout: 30_000 },
        );
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ''}`);
        const error = JSON.parse(result.stdout) as { name: string; code: string; message: string };
        assert.equal(error.name, 'ConnectionError', JSON.stringify(error));
        assert.equal(error.code, 'TURBINE_E004');
        assert.match(error.message, /@neondatabase\/serverless/);
        assert.match(error.message, /install/i);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
