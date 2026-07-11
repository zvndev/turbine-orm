/**
 * turbine-orm — Generated output must TYPECHECK against the library it ships with
 *
 * Regression test for the v0.28.x "incorrectly extends" break: the base
 * `TurbineClient.$transaction` gained a batch-array overload in v0.26, but the
 * generator's interface-merge for the typed client kept emitting only the
 * callback signature. A merged interface member must be compatible with the
 * base class member ON ITS OWN (TS2415), so every `turbine generate` output
 * failed `tsc` in user projects — while this repo's own string-pin tests
 * stayed green, because the template still matched itself.
 *
 * String pins can't catch template ↔ client-type drift; only compiling the
 * generated output against the real source types can. This test runs `tsc
 * --noEmit` over a freshly generated client with `turbine-orm` path-mapped to
 * `src/index.ts`.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    users: {
      name: 'users',
      columns: [
        {
          name: 'id',
          field: 'id',
          pgType: 'int8',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          pgArrayType: 'bigint[]',
        },
        {
          name: 'email',
          field: 'email',
          pgType: 'text',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          pgArrayType: 'text[]',
        },
      ],
      columnMap: { id: 'id', email: 'email' },
      reverseColumnMap: { id: 'id', email: 'email' },
      dateColumns: new Set<string>(),
      pgTypes: { id: 'int8', email: 'text' },
      allColumns: ['id', 'email'],
      primaryKey: ['id'],
      uniqueColumns: [],
      indexes: [],
      isView: false,
      relations: {},
    },
  },
};

describe('generated client typechecks against the shipped client types', () => {
  it('tsc --noEmit passes on generate output (pins $transaction overload parity)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-gen-typecheck-'));
    try {
      writeFileSync(join(dir, 'types.ts'), generateTypes(SCHEMA), 'utf-8');
      writeFileSync(join(dir, 'metadata.ts'), generateMetadata(SCHEMA), 'utf-8');
      writeFileSync(join(dir, 'index.ts'), generateIndex(SCHEMA), 'utf-8');
      const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            // Compile the generated output against the CURRENT source types —
            // this is exactly what drifts when the client class changes shape.
            paths: { 'turbine-orm': [join(repoRoot, 'src', 'index.ts')] },
          },
          // The repo's ambient shims (pg/lib/*) must ride along, same as the
          // main tsconfig's include of types/**/*.d.ts.
          include: ['*.ts', join(repoRoot, 'types', '**', '*.d.ts')],
        }),
        'utf-8',
      );
      const tsc = join(repoRoot, 'node_modules', '.bin', 'tsc');
      const result = spawnSync(tsc, ['--noEmit', '-p', dir], {
        cwd: repoRoot,
        encoding: 'utf-8',
        timeout: 120_000,
      });
      assert.equal(
        result.status,
        0,
        `generated client failed to typecheck:\n${result.stdout}\n${result.stderr}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
