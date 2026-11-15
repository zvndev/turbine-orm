/** Real compiler regressions; stripping each negative assertion must produce a diagnostic. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const producer = readFileSync(join(here, 'prototype-filter-types.fixture.ts'), 'utf8');
assert.equal((producer.match(/@ts-expect-error/g) ?? []).length, 31, 'retain every original negative control');
const fixture = [
  producer,
  readFileSync(join(here, 'prototype-filter-types-compat.fixture.ts'), 'utf8'),
  readFileSync(join(here, 'prototype-filter-types-admission.fixture.ts'), 'utf8'),
]
  .join('\n')
  .replaceAll('../query/index.js', 'prototype-query')
  .replaceAll('../query/column-ref.js', 'prototype-column-ref')
  .replaceAll('../query/types.js', 'prototype-query-types')
  .replaceAll('../powql.js', 'prototype-powql');
const returnTypeFixture = readFileSync(join(here, 'prototype-filter-types-returntype.fixture.ts'), 'utf8').replaceAll(
  '../query/index.js',
  'prototype-query',
);

for (const exactOptionalPropertyTypes of [false, true]) {
  test(`prototype column filters retain strict admission (exact optional: ${exactOptionalPropertyTypes})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'turbine-prototype-filter-types-'));
    try {
      const source = join(root, 'consumer.ts');
      const returnTypeSource = join(root, 'returntype.ts');
      const config = join(root, 'tsconfig.json');
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      const declarations = join(root, 'declarations');
      const emitted = spawnSync(
        process.execPath,
        [
          join(repo, 'node_modules/typescript/bin/tsc'),
          '-p',
          join(repo, 'tsconfig.json'),
          '--emitDeclarationOnly',
          '--outDir',
          declarations,
          '--pretty',
          'false',
        ],
        { encoding: 'utf8', timeout: 90_000 },
      );
      assert.equal(emitted.status, 0, `${emitted.error ?? ''}\n${emitted.stdout}\n${emitted.stderr}`);
      writeFileSync(
        config,
        JSON.stringify({
          compilerOptions: {
            strict: true,
            exactOptionalPropertyTypes,
            noEmit: true,
            skipLibCheck: false,
            target: 'ES2023',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            typeRoots: [join(repo, 'node_modules/@types')],
            types: ['node'],
            paths: {
              'prototype-query': [join(declarations, 'query/index.d.ts')],
              'prototype-column-ref': [join(declarations, 'query/column-ref.d.ts')],
              'prototype-query-types': [join(declarations, 'query/types.d.ts')],
              'prototype-powql': [join(declarations, 'powql.d.ts')],
            },
          },
          files: [source, returnTypeSource],
        }),
      );
      const compile = () =>
        spawnSync(
          process.execPath,
          [join(repo, 'node_modules/typescript/bin/tsc'), '-p', config, '--pretty', 'false'],
          { encoding: 'utf8', timeout: 90_000 },
        );
      writeFileSync(source, fixture);
      writeFileSync(returnTypeSource, returnTypeFixture);
      const valid = compile();
      assert.equal(valid.status, 0, `${valid.error ?? ''}\n${valid.stdout}\n${valid.stderr}`);

      const controls = fixture
        .split('\n')
        .flatMap((line, index) => (line.includes('@ts-expect-error') ? [index + 2] : []));
      assert.ok(controls.length >= 40, 'producer and independent negative controls must remain present');
      writeFileSync(source, fixture.replaceAll('@ts-expect-error', 'removed negative assertion:'));
      const invalid = compile();
      assert.equal(invalid.status, 2, `${invalid.error ?? ''}\n${invalid.stdout}\n${invalid.stderr}`);
      const diagnostics = invalid.stdout.split('\n').filter((line) => line.includes(': error TS'));
      const diagnosticLines = diagnostics.map((line) => Number(line.match(/consumer\.ts\((\d+),/)?.[1]));
      assert.deepEqual(
        [...new Set(diagnosticLines)].sort((a, b) => a - b),
        controls,
        invalid.stdout,
      );
      for (const line of controls) {
        assert.match(
          invalid.stdout,
          new RegExp(`consumer\\.ts\\(${line},\\d+\\): error TS(?:2322|2339|2345|2353|2559|2769)\\b`),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
