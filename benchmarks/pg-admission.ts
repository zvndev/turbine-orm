/** Final admission is bound to an external manifest, never to agreement between incomplete reports. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { summarizeSamples } from './bench-harness.js';

export const PG_IDENTITY = 'pg-executed-inputs-v1';
export const PG_FINAL_ADMISSION = 'pg-final-admission-v1';
export interface PgIdentity {
  format: typeof PG_IDENTITY;
  scope: 'installed-artifact' | 'byte-matched-local-dist';
  head: string;
  artifact: { path: string; sha256: string };
  runtime: { node: string; executable: string; sha256: string };
  server: { version: string; executable: string; sha256: string; settings: Record<string, string> };
  manifests: Record<'harness' | 'installed' | 'generated' | 'dependencies' | 'serverConfig', Record<string, string>>;
}
export interface PgAdmissionContext {
  format: typeof PG_FINAL_ADMISSION;
  /** Independently pinned correctness identity for the final tested archive. */
  expected: PgIdentity;
}
export interface PgAdmissionOptions {
  /** Default final admission always requires an external context. */
  scope?: 'final' | 'preparation' | 'historical';
  admission?: PgAdmissionContext;
}
const shaPattern = /^[a-f0-9]{64}$/;
const required = {
  harness: [
    'benchmarks/bench-harness.ts',
    'benchmarks/bench-interleaved.ts',
    'benchmarks/bench-extended.ts',
    'benchmarks/bench-stream-parity.ts',
    'benchmarks/bench-latency.ts',
    'benchmarks/deepoffset.ts',
    'benchmarks/equivalence.ts',
    'benchmarks/extended-equivalence.ts',
    'benchmarks/extended-support.ts',
    'benchmarks/secondary-contract.ts',
    'benchmarks/secondary-admission.ts',
    'benchmarks/semantics.ts',
    'benchmarks/extended-results.ts',
    'benchmarks/secondary-results.ts',
    'benchmarks/pg-admission.ts',
    'benchmarks/dashboard.ts',
    'benchmarks/schema.ts',
    'benchmarks/schema-rc.ts',
    'benchmarks/prisma/schema.prisma',
    'benchmarks/package-lock.json',
    'benchmarks/pg-preparation/run.mjs',
    'benchmarks/pg-preparation/worker.ts',
  ],
  installed: [
    'package.json',
    'dist/index.js',
    'dist/client.js',
    'dist/query/builder.js',
    'dist/query/stream-signal.js',
    'dist/generate.js',
    'dist/introspect.js',
    'dist/cli/index.js',
  ],
  generated: ['generated/turbine/index.ts', 'generated/turbine/metadata.ts', 'generated/turbine/types.ts'],
  dependencies: [
    'node_modules/pg/package.json',
    'node_modules/pg/lib/index.js',
    'node_modules/pg/lib/client.js',
    'node_modules/pg-protocol/package.json',
    'node_modules/drizzle-orm/package.json',
    'node_modules/drizzle-rc/package.json',
    'node_modules/@prisma/client/package.json',
    'node_modules/@prisma/adapter-pg/package.json',
    'node_modules/prisma/package.json',
    'node_modules/.prisma/client/index.js',
    'node_modules/tsx/dist/loader.mjs',
  ],
  serverConfig: ['postgresql.conf', 'pg_hba.conf', 'pg_ident.conf'],
} as const;
export const requiredPgManifestPaths = required;
function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Missing ${label}`);
}
export function assertPgIdentity(value: unknown): asserts value is PgIdentity {
  object(value, 'full PG provenance');
  assert.equal(value.format, PG_IDENTITY, 'Versioned full PG provenance required');
  assert.ok(
    value.scope === 'installed-artifact' || value.scope === 'byte-matched-local-dist',
    'Explicit artifact execution scope required',
  );
  assert.match(String(value.head), /^[a-f0-9]{40}$/, 'Executed source HEAD required');
  object(value.artifact, 'final artifact identity');
  assert.ok(
    typeof value.artifact.path === 'string' && isAbsolute(value.artifact.path),
    'Explicit archive path required',
  );
  assert.match(String(value.artifact.sha256), shaPattern, 'Explicit archive hash required');
  object(value.runtime, 'exact baseline runtime identity');
  assert.equal(value.runtime.node, 'v24.10.0', 'Exact baseline Node24.10.0 required');
  assert.ok(typeof value.runtime.executable === 'string' && isAbsolute(value.runtime.executable));
  assert.match(String(value.runtime.sha256), shaPattern, 'Node executable hash required');
  object(value.server, 'PostgreSQL executable/configuration identity');
  assert.equal(value.server.version, '18.6');
  assert.ok(typeof value.server.executable === 'string' && isAbsolute(value.server.executable));
  assert.match(String(value.server.sha256), shaPattern);
  object(value.server.settings, 'server settings');
  for (const name of [
    'max_connections',
    'shared_buffers',
    'fsync',
    'synchronous_commit',
    'full_page_writes',
    'default_transaction_isolation',
    'plan_cache_mode',
    'statement_timeout',
  ])
    assert.ok(typeof value.server.settings[name] === 'string', `Missing server setting ${name}`);
  object(value.manifests, 'full executed-input manifests');
  assert.deepEqual(
    Object.keys(value.manifests).sort(),
    Object.keys(required).sort(),
    'Exact executed-input manifest groups required',
  );
  for (const [group, paths] of Object.entries(required)) {
    const manifest = value.manifests[group];
    object(manifest, `${group} manifest`);
    for (const [path, hash] of Object.entries(manifest)) {
      assert.ok(path && !path.startsWith('/') && !path.split('/').includes('..'), `Invalid ${group} manifest path`);
      assert.match(String(hash), shaPattern, `${group}/${path} hash required`);
    }
    for (const path of paths)
      assert.ok(Object.hasOwn(manifest, path), `Missing required executed input ${group}/${path}`);
  }
}
export function assertPgProvenance(run: unknown, options: PgAdmissionOptions = {}): void {
  object(run, 'PG report');
  if (options.scope === 'historical') return; // Explicit historical summaries are never final evidence.
  assertPgIdentity(run.provenance);
  assert.deepEqual(run.runtime, run.provenance.runtime, 'Present full runtime identity must match executed provenance');
  if (options.scope === 'preparation') return;
  assert.ok(options.admission, 'External final archive/expected manifest admission is required');
  assert.equal(options.admission.format, PG_FINAL_ADMISSION);
  assertPgIdentity(options.admission.expected);
  assert.deepEqual(
    run.provenance,
    options.admission.expected,
    'PG execution differs from externally expected final manifest/archive/runtime',
  );
}
export function observedPgIdentity(): PgIdentity | undefined {
  const path = process.env.PG_BENCH_OBSERVED_IDENTITY;
  if (!path) return undefined;
  const identity = JSON.parse(readFileSync(path, 'utf8'));
  assertPgIdentity(identity);
  assert.equal(identity.runtime.node, process.version);
  assert.equal(identity.runtime.executable, process.execPath);
  assert.equal(identity.runtime.sha256, createHash('sha256').update(readFileSync(process.execPath)).digest('hex'));
  return identity;
}
export function assertPgSamples(stat: unknown, expectedN: number, options: PgAdmissionOptions = {}): void {
  object(stat, 'arm statistics');
  assert.ok(Number.isSafeInteger(expectedN) && expectedN > 0, 'Declared sample count required');
  assert.equal(stat.n, expectedN, 'Actual n must equal declared rounds');
  for (const key of ['median', 'avg', 'p95', 'min'])
    assert.ok(
      typeof stat[key] === 'number' && Number.isFinite(stat[key]) && stat[key] > 0,
      `Invalid timing statistic ${key}`,
    );
  if (options.scope === 'historical' && stat.samplesMs === undefined) {
    assert.ok(
      Number(stat.min) <= Number(stat.median) &&
        Number(stat.median) <= Number(stat.p95) &&
        Number(stat.min) <= Number(stat.avg),
      'Inconsistent historical statistics',
    );
    return;
  }
  assert.ok(
    Array.isArray(stat.samplesMs) && stat.samplesMs.length === expectedN,
    'Complete retained actual sample array required',
  );
  const computed = summarizeSamples(String(stat.name), stat.samplesMs, true);
  for (const key of ['n', 'median', 'avg', 'p95', 'min', 'p99', 'p99Status', 'sampleMethod'] as const)
    assert.deepEqual(stat[key], computed[key], `Sample-derived ${key} mismatch`);
}
