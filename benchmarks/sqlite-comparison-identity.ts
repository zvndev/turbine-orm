/** Identity checks for the original SQLite harness; no benchmark work lives here. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const comparisonRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
export function packageRoot(entry: string, name: string): string {
  let directory = dirname(realpathSync(entry));
  for (;;) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === name) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name} package root for ${entry}`);
    directory = parent;
  }
}

export function treeIdentity(directory: string): { sha256: string; files: Record<string, string> } {
  const files: Record<string, string> = {};
  function visit(current: string) {
    for (const name of readdirSync(current).sort()) {
      if (name === 'node_modules' || name === '.git') continue;
      const file = join(current, name),
        stat = lstatSync(file);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files[relative(directory, file)] = sha256(file);
      else if (stat.isSymbolicLink()) files[relative(directory, file)] = `link:${readlinkSync(file)}`;
      else throw new Error(`Unexpected non-regular package file: ${file}`);
    }
  }
  visit(directory);
  return { sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex'), files };
}

/** Compare bytes from the actual installed package against every regular archive member. */
export function verifyInstalledArtifact(archive: string, expected: string, installed: string, scratch: string) {
  assert.match(expected, /^[a-f0-9]{64}$/i, '--sha256 must be a SHA256 hex digest');
  const path = resolve(archive),
    actual = sha256(path);
  assert.equal(actual, expected.toLowerCase(), 'SQLite artifact SHA256 mismatch');
  const tar = (args: string[]) => execFileSync('tar', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20 });
  const members = tar(['-tzf', path]).trim().split('\n');
  assert.ok(
    members.length > 0 && members.every((p) => p.startsWith('package/') && !p.split('/').includes('..')),
    'Unexpected SQLite artifact member path',
  );
  tar(['-xzf', path, '--no-same-owner', '--no-same-permissions', '-C', scratch]);
  const packed = treeIdentity(join(scratch, 'package')),
    runtime = treeIdentity(installed);
  assert.deepEqual(runtime.files, packed.files, 'Installed Turbine package bytes differ from supplied archive');
  return {
    path,
    sha256: actual,
    installedPackageRoot: installed,
    installedTreeSha256: runtime.sha256,
    filesVerified: Object.keys(runtime.files).length,
    verified: true,
  };
}

export function resolveTurbine() {
  const entry = fileURLToPath(import.meta.resolve('turbine-orm/sqlite'));
  const directory = packageRoot(entry, 'turbine-orm');
  return {
    entry,
    packageRoot: directory,
    entrySha256: sha256(entry),
    packageVersion: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version,
    route: directory === comparisonRoot ? 'worktree-built-dist' : 'separately-installed-package',
    generationEntry: join(directory, 'dist/generate.js'),
    generationEntrySha256: sha256(join(directory, 'dist/generate.js')),
    nativeIntrospectionEntrySha256: sha256(entry),
  };
}

export function dependencyIdentities() {
  return Object.fromEntries(
    [
      ['drizzle-orm', 'drizzle-orm/better-sqlite3'],
      ['drizzle-rc', 'drizzle-rc/better-sqlite3'],
      ['@prisma/client', '@prisma/client'],
      ['@prisma/adapter-better-sqlite3', '@prisma/adapter-better-sqlite3'],
      ['@prisma/driver-adapter-utils', '@prisma/driver-adapter-utils'],
      ['@prisma/client-runtime-utils', '@prisma/client-runtime-utils'],
      ['prisma', 'prisma'],
      ['better-sqlite3', 'better-sqlite3'],
      ['tsx', 'tsx'],
    ].map(([name, specifier]) => {
      const entry =
        name === 'prisma'
          ? join(comparisonRoot, 'benchmarks/node_modules/prisma/build/index.js')
          : fileURLToPath(import.meta.resolve(specifier!));
      const directory = packageRoot(entry, name === 'drizzle-rc' ? 'drizzle-orm' : name!);
      const tree = treeIdentity(directory);
      return [
        name,
        {
          entry,
          packageRoot: directory,
          version: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version,
          entrySha256: sha256(entry),
          treeSha256: tree.sha256,
          files: tree.files,
        },
      ];
    }),
  );
}
