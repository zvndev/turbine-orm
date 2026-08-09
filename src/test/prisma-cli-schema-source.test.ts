/**
 * turbine-orm - `migrate-from-prisma` schema INPUT and the `--no-db` verdict.
 *
 * Two problems, both at the front door of the migration path:
 *
 *   1. A multi-file schema folder (Prisma >= 5.15, GA) died with a raw `EISDIR`
 *      from readFileSync. That is a stack trace where an answer belongs, and it
 *      is the layout Prisma's own docs now recommend for large schemas.
 *   2. `--no-db` always reported a clean bill of health. It skips resolution, so
 *      `hasUnresolved` is false by construction and the run exits 0 no matter
 *      what the parser threw away. It is the FIRST command anyone runs and the
 *      one place a parse problem should surface.
 *
 * The CLI half runs the REAL binary through tsx in a temp cwd, like
 * prisma-migrate-command.integration.test.ts. No database is involved.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readPrismaSchemaSource } from '../cli/index.js';

const repoRoot = process.cwd();
const tsxLoader = pathToFileURL(resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
const cliEntry = resolve(repoRoot, 'src/cli/index.ts');
const haveTsx = existsSync(resolve(repoRoot, 'node_modules/tsx'));

/** Run `turbine migrate-from-prisma` in `cwd`; never throws on a non-zero exit. */
function runCli(cwd: string, args: string[]): { code: number; output: string } {
  try {
    const stdout = execFileSync(process.execPath, ['--import', tsxLoader, cliEntry, 'migrate-from-prisma', ...args], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', DATABASE_URL: '' },
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return { code: e.status ?? 1, output: `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}` };
  }
}

/** A throwaway cwd, removed by the caller. */
function tempDir(tag: string): string {
  const dir = join(tmpdir(), `turbine-mfp-${tag}-${process.pid}-${Date.now().toString(36)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// readPrismaSchemaSource (pure enough: filesystem only)
// ---------------------------------------------------------------------------

describe('readPrismaSchemaSource', () => {
  it('reads a single file unchanged', () => {
    const dir = tempDir('file');
    try {
      const file = join(dir, 'schema.prisma');
      writeFileSync(file, 'model A {\n  id String @id\n}\n');
      assert.equal(readPrismaSchemaSource(file), 'model A {\n  id String @id\n}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('concatenates a multi-file schema folder in sorted order', () => {
    const dir = tempDir('folder');
    try {
      const schemaDir = join(dir, 'schema');
      mkdirSync(schemaDir);
      writeFileSync(join(schemaDir, 'b_post.prisma'), 'model Post {\n  id String @id\n}\n');
      writeFileSync(join(schemaDir, 'a_user.prisma'), 'model User {\n  id String @id\n}\n');
      // Not a .prisma file: ignored, exactly as Prisma does.
      writeFileSync(join(schemaDir, 'README.md'), 'notes\n');

      const src = readPrismaSchemaSource(schemaDir);
      assert.ok(src.indexOf('model User') < src.indexOf('model Post'), 'sorted, so the output is machine-independent');
      // Each file is introduced by name, because parse-error line numbers refer
      // to the concatenation and would otherwise point nowhere.
      assert.match(src, /\/\/ file: a_user\.prisma/);
      assert.match(src, /\/\/ file: b_post\.prisma/);
      assert.doesNotMatch(src, /notes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws a named error for a folder with no .prisma files', () => {
    const dir = tempDir('empty');
    try {
      assert.throws(() => readPrismaSchemaSource(dir), /No \.prisma files found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

describe('turbine migrate-from-prisma - schema input', () => {
  it('accepts a multi-file schema DIRECTORY', { skip: !haveTsx }, () => {
    const dir = tempDir('multifile');
    try {
      const schemaDir = join(dir, 'prisma', 'schema');
      mkdirSync(schemaDir, { recursive: true });
      writeFileSync(join(schemaDir, 'user.prisma'), 'model User {\n  id String @id\n  @@map("users")\n}\n');
      writeFileSync(join(schemaDir, 'post.prisma'), 'model Post {\n  id String @id\n  @@map("posts")\n}\n');

      const { code, output } = runCli(dir, ['--schema', schemaDir, '--out', './out', '--no-db', '--no-timestamp']);
      assert.equal(code, 0, output);
      assert.match(output, /Models:\s+2/);
      const report = readFileSync(join(dir, 'out', 'prisma-migration-report.md'), 'utf-8');
      assert.match(report, /\| User \|/);
      assert.match(report, /\| Post \|/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back from the default prisma/schema.prisma to prisma/schema/', { skip: !haveTsx }, () => {
    const dir = tempDir('default-folder');
    try {
      const schemaDir = join(dir, 'prisma', 'schema');
      mkdirSync(schemaDir, { recursive: true });
      writeFileSync(join(schemaDir, 'user.prisma'), 'model User {\n  id String @id\n  @@map("users")\n}\n');

      const { code, output } = runCli(dir, ['--out', './out', '--no-db', '--no-timestamp']);
      assert.equal(code, 0, output);
      assert.match(output, /Models:\s+1/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('turbine migrate-from-prisma - --no-db reports parser problems', () => {
  const SCHEMA_WITH_NOTES = [
    'model Legacy {',
    '  id     String @id',
    '  search Unsupported("tsvector")?',
    '  @@ignore',
    '  @@map("legacy")',
    '}',
    '',
  ].join('\n');

  it('exits non-zero and PRINTS the notes instead of a clean bill of health', { skip: !haveTsx }, () => {
    const dir = tempDir('notes');
    try {
      writeFileSync(join(dir, 'schema.prisma'), SCHEMA_WITH_NOTES);
      const { code, output } = runCli(dir, [
        '--schema',
        'schema.prisma',
        '--out',
        './out',
        '--no-db',
        '--no-timestamp',
      ]);
      assert.equal(code, 1, output);
      assert.match(output, /Parser notes/);
      assert.match(output, /tsvector/);
      assert.match(output, /@@ignore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--allow-partial accepts them, same opt-in as an unresolved item', { skip: !haveTsx }, () => {
    const dir = tempDir('notes-allowed');
    try {
      writeFileSync(join(dir, 'schema.prisma'), SCHEMA_WITH_NOTES);
      const { code, output } = runCli(dir, [
        '--schema',
        'schema.prisma',
        '--out',
        './out',
        '--no-db',
        '--allow-partial',
        '--no-timestamp',
      ]);
      assert.equal(code, 0, output);
      assert.match(output, /Parser notes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays quiet and exits 0 for a schema with nothing to note', { skip: !haveTsx }, () => {
    const dir = tempDir('clean');
    try {
      writeFileSync(join(dir, 'schema.prisma'), 'model User {\n  id String @id\n  @@map("users")\n}\n');
      const { code, output } = runCli(dir, [
        '--schema',
        'schema.prisma',
        '--out',
        './out',
        '--no-db',
        '--no-timestamp',
      ]);
      assert.equal(code, 0, output);
      assert.doesNotMatch(output, /Parser notes/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
