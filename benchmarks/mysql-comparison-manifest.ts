/** Build an independent final expectation from explicit frozen files, never from a run report. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { MysqlFinalManifest } from './comparison-results.js';
import { fileTree, hashFile, installedIdentity, mysqlBenchmarkHashes } from './mysql-comparison-provenance.js';

const flags = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(args[i]?.startsWith('--') && args[i + 1] && !flags.has(args[i]!), 'expected unique --key value arguments');
  flags.set(args[i]!, args[i + 1]!);
}
const required = [
  '--repository',
  '--benchmark',
  '--artifact',
  '--sha256',
  '--runtime',
  '--runtime-sha256',
  '--head',
  '--mode',
  '--output',
];
assert.deepEqual([...flags.keys()].sort(), [...required].sort(), `required arguments: ${required.join(' ')}`);
const repository = resolve(flags.get('--repository')!),
  benchmark = resolve(flags.get('--benchmark')!);
const output = resolve(flags.get('--output')!),
  mode = flags.get('--mode')!;
assert.ok(!existsSync(output), 'refusing to overwrite a final manifest');
assert.ok(['ordinary', 'no-backslash'].includes(mode));
assert.equal(process.version, 'v24.10.0');
assert.equal(process.execPath, flags.get('--runtime'));
assert.equal(hashFile(process.execPath), flags.get('--runtime-sha256'), 'explicit runtime hash mismatch');
const git = (...argv: string[]) => execFileSync('git', argv, { cwd: repository, encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), flags.get('--head'), 'explicit final HEAD mismatch');
assert.equal(git('status', '--porcelain'), '', 'final manifest requires clean source');
process.env.MYSQL_COMPARISON_ARTIFACT = resolve(flags.get('--artifact')!);
process.env.MYSQL_COMPARISON_ARTIFACT_SHA256 = flags.get('--sha256')!;
const installed = installedIdentity();
const benchmarkHashes = mysqlBenchmarkHashes(benchmark);
for (const [path, value] of Object.entries(benchmarkHashes))
  assert.equal(hashFile(join(repository, path)), value, `installed harness differs from pinned source: ${path}`);
const runtimeVersions: Record<string, string> = {};
for (const [name, value] of Object.entries(process.versions))
  if (typeof value === 'string') runtimeVersions[name] = value;
const manifest: MysqlFinalManifest = {
  inventory: { repository, benchmark },
  format: 'mysql-final-manifest-v1',
  head: flags.get('--head')!,
  catalogSha256: '098a75f791fd5298e37ad7326b18a6a9873dc0b9cb886ce04be0d89ed33b68c9',
  executionScope: 'installed-artifact',
  runtime: {
    node: process.version,
    executable: process.execPath,
    sha256: hashFile(process.execPath),
    versions: runtimeVersions,
  },
  artifact: { ...installed.artifact, sha256: installed.artifact.sha256! },
  hashes: {
    source: fileTree(join(repository, 'src'), 'src/'),
    dist: Object.fromEntries(Object.entries(installed.artifact.payload).filter(([path]) => path.startsWith('dist/'))),
    benchmark: benchmarkHashes,
    turbineGenerated: fileTree(join(benchmark, 'generated/turbine-mysql'), 'generated/turbine-mysql/'),
    prismaGenerated: fileTree(join(benchmark, 'generated/prisma-mysql'), 'generated/prisma-mysql/'),
    rootLock: hashFile(join(repository, 'package-lock.json')),
    benchmarkLock: hashFile(join(repository, 'benchmarks/package-lock.json')),
  },
  packages: installed.packages,
  installedLock: installed.installedLock,
  settings: {
    mode: mode as 'ordinary' | 'no-backslash',
    warmup: 10,
    groupRounds: { headline: 200, extended: 100, stream: 15, latency: 25, deep: 150, cold: 100 },
  },
};
writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
console.log(
  JSON.stringify({
    output,
    sha256: hashFile(output),
    head: manifest.head,
    artifactSha256: manifest.artifact.sha256,
    scope: manifest.executionScope,
  }),
);
