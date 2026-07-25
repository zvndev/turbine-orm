/**
 * turbine-orm CLI: first-run DX regression tests
 *
 * Covers the path a brand-new user walks: `turbine init` scaffolds TypeScript
 * files, then `turbine studio --demo` must work in that same directory even
 * though tsx is not installed and there is no database.
 *
 * Run: npx tsx --test src/test/cli-first-run.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configTemplate, resolveConfig, resolveSeedFile } from '../cli/config.js';
import {
  bootstrapCliConfig,
  detectPackageManager,
  initEnvNotice,
  tsxInstallCommand,
  tsxRequiredNotice,
  usesProjectConfig,
} from '../cli/index.js';
import { stripAnsi } from '../cli/ui.js';

const cleanups: Array<() => void> = [];

/** A throwaway directory that is removed after the test. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `turbine-${prefix}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Run `fn` with the process CWD pointed at `dir`, always restoring it. */
async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const original = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(original);
  }
}

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

// ---------------------------------------------------------------------------
// `studio --demo` must not resolve a config file
// ---------------------------------------------------------------------------

describe('config-free commands (studio --demo)', () => {
  it('usesProjectConfig() is false only for studio --demo', () => {
    assert.equal(usesProjectConfig({ command: 'studio', demo: true }), false);
    assert.equal(usesProjectConfig({ command: 'studio', demo: false }), true);
    assert.equal(usesProjectConfig({ command: 'studio', demo: undefined }), true);
    assert.equal(usesProjectConfig({ command: 'generate', demo: true }), true);
    assert.equal(usesProjectConfig({ command: 'migrate', demo: undefined }), true);
  });

  it('bootstrapCliConfig() skips the config file entirely for studio --demo', async () => {
    const dir = tempDir('demo-config');
    // A .js config so the control case loads without needing the tsx loader.
    writeFileSync(join(dir, 'turbine.config.js'), "export default { url: 'postgres://from-config/db' };\n", 'utf-8');

    const savedUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      await inDir(dir, async () => {
        const demo = await bootstrapCliConfig({ command: 'studio', demo: true }, {});
        assert.equal(demo.skipped, true);
        assert.deepEqual(demo.fileConfig, {});
        assert.equal(demo.config.url, '', 'demo mode must not pick up the config file url');
        assert.equal(demo.loadError, undefined);

        // Control: the same directory, without --demo, DOES load the config.
        const normal = await bootstrapCliConfig({ command: 'studio', demo: false }, {});
        assert.equal(normal.skipped, false);
        assert.equal(normal.config.url, 'postgres://from-config/db');
      });
    } finally {
      if (savedUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = savedUrl;
    }
  });

  it('studio --demo still honors flag overrides that do not come from config', async () => {
    const dir = tempDir('demo-flags');
    writeFileSync(join(dir, 'turbine.config.js'), "export default { out: './from-config' };\n", 'utf-8');
    await inDir(dir, async () => {
      const boot = await bootstrapCliConfig({ command: 'studio', demo: true }, { out: './from-flag' });
      assert.equal(boot.config.out, './from-flag');
    });
  });
});

// ---------------------------------------------------------------------------
// init warns when tsx is missing
// ---------------------------------------------------------------------------

