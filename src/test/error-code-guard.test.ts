/** Exercise the checker against isolated inputs, never mutate production code. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';

it('keeps file-local exceptions narrow while retaining runtime and code reachability checks', (t) => {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const root = mkdtempSync(join(tmpdir(), 'turbine-error-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  writeFileSync(
    join(root, 'src/errors.ts'),
    `
export const TurbineErrorCode = {
  VALIDATION: 'TURBINE_E003',
};
export class TurbineError extends Error {}
export class ValidationError extends TurbineError {
  code = TurbineErrorCode.VALIDATION;
}
`,
  );
  const cases = [
    {
      file: 'cli/d1-local.ts',
      source: ['throw', "new AggregateError(cleanupFailures, 'cleanup failed'); new ValidationError();"].join(' '),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'cli/d1-migrations.ts',
      source: [
        'throw',
        "new D1MigrationError('invalid history', 'read', 'not-dispatched'); new ValidationError();",
      ].join(' '),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    ...['cli/d1-local.ts', 'cli/d1-project.ts'].map((file) => ({
      file,
      source: ['throw', "new D1MigrationError('not this file'); new ValidationError();"].join(' '),
      exit: 1,
      message: /throw new D1MigrationError/,
    })),
    {
      file: 'cli/d1-migrations.ts',
      source: ['throw', "new AggregateError([], 'not this file'); new ValidationError();"].join(' '),
      exit: 1,
      message: /throw new AggregateError/,
    },
    {
      file: 'cli/libsql-migrate.ts',
      source: ['throw', "new AggregateError(cleanupFailures, 'cleanup failed'); new ValidationError();"].join(' '),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'cli/unrelated.ts',
      source: ['throw', "new AggregateError([], 'untracked'); new ValidationError();"].join(' '),
      exit: 1,
      message: /src\/cli\/unrelated.ts:1 -- throw new AggregateError/,
    },
    {
      file: 'd1/migrate.ts',
      source: ['throw', "new D1MigrationError('batch failed', 'dispatch', 'unknown'); new ValidationError();"].join(
        ' ',
      ),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    ...['d1/migrate.ts', 'd1/migrations/sql.ts'].map((file) => ({
      file,
      source: "throw new Error('internal cause'); new ValidationError();",
      exit: 0,
      message: /all 1 error codes are constructed/,
    })),
    ...['runtime.ts', 'd1/migrations/sql.ts'].map((file) => ({
      file,
      source: ['throw', "new D1MigrationError('not this file'); new ValidationError();"].join(' '),
      exit: 1,
      message: /throw new D1MigrationError/,
    })),
    {
      file: 'd1/other.ts',
      source: "throw new Error('untracked'); new ValidationError();",
      exit: 1,
      message: /src\/d1\/other.ts:1 -- throw new Error/,
    },
    {
      file: 'd1/migrate.ts',
      source: ['throw', "new UntrackedError('not registered'); new ValidationError();"].join(' '),
      exit: 1,
      message: /throw new UntrackedError/,
    },
    {
      file: 'libsql-seed.ts',
      source: [
        'throw',
        "new AggregateError([seedFailure, cleanupFailure], 'both failures'); new ValidationError();",
      ].join(' '),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'libsql-seed.ts',
      source: "throw new Error('untracked'); new ValidationError();",
      exit: 1,
      message: /src\/libsql-seed.ts:1 -- throw new Error/,
    },
    {
      file: 'live-query.ts',
      source: "throw new TypeError('invalid subscription handle'); new ValidationError();",
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'live-query.ts',
      source: "throw new Error('untracked'); new ValidationError();",
      exit: 1,
      message: /src\/live-query.ts:1 -- throw new Error/,
    },
    {
      file: 'test/live-query-pg.test.ts',
      source: ['throw', "new AggregateError([], 'cleanup'); new ValidationError();"].join(' '),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'test/sqlite-fixture-lifetime.ts',
      source: ['throw', "new AggregateError([], 'cleanup'); new ValidationError();"].join(' '),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'test/fixtures/postgres-durable-replay/controls.ts',
      source: ['throw', "new AggregateError([], 'all cleanup failures'); new ValidationError();"].join(' '),
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'test/fixtures/postgres-durable-replay/other.ts',
      source: ['throw', "new AggregateError([], 'not the registered fixture'); new ValidationError();"].join(' '),
      exit: 1,
      message: /src\/test\/fixtures\/postgres-durable-replay\/other.ts:1 -- throw new AggregateError/,
    },
    {
      file: 'test/another-fixture.ts',
      source: ['throw', "new AggregateError([], 'cleanup'); new ValidationError();"].join(' '),
      exit: 1,
      message: /src\/test\/another-fixture.ts:1 -- throw new AggregateError/,
    },
    {
      file: 'runtime.ts',
      source: ['throw', "new AggregateError([], 'runtime failure'); new ValidationError();"].join(' '),
      exit: 1,
      message: /src\/runtime.ts:1 -- throw new AggregateError/,
    },
    {
      file: 'sql.ts',
      source: "throw new TypeError('invalid argument'); new ValidationError();",
      exit: 0,
      message: /all 1 error codes are constructed/,
    },
    {
      file: 'runtime.ts',
      source: "throw new TypeError('runtime failure'); new ValidationError();",
      exit: 1,
      message: /src\/runtime.ts:1 -- throw new TypeError/,
    },
    {
      file: 'sql.ts',
      source: "throw new Error('untracked'); new ValidationError();",
      exit: 1,
      message: /src\/sql.ts:1 -- throw new Error/,
    },
    {
      file: 'sql.ts',
      source: "throw new TypeError('invalid argument');",
      exit: 1,
      message: /TURBINE_E003 \(ValidationError\)/,
    },
  ];
  for (const fixture of cases) {
    const path = join(root, 'src', fixture.file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fixture.source);
    // Test construction sites cannot satisfy production code reachability.
    const productionProof = join(root, 'src/production-proof.ts');
    if (fixture.file.startsWith('test/')) writeFileSync(productionProof, 'new ValidationError();');
    const result = spawnSync(
      process.execPath,
      ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'scripts/check-error-codes.ts')],
      { cwd: root, encoding: 'utf8', timeout: 20_000 },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, fixture.exit, output);
    assert.match(output, fixture.message);
    rmSync(path);
    rmSync(productionProof, { force: true });
  }
});
