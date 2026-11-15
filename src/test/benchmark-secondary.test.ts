import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

it('reads secondary reports without benchmark dependencies or generated clients', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-secondary-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  // Deliberately omit the execution contract, generated client and all ORM packages.
  for (const file of ['secondary-results.ts', 'secondary-admission.ts', 'bench-harness.ts', 'pg-admission.ts'])
    copyFileSync(join(root, 'benchmarks', file), join(dir, file));
  const module = pathToFileURL(join(dir, 'secondary-results.ts')).href;
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      join(root, 'node_modules/tsx/dist/loader.mjs'),
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
      const m = await import(${JSON.stringify(module)});
      assert.equal(m.SECONDARY_CATALOG.latency.length, 3);
      assert.throws(() => m.assertSecondaryRuns([], 'stream'), /No secondary runs/);
      console.log('pure report admission passed');`,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pure report admission passed/);
});

it('never marks raw named, unnamed or transaction controls as the fastest ORM', async () => {
  const { print } = await import(new URL('../../benchmarks/bench-harness.ts', import.meta.url).href);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    print(
      'fixture only',
      ['Raw', 'raw pg (NAMED)', 'raw pg (unnamed)', 'Raw tx', 'Drizzle', 'Turbine'].map((name, index) => ({
        name,
        median: index + 1,
        avg: index + 1,
        p95: index + 1,
        min: index + 1,
        n: 1,
      })),
    );
  } finally {
    console.log = original;
  }
  const winners = lines.filter((line) => line.includes('<= fastest ORM'));
  assert.equal(winners.length, 1);
  assert.match(winners[0]!, /^\s+Drizzle\s/);
});

it('the actual round runner fails when results aggregation fails through tee', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-secondary-round-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'node'),
    '#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.10.0; else printf "/tmp\\n5432\\nfixture\\nfixture\\n"; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'npx'),
    '#!/bin/sh\nif [ "$2" = "build-results.ts" ] && [ "$3" = "build" ]; then echo "fixture aggregation rejected" >&2; exit 42; fi\nexit 0\n',
    { mode: 0o755 },
  );
  const source = readFileSync(join(root, 'benchmarks/run-round.sh'), 'utf8');
  for (const omission of [false, true]) {
    const script = join(dir, omission ? 'omission.sh' : 'run-round.sh');
    writeFileSync(script, omission ? source.replace(/^\[ .*PIPESTATUS.*$/m, ':') : source);
    const result = spawnSync('bash', [script, join(dir, omission ? 'omitted-output' : 'output')], {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        QUICK: '1',
        QUIET_IDLE: '0',
        QUIET_PROCS: '',
        RUNS: '1',
      },
    });
    assert.equal(result.status, omission ? 0 : 1, result.stderr);
    assert.match(result.stderr, /fixture aggregation rejected/);
    if (!omission) assert.match(result.stdout, /round FAILED: build-results/);
  }
});
