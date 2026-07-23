/**
 * turbine-orm — seed-as-code unit tests
 *
 * Run: npx tsx --test src/test/seed-code.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveConfig, resolveSeedFile } from '../cli/config.js';
import { getSeedExecutionPlan } from '../cli/index.js';
import { defineSeed, parseStackFramePath } from '../seed.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, '../..');
const SEED_SRC = resolve(TEST_DIR, '../seed.ts');

describe('seed-as-code config resolution', () => {
  it('supports the new `seed` config field and keeps `seedFile` as an alias', () => {
    assert.equal(resolveConfig({ seed: './db/seed.js' }, {}).seedFile, './db/seed.js');
    assert.equal(resolveConfig({ seedFile: './legacy/seed.sql' }, {}).seedFile, './legacy/seed.sql');
  });

  it('resolves default seed.ts, seed.js, seed.sql candidates in order', () => {
    const dir = join(tmpdir(), `turbine-seed-resolve-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'seed.sql'), 'SELECT 1;');
      writeFileSync(join(dir, 'seed.js'), 'export default async function seed() {}');
      assert.equal(resolveSeedFile({}, dir), resolve(dir, 'seed.js'));

      writeFileSync(join(dir, 'seed.ts'), 'import { defineSeed } from "turbine-orm";');
      assert.equal(resolveSeedFile({}, dir), resolve(dir, 'seed.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses explicit config seed path even when the file does not exist yet', () => {
    const dir = join(tmpdir(), `turbine-seed-explicit-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      assert.equal(resolveSeedFile({ seed: './custom/seed.ts' }, dir), resolve(dir, './custom/seed.ts'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('seed-as-code execution plan', () => {
  it('runs TypeScript seeds through npx tsx only', () => {
    assert.deepEqual(getSeedExecutionPlan('/tmp/seed.ts'), {
      kind: 'tsx',
      command: 'npx',
      args: ['tsx', '/tmp/seed.ts'],
    });
  });

  it('imports JavaScript seeds and executes SQL seeds directly', () => {
    assert.deepEqual(getSeedExecutionPlan('/tmp/seed.js'), { kind: 'js', file: '/tmp/seed.js' });
    assert.deepEqual(getSeedExecutionPlan('/tmp/seed.sql'), { kind: 'sql', file: '/tmp/seed.sql' });
  });

  it('parseStackFramePath extracts the path from every frame shape', () => {
    // Bare absolute path (CJS / tsx frames).
    assert.equal(parseStackFramePath('    at <anonymous> (/a/b/seed.ts:2:15)'), '/a/b/seed.ts');
    // "at PATH:line:col" with no wrapping parens.
    assert.equal(parseStackFramePath('    at /a/b/seed.ts:2:15'), '/a/b/seed.ts');
    // file:// URL frame (ESM) resolves to a filesystem path.
    assert.equal(parseStackFramePath('    at run (file:///a/b/seed.js:9:3)'), '/a/b/seed.js');
    // A path containing spaces survives (only ends are trimmed).
    assert.equal(parseStackFramePath('    at fn (/a/My Dir/seed.ts:1:1)'), '/a/My Dir/seed.ts');
    // Node-internal and non-file frames are ignored.
    assert.equal(parseStackFramePath('    at Module._compile (node:internal/modules/cjs/loader:1871:14)'), null);
    assert.equal(parseStackFramePath('Error'), null);
  });

  it('defineSeed returns an executable seed function', async () => {
    let called = false;
    const run = defineSeed(async () => {
      called = true;
    });
    assert.equal(typeof run, 'function');
    // Clear DATABASE_URL so the missing-URL rejection path is exercised even
    // when the suite runs in an integration environment with a real database.
    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await assert.rejects(run(), /DATABASE_URL/);
      assert.equal(called, false);
    } finally {
      if (savedUrl !== undefined) process.env.DATABASE_URL = savedUrl;
    }
  });
});

describe('defineSeed self-run detection (spawned entry)', () => {
  // A dummy connection string that is syntactically valid but never dialed:
  // the seed callback below only writes a probe file and never touches the DB,
  // so the pool is created and closed without a single connection attempt.
  const BOGUS_URL = 'postgres://u:p@127.0.0.1:1/none';

  // The node:test runner exports NODE_TEST_CONTEXT into this process, and
  // defineSeed deliberately suppresses its auto-run whenever that variable is
  // present. A spawned seed must therefore NOT inherit it, or it would look like
  // a test context and never run, the exact false-negative we are guarding.
  function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const { NODE_TEST_CONTEXT: _omit, ...rest } = process.env;
    return { ...rest, DATABASE_URL: BOGUS_URL, ...extra };
  }

  function runSeedFile(
    body: string,
    extraEnv: Record<string, string> = {},
  ): { status: number; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-seed-entry-'));
    const file = join(dir, 'seed.ts');
    writeFileSync(file, body);
    try {
      const out = execFileSync('npx', ['tsx', file], {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv(extraEnv),
      });
      return { status: 0, stdout: out, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      return {
        status: e.status ?? 1,
        stdout: String(e.stdout ?? ''),
        stderr: String(e.stderr ?? ''),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('runs the callback when the defineSeed file is the entry point (tsx)', () => {
    const probe = join(mkdtempSync(join(tmpdir(), 'turbine-seed-probe-')), 'ran');
    const sentinel = join(dirname(probe), 'sentinel');
    try {
      const res = runSeedFile(
        [
          `import { writeFileSync } from 'node:fs';`,
          `import { defineSeed } from ${JSON.stringify(SEED_SRC)};`,
          `export default defineSeed(async () => { writeFileSync(${JSON.stringify(probe)}, 'ran'); });`,
        ].join('\n'),
        { TURBINE_SEED_SENTINEL: sentinel },
      );
      assert.equal(res.status, 0, `seed exited non-zero: ${res.stderr}`);
      assert.ok(existsSync(probe), 'the defineSeed callback did not execute when run as the entry');
      assert.ok(existsSync(sentinel), 'runSeed did not write the completion sentinel');
    } finally {
      rmSync(dirname(probe), { recursive: true, force: true });
    }
  });

  it('does NOT auto-run when the defineSeed module is only imported', () => {
    const probe = join(mkdtempSync(join(tmpdir(), 'turbine-seed-probe-')), 'ran');
    try {
      // The entry imports a SEPARATE module that calls defineSeed. Because that
      // module is not the process entry, its callback must not auto-run.
      const dir = mkdtempSync(join(tmpdir(), 'turbine-seed-import-'));
      const lib = join(dir, 'lib.ts');
      const entry = join(dir, 'entry.ts');
      writeFileSync(
        lib,
        [
          `import { writeFileSync } from 'node:fs';`,
          `import { defineSeed } from ${JSON.stringify(SEED_SRC)};`,
          `export const run = defineSeed(async () => { writeFileSync(${JSON.stringify(probe)}, 'ran'); });`,
        ].join('\n'),
      );
      writeFileSync(entry, `import './lib.js';\nconsole.log('imported');`);
      try {
        const out = execFileSync('npx', ['tsx', entry], {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: childEnv({}),
        });
        assert.match(out, /imported/);
        assert.ok(!existsSync(probe), 'imported defineSeed module auto-ran its callback (should not)');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      rmSync(dirname(probe), { recursive: true, force: true });
    }
  });

  it('leaves the sentinel unwritten when the entry never runs a callback', () => {
    // This is the signal the CLI seed runner uses to report an honest failure
    // instead of a false "Seed completed": a file that loads but runs nothing.
    const sentinel = join(mkdtempSync(join(tmpdir(), 'turbine-seed-nocb-')), 'sentinel');
    try {
      const res = runSeedFile(`console.log('loaded, but no defineSeed');`, { TURBINE_SEED_SENTINEL: sentinel });
      assert.equal(res.status, 0);
      assert.ok(!existsSync(sentinel), 'sentinel was written even though no callback ran');
    } finally {
      rmSync(dirname(sentinel), { recursive: true, force: true });
    }
  });
});
