import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertComparisonRun, loadMysqlFinalManifest, type MysqlFinalManifest } from './comparison-results.js';

export const mysqlFaultCauses = {
  scalar: 'exact result mismatch',
  'stream-drop': 'observed stream completeness',
  'write-effect': 'write effect',
  'catalog-omit': 'complete 47-entry catalog',
  'arm-omit': 'complete five-arm roster',
  'seed-volume': 'SEED MISMATCH comments',
  cleanup: 'forced cleanup reporting fault',
  signal: 'interrupted SIGTERM',
};

export const hashFile = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function nativeErrorChain(error: unknown) {
  const details: { name: unknown; message: string; code: unknown }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const row = current as Record<string, unknown>;
    details.push({ name: row.name ?? null, message: String(row.message ?? current), code: row.code ?? null });
    current = row.cause;
  }
  return details;
}

/** A serialized timing run must name a successful same-payload, same-harness preflight. */
export function timingAdmission(
  path: string | undefined,
  sha256: string,
  mode: string,
  directory: string,
  fixtureManifest?: MysqlFinalManifest,
) {
  assert.ok(path, 'timing requires explicit MYSQL_COMPARISON_PREFLIGHT from the final tested artifact');
  const preflight = JSON.parse(readFileSync(path, 'utf8'));
  const expected =
    fixtureManifest ??
    loadMysqlFinalManifest(
      process.env.MYSQL_COMPARISON_FINAL_MANIFEST,
      process.env.MYSQL_COMPARISON_FINAL_MANIFEST_SHA256,
    );
  assert.equal(preflight.status, 'pass', 'final artifact preflight failed');
  assert.equal(preflight.timing, false, 'correctness-only artifact preflight required');
  assert.equal(preflight.installed.artifact.sha256, sha256, 'final tested artifact differs from timing artifact');
  assert.equal(preflight.identity.mode, mode, 'timing and preflight SQL modes differ');
  assertComparisonRun(preflight.comparison, 'mysql', false, expected);
  assertComparisonRun(preflight.repeat, 'mysql', false, expected);
  assert.deepEqual(
    preflight.comparison.hashes.benchmark,
    mysqlBenchmarkHashes(directory),
    'Complete current preflight harness',
  );
  assert.deepEqual(preflight.repeat.hashes, preflight.comparison.hashes, 'Post-control repeat provenance');
  assert.deepEqual(
    preflight.controls.map((c: { fault: string }) => c.fault).sort(),
    Object.keys(mysqlFaultCauses).sort(),
  );
  for (const control of preflight.controls) {
    const cause = mysqlFaultCauses[control.fault as keyof typeof mysqlFaultCauses];
    assert.equal(control.expected, cause, 'Intended control identity');
    assert.equal(control.code, 1, 'Intended control must execute and fail');
    assert.equal(control.signal, null, 'Killed control is not an oracle rejection');
    const detail = control.report;
    const message = typeof detail.error === 'string' ? detail.error : (detail.error?.message ?? '');
    assert.ok(
      [message, ...(detail.cleanup?.errors ?? [])].some((text: string) => text.includes(cause)),
      `Missing intended ${control.fault} failure`,
    );
    if (control.fault === 'catalog-omit') {
      assert.equal(detail.phase, 'admission');
      assert.equal(detail.cleanup.backendAllocated, false);
    } else {
      assert.equal(detail.environment.MYSQL_COMPARISON_FAULT, control.fault);
      assert.equal(detail.cleanup.fixtureRestored, true);
      assert.equal(detail.cleanup.oracleClosed, true);
      assert.deepEqual(detail.cleanup.remainingArmBackends, []);
      assert.ok(detail.cleanup.adapters.every((a: { closed: boolean }) => a.closed));
      assert.ok(
        detail.cleanup.mysql2Pools.every((p: { closed: boolean; queued: number }) => p.closed && p.queued === 0),
      );
      assert.deepEqual(
        detail.cleanup.errors,
        control.fault === 'cleanup' ? ['forced cleanup reporting fault after actual cleanup'] : [],
      );
    }
  }
  assert.deepEqual(preflight.failures, []);
  assert.equal(preflight.identity.databaseDropped, true);
  assert.equal(preflight.identity.adminClosed, true);
  assert.deepEqual(preflight.identity.remainingConnections, []);
  assert.deepEqual(preflight.identity.remainingProcessGroups, []);
  assert.ok(
    preflight.controls.every(
      (c: { code: number; report: { status: string } }) => c.code !== 0 && c.report.status === 'failure',
    ),
  );
  assert.equal(preflight.identity.rootRemoved, true);
  assert.equal(preflight.identity.portClosed, true);
  assert.deepEqual(preflight.identity.cleanupAudit.remaining, []);
  for (const [relative, hash] of Object.entries(preflight.comparison.hashes.benchmark)) {
    assert.equal(
      hashFile(join(directory, relative.replace(/^benchmarks\//, ''))),
      hash,
      `timing harness changed after preflight: ${relative}`,
    );
  }
  return { path: resolve(path), sha256: hashFile(path), artifactSha256: sha256, mode };
}
export function fileTree(root: string, prefix = ''): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry): [string, string][] => {
        if (entry.name === 'node_modules') return [];
        const key = prefix + entry.name,
          file = join(root, entry.name);
        assert.ok(!entry.isSymbolicLink(), `mutable symlink in identity: ${file}`);
        return entry.isDirectory() ? Object.entries(fileTree(file, key + '/')) : [[key, hashFile(file)]];
      }),
  );
}
function packageEntries(name: string, root: string): string[] {
  const specifiers: Record<string, string[]> = {
    mysql2: ['mysql2/promise'],
    mariadb: ['mariadb'],
    'drizzle-orm': ['drizzle-orm', 'drizzle-orm/mysql2'],
    'drizzle-rc': ['drizzle-rc', 'drizzle-rc/mysql2', 'drizzle-rc/relations'],
    '@prisma/client': ['@prisma/client/runtime/client'],
    '@prisma/adapter-mariadb': ['@prisma/adapter-mariadb'],
    pg: ['pg'],
  };
  if (name === 'prisma') return [join(root, 'build/index.js')];
  if (name === 'tsx') return [join(root, 'dist/loader.mjs')];
  return specifiers[name]!.map((specifier) => fileURLToPath(import.meta.resolve(specifier)));
}
export function mysqlBenchmarkHashes(directory: string): Record<string, string> {
  const names = [
    ...readdirSync(directory).filter((name) => name.startsWith('mysql-') && name.endsWith('.ts')),
    'bench-mysql.ts',
    'bench-harness.ts',
    'equivalence.ts',
    'comparison-versions.json',
    'comparison-results.ts',
    'comparison-inventory.ts',
    'comparison-policy.ts',
    'prisma/mysql.prisma',
    'mysql-preparation/native.mjs',
    'mysql-preparation/oracle.mjs',
    'mysql-preparation/provenance.mjs',
  ];
  return Object.fromEntries(
    [...new Set(names)].sort().map((name) => [`benchmarks/${name}`, hashFile(join(directory, name))]),
  );
}
export function installedIdentity() {
  const artifact = process.env.MYSQL_COMPARISON_ARTIFACT;
  const expected = process.env.MYSQL_COMPARISON_ARTIFACT_SHA256;
  assert.ok(
    artifact && /^[a-f0-9]{64}$/.test(expected ?? ''),
    'explicit MYSQL_COMPARISON_ARTIFACT and SHA256 required',
  );
  assert.equal(hashFile(artifact), expected, 'explicit archive hash mismatch');
  assert.equal(process.version, 'v24.10.0', 'exact baseline Node24.10.0 required');
  const require = createRequire(import.meta.url);
  const entry = require.resolve('turbine-orm');
  let packageRoot = dirname(entry);
  for (;;) {
    try {
      if (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name === 'turbine-orm') break;
    } catch {}
    assert.notEqual(dirname(packageRoot), packageRoot, 'installed Turbine manifest missing');
    packageRoot = dirname(packageRoot);
  }
  assert.equal(realpathSync(packageRoot), packageRoot, 'installed Turbine must not be a source symlink');
  const temporary = mkdtempSync(join(dirname(packageRoot), '.mysql-archive-check-'));
  let payload: Record<string, string>;
  try {
    execFileSync('tar', ['-xzf', artifact, '-C', temporary]);
    payload = fileTree(join(temporary, 'package'));
    assert.deepEqual(fileTree(packageRoot), payload, 'installed Turbine payload differs from explicit archive');
  } finally {
    rmSync(temporary, { force: true, recursive: true });
  }
  const names = [
    'mysql2',
    'mariadb',
    'drizzle-orm',
    'drizzle-rc',
    '@prisma/client',
    '@prisma/adapter-mariadb',
    'prisma',
    'tsx',
    'pg',
  ];
  const packages = Object.fromEntries(
    names.map((name) => {
      let root = dirname(require.resolve(name === 'prisma' ? 'prisma/package.json' : name));
      for (;;) {
        try {
          const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
          if (manifest.version)
            return [
              name,
              { root, version: manifest.version, entries: packageEntries(name, root), files: fileTree(root) },
            ];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        assert.notEqual(dirname(root), root, `manifest missing: ${name}`);
        root = dirname(root);
      }
    }),
  );
  return {
    artifact: {
      path: resolve(artifact),
      sha256: expected,
      packageRoot,
      entry: fileURLToPath(import.meta.resolve('turbine-orm')),
      requireEntry: entry,
      mysqlEntry: fileURLToPath(import.meta.resolve('turbine-orm/mysql')),
      generationEntry: join(packageRoot, 'dist/generate.js'),
      payload,
      exercised: true,
      scope: 'Actual installed archive, generation/introspection and query runtime; no local src/dist imports',
    },
    runtime: {
      node: process.version,
      executable: process.execPath,
      sha256: hashFile(process.execPath),
      versions: process.versions,
    },
    packages,
    installedLock: {
      sha256: hashFile(new URL('./package-lock.json', import.meta.url).pathname),
      content: JSON.parse(readFileSync(new URL('./package-lock.json', import.meta.url), 'utf8')),
    },
  };
}
