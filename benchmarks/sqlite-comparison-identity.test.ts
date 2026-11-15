import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { comparisonRoot, sha256, verifyInstalledArtifact } from './sqlite-comparison-identity.js';
import { verifyScenarios } from './sqlite-equivalence.js';

test('archive hash and installed bytes are independent fail-closed prerequisites', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-artifact-control-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'package');
  mkdirSync(join(source, 'dist'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"name":"turbine-orm","version":"0.0.0-test"}\n');
  writeFileSync(join(source, 'dist/sqlite.js'), 'export const original = true;\n');
  const archive = join(directory, 'synthetic-control.tgz');
  execFileSync('tar', ['-czf', archive, '-C', directory, 'package']);
  const installed = join(directory, 'installed');
  cpSync(source, installed, { recursive: true });
  const scratch = (name: string) => {
    const p = join(directory, name);
    mkdirSync(p);
    return p;
  };
  assert.equal(verifyInstalledArtifact(archive, sha256(archive), installed, scratch('positive')).verified, true);
  assert.throws(
    () => verifyInstalledArtifact(archive, '0'.repeat(64), installed, scratch('bad-hash')),
    /SHA256 mismatch/,
  );
  writeFileSync(join(installed, 'dist/sqlite.js'), 'export const original = false;\n');
  assert.throws(() => verifyInstalledArtifact(archive, sha256(archive), installed, scratch('mutated')), /bytes differ/);
  cpSync(source, installed, { recursive: true });
  writeFileSync(join(installed, 'dist/extra.js'), 'export const injected = true;\n');
  assert.throws(() => verifyInstalledArtifact(archive, sha256(archive), installed, scratch('extra')), /bytes differ/);
});

test('hot-PK admission checks every rotating input and rejects a wrong final ID', async () => {
  const visits: number[] = [];
  const scenario = {
    id: 'headline-10',
    group: 'headline',
    scenario: 'rotating PK',
    arms: [
      {
        name: 'Raw',
        fn: async (i: number) => {
          visits.push(i);
          return { id: i + 1 };
        },
      },
    ],
    expected: (i: number) => ({ id: i + 1 }),
  };
  const rows = await verifyScenarios([scenario]);
  assert.deepEqual(
    visits,
    Array.from({ length: 50 }, (_, i) => i),
  );
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.inputs, visits);
  await assert.rejects(() => verifyScenarios([scenario], 'hot-input'), /exact result mismatch/);
});

test('timing cannot start without artifact identity and explicit serial execution', () => {
  for (const args of [
    ['--time'],
    ['--time', '--artifact', '/missing', '--sha256', '0'.repeat(64), '--report', '/unused'],
  ]) {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        join(comparisonRoot, 'benchmarks/node_modules/tsx/dist/loader.mjs'),
        join(comparisonRoot, 'benchmarks/bench-sqlite.ts'),
        ...args,
      ],
      {
        env: { ...process.env, SQLITE_COMPARISON_SERIALIZED: '' },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /timing requires/);
  }
});
