/**
 * turbine-orm, the CLI's check-then-write file operations.
 *
 * Several commands decided what to write by looking at the disk first
 * (`existsSync`, `statSync`) and then wrote with the default flags. Between the
 * look and the write a file can appear, or a symlink can be planted at the name,
 * and a default write truncates the first and follows the second. These tests
 * pin the exclusive-create behavior that replaced them:
 *
 *   - `turbine init --url <secret>` never writes the password through a symlink
 *     and never truncates a `.env` that showed up after it looked;
 *   - `createMigration` refuses to replace a file instead of overwriting it;
 *   - `turbine skill` still says "Installed" the first time and "Updated" after.
 *
 * Run: npx tsx --test src/test/codeql-cli-files.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, mock } from 'node:test';
import { pathToFileURL } from 'node:url';
import { readPrismaSchemaSource, scaffoldEnvForUrl } from '../cli/index.js';
import { createMigration } from '../cli/migrate.js';
import { MigrationError, ValidationError } from '../errors.js';

const URL_WITH_SECRET = 'postgres://user:s3cret@host/db';
const canSymlink = process.platform !== 'win32';

/** Run `fn` inside a throwaway directory, always restoring the original cwd. */
function inTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-codeql-files-'));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    fn(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('turbine init --url: a planted symlink is never written through', { skip: !canSymlink }, () => {
  for (const name of ['.env', '.gitignore', '.env.example']) {
    it(`${name} as a dangling symlink is refused, and its target is not created`, () => {
      inTempDir((dir) => {
        const victim = join(dir, 'victim');
        symlinkSync(victim, join(dir, name));

        assert.throws(
          () => scaffoldEnvForUrl(URL_WITH_SECRET),
          (err: unknown) => {
            assert.ok(err instanceof ValidationError, String(err));
            assert.match(err.message, /dangling symlink/);
            return true;
          },
        );
        assert.equal(existsSync(victim), false, `${name} was written through the symlink`);
      });
    });
  }

  it('a dangling .gitignore stops the scaffold before the password reaches disk', () => {
    inTempDir((dir) => {
      symlinkSync(join(dir, 'victim'), join(dir, '.gitignore'));
      assert.throws(() => scaffoldEnvForUrl(URL_WITH_SECRET), ValidationError);
      assert.equal(existsSync(join(dir, '.env')), false, '.env must not exist without an ignore rule for it');
    });
  });
});

describe('turbine init --url: a .env that appears after the plan is read is kept', () => {
  it('appends to it instead of truncating it', () => {
    inTempDir((dir) => {
      const realRead = fs.readFileSync;
      let armed = true;
      // The first look at `.env` finds nothing, and the file appears right after:
      // exactly the window between planning and writing.
      (fs as { readFileSync: unknown }).readFileSync = function patched(this: unknown, ...args: unknown[]) {
        if (armed && args[0] === '.env') {
          armed = false;
          writeFileSync(join(dir, '.env'), 'OTHER=1\n');
          throw Object.assign(new Error("ENOENT: no such file or directory, open '.env'"), { code: 'ENOENT' });
        }
        return (realRead as (...a: unknown[]) => unknown).apply(fs, args);
      };
      syncBuiltinESMExports();
      try {
        const plan = scaffoldEnvForUrl(URL_WITH_SECRET);
        assert.equal(armed, false, 'the race was never staged, so this test proves nothing');
        assert.equal(plan.env, 'appended');
        const env = readFileSync(join(dir, '.env'), 'utf-8');
        assert.ok(env.startsWith('OTHER=1\n'), `the file that appeared was overwritten:\n${env}`);
        assert.ok(env.includes('DATABASE_URL=postgres://user:s3cret@host/db'), env);
      } finally {
        (fs as { readFileSync: unknown }).readFileSync = realRead;
        syncBuiltinESMExports();
      }
    });
  });
});

describe('createMigration never replaces an existing file', () => {
  it('refuses a second file with the same name in the same second, and keeps the first', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-codeql-migration-'));
    mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-13T08:00:00Z') });
    try {
      const first = createMigration(dir, 'add users');
      writeFileSync(first.path, '-- UP\nSELECT 1;\n-- DOWN\nSELECT 0;\n');

      assert.throws(
        () => createMigration(dir, 'add users'),
        (err: unknown) => {
          assert.ok(err instanceof MigrationError, String(err));
          assert.ok(err.message.includes(first.filename), err.message);
          assert.match(err.message, /already exists/);
          return true;
        },
      );
      assert.equal(readFileSync(first.path, 'utf-8'), '-- UP\nSELECT 1;\n-- DOWN\nSELECT 0;\n');

      // A different name in the same second is a different file.
      assert.doesNotThrow(() => createMigration(dir, 'add posts'));
    } finally {
      mock.timers.reset();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readPrismaSchemaSource', () => {
  it('reports a path that does not exist by name', () => {
    const missing = join(tmpdir(), 'turbine-codeql-no-such-schema', 'schema.prisma');
    assert.throws(
      () => readPrismaSchemaSource(missing),
      (err: unknown) => {
        assert.equal((err as NodeJS.ErrnoException).code, 'ENOENT');
        assert.ok((err as Error).message.includes(missing), (err as Error).message);
        return true;
      },
    );
  });
});

describe('turbine skill', () => {
  const tsxLoader = pathToFileURL(resolve(process.cwd(), 'node_modules/tsx/dist/loader.mjs')).href;
  const cliEntry = resolve(process.cwd(), 'src/cli/index.ts');

  function runSkill(cwd: string): string {
    return execFileSync(process.execPath, ['--import', tsxLoader, cliEntry, 'skill'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0', DATABASE_URL: '' },
    });
  }

  it('says Installed the first time and Updated the next, writing the same file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-codeql-skill-'));
    try {
      mkdirSync(join(dir, '.claude'), { recursive: true });
      assert.match(runSkill(dir), /Installed the Turbine query skill/);
      const target = join(dir, '.claude', 'skills', 'turbine-orm', 'SKILL.md');
      const body = readFileSync(target, 'utf-8');
      assert.ok(body.length > 0);

      writeFileSync(target, 'stale');
      assert.match(runSkill(dir), /Updated the Turbine query skill/);
      assert.equal(readFileSync(target, 'utf-8'), body);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