describe('tsx heads-up after init scaffolding', () => {
  it('names every scaffolded TypeScript file and the exact install command', () => {
    const lines = tsxRequiredNotice(['turbine.config.ts', './turbine/schema.ts'], tsxInstallCommand('pnpm')).map(
      stripAnsi,
    );
    const text = lines.join('\n');
    assert.match(text, /tsx/);
    assert.match(text, /turbine\.config\.ts/);
    assert.match(text, /\.\/turbine\/schema\.ts/);
    assert.match(text, /pnpm add -D tsx/);
    assert.match(text, /Cannot load TypeScript file/);
  });

  it('gives a per-package-manager install command', () => {
    assert.equal(tsxInstallCommand('npm'), 'npm install --save-dev tsx');
    assert.equal(tsxInstallCommand('pnpm'), 'pnpm add -D tsx');
    assert.equal(tsxInstallCommand('yarn'), 'yarn add -D tsx');
    assert.equal(tsxInstallCommand('bun'), 'bun add -d tsx');
  });

  it('detects the package manager from the lockfile, defaulting to npm', () => {
    const empty = tempDir('pm-empty');
    assert.equal(detectPackageManager(empty), 'npm');

    const pnpmDir = tempDir('pm-pnpm');
    writeFileSync(join(pnpmDir, 'pnpm-lock.yaml'), '', 'utf-8');
    assert.equal(detectPackageManager(pnpmDir), 'pnpm');

    const yarnDir = tempDir('pm-yarn');
    writeFileSync(join(yarnDir, 'yarn.lock'), '', 'utf-8');
    assert.equal(detectPackageManager(yarnDir), 'yarn');

    const bunDir = tempDir('pm-bun');
    writeFileSync(join(bunDir, 'bun.lock'), '', 'utf-8');
    assert.equal(detectPackageManager(bunDir), 'bun');
  });

  it('cmdInit prints the notice only when tsx cannot be resolved', () => {
    // The wiring itself: init computes `tsxMissing` from canResolveTsx() and the
    // files it actually wrote, then prints the notice. Guard the condition so a
    // future edit cannot silently drop the warning.
    const source = readCliSource();
    assert.match(source, /const tsxMissing = tsFilesWritten\.length > 0 && !canResolveTsx\(\);/);
    assert.match(source, /if \(tsxMissing\) \{[\s\S]*tsxRequiredNotice\(/);
  });
});

function readCliSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(resolve(here, '../cli/index.ts'), 'utf-8');
}

// ---------------------------------------------------------------------------
// seedFile is canonical, seed is a back-compat alias
// ---------------------------------------------------------------------------

describe('seed file config key', () => {
  it('accepts both seedFile and seed, with seedFile winning', () => {
    assert.equal(resolveConfig({ seedFile: './a.ts' }, {}).seedFile, './a.ts');
    assert.equal(resolveConfig({ seed: './b.ts' }, {}).seedFile, './b.ts');
    assert.equal(resolveConfig({ seedFile: './a.ts', seed: './b.ts' }, {}).seedFile, './a.ts');
    assert.equal(resolveConfig({}, {}).seedFile, undefined);
  });

  it('resolveSeedFile() honors both keys', () => {
    const dir = tempDir('seed-keys');
    assert.equal(resolveSeedFile({ seedFile: './x.ts' }, dir), join(dir, 'x.ts'));
    assert.equal(resolveSeedFile({ seed: './y.ts' }, dir), join(dir, 'y.ts'));
    assert.equal(resolveSeedFile({ seedFile: './x.ts', seed: './y.ts' }, dir), join(dir, 'x.ts'));
  });

  it('the scaffolded config uses the canonical seedFile key', () => {
    const template = configTemplate();
    assert.match(template, /seedFile: '\.\/turbine\/seed\.ts'/);
    assert.doesNotMatch(template, /\n\s*seed: /);
  });

  it('auto-discovers the seed file init scaffolds, with root-level winning', () => {
    // No seedFile key at all: the turbine/ location init writes must still be found.
    const scaffolded = tempDir('seed-discovery-scaffolded');
    mkdirSync(join(scaffolded, 'turbine'), { recursive: true });
    writeFileSync(join(scaffolded, 'turbine', 'seed.ts'), '', 'utf-8');
    assert.equal(resolveSeedFile({}, scaffolded), join(scaffolded, 'turbine', 'seed.ts'));

    // Root-level only: unchanged from before the turbine/ candidates existed.
    const rootOnly = tempDir('seed-discovery-root');
    writeFileSync(join(rootOnly, 'seed.ts'), '', 'utf-8');
    assert.equal(resolveSeedFile({}, rootOnly), join(rootOnly, 'seed.ts'));

    // Both present: root-level keeps precedence so no existing project moves.
    const both = tempDir('seed-discovery-both');
    mkdirSync(join(both, 'turbine'), { recursive: true });
    writeFileSync(join(both, 'seed.sql'), '', 'utf-8');
    writeFileSync(join(both, 'turbine', 'seed.ts'), '', 'utf-8');
    assert.equal(resolveSeedFile({}, both), join(both, 'seed.sql'));

    // Nothing anywhere: still null, not a phantom path.
    assert.equal(resolveSeedFile({}, tempDir('seed-discovery-empty')), null);
  });

  it('a scaffolded config round-trips into a resolvable seed path', async () => {
    const dir = tempDir('seed-roundtrip');
    mkdirSync(join(dir, 'turbine'), { recursive: true });
    writeFileSync(join(dir, 'turbine', 'seed.ts'), '', 'utf-8');
    // Mirror what init writes: config value + file location must agree.
    assert.equal(resolveSeedFile({ seedFile: './turbine/seed.ts' }, dir), join(dir, 'turbine', 'seed.ts'));
  });
});

// ---------------------------------------------------------------------------
// init's connection notice
// ---------------------------------------------------------------------------

describe('init connection notice', () => {
  const base = {
    envUrl: undefined,
    hasEnvFile: false,
    hasEnvLocal: false,
    canAutoLoadEnv: true,
    flagUrl: undefined,
    configUrl: undefined,
  };

  it('does not claim a missing DATABASE_URL when --url was passed', () => {
    const notice = initEnvNotice({ ...base, flagUrl: 'postgres://localhost/db', configUrl: 'postgres://localhost/db' });
    assert.equal(notice.kind, 'success');
    assert.doesNotMatch(stripAnsi(notice.message), /No DATABASE_URL/);
    assert.match(stripAnsi(notice.message), /--url/);
  });

  it('does not claim a missing DATABASE_URL when the config file supplies one', () => {
    const notice = initEnvNotice({ ...base, configUrl: 'postgres://localhost/db' });
    assert.equal(notice.kind, 'success');
    assert.doesNotMatch(stripAnsi(notice.message), /No DATABASE_URL/);
  });

  it('still reports a genuinely missing URL', () => {
    const notice = initEnvNotice(base);
    assert.equal(notice.kind, 'info');
    assert.match(stripAnsi(notice.message), /No DATABASE_URL found in environment/);
  });

  it('keeps the existing env-file messages', () => {
    assert.match(stripAnsi(initEnvNotice({ ...base, envUrl: 'postgres://x/y' }).message), /Detected DATABASE_URL/);
    assert.match(stripAnsi(initEnvNotice({ ...base, hasEnvFile: true }).message), /no DATABASE_URL.*set in it yet/);
    assert.match(
      stripAnsi(initEnvNotice({ ...base, hasEnvFile: true, canAutoLoadEnv: false }).message),
      /cannot auto-load it/,
    );
    assert.match(stripAnsi(initEnvNotice({ ...base, hasEnvLocal: true }).message), /\.env\.local/);
  });
});
