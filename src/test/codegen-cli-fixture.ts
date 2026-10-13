/**
 * Shared harness for the codegen-cli tests: a throwaway project directory in
 * which the REAL CLI entry point runs, from source, under the tsx loader.
 *
 * The project gets `node_modules/tsx` (so `npx tsx` and the CLI's own loader
 * probe resolve it) and nothing else. Files that need Turbine import it by
 * absolute path from `src/`, so no test depends on a built `dist/`.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripAnsi } from '../cli/ui.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(TEST_DIR, '../..');
export const CLI_ENTRY = join(REPO_ROOT, 'src', 'cli', 'index.ts');
export const SRC = {
  seed: join(REPO_ROOT, 'src', 'seed.ts'),
  client: join(REPO_ROOT, 'src', 'client.ts'),
  schemaBuilder: join(REPO_ROOT, 'src', 'schema-builder.ts'),
  index: join(REPO_ROOT, 'src', 'index.ts'),
} as const;
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

export interface CliRun {
  status: number | null;
  /** stdout and stderr, ANSI stripped. */
  output: string;
}

export interface Project {
  readonly dir: string;
  /** Write `content` to `rel` inside the project, creating directories. */
  write(rel: string, content: string): void;
  /** Run `turbine <args>` in the project. */
  cli(args: string[], env?: Record<string, string>): CliRun;
  /** Remove the project directory. */
  cleanup(): void;
}

/** A project directory with tsx linked in, running the CLI from source. */
export function makeProject(prefix: string, options: { databaseUrl?: string } = {}): Project {
  const dir = mkdtempSync(join(tmpdir(), `turbine-${prefix}-`));
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  symlinkSync(join(REPO_ROOT, 'node_modules', 'tsx'), join(dir, 'node_modules', 'tsx'));
  symlinkSync('../tsx/dist/cli.mjs', join(dir, 'node_modules', '.bin', 'tsx'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: prefix, type: 'module', private: true }));

  return {
    dir,
    write(rel, content) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, 'utf-8');
    },
    cli(args, env = {}) {
      // The node:test runner exports NODE_TEST_CONTEXT, and defineSeed suppresses
      // its auto-run whenever it is present, so a spawned child must not inherit it.
      const { NODE_TEST_CONTEXT: _omit, ...inherited } = process.env;
      const result = spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
        cwd: dir,
        encoding: 'utf-8',
        timeout: 180_000,
        env: { ...inherited, ...(options.databaseUrl ? { DATABASE_URL: options.databaseUrl } : {}), ...env },
      });
      return { status: result.status, output: stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`) };
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Type-checking generated output
// ---------------------------------------------------------------------------

/**
 * Write `files` into a temp directory and run `tsc --noEmit --strict` over them
 * with `turbine-orm` mapped to this checkout's `src/index.ts`, so the generated
 * client is checked against the types it ships with. Returns tsc's output so a
 * failing assertion can quote the real diagnostics.
 */
export function typecheckFiles(files: Record<string, string>, extra: { include?: string[] } = {}): CliRun {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-typecheck-'));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, name), source, 'utf-8');
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
          paths: { 'turbine-orm': [SRC.index] },
        },
        include: extra.include ?? ['*.ts', join(REPO_ROOT, 'types', '**', '*.d.ts')],
      }),
      'utf-8',
    );
    const result = spawnSync(join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', dir], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 180_000,
    });
    return { status: result.status, output: `${result.stdout ?? ''}\n${result.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The tsc diagnostics that point INTO the named files. A typecheck compiles the
 * library from `src/` too, so a diagnostic in some other file means the library
 * is mid-edit or broken, which is a different failure from "the generated
 * output does not compile". Output with a non-zero status but no diagnostic at
 * all (a config or setup failure) is returned whole so it cannot pass silently.
 */
export function diagnosticsIn(run: CliRun, files: string[]): string[] {
  const lines = run.output.split('\n').filter((line) => /error TS\d+:/.test(line));
  const own = lines.filter((line) => files.some((file) => line.startsWith(`${file}(`)));
  if (own.length > 0 || run.status === 0) return own;
  return lines.length > 0 ? [] : [run.output];
}
